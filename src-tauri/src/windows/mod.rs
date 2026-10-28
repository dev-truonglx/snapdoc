use crate::state::{AppState, MonitorSnap};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "macos"))]
use tauri::{PhysicalPosition, PhysicalSize};

mod overlay;
pub use overlay::*;
#[cfg(target_os = "macos")]
mod product_windows;
#[cfg(target_os = "macos")]
pub use product_windows::*;

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
fn configure_overlay_ns_window_main_thread(win: &tauri::WebviewWindow, display_id: u32, record_self: bool) {
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

        // Đặt window level & sharingType:
        // - Khi record_self == false (mặc định): NSScreenSaverWindowLevel = 1000
        //   để overlay phủ kín mọi thứ kể cả Spotlight, Notification Center và menu bar.
        //   sharingType = NSWindowSharingNone (0) để overlay hoàn toàn "tàng hình" khi quay.
        // - Khi record_self == true: NSPopUpMenuWindowLevel = 101 để overlay vẫn phủ kín
        //   toàn bộ màn hình và menu bar (NSMenuBarWindowLevel ≈ 24), nhưng KHÔNG bị
        //   ScreenCaptureKit nhận diện là ScreenSaver layer (kCGScreenSaverWindowLevel = 1000)
        //   rồi tự động loại trừ khỏi video stream. Đồng thời sharingType = NSWindowSharingReadOnly (1)
        //   để macOS cho phép ScreenCaptureKit ghi hình cửa sổ.
        let window_level: i64 = if record_self { 101 } else { 1000 };
        let _: () = msg_send![ns_win, setLevel: window_level];

        let sharing_type: usize = if record_self { 1 } else { 0 };
        let _: () = msg_send![ns_win, setSharingType: sharing_type];

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
fn configure_overlay_ns_window_main_thread(_win: &tauri::WebviewWindow, _display_id: u32, _record_self: bool) {}

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
            // 2usize = NSApplicationActivateIgnoringOtherApps
            let _: bool = msg_send![running, activateWithOptions: 2usize];
            let sel = objc2::sel!(activate);
            if objc2::msg_send![running, respondsToSelector: sel] {
                let _: bool = msg_send![running, activate];
            }
        }
    });
}

/// Windows: Lấy HWND của cửa sổ foreground thuộc ứng dụng khác (vd Chrome, Edge)
/// ngay lúc bắt đầu phiên chụp. Nếu foreground là cửa sổ SnapDoc (Editor) thì trả None.
/// Nếu foreground là Taskbar/Tray menu (do người dùng click từ system tray), duyệt Z-order
/// để tìm cửa sổ ứng dụng người dùng đang thao tác trước đó.
#[cfg(target_os = "windows")]
pub fn get_external_foreground_hwnd(app: &AppHandle) -> Option<isize> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, GetWindow, GetWindowThreadProcessId, IsWindowVisible,
        GA_ROOT, GW_HWNDNEXT,
    };

    let our_pid = std::process::id();
    let fg = unsafe { GetForegroundWindow() };

    if !fg.is_null() {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(fg, &mut pid) };
        if pid == our_pid {
            let editor_hwnd = crate::flow::get_hwnd(app, "editor");
            let is_editor = editor_hwnd
                .map(|h| {
                    h == fg || unsafe { GetAncestor(fg, GA_ROOT) } == h
                })
                .unwrap_or(false);
            if is_editor {
                return None; // Đang ở Editor, không phải app khác
            }

            // Nếu foreground thuộc SnapDoc (vd: bấm Chụp nhanh từ CaptureBar hoặc menu):
            // Nếu Editor đang hiển thị (không bị minimize), người dùng đang làm việc trong Editor -> trả None.
            if let Some(win) = app.get_webview_window("editor") {
                if win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false) {
                    return None;
                }
            }
        } else {
            let mut class_name = [0u16; 64];
            let len = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(
                    fg,
                    class_name.as_mut_ptr(),
                    64,
                )
            };
            let name = String::from_utf16_lossy(&class_name[..len as usize]);
            if name != "Shell_TrayWnd" && name != "NotifyIconOverflowWindow" {
                return Some(fg as isize);
            }
        }
    }

    // Nếu fg là taskbar hoặc tray menu (hoặc SnapDoc khi Editor không hiển thị), duyệt Z-order tìm cửa sổ app khác gần nhất
    let mut curr = fg;
    while !curr.is_null() {
        curr = unsafe { GetWindow(curr, GW_HWNDNEXT) };
        if curr.is_null() {
            break;
        }
        if unsafe { IsWindowVisible(curr) } == 0 {
            continue;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(curr, &mut pid) };
        if pid == 0 || pid == our_pid {
            continue;
        }
        let mut class_name = [0u16; 64];
        let len = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(
                curr,
                class_name.as_mut_ptr(),
                64,
            )
        };
        let name = String::from_utf16_lossy(&class_name[..len as usize]);
        if name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd" {
            continue;
        }
        return Some(curr as isize);
    }

    // Nếu không tìm thấy app khác, chỉ trả Some(fg) nếu fg KHÔNG thuộc tiến trình của ta
    if !fg.is_null() {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(fg, &mut pid) };
        if pid != our_pid && pid != 0 {
            return Some(fg as isize);
        }
    }
    None
}

/// Đưa app sở hữu cửa sổ vừa chọn "Bắt đầu quay" lên foreground — nếu cửa sổ
/// đó đang ẩn phía sau app khác, user sẽ THẤY nó nổi lên ngay khi bắt đầu
/// quay thay vì phải tự Cmd+Tab/Alt+Tab đi tìm. ScreenCaptureKit/WGC vẫn quay
/// được cửa sổ dù bị che (không phụ thuộc z-order), đây thuần là cải thiện
/// trải nghiệm chứ không ảnh hưởng tới việc quay có thành công hay không.
///
/// `reactivate_app_pid` (kích hoạt cả app) KHÔNG đủ khi app có NHIỀU cửa sổ
/// (vd Finder mở 2 cửa sổ, cả 2 đều đang ẩn): macOS tự chọn cửa sổ "gần nhất"
/// của app đó lên, có thể KHÔNG PHẢI cửa sổ user vừa chọn trong dialog. Phải
/// raise ĐÚNG cửa sổ cụ thể qua Accessibility API (`ax_raise_window`) — cần
/// quyền Accessibility (khác Screen Recording, không tự prompt, phải chủ động
/// xin — xem `permissions::request_accessibility`); nếu chưa cấp, chỉ activate
/// được cả app (fallback), không chọn đúng cửa sổ.
/// `pid`/`window_id` lấy từ `capture::window::pid_of(id)`/`id` NGAY TRƯỚC khi
/// gọi hàm này (window có thể đã đóng giữa lúc user thao tác trong dialog).
#[cfg(target_os = "macos")]
pub fn bring_app_to_front(app: &AppHandle, pid: u32, window_id: u32) {
    reactivate_app_pid(app, pid as i32);
    if !crate::permissions::can_use_accessibility() {
        // Xin quyền (mở prompt hệ thống lần đầu) — lần gọi NÀY sẽ chưa raise
        // được đúng cửa sổ (quyền chưa kịp có), nhưng từ lần quay TIẾP THEO
        // (sau khi user cấp quyền trong System Settings) sẽ raise đúng.
        crate::permissions::request_accessibility();
        return;
    }
    ax_raise_window(pid as i32, window_id);
}

