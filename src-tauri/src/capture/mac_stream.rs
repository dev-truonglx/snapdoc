//! macOS: quay video liên tục bằng ScreenCaptureKit `SCStream` — khác với
//! `mac_sck.rs` (chụp MỘT lần qua `SCScreenshotManager`), module này giữ một
//! `SCStream` chạy liên tục, đẩy frame (BGRA thô) qua channel cho tới khi gọi
//! `stop()`.
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
//! 4. Mỗi `CMSampleBuffer` video nhận được → lock `CVPixelBuffer` (readonly),
//!    copy đúng phần dữ liệu hữu ích (bỏ padding cuối hàng do IOSurface)
//!    thành `Vec<u8>` BGRA rồi ghi vào `latest` (KHÔNG đẩy thẳng vào channel).
//!
//! KIẾN TRÚC FRAME PACING: SCStream chỉ THỰC SỰ gọi callback khi nội dung
//! màn hình đổi (`setMinimumFrameInterval` chỉ giới hạn tốc độ TỐI ĐA) — module
//! này chỉ cập nhật "frame mới nhất" (`LatestFrame`); nhịp đẩy frame vào
//! encoder theo đúng đồng hồ của phiên quay nằm ở `record::pacer` (dùng chung
//! với Windows).

// Tên phương thức protocol (`stream:didOutputSampleBuffer:ofType:`...) phải
// khớp đúng selector Objective-C nên không thể đổi sang snake_case.
#![allow(non_snake_case)]

use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::frame::{copy_rows, fit_even, publish, Frame, LatestFrame};
use crate::record::pcm_writer::PcmChunk;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsSignedInteger, AudioBufferList,
};
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
    SCContentFilter, SCDisplay, SCRunningApplication, SCShareableContent, SCStream,
    SCStreamConfiguration, SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
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

// Audio hệ thống truyền qua channel dạng `PcmChunk` (thời điểm thu + PCM
// s16le ĐÃ xen kẽ đúng `AUDIO_CHANNELS` kênh) — cùng dạng với mic, ghi ra file
// bởi `record::pcm_writer`.

/// Ivars của delegate object — Objective-C giữ instance này nên không thể
/// dùng lifetime tham chiếu ra ngoài, phải sở hữu dữ liệu trực tiếp.
pub struct StreamOutputIvars {
    /// Frame VIDEO mới nhất SCStream đã gửi — `record::pacer` đọc theo nhịp fps.
    latest: LatestFrame,
    /// Buffer của frame cũ (không còn ai giữ) để tái dùng — tránh cấp phát
    /// 20–60MB mỗi callback ở độ phân giải Retina.
    spare: Mutex<Option<Vec<u8>>>,
    /// `Some` khi bật quay âm thanh hệ thống — đóng (`None`) khi dừng quay để
    /// writer PCM thấy EOF.
    audio_tx: Arc<Mutex<Option<mpsc::SyncSender<PcmChunk>>>>,
    /// Set bởi `stream:didStopWithError:` khi SCStream tự dừng NGOÀI Ý MUỐN —
    /// người dùng bấm "Stop" trên icon "Screen Sharing" của hệ thống, màn hình
    /// bị ngắt, cửa sổ đang quay bị đóng... `record::mod` poll cờ này để tự
    /// dừng + lưu thay vì treo mãi ở trạng thái "đang quay".
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
                    let spare = self.ivars().spare.lock().unwrap_or_else(|p| p.into_inner()).take();
                    if let Some(frame) = unsafe { sample_buffer_to_frame(sample_buffer, spare) } {
                        if let Some(buf) = publish(&self.ivars().latest, frame) {
                            *self.ivars().spare.lock().unwrap_or_else(|p| p.into_inner()) = Some(buf);
                        }
                    }
                }
                SCStreamOutputType::Audio => {
                    let tx_guard = self.ivars().audio_tx.lock().unwrap_or_else(|p| p.into_inner());
                    let Some(audio_tx) = tx_guard.as_ref() else { return };
                    let captured_at = std::time::Instant::now();
                    if let Some(pcm) = unsafe { sample_buffer_to_audio(sample_buffer) } {
                        // Kênh đầy (writer chậm) → bỏ gói; `record::pcm_writer`
                        // tự chèn lặng đúng chỗ đó nên tiếng không bị lệch.
                        let _ = audio_tx.try_send((captured_at, pcm));
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
        latest: LatestFrame,
        audio_tx: Arc<Mutex<Option<mpsc::SyncSender<PcmChunk>>>>,
        stopped_externally: Arc<AtomicBool>,
    ) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamOutputIvars {
            latest,
            spare: Mutex::new(None),
            audio_tx,
            stopped_externally,
        });
        unsafe { msg_send![super(this), init] }
    }
}

