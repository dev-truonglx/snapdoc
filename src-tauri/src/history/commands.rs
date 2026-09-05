use super::db::HistoryState;
use super::model::{HistoryFilter, HistoryPage, HistoryRecord};
use super::{decode_image_data, now_ms};
use crate::state::{AppState, PendingCapture, PendingVideo};
use crate::windows;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::ToSql;
use tauri::{AppHandle, Emitter, Manager};

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
    if let Some(media_type) = &filter.media_type {
        where_clauses.push("media_type = ?".to_string());
        params.push(Box::new(media_type.clone()));
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

    // Video KHÔNG copy vào Library nội bộ — `asset_path` trỏ thẳng vào
    // saveDir tại thời điểm quay. Scope asset-protocol chỉ được mở cho
    // saveDir HIỆN TẠI (startup + lúc quay); video quay ở saveDir cũ (user
    // đã đổi thư mục lưu) sẽ bị chặn `convertFileSrc` (404) khi phát trong
    // History. Mở scope cho thư mục cha của từng video trong trang kết quả.
    {
        let mut seen = std::collections::HashSet::new();
        for item in items.iter().filter(|i| i.media_type == "video") {
            if let Some(parent) = std::path::Path::new(&item.asset_path).parent() {
                if seen.insert(parent.to_path_buf()) {
                    if let Err(e) = app.asset_protocol_scope().allow_directory(parent, true) {
                        eprintln!(
                            "[SnapDoc][history] Không mở được asset scope cho {}: {e}",
                            parent.display()
                        );
                    }
                }
            }
        }
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
    // Lỗi xoá file (đang bị app khác giữ, quyền...) KHÔNG chặn xoá row DB —
    // giữ row sẽ làm thùng rác không bao giờ dọn được — nhưng phải log lại:
    // trước đây nuốt im lặng, file mồ côi nằm lại trên đĩa mà không dấu vết.
    for path in [&rec.asset_path, &rec.thumb_path] {
        if let Err(e) = std::fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[SnapDoc][history] Không xoá được file {path} (file sẽ mồ côi trên đĩa): {e}");
            }
        }
    }
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    conn.execute("DELETE FROM history WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

struct TrashFile {
    asset_path: String,
    thumb_path: String,
}

fn delete_trash_items_batch(app: &AppHandle, where_clause: &str, params: &[&dyn ToSql]) -> Result<u32, String> {
    let items: Vec<TrashFile> = {
        let st = state(app)?;
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        let sql = format!("SELECT asset_path, thumb_path FROM history WHERE {where_clause}");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params, |r| {
            Ok(TrashFile {
                asset_path: r.get(0)?,
                thumb_path: r.get(1)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    if items.is_empty() {
        return Ok(0);
    }

    let count = items.len() as u32;

    for item in &items {
        for path in [&item.asset_path, &item.thumb_path] {
            if let Err(e) = std::fs::remove_file(path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("[SnapDoc][history] Không xoá được file {path} (file sẽ mồ côi trên đĩa): {e}");
                }
            }
        }
    }

    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    let sql = format!("DELETE FROM history WHERE {where_clause}");
    conn.execute(&sql, params).map_err(|e| e.to_string())?;

    Ok(count)
}

fn empty_trash_sync(app: &AppHandle) -> Result<u32, String> {
    delete_trash_items_batch(app, "deleted_at IS NOT NULL", &[])
}

/// Thời gian giữ item trong Trash trước khi tự động xoá vĩnh viễn. Xem
/// `STABILITY_RISKS.md` mục B.5/E.7: `library/assets`+`library/thumbs` từng
/// lớn dần vô hạn vì Trash chỉ được dọn khi user tự bấm "Dọn thùng rác".
const TRASH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Tự động xoá vĩnh viễn các item đã ở Trash quá `TRASH_RETENTION_MS` (30
/// ngày) — user vẫn Restore được bình thường trong 30 ngày đó, chỉ mất
/// quyền Restore sau khi đã bị dọn. Cùng logic với `empty_trash_sync`, chỉ
/// khác điều kiện lọc theo `deleted_at`.
pub fn purge_old_trash(app: &AppHandle) -> Result<u32, String> {
    let cutoff = now_ms() - TRASH_RETENTION_MS;
    delete_trash_items_batch(app, "deleted_at IS NOT NULL AND deleted_at < ?1", &[&cutoff])
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

/// Đọc bytes gốc (KHÔNG base64) của 1 history item — dùng bởi HistoryStrip
/// trong Editor để đổi ảnh đang xem TẠI CHỖ (không đi qua PendingCapture/
/// base64/window focus dance của `open_history_item_in_editor`, vì Editor đã
/// đang mở sẵn). Trả về `tauri::ipc::Response` (raw bytes, không serialize
/// JSON) để tránh chi phí base64 + JSON string cho ảnh gốc (có thể vài–vài
/// chục MB với màn hình Retina) — nguyên nhân chính gây lag khi bấm chọn ảnh
/// trong dải "Gần đây".
fn read_history_asset_bytes_sync(app: &AppHandle, id: &str) -> Result<Vec<u8>, String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.deleted_at.is_some() {
        return Err("Không thể mở item đang ở Trash — hãy Restore trước".to_string());
    }
    if rec.media_type == "video" {
        return Err("Video chưa hỗ trợ mở trong Editor".to_string());
    }
    Ok(load_asset(&rec)?.0)
}

/// Đọc asset của một item ẢNH → `(pixel nền, doc.json hiệu lực)`.
///
/// Che khác biệt giữa hai thế hệ định dạng bằng MAGIC BYTES, không bằng phần mở
/// rộng: Library của các bản trước còn đầy `{id}.png` trần, và viết lại toàn bộ
/// dữ liệu người dùng một lượt là rủi ro không cần thiết khi chỉ cần sniff 4
/// byte là đọc đúng cả hai. Item PNG cũ chỉ chuyển sang `.snapdoc` khi user Save
/// nó lần đầu (xem `save_history_doc_sync`).
///
/// "doc.json hiệu lực" = `draft.json` nếu có, ngược lại `doc.json` — tức luôn
/// mở ra đúng thứ user đang làm dở, kể cả sau khi app bị kill.
fn load_asset(rec: &HistoryRecord) -> Result<(Vec<u8>, String, bool), String> {
    let path = std::path::Path::new(&rec.asset_path);
    if crate::snapdoc_file::is_snapdoc(path) {
        let f = crate::snapdoc_file::read_snapdoc(path)?;
        let is_draft = f.draft_json.is_some();
        let doc = f.effective_doc().to_string();
        return Ok((f.base_png, doc, is_draft));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Không đọc được asset: {e}"))?;
    Ok((bytes, super::EMPTY_DOC_JSON.to_string(), false))
}

/// Bytes để đưa vào clipboard / xuất ra ngoài: bản ĐÃ GHÉP annotation
/// (`preview.png`), không phải nền sạch — đúng cái user thấy trên màn hình.
/// Ảnh PNG cũ thì bản thân file đã là "cái thấy được".
fn load_asset_preview(rec: &HistoryRecord) -> Result<Vec<u8>, String> {
    let path = std::path::Path::new(&rec.asset_path);
    if crate::snapdoc_file::is_snapdoc(path) {
        if let Some(bytes) =
            crate::snapdoc_file::read_snapdoc_entry(path, crate::snapdoc_file::PREVIEW_PNG)?
        {
            return Ok(bytes);
        }
        // Container thiếu preview (không nên xảy ra) → thà trả nền còn hơn lỗi.
        return Ok(crate::snapdoc_file::read_snapdoc(path)?.base_png);
    }
    std::fs::read(path).map_err(|e| format!("Không đọc được asset: {e}"))
}

/// Tìm id của ảnh (không phải video) mới nhất chưa bị xoá — dùng để mở
/// editor với "ảnh chụp gần nhất" lúc khởi động app (xem `lib.rs::setup`).
fn latest_image_history_id_sync(app: &AppHandle) -> Result<Option<String>, String> {
    let st = state(app)?;
    let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
    conn.query_row(
        "SELECT id FROM history WHERE deleted_at IS NULL AND media_type != 'video' ORDER BY created_at DESC LIMIT 1",
        [],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })
}

/// Mở editor lúc khởi động app, tải sẵn ảnh chụp gần nhất (nếu có) — tránh
/// tình trạng lần chụp/hover đầu tiên sau khi mở app không giữ được overlay
/// đang mở vì webview editor chưa "ấm" (xem yêu cầu người dùng: mở editor
/// ngay khi khởi động để app "swap up" sẵn). Không có ảnh nào trong Library
/// → coi như no-op, không mở editor trống.
pub fn open_latest_capture_in_editor_sync(app: &AppHandle) -> Result<(), String> {
    match latest_image_history_id_sync(app)? {
        Some(id) => open_history_item_in_editor_sync(app, &id),
        None => Ok(()),
    }
}

fn open_history_item_in_editor_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.deleted_at.is_some() {
        return Err("Không thể mở item đang ở Trash — hãy Restore trước".to_string());
    }
    if rec.media_type == "video" {
        let state = app.state::<AppState>();
        let mut g = state.pending_video.lock().map_err(|_| "Lock error".to_string())?;
        *g = Some(PendingVideo {
            path: rec.asset_path.clone(),
            width: rec.width,
            height: rec.height,
            duration_ms: rec.duration_ms.unwrap_or(0),
            history_id: id.to_string(),
        });
        drop(g);
        return windows::open_editor(app);
    }
    // Nền + lớp annotation cùng đi qua `PendingCapture`, để editor dựng lại
    // đúng trạng thái đang sửa chứ không chỉ mở ảnh trống.
    let (base_bytes, doc_json, is_draft) = load_asset(&rec)?;
    let base64 = STANDARD.encode(&base_bytes);
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
            capture_mode: rec.capture_mode.clone(),
            doc_json: Some(doc_json),
            doc_is_draft: is_draft,
            // Đến từ Library → Save ghi vào record, không phải vào file ngoài.
            file_path: None,
        });
    }
    windows::open_editor(app)
}

/// Lưu tài liệu của một item ảnh — **PHI HUỶ**.
///
/// Khác hẳn hành vi trước đây (`update_history_asset` cũ ghi đè `asset_path`
/// bằng ảnh ĐÃ GHÉP, tức annotation biến thành pixel vĩnh viễn và bản gốc sạch
/// mất luôn): ở đây pixel nền được GIỮ NGUYÊN, annotation lưu thành JSON cạnh
/// nó, nên mở lại lúc nào cũng di chuyển/đổi màu/xoá từng annotation được.
/// Thao tác phá huỷ duy nhất còn lại là Flatten (có dialog xác nhận riêng), và
/// nó đi qua đây với `base_data = Some(...)`.
///
/// - `doc_json`: trạng thái annotation sẽ trở thành bản ĐÃ LƯU. `draft.json`
///   bị XOÁ (write_snapdoc chỉ ghi entry nào được truyền) → cờ "chưa lưu" tắt.
/// - `preview_data`: bản đã ghép, dùng cho clipboard/xem nhanh + sinh thumbnail.
/// - `base_data`: chỉ truyền khi ẢNH NỀN thật sự đổi (crop/stitch/flatten —
///   frontend theo dõi qua `baseRev`). `None` → giữ nguyên nền đang có, nên
///   một lần Save chỉ-annotation không phải đẩy vài MB base64 qua IPC.
///
/// Item PNG cũ (định dạng thế hệ trước) được CHUYỂN sang `.snapdoc` ngay tại
/// đây: ghi file mới, cập nhật `asset_path`, xoá PNG cũ.
fn save_history_doc_sync(
    app: &AppHandle,
    id: &str,
    doc_json: &str,
    preview_data: &str,
    base_data: Option<&str>,
) -> Result<HistoryRecord, String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type == "video" {
        return Err("Video chưa hỗ trợ chỉnh sửa".to_string());
    }
    let preview_bytes = decode_image_data(preview_data)?;

    let old_path = std::path::Path::new(&rec.asset_path).to_path_buf();
    let was_snapdoc = crate::snapdoc_file::is_snapdoc(&old_path);

    // Nền: ưu tiên bản mới do frontend gửi lên, nếu không thì đọc lại nền đang
    // có. Với PNG cũ thì "nền đang có" chính là cả file.
    let (base_bytes, created_at) = match base_data {
        Some(d) => (
            decode_image_data(d)?,
            if was_snapdoc {
                crate::snapdoc_file::read_snapdoc(&old_path)
                    .map(|f| f.created_at)
                    .unwrap_or_else(|_| rec.created_at)
            } else {
                rec.created_at
            },
        ),
        None if was_snapdoc => {
            let f = crate::snapdoc_file::read_snapdoc(&old_path)?;
            (f.base_png, f.created_at)
        }
        None => (
            std::fs::read(&old_path).map_err(|e| format!("Không đọc được asset: {e}"))?,
            rec.created_at,
        ),
    };

    // Kích thước ghi vào DB lấy từ NỀN (không phải preview): đó mới là khung
    // toạ độ mà annotation trong `doc.json` bám vào, và cũng là thứ Editor nạp.
    let base_img =
        image::load_from_memory(&base_bytes).map_err(|e| format!("Ảnh nền không hợp lệ: {e}"))?;
    let (w, h) = (base_img.width(), base_img.height());

    let new_path = super::assets::snapdoc_path_for(app, id)?;
    crate::snapdoc_file::write_snapdoc(
        &new_path,
        crate::snapdoc_file::WriteSnapdoc {
            base_png: &base_bytes,
            doc_json,
            // Save = chốt bản nháp thành bản chính → KHÔNG ghi lại draft.
            draft_json: None,
            preview_png: &preview_bytes,
            created_at,
            updated_at: now_ms(),
        },
    )?;

    // Thumbnail sinh từ PREVIEW để lưới History/dải "Gần đây" hiện đúng cái
    // user thấy (có annotation), không phải nền trống.
    let thumb_bytes = super::thumbnail::generate(&preview_bytes)?;
    std::fs::write(&rec.thumb_path, &thumb_bytes)
        .map_err(|e| format!("Ghi thumbnail thất bại: {e}"))?;

    // Chuyển item PNG cũ sang `.snapdoc`: chỉ xoá file cũ SAU KHI file mới đã
    // ghi xong (write_snapdoc là atomic), để một lần lỗi không mất cả hai.
    let asset_path_str = new_path.to_string_lossy().to_string();
    if asset_path_str != rec.asset_path {
        let _ = std::fs::remove_file(&old_path);
    }
    let file_size = std::fs::metadata(&new_path).ok().map(|m| m.len() as i64);

    let st = state(app)?;
    {
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "UPDATE history SET updated_at = ?1, width = ?2, height = ?3, file_size = ?4, asset_path = ?5, is_edited = 1 WHERE id = ?6",
            rusqlite::params![now_ms(), w, h, file_size, asset_path_str, id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("snapdoc:changed", id);
    get_history_item_sync(app, id)
}

/// Ghi bản nháp (autosave) — chỉ đổi `draft.json` bên trong container, giữ
/// nguyên `doc.json`/`preview.png`/thumbnail.
///
/// Cố tình KHÔNG chạm thumbnail và KHÔNG set `is_edited`: đây là việc đang làm
/// dở, chưa phải nội dung chính thức của ảnh. Nhờ tách 2 slot như vậy mà nút
/// Save và chỉ báo "chưa lưu" vẫn giữ được ý nghĩa dù có autosave.
///
/// # Race với ingest
///
/// `ingest` INSERT row TRƯỚC rồi `ingest_finish_bg` mới ghi file ở thread nền.
/// Autosave (debounce ~2s) hoàn toàn có thể chạy trước khi file kịp tồn tại
/// trên một cái đĩa chậm. Khi đó KHÔNG được lỗi — chỉ bỏ qua lượt này; lượt
/// debounce sau (hoặc lần flush lúc rời/đóng) sẽ ghi được. Bản nháp mất tối đa
/// 2 giây đầu của một ảnh vừa chụp, còn state trong RAM thì vẫn nguyên.
fn put_history_draft_sync(app: &AppHandle, id: &str, doc_json: &str) -> Result<bool, String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type == "video" {
        return Ok(false);
    }
    let path = std::path::Path::new(&rec.asset_path).to_path_buf();
    if !crate::snapdoc_file::is_snapdoc(&path) {
        // Chưa ghi xong (race ở trên), hoặc là item PNG thế hệ cũ. Cả 2 ca đều
        // chờ tới lần Save (khi đó `save_history_doc_sync` dựng container).
        return Ok(false);
    }
    let f = crate::snapdoc_file::read_snapdoc(&path)?;
    let preview = crate::snapdoc_file::read_snapdoc_entry(&path, crate::snapdoc_file::PREVIEW_PNG)?
        .unwrap_or_else(|| f.base_png.clone());
    crate::snapdoc_file::write_snapdoc(
        &path,
        crate::snapdoc_file::WriteSnapdoc {
            base_png: &f.base_png,
            doc_json: &f.doc_json,
            draft_json: Some(doc_json),
            preview_png: &preview,
            created_at: f.created_at,
            updated_at: now_ms(),
        },
    )?;
    // CỐ TÌNH không emit "snapdoc:changed" ở đây, khác `save_history_doc_sync`
    // và `discard_history_draft_sync`: autosave chạy mỗi ~2s trong lúc user
    // đang vẽ, mà listener của event này cho dải "Gần đây" lại quét lại toàn bộ
    // container để dựng danh sách badge → 2 giây một lần mở hàng trăm file zip.
    //
    // Không mất gì: item đang sửa chính là `currentId`, vốn bị LOẠI khỏi badge
    // theo thiết kế (trạng thái chưa lưu của nó đã có chỉ báo riêng trên
    // toolbar), còn các item ở nền lấy badge từ registry trong RAM ngay lập
    // tức. Danh sách trên đĩa chỉ cần đúng sau khi khởi động lại app.
    Ok(true)
}

/// Bỏ bản nháp → tài liệu trở về đúng bản đã Save gần nhất.
fn discard_history_draft_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    let path = std::path::Path::new(&rec.asset_path).to_path_buf();
    if !crate::snapdoc_file::is_snapdoc(&path) {
        return Ok(());
    }
    let f = crate::snapdoc_file::read_snapdoc(&path)?;
    if f.draft_json.is_none() {
        return Ok(());
    }
    let preview = crate::snapdoc_file::read_snapdoc_entry(&path, crate::snapdoc_file::PREVIEW_PNG)?
        .unwrap_or_else(|| f.base_png.clone());
    crate::snapdoc_file::write_snapdoc(
        &path,
        crate::snapdoc_file::WriteSnapdoc {
            base_png: &f.base_png,
            doc_json: &f.doc_json,
            draft_json: None,
            preview_png: &preview,
            created_at: f.created_at,
            updated_at: now_ms(),
        },
    )?;
    let _ = app.emit("snapdoc:changed", id);
    Ok(())
}

