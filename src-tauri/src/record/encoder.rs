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
pub(crate) fn sidecar_path(name: &str) -> Result<PathBuf, String> {
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
///
/// `stderr_thread` bọc `Option` để cả `finish()` lẫn `Drop` đều join được —
/// `Drop` là lưới an toàn cho nhánh LỖI (vd `write_frame` gặp broken pipe và
/// closure của writer thread return sớm bằng `?`): không có nó, `Child` bị
/// drop mà không `kill()`/`wait()` → tiến trình ffmpeg thành zombie (Unix
/// không tự reap con), mỗi lần quay lỗi rò thêm 1 process.
pub struct Encoder {
    child: Child,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // `finish()` đã chạy trọn vẹn (stdin + stderr_thread đều đã take) →
        // không còn gì để dọn.
        if self.child.stdin.is_none() && self.stderr_thread.is_none() {
            return;
        }
        // Đóng stdin để ffmpeg thấy EOF → flush encoder + ghi moov atom; chờ
        // tối đa 3s cho nó tự thoát sạch (file mp4 có thể vẫn phát được),
        // quá hạn thì kill để không rò process.
        drop(self.child.stdin.take());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        if let Some(t) = self.stderr_thread.take() {
            let _ = t.join();
        }
    }
}

impl Encoder {
    /// Bắt đầu 1 tiến trình ffmpeg nhận rawvideo BGRA (`width`x`height`,
    /// `fps` khung/giây) qua stdin, encode H.264 (`libx264`), ghi mp4 tại
    /// `output_path`. `-movflags +faststart` để file phát ngay khi mở
    /// (moov atom ở đầu file thay vì cuối).
    ///
    /// CHỈ video — KHÔNG nhận thêm input audio nào ở đây nữa (khác Phase 4
    /// ban đầu). Lý do: ffmpeg (scheduler đa luồng bản mới) đồng bộ nhiều
    /// input SỐNG (pipe/fifo) với nhau — hễ 1 bên (audio) khựng lại vì bất kỳ
    /// lý do gì, ffmpeg tạm dừng đọc luôn CẢ VIDEO để tránh 2 stream lệch xa
    /// nhau, kéo theo kênh buffer riêng của app (`record/mod.rs`) đầy sau
    /// đúng vài giây rồi bắt đầu drop frame lặng lẽ — quay bao lâu file cũng
    /// chỉ có vài giây đầu. Audio giờ ghi ra file thô RIÊNG (không qua
    /// ffmpeg lúc quay), rồi ghép vào SAU khi quay xong bằng `mux_audio` —
    /// lúc đó cả 2 input đều là file tĩnh, không còn kiểu đồng bộ "sống" gây
    /// treo này nữa.
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

        Ok(Self { child, stderr_thread: Some(stderr_thread) })
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
        if let Some(t) = self.stderr_thread.take() {
            let _ = t.join();
        }
        if !status.success() {
            return Err(format!("ffmpeg thoát với lỗi: {status}"));
        }
        Ok(())
    }
}

/// Ghép audio thô (PCM s16le, ghi trực tiếp ra file trong lúc quay — xem
/// `record/mod.rs`) vào video ĐÃ QUAY XONG, chạy 1 LẦN sau khi dừng quay.
/// Khác `Encoder::start`: cả 2 input ở đây đều là FILE TĨNH (không phải
/// pipe/fifo sống), nên không có rủi ro ffmpeg đồng bộ-rồi-treo giữa 2 input
/// như hướng live-mux cũ. `-c:v copy`: giữ nguyên video đã encode, không mã
/// hoá lại (nhanh, không mất chất lượng) — chỉ ghép thêm audio track AAC.
pub fn mux_audio(
    video_path: &Path,
    audio_path: &Path,
    sample_rate: u32,
    channels: u16,
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = sidecar_path("ffmpeg")?;

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .arg("-i")
        .arg(video_path)
        .args(["-f", "s16le", "-ar", &sample_rate.to_string(), "-ac", &channels.to_string()])
        .arg("-i")
        .arg(audio_path)
        // -map tường minh: input 0 (mp4) chỉ có video, input 1 (raw PCM) chỉ
        // có audio — không dựa vào auto-mapping mặc định của ffmpeg để loại
        // hẳn khả năng nó chọn nhầm/bỏ sót stream.
        .args([
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        ])
        .arg(output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg ghép audio thất bại: {} — {stderr}", output.status));
    }
    Ok(())
}

