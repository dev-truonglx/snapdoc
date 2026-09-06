//! Module lắng nghe sự kiện click chuột toàn cục (Global Mouse Click Listener)
//! trong lúc quay màn hình để hiển thị hiệu ứng vòng tròn / sóng lan toả (ripple)
//! tại vị trí con trỏ chuột lên overlay và video.
//!
//! macOS: `CGEventTapCreate` (ListenOnly) trên một CFRunLoop thread độc lập.
//! Windows: `SetWindowsHookExW` (WH_MOUSE_LL) trên một Win32 message loop thread.
//! Khác: Stub struct rỗng.

#![allow(dead_code)]

#[derive(Clone, Debug, serde::Serialize)]
pub struct MouseClickPayload {
    pub x: f64,
    pub y: f64,
    pub button: String,
    pub count: u32,
}

#[cfg(target_os = "macos")]
pub use macos::MouseClickListener;

#[cfg(target_os = "windows")]
pub use windows::MouseClickListener;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::MouseClickListener;

// ── macOS Implementation ──────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::MouseClickPayload;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use tauri::{AppHandle, Emitter};

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    struct MouseTapContext {
        app: AppHandle,
        mach_port: *mut c_void,
        target_rect: (f64, f64, f64, f64), // (x, y, w, h)
    }

    pub struct MouseClickListener {
        run_loop: Arc<Mutex<Option<usize>>>,
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
        fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
        fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: *mut c_void,
            order: isize,
        ) -> *mut c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRemoveSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
        fn CFRunLoopStop(rl: *mut c_void);
        fn CFRelease(cf: *const c_void);
    }

    const LEFT_MOUSE_DOWN: u32 = 1;
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const OTHER_MOUSE_DOWN: u32 = 25;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    // kCGMouseEventClickState trong CoreGraphics là 1
    const MOUSE_CLICK_STATE_FIELD: u32 = 1;

    extern "C" fn mouse_event_tap_callback(
        _proxy: *mut c_void,
        event_type: u32,
        event: *mut c_void,
        refcon: *mut c_void,
    ) -> *mut c_void {
        if refcon.is_null() {
            return event;
        }

        let ctx = unsafe { &*(refcon as *const MouseTapContext) };

        if event_type == TAP_DISABLED_BY_TIMEOUT {
            if !ctx.mach_port.is_null() {
                unsafe { CGEventTapEnable(ctx.mach_port, true) };
            }
            return event;
        }

        if event_type == LEFT_MOUSE_DOWN || event_type == RIGHT_MOUSE_DOWN || event_type == OTHER_MOUSE_DOWN {
            let pt = unsafe { CGEventGetLocation(event) };
            let (tx, ty, tw, th) = ctx.target_rect;

            let local_x = pt.x - tx;
            let local_y = pt.y - ty;

            // Kiểm tra click có nằm trong phạm vi vùng quay không
            if local_x >= 0.0 && local_x <= tw && local_y >= 0.0 && local_y <= th {
                let button = match event_type {
                    LEFT_MOUSE_DOWN => "left",
                    RIGHT_MOUSE_DOWN => "right",
                    _ => "middle",
                };

                let raw_count = unsafe { CGEventGetIntegerValueField(event, MOUSE_CLICK_STATE_FIELD) };
                let count = if raw_count <= 0 { 1 } else { raw_count as u32 };

                let payload = MouseClickPayload {
                    x: local_x,
                    y: local_y,
                    button: button.to_string(),
                    count,
                };

                let _ = ctx.app.emit("record-mouse-click", payload);
            }
        }

        event
    }

    impl MouseClickListener {
        pub fn start(app: AppHandle, target_rect: (f64, f64, f64, f64)) -> Result<Self, String> {
            if !crate::permissions::can_use_accessibility() {
                eprintln!("[SnapDoc][mouse_click] Chưa có quyền Accessibility — đang yêu cầu cấp quyền...");
                crate::permissions::request_accessibility();
            }

            let run_loop: Arc<Mutex<Option<usize>>> = Arc::new(Mutex::new(None));
            let stopped = Arc::new(AtomicBool::new(false));

            let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), String>>();

            let rl_clone = run_loop.clone();
            let stopped_clone = stopped.clone();

            let thread_handle = thread::Builder::new()
                .name("snapdoc-mouse-click-listener".to_string())
                .spawn(move || unsafe {
                    let mut context = Box::new(MouseTapContext {
                        app,
                        mach_port: std::ptr::null_mut(),
                        target_rect,
                    });
                    let context_ptr: *mut MouseTapContext = &mut *context;

                    let events_mask: u64 =
                        (1u64 << LEFT_MOUSE_DOWN) | (1u64 << RIGHT_MOUSE_DOWN) | (1u64 << OTHER_MOUSE_DOWN);

                    let mach_port = CGEventTapCreate(
                        1, // kCGSessionEventTap
                        0, // kCGHeadInsertEventTap
                        1, // kCGEventTapOptionListenOnly
                        events_mask,
                        mouse_event_tap_callback,
                        context_ptr as *mut c_void,
                    );

                    if mach_port.is_null() {
                        eprintln!("[SnapDoc][mouse_click] CGEventTapCreate trả về NULL — cần cấp quyền Accessibility!");
                        let _ = init_tx.send(Err(
                            "Không tạo được EventTap chuột — cần cấp quyền Accessibility (Trợ năng) cho SnapDoc trong Cài đặt hệ thống".to_string(),
                        ));
                        return;
                    }

                    (*context_ptr).mach_port = mach_port;

                    let source = CFMachPortCreateRunLoopSource(std::ptr::null(), mach_port, 0);
                    if source.is_null() {
                        CFRelease(mach_port);
                        let _ = init_tx.send(Err("Không tạo được RunLoopSource cho EventTap chuột".to_string()));
                        return;
                    }

                    let cur_rl = CFRunLoopGetCurrent();
                    if let Ok(mut g) = rl_clone.lock() {
                        *g = Some(cur_rl as usize);
                    }

                    CFRunLoopAddSource(
                        cur_rl,
                        source,
                        core_foundation_sys::runloop::kCFRunLoopCommonModes as *const c_void,
                    );
                    CGEventTapEnable(mach_port, true);

                    eprintln!("[SnapDoc][mouse_click] EventTap chuột đã bật thành công trên CFRunLoop!");
                    let _ = init_tx.send(Ok(()));

                    while !stopped_clone.load(Ordering::Relaxed) {
                        CFRunLoopRun();
                        break;
                    }

                    CFRunLoopRemoveSource(
                        cur_rl,
                        source,
                        core_foundation_sys::runloop::kCFRunLoopCommonModes as *const c_void,
                    );
                    CFRelease(source);
                    CFRelease(mach_port);
                    eprintln!("[SnapDoc][mouse_click] EventTap chuột đã giải phóng sạch sẽ.");
                })
                .map_err(|e| format!("Không khởi động được thread nghe click chuột: {e}"))?;

            match init_rx.recv() {
                Ok(Ok(())) => Ok(MouseClickListener {
                    run_loop,
                    stopped,
                    thread_handle: Some(thread_handle),
                }),
                Ok(Err(err)) => {
                    let _ = thread_handle.join();
                    Err(err)
                }
                Err(_) => {
                    let _ = thread_handle.join();
                    Err("Thread nghe click chuột kết thúc bất thường".to_string())
                }
            }
        }

        pub fn stop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            if let Ok(mut g) = self.run_loop.lock() {
                if let Some(rl_usize) = g.take() {
                    unsafe {
                        CFRunLoopStop(rl_usize as *mut c_void);
                    }
                }
            }
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }
    }

    impl Drop for MouseClickListener {
        fn drop(&mut self) {
            self.stop();
        }
    }
}

