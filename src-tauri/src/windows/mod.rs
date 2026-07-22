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

        // Tắt animation mặc định của AppKit khi order-front/order-out
        // (NSWindowAnimationBehaviorNone = 2). Không set thì macOS tự áp 1
        // hiệu ứng zoom/fade nhẹ mỗi lần window lần đầu hiện ra — với overlay
        // chứa ảnh freeze, hiệu ứng đó lộ ra như ảnh freeze bị "zoom" lúc mở.
        // An toàn gọi lại nhiều lần (trước và sau show()).
        let no_animation: i64 = 2;
        let _: () = msg_send![ns_win, setAnimationBehavior: no_animation];

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

/// macOS: PID của app đang frontmost NGAY LÚC GỌI, CHỈ KHI đó KHÔNG phải
/// chính SnapDoc — dùng để trả lại focus cho app đó sau khi Chụp nhanh
/// copy/save/hủy xong, tránh kéo các cửa sổ ẩn của SnapDoc lên trước (xem
/// `AppState::restore_front_pid`). `None` nếu SnapDoc đang frontmost (người
/// dùng chủ động ở trong app) hoặc không đọc được. Đọc `NSWorkspace` trên
/// main thread cho an toàn (chạy đồng bộ qua channel, có timeout).
#[cfg(target_os = "macos")]
pub fn frontmost_other_app_pid(app: &AppHandle) -> Option<i32> {
    use objc2::{class, msg_send, runtime::AnyObject};
    let ours = std::process::id() as i32;
    let (tx, rx) = std::sync::mpsc::channel::<Option<i32>>();
    if app
        .run_on_main_thread(move || {
            let pid = unsafe {
                let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
                if ws.is_null() {
                    None
                } else {
                    let front: *mut AnyObject = msg_send![ws, frontmostApplication];
                    if front.is_null() {
                        None
                    } else {
                        let pid: i32 = msg_send![front, processIdentifier];
                        if pid > 0 && pid != ours { Some(pid) } else { None }
                    }
                }
            };
            let _ = tx.send(pid);
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(std::time::Duration::from_millis(300)).ok().flatten()
}

/// macOS: đưa app có `pid` trở lại frontmost (nếu còn chạy) — SnapDoc mất
/// frontmost nên các cửa sổ vừa bị `set_focus` overlay kéo lên sẽ chìm lại
/// phía sau. No-op nếu app đó đã thoát. Xem `frontmost_other_app_pid`.
#[cfg(target_os = "macos")]
pub fn reactivate_app_pid(app: &AppHandle, pid: i32) {
    use objc2::{class, msg_send, runtime::AnyObject};
    let _ = app.run_on_main_thread(move || unsafe {
        let running: *mut AnyObject =
            msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if !running.is_null() {
            // options = 0: chỉ đưa app lên frontmost, không ép mọi cửa sổ của
            // nó lên (NSApplicationActivateAllWindows).
            let _: bool = msg_send![running, activateWithOptions: 0usize];
        }
    });
}

fn url(win: &str) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?win={win}").into())
}

/// Như `url` nhưng kèm query string riêng — dùng cho `history-trim` truyền
/// `id` của item History cần cắt (đọc lại ở `HistoryTrim.tsx` qua
/// `URLSearchParams`, KHÔNG qua AppState — đơn giản hơn hẳn cho 1 giá trị
/// đọc 1 lần lúc mount, không cần dọn dẹp state như `PendingRecordingState`).
fn url_with_query(win: &str, query: &str) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?win={win}&{query}").into())
}

/// Vùng (x, y, width, height) theo LOGICAL/points của màn hình đang chứa con
/// trỏ chuột. Dùng để mở cửa sổ (capture bar, thumbnail, recording
/// indicator, và cả Editor/History/Settings/RecordReview/HistoryTrim) đúng
/// màn hình user đang nhìn vào lúc bấm mở, thay vì luôn mở ở màn hình chính.
/// Chỉ cần `app` (không cần cửa sổ đã tồn tại) — fallback về
/// `app.primary_monitor()` (hành vi cũ) nếu không đọc được con trỏ hoặc
/// không xác định được màn hình chứa nó, nên dùng được cả TRƯỚC khi tạo cửa
/// sổ (ví dụ để tính kích thước theo % màn hình đích, xem `open_record_review`).
///
/// LUÔN trả LOGICAL, KHÔNG physical — lý do (bug đã tái hiện thực tế): trên
/// macOS, `win.set_position(Position::Physical(..))` (`tao`'s
/// `set_outer_position`) quy đổi physical→logical bằng **scale hiện tại của
/// cửa sổ TRƯỚC khi di chuyển**, không phải scale màn hình ĐÍCH. Nếu cửa sổ
/// đang ở màn Retina (scale 2) và ta tính toạ độ physical theo màn đích scale
/// 1 (FullHD), `tao` sẽ chia lại theo scale 2 (sai) khi áp dụng → lệch nửa
/// khoảng cách thật (đúng hiện tượng "FullHD lệch phải, Retina thì đúng" đã
/// gặp). Dùng `Position::Logical` bỏ HẲN bước quy đổi này — giá trị Logical
/// chỉ được cast, không bị chia lại theo bất kỳ scale nào — an toàn tuyệt
/// đối bất kể cửa sổ đang ở màn nào lúc gọi.
fn cursor_or_primary_monitor_logical_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    if let Some((cx, cy)) = read_cursor(app) {
        if let Ok(m) = crate::capture::monitor::at_point(cx as i32, cy as i32) {
            // xcap trả x/y/width/height theo POINTS trên macOS (đã là logical,
            // dùng thẳng) hoặc physical px trên Windows (chia scale để ra logical).
            #[cfg(target_os = "macos")]
            let rect = (
                m.x().unwrap_or(0) as f64,
                m.y().unwrap_or(0) as f64,
                m.width().unwrap_or(0) as f64,
                m.height().unwrap_or(0) as f64,
            );
            #[cfg(not(target_os = "macos"))]
            let rect = {
                let scale = (m.scale_factor().unwrap_or(1.0).max(1.0)) as f64;
                (
                    m.x().unwrap_or(0) as f64 / scale,
                    m.y().unwrap_or(0) as f64 / scale,
                    m.width().unwrap_or(0) as f64 / scale,
                    m.height().unwrap_or(0) as f64 / scale,
                )
            };
            return Some(rect);
        }
    }
    let pm = app.primary_monitor().ok().flatten()?;
    let scale = pm.scale_factor() as f64;
    Some((
        pm.position().x as f64 / scale,
        pm.position().y as f64 / scale,
        pm.size().width as f64 / scale,
        pm.size().height as f64 / scale,
    ))
}

/// Kích thước NGOÀI cửa sổ hiện tại theo LOGICAL — dùng cùng
/// `cursor_or_primary_monitor_logical_rect` để mọi phép tính vị trí ở CHUNG 1
/// hệ logical (tránh đúng bug quy đổi scale sai giải thích ở đó). Scale dùng
/// ở đây là scale HIỆN TẠI của cửa sổ (trước khi di chuyển) — chính xác cho
/// mục đích này vì chỉ dùng để đổi `outer_size()` (physical) → logical, không
/// liên quan gì đến scale của màn hình ĐÍCH.
fn logical_outer_size(win: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let size = win.outer_size().ok()?;
    let scale = win.scale_factor().ok()?.max(0.0001);
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// Đặt cửa sổ ở giữa-đáy màn hình đang chứa con trỏ chuột (cho capture bar).
fn place_bottom_center(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Some((m_x, m_y, m_w, m_h)) = cursor_or_primary_monitor_logical_rect(app) {
        if let Some((win_w, win_h)) = logical_outer_size(win) {
            let x = m_x + (m_w - win_w) / 2.0;
            let y = m_y + m_h - win_h - 64.0;
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
    }
}

/// Đặt cửa sổ ở CHÍNH GIỮA màn hình đang chứa con trỏ chuột — dùng cho các
/// cửa sổ ứng dụng "lớn" (Editor, History, Settings, RecordReview,
/// HistoryTrim) thay cho `.center()` mặc định của Tauri (luôn là màn hình
/// chính, bất kể con trỏ đang ở đâu). Cùng kỹ thuật `place_bottom_center`.
fn place_center_on_monitor(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Some((m_x, m_y, m_w, m_h)) = cursor_or_primary_monitor_logical_rect(app) {
        if let Some((win_w, win_h)) = logical_outer_size(win) {
            let x = m_x + (m_w - win_w) / 2.0;
            let y = m_y + (m_h - win_h) / 2.0;
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
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
        // Bỏ cờ chỉ dùng trong lúc freeze trước khi khôi phục bar. Cờ này
        // được đặt lại ở lần freeze kế tiếp, nên một lần show thông thường
        // vẫn giữ nguyên transition Windows mặc định.
        #[cfg(target_os = "windows")]
        if let Ok(hwnd) = win.hwnd() {
            set_dwm_transitions_disabled(hwnd.0, false);
        }
        // .unminimize() cần cho trường hợp user vừa bấm "X" trên bar (nay chỉ
        // minimize, xem `commands::close_self`) — .show() không tự khôi phục
        // khỏi trạng thái minimize.
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        // Windows: hiển thị icon trên taskbar khi capture bar visible
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(false);
        place_bottom_center(app, &win);
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "capture-bar", url("capture-bar"))
        .title("SnapDoc")
        // 830px — bar chia 2 khu vực (chụp ảnh + quay màn hình, mỗi khu 1
        // modeGroup riêng) rộng ~798px đo qua getBoundingClientRect trong
        // preview. Cửa sổ resizable(false) + body overflow:hidden nên rộng
        // hơn nội dung thật 1 chút để không bao giờ bị cắt, kể cả khi font
        // render rộng hơn 1 chút trên Windows.
        .inner_size(730.0, 80.0)
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
    place_bottom_center(app, &win);
    let _ = win.set_focus();
    Ok(())
}

/// Minimize capture bar ngay trước khi chụp ảnh nền freeze trên Windows.
///
/// Capture bar PHẢI luôn ở taskbar, nên không được `hide()`. Thay vào đó, tắt
/// DWM transition cho RIÊNG HWND này rồi gọi trực tiếp `ShowWindow`: icon
/// taskbar vẫn tồn tại, nhưng frame cũ không chạy animation thu nhỏ để bị
/// WGC/GDI chụp vào frozen background.
#[cfg(target_os = "windows")]
pub fn minimize_capture_bar_for_freeze(app: &AppHandle) -> bool {
    let Some(win) = app.get_webview_window("capture-bar") else {
        return false;
    };
    let Ok(hwnd) = win.hwnd() else {
        return false;
    };
    let transitions_disabled = set_dwm_transitions_disabled(hwnd.0, true);
    // `WebviewWindow::minimize()` đẩy yêu cầu vào event loop của Tauri, vì thế
    // `DwmFlush` ngay sau nó vẫn có thể flush frame CŨ. Gọi ShowWindow trực
    // tiếp cho HWND cùng process giúp trạng thái iconic được áp dụng trước khi
    // đồng bộ với compositor.
    let minimized = minimize_hwnd_now(hwnd.0);
    let _ = win.set_skip_taskbar(false);
    // Chờ tới frame Present tiếp theo của DWM. Điều này ngăn backend capture
    // đọc lại frame compositor cũ, dù trạng thái minimized đã được Tauri trả
    // về ngay sau khi gửi message cho Windows.
    let compositor_flushed = flush_dwm().is_ok();
    transitions_disabled && minimized && compositor_flushed
}

/// Bật/tắt transition DWM cho một cửa sổ mà không thay đổi thiết lập animation
/// toàn hệ thống. `DWMWA_TRANSITIONS_FORCEDISABLED` nhận BOOL: TRUE để tắt,
/// FALSE để bật lại.
#[cfg(target_os = "windows")]
fn set_dwm_transitions_disabled(hwnd: windows_sys::Win32::Foundation::HWND, disabled: bool) -> bool {
    use std::ffi::c_void;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
    };

    let value: i32 = if disabled { 1 } else { 0 }; // Win32 BOOL
    // SAFETY: HWND còn sống vì WebviewWindow được caller giữ; value là BOOL hợp lệ.
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &value as *const i32 as *const c_void,
            std::mem::size_of_val(&value) as u32,
        ) >= 0
    }
}

