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

use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_audio_types::{kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, AudioBufferList};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_media::{
    kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime,
    CMTimeFlags,
};
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
};

/// Âm thanh HỆ THỐNG (loa) do SCStream trả về khi bật `capturesAudio` —
/// LUÔN cấu hình cứng 48kHz/stereo (`AUDIO_SAMPLE_RATE`/`AUDIO_CHANNELS`) qua
/// `SCStreamConfiguration`, nên caller (encoder ffmpeg) biết trước format mà
/// không cần đọc lại từ mỗi lần callback. Khác mic (`audio_mic.rs`) — thiết bị
/// mic trả về sample rate/channel tuỳ phần cứng, không cố định được.
pub const AUDIO_SAMPLE_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u16 = 2;

/// Phạm vi quay — v1 chỉ toàn màn hình (`Display`); Phase 3 thêm `Region`
/// (crop 1 vùng trong 1 màn hình cụ thể qua `SCStreamConfiguration.sourceRect`)
/// và `Window` (quay đúng 1 cửa sổ qua `SCContentFilter`
/// `initWithDesktopIndependentWindow`).
pub enum RecordTarget {
    /// Toàn bộ 1 màn hình theo `CGDirectDisplayID`.
    Display(u32),
    /// 1 vùng trong 1 màn hình. `x,y,w,h` là POINTS, LOCAL theo gốc màn hình
    /// đó (giống hệ toạ độ `capture::region::capture_region` dùng cho chụp
    /// vùng ảnh tĩnh) — KHÔNG phải toạ độ global desktop.
    Region { display_id: u32, x: f64, y: f64, w: f64, h: f64 },
    /// 1 cửa sổ theo `CGWindowID`.
    Window(u32),
}

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

// Audio hệ thống truyền qua channel dạng `Vec<u8>` (PCM signed 16-bit
// little-endian, ĐÃ xen kẽ kênh đúng `AUDIO_CHANNELS`) thẳng, không bọc
// struct riêng — writer thread (`record/mod.rs::spawn_fifo_writer`) ghi
// thẳng byte này vào fifo nạp cho ffmpeg, dùng chung hàm với mic
// (`audio_mic.rs` cũng gửi `Vec<u8>` cùng dạng PCM s16le).

/// Ivars của delegate object — Objective-C giữ instance này nên không thể
/// dùng lifetime tham chiếu ra ngoài, phải sở hữu `Sender` trực tiếp.
pub struct StreamOutputIvars {
    frame_tx: mpsc::SyncSender<Frame>,
    /// `Some` khi bật quay âm thanh hệ thống (`capturesAudio=true` lúc
    /// `start()`) — callback nhận `SCStreamOutputType::Audio` sẽ gửi vào đây
    /// thay vì `frame_tx`. `None` thì callback bỏ qua hẳn sample buffer audio
    /// (SCK không gửi loại này nếu config không bật `capturesAudio`, nhưng
    /// vẫn kiểm tra cho chắc).
    audio_tx: Option<mpsc::SyncSender<Vec<u8>>>,
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
            match r#type {
                SCStreamOutputType::Screen => {
                    if let Some(frame) = unsafe { sample_buffer_to_frame(sample_buffer) } {
                        // try_send: nếu channel đầy (consumer/encoder chậm), DROP
                        // frame này thay vì block callback queue của SCK — chặn ở
                        // đây sẽ làm SCK dồn ứ và cuối cùng crash/treo stream.
                        if self.ivars().frame_tx.try_send(frame).is_err() {
                            self.ivars().dropped.store(true, Ordering::Relaxed);
                        }
                    }
                }
                SCStreamOutputType::Audio => {
                    let Some(audio_tx) = self.ivars().audio_tx.as_ref() else { return };
                    if let Some(frame) = unsafe { sample_buffer_to_audio(sample_buffer) } {
                        if audio_tx.try_send(frame).is_err() {
                            self.ivars().dropped.store(true, Ordering::Relaxed);
                        }
                    }
                }
                _ => {}
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
        audio_tx: Option<mpsc::SyncSender<Vec<u8>>>,
        dropped: Arc<AtomicBool>,
        stopped_externally: Arc<AtomicBool>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamOutputIvars {
            frame_tx,
            audio_tx,
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

/// Trần an toàn để không đọc tràn bộ nhớ nếu `mNumberBuffers` trả về bất
/// thường — KHÔNG dùng để tính kích thước cấp phát nữa (xem lý do ở
/// `sample_buffer_to_audio`: từng đoán cứng 8 buffer/136 byte và vẫn bị
/// CoreMedia trả lỗi `kCMSampleBufferError_ArrayTooSmall` — API này không
/// cho đoán, phải HỎI kích thước thật rồi mới cấp đúng).
const MAX_AUDIO_BUFFERS: usize = 64;

/// `CMSampleBuffer` (audio, wrap 1 `AudioBufferList`) → PCM i16 interleaved
/// (`Vec<u8>`). SCStream không cam kết format cụ thể (theo doc chỉ nói
/// "dựa trên sampleRate/channelCount đã set"), nên đọc thẳng
/// `AudioStreamBasicDescription` của sample buffer để biết chắc: float hay
/// int, interleaved hay planar (non-interleaved — mỗi kênh 1 buffer riêng,
/// phải tự xen kẽ lại).
///
/// `AudioBufferList` là kiểu C "flexible array member"
/// (`{ mNumberBuffers: u32, mBuffers: [AudioBuffer; 1] }` nhưng thực chứa
/// `mNumberBuffers` phần tử) — phải tự cấp phát đủ chỗ rồi truy cập qua con
/// trỏ thô, không dùng `list.mBuffers[i]` (mảng Rust khai báo cứng độ dài 1,
/// index > 0 sẽ panic). Kích thước cần cấp phát KHÔNG được đoán cứng theo số
/// kênh — gọi 2 lần theo đúng mẫu Apple tài liệu: lần 1 với
/// `buffer_list_out=NULL` chỉ để HỎI `buffer_list_size_needed_out`, lần 2
/// mới cấp đúng số byte đó rồi lấy dữ liệu thật. Đoán cứng (8 buffer/136
/// byte) từng bị CoreMedia trả `kCMSampleBufferError_ArrayTooSmall`
/// (-12737) dù nhìn tưởng dư dả — API này không cho đoán.
unsafe fn sample_buffer_to_audio(sample_buffer: &CMSampleBuffer) -> Option<Vec<u8>> {
    let format_desc = unsafe { sample_buffer.format_description() }?;
    let asbd_ptr = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&format_desc) };
    if asbd_ptr.is_null() {
        return None;
    }
    let asbd = unsafe { *asbd_ptr };

