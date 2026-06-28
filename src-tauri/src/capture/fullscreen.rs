use super::{persist, Capture};
use xcap::Monitor;

/// Chụp toàn bộ một màn hình cụ thể.
///
/// - macOS: ScreenCaptureKit (`captureImageInRect`) trên đúng frame màn hình
///   (points global) → giữ độ phân giải Retina.
/// - OS khác: xcap (Windows = GDI, Linux = pipewire/x11).
pub fn capture_monitor(m: &Monitor) -> Result<Capture, String> {
    #[cfg(target_os = "macos")]
    {
        let x = m.x().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let y = m.y().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let w = m.width().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let h = m.height().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let img = super::mac_sck::capture_rect(x, y, w, h)?;
        return persist(&img);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let img = m
            .capture_image()
            .map_err(|e| format!("Lỗi chụp màn hình: {e}"))?;
        persist(&img)
    }
}

/// Chụp tất cả màn hình và ghép thành một ảnh ngang duy nhất.
///
/// Màn hình được sắp xếp theo toạ độ X tăng dần (trái → phải).
/// Kích thước mỗi màn hình được chuẩn hoá về LOGICAL POINTS trước khi ghép
/// để Retina (2×) và Full HD (1×) có kích thước tương đương nhau trong ảnh kết quả.
/// Chiều cao canvas = màn hình cao nhất (tính theo logical points).
/// Mỗi màn hình được vẽ căn giữa theo chiều dọc.
pub fn capture_all_monitors() -> Result<Capture, String> {
    use image::{GenericImage, RgbaImage, imageops};

    let monitors = Monitor::all()
        .map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    if monitors.is_empty() {
        return Err("Không tìm thấy màn hình nào".to_string());
    }

    // Chụp từng màn, lấy kích thước logical (points) để chuẩn hoá.
    struct Shot {
        x: i32,
        img: RgbaImage,
        /// Chiều rộng/cao theo logical points (sau khi chuẩn hoá).
        logical_w: u32,
        logical_h: u32,
    }

    let mut shots: Vec<Shot> = Vec::with_capacity(monitors.len());
    for m in &monitors {
        let x = m.x().unwrap_or(0);
        let raw = capture_monitor_raw(m)?;

        // Trên macOS, m.width()/m.height() trả về LOGICAL POINTS còn raw image
        // ở pixel vật lý (SCK capture tự nhân scale). Resize về points để cân bằng.
        // Trên Windows/Linux, xcap trả physical px nhưng không có Retina nên
        // width()/height() = pixel vật lý → không cần resize.
        let logical_w = m.width().unwrap_or(raw.width());
        let logical_h = m.height().unwrap_or(raw.height());

        let img = if raw.width() != logical_w || raw.height() != logical_h {
            // Scale xuống logical points bằng Lanczos3 (chất lượng cao, dùng cho downscale).
            imageops::resize(&raw, logical_w, logical_h, imageops::FilterType::Lanczos3)
        } else {
            raw
        };

        shots.push(Shot { x, img, logical_w, logical_h });
    }

    // Sắp xếp trái → phải theo toạ độ X của màn hình.
    shots.sort_by_key(|s| s.x);

    // Tính kích thước canvas theo logical points.
    let total_w: u32 = shots.iter().map(|s| s.logical_w).sum();
    let max_h: u32 = shots.iter().map(|s| s.logical_h).max().unwrap_or(0);
    if total_w == 0 || max_h == 0 {
        return Err("Kích thước ảnh ghép không hợp lệ".to_string());
    }

    let mut canvas = RgbaImage::new(total_w, max_h);

    // Vẽ từng màn hình, căn giữa dọc.
    let mut cursor_x: u32 = 0;
    for shot in &shots {
        let w = shot.logical_w;
        let h = shot.logical_h;
        let offset_y = (max_h - h) / 2;
        canvas
            .copy_from(&shot.img, cursor_x, offset_y)
            .map_err(|e| format!("Lỗi ghép ảnh: {e}"))?;
        cursor_x += w;
    }

    persist(&canvas)
}

/// Chụp một màn hình thành `RgbaImage` thô (không encode PNG).
fn capture_monitor_raw(m: &Monitor) -> Result<image::RgbaImage, String> {
    #[cfg(target_os = "macos")]
    {
        let x = m.x().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let y = m.y().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let w = m.width().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let h = m.height().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        super::mac_sck::capture_rect(x, y, w, h)
    }

    #[cfg(not(target_os = "macos"))]
    {
        m.capture_image()
            .map_err(|e| format!("Lỗi chụp màn hình: {e}"))
    }
}
