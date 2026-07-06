//! macOS: quay video liên tục bằng ScreenCaptureKit `SCStream` — khác với
//! `mac_sck.rs` (chụp MỘT lần qua `SCScreenshotManager`), module này giữ một
//! `SCStream` chạy liên tục, đẩy mỗi frame (BGRA thô) qua channel cho tới khi
//! gọi `stop()`.
//!
//! Luồng hoạt động:
//! 1. `start()` liệt kê `SCShareableContent` để tìm đúng `SCDisplay` theo
//!    `CGDirectDisplayID`, dựng `SCContentFilter` bao trọn màn hình đó.
//! 2. Tạo `SCStreamConfiguration` (kích thước = pixel vật lý, pixelFormat =
//!    BGRA32, fps qua `minimumFrameInterval`, có con trỏ chuột).
//! 3. Tạo `SCStream` với delegate là `StreamOutputHandler` — 1 class Objective-C
//!    tự định nghĩa (`define_class!`) implement `SCStreamOutput` +
//!    `SCStreamDelegate`. Frame callback chạy trên 1 dispatch queue serial
//!    RIÊNG (không phải main queue) để không bị chặn bởi UI thread.
//! 4. Mỗi `CMSampleBuffer` nhận được → lock `CVPixelBuffer` (readonly), copy
//!    đúng phần dữ liệu hữu ích (bỏ padding cuối hàng do IOSurface) thành
//!    `Vec<u8>` BGRA rồi gửi qua channel `mpsc` (KHÔNG giữ callback thread lâu
//!    — nếu consumer chậm hơn tốc độ quay, DROP frame thay vì chặn SCK).

// Tên phương thức protocol (`stream:didOutputSampleBuffer:ofType:`...) phải
// khớp đúng selector Objective-C nên không thể đổi sang snake_case.
#![allow(non_snake_case)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_foundation::CGRect;
use objc2_core_media::{CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType,
};

const TIMEOUT: Duration = Duration::from_secs(10);
/// readonly lock — ta chỉ đọc, không sửa buffer của SCK.
const LOCK_READONLY: CVPixelBufferLockFlags = CVPixelBufferLockFlags(1);

/// Một frame video thô: BGRA, chưa nén — thứ tự kênh giữ nguyên như SCK trả
/// về (không đảo sang RGBA như luồng chụp ảnh) vì bước encode video kế tiếp
/// (ffmpeg `-pix_fmt bgra`) nhận thẳng định dạng này, tránh 1 lượt swap kênh
/// tốn CPU trên mỗi frame ở tốc độ 30fps.
pub struct Frame {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Ivars của delegate object — Objective-C giữ instance này nên không thể
/// dùng lifetime tham chiếu ra ngoài, phải sở hữu `Sender` trực tiếp.
pub struct StreamOutputIvars {
    frame_tx: mpsc::SyncSender<Frame>,
    /// Đếm số frame đã DROP vì consumer chậm hơn tốc độ quay — log khi stop.
    dropped: Arc<AtomicBool>,
    /// Set bởi `stream:didStopWithError:` khi SCStream tự dừng NGOÀI Ý MUỐN —
    /// ví dụ người dùng bấm "Stop" trên icon "Screen Sharing" của HỆ THỐNG
    /// macOS (khác icon "đang quay" riêng của app), chứ không qua
    /// `RecordingHandle::stop()`. Chia sẻ với `RecordingHandle` để
    /// `record::mod` phát hiện và tự dọn dẹp (đóng ffmpeg, ẩn tray icon)
    /// thay vì treo mãi ở trạng thái "đang quay" trong khi SCK đã âm thầm
    /// ngừng gửi frame.
    stopped_externally: Arc<AtomicBool>,
}

define_class!(
    // SAFETY: NSObject không có yêu cầu subclass đặc biệt; StreamOutputHandler
    // không implement Drop nên không cần dealloc tuỳ chỉnh.
    #[unsafe(super(NSObject))]
    #[ivars = StreamOutputIvars]
    struct StreamOutputHandler;

    unsafe impl NSObjectProtocol for StreamOutputHandler {}

    unsafe impl SCStreamOutput for StreamOutputHandler {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_didOutputSampleBuffer_ofType(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            r#type: SCStreamOutputType,
        ) {
            if r#type != SCStreamOutputType::Screen {
                return;
            }
            match unsafe { sample_buffer_to_frame(sample_buffer) } {
                Some(frame) => {
                    // try_send: nếu channel đầy (consumer/encoder chậm), DROP
                    // frame này thay vì block callback queue của SCK — chặn ở
                    // đây sẽ làm SCK dồn ứ và cuối cùng crash/treo stream.
                    if self.ivars().frame_tx.try_send(frame).is_err() {
                        self.ivars().dropped.store(true, Ordering::Relaxed);
                    }
                }
                None => {}
            }
        }
    }