    const FLAGS: u32 = kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment;

    // Lần 1: hỏi kích thước THẬT cần cấp — `buffer_list_out=NULL` nghĩa là
    // "chỉ tính size, chưa lấy dữ liệu" (đúng mẫu dùng API này của Apple).
    let mut needed_size: usize = 0;
    let _query_status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            &mut needed_size,
            std::ptr::null_mut(),
            0,
            None,
            None,
            FLAGS,
            std::ptr::null_mut(),
        )
    };
    if needed_size == 0 {
        return None;
    }

    let layout = Layout::from_size_align(needed_size, std::mem::align_of::<AudioBufferList>()).ok()?;
    let raw = unsafe { alloc_zeroed(layout) };
    if raw.is_null() {
        return None;
    }
    let list_ptr = raw as *mut AudioBufferList;

    // Lần 2: cấp ĐÚNG `needed_size` vừa hỏi được — lấy dữ liệu thật.
    let mut block_buffer_raw: *mut CMBlockBuffer = std::ptr::null_mut();
    let status = unsafe {
        sample_buffer.audio_buffer_list_with_retained_block_buffer(
            std::ptr::null_mut(),
            list_ptr,
            needed_size,
            None,
            None,
            FLAGS,
            &mut block_buffer_raw,
        )
    };
    // "WithRetainedBlockBuffer" trả block buffer đã +1 refcount — bọc vào
    // CFRetained để tự CFRelease khi ra khỏi scope (giữ sống bộ nhớ mà
    // AudioBufferList trỏ tới cho tới khi ta copy xong PCM ở dưới).
    let _block_buffer_guard = (!block_buffer_raw.is_null())
        .then(|| unsafe { CFRetained::from_raw(std::ptr::NonNull::new_unchecked(block_buffer_raw)) });

    let pcm = if status != 0 || block_buffer_raw.is_null() {
        None
    } else {
        let list: &AudioBufferList = unsafe { &*list_ptr };
        let n = (list.mNumberBuffers as usize).min(MAX_AUDIO_BUFFERS);
        let non_interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;
        let is_float = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0;
        let buffers_ptr = list.mBuffers.as_ptr();

        if n == 0 {
            None
        } else if non_interleaved {
            // Planar: buffer[i] chứa riêng kênh i (float32) — tự interleave
            // lại thành i16 xen kẽ cho đúng định dạng `-f s16le` phía ffmpeg.
            let first = unsafe { &*buffers_ptr };
            let frames = first.mDataByteSize as usize / 4;
            let mut out = vec![0u8; frames * n * 2];
            for ch in 0..n {
                let buf = unsafe { &*buffers_ptr.add(ch) };
                if buf.mData.is_null() {
                    continue;
                }
                let count = (buf.mDataByteSize as usize / 4).min(frames);
                let src = unsafe { std::slice::from_raw_parts(buf.mData as *const f32, count) };
                for (i, &s) in src.iter().enumerate() {
                    let off = (i * n + ch) * 2;
                    out[off..off + 2].copy_from_slice(&f32_to_i16_le(s));
                }
            }
            Some(out)
        } else {
            // Interleaved: 1 buffer duy nhất, các kênh đã xen kẽ sẵn.
            let buf = unsafe { &*buffers_ptr };
            if buf.mData.is_null() {
                None
            } else if is_float {
                let count = buf.mDataByteSize as usize / 4;
                let src = unsafe { std::slice::from_raw_parts(buf.mData as *const f32, count) };
                let mut out = vec![0u8; count * 2];
                for (i, &s) in src.iter().enumerate() {
                    out[i * 2..i * 2 + 2].copy_from_slice(&f32_to_i16_le(s));
                }
                Some(out)
            } else {
                // Coi như đã là PCM 16-bit signed interleaved — copy thẳng.
                let bytes = unsafe {
                    std::slice::from_raw_parts(buf.mData as *const u8, buf.mDataByteSize as usize)
                };
                Some(bytes.to_vec())
            }
        }
    };

    unsafe { dealloc(raw, layout) };
    pcm
}

