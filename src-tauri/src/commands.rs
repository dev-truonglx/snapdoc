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
/// Dùng async + spawn_blocking để code blocking chạy trên dedicated thread,
/// không block Tokio event loop — WebView2 message pump tiếp tục chạy,
/// overlay đóng được bình thường.
#[tauri::command]
pub async fn finalize_region(
    app: AppHandle,
    window: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || flow::finalize_region(&app, window, x, y, w, h))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Chụp cửa sổ đã chọn.
/// async + spawn_blocking: không block Tokio event loop → WebView2 pump chạy,
/// win.close() (WM_CLOSE) được xử lý trong lúc capture đang chờ.
#[tauri::command]
pub async fn finalize_window(app: AppHandle, id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || flow::finalize_window(&app, id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Chụp toàn màn hình.
#[tauri::command]
pub async fn finalize_monitor(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || flow::finalize_monitor(&app, window))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Liệt kê cửa sổ — async để không block Tokio event loop.
#[tauri::command]
pub async fn list_windows(window: WebviewWindow) -> Result<Vec<WindowInfo>, String> {
    let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
    let pos = window
        .outer_position()
        .map_err(|e| format!("Không lấy được vị trí overlay: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        capture::window::list(pos.x as f64, pos.y as f64, scale)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub fn cancel_overlay(app: AppHandle) {
    flow::cancel_overlay(&app);
}

/// Chụp tất cả màn hình ghép ngang — không cần chọn, không cần overlay.
#[tauri::command]
pub async fn capture_all_screens(app: AppHandle, output: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        flow::capture_all_screens(&app, &output)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
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

/// Áp dụng phím tắt mới ngay lập tức — huỷ tất cả, đăng ký lại từ settings.
#[tauri::command]
pub fn reload_shortcuts(app: AppHandle) -> Result<(), String> {
    crate::hotkey::reload(&app)
}