    unsafe impl SCStreamDelegate for StreamOutputHandler {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stream_didStopWithError(
            &self,
            _stream: &SCStream,
            error: &objc2_foundation::NSError,
        ) {
            eprintln!(
                "[SnapDoc][record] SCStream dừng ngoài ý muốn: {}",
                error.localizedDescription()
            );
            self.ivars().stopped_externally.store(true, Ordering::SeqCst);
        }
    }
);

impl StreamOutputHandler {
    fn new(
        frame_tx: mpsc::SyncSender<Frame>,
        dropped: Arc<AtomicBool>,
        stopped_externally: Arc<AtomicBool>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamOutputIvars {
            frame_tx,
            dropped,
            stopped_externally,
        });
        unsafe { msg_send![super(this), init] }
    }
}

/// `CMSampleBuffer` (BGRA, IOSurface-backed `CVPixelBuffer`) → `Frame`.
/// Chạy trong dispatch queue riêng của stream (KHÔNG phải main queue).
unsafe fn sample_buffer_to_frame(sample_buffer: &CMSampleBuffer) -> Option<Frame> {
    let pixel_buffer = unsafe { sample_buffer.image_buffer() }?;

    // Lock/Unlock là FFI thô (extern "C-unwind") nên cần unsafe; các hàm Get*
    // bên dưới là wrapper Rust an toàn (không cần bọc unsafe).
    unsafe { CVPixelBufferLockBaseAddress(&pixel_buffer, LOCK_READONLY) };
    let width = CVPixelBufferGetWidth(&pixel_buffer);
    let height = CVPixelBufferGetHeight(&pixel_buffer);
    let bytes_per_row = CVPixelBufferGetBytesPerRow(&pixel_buffer);
    let base = CVPixelBufferGetBaseAddress(&pixel_buffer);

    let frame = if base.is_null() || width == 0 || height == 0 {
        None
    } else {
        // IOSurface pad bytes_per_row >= width*4 — copy đúng row_len mỗi hàng,
        // bỏ phần padding cuối hàng (giống cgimage_to_rgba ở mac_sck.rs).
        let row_len = width * 4;
        let mut buffer = vec![0u8; row_len * height];
        unsafe {
            let src = base as *const u8;
            for y in 0..height {
                let src_row = src.add(y * bytes_per_row);
                let dst_row = buffer.as_mut_ptr().add(y * row_len);
                std::ptr::copy_nonoverlapping(src_row, dst_row, row_len);
            }
        }
        Some(Frame {
            bgra: buffer,
            width: width as u32,
            height: height as u32,
        })
    };

    unsafe { CVPixelBufferUnlockBaseAddress(&pixel_buffer, LOCK_READONLY) };
    frame
}

