//! Chạy tiến trình con (ffmpeg) có GIỚI HẠN THỜI GIAN — `Command::output()`
//! chặn vô hạn nếu ffmpeg treo (driver encoder phần cứng lỗi, file trên ổ mạng
//! mất kết nối...), kéo theo cả luồng dừng quay/ingest treo theo mà người dùng
//! không có cách nào thoát ngoài force quit. Mọi lệnh ffmpeg "chạy 1 lần rồi
//! xong" của luồng quay (mux audio, remux, thumbnail, probe, filmstrip, dò
//! encoder) đi qua đây.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Ẩn cửa sổ console của tiến trình con trên Windows (no-op nơi khác).
pub fn no_window(#[allow(unused_variables)] cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Kết quả của 1 lần chạy có timeout — giống `std::process::Output` nhưng
/// stdout/stderr đã decode sẵn (lossy) vì mọi caller chỉ dùng để log/parse.
pub struct ProcOutput {
    pub status: ExitStatus,
    #[cfg_attr(not(test), allow(dead_code))]
    pub stdout: String,
    pub stderr: String,
}

/// Đọc hết 1 pipe ở thread riêng — bắt buộc đọc song song cả stdout lẫn
/// stderr, nếu không pipe đầy (~64KB) sẽ làm tiến trình con treo khi ghi log.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> Option<std::thread::JoinHandle<Vec<u8>>> {
    pipe.map(|mut p| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = p.read_to_end(&mut buf);
            buf
        })
    })
}

/// Chờ `child` kết thúc tối đa `timeout`; quá hạn thì kill + reap (không để
/// lại zombie) và trả `Err`.
pub fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("quá thời gian chờ ({}s)", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("lỗi chờ tiến trình: {e}"));
            }
        }
    }
}

/// Như `run` nhưng giữ nguyên stdout dạng byte (vd ảnh JPEG qua `pipe:1`).
pub fn run_raw(cmd: &mut Command, timeout: Duration) -> Result<(ExitStatus, Vec<u8>, String), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(cmd);
    let mut child = cmd.spawn().map_err(|e| format!("không khởi chạy được tiến trình: {e}"))?;
    let out_t = drain(child.stdout.take());
    let err_t = drain(child.stderr.take());
    let status = wait_with_timeout(&mut child, timeout);
    // Tiến trình đã kết thúc (hoặc bị kill) → pipe đã đóng, 2 thread đọc chắc
    // chắn trả về.
    let stdout = out_t.and_then(|t| t.join().ok()).unwrap_or_default();
    let stderr = err_t.and_then(|t| t.join().ok()).unwrap_or_default();
    Ok((status?, stdout, String::from_utf8_lossy(&stderr).into_owned()))
}

/// Chạy `cmd` tới khi xong hoặc hết `timeout`. stdin luôn là null; stdout và
/// stderr luôn được pipe + đọc hết.
pub fn run(cmd: &mut Command, timeout: Duration) -> Result<ProcOutput, String> {
    let (status, stdout, stderr) = run_raw(cmd, timeout)?;
    Ok(ProcOutput { status, stdout: String::from_utf8_lossy(&stdout).into_owned(), stderr })
}

/// Như `run`, nhưng coi exit code khác 0 là lỗi (kèm stderr để chẩn đoán).
pub fn run_ok(cmd: &mut Command, timeout: Duration, what: &str) -> Result<ProcOutput, String> {
    let out = run(cmd, timeout).map_err(|e| format!("{what}: {e}"))?;
    if !out.status.success() {
        let tail: String = out.stderr.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("{what} thất bại ({}): {}", out.status, tail.trim()));
    }
    Ok(out)
}

/// Timeout cho các lệnh ffmpeg xử lý cả file (remux/mux): tối thiểu 2 phút,
/// cộng thêm theo dung lượng (giả định tối thiểu ~20MB/s — remux `-c copy`
/// trên ổ chậm/HDD vẫn nhanh hơn mức này nhiều).
pub fn timeout_for_file(path: &std::path::Path) -> Duration {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Duration::from_secs(120 + size / (20 * 1024 * 1024))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn kills_process_on_timeout() {
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let started = Instant::now();
        let r = run(&mut cmd, Duration::from_millis(200));
        assert!(r.is_err(), "phải báo timeout");
        assert!(started.elapsed() < Duration::from_secs(3), "phải kill sớm, không chờ đủ 5s");
    }

    #[cfg(unix)]
    #[test]
    fn captures_output() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo out; echo err 1>&2"]);
        let r = run_ok(&mut cmd, Duration::from_secs(5), "sh").expect("sh phải chạy được");
        assert_eq!(r.stdout.trim(), "out");
        assert_eq!(r.stderr.trim(), "err");
    }
}
