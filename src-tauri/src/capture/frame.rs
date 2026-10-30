//! Kiểu frame video dùng chung cho mọi nguồn quay liên tục (`mac_stream` —
//! ScreenCaptureKit, `windows_stream` — Windows.Graphics.Capture) và phía
//! tiêu thụ (`record::pacer` → encoder ffmpeg). Trước đây mỗi nền tảng tự
//! khai 1 struct `Frame` y hệt nhau + tự có 1 ticker riêng (hành vi lệch nhau:
//! macOS bỏ nhịp khi trễ, Windows bắn dồn) — giờ nguồn quay CHỈ cập nhật
//! `LatestFrame`, còn nhịp đẩy frame vào encoder nằm duy nhất ở `record::pacer`.

use std::sync::{Arc, Mutex};

/// Bố cục byte của `Frame::data` (luôn KHÔNG padding cuối hàng).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    /// 4 byte/pixel B,G,R,A — Windows.Graphics.Capture.
    Bgra,
    /// YUV 4:2:0 bán phẳng, dải "video" (16–235): mặt phẳng Y (`width*height`
    /// byte) rồi mặt phẳng CbCr xen kẽ (`width*height/2` byte) — macOS (SCK
    /// chuyển màu trên GPU). Encoder nhận thẳng, ffmpeg không phải chạy swscale.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Nv12,
}

impl PixelFormat {
    /// Tên `-pix_fmt` của ffmpeg.
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            PixelFormat::Bgra => "bgra",
            PixelFormat::Nv12 => "nv12",
        }
    }

    /// Số byte của 1 frame `width×height` (NV12: width/height chẵn — xem `fit_even`).
    pub fn frame_len(self, width: u32, height: u32) -> usize {
        let (w, h) = (width as usize, height as usize);
        match self {
            PixelFormat::Bgra => w * h * 4,
            PixelFormat::Nv12 => w * h + w * (h / 2),
        }
    }
}

/// 1 frame thô theo `format`, KHÔNG padding cuối hàng
/// (`data.len() == format.frame_len(width, height)`).
pub struct Frame {
    pub data: Vec<u8>,
    pub format: PixelFormat,
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
    Arc::try_unwrap(old).ok().map(|f| f.data)
}

/// Copy `height` hàng (mỗi hàng `row_bytes` byte, cách nhau `src_stride` byte
/// trong `src`) vào `dst` liền mạch (đúng `row_bytes * height` byte) — bỏ
/// padding cuối hàng của IOSurface; gọi 1 lần cho mỗi mặt phẳng để ghép nhiều
/// mặt phẳng (NV12: Y rồi CbCr) vào cùng 1 buffer.
///
/// # Safety
/// `src` phải hợp lệ để đọc `src_stride * (height - 1) + row_bytes` byte.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub unsafe fn copy_rows_into(src: *const u8, src_stride: usize, row_bytes: usize, height: usize, dst: &mut [u8]) {
    assert_eq!(dst.len(), row_bytes * height);
    if src_stride == row_bytes {
        std::ptr::copy_nonoverlapping(src, dst.as_mut_ptr(), dst.len());
    } else {
        for y in 0..height {
            std::ptr::copy_nonoverlapping(
                src.add(y * src_stride),
                dst.as_mut_ptr().add(y * row_bytes),
                row_bytes,
            );
        }
    }
}

/// Khớp frame về đúng (dst_w, dst_h) đã khai với encoder khi bắt đầu quay —
/// cửa sổ bị resize giữa chừng thì crop/pad viền đen (góc trên-trái giữ nguyên)
/// thay vì bỏ frame. Giữ nguyên định dạng pixel của frame.
pub fn fit_to_size(frame: &Frame, dst_w: u32, dst_h: u32) -> Vec<u8> {
    let copy_w = frame.width.min(dst_w) as usize;
    let copy_h = frame.height.min(dst_h) as usize;
    match frame.format {
        PixelFormat::Bgra => {
            let mut dst = vec![0u8; PixelFormat::Bgra.frame_len(dst_w, dst_h)];
            copy_plane(&frame.data, frame.width as usize * 4, &mut dst, dst_w as usize * 4, copy_w * 4, copy_h);
            dst
        }
        PixelFormat::Nv12 => {
            // Đen ở dải "video": Y = 16, Cb = Cr = 128.
            let (sw, sh, dw, dh) = (frame.width as usize, frame.height as usize, dst_w as usize, dst_h as usize);
            let mut dst = vec![16u8; dw * dh];
            dst.resize(PixelFormat::Nv12.frame_len(dst_w, dst_h), 128);
            let (src_y, src_uv) = frame.data.split_at((sw * sh).min(frame.data.len()));
            let (dst_y, dst_uv) = dst.split_at_mut(dw * dh);
            copy_plane(src_y, sw, dst_y, dw, copy_w, copy_h);
            // Mỗi hàng CbCr phủ 2 hàng Y, mỗi cặp byte phủ 2 cột → giữ chẵn.
            copy_plane(src_uv, sw, dst_uv, dw, copy_w & !1, copy_h / 2);
            dst
        }
    }
}

