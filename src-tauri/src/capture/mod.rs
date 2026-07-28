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

/// Kết quả chụp: base64 PNG + kích thước pixel vật lý.
/// (Không ghi file tạm nữa — base64 đi thẳng tới webview, nhanh hơn.)
#[derive(Clone)]
pub struct Capture {
    pub base64: String,
    pub width: u32,
    pub height: u32,
}

/// Mã hoá PNG ưu tiên TỐC ĐỘ (CompressionType::Fast + NoFilter) thay vì kích
/// thước file — phù hợp luồng chụp nhanh, ảnh thường được copy/sửa ngay.
fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::NoFilter)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("Lỗi mã hoá PNG: {e}"))?;
    Ok(bytes)
}

pub fn persist(img: &RgbaImage) -> Result<Capture, String> {
    let bytes = encode_png(img)?;
    Ok(Capture {
        base64: STANDARD.encode(&bytes),
        width: img.width(),
        height: img.height(),
    })
}
