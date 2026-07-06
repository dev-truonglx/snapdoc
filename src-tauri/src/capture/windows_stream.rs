//! Windows: quay video liên tục bằng Windows.Graphics.Capture (WGC) qua crate
//! `windows-capture` — vai trò tương đương `mac_stream.rs` bên macOS
//! (ScreenCaptureKit `SCStream`). Xem plan Phase 5
//! (`.claude/plans/sprightly-yawning-ritchie.md`) để hiểu lý do chọn WGC thay
//! vì DXGI Desktop Duplication.
//!
//! GIAI ĐOẠN 1 (hiện tại): chỉ hỗ trợ `RecordTarget::Display` (toàn màn
//! hình), CHƯA có audio hệ thống (tham số `capture_system_audio` bị bỏ qua).
//! `Window`/`Region` trả lỗi rõ ràng — sẽ triển khai ở giai đoạn 2/4 của plan
//! (cần thêm bước map id `xcap` → `HWND`/crop theo vùng).
//!
//! LƯU Ý QUAN TRỌNG: phần gọi vào crate `windows-capture` dưới đây viết theo
//! API công khai đã biết của crate lúc lên plan — môi trường phát triển hiện
//! tại là macOS nên KHÔNG build/test được trên Windows thật. Nếu tên hàm/kiểu
//! (`Settings::new`, `Monitor::enumerate`, `FrameBuffer::as_raw_nopadding_buffer`,
//! `CaptureControl`, ...) lệch so với phiên bản `windows-capture` cài đặt
//! thực tế, sửa lại theo lỗi biên dịch của `cargo check` trên máy Windows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor as WgcMonitor;
use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings};

/// Phạm vi quay — cùng hình dạng với `mac_stream::RecordTarget` để
/// `record/mod.rs` dùng chung 1 kiểu dispatch cho cả 2 nền tảng. Xem doc-
/// comment đầu file: `Region`/`Window` chưa triển khai ở giai đoạn 1.
pub enum RecordTarget {
    /// Toàn bộ 1 màn hình, `display_id` là id từ `xcap::Monitor::id()` (cùng
    /// id dùng cho overlay chọn màn hình + chụp ảnh).
    Display(u32),
    /// 1 vùng trong 1 màn hình — `x,y,w,h` là pixel vật lý, LOCAL theo gốc
    /// màn hình (cùng hệ toạ độ `flow::finalize_region` đã tính cho chụp ảnh
    /// vùng). Giai đoạn 4 của plan: quay nguyên `display_id`, crop trong Rust.
    Region { display_id: u32, x: f64, y: f64, w: f64, h: f64 },
    /// 1 cửa sổ theo id từ `xcap::Window::id()`. Giai đoạn 2 của plan: cần
    /// map id này sang `HWND` cho WGC.
    Window(u32),
}

/// Một frame video thô: BGRA, chưa nén — cùng định dạng với `mac_stream::Frame`
/// nên `encoder.rs` (ffmpeg `-pix_fmt bgra`) không cần biết frame đến từ nền
/// tảng nào.
pub struct Frame {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

struct CapturerFlags {
    frame_tx: mpsc::SyncSender<Frame>,
    dropped: Arc<AtomicBool>,
    stopped_externally: Arc<AtomicBool>,
    /// Khoảng cách tối thiểu giữa 2 frame được GỬI ĐI (không phải giữa 2 lần
    /// WGC gọi callback — WGC không có tham số fps như
    /// `SCStreamConfiguration.minimumFrameInterval` bên macOS, nên tự lọc bớt
    /// ở đây để không nạp cho ffmpeg nhanh/chậm hơn `-r fps` đã khai lúc mở
    /// encoder, tránh video bị tua nhanh/chậm so với thời lượng thật).
    frame_interval: Duration,
}

struct Capturer {
    frame_tx: mpsc::SyncSender<Frame>,
    dropped: Arc<AtomicBool>,
    stopped_externally: Arc<AtomicBool>,
    frame_interval: Duration,
    last_sent: Instant,
}

impl GraphicsCaptureApiHandler for Capturer {
    type Flags = CapturerFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            frame_tx: ctx.flags.frame_tx,
            dropped: ctx.flags.dropped,
            stopped_externally: ctx.flags.stopped_externally,
            last_sent: Instant::now() - ctx.flags.frame_interval,
            frame_interval: ctx.flags.frame_interval,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WgcFrame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let now = Instant::now();
        if now.duration_since(self.last_sent) < self.frame_interval {
            return Ok(());
        }
        self.last_sent = now;

        let width = frame.width();
        let height = frame.height();
        let mut buffer = frame.buffer()?;
        // Đã bỏ padding cuối hàng (row pitch) sẵn — tương đương bước copy
        // đúng `row_len` mỗi hàng mà `mac_stream.rs` tự làm thủ công cho
        // IOSurface, ở đây crate lo hộ.
        let bgra = buffer.as_raw_nopadding_buffer()?;

