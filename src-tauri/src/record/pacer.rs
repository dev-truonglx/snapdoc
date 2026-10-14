//! Nhịp đẩy frame vào encoder — DUY NHẤT cho mọi nền tảng.
//!
//! ffmpeg nhận rawvideo qua pipe với `-r fps` cố định: thời lượng video =
//! SỐ FRAME / fps, không có timestamp thật. Vì vậy số frame ghi ra phải bám
//! đúng đồng hồ của phiên quay (`RecordingClock`), nếu không video sẽ ngắn
//! hơn thực tế và lệch tiếng dần. 2 ticker cũ (mỗi nền tảng 1 cái) đều làm mất
//! frame: macOS nhảy cóc qua các nhịp bị trễ, cả 2 drop frame khi kênh đầy.
//!
//! Ở đây pacer tính "đến giờ này phải có bao nhiêu frame" từ đồng hồ chung
//! (đã trừ thời gian pause) rồi gửi 1 frame kèm SỐ LẦN LẶP (`repeat`) cho đủ
//! số frame còn nợ. Encoder bận (kênh đầy) thì giữ nợ, lần gửi sau lặp nhiều
//! hơn — nội dung có thể giật nhưng THỜI LƯỢNG luôn đúng, audio luôn khớp.

use super::clock::RecordingClock;
use crate::capture::frame::{Frame, LatestFrame};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// 1 frame + số lần ghi lặp liên tiếp vào encoder.
pub struct PacedFrame {
    pub frame: Arc<Frame>,
    pub repeat: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(u_period: u32) -> u32;
    fn timeEndPeriod(u_period: u32) -> u32;
}

/// Số frame phải có sau `elapsed` ở `fps` — frame thứ k phủ [k/fps, (k+1)/fps)
/// và "đến hạn" ngay khi đồng hồ vượt qua k/fps.
pub fn frames_due(elapsed: Duration, fps: u32) -> u64 {
    let n = elapsed.as_nanos() * fps.max(1) as u128;
    n.div_ceil(1_000_000_000) as u64
}

pub struct Pacer {
    /// Dừng ngay, không đẩy nốt (đường lỗi / Drop).
    abort: Arc<AtomicBool>,
    /// Đẩy nốt các frame còn nợ tới mốc `clock.stop()` rồi thoát (dừng quay bình thường).
    finish: Arc<AtomicBool>,
    lagging: Arc<AtomicBool>,
    /// Số frame đang nợ mà kênh chưa nhận (encoder bận) — watchdog dùng để
    /// phân biệt "encoder treo" với "không có gì để ghi" (pause, chờ frame đầu).
    backlog: Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

impl Pacer {
    pub fn spawn(latest: LatestFrame, clock: Arc<RecordingClock>, fps: u32, tx: SyncSender<PacedFrame>) -> Self {
        let abort = Arc::new(AtomicBool::new(false));
        let finish = Arc::new(AtomicBool::new(false));
        let lagging = Arc::new(AtomicBool::new(false));
        let backlog = Arc::new(AtomicU64::new(0));
        let (a, f, l, b) = (abort.clone(), finish.clone(), lagging.clone(), backlog.clone());
        let thread = std::thread::Builder::new()
            .name("snapdoc-record-pacer".into())
            .spawn(move || run(latest, clock, fps.max(1), tx, a, f, l, b))
            .expect("không tạo được thread pacer");
        Pacer { abort, finish, lagging, backlog, thread: Some(thread) }
    }

    pub fn backlog(&self) -> Arc<AtomicU64> {
        self.backlog.clone()
    }

    /// Encoder từng bị tụt lại > 2 giây (nội dung video có thể bị giật).
    pub fn lagging(&self) -> bool {
        self.lagging.load(Ordering::Relaxed)
    }

