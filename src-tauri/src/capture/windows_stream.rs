//! Windows: quay video liên tục bằng Windows.Graphics.Capture (WGC) qua crate
//! `windows-capture` — vai trò tương đương `mac_stream.rs` bên macOS
//! (ScreenCaptureKit `SCStream`). Xem plan Phase 5
//! (`.claude/plans/sprightly-yawning-ritchie.md`) để hiểu lý do chọn WGC thay
//! vì DXGI Desktop Duplication.
//!
//! GIAI ĐOẠN 1+2+4 (hiện tại): hỗ trợ cả 3 `RecordTarget` (`Display`,
//! `Window`, `Region`), CHƯA có audio hệ thống (tham số `capture_system_audio`
//! bị bỏ qua — giai đoạn 5/6 của plan).
//!
//! KIẾN TRÚC FRAME PACING — khác biệt quan trọng với `mac_stream.rs`:
//! ScreenCaptureKit gửi frame ĐỀU theo `minimumFrameInterval` bất kể nội dung
//! màn hình có đổi hay không, nhưng WGC (`on_frame_arrived`) chỉ gọi callback
//! khi nội dung THỰC SỰ thay đổi — nếu ghi thẳng từng frame nhận được vào
//! encoder (giả định 1 frame = 1/fps giây, đúng như macOS), video quay ra sẽ
//! bị "tua nhanh": vd 30 giây quay thực tế nhưng màn hình ít đổi chỉ sinh ra
//! ~90 frame → ffmpeg (không có timestamp thật, chỉ đếm frame/fps) tính ra
//! đúng 3 giây video, y hệt nội dung nhưng bị nén thời gian. Cách sửa: TÁCH
//! RIÊNG "WGC cập nhật nội dung mới nhất" (`on_frame_arrived` chỉ ghi vào
//! `latest`) khỏi "nhịp đẩy vào encoder" (`spawn_ticker` chạy đúng `fps`
//! lần/giây, mỗi nhịp lấy `latest` hiện có — LẶP LẠI frame cũ nếu WGC chưa
//! gửi gì mới — rồi mới đẩy vào channel `Frame`).
//!
//! LƯU Ý: `Settings::new` (8 tham số) và `capture.rs` (`CaptureControl`,
//! `start_free_threaded`, `Context`) đã đối chiếu đúng với source thật của
//! crate `windows-capture` cài trên máy Windows dùng để build. Phần còn lại
//! (`Monitor::enumerate`, `FrameBuffer::as_raw_buffer`) vẫn viết theo API đã
//! biết lúc lên plan, CHƯA đối chiếu source thật — môi trường phát triển hiện
//! tại là macOS nên không build/test được trên Windows. Nếu lệch, sửa theo
//! lỗi biên dịch của `cargo check` trên máy Windows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor as WgcMonitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window as WgcWindow;
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};

/// Phạm vi quay — cùng hình dạng với `mac_stream::RecordTarget` để
/// `record/mod.rs` dùng chung 1 kiểu dispatch cho cả 2 nền tảng.
pub enum RecordTarget {
    /// Toàn bộ 1 màn hình, `display_id` là id từ `xcap::Monitor::id()` (cùng
    /// id dùng cho overlay chọn màn hình + chụp ảnh).
    Display(u32),
    /// 1 vùng trong 1 màn hình — `x,y,w,h` là pixel vật lý, LOCAL theo gốc
    /// màn hình (cùng hệ toạ độ `flow::finalize_region` đã tính cho chụp ảnh
    /// vùng). WGC không có `sourceRect` như SCStream nên `start()` quay
    /// nguyên `display_id` rồi tự crop trong `on_frame_arrived`.
    Region { display_id: u32, x: f64, y: f64, w: f64, h: f64 },
    /// 1 cửa sổ theo id từ `xcap::Window::id()`, map sang `HWND` trong
    /// `resolve_window`.
    Window(u32),
}

