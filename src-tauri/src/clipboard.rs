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

/// Copy file ảnh GIF vào clipboard hệ thống dưới dạng ảnh động (hoặc file drop).
#[cfg(target_os = "macos")]
pub fn copy_gif_file(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File GIF không tồn tại: {}", path.display()));
    }
    let path_str = path.to_string_lossy();
    let script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as «class GIFf»)",
        path_str.replace('"', "\\\"")
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Lỗi gọi osascript: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "osascript copy GIF thất bại: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn copy_gif_file(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File GIF không tồn tại: {}", path.display()));
    }
    let path_str = path.to_string_lossy();
    let script = format!("Set-Clipboard -Path '{}'", path_str.replace('\'', "''"));
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("Lỗi gọi powershell: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "powershell copy GIF thất bại: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn copy_gif_file(_path: &std::path::Path) -> Result<(), String> {
    Err("Nền tảng này chưa hỗ trợ copy file GIF vào clipboard".to_string())
}

