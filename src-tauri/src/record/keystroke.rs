//! Module lắng nghe sự kiện bàn phím toàn cục (Global Keystroke Listener)
//! trong lúc quay màn hình để hiển thị phím bấm lên overlay và video.
//!
//! macOS: `CGEventTapCreate` (ListenOnly) trên một CFRunLoop thread độc lập.
//! Windows: `SetWindowsHookExW` (WH_KEYBOARD_LL) trên một Win32 message loop thread.
//! Khác: Stub struct rỗng.

#![allow(dead_code)]

#[derive(Clone, Debug, serde::Serialize)]
pub struct KeystrokePayload {
    pub key: String,
    pub modifiers: Vec<String>,
    pub label: String,
}

#[cfg(target_os = "macos")]
pub use macos::KeystrokeListener;

#[cfg(target_os = "windows")]
pub use windows::KeystrokeListener;
#[cfg(target_os = "windows")]
pub(crate) use windows::post_quit;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::KeystrokeListener;

// ── macOS Implementation ──────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::KeystrokePayload;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use tauri::{AppHandle, Emitter};

    struct TapContext {
        app: AppHandle,
        mach_port: *mut c_void,
    }

    pub struct KeystrokeListener {
        stopped: Arc<AtomicBool>,
        thread_handle: Option<JoinHandle<()>>,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
            user_info: *mut c_void,
        ) -> *mut c_void;
        fn CGEventTapEnable(tap: *mut c_void, enable: bool);
        fn CGEventGetFlags(event: *mut c_void) -> u64;
        fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
        fn CGEventKeyboardGetUnicodeString(
            event: *mut c_void,
            max_len: u32,
            actual_len: *mut u32,
            out_str: *mut u16,
        );
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: *mut c_void,
            order: isize,
        ) -> *mut c_void;
        fn CFMachPortInvalidate(port: *mut c_void);
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRemoveSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source_handled: u8) -> i32;
        fn CFRelease(cf: *const c_void);
    }

    const KEY_DOWN_EVENT: u32 = 10;
    const FLAGS_CHANGED_EVENT: u32 = 12;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFFFFFF;
    // kCGKeyboardEventAutorepeat = 8, kCGKeyboardEventKeycode = 9
    const KEYBOARD_AUTOREPEAT_FIELD: u32 = 8;
    const KEYBOARD_KEYCODE_FIELD: u32 = 9;
    /// `kCFRunLoopRunFinished` — run loop không còn source nào.
    const RUN_FINISHED: i32 = 1;

    const COMMAND_BIT: u64 = 0x00100000;
    const ALTERNATE_BIT: u64 = 0x00080000;
    const CONTROL_BIT: u64 = 0x00040000;
    const SHIFT_BIT: u64 = 0x00020000;

    fn keycode_to_string(kc: i64) -> Option<&'static str> {
        match kc {
            0 => Some("A"), 1 => Some("S"), 2 => Some("D"), 3 => Some("F"), 4 => Some("H"),
            5 => Some("G"), 6 => Some("Z"), 7 => Some("X"), 8 => Some("C"), 9 => Some("V"),
            11 => Some("B"), 12 => Some("Q"), 13 => Some("W"), 14 => Some("E"), 15 => Some("R"),
            16 => Some("Y"), 17 => Some("T"), 18 => Some("1"), 19 => Some("2"), 20 => Some("3"),
            21 => Some("4"), 22 => Some("6"), 23 => Some("5"), 24 => Some("="), 25 => Some("9"),
            26 => Some("7"), 27 => Some("-"), 28 => Some("8"), 29 => Some("0"), 30 => Some("]"),
            31 => Some("O"), 32 => Some("U"), 33 => Some("["), 34 => Some("I"), 35 => Some("P"),
            36 => Some("Return"), 37 => Some("L"), 38 => Some("J"), 39 => Some("'"), 40 => Some("K"),
            41 => Some(";"), 42 => Some("\\"), 43 => Some(","), 44 => Some("/"), 45 => Some("N"),
            46 => Some("M"), 47 => Some("."), 48 => Some("Tab"), 49 => Some("Space"), 50 => Some("`"),
            51 => Some("Delete"), 53 => Some("Esc"),
            65 => Some("."), 67 => Some("*"), 69 => Some("+"), 71 => Some("Clear"), 75 => Some("/"),
            76 => Some("Enter"), 78 => Some("-"), 81 => Some("="),
            82 => Some("0"), 83 => Some("1"), 84 => Some("2"), 85 => Some("3"), 86 => Some("4"),
            87 => Some("5"), 88 => Some("6"), 89 => Some("7"), 91 => Some("8"), 92 => Some("9"),
            96 => Some("F5"), 97 => Some("F6"), 98 => Some("F7"), 99 => Some("F3"),
            100 => Some("F8"), 101 => Some("F9"), 103 => Some("F11"), 109 => Some("F10"),
            111 => Some("F12"), 114 => Some("Help"), 115 => Some("Home"), 116 => Some("PageUp"),
            117 => Some("ForwardDelete"), 118 => Some("F4"), 119 => Some("End"), 120 => Some("F2"),
            121 => Some("PageDown"), 122 => Some("F1"),
            123 => Some("←"), 124 => Some("→"), 125 => Some("↓"), 126 => Some("↑"),
            _ => None,
        }
    }

    fn unicode_from_event(event: *mut c_void) -> Option<String> {
        let mut buf = [0u16; 8];
        let mut actual_len: u32 = 0;
        unsafe {
            CGEventKeyboardGetUnicodeString(event, buf.len() as u32, &mut actual_len, buf.as_mut_ptr());
        }
        // Kẹp độ dài: cắt slice vượt biên trong callback `extern "C"` = abort cả app.
        let len = (actual_len as usize).min(buf.len());
        if len > 0 {
            let s = String::from_utf16(&buf[..len]).ok()?;
            // Lọc bỏ triệt để các ký tự điều khiển non-printable (như 0x1B cho Esc, 0x18 cho Ctrl+X...)
            let printable: String = s.chars().filter(|c| !c.is_control()).collect();
            let trimmed = printable.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_uppercase());
            }
        }
        None
    }

    extern "C" fn event_tap_callback(
        _proxy: *mut c_void,
        event_type: u32,
        event: *mut c_void,
        refcon: *mut c_void,
    ) -> *mut c_void {
        if refcon.is_null() {
            return event;
        }

        let ctx = unsafe { &*(refcon as *const TapContext) };

        if event_type == TAP_DISABLED_BY_TIMEOUT || event_type == TAP_DISABLED_BY_USER_INPUT {
            if !ctx.mach_port.is_null() {
                unsafe { CGEventTapEnable(ctx.mach_port, true) };
            }
            return event;
        }

        // Giữ phím → hệ điều hành bắn keydown lặp liên tục: chỉ hiển thị lần nhấn đầu.
        if event_type == KEY_DOWN_EVENT && unsafe { CGEventGetIntegerValueField(event, KEYBOARD_AUTOREPEAT_FIELD) } != 0 {
            return event;
        }

        if event_type == KEY_DOWN_EVENT {
            let kc = unsafe { CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE_FIELD) };
            let flags = unsafe { CGEventGetFlags(event) };

            let mut modifiers = Vec::new();
            if flags & CONTROL_BIT != 0 {
                modifiers.push("Ctrl".to_string());
            }
            if flags & ALTERNATE_BIT != 0 {
                modifiers.push("Opt".to_string());
            }
            if flags & SHIFT_BIT != 0 {
                modifiers.push("Shift".to_string());
            }
            if flags & COMMAND_BIT != 0 {
                modifiers.push("Cmd".to_string());
            }

            // Bảng keycode là vị trí phím trên bàn phím ANSI-US — sai chữ với
            // AZERTY/Dvorak... Chữ cái lấy theo ký tự THẬT layout hiện tại sinh
            // ra; phím đặc biệt/số/dấu (và tổ hợp Ctrl, nơi ký tự Unicode là mã
            // điều khiển) vẫn theo bảng keycode như cũ.
            let unicode_letter = unicode_from_event(event).filter(|u| {
                let mut chars = u.chars();
                matches!((chars.next(), chars.next()), (Some(c), None) if c.is_alphabetic())
            });
            let key_opt = unicode_letter
                .or_else(|| keycode_to_string(kc).map(|s| s.to_string()))
                .or_else(|| unicode_from_event(event));

            if let Some(key_name) = key_opt {
                let mut parts = modifiers.clone();
                parts.push(key_name.clone());
                let label = parts.join(" + ");
                // KHÔNG log phím gõ ra stderr: bản debug chuyển stderr vào file
                // log trên đĩa — nội dung gõ (mật khẩu...) không được lưu lại.

                let payload = KeystrokePayload {
                    key: key_name,
                    modifiers,
                    label,
                };
                let _ = ctx.app.emit("record-keystroke-press", payload);
            }
        }

        event
    }

    impl KeystrokeListener {
        pub fn start(app: AppHandle) -> Result<Self, String> {
            // Kiểm tra quyền Accessibility
            if !crate::permissions::can_use_accessibility() {
                eprintln!("[SnapDoc][keystroke] Chưa có quyền Accessibility — đang yêu cầu prompt cấp quyền...");
                crate::permissions::request_accessibility();
            }

            let stopped = Arc::new(AtomicBool::new(false));

            let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), String>>();

            let stopped_clone = stopped.clone();

            let thread_handle = thread::Builder::new()
                .name("snapdoc-keystroke-listener".to_string())
                .spawn(move || unsafe {
                    let mut context = Box::new(TapContext {
                        app,
                        mach_port: std::ptr::null_mut(),
                    });
                    let context_ptr: *mut TapContext = &mut *context;

                    // Lắng nghe cả KeyDown (10) và FlagsChanged (12)
                    let events_mask: u64 = (1 << KEY_DOWN_EVENT) | (1 << FLAGS_CHANGED_EVENT);
                    let mach_port = CGEventTapCreate(
                        1, // kCGSessionEventTap
                        0, // kCGHeadInsertEventTap
                        1, // kCGEventTapOptionListenOnly
                        events_mask,
                        event_tap_callback,
                        context_ptr as *mut c_void,
                    );

                    if mach_port.is_null() {
                        eprintln!("[SnapDoc][keystroke] CGEventTapCreate trả về NULL — cần cấp quyền Accessibility (Trợ năng) trong System Settings > Privacy & Security > Accessibility!");
                        let _ = init_tx.send(Err(
                            "Không tạo được CGEventTap — cần cấp quyền Accessibility (Trợ năng) cho SnapDoc trong Cài đặt hệ thống".to_string(),
                        ));
                        return;
                    }

                    (*context_ptr).mach_port = mach_port;

                    let source = CFMachPortCreateRunLoopSource(std::ptr::null(), mach_port, 0);
                    if source.is_null() {
                        CFMachPortInvalidate(mach_port);
                        CFRelease(mach_port);
                        let _ = init_tx.send(Err("Không tạo được RunLoopSource cho EventTap".to_string()));
                        return;
                    }

                    let cur_rl = CFRunLoopGetCurrent();
                    let mode = core_foundation_sys::runloop::kCFRunLoopDefaultMode as *const c_void;
                    CFRunLoopAddSource(cur_rl, source, mode);
                    CGEventTapEnable(mach_port, true);
                    let _ = init_tx.send(Ok(()));

                    // Chạy run loop từng lát 100ms rồi kiểm tra cờ dừng — bản cũ
                    // `CFRunLoopRun` + `CFRunLoopStop` từ thread khác có race (dừng
                    // trước khi run loop chạy → treo vĩnh viễn) và dùng con trỏ run
                    // loop của 1 thread có thể đã kết thúc.
                    while !stopped_clone.load(Ordering::SeqCst) {
                        if CFRunLoopRunInMode(mode, 0.1, 0) == RUN_FINISHED {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                    }

                    CGEventTapEnable(mach_port, false);
                    CFRunLoopRemoveSource(cur_rl, source, mode);
                    CFMachPortInvalidate(mach_port);
                    CFRelease(source);
                    CFRelease(mach_port);
                })
                .map_err(|e| format!("Không khởi động được thread nghe phím: {e}"))?;

            match init_rx.recv() {
                Ok(Ok(())) => Ok(KeystrokeListener {
                    stopped,
                    thread_handle: Some(thread_handle),
                }),
                Ok(Err(err)) => {
                    let _ = thread_handle.join();
                    Err(err)
                }
                Err(_) => {
                    let _ = thread_handle.join();
                    Err("Thread nghe phím kết thúc bất thường".to_string())
                }
            }
        }

        pub fn stop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }
    }

    impl Drop for KeystrokeListener {
        fn drop(&mut self) {
            self.stop();
        }
    }
}

