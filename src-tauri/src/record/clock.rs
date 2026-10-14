//! Đồng hồ CHUNG của 1 phiên quay — nguồn thời gian duy nhất cho video
//! (`pacer`), audio (`pcm_writer`), telemetry chuột (`mouse_click`) và đồng
//! hồ hiển thị (tray/indicator).
//!
//! Trước đây mỗi thành phần tự đếm giờ theo `Instant` riêng, bắt đầu ở các
//! thời điểm khác nhau và KHÔNG cùng biết về pause: video bỏ frame khi pause
//! nhưng telemetry vẫn chạy đồng hồ treo tường, mic macOS bắt đầu sau video mà
//! không bù khoảng lặng... nên tiếng/hình/click lệch nhau. Mọi thành phần giờ
//! hỏi CÙNG 1 câu "đã ghi được bao lâu (không tính thời gian pause)" ở đây.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct ClockInner {
    started_at: Option<Instant>,
    paused_total: Duration,
    pause_started_at: Option<Instant>,
    /// Các khoảng pause đã kết thúc — để quy đổi 1 thời điểm BẤT KỲ trong quá
    /// khứ (lúc 1 gói audio được thu) sang vị trí trong bản quay.
    pauses: Vec<(Instant, Instant)>,
    stopped_at: Option<Instant>,
}

/// Vị trí của 1 thời điểm (vd lúc thu 1 gói audio) so với bản quay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Position {
    /// Trước mốc 0 (pre-roll lúc khởi động).
    BeforeStart,
    /// Rơi vào 1 khoảng pause.
    Paused,
    /// Sau mốc dừng quay.
    AfterStop,
    /// Thời gian ĐÃ GHI tính tới thời điểm đó.
    At(Duration),
}

#[derive(Default)]
pub struct RecordingClock {
    inner: Mutex<ClockInner>,
    /// Bản sao cờ pause để đọc không cần lock ở các vòng lặp nóng.
    paused: AtomicBool,
}

impl RecordingClock {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ClockInner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Mốc 0 của phiên quay. Gọi lại lần 2 không đổi mốc.
    pub fn start(&self) {
        let mut g = self.lock();
        if g.started_at.is_none() {
            g.started_at = Some(Instant::now());
        }
    }

    /// `true` nếu trạng thái thực sự đổi (chưa pause → pause).
    pub fn pause(&self) -> bool {
        let mut g = self.lock();
        if g.started_at.is_none() || g.stopped_at.is_some() || g.pause_started_at.is_some() {
            return false;
        }
        g.pause_started_at = Some(Instant::now());
        self.paused.store(true, Ordering::SeqCst);
        true
    }

