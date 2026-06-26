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
/// - Windows: xcap với WGC. Phải chạy trên STA COM thread (WGC yêu cầu COM đã
///   được init). Dùng `std::thread::spawn` + `CoInitializeEx(STA)` để đảm bảo
///   điều đó, tránh crash khi gọi từ thread non-COM của Tauri.
/// - OS khác: xcap (Linux = pipewire/x11).
pub fn capture_by_id(id: u32) -> Result<Capture, String> {
    #[cfg(target_os = "macos")]
    {
        let img = super::mac_sck::capture_window(id)?;
        return persist(&img);
    }

    #[cfg(target_os = "windows")]
    {
        return capture_by_id_windows(id);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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

/// Thực thi capture window trên Windows.
///
/// WGC (Windows.Graphics.Capture) yêu cầu thread đang gọi đã khởi tạo COM ở
/// chế độ STA (Single-Threaded Apartment). Thread của Tauri/Tokio không đảm bảo
/// điều đó → gọi `capture_image()` thẳng từ đó thường dẫn đến crash
/// (access violation hoặc RPC_E_WRONG_THREAD).
///
/// Giải pháp: spawn thread mới, init COM STA ngay đầu thread đó, thực hiện
/// capture, rồi gọi CoUninitialize khi xong. Dùng channel để trả kết quả về.
#[cfg(target_os = "windows")]
fn capture_by_id_windows(id: u32) -> Result<Capture, String> {
    use std::sync::mpsc;
    use windows_sys::Win32::System::Com;

    let (tx, rx) = mpsc::channel::<Result<Capture, String>>();

    std::thread::spawn(move || {
        // Khởi tạo COM trong chế độ STA cho thread này.
        // windows-sys dùng raw *const c_void (không phải Option<>), và
        // COINIT_APARTMENTTHREADED là hằng u32, không phải enum variant.
        // S_OK = 0, S_FALSE = 1 (đã init trên thread này rồi) — cả hai đều OK.
        // Nếu hr < 0 (thất bại) vẫn cố capture; WGC có thể hoạt động nếu COM
        // đã được init trước đó bởi luồng khác của Tauri (ít xảy ra nhưng an toàn).
        let hr_init = unsafe {
            Com::CoInitializeEx(std::ptr::null(), Com::COINIT_APARTMENTTHREADED)
        };
        let com_inited = hr_init >= 0;

        let result = do_capture_window(id);

        if com_inited {
            unsafe { Com::CoUninitialize() };
        }

        let _ = tx.send(result);
    });

    rx.recv()
        .map_err(|_| "Thread chụp cửa sổ bị panic hoặc không trả kết quả".to_string())?
}

/// Phần thực sự của capture: liệt kê cửa sổ, tìm theo id, kiểm tra trạng thái,
/// rồi chụp. Tách ra để dễ đọc và để `catch_unwind` bọc nếu cần sau này.
#[cfg(target_os = "windows")]
fn do_capture_window(id: u32) -> Result<Capture, String> {
    let windows = Window::all().map_err(|e| format!("Không liệt kê được cửa sổ: {e}"))?;

    let target = windows
        .into_iter()
        .find(|w| w.id().map(|i| i == id).unwrap_or(false))
        .ok_or_else(|| "Không tìm thấy cửa sổ (có thể đã đóng)".to_string())?;

    // Bỏ qua cửa sổ bị thu nhỏ: WGC capture window bị minimize thường trả ảnh
    // rỗng hoặc crash vì không có swap chain hợp lệ.
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

    persist(&img)
}
