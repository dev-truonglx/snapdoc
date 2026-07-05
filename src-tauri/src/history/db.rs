use std::path::Path;
use std::sync::Mutex;

/// Version schema hiện tại — tăng lên + thêm nhánh trong `migrate()` khi cần
/// thay đổi schema (không dùng crate migration ngoài, tự quản lý qua
/// `PRAGMA user_version`).
pub const CURRENT_VERSION: i32 = 1;

/// State quản lý bởi Tauri — chỉ `.manage()` khi `open()` thành công. Nếu
/// History DB không khởi tạo được (đĩa lỗi, quyền ghi...), state này KHÔNG
/// được manage → mọi command History trả lỗi rõ ràng qua `app.try_state()`
/// thay vì panic ở `app.state::<HistoryState>()`.
pub struct HistoryState {
    pub conn: Mutex<rusqlite::Connection>,
}

impl HistoryState {
    pub fn new(conn: rusqlite::Connection) -> Self {
        Self { conn: Mutex::new(conn) }
    }
}

/// Mở (tạo nếu chưa có) history.db, bật WAL + foreign_keys, chạy migration.
pub fn open(db_path: &Path) -> Result<rusqlite::Connection, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Không tạo được thư mục history: {e}"))?;
    }
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("Không mở được history.db: {e}"))?;
    // WAL: cho phép đọc (History window) đồng thời với ghi (ingest lúc capture).
    // Lưu ý: WAL có thể không ổn định trên thư mục đồng bộ cloud (OneDrive/iCloud
    // Drive) — nếu app_data_dir nằm trong đó, cân nhắc fallback DELETE mode.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Không bật WAL: {e}"))?;
    // NORMAL (thay vì mặc định FULL) bỏ bớt fsync không cần thiết khi đã có
    // WAL — tổ hợp chuẩn được SQLite khuyến nghị: an toàn khi app crash, chỉ
    // rủi ro mất đúng transaction cuối nếu mất điện/OS crash — chấp nhận được
    // cho một cache/thư viện ảnh local, đổi lại insert/update nhanh hơn đáng kể.
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Không đặt synchronous=NORMAL: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("Không bật foreign_keys: {e}"))?;
    migrate(&conn)?;
    Ok(conn)
}

fn user_version(conn: &rusqlite::Connection) -> Result<i32, String> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("Không đọc được user_version: {e}"))
}

/// Chạy tuần tự các migration còn thiếu, mỗi bước trong 1 transaction riêng —
/// nếu app crash giữa chừng, lần khởi động sau sẽ tiếp tục đúng từ version dở.
fn migrate(conn: &rusqlite::Connection) -> Result<(), String> {
    let mut version = user_version(conn)?;
    while version < CURRENT_VERSION {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Không mở transaction migrate: {e}"))?;
        match version {
            0 => migrate_v1(&tx)?,
            _ => return Err(format!("Không có migration cho version {version}")),
        }
        version += 1;
        tx.pragma_update(None, "user_version", version)
            .map_err(|e| format!("Không ghi user_version: {e}"))?;
        tx.commit().map_err(|e| format!("Commit migration thất bại: {e}"))?;
    }
    Ok(())
}

/// Schema v1 — cột `media_type`/`duration_ms` để trống/NULL ở v1 (chỉ ảnh
/// tĩnh) nhưng đã có sẵn để v2 (video/GIF) không cần migration phá vỡ.
fn migrate_v1(tx: &rusqlite::Transaction) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TABLE history (
            id            TEXT PRIMARY KEY,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL,
            capture_mode  TEXT NOT NULL,
            media_type    TEXT NOT NULL DEFAULT 'image',
            width         INTEGER NOT NULL,
            height        INTEGER NOT NULL,
            scale_factor  REAL NOT NULL DEFAULT 1.0,
            duration_ms   INTEGER,
            asset_path    TEXT NOT NULL,
            thumb_path    TEXT NOT NULL,
            file_size     INTEGER,
            source_app    TEXT,
            title         TEXT,
            is_edited     INTEGER NOT NULL DEFAULT 0,
            deleted_at    INTEGER
         );
         CREATE INDEX idx_history_created_at ON history(created_at DESC);
         CREATE INDEX idx_history_deleted_at ON history(deleted_at);
         CREATE INDEX idx_history_mode ON history(capture_mode);",
    )
    .map_err(|e| format!("Migration v1 thất bại: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_creates_schema_and_reaches_current_version() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), CURRENT_VERSION);

        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('history')")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["id", "created_at", "capture_mode", "media_type", "duration_ms", "deleted_at", "is_edited"] {
            assert!(cols.contains(&expected.to_string()), "missing column: {expected}");
        }
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // chạy lần 2 không được lỗi / không vượt CURRENT_VERSION
        assert_eq!(user_version(&conn).unwrap(), CURRENT_VERSION);
    }

    #[test]
    fn insert_and_soft_delete_roundtrip() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO history (id, created_at, updated_at, capture_mode, width, height, scale_factor, asset_path, thumb_path) VALUES ('a',1,1,'region',10,10,1.0,'/a.png','/a.jpg')",
            [],
        ).unwrap();

        let active: i64 = conn.query_row("SELECT COUNT(*) FROM history WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(active, 1);

        conn.execute("UPDATE history SET deleted_at = 123 WHERE id = 'a'", []).unwrap();
        let active: i64 = conn.query_row("SELECT COUNT(*) FROM history WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
        let trashed: i64 = conn.query_row("SELECT COUNT(*) FROM history WHERE deleted_at IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(active, 0);
        assert_eq!(trashed, 1);

        conn.execute("UPDATE history SET deleted_at = NULL WHERE id = 'a'", []).unwrap();
        let active: i64 = conn.query_row("SELECT COUNT(*) FROM history WHERE deleted_at IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(active, 1);
    }
}