    /// `true` nếu trạng thái thực sự đổi (đang pause → chạy tiếp).
    pub fn resume(&self) -> bool {
        let mut g = self.lock();
        if g.stopped_at.is_some() {
            return false;
        }
        let Some(p) = g.pause_started_at.take() else { return false };
        let now = Instant::now();
        g.paused_total += now.saturating_duration_since(p);
        g.pauses.push((p, now));
        self.paused.store(false, Ordering::SeqCst);
        true
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Đóng băng đồng hồ tại thời điểm dừng quay — mọi lần hỏi `elapsed()` sau
    /// đó trả cùng 1 giá trị, để pacer/audio writer chốt đúng cùng 1 độ dài.
    pub fn stop(&self) {
        let mut g = self.lock();
        if g.stopped_at.is_none() {
            g.stopped_at = Some(Instant::now());
        }
    }

    /// Thời gian ĐÃ GHI (không tính các khoảng pause). `None` nếu chưa start.
    pub fn elapsed(&self) -> Option<Duration> {
        let g = self.lock();
        let start = g.started_at?;
        let now = g.stopped_at.unwrap_or_else(Instant::now);
        let end = match g.pause_started_at {
            Some(p) => p.min(now),
            None => now,
        };
        Some(end.saturating_duration_since(start).saturating_sub(g.paused_total))
    }

    pub fn elapsed_ms(&self) -> Option<u64> {
        self.elapsed().map(|d| d.as_millis() as u64)
    }

    /// Quy đổi thời điểm `t` sang vị trí trong bản quay (đã trừ mọi khoảng
    /// pause trước `t`). Dùng cho audio: gói được ĐÓNG MỐC lúc thu, nên writer
    /// bị chậm/khựng vẫn đặt đúng chỗ, và gói thu trong lúc pause bị bỏ đúng.
    pub fn position(&self, t: Instant) -> Position {
        let g = self.lock();
        let Some(start) = g.started_at else { return Position::BeforeStart };
        if t < start {
            return Position::BeforeStart;
        }
        if let Some(stop) = g.stopped_at {
            if t > stop {
                return Position::AfterStop;
            }
        }
        let mut paused = Duration::ZERO;
        for &(a, b) in &g.pauses {
            if t >= a && t < b {
                return Position::Paused;
            }
            if b <= t {
                paused += b.saturating_duration_since(a);
            }
        }
        if let Some(p) = g.pause_started_at {
            if t >= p {
                return Position::Paused;
            }
        }
        Position::At(t.saturating_duration_since(start).saturating_sub(paused))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn not_started_has_no_elapsed() {
        let c = RecordingClock::new();
        assert!(c.elapsed().is_none());
        assert!(!c.pause(), "chưa start thì không pause được");
    }

    #[test]
    fn pause_excludes_time() {
        let c = RecordingClock::new();
        c.start();
        sleep(Duration::from_millis(60));
        assert!(c.pause());
        let at_pause = c.elapsed().unwrap();
        sleep(Duration::from_millis(120));
        // Đang pause: đồng hồ đứng yên.
        let during = c.elapsed().unwrap();
        assert_eq!(at_pause, during);
        assert!(c.resume());
        sleep(Duration::from_millis(60));
        let total = c.elapsed().unwrap();
        assert!(total >= Duration::from_millis(115), "{total:?}");
        assert!(total < Duration::from_millis(115 + 100), "khoảng pause 120ms không được tính: {total:?}");
    }

    #[test]
    fn stop_freezes() {
        let c = RecordingClock::new();
        c.start();
        sleep(Duration::from_millis(30));
        c.stop();
        let a = c.elapsed().unwrap();
        sleep(Duration::from_millis(40));
        assert_eq!(a, c.elapsed().unwrap());
        assert!(!c.pause(), "đã dừng thì không pause được");
    }

    #[test]
    fn position_maps_capture_time_through_pauses() {
        let c = RecordingClock::new();
        let before = Instant::now();
        sleep(Duration::from_millis(5));
        c.start();
        assert_eq!(c.position(before), Position::BeforeStart);
        sleep(Duration::from_millis(50));
        let t1 = Instant::now();
        c.pause();
        sleep(Duration::from_millis(20));
        let during = Instant::now();
        sleep(Duration::from_millis(80));
        c.resume();
        sleep(Duration::from_millis(30));
        let t2 = Instant::now();
        assert_eq!(c.position(during), Position::Paused);
        let Position::At(p1) = c.position(t1) else { panic!() };
        let Position::At(p2) = c.position(t2) else { panic!() };
        assert!(p1 >= Duration::from_millis(50) && p1 < Duration::from_millis(90), "{p1:?}");
        // p2 - p1 ≈ 30ms ghi thật (100ms pause không được tính).
        let d = p2 - p1;
        assert!(d >= Duration::from_millis(28) && d < Duration::from_millis(70), "{d:?}");
        c.stop();
        sleep(Duration::from_millis(5));
        assert_eq!(c.position(Instant::now()), Position::AfterStop);
    }

    #[test]
    fn stop_while_paused_uses_pause_point() {
        let c = RecordingClock::new();
        c.start();
        sleep(Duration::from_millis(30));
        c.pause();
        let at_pause = c.elapsed().unwrap();
        sleep(Duration::from_millis(40));
        c.stop();
        assert_eq!(at_pause, c.elapsed().unwrap());
    }
}
