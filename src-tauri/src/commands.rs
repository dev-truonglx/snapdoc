use crate::{
    capture, clipboard, flow, permissions, state::AppState, state::PendingCapture, state::PendingVideo,
    storage, tray, windows,
};
use crate::capture::window::WindowInfo;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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

/// Đọc (không xoá) video đang chờ mở trong Editor.
#[tauri::command]
pub fn peek_pending_video(state: State<AppState>) -> Option<PendingVideo> {
    state.pending_video.lock().ok().and_then(|g| g.clone())
}

/// Lấy và xoá video đang chờ — Editor gọi khi mở/refresh.
#[tauri::command]
pub fn take_pending_video(state: State<AppState>) -> Option<PendingVideo> {
    state.pending_video.lock().ok().and_then(|mut g| g.take())
}

/// Ghi đè ảnh đang chờ với output="editor" — dùng cho nút "Mở Editor" ở
/// "Chụp nhanh" để bàn giao sang cửa sổ Editor đầy đủ qua đúng pipeline
/// `take_pending` có sẵn.
/// `data`: data URL đầy đủ (`data:image/png;base64,...`) hoặc base64 trần —
/// tách bỏ phần prefix nếu có, giữ đúng quy ước của `PendingCapture.base64`.
/// `doc_json`: lớp annotation đã serialize (DocPayload JSON) — khi có, Editor
/// dựng lại đúng các annotation object để user chỉnh tiếp, thay vì nhận ảnh
/// phẳng mà không còn annotation nào. `None` = không có annotation, ảnh sạch.
#[tauri::command]
pub fn set_pending_image(
    app: AppHandle,
    state: State<AppState>,
    data: String,
    width: u32,
    height: u32,
    doc_json: Option<String>,
    scale_factor: Option<f64>,
) {
    let base64 = data.split(',').next_back().unwrap_or(&data).to_string();
    let scale = scale_factor.unwrap_or(1.0);

    // "Mở Editor" từ Quick Capture cũng là một capture hoàn chỉnh (đối xứng với
    // nhánh `_ => open_editor` của `flow::finish`) — ingest ngay để History
    // ghi nhận mọi đường ra editor, không chỉ Copy/Save.
    // Ảnh ingest là ảnh NỀN THÔ (screenshot chưa ghép annotation): annotation
    // đi riêng qua doc_json và được lưu non-destructive, giữ pixel nền sạch.
    let cap = crate::capture::Capture { base64: base64.clone(), width, height };
    let history_id = match crate::history::ingest(&app, &cap, "quick", scale) {
        Ok(rec) => Some(rec.id),
        Err(e) => {
            eprintln!("[SnapDoc][history] ingest (set_pending_image) thất bại: {e}");
            None
        }
    };

    if let Ok(mut g) = state.pending.lock() {
        *g = Some(PendingCapture {
            base64,
            width,
            height,
            output: "editor".to_string(),
            scale_factor: scale,
            history_id,
            capture_mode: "quick".to_string(),
            doc_json,
            doc_is_draft: false,
            file_path: None,
        });
    }
}

/// Chụp theo mode + output (gọi từ capture bar). Chạy nền để không chặn UI.
#[tauri::command]
pub fn capture_now(app: AppHandle, mode: String, output: String) {
    std::thread::spawn(move || flow::run(&app, &mode, &output));
}

/// Huỷ phiên đếm ngược "hẹn giờ chụp" đang chạy (nếu có) — xem
/// `flow::wait_capture_delay`.
#[tauri::command]
pub fn cancel_capture_countdown(app: AppHandle) {
    flow::cancel_capture_countdown(&app);
}

/// "Chụp nhanh": mở overlay trong suốt trên mọi màn hình để chọn vùng + chú thích.
#[tauri::command]
pub fn start_quick(app: AppHandle) {
    std::thread::spawn(move || flow::start_quick(&app));
}

