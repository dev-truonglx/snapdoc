use super::db::HistoryState;
use super::model::{HistoryFilter, HistoryPage, HistoryRecord};
use super::{decode_image_data, now_ms};
use crate::state::{AppState, PendingCapture};
use crate::windows;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::ToSql;
use tauri::{AppHandle, Manager};

fn state(app: &AppHandle) -> Result<tauri::State<'_, HistoryState>, String> {
    app.try_state::<HistoryState>()
        .ok_or_else(|| "History chưa sẵn sàng (DB init thất bại lúc khởi động)".to_string())
}

// ── Logic đồng bộ (chạy trong spawn_blocking) ──────────────────────────────

fn list_history_sync(app: &AppHandle, filter: HistoryFilter) -> Result<HistoryPage, String> {
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;

    let mut where_clauses: Vec<String> = vec![if filter.trash_only {
        "deleted_at IS NOT NULL".to_string()
    } else {
        "deleted_at IS NULL".to_string()
    }];
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(from) = filter.from {
        where_clauses.push("created_at >= ?".to_string());
        params.push(Box::new(from));
    }
    if let Some(to) = filter.to {
        where_clauses.push("created_at < ?".to_string());
        params.push(Box::new(to));
    }
    if let Some(mode) = &filter.capture_mode {
        where_clauses.push("capture_mode = ?".to_string());
        params.push(Box::new(mode.clone()));
    }
    if let Some(search) = &filter.search {
        if !search.is_empty() {
            where_clauses.push("title LIKE ?".to_string());
            params.push(Box::new(format!("%{search}%")));
        }
    }
    let where_sql = where_clauses.join(" AND ");

    let total: i64 = {
        let sql = format!("SELECT COUNT(*) FROM history WHERE {where_sql}");
        let refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.query_row(&sql, refs.as_slice(), |r| r.get(0))
            .map_err(|e| format!("Đếm history thất bại: {e}"))?
    };

    let sql = format!("SELECT * FROM history WHERE {where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut all_params = params;
    all_params.push(Box::new(filter.limit));
    all_params.push(Box::new(filter.offset));
    let refs: Vec<&dyn ToSql> = all_params.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(refs.as_slice(), HistoryRecord::from_row)
        .map_err(|e| format!("Query history thất bại: {e}"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| e.to_string())?);
    }

    Ok(HistoryPage { items, total })
}

fn get_history_item_sync(app: &AppHandle, id: &str) -> Result<HistoryRecord, String> {
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    conn.query_row("SELECT * FROM history WHERE id = ?1", [id], HistoryRecord::from_row)
        .map_err(|e| format!("Không tìm thấy history item: {e}"))
}