/// `CMSampleBuffer` (BGRA, IOSurface-backed `CVPixelBuffer`) → `Frame`, tái
/// dùng `spare` làm bộ nhớ đích nếu đúng kích thước. Chạy trong dispatch queue
/// riêng của stream (KHÔNG phải main queue). Sample buffer "idle" (màn hình
/// không đổi) không có image buffer → `None`, giữ nguyên frame cũ.
unsafe fn sample_buffer_to_frame(sample_buffer: &CMSampleBuffer, spare: Option<Vec<u8>>) -> Option<Frame> {
    let pixel_buffer = unsafe { sample_buffer.image_buffer() }?;

    // Lock/Unlock là FFI thô (extern "C-unwind") nên cần unsafe; các hàm Get*
    // bên dưới là wrapper Rust an toàn (không cần bọc unsafe).
    unsafe { CVPixelBufferLockBaseAddress(&pixel_buffer, LOCK_READONLY) };
    let width = CVPixelBufferGetWidth(&pixel_buffer);
    let height = CVPixelBufferGetHeight(&pixel_buffer);
    let bytes_per_row = CVPixelBufferGetBytesPerRow(&pixel_buffer);
    let base = CVPixelBufferGetBaseAddress(&pixel_buffer);

    let frame = if base.is_null() || width == 0 || height == 0 || bytes_per_row < width * 4 {
        None
    } else {
        // IOSurface pad bytes_per_row >= width*4 — copy đúng width*4 mỗi hàng.
        let bgra = unsafe { copy_rows(base as *const u8, bytes_per_row, width * 4, height, spare) };
        Some(Frame { bgra, width: width as u32, height: height as u32 })
    };

    unsafe { CVPixelBufferUnlockBaseAddress(&pixel_buffer, LOCK_READONLY) };
    frame
}

/// Trần an toàn để không đọc tràn bộ nhớ nếu `mNumberBuffers` trả về bất
/// thường — KHÔNG dùng để tính kích thước cấp phát (xem `sample_buffer_to_audio`).
const MAX_AUDIO_BUFFERS: usize = 64;

/// Đọc 1 sample (kênh `ch`, frame `i`) thành f32 [-1, 1] theo đúng định dạng
/// SCStream trả về (float32 / int16 / int32, interleaved hoặc planar).
#[derive(Clone, Copy)]
enum SampleKind {
    F32,
    I16,
    I32,
}

impl SampleKind {
    fn bytes(self) -> usize {
        match self {
            SampleKind::I16 => 2,
            _ => 4,
        }
    }

    /// # Safety: `p` trỏ tới ít nhất `self.bytes()` byte hợp lệ.
    unsafe fn read(self, p: *const u8) -> f32 {
        match self {
            SampleKind::F32 => unsafe { (p as *const f32).read_unaligned() },
            SampleKind::I16 => (unsafe { (p as *const i16).read_unaligned() }) as f32 / 32768.0,
            SampleKind::I32 => (unsafe { (p as *const i32).read_unaligned() } as f64 / 2147483648.0) as f32,
        }
    }
}

