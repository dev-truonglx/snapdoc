use super::{persist, Capture};
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

/// Chụp đúng cửa sổ theo id.
///
/// - macOS: ScreenCaptureKit (`SCContentFilter` + `captureImageWithFilter`).
/// - Windows: xcap dùng GDI PrintWindow (feature "wgc" tắt) — không cần
///   WinRT/COM, không lock static Mutex → không treo.
/// - Linux: xcap (pipewire/x11).
pub fn capture_by_id(id: u32) -> Result<Capture, String> {
    #[cfg(target_os = "macos")]
    {
        let img = super::mac_sck::capture_window(id)?;
        return persist(&img);
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

        let img = target
            .capture_image()
            .map_err(|e| format!("Lỗi chụp cửa sổ: {e}"))?;
        return persist(&img);
    }
}
