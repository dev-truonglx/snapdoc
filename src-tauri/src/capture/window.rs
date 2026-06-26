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

/// Liệt kê cửa sổ chọn được.
///
/// `ox_phys`, `oy_phys` = gốc overlay theo **PHYSICAL pixels** (hệ xcap),
/// `scale` = DPI scale factor của màn hình chứa overlay.
///
/// Trả về toạ độ theo **CSS px** tương đối gốc overlay để frontend dùng
/// trực tiếp khi vẽ highlight.
///
/// macOS: xcap trả points (= CSS px, scale=1) nên inv_scale=1 → không đổi.
/// Windows/Linux: xcap trả physical px → chia scale → CSS px.
pub fn list(ox_phys: f64, oy_phys: f64, scale: f64) -> Result<Vec<WindowInfo>, String> {
    let windows = Window::all().map_err(|e| format!("Không liệt kê được cửa sổ: {e}"))?;

    #[cfg(target_os = "macos")]
    let inv = 1.0_f64;
    #[cfg(not(target_os = "macos"))]
    let inv = if scale > 0.0 { 1.0 / scale } else { 1.0 };

    let mut out = Vec::new();
    for w in windows {
        if w.is_minimized().unwrap_or(false) {
            continue;
        }
        let width_phys = w.width().unwrap_or(0);
        let height_phys = w.height().unwrap_or(0);
        if width_phys < 40 || height_phys < 40 {
            continue;
        }
        let app = w.app_name().unwrap_or_default();
        if SYSTEM_OWNERS.iter().any(|s| app.eq_ignore_ascii_case(s)) {
            continue;
        }
        // Chuyển toạ độ physical→CSS rồi trừ gốc overlay (cũng ở CSS px).
        out.push(WindowInfo {
            id: w.id().unwrap_or(0),
            x: w.x().unwrap_or(0) as f64 * inv - ox_phys * inv,
            y: w.y().unwrap_or(0) as f64 * inv - oy_phys * inv,
            width: width_phys as f64 * inv,
            height: height_phys as f64 * inv,
            title: w.title().unwrap_or_default(),
            app,
        });
    }
    Ok(out)
}

/// Chụp đúng cửa sổ theo id.
///
/// - macOS: ScreenCaptureKit → chụp đúng 1 cửa sổ kể cả khi bị che.
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
            .ok_or_else(|| format!("Không tìm thấy cửa sổ id={id}"))?;
        let img = target
            .capture_image()
            .map_err(|e| format!("Lỗi chụp cửa sổ: {e}"))?;
        persist(&img)
    }
}
