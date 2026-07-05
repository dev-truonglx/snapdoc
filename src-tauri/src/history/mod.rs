pub mod assets;
pub mod commands;
pub mod db;
pub mod model;
pub mod thumbnail;

use crate::capture;
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use db::HistoryState;
use model::HistoryRecord;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Chấp nhận cả base64 trần (quy ước `capture::Capture.base64`) lẫn data URL
/// đầy đủ (`data:image/png;base64,...` — quy ước phía frontend) — tách phần
/// sau dấu phẩy cuối nếu có, không ảnh hưởng chuỗi không có dấu phẩy.
pub(crate) fn decode_image_data(data: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(strip_data_url_prefix(data).trim())
        .map_err(|e| format!("Base64 không hợp lệ: {e}"))
}

/// Bỏ phần `data:image/png;base64,` nếu có, giữ nguyên chuỗi nếu đã là base64 trần.
pub(crate) fn strip_data_url_prefix(data: &str) -> &str {
    data.split(',').next_back().unwrap_or(data)
}

/// Ghi 1 capture vào Library — CHIA 2 PHA để không chặn đường mở editor/copy/save:
///
/// - Pha 1 (đồng bộ, ở đây): chỉ 1 INSERT tối thiểu → trả về `HistoryRecord`
///   ngay, đủ để `attach_pending_id` gắn `history_id` trước khi Editor mở lên.
/// - Pha 2 (nền, `ingest_finish_bg`): decode base64 + ghi asset PNG + tạo
///   thumbnail JPEG + UPDATE `file_size`, chạy trên thread riêng, không ai chờ.
///   Nếu pha 2 lỗi (đĩa đầy...), record được soft-delete (chuyển vào Trash)
///   thay vì để lại 1 row trỏ tới file không tồn tại — History UI vốn đã xử lý
///   graceful ảnh vỡ (xem `HistoryItemCard`), nhưng tự ẩn khỏi thư viện chính
///   sạch sẽ hơn là hiện ảnh lỗi mãi.
///
/// KHÔNG BAO GIỜ được gọi bằng `?` từ luồng capture chính (flow::finish) —
/// lỗi ở pha 1 chỉ nên log, không làm gián đoạn clipboard/save/editor.
pub fn ingest(
    app: &AppHandle,
    cap: &capture::Capture,
    mode: &str,
    scale_factor: f64,
) -> Result<HistoryRecord, String> {
    let state = app
        .try_state::<HistoryState>()
        .ok_or_else(|| "History chưa sẵn sàng (DB init thất bại lúc khởi động)".to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let (asset_path, thumb_path) = assets::paths_for(app, &id)?;
    let asset_path_str = asset_path.to_string_lossy().to_string();
    let thumb_path_str = thumb_path.to_string_lossy().to_string();

    {
        let conn = state.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO history (id, created_at, updated_at, capture_mode, width, height, scale_factor, asset_path, thumb_path) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![id, now, now, mode, cap.width, cap.height, scale_factor, asset_path_str, thumb_path_str],
        )
        .map_err(|e| format!("Insert history thất bại: {e}"))?;
    }

    let record = HistoryRecord {
        id: id.clone(),
        created_at: now,
        updated_at: now,
        capture_mode: mode.to_string(),
        media_type: "image".to_string(),
        width: cap.width,
        height: cap.height,
        scale_factor,
        duration_ms: None,
        asset_path: asset_path_str,
        thumb_path: thumb_path_str,
        file_size: None,
        source_app: None,
        title: None,
        is_edited: false,
        deleted_at: None,
    };

    let app2 = app.clone();
    let base64 = cap.base64.clone();
    std::thread::spawn(move || ingest_finish_bg(&app2, id, asset_path, thumb_path, &base64));

    Ok(record)
}

