//! macOS: grab pixel bằng ScreenCaptureKit (macOS 14.0+) — API hiện đại của
//! Apple, thay cho `CGWindowListCreateImage` đã deprecated.
//!
//! - Vùng / toàn màn hình: `captureImageInRect` (display-agnostic, nhận CGRect
//!   theo POINTS trong không gian global, hỗ trợ đa màn hình, trả ảnh ở độ phân
//!   giải pixel vật lý — Retina giữ nguyên).
//! - Cửa sổ: `SCContentFilter(initWithDesktopIndependentWindow)` +
//!   `captureImageWithFilter` → chụp đúng 1 cửa sổ kể cả khi bị che.
//!
//! Các completion handler của SCK là async, được gọi trên hàng đợi nền nội bộ
//! của SCK (KHÔNG phải main queue) → block thread gọi để chờ kết quả là an
//! toàn (không deadlock), có timeout phòng treo.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use image::RgbaImage;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration,
};

const TIMEOUT: Duration = Duration::from_secs(10);

type CapResult = Result<RgbaImage, String>;

/// Lấy mô tả lỗi từ NSError (an toàn với con trỏ null).
unsafe fn err_msg(err: *mut NSError) -> String {
    if err.is_null() {
        return "không rõ".to_string();
    }
    let e: &NSError = &*err;
    e.localizedDescription().to_string()
}

/// CGImage (BGRA, có thể có padding cuối mỗi hàng) → RgbaImage. CHẠY trong
/// completion block của SCK khi con trỏ ảnh còn sống.
unsafe fn cgimage_to_rgba(img: *mut CGImage) -> CapResult {
    if img.is_null() {
        return Err("ScreenCaptureKit trả ảnh rỗng".to_string());
    }
    let img: &CGImage = &*img;
    let width = CGImage::width(Some(img));
    let height = CGImage::height(Some(img));
    if width == 0 || height == 0 {
        return Err("Kích thước ảnh không hợp lệ".to_string());
    }
    let bytes_per_row = CGImage::bytes_per_row(Some(img));
    let bits_per_pixel = CGImage::bits_per_pixel(Some(img));
    if bits_per_pixel != 32 {
        return Err(format!(
            "Định dạng pixel không hỗ trợ ({bits_per_pixel} bit/pixel, cần 32)"
        ));
    }
    let provider =
        CGImage::data_provider(Some(img)).ok_or_else(|| "Không lấy được data provider".to_string())?;
    let data = CGDataProvider::data(Some(&provider))
        .ok_or_else(|| "Không copy được dữ liệu ảnh".to_string())?
        .to_vec();

    // Buffer của SCK (IOSurface) thường được pad CẢ chiều rộng (bytes_per_row >
    // width*4) LẪN chiều cao (số hàng > height). Vì vậy phải copy ĐÚNG `height`
    // hàng, mỗi hàng ĐÚNG `width*4` byte → buffer dài chính xác width*height*4
    // (write_image của crate image assert độ dài khít, dài hơn sẽ panic).
    let row_len = width * 4;
    let stride = bytes_per_row.max(row_len);
    if data.len() < stride * (height - 1) + row_len {
        return Err(format!(
            "Dữ liệu ảnh thiếu ({} byte, cần ≥ {})",
            data.len(),
            stride * (height - 1) + row_len
        ));
    }
    let mut buffer = vec![0u8; row_len * height];
    for y in 0..height {
        let src = &data[y * stride..y * stride + row_len];
        let dst = &mut buffer[y * row_len..(y + 1) * row_len];
        dst.copy_from_slice(src);
    }
    // BGRA → RGBA.
    for px in buffer.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    RgbaImage::from_raw(width as u32, height as u32, buffer)
        .ok_or_else(|| "Tạo RgbaImage thất bại".to_string())
}

