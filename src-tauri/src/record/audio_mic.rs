//! Ghi âm MICRO — độc lập với `capture::mac_stream` (audio hệ thống qua
//! ScreenCaptureKit). Lý do tách riêng: `SCStreamConfiguration.captureMicrophone`
//! chỉ có từ macOS 15, trong khi app hỗ trợ tối thiểu macOS 14 (xem
//! `tauri.conf.json` → `bundle.macOS.minimumSystemVersion`) — dùng `cpal`
//! (CoreAudio HAL trực tiếp) để hoạt động trên mọi phiên bản macOS mà app hỗ
//! trợ, không phụ thuộc API mới của SCK.
//!
//! `cpal::Stream` không đảm bảo `Send` nên KHÔNG thể giữ trong `ActiveRecording`
//! (field đó nằm trong `Mutex` có thể bị `.take()` từ thread khác thread tạo
//! ra nó). Giải pháp: 1 thread riêng "sở hữu" toàn bộ vòng đời của `Stream`
//! (tạo, `play()`, chờ tín hiệu dừng, drop) — bên ngoài chỉ cầm `JoinHandle`
//! + `Sender<()>` để báo dừng, cả 2 đều `Send` bình thường.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::pcm_writer::PcmChunk;

/// Tay cầm 1 phiên ghi mic đang chạy — gọi `stop()` để dừng (drop `Stream`
/// → đóng `pcm_tx` phía trong, writer thread thấy kênh đóng).
pub struct MicCapture {
    stop_tx: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl MicCapture {
    /// Dừng ghi mic, đợi thread nội bộ dọn dẹp xong (chỉ là `drop(stream)`).
    pub fn stop(self) {
        let _ = self.stop_tx.send(());
        let _ = self.thread.join();
    }
}

/// Pre-warm audio subsystem and default microphone endpoint in background.
pub fn prewarm() {
    std::thread::Builder::new()
        .name("snapdoc-mic-prewarm".into())
        .spawn(|| {
            let host = cpal::default_host();
            if let Some(device) = host.default_input_device() {
                let _ = device.default_input_config();
            }
        })
        .ok();
}

/// Dựng input stream cpal chuyển MỌI định dạng mẫu phổ biến sang PCM s16le
/// xen kẽ, gửi từng đợt qua `tx` (kênh đầy thì bỏ gói — `pcm_writer` tự chèn
/// lặng đúng chỗ đó). Lỗi luồng giữa chừng (rút thiết bị, đổi sample rate,
/// mất kết nối Bluetooth...) bật `device_error` để báo người dùng sau khi dừng.
pub(crate) fn build_pcm_input_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    tx: mpsc::SyncSender<PcmChunk>,
    device_error: Arc<AtomicBool>,
    what: &'static str,
) -> Result<cpal::Stream, String> {
    fn build<T>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        tx: mpsc::SyncSender<PcmChunk>,
        device_error: Arc<AtomicBool>,
        what: &'static str,
    ) -> Result<cpal::Stream, String>
    where
        T: cpal::SizedSample,
        i16: cpal::FromSample<T>,
    {
        device
            .build_input_stream(
                config,
                move |data: &[T], _: &cpal::InputCallbackInfo| {
                    // Đóng mốc NGAY lúc thu — writer bị khựng vẫn đặt đúng chỗ.
                    let captured_at = Instant::now();
                    let mut bytes = Vec::with_capacity(data.len() * 2);
                    for &s in data {
                        let v: i16 = cpal::FromSample::from_sample_(s);
                        bytes.extend_from_slice(&v.to_le_bytes());
                    }
                    let _ = tx.try_send((captured_at, bytes));
                },
                move |e: cpal::Error| {
                    eprintln!("[SnapDoc][record] Lỗi luồng {what}: {e}");
                    device_error.store(true, Ordering::SeqCst);
                },
                // Windows: `ActivateAudioInterfaceAsync` không có timeout thì
                // có thể chờ vô hạn nếu driver kẹt.
                Some(Duration::from_secs(5)),
            )
            .map_err(|e| format!("Không tạo được luồng ghi {what}: {e}"))
    }

    let sample_format = config.sample_format();
    let cfg: cpal::StreamConfig = config.into();
    use cpal::SampleFormat as F;
    match sample_format {
        F::F32 => build::<f32>(device, cfg, tx, device_error, what),
        F::F64 => build::<f64>(device, cfg, tx, device_error, what),
        F::I8 => build::<i8>(device, cfg, tx, device_error, what),
        F::I16 => build::<i16>(device, cfg, tx, device_error, what),
        F::I24 => build::<cpal::I24>(device, cfg, tx, device_error, what),
        F::I32 => build::<i32>(device, cfg, tx, device_error, what),
        F::I64 => build::<i64>(device, cfg, tx, device_error, what),
        F::U8 => build::<u8>(device, cfg, tx, device_error, what),
        F::U16 => build::<u16>(device, cfg, tx, device_error, what),
        F::U32 => build::<u32>(device, cfg, tx, device_error, what),
        F::U64 => build::<u64>(device, cfg, tx, device_error, what),
        other => Err(format!("Định dạng {what} không hỗ trợ: {other:?}")),
    }
}

/// Bắt đầu ghi mic mặc định của hệ thống. Trả về tay cầm điều khiển +
/// `Receiver<PcmChunk>` (thời điểm thu + PCM s16le xen kẽ) + sample rate/số kênh THẬT của thiết
/// bị + cờ "thiết bị lỗi giữa chừng".
pub fn start() -> Result<(MicCapture, mpsc::Receiver<PcmChunk>, u32, u16, Arc<AtomicBool>), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "Không tìm thấy thiết bị micro".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("Không đọc được cấu hình micro: {e}"))?;

    let sample_rate = config.sample_rate();
    let channels = config.channels();

    // Đợi thread dựng xong stream rồi mới trả `start()` về cho caller — nếu
    // build lỗi (vd không có quyền micro), phải báo lỗi NGAY.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (pcm_tx, pcm_rx) = mpsc::sync_channel::<PcmChunk>(200);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let device_error = Arc::new(AtomicBool::new(false));
    let err_flag = device_error.clone();

    let thread = std::thread::Builder::new()
        .name("snapdoc-mic".into())
        .spawn(move || {
            let stream = match build_pcm_input_stream(&device, config, pcm_tx, err_flag, "mic") {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(format!("Không bắt đầu ghi mic: {e}")));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            // Giữ `stream` sống tới khi có tín hiệu dừng — drop tự dừng input unit.
            let _ = stop_rx.recv();
            drop(stream);
        })
        .map_err(|e| format!("Không tạo được thread ghi mic: {e}"))?;

    ready_rx
        .recv()
        .map_err(|_| "Luồng ghi mic bị panic lúc khởi động".to_string())??;

    Ok((MicCapture { stop_tx, thread }, pcm_rx, sample_rate, channels, device_error))
}
