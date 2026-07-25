use crate::{
    capture,
    clipboard,
    state::{AppState, MonitorSnap, PendingCapture},
    storage,
    windows,
};
use std::sync::atomic::Ordering;
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

/// Đọc số giây hẹn giờ chụp từ Settings (`timerSeconds` — option "Tắt/5s/10s"
/// ở capture-bar). `0` = tắt, chụp ngay như trước.
fn capture_delay_seconds(app: &AppHandle) -> u64 {
    let dir = app.path().app_config_dir().unwrap_or_default();
    storage::settings::load(&dir)
        .get("timerSeconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

/// Đếm ngược TRƯỚC KHI thực sự chụp, nếu user đã bật "hẹn giờ chụp" trong
/// Settings/capture-bar. Cho phép user mở dropdown/hover menu SAU khi bấm nút
/// chụp (hoặc phím tắt), đợi đếm ngược xong xuôi, KHÔNG cần bấm thêm phím nào
/// lúc menu đang mở — né đúng race-condition mất focus cửa sổ khi bấm phím
/// tắt trong lúc menu đang mở (đã xác nhận qua test thực tế — xem trao đổi:
/// bấm phím bất kỳ không đóng menu, nhưng đổi cửa sổ active (Alt+Tab) thì có;
/// và mọi cách rút ngắn/né thao tác cửa sổ phía SnapDoc đều không giải quyết
/// được vì gốc rễ nằm ở tầng OS/app đích, ngoài tầm code SnapDoc).
///
/// Emit `capture-countdown-tick` (số giây còn lại, kể cả giây đầu = tổng số
/// giây) mỗi giây cho capture-bar hiển thị đếm ngược. Trả `false` nếu bị huỷ
/// giữa chừng (`cancel_capture_countdown` — Esc, hoặc 1 phiên đếm khác đè lên)
/// — caller phải BỎ QUA bước chụp thật khi nhận `false`.
fn wait_capture_delay(app: &AppHandle) -> bool {
    let secs = capture_delay_seconds(app);
    if secs == 0 {
        return true;
    }
    let my_gen = app.state::<AppState>().countdown_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("capture-countdown-tick", secs);
    for remaining in (0..secs).rev() {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if app.state::<AppState>().countdown_gen.load(Ordering::SeqCst) != my_gen {
            return false;
        }
        let _ = app.emit("capture-countdown-tick", remaining);
    }
    true
}

/// Huỷ phiên đếm ngược "hẹn giờ chụp" đang chạy (nếu có) — gọi khi user bấm
/// Esc trên capture-bar trong lúc đang đếm. No-op an toàn nếu không có phiên
/// nào đang chạy (chỉ bump generation, phiên `wait_capture_delay` nào đang
/// `sleep` sẽ tự thoát ở vòng lặp kế tiếp, chậm nhất 1s).
pub fn cancel_capture_countdown(app: &AppHandle) {
    app.state::<AppState>().countdown_gen.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("capture-countdown-cancel", ());
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

/// Chỉ số overlay (`overlay-{i}`) từ label cửa sổ — cùng key với
/// `frozen_screens`/`overlay_monitors`.
fn overlay_index(win: &WebviewWindow) -> Option<usize> {
    win.label().strip_prefix("overlay-")?.parse::<usize>().ok()
}

/// Crop ảnh cuối từ ẢNH FREEZE (grab A — chụp TRƯỚC khi overlay giành key
/// window) thay vì chụp lại pixel live — giữ nguyên dropdown/menu native đang
/// mở. Nguồn là ĐÚNG ảnh JPEG đang hiển thị làm nền overlay (`frozen_screens`),
/// KHÔNG đụng gì tới luồng chụp/lưu freeze để không ảnh hưởng nền hiển thị.
/// Trả `None` khi không có ảnh freeze cho màn `idx` (vd bị loại do editor mở,
/// hoặc freeze lỗi) → caller tự fallback về chụp live.
///
/// `(rx,ry,rw,rh)` cùng hệ đơn vị mà `finalize_region`/`capture_quick_region`
/// dùng cho `capture_region` (macOS/Linux = logical, Windows = physical px).
/// Ảnh freeze ở physical px full-monitor, nên đổi hệ bằng tỉ lệ
/// `image_px / snap_size` suy trực tiếp từ ảnh + `MonitorSnap` (đa nền tảng,
/// không cần `cfg`).
///
/// LƯU Ý CHẤT LƯỢNG: ảnh freeze là JPEG q85 → crop ra hơi kém lossless một
/// chút (rõ nhất ở chữ nhỏ). Đánh đổi để giữ dropdown và tuyệt đối không tác
/// động tới nền freeze.
fn crop_frozen(
    app: &AppHandle,
    idx: usize,
    s: &MonitorSnap,
    rx: f64,
    ry: f64,
    rw: f64,
    rh: f64,
) -> Option<capture::Capture> {
    // Lấy JPEG base64 (đúng bản đang hiển thị) rồi giải mã ra RGBA để crop.
    let b64 = {
        let state = app.state::<AppState>();
        let guard = state.frozen_screens.lock().ok()?;
        guard.get(&idx).cloned()?
    };
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();

    let (bw, bh) = (img.width() as f64, img.height() as f64);
    if s.w <= 0.0 || s.h <= 0.0 || bw < 1.0 || bh < 1.0 {
        return None;
    }
    let sx = bw / s.w;
    let sy = bh / s.h;
    let cx = (rx * sx).round().max(0.0);
    let cy = (ry * sy).round().max(0.0);
    let mut cw = (rw * sx).round();
    let mut ch = (rh * sy).round();
    // Clamp vào biên ảnh để không panic khi vùng chọn chạm mép.
    if cx + cw > bw {
        cw = bw - cx;
    }
    if cy + ch > bh {
        ch = bh - cy;
    }
    if cw < 1.0 || ch < 1.0 {
        return None;
    }
    let cropped =
        image::imageops::crop_imm(&img, cx as u32, cy as u32, cw as u32, ch as u32).to_image();
    capture::persist(&cropped).ok()
}

/// Xác định overlay/màn hình chứa cửa sổ `id` và rect của nó QUY VỀ gốc màn
/// đó, để dùng thẳng cho `crop_frozen` — cho phép `finalize_window` cũng ưu
/// tiên crop từ freeze thay vì chụp live (giữ dropdown/menu nổi trên cửa sổ
/// đích, xem chi tiết ở `crop_frozen`).
///
/// Toạ độ `xcap::Window` (macOS = points, Windows/Linux = physical px, xem
/// `capture/window.rs`) CÙNG hệ với `MonitorSnap.x/y/w/h` (snapshot trực tiếp
/// từ `xcap::Monitor` ở `windows::open_overlays_ex`) nên không cần quy đổi
/// scale như `finalize_region` phải làm với toạ độ overlay CSS px.
fn window_snap_and_rect(
    app: &AppHandle,
    id: u32,
) -> Option<(usize, MonitorSnap, f64, f64, f64, f64)> {
    let w = xcap::Window::all()
        .ok()?
        .into_iter()
        .find(|w| w.id().map(|i| i == id).unwrap_or(false))?;
    let (wx, wy, ww, wh) = (
        w.x().unwrap_or(0) as f64,
        w.y().unwrap_or(0) as f64,
        w.width().unwrap_or(0) as f64,
        w.height().unwrap_or(0) as f64,
    );
    if ww < 1.0 || wh < 1.0 {
        return None;
    }
    let (cx, cy) = (wx + ww / 2.0, wy + wh / 2.0);

    let snaps = app.state::<AppState>().overlay_monitors.lock().ok()?.clone();
    let (idx, snap) = snaps.iter().enumerate().find(|(_, s)| {
        cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h
    })?;

    let rx = (wx - snap.x).max(0.0);
    let ry = (wy - snap.y).max(0.0);
    let mut rw = ww;
    let mut rh = wh;
    if rx + rw > snap.w {
        rw = snap.w - rx;
    }
    if ry + rh > snap.h {
        rh = snap.h - ry;
    }
    if rw < 1.0 || rh < 1.0 {
        return None;
    }
    Some((idx, *snap, rx, ry, rw, rh))
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

/// Lấy `saveDir` từ settings; fallback về Pictures/SnapDoc nếu chưa cấu hình.
/// Dùng chung cho output mode "save"/"save_copy" (ghi chính) VÀ auto-export
/// bản sao ở các mode còn lại (xem `finish()`).
fn resolve_save_dir(app: &AppHandle) -> String {
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
    let ingested_id = match crate::history::ingest(app, &cap, &mode, scale_factor) {
        Ok(rec) => {
            crate::history::attach_pending_id(app, &rec.id);
            Some(rec.id)
        }
        Err(e) => {
            eprintln!("[SnapDoc][history] ingest thất bại, luồng capture vẫn tiếp tục: {e}");
            None
        }
    };

    match output {
        "clipboard" => {
            clipboard::copy_png(&cap.base64)?;
            auto_export_copy(app, &cap, ingested_id.as_deref());
            windows::open_thumbnail(app)
        }
        "copy_editor" => {
            clipboard::copy_png(&cap.base64)?;
            auto_export_copy(app, &cap, ingested_id.as_deref());
            windows::open_editor(app)
        }
        "save" | "save_copy" => {
            let save_dir = resolve_save_dir(app);
            let path = format!("{save_dir}/{}.png", stamp_filename("Screenshot"));
            let data = format!("data:image/png;base64,{}", cap.base64);
            let saved = storage::save::write_png(&path, &data)?;
            if output == "save_copy" {
                clipboard::copy_png(&cap.base64)?;
            }
            // Đây CHÍNH LÀ hành động Save chủ ý của user (không phải bản
            // auto-export best-effort) — ghi luôn `exported_path` bằng đúng
            // file này thay vì gọi thêm `auto_export_copy` (tránh ghi 2 file
            // trùng lặp trong `save_dir`).
            if let Some(id) = &ingested_id {
                if let Err(e) = crate::history::commands::set_history_exported_path_sync(app, id, &saved) {
                    eprintln!("[SnapDoc] Ghi exported_path thất bại: {e}");
                }
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
        _ => {
            auto_export_copy(app, &cap, ingested_id.as_deref());
            windows::open_editor(app)
        }
    }
}

/// Tự động ghi thêm 1 bản PNG vào `saveDir` cấu hình cho các output mode
/// KHÔNG chủ động ghi ra đó (khác "save"/"save_copy", đã tự làm việc này với
/// xử lý lỗi chặt hơn ở `finish()`) — để "Xem file trong Thư mục" ở
/// Editor/Library luôn có sẵn 1 bản trong đúng folder user cấu hình, không
/// phải đợi user tự bấm Save As. BEST-EFFORT: lỗi (đĩa đầy, quyền ghi...) CHỈ
/// log, không được làm gián đoạn output chính (clipboard đã copy/Editor đã mở
/// xong ở lúc gọi hàm này) — khác nhánh "save"/"save_copy" nơi ghi file THẤT
/// BẠI nghĩa là chính hành động user vừa chọn thất bại, phải báo lỗi rõ ràng.
fn auto_export_copy(app: &AppHandle, cap: &capture::Capture, history_id: Option<&str>) {
    let save_dir = resolve_save_dir(app);
    let path = format!("{save_dir}/{}.png", stamp_filename("Screenshot"));
    let data = format!("data:image/png;base64,{}", cap.base64);
    match storage::save::write_png(&path, &data) {
        Ok(saved) => {
            if let Some(id) = history_id {
                if let Err(e) = crate::history::commands::set_history_exported_path_sync(app, id, &saved) {
                    eprintln!("[SnapDoc] Ghi exported_path thất bại: {e}");
                }
            }
        }
        Err(e) => eprintln!("[SnapDoc] Tự động lưu bản sao vào {save_dir} thất bại: {e}"),
    }
}

fn overlay_snap(app: &AppHandle, win: &WebviewWindow) -> Option<MonitorSnap> {
    let idx = win.label().strip_prefix("overlay-")?.parse::<usize>().ok()?;
    let state = app.state::<AppState>();
    let g = state.overlay_monitors.lock().ok()?;
    g.get(idx).copied()
}

pub fn run(app: &AppHandle, mode: &str, output: &str) {
    // Đếm ngược trước (nếu bật "hẹn giờ chụp") — huỷ ngang (Esc) thì bỏ luôn,
    // không chụp gì cả.
    if !wait_capture_delay(app) {
        return;
    }
    // Lưu chế độ trước khi chụp (kể cả "full" → overlay monitor)
    app.state::<AppState>().last_capture.set(mode, output);
    // Ẩn editor nếu đang mở (giống nhấn button "New" trong editor)
    windows::hide_editor(app);
    set_output(app, output);

    // "window": dialog "Chọn cửa sổ" dạng lưới thumbnail (tham khảo dialog
    // "Select App Window" của macOS) — 1 cửa sổ dialog BÌNH THƯỜNG (có viền/
    // tiêu đề), khác hẳn overlay phủ kín màn hình của "region"/"full" nên
    // KHÔNG cần freeze màn hình/snapshot cửa sổ ẩn (không chụp "qua" nó).
    if mode == "window" {
        if bar_is_visible(app) {
            hide_bar(app);
        }
        if let Err(e) = windows::open_window_picker(app, false) {
            let _ = app.emit("snapdoc-error", e);
        }
        return;
    }

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
    // Ẩn editor nếu đang mở (giống nhấn button "New" trong editor)
    windows::hide_editor(app);

    // "window": dùng chung dialog "Chọn cửa sổ" dạng lưới thumbnail với chụp
    // ảnh (xem nhánh tương ứng ở `run()`) — set `pending_record` để
    // `finalize_window` biết chuyển hướng sang `record::start_recording_window`
    // thay vì chụp ảnh. Không cần freeze vì đây là dialog thường, không phải
    // overlay phủ kín màn hình.
    if mode == "window" {
        *app.state::<AppState>().pending_record.lock().unwrap() = true;
        if bar_is_visible(app) {
            hide_bar(app);
        }
        if let Err(e) = windows::open_window_picker(app, true) {
            *app.state::<AppState>().pending_record.lock().unwrap() = false;
            let _ = app.emit("snapdoc-error", e);
        }
        return;
    }

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
        // Cùng kỹ thuật chống nháy hình với nhánh `pending_record` ở trên: GIỮ
        // NGUYÊN chính overlay đang hiển thị (đã đứng yên từ lúc user kéo/thả
        // chuột) làm khung viền trong lúc chụp cuộn, thay vì đóng nó rồi build
        // 1 cửa sổ "scroll-border" MỚI từ đầu — trước đây khoảng hở giữa lúc
        // overlay cũ biến mất và cửa sổ mới paint xong chính là nguồn gây
        // "nháy khung" khi bắt đầu chụp cuộn. Không có build() mới nào cho
        // phần khung nên khung xanh hiển thị Y NGUYÊN PIXEL, chỉ đổi sang
        // click-through để chuột xuyên xuống trang thật phía dưới.
        windows::close_overlays_except(app, win.label());
        windows::restore_regular_activation(app);
        windows::open_scroll_control(app, &win, center_x, center_y, rx as u32, ry as u32, rw as u32, rh as u32)?;
        return Ok(());
    }

    // Tỉ lệ pixel-vật-lý/CSS-px của bitmap kết quả — lưu vào PendingCapture để
    // Editor hiển thị badge HiDPI đúng. Linux: xcap trả đúng số pixel yêu cầu
    // (không nhân scale) → 1.0; macOS/Windows: bitmap ở physical px → s.scale.
    // Áp dụng cho CẢ nhánh crop-từ-frozen lẫn nhánh chụp live: crop cho ra đúng
    // số physical px như live grab nên badge scale giống nhau.
    #[cfg(target_os = "linux")]
    let bitmap_scale: f64 = 1.0;
    #[cfg(not(target_os = "linux"))]
    let bitmap_scale: f64 = s.scale;

    // Step 3a: ưu tiên CROP từ buffer freeze (grab A — chụp TRƯỚC khi overlay
    // giành key window) thay vì chụp lại pixel live. Đây là điểm mấu chốt giữ
    // nguyên dropdown/menu native đang mở: live grab (grab B) chạy sau khi
    // overlay `set_focus()` nên popup đã đóng, còn buffer freeze vẫn còn nó.
    // Phải crop TRƯỚC `clear_frozen_screens`. Buffer freeze KHÔNG chứa overlay
    // (freeze chạy trước khi mở overlay) nên bỏ luôn close-trước-khi-chụp,
    // sleep 200ms và content-protection — không cần thiết.
    if let Some(cap) = overlay_index(&win).and_then(|i| crop_frozen(app, i, &s, rx, ry, rw, rh)) {
        windows::close_overlays(app);
        clear_frozen_screens(app);
        windows::restore_regular_activation(app);
        let output = get_output(app);
        return finish(app, cap, &output, bitmap_scale);
    }

    // Step 3b (fallback): không có buffer freeze cho màn này (vd bị loại do
    // editor mở, hoặc freeze lỗi) → chụp lại pixel live như trước.
    // close overlays BEFORE capture.
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
    // (`bitmap_scale` đã tính ở trên, dùng chung cho cả nhánh frozen.)

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
    if take_pending_record(app) {
        windows::close_overlays(app);
        clear_frozen_screens(app);
        windows::restore_regular_activation(app);
        // Đưa cửa sổ sắp quay lên trước — nếu đang ẩn phía sau app khác, user
        // sẽ thấy nó nổi lên ngay thay vì vẫn chìm phía sau suốt phiên quay
        // (quay vẫn hoạt động dù cửa sổ bị che, đây thuần là UX). Lấy pid
        // NGAY LÚC NÀY (không phải trước đó) để tránh trường hợp cửa sổ đã
        // đóng giữa lúc chọn — `pid_of` trả `None` thì bỏ qua, không chặn quay.
        if let Some(pid) = capture::window::pid_of(id) {
            windows::bring_app_to_front(app, pid, id);
        }
        return crate::record::start_recording_window(app, id);
    }

    // Ưu tiên CROP từ buffer freeze (grab A — chụp TRƯỚC khi overlay giành key
    // window) thay vì chụp lại pixel live: giữ nguyên dropdown/menu native nổi
    // trên cửa sổ đích (vd popup/NSMenu là cửa sổ riêng, không thuộc bề mặt mà
    // `capture_by_id` chụp). Phải làm TRƯỚC `clear_frozen_screens`.
    if let Some((idx, snap, rx, ry, rw, rh)) = window_snap_and_rect(app, id) {
        if let Some(cap) = crop_frozen(app, idx, &snap, rx, ry, rw, rh) {
            windows::close_overlays(app);
            clear_frozen_screens(app);
            windows::restore_regular_activation(app);
            let output = get_output(app);
            #[cfg(target_os = "linux")]
            let bitmap_scale: f64 = 1.0;
            #[cfg(not(target_os = "linux"))]
            let bitmap_scale: f64 = snap.scale;
            return finish(app, cap, &output, bitmap_scale);
        }
    }

    // Fallback: không có buffer freeze cho màn chứa cửa sổ này (vd bị loại do
    // editor mở, hoặc freeze lỗi) → chụp lại pixel live như trước.
    windows::close_overlays(app);
    clear_frozen_screens(app);

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

    // Ưu tiên dùng NGUYÊN buffer freeze (grab A — chụp TRƯỚC khi overlay giành
    // key window) thay vì chụp lại pixel live: giữ nguyên dropdown/menu native
    // đang mở. `crop_frozen` với rect = cả màn hình (0,0,s.w,s.h) trả về đúng
    // toàn bộ buffer — buffer full-monitor là chính thứ `capture_monitor` tạo.
    if let Some(cap) =
        overlay_index(&win).and_then(|i| crop_frozen(app, i, &s, 0.0, 0.0, s.w, s.h))
    {
        windows::close_overlays(app);
        clear_frozen_screens(app);
        windows::restore_regular_activation(app);
        let output = get_output(app);
        return finish(app, cap, &output, s.scale);
    }

    // Fallback: không có buffer freeze cho màn này → chụp live như trước.
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
    if !wait_capture_delay(app) {
        return Ok(());
    }
    app.state::<AppState>().last_capture.set("all", output);
    // Ẩn editor nếu đang mở (giống nhấn button "New" trong editor)
    windows::hide_editor(app);
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
    // Ẩn editor nếu đang mở (giống nhấn button "New" trong editor)
    windows::hide_editor(app);
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

    // Ưu tiên CROP từ buffer freeze (grab A — chụp TRƯỚC khi overlay giành key
    // window) thay vì chụp lại pixel live: giữ nguyên dropdown/menu native đang
    // mở. Buffer freeze không chứa overlay/dim/annotation (freeze chạy trước
    // khi mở overlay) nên ảnh sạch sẵn. Frozen data chỉ được xoá về sau ở
    // `cancel_overlay` nên vẫn còn ở đây.
    if let Some(cap) = overlay_index(&win).and_then(|i| crop_frozen(app, i, &s, rx, ry, rw, rh)) {
        return Ok(cap.base64);
    }

    // Fallback: không có buffer freeze cho màn này → chụp live như trước.
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