/// Chụp đúng vùng đã chọn cho "Chụp nhanh", trả base64 PNG cho React ghép chú thích.
/// async + spawn_blocking: không block Tokio event loop (WebView2 pump chạy tiếp).
#[tauri::command]
pub async fn capture_quick_region(
    app: AppHandle,
    window: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || flow::capture_quick_region(&app, window, x, y, w, h))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
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

/// Liệt kê cửa sổ (metadata, KHÔNG kèm ảnh) cho dialog "Chọn cửa sổ" dạng
/// lưới — trả về ngay lập tức để dialog vẽ khung lưới + spinner từng ô trước,
/// gọi `capture_window_thumbs_stream` riêng để lấy ảnh thumbnail sau.
#[tauri::command]
pub async fn list_window_metas() -> Result<Vec<capture::window::WindowMetaInfo>, String> {
    tauri::async_runtime::spawn_blocking(capture::window::list_metas)
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Chụp thumbnail cho từng cửa sổ trong `ids`, bắn event `"window-thumb-ready"`
/// (payload `(id, thumb | null)`) NGAY khi từng cửa sổ xong — cửa sổ nào chụp
/// xong trước hiển thị trước ở frontend, không phải đợi cả danh sách xong mới
/// thấy gì (xem `capture::window::capture_thumbs_streaming`). async +
/// spawn_blocking vì chụp ảnh (ScreenCaptureKit/xcap) tốn thời gian, không
/// được block Tokio event loop.
#[tauri::command]
pub async fn capture_window_thumbs_stream(app: AppHandle, ids: Vec<u32>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        capture::window::capture_thumbs_streaming(&ids, |id, thumb| {
            let _ = app.emit("window-thumb-ready", (id, thumb));
        });
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))
}

#[tauri::command]
pub fn cancel_overlay(app: AppHandle) {
    flow::cancel_overlay(&app);
}

/// Chụp nhanh "Mở trong Editor": báo Rust GIỮ SnapDoc frontmost (không trả
/// focus về app cũ như copy/save/hủy) — gọi TRƯỚC `open_editor` + `cancel_overlay`.
/// Xem `flow::keep_capture_focus` / `AppState::restore_front_pid`.
#[tauri::command]
pub fn keep_capture_focus(app: AppHandle) {
    flow::keep_capture_focus(&app);
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
    // `path` đến từ dialog Save/Save As gốc OS — dialog đã tự hỏi "Replace
    // existing file?" nên ghi đúng path, không dedupe (xem `write_png_exact`).
    storage::save::write_png_exact(&path, &data)
}

#[tauri::command]
pub fn save_and_copy(path: String, data: String) -> Result<String, String> {
    clipboard::copy_png(&data)?;
    storage::save::write_png_exact(&path, &data)
}

#[tauri::command]
pub fn open_capture_bar(app: AppHandle) -> Result<(), String> {
    windows::open_capture_bar(&app)
}

/// Nút "New" trong editor — chạy THẲNG đúng chế độ chụp gần nhất, KHÔNG mở/hiện
/// capture bar nữa (coi như hành động đã được "chọn" sẵn từ capture bar rồi,
/// giống hệt cách phím tắt toàn cục kích hoạt chụp mà không cần mở bar — xem
/// `hotkey::run_action`). Trước đây có mở bar + emit `set-capture-mode` để bar
/// tự bấm; đã bỏ vì capture bar không còn nút "Chụp" xác nhận (chọn mode =
/// chạy luôn), nên mở bar chỉ để rồi tự bắn action ngay là thừa — và từng gây
/// lỗi "webview overlay-0 already exists" do bar nhận event `set-capture-mode`
/// những HAI lần (cơ chế delay-emit an toàn cho window mới mount) nên chạy
/// `capture_now` lặp lại, mở overlay đè lên chính nó.
///
/// Luồng trên Windows:
/// - hide_editor() là lời gọi nhanh (không block).
/// - Toàn bộ được spawn sang std::thread riêng để tránh block Tauri IPC thread,
///   đặc biệt tránh trường hợp Win32 message pump stall khi hide window từ
///   thread không có message loop.
#[tauri::command]
pub fn open_capture_bar_for_new(app: AppHandle) -> Result<(), String> {
    std::thread::spawn(move || {
        windows::hide_editor(&app);
        // Trên Windows: đợi WM_SHOWWINDOW được xử lý trước khi tiếp tục,
        // tránh race condition với thao tác window vừa rồi.
        #[cfg(target_os = "windows")]
        std::thread::sleep(std::time::Duration::from_millis(80));
        let (mode, _) = app.state::<AppState>().last_capture.get();
        let output = crate::hotkey::default_output(&app);
        flow::run(&app, &mode, &output);
    });
    Ok(())
}

