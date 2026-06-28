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

    // macOS: overlay được đặt theo NSScreen frame (points). outer_position()
    // của Tauri trả physical px → chia scale để về points nhất quán với xcap.
    // Windows/Linux: cả hai đều dùng physical px → truyền thẳng, list() sẽ chia.
    let pos = window
        .outer_position()
        .map_err(|e| format!("Không lấy được vị trí overlay: {e}"))?;

    #[cfg(target_os = "macos")]
    let (ox, oy) = (pos.x as f64 / scale, pos.y as f64 / scale);
    #[cfg(not(target_os = "macos"))]
    let (ox, oy) = (pos.x as f64, pos.y as f64);

    tauri::async_runtime::spawn_blocking(move || {
        capture::window::list(ox, oy, scale)
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

/// Mở capture bar với chế độ chụp gần nhất pre-selected — dùng cho nút "New" trong editor.
#[tauri::command]
pub fn open_capture_bar_for_new(app: AppHandle) -> Result<(), String> {
    windows::hide_editor(&app);
    windows::open_capture_bar_with_last_mode(&app)
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

/// Ẩn thumbnail window (giữ pre-warmed, không destroy).
#[tauri::command]
pub fn hide_thumbnail(app: AppHandle) {
    if let Some(win) = app.get_webview_window("thumbnail") {
        let _ = win.hide();
    }
}

/// Mở ảnh từ đường dẫn tuyệt đối vào editor (dùng cho "Open with" / double-click).
/// Đọc file, encode base64, set pending rồi mở editor.
#[tauri::command]
pub fn open_file_path(app: AppHandle, path: String) -> Result<(), String> {
    open_file_path_sync(&app, path)
}

/// macOS: cửa sổ editor "Open with" tự kéo data URL ảnh của nó lúc mount.
/// Dùng label cửa sổ gọi để lấy đúng ảnh (mỗi cửa sổ một ảnh riêng).
#[tauri::command]
pub fn take_open_file(window: tauri::WebviewWindow, app: AppHandle) -> Option<String> {
    let label = window.label().to_string();
    app.state::<AppState>()
        .open_files
        .lock()
        .ok()?
        .remove(&label)
}

/// Hàm nội bộ — gọi được từ lib.rs (RunEvent::Opened, Windows argv).
pub fn open_file_path_sync(app: &AppHandle, path: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Không đọc được file: {e}"))?;

    // Decode để xác thực là ảnh hợp lệ (đồng thời lấy kích thước cho Windows).
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Không đọc được ảnh: {e}"))?;
    #[cfg_attr(target_os = "macos", allow(unused_variables))]
    let (width, height) = (img.width(), img.height());

    let mime = match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp"         => "image/webp",
        "bmp"          => "image/bmp",
        "gif"          => "image/gif",
        _              => "image/png",
    };
    let b64 = STANDARD.encode(&bytes);
    let data_url = format!("data:{mime};base64,{b64}");

    // macOS: một process duy nhất xử lý mọi "Open with" → mở MỖI ảnh trong một
    // cửa sổ editor riêng để xem/chỉnh nhiều ảnh cùng lúc (như Windows mở nhiều
    // process). Ảnh được lưu theo label; cửa sổ tự kéo qua take_open_file.
    #[cfg(target_os = "macos")]
    {
        let _ = b64;
        windows::open_editor_with_file(app, data_url)
    }

    // Windows: mỗi "Open with" là một process riêng → một cửa sổ "editor".
    #[cfg(not(target_os = "macos"))]
    {
        {
            let state = app.state::<AppState>();
            let mut guard = state.pending.lock()
                .map_err(|_| "Lock error".to_string())?;
            *guard = Some(PendingCapture {
                base64: b64,
                width,
                height,
                output: "editor".to_string(),
            });
        }
        windows::open_editor(app)?;
        if let Some(win) = app.get_webview_window("editor") {
            use tauri::Emitter;
            let _ = win.emit("open-file", &data_url);
        }
        Ok(())
    }
}

/// Mở file dialog để chọn ảnh PNG/JPG, đọc nội dung và trả về base64 data URL.
/// Trả về None nếu user huỷ.
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use base64::{engine::general_purpose::STANDARD, Engine};

    let path = app
        .dialog()
        .file()
        .add_filter("Ảnh", &["png", "jpg", "jpeg", "webp", "bmp", "gif"])
        .blocking_pick_file();

    let path = match path {
        Some(p) => p,
        None => return Ok(None),
    };

    let path_str = path.to_string();
    let bytes = std::fs::read(&path_str)
        .map_err(|e| format!("Không đọc được file: {e}"))?;

    // Xác định MIME type từ extension
    let mime = match path_str.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp"         => "image/webp",
        "bmp"          => "image/bmp",
        "gif"          => "image/gif",
        _              => "image/png",
    };

    let b64 = STANDARD.encode(&bytes);
    Ok(Some(format!("data:{mime};base64,{b64}")))
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

/// Lấy chế độ chụp gần nhất (mode + output) — dùng cho nút "New" ở editor.
#[tauri::command]
pub fn get_last_capture_mode(app: AppHandle) -> (String, String) {
    app.state::<AppState>().last_capture.get()
}

// ── Autostart commands ───────────────────────────────────────────────────────

/// Trả về trạng thái "khởi động cùng hệ thống" hiện tại.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Bật / tắt "khởi động cùng hệ thống".
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable().map_err(|e| format!("Không bật autostart: {e}"))
    } else {
        app.autolaunch().disable().map_err(|e| format!("Không tắt autostart: {e}"))
    }
}

// ── Update commands ──────────────────────────────────────────────────────────

/// Tạm tắt tất cả global shortcuts — dùng khi Settings đang trong chế độ
/// ghi phím tắt (recording), tránh shortcut kích hoạt hành động thực sự.
#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("suspend shortcuts failed: {e}"))
}

/// Đăng ký lại tất cả global shortcuts sau khi kết thúc recording.
#[tauri::command]
pub fn resume_shortcuts(app: AppHandle) -> Result<(), String> {
    crate::hotkey::register_all(&app)
}

/// Áp dụng phím tắt mới ngay lập tức — huỷ tất cả, đăng ký lại từ settings.
/// Đồng thời rebuild tray menu để accelerator text khớp với shortcuts mới.
#[tauri::command]
pub fn reload_shortcuts(app: AppHandle) -> Result<(), String> {
    crate::hotkey::reload(&app)?;
    crate::tray::rebuild_menu(&app);
    Ok(())
}

/// Check for update manually (called from Settings). Returns UpdateInfo.
/// On success, caches the update in PendingUpdate state.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<crate::update::UpdateInfo, String> {
    let info = crate::update::check_update(app.clone(), true).await?;
    if info.available {
        crate::tray::set_update_badge(&app);
    }
    Ok(info)
}

/// Returns the cached pending update info without re-fetching. The update
/// window can call this on load to get info immediately, without race conditions
/// on the event bus.
#[tauri::command]
pub fn get_pending_update(app: AppHandle) -> Option<crate::update::UpdateInfo> {
    crate::update::pending_info(&app)
}

/// Download + install the pending update and restart the app.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    crate::update::install_pending(app).await
}
