#[cfg(target_os = "macos")]
pub mod macos;

/// Kiểm tra quyền chụp màn hình (không side-effect).
/// Trên macOS = `CGPreflightScreenCaptureAccess`; OS khác luôn true.
pub fn can_capture() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::screen_recording_ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Yêu cầu quyền chụp màn hình (mở prompt hệ thống nếu chưa cấp).
/// Trả về true nếu đã/được cấp. OS khác luôn true.
pub fn request_capture() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_screen_recording()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Kiểm tra quyền Accessibility (không side-effect) — xem `macos::accessibility_ok`.
pub fn can_use_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::accessibility_ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Yêu cầu quyền Accessibility (mở prompt hệ thống lần đầu nếu chưa cấp) —
/// xem `macos::request_accessibility`.
pub fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_accessibility()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