/// Trên Windows, nếu cửa sổ "editor" đã bị đóng trước đó (Save, đóng tay...)
/// thì `windows::open_editor` phải tạo lại webview mới bằng `build()`, vốn
/// block chờ event loop chính qua channel — gọi trực tiếp trên IPC thread sẽ
/// deadlock Win32 message pump (trắng trang + treo app), giống lỗi đã fix ở
/// `history::open_history`. Tách sang thread riêng để tránh.
#[tauri::command]
pub fn open_editor(app: AppHandle) -> Result<(), String> {
    std::thread::spawn(move || {
        let _ = windows::open_editor(&app);
    });
    Ok(())
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    windows::open_settings(&app)
}

#[tauri::command]
pub fn close_self(window: tauri::WebviewWindow) {
    let label = window.label();
    if label == "scroll-control" {
        // Khung viền chụp cuộn giờ chính là overlay tái sử dụng (xem
        // `windows::open_scroll_control`) — đây là đường HUỶ (nút "Huỷ"/Esc
        // trong ScrollControl), dùng `end_scroll_session` để đóng nốt overlay
        // đó VÀ dọn state phòng "kích hoạt lại" (xem hàm đó).
        crate::windows::end_scroll_session(window.app_handle());
    }
    // capture-bar không bao giờ bị destroy nữa — phải luôn tồn tại để giữ
    // Dock/taskbar icon xuyên suốt vòng đời app (xem `windows::prewarm_capture_bar`).
    // Bấm "X"/Escape chỉ minimize; `windows::open_capture_bar` tự unminimize
    // khi mở lại.
    if label == "capture-bar" {
        if let Some(popover) = window.app_handle().get_webview_window("capture-bar-popover") {
            let _ = popover.hide();
        }
        let _ = window.minimize();
        return;
    }
    if label == "capture-bar-popover" {
        let _ = window.hide();
        return;
    }
    let _ = window.close();
}

