pub mod freeze;
pub mod fullscreen;
pub mod monitor;
pub mod region;
pub mod window;

#[cfg(target_os = "macos")]
pub mod mac_sck;
#[cfg(target_os = "macos")]
pub mod mac_stream;
#[cfg(target_os = "windows")]
pub mod windows_stream;
#[cfg(target_os = "windows")]
pub mod win_affinity;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};

/// Kết quả chụp: PNG raw bytes + base64 PNG + kích thước pixel vật lý.
#[derive(Clone)]
pub struct Capture {
    pub bytes: Vec<u8>,
    pub base64: String,
    pub width: u32,
    pub height: u32,
}

/// Mã hoá PNG ưu tiên TỐC ĐỘ (CompressionType::Fast + NoFilter) thay vì kích
/// thước file — phù hợp luồng chụp nhanh, ảnh thường được copy/sửa ngay.
pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::NoFilter)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("Lỗi mã hoá PNG: {e}"))?;
    Ok(bytes)
}

pub fn persist(img: &RgbaImage) -> Result<Capture, String> {
    let bytes = encode_png(img)?;
    let base64 = STANDARD.encode(&bytes);
    Ok(Capture {
        bytes,
        base64,
        width: img.width(),
        height: img.height(),
    })
}

/// Mã hoá JPEG chất lượng cao (mặc định quality 92) — đặc biệt tối ưu cho ảnh cuộn siêu dài.
/// Giảm 85-90% dung lượng RAM/file và kích hoạt Hardware JPEG Decoder trên WebKit macOS.
pub fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(bytes) = encode_jpeg_native_macos(img, quality as f32 / 100.0) {
            return Ok(bytes);
        }
    }
    encode_jpeg_cpu(img, quality)
}

#[cfg(target_os = "macos")]
fn encode_jpeg_native_macos(img: &RgbaImage, quality: f32) -> Result<Vec<u8>, String> {
    use objc2::{class, msg_send, rc::autoreleasepool, runtime::AnyObject};
    use objc2_foundation::ns_string;

    let width = img.width() as usize;
    let height = img.height() as usize;
    if width == 0 || height == 0 {
        return Err("Kích thước ảnh bằng 0".to_string());
    }
    let raw_ptr = img.as_raw().as_ptr() as *mut u8;

    autoreleasepool(|_| unsafe {
        let rep_alloc: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
        if rep_alloc.is_null() {
            return Err("Alloc NSBitmapImageRep thất bại".to_string());
        }

        let mut planes: [*mut u8; 5] = [
            raw_ptr,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ];
        let color_space = ns_string!("NSDeviceRGBColorSpace");

        let rep: *mut AnyObject = msg_send![
            rep_alloc,
            initWithBitmapDataPlanes: planes.as_mut_ptr(),
            pixelsWide: width as isize,
            pixelsHigh: height as isize,
            bitsPerSample: 8isize,
            samplesPerPixel: 4isize,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: color_space,
            bytesPerRow: (width * 4) as isize,
            bitsPerPixel: 32isize
        ];

        if rep.is_null() {
            return Err("initWithBitmapDataPlanes thất bại".to_string());
        }

        let num: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: quality as f64];
        let key = ns_string!("NSImageCompressionFactor");
        let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: num, forKey: key];

        // 3 = NSBitmapImageFileTypeJPEG
        let data: *mut AnyObject = msg_send![rep, representationUsingType: 3usize, properties: props];

        let result = if !data.is_null() {
            let len: usize = msg_send![data, length];
            let bytes: *const u8 = msg_send![data, bytes];
            if !bytes.is_null() && len > 0 {
                let slice = std::slice::from_raw_parts(bytes, len);
                Ok(slice.to_vec())
            } else {
                Err("Dữ liệu NSData JPEG rỗng".to_string())
            }
        } else {
            Err("representationUsingType thất bại".to_string())
        };

        let _: () = msg_send![rep, release];
        result
    })
}

pub fn encode_jpeg_cpu(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    let (w, h) = (img.width(), img.height());
    let raw = img.as_raw();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for chunk in raw.chunks_exact(4) {
        rgb.push(chunk[0]);
        rgb.push(chunk[1]);
        rgb.push(chunk[2]);
    }
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
        .map_err(|e| format!("Lỗi mã hoá JPEG CPU: {e}"))?;
    Ok(buf)
}

/// Dành riêng cho chụp cuộn: lưu thành JPEG chất lượng 92% thay vì PNG,
/// giúp WebKit decode trong <100ms thay vì 2-3 giây.
pub fn persist_scroll(img: &RgbaImage) -> Result<Capture, String> {
    let bytes = encode_jpeg(img, 92)?;
    let base64 = STANDARD.encode(&bytes);
    Ok(Capture {
        bytes,
        base64,
        width: img.width(),
        height: img.height(),
    })
}

