/// Kiểm tra quyền Screen Recording bằng API hệ thống chuẩn
/// `CGPreflightScreenCaptureAccess` — không gây side-effect (không thử chụp),
/// đúng với cơ chế TCC mà ScreenCaptureKit dùng.
#[cfg(target_os = "macos")]
pub fn screen_recording_ok() -> bool {
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
}

/// Yêu cầu cấp quyền Screen Recording (mở prompt hệ thống lần đầu).
#[cfg(target_os = "macos")]
pub fn request_screen_recording() -> bool {
    objc2_core_graphics::CGRequestScreenCaptureAccess()
}

#[cfg(not(target_os = "macos"))]
pub fn screen_recording_ok() -> bool {
    true
}
