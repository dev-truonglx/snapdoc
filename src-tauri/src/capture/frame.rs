//! Kiểu frame video dùng chung cho mọi nguồn quay liên tục (`mac_stream` —
//! ScreenCaptureKit, `windows_stream` — Windows.Graphics.Capture) và phía
//! tiêu thụ (`record::pacer` → encoder ffmpeg). Trước đây mỗi nền tảng tự
//! khai 1 struct `Frame` y hệt nhau + tự có 1 ticker riêng (hành vi lệch nhau:
//! macOS bỏ nhịp khi trễ, Windows bắn dồn) — giờ nguồn quay CHỈ cập nhật
//! `LatestFrame`, còn nhịp đẩy frame vào encoder nằm duy nhất ở `record::pacer`.

use std::sync::{Arc, Mutex};

/// 1 frame BGRA thô, KHÔNG padding cuối hàng (`bgra.len() == width*height*4`).
pub struct Frame {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Ô chứa frame MỚI NHẤT nguồn quay đã gửi — nguồn ghi đè, pacer đọc theo
/// nhịp fps (lặp lại frame cũ nếu màn hình đứng yên).
pub type LatestFrame = Arc<Mutex<Option<Arc<Frame>>>>;

pub fn new_latest() -> LatestFrame {
    Arc::new(Mutex::new(None))
}

/// Ghi đè frame mới nhất; trả lại buffer của frame cũ (nếu không còn ai giữ
/// tham chiếu) để nguồn quay tái sử dụng, tránh cấp phát hàng chục MB mỗi frame.
pub fn publish(latest: &LatestFrame, frame: Frame) -> Option<Vec<u8>> {
    let old = {
        let mut g = latest.lock().unwrap_or_else(|p| p.into_inner());
        g.replace(Arc::new(frame))
    }?;
    Arc::try_unwrap(old).ok().map(|f| f.bgra)
}

/// Copy `height` hàng (mỗi hàng `row_bytes` byte, cách nhau `src_stride` byte
/// trong `src`) vào `dst` liền mạch, tái dùng `spare` làm bộ nhớ đích nếu đúng
/// kích thước. Không zero-fill: mọi byte của đích đều được ghi đè.
///
/// # Safety
/// `src` phải hợp lệ để đọc `src_stride * (height - 1) + row_bytes` byte.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub unsafe fn copy_rows(
    src: *const u8,
    src_stride: usize,
    row_bytes: usize,
    height: usize,
    spare: Option<Vec<u8>>,
) -> Vec<u8> {
    let needed = row_bytes * height;
    let mut dst = match spare {
        Some(v) if v.len() == needed => v,
        _ => vec![0u8; needed],
    };
    if src_stride == row_bytes {
        std::ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), needed);
    } else {
        for y in 0..height {
            std::ptr::copy_nonoverlapping(
                src.add(y * src_stride),
                dst.as_mut_ptr().add(y * row_bytes),
                row_bytes,
            );
        }
    }
    dst
}

/// Thu nhỏ (giữ tỉ lệ) để cạnh dài <= `max_long` và cạnh ngắn <= `max_short`,
/// rồi làm tròn XUỐNG số chẵn (yuv420p đòi width/height chẵn). Không phóng to.
pub fn fit_even(w: u32, h: u32, max_long: u32, max_short: u32) -> (u32, u32) {
    let (long, short) = if w >= h { (w, h) } else { (h, w) };
    let scale = (max_long as f64 / long.max(1) as f64)
        .min(max_short as f64 / short.max(1) as f64)
        .min(1.0);
    let nw = ((w as f64 * scale).floor() as u32).max(2) & !1;
    let nh = ((h as f64 * scale).floor() as u32).max(2) & !1;
    (nw, nh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_even_keeps_small_sizes() {
        assert_eq!(fit_even(1920, 1080, 3840, 2160), (1920, 1080));
        assert_eq!(fit_even(2880, 1800, 3840, 2160), (2880, 1800));
        assert_eq!(fit_even(1823, 1161, 3840, 2160), (1822, 1160));
    }

    #[test]
    fn fit_even_scales_5k_and_portrait() {
        assert_eq!(fit_even(5120, 2880, 3840, 2160), (3840, 2160));
        assert_eq!(fit_even(2160, 3840, 3840, 2160), (2160, 3840));
        let (w, h) = fit_even(5120, 1440, 3840, 2160);
        assert_eq!((w, h), (3840, 1080));
        let (w, h) = fit_even(6016, 3384, 3840, 2160);
        assert!(w <= 3840 && h <= 2160 && w % 2 == 0 && h % 2 == 0);
    }

    #[test]
    fn copy_rows_strips_padding() {
        // 2 hàng, mỗi hàng 4 byte dữ liệu + 2 byte padding.
        let src: Vec<u8> = vec![1, 2, 3, 4, 0, 0, 5, 6, 7, 8, 0, 0];
        let out = unsafe { copy_rows(src.as_ptr(), 6, 4, 2, None) };
        assert_eq!(out, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        let reused = unsafe { copy_rows(src.as_ptr(), 6, 4, 2, Some(vec![9; 8])) };
        assert_eq!(reused, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn publish_recycles_unshared_buffer() {
        let latest = new_latest();
        assert!(publish(&latest, Frame { bgra: vec![1; 8], width: 1, height: 2 }).is_none());
        let recycled = publish(&latest, Frame { bgra: vec![2; 8], width: 1, height: 2 });
        assert_eq!(recycled, Some(vec![1; 8]));
        // Có người giữ Arc → không tái dùng được.
        let held = latest.lock().unwrap().clone();
        assert!(publish(&latest, Frame { bgra: vec![3; 8], width: 1, height: 2 }).is_none());
        drop(held);
    }
}
