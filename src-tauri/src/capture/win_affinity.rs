//! Loại trừ cửa sổ app khỏi mọi ảnh capture ở tầng DWM/compositor —
//! tương tự SCContentFilter excludingApplications trên macOS.
//! Yêu cầu Windows 10 version 2004+ (build 19041).

#![cfg(target_os = "windows")]

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Dwm::DwmFlush;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};

/// Set WDA_EXCLUDEFROMCAPTURE cho một HWND.
/// DWM sẽ render cửa sổ đó thành màu đen/trong suốt trong mọi capture API.
pub fn exclude_from_capture(hwnd: HWND) -> Result<(), String> {
    let ok = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) };
    if ok == 0 {
        return Err("SetWindowDisplayAffinity(EXCLUDE) failed".to_string());
    }
    Ok(())
}

/// Restore lại bình thường (khi cửa sổ hiển thị trở lại).
pub fn include_in_capture(hwnd: HWND) -> Result<(), String> {
    let ok = unsafe { SetWindowDisplayAffinity(hwnd, WDA_NONE) };
    if ok == 0 {
        return Err("SetWindowDisplayAffinity(NONE) failed".to_string());
    }
    Ok(())
}

/// Chờ DWM commit frame hiện tại — gọi SAU khi set affinity để đảm bảo
/// cửa sổ đã bị loại khỏi compositor TRƯỚC khi capture bắt đầu.
pub fn dwm_flush() {
    unsafe {
        let _ = DwmFlush();
    }
}