/// Một frame video thô: BGRA, chưa nén — cùng định dạng với `mac_stream::Frame`
/// nên `encoder.rs` (ffmpeg `-pix_fmt bgra`) không cần biết frame đến từ nền
/// tảng nào. `Clone` để `spawn_ticker` có thể gửi LẠI cùng nội dung cho nhiều
/// nhịp liên tiếp khi WGC chưa cập nhật frame mới (xem doc-comment đầu file).
#[derive(Clone)]
pub struct Frame {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Làm tròn XUỐNG số chẵn gần nhất — `libx264` + `-pix_fmt yuv420p` (chroma
/// subsampling 4:2:0) bắt buộc width/height chẵn, trong khi 1 cửa sổ thực tế
/// có thể có kích thước lẻ bất kỳ (vd 581px) → ffmpeg từ chối mở encoder
/// ("width not divisible by 2") nếu truyền thẳng. Lệch 1px là không đáng kể.
fn even_floor(v: u32) -> u32 {
    v & !1
}

struct CapturerFlags {
    /// Nội dung frame MỚI NHẤT WGC đã gửi — `on_frame_arrived` chỉ cập nhật
    /// chỗ này, KHÔNG tự đẩy vào channel (xem doc-comment đầu file).
    /// Bọc `Arc<Frame>` để `spawn_ticker` lặp lại frame cũ chỉ tốn chi phí clone
    /// con trỏ Arc (8 bytes) thay vì deep-copy mảng byte lớn.
    latest: Arc<Mutex<Option<Arc<Frame>>>>,
    stopped_externally: Arc<AtomicBool>,
    /// Kích thước ĐÃ làm tròn chẵn, khớp đúng `-s WxH` đã khai với `Encoder`
    /// lúc `start()` — MỌI frame gửi đi phải đúng kích thước này (không phải
    /// kích thước WGC thực báo qua `frame.width()/height()`), nếu không
    /// `record/mod.rs` sẽ coi là "sai kích thước" và bỏ hết frame.
    target_width: u32,
    target_height: u32,
    /// Toạ độ góc trên-trái của vùng cần crop trong frame WGC trả về (pixel
    /// vật lý). `(0, 0)` cho `Display`/`Window` (lấy nguyên góc trái); khác 0
    /// chỉ khi quay `Region` (WGC không có `sourceRect` như SCStream — phải
    /// quay nguyên màn hình rồi tự crop ở đây, xem `RecordTarget::Region`).
    crop_x: u32,
    crop_y: u32,
}

struct Capturer {
    latest: Arc<Mutex<Option<Arc<Frame>>>>,
    stopped_externally: Arc<AtomicBool>,
    target_width: u32,
    target_height: u32,
    crop_x: u32,
    crop_y: u32,
}

impl GraphicsCaptureApiHandler for Capturer {
    type Flags = CapturerFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            latest: ctx.flags.latest,
            stopped_externally: ctx.flags.stopped_externally,
            target_width: ctx.flags.target_width,
            target_height: ctx.flags.target_height,
            crop_x: ctx.flags.crop_x,
            crop_y: ctx.flags.crop_y,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WgcFrame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let src_width = frame.width();
        let src_height = frame.height();
        let mut buffer = frame.buffer()?;
        // `as_raw_buffer()` trả buffer thô CÓ THỂ pad cuối mỗi hàng (row
        // pitch của staging texture D3D11 không nhất thiết bằng width*4) —
        // tự copy đúng row_len mỗi hàng, bỏ phần đệm, giống hệt cách
        // `mac_stream.rs` xử lý cho IOSurface. Suy ra row_pitch từ
        // `raw.len() / src_height` vì buffer luôn có đúng `src_height *
        // row_pitch` byte (không có API đọc row_pitch trực tiếp).
        let raw = buffer.as_raw_buffer();
        let row_pitch = if src_height == 0 { (src_width as usize) * 4 } else { raw.len() / src_height as usize };
        // Guard: `row_pitch` suy ra bằng phép chia SÀN — nếu `raw.len()`
        // không chia hết cho `src_height` (hoặc WGC báo kích thước lệch với
        // buffer thật), slice `raw[src_off..]` bên dưới có thể vượt biên →
        // panic NGAY TRONG callback FFI (unwind qua biên C++ = UB/abort cả
        // app). Bỏ frame lệch còn hơn sập giữa phiên quay.
        if row_pitch < (src_width as usize) * 4 || raw.len() < (src_height as usize) * row_pitch {
            return Ok(());
        }

        // Luôn crop/pad về ĐÚNG (target_width, target_height) đã khai với
        // encoder, bắt đầu từ (crop_x, crop_y) — vừa xử lý việc làm tròn chẵn
        // ở trên, vừa tự chịu được nếu WGC báo kích thước frame thật lệch vài
        // pixel so với lúc ước tính ban đầu (`window_capture_size`/
        // `monitor.width()`), vừa là bước crop THẬT cho `RecordTarget::Region`
        // (crop_x/crop_y > 0) — thay vì bị `record/mod.rs` bỏ hết frame vì
        // "sai kích thước".
        let avail_w = src_width.saturating_sub(self.crop_x);
        let avail_h = src_height.saturating_sub(self.crop_y);
        let copy_w = self.target_width.min(avail_w) as usize;
        let copy_h = self.target_height.min(avail_h) as usize;
        let dst_row_len = (self.target_width as usize) * 4;
        let copy_row_bytes = copy_w * 4;
        let mut bgra = vec![0u8; dst_row_len * self.target_height as usize];
        for y in 0..copy_h {
            let src_off = (y + self.crop_y as usize) * row_pitch + (self.crop_x as usize) * 4;
            let dst_off = y * dst_row_len;
            bgra[dst_off..dst_off + copy_row_bytes].copy_from_slice(&raw[src_off..src_off + copy_row_bytes]);
        }

        // `unwrap_or_else(into_inner)`: 1 lần panic ở holder khác làm poison
        // mutex — `unwrap()` ở đây sẽ panic DÂY CHUYỀN trong callback FFI
        // (abort). Dữ liệu chỉ là "frame mới nhất", ghi đè an toàn kể cả sau
        // poison. Bọc `Arc::new` để ticker chia sẻ dữ liệu zero-copy.
        *self.latest.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Arc::new(Frame { bgra, width: self.target_width, height: self.target_height }));
        Ok(())
    }

