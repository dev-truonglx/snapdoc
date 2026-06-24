//! Đọc trạng thái nút chuột / phím toàn cục (không cần focus cửa sổ).
//! macOS dùng CoreGraphics; OS khác trả false (chưa hỗ trợ multi-monitor input).

#[cfg(target_os = "macos")]
mod imp {
    use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGMouseButton};

    const STATE: CGEventSourceStateID = CGEventSourceStateID::CombinedSessionState;
    const ESC_KEYCODE: u16 = 53;

    pub fn left_down() -> bool {
        CGEventSource::button_state(STATE, CGMouseButton::Left)
    }
    pub fn right_down() -> bool {
        CGEventSource::button_state(STATE, CGMouseButton::Right)
    }
    pub fn escape_down() -> bool {
        CGEventSource::key_state(STATE, ESC_KEYCODE)
    }
}

#[cfg(not(target_os = "macos"))]
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
}

pub use imp::*;