/// `CMSampleBuffer` (audio, wrap 1 `AudioBufferList`) → PCM s16le xen kẽ
/// ĐÚNG `AUDIO_CHANNELS` kênh (mono được nhân đôi, >2 kênh lấy 2 kênh đầu) —
/// file PCM được ghép với `-ac AUDIO_CHANNELS` cố định nên số kênh sai sẽ làm
/// tiếng chạy nhanh/chậm gấp đôi.
///
/// `AudioBufferList` là kiểu C "flexible array member" — phải tự cấp phát đủ
/// chỗ rồi truy cập qua con trỏ thô. Kích thước cần cấp phát KHÔNG được đoán
/// cứng — gọi 2 lần theo đúng mẫu Apple: lần 1 hỏi `buffer_list_size_needed_out`,
/// lần 2 cấp đúng số byte đó rồi lấy dữ liệu (đoán cứng từng bị CoreMedia trả
/// `kCMSampleBufferError_ArrayTooSmall`).
unsafe fn sample_buffer_to_audio(sample_buffer: &CMSampleBuffer) -> Option<Vec<u8>> {
    let format_desc = unsafe { sample_buffer.format_description() }?;
    let asbd_ptr = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&format_desc) };
    if asbd_ptr.is_null() {
        return None;
    }
    let asbd = unsafe { *asbd_ptr };
    let flags = asbd.mFormatFlags;
    let kind = if flags & kAudioFormatFlagIsFloat != 0 && asbd.mBitsPerChannel == 32 {
        SampleKind::F32
    } else if flags & kAudioFormatFlagIsSignedInteger != 0 && asbd.mBitsPerChannel == 16 {
        SampleKind::I16
    } else if flags & kAudioFormatFlagIsSignedInteger != 0 && asbd.mBitsPerChannel == 32 {
        SampleKind::I32
    } else if flags & kAudioFormatFlagIsFloat != 0 || asbd.mBitsPerChannel == 0 {
        // SCStream thực tế luôn trả float32 — coi như mặc định.
        SampleKind::F32
    } else {
        return None;
    };
    let non_interleaved = flags & kAudioFormatFlagIsNonInterleaved != 0;
    let src_channels = (asbd.mChannelsPerFrame as usize).max(1);

    const FLAGS: u32 = kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment;

    // Lần 1: hỏi kích thước THẬT cần cấp.
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
    // CFRetained để tự CFRelease khi ra khỏi scope.
    let _block_buffer_guard = (!block_buffer_raw.is_null())
        .then(|| unsafe { CFRetained::from_raw(std::ptr::NonNull::new_unchecked(block_buffer_raw)) });

    let pcm = if status != 0 || block_buffer_raw.is_null() {
        None
    } else {
        let list: &AudioBufferList = unsafe { &*list_ptr };
        let n_buffers = (list.mNumberBuffers as usize).min(MAX_AUDIO_BUFFERS);
        let buffers_ptr = list.mBuffers.as_ptr();
        let sb = kind.bytes();
        let out_ch = AUDIO_CHANNELS as usize;

        // (con trỏ dữ liệu, số byte, stride giữa 2 frame) cho từng kênh nguồn.
        let mut chans: Vec<(*const u8, usize, usize)> = Vec::new();
        if non_interleaved {
            for i in 0..n_buffers {
                let buf = unsafe { &*buffers_ptr.add(i) };
                if !buf.mData.is_null() {
                    chans.push((buf.mData as *const u8, buf.mDataByteSize as usize, sb));
                }
            }
        } else if n_buffers > 0 {
            let buf = unsafe { &*buffers_ptr };
            if !buf.mData.is_null() {
                let stride = sb * src_channels;
                for c in 0..src_channels {
                    let p = unsafe { (buf.mData as *const u8).add(c * sb) };
                    let len = (buf.mDataByteSize as usize).saturating_sub(c * sb);
                    chans.push((p, len, stride));
                }
            }
        }

        if chans.is_empty() {
            None
        } else {
            let frames = chans
                .iter()
                .map(|&(_, len, stride)| if len >= sb { (len - sb) / stride + 1 } else { 0 })
                .min()
                .unwrap_or(0);
            let mut out = Vec::with_capacity(frames * out_ch * 2);
            for i in 0..frames {
                for c in 0..out_ch {
                    // Mono → nhân đôi sang cả 2 kênh; nhiều kênh → lấy kênh đầu.
                    let (p, _, stride) = chans[c.min(chans.len() - 1)];
                    let v = unsafe { kind.read(p.add(i * stride)) };
                    out.extend_from_slice(&f32_to_i16_le(v));
                }
            }
            Some(out)
        }
    };

    unsafe { dealloc(raw, layout) };
    pcm
}

#[inline]
fn f32_to_i16_le(sample: f32) -> [u8; 2] {
    let clamped = if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 };
    let v = (clamped * i16::MAX as f32) as i16;
    v.to_le_bytes()
}

/// Tìm `SCDisplay` khớp `CGDirectDisplayID` và danh sách `SCRunningApplication`
/// của chính SnapDoc (`processID == my_pid`) để loại trừ khỏi stream quay video,
/// đồng thời tìm các `SCWindow` ngoại lệ (như overlay phím bấm `record-keystroke`)
/// để cho phép xuất hiện trong video quay.
type DisplayQuery = (Retained<SCDisplay>, Vec<Retained<SCRunningApplication>>, Vec<Retained<SCWindow>>);

