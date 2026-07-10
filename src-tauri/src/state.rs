use std::collections::{HashMap, HashSet};
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
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
    /// DPI scale thật của màn hình nguồn (1.0 = normal, 2.0 = Retina 2×).
    pub scale_factor: f64,
    /// Id bản ghi History tương ứng (nếu đã ingest thành công) — Editor dùng
    /// để Save ghi đè tại chỗ đúng record thay vì chỉ save-as thông thường.
    #[serde(default)]
    pub history_id: Option<String>,
    /// Mode đã chụp ra ảnh này ("region"/"window"/"full"/"all"/"scroll"/
    /// "quick"/"file") — Editor dùng để chọn zoom mặc định: "region" → 100%,
    /// còn lại → fit cả chiều rộng/cao (xem `AnnotationStage.tsx`).
    #[serde(default)]
    pub capture_mode: String,
}

/// Chế độ chụp + output gần nhất — dùng cho nút "New" ở editor.
/// Được cập nhật mỗi khi user chụp từ capture bar.
#[derive(Default)]
pub struct LastCaptureMode {
    pub mode: Mutex<String>,
    pub output: Mutex<String>,
}

impl LastCaptureMode {
    pub fn get(&self) -> (String, String) {
        let mode = self.mode.lock().unwrap().clone();
        let output = self.output.lock().unwrap().clone();
        let mode = if mode.is_empty() { "region".to_string() } else { mode };
        let output = if output.is_empty() { "editor".to_string() } else { output };
        (mode, output)
    }
    pub fn set(&self, mode: &str, output: &str) {
        *self.mode.lock().unwrap() = mode.to_string();
        *self.output.lock().unwrap() = output.to_string();
    }
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
    /// Chế độ chụp gần nhất — dùng cho nút "New" ở editor.
    pub last_capture: LastCaptureMode,
    /// macOS: data URL ảnh "Open with" theo label cửa sổ editor. Mỗi lần
    /// "Open with" mở một cửa sổ editor mới; cửa sổ tự kéo ảnh của nó qua
    /// `take_open_file` lúc mount (pull → không race timing như emit event).
    pub open_files: Mutex<HashMap<String, String>>,
    /// Bộ đếm tạo label cửa sổ editor "Open with" duy nhất (editor-ow-N).
    /// Chỉ sử dụng trên macOS khi "Open with" được gọi.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub editor_seq: AtomicU64,
    /// Bộ đệm lưu các lát cắt (slices) của tính năng chụp cuộn.
    pub scroll_slices: Mutex<Vec<image::RgbaImage>>,
    /// Lỗi đăng ký global shortcut lúc khởi động (nếu có) — Settings query lúc
    /// mount để hiện banner cảnh báo, thay vì chỉ `eprintln!` không ai thấy.
    pub hotkey_warning: Mutex<Option<String>>,
    /// `true` khi overlay đang mở là để CHỌN PHẠM VI QUAY (không phải chụp
    /// ảnh) — set bởi `flow::run_record_picker`, đọc + xoá (`take`) trong
    /// `finalize_region`/`finalize_window`/`finalize_monitor` để biết nên bắt
    /// đầu quay thay vì chụp ảnh tĩnh. Cờ dùng chung cho cả 3 scope (region/
    /// window/monitor) vì bản thân hàm finalize nào được gọi đã tự xác định
    /// đúng loại phạm vi rồi.
    pub pending_record: Mutex<bool>,
    /// macOS: nhãn các cửa sổ sản phẩm (editor/settings/history/…) đang thật
    /// sự hiển thị (không bị che) ngay lúc bắt đầu phiên chụp hiện tại — xem
    /// `windows::snapshot_visible_product_windows`/`windows::protect_product_windows`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub visible_product_windows: Mutex<HashSet<String>>,
}
