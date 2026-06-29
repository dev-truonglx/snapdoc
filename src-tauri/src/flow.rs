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

fn store(app: &AppHandle, cap: &capture::Capture, output: &str) {
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
    });
}

pub fn finish(app: &AppHandle, cap: capture::Capture, output: &str) -> Result<(), String> {
    store(app, &cap, output);
    match output {
        "clipboard" => {
            clipboard::copy_png(&cap.base64)?;
            windows::open_thumbnail(app)
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
            let stamp = {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                // Format YYYY-MM-DD_HHMMSS từ Unix timestamp (UTC)
                let secs = now % 86400;
                let days = now / 86400;
                // Tính năm/tháng/ngày đơn giản (UTC)
                let (y, mo, d) = days_to_ymd(days);
                let hh = secs / 3600;
                let mm = (secs % 3600) / 60;
                let ss = secs % 60;
                format!("Screenshot_{y:04}-{mo:02}-{d:02}_{hh:02}{mm:02}{ss:02}")
            };
            let path = format!("{save_dir}/{stamp}.png");
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
    let cap = capture::region::capture_region(&m, rx as u32, ry as u32, rw as u32, rh as u32)?;
    let output = get_output(app);
    finish(app, cap, &output)
}

pub fn finalize_window(app: &AppHandle, id: u32) -> Result<(), String> {
    windows::close_overlays(app);

    // Chờ WM_CLOSE được main thread xử lý và DWM unregister protected surface.
    // Không poll (deadlock risk) — sleep cố định 200ms là đủ.
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));

    let cap = capture::window::capture_by_id(id)?;
    let output = get_output(app);
    finish(app, cap, &output)
}

pub fn finalize_monitor(app: &AppHandle, win: WebviewWindow) -> Result<(), String> {
    let s = overlay_snap(app, &win)
        .ok_or_else(|| "Khong xac dinh duoc man hinh cua overlay".to_string())?;
    let center_x = (s.x + s.w / 2.0) as i32;
    let center_y = (s.y + s.h / 2.0) as i32;
    let m = capture::monitor::at_point(center_x, center_y)?;
    // KHÔNG poll sau close — deadlock risk (xem close_overlays). Sleep 200ms.
    windows::close_overlays(app);
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(200));
    let cap = capture::fullscreen::capture_monitor(&m)?;
    let output = get_output(app);
    finish(app, cap, &output)
}

pub fn cancel_overlay(app: &AppHandle) {
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
    finish(app, cap, output)
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
