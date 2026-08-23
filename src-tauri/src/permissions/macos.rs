/// Kiểm tra quyền Screen Recording bằng API hệ thống chuẩn
/// `CGPreflightScreenCaptureAccess` — không gây side-effect (không thử chụp),
/// đúng với cơ chế TCC mà ScreenCaptureKit dùng.
pub fn screen_recording_ok() -> bool {
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
}

/// Yêu cầu cấp quyền Screen Recording (mở prompt hệ thống lần đầu).
pub fn request_screen_recording() -> bool {
    objc2_core_graphics::CGRequestScreenCaptureAccess()
}

/// Kiểm tra quyền Accessibility (Trợ năng) — cần để `windows::bring_app_to_front`
/// raise ĐÚNG 1 cửa sổ cụ thể (không phải cả app) khi bắt đầu quay 1 cửa sổ,
/// xem `capture/window.rs::ax_raise_window`. Không side-effect (không mở prompt).
pub fn accessibility_ok() -> bool {
    unsafe { accessibility_sys::AXIsProcessTrusted() }
}

/// Yêu cầu quyền Accessibility — KHÁC Screen Recording (ScreenCaptureKit tự
/// mở prompt hệ thống ở lần capture thật đầu tiên, không cần gọi request):
/// Accessibility KHÔNG tự prompt khi gọi AX API mà chưa được cấp quyền, phải
/// chủ động gọi `AXIsProcessTrustedWithOptions` kèm option "prompt" này thì
/// macOS mới hiện hộp thoại xin quyền + tự thêm app vào danh sách System
/// Settings > Privacy & Security > Accessibility (ở trạng thái CHƯA bật, user
/// tự bật). Trả `true` nếu đã được cấp NGAY (hiếm khi đúng ở lần gọi đầu).
pub fn request_accessibility() -> bool {
    use accessibility_sys::{AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt};
    use core_foundation_sys::{
        base::{kCFAllocatorDefault, CFRelease, CFTypeRef},
        dictionary::{CFDictionaryCreate, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks},
        number::kCFBooleanTrue,
    };
    use std::ffi::c_void;

    unsafe {
        let key = kAXTrustedCheckOptionPrompt as *const c_void;
        let value = kCFBooleanTrue as *const c_void;
        let dict = CFDictionaryCreate(
            kCFAllocatorDefault,
            &key,
            &value,
            1,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        let trusted = AXIsProcessTrustedWithOptions(dict);
        CFRelease(dict as CFTypeRef);
        trusted
    }
}
