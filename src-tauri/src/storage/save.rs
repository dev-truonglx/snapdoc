use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::PathBuf;

/// Nếu file đã tồn tại, tự thêm hậu tố _1, _2, ... để tránh ghi đè.
/// `pub(crate)`: `stamp_filename` chỉ có độ phân giải 1 GIÂY — mọi luồng
/// auto-save (ảnh lẫn video, xem `record::new_output_path`) đều phải qua đây
/// để 2 lần lưu trong cùng giây không âm thầm ghi đè nhau.
pub(crate) fn dedupe(path: PathBuf) -> PathBuf {
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

/// Ghi base64 PNG ra `path`, tự thêm hậu tố `_1`, `_2`... nếu đã tồn tại
/// (qua `dedupe`). Dùng cho các luồng auto-save im lặng (hotkey chụp nhanh,
/// Quick Capture) — không có bước xác nhận nào của người dùng trước đó nên
/// không được phép ghi đè file có sẵn. Trả về đường dẫn thực tế đã ghi.
pub fn write_png(path: &str, data: &str) -> Result<String, String> {
    write_png_to(dedupe(PathBuf::from(path)), data)
}

/// Ghi base64 PNG ra ĐÚNG `path` được truyền vào, KHÔNG qua `dedupe`. Dùng
/// cho Save/Save As thủ công (`save_image`/`save_and_copy`): path này đến từ
/// dialog Save gốc OS, dialog đã tự hỏi "Replace existing file?" và người
/// dùng đã xác nhận ghi đè — nếu vẫn dedupe sẽ âm thầm tạo `ten-file_1.png`
/// bên cạnh thay vì ghi đè đúng file đã chọn.
pub fn write_png_exact(path: &str, data: &str) -> Result<String, String> {
    write_png_to(PathBuf::from(path), data)
}

fn write_png_to(target: PathBuf, data: &str) -> Result<String, String> {
    let b64 = data.split(',').next_back().unwrap_or(data);
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Base64 không hợp lệ: {e}"))?;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("Lỗi ghi file: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}
