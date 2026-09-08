//! Module lắng nghe sự kiện click và di chuyển chuột toàn cục (Global Mouse Tracker)
//! trong lúc quay màn hình:
//! 1. Hiển thị hiệu ứng sóng lan toả (ripple) trên overlay thời gian thực (`record-mouse-click`).
//! 2. Thu thập luồng dữ liệu sự kiện chuột (Mouse Telemetry: tọa độ, click, drag)
//!    để làm tính năng Auto Focus & Zoom thông minh trong khâu hậu kỳ (VideoTrimmer).
//!
//! macOS: `CGEventTapCreate` (ListenOnly) trên một CFRunLoop thread độc lập.
//! Windows: `SetWindowsHookExW` (WH_MOUSE_LL) trên một Win32 message loop thread.
//! Khác: Stub struct rỗng.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseClickPayload {
    pub x: f64,
    pub y: f64,
    pub button: String,
    pub count: u32,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseTelemetryItem {
    pub t: u64, // ms relative to recording start
    pub x: f64, // pixel position relative to recorded area
    pub y: f64,
    #[serde(rename = "type")]
    pub event_type: String, // "click" | "move" | "drag"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<String>, // "left" | "right" | "middle"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseTelemetryFile {
    pub version: u32,
    pub video_width: u32,
    pub video_height: u32,
    pub duration_ms: u64,
    pub events: Vec<MouseTelemetryItem>,
}

