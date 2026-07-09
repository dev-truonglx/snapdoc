use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Thư mục gốc của History (DB + asset store) — tách biệt hoàn toàn với
/// `saveDir` mà user tự cấu hình trong Settings (nơi đó là nơi user CHỌN lưu
/// file, còn đây là Library nội bộ app tự quản lý).
pub fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Không tìm thấy app_data_dir: {e}"))?;
    Ok(base.join("SnapDoc"))
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join("history.db"))
}

fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join("library").join("assets"))
}

fn thumbs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join("library").join("thumbs"))
}

/// Đường dẫn tuyệt đối (asset_path, thumb_path) cho một id — tạo sẵn thư mục
/// cha nếu chưa có. Gọi trước khi ghi file.
pub fn paths_for(app: &AppHandle, id: &str) -> Result<(PathBuf, PathBuf), String> {
    let assets = assets_dir(app)?;
    let thumbs = thumbs_dir(app)?;
    std::fs::create_dir_all(&assets).map_err(|e| format!("Không tạo được thư mục assets: {e}"))?;
    std::fs::create_dir_all(&thumbs).map_err(|e| format!("Không tạo được thư mục thumbs: {e}"))?;
    Ok((assets.join(format!("{id}.png")), thumbs.join(format!("{id}.jpg"))))
}

/// Chỉ đường dẫn thumbnail (không kèm asset_path trong `library/assets`) —
/// dùng cho video: file mp4 đã nằm sẵn ở `saveDir`/Pictures (do
/// `record::new_output_path` quyết định), KHÔNG cần bản sao thứ 2 trong
/// Library nội bộ (khác ảnh chụp — dung lượng nhỏ nên nhân đôi không đáng
/// kể). Chỉ thumbnail (JPEG nhỏ) là thứ thật sự cần sinh riêng.
pub fn thumb_path_for(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let thumbs = thumbs_dir(app)?;
    std::fs::create_dir_all(&thumbs).map_err(|e| format!("Không tạo được thư mục thumbs: {e}"))?;
    Ok(thumbs.join(format!("{id}.jpg")))
}