    /// WGC gọi khi phiên capture kết thúc NGOÀI Ý MUỐN (màn hình bị ngắt,
    /// đổi cấu hình hiển thị...) — KHÔNG gọi khi ta tự `stop()` (đường đó đi
    /// qua `CaptureControl::stop()`, không qua callback này), giống hệt vai
    /// trò `stream:didStopWithError:` bên macOS.
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.stopped_externally.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Thread đếm nhịp đúng `interval` (= 1/fps giây) — MỖI NHỊP lấy frame mới
/// nhất `Capturer` đã ghi vào `latest` (lặp lại frame cũ nếu WGC chưa gửi gì
/// mới kể từ nhịp trước) rồi đẩy vào `frame_tx`.
fn spawn_ticker(
    frame_tx: mpsc::SyncSender<Arc<Frame>>,
    latest: Arc<Mutex<Option<Arc<Frame>>>>,
    dropped: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    interval: Duration,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let start = Instant::now();
        let mut frame_index: u32 = 0;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let target_time = start + interval * frame_index;
            let now = Instant::now();
            if target_time > now {
                std::thread::sleep((target_time - now).min(Duration::from_millis(20)));
                continue;
            }
            frame_index = frame_index.wrapping_add(1).max(
                ((now - start).as_nanos() / interval.as_nanos().max(1)) as u32,
            );

            let frame = latest.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some(frame) = frame {
                if frame_tx.try_send(frame).is_err() {
                    dropped.store(true, Ordering::Relaxed);
                }
            }
        }
    })
}