        // try_send: nếu channel đầy (encoder chậm hơn tốc độ quay), DROP frame
        // này thay vì chặn callback của WGC — giống hệt lý do ở mac_stream.rs.
        if self
            .frame_tx
            .try_send(Frame { bgra: bgra.to_vec(), width, height })
            .is_err()
        {
            self.dropped.store(true, Ordering::Relaxed);
        }
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

/// Tìm `windows_capture::monitor::Monitor` khớp `display_id` (id từ
/// `xcap::Monitor::id()`, dùng chung cho overlay chọn màn hình). Windows-capture
/// không có API "tạo theo id của xcap" — đối chiếu qua VỊ TRÍ trong danh sách
/// liệt kê của cả 2 crate (giả định thứ tự liệt kê giống nhau vì cùng dựa
/// trên `EnumDisplayMonitors` của hệ điều hành — CẦN xác minh trên máy thật,
/// xem mục "Xác định monitor/window" trong plan Phase 5; nếu lệch, đổi sang
/// đối chiếu theo toạ độ/kích thước màn hình thay vì theo vị trí index).
fn resolve_monitor(display_id: u32) -> Result<WgcMonitor, String> {
    let xcap_monitors = xcap::Monitor::all().map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    let index = xcap_monitors
        .iter()
        .position(|m| m.id().map(|i| i == display_id).unwrap_or(false));

    if let Some(index) = index {
        let wgc_monitors = WgcMonitor::enumerate().map_err(|e| format!("Không liệt kê được màn hình (WGC): {e}"))?;
        if let Some(m) = wgc_monitors.into_iter().nth(index) {
            return Ok(m);
        }
    }
    // Không khớp được theo index — quay màn hình chính còn hơn báo lỗi hẳn.
    WgcMonitor::primary().map_err(|e| format!("Không tìm thấy màn hình để quay: {e}"))
}

/// Phiên quay đang chạy — giữ `CaptureControl` (thread nền của WGC, xem
/// `start_free_threaded`) cho tới khi `stop()`. Vai trò tương đương
/// `mac_stream::RecordingHandle`.
pub struct RecordingHandle {
    control: CaptureControl<Capturer, Box<dyn std::error::Error + Send + Sync>>,
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

    /// Dừng quay. `CaptureControl::stop()` gửi tín hiệu dừng cho thread capture
    /// nền và đợi nó kết thúc hẳn.
    pub fn stop(self) -> Result<(), String> {
        if self.stopped_externally.load(Ordering::SeqCst) {
            if self.dropped.load(Ordering::Relaxed) {
                eprintln!("[SnapDoc][record] Một số frame đã bị drop do encoder/consumer chậm hơn tốc độ quay");
            }
            return Ok(());
        }
        self.control.stop().map_err(|e| format!("Lỗi dừng quay: {e}"))?;
        if self.dropped.load(Ordering::Relaxed) {
            eprintln!("[SnapDoc][record] Một số frame đã bị drop do encoder/consumer chậm hơn tốc độ quay");
        }
        Ok(())
    }
}

/// Bắt đầu quay theo `RecordTarget`. Xem doc-comment đầu file: giai đoạn 1
/// chỉ hỗ trợ `Display`; `capture_system_audio` hiện bị bỏ qua (luôn quay
/// không tiếng trên Windows — audio hệ thống là giai đoạn 6 của plan).
pub fn start(
    target: RecordTarget,
    fps: u32,
    _capture_system_audio: bool,
) -> Result<(RecordingHandle, mpsc::Receiver<Frame>, Option<mpsc::Receiver<Vec<u8>>>), String> {
    let monitor = match target {
        RecordTarget::Display(display_id) => resolve_monitor(display_id)?,
        RecordTarget::Window(_) => {
            return Err("Quay theo cửa sổ trên Windows chưa được hỗ trợ ở bản này".to_string())
        }
        RecordTarget::Region { .. } => {
            return Err("Quay theo vùng trên Windows chưa được hỗ trợ ở bản này".to_string())
        }
    };

    let width = monitor.width().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?;
    let height = monitor.height().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?;

    // Channel có giới hạn dung lượng — nếu encoder xử lý chậm hơn tốc độ quay,
    // try_send() trong callback sẽ thất bại (drop) thay vì chặn thread capture
    // của WGC. Bound = 2 giây buffer ở fps yêu cầu (giống mac_stream.rs).
    let bound = (fps.max(1) as usize) * 2;
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Frame>(bound);
    let dropped = Arc::new(AtomicBool::new(false));
    let stopped_externally = Arc::new(AtomicBool::new(false));

    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        ColorFormat::Bgra8,
        CapturerFlags {
            frame_tx,
            dropped: dropped.clone(),
            stopped_externally: stopped_externally.clone(),
            frame_interval: Duration::from_secs_f64(1.0 / fps.max(1) as f64),
        },
    );

    let control = Capturer::start_free_threaded(settings)
        .map_err(|e| format!("Không bắt đầu quay (Windows.Graphics.Capture): {e}"))?;

    Ok((
        RecordingHandle {
            control,
            dropped,
            stopped_externally,
            width,
            height,
        },
        frame_rx,
        None,
    ))
}
