use super::{persist, Capture};
use xcap::Monitor;

/// Chụp một vùng trên màn hình `m`. (x,y,w,h) theo POINTS, tương đối gốc màn
/// hình đó. Ảnh trả về ở pixel vật lý. Overlay (content-protected) không lọt vào.
///
/// - macOS: ScreenCaptureKit (`captureImageInRect`) với toạ độ global points.
/// - OS khác: xcap (Windows = WGC, Linux = pipewire/x11).
pub fn capture_region(m: &Monitor, x: u32, y: u32, w: u32, h: u32) -> Result<Capture, String> {
    if w == 0 || h == 0 {
        return Err("Vùng chọn không hợp lệ".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mx = m.x().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let my = m.y().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let img = super::mac_sck::capture_rect(mx + x as f64, my + y as f64, w as f64, h as f64)?;
        return persist(&img);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let img = m
            .capture_region(x, y, w, h)
            .map_err(|e| format!("Lỗi chụp vùng: {e}"))?;
        persist(&img)
    }
}
