//! Loại trừ cửa sổ app khỏi mọi ảnh capture ở tầng DWM/compositor —
//! tương tự SCContentFilter excludingApplications trên macOS.
//! Yêu cầu Windows 10 version 2004+ (build 19041).

#![cfg(target_os = "windows")]

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};
use windows::Win32::Graphics::Dwm::DwmFlush;

/// Set WDA_EXCLUDEFROMCAPTURE cho một HWND.
/// DWM sẽ render cửa sổ đó thành màu đen/trong suốt trong mọi capture API.
pub fn exclude_from_capture(hwnd: HWND) -> Result<(), String> {
    unsafe {
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
            .map_err(|e| format!("SetWindowDisplayAffinity failed: {e}"))
    }
}

/// Restore lại bình thường (khi cửa sổ hiển thị trở lại).
pub fn include_in_capture(hwnd: HWND) -> Result<(), String> {
    unsafe {
        SetWindowDisplayAffinity(hwnd, WDA_NONE)
            .map_err(|e| format!("SetWindowDisplayAffinity restore failed: {e}"))
    }
}

/// Chờ DWM commit frame hiện tại — gọi SAU khi set affinity để đảm bảo
/// cửa sổ đã bị loại khỏi compositor TRƯỚC khi capture bắt đầu.
/// Tương đương sleep(50ms) trên macOS nhưng CHÍNH XÁC hơn (không đoán thời gian).
pub fn dwm_flush() {
    unsafe { let _ = DwmFlush(); }
}