/// Copy `rows` hàng × `row_bytes` byte giữa 2 mặt phẳng có stride riêng; bỏ
/// qua phần vượt quá dữ liệu nguồn/đích (frame hỏng thì thà thiếu còn hơn panic).
fn copy_plane(src: &[u8], src_stride: usize, dst: &mut [u8], dst_stride: usize, row_bytes: usize, rows: usize) {
    for y in 0..rows {
        let (s, d) = (y * src_stride, y * dst_stride);
        if s + row_bytes > src.len() || d + row_bytes > dst.len() {
            break;
        }
        dst[d..d + row_bytes].copy_from_slice(&src[s..s + row_bytes]);
    }
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

    fn bgra(data: Vec<u8>, width: u32, height: u32) -> Frame {
        Frame { data, format: PixelFormat::Bgra, width, height }
    }

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
        let mut out = vec![9u8; 8];
        unsafe { copy_rows_into(src.as_ptr(), 6, 4, 2, &mut out) };
        assert_eq!(out, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        let mut tight = vec![0u8; 4];
        unsafe { copy_rows_into(src.as_ptr(), 4, 4, 1, &mut tight) };
        assert_eq!(tight, vec![1, 2, 3, 4]);
    }

    #[test]
    fn publish_recycles_unshared_buffer() {
        let latest = new_latest();
        assert!(publish(&latest, bgra(vec![1; 8], 1, 2)).is_none());
        let recycled = publish(&latest, bgra(vec![2; 8], 1, 2));
        assert_eq!(recycled, Some(vec![1; 8]));
        // Có người giữ Arc → không tái dùng được.
        let held = latest.lock().unwrap().clone();
        assert!(publish(&latest, bgra(vec![3; 8], 1, 2)).is_none());
        drop(held);
    }
    #[test]
    fn nv12_frame_len() {
        assert_eq!(PixelFormat::Nv12.frame_len(4, 2), 8 + 4);
        assert_eq!(PixelFormat::Nv12.frame_len(1920, 1080), 1920 * 1080 * 3 / 2);
        assert_eq!(PixelFormat::Bgra.frame_len(4, 2), 32);
    }

    #[test]
    fn fit_to_size_pads_and_crops_bgra() {
        // 1×2 → 2×1: giữ pixel (0,0), pixel mới là đen.
        let out = fit_to_size(&bgra(vec![1, 2, 3, 4, 5, 6, 7, 8], 1, 2), 2, 1);
        assert_eq!(out, vec![1, 2, 3, 4, 0, 0, 0, 0]);
    }

    #[test]
    fn fit_to_size_pads_and_crops_nv12() {
        // Nguồn 2×2: Y = [1,2 / 3,4], CbCr = [5,6].
        let src = Frame { data: vec![1, 2, 3, 4, 5, 6], format: PixelFormat::Nv12, width: 2, height: 2 };
        // Lớn hơn (4×2): phần thêm là đen video-range.
        let out = fit_to_size(&src, 4, 2);
        assert_eq!(out, vec![1, 2, 16, 16, 3, 4, 16, 16, 5, 6, 128, 128]);
        // Nhỏ hơn chiều cao (2×4 → giữ 2 hàng đầu, thêm 2 hàng đen).
        let out = fit_to_size(&src, 2, 4);
        assert_eq!(out, vec![1, 2, 3, 4, 16, 16, 16, 16, 5, 6, 128, 128]);
        // Crop (4×4 → 2×2) giữ góc trên-trái.
        let big = Frame {
            data: (0..24).collect(),
            format: PixelFormat::Nv12,
            width: 4,
            height: 4,
        };
        assert_eq!(fit_to_size(&big, 2, 2), vec![0, 1, 4, 5, 16, 17]);
    }
}