    /// Gọi SAU `clock.stop()`: đẩy nốt frame còn nợ rồi đóng kênh (writer thấy EOF).
    pub fn finish(mut self) {
        self.finish.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Pacer {
    fn drop(&mut self) {
        self.abort.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run(
    latest: LatestFrame,
    clock: Arc<RecordingClock>,
    fps: u32,
    tx: SyncSender<PacedFrame>,
    abort: Arc<AtomicBool>,
    finish: Arc<AtomicBool>,
    lagging: Arc<AtomicBool>,
    backlog: Arc<AtomicU64>,
) {
    // Độ phân giải timer mặc định của Windows là ~15.6ms — quá thô cho nhịp
    // 33ms; bật 1ms trong suốt vòng đời pacer.
    #[cfg(target_os = "windows")]
    unsafe {
        timeBeginPeriod(1);
    }

    let mut emitted: u64 = 0;
    loop {
        if abort.load(Ordering::SeqCst) {
            break;
        }
        let finishing = finish.load(Ordering::SeqCst);
        let Some(elapsed) = clock.elapsed() else {
            if finishing {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
            continue;
        };

        let due = frames_due(elapsed, fps);
        if due > emitted {
            let frame = latest.lock().unwrap_or_else(|p| p.into_inner()).clone();
            match frame {
                // Nguồn quay chưa gửi frame đầu tiên — chờ; khi có, frame đầu
                // được lặp để phủ luôn khoảng chờ này (giữ đúng mốc thời gian).
                None => {
                    if finishing {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Some(frame) => {
                    let owed = due - emitted;
                    if owed > fps as u64 * 2 {
                        lagging.store(true, Ordering::Relaxed);
                    }
                    let msg = PacedFrame { frame, repeat: owed.min(u32::MAX as u64) as u32 };
                    if finishing {
                        // Pha dừng: gửi CHẶN — không được mất các frame cuối
                        // (encoder treo thì watchdog kill ffmpeg → writer đóng
                        // kênh → `send` trả lỗi, không kẹt mãi).
                        backlog.store(owed, Ordering::Relaxed);
                        let sent = tx.send(msg).is_ok();
                        backlog.store(0, Ordering::Relaxed);
                        if !sent {
                            break;
                        }
                        emitted = due;
                    } else {
                        match tx.try_send(msg) {
                            Ok(()) => {
                                emitted = due;
                                backlog.store(0, Ordering::Relaxed);
                            }
                            // Encoder đang bận: giữ nguyên số nợ, lần sau gửi dồn.
                            Err(TrySendError::Full(_)) => backlog.store(owed, Ordering::Relaxed),
                            // Writer đã chết (ffmpeg lỗi) — không còn ai nhận.
                            Err(TrySendError::Disconnected(_)) => break,
                        }
                    }
                }
            }
        }

        if finishing {
            break;
        }
        // Ngủ tới lúc frame kế tiếp đến hạn — tối đa 10ms để phản ứng nhanh
        // với pause/stop, tối thiểu 1ms để không quay vòng rỗng.
        let next_due_at = Duration::from_nanos(((emitted as u128 * 1_000_000_000) / fps as u128) as u64);
        let wait = next_due_at
            .saturating_sub(elapsed)
            .clamp(Duration::from_millis(1), Duration::from_millis(10));
        std::thread::sleep(wait);
    }

    #[cfg(target_os = "windows")]
    unsafe {
        timeEndPeriod(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::frame::new_latest;
    use std::sync::mpsc::sync_channel;

    fn frame() -> Frame {
        Frame { bgra: vec![0; 16], width: 2, height: 2 }
    }

    #[test]
    fn frames_due_math() {
        assert_eq!(frames_due(Duration::ZERO, 30), 0);
        assert_eq!(frames_due(Duration::from_nanos(1), 30), 1);
        assert_eq!(frames_due(Duration::from_secs(10), 30), 300);
        assert_eq!(frames_due(Duration::from_millis(1001), 30), 31);
    }

    /// Consumer chậm hơn hẳn tốc độ quay vẫn phải nhận ĐỦ số frame theo đồng
    /// hồ (qua `repeat`) — thời lượng video không được hụt.
    #[test]
    fn slow_consumer_still_gets_full_frame_count() {
        let latest = new_latest();
        crate::capture::frame::publish(&latest, frame());
        let clock = RecordingClock::new();
        let (tx, rx) = sync_channel::<PacedFrame>(2);
        let pacer = Pacer::spawn(latest, clock.clone(), 30, tx);
        clock.start();
        let consumer = std::thread::spawn(move || {
            let mut total = 0u64;
            while let Ok(m) = rx.recv() {
                total += m.repeat as u64;
                // Mỗi lần nhận "encode" mất 100ms — chậm gấp 3 lần nhịp 33ms.
                std::thread::sleep(Duration::from_millis(100));
            }
            total
        });
        std::thread::sleep(Duration::from_millis(1000));
        clock.stop();
        let expected = frames_due(clock.elapsed().unwrap(), 30);
        pacer.finish();
        let total = consumer.join().unwrap();
        assert_eq!(total, expected, "phải đủ đúng số frame theo đồng hồ");
    }

    #[test]
    fn pause_produces_no_frames() {
        let latest = new_latest();
        crate::capture::frame::publish(&latest, frame());
        let clock = RecordingClock::new();
        let (tx, rx) = sync_channel::<PacedFrame>(64);
        let pacer = Pacer::spawn(latest, clock.clone(), 30, tx);
        clock.start();
        std::thread::sleep(Duration::from_millis(300));
        clock.pause();
        std::thread::sleep(Duration::from_millis(500));
        clock.resume();
        std::thread::sleep(Duration::from_millis(300));
        clock.stop();
        let expected = frames_due(clock.elapsed().unwrap(), 30);
        pacer.finish();
        let total: u64 = rx.iter().map(|m| m.repeat as u64).sum();
        assert_eq!(total, expected);
        // ~600ms ghi thật → ~18 frame; 500ms pause không được tính.
        assert!((15..=22).contains(&total), "total={total}");
    }

    #[test]
    fn waits_for_first_frame_then_covers_gap() {
        let latest = new_latest();
        let clock = RecordingClock::new();
        let (tx, rx) = sync_channel::<PacedFrame>(64);
        let pacer = Pacer::spawn(latest.clone(), clock.clone(), 30, tx);
        clock.start();
        std::thread::sleep(Duration::from_millis(200));
        crate::capture::frame::publish(&latest, frame());
        std::thread::sleep(Duration::from_millis(200));
        clock.stop();
        let expected = frames_due(clock.elapsed().unwrap(), 30);
        pacer.finish();
        let msgs: Vec<PacedFrame> = rx.iter().collect();
        assert!(msgs[0].repeat >= 5, "frame đầu phải lặp để phủ khoảng chờ");
        assert_eq!(msgs.iter().map(|m| m.repeat as u64).sum::<u64>(), expected);
    }
}
