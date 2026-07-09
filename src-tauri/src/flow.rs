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
        let _ = win.hide();
    }
}

fn bar_is_visible(app: &AppHandle) -> bool {
    app.get_webview_window("capture-bar")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
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
    let result: Result<(), String> = (|| {
        if bar_is_visible(app) {
            hide_bar(app);
        }
        set_output(app, output);
        let overlay_mode = if mode == "full" { "monitor" } else { mode };
        windows::open_overlays(app, overlay_mode)
    })();
    if let Err(e) = result {
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
    let result: Result<(), String> = (|| {
        if bar_is_visible(app) {
            hide_bar(app);
        }
        *app.state::<AppState>().pending_record.lock().unwrap() = true;
        let overlay_mode = if mode == "full" { "monitor" } else { mode };
        windows::open_overlays(app, overlay_mode)
    })();
    if let Err(e) = result {
        *app.state::<AppState>().pending_record.lock().unwrap() = false;
        let _ = app.emit("snapdoc-error", e);
    }
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
        return Err("Vung chon khong hop le".to_string());
    }

    if take_pending_record(app) {
        windows::close_overlays(app);
        let display_id = m.id().map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
        return crate::record::start_recording_region(app, display_id, rx, ry, rw, rh);
    }

    let (mode, _) = app.state::<AppState>().last_capture.get();
    if mode == "scroll" {
        windows::close_overlays(app);
        windows::open_scroll_control(app, center_x, center_y, rx as u32, ry as u32, rw as u32, rh as u32)?;
        return Ok(());
    }

    // Step 3: close overlays BEFORE capture.
    // KHÔNG poll sau close — deadlock risk (xem close_overlays). Sleep 200ms.
    windows::close_overlays(app);
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Step 4: capture the region on this thread (caller must be an OS thread
    // with COM initialized -- see commands.rs where finalize_region is spawned
    // via std::thread::spawn instead of being invoked on a Tokio worker).
    // Tỉ lệ pixel-vật-lý/CSS-px của bitmap vừa chụp — lưu vào PendingCapture để
    // Editor hiển thị badge HiDPI đúng. Linux: xcap trả đúng số pixel yêu cầu
    // (không nhân scale) → 1.0; macOS/Windows: bitmap ở physical px → s.scale.
    #[cfg(target_os = "linux")]
    let bitmap_scale: f64 = 1.0;
    #[cfg(not(target_os = "linux"))]
    let bitmap_scale: f64 = s.scale;

    let cap = capture::region::capture_region(&m, rx as u32, ry as u32, rw as u32, rh as u32)?;
    let output = get_output(app);
    finish(app, cap, &output, bitmap_scale)
}

pub fn finalize_window(app: &AppHandle, id: u32) -> Result<(), String> {
    windows::close_overlays(app);

    if take_pending_record(app) {
        return crate::record::start_recording_window(app, id);
    }

    // Chờ WM_CLOSE được main thread xử lý và DWM unregister protected surface.
    // Không poll (deadlock risk) — sleep cố định 200ms là đủ.
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));

    let cap = capture::window::capture_by_id(id)?;
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
        let display_id = m.id().map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
        return crate::record::start_recording_monitor(app, display_id);
    }

    // KHÔNG poll sau close — deadlock risk (xem close_overlays). Sleep 200ms.
    windows::close_overlays(app);
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));
    let cap = capture::fullscreen::capture_monitor(&m)?;
    let output = get_output(app);
    finish(app, cap, &output, s.scale)
}

pub fn cancel_overlay(app: &AppHandle) {
    // Reset cờ chọn phạm vi quay — tránh rò rỉ sang lần chọn vùng/cửa sổ kế
    // tiếp (vốn dành cho chụp ảnh) nếu người dùng bấm Esc giữa lúc đang chọn
    // phạm vi quay.
    *app.state::<AppState>().pending_record.lock().unwrap() = false;
    windows::close_overlays(app);
}

/// Chụp tất cả màn hình ghép ngang, không cần overlay.
/// Ẩn capture bar trước khi chụp để không lọt vào ảnh.
pub fn capture_all_screens(app: &AppHandle, output: &str) -> Result<(), String> {
    app.state::<AppState>().last_capture.set("all", output);
    if bar_is_visible(app) {
        hide_bar(app);
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    let cap = capture::fullscreen::capture_all_monitors()?;
    finish(app, cap, output, 1.0)
}

/// "Chụp nhanh" (Lightshot-style): mở overlay TRONG SUỐT trên MỌI màn hình
/// (tái dùng hạ tầng chọn vùng đa-màn-hình sẵn có — nhanh, không đóng băng ảnh).
/// User kéo chọn vùng, sau đó chú thích ngay trên overlay (thấy màn hình thật
/// qua vùng trong suốt). Ảnh cuối CHỈ được chụp khi bấm Copy/Save — chỉ chụp
/// đúng vùng nhỏ đã chọn (nhanh), rồi ghép chú thích. Đúng yêu cầu "vẽ khung
/// xong chưa chụp, di chuyển được, tới lúc lưu/copy mới chụp".
pub fn start_quick(app: &AppHandle) {
    let result: Result<(), String> = (|| {
        if bar_is_visible(app) {
            hide_bar(app);
        }
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