/// `doc.json` hiệu lực (`draft.json` nếu có) của một item — chuỗi nhỏ, tách
/// khỏi đường đọc pixel để `HistoryStrip` lấy song song mà không tốn gì.
fn get_history_doc_json_sync(app: &AppHandle, id: &str) -> Result<Option<DocLayer>, String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type == "video" {
        return Ok(None);
    }
    let path = std::path::Path::new(&rec.asset_path);
    if !crate::snapdoc_file::is_snapdoc(path) {
        return Ok(None);
    }
    let f = crate::snapdoc_file::read_snapdoc(path)?;
    Ok(Some(DocLayer {
        is_draft: f.draft_json.is_some(),
        json: f.effective_doc().to_string(),
    }))
}

/// Lớp annotation + cờ "đây là bản nháp chưa lưu" — Editor cần cờ này để đánh
/// dấu tài liệu là chưa lưu và để hỏi user muốn tiếp tục hay bỏ.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocLayer {
    pub json: String,
    pub is_draft: bool,
}

/// Id các item đang có bản nháp chưa lưu — dải "Gần đây" dùng để gắn badge sau
/// khi khởi động lại app (phiên trong RAM đã mất, nhưng nháp trên đĩa còn).
fn list_items_with_draft_sync(app: &AppHandle) -> Result<Vec<String>, String> {
    let st = state(app)?;
    // KHÔNG lọc `is_edited = 1`: autosave cố tình không set cờ đó (nháp là việc
    // đang làm dở, chưa phải nội dung chính thức của ảnh), nên lọc theo nó sẽ
    // bỏ sót đúng trường hợp hàm này cần tìm.
    //
    // Chặn ở `LIMIT` thay vì quét cả Library: badge chỉ hiện được trên các item
    // mà UI thật sự vẽ ra (dải "Gần đây" lấy 20 item mới nhất), nên quét vài
    // trăm item gần nhất là đủ và không phải mở hàng nghìn file.
    let rows: Vec<(String, String)> = {
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, asset_path FROM history \
                 WHERE deleted_at IS NULL AND media_type != 'video' \
                 ORDER BY created_at DESC LIMIT 200",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        it.filter_map(Result::ok).collect()
    };
    Ok(rows
        .into_iter()
        // `has_draft` chỉ đọc central directory của ZIP — không giải nén
        // `base.png`, nên vòng lặp này rẻ dù chạy qua vài trăm file.
        .filter(|(_, asset_path)| crate::snapdoc_file::has_draft(std::path::Path::new(asset_path)))
        .map(|(id, _)| id)
        .collect())
}