fn find_display_and_own_apps(display_id: u32, excepting_window_ids: &[u32]) -> Result<DisplayQuery, String> {
    // Overlay phím bấm/click vừa tạo có thể CHƯA được WindowServer đưa vào
    // SCShareableContent — thiếu nó trong danh sách ngoại lệ thì overlay bị
    // loại khỏi video. Thử lại vài lần (tổng tối đa ~0.5s) tới khi thấy đủ,
    // thay vì 1 lần ngủ cố định 60ms như trước (không chắc đủ trên máy chậm).
    let mut last = None;
    for attempt in 0..6 {
        if !excepting_window_ids.is_empty() {
            std::thread::sleep(Duration::from_millis(if attempt == 0 { 40 } else { 80 }));
        }
        let r = query_display_once(display_id, excepting_window_ids)?;
        let found = excepting_window_ids
            .iter()
            .filter(|id| r.2.iter().any(|w| unsafe { w.windowID() } == **id))
            .count();
        let complete = found == excepting_window_ids.len();
        last = Some(r);
        if complete {
            break;
        }
    }
    last.ok_or_else(|| "Không lấy được danh sách màn hình".to_string())
}

fn query_display_once(display_id: u32, excepting_window_ids: &[u32]) -> Result<DisplayQuery, String> {
    let my_pid = std::process::id();
    let excepting_ids = excepting_window_ids.to_vec();

    let (tx, rx) = mpsc::channel::<Result<DisplayQuery, String>>();
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
        let found_display = displays
            .iter()
            .find(|d| unsafe { d.displayID() } == display_id);
        let Some(display) = found_display else {
            let _ = tx.send(Err("Không tìm thấy màn hình để quay".to_string()));
            return;
        };

        let apps = unsafe { content.applications() };
        let own_apps: Vec<Retained<SCRunningApplication>> = apps
            .iter()
            .filter(|a| unsafe { a.processID() } as u32 == my_pid)
            .collect();

        let windows = unsafe { content.windows() };
        let excepting_windows: Vec<Retained<SCWindow>> = windows
            .iter()
            .filter(|w| {
                let wid = unsafe { w.windowID() };
                if excepting_ids.contains(&wid) {
                    return true;
                }
                let is_own = unsafe { w.owningApplication() }
                    .map(|a| unsafe { a.processID() } as u32 == my_pid)
                    .unwrap_or(false);
                if is_own {
                    if let Some(t) = unsafe { w.title() } {
                        let t_str = t.to_string();
                        if t_str.contains("Phím bấm")
                            || t_str.contains("record-keystroke")
                            || t_str.contains("Click chuột")
                            || t_str.contains("record-clicks")
                        {
                            return true;
                        }
                    }
                }
                false
            })
            .collect();

        eprintln!(
            "[SnapDoc][record] SCContentFilter: tìm thấy {} cửa sổ ngoại lệ (phím bấm) (excepting_ids={:?})",
            excepting_windows.len(),
            excepting_ids
        );

        let _ = tx.send(Ok((display, own_apps, excepting_windows)));
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
/// `stop()`. `Drop` là lưới an toàn cho nhánh LỖI (khởi động thất bại sau khi
/// stream đã chạy): dừng SCStream fire-and-forget, không để phiên capture của
/// OS chạy mồ côi (đèn "đang ghi màn hình" của macOS sáng mãi).
pub struct RecordingHandle {
    stream: Retained<SCStream>,
    _handler: Retained<StreamOutputHandler>,
    /// `stop()` đã được gọi tường minh — `Drop` không cần dừng lại lần nữa.
    stopped: bool,
    latest: LatestFrame,
    audio_tx: Arc<Mutex<Option<mpsc::SyncSender<PcmChunk>>>>,
    /// Cờ dùng chung với `StreamOutputIvars` — SCK đã tự dừng ngoài ý muốn.
    stopped_externally: Arc<AtomicBool>,
    /// Kích thước pixel của mỗi frame — cố định cho suốt phiên quay, khớp đúng
    /// `SCStreamConfiguration` lúc `start()` (đã giới hạn trong 4K).
    pub width: u32,
    pub height: u32,
}

// SAFETY: SCStream tự quản lý đồng bộ nội bộ (GCD); ta chỉ giữ Retained để nó
// không bị giải phóng, và chỉ gọi các phương thức của nó tuần tự từ 1 thread
// điều khiển (không có &mut chia sẻ giữa các thread).
unsafe impl Send for RecordingHandle {}

impl RecordingHandle {
    /// Ô frame mới nhất — `record::pacer` đọc theo nhịp fps.
    pub fn latest(&self) -> LatestFrame {
        self.latest.clone()
    }

    /// Đóng sender audio hệ thống để writer PCM thấy EOF.
    fn close_audio_sender(&self) {
        self.audio_tx.lock().unwrap_or_else(|p| p.into_inner()).take();
    }

    /// SCK đã tự dừng ngoài ý muốn (vd người dùng bấm "Stop" trên icon
    /// "Screen Sharing" của hệ thống macOS) hay chưa.
    pub fn is_stopped_externally(&self) -> bool {
        self.stopped_externally.load(Ordering::SeqCst)
    }

    /// Dừng quay, đợi SCStream xác nhận đã dừng hẳn (có timeout).
    pub fn stop(mut self) -> Result<(), String> {
        // Đánh dấu NGAY từ đầu — kể cả khi các bước dưới lỗi/timeout, Drop
        // cũng không được lặp lại việc dừng (yêu cầu dừng đã được gửi đi).
        self.stopped = true;
        self.close_audio_sender();

        // SCK đã tự dừng rồi — gọi lại `stopCapture` trên 1 stream không còn
        // chạy có thể không bao giờ gọi completion handler (chờ hết TIMEOUT vô ích).
        if self.stopped_externally.load(Ordering::SeqCst) {
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let handler = RcBlock::new(move |err: *mut objc2_foundation::NSError| {
            let r = if err.is_null() {
                Ok(())
            } else {
                Err(format!("Lỗi dừng quay: {}", unsafe { (*err).localizedDescription() }))
            };
            let _ = tx.send(r);
        });
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&handler)) };
        rx.recv_timeout(TIMEOUT)
            .map_err(|_| "Hết thời gian chờ dừng quay".to_string())?
    }
}

