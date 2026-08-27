use super::{persist, Capture};
use image::RgbaImage;
use xcap::Window;

/// Thông tin cửa sổ cho overlay vẽ highlight. Toạ độ theo CSS px (= points),
/// đã trừ gốc overlay nên dùng thẳng trong overlay. Mảng giữ thứ tự z
/// FRONT-TO-BACK (cửa sổ trên cùng đứng trước).
#[derive(Clone, serde::Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub title: String,
    pub app: String,
}

/// Chủ cửa sổ thuộc hệ thống / chính app — không nên cho chọn chụp.
const SYSTEM_OWNERS: &[&str] = &[
    "Window Server",
    "Dock",
    "Control Center",
    "Controlcenter",
    "Spotlight",
    "Notification Center",
    "NotificationCenter",
    "WindowManager",
    "SnapDoc",
];

/// Liệt kê cửa sổ chọn được. (ox, oy) = gốc overlay theo points (CSS px),
/// scale = DPI scale factor (chỉ dùng cho Windows/Linux). Toạ độ trả về là
/// CSS points đã trừ gốc overlay, dùng thẳng trong overlay.
pub fn list(ox: f64, oy: f64, scale: f64) -> Result<Vec<WindowInfo>, String> {
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let windows = Window::all().map_err(|e| format!("Không liệt kê được cửa sổ: {e}"))?;

    // Gốc overlay tính theo points (CSS px).
    // macOS: outer_position() trả physical px → chia scale để về points.
    // Windows/Linux: xcap trả physical px → outer_position() cũng physical → chia scale nhất quán.
    let ox_pts = ox / scale;
    let oy_pts = oy / scale;

    let mut out = Vec::new();
    for w in windows {
        if w.is_minimized().unwrap_or(false) {
            continue;
        }
        let width = w.width().unwrap_or(0);
        let height = w.height().unwrap_or(0);
        if width < 40 || height < 40 {
            continue;
        }
        let app = w.app_name().unwrap_or_default();
        if SYSTEM_OWNERS.iter().any(|s| app.eq_ignore_ascii_case(s)) {
            continue;
        }

        // macOS: xcap trả tọa độ + kích thước theo POINTS (= CSS px) — KHÔNG chia scale.
        // Windows/Linux: xcap trả physical px → chia scale để về CSS points.
        #[cfg(target_os = "macos")]
        let (x_pts, y_pts, w_pts, h_pts) = (
            w.x().unwrap_or(0) as f64,
            w.y().unwrap_or(0) as f64,
            width as f64,
            height as f64,
        );
        #[cfg(not(target_os = "macos"))]
        let (x_pts, y_pts, w_pts, h_pts) = (
            w.x().unwrap_or(0) as f64 / scale,
            w.y().unwrap_or(0) as f64 / scale,
            width as f64 / scale,
            height as f64 / scale,
        );

        out.push(WindowInfo {
            id: w.id().unwrap_or(0),
            x: x_pts - ox_pts,
            y: y_pts - oy_pts,
            width: w_pts,
            height: h_pts,
            title: w.title().unwrap_or_default(),
            app,
        });
    }
    Ok(out)
}

/// PID của process sở hữu cửa sổ `id` — dùng để đưa app đó lên foreground khi
/// bắt đầu QUAY cửa sổ (xem `windows::bring_app_to_front`), không phải để
/// chụp ảnh/thumbnail. `None` nếu không còn tìm thấy cửa sổ (vd vừa đóng).
pub fn pid_of(id: u32) -> Option<u32> {
    Window::all()
        .ok()?
        .into_iter()
        .find(|w| w.id().map(|i| i == id).unwrap_or(false))?
        .pid()
        .ok()
}

