//! Điều phối 1 phiên quay màn hình: nối `capture::mac_stream` (frame BGRA
//! thật từ ScreenCaptureKit) với `encoder` (ffmpeg) + quản lý vòng đời qua
//! `RecordingState` (managed trong Tauri) và tray icon "đang quay" (`tray.rs`).
//!
//! v1: chỉ macOS, không audio, fps cố định. Phase 3 thêm chọn PHẠM VI quay
//! (màn hình cụ thể / vùng chọn / cửa sổ) qua overlay chọn vùng có sẵn của
//! tính năng chụp ảnh (xem `flow::run_record_picker` +
//! `flow::finalize_region/finalize_window/finalize_monitor`).

pub mod encoder;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Manager};

/// fps cố định cho v1 — đủ mượt cho demo/hướng dẫn, giữ CPU/dung lượng thấp.
pub const FPS: u32 = 30;

/// 1 phiên quay đang chạy. Field `stream` chỉ tồn tại trên macOS (nguồn frame
/// duy nhất hiện có); `writer` sở hữu cả `Receiver<Frame>` lẫn `Encoder`, tự
/// gọi `encoder.finish()` khi kênh đóng (xem `stop_recording`).
pub struct ActiveRecording {
    #[cfg(target_os = "macos")]
    stream: crate::capture::mac_stream::RecordingHandle,
    writer: std::thread::JoinHandle<Result<(), String>>,
    pub output_path: PathBuf,
    pub started_at: Instant,
}

#[derive(Default)]
pub struct RecordingState(pub Mutex<Option<ActiveRecording>>);

/// Đường dẫn file mp4 mới: `{saveDir hoặc Pictures/SnapDoc}/Recording_<timestamp>.mp4`
/// — cùng thư mục lưu với ảnh chụp (tôn trọng `saveDir` đã cấu hình trong Settings).
fn new_output_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let settings = crate::storage::settings::load(&config_dir);
    let custom_dir = settings
        .get("saveDir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let dir = if custom_dir.is_empty() {
        app.path()
            .picture_dir()
            .map(|p| p.join("SnapDoc"))
            .map_err(|e| format!("Không tìm thấy thư mục Pictures: {e}"))?
    } else {
        PathBuf::from(custom_dir)
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Không tạo được thư mục lưu: {e}"))?;
    Ok(dir.join(format!("{}.mp4", crate::flow::stamp_filename("Recording"))))
}

/// Quay toàn màn hình CHÍNH (hành vi v1, dùng cho nút "Quay" mặc định + hotkey).
#[cfg(target_os = "macos")]
pub fn start_recording(app: &AppHandle) -> Result<(), String> {
    let monitor = crate::capture::monitor::primary()?;
    let display_id = monitor
        .id()
        .map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
    start_with_target(app, crate::capture::mac_stream::RecordTarget::Display(display_id))
}

/// Quay toàn bộ 1 màn hình CỤ THỂ (người dùng chọn qua overlay — Phase 3).
#[cfg(target_os = "macos")]
pub fn start_recording_monitor(app: &AppHandle, display_id: u32) -> Result<(), String> {
    start_with_target(app, crate::capture::mac_stream::RecordTarget::Display(display_id))
}

/// Quay 1 VÙNG đã chọn qua overlay. `x,y,w,h` là points, LOCAL theo gốc màn
/// hình `display_id` (cùng hệ toạ độ `flow::finalize_region` đã tính sẵn cho
/// chụp ảnh vùng — xem đó để hiểu vì sao không cần cộng thêm gốc màn hình).
#[cfg(target_os = "macos")]
pub fn start_recording_region(
    app: &AppHandle,
    display_id: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    start_with_target(
        app,
        crate::capture::mac_stream::RecordTarget::Region { display_id, x, y, w, h },
    )
}

/// Quay 1 cửa sổ đã chọn qua overlay.
#[cfg(target_os = "macos")]
pub fn start_recording_window(app: &AppHandle, window_id: u32) -> Result<(), String> {
    start_with_target(app, crate::capture::mac_stream::RecordTarget::Window(window_id))
}

