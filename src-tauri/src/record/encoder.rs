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

static DETECTED_ENCODER_ARGS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

fn test_encoder(ffmpeg: &Path, encoder_name: &str, extra_args: &[&str]) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=0.04",
        "-c:v",
        encoder_name,
    ]);
    cmd.args(extra_args);
    cmd.args(["-f", "null", "-"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.status() {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

/// Pre-warm detection of best H.264 encoder in background during startup,
/// avoiding ~1s delay when user starts their first recording.
pub fn prewarm_encoder() {
    std::thread::Builder::new()
        .name("snapdoc-encoder-prewarm".into())
        .spawn(|| {
            if let Ok(ffmpeg) = sidecar_path("ffmpeg") {
                let _ = best_h264_encoder_args(&ffmpeg);
            }
        })
        .ok();
}

fn best_h264_encoder_args(ffmpeg: &Path) -> &'static [String] {
    DETECTED_ENCODER_ARGS.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            // 1. Thử NVIDIA NVENC (card rời NVIDIA)
            if test_encoder(ffmpeg, "h264_nvenc", &["-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p"]) {
                eprintln!("[SnapDoc][record] Dùng hardware encoder: h264_nvenc (NVIDIA)");
                return vec![
                    "-c:v".to_string(), "h264_nvenc".to_string(),
                    "-preset".to_string(), "p4".to_string(),
                    "-cq".to_string(), "23".to_string(),
                    "-pix_fmt".to_string(), "yuv420p".to_string(),
                ];
            }
            // 2. Thử Intel QuickSync (card onboard hoặc rời Intel)
            if test_encoder(ffmpeg, "h264_qsv", &["-global_quality", "23", "-pix_fmt", "nv12"]) {
                eprintln!("[SnapDoc][record] Dùng hardware encoder: h264_qsv (Intel QuickSync)");
                return vec![
                    "-c:v".to_string(), "h264_qsv".to_string(),
                    "-global_quality".to_string(), "23".to_string(),
                    "-pix_fmt".to_string(), "nv12".to_string(),
                ];
            }
            // 3. Thử AMD AMF (card rời AMD)
            if test_encoder(ffmpeg, "h264_amf", &["-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23", "-pix_fmt", "yuv420p"]) {
                eprintln!("[SnapDoc][record] Dùng hardware encoder: h264_amf (AMD)");
                return vec![
                    "-c:v".to_string(), "h264_amf".to_string(),
                    "-quality".to_string(), "speed".to_string(),
                    "-rc".to_string(), "cqp".to_string(),
                    "-qp_i".to_string(), "23".to_string(),
                    "-qp_p".to_string(), "23".to_string(),
                    "-pix_fmt".to_string(), "yuv420p".to_string(),
                ];
            }
            // 4. Thử Windows Media Foundation (tích hợp sẵn trên Windows 10/11)
            if test_encoder(ffmpeg, "h264_mf", &["-b:v", "5M", "-pix_fmt", "yuv420p"]) {
                eprintln!("[SnapDoc][record] Dùng hardware encoder: h264_mf (Windows Media Foundation)");
                return vec![
                    "-c:v".to_string(), "h264_mf".to_string(),
                    "-b:v".to_string(), "5M".to_string(),
                    "-pix_fmt".to_string(), "yuv420p".to_string(),
                ];
            }
            // 5. Fallback: libx264 siêu nhẹ (ultrafast + zerolatency) cho máy Windows yếu
            eprintln!("[SnapDoc][record] Không có hardware encoder, fallback libx264 ultrafast cho máy yếu");
            vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "ultrafast".to_string(),
                "-tune".to_string(), "zerolatency".to_string(),
                "-crf".to_string(), "26".to_string(),
                "-pix_fmt".to_string(), "yuv420p".to_string(),
            ]
        }

        #[cfg(target_os = "macos")]
        {
            if test_encoder(ffmpeg, "h264_videotoolbox", &["-q:v", "60", "-pix_fmt", "yuv420p"]) {
                eprintln!("[SnapDoc][record] Dùng hardware encoder: h264_videotoolbox (Apple Silicon / Intel Mac)");
                return vec![
                    "-c:v".to_string(), "h264_videotoolbox".to_string(),
                    "-q:v".to_string(), "60".to_string(),
                    "-pix_fmt".to_string(), "yuv420p".to_string(),
                ];
            }
            eprintln!("[SnapDoc][record] Dùng fallback libx264 veryfast");
            vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "veryfast".to_string(),
                "-crf".to_string(), "20".to_string(),
                "-pix_fmt".to_string(), "yuv420p".to_string(),
            ]
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-preset".to_string(), "veryfast".to_string(),
                "-crf".to_string(), "20".to_string(),
                "-pix_fmt".to_string(), "yuv420p".to_string(),
            ]
        }
    })
}