pub fn telemetry_path_for_video(video_path: &Path) -> PathBuf {
    video_path.with_extension("mouse.json")
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
    use super::{MouseClickPayload, MouseTelemetryFile, MouseTelemetryItem};
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
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
        started_at: std::time::Instant,
        events: Arc<Mutex<Vec<MouseTelemetryItem>>>,
        last_x: f64,
        last_y: f64,
        last_time_ms: u64,
    }

    pub struct MouseClickListener {
        run_loop: Arc<Mutex<Option<usize>>>,
        stopped: Arc<AtomicBool>,
        thread_handle: Option<JoinHandle<()>>,
        events: Arc<Mutex<Vec<MouseTelemetryItem>>>,
        pub target_rect: (f64, f64, f64, f64),
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
        fn CFRunLoopWakeUp(rl: *mut c_void);
        fn CFRelease(cf: *const c_void);
    }

    const LEFT_MOUSE_DOWN: u32 = 1;
    const LEFT_MOUSE_UP: u32 = 2;
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const RIGHT_MOUSE_UP: u32 = 4;
    const MOUSE_MOVED: u32 = 5;
    const LEFT_MOUSE_DRAGGED: u32 = 6;
    const RIGHT_MOUSE_DRAGGED: u32 = 7;
    const OTHER_MOUSE_DOWN: u32 = 25;
    const OTHER_MOUSE_UP: u32 = 26;
    const OTHER_MOUSE_DRAGGED: u32 = 27;

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

        let ctx = unsafe { &mut *(refcon as *mut MouseTapContext) };

        if event_type == TAP_DISABLED_BY_TIMEOUT {
            if !ctx.mach_port.is_null() {
                unsafe { CGEventTapEnable(ctx.mach_port, true) };
            }
            return event;
        }

        let pt = unsafe { CGEventGetLocation(event) };
        let (tx, ty, tw, th) = ctx.target_rect;

        let local_x = pt.x - tx;
        let local_y = pt.y - ty;

        // Kiểm tra toạ độ có nằm trong phạm vi vùng quay không
        if local_x >= 0.0 && local_x <= tw && local_y >= 0.0 && local_y <= th {
            let now_ms = ctx.started_at.elapsed().as_millis() as u64;

            if event_type == LEFT_MOUSE_DOWN || event_type == RIGHT_MOUSE_DOWN || event_type == OTHER_MOUSE_DOWN {
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

                if let Ok(mut g) = ctx.events.lock() {
                    g.push(MouseTelemetryItem {
                        t: now_ms,
                        x: local_x,
                        y: local_y,
                        event_type: "click".to_string(),
                        button: Some(button.to_string()),
                        count: Some(count),
                    });
                }

                ctx.last_x = local_x;
                ctx.last_y = local_y;
                ctx.last_time_ms = now_ms;
            } else if event_type == MOUSE_MOVED || event_type == LEFT_MOUSE_DRAGGED || event_type == RIGHT_MOUSE_DRAGGED || event_type == OTHER_MOUSE_DRAGGED {
                let is_drag = event_type != MOUSE_MOVED;
                let dt = now_ms.saturating_sub(ctx.last_time_ms);
                // Giới hạn tần số lấy mẫu tối đa ~60Hz (>= 16ms) và deadband 2px để tránh quá tải
                if dt >= 16 {
                    let dx = local_x - ctx.last_x;
                    let dy = local_y - ctx.last_y;
                    if dx * dx + dy * dy >= 4.0 || is_drag {
                        ctx.last_x = local_x;
                        ctx.last_y = local_y;
                        ctx.last_time_ms = now_ms;

                        let button = if is_drag {
                            Some(if event_type == LEFT_MOUSE_DRAGGED {
                                "left".to_string()
                            } else {
                                "right".to_string()
                            })
                        } else {
                            None
                        };

                        if let Ok(mut g) = ctx.events.lock() {
                            g.push(MouseTelemetryItem {
                                t: now_ms,
                                x: local_x,
                                y: local_y,
                                event_type: if is_drag { "drag".to_string() } else { "move".to_string() },
                                button,
                                count: None,
                            });
                        }
                    }
                }
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
            let events = Arc::new(Mutex::new(Vec::new()));

            let rl_clone = run_loop.clone();
            let stopped_clone = stopped.clone();
            let events_clone = events.clone();

            let thread_handle = thread::Builder::new()
                .name("snapdoc-mouse-click-listener".to_string())
                .spawn(move || unsafe {
                    let context = Box::new(MouseTapContext {
                        app,
                        mach_port: std::ptr::null_mut(),
                        target_rect,
                        started_at: std::time::Instant::now(),
                        events: events_clone,
                        last_x: -999.0,
                        last_y: -999.0,
                        last_time_ms: 0,
                    });
                    let context_ptr = Box::into_raw(context);

                    let events_mask: u64 = (1u64 << LEFT_MOUSE_DOWN)
                        | (1u64 << RIGHT_MOUSE_DOWN)
                        | (1u64 << OTHER_MOUSE_DOWN)
                        | (1u64 << MOUSE_MOVED)
                        | (1u64 << LEFT_MOUSE_DRAGGED)
                        | (1u64 << RIGHT_MOUSE_DRAGGED)
                        | (1u64 << OTHER_MOUSE_DRAGGED);

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
                        let _ = Box::from_raw(context_ptr);
                        let _ = init_tx.send(Err(
                            "Không tạo được EventTap chuột — cần cấp quyền Accessibility (Trợ năng) cho SnapDoc trong Cài đặt hệ thống".to_string(),
                        ));
                        return;
                    }

                    (*context_ptr).mach_port = mach_port;

                    let source = CFMachPortCreateRunLoopSource(std::ptr::null(), mach_port, 0);
                    if source.is_null() {
                        CFRelease(mach_port);
                        let _ = Box::from_raw(context_ptr);
                        let _ = init_tx.send(Err("Không tạo được RunLoopSource cho EventTap chuột".to_string()));
                        return;
                    }

                    let cur_rl = CFRunLoopGetCurrent();
                    if let Ok(mut g) = rl_clone.lock() {
                        *g = Some(cur_rl as usize);
                    }

                    let mode = core_foundation_sys::runloop::kCFRunLoopDefaultMode as *const c_void;
                    CFRunLoopAddSource(cur_rl, source, mode);
                    CGEventTapEnable(mach_port, true);

                    eprintln!("[SnapDoc][mouse_click] EventTap chuột đã bật thành công trên CFRunLoop!");
                    let _ = init_tx.send(Ok(()));

                    while !stopped_clone.load(Ordering::Relaxed) {
                        CFRunLoopRun();
                    }

                    CGEventTapEnable(mach_port, false);
                    CFRunLoopRemoveSource(cur_rl, source, mode);
                    CFRelease(source);
                    CFRelease(mach_port);
                    let _ = Box::from_raw(context_ptr);
                    eprintln!("[SnapDoc][mouse_click] EventTap chuột đã giải phóng sạch sẽ.");
                })
                .map_err(|e| format!("Không khởi động được thread nghe click chuột: {e}"))?;

            match init_rx.recv() {
                Ok(Ok(())) => Ok(MouseClickListener {
                    run_loop,
                    stopped,
                    thread_handle: Some(thread_handle),
                    events,
                    target_rect,
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
            if self.stopped.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Ok(mut g) = self.run_loop.lock() {
                if let Some(rl_usize) = g.take() {
                    unsafe {
                        CFRunLoopStop(rl_usize as *mut c_void);
                        CFRunLoopWakeUp(rl_usize as *mut c_void);
                    }
                }
            }
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }

        pub fn save_telemetry(
            &self,
            video_path: &Path,
            width: u32,
            height: u32,
            duration_ms: u64,
        ) -> Result<PathBuf, String> {
            let out_path = super::telemetry_path_for_video(video_path);
            let events = self
                .events
                .lock()
                .map_err(|_| "Telemetry lock poisoned".to_string())?
                .clone();

            // Chuẩn hoá toạ độ từ logical points (Retina display) sang kích thước pixel thực của video
            let (_tx, _ty, tw, th) = self.target_rect;
            let scale_x = if tw > 1.0 { (width as f64) / tw } else { 1.0 };
            let scale_y = if th > 1.0 { (height as f64) / th } else { 1.0 };

            let scaled_events: Vec<MouseTelemetryItem> = events
                .into_iter()
                .map(|mut ev| {
                    ev.x = (ev.x * scale_x).round();
                    ev.y = (ev.y * scale_y).round();
                    ev
                })
                .collect();

            let file = MouseTelemetryFile {
                version: 1,
                video_width: width,
                video_height: height,
                duration_ms,
                events: scaled_events,
            };
            let json = serde_json::to_string(&file)
                .map_err(|e| format!("Lỗi serialize mouse telemetry: {e}"))?;
            std::fs::write(&out_path, json)
                .map_err(|e| format!("Lỗi ghi file telemetry: {e}"))?;
            eprintln!(
                "[SnapDoc][mouse_tracker] Đã lưu telemetry ({} sự kiện) tại: {}",
                file.events.len(),
                out_path.display()
            );
            Ok(out_path)
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
    use super::{MouseClickPayload, MouseTelemetryFile, MouseTelemetryItem};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HMODULE, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN,
    };

    static mut HOOK_HANDLE: HHOOK = std::ptr::null_mut();
    static APP_HANDLE_FOR_HOOK: Mutex<Option<AppHandle>> = Mutex::new(None);
    static TELEMETRY_EVENTS: Mutex<Option<Arc<Mutex<Vec<MouseTelemetryItem>>>>> = Mutex::new(None);
    static mut TARGET_BOUNDS: (f64, f64, f64, f64, f64) = (0.0, 0.0, 0.0, 0.0, 1.0); // (x, y, w, h, scale)
    static mut LAST_CLICK_TIME: u32 = 0;
    static mut LAST_CLICK_POS: (i32, i32) = (0, 0);

    static mut RECORD_START_INSTANT: Option<std::time::Instant> = None;
    static mut LAST_MOVE_MS: u64 = 0;
    static mut LAST_MOVE_POS: (f64, f64) = (-999.0, -999.0);

    pub struct MouseClickListener {
        thread_id: u32,
        stopped: Arc<AtomicBool>,
        thread_handle: Option<JoinHandle<()>>,
        events: Arc<Mutex<Vec<MouseTelemetryItem>>>,
        pub target_rect: (f64, f64, f64, f64),
    }

    unsafe extern "system" fn low_level_mouse_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 {
            let msg = w_param as u32;
            let mouse_hook = *(l_param as *const MSLLHOOKSTRUCT);
            let (tx, ty, tw, th, scale) = TARGET_BOUNDS;

            let global_x = mouse_hook.pt.x as f64 / scale;
            let global_y = mouse_hook.pt.y as f64 / scale;

            let local_x = global_x - tx;
            let local_y = global_y - ty;

            if local_x >= 0.0 && local_x <= tw && local_y >= 0.0 && local_y <= th {
                let now_ms = RECORD_START_INSTANT
                    .map(|i| i.elapsed().as_millis() as u64)
                    .unwrap_or(0);

                if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN {
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

                    if let Ok(guard) = APP_HANDLE_FOR_HOOK.lock() {
                        if let Some(app) = guard.as_ref() {
                            let payload = MouseClickPayload {
                                x: local_x,
                                y: local_y,
                                button: button.to_string(),
                                count,
                            };
                            let _ = app.emit("record-mouse-click", payload);
                        }
                    }

                    if let Ok(g) = TELEMETRY_EVENTS.lock() {
                        if let Some(ev_arc) = g.as_ref() {
                            if let Ok(mut ev) = ev_arc.lock() {
                                ev.push(MouseTelemetryItem {
                                    t: now_ms,
                                    x: local_x,
                                    y: local_y,
                                    event_type: "click".to_string(),
                                    button: Some(button.to_string()),
                                    count: Some(count),
                                });
                            }
                        }
                    }

                    LAST_MOVE_POS = (local_x, local_y);
                    LAST_MOVE_MS = now_ms;
                } else if msg == WM_MOUSEMOVE {
                    let dt = now_ms.saturating_sub(LAST_MOVE_MS);
                    if dt >= 16 {
                        let dx = local_x - LAST_MOVE_POS.0;
                        let dy = local_y - LAST_MOVE_POS.1;
                        if dx * dx + dy * dy >= 4.0 {
                            LAST_MOVE_POS = (local_x, local_y);
                            LAST_MOVE_MS = now_ms;

                            if let Ok(g) = TELEMETRY_EVENTS.lock() {
                                if let Some(ev_arc) = g.as_ref() {
                                    if let Ok(mut ev) = ev_arc.lock() {
                                        ev.push(MouseTelemetryItem {
                                            t: now_ms,
                                            x: local_x,
                                            y: local_y,
                                            event_type: "move".to_string(),
                                            button: None,
                                            count: None,
                                        });
                                    }
                                }
                            }
                        }
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
            let events = Arc::new(Mutex::new(Vec::new()));
            let stopped = Arc::new(AtomicBool::new(false));

            if let Ok(mut g) = TELEMETRY_EVENTS.lock() {
                *g = Some(events.clone());
            }

            let thread_handle = thread::Builder::new()
                .name("snapdoc-win-mouse-click".to_string())
                .spawn(move || unsafe {
                    if let Ok(mut g) = APP_HANDLE_FOR_HOOK.lock() {
                        *g = Some(app);
                    }
                    TARGET_BOUNDS = (target_rect.0, target_rect.1, target_rect.2, target_rect.3, scale);
                    RECORD_START_INSTANT = Some(std::time::Instant::now());
                    LAST_MOVE_MS = 0;
                    LAST_MOVE_POS = (-999.0, -999.0);

                    let hook = SetWindowsHookExW(
                        WH_MOUSE_LL,
                        Some(low_level_mouse_proc),
                        std::ptr::null_mut() as HMODULE,
                        0,
                    );

                    if hook.is_null() {
                        let _ = tx.send(Err("SetWindowsHookExW thất bại".to_string()));
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

                    if !HOOK_HANDLE.is_null() {
                        UnhookWindowsHookEx(HOOK_HANDLE);
                        HOOK_HANDLE = std::ptr::null_mut();
                    }
                    if let Ok(mut g) = APP_HANDLE_FOR_HOOK.lock() {
                        *g = None;
                    }
                })
                .map_err(|e| format!("Không khởi động được thread nghe click chuột (Win): {e}"))?;

            let thread_id = rx
                .recv()
                .map_err(|_| "Thread hook Win kết thúc bất thường".to_string())??;

            Ok(MouseClickListener {
                thread_id,
                stopped,
                thread_handle: Some(thread_handle),
                events,
                target_rect,
            })
        }

        pub fn stop(&mut self) {
            if self.stopped.swap(true, Ordering::SeqCst) {
                return;
            }
            if self.thread_id != 0 {
                unsafe {
                    PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
                }
                self.thread_id = 0;
            }
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
            if let Ok(mut g) = TELEMETRY_EVENTS.lock() {
                *g = None;
            }
        }

        pub fn save_telemetry(
            &self,
            video_path: &Path,
            width: u32,
            height: u32,
            duration_ms: u64,
        ) -> Result<PathBuf, String> {
            let out_path = super::telemetry_path_for_video(video_path);
            let events = self
                .events
                .lock()
                .map_err(|_| "Telemetry lock poisoned".to_string())?
                .clone();

            // Chuẩn hoá toạ độ từ logical points sang kích thước pixel thực của video
            let (_tx, _ty, tw, th) = self.target_rect;
            let scale_x = if tw > 1.0 { (width as f64) / tw } else { 1.0 };
            let scale_y = if th > 1.0 { (height as f64) / th } else { 1.0 };

            let scaled_events: Vec<MouseTelemetryItem> = events
                .into_iter()
                .map(|mut ev| {
                    ev.x = (ev.x * scale_x).round();
                    ev.y = (ev.y * scale_y).round();
                    ev
                })
                .collect();

            let file = MouseTelemetryFile {
                version: 1,
                video_width: width,
                video_height: height,
                duration_ms,
                events: scaled_events,
            };
            let json = serde_json::to_string(&file)
                .map_err(|e| format!("Lỗi serialize mouse telemetry: {e}"))?;
            std::fs::write(&out_path, json)
                .map_err(|e| format!("Lỗi ghi file telemetry: {e}"))?;
            eprintln!(
                "[SnapDoc][mouse_tracker] Đã lưu telemetry ({} sự kiện) tại: {}",
                file.events.len(),
                out_path.display()
            );
            Ok(out_path)
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
    use std::path::{Path, PathBuf};
    use tauri::AppHandle;

    pub struct MouseClickListener;

    impl MouseClickListener {
        pub fn start(_app: AppHandle, _target_rect: (f64, f64, f64, f64)) -> Result<Self, String> {
            Ok(MouseClickListener)
        }

        pub fn stop(&mut self) {}

        pub fn save_telemetry(
            &self,
            _video_path: &Path,
            _width: u32,
            _height: u32,
            _duration_ms: u64,
        ) -> Result<PathBuf, String> {
            Ok(PathBuf::new())
        }
    }
}