fn delete_history_item_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    conn.execute(
        "UPDATE history SET deleted_at = ?1 WHERE id = ?2",
        rusqlite::params![now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn restore_history_item_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    conn.execute("UPDATE history SET deleted_at = NULL WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn permanently_delete_history_item_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    let _ = std::fs::remove_file(&rec.asset_path);
    let _ = std::fs::remove_file(&rec.thumb_path);
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    conn.execute("DELETE FROM history WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn empty_trash_sync(app: &AppHandle) -> Result<u32, String> {
    let ids: Vec<String> = {
        let st = state(app)?;
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM history WHERE deleted_at IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let count = ids.len() as u32;
    for id in ids {
        let _ = permanently_delete_history_item_sync(app, &id);
    }
    Ok(count)
}

fn rename_history_item_sync(app: &AppHandle, id: &str, title: &str) -> Result<(), String> {
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    conn.execute(
        "UPDATE history SET title = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![title, now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn open_history_item_in_editor_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.deleted_at.is_some() {
        return Err("Không thể mở item đang ở Trash — hãy Restore trước".to_string());
    }
    if rec.media_type == "video" {
        return Err("Video chưa hỗ trợ mở trong Editor".to_string());
    }
    let bytes = std::fs::read(&rec.asset_path).map_err(|e| format!("Không đọc được asset: {e}"))?;
    let base64 = STANDARD.encode(&bytes);
    {
        let state = app.state::<AppState>();
        let mut g = state.pending.lock().map_err(|_| "Lock error".to_string())?;
        *g = Some(PendingCapture {
            base64,
            width: rec.width,
            height: rec.height,
            output: "editor".to_string(),
            scale_factor: rec.scale_factor,
            history_id: Some(id.to_string()),
        });
    }
    windows::open_editor(app)
}

fn update_history_asset_sync(app: &AppHandle, id: &str, data: &str) -> Result<HistoryRecord, String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type == "video" {
        return Err("Video chưa hỗ trợ chỉnh sửa".to_string());
    }
    let bytes = decode_image_data(data)?;
    std::fs::write(&rec.asset_path, &bytes).map_err(|e| format!("Ghi asset thất bại: {e}"))?;
    let thumb_bytes = super::thumbnail::generate(&bytes)?;
    std::fs::write(&rec.thumb_path, &thumb_bytes).map_err(|e| format!("Ghi thumbnail thất bại: {e}"))?;

    let img = image::load_from_memory(&bytes).map_err(|e| format!("Ảnh không hợp lệ: {e}"))?;
    let (w, h) = (img.width(), img.height());

    let st = state(app)?;
    {
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "UPDATE history SET updated_at = ?1, width = ?2, height = ?3, file_size = ?4, is_edited = 1 WHERE id = ?5",
            rusqlite::params![now_ms(), w, h, bytes.len() as i64, id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_history_item_sync(app, id)
}

fn copy_history_item_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type == "video" {
        return Err("Video chưa hỗ trợ copy vào clipboard".to_string());
    }
    let bytes = std::fs::read(&rec.asset_path).map_err(|e| format!("Không đọc được asset: {e}"))?;
    crate::clipboard::copy_png_bytes(&bytes)
}

fn reveal_history_item_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&rec.asset_path)
        .map_err(|e| format!("Không mở được thư mục chứa file: {e}"))
}

// ── Tauri commands (IPC-facing) ────────────────────────────────────────────
// Đều async + spawn_blocking: các thao tác này đọc/ghi đĩa + SQLite, có thể
// mất vài–vài chục ms với ảnh lớn — không được chặn Tokio event loop / WebView2
// message pump, đồng nhất với convention của các command chụp ảnh khác.

#[tauri::command]
pub async fn list_history(app: AppHandle, filter: HistoryFilter) -> Result<HistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || list_history_sync(&app, filter))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn get_history_item(app: AppHandle, id: String) -> Result<HistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || get_history_item_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn delete_history_item(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_history_item_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn restore_history_item(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restore_history_item_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn permanently_delete_history_item(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || permanently_delete_history_item_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Xoá vĩnh viễn toàn bộ item trong Trash. Trả về số lượng đã xoá.
#[tauri::command]
pub async fn empty_trash(app: AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || empty_trash_sync(&app))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn rename_history_item(app: AppHandle, id: String, title: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_history_item_sync(&app, &id, &title))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Nạp asset của 1 history item vào `AppState.pending` (kèm `history_id`) rồi
/// mở Editor — Editor Save sau đó sẽ ghi đè tại chỗ đúng record này.
#[tauri::command]
pub async fn open_history_item_in_editor(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_history_item_in_editor_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Editor Save-in-place: ghi đè asset + thumbnail của đúng record, bump
/// `updated_at`, đánh dấu `is_edited`. KHÔNG tạo record mới.
#[tauri::command]
pub async fn update_history_asset(app: AppHandle, id: String, data: String) -> Result<HistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || update_history_asset_sync(&app, &id, &data))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Copy nhanh 1 item History vào clipboard (đọc thẳng từ asset trên đĩa) —
/// dùng cho dải "Gần đây" ở cạnh dưới Editor, không cần mở lại Editor.
#[tauri::command]
pub async fn copy_history_item(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_history_item_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub async fn reveal_history_item(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reveal_history_item_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub fn open_history(app: AppHandle) -> Result<(), String> {
    windows::open_history(&app)
}

/// Hoàn tất Quick Capture (copy/save ảnh đã flatten annotation) + ingest vào
/// history. async + spawn_blocking để không block Tokio event loop trong lúc
/// ghi file/DB.
#[tauri::command]
pub async fn finish_quick_capture(
    app: AppHandle,
    data: String,
    width: u32,
    height: u32,
    output: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || super::ingest_quick(&app, &data, width, height, &output))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}