/// Chụp đúng cửa sổ theo id, trả ảnh RGBA THÔ (chưa encode) — dùng chung cho
/// cả `capture_by_id` (ảnh chụp thật, giữ nguyên độ phân giải) lẫn
/// `capture_thumb` (thu nhỏ làm thumbnail cho dialog "Chọn cửa sổ").
///
/// - macOS: ScreenCaptureKit (`SCContentFilter` + `captureImageWithFilter`).
/// - Windows: xcap dùng GDI PrintWindow (feature "wgc" tắt) — không cần
///   WinRT/COM, không lock static Mutex → không treo.
/// - Linux: xcap (pipewire/x11).
fn capture_raw_by_id(id: u32) -> Result<RgbaImage, String> {
    #[cfg(target_os = "macos")]
    {
        super::mac_sck::capture_window(id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let windows = Window::all()
            .map_err(|e| format!("Không liệt kê được cửa sổ: {e}"))?;

        let target = windows
            .into_iter()
            .find(|w| w.id().map(|i| i == id).unwrap_or(false))
            .ok_or_else(|| "Không tìm thấy cửa sổ (có thể đã đóng)".to_string())?;

        if target.is_minimized().unwrap_or(false) {
            return Err("Cửa sổ đang bị thu nhỏ, không thể chụp".to_string());
        }
        let width = target.width().unwrap_or(0);
        let height = target.height().unwrap_or(0);
        if width == 0 || height == 0 {
            return Err("Cửa sổ có kích thước 0, không thể chụp".to_string());
        }

        target
            .capture_image()
            .map_err(|e| format!("Lỗi chụp cửa sổ: {e}"))
    }
}

/// Chụp đúng cửa sổ theo id (ảnh đầy đủ độ phân giải, dùng khi thật sự chụp).
pub fn capture_by_id(id: u32) -> Result<Capture, String> {
    persist(&capture_raw_by_id(id)?)
}

const THUMB_MAX: u32 = 320;

/// Ảnh RGBA thô → PNG base64 đã thu nhỏ (cạnh dài nhất tối đa `THUMB_MAX`).
/// Dùng cho nhánh Windows/Linux, nơi ảnh chụp về sẵn full-res rồi mới resize
/// (khác macOS: `mac_sck::capture_window_thumbs` yêu cầu SCK chụp thẳng ở
/// kích thước nhỏ, khỏi tốn công resize/encode ảnh lớn).
#[cfg(not(target_os = "macos"))]
fn shrink_to_thumb(img: &RgbaImage) -> Result<String, String> {
    let (w, h) = (img.width(), img.height());
    let scale = (THUMB_MAX as f32 / w.max(h).max(1) as f32).min(1.0);
    let tw = ((w as f32 * scale).round() as u32).max(1);
    let th = ((h as f32 * scale).round() as u32).max(1);
    let resized = image::imageops::resize(img, tw, th, image::imageops::FilterType::Triangle);
    Ok(persist(&resized)?.base64)
}

/// Metadata 1 cửa sổ (không kèm ảnh) — bước lọc/liệt kê RẺ (không cần chụp
/// pixel gì cả), trả về NGAY để dialog "Chọn cửa sổ" vẽ khung lưới + spinner
/// từng ô trước, rồi mới điền ảnh thumbnail vào sau khi chụp xong (xem
/// `capture_thumbs_streaming`) — thay vì bắt người dùng nhìn màn hình trắng
/// chờ TẤT CẢ thumbnail chụp xong mới thấy gì.
#[derive(Clone, serde::Serialize)]
pub struct WindowMetaInfo {
    pub id: u32,
    pub title: String,
    pub app: String,
    pub width: f64,
    pub height: f64,
}

pub fn list_metas() -> Result<Vec<WindowMetaInfo>, String> {
    let windows = Window::all().map_err(|e| format!("Không liệt kê được cửa sổ: {e}"))?;
    let mut out = Vec::new();
    for w in windows {
        if w.is_minimized().unwrap_or(false) {
            continue;
        }
        let width = w.width().unwrap_or(0);
        let height = w.height().unwrap_or(0);
        if width < 40 || height < 40 {
            continue;
        }
        let app = w.app_name().unwrap_or_default();
        if SYSTEM_OWNERS.iter().any(|s| app.eq_ignore_ascii_case(s)) {
            continue;
        }
        let Ok(id) = w.id() else { continue };
        out.push(WindowMetaInfo {
            id,
            title: w.title().unwrap_or_default(),
            app,
            width: width as f64,
            height: height as f64,
        });
    }
    Ok(out)
}

/// Chụp thumbnail cho đúng danh sách `ids` (lấy từ `list_metas` trước đó) và
/// gọi `on_ready(id, thumb)` NGAY khi từng cửa sổ chụp xong — `thumb = None`
/// nếu chụp lỗi (vd cửa sổ vừa đóng giữa chừng), caller tự quyết định ẩn ô đó
/// đi. Cửa sổ nào xong TRƯỚC hiển thị TRƯỚC, không đợi toàn bộ danh sách —
/// đây là lý do tách riêng khỏi `list_metas` (đã trả về ngay, không chờ chụp).
///
/// - macOS: chụp TẤT CẢ cửa sổ qua 1 lần `capture_window_thumbs` (1 lần fetch
///   shareable content dùng chung, các lệnh chụp bắn song song, kết quả trả
///   về theo đúng thứ tự hoàn thành thực tế) thay vì gọi `capture_window` (tự
///   fetch content riêng) tuần tự cho từng cửa sổ — đây là tối ưu chính, fetch
///   shareable content là phần tốn thời gian nhất.
/// - Windows/Linux: xcap không có khái niệm "content list" tốn kém tương tự,
///   nhưng vẫn chụp song song bằng thread để tận dụng nhiều cửa sổ cùng lúc
///   thay vì đợi tuần tự — mỗi thread tự gửi kết quả về ngay khi xong.
pub fn capture_thumbs_streaming(ids: &[u32], on_ready: impl Fn(u32, Option<String>) + Send + Sync) {
    #[cfg(target_os = "macos")]
    {
        super::mac_sck::capture_window_thumbs(ids, THUMB_MAX, |id, r| {
            let thumb = r.ok().and_then(|img| persist(&img).ok()).map(|c| c.base64);
            on_ready(id, thumb);
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Chia batch tối đa 8 thread mỗi lần — tránh spawn vô hạn thread khi
        // user mở 50+ cửa sổ (gây tràn GDI handle trên Windows, lag hệ thống).
        for chunk in ids.chunks(8) {
            std::thread::scope(|scope| {
                for &id in chunk {
                    let on_ready = &on_ready;
                    scope.spawn(move || {
                        let thumb = capture_raw_by_id(id).ok().and_then(|img| shrink_to_thumb(&img).ok());
                        on_ready(id, thumb);
                    });
                }
            });
        }
    }
}