/// Raise cửa sổ `target_window_id` (CGWindowID) thuộc process `pid` lên trước
/// TRONG CHÍNH app đó, dùng Accessibility API. `_AXUIElementGetWindow` là API
/// PRIVATE (không có trong header công khai của Apple) nhưng ổn định qua
/// nhiều phiên bản macOS và được dùng rộng rãi bởi các công cụ quản lý cửa sổ
/// (Rectangle, Contexts, yabai...) — không có API public nào khác để map
/// ngược từ AXUIElement (cửa sổ) sang đúng CGWindowID mà `capture::window`
/// đang dùng xuyên suốt app. No-op an toàn nếu bất kỳ bước AX nào lỗi (vd
/// process đã thoát, cửa sổ đã đóng) — đây thuần là cải thiện UX, không phải
/// đường dẫn quan trọng của việc quay.
#[cfg(target_os = "macos")]
fn ax_raise_window(pid: i32, target_window_id: u32) {
    use accessibility_sys::{
        kAXRaiseAction, kAXWindowsAttribute, AXUIElementCopyAttributeValue,
        AXUIElementCreateApplication, AXUIElementPerformAction, AXUIElementRef,
    };
    use core_foundation_sys::{
        array::{CFArrayGetCount, CFArrayGetValueAtIndex},
        base::{kCFAllocatorDefault, CFRelease, CFTypeRef},
        string::{CFStringCreateWithCString, kCFStringEncodingUTF8},
    };

    // Private, không có trong `accessibility-sys` — khai báo thủ công (xem
    // doc-comment ở trên). Framework đã được `accessibility-sys` link sẵn,
    // khai `#[link]` lại ở đây chỉ để rõ ràng (linker gộp, không trùng lặp).
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn _AXUIElementGetWindow(element: AXUIElementRef, out: *mut u32) -> i32;
    }

    unsafe fn ax_cfstring(s: &str) -> core_foundation_sys::string::CFStringRef {
        let c = std::ffi::CString::new(s).unwrap_or_default();
        unsafe { CFStringCreateWithCString(kCFAllocatorDefault, c.as_ptr(), kCFStringEncodingUTF8) }
    }

    unsafe {
        let app_elem: AXUIElementRef = AXUIElementCreateApplication(pid);
        if app_elem.is_null() {
            return;
        }
        let attr = ax_cfstring(kAXWindowsAttribute);
        let mut windows_ref: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(app_elem, attr, &mut windows_ref);
        CFRelease(attr as CFTypeRef);
        if err == accessibility_sys::kAXErrorSuccess && !windows_ref.is_null() {
            let arr = windows_ref as core_foundation_sys::array::CFArrayRef;
            for i in 0..CFArrayGetCount(arr) {
                let win_elem = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
                let mut wid: u32 = 0;
                if _AXUIElementGetWindow(win_elem, &mut wid) == accessibility_sys::kAXErrorSuccess
                    && wid == target_window_id
                {
                    let action = ax_cfstring(kAXRaiseAction);
                    AXUIElementPerformAction(win_elem, action);
                    CFRelease(action as CFTypeRef);
                    break;
                }
            }
            CFRelease(windows_ref);
        }
        CFRelease(app_elem as CFTypeRef);
    }
}

/// Windows: `window_id` (từ `capture::window::pid_of`/`list_metas`, xem
/// `xcap::Window::id()`) CHÍNH LÀ giá trị HWND (ép kiểu u32) — raise ĐÚNG cửa
/// sổ đó trực tiếp bằng `SetForegroundWindow`, không cần dò theo `pid` (tránh
/// đúng vấn đề nhiều cửa sổ/1 process như macOS — Explorer cũng có thể có
/// nhiều cửa sổ). Khôi phục trước nếu đang bị thu nhỏ (`SetForegroundWindow`
/// không tự bỏ minimize). Có thể bị OS chặn nếu SnapDoc không phải app đang có
/// input focus gần đây nhất (cùng hạn chế `SetForegroundWindow` đã ghi ở
/// `force_to_foreground` phía trên) — best-effort, không coi là lỗi nếu không
/// lên được, quay vẫn tiếp tục bình thường.
#[cfg(target_os = "windows")]
pub fn bring_app_to_front(_app: &AppHandle, _pid: u32, window_id: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE};

    let hwnd = window_id as isize as windows_sys::Win32::Foundation::HWND;
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn bring_app_to_front(_app: &AppHandle, _pid: u32, _window_id: u32) {}

fn url(win: &str) -> WebviewUrl {
    WebviewUrl::App(format!("index.html?win={win}").into())
}

/// Khoảng cách (trái, trên, phải, dưới) giữa kích thước MÀN HÌNH ĐẦY ĐỦ và WORK AREA (đã trừ taskbar/Dock/menu bar…)
/// của màn hình chứa điểm `(cx, cy)` (physical px).
/// - Trên macOS: trả về đơn vị LOGICAL/points (chia scale) cho đúng chuẩn points của macOS.
/// - Trên Windows/Linux: trả về đơn vị PHYSICAL PIXELS (không chia scale) làm chuẩn Win32.
fn work_area_insets(app: &AppHandle, cx: f64, cy: f64) -> Option<(f64, f64, f64, f64)> {
    let m = app.monitor_from_point(cx, cy).ok().flatten()?;
    let pos = m.position();
    let size = m.size();
    let wa = m.work_area();
    #[cfg(target_os = "macos")]
    {
        let scale = m.scale_factor().max(0.0001);
        let left = (wa.position.x - pos.x).max(0) as f64 / scale;
        let top = (wa.position.y - pos.y).max(0) as f64 / scale;
        let right = ((pos.x + size.width as i32) - (wa.position.x + wa.size.width as i32)).max(0) as f64 / scale;
        let bottom = ((pos.y + size.height as i32) - (wa.position.y + wa.size.height as i32)).max(0) as f64 / scale;
        Some((left, top, right, bottom))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let left = (wa.position.x - pos.x).max(0) as f64;
        let top = (wa.position.y - pos.y).max(0) as f64;
        let right = ((pos.x + size.width as i32) - (wa.position.x + wa.size.width as i32)).max(0) as f64;
        let bottom = ((pos.y + size.height as i32) - (wa.position.y + wa.size.height as i32)).max(0) as f64;
        Some((left, top, right, bottom))
    }
}

/// Trừ insets (`work_area_insets`) vào rect màn hình đầy đủ `(m_x, m_y, m_w, m_h)`.
fn shrink_to_work_area(app: &AppHandle, cx: f64, cy: f64, rect: (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    let (m_x, m_y, m_w, m_h) = rect;
    match work_area_insets(app, cx, cy) {
        Some((left, top, right, bottom)) => (
            m_x + left,
            m_y + top,
            (m_w - left - right).max(1.0),
            (m_h - top - bottom).max(1.0),
        ),
        None => rect,
    }
}

#[derive(Clone, Copy, Debug)]
struct TargetMonitorBounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
}

/// Vùng (x, y, width, height, scale) của WORK AREA (đã trừ taskbar/Dock/menu bar) màn hình đang chứa con trỏ chuột.
/// Dùng để mở cửa sổ đúng màn hình user đang nhìn vào lúc bấm mở.
///
/// - Trên macOS: LUÔN trả LOGICAL points (CGDisplayBounds/points) — an toàn trên macOS vì tao không nhân/chia lại.
/// - Trên Windows/Linux: LUÔN trả PHYSICAL PIXELS làm chuẩn (Win32 virtual screen coordinates) — an toàn trên
///   Windows vì SetWindowPos nhận toạ độ vật lý, tránh bug scale nhân lệch của tao khi truyền LogicalPosition giữa các màn hình khác DPI.
fn cursor_or_primary_monitor_bounds(app: &AppHandle) -> Option<TargetMonitorBounds> {
    if let Some((cx, cy)) = read_cursor(app) {
        if let Ok(m) = crate::capture::monitor::at_point(cx as i32, cy as i32) {
            #[cfg(target_os = "macos")]
            let (rect, scale) = {
                let s = m.scale_factor().unwrap_or(1.0).max(1.0) as f64;
                (
                    (
                        m.x().unwrap_or(0) as f64,
                        m.y().unwrap_or(0) as f64,
                        m.width().unwrap_or(0) as f64,
                        m.height().unwrap_or(0) as f64,
                    ),
                    s,
                )
            };
            #[cfg(not(target_os = "macos"))]
            let (rect, scale) = {
                let s = (m.scale_factor().unwrap_or(1.0).max(1.0)) as f64;
                (
                    (
                        m.x().unwrap_or(0) as f64,
                        m.y().unwrap_or(0) as f64,
                        m.width().unwrap_or(0) as f64,
                        m.height().unwrap_or(0) as f64,
                    ),
                    s,
                )
            };
            let (x, y, w, h) = shrink_to_work_area(app, cx, cy, rect);
            return Some(TargetMonitorBounds { x, y, w, h, scale });
        }
    }
    let pm = app.primary_monitor().ok().flatten()?;
    let scale = pm.scale_factor() as f64;
    #[cfg(target_os = "macos")]
    let rect = (
        pm.position().x as f64 / scale,
        pm.position().y as f64 / scale,
        pm.size().width as f64 / scale,
        pm.size().height as f64 / scale,
    );
    #[cfg(not(target_os = "macos"))]
    let rect = (
        pm.position().x as f64,
        pm.position().y as f64,
        pm.size().width as f64,
        pm.size().height as f64,
    );
    let (x, y, w, h) = shrink_to_work_area(app, pm.position().x as f64, pm.position().y as f64, rect);
    Some(TargetMonitorBounds { x, y, w, h, scale })
}