/// Cắt 1 video đã lưu trong Library — tạo 1 record MỚI cho bản đã cắt, GIỮ
/// NGUYÊN record gốc (không đổi 1 byte nào của asset/thumbnail/DB row cũ).
/// Trước đây ghi đè tại chỗ — cắt sai 1 lần là mất trắng phần đã xoá, không
/// có đường lùi. Đổi lại: mỗi lần cắt tốn thêm dung lượng cho 1 file video
/// mới (đã cân nhắc — với video quay màn hình, đánh đổi này hợp lý hơn nguy
/// cơ mất bản gốc). File mới nằm ở `saveDir` giống video quay bình thường
/// (`record::new_output_path`, KHÔNG copy vào `library/assets` — theo đúng
/// quy ước hiện có cho video, xem `history::ingest_video`).
fn trim_history_video_sync(
    app: &AppHandle,
    id: &str,
    keep_ranges_ms: &[(i64, i64)],
    remove_audio: bool,
    output_path: Option<&str>,
    overlays: Option<&[crate::record::encoder::VideoOverlay]>,
) -> Result<HistoryRecord, String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type != "video" {
        return Err("Chỉ video mới cắt được".to_string());
    }

    let asset_path = std::path::Path::new(&rec.asset_path);
    // `output_path` do user tự chọn qua dropdown "Chọn nơi lưu…" (dialog Save
    // As ở VideoTrimmer) — khác đường mặc định `new_output_path` (auto vào
    // `saveDir`/Pictures), nên phải tự tạo thư mục + mở asset scope cho ĐÚNG
    // thư mục đó (khác `saveDir` đã được mở sẵn từ trước).
    let new_path = match output_path {
        Some(p) => {
            let p = std::path::PathBuf::from(p);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("Không tạo được thư mục lưu: {e}"))?;
                crate::record::allow_asset_scope(app, parent);
            }
            p
        }
        None => crate::record::new_output_path(app)?,
    };
    // Báo tiến độ % cho Editor (chế độ video) qua event toàn app — xem
    // doc-comment `encoder::trim` + listener ở `Editor.tsx`.
    let progress_app = app.clone();
    crate::record::encoder::trim(asset_path, keep_ranges_ms, &new_path, remove_audio, overlays, move |frac| {
        use tauri::Emitter;
        let _ = progress_app.emit("trim-progress", frac);
    })?;

    let new_duration_ms: i64 = keep_ranges_ms.iter().map(|(s, e)| (e - s).max(0)).sum();
    let file_size = std::fs::metadata(&new_path).ok().map(|m| m.len() as i64);

    let new_id = uuid::Uuid::new_v4().to_string();
    let thumb_path = super::assets::thumb_path_for(app, &new_id)?;
    // Lỗi sinh thumbnail KHÔNG chặn kết quả cắt — file video đã cắt xong và
    // hợp lệ, chỉ ảnh thu nhỏ hiển thị tạm là fallback trống (giống cách
    // `ingest_video` xử lý lỗi thumbnail).
    if let Err(e) = super::video_thumbnail::generate(&new_path, &thumb_path) {
        eprintln!("[SnapDoc][history] Sinh thumbnail cho bản đã cắt thất bại: {e}");
    }

    let asset_path_str = new_path.to_string_lossy().to_string();
    let thumb_path_str = thumb_path.to_string_lossy().to_string();
    // Gắn "(đã cắt)" vào tên để phân biệt với bản gốc trong danh sách — nếu
    // bản gốc chưa đặt tên thì để trống, dựa vào fallback "(Không tên)" +
    // thứ tự mới nhất trong list là đủ phân biệt.
    let new_title = rec.title.as_ref().map(|t| format!("{t} (đã cắt)"));
    let now = now_ms();

    let st = state(app)?;
    {
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO history (id, created_at, updated_at, capture_mode, media_type, width, height, scale_factor, duration_ms, asset_path, thumb_path, file_size, title, is_edited) \
             VALUES (?1,?2,?3,?4,'video',?5,?6,?7,?8,?9,?10,?11,?12,1)",
            rusqlite::params![
                new_id,
                now,
                now,
                rec.capture_mode,
                rec.width,
                rec.height,
                rec.scale_factor,
                new_duration_ms,
                asset_path_str,
                thumb_path_str,
                file_size,
                new_title,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    get_history_item_sync(app, &new_id)
}

/// "Lưu đè bản gốc" ở Editor — áp cắt trực tiếp vào asset/thumbnail của
/// ĐÚNG record này, KHÔNG tạo record mới (khác `trim_history_video_sync`).
/// Đây là lựa chọn NGƯỜI DÙNG CHỦ Ý (2 lựa chọn Lưu ở Editor, xem
/// `Toolbar.tsx`) nên không giữ bản gốc dự phòng — mất phần đã cắt là hệ quả
/// đã biết trước, khác lựa chọn còn lại "Lưu thành video mới"
/// (`trim_history_video_sync`). Cùng pattern trim→tmp file cùng thư
/// mục→rename đè mà `overwrite_history_video_sync` này thay thế cho
/// `trim_pending_recording` cũ (đã xoá cùng `record-review`/pending-recording).
fn overwrite_history_video_sync(
    app: &AppHandle,
    id: &str,
    keep_ranges_ms: &[(i64, i64)],
    remove_audio: bool,
    overlays: Option<&[crate::record::encoder::VideoOverlay]>,
) -> Result<HistoryRecord, String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type != "video" {
        return Err("Chỉ video mới cắt được".to_string());
    }
    let asset_path = std::path::Path::new(&rec.asset_path);
    let tmp_output = asset_path.with_extension("trimtmp.mp4");
    let progress_app = app.clone();
    crate::record::encoder::trim(asset_path, keep_ranges_ms, &tmp_output, remove_audio, overlays, move |frac| {
        use tauri::Emitter;
        let _ = progress_app.emit("trim-progress", frac);
    })?;
    std::fs::rename(&tmp_output, asset_path).map_err(|e| format!("Không ghi đè được file đã cắt: {e}"))?;

    let new_duration_ms: i64 = keep_ranges_ms.iter().map(|(s, e)| (e - s).max(0)).sum();
    let file_size = std::fs::metadata(asset_path).ok().map(|m| m.len() as i64);
    if let Err(e) = super::video_thumbnail::generate(asset_path, std::path::Path::new(&rec.thumb_path)) {
        eprintln!("[SnapDoc][history] Sinh lại thumbnail sau khi ghi đè thất bại: {e}");
    }

    let st = state(app)?;
    {
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "UPDATE history SET updated_at = ?1, duration_ms = ?2, file_size = ?3, is_edited = 1 WHERE id = ?4",
            rusqlite::params![now_ms(), new_duration_ms, file_size, id],
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
    // `preview.png` — bản ĐÃ ghép annotation, tức đúng cái user thấy. Copy nền
    // sạch ra clipboard sẽ là mất annotation một cách im lặng.
    let bytes = load_asset_preview(&rec)?;
    crate::clipboard::copy_png_bytes(&bytes)
}

/// Ưu tiên bản Save/Save As gần nhất (`exported_path`) nếu còn tồn tại trên
/// đĩa — đúng chỗ user tự chọn lưu, thay vì luôn về file GỐC trong thư mục dữ
/// liệu nội bộ của app (`asset_path`). Fallback về `asset_path` khi chưa từng
/// export (`exported_path` = `None`) HOẶC bản export đã bị xoá/di chuyển khỏi
/// đường dẫn cũ (kiểm tra tồn tại trước, tránh mở nhầm thư mục rồi báo lỗi
/// file không tìm thấy).
fn reveal_history_item_sync(app: &AppHandle, id: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    let target = match &rec.exported_path {
        Some(p) if std::path::Path::new(p).exists() => p.as_str(),
        _ => rec.asset_path.as_str(),
    };
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(|e| format!("Không mở được thư mục chứa file: {e}"))
}

/// Ghi lại đường dẫn bản Save/Save As gần nhất cho 1 item — gọi ngay sau khi
/// user export thành công ra 1 thư mục tuỳ chọn (Editor: `doSaveAs` ảnh),
/// để "Xem file trong Thư mục" (`reveal_history_item_sync`) sau này mở đúng
/// chỗ đó thay vì file gốc nội bộ.
pub(crate) fn set_history_exported_path_sync(app: &AppHandle, id: &str, path: &str) -> Result<HistoryRecord, String> {
    let st = state(app)?;
    {
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "UPDATE history SET exported_path = ?1 WHERE id = ?2",
            rusqlite::params![path, id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_history_item_sync(app, id)
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

/// Trả về bytes ảnh gốc (PNG) của 1 history item dưới dạng raw binary IPC
/// response — xem doc-comment `read_history_asset_bytes_sync`.
#[tauri::command]
pub async fn get_history_asset_bytes(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_history_asset_bytes_sync(&app, &id).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Editor Save: lưu tài liệu vào đúng record, PHI HUỶ — xem
/// `save_history_doc_sync`. KHÔNG tạo record mới.
#[tauri::command]
pub async fn save_history_doc(
    app: AppHandle,
    id: String,
    doc_json: String,
    preview: String,
    base: Option<String>,
) -> Result<HistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_history_doc_sync(&app, &id, &doc_json, &preview, base.as_deref())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Autosave bản nháp. Trả `false` (KHÔNG lỗi) khi container chưa tồn tại hoặc
/// item còn ở định dạng PNG cũ — xem `put_history_draft_sync`.
#[tauri::command]
pub async fn put_history_draft(app: AppHandle, id: String, doc_json: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || put_history_draft_sync(&app, &id, &doc_json))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Bỏ bản nháp → về đúng bản đã Save gần nhất.
#[tauri::command]
pub async fn discard_history_draft(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || discard_history_draft_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Bản ĐÃ GHÉP annotation của một item ảnh (`preview.png`), raw bytes.
///
/// Cửa sổ History không render trực tiếp `asset_path` được nữa: `.snapdoc` là
/// container ZIP nên `<img src={convertFileSrc(assetPath)}>` sẽ hỏng. Trả raw
/// `Response` (không base64/JSON) theo đúng lý do của `get_history_asset_bytes`
/// — ảnh gốc có thể vài chục MB trên màn Retina.
#[tauri::command]
pub async fn get_history_preview_bytes(
    app: AppHandle,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let rec = get_history_item_sync(&app, &id)?;
        if rec.media_type == "video" {
            return Err("Video không có preview ảnh".to_string());
        }
        load_asset_preview(&rec)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Lớp annotation hiệu lực của một item (nháp nếu có, ngược lại bản đã lưu).
#[tauri::command]
pub async fn get_history_doc_json(app: AppHandle, id: String) -> Result<Option<DocLayer>, String> {
    tauri::async_runtime::spawn_blocking(move || get_history_doc_json_sync(&app, &id))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Id các item còn bản nháp chưa lưu — dải "Gần đây" gắn badge sau khi app khởi
/// động lại (phiên trong RAM đã mất nhưng nháp trên đĩa còn).
#[tauri::command]
pub async fn list_items_with_draft(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_items_with_draft_sync(&app))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Cắt 1 video đã lưu trong Library — xem `trim_history_video_sync`.
/// `spawn_blocking` bắt buộc: chạy ffmpeg re-encode + concat, có thể mất vài
/// giây (cùng lý do `commands::stop_recording`).
///
/// Gọi từ Editor (chế độ video, xem `Editor.tsx`) — KHÁC webview với cửa sổ
/// "history" (mỗi cửa sổ Tauri là 1 JS heap/Zustand store riêng), nên thêm
/// item mới xong không thể gọi thẳng `addItem` của store bên "history" được —
/// phải emit event cho cửa sổ đó tự cập nhật, xem listener ở `HistoryWindow.tsx`.
#[tauri::command]
pub async fn trim_history_video(
    app: AppHandle,
    id: String,
    ranges: Vec<(f64, f64)>,
    remove_audio: bool,
    output_path: Option<String>,
    overlays: Option<Vec<crate::record::encoder::VideoOverlay>>,
) -> Result<HistoryRecord, String> {
    let int_ranges: Vec<(i64, i64)> = ranges
        .into_iter()
        .map(|(s, e)| (s.round() as i64, e.round() as i64))
        .collect();
    let app_for_blocking = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        trim_history_video_sync(
            &app_for_blocking,
            &id,
            &int_ranges,
            remove_audio,
            output_path.as_deref(),
            overlays.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;
    use tauri::Emitter;
    let _ = app.emit("history:item-added", &result);
    Ok(result)
}

/// "Lưu đè bản gốc" cho video trong Editor — xem `overwrite_history_video_sync`.
#[tauri::command]
pub async fn overwrite_history_video(
    app: AppHandle,
    id: String,
    ranges: Vec<(f64, f64)>,
    remove_audio: bool,
    overlays: Option<Vec<crate::record::encoder::VideoOverlay>>,
) -> Result<HistoryRecord, String> {
    let int_ranges: Vec<(i64, i64)> = ranges
        .into_iter()
        .map(|(s, e)| (s.round() as i64, e.round() as i64))
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        overwrite_history_video_sync(&app, &id, &int_ranges, remove_audio, overlays.as_deref())
    })
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
pub async fn set_history_exported_path(app: AppHandle, id: String, path: String) -> Result<HistoryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || set_history_exported_path_sync(&app, &id, &path))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Mở cửa sổ History/Library — gọi từ Editor (nút "Xem tất cả").
///
/// Trên Windows, `WebviewWindowBuilder::build()` dispatch một message tới
/// event loop và block chờ kết quả; nếu gọi trực tiếp trên IPC thread (vốn
/// nested trong callback WebMessageReceived của webview Editor đang chạy
/// trên cùng thread với event loop chính) thì sẽ deadlock toàn bộ Win32
/// message pump — mọi cửa sổ treo trắng, app không đóng được. Vì cửa sổ
/// "history" không được pre-warm như "editor"/"thumbnail", build() ở đây
/// luôn chạy live lần đầu tiên nên bắt buộc phải tách sang thread riêng,
/// giống pattern đã dùng cho open_capture_bar_for_new.
#[tauri::command]
pub fn open_history(app: AppHandle) -> Result<(), String> {
    std::thread::spawn(move || {
        let _ = windows::open_history(&app);
    });
    Ok(())
}

/// Hoàn tất Quick Capture (copy/save ảnh đã flatten annotation) + ingest vào
/// history. async + spawn_blocking để không block Tokio event loop trong lúc
/// ghi file/DB.
/// `base_data`: ảnh nền THÔ (chưa ghép annotation) — khi user có vẽ annotation.
/// `doc_json`: annotation JSON (DocPayload) — đi kèm `base_data`.
#[tauri::command]
pub async fn finish_quick_capture(
    app: AppHandle,
    data: String,
    width: u32,
    height: u32,
    output: String,
    base_data: Option<String>,
    doc_json: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::ingest_quick(
            &app,
            &data,
            width,
            height,
            &output,
            base_data.as_deref(),
            doc_json.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Cập nhật thumbnail của một item ảnh từ preview PNG đã ghép annotation.
/// Chỉ ghi file thumbnail — không đụng asset, doc.json, DB hay preview.png.
/// Dùng cho tính năng live-update thumbnail khi user vẽ annotation trong Editor.
///
/// Best-effort: lỗi chỉ log, không báo lại caller vì đây là cập nhật UI phụ
/// (thumbnail hiện sai chỉ mất thẩm mỹ, không mất dữ liệu).
fn update_history_thumb_sync(app: &AppHandle, id: &str, preview_data: &str) -> Result<(), String> {
    let rec = get_history_item_sync(app, id)?;
    if rec.media_type == "video" {
        return Ok(());
    }
    let preview_bytes = decode_image_data(preview_data)?;
    let thumb_bytes = super::thumbnail::generate(&preview_bytes)?;
    std::fs::write(&rec.thumb_path, &thumb_bytes)
        .map_err(|e| format!("Ghi thumbnail thất bại: {e}"))?;
    // Emit để HistoryStrip biết cần reload thumbnail của item này.
    let _ = app.emit("history:thumb-updated", id);
    Ok(())
}

/// Cập nhật thumbnail live khi user vẽ annotation — chỉ ghi file thumbnail,
/// không đụng dữ liệu chính. async + spawn_blocking vì ghi file không được
/// block Tokio event loop.
#[tauri::command]
pub async fn update_history_thumb(
    app: AppHandle,
    id: String,
    preview_data: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = update_history_thumb_sync(&app, &id, &preview_data) {
            eprintln!("[SnapDoc][history] update_history_thumb thất bại (bỏ qua): {e}");
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

fn save_gif_to_history_sync(
    app: &AppHandle,
    source_history_id: Option<&str>,
    gif_path: &str,
    duration_ms: i64,
) -> Result<HistoryRecord, String> {
    let p = std::path::Path::new(gif_path);
    if !p.exists() {
        return Err(format!("File GIF không tồn tại: {gif_path}"));
    }
    let file_size = std::fs::metadata(p).ok().map(|m| m.len() as i64);

    let (capture_mode, scale_factor, title, w, h) = if let Some(id) = source_history_id {
        if let Ok(rec) = get_history_item_sync(app, id) {
            let t = rec.title.as_ref().map(|s| format!("{s} (GIF)"));
            (rec.capture_mode, rec.scale_factor, t, rec.width, rec.height)
        } else {
            ("region".to_string(), 1.0, None, 800, 600)
        }
    } else {
        ("region".to_string(), 1.0, None, 800, 600)
    };

    let new_id = uuid::Uuid::new_v4().to_string();
    let thumb_path = super::assets::thumb_path_for(app, &new_id)?;
    if let Err(e) = super::video_thumbnail::generate(p, &thumb_path) {
        eprintln!("[SnapDoc][history] Sinh thumbnail cho GIF thất bại: {e}");
    }

    let asset_path_str = p.to_string_lossy().to_string();
    let thumb_path_str = thumb_path.to_string_lossy().to_string();
    let now = now_ms();

    let st = state(app)?;
    {
        let conn = st.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO history (id, created_at, updated_at, capture_mode, media_type, width, height, scale_factor, duration_ms, asset_path, thumb_path, file_size, title, is_edited) \
             VALUES (?1,?2,?3,?4,'gif',?5,?6,?7,?8,?9,?10,?11,?12,1)",
            rusqlite::params![
                new_id,
                now,
                now,
                capture_mode,
                w,
                h,
                scale_factor,
                duration_ms,
                asset_path_str,
                thumb_path_str,
                file_size,
                title,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    get_history_item_sync(app, &new_id)
}

/// Lưu bản ghi ảnh GIF vào thư viện History.
#[tauri::command]
pub async fn save_gif_to_history(
    app: AppHandle,
    source_history_id: Option<String>,
    gif_path: String,
    duration_ms: i64,
) -> Result<HistoryRecord, String> {
    let app_for_blocking = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        save_gif_to_history_sync(&app_for_blocking, source_history_id.as_deref(), &gif_path, duration_ms)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;
    use tauri::Emitter;
    let _ = app.emit("history:item-added", &result);
    Ok(result)
}

