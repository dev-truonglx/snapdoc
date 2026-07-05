/// Một bản ghi trong Library — trả về nguyên vẹn qua IPC cho React (camelCase
/// qua `serde(rename_all = "camelCase")` để khớp field TS `HistoryItem`).
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub capture_mode: String,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub duration_ms: Option<i64>,
    /// Đường dẫn TUYỆT ĐỐI (không phải path tương đối lưu trong DB) — để
    /// frontend dùng thẳng `convertFileSrc()` mà không cần round-trip thêm.
    pub asset_path: String,
    pub thumb_path: String,
    pub file_size: Option<i64>,
    pub source_app: Option<String>,
    pub title: Option<String>,
    pub is_edited: bool,
    pub deleted_at: Option<i64>,
}

impl HistoryRecord {
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            capture_mode: row.get("capture_mode")?,
            media_type: row.get("media_type")?,
            width: row.get("width")?,
            height: row.get("height")?,
            scale_factor: row.get("scale_factor")?,
            duration_ms: row.get("duration_ms")?,
            asset_path: row.get("asset_path")?,
            thumb_path: row.get("thumb_path")?,
            file_size: row.get("file_size")?,
            source_app: row.get("source_app")?,
            title: row.get("title")?,
            is_edited: row.get::<_, i64>("is_edited")? != 0,
            deleted_at: row.get("deleted_at")?,
        })
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub capture_mode: Option<String>,
    pub search: Option<String>,
    #[serde(default)]
    pub trash_only: bool,
    pub limit: i64,
    pub offset: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<HistoryRecord>,
    pub total: i64,
}
