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

/// Liệt kê cửa sổ chọn được. (ox, oy) = gốc overlay theo points để đổi toạ độ
/// cửa sổ (points global) sang toạ độ local của overlay.
pub fn list(ox: f64, oy: f64) -> Result<Vec<WindowInfo>, String> {
    // Window::all() trả thứ tự từ TRÊN xuống DƯỚI (front-to-back).
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
        out.push(WindowInfo {
            id: w.id().unwrap_or(0),
            x: w.x().unwrap_or(0) as f64 - ox,
            y: w.y().unwrap_or(0) as f64 - oy,
            width: width as f64,
            height: height as f64,
            title: w.title().unwrap_or_default(),
            app,
        });
    }
    Ok(out)
}

/// Chụp đúng cửa sổ theo id.
///
/// - macOS: ScreenCaptureKit (`SCContentFilter` + `captureImageWithFilter`) →
///   chụp đúng 1 cửa sổ kể cả khi bị che, giữ độ phân giải Retina.
/// - OS khác: xcap (Windows = WGC, Linux = pipewire/x11).
pub fn capture_by_id(id: u32) -> Result<Capture, String> {
    #[cfg(target_os = "macos")]
    {
        let img = super::mac_sck::capture_window(id)?;
        return persist(&img);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let windows = Window::all().map_err(|e| format!("Không liệt kê được cửa sổ: {e}"))?;
        let target = windows
            .into_iter()
            .find(|w| w.id().map(|i| i == id).unwrap_or(false))
            .ok_or_else(|| "Không tìm thấy cửa sổ".to_string())?;
        let img = target
            .capture_image()
            .map_err(|e| format!("Lỗi chụp cửa sổ: {e}"))?;
        persist(&img)
    }
}
