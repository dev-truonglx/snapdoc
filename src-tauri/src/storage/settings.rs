use serde_json::{json, Value};
use std::path::PathBuf;

fn settings_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("settings.json")
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
        "shortcuts": {
            "captureBar": "CmdOrCtrl+Shift+5",
            "full": "CmdOrCtrl+Shift+1",
            "region": "CmdOrCtrl+Shift+2",
            "window": "CmdOrCtrl+Shift+3",
            "all": "CmdOrCtrl+Shift+4",
            "captureCopy": "CmdOrCtrl+Shift+C",
            "scroll": "CmdOrCtrl+Shift+6"
        }
    })
}

pub fn load(config_dir: &PathBuf) -> Value {
    let path = settings_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| defaults()),
        Err(_) => defaults(),
    }
}

pub fn save(config_dir: &PathBuf, value: &Value) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).ok();
    let path = settings_path(config_dir);
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("Lỗi serialize: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("Lỗi ghi settings: {e}"))?;
    Ok(())
}
