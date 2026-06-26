use crate::{flow, storage, windows};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

// Phím tắt mặc định — dùng khi settings chưa có giá trị.
pub const DEFAULT_BAR: &str = "CmdOrCtrl+Shift+5";
pub const DEFAULT_FULL: &str = "CmdOrCtrl+Shift+1";
pub const DEFAULT_REGION: &str = "CmdOrCtrl+Shift+2";
pub const DEFAULT_WINDOW: &str = "CmdOrCtrl+Shift+3";
pub const DEFAULT_ALL: &str = "CmdOrCtrl+Shift+4";
pub const DEFAULT_COPY: &str = "CmdOrCtrl+Shift+C";

/// Lấy map (action → combo) từ settings.
/// Nếu một key thiếu thì dùng giá trị mặc định.
pub fn shortcuts_from_settings(app: &AppHandle) -> Vec<(String, String)> {
    let dir = app.path().app_config_dir().unwrap_or_default();
    let val = storage::settings::load(&dir);
    let shortcuts = val.get("shortcuts");

    let get = |key: &str, default: &str| -> String {
        shortcuts
            .and_then(|s| s.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(default)
            .to_string()
    };

    vec![
        ("bar".into(),         get("captureBar",  DEFAULT_BAR)),
        ("full".into(),        get("full",        DEFAULT_FULL)),
        ("region".into(),      get("region",      DEFAULT_REGION)),
        ("window".into(),      get("window",      DEFAULT_WINDOW)),
        ("all".into(),         get("all",         DEFAULT_ALL)),
        ("captureCopy".into(), get("captureCopy", DEFAULT_COPY)),
    ]
}

/// Đăng ký tất cả phím tắt từ settings lúc khởi động.
pub fn register_all(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    for (action, combo) in shortcuts_from_settings(app) {
        gs.register(combo.as_str()).map_err(|e| {
            format!("Đăng ký phím tắt '{combo}' ({action}) thất bại: {e}")
        })?;
    }
    Ok(())
}

/// Huỷ tất cả phím tắt hiện tại, rồi đăng ký lại từ settings.
/// Gọi sau khi người dùng lưu cài đặt mới.
pub fn reload(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all()
        .map_err(|e| format!("Huỷ phím tắt thất bại: {e}"))?;
    register_all(app)
}

/// Điều phối khi một phím tắt được nhấn.
pub fn handle(app: &AppHandle, fired: &Shortcut) {
    for (action, combo) in shortcuts_from_settings(app) {
        if let Ok(parsed) = combo.parse::<Shortcut>() {
            if &parsed == fired {
                run_action(app, &action);
                return;
            }
        }
    }
}

fn run_action(app: &AppHandle, action: &str) {
    match action {
        "bar" => {
            let _ = windows::open_capture_bar(app);
        }
        "region" => spawn(app, "region", "editor"),
        "window" => spawn(app, "window", "editor"),
        "all" => {
            let app = app.clone();
            std::thread::spawn(move || {
                flow::capture_all_screens(&app, "editor").ok();
            });
        }
        "captureCopy" => spawn(app, "full", "clipboard"),
        _ => spawn(app, "full", "editor"), // "full"
    }
}

fn spawn(app: &AppHandle, mode: &str, output: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    let output = output.to_string();
    std::thread::spawn(move || flow::run(&app, &mode, &output));
}