/// Windows tương đương `NSWindowAnimationBehaviorNone` của macOS cho overlay.
/// Cờ này chỉ áp dụng cho native overlay window, không thay đổi thiết lập hiệu
/// ứng của hệ điều hành hay những cửa sổ khác của SnapDoc.
#[cfg(target_os = "windows")]
fn disable_overlay_transitions(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        let _ = set_dwm_transitions_disabled(hwnd.0, true);
    }
}

/// Minimize đồng bộ HWND rồi xác nhận Windows đã chuyển sang trạng thái iconic.
#[cfg(target_os = "windows")]
fn minimize_hwnd_now(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, ShowWindow, SW_MINIMIZE};

    // SAFETY: HWND thuộc WebviewWindow còn sống. SW_MINIMIZE giữ taskbar button,
    // khác SW_HIDE vốn làm mất app-level anchor.
    unsafe {
        let _ = ShowWindow(hwnd, SW_MINIMIZE);
        IsIconic(hwnd) != 0
    }
}

/// Chờ DWM present mọi thay đổi đang pending từ process này trước khi capture.
#[cfg(target_os = "windows")]
fn flush_dwm() -> Result<(), ()> {
    use windows_sys::Win32::Graphics::Dwm::DwmFlush;

    // SAFETY: DwmFlush không nhận pointer/handle và chỉ đồng bộ compositor.
    if unsafe { DwmFlush() } >= 0 {
        Ok(())
    } else {
        Err(())
    }
}

/// Tạo sẵn capture-bar (ẩn) NGAY lúc app khởi động — giữ icon Dock (macOS)/
/// Taskbar (Windows) hiện diện xuyên suốt vòng đời app kể từ khi mở app, thay
/// vì chỉ xuất hiện từ lần đầu user tự mở bar. Không show lên màn hình (không
/// giật mình user mỗi lần mở app) — chỉ tạo sẵn + bật Regular/skip_taskbar
/// ngay, để `open_capture_bar()` sau này chỉ cần show/focus lại đúng cửa sổ
/// này (không phải build mới). Từ đây capture-bar không bao giờ bị destroy
/// nữa (xem `commands::close_self` — bấm "X" chỉ minimize), nên `on_editor_closed`/
/// `hide_editor` đều coi sự TỒN TẠI của nó là đủ để giữ Dock/taskbar icon mãi.
pub fn prewarm_capture_bar(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("capture-bar").is_some() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }
    let win = WebviewWindowBuilder::new(app, "capture-bar", url("capture-bar"))
        .title("SnapDoc")
        .inner_size(730.0, 80.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| format!("Không tạo được capture bar: {e}"))?;
    place_bottom_center(app, &win);
    #[cfg(target_os = "windows")]
    {
        // Windows chỉ giữ icon app trên taskbar khi có cửa sổ hiện diện.
        // Prewarm theo kiểu hidden (`visible(false)`) sẽ rơi về tray-only.
        // Show rồi minimize để taskbar icon luôn tồn tại từ lúc khởi động,
        // nhưng không làm thanh capture bar nằm lộ trên màn hình.
        let _ = win.show();
        let _ = win.minimize();
        let _ = win.set_skip_taskbar(false);
    }
    Ok(())
}

