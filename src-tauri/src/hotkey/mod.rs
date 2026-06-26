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
/// Trả về empty string nếu user đã xóa phím tắt (không fall back về default).
/// Chỉ dùng default khi key CHƯA TỒN TẠI trong settings (chưa bao giờ set).
pub fn shortcuts_from_settings(app: &AppHandle) -> Vec<(String, String)> {
    let dir = app.path().app_config_dir().unwrap_or_default();
    let val = storage::settings::load(&dir);
    let shortcuts = val.get("shortcuts");

    // Trả về Some("") nếu key tồn tại nhưng rỗng (user đã xóa),
    // None nếu key chưa tồn tại (dùng default).
    let get = |key: &str, default: &str| -> String {
        match shortcuts.and_then(|s| s.get(key)).and_then(|v| v.as_str()) {
            Some(v) => v.to_string(), // kể cả empty string — user đã xóa
            None => default.to_string(), // key chưa có → dùng default
        }
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
/// Bỏ qua các combo rỗng (user đã xóa phím tắt đó).
pub fn register_all(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    for (action, combo) in shortcuts_from_settings(app) {
        if combo.is_empty() {
            continue; // user đã xóa shortcut này
        }
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
        "captureCopy" => spawn(app, "full", "clipboard"),
        _ => {
            // Lấy defaultOutput từ settings để áp dụng cho mọi phím tắt chụp.
            let output = default_output(app);
            match action {
                "region" => spawn(app, "region", &output),
                "window" => spawn(app, "window", &output),
                "all" => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        flow::capture_all_screens(&app, &output).ok();
                    });
                }
                _ => spawn(app, "full", &output), // "full"
            }
        }
    }
}

/// Đọc defaultOutput từ settings. Trả về "editor" nếu không đọc được.
pub fn default_output(app: &AppHandle) -> String {
    let dir = app.path().app_config_dir().unwrap_or_default();
    let val = storage::settings::load(&dir);
    val.get("defaultOutput")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("editor")
        .to_string()
}

fn spawn(app: &AppHandle, mode: &str, output: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    let output = output.to_string();
    std::thread::spawn(move || flow::run(&app, &mode, &output));
}