// ── Windows Implementation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows {
    use super::KeystrokePayload;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    /// (thế hệ listener, app) — thread hook cũ không dừng kịp không được xoá
    /// app của listener mới.
    static APP_HANDLE_FOR_HOOK: Mutex<Option<(u64, AppHandle)>> = Mutex::new(None);
    static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn clear_app_if(gen: u64) {
        let mut g = APP_HANDLE_FOR_HOOK.lock().unwrap_or_else(|p| p.into_inner());
        if g.as_ref().map(|(g0, _)| *g0 == gen).unwrap_or(false) {
            *g = None;
        }
    }
    /// Phím đang được giữ — chỉ hiển thị lần nhấn đầu, bỏ keydown lặp (auto-repeat).
    static mut KEYS_DOWN: [bool; 256] = [false; 256];

    pub struct KeystrokeListener {
        thread_id: u32,
        stopped: Arc<AtomicBool>,
        thread_handle: Option<JoinHandle<()>>,
    }

    fn vk_to_string(vk: u32) -> Option<&'static str> {
        match vk {
            0x08 => Some("Backspace"),
            0x09 => Some("Tab"),
            0x0D => Some("Enter"),
            0x1B => Some("Esc"),
            0x20 => Some("Space"),
            0x21 => Some("PageUp"),
            0x22 => Some("PageDown"),
            0x23 => Some("End"),
            0x24 => Some("Home"),
            0x25 => Some("←"),
            0x26 => Some("↑"),
            0x27 => Some("→"),
            0x28 => Some("↓"),
            0x2E => Some("Delete"),
            0x30 => Some("0"), 0x31 => Some("1"), 0x32 => Some("2"), 0x33 => Some("3"), 0x34 => Some("4"),
            0x35 => Some("5"), 0x36 => Some("6"), 0x37 => Some("7"), 0x38 => Some("8"), 0x39 => Some("9"),
            0x41 => Some("A"), 0x42 => Some("B"), 0x43 => Some("C"), 0x44 => Some("D"), 0x45 => Some("E"),
            0x46 => Some("F"), 0x47 => Some("G"), 0x48 => Some("H"), 0x49 => Some("I"), 0x4A => Some("J"),
            0x4B => Some("K"), 0x4C => Some("L"), 0x4D => Some("M"), 0x4E => Some("N"), 0x4F => Some("O"),
            0x50 => Some("P"), 0x51 => Some("Q"), 0x52 => Some("R"), 0x53 => Some("S"), 0x54 => Some("T"),
            0x55 => Some("U"), 0x56 => Some("V"), 0x57 => Some("W"), 0x58 => Some("X"), 0x59 => Some("Y"),
            0x5A => Some("Z"),
            0x70 => Some("F1"), 0x71 => Some("F2"), 0x72 => Some("F3"), 0x73 => Some("F4"),
            0x74 => Some("F5"), 0x75 => Some("F6"), 0x76 => Some("F7"), 0x77 => Some("F8"),
            0x78 => Some("F9"), 0x79 => Some("F10"), 0x7A => Some("F11"), 0x7B => Some("F12"),
            _ => None,
        }
    }

    unsafe extern "system" fn low_level_keyboard_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 && (w_param == WM_KEYUP as usize || w_param == WM_SYSKEYUP as usize) {
            let vk = (*(l_param as *const KBDLLHOOKSTRUCT)).vkCode as usize;
            if vk < 256 {
                KEYS_DOWN[vk] = false;
            }
        }
        if n_code >= 0 && (w_param == WM_KEYDOWN as usize || w_param == WM_SYSKEYDOWN as usize) {
            let kbd = *(l_param as *const KBDLLHOOKSTRUCT);
            let vk = kbd.vkCode;
            if (vk as usize) < 256 {
                if KEYS_DOWN[vk as usize] {
                    return CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param);
                }
                KEYS_DOWN[vk as usize] = true;
            }

            let mut modifiers = Vec::new();
            if (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0 {
                modifiers.push("Ctrl".to_string());
            }
            if (GetAsyncKeyState(VK_MENU as i32) as u16 & 0x8000) != 0 {
                modifiers.push("Alt".to_string());
            }
            if (GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000) != 0 {
                modifiers.push("Shift".to_string());
            }
            if (GetAsyncKeyState(VK_LWIN as i32) as u16 & 0x8000) != 0
                || (GetAsyncKeyState(VK_RWIN as i32) as u16 & 0x8000) != 0
            {
                modifiers.push("Win".to_string());
            }

            if let Some(key_name) = vk_to_string(vk) {
                let mut parts = modifiers.clone();
                parts.push(key_name.to_string());
                let label = parts.join(" + ");

                if let Ok(guard) = APP_HANDLE_FOR_HOOK.lock() {
                    if let Some((_, app)) = guard.as_ref() {
                        let payload = KeystrokePayload {
                            key: key_name.to_string(),
                            modifiers,
                            label,
                        };
                        let _ = app.emit("record-keystroke-press", payload);
                    }
                }
            }
        }

        // Tham số hook đầu tiên bị bỏ qua từ Windows NT — không cần handle toàn cục.
        CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param)
    }

    impl KeystrokeListener {
        pub fn start(app: AppHandle) -> Result<Self, String> {
            let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
            let stopped = Arc::new(AtomicBool::new(false));

            let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
            let thread_handle = thread::Builder::new()
                .name("snapdoc-win-keystroke".to_string())
                .spawn(move || unsafe {
                    if let Ok(mut g) = APP_HANDLE_FOR_HOOK.lock() {
                        *g = Some((gen, app));
                    }
                    KEYS_DOWN = [false; 256];
                    let hook = SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(low_level_keyboard_proc),
                        std::ptr::null_mut(),
                        0,
                    );

                    if hook.is_null() {
                        clear_app_if(gen);
                        let _ = tx.send(Err("Không thiết lập được Windows Keyboard Hook".to_string()));
                        return;
                    }

                    let thread_id = windows_sys::Win32::System::Threading::GetCurrentThreadId();
                    let _ = tx.send(Ok(thread_id));

                    let mut msg: MSG = std::mem::zeroed();
                    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }

                    UnhookWindowsHookEx(hook);
                    clear_app_if(gen);
                })
                .map_err(|e| format!("Không khởi động được thread nghe phím: {e}"))?;

            let thread_id = rx
                .recv()
                .map_err(|_| "Khởi tạo listener phím thất bại".to_string())??;

            Ok(KeystrokeListener {
                thread_id,
                stopped,
                thread_handle: Some(thread_handle),
            })
        }

        pub fn stop(&mut self) {
            if !self.stopped.swap(true, Ordering::SeqCst) {
                let posted = post_quit(self.thread_id);
                if let Some(handle) = self.thread_handle.take() {
                    if posted {
                        let _ = handle.join();
                    } else {
                        // Không gửi được WM_QUIT — không join (tránh treo cả luồng dừng quay).
                        eprintln!("[SnapDoc][keystroke] Không dừng được thread hook bàn phím");
                    }
                }
            }
        }
    }

    /// Gửi `WM_QUIT` tới thread hook (có thử lại: hàng đợi message của thread
    /// có thể chưa sẵn sàng ngay). `false` nếu không gửi được — caller KHÔNG
    /// được `join()` (sẽ chờ vô hạn).
    pub(crate) fn post_quit(thread_id: u32) -> bool {
        if thread_id == 0 {
            return false;
        }
        for _ in 0..50 {
            if unsafe { PostThreadMessageW(thread_id, WM_QUIT, 0, 0) } != 0 {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        false
    }

    impl Drop for KeystrokeListener {
        fn drop(&mut self) {
            self.stop();
        }
    }
}

// ── Fallback Implementation ───────────────────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod fallback {
    use tauri::AppHandle;

    pub struct KeystrokeListener;

    impl KeystrokeListener {
        pub fn start(_app: AppHandle) -> Result<Self, String> {
            Ok(KeystrokeListener)
        }
        pub fn stop(&mut self) {}
    }
}
