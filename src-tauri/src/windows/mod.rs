use crate::state::{AppState, MonitorSnap};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "macos"))]
use tauri::PhysicalSize;

/// Vị trí con trỏ trong hệ POINTS global của CoreGraphics (top-left origin),
/// NHẤT QUÁN với CGDisplayBounds dùng cho `MonitorSnap`. KHÔNG dùng
/// `app.cursor_position()` của Tauri vì nó trả points × scale-màn-chính →
/// lệch với toạ độ màn hình khác scale.
#[cfg(target_os = "macos")]
fn cursor_points() -> Option<(f64, f64)> {
    use objc2_core_graphics::CGEvent;
    let ev = CGEvent::new(None)?;
    let p = CGEvent::location(Some(&ev));
    Some((p.x, p.y))
}

/// Cấu hình NSWindow của overlay (BẮT BUỘC chạy trên main thread):
/// 1. Đặt FRAME đúng bằng `NSScreen.frame` của màn hình có `display_id` —
///    cách native, chính xác tuyệt đối kể cả khi đa màn hình khác scale
///    (tránh hoàn toàn các quirk chuyển đổi physical/logical của tao).
/// 2. collectionBehavior → hiện trên Space đang active của TỪNG màn hình
///    (mấu chốt khi macOS bật "Displays have separate Spaces").
#[cfg(target_os = "macos")]
fn configure_overlay_ns_window_main_thread(win: &tauri::WebviewWindow, display_id: u32) {
    use objc2::msg_send;
    use objc2_app_kit::NSScreen;
    use objc2_foundation::{ns_string, MainThreadMarker};

    let ptr = match win.ns_window() {
        Ok(p) => p as *mut objc2_app_kit::NSWindow,
        Err(_) => return,
    };
    if ptr.is_null() {
        return;
    }
    // SAFETY: chạy trên main thread (caller bảo đảm). con trỏ NSWindow do Tauri
    // giữ, còn sống trong scope.
    unsafe {
        let ns_win: &objc2_app_kit::NSWindow = &*ptr;

        // CanJoinAllSpaces=1 | Stationary=1<<4 | FullScreenAuxiliary=1<<8.
        let behavior: usize = 1 | (1 << 4) | (1 << 8);
        let _: () = msg_send![ns_win, setCollectionBehavior: behavior];

        // Đặt window level CAO HƠN menu bar của macOS để overlay phủ kín toàn
        // màn hình, bao gồm cả thanh menu (NSMenuBarWindowLevel ≈ 24).
        // NSScreenSaverWindowLevel = 1000 — đảm bảo phủ mọi thứ kể cả
        // Spotlight, Notification Center và menu bar.
        // CGWindowLevel của NSScreenSaverWindowLevel là 1000.
        let screen_saver_level: i64 = 1000;
        let _: () = msg_send![ns_win, setLevel: screen_saver_level];

        // Tìm NSScreen có NSScreenNumber == display_id rồi setFrame theo đúng
        // frame (points, hệ AppKit) của nó.
        if let Some(mtm) = MainThreadMarker::new() {
            let screens = NSScreen::screens(mtm);
            for i in 0..screens.count() {
                let screen = screens.objectAtIndex(i);
                let desc = screen.deviceDescription();
                let key = ns_string!("NSScreenNumber");
                if let Some(num) = desc.objectForKey(key) {
                    // num: NSNumber → unsignedIntValue.
                    let sid: u32 = msg_send![&*num, unsignedIntValue];
                    if sid == display_id {
                        // Dùng screen.visibleFrame() để lấy toàn bộ frame màn
                        // hình bao gồm cả vùng menu bar (frame() của NSScreen
                        // bao gồm menu bar, visibleFrame() loại trừ nó — ta
                        // cần frame() để overlay phủ kín cả menu bar).
                        let frame = screen.frame();
                        let _: () = msg_send![ns_win, setFrame: frame, display: true];
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn configure_overlay_ns_window_main_thread(_win: &tauri::WebviewWindow, _display_id: u32) {}

fn url(win: &str) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?win={win}").into())
}

/// Đặt cửa sổ ở giữa-đáy màn hình chính (cho capture bar).
fn place_bottom_center(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let m_size = monitor.size();
        let m_pos = monitor.position();
        let scale = monitor.scale_factor();
        if let Ok(win_size) = win.outer_size() {
            let x = m_pos.x + ((m_size.width as i32 - win_size.width as i32) / 2);
            let y = m_pos.y + m_size.height as i32
                - win_size.height as i32
                - (64.0 * scale) as i32;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Capture bar kiểu macOS Cmd+Shift+5 — nổi, không viền, trong suốt.
pub fn open_capture_bar(app: &AppHandle) -> Result<(), String> {
    // macOS: hiển thị icon trên Dock khi capture bar visible
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    if let Some(win) = app.get_webview_window("capture-bar") {
        let _ = win.show();
        let _ = win.set_focus();
        // Windows: hiển thị icon trên taskbar khi capture bar visible
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(false);
        place_bottom_center(&win);
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "capture-bar", url("capture-bar"))
        .title("SnapDoc")
        .inner_size(660.0, 280.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(false)  // Windows: hiển thị icon trên taskbar
        // Windows: tắt DWM drop-shadow trên cửa sổ transparent/borderless.
        // macOS không bị ảnh hưởng bởi flag này.
        .shadow(false)
        .build()
        .map_err(|e| format!("Không tạo được capture bar: {e}"))?;
    place_bottom_center(&win);
    let _ = win.set_focus();
    Ok(())
}


/// Bảng điều khiển chụp cuộn (scrolling capture).
pub fn open_scroll_control(
    app: &AppHandle,
    mx: i32,
    my: i32,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("scroll-control") {
        let _ = win.close();
    }
    if let Some(win) = app.get_webview_window("scroll-border") {
        let _ = win.close();
    }

    let m = crate::capture::monitor::at_point(mx, my)?;
    let m_x = m.x().map_err(|e| e.to_string())? as f64;
    let m_y = m.y().map_err(|e| e.to_string())? as f64;
    let scale = m.scale_factor().unwrap_or(1.0).max(1.0) as f64;

    // Chuyển toạ độ vùng chụp sang logical points để định vị cửa sổ
    #[cfg(target_os = "windows")]
    let (lx, ly, lw, lh) = (
        rx as f64 / scale,
        ry as f64 / scale,
        rw as f64 / scale,
        rh as f64 / scale,
    );
    #[cfg(not(target_os = "windows"))]
    let (lx, ly, lw, lh) = (
        rx as f64,
        ry as f64,
        rw as f64,
        rh as f64,
    );

    let global_x = m_x + lx;
    let global_y = m_y + ly;

    // 1. Mở cửa sổ khung viền nét đứt bao quanh vùng chọn (kích thước lớn hơn vùng chọn 12px)
    let border_win = WebviewWindowBuilder::new(
        app,
        "scroll-border",
        WebviewUrl::App("index.html?win=scroll-border".into()),
    )
    .title("SnapDoc — Scroll Border")
    .inner_size(lw + 12.0, lh + 12.0)
    .position(global_x - 6.0, global_y - 6.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .build()
    .map_err(|e| format!("Không tạo được khung viền scroll: {e}"))?;

    // Đặt click-through để chuột nhấn xuyên qua được viền
    let _ = border_win.set_ignore_cursor_events(true);
    // Loại khung viền khỏi ảnh chụp (SCK trên macOS / WGC trên Windows bỏ qua
    // cửa sổ content-protected) — tránh viền nét đứt lọt vào lát cắt khi nó
    // nằm đè lên vùng đang cuộn.
    let _ = border_win.set_content_protected(true);

    // 2. Tính toán vị trí bảng điều khiển. Ưu tiên đặt NGOÀI vùng chọn bên phải;
    //    nếu không đủ chỗ thì bên trái; nếu vùng chọn chiếm hết (cả hai bên đều
    //    không đủ) thì đặt TRONG vùng chọn, luôn SÁT MÉP PHẢI. Panel đã được
    //    content-protect nên không lọt vào ảnh chụp dù nằm đè lên vùng cuộn.
    let ctrl_w = 260.0;
    let ctrl_h = 420.0;
    let margin = 8.0;

    let m_w = m.width().map_err(|e| e.to_string())? as f64 / scale;
    let m_h = m.height().map_err(|e| e.to_string())? as f64 / scale;

    let right_outside = global_x + lw + margin;
    let left_outside = global_x - ctrl_w - margin;

    let mut ctrl_x = if right_outside + ctrl_w <= m_x + m_w {
        // Đủ chỗ bên phải, ngoài vùng chọn.
        right_outside
    } else if left_outside >= m_x {
        // Đủ chỗ bên trái, ngoài vùng chọn.
        left_outside
    } else {
        // Vùng chọn chiếm hết -> nằm trong vùng chọn, sát cạnh phải.
        global_x + lw - ctrl_w - margin
    };
    let mut ctrl_y = global_y;

    // Giữ trong biên màn hình (chốt an toàn).
    ctrl_x = ctrl_x.max(m_x + margin).min(m_x + m_w - ctrl_w - margin);
    ctrl_y = ctrl_y.max(m_y + margin).min(m_y + m_h - ctrl_h - margin);

    let url_str = format!("scroll-control&mx={mx}&my={my}&rx={rx}&ry={ry}&rw={rw}&rh={rh}");
    let control_win = WebviewWindowBuilder::new(app, "scroll-control", url(&url_str))
        .title("SnapDoc — Scrolling Capture")
        .inner_size(ctrl_w, ctrl_h)
        .position(ctrl_x, ctrl_y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
        .map_err(|e| format!("Không tạo được bảng điều khiển chụp cuộn: {e}"))?;

    // Bảng điều khiển (có khung preview) cũng phải bị loại khỏi ảnh chụp: khi
    // vùng chọn rộng và panel buộc phải đặt đè lên vùng đang cuộn, nó sẽ không
    // lọt vào lát cắt.
    let _ = control_win.set_content_protected(true);

    let _ = control_win.set_focus();
    Ok(())
}

/// Mở capture bar và emit event `set-capture-mode` với lastMode từ Rust state.
/// Chỉ sync chế độ chụp (mode), KHÔNG override output — capture bar tự giữ
/// defaultOutput từ settings. Dùng cho nút "New" trong editor.
pub fn open_capture_bar_with_last_mode(app: &AppHandle) -> Result<(), String> {
    use crate::state::AppState;

    let (mode, _output) = app.state::<AppState>().last_capture.get();
    let is_new_window = app.get_webview_window("capture-bar").is_none();

    open_capture_bar(app)?;

    // Với window đã tồn tại: listener JS đã active → delay ngắn.
    // Với window mới: cần đợi React mount + register listener → delay dài hơn.
    // Chỉ emit mode, không emit output → capture bar tự load defaultOutput từ settings.
    // Dùng async_runtime (Tokio) để emit an toàn từ async context.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let first_delay = if is_new_window { 400 } else { 80 };
        tokio::time::sleep(std::time::Duration::from_millis(first_delay)).await;
        if let Some(win) = app.get_webview_window("capture-bar") {
            let payload = serde_json::json!({ "mode": mode, "output": serde_json::Value::Null });
            let _ = win.emit("set-capture-mode", payload.clone());
            // Emit lần 2 cho window mới (đảm bảo listener đã mount)
            if is_new_window {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if let Some(win2) = app.get_webview_window("capture-bar") {
                    let _ = win2.emit("set-capture-mode", payload);
                }
            }
        }
    });

    Ok(())
}

/// Mở overlay trên TẤT CẢ màn hình (mỗi màn một cái). `mode` =
/// "region" | "window" | "monitor". Input do `input_loop` xử lý qua con trỏ +
/// nút chuột toàn cục (không cần focus) → không nháy, độ trễ chuyển màn = 0.
///
/// Toạ độ dùng hệ NHẤT QUÁN: trên macOS là POINTS (CGDisplayBounds/xcap) —
/// vì `Tauri::Monitor::position()` (physical = points×scale-riêng) KHÔNG nhất
/// quán giữa các màn khác scale. Định vị overlay trên macOS qua `NSScreen.frame`
/// (native, chính xác); các OS khác dùng set_position/set_size physical.
pub fn open_overlays(app: &AppHandle, mode: &str) -> Result<(), String> {
    close_overlays(app);

    // Snapshot từ xcap: trên macOS = POINTS (CGDisplayBounds) + CGDirectDisplayID;
    // trên Windows/Linux = physical pixels.
    let xmons = xcap::Monitor::all().map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    if xmons.is_empty() {
        return Err("Không tìm thấy màn hình nào".to_string());
    }
    let snaps: Vec<MonitorSnap> = xmons
        .iter()
        .map(|m| MonitorSnap {
            id: m.id().unwrap_or(0),
            x: m.x().unwrap_or(0) as f64,
            y: m.y().unwrap_or(0) as f64,
            w: m.width().unwrap_or(0) as f64,
            h: m.height().unwrap_or(0) as f64,
            scale: m.scale_factor().unwrap_or(1.0).max(1.0) as f64,
        })
        .collect();

    if let Ok(mut g) = app.state::<AppState>().overlay_monitors.lock() {
        *g = snaps.clone();
    }

    // Màn hình đang có con trỏ (toạ độ cùng hệ với snapshot).
    let cursor_idx = {
        #[cfg(target_os = "macos")]
        {
            cursor_points()
                .and_then(|(x, y)| snap_index_at(&snaps, x, y))
                .unwrap_or(0)
        }
        #[cfg(not(target_os = "macos"))]
        {
            app.cursor_position()
                .ok()
                .and_then(|p| snap_index_at(&snaps, p.x, p.y))
                .unwrap_or(0)
        }
    };

    for (i, snap) in snaps.iter().enumerate() {
        let label = format!("overlay-{i}");
        let win = WebviewWindowBuilder::new(
            app,
            &label,
            // scale: cần cho mode "quick" (Chụp nhanh) để canvas chú thích render
            // đúng độ phân giải vật lý; các mode khác bỏ qua tham số này.
            WebviewUrl::App(
                format!("index.html?win=overlay&mode={mode}&idx={i}&scale={}", snap.scale).into(),
            ),
        )
        .title("SnapDoc")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        // Windows: tắt DWM drop-shadow để set_position khớp chính xác pixel
        // gốc màn hình. Shadow DWM làm nội dung lệch phải/xuống một khoảng
        // bằng shadow margin (~8 px ở 100% DPI, tự scale theo DPI).
        .shadow(false)
        .build()
        .map_err(|e| format!("Không tạo được overlay: {e}"))?;

        let _ = win.set_content_protected(true);

        #[cfg(target_os = "macos")]
        {
            // Đặt frame qua NSScreen (points, native) trên main thread.
            let win_main = win.clone();
            let did = snap.id;
            let _ = app.run_on_main_thread(move || {
                configure_overlay_ns_window_main_thread(&win_main, did);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Windows/Linux: snapshot ở physical pixels → đặt trực tiếp.
            let _ = win.set_position(PhysicalPosition::new(snap.x as i32, snap.y as i32));
            let _ = win.set_size(PhysicalSize::new(snap.w as u32, snap.h as u32));
        }

        let _ = win.show();

        #[cfg(target_os = "macos")]
        {
            // Lặp lại setFrame SAU show: NSWindow borderless đôi khi chỉ áp
            // đúng frame sau khi đã order-front.
            let win_main = win.clone();
            let did = snap.id;
            let _ = app.run_on_main_thread(move || {
                configure_overlay_ns_window_main_thread(&win_main, did);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Windows: áp lại SAU show. Khi set_position chuyển cửa sổ sang màn
            // đích khác DPI, Windows gửi WM_DPICHANGED và tự rescale kích thước →
            // lần set trước show có thể bị ghi đè/bỏ qua. Đặt position TRƯỚC (để
            // DPI ổn định ở màn đích) rồi set_size để phủ trọn vẹn toàn màn hình.
            let _ = win.set_position(PhysicalPosition::new(snap.x as i32, snap.y as i32));
            let _ = win.set_size(PhysicalSize::new(snap.w as u32, snap.h as u32));
        }

        if i == cursor_idx {
            let _ = win.set_focus();
        }
    }

    let gen = app
        .state::<AppState>()
        .overlay_gen
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let handle = app.clone();

    std::thread::spawn(move || {
        input_loop(handle, gen, cursor_idx);
    });

    Ok(())
}

fn snap_index_at(snaps: &[MonitorSnap], x: f64, y: f64) -> Option<usize> {
    snaps
        .iter()
        .position(|s| x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h)
}

/// Đọc con trỏ trong CÙNG hệ với snapshot. macOS = POINTS (CGEvent);
/// OS khác = physical pixels (Tauri).
fn read_cursor(app: &AppHandle) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        cursor_points()
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.cursor_position().ok().map(|p| (p.x, p.y))
    }
}

/// Đổi toạ độ con trỏ (hệ snapshot) sang CSS px tương đối gốc overlay.
/// macOS: snapshot ở points = CSS px → trừ gốc là xong. OS khác: physical →
/// chia thêm scale.
fn to_css(s: &MonitorSnap, cx: f64, cy: f64) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        (cx - s.x, cy - s.y)
    }
    #[cfg(not(target_os = "macos"))]
    {
        ((cx - s.x) / s.scale, (cy - s.y) / s.scale)
    }
}

/// Luồng input: poll con trỏ + nút chuột toàn cục, phát sự kiện cho overlay.
/// - `overlay-input` (idx_active, x, y): con trỏ đang ở overlay nào + toạ độ CSS.
/// - `overlay-press` / `overlay-release` (idx, x, y): cạnh nhấn/thả chuột trái.
/// Phải/Esc → huỷ. Dừng khi sang phiên mới hoặc overlay đã đóng.
fn input_loop(app: AppHandle, gen: u64, initial_idx: usize) {
    let mut prev_left = crate::input::left_down();
    let mut prev_right = crate::input::right_down();
    let mut prev_esc = crate::input::escape_down();
    let mut focused_idx: Option<usize> = Some(initial_idx);
    let mut drag_idx: Option<usize> = None;

    loop {
        if app.state::<AppState>().overlay_gen.load(Ordering::SeqCst) != gen {
            break;
        }
        if !app
            .webview_windows()
            .keys()
            .any(|l| l.starts_with("overlay"))
        {
            break;
        }

        // Dùng snapshot lưu trong AppState để chỉ số khớp 1-1 với label
        // `overlay-{i}` đã tạo ở open_overlays. Không gọi lại
        // available_monitors() — tránh khác thứ tự giữa các lần gọi.
        let snaps: Vec<MonitorSnap> = match app.state::<AppState>().overlay_monitors.lock() {
            Ok(g) => g.clone(),
            Err(_) => break,
        };
        if snaps.is_empty() {
            break;
        }

        let left = crate::input::left_down();
        if let Some((cx, cy)) = read_cursor(&app) {
            let hit = snap_index_at(&snaps, cx, cy);

            if let Some(i) = hit {
                let s = &snaps[i];
                let (x, y) = to_css(s, cx, cy);

                if !left && focused_idx != Some(i) {
                    if let Some(win) = app.get_webview_window(&format!("overlay-{i}")) {
                        let _ = win.set_focus();
                    }
                    focused_idx = Some(i);
                }

                // Khi đang drag, mọi input/release route về overlay bắt đầu
                // drag để không "rớt" sang overlay khác giữa chừng — kể cả
                // khi con trỏ vượt biên màn hình.
                let target_idx = drag_idx.unwrap_or(i);
                let _ = app.emit("overlay-input", (target_idx, x, y));
                if left && !prev_left {
                    drag_idx = Some(i);
                    let _ = app.emit("overlay-press", (i, x, y));
                }
                if !left && prev_left {
                    let release_idx = drag_idx.take().unwrap_or(i);
                    // Nếu thả ở overlay khác, đổi hệ trục về snapshot nguồn.
                    let (rx, ry) = if release_idx != i {
                        to_css(&snaps[release_idx], cx, cy)
                    } else {
                        (x, y)
                    };
                    let _ = app.emit("overlay-release", (release_idx, rx, ry));
                    // Focus overlay vừa thả chuột để phím tắt công cụ hoạt động ngay.
                    if let Some(win) = app.get_webview_window(&format!("overlay-{release_idx}")) {
                        let _ = win.set_focus();
                    }
                    focused_idx = Some(release_idx);
                }
            } else if !left && prev_left {
                if let Some(src_idx) = drag_idx.take() {
                    let (rx, ry) = to_css(&snaps[src_idx], cx, cy);
                    let _ = app.emit("overlay-release", (src_idx, rx, ry));
                }
            }
        }
        prev_left = left;

        let right = crate::input::right_down();
        let esc = crate::input::escape_down();
        if (right && !prev_right) || (esc && !prev_esc) {
            close_overlays(&app);
            break;
        }
        prev_right = right;
        prev_esc = esc;

        std::thread::sleep(Duration::from_millis(8));
    }
}

/// Đóng toàn bộ overlay (mọi màn hình).
///
/// QUAN TRỌNG: KHÔNG poll app.webview_windows() sau win.close() trên Windows.
/// win.close() gửi WM_CLOSE async — cần main thread message pump xử lý.
/// Nếu gọi từ std::thread đang được Tokio IPC thread chờ (rx.recv()), main
/// thread có thể bị stall → polling không bao giờ thấy overlay biến mất →
/// deadlock → Windows báo AppHang sau ~5 giây.
///
/// Giải pháp: gửi close rồi return ngay. Sleep cố định 150ms trong
/// finalize_window/finalize_region để DWM có thời gian unregister protected
/// surface — không cần xác nhận overlay đã đóng hẳn.
pub fn close_overlays(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay") {
            let _ = win.close();
        }
    }
    // KHÔNG poll ở đây — xem comment trên.
}

/// Ẩn editor và trả về Accessory policy (ẩn Dock) / ẩn icon khỏi taskbar (Windows).
/// Dùng cho nút "New" trong editor — user muốn chụp mới mà không cần đóng editor.
pub fn hide_editor(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("editor") {
        let _ = win.hide();
        // Windows: ẩn icon khỏi taskbar khi editor bị ẩn
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(true);
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }
}

/// Tạo sẵn editor (ẩn) lúc khởi động để lần chụp đầu hiện ngay, không phải
/// chờ tạo webview + nạp Konva.
pub fn prewarm_editor(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("editor").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "editor", url("editor"))
        .title("SnapDoc — Editor")
        .inner_size(1040.0, 720.0)
        .min_inner_size(680.0, 480.0)
        .resizable(true)
        .center()
        .visible(false)
        .skip_taskbar(true)  // Ẩn icon khỏi taskbar lúc khởi động
        .build()
        .map_err(|e| format!("Không tạo được editor: {e}"))?;
    Ok(())
}

/// Editor chú thích.
pub fn open_editor(app: &AppHandle) -> Result<(), String> {
    // macOS: chuyển về Regular khi editor hiển thị → icon xuất hiện trên Dock,
    // cmd+Tab hoạt động, app có titlebar menu chuẩn.
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    if let Some(win) = app.get_webview_window("editor") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // Windows: hiển thị icon trên taskbar khi editor visible
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(false);
        // Trên Windows, show() là async (WM_SHOWWINDOW qua message pump).
        // Emit refresh-capture sau một tick để đảm bảo webview visible và
        // JS message pump đang chạy trước khi nhận event.
        // Dùng async_runtime::spawn (Tokio) thay vì std::thread để tránh
        // gọi Tauri IPC từ thread không có context phù hợp.
        let win2 = win.clone();
        tauri::async_runtime::spawn(async move {
            #[cfg(target_os = "windows")]
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = win2.emit("refresh-capture", ());
        });
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let win = WebviewWindowBuilder::new(app, "editor", url("editor"))
            .title("SnapDoc — Editor")
            .inner_size(1040.0, 720.0)
            .min_inner_size(680.0, 480.0)
            .resizable(true)
            .center()
            .skip_taskbar(false)  // Windows: hiển thị icon trên taskbar
            .build()
            .map_err(|e| format!("Không tạo được editor: {e}"))?;
        
        let win2 = win.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = win2.emit("refresh-capture", ());
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _win = WebviewWindowBuilder::new(app, "editor", url("editor"))
            .title("SnapDoc — Editor")
            .inner_size(1040.0, 720.0)
            .min_inner_size(680.0, 480.0)
            .resizable(true)
            .center()
            .skip_taskbar(false)
            .build()
            .map_err(|e| format!("Không tạo được editor: {e}"))?;
    }
    Ok(())
}

/// macOS: mở MỘT cửa sổ editor mới cho mỗi ảnh "Open with" → xem/chỉnh nhiều
/// ảnh cùng lúc. Mỗi cửa sổ có label `editor-ow-N` riêng; data URL ảnh được lưu
/// trong AppState theo label và cửa sổ tự kéo qua `take_open_file` lúc mount
/// (pull → không race timing, không lẫn ảnh giữa các cửa sổ).
#[cfg(target_os = "macos")]
pub fn open_editor_with_file(app: &AppHandle, data_url: String) -> Result<(), String> {
    use tauri::ActivationPolicy;
    // Hiện Dock + cmd+Tab cho cửa sổ editor "thật".
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    let n = app
        .state::<AppState>()
        .editor_seq
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let label = format!("editor-ow-{n}");
    eprintln!("[SnapDoc] Open with → tạo cửa sổ editor mới: {label}");

    if let Ok(mut g) = app.state::<AppState>().open_files.lock() {
        g.insert(label.clone(), data_url);
    }

    let win = WebviewWindowBuilder::new(app, &label, url("editor"))
        .title("SnapDoc — Editor")
        .inner_size(1040.0, 720.0)
        .min_inner_size(680.0, 480.0)
        .resizable(true)
        .center()
        .skip_taskbar(false)  // Windows: hiển thị icon trên taskbar
        .build()
        .map_err(|e| format!("Không tạo được editor: {e}"))?;

    // Cascade: lệch mỗi cửa sổ một chút để không chồng khít lên nhau → người
    // dùng thấy rõ nhiều ảnh đang mở thay vì tưởng ảnh trước bị thay.
    if n > 1 {
        if let Ok(pos) = win.outer_position() {
            let off = (((n - 1) % 8) as i32) * 32;
            let _ = win.set_position(PhysicalPosition::new(pos.x + off, pos.y + off));
        }
    }
    let _ = win.set_focus();
    Ok(())
}

/// Trả về Accessory policy (ẩn Dock) trên macOS hoặc ẩn taskbar icon trên Windows
/// nếu không còn cửa sổ editor/settings/capture-bar nào đang mở.
/// Gọi từ on_window_event khi editor/settings/capture-bar bị đóng.
pub fn on_editor_closed(app: &AppHandle) {
    // Kiểm tra còn cửa sổ "thật" nào đang mở không (editor, settings, capture-bar).
    // Không tính overlay, thumbnail, scroll-control vì chúng tạm thời/phụ trợ.
    let has_visible = app.webview_windows().values().any(|w| {
        let label = w.label();
        (label.starts_with("editor") || label == "settings" || label == "capture-bar")
            && w.is_visible().unwrap_or(false)
    });

    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        if !has_visible {
            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: ẩn icon trên taskbar nếu không còn cửa sổ "thật" nào mở
        if !has_visible {
            for (label, win) in app.webview_windows() {
                if label.starts_with("editor") || label == "settings" || label == "capture-bar" {
                    let _ = win.set_skip_taskbar(true);
                }
            }
        }
    }
}


/// Thumbnail nổi góc dưới-phải sau khi chụp.
/// Dùng pre-warmed window: chỉ emit data + show/reposition thay vì tạo mới.
pub fn open_thumbnail(app: &AppHandle) -> Result<(), String> {
    // Lấy data từ pending để truyền thẳng qua event (tránh IPC roundtrip từ JS).
    let base64 = {
        use crate::state::AppState;
        app.state::<AppState>()
            .pending
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| p.base64.clone()))
            .unwrap_or_default()
    };

    let win = if let Some(w) = app.get_webview_window("thumbnail") {
        w
    } else {
        // Fallback: pre-warm chưa chạy (không nên xảy ra khi runtime bình thường).
        create_thumbnail_window(app)?
    };

    // Đặt vị trí góc dưới-phải trước khi show để tránh flash ở vị trí cũ.
    place_thumbnail(&win);

    // QUAN TRỌNG: show() TRƯỚC emit() trên Windows.
    // WebView2 suspend JavaScript execution khi window hidden → event bị drop
    // nếu emit trước show. Show window trước, đợi WebView2 resume, rồi mới emit.
    let _ = win.show();
    let _ = win.set_always_on_top(true);

    // Trên Windows: đợi WebView2 resume JS sau khi window visible.
    // Emit ngay sau show() có thể vẫn bị drop trong ~1 frame đầu.
    let win2 = win.clone();
    let b64 = base64;
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        std::thread::sleep(std::time::Duration::from_millis(50));
        let _ = win2.emit("show-thumbnail", &b64);
    });

    Ok(())
}