/// Resize capture-bar giữ NGUYÊN cạnh đáy (bar luôn "mọc" lên trên khi mở
/// popover, xem `CaptureBar.tsx`) mà KHÔNG nháy.
///
/// macOS: gọi thẳng `NSWindow.setFrame:display:` — MỘT lệnh AppKit atomic
/// set cả kích thước lẫn vị trí cùng lúc. Khác với `set_size` + `set_position`
/// riêng lẻ của Tauri (2 lệnh OS tách rời), atomic frame không thể lộ ra 1
/// khung hình trung gian sai kích thước/vị trí giữa 2 bước — đây chính là
/// nguồn gây nháy khi resize nhanh (mở/đóng popover liên tục) dù JS đã tính
/// đúng chiều cao và đúng thứ tự gọi.
///
/// Windows: gọi thẳng Win32 `SetWindowPos` — MỘT lệnh atomic set cả size lẫn
/// position cùng lúc (tương đương `setFrame:display:` bên macOS). Windows
/// dùng gốc toạ độ TRÊN-TRÁI (khác AppKit) nên vẫn cần tự tính `y` mới để
/// giữ cạnh đáy đứng yên, nhưng việc đó + set đều gói trong 1 lệnh Win32 duy
/// nhất — không tách thành 2 lệnh (set_size rồi set_position) như Tauri.
///
/// Linux (fallback chung): không có API atomic tương đương, dùng set_size +
/// set_position của Tauri — nhưng vẫn gộp việc đo + tính + set vào 1 lệnh
/// Rust duy nhất (trước đây JS phải gọi 4 round-trip IPC riêng: innerSize/
/// outerPosition/setSize/setPosition), giảm hẳn độ trễ giữa các bước.
#[tauri::command]
pub fn resize_capture_bar(app: AppHandle, height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window("capture-bar")
        .ok_or("capture-bar không tồn tại")?;

    #[cfg(target_os = "macos")]
    {
        // #[tauri::command] đồng bộ (không async) chạy NGAY TRÊN thread nhận
        // IPC — trên macOS đó CHÍNH LÀ main thread (WKScriptMessageHandler
        // của WebKit luôn callback trên main thread, không có thread pool nào
        // ở giữa). Vì vậy gọi thẳng AppKit ở đây là AN TOÀN, không cần
        // `run_on_main_thread`.
        //
        // TRƯỚC ĐÂY code này dùng `run_on_main_thread` + channel để "chắc ăn"
        // — nhưng đó chính là BUG gây "nháy": `run_on_main_thread` chỉ ĐƯA
        // closure vào hàng đợi của main thread rồi trả về ngay (không tự
        // chạy), trong khi ta đang ĐỨNG NGAY TRÊN main thread và tự chặn nó
        // bằng `rx.recv_timeout` — closure không bao giờ được xử lý cho tới
        // khi hàm này return (giải phóng main thread), nên lúc nào cũng phải
        // đợi hết timeout (500ms) mới "release" được: bar bị kẹt ở kích thước
        // cũ suốt 500ms rồi mới "nháy" snap về đúng kích thước — deadlock tự
        // gây ra, không phải do AppKit hay do JS.
        resize_capture_bar_ns_window_main_thread(&win, height);
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        resize_capture_bar_win32(&win, height)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let current_size = win.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let current_position = win.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
        let height_delta = height - current_size.height;
        win
            .set_size(tauri::LogicalSize::new(current_size.width, height))
            .map_err(|e| e.to_string())?;
        if height_delta.abs() > 0.5 {
            win
                .set_position(tauri::LogicalPosition::new(
                    current_position.x,
                    current_position.y - height_delta,
                ))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// SAFETY: BẮT BUỘC chạy trên main thread — được đảm bảo bởi caller duy nhất
/// (`resize_capture_bar`, một `#[tauri::command]` đồng bộ, luôn chạy ngay
/// trên thread nhận IPC — main thread trên macOS).
#[cfg(target_os = "macos")]
fn resize_capture_bar_ns_window_main_thread(win: &tauri::WebviewWindow, height: f64) {
    let ptr = match win.ns_window() {
        Ok(p) => p as *mut objc2_app_kit::NSWindow,
        Err(_) => return,
    };
    if ptr.is_null() {
        return;
    }
    // SAFETY: con trỏ NSWindow do Tauri giữ, còn sống trong scope.
    unsafe {
        let ns_win: &objc2_app_kit::NSWindow = &*ptr;
        let mut frame = ns_win.frame();
        // AppKit: origin là góc DƯỚI-TRÁI của màn hình → giữ nguyên origin,
        // chỉ đổi height là cửa sổ tự "mọc" lên TRÊN (đáy đứng yên), không
        // cần tính bù vị trí thủ công như set_size/set_position riêng lẻ.
        frame.size.height = height;
        ns_win.setFrame_display(frame, true);
    }
}

/// `height` (logic/CSS px, từ `getBoundingClientRect` bên JS) được quy đổi
/// sang PHYSICAL px qua `scale_factor()` vì `GetWindowRect`/`SetWindowPos`
/// của Win32 luôn làm việc ở physical px (app Tauri per-monitor-DPI-aware).
#[cfg(target_os = "windows")]
fn resize_capture_bar_win32(win: &tauri::WebviewWindow, height: f64) -> Result<(), String> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

    let hwnd = win.hwnd().map_err(|e| e.to_string())?.0;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let height_physical = (height * scale).round() as i32;

    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    // SAFETY: hwnd còn sống trong scope (giữ bởi `win`); rect là output hợp lệ.
    let ok = unsafe { GetWindowRect(hwnd, &mut rect) };
    if ok == 0 {
        return Err("GetWindowRect thất bại".to_string());
    }

    let width = rect.right - rect.left;
    let current_height = rect.bottom - rect.top;
    let height_delta = height_physical - current_height;
    // Win32: gốc toạ độ TRÊN-TRÁI, y tăng xuống dưới → phải bù `top` lên
    // đúng bằng phần chiều cao tăng thêm để giữ cạnh đáy đứng yên (khác
    // AppKit, nơi giữ nguyên origin là đủ).
    let new_top = rect.top - height_delta;

    // SAFETY: hwnd hợp lệ (Tauri giữ); SWP_NOZORDER nên hwndinsertafter (null)
    // bị bỏ qua.
    let ok = unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            rect.left,
            new_top,
            width,
            height_physical,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    if ok == 0 {
        return Err("SetWindowPos thất bại".to_string());
    }
    Ok(())
}

/// Bảng điều khiển chụp cuộn (scrolling capture). `border_win` là chính
/// overlay đang hiển thị khung xanh (đã đứng yên từ lúc user kéo/thả chuột
/// chọn vùng, xem `flow::finalize_region` nhánh "scroll") — KHÔNG build cửa
/// sổ "scroll-border" mới nữa: tái dùng nguyên nó làm khung viền trong lúc
/// chụp cuộn, loại bỏ khoảng hở giữa 2 cửa sổ từng gây "nháy khung" lúc bắt
/// đầu chụp cuộn (cùng kỹ thuật `open_stop_control`/`finalize_region` dùng
/// cho quay vùng).
pub fn open_scroll_control(
    app: &AppHandle,
    border_win: &tauri::WebviewWindow,
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

    // Đặt click-through để chuột nhấn xuyên qua được khung xuống trang thật
    // đang cuộn phía dưới.
    let _ = border_win.set_ignore_cursor_events(true);
    // Loại khung viền khỏi ảnh chụp (SCK trên macOS / WGC trên Windows bỏ qua
    // cửa sổ content-protected) — tránh khung lọt vào lát cắt khi nó nằm đè
    // lên vùng đang cuộn.
    let _ = border_win.set_content_protected(true);
    // Báo frontend (đang chạy sẵn NGAY TRONG cửa sổ này suốt từ lúc chọn
    // vùng) tự chuyển từ hiển thị "khung xanh + backdrop mờ" (RegionSelect)
    // sang khung viền nét đứt pulsing cho chụp cuộn — không cần truyền lại
    // toạ độ vùng chọn vì component vẫn còn nguyên `sel` trong state.
    let _ = border_win.emit("scroll-border-activate", ());

    let m = crate::capture::monitor::at_point(mx, my)?;
    let m_x = m.x().map_err(|e| e.to_string())? as f64;
    let m_y = m.y().map_err(|e| e.to_string())? as f64;
    let scale = m.scale_factor().unwrap_or(1.0).max(1.0) as f64;

    // Chuyển toạ độ vùng chụp sang logical points để định vị cửa sổ
    #[cfg(target_os = "windows")]
    let (lx, ly, lw, _lh) = (
        rx as f64 / scale,
        ry as f64 / scale,
        rw as f64 / scale,
        rh as f64 / scale,
    );
    #[cfg(not(target_os = "windows"))]
    let (lx, ly, lw, _lh) = (
        rx as f64,
        ry as f64,
        rw as f64,
        rh as f64,
    );

    let global_x = m_x + lx;
    let global_y = m_y + ly;

    // Tính toán vị trí bảng điều khiển. Ưu tiên đặt NGOÀI vùng chọn bên phải;
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

/// Pre-warm cửa sổ nhỏ chứa nút "Dừng quay" (nổi cạnh vùng đang quay) — hoàn
/// toàn TÁCH RIÊNG khỏi overlay khung/backdrop (khung viền lúc quay 1 VÙNG
/// giờ KHÔNG còn là 1 cửa sổ riêng nữa — chính overlay chọn vùng, đang hiển
/// thị sẵn từ lúc user kéo/chỉnh khung, được BIẾN THÀNH lớp click-through cho
/// khung viền luôn, xem `flow::finalize_region` — không tạo/ẩn cửa sổ nào
/// thêm cho phần khung nên không thể có khoảng hở giữa 2 khung khác nhau
/// (nguồn gây "nháy hình" trước đây, dù đã pre-warm để giảm độ trễ tải trang
/// cũng không triệt tiêu hết vì bản chất vẫn là 2 cửa sổ được compositor xử
/// lý độc lập)). Thanh nút này là cửa sổ NHỎ, KHÔNG click-through, chỉ che
/// đúng khoảng của chính nó — user vẫn tương tác được với toàn bộ phần còn
/// lại của màn hình (kể cả bên trong vùng đang quay) khi quay, giống tinh
/// thần `open_scroll_control`.
pub fn prewarm_stop_control(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("record-stop-control").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "record-stop-control", url("record-stop-control"))
        .title("SnapDoc — Dừng quay")
        .inner_size(200.0, 56.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|e| format!("Không tạo được nút dừng quay: {e}"))?;
    Ok(())
}

/// Hiện thanh "Dừng quay" cạnh vùng `rx,ry,rw,rh` (cùng đơn vị với
/// `record::start_recording_region`) trên màn hình `s`. Đặt vị trí ưu tiên
/// NGAY DƯỚI khung (fallback lên trên nếu sát mép dưới màn hình) — cùng công
/// thức `RecordRegionToolbar` phía frontend dùng lúc còn ở pha "adjusting",
/// nên thanh nút hiện ra ĐÚNG NGAY vị trí user vừa thấy nút "Bắt đầu quay",
/// không bị nhảy chỗ. Tái dùng cửa sổ pre-warm — chỉ reposition rồi show +
/// focus (bấm 1 lần là ăn ngay, không cửa sổ nào khác giành mất vì mọi cửa sổ
/// tạo sau nó đều đã `.focused(false)`).
pub fn open_stop_control(app: &AppHandle, s: &MonitorSnap, rx: f64, ry: f64, _rw: f64, rh: f64) -> Result<(), String> {
    if app.get_webview_window("record-stop-control").is_none() {
        prewarm_stop_control(app)?;
    }
    let win = app
        .get_webview_window("record-stop-control")
        .ok_or_else(|| "Không tìm thấy nút dừng quay".to_string())?;

    #[cfg(target_os = "windows")]
    let scale_conv = s.scale.max(0.0001);
    #[cfg(not(target_os = "windows"))]
    let scale_conv = 1.0_f64;
    let logical = |v: f64| v / scale_conv;
    let (l_x, l_y, l_w_mon, l_h_mon) = (logical(s.x), logical(s.y), logical(s.w), logical(s.h));
    let (l_rx, l_ry, l_rh) = (logical(rx), logical(ry), logical(rh));

    const CTRL_W: f64 = 200.0;
    const CTRL_H: f64 = 56.0;
    const MARGIN: f64 = 12.0;

    let below_y = l_y + l_ry + l_rh + MARGIN;
    let fits_below = below_y + CTRL_H <= l_y + l_h_mon;
    let ty = if fits_below {
        below_y
    } else {
        (l_y + l_ry - MARGIN - CTRL_H).max(l_y)
    };
    let tx = (l_x + l_rx).max(l_x).min(l_x + l_w_mon - CTRL_W);

    let _ = win.set_size(tauri::LogicalSize::new(CTRL_W, CTRL_H));
    let _ = win.set_position(tauri::LogicalPosition::new(tx, ty));
    // Cửa sổ được TÁI SỬ DỤNG (chỉ `hide()`, không `close()` — xem
    // `close_stop_control`) nên webview + state React của nó SỐNG SÓT qua
    // nhiều phiên quay. Không reset thì state `busy` (đặt `true` lúc bấm
    // "Dừng quay" lần trước) còn sót lại → lần quay MỚI mở ra nút đã hiện sẵn
    // "Đang dừng…", bấm không ăn thua gì (disabled). Emit event để frontend
    // tự reset local state mỗi lần được show lại.
    let _ = win.emit("record-stop-control-reset", ());
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Ẩn (KHÔNG đóng) thanh "Dừng quay" khi dừng quay — giữ webview sống cho
/// phiên quay tiếp theo, tránh phải tải lại bundle JS mỗi lần.
pub fn close_stop_control(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("record-stop-control") {
        let _ = win.hide();
    }
}

/// Popup nổi "đang quay" trên Windows — chấm đỏ + đồng hồ đếm mm:ss, bấm vào
/// để dừng quay ngay (`commands::stop_recording`). Thay cho vai trò của
/// `NSStatusItem.title` bên macOS (hiện text cạnh icon tray) — tray icon Win32
/// (`NOTIFYICONDATA`) không có API tương đương, chỉ có tooltip khi hover, nên
/// cần 1 cửa sổ riêng để hiện đồng hồ đếm luôn hiển thị. Nổi trên mọi cửa sổ
/// khác + loại khỏi chính video đang quay qua `set_content_protected(true)`
/// (WGC bỏ qua cửa sổ content-protected, cùng kỹ thuật `open_region_border`).
#[cfg(target_os = "windows")]
pub fn open_recording_indicator(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("recording-indicator") {
        let _ = win.show();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, "recording-indicator", url("recording-indicator"))
        .title("SnapDoc — Đang quay")
        .inner_size(148.0, 44.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        // Không giành focus của cửa sổ đang key hiện tại lúc vừa tạo — cùng lý
        // do với `.focused(false)` ở `open_region_border`.
        .focused(false)
        .build()
        .map_err(|e| format!("Không tạo được popup đang quay: {e}"))?;

    place_top_center(app, &win);
    let _ = win.set_content_protected(true);
    let _ = win.show();
    Ok(())
}

/// Đóng popup "đang quay" (nếu có) — gọi khi dừng quay. An toàn khi gọi dù
/// chưa từng mở.
#[cfg(target_os = "windows")]
pub fn close_recording_indicator(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("recording-indicator") {
        let _ = win.close();
    }
}

/// Đặt cửa sổ ở giữa-đỉnh màn hình chính, cách mép trên 1 khoảng nhỏ (cho
/// popup "đang quay") — cùng kỹ thuật `place_bottom_center` phía trên.
#[cfg(target_os = "windows")]
fn place_top_center(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Some((m_x, m_y, m_w, _m_h)) = cursor_or_primary_monitor_logical_rect(app) {
        if let Some((win_w, _win_h)) = logical_outer_size(win) {
            let x = m_x + (m_w - win_w) / 2.0;
            let y = m_y + 16.0;
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
    }
}

/// Mở capture bar và emit event `set-record-mode` để chọn sẵn đúng phạm vi
/// quay (`mode`: "full" | "window" | "region") ở khu vực QUAY MÀN HÌNH — dùng
/// cho nút "Quay lại" ở `record-review` (xem `record::redo_recording`). Emit
/// 2 lần cho window mới (delay ngắn rồi delay dài hơn) để đợi React mount +
/// đăng ký listener xong mới chắc emit tới nơi.
pub fn open_capture_bar_with_record_mode(app: &AppHandle, mode: &str) -> Result<(), String> {
    let is_new_window = app.get_webview_window("capture-bar").is_none();

    open_capture_bar(app)?;

    let app = app.clone();
    let mode = mode.to_string();
    tauri::async_runtime::spawn(async move {
        let first_delay = if is_new_window { 400 } else { 80 };
        tokio::time::sleep(std::time::Duration::from_millis(first_delay)).await;
        if let Some(win) = app.get_webview_window("capture-bar") {
            let payload = serde_json::json!({ "mode": mode });
            let _ = win.emit("set-record-mode", payload.clone());
            if is_new_window {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if let Some(win2) = app.get_webview_window("capture-bar") {
                    let _ = win2.emit("set-record-mode", payload);
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
    open_overlays_ex(app, mode, false, None)
}

/// Như `open_overlays`, kèm `record` (đang chọn phạm vi QUAY, không phải chụp
/// ảnh — frontend `Overlay.tsx` dựa vào đây để hiện bước "chỉnh vùng + nút
/// Bắt đầu" thay vì quay ngay khi thả chuột) và `preset` = vùng chọn lần quay
/// gần nhất (`display_id`, x, y, w, h theo hệ đơn vị của `MonitorSnap`) để đề
/// xuất lại — chỉ overlay đúng màn hình chứa `display_id` đó nhận preset qua
/// query string (`px/py/pw/ph`, đã đổi sang CSS px cục bộ của màn đó); preset
/// không khớp màn nào hiện tại (đổi cấu hình màn hình) hoặc vượt biên thì bị
/// bỏ qua lặng lẽ, coi như chưa từng có.
/// Query string cho 1 overlay ở monitor `snap` (idx `i`) — tách riêng khỏi
/// `open_overlays_ex` để `prewarm_overlays`/`try_reuse_prewarmed_overlays`
/// dùng chung, không lặp lại logic tính preset/scale.
fn build_overlay_query(
    mode: &str,
    i: usize,
    snap: &MonitorSnap,
    record: bool,
    preset: Option<(u32, f64, f64, f64, f64)>,
    gen: u64,
) -> String {
    // scale: cần cho mode "quick" (Chụp nhanh) để canvas chú thích render
    // đúng độ phân giải vật lý; các mode khác bỏ qua tham số này.
    // gen: overlay echo lại nguyên giá trị này khi báo "đã paint xong" (xem
    // `wait_for_overlays_ready`) — để Rust lọc bỏ tín hiệu trễ từ phiên cũ.
    let mut query = format!("win=overlay&mode={mode}&idx={i}&scale={}&gen={gen}", snap.scale);
    if record {
        query.push_str("&record=1");
    }
    if let Some((preset_display, px, py, pw, ph)) = preset {
        if preset_display == snap.id {
            #[cfg(target_os = "windows")]
            let scale_conv = snap.scale.max(0.0001);
            #[cfg(not(target_os = "windows"))]
            let scale_conv = 1.0_f64;
            let (cx, cy, cw, ch) = (px / scale_conv, py / scale_conv, pw / scale_conv, ph / scale_conv);
            let (snap_w_css, snap_h_css) = (snap.w / scale_conv, snap.h / scale_conv);
            let fits = cw >= 1.0 && ch >= 1.0 && cx >= 0.0 && cy >= 0.0
                && cx + cw <= snap_w_css + 0.5 && cy + ch <= snap_h_css + 0.5;
            if fits {
                query.push_str(&format!("&px={cx}&py={cy}&pw={cw}&ph={ch}"));
            }
        }
    }
    query
}

/// Định vị 1 overlay đúng khung `snap` rồi show() — tách riêng khỏi
/// `open_overlays_ex` để dùng chung cho cả nhánh build() mới lẫn nhánh
/// navigate() tái sử dụng cửa sổ đã pre-warm (xem `try_reuse_prewarmed_overlays`).
/// Đặt frame/level cho overlay TRƯỚC khi show() — cửa sổ vẫn ẩn, nhưng đã
/// đúng vị trí/kích thước để frontend bắt đầu vẽ (fetch ảnh đóng băng) ngay,
/// không phải chờ thêm một nhịp "nhảy vị trí" sau khi đã lên hình.
fn position_overlay(
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] app: &AppHandle,
    win: &tauri::WebviewWindow,
    snap: &MonitorSnap,
) {
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
        // Windows: tương đương NSWindowAnimationBehaviorNone trên macOS.
        // Đặt cờ trước khi window được reveal để DWM không fade/transition
        // ảnh freeze đã chuẩn bị sẵn lúc overlay xuất hiện.
        #[cfg(target_os = "windows")]
        disable_overlay_transitions(win);
        // Windows/Linux: snapshot ở physical pixels → đặt trực tiếp.
        let _ = win.set_position(PhysicalPosition::new(snap.x as i32, snap.y as i32));
        let _ = win.set_size(PhysicalSize::new(snap.w as u32, snap.h as u32));
    }
}

/// order-front THẬT (win.show()) + áp lại frame sau show (NSWindow borderless
/// đôi khi chỉ áp đúng frame sau khi đã order-front; Windows thì
/// WM_DPICHANGED khi đổi màn đích DPI khác có thể ghi đè set_size gọi trước
/// show()). CHỈ gọi hàm này SAU KHI `wait_for_overlays_ready` đã xác nhận (hoặc
/// timeout) frontend paint xong ảnh đóng băng — để frame đầu tiên hiện ra đã
/// có sẵn nội dung đúng, không có nhịp trống/nháy (cơ chế freeze mượt như
/// Snagit: không bao giờ show() rồi mới paint sau).
fn reveal_overlay(
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] app: &AppHandle,
    win: &tauri::WebviewWindow,
    snap: &MonitorSnap,
) {
    // macOS đặt NSWindowAnimationBehaviorNone trong configure_overlay...;
    // Windows dùng thuộc tính DWM tương đương và phải đặt TRƯỚC show() để
    // frame đầu tiên của ảnh freeze không bị transition/fade.
    #[cfg(target_os = "windows")]
    disable_overlay_transitions(win);

    let _ = win.show();

    #[cfg(target_os = "macos")]
    {
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
}

/// Chờ frontend báo "đã paint xong ảnh đóng băng" cho từng overlay-{idx}
/// (qua Tauri command `notify_overlay_ready`, xem `commands::notify_overlay_ready`
/// và `useFrozenScreen` trong Overlay.tsx) trước khi `reveal_overlay` cho
/// TẤT CẢ màn hình. Mục đích: tất cả overlay trồi lên compositor gần như
/// cùng một nhịp, với nội dung đã đúng — không màn nào lộ ra chậm hơn màn
/// khác, không có nhịp "trống" trước khi ảnh đóng băng kịp vẽ.
///
/// Có timeout an toàn (220ms) để một lỗi/độ trễ bất thường ở frontend không
/// bao giờ treo cả phiên chụp — hết giờ thì vẫn tiến hành reveal như cũ
/// (đúng hành vi trước khi có cơ chế chờ này).
fn wait_for_overlays_ready(app: &AppHandle, gen: u64, expected: usize) {
    use std::collections::HashSet;
    use std::sync::mpsc;
    use std::time::Instant;

    let (tx, rx) = mpsc::channel::<(u64, usize)>();
    if let Ok(mut slot) = app.state::<AppState>().overlay_ready_tx.lock() {
        *slot = Some(tx);
    }

    let deadline = Instant::now() + Duration::from_millis(220);
    let mut seen: HashSet<usize> = HashSet::with_capacity(expected);
    while seen.len() < expected {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok((g, idx)) if g == gen => {
                seen.insert(idx);
            }
            Ok(_) => {} // tín hiệu trễ từ phiên overlay cũ — bỏ qua
            Err(_) => break, // timeout
        }
    }

    if let Ok(mut slot) = app.state::<AppState>().overlay_ready_tx.lock() {
        *slot = None;
    }
}

/// Tạo sẵn (ẩn) 1 cửa sổ overlay cho mỗi màn hình hiện có — gọi lúc khởi
/// động app và sau mỗi lần `close_overlays` (xem đó) — để lần
/// `open_overlays_ex` TIẾP THEO chỉ cần `navigate()` cửa sổ đã có sẵn thay vì
/// phải `build()` mới hoàn toàn N cửa sổ webview. Trên máy nhiều màn hình, N
/// lần build() TUẦN TỰ (mỗi lần tạo native window + webview từ đầu) là nguồn
/// trễ chính khiến overlay không hiện "tức thì" khi bấm phím tắt chụp — build()
/// một lần duy nhất/1 cửa sổ (editor/thumbnail/capture-bar) vốn đã prewarm
/// theo đúng cách này, ở đây áp dụng lại cho N cửa sổ overlay.
///
/// Query đặt tạm mode=region làm placeholder — không ai nhìn thấy (cửa sổ
/// đang ẩn); `try_reuse_prewarmed_overlays` sẽ `navigate()` ghi đè đúng
/// mode/scale/record/preset thật ngay trước khi show(). Không đụng vào
/// overlay-{i} đã tồn tại (dù đang ẩn/idle hay đang LIVE của 1 phiên khác) —
/// chỉ tạo bù cho những index còn thiếu.
pub fn prewarm_overlays(app: &AppHandle) {
    let xmons = match xcap::Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[SnapDoc] prewarm_overlays: không liệt kê được màn hình: {e}");
            return;
        }
    };
    for (i, m) in xmons.iter().enumerate() {
        let label = format!("overlay-{i}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        let snap = MonitorSnap {
            id: m.id().unwrap_or(0),
            x: m.x().unwrap_or(0) as f64,
            y: m.y().unwrap_or(0) as f64,
            w: m.width().unwrap_or(0) as f64,
            h: m.height().unwrap_or(0) as f64,
            scale: m.scale_factor().unwrap_or(1.0).max(1.0) as f64,
        };
        // gen=0: cửa sổ pre-warm chưa thuộc phiên chụp thật nào — sẽ được
        // navigate() lại với gen thật trước khi dùng (xem `try_reuse_prewarmed_overlays`).
        let query = build_overlay_query("region", i, &snap, false, None, 0);
        let win = match WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(format!("index.html?{query}").into()),
        )
        .title("SnapDoc")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .shadow(false)
        .resizable(false)
        .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[SnapDoc] prewarm_overlays: không tạo được overlay-{i}: {e}");
                continue;
            }
        };
        let _ = win.set_content_protected(true);
        // Định vị đúng ngay từ lúc prewarm (dù đang ẩn) — tránh 1 nhịp "nhảy
        // vị trí" nếu lỡ bị show() trước khi kịp navigate() lần dùng thật.
        #[cfg(target_os = "macos")]
        {
            let win_main = win.clone();
            let did = snap.id;
            let _ = app.run_on_main_thread(move || {
                configure_overlay_ns_window_main_thread(&win_main, did);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = win.set_position(PhysicalPosition::new(snap.x as i32, snap.y as i32));
            let _ = win.set_size(PhysicalSize::new(snap.w as u32, snap.h as u32));
        }
    }
}

/// Thử tái sử dụng pool overlay đã pre-warm (ẩn, idle) thay vì `close_overlays`
/// + `build()` lại từ đầu (xem `prewarm_overlays`). Chỉ reuse khi TOÀN BỘ N
/// cửa sổ overlay-{0..N-1} đã tồn tại, đang ẨN (`is_visible() == false` — nếu
/// đang hiện tức là phiên khác đang chạy thật, TUYỆT ĐỐI không đụng vào) và
/// không có label overlay-* nào thừa (topology màn hình đổi khác lúc
/// prewarm). Bất kỳ điều kiện nào không khớp → trả `false`, caller tự
/// fallback về nhánh build() cũ — an toàn tuyệt đối, không đổi hành vi trong
/// các trường hợp đó (kể cả khi navigate() lỗi giữa chừng: các cửa sổ đã
/// navigate xong trong vòng lặp này sẽ bị `close_overlays` ở nhánh fallback
/// dọn sạch cùng phần còn lại, không để lại state lệch).
///
/// Dùng `WebviewWindow::navigate()` (điều hướng lại TRANG trên cửa sổ có sẵn,
/// KHÔNG tạo native window mới) để đổi mode/scale/record/preset — tương
/// đương 1 lần "reload", `Overlay.tsx` đọc lại `window.location.search` từ
/// đầu nên toàn bộ state module-level (MODE/MY_IDX/SCALE/RECORD/PRESET) tự
/// đúng, KHÔNG cần sửa gì ở phía frontend.
fn try_reuse_prewarmed_overlays(
    app: &AppHandle,
    mode: &str,
    record: bool,
    preset: Option<(u32, f64, f64, f64, f64)>,
    snaps: &[MonitorSnap],
    cursor_idx: usize,
    gen: u64,
) -> bool {
    let windows = app.webview_windows();
    let has_extra = windows.keys().any(|l| {
        l.starts_with("overlay-")
            && l.strip_prefix("overlay-")
                .and_then(|s| s.parse::<usize>().ok())
                .map(|idx| idx >= snaps.len())
                .unwrap_or(true)
    });
    if has_extra {
        return false;
    }

    let mut wins = Vec::with_capacity(snaps.len());
    for i in 0..snaps.len() {
        match windows.get(&format!("overlay-{i}")) {
            Some(w) => wins.push(w.clone()),
            None => return false,
        }
    }
    if wins.iter().any(|w| w.is_visible().unwrap_or(true)) {
        return false;
    }

    for (i, (snap, win)) in snaps.iter().zip(wins.iter()).enumerate() {
        let query = build_overlay_query(mode, i, snap, record, preset, gen);
        let navigated = win.url().ok().and_then(|mut u| {
            u.set_query(Some(&query));
            win.navigate(u).ok()
        });
        if navigated.is_none() {
            eprintln!("[SnapDoc] Tái sử dụng overlay pre-warm thất bại — để build() dựng lại từ đầu");
            return false;
        }
        // Chỉ định vị (ẩn) — CHƯA show(). show() đồng loạt sau khi
        // `wait_for_overlays_ready` xác nhận nội dung đã paint xong, xem đó.
        position_overlay(app, win, snap);
    }

    // Chờ frontend từng overlay báo đã paint xong ảnh đóng băng, rồi mới
    // order-front TẤT CẢ cùng lúc — tránh nhịp trống/nháy và tránh màn hình
    // này lên hình trước màn hình khác.
    wait_for_overlays_ready(app, gen, snaps.len());
    for (i, win) in wins.iter().enumerate() {
        reveal_overlay(app, win, &snaps[i]);
        if i == cursor_idx {
            let _ = win.set_focus();
        }
    }
    true
}

pub fn open_overlays_ex(
    app: &AppHandle,
    mode: &str,
    record: bool,
    preset: Option<(u32, f64, f64, f64, f64)>,
) -> Result<(), String> {
    // macOS: hạ về Accessory TRƯỚC khi show/focus overlay bên dưới. Verify
    // thực nghiệm (2026-07-22, panel_test/testN.m): dưới Accessory policy, gọi
    // `activateIgnoringOtherApps` + `makeKeyAndOrderFront` (đúng những gì
    // `win.set_focus()` làm) vẫn cho overlay nhận bàn phím thật (Esc/Enter/gõ
    // chú thích Chụp nhanh) NHƯNG KHÔNG đưa SnapDoc lên frontmost hệ thống —
    // app đang active trước đó giữ nguyên menu bar suốt phiên overlay. Dưới
    // Regular (chế độ mặc định vì `prewarm_capture_bar` cần Regular để giữ
    // Dock icon) thì cùng lệnh đó chắc chắn cướp menu bar. Trả lại Regular ở
    // `restore_regular_activation` khi phiên overlay/chụp/quay kết thúc.
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }

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

    // Tính gen TRƯỚC khi mở overlay (không phải sau như trước): cần nhúng
    // vào query string ngay từ navigate()/build() đầu tiên để frontend echo
    // lại đúng giá trị khi báo "đã paint xong" (xem `wait_for_overlays_ready`).
    let gen = app
        .state::<AppState>()
        .overlay_gen
        .fetch_add(1, Ordering::SeqCst)
        + 1;

    // P8: thử tái sử dụng pool overlay đã pre-warm trước khi đóng+build lại
    // từ đầu — xem `try_reuse_prewarmed_overlays`/`prewarm_overlays`.
    if !try_reuse_prewarmed_overlays(app, mode, record, preset, &snaps, cursor_idx, gen) {
        close_overlays(app);
        let mut wins = Vec::with_capacity(snaps.len());
        for (i, snap) in snaps.iter().enumerate() {
            let label = format!("overlay-{i}");
            let query = build_overlay_query(mode, i, snap, record, preset, gen);
            let win = WebviewWindowBuilder::new(
                app,
                &label,
                WebviewUrl::App(format!("index.html?{query}").into()),
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
            // Không cho OS resize overlay (đồng bộ với `prewarm_overlays`) —
            // toạ độ CSS/tính rect trong Overlay.tsx giả định cửa sổ luôn
            // khớp CHÍNH XÁC `MonitorSnap`; thiếu dòng này ở nhánh fallback
            // (khi tái dùng pool pre-warm thất bại) sẽ tái phát bug "lock
            // resize" đã fix ở commit 9b16ba5, vì nhánh đó chỉ áp cho pool
            // pre-warm, không áp cho window build() mới ở đây.
            .resizable(false)
            .build()
            .map_err(|e| format!("Không tạo được overlay: {e}"))?;

            let _ = win.set_content_protected(true);
            // Chỉ định vị (ẩn) — CHƯA show(), giống nhánh reuse ở trên.
            position_overlay(app, &win, snap);
            wins.push(win);
        }

        wait_for_overlays_ready(app, gen, snaps.len());
        for (i, win) in wins.iter().enumerate() {
            reveal_overlay(app, win, &snaps[i]);
            if i == cursor_idx {
                let _ = win.set_focus();
            }
        }
    }

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

/// Kích thước 1 màn hình theo đơn vị CSS px (cùng hệ với `to_css`) — dùng để
/// clamp con trỏ khi đang kéo vượt biên (xem `input_loop`).
fn css_size(s: &MonitorSnap) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        (s.w, s.h)
    }
    #[cfg(not(target_os = "macos"))]
    {
        (s.w / s.scale, s.h / s.scale)
    }
}

/// `to_css` + clamp vào đúng biên `s` — dùng khi con trỏ đã ra khỏi màn hình
/// `s` (đang kéo/thả từ màn khác sang) để toạ độ trả về LUÔN nằm trong
/// `[0, css_w] × [0, css_h]` của `s`, không tràn ra ngoài. Dùng chung cho cả
/// `overlay-input` (di chuyển) lẫn `overlay-release` (thả chuột) trong
/// `input_loop` — nếu chỉ clamp 1 trong 2 nơi, nơi còn lại vẫn có thể phát ra
/// toạ độ tràn biên, làm khung chọn/toolbar lệch hoặc nằm ngoài viewport (bị
/// `overflow: hidden` của overlay cắt mất, xem `Overlay.tsx`).
fn to_css_clamped(s: &MonitorSnap, cx: f64, cy: f64) -> (f64, f64) {
    let (x, y) = to_css(s, cx, cy);
    let (cw, ch) = css_size(s);
    (x.clamp(0.0, cw), y.clamp(0.0, ch))
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
                // khi con trỏ vượt biên màn hình. QUAN TRỌNG: toạ độ CSS phải
                // quy đổi theo snapshot của overlay ĐÍCH (`target_idx`), KHÔNG
                // phải overlay con trỏ đang thực sự đứng (`i`) — trộn lẫn 2 hệ
                // gốc toạ độ khác nhau (khi `i != target_idx`, tức con trỏ đã
                // sang màn hình khác) khiến x/y "nhảy cóc" về giá trị nhỏ/âm,
                // làm khung chọn bị lật (rectFrom ở frontend dùng min/abs nên
                // đảo ngược ngay khi x/y đột ngột đổi dấu/độ lớn).
                let target_idx = drag_idx.unwrap_or(i);
                // Vùng chọn vốn không thể kéo sang màn hình khác, nên khi con
                // trỏ vượt biên, khung chỉ dừng lại đúng mép thay vì báo kích
                // thước tràn ra ngoài màn hình gốc — xem `to_css_clamped`.
                let (x, y) = if target_idx == i { (x, y) } else { to_css_clamped(&snaps[target_idx], cx, cy) };
                let _ = app.emit("overlay-input", (target_idx, x, y));
                if left && !prev_left {
                    drag_idx = Some(i);
                    let _ = app.emit("overlay-press", (i, x, y));
                }
                if !left && prev_left {
                    let release_idx = drag_idx.take().unwrap_or(i);
                    // Nếu thả ở overlay khác, đổi hệ trục về snapshot nguồn
                    // (clamp — CÙNG lý do với nhánh di chuyển ở trên, nếu không
                    // toạ độ thả chuột có thể tràn biên dù lúc di chuyển đã
                    // được clamp đúng, làm khung/toolbar cuối cùng vẫn lệch).
                    let (rx, ry) = if release_idx != i {
                        to_css_clamped(&snaps[release_idx], cx, cy)
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
                // Thả chuột ở NGOÀI mọi màn hình (kéo tràn ra rìa desktop ảo)
                // — cùng lý do clamp với 2 nhánh trên.
                if let Some(src_idx) = drag_idx.take() {
                    let (rx, ry) = to_css_clamped(&snaps[src_idx], cx, cy);
                    let _ = app.emit("overlay-release", (src_idx, rx, ry));
                }
            }
        }
        prev_left = left;

        let right = crate::input::right_down();
        let esc = crate::input::escape_down();
        if (right && !prev_right) || (esc && !prev_esc) {
            close_overlays(&app);
            restore_regular_activation(&app);
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

    // Dựng lại pool overlay ẩn cho lần mở TIẾP THEO (xem `prewarm_overlays`) —
    // chạy nền, không chặn return (giữ đúng tính chất "gửi rồi return ngay"
    // đã ghi ở trên). Sleep 300ms trước khi build lại: cùng lý do timing đã
    // ghi ở trên (win.close() là async trên Windows — build() label trùng 1
    // cửa sổ vừa đóng nhưng OS/DWM chưa xử lý xong dễ lỗi/không ổn định).
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        prewarm_overlays(&handle);
    });
}

/// Trả `ActivationPolicy` về Regular sau khi phiên overlay (chụp ảnh/Chụp
/// nhanh/quay) kết thúc thật sự — đối xứng với việc hạ xuống Accessory ở đầu
/// `open_overlays_ex` (xem đó để biết lý do). BẮT BUỘC phải trả lại: capture-bar
/// (`prewarm_capture_bar`) cần Regular để giữ Dock icon suốt vòng đời app.
/// Gọi ở các điểm KẾT THÚC THẬT của phiên (`cancel_overlay`, bắt đầu quay,
/// chuyển sang chế độ scroll, Esc/right-click trong `input_loop`) — KHÔNG gọi
/// trong `close_overlays` dùng chung vì hàm đó còn được gọi GIỮA phiên (rebuild
/// lại overlay khi pool pre-warm không tái dùng được, xem `open_overlays_ex`),
/// trả Regular ở đó sẽ xoá mất đúng hiệu ứng Accessory vừa bật.
#[cfg(target_os = "macos")]
pub fn restore_regular_activation(app: &AppHandle) {
    use tauri::ActivationPolicy;
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
}
#[cfg(not(target_os = "macos"))]
pub fn restore_regular_activation(_app: &AppHandle) {}

/// Như `close_overlays`, TRỪ 1 cửa sổ (`keep_label`) — dùng khi bắt đầu quay
/// vùng chọn qua `RecordRegionSelect`: đóng overlay ở MỌI màn hình khác, giữ
/// lại đúng overlay nơi vùng vừa chọn — cửa sổ này tiếp tục sống SUỐT phiên
/// quay, đóng vai trò khung viền click-through (xem `flow::finalize_region`),
/// không resize/reposition/tạo lại gì cả nên không có nguồn gây nháy hình.
pub fn close_overlays_except(app: &AppHandle, keep_label: &str) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay") && label != keep_label {
            let _ = win.close();
        }
    }
    // Dừng luôn vòng lặp input_loop toàn cục (nếu không, nó vẫn tiếp tục poll
    // + emit overlay-input/press/release cho overlay còn lại dù đã hết tác
    // dụng chọn vùng) — bump generation để lần kiểm tra tiếp theo tự thoát.
    app.state::<AppState>().overlay_gen.fetch_add(1, Ordering::SeqCst);
}