/// Chụp một hình chữ nhật theo POINTS trong không gian global (đa màn hình).
/// Dùng cho cả chế độ vùng chọn và chụp nguyên màn hình.
pub fn capture_rect(x: f64, y: f64, w: f64, h: f64) -> CapResult {
    if w < 1.0 || h < 1.0 {
        return Err("Vùng chụp không hợp lệ".to_string());
    }
    let rect = CGRect {
        origin: CGPoint { x, y },
        size: CGSize { width: w, height: h },
    };
    let (tx, rx) = mpsc::channel::<CapResult>();
    let handler = RcBlock::new(move |img: *mut CGImage, err: *mut NSError| {
        let r = if img.is_null() {
            Err(format!("ScreenCaptureKit lỗi: {}", unsafe { err_msg(err) }))
        } else {
            unsafe { cgimage_to_rgba(img) }
        };
        let _ = tx.send(r);
    });
    unsafe {
        SCScreenshotManager::captureImageInRect_completionHandler(rect, Some(&handler));
    }
    rx.recv_timeout(TIMEOUT)
        .map_err(|_| "Hết thời gian chờ ScreenCaptureKit".to_string())?
}

/// Chụp đúng một cửa sổ theo CGWindowID — kể cả khi bị cửa sổ khác che.
pub fn capture_window(window_id: u32) -> CapResult {
    let (tx, rx) = mpsc::channel::<CapResult>();
    let tx_outer = tx;

    // Block ngoài: nhận danh sách nội dung chia sẻ, tìm đúng SCWindow, dựng
    // filter + config rồi gọi captureImageWithFilter (block trong).
    let outer = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        if content.is_null() {
            let _ = tx_outer.send(Err(format!(
                "Không lấy được nội dung chia sẻ: {}",
                unsafe { err_msg(err) }
            )));
            return;
        }
        let content: &SCShareableContent = unsafe { &*content };
        let windows = unsafe { content.windows() };

        let mut target = None;
        for w in windows.iter() {
            if unsafe { w.windowID() } == window_id {
                target = Some(w);
                break;
            }
        }
        let scwin = match target {
            Some(w) => w,
            None => {
                let _ = tx_outer.send(Err("Không tìm thấy cửa sổ".to_string()));
                return;
            }
        };

        let filter = unsafe {
            SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &scwin)
        };
        // Kích thước pixel vật lý = contentRect (points) × pointPixelScale.
        let scale = unsafe { filter.pointPixelScale() } as f64;
        let crect = unsafe { filter.contentRect() };
        let px_w = ((crect.size.width * scale).round() as usize).max(1);
        let px_h = ((crect.size.height * scale).round() as usize).max(1);

        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(px_w);
            config.setHeight(px_h);
            config.setShowsCursor(false);
            config.setIgnoreShadowsSingleWindow(true);
        }

        let tx_inner = tx_outer.clone();
        let inner = RcBlock::new(move |img: *mut CGImage, err2: *mut NSError| {
            let r = if img.is_null() {
                Err(format!("Chụp cửa sổ lỗi: {}", unsafe { err_msg(err2) }))
            } else {
                unsafe { cgimage_to_rgba(img) }
            };
            let _ = tx_inner.send(r);
        });
        unsafe {
            SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                &filter,
                &config,
                Some(&inner),
            );
        }
    });

    unsafe {
        SCShareableContent::getShareableContentWithCompletionHandler(&outer);
    }
    rx.recv_timeout(TIMEOUT)
        .map_err(|_| "Hết thời gian chờ ScreenCaptureKit".to_string())?
}

