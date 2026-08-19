pub mod assets;
pub mod commands;
pub mod db;
pub mod model;
pub mod thumbnail;
pub mod video_thumbnail;

use crate::capture;
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use db::HistoryState;
use model::HistoryRecord;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 1 job ghi asset+thumbnail nền cho `ingest()`. Gửi qua channel tới
/// `spawn_ingest_worker` thay vì `std::thread::spawn` mỗi lần chụp — tránh
/// tạo hàng chục thread cùng lúc khi user spam phím tắt chụp liên tục (tất cả
/// đều phải tranh cùng 1 Mutex<Connection> nên spawn nhiều thread không giúp
/// nhanh hơn, chỉ tốn RAM/context-switch).
pub struct IngestJob {
    id: String,
    asset_path: PathBuf,
    thumb_path: PathBuf,
    base64: String,
    /// doc.json kèm theo (nếu có annotation) — ghi vào container thay vì EMPTY_DOC_JSON.
    doc_json: Option<String>,
    /// Preview đã ghép annotation (nếu có) — dùng cho thumbnail. None → dùng base64.
    preview_base64: Option<String>,
}

/// Spawn DUY NHẤT 1 worker thread xử lý tuần tự mọi job ghi nền — gọi 1 lần
/// lúc khởi động app (cạnh `HistoryState::new`). Worker tự thoát khi mọi
/// `Sender` bị drop (app thoát).
pub fn spawn_ingest_worker(app: AppHandle) -> std::sync::mpsc::Sender<IngestJob> {
    let (tx, rx) = std::sync::mpsc::channel::<IngestJob>();
    std::thread::spawn(move || {
        for job in rx {
            ingest_finish_bg(
                &app,
                job.id,
                job.asset_path,
                job.thumb_path,
                &job.base64,
                job.doc_json.as_deref(),
                job.preview_base64.as_deref(),
            );
        }
    });
    tx
}

/// `now_ms` cho các module ngoài `history` (vd `commands::save_snapdoc_file`
/// ghi `updatedAt` vào manifest) — cùng một mốc thời gian, khỏi định nghĩa lại.
pub(crate) fn now_ms_pub() -> i64 {
    now_ms()
}

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

/// `doc.json` cho ảnh chưa có annotation nào. Phải khớp shape mà frontend đọc
/// (`sessions.ts`/`Editor.tsx`) — `payloadV` tách khỏi `formatVersion` của
/// container để thêm loại annotation mới không cần bump định dạng file.
pub(crate) const EMPTY_DOC_JSON: &str =
    r#"{"payloadV":1,"kind":"image","annotations":[],"stepCounter":1,"arrowCounter":1}"#;

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
        exported_path: None,
    };

    // Đẩy việc ghi file nặng (I/O) qua worker cố định thay vì spawn thread mới
    if let Ok(tx) = state.ingest_tx.lock() {
        let _ = tx.send(IngestJob {
            id,
            asset_path,
            thumb_path,
            base64: cap.base64.clone(),
            doc_json: None,
            preview_base64: None,
        });
    }

    // KHÔNG emit "history:item-added" ở đây — thumbnail còn chưa được ghi
    // (chạy nền ở `ingest_finish_bg`), cửa sổ History có thể race và hiện
    // "Không tải được ảnh" vĩnh viễn. Emit sau khi thumbnail đã tồn tại.
    Ok(record)
}

/// Như `ingest` nhưng ghi kèm `doc_json` (annotation) và `preview_data`
/// (ảnh đã ghép, dùng cho thumbnail). Dùng cho Quick Capture copy/save khi
/// có annotation — giữ nền sạch trong asset, annotation trong doc.json.
pub fn ingest_with_doc(
    app: &AppHandle,
    cap: &capture::Capture,
    mode: &str,
    scale_factor: f64,
    doc_json: &str,
    preview_data: Option<&str>,
) -> Result<HistoryRecord, String> {
    let state = app
        .try_state::<HistoryState>()
        .ok_or_else(|| "History chưa sẵn sàng".to_string())?;
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
        exported_path: None,
    };

    if let Ok(tx) = state.ingest_tx.lock() {
        let _ = tx.send(IngestJob {
            id,
            asset_path,
            thumb_path,
            base64: cap.base64.clone(),
            doc_json: Some(doc_json.to_string()),
            preview_base64: preview_data.map(|s| s.to_string()),
        });
    }

    Ok(record)
}

