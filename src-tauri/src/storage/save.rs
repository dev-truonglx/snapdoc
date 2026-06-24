use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::PathBuf;

/// Nếu file đã tồn tại, tự thêm hậu tố _1, _2, ... để tránh ghi đè.
fn dedupe(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "snapdoc".into());
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "png".into());
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();

    let mut i = 1;
    loop {
        let candidate = dir.join(format!("{stem}_{i}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

/// Ghi base64 PNG ra đúng `path`. Trả về đường dẫn thực tế đã ghi.
pub fn write_png(path: &str, data: &str) -> Result<String, String> {
    let b64 = data.split(',').next_back().unwrap_or(data);
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Base64 không hợp lệ: {e}"))?;

    let target = dedupe(PathBuf::from(path));
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("Lỗi ghi file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}