/// Tìm `windows_capture::monitor::Monitor` khớp `display_id` (id từ
/// `xcap::Monitor::id()`, dùng chung cho overlay chọn màn hình). Windows-capture
/// không có API "tạo theo id của xcap" — đối chiếu qua VỊ TRÍ trong danh sách
/// liệt kê của cả 2 crate (giả định thứ tự liệt kê giống nhau vì cùng dựa
/// trên `EnumDisplayMonitors` của hệ điều hành — CẦN xác minh trên máy thật,
/// xem mục "Xác định monitor/window" trong plan Phase 5; nếu lệch, đổi sang
/// đối chiếu theo toạ độ/kích thước màn hình thay vì theo vị trí index).
fn resolve_monitor(display_id: u32) -> Result<WgcMonitor, String> {
    let mut wgc_monitors = WgcMonitor::enumerate().map_err(|e| format!("Không liệt kê được màn hình (WGC): {e}"))?;
    if wgc_monitors.is_empty() {
        return WgcMonitor::primary().map_err(|e| format!("Không tìm thấy màn hình để quay: {e}"));
    }
    if wgc_monitors.len() == 1 {
        return Ok(wgc_monitors.remove(0));
    }

    let xcap_monitors = xcap::Monitor::all().map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    let target = xcap_monitors
        .iter()
        .enumerate()
        .find(|(_, m)| m.id().map(|i| i == display_id).unwrap_or(false));

    if let Some((index, xcap_m)) = target {
        // Kích thước của màn hình cần quay theo xcap — dùng để XÁC MINH ứng
        // viên WGC, vì thứ tự liệt kê giữa 2 crate KHÔNG được đảm bảo giống
        // nhau: cùng dựa trên EnumDisplayMonitors nhưng khác phiên bản/filter
        // có thể lệch → quay nhầm màn hình trên setup nhiều màn hình.
        let want_w = xcap_m.width().unwrap_or(0);
        let want_h = xcap_m.height().unwrap_or(0);

        // Ưu tiên 1: đúng index VÀ khớp kích thước (trường hợp bình thường).
        // Ưu tiên 2: bất kỳ monitor WGC nào khớp kích thước duy nhất — cứu
        // được trường hợp 2 danh sách lệch thứ tự (miễn các màn hình không
        // trùng độ phân giải). Cuối cùng mới rơi về đúng index bất kể kích
        // thước (hành vi cũ), rồi primary.
        let size_of = |m: &WgcMonitor| -> (u32, u32) {
            (m.width().unwrap_or(0), m.height().unwrap_or(0))
        };
        let by_index_ok = wgc_monitors
            .get(index)
            .map(|m| want_w > 0 && size_of(m) == (want_w, want_h))
            .unwrap_or(false);
        if by_index_ok {
            return wgc_monitors.into_iter().nth(index)
                .ok_or_else(|| format!("Không lấy được monitor theo index {index}"));
        }
        if want_w > 0 {
            let matches: Vec<usize> = wgc_monitors
                .iter()
                .enumerate()
                .filter(|(_, m)| size_of(m) == (want_w, want_h))
                .map(|(i, _)| i)
                .collect();
            if matches.len() == 1 {
                return wgc_monitors.into_iter().nth(matches[0])
                    .ok_or_else(|| format!("Không lấy được monitor theo index {}", matches[0]));
            }
        }
        if let Some(m) = wgc_monitors.into_iter().nth(index) {
            return Ok(m);
        }
    }
    // Không khớp được — quay màn hình chính còn hơn báo lỗi hẳn.
    WgcMonitor::primary().map_err(|e| format!("Không tìm thấy màn hình để quay: {e}"))
}

/// Tìm `windows_capture::window::Window` khớp `window_id` (id từ
/// `xcap::Window::id()`, dùng chung cho overlay chọn cửa sổ). Ép kiểu TRỰC
/// TIẾP `window_id` (u32) ngược lại thành `HWND` — giả định `xcap::Window::id()`
/// trên Windows chính là giá trị `HWND` (CẦN xác minh trên máy thật, xem mục
/// "Xác định monitor/window" trong plan Phase 5). Nếu quay NHẦM cửa sổ, đổi
/// sang đối chiếu qua `WgcWindow::enumerate()` + `title()`/`process_id()`
/// thay vì ép kiểu thẳng.
fn resolve_window(window_id: u32) -> Result<WgcWindow, String> {
    // Ưu tiên đối chiếu qua danh sách cửa sổ THẬT của WGC: tìm cửa sổ có HWND
    // (truncate về u32 — handle Win32 theo spec tương thích 32-bit) khớp id —
    // tránh tự dựng lại HWND từ u32 với rủi ro sign-extension/truncation sai.
    if let Ok(windows) = WgcWindow::enumerate() {
        if let Some(w) = windows
            .into_iter()
            .find(|w| (w.as_raw_hwnd() as usize as u32) == window_id)
        {
            return Ok(w);
        }
    }
    // Fallback hành vi cũ: dựng HWND trực tiếp từ id (đúng khi
    // `xcap::Window::id()` chính là giá trị HWND).
    let hwnd = window_id as i32 as isize as *mut std::ffi::c_void;
    let window = WgcWindow::from_raw_hwnd(hwnd);
    if !window.is_valid() {
        return Err("Cửa sổ không còn hợp lệ để quay (có thể đã đóng hoặc bị thu nhỏ)".to_string());
    }
    Ok(window)
}

/// Kích thước THẬT của 1 cửa sổ để khởi tạo encoder TRƯỚC khi frame đầu tiên
/// từ WGC tới — dùng `DWMWA_EXTENDED_FRAME_BOUNDS` (không dùng
/// `Window::rect()`/`GetWindowRect`, vì hàm đó tính CẢ viền bóng đổ vô hình do
/// DWM vẽ thêm, thường lệch vài pixel so với nội dung WGC thực sự quay —
/// crate `windows-capture` cũng tự dùng đúng API này nội bộ cho
/// `title_bar_height()`, xem window.rs).
fn window_capture_size(hwnd: *mut std::ffi::c_void) -> Result<(u32, u32), String> {
    use windows_sys::Win32::Foundation::RECT;
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if hr != 0 {
        return Err(format!("Không đọc được kích thước cửa sổ (DwmGetWindowAttribute lỗi, HRESULT={hr:#x})"));
    }
    let width = (rect.right - rect.left).max(0) as u32;
    let height = (rect.bottom - rect.top).max(0) as u32;
    if width == 0 || height == 0 {
        return Err("Cửa sổ có kích thước 0, không thể quay".to_string());
    }
    Ok((width, height))
}

