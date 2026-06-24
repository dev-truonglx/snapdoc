use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

/// Snapshot một màn hình tại thời điểm mở overlay, đơn vị **POINTS** trong
/// không gian global của CoreGraphics (CGDisplayBounds — top-left origin).
/// Đây là hệ NHẤT QUÁN giữa các màn khác scale (khác với physical pixel của
/// `Monitor::position()` = points × scale-riêng → không nhất quán).
/// Toạ độ con trỏ đọc qua CGEvent cũng ở chính hệ points này.
#[derive(Clone, Copy, Debug)]
pub struct MonitorSnap {
    /// CGDirectDisplayID — để khớp đúng NSScreen khi đặt frame overlay.
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    // Dùng để đổi physical→CSS trên Windows/Linux; macOS làm việc ở points nên
    // không cần (đánh dấu allow để không cảnh báo ở bản macOS).
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub scale: f64,
}

/// Ảnh vừa chụp đang chờ xử lý (editor / clipboard / thumbnail).
#[derive(Clone, serde::Serialize)]
pub struct PendingCapture {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub output: String,
}

#[derive(Default)]
pub struct AppState {
    pub pending: Mutex<Option<PendingCapture>>,
    /// Output đã chọn trước khi chụp (cho luồng region/window qua overlay).
    pub pending_output: Mutex<String>,
    /// Generation của phiên overlay hiện tại — để chỉ 1 luồng theo dõi con trỏ
    /// chạy tại một thời điểm (lần mở overlay mới sẽ dừng watcher cũ).
    pub overlay_gen: AtomicU64,
    /// Snapshot màn hình của phiên overlay hiện tại — chia sẻ giữa `open_overlays`
    /// và `input_loop` để chỉ số overlay luôn khớp.
    pub overlay_monitors: Mutex<Vec<MonitorSnap>>,
}