#[cfg(target_os = "macos")]
fn start_with_target(app: &AppHandle, target: crate::capture::mac_stream::RecordTarget) -> Result<(), String> {
    let state = app.state::<RecordingState>();
    {
        let guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
        if guard.is_some() {
            return Err("Đã có phiên quay đang chạy".to_string());
        }
    }

    let (stream, frame_rx) = crate::capture::mac_stream::start(target, FPS)?;
    let (width, height) = (stream.width, stream.height);

    let output_path = new_output_path(app)?;
    let mut encoder = encoder::Encoder::start(&output_path, width, height, FPS)?;

    // Luồng riêng: kéo frame liên tục cho tới khi channel đóng (xảy ra khi
    // `stop_recording` gọi `stream.stop()` → drop sender bên trong
    // `mac_stream`), rồi TỰ gọi `encoder.finish()` để đóng stdin/mux file.
    let writer = std::thread::spawn(move || -> Result<(), String> {
        while let Ok(frame) = frame_rx.recv() {
            // ffmpeg nhận rawvideo với -s cố định từ lúc start() — 1 frame
            // lệch kích thước (vd đổi độ phân giải màn hình giữa lúc quay) sẽ
            // làm lệch byte-offset của MỌI frame sau, hỏng cả file. Bỏ qua
            // thay vì ghi nhầm.
            if frame.width != width || frame.height != height {
                eprintln!(
                    "[SnapDoc][record] Bỏ qua frame sai kích thước ({}x{}, cần {width}x{height})",
                    frame.width, frame.height
                );
                continue;
            }
            encoder.write_frame(&frame.bgra)?;
        }
        encoder.finish()
    });

    {
        let mut guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
        *guard = Some(ActiveRecording {
            stream,
            writer,
            output_path,
            started_at: Instant::now(),
        });
    }

    crate::tray::show_recording_tray(app);
    spawn_tray_ticker(app.clone());
    Ok(())
}

/// Cập nhật đồng hồ đếm cạnh icon "đang quay" mỗi giây — tự dừng khi
/// `status()` trả `None` (đã `stop_recording`). Đồng thời poll
/// `is_stopped_externally()`: nếu người dùng bấm "Stop" trên icon "Screen
/// Sharing" của HỆ THỐNG macOS (khác icon riêng của app), `SCStream` tự dừng
/// mà không ai gọi `stop_recording()` của ta — nếu không phát hiện, phiên
/// quay coi như "kẹt" mãi ở trạng thái đang chạy: `writer` thread chờ frame
/// không bao giờ tới nữa, và icon "đang quay" không bao giờ bị ẩn.
#[cfg(target_os = "macos")]
fn spawn_tray_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        if stopped_externally(&app) {
            if let Err(e) = stop_recording(&app) {
                eprintln!("[SnapDoc][record] Dừng quay (SCStream tự dừng bên ngoài) thất bại: {e}");
            }
            break;
        }
        match status(&app) {
            Some(ms) => {
                crate::tray::update_recording_time(ms);
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            None => break,
        }
    });
}

/// `true` nếu phiên quay hiện tại đã bị SCStream tự dừng ngoài ý muốn (xem
/// `spawn_tray_ticker`).
#[cfg(target_os = "macos")]
fn stopped_externally(app: &AppHandle) -> bool {
    let state = app.state::<RecordingState>();
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    guard
        .as_ref()
        .map(|r| r.stream.is_stopped_externally())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn start_recording(_app: &AppHandle) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn start_recording_monitor(_app: &AppHandle, _display_id: u32) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn start_recording_region(
    _app: &AppHandle,
    _display_id: u32,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn start_recording_window(_app: &AppHandle, _window_id: u32) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS".to_string())
}

/// Dừng phiên quay hiện tại, đợi ffmpeg mux xong, trả về đường dẫn file mp4.
pub fn stop_recording(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<RecordingState>();
    let active = state
        .0
        .lock()
        .map_err(|_| "Lock RecordingState lỗi".to_string())?
        .take()
        .ok_or_else(|| "Không có phiên quay nào đang chạy".to_string())?;

    #[cfg(target_os = "macos")]
    active.stream.stop()?;

    let write_result = active
        .writer
        .join()
        .map_err(|_| "Luồng ghi video bị panic".to_string())?;

    crate::tray::hide_recording_tray(app);

    write_result?;
    Ok(active.output_path.to_string_lossy().to_string())
}

/// Bật/tắt quay — dùng cho global hotkey (không cần biết trạng thái trước).
pub fn toggle(app: &AppHandle) {
    let is_active = app
        .state::<RecordingState>()
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);

    if is_active {
        if let Err(e) = stop_recording(app) {
            eprintln!("[SnapDoc][record] Dừng quay thất bại: {e}");
        }
    } else if let Err(e) = start_recording(app) {
        eprintln!("[SnapDoc][record] Bắt đầu quay thất bại: {e}");
    }
}

/// Thời gian đã quay (ms) nếu đang có phiên quay — cửa sổ chỉ báo poll hàm
/// này định kỳ để hiện đồng hồ đếm, tránh cần thêm 1 ticker thread ở Rust.
pub fn status(app: &AppHandle) -> Option<u64> {
    let state = app.state::<RecordingState>();
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|r| r.started_at.elapsed().as_millis() as u64)
}