/// Ẩn editor và trả về Accessory policy (ẩn Dock) / ẩn icon khỏi taskbar (Windows).
/// Dùng cho nút "New" trong editor — user muốn chụp mới mà không cần đóng editor.
///
/// KHÔNG được tắt Dock/taskbar icon nếu capture-bar vẫn còn tồn tại (từ
/// `prewarm_capture_bar`, capture-bar sống suốt vòng đời app) — bản thân nó
/// phải giữ icon hiện xuyên suốt, ẩn editor không được phép kéo theo mất icon.
pub fn hide_editor(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("editor") {
        let _ = win.hide();
        // Windows: ẩn icon khỏi taskbar khi editor bị ẩn
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(true);
    }
    if app.get_webview_window("capture-bar").is_none() {
        #[cfg(target_os = "macos")]
        {
            use tauri::ActivationPolicy;
            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
        }
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
        place_center_on_monitor(app, &win);
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
        place_center_on_monitor(app, &win);

        let win2 = win.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = win2.emit("refresh-capture", ());
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let win = WebviewWindowBuilder::new(app, "editor", url("editor"))
            .title("SnapDoc — Editor")
            .inner_size(1040.0, 720.0)
            .min_inner_size(680.0, 480.0)
            .resizable(true)
            .center()
            .skip_taskbar(false)
            .build()
            .map_err(|e| format!("Không tạo được editor: {e}"))?;
        place_center_on_monitor(app, &win);
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

/// Cửa sổ "sản phẩm" của SnapDoc (không phải overlay/thanh công cụ tạm) — có
/// thể đang mở nhưng bị app khác che ở thời điểm chụp, hoặc — đã quan sát
/// thấy trên macOS — bị hệ thống tự đưa lên trước ngay lúc xử lý phím tắt
/// Copy/Save trong 1 phiên chụp. Xem `snapshot_visible_product_windows` +
/// `protect_product_windows` bên dưới.
#[cfg(target_os = "macos")]
const PRODUCT_WINDOW_LABELS: &[&str] = &["settings", "history", "record-review", "history-trim"];

#[cfg(target_os = "macos")]
fn is_product_window(label: &str) -> bool {
    label.starts_with("editor") || PRODUCT_WINDOW_LABELS.contains(&label)
}

/// macOS: cửa sổ có đang thật sự hiển thị MỘT PHẦN trên màn hình hay không
/// (KHÔNG bị cửa sổ khác che hoàn toàn) tại đúng thời điểm gọi — dựa trên
/// `NSWindow.occlusionState`, do WindowServer duy trì liên tục theo occlusion
/// THẬT, khác `is_visible()` (chỉ biết `isVisible` bất kể có bị che hay
/// không).
#[cfg(target_os = "macos")]
fn is_occlusion_visible(win: &tauri::WebviewWindow) -> bool {
    use objc2::msg_send;
    let ptr = match win.ns_window() {
        Ok(p) => p as *mut objc2_app_kit::NSWindow,
        Err(_) => return false,
    };
    if ptr.is_null() {
        return false;
    }
    unsafe {
        let ns_win: &objc2_app_kit::NSWindow = &*ptr;
        let state: usize = msg_send![ns_win, occlusionState];
        state & 0x2 != 0 // NSWindowOcclusionStateVisible = 1 << 1
    }
}

/// Chụp nhanh tập nhãn cửa sổ sản phẩm ĐANG THẬT SỰ HIỂN THỊ (không bị che)
/// ngay lúc BẮT ĐẦU một phiên chụp (mở overlay/trước khi hiện thực sự chụp
/// pixel) — tức là TRƯỚC KHI user có cơ hội bấm phím tắt Copy/Save, trước khi
/// hiện tượng "tự đưa cửa sổ lên trước" có thể xảy ra. Dùng làm allowlist cho
/// `protect_product_windows`: cửa sổ nào đã hiển thị thật từ đầu (ý người
/// dùng đang muốn tự chụp chính nó) sẽ KHÔNG bị loại khỏi ảnh sau này, dù nó
/// có bị hệ thống đẩy lên/xuống trong lúc chờ user bấm nút.
#[cfg(target_os = "macos")]
pub fn snapshot_visible_product_windows(app: &AppHandle) -> std::collections::HashSet<String> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| is_product_window(label))
        .filter_map(|(label, win)| {
            (win.is_visible().unwrap_or(false) && is_occlusion_visible(&win)).then_some(label)
        })
        .collect()
}

