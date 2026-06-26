use crate::{
    capture,
    clipboard,
    state::{AppState, MonitorSnap, PendingCapture},
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

fn get_output(app: &AppHandle) -> String {
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

fn finish(app: &AppHandle, cap: capture::Capture, output: &str) -> Result<(), String> {
    store(app, &cap, output);
    match output {
        "clipboard" => {
            clipboard::copy_png(&cap.base64)?;
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