/// Kích thước cửa sổ phục vụ việc định vị:
/// - macOS: trả về LOGICAL points (outer_size / scale).
/// - Windows: trả về PHYSICAL pixels (outer_size).
/// Nếu cửa sổ đang ẩn hoặc outer_size trả về <= 0, fallback về inner_size hoặc `fallback_logical` nhân theo scale.
fn window_placement_size(
    win: &tauri::WebviewWindow,
    #[cfg_attr(target_os = "macos", allow(unused_variables))] target_scale: f64,
    fallback_logical: (f64, f64),
) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        if let (Ok(size), Ok(scale)) = (win.outer_size(), win.scale_factor()) {
            let s = scale.max(0.0001);
            let w = size.width as f64 / s;
            let h = size.height as f64 / s;
            if w > 0.0 && h > 0.0 {
                return (w, h);
            }
        }
        if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
            let s = scale.max(0.0001);
            let w = size.width as f64 / s;
            let h = size.height as f64 / s;
            if w > 0.0 && h > 0.0 {
                return (w, h);
            }
        }
        fallback_logical
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(size) = win.outer_size() {
            let w = size.width as f64;
            let h = size.height as f64;
            if w > 0.0 && h > 0.0 {
                return (w, h);
            }
        }
        if let Ok(size) = win.inner_size() {
            let w = size.width as f64;
            let h = size.height as f64;
            if w > 0.0 && h > 0.0 {
                return (w, h);
            }
        }
        (fallback_logical.0 * target_scale, fallback_logical.1 * target_scale)
    }
}

/// Đặt cửa sổ ở giữa-đáy màn hình đang chứa con trỏ chuột (cho capture bar).
fn place_bottom_center(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Some(m) = cursor_or_primary_monitor_bounds(app) {
        let (win_w, win_h) = window_placement_size(win, m.scale, (730.0, 80.0));
        let x = m.x + (m.w - win_w) / 2.0;
        #[cfg(target_os = "macos")]
        {
            let y = m.y + m.h - win_h - 64.0;
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let y = m.y + m.h - win_h - (64.0 * m.scale);
            let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
        }
    }
}

/// Đặt cửa sổ ở CHÍNH GIỮA màn hình đang chứa con trỏ chuột — dùng cho các
/// cửa sổ ứng dụng "lớn" (Editor, History, Settings) thay cho
/// `.center()` mặc định của Tauri (luôn là màn hình
/// chính, bất kể con trỏ đang ở đâu). Cùng kỹ thuật `place_bottom_center`.
fn place_center_on_monitor(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Some(m) = cursor_or_primary_monitor_bounds(app) {
        let (win_w, win_h) = window_placement_size(win, m.scale, (800.0, 600.0));
        let x = m.x + (m.w - win_w) / 2.0;
        let y = m.y + (m.h - win_h) / 2.0;
        #[cfg(target_os = "macos")]
        {
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
        }
    }
}

