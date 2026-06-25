use crate::{
    capture, clipboard, flow, permissions, state::AppState, state::PendingCapture, storage, windows,
};
use crate::capture::window::WindowInfo;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// Đọc (không xoá) ảnh đang chờ — dùng cho overlay & thumbnail.
#[tauri::command]
pub fn peek_pending(state: State<AppState>) -> Option<PendingCapture> {
    state.pending.lock().ok().and_then(|g| g.clone())
}

/// Lấy và xoá ảnh đang chờ — editor gọi khi mở.
#[tauri::command]
pub fn take_pending(state: State<AppState>) -> Option<PendingCapture> {
    state.pending.lock().ok().and_then(|mut g| g.take())
}

/// Chụp theo mode + output (gọi từ capture bar). Chạy nền để không chặn UI.
#[tauri::command]
pub fn capture_now(app: AppHandle, mode: String, output: String) {
    std::thread::spawn(move || flow::run(&app, &mode, &output));
}

/// Chụp vùng chọn từ overlay.
///
/// **Phải chạy trên một OS thread riêng** — Tokio worker threads không khởi tạo
/// COM STA, trong khi xcap WGC gọi CoInitializeEx/WinRT APIs yêu cầu STA.
/// Spawn `std::thread` để đảm bảo ngữ cảnh COM đúng, rồi forward kết quả
/// về IPC caller qua channel.
#[tauri::command]
pub fn finalize_region(
    app: AppHandle,
    window: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let result = flow::finalize_region(&app, window, x, y, w, h);
        let _ = tx.send(result);
    });
    rx.recv().unwrap_or_else(|_| Err("Thread capture bị lỗi bất ngờ".to_string()))
}

#[tauri::command]
pub fn finalize_window(app: AppHandle, id: u32) -> Result<(), String> {
    flow::finalize_window(&app, id)
}

#[tauri::command]
pub fn finalize_monitor(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    flow::finalize_monitor(&app, window)
}

/// Liệt kê cửa sổ theo toạ độ local của overlay GỌI lệnh (mỗi màn hình một
/// overlay) → highlight đúng trên màn hình đang trỏ tới.
///
/// Truyền `outer_position()` (physical px) và `scale_factor` nguyên gốc vào
/// `list()` để nó tự convert. KHÔNG chia trước ở đây — tránh mất chính xác
/// và lệch khi DPI != 1.
#[tauri::command]
pub fn list_windows(window: WebviewWindow) -> Result<Vec<WindowInfo>, String> {
    let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
    let pos = window
        .outer_position()
        .map_err(|e| format!("Không lấy được vị trí overlay: {e}"))?;
    // Truyền physical px trực tiếp; list() sẽ tự chia scale.
    capture::window::list(pos.x as f64, pos.y as f64, scale)
}

#[tauri::command]
pub fn cancel_overlay(app: AppHandle) {
    flow::cancel_overlay(&app);
}

#[tauri::command]
pub fn copy_image(data: String) -> Result<(), String> {
    clipboard::copy_png(&data)
}

#[tauri::command]
pub fn save_image(path: String, data: String) -> Result<String, String> {
    storage::save::write_png(&path, &data)
}

#[tauri::command]
pub fn save_and_copy(path: String, data: String) -> Result<String, String> {
    clipboard::copy_png(&data)?;
    storage::save::write_png(&path, &data)
}

#[tauri::command]
pub fn open_capture_bar(app: AppHandle) -> Result<(), String> {
    windows::open_capture_bar(&app)
}

#[tauri::command]
pub fn open_editor(app: AppHandle) -> Result<(), String> {
    windows::open_editor(&app)
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    windows::open_settings(&app)
}

#[tauri::command]
pub fn close_self(window: tauri::WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn default_save_dir(app: AppHandle) -> String {
    app.path()
        .picture_dir()
        .map(|p| p.join("SnapDoc").to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Value {
    let dir = app.path().app_config_dir().unwrap_or_default();
    storage::settings::load(&dir)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, value: Value) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Không tìm thấy thư mục config: {e}"))?;
    storage::settings::save(&dir, &value)
}

#[tauri::command]
pub fn check_screen_permission() -> bool {
    permissions::can_capture()
}

/// Mở prompt cấp quyền Screen Recording của hệ thống (macOS). Trả về true nếu
/// đã/được cấp.
#[tauri::command]
pub fn request_screen_permission() -> bool {
    permissions::request_capture()
}
