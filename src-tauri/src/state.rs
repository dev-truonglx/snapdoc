use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64};
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
    /// Pixel NỀN (chưa ghép annotation) — base64 trần, không prefix data URL.
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
    /// Lớp annotation đi kèm (`doc.json` hiệu lực trong container `.snapdoc`,
    /// tức `draft.json` nếu có) — Editor dựng lại đúng trạng thái đang sửa thay
    /// vì mở ảnh trống. `None` cho ảnh vừa chụp (chưa có annotation nào) và cho
    /// item PNG thế hệ cũ.
    #[serde(default, rename = "docJson")]
    pub doc_json: Option<String>,
    /// `true` khi `doc_json` là BẢN NHÁP (`draft.json`) chứ không phải bản đã
    /// lưu. Editor phải biết để (a) đánh dấu tài liệu là CHƯA LƯU — nháp phục
    /// hồi thì đúng nghĩa là chưa lưu, để clean thì badge tắt và autosave ngừng
    /// ghi — và (b) hỏi user muốn tiếp tục hay bỏ, thay vì lặng lẽ đắp annotation
    /// cũ lên một ảnh mà user tưởng còn nguyên.
    #[serde(default, rename = "docIsDraft")]
    pub doc_is_draft: bool,
    /// Đường dẫn file `.snapdoc` trên đĩa mà tài liệu này ĐẾN TỪ (mở qua "Open
    /// with"/Cmd+O). Có giá trị → Editor Save ghi THẲNG lại chính file đó, không
    /// mở dialog và không đụng Library — đúng ngữ nghĩa một trình soạn tài liệu.
    /// `None` cho mọi thứ đến từ Library hoặc vừa chụp.
    #[serde(default, rename = "filePath")]
    pub file_path: Option<String>,
}

/// Video đang chờ mở trong Editor — đã CÓ SẴN trong History (`history_id`
/// luôn là id thật): mở từ Library (xem
/// `history::commands::open_history_item_in_editor_sync`) hoặc vừa quay xong
/// (ingest ngay lập tức, xem `record::stop_recording_impl`) — không còn
/// khái niệm "video chưa lưu" nữa.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingVideo {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub duration_ms: i64,
    pub history_id: String,
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
        let mode = self.mode.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let output = self.output.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mode = if mode.is_empty() { "region".to_string() } else { mode };
        let output = if output.is_empty() { "editor".to_string() } else { output };
        (mode, output)
    }
    pub fn set(&self, mode: &str, output: &str) {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner()) = mode.to_string();
        *self.output.lock().unwrap_or_else(|e| e.into_inner()) = output.to_string();
    }

    /// Xoá `mode` (giữ nguyên `output`) — gọi khi 1 phiên "có trạng thái đặc
    /// biệt kéo dài" (hiện chỉ chụp cuộn) đã hoàn tất/huỷ THẬT SỰ. Nếu không
    /// xoá, `mode` vẫn còn là "scroll" cho tới lần chụp chủ động TIẾP THEO —
    /// một cú `finalize_region` LẠC (vd overlay pre-warm ẩn lỡ nhận nhầm sự
    /// kiện chuột toàn cục nào đó, xem `windows::input_loop`) sẽ bị hiểu nhầm
    /// là "vẫn đang chụp cuộn" và tự khởi động lại phiên, thay vì bị bỏ qua.
    pub fn clear_mode(&self) {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner()) = String::new();
    }
}

/// Trạng thái lưu trữ các lát cắt trong phiên chụp cuộn.
/// Tách biệt giữa các lát cắt vừa chụp (chưa chắc dùng) và các lát cắt đã xác nhận đưa vào ảnh ghép.
#[derive(Default)]
pub struct ScrollSlicesState {
    pub next_id: usize,
    /// Ring buffer chứa các lát cắt vừa chụp gần nhất (tối đa 16 lát) để tránh rò rỉ RAM khi trang đứng yên / cuộn nhanh.
    pub uncommitted: HashMap<usize, image::RgbaImage>,
    /// Các lát cắt đã được frontend xác nhận đưa vào danh sách ghép.
    pub committed: HashMap<usize, image::RgbaImage>,
}

impl ScrollSlicesState {
    pub fn clear(&mut self) {
        self.next_id = 0;
        self.uncommitted.clear();
        self.committed.clear();
    }
}

