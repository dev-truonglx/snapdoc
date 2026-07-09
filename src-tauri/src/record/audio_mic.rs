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
use std::sync::mpsc;
use std::thread::JoinHandle;

/// Tay cầm 1 phiên ghi mic đang chạy — gọi `stop()` để dừng (đóng
/// `pcm_tx` phía trong, cho writer thread đọc `Receiver<Vec<u8>>` biết ghi
/// xong, tương tự cách `RecordingHandle::stop()` đóng kênh video/audio hệ thống).
pub struct MicCapture {
    stop_tx: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl MicCapture {
    /// Dừng ghi mic, đợi thread nội bộ dọn dẹp xong (rất nhanh — chỉ là
    /// `drop(stream)`, không có I/O chờ lâu như `stop()` của SCStream).
    pub fn stop(self) {
        let _ = self.stop_tx.send(());
        let _ = self.thread.join();
    }
}

/// Bắt đầu ghi mic mặc định của hệ thống. Trả về tay cầm điều khiển +
/// `Receiver<Vec<u8>>` PCM i16 interleaved (mỗi lần cpal callback 1 đợt) +
/// sample rate/số kênh THẬT của thiết bị (không cố định như audio hệ thống —
/// mỗi mic phần cứng có thể khác nhau, ffmpeg sẽ tự resample qua `aresample`
/// trong filter_complex, xem `encoder.rs`).
pub fn start() -> Result<(MicCapture, mpsc::Receiver<Vec<u8>>, u32, u16), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "Không tìm thấy thiết bị micro".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("Không đọc được cấu hình micro: {e}"))?;

    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let sample_format = config.sample_format();

    // Đợi thread dựng xong stream rồi mới trả `start()` về cho caller — nếu
    // build lỗi (vd không có quyền micro), phải báo lỗi NGAY thay vì để
    // caller tưởng đã chạy trong khi thread nền đã chết từ đầu.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (pcm_tx, pcm_rx) = mpsc::sync_channel::<Vec<u8>>(200);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let thread = std::thread::spawn(move || {
        let err_fn = |e: cpal::Error| {
            eprintln!("[SnapDoc][record] Lỗi luồng mic: {e}");
        };
        let stream_config: cpal::StreamConfig = config.into();

        let stream_result = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mut bytes = Vec::with_capacity(data.len() * 2);
                    for &s in data {
                        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                        bytes.extend_from_slice(&v.to_le_bytes());
                    }
                    let _ = pcm_tx.try_send(bytes);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let mut bytes = Vec::with_capacity(data.len() * 2);
                    for &s in data {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    let _ = pcm_tx.try_send(bytes);
                },
                err_fn,
                None,
            ),
            other => {
                let _ = ready_tx.send(Err(format!("Định dạng mic không hỗ trợ: {other:?}")));
                return;
            }
        };

        let stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("Không tạo được luồng ghi mic: {e}")));
                return;
            }
        };

        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(format!("Không bắt đầu ghi mic: {e}")));
            return;
        }

        let _ = ready_tx.send(Ok(()));

        // Giữ `stream` sống tới khi có tín hiệu dừng — drop ở cuối scope này
        // tự dừng CoreAudio input unit.
        let _ = stop_rx.recv();
        drop(stream);
    });

    ready_rx
        .recv()
        .map_err(|_| "Luồng ghi mic bị panic lúc khởi động".to_string())??;

    Ok((MicCapture { stop_tx, thread }, pcm_rx, sample_rate, channels))
}