/// Phiên quay đang chạy — giữ `CaptureControl` (thread nền của WGC, xem
/// `start_free_threaded`) + `ticker_thread` (nhịp đẩy frame ra encoder) cho
/// tới khi `stop()`. Vai trò tương đương `mac_stream::RecordingHandle`.
///
/// `control` bọc `Option` để CẢ `stop()` (đường chủ động) lẫn `Drop` (lưới an
/// toàn cho nhánh lỗi của `start_with_target` — các bước fallible sau khi
/// stream đã chạy) đều lấy ra dừng được — không có `Drop`, handle bị bỏ rơi
/// để lại phiên WGC chạy mồ côi + ticker thread loop vô hạn.
pub struct RecordingHandle {
    control: Option<CaptureControl<Capturer, Box<dyn std::error::Error + Send + Sync>>>,
    ticker_stop: Arc<AtomicBool>,
    ticker_thread: Option<JoinHandle<()>>,
    dropped: Arc<AtomicBool>,
    stopped_externally: Arc<AtomicBool>,
    pub width: u32,
    pub height: u32,
}

impl RecordingHandle {
    /// WGC đã tự dừng phiên capture ngoài ý muốn hay chưa — `record::mod`
    /// poll cờ này để tự dọn dẹp thay vì chờ mãi frame không bao giờ tới.
    pub fn is_stopped_externally(&self) -> bool {
        self.stopped_externally.load(Ordering::SeqCst)
    }

    /// Cờ "đã có frame bị drop" dùng chung với ticker — caller (`record::mod`)
    /// clone Arc này TRƯỚC khi `stop()` tiêu thụ handle để còn đọc được sau
    /// khi dừng mà cảnh báo người dùng.
    pub fn dropped_flag(&self) -> Arc<AtomicBool> {
        self.dropped.clone()
    }

    /// Dừng quay: dừng ticker TRƯỚC (đóng `frame_tx`, kết thúc writer thread
    /// bên `record/mod.rs`), rồi mới dừng phiên WGC qua `CaptureControl::stop()`.
    pub fn stop(mut self) -> Result<(), String> {
        self.ticker_stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.ticker_thread.take() {
            let _ = t.join();
        }

        let control = self.control.take();
        if self.stopped_externally.load(Ordering::SeqCst) {
            if self.dropped.load(Ordering::Relaxed) {
                eprintln!("[SnapDoc][record] Một số frame đã bị drop do encoder/consumer chậm hơn tốc độ quay");
            }
            return Ok(());
        }
        if let Some(control) = control {
            control.stop().map_err(|e| format!("Lỗi dừng quay: {e}"))?;
        }
        if self.dropped.load(Ordering::Relaxed) {
            eprintln!("[SnapDoc][record] Một số frame đã bị drop do encoder/consumer chậm hơn tốc độ quay");
        }
        Ok(())
    }
}

impl Drop for RecordingHandle {
    fn drop(&mut self) {
        // `stop()` đã lấy control ra (`take`) → không còn gì để dọn.
        let Some(control) = self.control.take() else { return };
        self.ticker_stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.ticker_thread.take() {
            let _ = t.join();
        }
        if !self.stopped_externally.load(Ordering::SeqCst) {
            eprintln!("[SnapDoc][record] RecordingHandle bị drop khi chưa stop() — dừng WGC khẩn cấp");
            let _ = control.stop();
        }
    }
}

