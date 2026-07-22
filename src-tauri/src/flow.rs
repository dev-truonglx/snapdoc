use crate::{
    capture,
    clipboard,
    state::{AppState, MonitorSnap, PendingCapture},
    storage,
    windows,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

fn hide_bar(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("capture-bar") {
        #[cfg(target_os = "windows")]
        {
            // Giữ cửa sổ tồn tại trên taskbar (app-level anchor) thay vì
            // hidden hoàn toàn như trước.
            let _ = win.minimize();
            let _ = win.set_skip_taskbar(false);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = win.hide();
        }
    }
}

/// Ẩn capture bar rồi chờ compositor bỏ frame cũ trước khi lấy ảnh freeze.
///
/// Trên Windows, capture bar vẫn `minimize()` để icon taskbar luôn tồn tại,
/// nhưng DWM transition của RIÊNG cửa sổ này bị tắt trước khi minimize. Nếu
/// không tắt được DWM transition, fallback dùng thời gian chờ cũ để không làm
/// hỏng phiên chụp.
fn hide_bar_for_freeze(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        if windows::minimize_capture_bar_for_freeze(app) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        } else {
            hide_bar(app);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    #[cfg(target_os = "macos")]
    {
        hide_bar(app);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    hide_bar(app);
}

fn bar_is_visible(app: &AppHandle) -> bool {
    app.get_webview_window("capture-bar")
        .map(|w| {
            let visible = w.is_visible().unwrap_or(false);
            #[cfg(target_os = "windows")]
            {
                let minimized = w.is_minimized().unwrap_or(false);
                visible && !minimized
            }
            #[cfg(not(target_os = "windows"))]
            {
                visible
            }
        })
        .unwrap_or(false)
}

/// Đọc vùng quay gần nhất đã lưu (persist trong settings.json, sống qua cả
/// lần khởi động lại app — không chỉ trong 1 phiên) — (display_id, x, y, w, h)
/// theo ĐÚNG hệ đơn vị của `MonitorSnap` (points trên macOS, physical px trên
/// Windows/Linux), local theo màn hình (KHÔNG cộng offset `snap.x`/`snap.y`),
/// giống hệt `rx/ry/rw/rh` mà `finalize_region` tính ra. `None` nếu chưa từng
/// quay vùng chọn lần nào hoặc file settings hỏng.
pub fn load_last_region(app: &AppHandle) -> Option<(u32, f64, f64, f64, f64)> {
    let config_dir = app.path().app_config_dir().ok()?;
    let settings = storage::settings::load(&config_dir);
    let v = settings.get("lastRecordRegion")?;
    Some((
        v.get("displayId")?.as_u64()? as u32,
        v.get("x")?.as_f64()?,
        v.get("y")?.as_f64()?,
        v.get("w")?.as_f64()?,
        v.get("h")?.as_f64()?,
    ))
}

/// Lưu lại vùng vừa dùng để quay — gọi mỗi khi 1 phiên quay vùng chọn bắt đầu
/// thành công, để lần "Quay > Vùng chọn" tiếp theo có thể đề xuất dùng lại
/// ngay (xem `run_record_picker`), không bắt user kéo chọn lại từ đầu.
fn save_last_region(app: &AppHandle, display_id: u32, x: f64, y: f64, w: f64, h: f64) {
    let Ok(config_dir) = app.path().app_config_dir() else { return };
    let mut settings = storage::settings::load(&config_dir);
    settings["lastRecordRegion"] = serde_json::json!({
        "displayId": display_id, "x": x, "y": y, "w": w, "h": h,
    });
    let _ = storage::settings::save(&config_dir, &settings);
}

/// Chụp "đóng băng" tất cả màn hình (JPEG) và lưu vào AppState — gọi TRƯỚC
/// `open_overlays` để overlay có background tĩnh ngay khi hiện ra, tránh user
/// tương tác nhầm với app phía sau (như Snagit/Lightshot). Chạy đồng bộ ở
/// thread hiện tại (thường là `std::thread::spawn`), không block UI.
/// Bỏ qua màn hình chứa cửa sổ editor (nếu có mở) để không "đóng băng" editor.
fn take_frozen_screens(app: &AppHandle) {
    let exclude_ids = get_editor_window_monitor_ids(app);
    let screens = capture::freeze::capture_frozen_screens_ex(&exclude_ids);
    if let Ok(mut g) = app.state::<AppState>().frozen_screens.lock() {
        *g = screens;
    }
}

/// Lấy danh sách monitor IDs của các cửa sổ editor đang mở.
/// Dùng để loại bỏ khỏi frozen screens — editor không bị "đóng băng".
fn get_editor_window_monitor_ids(app: &AppHandle) -> Vec<u32> {
    let mut ids = Vec::new();
    
    // Kiểm tra tất cả cửa sổ webview
    for (label, win) in app.webview_windows() {
        // Chỉ quan tâm cửa sổ editor (editor, editor-ow-N)
        if label.starts_with("editor") {
            // Lấy vị trí cửa sổ để xác định monitor chứa nó
            if let Ok(pos) = win.outer_position() {
                // Dùng xcap để tìm monitor tại vị trí đó
                if let Ok(monitor) = crate::capture::monitor::at_point(pos.x as i32, pos.y as i32) {
                    if let Ok(id) = monitor.id() {
                        if !ids.contains(&id) {
                            ids.push(id);
                            eprintln!("[SnapDoc] Loại bỏ editor (label={label}) khỏi frozen screens (monitor_id={id})");
                        }
                    }
                }
            }
        }
    }
    
    ids
}

/// Dọn dẹp frozen screens sau khi overlay đóng — giải phóng bộ nhớ.
fn clear_frozen_screens(app: &AppHandle) {
    if let Ok(mut g) = app.state::<AppState>().frozen_screens.lock() {
        g.clear();
    }
}

/// macOS: chụp lại "cửa sổ sản phẩm nào đang thật sự hiển thị" NGAY LÚC mở
/// overlay chọn vùng/màn hình/Quick Capture — trước khi user có cơ hội bấm
/// phím tắt Copy/Save (và trước khi hiện tượng cửa sổ tự bị đẩy lên có thể
/// xảy ra). Lưu vào AppState để dùng lại ở bước capture pixel thật, có thể
/// diễn ra trễ hơn nhiều (user kéo chọn vùng xong mới bấm Copy).
#[cfg(target_os = "macos")]
fn snapshot_product_windows(app: &AppHandle) {
    let keep = windows::snapshot_visible_product_windows(app);
    *app.state::<AppState>().visible_product_windows.lock().unwrap() = keep;
}
#[cfg(not(target_os = "macos"))]
fn snapshot_product_windows(_app: &AppHandle) {}

/// Bọc 1 lần chụp pixel thật (`f`) bằng protect/unprotect cửa sổ sản phẩm
/// theo allowlist đã chụp ở `snapshot_product_windows` — chỉ có tác dụng
/// trên macOS (nơi quan sát thấy cửa sổ tự bị đẩy lên khi xử lý phím tắt);
/// no-op ở nơi khác. Luôn gỡ protect ngay sau `f`, kể cả khi `f` lỗi.
fn with_product_windows_protected<T>(
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] app: &AppHandle,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    #[cfg(target_os = "macos")]
    {
        let keep = app.state::<AppState>().visible_product_windows.lock().unwrap().clone();
        windows::protect_product_windows(app, &keep);
        let result = f();
        windows::unprotect_product_windows(app);
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        f()
    }
}

fn set_output(app: &AppHandle, output: &str) {
    let state = app.state::<AppState>();
    let mut guard = match state.pending_output.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    *guard = output.to_string();
}

pub fn get_output(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    state
        .pending_output
        .lock()
        .map(|o| o.clone())
        .unwrap_or_else(|_| "editor".to_string())
}

fn store(app: &AppHandle, cap: &capture::Capture, output: &str, scale_factor: f64, mode: &str) {
    let state = app.state::<AppState>();
    let mut guard = match state.pending.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    *guard = Some(PendingCapture {
        base64: cap.base64.clone(),
        width: cap.width,
        height: cap.height,
        output: output.to_string(),
        scale_factor,
        history_id: None,
        capture_mode: mode.to_string(),
    });
}

/// Tên file theo template `{prefix}_YYYY-MM-DD_HHMMSS` (UTC) — dùng chung cho
/// capture thường (output "save"/"save_copy", prefix "Screenshot"), Quick
/// Capture (`history::save_quick_auto`) và quay màn hình (`record::mod`,
/// prefix "Recording") để cùng một quy ước đặt tên.
pub(crate) fn stamp_filename(prefix: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let secs = now % 86400;
    let days = now / 86400;
    let (y, mo, d) = days_to_ymd(days);
    let hh = secs / 3600;
    let mm = (secs % 3600) / 60;
    let ss = secs % 60;
    format!("{prefix}_{y:04}-{mo:02}-{d:02}_{hh:02}{mm:02}{ss:02}")
}

/// `scale_factor`: hệ số quy đổi pixel-vật-lý-của-bitmap → CSS/logical px,
/// lưu vào `PendingCapture` (badge HiDPI ở Editor). Truyền 1.0 khi không rõ.
pub fn finish(
    app: &AppHandle,
    cap: capture::Capture,
    output: &str,
    scale_factor: f64,
) -> Result<(), String> {
    // Đọc mode 1 lần, dùng chung cho `store()` (Editor cần biết để chọn zoom
    // mặc định, xem `PendingCapture.capture_mode`) và ingest History bên dưới.
    let (mode, _) = app.state::<AppState>().last_capture.get();
    store(app, &cap, output, scale_factor, &mode);

    // Ingest vào History Library — LUÔN chạy bất kể output, KHÔNG BAO GIỜ làm
    // gián đoạn clipboard/save/editor phía dưới nếu lỗi (đĩa đầy, DB lỗi...).
    match crate::history::ingest(app, &cap, &mode, scale_factor) {
        Ok(rec) => crate::history::attach_pending_id(app, &rec.id),
        Err(e) => eprintln!("[SnapDoc][history] ingest thất bại, luồng capture vẫn tiếp tục: {e}"),
    }

    match output {
        "clipboard" => {
            clipboard::copy_png(&cap.base64)?;
            windows::open_thumbnail(app)
        }
        "copy_editor" => {
            clipboard::copy_png(&cap.base64)?;
            windows::open_editor(app)
        }
        "save" | "save_copy" => {
            // Lấy saveDir từ settings; fallback về Pictures/SnapDoc nếu chưa cấu hình.
            let save_dir = {
                let config_dir = app.path().app_config_dir().unwrap_or_default();
                let s = storage::settings::load(&config_dir);
                let dir = s.get("saveDir").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if dir.is_empty() {
                    app.path()
                        .picture_dir()
                        .map(|p| p.join("SnapDoc").to_string_lossy().to_string())
                        .unwrap_or_default()
                } else {
                    dir
                }
            };
            let path = format!("{save_dir}/{}.png", stamp_filename("Screenshot"));
            let data = format!("data:image/png;base64,{}", cap.base64);
            let saved = storage::save::write_png(&path, &data)?;
            if output == "save_copy" {
                clipboard::copy_png(&cap.base64)?;
            }
            // Lưu đường dẫn đã ghi vào pending để thumbnail/editor có thể dùng nếu cần
            let state = app.state::<AppState>();
            if let Ok(mut g) = state.pending.lock() {
                if let Some(ref mut p) = *g {
                    p.output = format!("saved:{saved}");
                }
            }
            windows::open_thumbnail(app)
        }
        _ => windows::open_editor(app),
    }
}

fn overlay_snap(app: &AppHandle, win: &WebviewWindow) -> Option<MonitorSnap> {
    let idx = win.label().strip_prefix("overlay-")?.parse::<usize>().ok()?;
    let state = app.state::<AppState>();
    let g = state.overlay_monitors.lock().ok()?;
    g.get(idx).copied()
}

pub fn run(app: &AppHandle, mode: &str, output: &str) {
    // Lưu chế độ trước khi chụp (kể cả "full" → overlay monitor)
    app.state::<AppState>().last_capture.set(mode, output);
    // Snapshot TRƯỚC KHI đụng tới bất kỳ cửa sổ/focus nào (kể cả hide_bar và
    // mở overlay) — vì bản thân open_overlays() cũng gọi set_focus() lên 1
    // cửa sổ của app, có thể tự kích hoạt app và đẩy cửa sổ ẩn lên trước NGAY
    // TỪ ĐÂY, tức là TRƯỚC khi user kịp bấm phím tắt Copy/Save. Nếu snapshot
    // sau open_overlays thì đã quá trễ — window đã bị đẩy lên rồi.
    snapshot_product_windows(app);
    // Đóng băng màn hình: ẩn capture-bar TRƯỚC rồi mới chụp frozen — đảm bảo
    // capture-bar không lọt vào ảnh frozen. Sau đó mở overlay với frozen
    // image đã sẵn sàng trong AppState.
    if bar_is_visible(app) {
        hide_bar_for_freeze(app);
    }
    take_frozen_screens(app);
    let result: Result<(), String> = (|| {
        set_output(app, output);
        let overlay_mode = if mode == "full" { "monitor" } else { mode };
        windows::open_overlays(app, overlay_mode)
    })();
    if let Err(e) = result {
        clear_frozen_screens(app);
        let _ = app.emit("snapdoc-error", e);
    }
}

/// Mở overlay chọn PHẠM VI QUAY (không phải chụp ảnh) — tái dùng NGUYÊN VẸN
/// overlay chọn vùng/cửa sổ/màn hình đã có cho chụp ảnh tĩnh. `mode` nhận
/// đúng giá trị CaptureMode phía UI ("full" | "window" | "region") — cùng
/// input với nút "Chụp", để 1 mode đang chọn dùng chung cho cả 2 hành động.
/// "full" được map sang overlay "monitor" giống hệt `run()` (chụp "full"
/// cũng luôn mở overlay chọn màn hình, không có gì tự động ở đây). Set cờ
/// `pending_record` để `finalize_region`/`finalize_window`/`finalize_monitor`
/// biết đường CHUYỂN HƯỚNG sang `record::start_recording_*` thay vì chụp ảnh
/// + `finish()` như bình thường.
pub fn run_record_picker(app: &AppHandle, mode: &str) {
    // Đóng băng màn hình: ẩn capture-bar TRƯỚC rồi mới chụp frozen.
    if bar_is_visible(app) {
        hide_bar_for_freeze(app);
    }
    take_frozen_screens(app);
    let result: Result<(), String> = (|| {
        *app.state::<AppState>().pending_record.lock().unwrap() = true;
        let overlay_mode = if mode == "full" { "monitor" } else { mode };
        // "region": đề xuất lại vùng đã quay lần gần nhất (nếu có) — overlay
        // tự khớp đúng màn hình + validate còn nằm trong biên (xem
        // `windows::open_overlays_ex`), KHÔNG áp dụng cho "window"/"monitor"
        // (bấm chọn tức thì, không cần bước chỉnh vùng).
        let preset = if overlay_mode == "region" { load_last_region(app) } else { None };
        windows::open_overlays_ex(app, overlay_mode, true, preset)?;
        // Overlay mới tạo (always_on_top) có thể đè lên CaptureBar (cũng
        // always_on_top, tạo trước) — đưa CaptureBar lên lại để user vẫn thấy
        // và bấm được nút "Quay" của nó cạnh khung chọn vùng.
        if mode == "region" {
            if let Some(bar) = app.get_webview_window("capture-bar") {
                let _ = bar.set_focus();
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        *app.state::<AppState>().pending_record.lock().unwrap() = false;
        clear_frozen_screens(app);
        let _ = app.emit("snapdoc-error", e);
    }
}

/// Bấm nút "Quay" ở CaptureBar TRONG LÚC khung chọn vùng quay
/// (`RecordRegionSelect`) đã đang mở/hiển thị — coi như bấm "Bắt đầu quay"
/// NGAY tại khung đó (dùng đúng vùng đang hiển thị, kể cả đã kéo/resize),
/// KHÔNG mở lại phiên chọn vùng mới. Bắn event cho overlay đang mở tự xử lý —
/// no-op nếu overlay đã đóng hoặc đang ở pha "selecting" (chưa có khung nào).
pub fn confirm_region_record_start(app: &AppHandle) {
    let _ = app.emit("region-record-confirm", ());
}

/// `true` nếu cờ `pending_record` đang bật — nếu có, TẮT LUÔN (lấy 1 lần) để
/// lần chọn tiếp theo mặc định quay về chụp ảnh như thường lệ.
fn take_pending_record(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let mut guard = state.pending_record.lock().unwrap();
    std::mem::take(&mut *guard)
}

pub fn finalize_region(
    app: &AppHandle,
    win: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    // Step 1: resolve MonitorSnap WHILE the overlay window still exists.
    let s = overlay_snap(app, &win)
        .ok_or_else(|| "Khong xac dinh duoc man hinh cua overlay".to_string())?;

    // On Windows, MonitorSnap stores physical pixels while the overlay
    // reports CSS logical pixels. Multiply by the DPI scale factor so that
    // the coordinates passed to capture_region are physical pixels.
    // macOS ScreenCaptureKit works in points (= CSS px), so scale = 1.
    // Linux follows the same logical-pixel convention as macOS here.
    #[cfg(target_os = "windows")]
    let scale_in_snap: f64 = s.scale;
    #[cfg(not(target_os = "windows"))]
    let scale_in_snap: f64 = 1.0;

    let center_x = (s.x + (x + w / 2.0) * scale_in_snap) as i32;
    let center_y = (s.y + (y + h / 2.0) * scale_in_snap) as i32;

    // Step 2: resolve the xcap Monitor object while we still have snap data.
    let m = capture::monitor::at_point(center_x, center_y)?;

    // Convert to physical px, clamping negative origin to 0.
    let rx = (x * scale_in_snap).max(0.0);
    let ry = (y * scale_in_snap).max(0.0);

    // Subtract any portion clipped from the left/top edge.
    let mut rw = (w * scale_in_snap) - (0.0_f64.max(-x) * scale_in_snap);
    let mut rh = (h * scale_in_snap) - (0.0_f64.max(-y) * scale_in_snap);

    // Clamp to MonitorSnap bounds to avoid out-of-range coords.
    let snap_w = s.w;
    let snap_h = s.h;
    if rx + rw > snap_w {
        rw = snap_w - rx;
    }
    if ry + rh > snap_h {
        rh = snap_h - ry;
    }
    if rw < 1.0 || rh < 1.0 {
        windows::close_overlays(app);
        windows::restore_regular_activation(app);
        return Err("Vung chon khong hop le".to_string());
    }

    if take_pending_record(app) {
        windows::close_overlays_except(app, win.label());
        windows::restore_regular_activation(app);
        let display_id = m.id().map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
        save_last_region(app, display_id, rx, ry, rw, rh);
        crate::record::start_recording_region(app, display_id, rx, ry, rw, rh)?;

        // KHÔNG resize/reposition/ẩn/tạo lại BẤT KỲ cửa sổ nào cho phần
        // khung+backdrop — chính overlay đang hiển thị (đã đứng y nguyên từ
        // lúc user kéo/chỉnh vùng) được giữ lại, chỉ bật click-through để
        // click xuyên qua được xuống nội dung thật phía dưới trong lúc quay.
        // Vì không có bất kỳ thao tác cửa sổ nào xảy ra, khung đỏ + nền mờ
        // hiển thị Y NGUYÊN PIXEL suốt từ pha "adjusting" sang lúc quay —
        // không một khung hình nào bị bỏ lỡ, loại bỏ HOÀN TOÀN nguồn gây
        // nháy hình (2 cửa sổ khác nhau luôn có độ trễ dù chỉ 1 khung hình do
        // compositor xử lý độc lập, dù đã pre-warm để giảm thời gian tải).
        let _ = win.set_ignore_cursor_events(true);
        // Thanh "Dừng quay" là cửa sổ NHỎ, RIÊNG (không click-through) — nổi
        // đúng ngay vị trí nút "Bắt đầu quay" vừa hiện, xem
        // `windows::open_stop_control`.
        windows::open_stop_control(app, &s, rx, ry, rw, rh)?;
        return Ok(());
    }

    let (mode, _) = app.state::<AppState>().last_capture.get();
    if mode == "scroll" {
        windows::close_overlays(app);
        windows::restore_regular_activation(app);
        windows::open_scroll_control(app, center_x, center_y, rx as u32, ry as u32, rw as u32, rh as u32)?;
        return Ok(());
    }

    // Step 3: close overlays BEFORE capture.
    // KHÔNG poll sau close — deadlock risk (xem close_overlays). Sleep 200ms.
    windows::close_overlays(app);
    // KHÔNG restore_regular_activation ở đây — xem lý do ngay trước lệnh
    // chụp pixel ở dưới (menu bar bug).
    // Frozen screen không còn cần thiết sau khi overlay đóng.
    clear_frozen_screens(app);
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Step 4: capture the region on this thread. LƯU Ý: commands.rs hiện
    // spawn hàm này qua `tauri::async_runtime::spawn_blocking` (thread pool
    // blocking của Tokio, KHÔNG phải `std::thread::spawn` như comment cũ
    // từng nói) — xcap trên Windows tự init COM per-call nếu cần; nếu tương
    // lai gặp lỗi CoInitialize trên Windows, chuyển caller về
    // `std::thread::spawn` với COM apartment riêng.
    // Tỉ lệ pixel-vật-lý/CSS-px của bitmap vừa chụp — lưu vào PendingCapture để
    // Editor hiển thị badge HiDPI đúng. Linux: xcap trả đúng số pixel yêu cầu
    // (không nhân scale) → 1.0; macOS/Windows: bitmap ở physical px → s.scale.
    #[cfg(target_os = "linux")]
    let bitmap_scale: f64 = 1.0;
    #[cfg(not(target_os = "linux"))]
    let bitmap_scale: f64 = s.scale;

    // Chụp pixel TRƯỚC khi trả `ActivationPolicy::Regular` — trả Regular
    // trước lúc này khiến macOS coi SnapDoc là app active và hiện menu bar
    // của chính SnapDoc lên, đè vào đúng vùng ảnh đang chụp (nếu vùng chọn
    // chạm mép trên màn hình) thay vì menu bar của app đang thật sự hiển
    // thị. Cùng cơ chế "Regular khiến 1 lệnh tương đương focus cướp menu
    // bar" đã ghi ở comment `open_overlays_ex` — ở đây không có lệnh focus
    // nào, nhưng chính bản thân việc đổi policy cũng đủ để kích hoạt lại.
    let cap = with_product_windows_protected(app, || {
        capture::region::capture_region(&m, rx as u32, ry as u32, rw as u32, rh as u32)
    })?;
    windows::restore_regular_activation(app);
    let output = get_output(app);
    finish(app, cap, &output, bitmap_scale)
}

pub fn finalize_window(app: &AppHandle, id: u32) -> Result<(), String> {
    windows::close_overlays(app);
    clear_frozen_screens(app);

    if take_pending_record(app) {
        windows::restore_regular_activation(app);
        return crate::record::start_recording_window(app, id);
    }

    // Chờ WM_CLOSE được main thread xử lý và DWM unregister protected surface.
    // Không poll (deadlock risk) — sleep cố định 200ms là đủ.
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Chụp TRƯỚC khi restore_regular_activation — xem lý do chi tiết ở
    // `finalize_region` (bug menu bar của SnapDoc lọt vào ảnh chụp).
    let cap = capture::window::capture_by_id(id)?;
    windows::restore_regular_activation(app);
    let output = get_output(app);
    finish(app, cap, &output, 1.0)
}

pub fn finalize_monitor(app: &AppHandle, win: WebviewWindow) -> Result<(), String> {
    let s = overlay_snap(app, &win)
        .ok_or_else(|| "Khong xac dinh duoc man hinh cua overlay".to_string())?;
    let center_x = (s.x + s.w / 2.0) as i32;
    let center_y = (s.y + s.h / 2.0) as i32;
    let m = capture::monitor::at_point(center_x, center_y)?;

    if take_pending_record(app) {
        windows::close_overlays(app);
        windows::restore_regular_activation(app);
        let display_id = m.id().map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
        return crate::record::start_recording_monitor(app, display_id);
    }

    // KHÔNG poll sau close — deadlock risk (xem close_overlays). Sleep 200ms.
    windows::close_overlays(app);
    clear_frozen_screens(app);
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));
    // Chụp TRƯỚC khi restore_regular_activation — xem lý do chi tiết ở
    // `finalize_region` (bug menu bar của SnapDoc lọt vào ảnh chụp). Capture
    // fullscreen/monitor LUÔN chạm mép trên màn hình nên đây là case dễ thấy
    // bug nhất.
    let cap = with_product_windows_protected(app, || capture::fullscreen::capture_monitor(&m))?;
    windows::restore_regular_activation(app);
    let output = get_output(app);
    finish(app, cap, &output, s.scale)
}

pub fn cancel_overlay(app: &AppHandle) {
    // Reset cờ chọn phạm vi quay — tránh rò rỉ sang lần chọn vùng/cửa sổ kế
    // tiếp (vốn dành cho chụp ảnh) nếu người dùng bấm Esc giữa lúc đang chọn
    // phạm vi quay.
    *app.state::<AppState>().pending_record.lock().unwrap() = false;
    // Giải phóng frozen screen data — không còn cần sau khi overlay đóng.
    clear_frozen_screens(app);
    windows::close_overlays(app);
    windows::restore_regular_activation(app);

    // macOS: dọn dẹp trạng thái focus/ẩn của phiên Chụp nhanh (no-op nếu
    // phiên này không phải Chụp nhanh — cả 2 field chỉ được set trong
    // `start_quick`). THỨ TỰ BẮT BUỘC: trả frontmost về app cũ TRƯỚC (nếu
    // copy/save/hủy — `restore_front_pid` còn Some; mở Editor đã clear nó qua
    // `keep_capture_focus`), RỒI MỚI phục hồi (orderFront, không focus) các
    // cửa sổ đã ẩn — phục hồi TRƯỚC khi SnapDoc kịp mất frontmost sẽ khiến
    // chúng nháy lên lại đúng vấn đề đang tránh (xem
    // `windows::restore_hidden_product_windows`). Chạy nền sau 1 nhịp ngắn
    // để overlay đóng hẳn, không chặn caller.
    #[cfg(target_os = "macos")]
    {
        let pid = app
            .state::<AppState>()
            .restore_front_pid
            .lock()
            .ok()
            .and_then(|mut g| g.take());
        let hidden = app
            .state::<AppState>()
            .hidden_for_capture
            .lock()
            .ok()
            .map(|mut g| std::mem::take(&mut *g))
            .unwrap_or_default();
        if pid.is_some() || !hidden.is_empty() {
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                if let Some(pid) = pid {
                    windows::reactivate_app_pid(&app2, pid);
                    // Chờ thêm để việc activate app cũ chạy xong hẳn trên
                    // main thread trước khi orderFront lại các cửa sổ đã ẩn.
                    std::thread::sleep(std::time::Duration::from_millis(80));
                }
                if !hidden.is_empty() {
                    windows::restore_hidden_product_windows(&app2, &hidden);
                }
            });
        }
    }
}