fn create_thumbnail_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    WebviewWindowBuilder::new(app, "thumbnail", url("thumbnail"))
        .title("SnapDoc")
        .inner_size(300.0, 210.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| format!("Không tạo được thumbnail: {e}"))
}

fn place_thumbnail(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let m_size = monitor.size();
        let m_pos = monitor.position();
        let scale = monitor.scale_factor();
        if let Ok(win_size) = win.outer_size() {
            let margin = (24.0 * scale) as i32;
            let x = m_pos.x + m_size.width as i32 - win_size.width as i32 - margin;
            let y = m_pos.y + m_size.height as i32 - win_size.height as i32 - margin;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Pre-warm thumbnail window ẩn lúc khởi động.
/// Khi open_thumbnail được gọi, chỉ cần emit event + show — không tạo webview mới.
pub fn prewarm_thumbnail(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("thumbnail").is_some() {
        return Ok(());
    }
    create_thumbnail_window(app)?;
    Ok(())
}

/// macOS: gọi makeKeyAndOrderFront + NSApp.activate trên main thread để
/// cửa sổ settings luôn nổi lên trước mọi app khác.
#[cfg(target_os = "macos")]
fn bring_settings_to_front(app: &AppHandle, win: tauri::WebviewWindow) {
    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        use objc2::msg_send;
        use objc2_app_kit::NSApplication;
        use objc2_foundation::MainThreadMarker;

        // activate app trước (ignoringOtherApps: true) để macOS cho phép
        // cửa sổ lên front ngay cả khi app đang ở background.
        if let Some(mtm) = MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(mtm);
            let _: () = unsafe { msg_send![&*ns_app, activateIgnoringOtherApps: true] };
        }

        // makeKeyAndOrderFront: nil → bring window to front & make key window.
        if let Ok(ptr) = win.ns_window() {
            let ns_win = ptr as *mut objc2_app_kit::NSWindow;
            if !ns_win.is_null() {
                unsafe {
                    let _: () = msg_send![&*ns_win, makeKeyAndOrderFront: Option::<&objc2::runtime::AnyObject>::None];
                }
            }
        }
    });
}

/// Settings.
pub fn open_settings(app: &AppHandle) -> Result<(), String> {    // macOS: chuyển về Regular để icon hiện trên Dock và Cmd+Tab hoạt động.
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        // Windows: hiển thị icon trên taskbar khi settings visible
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(false);
        #[cfg(target_os = "macos")]
        bring_settings_to_front(app, win);
        #[cfg(not(target_os = "macos"))]
        let _ = win.set_focus();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "settings", url("settings"))
        .title("SnapDoc — Cài đặt")
        .inner_size(560.0, 700.0)
        .min_inner_size(560.0, 400.0)
        .max_inner_size(560.0, 10000.0)  // khóa chiều ngang = 560, chỉ resize dọc
        .resizable(true)
        .center()
        .skip_taskbar(false)  // Windows: hiển thị icon trên taskbar
        .build()
        .map_err(|e| format!("Không tạo được settings: {e}"))?;
    #[cfg(target_os = "macos")]
    bring_settings_to_front(app, win);
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_focus();
    Ok(())
}
