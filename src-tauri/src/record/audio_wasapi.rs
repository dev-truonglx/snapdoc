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
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;

use super::pcm_writer::PcmChunk;

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
/// tay cầm + `Receiver<PcmChunk>` (thời điểm thu + PCM s16le) + sample rate/số kênh THẬT
/// + cờ "thiết bị lỗi giữa chừng".
///
/// LƯU Ý: WASAPI loopback KHÔNG gửi gói nào khi không có âm thanh đang phát —
/// `record::pcm_writer` bám đồng hồ của phiên quay để chèn lặng đúng chỗ đó.
pub fn start() -> Result<(SystemAudioCapture, mpsc::Receiver<PcmChunk>, u32, u16, Arc<AtomicBool>), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "Không tìm thấy thiết bị phát âm thanh để ghi audio hệ thống".to_string())?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("Không đọc được cấu hình thiết bị phát âm thanh: {e}"))?;

    let sample_rate = config.sample_rate();
    let channels = config.channels();

    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (pcm_tx, pcm_rx) = mpsc::sync_channel::<PcmChunk>(200);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let device_error = Arc::new(AtomicBool::new(false));
    let err_flag = device_error.clone();

    let thread = std::thread::Builder::new()
        .name("snapdoc-system-audio".into())
        .spawn(move || {
            // Gọi `build_input_stream` trên thiết bị OUTPUT — chính là "mẹo"
            // loopback của cpal (xem doc-comment đầu file).
            let stream = match super::audio_mic::build_pcm_input_stream(&device, config, pcm_tx, err_flag, "âm thanh hệ thống") {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("{e} (loopback)")));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(format!("Không bắt đầu ghi audio hệ thống: {e}")));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            // Giữ `stream` sống tới khi có tín hiệu dừng — drop tự dừng WASAPI capture client.
            let _ = stop_rx.recv();
            drop(stream);
        })
        .map_err(|e| format!("Không tạo được thread ghi audio hệ thống: {e}"))?;

    ready_rx
        .recv()
        .map_err(|_| "Luồng ghi audio hệ thống bị panic lúc khởi động".to_string())??;

    Ok((SystemAudioCapture { stop_tx, thread }, pcm_rx, sample_rate, channels, device_error))
}
