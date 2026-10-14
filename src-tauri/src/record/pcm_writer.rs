//! Ghi PCM s16le thô (mic hoặc audio hệ thống) ra file trong lúc quay, BÁM
//! THEO đồng hồ chung của phiên quay (`RecordingClock`).
//!
//! PCM thô không có timestamp: ffmpeg coi byte thứ N là thời điểm N/byte_rate.
//! Bản cũ ghi thẳng mọi chunk nhận được nên bất kỳ "lỗ" nào trong luồng audio
//! đều dồn toàn bộ phần sau lên sớm hơn và làm file ngắn hơn video:
//! - WASAPI loopback KHÔNG gửi gói nào khi máy im lặng,
//! - mic bị rút/AirPods mất kết nối/đổi sample rate (cpal dừng stream),
//! - chunk bị drop vì kênh đầy, mic macOS khởi động SAU video...
//! (kết hợp `-shortest` lúc ghép → video bị cắt cụt theo độ dài audio).
//!
//! Mỗi gói được ĐÓNG MỐC thời điểm thu ngay trong callback của thiết bị
//! (`PcmChunk`), rồi so với "đáng lẽ phải ở đâu" theo đồng hồ chung — writer
//! bị khựng (đĩa chậm) cũng không làm lệch tiếng:
//! - thu TRƯỚC mốc 0 của phiên quay (pre-roll lúc khởi động) / trong lúc
//!   pause / sau mốc dừng → bỏ,
//! - gói đầu tiên: đệm lặng CHÍNH XÁC từ mốc 0 (mic mở chậm vài trăm ms vẫn khớp),
//! - tụt sau đồng hồ quá `SLACK` → chèn khoảng lặng cho khớp,
//! - vượt trước đồng hồ quá `SLACK` (clock thiết bị chạy nhanh hơn) → cắt phần thừa.

use super::clock::{Position, RecordingClock};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// 1 gói PCM s16le xen kẽ + thời điểm thu (lúc callback của thiết bị chạy).
pub type PcmChunk = (Instant, Vec<u8>);

/// Dung sai cho phép trước khi chèn lặng/cắt bớt — lớn hơn jitter thời điểm
/// gọi callback của driver để không chèn lặng giả giữa chừng.
const SLACK: Duration = Duration::from_millis(80);

#[derive(Clone, Copy, Debug)]
pub struct PcmFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

impl PcmFormat {
    fn frame_bytes(&self) -> u64 {
        self.channels.max(1) as u64 * 2
    }

    /// Số byte (đã căn theo frame) tương ứng với `d`.
    fn bytes_for(&self, d: Duration) -> u64 {
        let frames = d.as_nanos() * self.sample_rate as u128 / 1_000_000_000;
        frames as u64 * self.frame_bytes()
    }
}

#[derive(Default, Debug, Clone, Copy)]
pub struct PcmStats {
    /// Tổng byte audio THẬT (không tính lặng chèn thêm) đã ghi.
    pub real_bytes: u64,
    /// Tổng thời lượng lặng đã chèn để giữ đồng bộ.
    pub padded: Duration,
    pub io_error: bool,
}

/// Trạng thái ghi — tách khỏi thread để test được trực tiếp.
struct Sink<W: Write> {
    out: W,
    fmt: PcmFormat,
    written: u64,
    stats: PcmStats,
}

impl<W: Write> Sink<W> {
    fn new(out: W, fmt: PcmFormat) -> Self {
        Sink { out, fmt, written: 0, stats: PcmStats::default() }
    }

