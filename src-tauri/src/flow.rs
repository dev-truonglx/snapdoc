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
    //
    // The overlay windows are created with set_content_protected(true) which
    // marks them as a DWM protected surface. Windows Graphics Capture (WGC)
    // skips protected surfaces in every frame, so if the overlay is still
    // visible the captured image will contain a black rectangle where the
    // overlay was. Closing first, then waiting one compositor frame (~50 ms)
    // lets DWM unregister the protected surface before WGC takes the shot.
    //
    // macOS ScreenCaptureKit does not have this restriction, so we skip the
    // sleep there to keep things snappy.
    windows::close_overlays(app);
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Step 4: capture the region on this thread (caller must be an OS thread
    // with COM initialized -- see commands.rs where finalize_region is spawned
    // via std::thread::spawn instead of being invoked on a Tokio worker).
    let cap = capture::region::capture_region(&m, rx as u32, ry as u32, rw as u32, rh as u32)?;
    let output = get_output(app);
    finish(app, cap, &output)
}

pub fn finalize_window(app: &AppHandle, id: u32) -> Result<(), String> {
    // Close overlays BEFORE capture so that the DWM-protected overlay surface
    // is unregistered from the compositor before Windows Graphics Capture
    // (WGC) takes the shot. Without the sleep, WGC may still see the overlay
    // protected surface and return a black/corrupt frame or panic.
    //
    // win.close() on Windows is async (sends WM_CLOSE), so we must wait for
    // the overlay to actually disappear. close_overlays() already polls up to
    // 300 ms for that on Windows, so no extra sleep is strictly needed beyond
    // what close_overlays guarantees. However, an additional short wait ensures
    // the DWM compositor has composited one full frame without the protected
    // surface before WGC starts capturing -- preventing black frames.
    //
    // macOS uses ScreenCaptureKit which does not have this restriction, so we
    // skip the sleep there.
    windows::close_overlays(app);
    #[cfg(not(target_os = "macos"))]
    std::thread::sleep(std::time::Duration::from_millis(50));

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
    windows::close_overlays(app);
    let cap = capture::fullscreen::capture_monitor(&m)?;
    let output = get_output(app);
    finish(app, cap, &output)
}

pub fn cancel_overlay(app: &AppHandle) {
    windows::close_overlays(app);
}