impl Encoder {
    /// Bắt đầu 1 tiến trình ffmpeg nhận rawvideo BGRA (`width`x`height`,
    /// `fps` khung/giây) qua stdin, encode H.264 (hardware nếu có, fallback libx264),
    /// ghi mp4 tại `output_path`. `-movflags +faststart` để file phát ngay khi mở
    /// (moov atom ở đầu file thay vì cuối).
    pub fn start(output_path: &Path, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        let ffmpeg = sidecar_path("ffmpeg")?;
        let enc_args = best_h264_encoder_args(&ffmpeg);

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
        ]);
        cmd.args(enc_args);
        cmd.args([
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
/// Khi `is_mic = true`, áp dụng `dynaudnorm` để tự động khuếch đại giọng nói
/// lên mức to rõ chuẩn phòng thu (peak 0.95) và chống vỡ tiếng.
pub fn mux_audio(
    video_path: &Path,
    audio_path: &Path,
    sample_rate: u32,
    channels: u16,
    is_mic: bool,
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = sidecar_path("ffmpeg")?;

    let filter_arg = if is_mic {
        "aresample=async=1000:first_pts=0,dynaudnorm=f=150:g=15:p=0.95:m=10.0"
    } else {
        "aresample=async=1000:first_pts=0"
    };

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .arg("-i")
        .arg(video_path)
        .args(["-f", "s16le", "-ar", &sample_rate.to_string(), "-ac", &channels.to_string()])
        .arg("-i")
        .arg(audio_path)
        // -map tường minh: input 0 (mp4) chỉ có video, input 1 (raw PCM) chỉ
        // có audio — không dựa vào auto-mapping mặc định của ffmpeg để loại
        // hẳn khả năng nó chọn nhầm/bỏ sót stream. Thêm aresample async=1000
        // và -shortest để đồng bộ thời lượng tuyệt đối giữa audio và video,
        // chống lệch tiếng sau khi pause/resume nhiều lần.
        .args([
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
            "-af", filter_arg,
            "-shortest",
            "-movflags", "+faststart",
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

/// Ghép và trộn 2 nguồn audio thô (PCM s16le, Microphone + Âm thanh hệ thống)
/// vào video ĐÃ QUAY XONG bằng 1 lần chạy ffmpeg TĨNH.
///
/// Xử lý cân bằng âm thanh chuyên nghiệp:
/// 1. `mic`: Áp dụng `dynaudnorm` (Dynamic Audio Normalizer) tự động khuếch đại
///    thông minh tiếng micro lên mức to rõ (peak 0.95) mà không bị vỡ tiếng.
/// 2. `sys`: Âm thanh hệ thống (vốn đã ở mức cực đại 0 dBFS) được cân chỉnh về 0.45×
///    để làm nền hài hòa, không lấn át tiếng nói thuyết minh của người dùng.
/// 3. `aresample=async=1000:first_pts=0` độc lập trên từng nguồn để căn chuẩn
///    tuyệt đối mốc thời gian sau các lần Tạm dừng (Pause) & Tiếp tục (Resume).
pub fn mux_dual_audio(
    video_path: &Path,
    mic_path: &Path,
    mic_sample_rate: u32,
    mic_channels: u16,
    sys_path: &Path,
    sys_sample_rate: u32,
    sys_channels: u16,
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = sidecar_path("ffmpeg")?;

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .arg("-i")
        .arg(video_path)
        .args(["-f", "s16le", "-ar", &mic_sample_rate.to_string(), "-ac", &mic_channels.to_string()])
        .arg("-i")
        .arg(mic_path)
        .args(["-f", "s16le", "-ar", &sys_sample_rate.to_string(), "-ac", &sys_channels.to_string()])
        .arg("-i")
        .arg(sys_path)
        .args([
            "-filter_complex",
            "[1:a]aresample=async=1000:first_pts=0,dynaudnorm=f=150:g=15:p=0.95:m=10.0[mic];[2:a]aresample=async=1000:first_pts=0,volume=0.45[sys];[mic][sys]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,aresample=async=1000:first_pts=0,alimiter=limit=0.95[aout]",
            "-map", "0:v:0", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
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
        return Err(format!("ffmpeg ghép dual audio thất bại: {} — {stderr}", output.status));
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
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOverlay {
    pub id: String,
    #[serde(rename = "type")]
    pub overlay_type: String,
    #[serde(default)]
    pub rel_x: f64,
    #[serde(default)]
    pub rel_y: f64,
    #[serde(default)]
    pub rel_w: f64,
    #[serde(default)]
    pub rel_h: f64,
    #[serde(default)]
    pub start_time_ms: f64,
    #[serde(default)]
    pub end_time_ms: f64,
    #[serde(default)]
    pub stroke_color: Option<String>,
    #[serde(default)]
    pub stroke_width: Option<f64>,
    #[serde(default)]
    pub is_blackout: Option<bool>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub image_data: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub text_color: Option<String>,
    #[serde(default)]
    pub has_background: Option<bool>,
    #[serde(default)]
    pub arrow_start_x: Option<f64>,
    #[serde(default)]
    pub arrow_start_y: Option<f64>,
    #[serde(default)]
    pub arrow_end_x: Option<f64>,
    #[serde(default)]
    pub arrow_end_y: Option<f64>,
}

/// Toạ độ và kích thước vùng crop không gian (X, Y, W, H tính theo pixel thực tế của video).
#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoCrop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoomSegment {
    pub id: String,
    pub start_time_ms: f64,
    pub end_time_ms: f64,
    pub scale: f64,
    pub focus_x: f64,
    pub focus_y: f64,
    #[serde(default)]
    pub easing: Option<String>,
}

/// Sinh chuỗi filter atempo cho FFmpeg (hỗ trợ speed từ 0.05 đến 16.0 bằng cách xâu chuỗi atempo=2.0 hoặc atempo=0.5).
pub fn build_atempo_filter(speed: f64) -> String {
    let mut s = if speed > 0.01 { speed } else { 1.0 };
    let mut filters = Vec::new();
    while s > 2.0001 {
        filters.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.4999 {
        filters.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 0.001 {
        if (s - 2.0).abs() < 0.001 {
            filters.push("atempo=2.0".to_string());
        } else if (s - 0.5).abs() < 0.001 {
            filters.push("atempo=0.5".to_string());
        } else {
            let formatted = format!("{:.4}", s);
            let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
            filters.push(format!("atempo={trimmed}"));
        }
    }
    if filters.is_empty() {
        "anull".to_string()
    } else {
        filters.join(",")
    }
}

pub fn build_overlay_filter_graph(
    overlays: &[VideoOverlay],
    image_overlays: &[&VideoOverlay],
    crop: Option<&VideoCrop>,
    zoom_segments: Option<&[ZoomSegment]>,
    video_size: Option<(u32, u32)>,
    speed: Option<f64>,
) -> Option<String> {
    let has_speed = speed.map(|s| (s - 1.0).abs() > 0.01).unwrap_or(false);
    let valid: Vec<&VideoOverlay> = overlays
        .iter()
        .filter(|o| o.rel_w > 0.001 && o.rel_h > 0.001 && o.end_time_ms > o.start_time_ms)
        .collect();
    let has_zooms = zoom_segments
        .map(|zs| zs.iter().any(|z| z.scale > 1.01 && z.end_time_ms > z.start_time_ms))
        .unwrap_or(false);

    let crop_filter = crop.map(|c| {
        let cw = (c.width / 2) * 2;
        let ch = (c.height / 2) * 2;
        format!("crop={cw}:{ch}:{}:{}", c.x, c.y)
    });

    if valid.is_empty() && image_overlays.is_empty() && !has_zooms {
        if let Some(cf) = crop_filter {
            if has_speed {
                let sp = speed.unwrap();
                return Some(format!("[0:v]{cf},setpts={:.4}*PTS[outv]", 1.0 / sp));
            } else {
                return Some(format!("[0:v]{cf}[outv]"));
            }
        } else if has_speed {
            let sp = speed.unwrap();
            return Some(format!("[0:v]setpts={:.4}*PTS[outv]", 1.0 / sp));
        } else {
            return None;
        }
    }

    let mut fg = String::new();
    let base_input: String;

    if let Some(cf) = crop_filter {
        fg.push_str(&format!("[0:v]{cf}[v_cropped];"));
        if has_speed {
            let sp = speed.unwrap();
            fg.push_str(&format!("[v_cropped]setpts={:.4}*PTS[v_speed];", 1.0 / sp));
            base_input = "v_speed".to_string();
        } else {
            base_input = "v_cropped".to_string();
        }
    } else if has_speed {
        let sp = speed.unwrap();
        fg.push_str(&format!("[0:v]setpts={:.4}*PTS[v_speed];", 1.0 / sp));
        base_input = "v_speed".to_string();
    } else {
        base_input = "0:v".to_string();
    }

    let mut soft_blurs = Vec::new();
    let mut boxes = Vec::new();

    for o in &valid {
        if o.overlay_type == "blur" && !o.is_blackout.unwrap_or(false) {
            soft_blurs.push(*o);
        } else if o.overlay_type == "rect" || (o.overlay_type == "blur" && o.is_blackout.unwrap_or(false)) {
            boxes.push(*o);
        }
    }

    let last_blur_label: String;

    if !soft_blurs.is_empty() {
        let n = soft_blurs.len();
        if base_input == "0:v" {
            fg.push_str(&format!("[0:v]split={}[base]", n + 1));
        } else {
            fg.push_str(&format!("[{base_input}]split={}[base]", n + 1));
        }
        for i in 0..n {
            fg.push_str(&format!("[c{i}]"));
        }
        fg.push(';');

        for (i, o) in soft_blurs.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let rw = o.rel_w.clamp(0.001, 1.0 - rx);
            let rh = o.rel_h.clamp(0.001, 1.0 - ry);
            fg.push_str(&format!(
                "[c{i}]crop=w='trunc(iw*{rw:.4})':h='trunc(ih*{rh:.4})':x='trunc(iw*{rx:.4})':y='trunc(ih*{ry:.4})',avgblur=sizeX=16:sizeY=16[b{i}];"
            ));
        }

        let mut prev = "base".to_string();
        for (i, o) in soft_blurs.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let s_sec = o.start_time_ms / 1000.0;
            let e_sec = o.end_time_ms / 1000.0;
            let next_label = format!("m{i}");
            fg.push_str(&format!(
                "[{prev}][b{i}]overlay=x='trunc(main_w*{rx:.4})':y='trunc(main_h*{ry:.4})':enable='between(t,{s_sec:.3},{e_sec:.3})'[{next_label}];"
            ));
            prev = next_label;
        }
        last_blur_label = prev;
    } else {
        last_blur_label = base_input;
    }

    let mut prev = last_blur_label;

    if !boxes.is_empty() {
        for (i, o) in boxes.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let rw = o.rel_w.clamp(0.001, 1.0 - rx);
            let rh = o.rel_h.clamp(0.001, 1.0 - ry);
            let s_sec = o.start_time_ms / 1000.0;
            let e_sec = o.end_time_ms / 1000.0;

            let (color, thickness) = if o.overlay_type == "blur" && o.is_blackout.unwrap_or(false) {
                ("black".to_string(), "fill".to_string())
            } else {
                let col = o.stroke_color.as_deref().unwrap_or("#ef4444");
                let clean_col = if let Some(hex) = col.strip_prefix('#') {
                    format!("0x{hex}")
                } else {
                    col.to_string()
                };
                let w = o.stroke_width.unwrap_or(3.0).max(1.0).round() as u32;
                (clean_col, w.to_string())
            };

            let next_label = format!("box{i}");
            fg.push_str(&format!(
                "[{prev}]drawbox=x='trunc(iw*{rx:.4})':y='trunc(ih*{ry:.4})':w='trunc(iw*{rw:.4})':h='trunc(ih*{rh:.4})':color={color}:t={thickness}:enable='between(t,{s_sec:.3},{e_sec:.3})'[{next_label}];"
            ));
            prev = next_label;
        }
    }

    if !image_overlays.is_empty() {
        for (i, o) in image_overlays.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let s_sec = o.start_time_ms / 1000.0;
            let e_sec = o.end_time_ms / 1000.0;
            let input_idx = 1 + i;
            let next_label = format!("img{i}");
            fg.push_str(&format!(
                "[{prev}][{input_idx}:v]overlay=x='trunc(main_w*{rx:.4})':y='trunc(main_h*{ry:.4})':enable='between(t,{s_sec:.3},{e_sec:.3})':shortest=1:eof_action=pass[{next_label}];"
            ));
            prev = next_label;
        }
    }

    if let Some(zooms) = zoom_segments {
        let valid_zooms: Vec<&ZoomSegment> = zooms
            .iter()
            .filter(|z| z.scale > 1.01 && z.end_time_ms > z.start_time_ms)
            .collect();
        if !valid_zooms.is_empty() {
            let (vw, vh) = video_size.unwrap_or((1920, 1080));
            let vw = if vw > 0 { vw } else { 1920 };
            let vh = if vh > 0 { vh } else { 1080 };

            for (idx, z) in valid_zooms.iter().enumerate() {
                let ts = z.start_time_ms / 1000.0;
                let te = z.end_time_ms / 1000.0;
                let dur = te - ts;
                let tr = 0.65f64.min(dur * 0.35).max(0.25);
                let scale = z.scale.max(1.05);
                let fx = z.focus_x.clamp(0.0, 1.0);
                let fy = z.focus_y.clamp(0.0, 1.0);

                let ts_tr = ts + tr;
                let te_tr = te - tr;

                let z_expr = format!(
                    "if(between(it,{ts:.3},{ts_tr:.3}),1.0+({scale}-1.0)*(6*pow((it-{ts:.3})/{tr:.3},5)-15*pow((it-{ts:.3})/{tr:.3},4)+10*pow((it-{ts:.3})/{tr:.3},3)),\
                     if(between(it,{te_tr:.3},{te:.3}),1.0+({scale}-1.0)*(6*pow(({te:.3}-it)/{tr:.3},5)-15*pow(({te:.3}-it)/{tr:.3},4)+10*pow(({te:.3}-it)/{tr:.3},3)),\
                     if(between(it,{ts_tr:.3},{te_tr:.3}),{scale},1.0)))"
                );
                let x_expr = format!(
                    "min(max(0,(iw/2+(iw*{fx:.4}-iw/2)*(zoom-1)/({scale}-1))-iw/zoom/2),iw-iw/zoom)"
                );
                let y_expr = format!(
                    "min(max(0,(ih/2+(ih*{fy:.4}-ih/2)*(zoom-1)/({scale}-1))-ih/zoom/2),ih-ih/zoom)"
                );

                let next_label = format!("zm{idx}");
                fg.push_str(&format!(
                    "[{prev}]zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={vw}x{vh}:fps=30[{next_label}];"
                ));
                prev = next_label;
            }
        }
    }

    if prev != "0:v" {
        fg.push_str(&format!("[{prev}]null[outv];"));
    } else {
        fg.push_str("[0:v]null[outv];");
    }

    if fg.ends_with(';') {
        fg.pop();
    }

    Some(fg)
}

/// Stream copy video nhanh mà không cần re-encode, chỉ loại bỏ audio stream (-an).
pub fn copy_without_audio(input_path: &Path, output_path: &Path) -> Result<(), String> {
    let ffmpeg = sidecar_path("ffmpeg")?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
    ])
    .arg(input_path)
    .args([
        "-c:v",
        "copy",
        "-an",
        "-movflags",
        "+faststart",
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
        return Err(format!("ffmpeg tách âm thanh thất bại: {stderr}"));
    }
    Ok(())
}

pub fn trim(
    input_path: &Path,
    keep_ranges_ms: &[(i64, i64, f64)],
    output_path: &Path,
    remove_audio: bool,
    overlays: Option<&[VideoOverlay]>,
    crop: Option<&VideoCrop>,
    zoom_segments: Option<&[ZoomSegment]>,
    video_size: Option<(u32, u32)>,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    if keep_ranges_ms.is_empty() {
        return Err("Không có đoạn nào được giữ lại".to_string());
    }

    let ffmpeg = sidecar_path("ffmpeg")?;
    let tmp_dir = std::env::temp_dir().join(format!("snapdoc-trim-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Không tạo được thư mục tạm: {e}"))?;

    let total_ms: i64 = keep_ranges_ms
        .iter()
        .map(|(s, e, sp)| {
            let speed = if *sp > 0.01 { *sp } else { 1.0 };
            (((*e - *s).max(0) as f64) / speed).round() as i64
        })
        .sum::<i64>()
        .max(1);
    on_progress(0.0);

    let mut run = || -> Result<(), String> {
        // Giải mã các overlay dạng ảnh (Text, Arrow, ...) ra file PNG tạm trước
        let mut image_overlays: Vec<(std::path::PathBuf, &VideoOverlay)> = Vec::new();
        if let Some(ovls) = overlays {
            for (idx, o) in ovls.iter().enumerate() {
                if let Some(data_url) = &o.image_data {
                    let clean_b64 = if let Some(comma_pos) = data_url.find(',') {
                        &data_url[comma_pos + 1..]
                    } else {
                        data_url.as_str()
                    };
                    use base64::Engine;
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(clean_b64.trim()) {
                        let img_path = tmp_dir.join(format!("ovl_img_{idx}.png"));
                        if std::fs::write(&img_path, bytes).is_ok() {
                            image_overlays.push((img_path, o));
                        }
                    }
                }
            }
        }

        let img_refs: Vec<&VideoOverlay> = image_overlays.iter().map(|(_, o)| *o).collect();
        let single_pass_speed = if keep_ranges_ms.len() == 1 && (keep_ranges_ms[0].2 - 1.0).abs() > 0.01 {
            Some(keep_ranges_ms[0].2)
        } else {
            None
        };
        let filter_graph = build_overlay_filter_graph(
            overlays.unwrap_or(&[]),
            &img_refs,
            crop,
            zoom_segments,
            video_size,
            single_pass_speed,
        );

        // TỐI ƯU HOÁ: Nếu chỉ có 1 đoạn giữ lại (chiếm đa số các tác vụ cắt hoặc thêm overlay),
        // chạy Single-Pass: cắt thời lượng + áp dụng filter graph + encode trong 1 lệnh duy nhất!
        // Tránh hoàn toàn việc encode seg_0.mp4 rồi lại re-encode lần 2 khi có overlay.
        if keep_ranges_ms.len() == 1 {
            let (start_ms, end_ms, speed) = keep_ranges_ms[0];
            let start_s = (start_ms as f64) / 1000.0;
            let dur_ms = (end_ms - start_ms).max(0);
            let dur_s = (dur_ms as f64) / 1000.0;
            let has_speed = (speed - 1.0).abs() > 0.01;
            let effective_speed = if speed > 0.01 { speed } else { 1.0 };
            let seg_play_ms = ((dur_ms as f64) / effective_speed).round() as i64;

            let mut cmd = Command::new(&ffmpeg);
            cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
            if start_ms > 0 {
                // Fast input seek: -ss trước -i
                cmd.args(["-ss", &format!("{start_s:.3}")]);
            }
            cmd.arg("-i").arg(input_path);
            cmd.args(["-t", &format!("{dur_s:.3}")]);

            for (img_path, _) in &image_overlays {
                cmd.args(["-loop", "1", "-i"]).arg(img_path);
            }

            if let Some(fg) = &filter_graph {
                cmd.args(["-filter_complex", fg])
                    .args(["-map", "[outv]"]);
                cmd.arg("-shortest");
            } else {
                cmd.args(["-map", "0:v:0"]);
            }

            cmd.args(best_h264_encoder_args(&ffmpeg));

            if remove_audio {
                cmd.arg("-an");
            } else if has_speed {
                let af = build_atempo_filter(speed);
                cmd.args(["-map", "0:a?", "-af", &af, "-c:a", "aac", "-b:a", "160k"]);
            } else if start_ms > 0 {
                // Tránh lệch sync âm thanh khi seek
                cmd.args(["-map", "0:a?", "-c:a", "aac", "-b:a", "160k"]);
            } else {
                cmd.args(["-map", "0:a?", "-c:a", "copy"]);
            }

            cmd.args(["-movflags", "+faststart"])
                .args(["-progress", "pipe:1"])
                .arg(output_path)
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
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(v) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = v.trim().parse::<i64>() {
                            let cur_ms = (us / 1000).clamp(0, seg_play_ms);
                            on_progress((cur_ms as f64 / seg_play_ms.max(1) as f64).min(1.0));
                        }
                    }
                }
            }

            let status = child
                .wait()
                .map_err(|e| format!("ffmpeg lỗi khi chờ tiến trình: {e}"))?;
            let stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                return Err(format!("ffmpeg xử lý video thất bại: {status} — {stderr}"));
            }

            on_progress(1.0);
            return Ok(());
        }

        // Trường hợp nhiều đoạn giữ lại (xoá đoạn ở giữa): encode từng đoạn với fast seeking
        let mut seg_paths = Vec::with_capacity(keep_ranges_ms.len());
        let mut done_ms: i64 = 0;
        for (i, (start_ms, end_ms, speed)) in keep_ranges_ms.iter().enumerate() {
            let seg_path = tmp_dir.join(format!("seg_{i}.mp4"));
            let start_s = (*start_ms as f64) / 1000.0;
            let dur_ms = (*end_ms - *start_ms).max(0);
            let dur_s = (dur_ms as f64) / 1000.0;
            let has_speed = (*speed - 1.0).abs() > 0.01;
            let effective_speed = if *speed > 0.01 { *speed } else { 1.0 };
            let seg_play_ms = ((dur_ms as f64) / effective_speed).round() as i64;

            let mut cmd = Command::new(&ffmpeg);
            cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
            if *start_ms > 0 {
                cmd.args(["-ss", &format!("{start_s:.3}")]);
            }
            cmd.arg("-i").arg(input_path);
            cmd.args(["-t", &format!("{dur_s:.3}")]);

            if has_speed {
                cmd.args(["-vf", &format!("setpts={:.4}*PTS", 1.0 / speed)]);
            }

            cmd.args(best_h264_encoder_args(&ffmpeg));
            if remove_audio {
                cmd.arg("-an");
            } else if has_speed {
                let af = build_atempo_filter(*speed);
                cmd.args(["-af", &af, "-c:a", "aac", "-b:a", "160k"]);
            } else {
                cmd.args(["-c:a", "aac", "-b:a", "160k"]);
            }
            cmd.args(["-progress", "pipe:1"])
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
                            let cur_ms = (us / 1000).clamp(0, seg_play_ms);
                            on_progress(((seg_base_ms + cur_ms) as f64 / total_ms as f64).min(1.0));
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
            done_ms += seg_play_ms;
            on_progress((done_ms as f64 / total_ms as f64).min(1.0));
            seg_paths.push(seg_path);
        }

        let list_path = tmp_dir.join("list.txt");
        let list_content = seg_paths
            .iter()
            .map(|p| format!("file '{}'", p.to_string_lossy().replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&list_path, list_content)
            .map_err(|e| format!("Không ghi được danh sách ghép: {e}"))?;

        let concat_target = if filter_graph.is_some() {
            tmp_dir.join("concat.mp4")
        } else {
            output_path.to_path_buf()
        };

        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0"])
            .arg("-i")
            .arg(&list_path)
            .args(["-map", "0:v:0"])
            .args(["-c:v", "copy"]);
        if !remove_audio {
            cmd.args(["-map", "0:a?", "-c:a", "copy"]);
        }
        cmd.args(["-movflags", "+faststart"])
            .arg(&concat_target)
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

        // Nếu có overlay trên nhiều đoạn ghép, áp dụng filter graph từ concat_target
        if let Some(fg) = filter_graph {
            let mut filter_cmd = Command::new(&ffmpeg);
            filter_cmd
                .args(["-hide_banner", "-loglevel", "error", "-y"])
                .arg("-i")
                .arg(&concat_target);
            for (img_path, _) in &image_overlays {
                filter_cmd.args(["-loop", "1", "-i"]).arg(img_path);
            }
            filter_cmd
                .args(["-filter_complex", &fg])
                .args(["-map", "[outv]"]);
            if !remove_audio {
                filter_cmd.args(["-map", "0:a?", "-c:a", "copy"]);
            }
            let total_sec = (total_ms as f64) / 1000.0;
            filter_cmd.args(["-t", &format!("{total_sec:.3}")]);
            filter_cmd.arg("-shortest");
            filter_cmd.args(best_h264_encoder_args(&ffmpeg));
            filter_cmd
                .args(["-movflags", "+faststart"])
                .arg(output_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                filter_cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let filter_out = filter_cmd
                .output()
                .map_err(|e| format!("Không khởi chạy ffmpeg áp dụng hiệu ứng ({}): {e}", ffmpeg.display()))?;
            if !filter_out.status.success() {
                let stderr = String::from_utf8_lossy(&filter_out.stderr);
                return Err(format!("ffmpeg áp dụng khung/che mờ thất bại: {} — {stderr}", filter_out.status));
            }
        }

        on_progress(1.0);
        Ok(())
    };

    let result = run();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Tuỳ chọn xuất video sang ảnh GIF động.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportOptions {
    pub start_ms: i64,
    pub duration_ms: i64,
    pub fps: u32,
    pub max_width: Option<u32>,
    pub speed: f64,
    pub loop_count: i32, // 0 = lặp vô hạn, -1 = phát 1 lần
}

/// Xuất 1 đoạn video (hoặc toàn bộ) ra file ảnh GIF chất lượng cao.
///
/// Dùng ffmpeg filter 2-pass (palettegen + paletteuse với Bayer dithering)
/// để bảng màu 256 màu đạt độ mịn tối đa, hạn chế răng cưa và giảm kích thước
/// file so với bộ encoder mặc định.
pub fn export_gif(
    input_path: &Path,
    output_path: &Path,
    options: &GifExportOptions,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    if !input_path.exists() {
        return Err(format!("File nguồn không tồn tại: {}", input_path.display()));
    }
    if options.duration_ms <= 0 {
        return Err("Thời lượng xuất GIF phải lớn hơn 0".to_string());
    }

    let ffmpeg = sidecar_path("ffmpeg")?;
    let start_s = (options.start_ms.max(0) as f64) / 1000.0;
    let dur_s = (options.duration_ms.max(100) as f64) / 1000.0;
    let speed = if options.speed > 0.05 { options.speed } else { 1.0 };
    let fps = options.fps.clamp(5, 60);

    let pts_filter = if (speed - 1.0).abs() > 0.01 {
        format!("setpts={:.4}*PTS,", 1.0 / speed)
    } else {
        String::new()
    };

    let scale_filter = match options.max_width {
        Some(w) if w > 0 => format!("scale='min({w},iw)':-2:flags=lanczos"),
        _ => "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos".to_string(),
    };

    let filter_complex = format!(
        "[0:v] {pts_filter}fps={fps},{scale_filter},split [s0][s1]; [s0] palettegen=stats_mode=diff [p]; [s1][p] paletteuse=dither=bayer:bayer_scale=3"
    );

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .arg("-ss")
        .arg(format!("{:.3}", start_s))
        .arg("-t")
        .arg(format!("{:.3}", dur_s))
        .arg("-i")
        .arg(input_path)
        .args(["-filter_complex", &filter_complex])
        .args(["-loop", &options.loop_count.to_string()])
        .args(["-progress", "pipe:1"])
        .arg(output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    on_progress(0.0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;

    let mut stderr_pipe = child.stderr.take().expect("stderr đã piped");
    let stderr_thread = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stderr_pipe.read_to_string(&mut buf);
        buf
    });

    let total_us = ((dur_s / speed) * 1_000_000.0) as i64;
    let stdout = child.stdout.take().expect("stdout đã piped");
    {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<i64>() {
                    let frac = (us as f64 / total_us.max(1) as f64).clamp(0.0, 0.99);
                    on_progress(frac);
                }
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg lỗi khi chờ tiến trình: {e}"))?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("Xuất GIF thất bại: {status} — {stderr}"));
    }

    on_progress(1.0);
    Ok(())
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
        mux_audio(&video_path, &audio_path, 44_100, 1, false, &out)
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
        let mut last_progress: f64 = 0.0;
        // `remove_audio = false`: video test không có audio track, và test này
        // kiểm cú pháp ffmpeg của đường cắt, không kiểm nhánh bỏ audio.
        trim(
            &src,
            &[(0, 1_500, 1.0), (3_500, 5_000, 1.0)],
            &out,
            false,
            None,
            None,
            None,
            None,
            |p| last_progress = p,
        )
        .expect("trim() thất bại — kiểm tra cú pháp ffmpeg");
        assert!((last_progress - 1.0).abs() < 1e-9, "progress cuối phải là 1.0, thấy {last_progress}");

        let meta = std::fs::metadata(&out).expect("không đọc được file output");
        assert!(meta.len() > 1000, "file mp4 sau khi cắt quá nhỏ ({} byte)", meta.len());
        eprintln!("[test] đã cắt video -> {} ({} byte)", out.display(), meta.len());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_atempo_filter_chain() {
        assert_eq!(build_atempo_filter(1.0), "anull");
        assert_eq!(build_atempo_filter(2.0), "atempo=2.0");
        assert_eq!(build_atempo_filter(4.0), "atempo=2.0,atempo=2.0");
        assert_eq!(build_atempo_filter(0.5), "atempo=0.5");
        assert_eq!(build_atempo_filter(0.25), "atempo=0.5,atempo=0.5");
        assert_eq!(build_atempo_filter(1.5), "atempo=1.5");
    }
}