/// Chụp nhanh: người dùng chọn "Mở trong Editor" — huỷ việc trả focus về app
/// cũ (`cancel_overlay` chạy sau đó trong `finally` của frontend sẽ thấy
/// `restore_front_pid` = None) vì lúc này ta CHỦ ĐỘNG muốn SnapDoc frontmost
/// để hiển thị Editor. Xem `AppState::restore_front_pid`.
pub fn keep_capture_focus(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(mut g) = app.state::<AppState>().restore_front_pid.lock() {
            *g = None;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Chụp tất cả màn hình ghép ngang, không cần overlay.
/// Ẩn capture bar trước khi chụp để không lọt vào ảnh.
pub fn capture_all_screens(app: &AppHandle, output: &str) -> Result<(), String> {
    app.state::<AppState>().last_capture.set("all", output);
    if bar_is_visible(app) {
        hide_bar_for_freeze(app);
    }
    // Không có bước "mở overlay, chờ user bấm nút" ở flow này (chụp ngay lập
    // tức) nên snapshot ngay trước khi chụp là đủ — không có khoảng hở thời
    // gian nào cho hiện tượng cửa sổ tự bị đẩy lên xảy ra.
    snapshot_product_windows(app);
    let cap = with_product_windows_protected(app, capture::fullscreen::capture_all_monitors)?;
    finish(app, cap, output, 1.0)
}

/// "Chụp nhanh" (Lightshot-style): mở overlay TRONG SUỐT trên MỌI màn hình
/// (tái dùng hạ tầng chọn vùng đa-màn-hình sẵn có — nhanh, không đóng băng ảnh).
/// User kéo chọn vùng, sau đó chú thích ngay trên overlay (thấy màn hình thật
/// qua vùng trong suốt). Ảnh cuối CHỈ được chụp khi bấm Copy/Save — chỉ chụp
/// đúng vùng nhỏ đã chọn (nhanh), rồi ghép chú thích. Đúng yêu cầu "vẽ khung
/// xong chưa chụp, di chuyển được, tới lúc lưu/copy mới chụp".
pub fn start_quick(app: &AppHandle) {
    // KHÔNG còn gọi `snapshot_product_windows` ở đây (khác `run()`/
    // `capture_all_screens`): cơ chế content-protection (`with_product_windows_protected`)
    // dựa vào nó chỉ là lưới an toàn YẾU cho hiện tượng "cửa sổ occluded bị hệ
    // thống đẩy lên khi activate app" — `hide_occluded_product_windows` ngay
    // dưới đây ẩn THẬT SỰ (orderOut) các cửa sổ đó xuyên suốt CẢ phiên Chụp
    // nhanh (từ đây tới lúc `cancel_overlay` phục hồi), nên khi
    // `capture_quick_region` chụp pixel sau này, không còn cửa sổ occluded
    // nào để mà lộ vào ảnh nữa — xem đó để hiểu vì sao không cần bọc
    // `with_product_windows_protected` quanh bước chụp pixel như trước.
    // macOS: nhớ app đang frontmost (khác SnapDoc) TRƯỚC khi open_overlays
    // kích hoạt SnapDoc — để `cancel_overlay` trả lại focus cho nó sau khi
    // copy/save/hủy xong (xem `AppState::restore_front_pid`). ĐỒNG THỜI ẩn
    // THẬT SỰ (orderOut) các cửa sổ sản phẩm đang bị app khác che — set_focus
    // sắp chạy activate app NGAY LẬP TỨC (đồng bộ), nếu không ẩn trước thì
    // macOS tự đưa chúng lên TRÊN app hiện tại NGAY TRONG lúc activate, hiện
    // ra 1-2 khung hình rồi mới bị ẩn lại dù ta phản ứng nhanh cỡ nào sau đó
    // — đây chính là nguyên nhân "hiện lên xong rồi mới ẩn" (xem
    // `windows::hide_occluded_product_windows`).
    #[cfg(target_os = "macos")]
    {
        let pid = windows::frontmost_other_app_pid(app);
        if let Ok(mut g) = app.state::<AppState>().restore_front_pid.lock() {
            *g = pid;
        }
        let hidden = windows::hide_occluded_product_windows(app);
        if let Ok(mut g) = app.state::<AppState>().hidden_for_capture.lock() {
            *g = hidden;
        }
    }
    // Đóng băng màn hình: ẩn capture-bar TRƯỚC rồi mới chụp frozen — đảm bảo
    // capture-bar không lọt vào ảnh frozen. Trên macOS cần sleep nhỏ để
    // compositor cập nhật sau khi hide_bar (orderOut) trước khi SCK chụp.
    if bar_is_visible(app) {
        hide_bar_for_freeze(app);
    }
    take_frozen_screens(app);
    let result: Result<(), String> = (|| {
        windows::open_overlays(app, "quick")
    })();
    if let Err(e) = result {
        let _ = app.emit("snapdoc-error", e);
    }
}

/// Chụp đúng vùng đã chọn cho "Chụp nhanh" và trả base64 PNG cho React (React
/// tự ghép lớp chú thích rồi copy/save). ẨN overlay trước khi chụp để dim +
/// annotation + khung chọn KHÔNG lọt vào ảnh (giống cách finalize_region đóng
/// overlay trước khi chụp). Toạ độ (x,y,w,h) là CSS px trong overlay `win`.
pub fn capture_quick_region(
    app: &AppHandle,
    win: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<String, String> {
    let s = overlay_snap(app, &win)
        .ok_or_else(|| "Khong xac dinh duoc man hinh cua overlay".to_string())?;

    #[cfg(target_os = "windows")]
    let scale_in_snap: f64 = s.scale;
    #[cfg(not(target_os = "windows"))]
    let scale_in_snap: f64 = 1.0;

    let center_x = (s.x + (x + w / 2.0) * scale_in_snap) as i32;
    let center_y = (s.y + (y + h / 2.0) * scale_in_snap) as i32;
    let m = capture::monitor::at_point(center_x, center_y)?;

    let rx = (x * scale_in_snap).max(0.0);
    let ry = (y * scale_in_snap).max(0.0);
    let mut rw = (w * scale_in_snap) - (0.0_f64.max(-x) * scale_in_snap);
    let mut rh = (h * scale_in_snap) - (0.0_f64.max(-y) * scale_in_snap);
    if rx + rw > s.w {
        rw = s.w - rx;
    }
    if ry + rh > s.h {
        rh = s.h - ry;
    }
    if rw < 1.0 || rh < 1.0 {
        return Err("Vung chon khong hop le".to_string());
    }

    // Ẩn overlay để không dính dim/annotation vào ảnh, rồi chờ compositor cập nhật.
    let _ = win.hide();
    #[cfg(target_os = "macos")]
    std::thread::sleep(std::time::Duration::from_millis(70));
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));

    // KHÔNG bọc `with_product_windows_protected` ở đây nữa (khác
    // `finalize_region`/`finalize_window`/`finalize_monitor`/`capture_all_screens`,
    // nơi cơ chế đó vẫn là tuyến phòng thủ DUY NHẤT): mọi cửa sổ sản phẩm
    // đang bị app khác che đã bị `hide_occluded_product_windows` ẩn THẬT SỰ
    // từ lúc `start_quick` mở overlay, xuyên suốt tới tận đây — không còn gì
    // để mà lộ vào ảnh. Cửa sổ đang thật sự hiển thị (user chủ ý xem, kể cả
    // trên màn khác) thì trước giờ vẫn KHÔNG được loại khỏi ảnh (giữ đúng
    // hành vi cũ: "ý user đang muốn tự chụp chính nó").
    let cap = capture::region::capture_region(&m, rx as u32, ry as u32, rw as u32, rh as u32)?;
    Ok(cap.base64)
}

/// Chuyển số ngày Unix (từ 1970-01-01) sang (year, month, day) UTC.
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Thuật toán lịch Gregorian đơn giản
    let z = days + 719468;
    let era = z / 146097;
    let doe = z % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