#[derive(Default)]
pub struct AppState {
    pub pending: Mutex<Option<PendingCapture>>,
    /// Video đang chờ mở trong Editor — xem `PendingVideo`.
    pub pending_video: Mutex<Option<PendingVideo>>,
    /// Output đã chọn trước khi chụp (cho luồng region/window qua overlay).
    pub pending_output: Mutex<String>,
    /// Generation của phiên overlay hiện tại — để chỉ 1 luồng theo dõi con trỏ
    /// chạy tại một thời điểm (lần mở overlay mới sẽ dừng watcher cũ).
    pub overlay_gen: AtomicU64,
    /// `true` trong lúc `windows::open_overlays_ex` đang dựng/tái sử dụng pool
    /// overlay (từ lúc kiểm tra reuse tới lúc show() xong) — chặn 2 lệnh mở
    /// overlay chạy CHỒNG NHAU (double-click nút chụp, hotkey double-fire,
    /// ...) cùng lúc `close_overlays()` + `build()` lại label `overlay-{i}`,
    /// gây lỗi "a webview with label ... already exists". Xem
    /// `windows::OverlayOpenGuard`.
    pub overlay_opening: AtomicBool,
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
    pub scroll_slices: Mutex<ScrollSlicesState>,
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
    /// macOS: PID của app đang frontmost (KHÁC SnapDoc) ngay TRƯỚC khi mở
    /// overlay Chụp nhanh. `open_overlays` gọi `set_focus()` → macOS kích hoạt
    /// cả app SnapDoc; sau khi copy/save xong (không mở cửa sổ nào của mình)
    /// ta activate lại app này để trả frontmost về đúng chỗ cũ. `None` khi
    /// SnapDoc vốn đang frontmost hoặc đã khôi phục xong (xem
    /// `flow::start_quick`/`flow::cancel_overlay`).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub restore_front_pid: Mutex<Option<i32>>,
    /// macOS: nhãn các cửa sổ sản phẩm (history/settings/preview…) đã bị
    /// `.hide()` THẬT SỰ (orderOut) tạm thời trước khi mở overlay Chụp nhanh.
    /// Lý do cần ẩn thật thay vì chỉ trả focus SAU: `set_focus()` lúc mở
    /// overlay activate cả app SnapDoc ngay lập tức (đồng bộ) — nếu 1 cửa sổ
    /// sản phẩm đang "visible" nhưng bị 1 app khác che (không phải user chủ ý
    /// ẩn), macOS sẽ tự đưa nó lên TRÊN app đó NGAY TRONG THỜI ĐIỂM activate,
    /// tức là TRƯỚC KHI code Rust kịp phản ứng gì — chỉ trả focus về app cũ
    /// SAU đó (dù có delay ngắn cỡ nào) vẫn để lộ ra đúng 1-2 khung hình cửa
    /// sổ đó "nháy" lên rồi mới ẩn lại, đúng hiện tượng UX không hợp lý đã
    /// quan sát được. Ẩn THẬT (orderOut) trước khi activate thì không còn gì
    /// để mà nháy lên nữa. `close_overlays`/`cancel_overlay` phục hồi
    /// (orderFront, KHÔNG makeKey/focus) các cửa sổ này SAU KHI đã trả
    /// frontmost về app trước đó — xem `windows::hide_occluded_product_windows`/
    /// `windows::restore_hidden_product_windows`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub hidden_for_capture: Mutex<Vec<String>>,
    /// Ảnh "đóng băng" màn hình (JPEG base64, không có prefix data URL) chụp
    /// ngay trước khi mở overlay chọn vùng — overlay dùng làm background tĩnh
    /// để tránh tương tác với app đang chạy phía sau (như Snagit/Lightshot).
    /// Key = chỉ số màn hình (khớp với `overlay-{i}`), value = JPEG base64.
    /// Xoá sau khi overlay đóng (`close_overlays` / `cancel_overlay`).
    pub frozen_screens: Mutex<HashMap<usize, String>>,
    /// Kênh báo "overlay-{idx} đã paint xong ảnh đóng băng" từ frontend, dùng
    /// bởi `windows::wait_for_overlays_ready` để trì hoãn `win.show()` cho
    /// tới khi frame đầu tiên hiện ra ĐÃ có sẵn nội dung đúng (tránh nhịp
    /// trống/nháy khi show() rồi mới paint sau — xem cơ chế freeze mượt như
    /// Snagit). Value gửi lên là `(gen, idx)`; gen dùng để lọc bỏ tín hiệu
    /// trễ từ phiên overlay cũ. Được thay Sender mới mỗi lần mở overlay,
    /// không cần dọn tay khi đóng overlay.
    pub overlay_ready_tx: Mutex<Option<std::sync::mpsc::Sender<(u64, usize)>>>,
    /// Generation của phiên đếm ngược "hẹn giờ chụp" hiện tại (xem
    /// `flow::wait_capture_delay`) — bump lên để huỷ đếm ngược đang chạy dở
    /// (user bấm Esc, hoặc trigger 1 lần chụp mới trong lúc đang đếm).
    pub countdown_gen: AtomicU64,
    /// Cờ "cửa sổ editor này đang có thay đổi chưa lưu", key = LABEL cửa sổ.
    ///
    /// Phải theo label chứ không phải 1 `AtomicBool` chung: trên macOS "Open
    /// with" mở thêm các cửa sổ `editor-ow-N` (xem `windows::open_editor_with_file`)
    /// nên một cửa sổ đang dở việc mà dùng cờ chung sẽ khoá cả các cửa sổ khác.
    ///
    /// Frontend đẩy lên qua `commands::set_editor_dirty` với debounce BẤT ĐỐI
    /// XỨNG: `true` gửi ngay (leading edge), `false` gửi trễ. Cờ `true` cũ đi
    /// quá hạn chỉ tốn 1 lần cảnh báo thừa; cờ `false` cũ đi quá hạn thì mất
    /// việc của user.
    pub editor_dirty: Mutex<HashMap<String, bool>>,
    /// `true` khi phiên chụp hiện tại đã ẩn một cửa sổ editor ĐANG dirty (xem
    /// `flow::hide_editor_for_freeze`). Có những nhánh chụp KHÔNG bao giờ mở
    /// lại editor — `output = "clipboard"`/`"save"` chỉ mở cửa sổ thumbnail,
    /// còn huỷ overlay (Esc) thì không hiện lại gì cả — nên nếu không có cờ
    /// này thì cửa sổ chứa việc chưa lưu bị ẩn và KHÔNG CÓ CÁCH NÀO mở lại
    /// (tray không có mục "Mở editor", `RunEvent::Reopen` mở capture-bar).
    /// Đọc-và-xoá bằng `swap(false)` trong `windows::show_editor_if_hidden_dirty`.
    pub editor_hidden_dirty: AtomicBool,
}
