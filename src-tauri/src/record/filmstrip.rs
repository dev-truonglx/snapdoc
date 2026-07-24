//! Trích nhiều frame tại các mốc thời gian bất kỳ cho filmstrip zoom của
//! `VideoTrimmer` (frontend) — khác `history::video_thumbnail::generate`
//! (chỉ 1 frame cover cố định ở giây 0.5), ở đây nhận danh sách mốc ms bất kỳ
//! do frontend tính theo mức zoom/vị trí cuộn hiện tại.
//!
//! CHỈ 1 lệnh ffmpeg cho cả batch (không phải 1 lệnh/mốc như bản đầu) — mỗi
//! lệnh ffmpeg riêng phải mở lại file + probe demuxer từ đầu, với clip ngắn
//! (video quay màn hình thường vài phút) phần mở/probe này chiếm phần lớn
//! thời gian, không phải phần decode. Seek 1 lần tới đầu khoảng cần, decode
//! tuần tự bằng filter `fps` để lấy đều N frame trong khoảng đó — nhanh hơn
//! hẳn N lệnh riêng, đổi lại mốc trả về là mốc ffmpeg THỰC SỰ giải mã được
//! (gần mốc yêu cầu, không tuyệt đối trùng) — đủ dùng cho thumbnail filmstrip
//! (frontend tự hiển thị "mốc gần nhất" khi render, xem `nearestFrameUrl` ở
//! `VideoTrimmer.tsx`), không dùng cho seek chính xác (trim vẫn seek bằng
//! `-ss` riêng, không qua module này).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn configure_no_window(#[allow(unused_variables)] cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// `scale_w`: bề rộng đích (px) — filmstrip tile nhỏ chỉ cần 160 (xem
/// `extract_range_frames`), nhưng hover-scrub preview hiện to (~340px, xem
/// `HOVER_PREVIEW_SCALE_W` ở `VideoTrimmer.tsx`) nên gọi hàm này với bề rộng
/// lớn hơn để ảnh không bị phóng to từ 160px lên gây mờ/vỡ nét.
fn extract_one_frame(ffmpeg: &Path, mp4_path: &Path, timestamp_ms: i64, scale_w: u32) -> Result<Vec<u8>, String> {
    let out_path = std::env::temp_dir().join(format!(
        "snapdoc-frame-{}-{}.jpg",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-ss"])
        .arg(format!("{:.3}", (timestamp_ms.max(0) as f64) / 1000.0))
        .arg("-i")
        .arg(mp4_path)
        .args(["-frames:v", "1", "-vf", &format!("scale={scale_w}:-1"), "-q:v", "3"])
        .arg(&out_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    configure_no_window(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&out_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg trích frame @{timestamp_ms}ms thất bại: {stderr}"));
    }

    let bytes = std::fs::read(&out_path).map_err(|e| format!("Không đọc được frame đã trích: {e}"));
    let _ = std::fs::remove_file(&out_path);
    bytes
}

/// Trích N frame cách đều trong 1 lần chạy ffmpeg (seek 1 lần + `-vf fps=`)
/// — dùng khi batch có ≥2 mốc. Trả `(mốc ước tính, bytes)` theo đúng thứ tự
/// giải mã (tăng dần theo thời gian); số lượng thực tế có thể lệch ±1 so với
/// `timestamps_ms.len()` do làm tròn fps/thời lượng ở ffmpeg.
fn extract_range_frames(
    ffmpeg: &Path,
    mp4_path: &Path,
    min_ms: i64,
    max_ms: i64,
    count: usize,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let span_ms = (max_ms - min_ms).max(1) as f64;
    let step_ms = span_ms / (count.max(1) as f64);
    // Đệm nửa bước trước/sau để mốc đầu/cuối không bị hụt do biên decode.
    let half_step_ms = step_ms / 2.0;
    let start_ms = (min_ms as f64 - half_step_ms).max(0.0);
    let duration_ms = (max_ms as f64 - start_ms) + half_step_ms;
    let fps = (count as f64) / (duration_ms / 1000.0).max(0.001);

    let out_dir = std::env::temp_dir().join(format!(
        "snapdoc-filmstrip-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Không tạo được thư mục tạm: {e}"))?;
    let pattern = out_dir.join("f_%05d.jpg");

    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-ss"])
        .arg(format!("{:.3}", start_ms / 1000.0))
        .arg("-i")
        .arg(mp4_path)
        .arg("-t")
        .arg(format!("{:.3}", duration_ms / 1000.0))
        .args(["-vf", &format!("fps={fps:.6},scale=160:-1"), "-q:v", "5"])
        .arg(&pattern)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    configure_no_window(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()));
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(e);
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(format!("ffmpeg trích filmstrip [{min_ms}..{max_ms}]ms thất bại: {stderr}"));
    }

    let mut files: Vec<PathBuf> = std::fs::read_dir(&out_dir)
        .map_err(|e| format!("Không đọc được thư mục tạm: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    files.sort();

    let step_ms_actual = 1000.0 / fps;
    let result: Vec<(i64, Vec<u8>)> = files
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let bytes = std::fs::read(p).ok()?;
            let ts = (start_ms + (i as f64 + 0.5) * step_ms_actual).round() as i64;
            Some((ts, bytes))
        })
        .collect();

    let _ = std::fs::remove_dir_all(&out_dir);
    Ok(result)
}

/// Trích 1 frame JPEG gần mỗi mốc trong `timestamps_ms` nhất có thể. ≥2 mốc
/// → 1 lệnh ffmpeg duy nhất (`extract_range_frames`, LUÔN scale 160px — dùng
/// cho filmstrip tile nhỏ, `scale_w` không ảnh hưởng nhánh này), ánh xạ ngược
/// mỗi mốc yêu cầu sang frame đã giải mã gần nó nhất theo thời gian (không
/// phải khớp tuyệt đối — xem doc-comment đầu file). Đúng 1 mốc → giữ đường cũ
/// (`extract_one_frame`, seek trực tiếp, không cần filter `fps`) — dùng
/// `scale_w` truyền vào, vì đây cũng chính là đường hover-scrub preview (to
/// hơn filmstrip nhiều, xem `HOVER_PREVIEW_SCALE_W` ở `VideoTrimmer.tsx`) cần
/// độ phân giải cao hơn để không bị mờ khi phóng to trên UI.
/// Lỗi cả batch (ffmpeg không khởi chạy được, file hỏng...) → mọi mốc đều lỗi,
/// KHÔNG làm sập cả app — `generate_video_frames` trả `None` cho từng mốc.
pub fn extract_frames(mp4_path: &Path, timestamps_ms: &[i64], scale_w: u32) -> Vec<Result<Vec<u8>, String>> {
    if timestamps_ms.is_empty() {
        return vec![];
    }

    let ffmpeg = match crate::record::encoder::sidecar_path("ffmpeg") {
        Ok(p) => p,
        Err(e) => return timestamps_ms.iter().map(|_| Err(e.clone())).collect(),
    };

    if timestamps_ms.len() == 1 {
        return vec![extract_one_frame(&ffmpeg, mp4_path, timestamps_ms[0], scale_w)];
    }

    let min_ms = *timestamps_ms.iter().min().unwrap();
    let max_ms = *timestamps_ms.iter().max().unwrap();

    if min_ms == max_ms {
        let frame = extract_one_frame(&ffmpeg, mp4_path, min_ms, scale_w);
        return timestamps_ms.iter().map(|_| frame.clone()).collect();
    }

    match extract_range_frames(&ffmpeg, mp4_path, min_ms, max_ms, timestamps_ms.len()) {
        Ok(produced) if !produced.is_empty() => timestamps_ms
            .iter()
            .map(|&want| {
                produced
                    .iter()
                    .min_by_key(|(ts, _)| (ts - want).abs())
                    .map(|(_, bytes)| bytes.clone())
                    .ok_or_else(|| "Không có frame nào được trích".to_string())
            })
            .collect(),
        Ok(_) => timestamps_ms
            .iter()
            .map(|_| Err("ffmpeg không trích được frame nào".to_string()))
            .collect(),
        Err(e) => timestamps_ms.iter().map(|_| Err(e.clone())).collect(),
    }
}

/// IPC cho filmstrip zoom của `VideoTrimmer` — nhận đường dẫn file (frontend
/// đã có sẵn: `PendingVideo.path` hoặc `HistoryRecord.assetPath`) + danh
/// sách mốc ms cần lấy, trả về từng mốc dạng data URL JPEG base64 (`None` nếu
/// mốc đó trích lỗi, không fail cả batch). `async fn` + `spawn_blocking` vì
/// chạy ffmpeg + đọc/xoá file tạm — không được chặn Tokio event loop / WebView2
/// message pump (cùng quy ước các command chạy ffmpeg khác trong app).
#[tauri::command]
pub async fn generate_video_frames(path: String, timestamps_ms: Vec<i64>, scale_w: u32) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let p = std::path::PathBuf::from(&path);
        extract_frames(&p, &timestamps_ms, scale_w)
            .into_iter()
            .map(|r| r.ok().map(|bytes| format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))))
            .collect()
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))
}