impl Drop for RecordingHandle {
    fn drop(&mut self) {
        self.close_audio_sender();
        if self.stopped || self.stopped_externally.load(Ordering::SeqCst) {
            return;
        }
        eprintln!("[SnapDoc][record] RecordingHandle bị drop khi chưa stop() — dừng SCStream khẩn cấp");
        unsafe { self.stream.stopCaptureWithCompletionHandler(None) };
    }
}

/// Bắt đầu quay theo `RecordTarget` (toàn màn hình / 1 vùng / 1 cửa sổ).
///
/// `capture_system_audio`: bật `SCStreamConfiguration.capturesAudio` — audio
/// HỆ THỐNG (loa), KHÔNG phải mic (mic dùng `record::audio_mic`). Trả về
/// `RecordingHandle` + `Receiver` PCM s16le `AUDIO_SAMPLE_RATE`/`AUDIO_CHANNELS`
/// của audio hệ thống (`Some` chỉ khi `capture_system_audio=true`).
pub fn start(
    target: RecordTarget,
    fps: u32,
    capture_system_audio: bool,
    exclude_own_app: bool,
    excepting_window_ids: &[u32],
) -> Result<(RecordingHandle, Option<mpsc::Receiver<PcmChunk>>), String> {
    // `source_rect`: Some khi quay 1 VÙNG (crop qua `SCStreamConfiguration`),
    // None khi quay trọn nội dung của filter (toàn màn hình hoặc cả cửa sổ).
    let (filter, source_rect): (Retained<SCContentFilter>, Option<CGRect>) = match &target {
        RecordTarget::Display(display_id) | RecordTarget::Region { display_id, .. } => {
            let (display, own_apps, excepting_windows) = find_display_and_own_apps(*display_id, excepting_window_ids)?;
            let empty_apps: Vec<Retained<SCRunningApplication>> = vec![];
            let own_apps_arr = if exclude_own_app {
                NSArray::from_retained_slice(&own_apps)
            } else {
                NSArray::from_retained_slice(&empty_apps)
            };
            let empty_windows: Vec<Retained<SCWindow>> = vec![];
            let excepting_windows_arr = if exclude_own_app {
                NSArray::from_retained_slice(&excepting_windows)
            } else {
                NSArray::from_retained_slice(&empty_windows)
            };
            // Loại trừ toàn bộ các cửa sổ của SnapDoc (khi exclude_own_app=true),
            // NGOẠI TRỪ các cửa sổ trong exceptingWindows (overlay phím bấm/click).
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &own_apps_arr,
                    &excepting_windows_arr,
                )
            };
            let rect = match &target {
                RecordTarget::Region { x, y, w, h, .. } => Some(CGRect {
                    origin: CGPoint { x: *x, y: *y },
                    size: CGSize { width: *w, height: *h },
                }),
                _ => None,
            };
            (filter, rect)
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
        ((rect.size.width * scale).round().max(2.0) as u32, (rect.size.height * scale).round().max(2.0) as u32)
    } else {
        let content_rect: CGRect = unsafe { filter.contentRect() };
        (
            (content_rect.size.width * scale).round().max(2.0) as u32,
            (content_rect.size.height * scale).round().max(2.0) as u32,
        )
    };
    // Giới hạn trong 4K (màn 5K/6K Retina vượt giới hạn H.264 của encoder phần
    // cứng và đẩy hàng GB/s qua pipe) — SCK tự thu nhỏ trên GPU, gần như miễn
    // phí. Đồng thời ép SỐ CHẴN: `yuv420p` đòi width/height chẵn (vùng chọn
    // tự do rất dễ ra số lẻ, vd 1822×1161 → ffmpeg từ chối ngay khi encode).
    let (px_w, px_h) = fit_even(
        px_w,
        px_h,
        crate::record::encoder::MAX_LONG_EDGE,
        crate::record::encoder::MAX_SHORT_EDGE,
    );
    let (px_w, px_h) = (px_w as usize, px_h as usize);

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
        }
    }

    // Audio đến theo packet nhỏ (~10-20ms/lần) — ~2s đệm.
    let (audio_tx, audio_rx) = if capture_system_audio {
        let (tx, rx) = mpsc::sync_channel::<PcmChunk>(200);
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let audio_tx = Arc::new(Mutex::new(audio_tx));
    let stopped_externally = Arc::new(AtomicBool::new(false));
    let latest = super::frame::new_latest();
    let handler_obj = StreamOutputHandler::new(latest.clone(), audio_tx.clone(), stopped_externally.clone());

    let delegate_proto = ProtocolObject::from_ref(&*handler_obj);
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &config,
            Some(delegate_proto),
        )
    };

    // Dispatch queue riêng cho callback (không dùng main queue để callback
    // nhận frame liên tục không bị chặn bởi UI thread).
    let queue = DispatchQueue::new("com.snapdoc.record.video", None);
    let output_proto = ProtocolObject::from_ref(&*handler_obj);
    unsafe {
        stream
            .addStreamOutput_type_sampleHandlerQueue_error(output_proto, SCStreamOutputType::Screen, Some(&queue))
            .map_err(|e| format!("Không thêm được stream output: {}", e.localizedDescription()))?;
    }
    if capture_system_audio {
        // Queue RIÊNG cho audio — 1 lượt copy khung hình (vài ms) không làm trễ audio.
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
            Err(format!("Lỗi bắt đầu quay: {}", unsafe { (*err).localizedDescription() }))
        };
        let _ = start_tx.send(r);
    });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&start_handler)) };
    match start_rx.recv_timeout(TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            // Có thể capture vẫn khởi động muộn — yêu cầu dừng để không bỏ
            // lại phiên capture mồ côi.
            unsafe { stream.stopCaptureWithCompletionHandler(None) };
            return Err("Hết thời gian chờ bắt đầu quay".to_string());
        }
    }

    Ok((
        RecordingHandle {
            stream,
            _handler: handler_obj,
            stopped: false,
            latest,
            audio_tx,
            stopped_externally,
            width: px_w as u32,
            height: px_h as u32,
        },
        audio_rx,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test thủ công: quay 2 giây, kiểm tra có frame và lưu frame cuối ra PNG.
    /// Chạy: `cargo test --package snapdoc -- --ignored --nocapture mac_stream`
    /// Yêu cầu: Terminal/iTerm đã được cấp quyền Screen Recording.
    #[test]
    #[ignore]
    fn captures_real_frames() {
        use xcap::Monitor;

        let monitor = Monitor::all().unwrap().into_iter().find(|m| m.is_primary().unwrap_or(false)).unwrap();
        let display_id = monitor.id().unwrap();
        let (handle, _audio_rx) =
            start(RecordTarget::Display(display_id), 30, false, false, &[]).expect("start() thất bại");
        std::thread::sleep(Duration::from_secs(2));
        let frame = handle.latest().lock().unwrap().clone();
        handle.stop().expect("stop() thất bại");

        let frame = frame.expect("không nhận được frame nào");
        assert_eq!(frame.bgra.len(), (frame.width * frame.height * 4) as usize);
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
