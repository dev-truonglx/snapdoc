use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{GenericImageView, ImageEncoder};

const MAX_EDGE: u32 = 320;
const JPEG_QUALITY: u8 = 78;

/// Sinh thumbnail JPEG từ bytes PNG gốc (đã ghi ra asset). Resize theo cạnh
/// dài <= MAX_EDGE trước khi encode — ảnh "all monitors"/scroll dài không bị
/// giữ nguyên full-res trong bước resize (tốn CPU/RAM không cần thiết).
pub fn generate(png_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png_bytes)
        .map_err(|e| format!("Không decode được ảnh để tạo thumbnail: {e}"))?;
    let (w, h) = img.dimensions();
    let scale = (MAX_EDGE as f32 / w.max(h).max(1) as f32).min(1.0);
    let (tw, th) = ((w as f32 * scale).round().max(1.0) as u32, (h as f32 * scale).round().max(1.0) as u32);

    // Triangle: nhanh, chất lượng đủ tốt cho thumbnail nhỏ (không cần Lanczos3).
    let resized = img.resize(tw, th, FilterType::Triangle).to_rgb8();

    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .write_image(resized.as_raw(), resized.width(), resized.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("Không encode được thumbnail JPEG: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([200, 50, 50, 255]));
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .unwrap();
        bytes
    }

    #[test]
    fn generate_downscales_large_image_and_produces_valid_jpeg() {
        let png = fake_png(2000, 1000);
        let thumb = generate(&png).unwrap();
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert!(decoded.width() <= MAX_EDGE);
        assert!(decoded.height() <= MAX_EDGE);
        // Tỉ lệ khung hình giữ nguyên (2:1).
        assert_eq!(decoded.width(), decoded.height() * 2);
    }

    #[test]
    fn generate_does_not_upscale_small_image() {
        let png = fake_png(50, 40);
        let thumb = generate(&png).unwrap();
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert_eq!(decoded.width(), 50);
        assert_eq!(decoded.height(), 40);
    }
}