/// `WebviewWindow::set_content_protected` gửi `WindowMessage::SetContentProtected`
/// qua `send_user_message` — CHỈ áp dụng ngay lập tức nếu gọi TỪ main thread;
/// gọi từ thread khác (đúng trường hợp của ta: `capture_quick_region`/
/// `finalize_region`/… chạy trên OS thread riêng, xem comment ở
/// `finalize_region`) chỉ ENQUEUE message rồi trả về NGAY, không chờ main
/// thread xử lý xong. Lệnh chụp native gọi ngay sau đó trên cùng thread nền
/// có thể chạy TRƯỚC KHI main thread kịp áp `NSWindow.sharingType` — 1 race
/// condition khiến `set_content_protected(true)` không kịp phát huy tác dụng.
/// Chạy qua `run_on_main_thread` + kênh chặn để đảm bảo áp dụng xong THẬT SỰ
/// trước khi trả quyền điều khiển lại cho caller.
#[cfg(target_os = "macos")]
fn run_on_main_sync(app: &AppHandle, f: impl FnOnce() + Send + 'static) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    if app
        .run_on_main_thread(move || {
            f();
            let _ = tx.send(());
        })
        .is_ok()
    {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
    }
}

/// Bật `content_protected` cho các cửa sổ sản phẩm KHÔNG có trong
/// `keep_visible` (allowlist từ `snapshot_visible_product_windows` lúc bắt
/// đầu phiên) — loại chúng khỏi ảnh chụp trong đúng khoảnh khắc chụp pixel,
/// bất kể vì sao chúng đang hiển thị lúc này. Cửa sổ NẰM TRONG allowlist (đã
/// hiển thị thật từ đầu phiên) được giữ nguyên để user vẫn tự chụp được
/// chính Editor/Settings/History khi cố ý làm vậy. Chạy đồng bộ qua main
/// thread — xem `run_on_main_sync`.
#[cfg(target_os = "macos")]
pub fn protect_product_windows(app: &AppHandle, keep_visible: &std::collections::HashSet<String>) {
    let app2 = app.clone();
    let keep = keep_visible.clone();
    run_on_main_sync(app, move || {
        for (label, win) in app2.webview_windows() {
            if is_product_window(&label) && !keep.contains(&label) {
                let _ = win.set_content_protected(true);
            }
        }
    });
}