/// Frontend báo cửa sổ editor này đang có / không còn thay đổi chưa lưu.
///
/// Tự đọc `window.label()` (không nhận label qua tham số) để một cửa sổ không
/// thể khai hộ cửa sổ khác — cùng kỹ thuật với `take_open_file`. Quan trọng
/// trên macOS vì "Open with" mở thêm các cửa sổ `editor-ow-N` độc lập.
///
/// Đặt luôn title cửa sổ ở ĐÂY (Rust) chứ không gọi `setTitle()` bên JS:
/// `core:default` chỉ cho `core:window:allow-title` (getter), KHÔNG cho
/// `allow-set-title`, nên làm bên JS sẽ phải nới ACL trong
/// `capabilities/default.json` cho `windows: ["*"]` — đổi bề mặt quyền của mọi
/// webview (kể cả overlay) chỉ để đổi một dòng chữ. Phía Rust không qua ACL.
#[tauri::command]
pub fn set_editor_dirty(window: WebviewWindow, state: State<AppState>, dirty: bool) {
    let label = window.label().to_string();
    if let Ok(mut map) = state.editor_dirty.lock() {
        if dirty {
            map.insert(label, true);
        } else {
            // Xoá hẳn key thay vì set `false` — cửa sổ editor bị destroy sẽ
            // không để lại rác trong map (không có hook nào dọn theo label).
            map.remove(&label);
        }
    }
    let _ = window.set_title(if dirty {
        "• SnapDoc — Editor"
    } else {
        "SnapDoc — Editor"
    });
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

/// Mở một file `.snapdoc` từ đĩa: nạp nền + lớp annotation vào editor, và ghi
/// nhớ đường dẫn để Save ghi THẲNG lại chính file đó (không dialog, không đụng
/// Library) — đúng ngữ nghĩa một trình soạn tài liệu.
///
/// Cố tình KHÔNG ingest vào Library như ảnh PNG ngoài: đây đã là định dạng tài
/// liệu của app, ingest chỉ tạo ra một bản sao thứ hai để user phải tự hỏi bản
/// nào là thật.
fn open_snapdoc_path(app: &AppHandle, path: &str) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let f = crate::snapdoc_file::read_snapdoc(std::path::Path::new(path))?;
    let img = image::load_from_memory(&f.base_png)
        .map_err(|e| format!("Ảnh nền trong .snapdoc không hợp lệ: {e}"))?;
    let doc_is_draft = f.draft_json.is_some();
    let doc_json = f.effective_doc().to_string();
    {
        let state = app.state::<AppState>();
        let mut guard = state.pending.lock().map_err(|_| "Lock error".to_string())?;
        *guard = Some(PendingCapture {
            base64: STANDARD.encode(&f.base_png),
            width: img.width(),
            height: img.height(),
            output: "editor".to_string(),
            scale_factor: 1.0,
            history_id: None,
            capture_mode: "file".to_string(),
            doc_json: Some(doc_json),
            doc_is_draft,
            file_path: Some(path.to_string()),
        });
    }
    windows::open_editor(app)
}