/// Bắt đầu quay theo `RecordTarget`. `capture_system_audio` hiện bị bỏ qua
/// (luôn quay không tiếng trên Windows — audio hệ thống là giai đoạn 5/6 của
/// plan).
pub fn start(
    target: RecordTarget,
    fps: u32,
    _capture_system_audio: bool,
) -> Result<(RecordingHandle, mpsc::Receiver<Arc<Frame>>, Option<mpsc::Receiver<Vec<u8>>>), String> {
    // Channel có giới hạn dung lượng — nếu encoder xử lý chậm hơn tốc độ quay,
    // try_send() trong `spawn_ticker` sẽ thất bại (drop) thay vì chặn nó lại.
    // Bound = 2 giây buffer ở fps yêu cầu (giống mac_stream.rs). Dùng Arc<Frame> để zero-copy.
    let bound = (fps.max(1) as usize) * 2;
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Arc<Frame>>(bound);
    let dropped = Arc::new(AtomicBool::new(false));
    let stopped_externally = Arc::new(AtomicBool::new(false));
    let latest: Arc<Mutex<Option<Arc<Frame>>>> = Arc::new(Mutex::new(None));
    let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    // Default cho setting của CRATE — việc ép nhịp fps thật giờ nằm ở
    // `spawn_ticker`, không còn phụ thuộc `MinimumUpdateIntervalSettings`.
    let min_interval = MinimumUpdateIntervalSettings::Default;

    // `Settings<Flags, T>` khác kiểu cụ thể giữa `Monitor` và `Window` (T khác
    // nhau) nên không thể dùng chung 1 biến `settings` — mỗi nhánh tự dựng
    // settings + gọi `start_free_threaded` + trả `RecordingHandle` riêng,
    // `CaptureControl<Capturer, _>` trả về có cùng kiểu bất kể T là gì.
    let (control, width, height) = match target {
        RecordTarget::Display(display_id) => {
            let monitor = resolve_monitor(display_id)?;
            let width = even_floor(monitor.width().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?);
            let height =
                even_floor(monitor.height().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?);
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                CapturerFlags {
                    latest: latest.clone(),
                    stopped_externally: stopped_externally.clone(),
                    target_width: width,
                    target_height: height,
                    crop_x: 0,
                    crop_y: 0,
                },
            );
            let control = Capturer::start_free_threaded(settings)
                .map_err(|e| format!("Không bắt đầu quay (Windows.Graphics.Capture): {e}"))?;
            (control, width, height)
        }
        RecordTarget::Window(window_id) => {
            let window = resolve_window(window_id)?;
            let (raw_width, raw_height) = window_capture_size(window.as_raw_hwnd())?;
            let (width, height) = (even_floor(raw_width), even_floor(raw_height));
            let settings = Settings::new(
                window,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                CapturerFlags {
                    latest: latest.clone(),
                    stopped_externally: stopped_externally.clone(),
                    target_width: width,
                    target_height: height,
                    crop_x: 0,
                    crop_y: 0,
                },
            );
            let control = Capturer::start_free_threaded(settings)
                .map_err(|e| format!("Không bắt đầu quay (Windows.Graphics.Capture): {e}"))?;
            (control, width, height)
        }
        RecordTarget::Region { display_id, x, y, w, h } => {
            // WGC không có `sourceRect` như SCStream — quay NGUYÊN màn hình
            // rồi crop trong `on_frame_arrived` (qua `crop_x`/`crop_y`/
            // `target_width`/`target_height`), xem doc-comment `CapturerFlags`.
            let monitor = resolve_monitor(display_id)?;
            let full_width = monitor.width().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?;
            let full_height = monitor.height().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?;
            let crop_x = x.max(0.0).round() as u32;
            let crop_y = y.max(0.0).round() as u32;
            let width = even_floor(w.max(0.0).round() as u32).min(even_floor(full_width.saturating_sub(crop_x)));
            let height = even_floor(h.max(0.0).round() as u32).min(even_floor(full_height.saturating_sub(crop_y)));
            if width == 0 || height == 0 {
                return Err("Vùng chọn không hợp lệ để quay".to_string());
            }
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                CapturerFlags {
                    latest: latest.clone(),
                    stopped_externally: stopped_externally.clone(),
                    target_width: width,
                    target_height: height,
                    crop_x,
                    crop_y,
                },
            );
            let control = Capturer::start_free_threaded(settings)
                .map_err(|e| format!("Không bắt đầu quay (Windows.Graphics.Capture): {e}"))?;
            (control, width, height)
        }
    };

    let ticker_stop = Arc::new(AtomicBool::new(false));
    let ticker_thread = spawn_ticker(frame_tx, latest, dropped.clone(), ticker_stop.clone(), interval);

    Ok((
        RecordingHandle {
            control: Some(control),
            ticker_stop,
            ticker_thread: Some(ticker_thread),
            dropped,
            stopped_externally,
            width,
            height,
        },
        frame_rx,
        None,
    ))
}