/// Chụp thumbnail cho NHIỀU cửa sổ cùng lúc — dùng cho dialog "Chọn cửa sổ"
/// dạng lưới (`capture::window::capture_thumbs_streaming`).
///
/// `capture_window()` ở trên, nếu gọi lặp lại cho từng cửa sổ, phải
/// `getShareableContentWithCompletionHandler` (enumerate TOÀN BỘ cửa sổ/màn
/// hình hệ thống — thao tác tốn thời gian nhất trong cả quy trình, không phải
/// bản thân bước chụp) MỖI LẦN GỌI → N cửa sổ = N lần fetch tuần tự, đây
/// chính là nguyên nhân dialog load chậm khi có nhiều cửa sổ đang mở.
///
/// Hàm này fetch shareable content CHỈ 1 LẦN, sau đó bắn TẤT CẢ N yêu cầu
/// `captureImageWithFilter` liên tiếp KHÔNG chờ nhau (SCK xử lý async, tự chạy
/// song song trên hàng đợi nội bộ) — và chụp THẲNG ở kích thước đã thu nhỏ
/// (set Width/Height nhỏ ngay trong `SCStreamConfiguration`) thay vì chụp
/// full-res rồi resize lại ở Rust, giảm cả dung lượng ảnh truyền qua IPC lẫn
/// thời gian encode/decode phía SCK.
///
/// Gọi `on_result(id, result)` NGAY khi từng cửa sổ chụp xong (thứ tự hoàn
/// thành thực tế, không phải thứ tự trong `ids`) — để caller (xem
/// `capture::window::capture_thumbs_streaming`) có thể bắn event cho frontend
/// hiển thị thumbnail đó luôn, thay vì phải đợi TOÀN BỘ N cửa sổ chụp xong
/// mới thấy gì cả.
pub fn capture_window_thumbs(ids: &[u32], max_dim: u32, mut on_result: impl FnMut(u32, CapResult)) {
    if ids.is_empty() {
        return;
    }
    let (tx, rx) = mpsc::channel::<(u32, CapResult)>();
    let ids_owned: Vec<u32> = ids.to_vec();
    let n = ids_owned.len();

    let outer = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        if content.is_null() {
            let msg = format!("Không lấy được nội dung chia sẻ: {}", unsafe { err_msg(err) });
            for id in &ids_owned {
                let _ = tx.send((*id, Err(msg.clone())));
            }
            return;
        }
        let content: &SCShareableContent = unsafe { &*content };
        let windows = unsafe { content.windows() };

        for &id in &ids_owned {
            let mut target = None;
            for w in windows.iter() {
                if unsafe { w.windowID() } == id {
                    target = Some(w);
                    break;
                }
            }
            let Some(scwin) = target else {
                let _ = tx.send((id, Err("Không tìm thấy cửa sổ".to_string())));
                continue;
            };

            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &scwin)
            };
            let scale = unsafe { filter.pointPixelScale() } as f64;
            let crect = unsafe { filter.contentRect() };
            let full_w = (crect.size.width * scale).max(1.0);
            let full_h = (crect.size.height * scale).max(1.0);
            let ratio = (max_dim as f64 / full_w.max(full_h)).min(1.0);
            let px_w = ((full_w * ratio).round() as usize).max(1);
            let px_h = ((full_h * ratio).round() as usize).max(1);

            let config = unsafe { SCStreamConfiguration::new() };
            unsafe {
                config.setWidth(px_w);
                config.setHeight(px_h);
                config.setShowsCursor(false);
                config.setIgnoreShadowsSingleWindow(true);
            }

            let tx_inner = tx.clone();
            let inner = RcBlock::new(move |img: *mut CGImage, err2: *mut NSError| {
                let r = if img.is_null() {
                    Err(format!("Chụp cửa sổ lỗi: {}", unsafe { err_msg(err2) }))
                } else {
                    unsafe { cgimage_to_rgba(img) }
                };
                let _ = tx_inner.send((id, r));
            });
            unsafe {
                SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                    &filter,
                    &config,
                    Some(&inner),
                );
            }
        }
    });

    unsafe {
        SCShareableContent::getShareableContentWithCompletionHandler(&outer);
    }

    // Chờ đủ N kết quả — timeout TỔNG (không phải mỗi cửa sổ 1 timeout riêng),
    // dừng sớm (bỏ những cửa sổ còn lại) nếu quá hạn thay vì treo vô thời hạn.
    for _ in 0..n {
        match rx.recv_timeout(TIMEOUT) {
            Ok((id, r)) => on_result(id, r),
            Err(_) => break,
        }
    }
}