/// Ghi lại một file `.snapdoc` trên đĩa (Editor Save cho tài liệu file-backed).
///
/// `base` chỉ truyền khi ảnh nền thật sự đổi (crop/stitch/flatten); `None` thì
/// giữ nguyên nền đang có trong file, khỏi đẩy vài MB base64 qua IPC.
#[tauri::command]
pub async fn save_snapdoc_file(
    path: String,
    doc_json: String,
    preview: String,
    base: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let preview_bytes = crate::history::decode_image_data(&preview)?;
        let (base_bytes, created_at) = match &base {
            Some(d) => (
                crate::history::decode_image_data(d)?,
                crate::snapdoc_file::read_snapdoc(p).map(|f| f.created_at).unwrap_or(0),
            ),
            None => {
                let f = crate::snapdoc_file::read_snapdoc(p)?;
                (f.base_png, f.created_at)
            }
        };
        crate::snapdoc_file::write_snapdoc(
            p,
            crate::snapdoc_file::WriteSnapdoc {
                base_png: &base_bytes,
                doc_json: &doc_json,
                // Save = chốt bản nháp thành bản chính.
                draft_json: None,
                preview_png: &preview_bytes,
                created_at,
                updated_at: crate::history::now_ms_pub(),
            },
        )
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Hàm nội bộ — gọi được từ lib.rs (RunEvent::Opened, Windows argv).
pub fn open_file_path_sync(app: &AppHandle, path: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    // Tài liệu `.snapdoc` đi đường riêng: nó là container ZIP, `image::load_from_memory`
    // bên dưới sẽ fail. Nhận dạng bằng magic bytes chứ không bằng phần mở rộng.
    if crate::snapdoc_file::is_snapdoc(std::path::Path::new(&path)) {
        return open_snapdoc_path(app, &path);
    }

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
                scale_factor: 1.0,
                // "Open with"/file ngoài KHÔNG vào History (chỉ ghi nhận ảnh do
                // app tự chụp) — history_id luôn None cho luồng này.
                history_id: None,
                capture_mode: "file".to_string(),
                doc_json: None,
                doc_is_draft: false,
                file_path: None,
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

/// Kết quả mở file từ dialog. Không còn chỉ là một data URL vì `.snapdoc` mang
/// thêm lớp annotation và đường dẫn gốc (Save ghi thẳng lại file đó).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    /// Data URL của pixel NỀN (với ảnh thường: chính nội dung file).
    pub data_url: String,
    /// Lớp annotation — chỉ có với `.snapdoc`.
    pub doc_json: Option<String>,
    /// Đường dẫn file — chỉ đặt cho `.snapdoc` (tài liệu file-backed).
    pub file_path: Option<String>,
}

/// Mở file dialog chọn ảnh hoặc tài liệu `.snapdoc`. `None` nếu user huỷ.
#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Result<Option<OpenedFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    use base64::{engine::general_purpose::STANDARD, Engine};

    let path = app
        .dialog()
        .file()
        .add_filter("Ảnh & tài liệu SnapDoc", &["snapdoc", "png", "jpg", "jpeg", "webp", "bmp", "gif"])
        .blocking_pick_file();

    let path = match path {
        Some(p) => p,
        None => return Ok(None),
    };

    let path_str = path.to_string();

    // `.snapdoc` là container ZIP — nhận dạng bằng magic bytes, không bằng phần
    // mở rộng (user có thể đổi tên file).
    if crate::snapdoc_file::is_snapdoc(std::path::Path::new(&path_str)) {
        let f = crate::snapdoc_file::read_snapdoc(std::path::Path::new(&path_str))?;
        return Ok(Some(OpenedFile {
            data_url: format!("data:image/png;base64,{}", STANDARD.encode(&f.base_png)),
            doc_json: Some(f.effective_doc().to_string()),
            file_path: Some(path_str),
        }));
    }

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
    Ok(Some(OpenedFile {
        data_url: format!("data:{mime};base64,{b64}"),
        doc_json: None,
        file_path: None,
    }))
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
    // Rebuild tray menu — rẻ, và đảm bảo đổi "language" phản ánh ngay trên
    // menu tray (chỉ đọc lại từ settings.json, không phụ thuộc field nào đổi).
    tray::rebuild_menu(&app);
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

/// Lỗi đăng ký global shortcut lúc khởi động (nếu có) — Settings gọi lúc mount
/// để hiện banner cảnh báo phím tắt bị trùng/không đăng ký được.
#[tauri::command]
pub fn get_hotkey_warning(app: AppHandle) -> Option<String> {
    app.state::<AppState>().hotkey_warning.lock().ok().and_then(|g| g.clone())
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

/// Returns true if a silent background update has been installed and the app
/// needs to restart to apply it. Settings calls this on mount so the restart
/// banner is shown even when the window was opened after the event fired.
#[tauri::command]
pub fn get_update_ready() -> bool {
    crate::update::UPDATE_READY.load(std::sync::atomic::Ordering::Relaxed)
}

/// Download + install the pending update and restart the app.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    crate::update::install_pending(app).await
}

/// Restart the app immediately — used after a silent background update has been
/// installed and the user confirms via Settings or tray.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    // Cùng lý do với tray "Quit": nếu đang quay, dừng sạch trước để không
    // giết ffmpeg giữa chừng (mp4 hỏng) — xem `record::finalize_on_exit`.
    crate::record::finalize_on_exit(&app);
    app.restart();
}

#[tauri::command]
pub fn start_scroll_session(state: State<'_, AppState>) {
    if let Ok(mut slices) = state.scroll_slices.lock() {
        slices.clear();
    }
}

