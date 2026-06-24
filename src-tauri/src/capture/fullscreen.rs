use super::{persist, Capture};
use xcap::Monitor;

/// Chụp toàn bộ một màn hình cụ thể.
///
/// - macOS: ScreenCaptureKit (`captureImageInRect`) trên đúng frame màn hình
///   (points global) → giữ độ phân giải Retina.
/// - OS khác: xcap (Windows = WGC, Linux = pipewire/x11).
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