// ── Windows Implementation ────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows {
    use super::MouseClickPayload;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HMODULE, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
    };

    static mut HOOK_HANDLE: HHOOK = std::ptr::null_mut();
    static mut APP_HANDLE_FOR_HOOK: Option<AppHandle> = None;
    static mut TARGET_BOUNDS: (f64, f64, f64, f64, f64) = (0.0, 0.0, 0.0, 0.0, 1.0); // (x, y, w, h, scale)
    static mut LAST_CLICK_TIME: u32 = 0;
    static mut LAST_CLICK_POS: (i32, i32) = (0, 0);

    pub struct MouseClickListener {
        thread_id: u32,
        stopped: Arc<AtomicBool>,
        thread_handle: Option<JoinHandle<()>>,
    }

    unsafe extern "system" fn low_level_mouse_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 {
            let msg = w_param as u32;
            if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN {
                let mouse_hook = *(l_param as *const MSLLHOOKSTRUCT);
                let (tx, ty, tw, th, scale) = TARGET_BOUNDS;

                let global_x = mouse_hook.pt.x as f64 / scale;
                let global_y = mouse_hook.pt.y as f64 / scale;

                let local_x = global_x - tx;
                let local_y = global_y - ty;

                if local_x >= 0.0 && local_x <= tw && local_y >= 0.0 && local_y <= th {
                    let button = match msg {
                        WM_LBUTTONDOWN => "left",
                        WM_RBUTTONDOWN => "right",
                        _ => "middle",
                    };

                    let now = mouse_hook.time;
                    let dt = now.saturating_sub(LAST_CLICK_TIME);
                    let dx = (mouse_hook.pt.x - LAST_CLICK_POS.0).abs();
                    let dy = (mouse_hook.pt.y - LAST_CLICK_POS.1).abs();

                    let is_double = dt < 450 && dx < 6 && dy < 6;
                    let count = if is_double { 2 } else { 1 };

                    LAST_CLICK_TIME = now;
                    LAST_CLICK_POS = (mouse_hook.pt.x, mouse_hook.pt.y);

                    if let Some(app) = &APP_HANDLE_FOR_HOOK {
                        let payload = MouseClickPayload {
                            x: local_x,
                            y: local_y,
                            button: button.to_string(),
                            count,
                        };
                        let _ = app.emit("record-mouse-click", payload);
                    }
                }
            }
        }

        CallNextHookEx(HOOK_HANDLE, n_code, w_param, l_param)
    }

    impl MouseClickListener {
        pub fn start(
            app: AppHandle,
            target_rect: (f64, f64, f64, f64),
            scale: f64,
        ) -> Result<Self, String> {
            let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
            let stopped = Arc::new(AtomicBool::new(false));

            let thread_handle = thread::Builder::new()
                .name("snapdoc-win-mouse-click".to_string())
                .spawn(move || unsafe {
                    APP_HANDLE_FOR_HOOK = Some(app);
                    TARGET_BOUNDS = (target_rect.0, target_rect.1, target_rect.2, target_rect.3, scale);

                    let hook = SetWindowsHookExW(
                        WH_MOUSE_LL,
                        Some(low_level_mouse_proc),
                        std::ptr::null_mut() as HMODULE,
                        0,
                    );

                    if hook.is_null() {
                        let _ = tx.send(Err("Không thiết lập được Windows Mouse Hook".to_string()));
                        return;
                    }

                    HOOK_HANDLE = hook;
                    let thread_id = windows_sys::Win32::System::Threading::GetCurrentThreadId();
                    let _ = tx.send(Ok(thread_id));

                    let mut msg: MSG = std::mem::zeroed();
                    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }

                    UnhookWindowsHookEx(HOOK_HANDLE);
                    HOOK_HANDLE = std::ptr::null_mut();
                    APP_HANDLE_FOR_HOOK = None;
                })
                .map_err(|e| format!("Không khởi động được thread nghe chuột: {e}"))?;

            let thread_id = rx
                .recv()
                .map_err(|_| "Không nhận được phản hồi từ thread nghe chuột".to_string())??;

            Ok(MouseClickListener {
                thread_id,
                stopped,
                thread_handle: Some(thread_handle),
            })
        }

        pub fn stop(&mut self) {
            if self.stopped.swap(true, Ordering::SeqCst) {
                return;
            }
            unsafe {
                PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
            }
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }
    }

    impl Drop for MouseClickListener {
        fn drop(&mut self) {
            self.stop();
        }
    }
}

// ── Fallback Implementation (Linux, etc.) ─────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod fallback {
    use tauri::AppHandle;

    pub struct MouseClickListener;

    impl MouseClickListener {
        pub fn start(_app: AppHandle, _target_rect: (f64, f64, f64, f64)) -> Result<Self, String> {
            Ok(MouseClickListener)
        }

        pub fn stop(&mut self) {}
    }
}