/// Giới hạn số lát cắt tối đa cho 1 phiên chụp cuộn — mỗi lát là 1
/// `RgbaImage` full-res giữ nguyên trong RAM tới lúc ghép (không nén), ảnh
/// ~1920×1440 đã ~11MB/lát. Không giới hạn thì trang cuộn quá dài có thể đẩy
/// RAM lên hàng GB. 300 lát tương ứng ~3.3GB ở độ phân giải trên — đủ rộng
/// cho hầu hết trang dài, vẫn có trần để tránh OOM.
const MAX_SCROLL_SLICES: usize = 300;

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
    {
        let slices = state.scroll_slices.lock().map_err(|_| "Lỗi lock scroll_slices".to_string())?;
        if slices.len() >= MAX_SCROLL_SLICES {
            return Err(format!(
                "Đã đạt giới hạn {MAX_SCROLL_SLICES} lát cắt cho 1 lần chụp cuộn — hãy dừng lại và ghép ảnh."
            ));
        }
    }

    let raw_img = tauri::async_runtime::spawn_blocking(move || -> Result<image::RgbaImage, String> {
        let m = crate::capture::monitor::at_point(mx, my)?;
        let img = crate::capture::region::capture_region_raw(&m, rx, ry, rw, rh)?;
        Ok(img)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Encode preview TRƯỚC (persist chỉ borrow) rồi MOVE ảnh vào bộ đệm —
    // tránh clone cả 1 RgbaImage full-res (~11MB ở 1920×1440) trên hot path
    // của mỗi lát cuộn.
    let cap = crate::capture::persist(&raw_img)?;
    if let Ok(mut slices) = state.scroll_slices.lock() {
        slices.push(raw_img);
    }
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
    // Khung viền chụp cuộn giờ là overlay tái sử dụng (xem
    // `windows::open_scroll_control`) — phiên đã HOÀN TẤT, dùng
    // `end_scroll_session` để đóng overlay đó VÀ dọn state phòng "kích hoạt
    // lại" (xem hàm đó).
    crate::windows::end_scroll_session(&app);
    let cap = crate::capture::Capture {
        base64,
        width,
        height,
    };
    let output = crate::flow::get_output(&app);
    // flow::finish() có thể gọi windows::open_editor() (build() cửa sổ mới) —
    // tách sang thread riêng để không deadlock IPC thread trên Windows, xem
    // comment ở commands::open_editor.
    std::thread::spawn(move || {
        let _ = crate::flow::finish(&app, cap, &output, 1.0);
    });
    Ok(())
}

// ── Quay màn hình ────────────────────────────────────────────────────────────
// "start" (hotkey — quay ngay màn hình chính, không qua overlay) + 1 lệnh mở
// picker dùng CHUNG mode với nút "Chụp" (full/window/region — Phase 3, tái
// dùng overlay chọn vùng có sẵn của tính năng chụp ảnh, xem
// `flow::run_record_picker`) là những thứ duy nhất cần lộ ra IPC lúc BẮT ĐẦU
// quay. Dừng quay/đọc trạng thái chủ yếu vẫn đi qua Rust thuần (tray icon +
// ticker, xem tray.rs) — `stop_recording`/`recording_status` bên dưới chỉ
// thêm 1 đường dừng/đọc trạng thái nữa cho popup "đang quay" trên Windows
// (`windows::open_recording_indicator`), vì Win32 tray icon không có API
// tương đương `NSStatusItem.title` để tự vẽ đồng hồ đếm cạnh icon.

/// Bắt đầu quay toàn màn hình chính (macOS), KHÔNG qua overlay — dùng cho
/// hotkey (lối tắt tức thời, không có UI để chọn phạm vi). `spawn_blocking`
/// vì phần khởi tạo `SCStream`/ffmpeg chờ đồng bộ qua completion handler
/// (blocking recv).
#[tauri::command]
pub async fn start_recording(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::record::start_recording(&app))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Mở overlay chọn phạm vi quay — dùng nút "Quay" trong CaptureBar, `mode`
/// là đúng CaptureMode đang chọn ("full" | "window" | "region") giống hệt
/// input của nút "Chụp".
#[tauri::command]
pub fn start_record_picker(app: AppHandle, mode: String) {
    std::thread::spawn(move || flow::run_record_picker(&app, &mode));
}

/// Bấm nút "Quay" ở CaptureBar trong lúc khung chọn vùng quay đã đang mở —
/// coi như bấm "Bắt đầu quay" ngay tại khung đó (xem
/// `flow::confirm_region_record_start`), không mở lại phiên chọn vùng mới.
#[tauri::command]
pub fn confirm_region_record_start(app: AppHandle) {
    flow::confirm_region_record_start(&app);
}

/// Dừng quay từ popup "đang quay" trên Windows (xem
/// `windows::open_recording_indicator`) — trên macOS việc dừng vẫn chủ yếu đi
/// qua tray icon (`tray.rs`), lệnh này chỉ thêm 1 đường dừng nữa, không thay
/// thế đường cũ. `spawn_blocking` BẮT BUỘC:
/// `record::stop_recording` join các thread ghi video/audio và
/// chạy `ffmpeg` đồng bộ để ghép audio (có thể mất vài giây) — nếu để hàm này
/// là `fn` thường (không `async`), Tauri chạy nó THẲNG trên main thread của
/// webview (execution context "sync", không qua thread pool), nghẽn toàn bộ
/// message pump và Windows báo "Not Responding" ở màn xác nhận lưu/xoá.
#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::record::stop_recording(&app))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Thời lượng đã quay (ms) — popup "đang quay" trên Windows poll lệnh này mỗi
/// giây để hiện đồng hồ đếm (`None` nếu không có phiên quay nào).
#[tauri::command]
pub fn recording_status(app: AppHandle) -> Option<u64> {
    crate::record::status(&app)
}

/// Tạm dừng phiên quay hiện tại — writer thread video/audio sẽ drop
/// frame/chunk trong lúc paused, đồng hồ đếm cũng đứng yên. No-op nếu đã
/// paused. `spawn_blocking` không cần (chỉ set cờ atomic, không blocking).
#[tauri::command]
pub fn pause_recording(app: AppHandle) -> Result<(), String> {
    crate::record::pause_recording(&app)
}

/// Tiếp tục phiên quay sau khi tạm dừng. No-op nếu đang chạy. `spawn_blocking`
/// không cần — chỉ set cờ atomic và cộng thêm elapsed vào accumulated.
#[tauri::command]
pub fn resume_recording(app: AppHandle) -> Result<(), String> {
    crate::record::resume_recording(&app)
}

/// Trạng thái tạm dừng hiện tại — `None` nếu không có phiên quay.
#[tauri::command]
pub fn recording_paused_state(app: AppHandle) -> Option<bool> {
    crate::record::paused_state(&app)
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

fn col_fixed_with_content(
    refs: &[&image::RgbaImage],
    x: u32,
    h: u32,
    y_step: u32,
    bg: i32,
) -> bool {
    let mut content_count = 0usize;
    let mut match_count = 0usize;
    let mut total_samples = 0usize;
    let mut y = 0u32;
    while y < h {
        total_samples += 1;
        let base = lum_u8(refs[0].get_pixel(x, y));
        let mut row_match = true;
        for r in &refs[1..] {
            if (lum_u8(r.get_pixel(x, y)) - base).abs() > 18 {
                row_match = false;
                break;
            }
        }
        if row_match {
            match_count += 1;
        }
        if (base - bg).abs() > 24 {
            content_count += 1;
        }
        y += y_step;
    }
    // Cột cố định nếu ít nhất 92% số điểm mẫu dọc theo cột là cố định và có chứa nội dung
    total_samples > 0 && (match_count as f32 / total_samples as f32) >= 0.92 && content_count > 0
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

            // Copy theo HÀNG bằng `copy_from_slice` trên buffer thô thay vì
            // `get_pixel`/`put_pixel` từng điểm — ảnh ghép có thể cao hàng
            // chục nghìn px (hàng trăm triệu pixel), per-pixel với bounds
            // check mỗi call chậm hơn memcpy theo hàng rất nhiều. Offset tính
            // bằng usize: ảnh ghép rất dài có thể vượt u32 khi nhân ra byte.
            let x_hi_clamped = x_hi.min(slice_w).min(width);
            if x_lo < x_hi_clamped {
                let row_len = ((x_hi_clamped - x_lo) * 4) as usize;
                let src_raw: &[u8] = slice.as_raw();
                let dst_raw: &mut [u8] = &mut final_img;
                for y in 0..inst.src_h {
                    let src_pixel_y = inst.src_y + y;
                    if src_pixel_y >= slice_h {
                        continue;
                    }
                    let dest_pixel_y = current_y + y;
                    if dest_pixel_y >= total_height {
                        continue;
                    }
                    let src_off = (src_pixel_y as usize * slice_w as usize + x_lo as usize) * 4;
                    let dst_off = (dest_pixel_y as usize * width as usize + x_lo as usize) * 4;
                    dst_raw[dst_off..dst_off + row_len]
                        .copy_from_slice(&src_raw[src_off..src_off + row_len]);
                }
            }

            current_y += inst.src_h;
        }

        // Đóng băng sidebar (kiểu Snagit): phần cột cố định bên dưới khung đầu được
        // ĐỔ bằng cách kéo dài hàng đáy của sidebar xuống hết chiều cao — nền sidebar
        // (thường màu đặc) trải liền mạch, nội dung sidebar chỉ hiện 1 lần ở trên.
        if (fixed_left > 0 || fixed_right > 0) && first_h > 0 && first_h <= total_height {
            // Copy sẵn 2 dải anchor ra buffer riêng rồi đổ theo HÀNG — cùng
            // lý do row-wise ở vòng ghép phía trên.
            let anchor_y = (first_h - 1) as usize;
            let row_px = width as usize;
            let left_len = fixed_left as usize * 4;
            let right_x = width.saturating_sub(fixed_right) as usize;
            let right_len = fixed_right as usize * 4;
            let dst_raw: &mut [u8] = &mut final_img;
            let left_off = anchor_y * row_px * 4;
            let left_src = dst_raw[left_off..left_off + left_len].to_vec();
            let right_off = (anchor_y * row_px + right_x) * 4;
            let right_src = dst_raw[right_off..right_off + right_len].to_vec();
            for y in (first_h as usize)..(total_height as usize) {
                if left_len > 0 {
                    let off = y * row_px * 4;
                    dst_raw[off..off + left_len].copy_from_slice(&left_src);
                }
                if right_len > 0 {
                    let off = (y * row_px + right_x) * 4;
                    dst_raw[off..off + right_len].copy_from_slice(&right_src);
                }
            }
        }

        let cap = crate::capture::persist(&final_img)?;
        Ok(cap)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    // Khung viền chụp cuộn giờ là overlay tái sử dụng (xem
    // `windows::open_scroll_control`) — phiên đã HOÀN TẤT (đây là đường "Hoàn
    // thành" chính, gọi TRƯỚC `close_self`/`finalize_scroll_capture`), dùng
    // `end_scroll_session` để đóng overlay đó VÀ dọn state phòng "kích hoạt
    // lại" (xem hàm đó).
    crate::windows::end_scroll_session(&app);

    let output = crate::flow::get_output(&app);
    crate::flow::finish(&app, cap, &output, 1.0)
}

/// Lấy ảnh "đóng băng màn hình" (JPEG base64 trần) cho overlay có chỉ số `idx`.
/// Frontend gọi khi mount overlay để lấy background tĩnh thay vì nhìn xuyên
/// qua overlay trong suốt vào app đang chạy phía sau.
/// Trả `None` nếu chưa có dữ liệu (lỗi chụp, hoặc chưa gọi `take_frozen_screens`).
#[tauri::command]
pub fn get_frozen_screen(state: State<AppState>, idx: usize) -> Option<String> {
    state
        .frozen_screens
        .lock()
        .ok()
        .and_then(|g| g.get(&idx).cloned())
}

/// Frontend gọi NGAY SAU KHI đã paint xong ảnh đóng băng (double rAF, xem
/// `useFrozenScreen` trong Overlay.tsx) — báo cho `windows::wait_for_overlays_ready`
/// biết overlay `idx` (thuộc phiên `gen`) đã sẵn sàng để `win.show()`.
/// Không có Sender đang chờ (đã timeout hoặc phiên cũ) thì bỏ qua im lặng.
#[tauri::command]
pub fn notify_overlay_ready(state: State<AppState>, gen: u64, idx: usize) {
    if let Ok(slot) = state.overlay_ready_tx.lock() {
        if let Some(tx) = slot.as_ref() {
            let _ = tx.send((gen, idx));
        }
    }
}
