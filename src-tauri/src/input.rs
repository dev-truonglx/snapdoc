//! Đọc trạng thái nút chuột / phím toàn cục (không cần focus cửa sổ).
//! macOS dùng CoreGraphics; Windows dùng Win32 GetAsyncKeyState; OS khác (Linux)
//! tạm trả false (chưa hỗ trợ multi-monitor input).

#[cfg(target_os = "macos")]
mod imp {
    use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGMouseButton};

    const STATE: CGEventSourceStateID = CGEventSourceStateID::CombinedSessionState;
    const ESC_KEYCODE: u16 = 53;
    // Mã phím vật lý (kVK_ANSI_*) — không phụ thuộc layout bàn phím.
    const C_KEYCODE: u16 = 8;
    const M_KEYCODE: u16 = 46;

    pub fn left_down() -> bool {
        CGEventSource::button_state(STATE, CGMouseButton::Left)
    }
    pub fn right_down() -> bool {
        CGEventSource::button_state(STATE, CGMouseButton::Right)
    }
    pub fn escape_down() -> bool {
        CGEventSource::key_state(STATE, ESC_KEYCODE)
    }
    pub fn c_down() -> bool {
        CGEventSource::key_state(STATE, C_KEYCODE)
    }
    pub fn m_down() -> bool {
        CGEventSource::key_state(STATE, M_KEYCODE)
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    // Mã phím ảo Win32. VK_LBUTTON luôn là nút trái vật lý (GetAsyncKeyState
    // không hoán đổi theo "primary button" của hệ thống) — đủ dùng cho vùng chọn.
    const VK_LBUTTON: i32 = 0x01;
    const VK_RBUTTON: i32 = 0x02;
    const VK_ESCAPE: i32 = 0x1B;
    const VK_C: i32 = 0x43;
    const VK_M: i32 = 0x4D;

    // Bit cao (0x8000) = phím/nút ĐANG được nhấn ngay lúc gọi. Gọi được từ thread
    // bất kỳ, không cần message pump — hợp với input_loop chạy ở thread nền.
    fn down(vk: i32) -> bool {
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }

    pub fn left_down() -> bool {
        down(VK_LBUTTON)
    }
    pub fn right_down() -> bool {
        down(VK_RBUTTON)
    }
    pub fn escape_down() -> bool {
        down(VK_ESCAPE)
    }
    pub fn c_down() -> bool {
        down(VK_C)
    }
    pub fn m_down() -> bool {
        down(VK_M)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn left_down() -> bool {
        false
    }
    pub fn right_down() -> bool {
        false
    }
    pub fn escape_down() -> bool {
        false
    }
    pub fn c_down() -> bool {
        false
    }
    pub fn m_down() -> bool {
        false
    }
}

pub use imp::*;