    /// `elapsed`: vị trí trong bản quay tại thời điểm thu gói (= cuối gói).
    fn push(&mut self, chunk: &[u8], elapsed: Duration) -> std::io::Result<()> {
        let fb = self.fmt.frame_bytes();
        // Chỉ ghi trọn frame — phần lẻ (không xảy ra với cpal/SCK) bỏ đi để
        // không bao giờ làm lệch kênh trái/phải.
        let usable = chunk.len() as u64 / fb * fb;
        let mut chunk = &chunk[..usable as usize];
        if chunk.is_empty() {
            return Ok(());
        }
        let expected = self.fmt.bytes_for(elapsed);
        // Gói đầu tiên: căn CHÍNH XÁC vào đồng hồ (không dung sai) — dung sai
        // chỉ để bỏ qua jitter giữa các gói liên tiếp.
        let slack = if self.written == 0 { 0 } else { self.fmt.bytes_for(SLACK) };
        let after = self.written + chunk.len() as u64;

        if expected > after + slack {
            // Tụt sau đồng hồ: chèn lặng sao cho chunk này kết thúc đúng tại "bây giờ".
            let pad = expected - after;
            self.write_silence(pad)?;
            self.stats.padded += Duration::from_nanos(
                (pad / fb) as u64 * 1_000_000_000 / self.fmt.sample_rate.max(1) as u64,
            );
        } else if after > expected + slack {
            // Vượt trước đồng hồ: bỏ phần đầu thừa của chunk.
            let excess = (after - expected) / fb * fb;
            if excess as usize >= chunk.len() {
                return Ok(());
            }
            chunk = &chunk[excess as usize..];
        }
        self.out.write_all(chunk)?;
        self.written += chunk.len() as u64;
        self.stats.real_bytes += chunk.len() as u64;
        Ok(())
    }

    fn write_silence(&mut self, mut n: u64) -> std::io::Result<()> {
        const ZEROS: [u8; 8192] = [0u8; 8192];
        self.written += n;
        while n > 0 {
            let k = n.min(ZEROS.len() as u64) as usize;
            self.out.write_all(&ZEROS[..k])?;
            n -= k as u64;
        }
        Ok(())
    }
}

