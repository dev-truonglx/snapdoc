pub mod macos;

/// Kiểm tra quyền chụp màn hình (không side-effect).
/// Trên macOS = `CGPreflightScreenCaptureAccess`; OS khác luôn true.
pub fn can_capture() -> bool {
    macos::screen_recording_ok()
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
