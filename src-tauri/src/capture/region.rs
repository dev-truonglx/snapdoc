use super::{persist, Capture};
use xcap::Monitor;

/// Chụp một vùng trên màn hình `m` trả về raw RgbaImage.
pub fn capture_region_raw(m: &Monitor, x: u32, y: u32, w: u32, h: u32) -> Result<image::RgbaImage, String> {
    if w == 0 || h == 0 {
        return Err("Vùng chọn không hợp lệ (w/h = 0)".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mx = m.x().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let my = m.y().map_err(|e| format!("Lỗi đọc màn hình: {e}"))? as f64;
        let img = super::mac_sck::capture_rect(mx + x as f64, my + y as f64, w as f64, h as f64)?;
        return Ok(img);
    }

    // Windows & Linux: guard against xcap/WGC panic when the rect exceeds
    // monitor bounds. Returns a clear error rather than unwinding.
    #[cfg(not(target_os = "macos"))]
    {
        let mw = m.width().map_err(|e| format!("Không đọc được width màn hình: {e}"))?;
        let mh = m.height().map_err(|e| format!("Không đọc được height màn hình: {e}"))?;
        if mw == 0 || mh == 0 {
            return Err("Không đọc được kích thước màn hình".to_string());
        }
        if x >= mw || y >= mh {
            return Err(format!(
                "Vùng chọn ngoài màn hình: origin ({x},{y}) >= màn hình ({mw},{mh})"
            ));
        }
        // Clamp so a slightly-overflowing selection still captures.
        let cw = w.min(mw - x);
        let ch = h.min(mh - y);
        if cw == 0 || ch == 0 {
            return Err("Vùng chọn không hợp lệ sau khi kẹp vào biên màn hình".to_string());
        }
        let img = m
            .capture_region(x, y, cw, ch)
            .map_err(|e| format!("Lỗi chụp vùng: {e}"))?;
        return Ok(img);
    }
}

/// Chụp một vùng trên màn hình `m`. (x,y,w,h) theo PHYSICAL PIXELS,
/// tương đối gốc màn hình đó. Ảnh trả về ở pixel vật lý.
/// Overlay (content-protected) không lọt vào.
pub fn capture_region(m: &Monitor, x: u32, y: u32, w: u32, h: u32) -> Result<Capture, String> {
    let img = capture_region_raw(m, x, y, w, h)?;
    persist(&img)
}