/// Spawn thread ghi `rx` ra `path`. Thread kết thúc khi `stop` được bật hoặc
/// kênh đóng; trả `PcmStats` qua `JoinHandle`.
pub fn spawn(
    path: PathBuf,
    rx: Receiver<PcmChunk>,
    fmt: PcmFormat,
    clock: Arc<RecordingClock>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<PcmStats> {
    std::thread::Builder::new()
        .name("snapdoc-pcm-writer".into())
        .spawn(move || {
            let file = match std::fs::File::create(&path) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("[SnapDoc][record] Không tạo được file audio tạm {}: {e}", path.display());
                    // Vẫn phải xả kênh tới khi dừng, không thì phía capture đầy kênh.
                    while !stop.load(Ordering::SeqCst) {
                        match rx.recv_timeout(Duration::from_millis(50)) {
                            Err(RecvTimeoutError::Disconnected) => break,
                            _ => {}
                        }
                    }
                    return PcmStats { io_error: true, ..Default::default() };
                }
            };
            let mut sink = Sink::new(std::io::BufWriter::with_capacity(256 * 1024, file), fmt);
            let handle = |(captured_at, chunk): PcmChunk, sink: &mut Sink<_>| -> bool {
                // Thu trước mốc 0 (pre-roll), trong lúc pause hoặc sau mốc dừng → bỏ.
                let Position::At(elapsed) = clock.position(captured_at) else { return true };
                if let Err(e) = sink.push(&chunk, elapsed) {
                    eprintln!("[SnapDoc][record] Lỗi ghi file audio tạm {}: {e}", path.display());
                    sink.stats.io_error = true;
                    return false;
                }
                true
            };
            loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(chunk) => {
                        if !handle(chunk, &mut sink) {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            // Xả nốt các chunk còn trong kênh (gói thu sau mốc dừng tự bị bỏ).
            if !sink.stats.io_error {
                while let Ok(chunk) = rx.try_recv() {
                    if !handle(chunk, &mut sink) {
                        break;
                    }
                }
            }
            if sink.out.flush().is_err() {
                sink.stats.io_error = true;
            }
            sink.stats
        })
        .expect("không tạo được thread ghi audio")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn sink() -> Sink<Vec<u8>> {
        Sink::new(Vec::new(), PcmFormat { sample_rate: 1000, channels: 1 })
    }

    /// 1000Hz mono s16 → 2 byte/ms.
    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn contiguous_stream_has_no_padding() {
        let mut s = sink();
        for i in 1..=50u64 {
            s.push(&vec![1u8; 20], ms(i * 10)).unwrap();
        }
        assert_eq!(s.out.len(), 50 * 20);
        assert_eq!(s.stats.padded, Duration::ZERO);
        assert!(s.out.iter().all(|&b| b == 1));
    }

    /// Mô phỏng WASAPI loopback: im lặng 2 giây không có gói nào.
    #[test]
    fn gap_is_filled_with_silence() {
        let mut s = sink();
        s.push(&vec![1u8; 200], ms(100)).unwrap(); // 0–100ms
        s.push(&vec![1u8; 200], ms(2200)).unwrap(); // gói kế tiếp tới sau 2.1s
        // Tổng phải đúng 2200ms = 4400 byte, chunk cuối nằm ở 2100–2200ms.
        assert_eq!(s.out.len(), 4400);
        assert!(s.out[200..4200].iter().all(|&b| b == 0));
        assert!(s.out[4200..].iter().all(|&b| b == 1));
        assert!(s.stats.padded >= ms(2000));
    }

    #[test]
    fn late_start_is_padded_from_zero() {
        // Mic macOS mở xong sau 400ms kể từ mốc 0.
        let mut s = sink();
        s.push(&vec![1u8; 20], ms(410)).unwrap();
        assert_eq!(s.out.len(), 820);
        assert!(s.out[..800].iter().all(|&b| b == 0));
    }

    #[test]
    fn excess_ahead_of_clock_is_trimmed() {
        let mut s = sink();
        // 600ms audio dồn tới khi đồng hồ mới chạy 100ms.
        s.push(&vec![1u8; 1200], ms(100)).unwrap();
        assert_eq!(s.out.len(), 200);
    }

    #[test]
    fn jitter_within_slack_is_untouched() {
        let mut s = sink();
        s.push(&vec![1u8; 200], ms(100)).unwrap();
        s.push(&vec![1u8; 200], ms(260)).unwrap(); // callback trễ 60ms < SLACK
        s.push(&vec![1u8; 200], ms(270)).unwrap(); // rồi dồn sớm hơn
        assert_eq!(s.out.len(), 600);
        assert_eq!(s.stats.padded, Duration::ZERO);
    }

    #[test]
    fn first_chunk_is_aligned_exactly_even_within_slack() {
        // Mic mở xong 50ms sau mốc 0 (< SLACK) vẫn phải đệm đúng 50ms.
        let mut s = sink();
        s.push(&vec![1u8; 20], ms(60)).unwrap();
        assert_eq!(s.out.len(), 120);
        assert!(s.out[..100].iter().all(|&b| b == 0));
    }

    #[test]
    fn writer_uses_capture_time_not_dequeue_time() {
        let clock = RecordingClock::new();
        clock.start();
        let dir = std::env::temp_dir().join(format!("snapdoc_pcm_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.pcm");
        let (tx, rx) = std::sync::mpsc::sync_channel::<PcmChunk>(1000);
        let stop = Arc::new(AtomicBool::new(false));
        let fmt = PcmFormat { sample_rate: 1000, channels: 1 };
        // 30 gói 10ms thu liên tục (mốc thu chính xác), tất cả nằm chờ trong
        // kênh TRƯỚC khi writer kịp chạy (mô phỏng writer khựng 400ms).
        let t0 = Instant::now();
        for i in 0..30u64 {
            tx.send((t0 + Duration::from_millis((i + 1) * 10), vec![1u8; 20])).unwrap();
        }
        std::thread::sleep(Duration::from_millis(400));
        let h = spawn(path.clone(), rx, fmt, clock.clone(), stop.clone());
        std::thread::sleep(Duration::from_millis(50));
        drop(tx);
        let stats = h.join().unwrap();
        // Không được chèn lặng giả hay bỏ audio thật chỉ vì writer chạy muộn.
        assert_eq!(stats.real_bytes, 30 * 20, "{stats:?}");
        assert!(stats.padded < Duration::from_millis(5), "{stats:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn odd_bytes_never_split_frames() {
        let mut s = Sink::new(Vec::new(), PcmFormat { sample_rate: 1000, channels: 2 });
        s.push(&vec![1u8; 7], ms(2)).unwrap();
        assert_eq!(s.out.len() % 4, 0);
    }
}