/// Gỡ `content_protected` cho toàn bộ cửa sổ sản phẩm — gọi ngay sau mỗi lần
/// chụp pixel thật, kể cả khi capture lỗi. Chạy đồng bộ qua main thread —
/// xem `run_on_main_sync` (không bắt buộc về đúng, nhưng nhất quán và tránh
/// để lại `sharingType` áp dụng trễ sau khi hàm đã return).
#[cfg(target_os = "macos")]
pub fn unprotect_product_windows(app: &AppHandle) {
    let app2 = app.clone();
    run_on_main_sync(app, move || {
        for (label, win) in app2.webview_windows() {
            if is_product_window(&label) {
                let _ = win.set_content_protected(false);
            }
        }
    });
}

/// Ẩn THẬT SỰ (`orderOut` qua `.hide()`, không chỉ occluded) các cửa sổ sản
/// phẩm đang "visible" nhưng KHÔNG được user thật sự nhìn thấy lúc này (bị 1
/// app khác che — `is_occlusion_visible() == false`). Cửa sổ đang thật sự
/// hiển thị (user chủ ý đang xem, kể cả trên màn hình khác) được GIỮ NGUYÊN.
///
/// Gọi TRƯỚC khi mở overlay Chụp nhanh — TRƯỚC bước sẽ `set_focus()` (activate
/// app). Lý do phải ẩn THẬT thay vì chỉ trả focus về app cũ SAU đó (cách đã
/// thử trước, không đủ): `set_focus()` activate app ĐỒNG BỘ ngay trong lệnh
/// gọi đó — thời điểm activate xảy ra, macOS coi MỌI cửa sổ "visible" của app
/// (kể cả đang bị 1 app khác che, không phải đã `.hide()`) là cần đưa lên
/// TRÊN app vừa mất frontmost. Việc này xảy ra TRƯỚC KHI code Rust/JS kịp
/// chạy bất kỳ dòng nào để phản ứng — dù sau đó có trả focus về app cũ nhanh
/// đến đâu, vẫn đã có 1-2 khung hình cửa sổ đó hiện ra rồi mới ẩn lại (đúng
/// hiện tượng "hiện lên xong rồi mới ẩn"). Ẩn thật (orderOut) trước thì không
/// còn gì để mà bị đưa lên nữa. Trả về nhãn các cửa sổ đã ẩn để
/// `restore_hidden_product_windows` phục hồi đúng chúng sau đó.
#[cfg(target_os = "macos")]
pub fn hide_occluded_product_windows(app: &AppHandle) -> Vec<String> {
    let mut hidden = Vec::new();
    for (label, win) in app.webview_windows() {
        if is_product_window(&label) && win.is_visible().unwrap_or(false) && !is_occlusion_visible(&win) {
            if win.hide().is_ok() {
                hidden.push(label);
            }
        }
    }
    hidden
}