/// Pha 2 của `ingest`: ghi asset + thumbnail (chạy nền), rồi cập nhật
/// `file_size`. Lỗi → soft-delete record thay vì để row mồ côi.
fn ingest_finish_bg(app: &AppHandle, id: String, asset_path: PathBuf, thumb_path: PathBuf, base64: &str, doc_json: Option<&str>, preview_base64: Option<&str>) {
    let write_result = (|| -> Result<i64, String> {
        let bytes = decode_image_data(base64)?;
        let effective_doc = doc_json.unwrap_or(EMPTY_DOC_JSON);
        // Preview cho thumbnail: ưu tiên bản đã ghép annotation nếu có,
        // ngược lại dùng chính ảnh nền (không có annotation).
        let preview_bytes = match preview_base64 {
            Some(p) => decode_image_data(p)?,
            None    => bytes.clone(),
        };
        let now = now_ms();
        crate::snapdoc_file::write_snapdoc(
            &asset_path,
            crate::snapdoc_file::WriteSnapdoc {
                base_png: &bytes,
                doc_json: effective_doc,
                draft_json: None,
                preview_png: &preview_bytes,
                created_at: now,
                updated_at: now,
            },
        )?;
        let thumb_bytes = thumbnail::generate(&preview_bytes)?;
        std::fs::write(&thumb_path, &thumb_bytes).map_err(|e| format!("Ghi thumbnail thất bại: {e}"))?;
        std::fs::metadata(&asset_path)
            .map(|m| m.len() as i64)
            .map_err(|e| format!("Không đọc được kích thước asset: {e}"))
    })();

    let Some(state) = app.try_state::<HistoryState>() else { return };
    match write_result {
        Ok(file_size) => {
            if let Ok(conn) = state.conn.lock() {
                let _ = conn.execute(
                    "UPDATE history SET file_size = ?1 WHERE id = ?2",
                    rusqlite::params![file_size, id],
                );
                // Asset + thumbnail đã ghi xong trên đĩa — an toàn để cửa sổ
                // History load ảnh ngay, xem giải thích ở `ingest()`.
                if let Ok(record) = conn.query_row(
                    "SELECT * FROM history WHERE id = ?1",
                    [&id],
                    HistoryRecord::from_row,
                ) {
                    use tauri::Emitter;
                    let _ = app.emit("history:item-added", &record);
                }
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

/// Ghi 1 phiên QUAY MÀN HÌNH đã hoàn tất vào Library — gọi từ
/// `record::stop_recording` SAU khi ffmpeg mux xong. Khác `ingest()` (ảnh):
///
/// - mp4 đã tồn tại sẵn trên đĩa (tại `saveDir`/Pictures — do
///   `record::new_output_path` quyết định) nên KHÔNG copy/move vào
///   `library/assets` như ảnh — `asset_path` trỏ THẲNG tới file đó. Video có
///   thể nặng hàng chục/hàng trăm MB, nhân đôi không đáng (khác ảnh PNG vài
///   trăm KB). Hệ quả: xoá vĩnh viễn record video trong History = xoá luôn
///   file gốc — đúng kỳ vọng người dùng vì chỉ có 1 bản duy nhất.
/// - Không chia 2 pha nền như ảnh: mp4 đã ghi xong hoàn toàn khi hàm này được
///   gọi, không cần decode base64/ghi file lớn ở đây. Việc còn lại (trích
///   frame làm thumbnail) chạy đồng bộ nhưng nhẹ (ffmpeg trích 1 frame vốn
///   rất nhanh, không đáng tách thread nền).
/// - Lỗi sinh thumbnail KHÔNG làm hỏng cả record — chỉ log, record vẫn được
///   lưu (thumbnail trống sẽ hiện fallback "Không tải được ảnh" ở UI, không
///   soft-delete như ảnh vì video vẫn hoàn toàn xem/phát được).
///
/// KHÔNG BAO GIỜ được gọi bằng `?` từ `record::stop_recording` — lỗi ở đây
/// chỉ nên log, không được làm mất đường dẫn mp4 đã trả về cho caller.
pub fn ingest_video(
    app: &AppHandle,
    mp4_path: &Path,
    width: u32,
    height: u32,
    duration_ms: i64,
    capture_mode: &str,
) -> Result<HistoryRecord, String> {
    let state = app
        .try_state::<HistoryState>()
        .ok_or_else(|| "History chưa sẵn sàng (DB init thất bại lúc khởi động)".to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let thumb_path = assets::thumb_path_for(app, &id)?;
    let asset_path_str = mp4_path.to_string_lossy().to_string();
    let thumb_path_str = thumb_path.to_string_lossy().to_string();
    let file_size = std::fs::metadata(mp4_path).ok().map(|m| m.len() as i64);

    if let Err(e) = video_thumbnail::generate(mp4_path, &thumb_path) {
        eprintln!("[SnapDoc][history] Sinh thumbnail video thất bại (record vẫn được lưu): {e}");
    }

    {
        let conn = state.conn.lock().map_err(|_| "History DB lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO history (id, created_at, updated_at, capture_mode, media_type, width, height, scale_factor, duration_ms, asset_path, thumb_path, file_size) VALUES (?1,?2,?3,?4,'video',?5,?6,1.0,?7,?8,?9,?10)",
            rusqlite::params![id, now, now, capture_mode, width, height, duration_ms, asset_path_str, thumb_path_str, file_size],
        )
        .map_err(|e| format!("Insert history thất bại: {e}"))?;
    }

    let record = HistoryRecord {
        id,
        created_at: now,
        updated_at: now,
        capture_mode: capture_mode.to_string(),
        media_type: "video".to_string(),
        width,
        height,
        scale_factor: 1.0,
        duration_ms: Some(duration_ms),
        asset_path: asset_path_str,
        thumb_path: thumb_path_str,
        file_size,
        source_app: None,
        title: None,
        is_edited: false,
        deleted_at: None,
        exported_path: None,
    };

    // Xem giải thích ở `ingest()` — cùng cơ chế báo cho cửa sổ History cập nhật ngay.
    {
        use tauri::Emitter;
        let _ = app.emit("history:item-added", &record);
    }

    Ok(record)
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

/// Ghi output "clipboard"/"save"/"save_copy" cho Quick Capture, rồi ingest
/// vào history với mode="quick".
///
/// - `data`: ảnh đã ghép annotation (flattened) — dùng cho clipboard/file/thumbnail.
/// - `base_data`: ảnh nền THÔ (chưa ghép annotation) — nếu có, ingest nền sạch
///   vào asset + lưu `doc_json` vào container để user mở lại còn sửa annotation.
///   `None` thì ingest `data` (flattened) như cũ.
/// - `doc_json`: annotation JSON (DocPayload) — chỉ dùng khi `base_data` có.
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
    base_data: Option<&str>,
    doc_json: Option<&str>,
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

    // Có ảnh nền riêng → ingest nền sạch, lưu doc_json + preview (đã ghép)
    // vào container để user mở lại sửa annotation được.
    // Không có → ingest ảnh flattened như cũ (backward compat).
    let base_str = base_data.unwrap_or(data);
    let effective_doc = doc_json.unwrap_or(EMPTY_DOC_JSON);
    let preview_str = if base_data.is_some() { Some(data) } else { None };

    let cap = capture::Capture {
        base64: strip_data_url_prefix(base_str).to_string(),
        width,
        height,
    };
    match ingest_with_doc(app, &cap, "quick", 1.0, effective_doc, preview_str) {
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
        // Fallback 2 lớp: `picture_dir()` có thể lỗi (sandbox/máy lạ) — bản
        // cũ `unwrap_or_default()` ra chuỗi RỖNG, path thành "/Screenshot_…"
        // ghi thẳng vào root filesystem. Lùi về app_data_dir thay vì root.
        app.path()
            .picture_dir()
            .map(|p| p.join("SnapDoc"))
            .or_else(|_| app.path().app_data_dir().map(|p| p.join("SnapDoc")))
            .map_err(|e| format!("Không tìm thấy thư mục lưu: {e}"))?
            .to_string_lossy()
            .to_string()
    } else {
        dir
    };
    let path = std::path::Path::new(&dir)
        .join(format!("{}.png", crate::flow::stamp_filename("Screenshot")));
    crate::storage::save::write_png(&path.to_string_lossy(), data)?;
    Ok(())
}