/// Đặt cửa sổ full khít màn hình đang chứa con trỏ chuột — set THẲNG
/// position/size (KHÔNG gọi `maximize()`/`.maximized(true)`): trên macOS đổi
/// trạng thái maximized qua API (kể cả gọi lập trình, không phải user bấm nút
/// xanh) vẫn kích hoạt animation "zoom" mượt từ kích thước cũ phồng to ra —
/// user yêu cầu cửa sổ Editor phải HIỆN RA đã full sẵn, không phải phóng to
/// dần. Set size/position trực tiếp không đi qua cơ chế zoom nên không có
/// animation này.
fn fill_monitor(app: &AppHandle, win: &tauri::WebviewWindow) {
    if let Some(m) = cursor_or_primary_monitor_bounds(app) {
        #[cfg(target_os = "macos")]
        {
            let _ = win.set_position(tauri::LogicalPosition::new(m.x, m.y));
            let _ = win.set_size(tauri::LogicalSize::new(m.w, m.h));
            // Editor CÓ title bar/viền native (không `.decorations(false)` như hầu
            // hết cửa sổ khác trong app) — `set_size` ở trên chỉnh INNER size
            // (client area, giống `inner_size()` lúc build), nên OUTER size (kích
            // thước thật hiển thị/chiếm chỗ trên màn hình) LỚN HƠN đúng bằng chiều
            // cao title bar + viền. Kết quả: dù `m_h` đã là work area (trừ
            // taskbar), outer bottom vẫn tràn xuống quá `m_h` một khoảng bằng
            // title bar/viền đó, đè lên taskbar — đúng hiện tượng "vẫn bị che 1
            // ít" sau khi đã trừ work area. Đo lệch outer-inner NGAY TRÊN cửa sổ
            // (đã đứng đúng màn hình đích, đúng DPI đích) rồi trừ lại phần đó vào
            // size mới nhất để outer bottom khớp đúng mép work area.
            if let (Ok(outer), Ok(inner), Ok(scale)) =
                (win.outer_size(), win.inner_size(), win.scale_factor())
            {
                let scale = scale.max(0.0001);
                let extra_w = (outer.width as f64 - inner.width as f64) / scale;
                let extra_h = (outer.height as f64 - inner.height as f64) / scale;
                if extra_w > 0.0 || extra_h > 0.0 {
                    let _ = win.set_size(tauri::LogicalSize::new(
                        (m.w - extra_w).max(1.0),
                        (m.h - extra_h).max(1.0),
                    ));
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = win.set_position(tauri::PhysicalPosition::new(m.x.round() as i32, m.y.round() as i32));
            let _ = win.set_size(tauri::PhysicalSize::new(m.w.round() as u32, m.h.round() as u32));
            if let (Ok(outer), Ok(inner)) = (win.outer_size(), win.inner_size()) {
                let extra_w = outer.width as f64 - inner.width as f64;
                let extra_h = outer.height as f64 - inner.height as f64;
                if extra_w > 0.0 || extra_h > 0.0 {
                    let _ = win.set_size(tauri::PhysicalSize::new(
                        (m.w - extra_w).max(1.0).round() as u32,
                        (m.h - extra_h).max(1.0).round() as u32,
                    ));
                }
            }
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
        ensure_capture_bar_popover(app);
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
    ensure_capture_bar_popover(app);
    Ok(())
}

/// Popover "Tuỳ chọn" chỉ dùng được khi capture-bar đang hiện — tạo sẵn (ẩn)
/// ngay lúc bar hiện thay vì lúc khởi động app, để người chỉ dùng phím tắt
/// không phải nuôi thêm 1 webview suốt vòng đời app. User nhìn thấy bar rồi
/// mới bấm Options nên popover vẫn kịp sẵn sàng; tạo rồi thì giữ lại.
fn ensure_capture_bar_popover(app: &AppHandle) {
    if let Err(e) = prewarm_capture_bar_popover(app) {
        log::warn!("[SnapDoc] {e}");
    }
}

/// Minimize capture bar ngay trước khi chụp ảnh nền freeze trên Windows.
///
/// Capture bar PHẢI luôn ở taskbar, nên không được `hide()`. Thay vào đó, tắt
/// DWM transition cho RIÊNG HWND này rồi gọi trực tiếp `ShowWindow`: icon
/// taskbar vẫn tồn tại, nhưng frame cũ không chạy animation thu nhỏ để bị
/// WGC/GDI chụp vào frozen background.
#[cfg(target_os = "windows")]
pub fn minimize_capture_bar_for_freeze(app: &AppHandle) -> bool {
    if let Some(popover) = app.get_webview_window("capture-bar-popover") {
        let _ = popover.hide();
    }
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

/// Mở hoặc ẩn popover của capture-bar.
use std::sync::atomic::AtomicU64;
use std::time::{SystemTime, UNIX_EPOCH};

static LAST_POPOVER_CLOSE_MS: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn record_popover_closed() {
    LAST_POPOVER_CLOSE_MS.store(now_millis(), Ordering::Relaxed);
}

pub fn prewarm_capture_bar_popover(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("capture-bar-popover").is_some() {
        return Ok(());
    }
    let _win = WebviewWindowBuilder::new(app, "capture-bar-popover", url("capture-bar-popover"))
        .title("SnapDoc Options")
        .inner_size(220.0, 425.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| format!("Không tạo được capture bar popover: {e}"))?;

    #[cfg(target_os = "windows")]
    disable_overlay_transitions(&_win);

    Ok(())
}

/// Mở hoặc ẩn popover của capture-bar.
/// `anchor_x`, `anchor_y`, `anchor_w`, `anchor_h` là toạ độ logic của nút Options (tương đối so với capture-bar).
#[tauri::command]
pub async fn toggle_capture_bar_popover(
    app: AppHandle,
    anchor_x: f64,
    anchor_y: f64,
    anchor_w: f64,
    anchor_h: f64,
) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("capture-bar-popover") {
        if popover.is_visible().unwrap_or(false) {
            let _ = popover.hide();
            record_popover_closed();
            return Ok(());
        }
    }
    // Nếu popover vừa mới bị đóng do mất focus trong vòng 200ms
    // (ví dụ: user click chuột vào đúng nút Options trên bar trong lúc popover đang mở),
    // hành động click này được coi là để đóng popover chứ không phải mở lại ngay.
    let last_close = LAST_POPOVER_CLOSE_MS.load(Ordering::Relaxed);
    if now_millis().saturating_sub(last_close) < 200 {
        return Ok(());
    }
    open_capture_bar_popover(&app, anchor_x, anchor_y, anchor_w, anchor_h)
}

/// Ẩn popover của capture-bar.
#[tauri::command]
pub async fn hide_capture_bar_popover(app: AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("capture-bar-popover") {
        let _ = popover.hide();
        record_popover_closed();
    }
    Ok(())
}

/// Mở và định vị popover ngay phía trên nút Options của capture-bar.
pub fn open_capture_bar_popover(
    app: &AppHandle,
    anchor_x: f64,
    _anchor_y: f64,
    anchor_w: f64,
    _anchor_h: f64,
) -> Result<(), String> {
    let bar_win = app
        .get_webview_window("capture-bar")
        .ok_or("capture-bar không tồn tại")?;

    let popover_w = 220.0;
    let popover_h = 425.0;

    #[cfg(target_os = "macos")]
    {
        let scale = bar_win.scale_factor().map_err(|e| e.to_string())?;
        let bar_pos = bar_win.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);

        // Căn mép phải của popover khớp với mép phải của nút Options trên thanh bar
        let pop_x = (bar_pos.x + anchor_x + anchor_w - popover_w).max(bar_pos.x);
        let pop_y = bar_pos.y - popover_h - 6.0;

        if let Some(w) = app.get_webview_window("capture-bar-popover") {
            let _ = w.set_position(tauri::LogicalPosition::new(pop_x, pop_y));
            let _ = w.show();
            let _ = w.set_focus();
        } else {
            let win = WebviewWindowBuilder::new(app, "capture-bar-popover", url("capture-bar-popover"))
                .title("SnapDoc Options")
                .inner_size(popover_w, popover_h)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .position(pop_x, pop_y)
                .build()
                .map_err(|e| format!("Không tạo được capture bar popover: {e}"))?;

            let _ = win.show();
            let _ = win.set_focus();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let scale = bar_win.scale_factor().map_err(|e| e.to_string())?.max(0.0001);
        let bar_pos = bar_win.outer_position().map_err(|e| e.to_string())?;

        let popover_w_px = (popover_w * scale).round() as i32;
        let popover_h_px = (popover_h * scale).round() as i32;
        let anchor_x_px = (anchor_x * scale).round() as i32;
        let anchor_w_px = (anchor_w * scale).round() as i32;
        let margin_6_px = (6.0 * scale).round() as i32;

        let pop_x = (bar_pos.x + anchor_x_px + anchor_w_px - popover_w_px).max(bar_pos.x);
        let pop_y = bar_pos.y - popover_h_px - margin_6_px;

        if let Some(w) = app.get_webview_window("capture-bar-popover") {
            let _ = w.set_position(tauri::PhysicalPosition::new(pop_x, pop_y));
            let _ = w.show();
            let _ = w.set_focus();
        } else {
            let win = WebviewWindowBuilder::new(app, "capture-bar-popover", url("capture-bar-popover"))
                .title("SnapDoc Options")
                .inner_size(popover_w, popover_h)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .build()
                .map_err(|e| format!("Không tạo được capture bar popover: {e}"))?;

            #[cfg(target_os = "windows")]
            disable_overlay_transitions(&win);

            let _ = win.set_position(tauri::PhysicalPosition::new(pop_x, pop_y));
            let _ = win.show();
            let _ = win.set_focus();
        }
    }

    Ok(())
}

/// Giữ lại hàm tương thích ngược (no-op)
#[tauri::command]
pub fn resize_capture_bar(_app: AppHandle, _height: f64) -> Result<(), String> {
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
    let win = WebviewWindowBuilder::new(app, "record-stop-control", url("record-stop-control"))
        .title("SnapDoc — Dừng quay")
        .inner_size(260.0, 56.0)
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
    // Loại cửa sổ này khỏi video đang quay — cùng kỹ thuật `open_record_border`
    // và `open_recording_indicator` dùng: SCK/WGC bỏ qua cửa sổ content-protected
    // nên nút "Dừng quay" không lọt vào frame nào của bản ghi.
    let _ = win.set_content_protected(true);
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
#[allow(dead_code)]
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

    const CTRL_W: f64 = 260.0;
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

/// Khung viền đỏ bao đúng vùng đang quay khi quay TOÀN màn hình / quay 1 CỬA
/// SỔ (quay VÙNG đã có khung riêng — chính overlay chọn vùng, xem
/// `flow::finalize_region` — nên không gọi hàm này cho trường hợp đó). Không
/// có khung này, quay đa màn hình (hoặc quay 1 cửa sổ nằm giữa nhiều cửa sổ
/// khác) dễ khiến user không biết ScreenCaptureKit/WGC đang bắt đúng màn/cửa
/// sổ nào. `x,y,w,h` LOGICAL/points, toạ độ GLOBAL desktop (không trừ gốc màn
/// hình nào — khác `open_stop_control`). Click-through + content-protected
/// (loại khỏi chính video đang quay) suốt phiên quay, đóng ở
/// `record::stop_recording_impl` (`close_record_border`).
pub fn open_record_border(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    close_record_border(app);
    #[cfg(target_os = "macos")]
    {
        let win = WebviewWindowBuilder::new(app, "record-border", url("record-border"))
            .title("SnapDoc — Đang quay")
            .position(x, y)
            .inner_size(w, h)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            // Không giành focus của cửa sổ đang key hiện tại — cùng lý do các
            // cửa sổ nổi khác (`open_stop_control`, `open_recording_indicator`).
            .focused(false)
            .build()
            .map_err(|e| format!("Không tạo được khung viền đang quay: {e}"))?;
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_content_protected(true);
        let _ = win.show();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let win = WebviewWindowBuilder::new(app, "record-border", url("record-border"))
            .title("SnapDoc — Đang quay")
            .inner_size(w, h)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .build()
            .map_err(|e| format!("Không tạo được khung viền đang quay: {e}"))?;

        #[cfg(target_os = "windows")]
        disable_overlay_transitions(&win);

        let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
        let _ = win.set_size(tauri::PhysicalSize::new(w.round() as u32, h.round() as u32));
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_content_protected(true);
        let _ = win.show();
        Ok(())
    }
}

/// Đóng khung viền đang quay (nếu có) — an toàn khi gọi dù chưa từng mở.
pub fn close_record_border(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("record-border") {
        let _ = win.close();
    }
}

/// Cửa sổ hiển thị phím bấm khi quay video (`record-keystroke`).
/// Trong suốt, click-through (`set_ignore_cursor_events(true)`), không giành focus,
/// và KHÔNG bật `set_content_protected(true)` để SCK/WGC tự động ghi nhận vào video.
pub fn open_record_keystroke(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<Option<u32>, String> {
    close_record_keystroke(app);
    #[cfg(target_os = "macos")]
    {
        let win = WebviewWindowBuilder::new(app, "record-keystroke", url("record-keystroke"))
            .title("SnapDoc — Phím bấm")
            .position(x, y)
            .inner_size(w, h)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .build()
            .map_err(|e| format!("Không tạo được overlay phím bấm: {e}"))?;
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_content_protected(false);
        let _ = win.show();

        let window_id: Option<u32> = {
            use objc2::msg_send;
            let (tx, rx) = std::sync::mpsc::channel::<Option<u32>>();
            let win_main = win.clone();
            let _ = app.run_on_main_thread(move || {
                let mut wid = None;
                if let Ok(ptr) = win_main.ns_window() {
                    let ptr = ptr as *mut objc2_app_kit::NSWindow;
                    if !ptr.is_null() {
                        unsafe {
                            let ns_win: &objc2_app_kit::NSWindow = &*ptr;
                            // CanJoinAllSpaces=1 | Stationary=1<<4 | FullScreenAuxiliary=1<<8
                            let behavior: usize = 1 | (1 << 4) | (1 << 8);
                            let _: () = msg_send![ns_win, setCollectionBehavior: behavior];
                            let no_animation: i64 = 2;
                            let _: () = msg_send![ns_win, setAnimationBehavior: no_animation];

                            // Đảm bảo chia sẻ cửa sổ (NSWindowSharingReadOnly = 1) để ScreenCaptureKit đọc được
                            let sharing_type: usize = 1;
                            let _: () = msg_send![ns_win, setSharingType: sharing_type];

                            // NSPopUpMenuWindowLevel = 101 để nổi trên các app nhưng không bị coi là screensaver layer
                            let window_level: i64 = 101;
                            let _: () = msg_send![ns_win, setLevel: window_level];

                            let _: () = msg_send![ns_win, orderFrontRegardless];

                            let num: isize = msg_send![ns_win, windowNumber];
                            if num > 0 {
                                wid = Some(num as u32);
                            }
                        }
                    }
                }
                let _ = tx.send(wid);
            });
            rx.recv_timeout(std::time::Duration::from_millis(500)).unwrap_or(None)
        };

        log::info!("[SnapDoc][record] open_record_keystroke -> window_id = {:?}", window_id);
        Ok(window_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let win = WebviewWindowBuilder::new(app, "record-keystroke", url("record-keystroke"))
            .title("SnapDoc — Phím bấm")
            .inner_size(w, h)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .build()
            .map_err(|e| format!("Không tạo được overlay phím bấm: {e}"))?;

        #[cfg(target_os = "windows")]
        disable_overlay_transitions(&win);

        let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
        let _ = win.set_size(tauri::PhysicalSize::new(w.round() as u32, h.round() as u32));
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_content_protected(false);
        let _ = win.show();

        let window_id: Option<u32> = None;
        log::info!("[SnapDoc][record] open_record_keystroke -> window_id = {:?}", window_id);
        Ok(window_id)
    }
}

/// Đóng cửa sổ hiển thị phím bấm đang quay.
pub fn close_record_keystroke(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("record-keystroke") {
        let _ = win.close();
    }
}

/// Cửa sổ hiển thị hiệu ứng click chuột khi quay video (`record-clicks`).
/// Bao phủ toàn bộ vùng quay, trong suốt, click-through (`set_ignore_cursor_events(true)`),
/// không giành focus, và KHÔNG bật `set_content_protected(true)` để SCK/WGC tự động ghi nhận vào video.
pub fn open_record_clicks(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<Option<u32>, String> {
    close_record_clicks(app);
    #[cfg(target_os = "macos")]
    {
        let win = WebviewWindowBuilder::new(app, "record-clicks", url("record-clicks"))
            .title("SnapDoc — Click chuột")
            .position(x, y)
            .inner_size(w, h)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .build()
            .map_err(|e| format!("Không tạo được overlay click chuột: {e}"))?;
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_content_protected(false);
        let _ = win.show();

        let window_id: Option<u32> = {
            use objc2::msg_send;
            let (tx, rx) = std::sync::mpsc::channel::<Option<u32>>();
            let win_main = win.clone();
            let _ = app.run_on_main_thread(move || {
                let mut wid = None;
                if let Ok(ptr) = win_main.ns_window() {
                    let ptr = ptr as *mut objc2_app_kit::NSWindow;
                    if !ptr.is_null() {
                        unsafe {
                            let ns_win: &objc2_app_kit::NSWindow = &*ptr;
                            let behavior: usize = 1 | (1 << 4) | (1 << 8);
                            let _: () = msg_send![ns_win, setCollectionBehavior: behavior];
                            let no_animation: i64 = 2;
                            let _: () = msg_send![ns_win, setAnimationBehavior: no_animation];

                            let sharing_type: usize = 1;
                            let _: () = msg_send![ns_win, setSharingType: sharing_type];

                            let window_level: i64 = 101;
                            let _: () = msg_send![ns_win, setLevel: window_level];

                            let _: () = msg_send![ns_win, orderFrontRegardless];

                            let num: isize = msg_send![ns_win, windowNumber];
                            if num > 0 {
                                wid = Some(num as u32);
                            }
                        }
                    }
                }
                let _ = tx.send(wid);
            });
            rx.recv_timeout(std::time::Duration::from_millis(500)).unwrap_or(None)
        };

        log::info!("[SnapDoc][record] open_record_clicks -> window_id = {:?}", window_id);
        Ok(window_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let win = WebviewWindowBuilder::new(app, "record-clicks", url("record-clicks"))
            .title("SnapDoc — Click chuột")
            .inner_size(w, h)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .build()
            .map_err(|e| format!("Không tạo được overlay click chuột: {e}"))?;

        #[cfg(target_os = "windows")]
        disable_overlay_transitions(&win);

        let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
        let _ = win.set_size(tauri::PhysicalSize::new(w.round() as u32, h.round() as u32));
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_content_protected(false);
        let _ = win.show();

        let window_id: Option<u32> = None;
        log::info!("[SnapDoc][record] open_record_clicks -> window_id = {:?}", window_id);
        Ok(window_id)
    }
}

/// Đóng cửa sổ hiển thị hiệu ứng click chuột đang quay.
pub fn close_record_clicks(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("record-clicks") {
        let _ = win.close();
    }
}

/// Cửa sổ nhỏ nổi hiển thị số đếm ngược "hẹn giờ chụp" (`flow::wait_capture_delay`)
/// — TÁCH HẲN khỏi capture-bar để hoạt động đúng bất kể bar đang ẩn hay hiện
/// (chụp qua hotkey toàn cục / nút "New" ở Editor đều chủ đích KHÔNG hiện bar,
/// nên trước đây số đếm ngược — vốn render bên trong bar — không có nơi nào để
/// hiển thị). Đặt ĐÚNG vị trí capture-bar (`place_bottom_center`, cùng kích
/// thước xấp xỉ pill của bar) để trải nghiệm giữ nguyên như trước, chỉ khác là
/// luôn hiện được kể cả khi bar đang ẩn. Build mới mỗi lần đếm rồi đóng ngay
/// sau khi xong/huỷ, không prewarm vì không nằm trên hot path như overlay.
/// `secs` (số giây ban đầu) được nhúng thẳng vào query string để component
/// render đúng số ngay từ frame đầu tiên, né race lúc webview mới tạo có thể
/// chưa kịp gắn listener khi tick `capture-countdown-tick` đầu tiên được emit.
pub fn open_capture_timer(app: &AppHandle, secs: u64) -> Result<(), String> {
    close_capture_timer(app);
    let win = WebviewWindowBuilder::new(
        app,
        "capture-timer",
        WebviewUrl::App(format!("index.html?win=capture-timer&secs={secs}").into()),
    )
    .title("SnapDoc")
    .inner_size(280.0, 80.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    // Không giành focus của cửa sổ đang key hiện tại — cùng lý do các cửa sổ
    // nổi khác (`open_record_border`, `open_recording_indicator`).
    .focused(false)
    .build()
    .map_err(|e| format!("Không tạo được cửa sổ đếm ngược: {e}"))?;
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.set_content_protected(true);
    place_bottom_center(app, &win);
    let _ = win.show();
    Ok(())
}

/// Đóng cửa sổ đếm ngược (nếu có) — an toàn khi gọi dù chưa từng mở.
pub fn close_capture_timer(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("capture-timer") {
        let _ = win.close();
    }
}

/// Pre-warm popup "đang quay" trên Windows — tạo sẵn ở trạng thái ẩn (visible=false)
/// lúc app khởi động để khi bắt đầu quay, cửa sổ hiện lên tức thì (< 16ms) thay vì
/// phải chờ tạo mới WebView2 runtime.
#[cfg(target_os = "windows")]
pub fn prewarm_recording_indicator(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("recording-indicator").is_some() {
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, "recording-indicator", url("recording-indicator"))
        .title("SnapDoc — Đang quay")
        .inner_size(240.0, 44.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("Không tạo được popup đang quay: {e}"))?;

    let _ = win.set_content_protected(true);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn prewarm_recording_indicator(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

/// Popup nổi "đang quay" trên Windows — chấm đỏ + đồng hồ đếm mm:ss, bấm vào
/// để dừng quay ngay (`commands::stop_recording`). Thay cho vai trò của
/// `NSStatusItem.title` bên macOS (hiện text cạnh icon tray) — tray icon Win32
/// (`NOTIFYICONDATA`) không có API tương đương, chỉ có tooltip khi hover, nên
/// cần 1 cửa sổ riêng để hiện đồng hồ đếm luôn hiển thị. Nổi trên mọi cửa sổ
/// khác + loại khỏi chính video đang quay qua `set_content_protected(true)`
/// (WGC bỏ qua cửa sổ content-protected, cùng kỹ thuật `open_region_border`).
#[cfg(target_os = "windows")]
pub fn open_recording_indicator(
    app: &AppHandle,
    target_rect: Option<(f64, f64, f64, f64, f64)>,
) -> Result<(), String> {
    if app.get_webview_window("recording-indicator").is_none() {
        prewarm_recording_indicator(app)?;
    }
    let win = app
        .get_webview_window("recording-indicator")
        .ok_or_else(|| "Không tìm thấy popup đang quay".to_string())?;

    disable_overlay_transitions(&win);

    // Tính toán toạ độ vật lý (Physical pixels) chuẩn xác ngay trên worker thread
    // trước khi dispatch lên main thread — đảm bảo main thread chỉ tốn <0.1ms để set_position và show.
    let target_pos = if let Some((tx, ty, tw, _th, scale)) = target_rect {
        let (win_w, _) = window_placement_size(&win, scale, (240.0, 44.0));
        let x = tx + (tw - win_w) / 2.0;
        let y = ty + (16.0 * scale);
        Some((x.round() as i32, y.round() as i32))
    } else if let Some(m) = cursor_or_primary_monitor_bounds(app) {
        let (win_w, _) = window_placement_size(&win, m.scale, (240.0, 44.0));
        let x = m.x + (m.w - win_w) / 2.0;
        let y = m.y + (16.0 * m.scale);
        Some((x.round() as i32, y.round() as i32))
    } else {
        None
    };

    let win_clone = win.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some((x, y)) = target_pos {
            let _ = win_clone.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = win_clone.emit("recording-indicator-reset", ());
        let _ = win_clone.show();
        let _ = win_clone.set_always_on_top(true);

        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::Foundation::HWND;
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
            };
            if let Ok(raw_hwnd) = win_clone.hwnd() {
                let hwnd = raw_hwnd.0 as HWND;
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
            }
        }
    });

    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn open_recording_indicator(
    _app: &AppHandle,
    _target_rect: Option<(f64, f64, f64, f64, f64)>,
) -> Result<(), String> {
    Ok(())
}

/// Đóng popup "đang quay" (nếu có) — gọi khi dừng quay. Chỉ ẩn (hide), không đóng
/// (close) để giữ webview sống cho các lần quay tiếp theo.
#[cfg(target_os = "windows")]
pub fn close_recording_indicator(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("recording-indicator") {
        let _ = win.hide();
    }
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

/// Hiện lại cửa sổ editor NẾU phiên chụp vừa rồi đã ẩn nó trong lúc nó đang
/// có thay đổi chưa lưu (cờ `AppState.editor_hidden_dirty`, set ở
/// `flow::hide_editor_for_freeze`). No-op nếu cờ không bật.
///
/// Vì sao cần: `hide_editor_for_freeze` ẩn editor cho MỌI lần chụp, nhưng
/// không phải nhánh nào cũng mở lại nó — `output = "clipboard"`/`"save"` chỉ
/// mở cửa sổ thumbnail, còn huỷ overlay (Esc) thì không mở lại gì. Khi đó cửa
/// sổ chứa việc chưa lưu bị ẩn và KHÔNG CÓ đường nào mở lại: tray không có
/// mục "Mở editor", `RunEvent::Reopen` mở capture-bar.
///
/// Chỉ `show()`, CỐ TÌNH không `set_focus()` và cố tình KHÔNG dùng
/// `open_editor`: hàm đó force focus + `fill_monitor()` + emit
/// `refresh-capture` (sẽ nạp đè ảnh mới lên đúng việc chưa lưu ta đang cứu),
/// và sẽ đánh nhau với phần khôi phục focus/activation-policy tinh tế của
/// macOS ở `flow::cancel_overlay` / `restore_hidden_product_windows`.
///
/// Cờ đọc-và-xoá bằng `swap(false)` nên gọi nhiều lần trong cùng một phiên là
/// idempotent — cần thiết vì `flow::run` gọi `hide_editor_for_freeze` hai lần
/// (một lần trong `wait_capture_delay` khi bật hẹn giờ).
pub fn show_editor_if_hidden_for_capture(app: &AppHandle) {
    if !app
        .state::<AppState>()
        .editor_hidden_for_capture
        .swap(false, Ordering::SeqCst)
    {
        return;
    }
    let Some(win) = app.get_webview_window("editor") else {
        return;
    };
    let was_active = app
        .state::<AppState>()
        .editor_was_active_before_capture
        .load(Ordering::SeqCst);

    #[cfg(target_os = "macos")]
    {
        if was_active {
            use tauri::ActivationPolicy;
            let _ = app.set_activation_policy(ActivationPolicy::Regular);
            let _ = win.show();
        } else {
            // User đang ở app khác (vd Chrome) — tuyệt đối KHÔNG gọi `win.show()` hay `orderFront:`!
            // Cả hai đều đưa Editor đè lên trên Chrome, gây hiện tượng cửa sổ Editor nháy lên rồi biến mất.
            // Dùng orderBack: trực tiếp để cửa sổ chỉ nằm ở z-order phía sau mà không giành frontmost hay chèn lên Chrome.
            use objc2::{msg_send, runtime::AnyObject};
            let _ = app.run_on_main_thread(move || {
                if let Ok(ptr) = win.ns_window() {
                    let ptr = ptr as *mut objc2_app_kit::NSWindow;
                    if !ptr.is_null() {
                        unsafe {
                            let ns_win: &objc2_app_kit::NSWindow = &*ptr;
                            let _: () = msg_send![ns_win, orderBack: Option::<&AnyObject>::None];
                        }
                    }
                }
            });
        }
    }
    #[cfg(target_os = "windows")]
    {
        // 1. Phải bỏ cờ WDA_EXCLUDEFROMCAPTURE TRƯỚC khi phục hồi cửa sổ
        // — tránh việc DWM compositor vẽ surface đen/trong suốt/trắng.
        crate::flow::restore_capture_affinity(app);
        // 2. Phục hồi icon taskbar
        let _ = win.set_skip_taskbar(false);

        if was_active {
            // User vốn đang ở Editor: hiển thị lại lên foreground và unminimize
            let _ = win.show();
            let _ = win.unminimize();
            bring_to_front(app, &win);
        } else {
            // User đang ở app khác (vd Chrome): tuyệt đối KHÔNG gọi win.show() hay win.unminimize()!
            // Cả hai lệnh này đều kích hoạt và đưa Editor lên đỉnh z-order gây nháy cửa sổ đè lên Chrome.
            // Dùng SetWindowPos đưa vào HWND_BOTTOM cùng cờ SWP_NOACTIVATE để cửa sổ nằm êm ở đáy z-order.
            if let Some(hwnd) = crate::flow::get_hwnd(app, "editor") {
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::{
                        SetWindowPos, HWND_BOTTOM, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
                    };
                    SetWindowPos(
                        hwnd,
                        HWND_BOTTOM,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = win.show();
    }
}

/// Alias tương thích ngược cho `show_editor_if_hidden_for_capture`.
#[allow(dead_code)]
pub fn show_editor_if_hidden_dirty(app: &AppHandle) {
    show_editor_if_hidden_for_capture(app);
}

/// Tạo sẵn editor (ẩn) lúc khởi động để lần chụp đầu hiện ngay, không phải
/// chờ tạo webview + nạp Konva.
pub fn prewarm_editor(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("editor").is_some() {
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "editor", url("editor"))
        .title("SnapDoc — Editor")
        .inner_size(1040.0, 720.0)
        .min_inner_size(680.0, 480.0)
        .resizable(true)
        .center()
        .visible(false)
        .skip_taskbar(true)  // Ẩn icon khỏi taskbar lúc khởi động
        .build()
        .map_err(|e| format!("Không tạo được editor: {e}"))?;
    // Ẩn nên set size/position ngay không ai thấy — full sẵn từ trước khi
    // `open_editor` gọi `win.show()` lần đầu (xem `fill_monitor`).
    fill_monitor(app, &win);
    Ok(())
}

/// Windows chặn `SetForegroundWindow` (mà `set_focus()` gọi bên dưới) từ tiến
/// trình không phải là ứng dụng đang active — điển hình: Editor tự mở lúc
/// khởi động app (autostart lúc boot, hoặc mở sẵn trong `setup()`) trong khi
/// user đang thao tác ở app khác. Kết quả: cửa sổ được tạo/show nhưng nằm SAU
/// app khác, chỉ nháy icon ở taskbar chứ không lên trước. Toggle
/// `always_on_top` là `SetWindowPos` thuần z-order — không cần quyền
/// "foreground lock" nên vẫn đưa được cửa sổ lên trên dù `set_focus()` bị OS
/// từ chối; gọi `set_focus()` lại sau đó để có luôn bàn phím nếu OS cho phép.
#[cfg(target_os = "windows")]
fn force_to_foreground(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, GetForegroundWindow,
        GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    // Cấp quyền SetForegroundWindow cho bất kỳ tiến trình nào (ASFW_ANY = 0xFFFFFFFF),
    // giúp vượt qua cơ chế Foreground Lock của Windows khi vừa đóng overlay.
    unsafe {
        AllowSetForegroundWindow(0xFFFFFFFF);
    }

    let _ = win.set_always_on_top(true);
    let _ = win.set_always_on_top(false);

    if let Ok(raw_hwnd) = win.hwnd() {
        let target_hwnd = raw_hwnd.0 as HWND;
        unsafe {
            if IsIconic(target_hwnd) != 0 {
                ShowWindow(target_hwnd, SW_RESTORE);
            }

            let fg_hwnd = GetForegroundWindow();
            if !fg_hwnd.is_null() && fg_hwnd != target_hwnd {
                let cur_thread = GetCurrentThreadId();
                let fg_thread = GetWindowThreadProcessId(fg_hwnd, std::ptr::null_mut());
                if cur_thread != fg_thread && fg_thread != 0 {
                    AttachThreadInput(cur_thread, fg_thread, 1);
                    SetForegroundWindow(target_hwnd);
                    BringWindowToTop(target_hwnd);
                    SetFocus(target_hwnd);
                    AttachThreadInput(cur_thread, fg_thread, 0);
                } else {
                    SetForegroundWindow(target_hwnd);
                    BringWindowToTop(target_hwnd);
                    SetFocus(target_hwnd);
                }
            } else {
                SetForegroundWindow(target_hwnd);
                BringWindowToTop(target_hwnd);
                SetFocus(target_hwnd);
            }
        }
    }

    let _ = win.set_focus();
}

/// Đưa cửa sổ lên trên cùng màn hình và nhận focus ngay cả khi ứng dụng đang chạy nền.
/// Trên macOS: gọi activateIgnoringOtherApps + makeKeyAndOrderFront + orderFrontRegardless trên main thread.
/// Trên Windows: gọi SetWindowPos always_on_top toggle + set_focus.
pub fn bring_to_front(app: &AppHandle, win: &tauri::WebviewWindow) {
    let _ = app;
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
        let win_clone = win.clone();
        let app_clone = app.clone();
        let _ = app_clone.run_on_main_thread(move || {
            use objc2::msg_send;
            use objc2_app_kit::NSApplication;
            use objc2_foundation::MainThreadMarker;

            // activate app trước (ignoringOtherApps: true) để macOS cho phép
            // cửa sổ lên front ngay cả khi app đang ở background.
            if let Some(mtm) = MainThreadMarker::new() {
                let ns_app = NSApplication::sharedApplication(mtm);
                let _: () = unsafe { msg_send![&*ns_app, activateIgnoringOtherApps: true] };
            }

            // makeKeyAndOrderFront + orderFrontRegardless → đưa cửa sổ lên trên cùng và nhận key focus.
            if let Ok(ptr) = win_clone.ns_window() {
                let ns_win = ptr as *mut objc2_app_kit::NSWindow;
                if !ns_win.is_null() {
                    unsafe {
                        let _: () = msg_send![&*ns_win, makeKeyAndOrderFront: Option::<&objc2::runtime::AnyObject>::None];
                        let _: () = msg_send![&*ns_win, orderFrontRegardless];
                    }
                }
            }
        });
        let _ = win.set_focus();
    }

    #[cfg(target_os = "windows")]
    {
        let _ = win.set_skip_taskbar(false);
        force_to_foreground(win);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = win.set_focus();
    }
}

/// Editor chú thích.
pub fn open_editor(app: &AppHandle) -> Result<(), String> {
    // Đường này tự hiện + focus editor rồi, nên cờ "đã ẩn editor khi freeze"
    // hết ý nghĩa — xoá để `show_editor_if_hidden_for_capture` chạy sau đó (vd
    // `cancel_overlay` trong `finally` của Chụp nhanh) thành no-op.
    app.state::<AppState>()
        .editor_hidden_for_capture
        .store(false, Ordering::SeqCst);

    // Đóng toàn bộ overlay trước khi hiển thị/focus Editor để tránh việc overlay
    // đóng sau đó cướp mất active window / keyboard focus trên Windows.
    // Chỉ khi đang có phiên chụp thật: lúc rảnh, overlay chỉ là pool pre-warm
    // ẨN (`prewarm_overlays`) — đóng nó không tránh được gì mà `close_overlays`
    // còn dựng lại N webview toàn màn hình mỗi lần mở Editor (Library, tray,
    // thumbnail, "Open with"...), và lúc khởi động thì đua với chính lượt
    // `prewarm_overlays` đầu tiên.
    if overlay_session_in_progress(app) {
        close_overlays(app);
    }

    if let Some(win) = app.get_webview_window("editor") {
        let _ = win.show();
        let _ = win.unminimize();
        fill_monitor(app, &win);
        bring_to_front(app, &win);

        // Trên Windows, show() là async (WM_SHOWWINDOW qua message pump).
        // Emit refresh-capture định danh đích đến ("editor").
        // Phát ngay nhịp đầu cho fast-path, và thêm 1 nhịp sau 150ms phòng khi WebView2 đang tỉnh giấc từ sleep.
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app_handle.emit_to("editor", "refresh-capture", &());
            #[cfg(target_os = "windows")]
            {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let _ = app_handle.emit_to("editor", "refresh-capture", &());
            }
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
        fill_monitor(app, &win);
        bring_to_front(app, &win);

        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app_handle.emit_to("editor", "refresh-capture", &());
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let _ = app_handle.emit_to("editor", "refresh-capture", &());
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
        fill_monitor(app, &win);
        bring_to_front(app, &win);

        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app_handle.emit_to("editor", "refresh-capture", &());
        });
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
    log::info!("[SnapDoc] Open with → tạo cửa sổ editor mới: {label}");

    if let Ok(mut g) = app.state::<AppState>().open_files.lock() {
        g.insert(label.clone(), data_url);
    }

    let win = WebviewWindowBuilder::new(app, &label, url("editor"))
        .title("SnapDoc — Editor")
        .inner_size(1040.0, 720.0)
        .min_inner_size(680.0, 480.0)
        .resizable(true)
        .center()
        .skip_taskbar(false)
        .build()
        .map_err(|e| format!("Không tạo được editor: {e}"))?;

    // Cascade: lệch mỗi cửa sổ một chút để không chồng khít lên nhau → người
    // dùng thấy rõ nhiều ảnh đang mở thay vì tưởng ảnh trước bị thay.
    if n > 1 {
        if let (Ok(pos), Ok(scale)) = (win.outer_position(), win.scale_factor()) {
            let scale = scale.max(0.0001);
            let off = (((n - 1) % 8) as f64) * 32.0;
            let _ = win.set_position(tauri::LogicalPosition::new(
                pos.x as f64 / scale + off,
                pos.y as f64 / scale + off,
            ));
        }
    }
    bring_to_front(app, &win);
    Ok(())
}

/// macOS: mở cửa sổ editor cho video "Open with" — tương tự `open_editor_with_file`
/// nhưng lưu video path thay vì data URL. Mỗi video một cửa sổ riêng với label
/// `editor-ow-N`. Video path được pull qua `take_open_video_file` lúc mount.
#[cfg(target_os = "macos")]
pub fn open_editor_with_video_file(app: &AppHandle, pv: crate::state::PendingVideo) -> Result<(), String> {
    use tauri::ActivationPolicy;
    // Hiện Dock + cmd+Tab cho cửa sổ editor "thật".
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    let n = app
        .state::<AppState>()
        .editor_seq
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let label = format!("editor-ow-{n}");
    log::info!("[SnapDoc] Open with video → tạo cửa sổ editor mới: {label}");

    if let Ok(mut g) = app.state::<AppState>().open_video_files.lock() {
        g.insert(label.clone(), pv);
    }

    let win = WebviewWindowBuilder::new(app, &label, url("editor"))
        .title("SnapDoc — Video Editor")
        .inner_size(1040.0, 720.0)
        .min_inner_size(680.0, 480.0)
        .resizable(true)
        .center()
        .skip_taskbar(false)
        .build()
        .map_err(|e| format!("Không tạo được editor: {e}"))?;

    // Cascade: lệch mỗi cửa sổ một chút để không chồng khít lên nhau
    if n > 1 {
        if let (Ok(pos), Ok(scale)) = (win.outer_position(), win.scale_factor()) {
            let scale = scale.max(0.0001);
            let off = (((n - 1) % 8) as f64) * 32.0;
            let _ = win.set_position(tauri::LogicalPosition::new(
                pos.x as f64 / scale + off,
                pos.y as f64 / scale + off,
            ));
        }
    }
    bring_to_front(app, &win);
    Ok(())
}

/// Trả về Accessory policy (ẩn Dock) trên macOS hoặc ẩn taskbar icon trên Windows
/// nếu không còn cửa sổ editor/settings/history nào
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
    // history). Không tính overlay, thumbnail, scroll-control vì chúng
    // tạm thời/phụ trợ.
    let has_visible = app.webview_windows().values().any(|w| {
        let label = w.label();
        (label.starts_with("editor") || label == "settings" || label == "history")
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
                if label.starts_with("editor") || label == "settings" || label == "history" {
                    let _ = win.set_skip_taskbar(true);
                }
            }
        }
    }
}

/// History/Library — cửa sổ browse capture đã lưu (theo đúng pattern `open_settings`).
pub fn open_history(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("history") {
        let _ = win.show();
        let _ = win.unminimize();
        place_center_on_monitor(app, &win);
        bring_to_front(app, &win);
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
    bring_to_front(app, &win);
    Ok(())
}


/// Cạnh dài (px) của ảnh xem trước gửi kèm event `show-thumbnail` — đủ nét
/// cho cửa sổ 300×210 trên màn Retina 2×.
const THUMB_POPUP_EDGE: u32 = 640;

/// Thumbnail nổi góc dưới-phải sau khi chụp.
/// Dùng pre-warmed window: chỉ emit data + show/reposition thay vì tạo mới.
pub fn open_thumbnail(app: &AppHandle) -> Result<(), String> {
    // Event chỉ mang ảnh XEM TRƯỚC nhỏ (JPEG ~640px) — trước đây là nguyên PNG
    // full-res dạng base64: hàng chục MB chuỗi qua event, rồi webview decode
    // cả ảnh 5K chỉ để vẽ một ô 300×210. Copy/Save trên thumbnail tự lấy bản
    // full-res qua binary IPC (`peek_pending`), xem `Thumbnail.tsx`.
    let bytes = {
        use crate::state::AppState;
        app.state::<AppState>()
            .pending
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| p.bytes.clone()))
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
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        let shown_at = std::time::Instant::now();
        // Rỗng (không có pending / decode lỗi) → trang tự nạp qua `peek_pending`.
        let preview = bytes
            .and_then(|b| crate::history::thumbnail::generate_with_max_edge(&b, THUMB_POPUP_EDGE).ok())
            .map(|jpg| {
                use base64::{engine::general_purpose::STANDARD, Engine};
                STANDARD.encode(jpg)
            })
            .unwrap_or_default();
        #[cfg(target_os = "windows")]
        if let Some(rest) = std::time::Duration::from_millis(50).checked_sub(shown_at.elapsed()) {
            std::thread::sleep(rest);
        }
        let _ = win2.emit("show-thumbnail", &preview);
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
    if let Some(m) = cursor_or_primary_monitor_bounds(app) {
        let (win_w, win_h) = window_placement_size(win, m.scale, (300.0, 210.0));
        #[cfg(target_os = "macos")]
        {
            let margin = 24.0;
            let x = m.x + m.w - win_w - margin;
            let y = m.y + m.h - win_h - margin;
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let margin = 24.0 * m.scale;
            let x = m.x + m.w - win_w - margin;
            let y = m.y + m.h - win_h - margin;
            let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
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

/// Settings.
pub fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        place_center_on_monitor(app, &win);
        bring_to_front(app, &win);
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
    bring_to_front(app, &win);
    Ok(())
}