/// Phục hồi các cửa sổ đã ẩn bởi `hide_occluded_product_windows`. Dùng
/// `orderFront:` gọi TRỰC TIẾP qua Objective-C (KHÔNG `.show()`/`set_focus()`
/// của Tauri — cả 2 đều đi qua `makeKeyAndOrderFront:`, có thể tự activate
/// lại app) để chỉ đưa cửa sổ trở lại đúng vị trí "đang mở nhưng bị app khác
/// che" như trước khi ẩn, không cướp lại frontmost.
///
/// **BẮT BUỘC gọi SAU KHI** app trước đó đã được activate lại (xem
/// `reactivate_app_pid`) — gọi trong lúc SnapDoc còn là app frontmost sẽ làm
/// cửa sổ nháy lên lại y hệt vấn đề ta đang tránh, chỉ là bị trễ ra thêm 1
/// bước thay vì được ngăn hẳn.
#[cfg(target_os = "macos")]
pub fn restore_hidden_product_windows(app: &AppHandle, labels: &[String]) {
    use objc2::{msg_send, runtime::AnyObject};
    for label in labels {
        let Some(win) = app.get_webview_window(label) else { continue };
        let _ = app.run_on_main_thread(move || {
            if let Ok(ptr) = win.ns_window() {
                let ptr = ptr as *mut objc2_app_kit::NSWindow;
                if !ptr.is_null() {
                    unsafe {
                        let ns_win: &objc2_app_kit::NSWindow = &*ptr;
                        let _: () = msg_send![ns_win, orderFront: Option::<&AnyObject>::None];
                    }
                }
            }
        });
    }
}

/// Trả về Accessory policy (ẩn Dock) trên macOS hoặc ẩn taskbar icon trên Windows
/// nếu không còn cửa sổ editor/settings/history/record-review/history-trim nào
/// đang mở. Gọi từ on_window_event khi 1 trong các cửa sổ đó bị đóng.
///
/// KHÔNG bao giờ tắt Dock/taskbar icon nếu capture-bar còn tồn tại — từ
/// `prewarm_capture_bar`, capture-bar sống suốt vòng đời app (bấm "X" chỉ
/// minimize, không destroy — xem `commands::close_self`) và bản thân nó phải
/// luôn giữ icon hiện, bất kể đang minimize/ẩn hay không.
pub fn on_editor_closed(app: &AppHandle) {
    if app.get_webview_window("capture-bar").is_some() {
        return;
    }

    // Kiểm tra còn cửa sổ "thật" nào đang mở không (editor, settings,
    // record-review, history-trim — từ khi có titlebar thật, xem
    // `open_record_review`/`open_history_trim`). Không tính overlay,
    // thumbnail, scroll-control vì chúng tạm thời/phụ trợ.
    let has_visible = app.webview_windows().values().any(|w| {
        let label = w.label();
        (label.starts_with("editor") || label == "settings" || label == "history" || label == "record-review" || label == "history-trim")
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
                if label.starts_with("editor") || label == "settings" || label == "history" || label == "record-review" || label == "history-trim" {
                    let _ = win.set_skip_taskbar(true);
                }
            }
        }
    }
}

