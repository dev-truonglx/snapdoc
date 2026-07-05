use base64::{engine::general_purpose::STANDARD, Engine};

/// Nhận base64 PNG (có thể kèm prefix data URL), trả về raw bytes.
fn decode(data: &str) -> Result<Vec<u8>, String> {
    let b64 = data.split(',').next_back().unwrap_or(data);
    STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Base64 không hợp lệ: {e}"))
}

/// Copy ảnh PNG (base64) vào clipboard hệ thống dưới dạng bitmap.
pub fn copy_png(data: &str) -> Result<(), String> {
    copy_png_bytes(&decode(data)?)
}

/// Copy ảnh PNG (raw bytes) vào clipboard — dùng khi ảnh đã có sẵn dạng bytes
/// (vd đọc thẳng từ file asset History), tránh vòng encode/decode base64 thừa.
pub fn copy_png_bytes(bytes: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Không đọc được ảnh: {e}"))?
        .to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);

    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Không mở được clipboard: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: w,
            height: h,
            bytes: img.into_raw().into(),
        })
        .map_err(|e| format!("Không copy được ảnh: {e}"))?;
    Ok(())
}
