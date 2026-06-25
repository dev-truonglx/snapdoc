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

/// Snapshot màn hình của overlay theo idx trong label "overlay-N". Dùng CHÍNH
/// snapshot (hệ points nhất quán, lưu lúc mở overlay) thay vì `outer_position`
/// của Tauri — vốn ở hệ physical không nhất quán giữa các màn khác scale.
fn overlay_snap(app: &AppHandle, win: &WebviewWindow) -> Option<MonitorSnap> {
    let idx = win.label().strip_prefix("overlay-")?.parse::<usize>().ok()?;
    let state = app.state::<AppState>();
    let g = state.overlay_monitors.lock().ok()?;
    g.get(idx).copied()
}

/// Điểm vào chính. MỌI mode đều mở overlay trên tất cả màn hình; full → picker
/// chọn màn hình (mode "monitor"). Người dùng luôn chọn rồi mới chụp.
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

/// Đã chọn xong vùng trên overlay `win`. (x,y,w,h) = CSS px (logical) trong
/// overlay đó.
///
/// # Chuyển đổi toạ độ (quan trọng — đây là nguồn gốc crash cũ)
///
/// Frontend gửi toạ độ **CSS px = logical pixels** (đã chia scale).
/// `MonitorSnap.{x,y,w,h}` trên macOS = points (= logical) → không cần đổi.
/// Trên Windows/Linux = **physical pixels** → phải nhân `s.scale` trước khi:
///   1. Tính `center_x/y` để gọi `Monitor::from_point` (physical).
///   2. Truyền `rx/ry/rw/rh` vào `capture_region` (physical).
pub fn finalize_region(
    app: &AppHandle,
    win: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let s = overlay_snap(app, &win)
        .ok_or_else(|| "Không xác định được màn hình của overlay".to_string())?;

    // Hệ số nhân để đổi CSS px → đơn vị của snapshot.
    // macOS: scale_in_snap = 1.0 (points = CSS px).
    // Windows/Linux: scale_in_snap = s.scale (physical = CSS × scale).
    #[cfg(target_os = "macos")]
    let scale_in_snap: f64 = 1.0;
    #[cfg(not(target_os = "macos"))]
    let scale_in_snap: f64 = s.scale;

    // Tâm vùng chọn trong hệ snapshot toàn cục → lấy đúng xcap Monitor.
    let center_x = (s.x + (x + w / 2.0) * scale_in_snap) as i32;
    let center_y = (s.y + (y + h / 2.0) * scale_in_snap) as i32;
    let m = capture::monitor::at_point(center_x, center_y)?;

    // Vùng chọn tương đối gốc màn hình, đổi sang physical, kẹp trong biên.
    let rx = (x * scale_in_snap).max(0.0);
    let ry = (y * scale_in_snap).max(0.0);
    let mut rw = (w - (rx / scale_in_snap - x).max(0.0)) * scale_in_snap;
    let mut rh = (h - (ry / scale_in_snap - y).max(0.0)) * scale_in_snap;

    let snap_w = s.w * scale_in_snap;
    let snap_h = s.h * scale_in_snap;
    if rx + rw > snap_w {
        rw = snap_w - rx;
    }
    if ry + rh > snap_h {
        rh = snap_h - ry;
    }
    if rw < 1.0 || rh < 1.0 {
        windows::close_overlays(app);
        return Err("Vùng chọn không hợp lệ".to_string());
    }

    let cap = capture::region::capture_region(&m, rx as u32, ry as u32, rw as u32, rh as u32)?;
    windows::close_overlays(app);
    let output = get_output(app);
    finish(app, cap, &output)
}

/// Đã click chọn cửa sổ (id toàn cục, hoạt động trên mọi màn hình).
pub fn finalize_window(app: &AppHandle, id: u32) -> Result<(), String> {
    windows::close_overlays(app);
    let cap = capture::window::capture_by_id(id)?;
    let output = get_output(app);
    finish(app, cap, &output)
}

/// Đã click chọn cả màn hình (mode full). Xác định màn hình theo tâm overlay.
pub fn finalize_monitor(app: &AppHandle, win: WebviewWindow) -> Result<(), String> {
    let s = overlay_snap(app, &win)
        .ok_or_else(|| "Không xác định được màn hình của overlay".to_string())?;
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