/// History/Library — cửa sổ browse capture đã lưu (theo đúng pattern `open_settings`).
pub fn open_history(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    if let Some(win) = app.get_webview_window("history") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        place_center_on_monitor(app, &win);
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(false);
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "history", url("history"))
        .title("SnapDoc — Library")
        .inner_size(1024.0, 680.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .center()
        .skip_taskbar(false)
        .build()
        .map_err(|e| format!("Không tạo được cửa sổ History: {e}"))?;
    place_center_on_monitor(app, &win);
    Ok(())
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
    place_thumbnail(app, &win);

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

fn place_thumbnail(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Some((m_x, m_y, m_w, m_h)) = cursor_or_primary_monitor_logical_rect(app) {
        if let Some((win_w, win_h)) = logical_outer_size(win) {
            let margin = 24.0;
            let x = m_x + m_w - win_w - margin;
            let y = m_y + m_h - win_h - margin;
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
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

/// Cửa sổ "xem lại bản quay" — mở NGAY sau khi `record::stop_recording`
/// ghi xong mp4, bắt người dùng xác nhận Lưu/Xoá trước khi ingest vào
/// History (xem `record::confirm_recording_save/discard`). KHÔNG pre-warm
/// như thumbnail: sự kiện này hiếm hơn nhiều (1 lần/phiên quay) nên tạo mới
/// mỗi lần không đáng lo hiệu năng, và tạo mới mỗi lần tránh phải tự
/// reset state cũ còn sót lại trong webview.
pub fn open_record_review(app: &AppHandle) -> Result<(), String> {
    // macOS: chuyển về Regular (cùng khuôn `open_editor`/`open_settings`) —
    // BẮT BUỘC để cửa sổ có titlebar chuẩn (nút đóng/thu nhỏ/phóng to hoạt
    // động, xem đổi từ `decorations(false)` bên dưới) + xuất hiện ở Dock/
    // Cmd+Tab. Quay có thể dừng từ tray/hotkey lúc app đang ở Accessory
    // policy (không cửa sổ nào mở) nên phải set lại mỗi lần mở, không chỉ
    // lúc tạo cửa sổ lần đầu.
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    if let Some(win) = app.get_webview_window("record-review") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        place_center_on_monitor(app, &win);
        #[cfg(target_os = "windows")]
        let _ = win.set_skip_taskbar(false);
        bring_record_review_to_front(app, win);
        return Ok(());
    }

    // Mở lớn theo % màn hình ĐANG CHỨA CON TRỎ (không phải luôn màn hình
    // chính) — người dùng cần nhìn rõ video + timeline cắt (VideoTrimmer, xem
    // RecordReview.tsx) ngay khi vừa quay xong, cỡ nhỏ trước đây làm
    // filmstrip/preview bị bóp. 85% kích thước màn hình (không phải maximize
    // hẳn) để vẫn còn thấy được nền desktop xung quanh.
    let (init_w, init_h) = cursor_or_primary_monitor_logical_rect(app)
        .map(|(_, _, w, h)| (w * 0.85, h * 0.85))
        .unwrap_or((1100.0, 780.0));

    // Cửa sổ thật có titlebar (thu nhỏ/phóng to/đóng) — giống `open_editor`,
    // KHÔNG còn borderless/transparent/always-on-top như bản cũ (cảm giác
    // "popup nổi" không phù hợp cho 1 màn hình chỉnh sửa cần thao tác lâu:
    // không thu nhỏ được, luôn che các cửa sổ khác). Đóng bằng nút "x" thật
    // trên titlebar giờ được chặn lại và coi như "Xoá" — xem
    // `WindowEvent::CloseRequested` cho label "record-review" ở `lib.rs`.
    let win = WebviewWindowBuilder::new(app, "record-review", url("record-review"))
        .title("SnapDoc — Xem lại bản quay")
        // resizable + min_inner_size để người dùng có thể kéo rộng/hẹp thêm
        // tuỳ ý (cùng khuôn `open_editor`/`open_history`).
        .inner_size(init_w, init_h)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .center()
        .skip_taskbar(false)
        .build()
        .map_err(|e| format!("Không tạo được cửa sổ xem lại bản quay: {e}"))?;

    place_center_on_monitor(app, &win);
    let _ = win.set_focus();
    bring_record_review_to_front(app, win);
    Ok(())
}

/// Đóng (huỷ hẳn, không ẩn) cửa sổ xem lại — gọi sau khi
/// `confirm_recording_save`/`confirm_recording_discard` xử lý xong (dữ liệu
/// đã lưu/xoá xong xuôi, giờ mới thật sự đóng cửa sổ).
///
/// PHẢI dùng `destroy()`, KHÔNG dùng `close()` — theo doc của tauri, `close()`
/// "emits `CloseRequested` first like a user-initiated close request", tức
/// gọi lại ĐÚNG event mà `WindowEvent::CloseRequested` cho label
/// "record-review" ở `lib.rs` đang chặn (coi là bấm nút "x" trên titlebar).
/// Dùng `close()` ở đây tạo vòng lặp tự chặn chính mình: Lưu/Xoá xử lý xong
/// gọi hàm này → `close()` → lại bắn `CloseRequested` → bị chặn lại →
/// cửa sổ KHÔNG BAO GIỜ đóng được dù dữ liệu đã xử lý xong. `destroy()`
/// "does not emit any events and force close the window instead" — đúng
/// đường "đã xử lý xong, đóng thật" cần ở đây.
pub fn close_record_review(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("record-review") {
        let _ = win.destroy();
    }
}

/// Cửa sổ "Cắt video" cho 1 item trong History — cùng khuôn `open_record_review`
/// (titlebar thật, thu nhỏ/phóng to/đóng) để 2 màn cắt video (sau khi quay
/// VS đã lưu trong History) trải nghiệm giống nhau hệt như nhau. Khác
/// `record-review`: KHÔNG cần chặn nút đóng (không có dữ liệu gì rủi ro mất —
/// đóng ngang lúc nào cũng an toàn, bản gốc trong History không đổi) và
/// KHÔNG dùng `AppState` để truyền item cần cắt — chỉ 1 giá trị `id` đọc 1
/// lần lúc mount nên nhét thẳng vào query string qua `url_with_query`, phía
/// `HistoryTrim.tsx` tự gọi `ipc.getHistoryItem(id)` để lấy dữ liệu, đơn giản
/// hơn hẳn 1 State + lock riêng.
pub fn open_history_trim(app: &AppHandle, id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }

    // Đóng cửa sổ cũ (nếu có, đang cắt 1 item KHÁC) trước khi mở cửa sổ mới
    // cho `id` này — đơn giản hơn hẳn việc tự "navigate" nội dung cửa sổ có
    // sẵn sang item khác, và tình huống này hiếm (chỉ xảy ra khi bấm "Cắt
    // video" ở item khác trong lúc cửa sổ cắt trước đó còn mở).
    if let Some(win) = app.get_webview_window("history-trim") {
        let _ = win.destroy();
    }

    // % màn hình ĐANG CHỨA CON TRỎ (không phải luôn màn hình chính) — cùng lý
    // do `open_record_review`.
    let (init_w, init_h) = cursor_or_primary_monitor_logical_rect(app)
        .map(|(_, _, w, h)| (w * 0.85, h * 0.85))
        .unwrap_or((1100.0, 780.0));

    let win = WebviewWindowBuilder::new(app, "history-trim", url_with_query("history-trim", &format!("id={id}")))
        .title("SnapDoc — Cắt video")
        .inner_size(init_w, init_h)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .center()
        .skip_taskbar(false)
        .build()
        .map_err(|e| format!("Không tạo được cửa sổ cắt video: {e}"))?;

    place_center_on_monitor(app, &win);
    let _ = win.set_focus();
    bring_history_trim_to_front(app, win);
    Ok(())
}

pub fn close_history_trim(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("history-trim") {
        let _ = win.close();
    }
}

#[cfg(target_os = "macos")]
fn bring_history_trim_to_front(app: &AppHandle, win: tauri::WebviewWindow) {
    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        use objc2::msg_send;
        use objc2_app_kit::NSApplication;
        use objc2_foundation::MainThreadMarker;

        if let Some(mtm) = MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(mtm);
            let _: () = unsafe { msg_send![&*ns_app, activateIgnoringOtherApps: true] };
        }

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

#[cfg(not(target_os = "macos"))]
fn bring_history_trim_to_front(_app: &AppHandle, _win: tauri::WebviewWindow) {}

/// macOS: kích hoạt app + đưa cửa sổ lên trước — quay thường được dừng từ
/// tray icon/hotkey lúc app đang ở chế độ Accessory (không có cửa sổ nào
/// hiện, không nằm trong Cmd+Tab), nên `always_on_top` không đủ để đảm bảo
/// cửa sổ nhận focus bàn phím/chuột ngay. Cùng kỹ thuật với
/// `bring_settings_to_front`.
#[cfg(target_os = "macos")]
fn bring_record_review_to_front(app: &AppHandle, win: tauri::WebviewWindow) {
    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        use objc2::msg_send;
        use objc2_app_kit::NSApplication;
        use objc2_foundation::MainThreadMarker;

        if let Some(mtm) = MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(mtm);
            let _: () = unsafe { msg_send![&*ns_app, activateIgnoringOtherApps: true] };
        }

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

#[cfg(not(target_os = "macos"))]
fn bring_record_review_to_front(_app: &AppHandle, _win: tauri::WebviewWindow) {}

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
        place_center_on_monitor(app, &win);
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
    place_center_on_monitor(app, &win);
    #[cfg(target_os = "macos")]
    bring_settings_to_front(app, win);
    #[cfg(not(target_os = "macos"))]
    let _ = win.set_focus();
    Ok(())
}
