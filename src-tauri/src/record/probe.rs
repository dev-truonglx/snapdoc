//! Module trích xuất metadata (thời lượng, độ phân giải) và remux video ngoài
//! để tương thích 100% với Webview HTML5 Video player và VideoTrimmer.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::AppHandle;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn configure_no_window(#[allow(unused_variables)] cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_ms: i64,
}

/// Chạy FFmpeg để trích xuất metadata (thời lượng, kích thước) của video bất kỳ.
/// Không yêu cầu ffprobe riêng, sử dụng chính sidecar ffmpeg đã có.
pub fn probe_video_metadata(video_path: &Path) -> Result<VideoMetadata, String> {
    let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-i"])
        .arg(video_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    configure_no_window(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("Không khởi chạy được ffmpeg probe: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);

    // 1. Phân tích thời lượng: "Duration: HH:MM:SS.ss"
    let mut duration_ms: i64 = 0;
    if let Some(pos) = stderr.find("Duration: ") {
        let rest = &stderr[pos + 10..];
        if let Some(end) = rest.find(',') {
            let dur_str = rest[..end].trim();
            let parts: Vec<&str> = dur_str.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                duration_ms = ((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as i64;
            }
        }
    }

    // 2. Phân tích độ phân giải từ stream Video
    let mut width: u32 = 1920;
    let mut height: u32 = 1080;
    let mut found_dim = false;

    if let Some(v_pos) = stderr.find("Video: ") {
        let v_slice = &stderr[v_pos..];
        let limit = v_slice.find('\n').unwrap_or(v_slice.len().min(1000));
        let video_line = &v_slice[..limit];

        for token in video_line.split(|c: char| c == ',' || c == ' ' || c == '[') {
            let t = token.trim();
            if let Some(x_idx) = t.find('x') {
                let left = &t[..x_idx];
                let right = &t[x_idx + 1..];
                if let (Ok(w), Ok(h)) = (left.parse::<u32>(), right.parse::<u32>()) {
                    if w >= 16 && w <= 16384 && h >= 16 && h <= 16384 {
                        width = w;
                        height = h;
                        found_dim = true;
                        break;
                    }
                }
            }
        }
    }

    if !found_dim {
        eprintln!("[SnapDoc][probe] Không phân tích được độ phân giải video, fallback về 1920x1080");
    }

    Ok(VideoMetadata {
        width,
        height,
        duration_ms,
    })
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

    eprintln!("[SnapDoc][probe] Đang remux nhanh {} sang MP4 tương thích Webview...", video_path.display());
    let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;
    let mut cmd = Command::new(&ffmpeg);
    // Thử remux stream copy (-c:v copy -c:a aac) trước để tốc độ cực nhanh (~0.2s)
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
    ])
    .arg(video_path)
    .args([
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
    ])
    .arg(&out_path)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    configure_no_window(&mut cmd);

    let output = cmd.output().map_err(|e| format!("Lỗi khởi chạy remux: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[SnapDoc][probe] Stream copy remux thất bại ({stderr}), thử transcode nhanh...");
        let mut trans_cmd = Command::new(&ffmpeg);
        trans_cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
        ])
        .arg(video_path)
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "22",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ])
        .arg(&out_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
        configure_no_window(&mut trans_cmd);

        let trans_out = trans_cmd.output().map_err(|e| format!("Lỗi transcode: {e}"))?;
        if !trans_out.status.success() {
            let err = String::from_utf8_lossy(&trans_out.stderr);
            return Err(format!("Không thể chuyển đổi video sang định dạng tương thích: {err}"));
        }
    }

    Ok(out_path)
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_parse_metadata() {
        let stderr = r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'test.mp4':
  Duration: 00:00:03.50, start: 0.000000, bitrate: 61 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 56 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
"#;
        let mut duration_ms = 0;
        if let Some(pos) = stderr.find("Duration: ") {
            let rest = &stderr[pos + 10..];
            if let Some(end) = rest.find(',') {
                let dur_str = rest[..end].trim();
                let parts: Vec<&str> = dur_str.split(':').collect();
                if parts.len() == 3 {
                    let h: f64 = parts[0].parse().unwrap_or(0.0);
                    let m: f64 = parts[1].parse().unwrap_or(0.0);
                    let s: f64 = parts[2].parse().unwrap_or(0.0);
                    duration_ms = ((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as i64;
                }
            }
        }
        assert_eq!(duration_ms, 3500);

        let mut width = 1920;
        let mut height = 1080;
        if let Some(v_pos) = stderr.find("Video: ") {
            let v_slice = &stderr[v_pos..];
            let limit = v_slice.find('\n').unwrap_or(v_slice.len().min(1000));
            let video_line = &v_slice[..limit];
            for token in video_line.split(|c: char| c == ',' || c == ' ' || c == '[') {
                let t = token.trim();
                if let Some(x_idx) = t.find('x') {
                    let left = &t[..x_idx];
                    let right = &t[x_idx + 1..];
                    if let (Ok(w), Ok(h)) = (left.parse::<u32>(), right.parse::<u32>()) {
                        if w >= 16 && w <= 16384 && h >= 16 && h <= 16384 {
                            width = w;
                            height = h;
                            break;
                        }
                    }
                }
            }
        }
        assert_eq!(width, 640);
        assert_eq!(height, 360);
    }
}