/// Pha 2 của `ingest`: ghi asset + thumbnail (chạy nền), rồi cập nhật
/// `file_size`. Lỗi → soft-delete record thay vì để row mồ côi.
fn ingest_finish_bg(app: &AppHandle, id: String, asset_path: PathBuf, thumb_path: PathBuf, base64: &str) {
    let write_result = (|| -> Result<i64, String> {
        let bytes = decode_image_data(base64)?;
        std::fs::write(&asset_path, &bytes).map_err(|e| format!("Ghi asset thất bại: {e}"))?;
        let thumb_bytes = thumbnail::generate(&bytes)?;
        std::fs::write(&thumb_path, &thumb_bytes).map_err(|e| format!("Ghi thumbnail thất bại: {e}"))?;
        Ok(bytes.len() as i64)
    })();

    let Some(state) = app.try_state::<HistoryState>() else { return };
    match write_result {
        Ok(file_size) => {
            if let Ok(conn) = state.conn.lock() {
                let _ = conn.execute(
                    "UPDATE history SET file_size = ?1 WHERE id = ?2",
                    rusqlite::params![file_size, id],
                );
            }
        }
        Err(e) => {
            eprintln!("[SnapDoc][history] ghi asset/thumbnail nền thất bại, chuyển record vào Trash: {e}");
            if let Ok(conn) = state.conn.lock() {
                let _ = conn.execute(
                    "UPDATE history SET deleted_at = ?1 WHERE id = ?2",
                    rusqlite::params![now_ms(), id],
                );
            }
        }
    }
}

/// Gắn `history_id` vào `PendingCapture` hiện tại (nếu còn tồn tại) — gọi
/// SAU khi `ingest()` đã trả về id, để Editor mở lên biết record nào để
/// update-in-place khi Save.
pub fn attach_pending_id(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut g) = state.pending.lock() {
        if let Some(p) = g.as_mut() {
            p.history_id = Some(id.to_string());
        }
    };
}

/// Ghi output "clipboard"/"save"/"save_copy" cho Quick Capture (ảnh đã
/// flatten annotation ở frontend), rồi ingest vào history với mode="quick".
///
/// KHÔNG dùng chung `flow::finish()` — quick-capture cố tình giữ UX hiện có
/// (không mở PendingCapture/thumbnail popup, overlay tự đóng ngay). Copy/Save
/// luôn thực hiện trước và luôn thành công độc lập với việc ingest; lỗi
/// ingest chỉ log, không làm hỏng action mà user vừa bấm.
pub fn ingest_quick(
    app: &AppHandle,
    data: &str,
    width: u32,
    height: u32,
    output: &str,
) -> Result<Option<String>, String> {
    match output {
        "clipboard" => crate::clipboard::copy_png(data)?,
        "save" => save_quick_auto(app, data)?,
        "save_copy" => {
            crate::clipboard::copy_png(data)?;
            save_quick_auto(app, data)?;
        }
        _ => {}
    }

    let cap = capture::Capture {
        base64: strip_data_url_prefix(data).to_string(),
        width,
        height,
    };
    match ingest(app, &cap, "quick", 1.0) {
        Ok(rec) => Ok(Some(rec.id)),
        Err(e) => {
            eprintln!("[SnapDoc][history] ingest_quick thất bại (output đã thực hiện xong): {e}");
            Ok(None)
        }
    }
}

/// Lưu vào `saveDir` (settings) hoặc mặc định `Pictures/SnapDoc`, tên file
/// theo cùng template `Screenshot_YYYY-MM-DD_HHMMSS.png` với capture thường
/// (tái dùng `flow::stamp_filename`).
fn save_quick_auto(app: &AppHandle, data: &str) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let settings = crate::storage::settings::load(&config_dir);
    let dir = settings
        .get("saveDir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let dir = if dir.is_empty() {
        app.path()
            .picture_dir()
            .map(|p| p.join("SnapDoc").to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        dir
    };
    let path = format!("{dir}/{}.png", crate::flow::stamp_filename());
    crate::storage::save::write_png(&path, data)?;
    Ok(())
}
