//! Ghi âm thanh HỆ THỐNG (loa) trên Windows qua WASAPI loopback — dùng
//! `cpal` (đã có sẵn cho `audio_mic.rs`) thay vì thêm crate `wasapi` riêng
//! (xem plan Phase 5, mục "cpal vs dedicated wasapi crate": giữ mặt bằng
//! dependency phẳng, tái dùng đúng pattern callback đã có). "Mẹo" loopback:
//! `cpal`'s backend WASAPI trên Windows tự nhận diện khi `build_input_stream()`
//! được gọi trên 1 thiết bị OUTPUT (loa) thay vì INPUT (mic), và tự đặt cờ
//! `AUDCLNT_STREAMFLAGS_LOOPBACK` nội bộ — API công khai gọi giống hệt
//! `audio_mic.rs`, chỉ khác lấy `default_output_device()` thay vì
//! `default_input_device()`.
//!
//! LƯU Ý: hành vi loopback này viết theo tài liệu/PR đã biết của `cpal` lúc
//! lên plan — CHƯA build/test được trên Windows thật trong môi trường phát
//! triển này (macOS). Nếu phiên bản `cpal` cài đặt không hỗ trợ (báo lỗi rõ
//! ràng ở `build_input_stream`, không phải panic), phương án dự phòng đã ghi
//! trong plan là chuyển riêng module này sang crate `wasapi` chuyên dụng,
//! không ảnh hưởng `audio_mic.rs`/phần còn lại.
//!
//! Cấu trúc song song với `audio_mic.rs`: `cpal::Stream` không `Send` nên 1
//! thread riêng sở hữu toàn bộ vòng đời (tạo, `play()`, chờ tín hiệu dừng,
//! drop) — bên ngoài chỉ cầm `JoinHandle` + `Sender<()>` để báo dừng.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc;
use std::thread::JoinHandle;

/// Tay cầm 1 phiên ghi audio hệ thống đang chạy — gọi `stop()` để dừng, cùng
/// vai trò `MicCapture::stop()` bên `audio_mic.rs`.
pub struct SystemAudioCapture {
    stop_tx: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl SystemAudioCapture {
    pub fn stop(self) {
        let _ = self.stop_tx.send(());
        let _ = self.thread.join();
    }
}

/// Bắt đầu ghi audio hệ thống (loopback trên thiết bị phát mặc định). Trả về
/// tay cầm điều khiển + `Receiver<Vec<u8>>` PCM i16 interleaved + sample
/// rate/số kênh THẬT của thiết bị (không cố định như audio hệ thống bên
/// macOS — Windows không có API cấu hình cứng format như
/// `SCStreamConfiguration`, `encoder::mux_audio` đã nhận tham số này động).
pub fn start() -> Result<(SystemAudioCapture, mpsc::Receiver<Vec<u8>>, u32, u16), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "Không tìm thấy thiết bị phát âm thanh để ghi audio hệ thống".to_string())?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("Không đọc được cấu hình thiết bị phát âm thanh: {e}"))?;

    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let sample_format = config.sample_format();

    // Đợi thread dựng xong stream rồi mới trả `start()` về cho caller — nếu
    // build lỗi (vd cpal không hỗ trợ loopback trên thiết bị/driver này), báo
    // lỗi NGAY thay vì để caller tưởng đã chạy trong khi thread nền đã chết.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (pcm_tx, pcm_rx) = mpsc::sync_channel::<Vec<u8>>(200);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let thread = std::thread::spawn(move || {
        let err_fn = |e: cpal::Error| {
            eprintln!("[SnapDoc][record] Lỗi luồng audio hệ thống: {e}");
        };
        let stream_config: cpal::StreamConfig = config.into();

        // Gọi `build_input_stream` trên thiết bị OUTPUT — chính là "mẹo"
        // loopback của cpal (xem doc-comment đầu file).
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
                let _ = ready_tx.send(Err(format!("Định dạng audio hệ thống không hỗ trợ: {other:?}")));
                return;
            }
        };

        let stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(format!(
                    "Không tạo được luồng ghi audio hệ thống (loopback): {e}"
                )));
                return;
            }
        };

        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(format!("Không bắt đầu ghi audio hệ thống: {e}")));
            return;
        }

        let _ = ready_tx.send(Ok(()));

        // Giữ `stream` sống tới khi có tín hiệu dừng — drop ở cuối scope này
        // tự dừng WASAPI capture client.
        let _ = stop_rx.recv();
        drop(stream);
    });

    ready_rx
        .recv()
        .map_err(|_| "Luồng ghi audio hệ thống bị panic lúc khởi động".to_string())??;

    Ok((SystemAudioCapture { stop_tx, thread }, pcm_rx, sample_rate, channels))
}