/// Cắt video theo danh sách đoạn GIỮ LẠI (ms, đã sort tăng dần, không chồng
/// lấp) — dùng cho cả trim đầu/cuối (1 đoạn) và xoá đoạn giữa (nhiều đoạn).
/// Re-encode từng đoạn (KHÔNG dùng `-c:v copy`) để cắt chính xác tới bất kỳ
/// mốc thời gian nào: `Encoder::start` không set GOP nhỏ nên `-c copy` chỉ
/// cắt được ở keyframe gần nhất (mặc định libx264 ~250 frame, tức ~8s ở
/// 30fps) — không đủ chính xác cho việc người dùng tự chọn mốc cắt. Video
/// quay màn hình thường ngắn nên re-encode không đáng lo hiệu năng.
///
/// Mỗi đoạn giữ lại được encode ra 1 file tạm riêng (`-ss`/`-t` ĐẶT SAU
/// `-i` để seek chính xác tới frame thay vì snap theo keyframe; dùng `-t`
/// thay vì `-to` để tránh nhập nhằng absolute/relative timestamp của ffmpeg
/// khi `-ss` cũng là output option), rồi LUÔN ghép lại bằng 1 lệnh concat
/// demuxer `-c copy` — kể cả khi chỉ có 1 đoạn (1 code path duy nhất, chi phí
/// thêm không đáng kể). `output_path` chỉ được ghi khi mọi bước thành công —
/// `input_path` không bao giờ bị đụng vào (caller tự quyết định
/// `fs::rename` đè lên file gốc sau khi hàm này trả về `Ok`).
///
/// `on_progress` được gọi liên tục với tỉ lệ 0.0..=1.0 trong lúc encode từng
/// đoạn (đọc `out_time_us=` từ `-progress pipe:1` của ffmpeg — machine-
/// readable, ổn định hơn parse chuỗi `time=` trong stderr thường), quy đổi
/// theo tổng thời lượng CÒN LẠI của mọi đoạn (không phải % số đoạn xong, vì 1
/// đoạn dài có thể chiếm hầu hết thời gian trong khi các đoạn khác rất ngắn).
/// Bước ghép cuối (`-c copy`) rất nhanh nên không cần progress riêng — nhảy
/// thẳng lên `1.0` khi xong.
pub fn trim(
    input_path: &Path,
    keep_ranges_ms: &[(i64, i64)],
    output_path: &Path,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    if keep_ranges_ms.is_empty() {
        return Err("Không có đoạn nào được giữ lại".to_string());
    }

    let ffmpeg = sidecar_path("ffmpeg")?;
    let tmp_dir = std::env::temp_dir().join(format!("snapdoc-trim-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Không tạo được thư mục tạm: {e}"))?;

    let total_ms: i64 = keep_ranges_ms.iter().map(|(s, e)| (e - s).max(0)).sum::<i64>().max(1);
    let mut done_ms: i64 = 0;
    on_progress(0.0);

    let mut run = || -> Result<(), String> {
        let mut seg_paths = Vec::with_capacity(keep_ranges_ms.len());
        for (i, (start_ms, end_ms)) in keep_ranges_ms.iter().enumerate() {
            let seg_path = tmp_dir.join(format!("seg_{i}.mp4"));
            let start_s = (*start_ms as f64) / 1000.0;
            let dur_ms = (*end_ms - *start_ms).max(0);
            let dur_s = (dur_ms as f64) / 1000.0;

            let mut cmd = Command::new(&ffmpeg);
            cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
                .arg("-i")
                .arg(input_path)
                .args([
                    "-ss", &start_s.to_string(),
                    "-t", &dur_s.to_string(),
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "160k",
                    "-progress", "pipe:1",
                ])
                .arg(&seg_path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;
            // Đọc stderr trên thread riêng — chỉ để giữ lại cho thông báo lỗi
            // nếu process thất bại, KHÔNG để buffer đầy gây deadlock (child chờ
            // ghi stderr, ta chờ đọc stdout) trong lúc đọc `-progress` ở dưới.
            let mut stderr_pipe = child.stderr.take().expect("stderr đã piped");
            let stderr_thread = std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = String::new();
                let _ = stderr_pipe.read_to_string(&mut buf);
                buf
            });

            let stdout = child.stdout.take().expect("stdout đã piped");
            {
                use std::io::{BufRead, BufReader};
                let seg_base_ms = done_ms;
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(v) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = v.trim().parse::<i64>() {
                            let seg_ms = (us / 1000).clamp(0, dur_ms);
                            on_progress(((seg_base_ms + seg_ms) as f64 / total_ms as f64).min(1.0));
                        }
                    }
                }
            }

            let status = child
                .wait()
                .map_err(|e| format!("ffmpeg lỗi khi chờ tiến trình: {e}"))?;
            let stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                return Err(format!("ffmpeg cắt đoạn {i} thất bại: {status} — {stderr}"));
            }
            done_ms += dur_ms;
            on_progress((done_ms as f64 / total_ms as f64).min(1.0));
            seg_paths.push(seg_path);
        }

        // Concat demuxer yêu cầu 1 file danh sách text — dùng đường dẫn TUYỆT
        // ĐỐI + `-safe 0` (mặc định concat chặn absolute path để tránh path
        // traversal khi list.txt đến từ nguồn không tin cậy — ở đây ta tự sinh
        // toàn bộ path nên an toàn).
        let list_path = tmp_dir.join("list.txt");
        let list_content = seg_paths
            .iter()
            .map(|p| format!("file '{}'", p.to_string_lossy().replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&list_path, list_content)
            .map_err(|e| format!("Không ghi được danh sách ghép: {e}"))?;

        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0"])
            .arg("-i")
            .arg(&list_path)
            .args(["-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart"])
            .arg(output_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg ghép các đoạn thất bại: {} — {stderr}", output.status));
        }
        on_progress(1.0);
        Ok(())
    };

    let result = run();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
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
        let mut encoder = Encoder::start(&out, width, height, fps).expect("Encoder::start thất bại");

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

    /// Ghép audio thô (PCM s16le TỔNG HỢP, ghi thẳng ra file — không qua
    /// pipe/fifo sống) vào 1 video đã quay xong — xác nhận `mux_audio` chạy
    /// đúng cú pháp ffmpeg, không phụ thuộc timing/threading như cách live-mux
    /// cũ (xem lý do đổi kiến trúc ở doc-comment của `Encoder::start`).
    #[test]
    fn muxes_audio_into_completed_video() {
        let width = 160u32;
        let height = 120u32;
        let fps = 10u32;
        let frame_count = 20u32;

        let tmp_dir = std::env::temp_dir().join("snapdoc_encoder_mux_test");
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let video_path = tmp_dir.join("video_only.mp4");
        let mut encoder =
            Encoder::start(&video_path, width, height, fps).expect("Encoder::start thất bại");
        for i in 0..frame_count {
            let level = ((i * 255) / frame_count) as u8;
            let mut frame = vec![0u8; (width * height * 4) as usize];
            for px in frame.chunks_exact_mut(4) {
                px[0] = level;
                px[1] = 255 - level;
                px[2] = 128;
                px[3] = 255;
            }
            encoder.write_frame(&frame).expect("write_frame thất bại");
        }
        encoder.finish().expect("finish thất bại");

        // Audio thô: 2 giây PCM s16le mono 44100Hz im lặng — chỉ cần đúng
        // định dạng khai báo, nội dung không quan trọng cho test cú pháp.
        let audio_path = tmp_dir.join("audio.pcm");
        std::fs::write(&audio_path, vec![0u8; 44_100 * 2 * 2]).unwrap();

        let out = tmp_dir.join("final.mp4");
        mux_audio(&video_path, &audio_path, 44_100, 1, &out)
            .expect("mux_audio thất bại — kiểm tra lại cú pháp lệnh ffmpeg");

        let meta = std::fs::metadata(&out).expect("không đọc được file output");
        assert!(meta.len() > 1000, "file mp4 quá nhỏ ({} byte)", meta.len());
        eprintln!("[test] đã ghép audio -> {} ({} byte)", out.display(), meta.len());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    /// Encode 1 video 5s (10fps × 50 frame) rồi cắt giữ lại 2 đoạn
    /// (0–1.5s và 3.5–5s), mô phỏng đúng thao tác "xoá đoạn giữa" — xác nhận
    /// `trim()` chạy đúng cú pháp ffmpeg (cả bước re-encode từng đoạn lẫn
    /// bước ghép concat) với sidecar binary thật, không chỉ đúng trên lý
    /// thuyết.
    #[test]
    fn trims_video_by_keeping_two_ranges() {
        let width = 160u32;
        let height = 120u32;
        let fps = 10u32;
        let frame_count = 50u32; // 5s

        let tmp_dir = std::env::temp_dir().join("snapdoc_encoder_trim_test");
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let src = tmp_dir.join("source.mp4");
        let mut encoder = Encoder::start(&src, width, height, fps).expect("Encoder::start thất bại");
        for i in 0..frame_count {
            let level = ((i * 255) / frame_count) as u8;
            let mut frame = vec![0u8; (width * height * 4) as usize];
            for px in frame.chunks_exact_mut(4) {
                px[0] = level;
                px[1] = 255 - level;
                px[2] = 128;
                px[3] = 255;
            }
            encoder.write_frame(&frame).expect("write_frame thất bại");
        }
        encoder.finish().expect("finish thất bại");

        let out = tmp_dir.join("trimmed.mp4");
        // Giữ 0–1.5s và 3.5–5s (xoá đoạn giữa 1.5–3.5s) → kết quả ~3s.
        let mut last_progress = 0.0;
        trim(&src, &[(0, 1_500), (3_500, 5_000)], &out, |p| last_progress = p)
            .expect("trim() thất bại — kiểm tra cú pháp ffmpeg");
        assert!((last_progress - 1.0).abs() < 1e-9, "progress cuối phải là 1.0, thấy {last_progress}");

        let meta = std::fs::metadata(&out).expect("không đọc được file output");
        assert!(meta.len() > 1000, "file mp4 sau khi cắt quá nhỏ ({} byte)", meta.len());
        eprintln!("[test] đã cắt video -> {} ({} byte)", out.display(), meta.len());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
