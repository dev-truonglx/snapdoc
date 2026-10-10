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

fn fnv1a_hash(data: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in data.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Xác định đường dẫn file telemetry focus (.json) cho video.
/// Tách rời khỏi folder video, lưu vào folder riêng nội bộ (`library/focus`)
/// tương tự như folder file gốc của ảnh chụp (`library/assets`).
/// Tên file telemetry chuẩn của 1 video: `{stem}_{hash đường dẫn}.json`.
fn telemetry_file_name(video_path: &Path) -> (String, String) {
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_string();
    let norm = std::fs::canonicalize(video_path).unwrap_or_else(|_| video_path.to_path_buf());
    let hash = fnv1a_hash(&norm.to_string_lossy());
    let filename = format!("{stem}_{hash:016x}.json");
    (stem, filename)
}

/// `true` nếu `name` có dạng ĐÚNG `{stem}_{16 chữ số hex}.json` — tránh nhận
/// nhầm telemetry của `Recording_T_1` khi đang tìm cho `Recording_T` (2 bản
/// quay trong cùng 1 giây được dedupe tên bằng hậu tố `_1`, `_2`...).
fn is_telemetry_of_stem(name: &str, stem: &str) -> bool {
    let Some(rest) = name.strip_prefix(stem).and_then(|r| r.strip_prefix('_')) else { return false };
    let Some(hex) = rest.strip_suffix(".json") else { return false };
    hex.len() == 16 && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// Chỉ trả file telemetry CHẮC CHẮN thuộc video này (đúng hash đường dẫn hoặc
/// file legacy cạnh video) — dùng khi XOÁ, không bao giờ đoán theo tên.
pub fn telemetry_path_strict(app: &tauri::AppHandle, video_path: &Path) -> Option<PathBuf> {
    let (_, filename) = telemetry_file_name(video_path);
    if let Ok(dir) = crate::history::assets::focus_dir(app) {
        let p = dir.join(&filename);
        if p.exists() {
            return Some(p);
        }
    }
    let legacy = video_path.with_extension("mouse.json");
    legacy.exists().then_some(legacy)
}

pub fn telemetry_path_for_video(app: &tauri::AppHandle, video_path: &Path) -> PathBuf {
    let (stem, filename) = telemetry_file_name(video_path);
    let stem = stem.as_str();

    if let Ok(dir) = crate::history::assets::focus_dir(app) {
        let target_path = dir.join(&filename);

        // 1. Ưu tiên file theo đúng hash đường dẫn
        if target_path.exists() {
            return target_path;
        }

        // 2. Fallback: file theo stem đơn thuần (nếu từng lưu dạng {stem}.json)
        let stem_path = dir.join(format!("{stem}.json"));
        if stem_path.exists() {
            return stem_path;
        }

        // 3. Fallback: tìm file `{stem}_{hash}.json` trong thư mục focus (video
        // bị di chuyển/đổi thư mục cha nên hash đường dẫn đổi theo).
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if is_telemetry_of_stem(&name.to_string_lossy(), stem) {
                    return entry.path();
                }
            }
        }

        // 4. Fallback tương thích ngược: file legacy nằm cùng thư mục video (.mouse.json)
        let legacy_path = video_path.with_extension("mouse.json");
        if legacy_path.exists() {
            return legacy_path;
        }

        // Mặc định trả về target_path mới để ghi file mới vào đúng thư mục library/focus
        target_path
    } else {
        video_path.with_extension("mouse.json")
    }
}

#[cfg(target_os = "macos")]
pub use macos::MouseClickListener;

#[cfg(target_os = "windows")]
pub use windows::MouseClickListener;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use fallback::MouseClickListener;

// ── Dùng chung ────────────────────────────────────────────────────────────

/// Bộ đệm telemetry + đồng hồ của phiên quay. `t` của mỗi sự kiện = thời gian
/// ĐÃ GHI (đã trừ pause) theo đồng hồ chung — khớp đúng mốc thời gian trong
/// video. Sự kiện xảy ra trước mốc 0 hoặc trong lúc pause bị bỏ (không có
/// khung hình video tương ứng).
struct Telemetry {
    clock: Arc<RecordingClock>,
    events: Mutex<Vec<MouseTelemetryItem>>,
    last_x: f64,
    last_y: f64,
    last_time_ms: u64,
}