#[inline]
fn f32_to_i16_le(sample: f32) -> [u8; 2] {
    let clamped = sample.clamp(-1.0, 1.0);
    let v = (clamped * i16::MAX as f32) as i16;
    v.to_le_bytes()
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

/// Tìm `SCWindow` khớp `CGWindowID` — cùng cách với `find_display` nhưng
/// liệt kê `content.windows()`. Dùng cho `RecordTarget::Window`.
fn find_window(window_id: u32) -> Result<Retained<SCWindow>, String> {
    let (tx, rx) = mpsc::channel::<Result<Retained<SCWindow>, String>>();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, err: *mut objc2_foundation::NSError| {
        if content.is_null() {
            let msg = if err.is_null() {
                "không rõ".to_string()
            } else {
                unsafe { (*err).localizedDescription().to_string() }
            };
            let _ = tx.send(Err(format!("Không lấy được danh sách cửa sổ: {msg}")));
            return;
        }
        let content: &SCShareableContent = unsafe { &*content };
        let windows = unsafe { content.windows() };
        let found = windows
            .iter()
            .find(|w| unsafe { w.windowID() } == window_id);
        let _ = tx.send(found.ok_or_else(|| "Không tìm thấy cửa sổ để quay (có thể đã đóng)".to_string()));
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    rx.recv_timeout(TIMEOUT)
        .map_err(|_| "Hết thời gian chờ ScreenCaptureKit liệt kê cửa sổ".to_string())?
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

/// Bắt đầu quay theo `RecordTarget` (toàn màn hình / 1 vùng / 1 cửa sổ).
///
/// `fps`: tốc độ khung hình mong muốn (khuyến nghị 30). `capture_system_audio`:
/// bật `SCStreamConfiguration.capturesAudio` (macOS 13+, an toàn với
/// `minimumSystemVersion` 14.0 của app) — audio HỆ THỐNG (loa), KHÔNG phải
/// mic (mic dùng `record::audio_mic` riêng, xem module đó để hiểu vì sao).
/// Trả về `RecordingHandle` (giữ để gọi `stop()`) + `Receiver<Frame>` video +
/// `Receiver<Vec<u8>>` audio hệ thống (`Some` chỉ khi
/// `capture_system_audio=true`).
pub fn start(
    target: RecordTarget,
    fps: u32,
    capture_system_audio: bool,
) -> Result<(RecordingHandle, mpsc::Receiver<Frame>, Option<mpsc::Receiver<Vec<u8>>>), String> {
    // `source_rect`: Some khi quay 1 VÙNG (crop qua `SCStreamConfiguration`),
    // None khi quay trọn nội dung của filter (toàn màn hình hoặc cả cửa sổ).
    let (filter, source_rect): (Retained<SCContentFilter>, Option<CGRect>) = match &target {
        RecordTarget::Display(display_id) => {
            let display = find_display(*display_id)?;
            let excluded = NSArray::from_slice(&[]);
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &excluded)
            };
            (filter, None)
        }
        RecordTarget::Region { display_id, x, y, w, h } => {
            let display = find_display(*display_id)?;
            let excluded = NSArray::from_slice(&[]);
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &excluded)
            };
            let rect = CGRect {
                origin: CGPoint { x: *x, y: *y },
                size: CGSize { width: *w, height: *h },
            };
            (filter, Some(rect))
        }
        RecordTarget::Window(window_id) => {
            let window = find_window(*window_id)?;
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            (filter, None)
        }
    };

    let scale = unsafe { filter.pointPixelScale() } as f64;
    // Kích thước pixel đầu ra: bằng đúng vùng crop nếu có `source_rect`, nếu
    // không thì bằng toàn bộ nội dung của filter (`contentRect`).
    let (px_w, px_h) = if let Some(rect) = source_rect {
        (
            ((rect.size.width * scale).round() as usize).max(2),
            ((rect.size.height * scale).round() as usize).max(2),
        )
    } else {
        let content_rect: CGRect = unsafe { filter.contentRect() };
        (
            ((content_rect.size.width * scale).round() as usize).max(2),
            ((content_rect.size.height * scale).round() as usize).max(2),
        )
    };
    // Ép về SỐ CHẴN (`& !1` xoá bit thấp nhất, luôn còn >= 2 nhờ `.max(2)`
    // trên) — `Encoder::start` (encoder.rs) encode ra `yuv420p`, đòi hỏi CẢ
    // width/height chẵn (chroma subsampling 4:2:0 chia đôi từng chiều).
    // `content_rect` (toàn màn hình/cửa sổ) thường sẵn chẵn nên hiếm gặp, nhưng
    // `source_rect` (quay 1 VÙNG do người dùng tự kéo chọn, kích thước bất kỳ)
    // ra số lẻ rất dễ xảy ra — ffmpeg từ chối ngay khi bắt đầu encode, đóng
    // stdin, mọi lần `write_frame()` sau đó lỗi "Broken pipe" (đã tái hiện và
    // xác nhận qua log: 1822×1161 — 1161 lẻ — đúng lúc quay 1 vùng chọn tự do).
    let px_w = px_w & !1;
    let px_h = px_h & !1;

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
        if let Some(rect) = source_rect {
            config.setSourceRect(rect);
        }
        if capture_system_audio {
            config.setCapturesAudio(true);
            config.setSampleRate(AUDIO_SAMPLE_RATE as isize);
            config.setChannelCount(AUDIO_CHANNELS as isize);
            // KHÔNG bật excludesCurrentProcessAudio: về lý thuyết chỉ loại
            // tiếng của chính SnapDoc, nhưng đây là biến số không cần thiết
            // cho tính năng (SnapDoc không tự phát âm thanh gì đáng kể) — bỏ
            // để loại trừ khả năng nó là nguyên nhân audio hệ thống bị câm.
        }
    }

    // Channel có giới hạn dung lượng — nếu encoder xử lý chậm hơn tốc độ quay,
    // các lệnh gọi try_send() trong callback sẽ thất bại (drop) thay vì chặn
    // luồng SCK. Bound = 2 giây buffer ở fps yêu cầu.
    let bound = (fps.max(1) as usize) * 2;
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Frame>(bound);
    // Audio đến theo packet nhỏ (~10-20ms/lần) chứ không theo fps — bound rời
    // rạc hơn (packet/giây, không phải sample/giây) vẫn đủ ~2s đệm.
    let (audio_tx, audio_rx) = if capture_system_audio {
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(200);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let dropped = Arc::new(AtomicBool::new(false));
    let stopped_externally = Arc::new(AtomicBool::new(false));
    let handler_obj =
        StreamOutputHandler::new(frame_tx, audio_tx, dropped.clone(), stopped_externally.clone());

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
    if capture_system_audio {
        // Queue RIÊNG cho callback audio — tách khỏi queue video để 1 lượt
        // callback video (copy cả khung hình, có thể vài ms) không làm trễ
        // audio (nhạy độ trễ hơn nhiều, chỉ vài chục byte mỗi lần).
        let audio_queue = DispatchQueue::new("com.snapdoc.record.audio", None);
        let audio_output_proto = ProtocolObject::from_ref(&*handler_obj);
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    audio_output_proto,
                    SCStreamOutputType::Audio,
                    Some(&audio_queue),
                )
                .map_err(|e| format!("Không thêm được stream output audio: {}", e.localizedDescription()))?;
        }
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
        audio_rx,
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

        let (handle, rx, _audio_rx) =
            start(RecordTarget::Display(display_id), fps, false).expect("start() thất bại");

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