/// Tìm `SCDisplay` khớp `CGDirectDisplayID` bằng cách liệt kê
/// `SCShareableContent` (đồng bộ hoá qua channel, có timeout).
fn find_display(display_id: u32) -> Result<Retained<SCDisplay>, String> {
    let (tx, rx) = mpsc::channel::<Result<Retained<SCDisplay>, String>>();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, err: *mut objc2_foundation::NSError| {
        if content.is_null() {
            let msg = if err.is_null() {
                "không rõ".to_string()
            } else {
                unsafe { (*err).localizedDescription().to_string() }
            };
            let _ = tx.send(Err(format!("Không lấy được danh sách màn hình: {msg}")));
            return;
        }
        let content: &SCShareableContent = unsafe { &*content };
        let displays = unsafe { content.displays() };
        let found = displays
            .iter()
            .find(|d| unsafe { d.displayID() } == display_id);
        let _ = tx.send(found.ok_or_else(|| "Không tìm thấy màn hình để quay".to_string()));
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    rx.recv_timeout(TIMEOUT)
        .map_err(|_| "Hết thời gian chờ ScreenCaptureKit liệt kê màn hình".to_string())?
}

/// Stream đang chạy — giữ sống `SCStream` + delegate (ARC) cho tới khi
/// `stop()`. Drop mà chưa gọi `stop()` sẽ để stream chạy "mồ côi" (không ai
/// đọc frame nữa) nên luôn phải gọi `stop()` tường minh.
pub struct RecordingHandle {
    stream: Retained<SCStream>,
    _handler: Retained<StreamOutputHandler>,
    dropped: Arc<AtomicBool>,
    /// Cờ dùng chung với `StreamOutputIvars` (xem giải thích ở đó) — báo SCK
    /// đã tự dừng ngoài ý muốn của ta.
    stopped_externally: Arc<AtomicBool>,
    /// Kích thước pixel vật lý của mỗi frame — cố định cho suốt phiên quay,
    /// khớp đúng `SCStreamConfiguration` đã cấu hình lúc `start()`. Caller
    /// (`record::mod`) cần giá trị này TRƯỚC frame đầu tiên để khởi động
    /// ffmpeg với đúng `-s WxH`.
    pub width: u32,
    pub height: u32,
}

// SAFETY: SCStream tự quản lý đồng bộ nội bộ (GCD); ta chỉ giữ Retained để nó
// không bị giải phóng, và chỉ gọi các phương thức của nó tuần tự từ 1 thread
// điều khiển (không có &mut chia sẻ giữa các thread).
unsafe impl Send for RecordingHandle {}

impl RecordingHandle {
    /// SCK đã tự dừng ngoài ý muốn (vd người dùng bấm "Stop" trên icon
    /// "Screen Sharing" của hệ thống macOS) hay chưa — `record::mod` poll cờ
    /// này để tự dọn dẹp phiên quay thay vì chờ mãi frame không bao giờ tới.
    pub fn is_stopped_externally(&self) -> bool {
        self.stopped_externally.load(Ordering::SeqCst)
    }

    /// Dừng quay, đợi SCStream xác nhận đã dừng hẳn (có timeout).
    pub fn stop(self) -> Result<(), String> {
        // SCK đã tự dừng rồi (xem `is_stopped_externally`) — gọi lại
        // `stopCaptureWithCompletionHandler` trên 1 stream không còn chạy có
        // thể không bao giờ gọi completion handler, khiến ta chờ hết
        // `TIMEOUT` (10s) một cách vô ích. Coi như đã dừng xong; `self` vẫn
        // drop bình thường ở cuối hàm (giải phóng `_handler` → đóng
        // `frame_tx` → luồng ghi video tự kết thúc).
        if self.stopped_externally.load(Ordering::SeqCst) {
            if self.dropped.load(Ordering::Relaxed) {
                eprintln!("[SnapDoc][record] Một số frame đã bị drop do encoder/consumer chậm hơn tốc độ quay");
            }
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let handler = RcBlock::new(move |err: *mut objc2_foundation::NSError| {
            let r = if err.is_null() {
                Ok(())
            } else {
                Err(format!("Lỗi dừng quay: {}", unsafe {
                    (*err).localizedDescription()
                }))
            };
            let _ = tx.send(r);
        });
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&handler)) };
        let result = rx
            .recv_timeout(TIMEOUT)
            .map_err(|_| "Hết thời gian chờ dừng quay".to_string())?;
        if self.dropped.load(Ordering::Relaxed) {
            eprintln!("[SnapDoc][record] Một số frame đã bị drop do encoder/consumer chậm hơn tốc độ quay");
        }
        result
    }
}