impl Telemetry {
    fn new(clock: Arc<RecordingClock>) -> Self {
        Telemetry { clock, events: Mutex::new(Vec::new()), last_x: -999.0, last_y: -999.0, last_time_ms: 0 }
    }

    /// Thời điểm hiện tại theo đồng hồ phiên quay; `None` nếu chưa bắt đầu/đang pause.
    fn now_ms(&self) -> Option<u64> {
        if self.clock.is_paused() {
            return None;
        }
        self.clock.elapsed_ms()
    }

    fn click(&mut self, x: f64, y: f64, button: &'static str, count: u32) {
        let Some(t) = self.now_ms() else { return };
        self.events.lock().unwrap_or_else(|p| p.into_inner()).push(MouseTelemetryItem {
            t,
            x,
            y,
            event_type: "click".to_string(),
            button: Some(button.to_string()),
            count: Some(count),
        });
        self.last_x = x;
        self.last_y = y;
        self.last_time_ms = t;
    }

    /// `drag_button`: `Some` khi đang giữ chuột (kéo thả).
    fn motion(&mut self, x: f64, y: f64, drag_button: Option<&'static str>) {
        let Some(t) = self.now_ms() else { return };
        // Giới hạn ~60Hz (>= 16ms) và deadband 2px để tránh quá tải.
        if t.saturating_sub(self.last_time_ms) < 16 {
            return;
        }
        let (dx, dy) = (x - self.last_x, y - self.last_y);
        if dx * dx + dy * dy < 4.0 && drag_button.is_none() {
            return;
        }
        self.last_x = x;
        self.last_y = y;
        self.last_time_ms = t;
        self.events.lock().unwrap_or_else(|p| p.into_inner()).push(MouseTelemetryItem {
            t,
            x,
            y,
            event_type: if drag_button.is_some() { "drag" } else { "move" }.to_string(),
            button: drag_button.map(|b| b.to_string()),
            count: None,
        });
    }
}

/// Ghi telemetry ra file, quy đổi toạ độ từ đơn vị của vùng quay (`rect_size`)
/// sang pixel thật của video.
fn write_telemetry(
    app: &tauri::AppHandle,
    events: Vec<MouseTelemetryItem>,
    rect_size: (f64, f64),
    video_path: &Path,
    width: u32,
    height: u32,
    duration_ms: u64,
) -> Result<PathBuf, String> {
    let out_path = telemetry_path_for_video(app, video_path);
    let (tw, th) = rect_size;
    let scale_x = if tw > 1.0 { (width as f64) / tw } else { 1.0 };
    let scale_y = if th > 1.0 { (height as f64) / th } else { 1.0 };
    let events: Vec<MouseTelemetryItem> = events
        .into_iter()
        .filter(|ev| ev.t <= duration_ms)
        .map(|mut ev| {
            ev.x = (ev.x * scale_x).round();
            ev.y = (ev.y * scale_y).round();
            ev
        })
        .collect();
    let file = MouseTelemetryFile { version: 1, video_width: width, video_height: height, duration_ms, events };
    let json = serde_json::to_string(&file).map_err(|e| format!("Lỗi serialize mouse telemetry: {e}"))?;
    std::fs::write(&out_path, json).map_err(|e| format!("Lỗi ghi file telemetry: {e}"))?;

    // Đảm bảo không còn file legacy sót lại trong folder video
    let legacy_path = video_path.with_extension("mouse.json");
    if legacy_path.exists() && legacy_path != out_path {
        let _ = std::fs::remove_file(&legacy_path);
    }
    eprintln!(
        "[SnapDoc][mouse_tracker] Đã lưu telemetry ({} sự kiện) tại: {}",
        file.events.len(),
        out_path.display()
    );
    Ok(out_path)
}

use super::clock::RecordingClock;
use super::SharedRect;
use std::sync::{Arc, Mutex};

