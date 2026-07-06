//! Encode video quay màn hình: chạy `ffmpeg` như sidecar binary (đóng gói
//! cùng app qua `tauri.conf.json` → `bundle.externalBin`), nhận raw frame
//! BGRA qua stdin, xuất H.264/mp4.
//!
//! KHÔNG dùng `tauri-plugin-shell` cho việc này: API sidecar cấp cao của
//! plugin (`CommandChild`) không cho đóng RIÊNG stdin (chỉ có `write()` và
//! `kill()`) — mà ffmpeg cần thấy EOF trên stdin để flush encoder + ghi
//! moov atom rồi tự thoát (kill giữa chừng sẽ ra file mp4 hỏng, không phát
//! được). Dùng thẳng `std::process::Command` để ta tự kiểm soát vòng đời:
//! đóng `ChildStdin` (drop) → ffmpeg tự kết thúc sạch → `wait()` lấy exit
//! code. Việc tìm binary vẫn theo đúng quy ước sidecar của Tauri (nằm cạnh
//! executable chính sau khi CLI copy theo `externalBin`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Tìm binary sidecar cạnh executable hiện tại — cùng quy ước
/// `tauri-plugin-shell` dùng cho `externalBin`: lúc `tauri dev`/`tauri build`,
/// CLI copy `binaries/ffmpeg-<target-triple>` → cạnh binary chính, bỏ hậu tố
/// triple. Khi chạy qua `cargo test`, executable nằm trong `target/debug/deps/`
/// nên phải lùi lên 1 cấp mới đúng chỗ CLI sẽ copy tới.
fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Không đọc được đường dẫn executable: {e}"))?;
    let exe_dir = exe.parent().ok_or("Executable không có thư mục cha")?;
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };
    #[allow(unused_mut)]
    let mut path = base_dir.join(name);
    #[cfg(windows)]
    {
        path.set_extension("exe");
    }
    if !path.exists() {
        return Err(format!(
            "Không tìm thấy sidecar '{name}' tại {} — kiểm tra bundle.externalBin trong tauri.conf.json \
             và src-tauri/binaries/{name}-<target-triple>",
            path.display()
        ));
    }
    Ok(path)
}

/// Tiến trình ffmpeg đang encode — ghi frame qua `write_frame`, kết thúc
/// bằng `finish()` (đóng stdin, đợi ffmpeg mux xong).
pub struct Encoder {
    child: Child,
    stderr_thread: std::thread::JoinHandle<()>,
}

impl Encoder {
    /// Bắt đầu 1 tiến trình ffmpeg nhận rawvideo BGRA (`width`x`height`,
    /// `fps` khung/giây) qua stdin, encode H.264 (`libx264`), ghi mp4 tại
    /// `output_path`. `-movflags +faststart` để file phát ngay khi mở
    /// (moov atom ở đầu file thay vì cuối).
    pub fn start(output_path: &Path, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        let ffmpeg = sidecar_path("ffmpeg")?;

        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgra",
            "-s",
            &format!("{width}x{height}"),
            "-r",
            &fps.to_string(),
            "-i",
            "pipe:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ])
        .arg(output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;

        // Phải đọc liên tục stderr — pipe đầy (thường 64KB) sẽ làm ffmpeg
        // treo khi ghi log lỗi, kéo theo cả write_frame() bị chặn.
        let stderr = child.stderr.take().expect("stderr đã được piped ở trên");
        let stderr_thread = std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[ffmpeg] {line}");
            }
        });

        Ok(Self { child, stderr_thread })
    }

    /// Ghi 1 frame BGRA thô (đúng `width*height*4` byte) vào stdin ffmpeg.
    pub fn write_frame(&mut self, data: &[u8]) -> Result<(), String> {
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "ffmpeg đã đóng stdin".to_string())?;
        stdin
            .write_all(data)
            .map_err(|e| format!("Lỗi ghi frame vào ffmpeg: {e}"))
    }

    /// Đóng stdin (ffmpeg thấy EOF → flush + ghi moov atom + tự thoát),
    /// đợi tiến trình kết thúc và kiểm tra exit code.
    pub fn finish(mut self) -> Result<(), String> {
        drop(self.child.stdin.take());
        let status = self
            .child
            .wait()
            .map_err(|e| format!("Lỗi đợi ffmpeg kết thúc: {e}"))?;
        let _ = self.stderr_thread.join();
        if !status.success() {
            return Err(format!("ffmpeg thoát với lỗi: {status}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode 30 frame gradient tổng hợp (không cần quyền Screen Recording,
    /// không phụ thuộc macOS) → xác nhận pipeline ffmpeg hoạt động đúng.
    /// Yêu cầu: `src-tauri/binaries/ffmpeg-<target-triple>` tồn tại và đã
    /// được copy cạnh test binary (mô phỏng bước `externalBin` của Tauri CLI)
    /// — khi chạy qua `tauri dev`/`tauri build` việc này tự động.
    #[test]
    fn encodes_synthetic_frames_to_mp4() {
        let width = 320u32;
        let height = 240u32;
        let fps = 10u32;
        let frame_count = 30u32;

        let out = std::env::temp_dir().join("snapdoc_encoder_test.mp4");
        let mut encoder =
            Encoder::start(&out, width, height, fps).expect("Encoder::start thất bại");

        for i in 0..frame_count {
            let level = ((i * 255) / frame_count) as u8;
            let mut frame = vec![0u8; (width * height * 4) as usize];
            for px in frame.chunks_exact_mut(4) {
                px[0] = level; // B
                px[1] = 255 - level; // G
                px[2] = 128; // R
                px[3] = 255; // A
            }
            encoder.write_frame(&frame).expect("write_frame thất bại");
        }

        encoder.finish().expect("finish thất bại");

        let meta = std::fs::metadata(&out).expect("không đọc được file output");
        assert!(
            meta.len() > 1000,
            "file mp4 quá nhỏ ({} byte), có thể encode lỗi",
            meta.len()
        );
        eprintln!(
            "[test] đã encode {frame_count} frame -> {} ({} byte)",
            out.display(),
            meta.len()
        );
    }
}
