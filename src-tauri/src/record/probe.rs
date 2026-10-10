//! Module trích xuất metadata (thời lượng, độ phân giải) và remux video ngoài
//! để tương thích 100% với Webview HTML5 Video player và VideoTrimmer.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_ms: i64,
}

/// Parse output `ffmpeg -i` (stderr). `None` nếu không có luồng video nào —
/// dùng để KIỂM TRA 1 file mp4 có thật sự đọc được hay không (vd bản quay
/// vừa hoàn tất / khôi phục sau crash).
fn parse_ffmpeg_info(stderr: &str) -> Option<VideoMetadata> {
    // Chỉ xét dòng "Stream #...: Video: ..." — dòng metadata (vd tag title
    // chứa chữ "Video: ") không được nhầm thành dòng luồng video.
    let video_line = stderr
        .lines()
        .find(|l| l.trim_start().starts_with("Stream #") && l.contains("Video: "))?;
    let after = &video_line[video_line.find("Video: ")? + 7..];

    let mut dims: Option<(u32, u32)> = None;
    for token in after.split(|c: char| c == ',' || c == ' ' || c == '[') {
        let t = token.trim();
        if let Some(x_idx) = t.find('x') {
            if let (Ok(w), Ok(h)) = (t[..x_idx].parse::<u32>(), t[x_idx + 1..].parse::<u32>()) {
                if (16..=16384).contains(&w) && (16..=16384).contains(&h) {
                    dims = Some((w, h));
                    break;
                }
            }
        }
    }
    let (mut width, mut height) = dims?;

    // Video quay dọc từ điện thoại: lưu ngang + displaymatrix xoay ±90° —
    // trình phát hiển thị theo chiều đã xoay nên kích thước cũng phải đảo.
    if let Some(pos) = stderr.find("displaymatrix: rotation of ") {
        let rest = &stderr[pos + "displaymatrix: rotation of ".len()..];
        let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.').collect();
        if let Ok(deg) = num.parse::<f64>() {
            if ((deg.abs() - 90.0).abs() < 1.0) || ((deg.abs() - 270.0).abs() < 1.0) {
                std::mem::swap(&mut width, &mut height);
            }
        }
    }

    let mut duration_ms: i64 = 0;
    if let Some(pos) = stderr.find("Duration: ") {
        let rest = &stderr[pos + 10..];
        if let Some(end) = rest.find(',') {
            let parts: Vec<&str> = rest[..end].trim().split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                duration_ms = ((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as i64;
            }
        }
    }

    Some(VideoMetadata { width, height, duration_ms })
}

/// Chạy FFmpeg để trích xuất metadata (thời lượng, kích thước) của video bất kỳ.
/// Không yêu cầu ffprobe riêng, sử dụng chính sidecar ffmpeg đã có. Lỗi nếu
/// file không có luồng video đọc được.
pub fn probe_video_metadata(video_path: &Path) -> Result<VideoMetadata, String> {
    let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-i"]).arg(video_path);
    // `ffmpeg -i` không có output → luôn exit 1; chỉ cần stderr.
    let out = super::proc::run(&mut cmd, Duration::from_secs(30))
        .map_err(|e| format!("Không chạy được ffmpeg probe: {e}"))?;
    parse_ffmpeg_info(&out.stderr)
        .ok_or_else(|| format!("Không đọc được luồng video trong {}", video_path.display()))
}

/// Kiểm tra nếu file video thuộc định dạng container không tương thích với HTML5 <video>
/// của Webview (như .mkv, .avi) thì remux siêu tốc (copy streams) sang .mp4 trong thư mục cache.
pub fn remux_to_mp4_if_needed(app: &AppHandle, video_path: &Path) -> Result<PathBuf, String> {
    let ext = video_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Các định dạng phát trực tiếp được trên Webview (WebKit / WebView2)
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "webm") {
        return Ok(video_path.to_path_buf());
    }

    if !matches!(ext.as_str(), "mkv" | "avi") {
        return Ok(video_path.to_path_buf());
    }

    // Cần remux sang MP4
    let remux_dir = crate::history::assets::root_dir(app)?
        .join("library")
        .join("remux");
    std::fs::create_dir_all(&remux_dir)
        .map_err(|e| format!("Không tạo được thư mục remux: {e}"))?;

    let file_stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");

    let meta = std::fs::metadata(video_path).ok();
    let mod_time = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let out_name = format!("{file_stem}_{size}_{mod_time}.mp4");
    let out_path = remux_dir.join(out_name);

    if out_path.exists() {
        eprintln!("[SnapDoc][probe] Sử dụng bản remux MP4 đã có sẵn: {}", out_path.display());
        return Ok(out_path);
    }

    // Ghi ra file TẠM rồi mới đổi tên: remux lỗi/crash giữa chừng không để
    // lại 1 file hỏng ở `out_path` (bản cũ ghi thẳng nên lần mở sau thấy file
    // đã "có sẵn" và dùng file hỏng đó mãi mãi).
    let tmp_path = remux_dir.join(format!("{file_stem}_{size}_{mod_time}.{}.part.mp4", uuid::Uuid::new_v4()));
    let timeout = super::proc::timeout_for_file(video_path);

    eprintln!("[SnapDoc][probe] Đang remux nhanh {} sang MP4 tương thích Webview...", video_path.display());
    let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;
    // Thử remux stream copy (-c:v copy -c:a aac) trước để tốc độ cực nhanh (~0.2s)
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(video_path)
        .args(["-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "-f", "mp4"])
        .arg(&tmp_path);
    if let Err(e) = super::proc::run_ok(&mut cmd, timeout, "Remux stream copy") {
        eprintln!("[SnapDoc][probe] {e} — thử transcode nhanh...");
        let mut trans_cmd = Command::new(&ffmpeg);
        trans_cmd
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(video_path)
            .args([
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac",
                "-movflags", "+faststart", "-f", "mp4",
            ])
            .arg(&tmp_path);
        // Transcode lâu hơn remux nhiều — cho thêm thời gian.
        if let Err(e) = super::proc::run_ok(&mut trans_cmd, timeout * 10, "Chuyển đổi video") {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Không thể chuyển đổi video sang định dạng tương thích: {e}"));
        }
    }
    if let Err(e) = std::fs::rename(&tmp_path, &out_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Không lưu được bản remux: {e}"));
    }

    Ok(out_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_regular_mp4() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'test.mp4':
  Duration: 00:00:03.50, start: 0.000000, bitrate: 61 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 56 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
"#;
        let m = parse_ffmpeg_info(stderr).expect("phải parse được");
        assert_eq!((m.width, m.height, m.duration_ms), (640, 360, 3500));
    }

    #[test]
    fn ignores_metadata_lines_and_requires_video_stream() {
        let stderr = r#"
Input #0, mov,mp4 from 'x.mp4':
  Metadata:
    title           : Video: 99x99 tutorial
  Duration: 00:00:01.00, start: 0.000000, bitrate: 61 kb/s
  Stream #0:0(und): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s
"#;
        assert!(parse_ffmpeg_info(stderr).is_none());
    }

    #[test]
    fn swaps_dims_for_rotated_video() {
        let stderr = r#"
  Duration: 00:00:02.00, start: 0.000000, bitrate: 61 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(tv, bt709), 1920x1080, 30 fps (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
"#;
        let m = parse_ffmpeg_info(stderr).unwrap();
        assert_eq!((m.width, m.height), (1080, 1920));
    }
}