/// Bắt đầu quay toàn bộ 1 màn hình (theo `CGDirectDisplayID`).
///
/// `fps`: tốc độ khung hình mong muốn (khuyến nghị 30). Trả về `RecordingHandle`
/// (giữ để gọi `stop()`) + `Receiver<Frame>` để đọc frame BGRA liên tục.
pub fn start(display_id: u32, fps: u32) -> Result<(RecordingHandle, mpsc::Receiver<Frame>), String> {
    let display = find_display(display_id)?;

    let excluded = NSArray::from_slice(&[]);
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &excluded)
    };

    let scale = unsafe { filter.pointPixelScale() } as f64;
    let content_rect: CGRect = unsafe { filter.contentRect() };
    let px_w = ((content_rect.size.width * scale).round() as usize).max(1);
    let px_h = ((content_rect.size.height * scale).round() as usize).max(1);

    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(px_w);
        config.setHeight(px_h);
        config.setPixelFormat(kCVPixelFormatType_32BGRA);
        config.setShowsCursor(true);
        config.setQueueDepth(5);
        config.setMinimumFrameInterval(CMTime {
            value: 1,
            timescale: fps.max(1) as i32,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        });
    }

    // Channel có giới hạn dung lượng — nếu encoder xử lý chậm hơn tốc độ quay,
    // các lệnh gọi try_send() trong callback sẽ thất bại (drop) thay vì chặn
    // luồng SCK. Bound = 2 giây buffer ở fps yêu cầu.
    let bound = (fps.max(1) as usize) * 2;
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Frame>(bound);
    let dropped = Arc::new(AtomicBool::new(false));
    let stopped_externally = Arc::new(AtomicBool::new(false));
    let handler_obj = StreamOutputHandler::new(frame_tx, dropped.clone(), stopped_externally.clone());

    let delegate_proto = ProtocolObject::from_ref(&*handler_obj);
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &config,
            Some(delegate_proto),
        )
    };

    let queue = DispatchQueue::new("com.snapdoc.record.video", None);
    let output_proto = ProtocolObject::from_ref(&*handler_obj);
    unsafe {
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(
                output_proto,
                SCStreamOutputType::Screen,
                Some(&queue),
            )
            .map_err(|e| format!("Không thêm được stream output: {}", e.localizedDescription()))?;
    }

    let (start_tx, start_rx) = mpsc::channel::<Result<(), String>>();
    let start_handler = RcBlock::new(move |err: *mut objc2_foundation::NSError| {
        let r = if err.is_null() {
            Ok(())
        } else {
            Err(format!("Lỗi bắt đầu quay: {}", unsafe {
                (*err).localizedDescription()
            }))
        };
        let _ = start_tx.send(r);
    });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&start_handler)) };
    start_rx
        .recv_timeout(TIMEOUT)
        .map_err(|_| "Hết thời gian chờ bắt đầu quay".to_string())??;

    Ok((
        RecordingHandle {
            stream,
            _handler: handler_obj,
            dropped,
            stopped_externally,
            width: px_w as u32,
            height: px_h as u32,
        },
        frame_rx,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test thủ công: quay 3 giây, kiểm tra nhận đủ ~fps*3 frame và
    /// lưu frame cuối ra PNG để soi bằng mắt.
    /// Chạy: `cargo test --package snapdoc -- --ignored --nocapture mac_stream`
    /// Yêu cầu: Terminal/iTerm đã được cấp quyền Screen Recording.
    #[test]
    #[ignore]
    fn captures_real_frames() {
        use xcap::Monitor;

        let monitor = Monitor::all().unwrap().into_iter().find(|m| m.is_primary().unwrap_or(false)).unwrap();
        let display_id = monitor.id().unwrap();
        let fps = 30;

        let (handle, rx) = start(display_id, fps).expect("start() thất bại");

        let mut count = 0u32;
        let mut last: Option<Frame> = None;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Ok(frame) = rx.recv_timeout(Duration::from_millis(500)) {
                count += 1;
                last = Some(frame);
            }
        }
        handle.stop().expect("stop() thất bại");

        eprintln!("[test] nhận {count} frame trong 3s (~{:.1} fps)", count as f64 / 3.0);
        assert!(count > 0, "không nhận được frame nào");

        let frame = last.expect("không có frame nào để lưu");
        let mut rgba = frame.bgra.clone();
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let img = image::RgbaImage::from_raw(frame.width, frame.height, rgba).unwrap();
        let out = std::env::temp_dir().join("snapdoc_mac_stream_test.png");
        img.save(&out).unwrap();
        eprintln!("[test] đã lưu frame cuối tại {}", out.display());
    }
}
