use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

fn settings_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("settings.json")
}

/// Cache RAM của settings.json — các hot path (MỖI lần nhấn hotkey qua
/// `hotkey::handle`, rebuild tray menu, bắt đầu quay/chụp...) đều gọi
/// `load()`; đọc + parse file đồng bộ từ đĩa mỗi lần là I/O thừa. Mọi thao
/// tác GHI đều đi qua `save()` của chính module này nên invalidate tại đó là
/// đủ; sửa file bằng tay từ ngoài khi app đang chạy không được hỗ trợ (cần
/// restart). Key theo path để test (mỗi test 1 thư mục riêng) không dẫm nhau.
static CACHE: OnceLock<Mutex<Option<(PathBuf, Value)>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<(PathBuf, Value)>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Giá trị mặc định khi chưa có file settings.
fn defaults() -> Value {
    json!({
        "saveDir": "",
        "format": "png",
        "defaultOutput": "editor",
        "openEditorAfterCapture": true,
        "timerSeconds": 0,
        "rememberLastRegion": false,
        "launchAtLogin": true,
        "recordAudioSource": "off",
        "recordSelf": false,
        "recordShowKeystrokes": false,
        "language": "vi",
        "shortcuts": {
            "captureBar": "CmdOrCtrl+Shift+5",
            "full": "CmdOrCtrl+Shift+1",
            "region": "CmdOrCtrl+Shift+2",
            "window": "CmdOrCtrl+Shift+3",
            "all": "CmdOrCtrl+Shift+4",
            "captureCopy": "CmdOrCtrl+Shift+C",
            "scroll": "CmdOrCtrl+Shift+6",
            "record": "CmdOrCtrl+Shift+7"
        }
    })
}

/// File settings.json đã từng được lưu chưa — dùng để phát hiện "lần đầu
/// chạy sau khi cài" (xem `lib.rs`). KHÔNG dùng key trong giá trị trả về từ
/// `load()` để kiểm tra: `load()` tự fallback về `defaults()` khi file chưa
/// tồn tại, mà `defaults()` đã có sẵn mọi key (kể cả `launchAtLogin`) — kiểm
/// tra key sẽ luôn đúng dù file thật sự chưa từng được ghi.
pub fn exists(config_dir: &PathBuf) -> bool {
    settings_path(config_dir).exists()
}

pub fn load(config_dir: &PathBuf) -> Value {
    let path = settings_path(config_dir);
    if let Ok(guard) = cache().lock() {
        if let Some((cached_path, value)) = guard.as_ref() {
            if cached_path == &path {
                return value.clone();
            }
        }
    }
    let value = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| defaults()),
        Err(_) => defaults(),
    };
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((path, value.clone()));
    }
    value
}

pub fn save(config_dir: &PathBuf, value: &Value) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).ok();
    let path = settings_path(config_dir);
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("Lỗi serialize: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("Lỗi ghi settings: {e}"))?;
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((path, value.clone()));
    }
    Ok(())
}

pub fn is_record_self(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    load(&config_dir)
        .get("recordSelf")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Xác nhận đúng bug đã sửa ở `lib.rs`: kiểm tra key trong `load()` LUÔN
    /// đúng (vì fallback về `defaults()` đã có sẵn key) dù file chưa từng
    /// được ghi — phải dùng `exists()` (kiểm tra file thật) mới phân biệt
    /// được "lần đầu chạy" với "đã từng lưu".
    #[test]
    fn exists_reflects_actual_file_presence_not_defaults() {
        let dir = std::env::temp_dir().join(format!("snapdoc-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!exists(&dir), "chưa từng save() thì exists() phải là false");
        let loaded = load(&dir);
        assert!(loaded.get("launchAtLogin").is_some(), "load() fallback vẫn có key này");
        assert!(!exists(&dir), "load() không được tự tạo file trên đĩa");

        save(&dir, &loaded).unwrap();
        assert!(exists(&dir), "sau save() phải thấy file thật trên đĩa");

        std::fs::remove_dir_all(&dir).ok();
    }
}
