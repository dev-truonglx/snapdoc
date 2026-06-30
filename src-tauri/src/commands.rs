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
///
/// Luồng trên Windows:
/// - hide_editor() + open_capture_bar() là các lời gọi nhanh (không block).
/// - Toàn bộ được spawn sang std::thread riêng để tránh block Tauri IPC thread,
///   đặc biệt tránh trường hợp Win32 message pump stall khi show/hide window
///   từ thread không có message loop.
#[tauri::command]
pub fn open_capture_bar_for_new(app: AppHandle) -> Result<(), String> {
    std::thread::spawn(move || {
        windows::hide_editor(&app);
        // Trên Windows: đợi WM_SHOWWINDOW được xử lý trước khi mở capture bar,
        // tránh race condition giữa hai thao tác window.
        #[cfg(target_os = "windows")]
        std::thread::sleep(std::time::Duration::from_millis(80));
        let _ = windows::open_capture_bar_with_last_mode(&app);
    });
    Ok(())
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
    let label = window.label();
    if label == "scroll-control" {
        use tauri::Manager;
        if let Some(border) = window.app_handle().get_webview_window("scroll-border") {
            let _ = border.close();
        }
    }
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

/// Mở dialog chọn NHIỀU ảnh cùng lúc → trả về danh sách data URL (theo thứ tự
/// user chọn). Dùng cho tính năng nối ảnh (stitch). Trả về [] nếu user huỷ.
#[tauri::command]
pub async fn open_files_dialog(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use base64::{engine::general_purpose::STANDARD, Engine};

    let paths = app
        .dialog()
        .file()
        .add_filter("Ảnh", &["png", "jpg", "jpeg", "webp", "bmp", "gif"])
        .blocking_pick_files();

    let paths = match paths {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let path_str = path.to_string();
        let bytes = std::fs::read(&path_str)
            .map_err(|e| format!("Không đọc được file: {e}"))?;
        let mime = match path_str.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp"         => "image/webp",
            "bmp"          => "image/bmp",
            "gif"          => "image/gif",
            _              => "image/png",
        };
        let b64 = STANDARD.encode(&bytes);
        out.push(format!("data:{mime};base64,{b64}"));
    }
    Ok(out)
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
    storage::settings::save(&dir, &value)?;
    // Broadcast cho tất cả window đang mở để sync lại settings.
    // CaptureBar cần biết khi Settings đổi defaultOutput, và ngược lại.
    use tauri::Emitter;
    let _ = app.emit("settings-changed", &value);
    Ok(())
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

#[tauri::command]
pub fn start_scroll_session(state: State<'_, AppState>) {
    if let Ok(mut slices) = state.scroll_slices.lock() {
        slices.clear();
    }
}

/// Chụp một lát cắt trong tính năng chụp cuộn.
#[tauri::command]
pub async fn capture_scroll_slice(
    state: State<'_, AppState>,
    mx: i32,
    my: i32,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
) -> Result<String, String> {
    let raw_img = tauri::async_runtime::spawn_blocking(move || -> Result<image::RgbaImage, String> {
        let m = crate::capture::monitor::at_point(mx, my)?;
        let img = crate::capture::region::capture_region_raw(&m, rx, ry, rw, rh)?;
        Ok(img)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Lưu vào bộ đệm slices
    if let Ok(mut slices) = state.scroll_slices.lock() {
        slices.push(raw_img.clone());
    }

    // Persist to base64 for frontend preview
    let cap = crate::capture::persist(&raw_img)?;
    Ok(cap.base64)
}

/// Hoàn tất chụp cuộn: nhận base64 của canvas đã ghép, chuyển về flow để kết xuất.
#[tauri::command]
pub fn finalize_scroll_capture(
    app: AppHandle,
    base64: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use tauri::Manager;
    if let Some(border) = app.get_webview_window("scroll-border") {
        let _ = border.close();
    }
    let cap = crate::capture::Capture {
        base64,
        width,
        height,
    };
    let output = crate::flow::get_output(&app);
    crate::flow::finish(&app, cap, &output)
}

#[derive(serde::Deserialize)]
pub struct StitchInstruction {
    #[serde(rename = "sliceIndex")]
    slice_index: usize,
    #[serde(rename = "srcY")]
    src_y: u32,
    #[serde(rename = "srcH")]
    src_h: u32,
}

fn lum_u8(px: &image::Rgba<u8>) -> i32 {
    (px[0] as i32 * 299 + px[1] as i32 * 587 + px[2] as i32 * 114) / 1000
}

/// Cột x có phải CỘT CỐ ĐỊNH (sidebar dính) không: giống nhau qua các lát cắt ở
/// MỌI vị trí cuộn (không dịch theo cuộn) VÀ có nội dung (khác nền trang). Cột
/// nội dung cuộn thì đổi qua các lát; lề trắng thì không có nội dung → đều loại.
fn col_fixed_with_content(
    refs: &[&image::RgbaImage],
    x: u32,
    h: u32,
    y_step: u32,
    bg: i32,
) -> bool {
    let mut content = false;
    let mut y = 0u32;
    while y < h {
        let base = lum_u8(refs[0].get_pixel(x, y));
        for r in &refs[1..] {
            if (lum_u8(r.get_pixel(x, y)) - base).abs() > 18 {
                return false; // đổi qua các lát → đang cuộn, không cố định
            }
        }
        if (base - bg).abs() > 24 {
            content = true; // khác nền → có nội dung (sidebar), không phải lề trắng
        }
        y += y_step;
    }
    content
}

/// Phát hiện dải cột cố định ở mép trái/phải (sidebar/panel dính) bằng cách so
/// vài lát cắt rải đều. Trả (left, right) tính bằng px. Có chốt an toàn để không
/// cắt nhầm nội dung.
fn detect_fixed_columns(slices: &[image::RgbaImage], width: u32) -> (u32, u32) {
    let n = slices.len();
    if n < 3 {
        return (0, 0);
    }
    let idxs = [0usize, n / 4, n / 2, (3 * n) / 4, n - 1];
    let refs: Vec<&image::RgbaImage> = idxs.iter().map(|&i| &slices[i]).collect();
    let h = refs[0].height();
    let mut w = width;
    for r in &refs {
        w = w.min(r.width());
    }
    if w == 0 || h == 0 {
        return (0, 0);
    }
    let y_step = (h / 120).max(1);

    // Nền trang ≈ trung vị độ sáng của khung đầu (trang admin thường trắng).
    let bg = {
        let mut lums: Vec<i32> = Vec::new();
        let xs = (w / 40).max(1);
        let ys = (h / 60).max(1);
        let mut yy = 0u32;
        while yy < h {
            let mut xx = 0u32;
            while xx < w {
                lums.push(lum_u8(refs[0].get_pixel(xx, yy)));
                xx += xs;
            }
            yy += ys;
        }
        lums.sort_unstable();
        if lums.is_empty() { 255 } else { lums[lums.len() / 2] }
    };

    let mut left = 0u32;
    while left < w && col_fixed_with_content(&refs, left, h, y_step, bg) {
        left += 1;
    }
    let mut right = 0u32;
    while right < w && col_fixed_with_content(&refs, w - 1 - right, h, y_step, bg) {
        right += 1;
    }

    // Chốt an toàn: 1 dải > 40% bề ngang, hoặc 2 dải phủ gần hết khung → coi như
    // phát hiện sai (vd cuộn quá ít) và bỏ qua, tránh cắt nhầm nội dung.
    let maxband = (width as f32 * 0.4) as u32;
    if left > maxband {
        left = 0;
    }
    if right > maxband {
        right = 0;
    }
    if left + right >= w {
        return (0, 0);
    }
    (left, right)
}

/// Ghép ảnh cuộn ở backend dựa trên danh sách các lát cắt đã lưu và hướng dẫn ghép.
#[tauri::command]
pub async fn finalize_scroll_stitch(
    app: AppHandle,
    state: State<'_, AppState>,
    width: u32,
    instructions: Vec<StitchInstruction>,
) -> Result<(), String> {
    use tauri::Manager;

    let slices = {
        let mut guard = state.scroll_slices.lock().map_err(|_| "Lỗi lock scroll_slices".to_string())?;
        std::mem::take(&mut *guard)
    };

    if slices.is_empty() || instructions.is_empty() {
        return Err("Không có dữ liệu lát cắt hoặc hướng dẫn ghép".to_string());
    }

    let cap = tauri::async_runtime::spawn_blocking(move || -> Result<crate::capture::Capture, String> {
        let mut total_height = 0u32;
        for inst in &instructions {
            total_height += inst.src_h;
        }

        if total_height == 0 {
            return Err("Chiều cao ảnh ghép bằng 0".to_string());
        }

        // Phát hiện sidebar/panel cố định để KHÔNG copy lặp khi nối (chỉ khi thực
        // sự có cuộn nhiều khung).
        let (fixed_left, fixed_right) = if instructions.len() >= 2 {
            detect_fixed_columns(&slices, width)
        } else {
            (0, 0)
        };
        let first_h = instructions[0].src_h;

        let mut final_img = image::RgbaImage::new(width, total_height);

        let mut current_y = 0u32;
        for (idx, inst) in instructions.iter().enumerate() {
            let slice = slices.get(inst.slice_index).ok_or_else(|| {
                format!("Không tìm thấy lát cắt index {}", inst.slice_index)
            })?;

            let slice_w = slice.width();
            let slice_h = slice.height();

            // Khung ĐẦU vẽ đủ bề ngang (sidebar hiện 1 lần); các dải nối SAU chỉ
            // copy cột đang cuộn, bỏ cột cố định để sidebar không bị lặp dọc.
            let (x_lo, x_hi) = if idx == 0 {
                (0u32, width)
            } else {
                (fixed_left, width.saturating_sub(fixed_right))
            };

            for y in 0..inst.src_h {
                let src_pixel_y = inst.src_y + y;
                if src_pixel_y >= slice_h {
                    continue;
                }
                let dest_pixel_y = current_y + y;
                if dest_pixel_y >= total_height {
                    continue;
                }
                for x in x_lo..x_hi {
                    if x >= slice_w {
                        continue;
                    }
                    let pixel = slice.get_pixel(x, src_pixel_y);
                    final_img.put_pixel(x, dest_pixel_y, *pixel);
                }
            }

            current_y += inst.src_h;
        }

        // Đóng băng sidebar (kiểu Snagit): phần cột cố định bên dưới khung đầu được
        // ĐỔ bằng cách kéo dài hàng đáy của sidebar xuống hết chiều cao — nền sidebar
        // (thường màu đặc) trải liền mạch, nội dung sidebar chỉ hiện 1 lần ở trên.
        if (fixed_left > 0 || fixed_right > 0) && first_h > 0 && first_h <= total_height {
            let anchor_y = first_h - 1;
            for y in first_h..total_height {
                for x in 0..fixed_left {
                    let px = *final_img.get_pixel(x, anchor_y);
                    final_img.put_pixel(x, y, px);
                }
                for x in (width - fixed_right)..width {
                    let px = *final_img.get_pixel(x, anchor_y);
                    final_img.put_pixel(x, y, px);
                }
            }
        }

        let cap = crate::capture::persist(&final_img)?;
        Ok(cap)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    if let Some(border) = app.get_webview_window("scroll-border") {
        let _ = border.close();
    }

    let output = crate::flow::get_output(&app);
    crate::flow::finish(&app, cap, &output)
}