// ── macOS Implementation ──────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::{MouseClickPayload, SharedRect, Telemetry};
    use crate::record::clock::RecordingClock;
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
        rect: SharedRect,
        telemetry: Arc<Mutex<Telemetry>>,
    }

    pub struct MouseClickListener {
        stopped: Arc<AtomicBool>,
        thread_handle: Option<JoinHandle<()>>,
        telemetry: Arc<Mutex<Telemetry>>,
        rect_size: (f64, f64),
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
        fn CFMachPortInvalidate(port: *mut c_void);
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRemoveSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source_handled: u8) -> i32;
        fn CFRelease(cf: *const c_void);
    }

    const LEFT_MOUSE_DOWN: u32 = 1;
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const MOUSE_MOVED: u32 = 5;
    const LEFT_MOUSE_DRAGGED: u32 = 6;
    const RIGHT_MOUSE_DRAGGED: u32 = 7;
    const OTHER_MOUSE_DOWN: u32 = 25;
    const OTHER_MOUSE_DRAGGED: u32 = 27;

    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFFFFFF;
    // kCGMouseEventClickState trong CoreGraphics là 1
    const MOUSE_CLICK_STATE_FIELD: u32 = 1;
    /// `kCFRunLoopRunFinished` — run loop không còn source nào.
    const RUN_FINISHED: i32 = 1;

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

        if event_type == TAP_DISABLED_BY_TIMEOUT || event_type == TAP_DISABLED_BY_USER_INPUT {
            if !ctx.mach_port.is_null() {
                unsafe { CGEventTapEnable(ctx.mach_port, true) };
            }
            return event;
        }

        let pt = unsafe { CGEventGetLocation(event) };
        let (tx, ty, tw, th) = *ctx.rect.lock().unwrap_or_else(|p| p.into_inner());
        let local_x = pt.x - tx;
        let local_y = pt.y - ty;
        if !(local_x >= 0.0 && local_x <= tw && local_y >= 0.0 && local_y <= th) {
            return event;
        }

        match event_type {
            LEFT_MOUSE_DOWN | RIGHT_MOUSE_DOWN | OTHER_MOUSE_DOWN => {
                let button = match event_type {
                    LEFT_MOUSE_DOWN => "left",
                    RIGHT_MOUSE_DOWN => "right",
                    _ => "middle",
                };
                let raw_count = unsafe { CGEventGetIntegerValueField(event, MOUSE_CLICK_STATE_FIELD) };
                let count = if raw_count <= 0 { 1 } else { raw_count as u32 };
                let _ = ctx.app.emit(
                    "record-mouse-click",
                    MouseClickPayload { x: local_x, y: local_y, button: button.to_string(), count },
                );
                ctx.telemetry.lock().unwrap_or_else(|p| p.into_inner()).click(local_x, local_y, button, count);
            }
            MOUSE_MOVED | LEFT_MOUSE_DRAGGED | RIGHT_MOUSE_DRAGGED | OTHER_MOUSE_DRAGGED => {
                let drag = match event_type {
                    LEFT_MOUSE_DRAGGED => Some("left"),
                    RIGHT_MOUSE_DRAGGED => Some("right"),
                    OTHER_MOUSE_DRAGGED => Some("middle"),
                    _ => None,
                };
                ctx.telemetry.lock().unwrap_or_else(|p| p.into_inner()).motion(local_x, local_y, drag);
            }
            _ => {}
        }
        event
    }

    impl MouseClickListener {
        /// Event tap chuột ListenOnly KHÔNG cần quyền Accessibility (chỉ phím
        /// mới cần) — không tự bật hộp thoại xin quyền ở mỗi lần quay như bản
        /// cũ (hộp thoại đó còn có thể lọt vào chính video).
        pub fn start(app: AppHandle, rect: SharedRect, clock: Arc<RecordingClock>, _scale: f64) -> Result<Self, String> {
            let stopped = Arc::new(AtomicBool::new(false));
            let rect_size = {
                let r = rect.lock().unwrap_or_else(|p| p.into_inner());
                (r.2, r.3)
            };
            let telemetry = Arc::new(Mutex::new(Telemetry::new(clock)));
            let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let stopped_clone = stopped.clone();
            let telemetry_clone = telemetry.clone();

            let thread_handle = thread::Builder::new()
                .name("snapdoc-mouse-click-listener".to_string())
                .spawn(move || unsafe {
                    let context_ptr = Box::into_raw(Box::new(MouseTapContext {
                        app,
                        mach_port: std::ptr::null_mut(),
                        rect,
                        telemetry: telemetry_clone,
                    }));

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
                        drop(Box::from_raw(context_ptr));
                        let _ = init_tx.send(Err("Không tạo được EventTap chuột".to_string()));
                        return;
                    }
                    (*context_ptr).mach_port = mach_port;

                    let source = CFMachPortCreateRunLoopSource(std::ptr::null(), mach_port, 0);
                    if source.is_null() {
                        CFMachPortInvalidate(mach_port);
                        CFRelease(mach_port);
                        drop(Box::from_raw(context_ptr));
                        let _ = init_tx.send(Err("Không tạo được RunLoopSource cho EventTap chuột".to_string()));
                        return;
                    }

                    let cur_rl = CFRunLoopGetCurrent();
                    let mode = core_foundation_sys::runloop::kCFRunLoopDefaultMode as *const c_void;
                    CFRunLoopAddSource(cur_rl, source, mode);
                    CGEventTapEnable(mach_port, true);
                    let _ = init_tx.send(Ok(()));

                    // Chạy run loop từng lát 100ms rồi kiểm tra cờ dừng — không
                    // cần chia sẻ con trỏ run loop ra ngoài để `CFRunLoopStop`
                    // (bản cũ có race: stop trước khi `CFRunLoopRun` bắt đầu thì
                    // treo vĩnh viễn, và quay vòng 100% CPU nếu source bị huỷ).
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
                    drop(Box::from_raw(context_ptr));
                })
                .map_err(|e| format!("Không khởi động được thread nghe click chuột: {e}"))?;

            match init_rx.recv() {
                Ok(Ok(())) => Ok(MouseClickListener { stopped, thread_handle: Some(thread_handle), telemetry, rect_size }),
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
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }

        pub fn save_telemetry(
            &self,
            app: &AppHandle,
            video_path: &Path,
            width: u32,
            height: u32,
            duration_ms: u64,
        ) -> Result<PathBuf, String> {
            let events = {
                let t = self.telemetry.lock().unwrap_or_else(|p| p.into_inner());
                let mut g = t.events.lock().unwrap_or_else(|p| p.into_inner());
                std::mem::take(&mut *g)
            };
            super::write_telemetry(app, events, self.rect_size, video_path, width, height, duration_ms)
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
    use super::{MouseClickPayload, SharedRect, Telemetry};
    use crate::record::clock::RecordingClock;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HMODULE, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, GetSystemMetrics, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, SM_CXDOUBLECLK, SM_CYDOUBLECLK, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    /// Trạng thái dùng chung giữa hook proc (chạy trên thread hook) và listener.
    struct HookCtx {
        /// Thế hệ listener sở hữu ctx — thread hook cũ (không dừng được kịp)
        /// không được xoá ctx của listener mới.
        gen: u64,
        app: AppHandle,
        rect: SharedRect,
        scale: f64,
        telemetry: Arc<Mutex<Telemetry>>,
        // Theo dõi double-click / kéo thả (chỉ thread hook đụng tới).
        last_click_time: u32,
        last_click_pos: (i32, i32),
        last_click_button: u32,
        buttons_down: u32,
        dbl_time: u32,
        dbl_cx: i32,
        dbl_cy: i32,
    }

    static CTX: Mutex<Option<HookCtx>> = Mutex::new(None);
    static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn clear_ctx_if(gen: u64) {
        let mut g = CTX.lock().unwrap_or_else(|p| p.into_inner());
        if g.as_ref().map(|c| c.gen == gen).unwrap_or(false) {
            *g = None;
        }
    }

    pub struct MouseClickListener {
        thread_id: u32,
        stopped: Arc<AtomicBool>,
        thread_handle: Option<JoinHandle<()>>,
        telemetry: Arc<Mutex<Telemetry>>,
        rect_size: (f64, f64),
    }

    unsafe extern "system" fn low_level_mouse_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
        if n_code >= 0 {
            let msg = w_param as u32;
            let hook = *(l_param as *const MSLLHOOKSTRUCT);
            if let Ok(mut guard) = CTX.lock() {
                if let Some(ctx) = guard.as_mut() {
                    handle_event(ctx, msg, &hook);
                }
            }
        }
        // Tham số hook đầu tiên bị bỏ qua từ Windows NT — không cần handle toàn cục.
        CallNextHookEx(std::ptr::null_mut() as HHOOK, n_code, w_param, l_param)
    }

    fn button_of(msg: u32) -> Option<(u32, &'static str, bool)> {
        // (bit, tên, là nhấn xuống)
        match msg {
            WM_LBUTTONDOWN => Some((1, "left", true)),
            WM_LBUTTONUP => Some((1, "left", false)),
            WM_RBUTTONDOWN => Some((2, "right", true)),
            WM_RBUTTONUP => Some((2, "right", false)),
            WM_MBUTTONDOWN => Some((4, "middle", true)),
            WM_MBUTTONUP => Some((4, "middle", false)),
            _ => None,
        }
    }

    fn handle_event(ctx: &mut HookCtx, msg: u32, hook: &MSLLHOOKSTRUCT) {
        if let Some((bit, _, false)) = button_of(msg) {
            ctx.buttons_down &= !bit;
            return;
        }
        let (tx, ty, tw, th) = *ctx.rect.lock().unwrap_or_else(|p| p.into_inner());
        let local_x = hook.pt.x as f64 - tx;
        let local_y = hook.pt.y as f64 - ty;
        let inside = local_x >= 0.0 && local_x <= tw && local_y >= 0.0 && local_y <= th;

        if let Some((bit, button, true)) = button_of(msg) {
            ctx.buttons_down |= bit;
            if !inside {
                return;
            }
            let dt = hook.time.wrapping_sub(ctx.last_click_time);
            let dx = (hook.pt.x - ctx.last_click_pos.0).abs();
            let dy = (hook.pt.y - ctx.last_click_pos.1).abs();
            let is_double =
                ctx.last_click_button == bit && dt <= ctx.dbl_time && dx <= ctx.dbl_cx / 2 && dy <= ctx.dbl_cy / 2;
            let count = if is_double { 2 } else { 1 };
            // Sau 1 double-click, lần bấm kế tiếp tính lại từ đầu.
            ctx.last_click_time = if is_double { 0 } else { hook.time };
            ctx.last_click_pos = (hook.pt.x, hook.pt.y);
            ctx.last_click_button = bit;

            let _ = ctx.app.emit(
                "record-mouse-click",
                MouseClickPayload { x: local_x / ctx.scale, y: local_y / ctx.scale, button: button.to_string(), count },
            );
            ctx.telemetry.lock().unwrap_or_else(|p| p.into_inner()).click(local_x, local_y, button, count);
        } else if msg == WM_MOUSEMOVE && inside {
            let drag = if ctx.buttons_down & 1 != 0 {
                Some("left")
            } else if ctx.buttons_down & 2 != 0 {
                Some("right")
            } else if ctx.buttons_down & 4 != 0 {
                Some("middle")
            } else {
                None
            };
            ctx.telemetry.lock().unwrap_or_else(|p| p.into_inner()).motion(local_x, local_y, drag);
        }
    }

    impl MouseClickListener {
        pub fn start(app: AppHandle, rect: SharedRect, clock: Arc<RecordingClock>, scale: f64) -> Result<Self, String> {
            let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
            let stopped = Arc::new(AtomicBool::new(false));
            let rect_size = {
                let r = rect.lock().unwrap_or_else(|p| p.into_inner());
                (r.2, r.3)
            };
            let telemetry = Arc::new(Mutex::new(Telemetry::new(clock)));
            let (dbl_time, dbl_cx, dbl_cy) =
                unsafe { (GetDoubleClickTime(), GetSystemMetrics(SM_CXDOUBLECLK), GetSystemMetrics(SM_CYDOUBLECLK)) };
            let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
            *CTX.lock().unwrap_or_else(|p| p.into_inner()) = Some(HookCtx {
                gen,
                app,
                rect,
                scale: if scale > 0.0 { scale } else { 1.0 },
                telemetry: telemetry.clone(),
                last_click_time: 0,
                last_click_pos: (i32::MIN / 2, i32::MIN / 2),
                last_click_button: 0,
                buttons_down: 0,
                dbl_time: if dbl_time == 0 { 500 } else { dbl_time },
                dbl_cx: dbl_cx.max(4),
                dbl_cy: dbl_cy.max(4),
            });

            let thread_handle = thread::Builder::new()
                .name("snapdoc-win-mouse-click".to_string())
                .spawn(move || unsafe {
                    let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), std::ptr::null_mut() as HMODULE, 0);
                    if hook.is_null() {
                        clear_ctx_if(gen);
                        let _ = tx.send(Err("SetWindowsHookExW thất bại".to_string()));
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
                    clear_ctx_if(gen);
                })
                .map_err(|e| {
                    clear_ctx_if(gen);
                    format!("Không khởi động được thread nghe click chuột (Win): {e}")
                })?;

            let thread_id = match rx.recv() {
                Ok(Ok(id)) => id,
                Ok(Err(e)) => {
                    let _ = thread_handle.join();
                    return Err(e);
                }
                Err(_) => {
                    let _ = thread_handle.join();
                    clear_ctx_if(gen);
                    return Err("Thread hook Win kết thúc bất thường".to_string());
                }
            };

            Ok(MouseClickListener { thread_id, stopped, thread_handle: Some(thread_handle), telemetry, rect_size })
        }

        pub fn stop(&mut self) {
            if self.stopped.swap(true, Ordering::SeqCst) {
                return;
            }
            let posted = super::super::keystroke::post_quit(self.thread_id);
            if let Some(handle) = self.thread_handle.take() {
                if posted {
                    let _ = handle.join();
                } else {
                    // Không gửi được WM_QUIT — không join (tránh treo cả luồng dừng quay).
                    eprintln!("[SnapDoc][mouse_click] Không dừng được thread hook chuột");
                }
            }
        }

        pub fn save_telemetry(
            &self,
            app: &AppHandle,
            video_path: &Path,
            width: u32,
            height: u32,
            duration_ms: u64,
        ) -> Result<PathBuf, String> {
            let events = {
                let t = self.telemetry.lock().unwrap_or_else(|p| p.into_inner());
                let mut g = t.events.lock().unwrap_or_else(|p| p.into_inner());
                std::mem::take(&mut *g)
            };
            super::write_telemetry(app, events, self.rect_size, video_path, width, height, duration_ms)
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
    use super::SharedRect;
    use crate::record::clock::RecordingClock;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use tauri::AppHandle;

    pub struct MouseClickListener;

    impl MouseClickListener {
        pub fn start(_app: AppHandle, _rect: SharedRect, _clock: Arc<RecordingClock>, _scale: f64) -> Result<Self, String> {
            Ok(MouseClickListener)
        }

        pub fn stop(&mut self) {}

        pub fn save_telemetry(
            &self,
            _app: &AppHandle,
            _video_path: &Path,
            _width: u32,
            _height: u32,
            _duration_ms: u64,
        ) -> Result<PathBuf, String> {
            Ok(PathBuf::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_stem_match_is_strict() {
        assert!(is_telemetry_of_stem("Recording_T_0123456789abcdef.json", "Recording_T"));
        assert!(!is_telemetry_of_stem("Recording_T_1_0123456789abcdef.json", "Recording_T"));
        assert!(!is_telemetry_of_stem("Recording_T_xyz.json", "Recording_T"));
    }

    #[test]
    fn telemetry_skips_pause_and_uses_clock() {
        let clock = RecordingClock::new();
        let mut t = Telemetry::new(clock.clone());
        t.click(1.0, 1.0, "left", 1); // trước mốc 0 → bỏ
        clock.start();
        std::thread::sleep(std::time::Duration::from_millis(30));
        t.click(2.0, 2.0, "left", 1);
        clock.pause();
        t.click(3.0, 3.0, "left", 1); // đang pause → bỏ
        std::thread::sleep(std::time::Duration::from_millis(200));
        clock.resume();
        t.click(4.0, 4.0, "left", 1);
        let ev = t.events.lock().unwrap();
        assert_eq!(ev.len(), 2);
        assert!(ev[1].t < 150, "200ms pause không được tính vào t: {}", ev[1].t);
    }
}
