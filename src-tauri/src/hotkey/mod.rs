use crate::{flow, windows};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const BAR: &str = "CmdOrCtrl+Shift+5";
pub const FULL: &str = "CmdOrCtrl+Shift+1";
pub const REGION: &str = "CmdOrCtrl+Shift+2";
pub const WINDOW: &str = "CmdOrCtrl+Shift+3";
pub const COPY: &str = "CmdOrCtrl+Shift+C";

/// Đăng ký toàn bộ phím tắt toàn cục. Trả lỗi nếu bị xung đột.
pub fn register_all(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    for s in [BAR, FULL, REGION, WINDOW, COPY] {
        gs.register(s)
            .map_err(|e| format!("Đăng ký phím tắt '{s}' thất bại (có thể bị app khác chiếm): {e}"))?;
    }
    Ok(())
}

/// Điều phối khi một phím tắt được nhấn.
pub fn handle(app: &AppHandle, fired: &Shortcut) {
    let mappings = [
        (BAR, "bar"),
        (FULL, "full"),
        (REGION, "region"),
        (WINDOW, "window"),
        (COPY, "copy"),
    ];

    for (combo, action) in mappings {
        let parsed: Result<Shortcut, _> = combo.parse();
        if let Ok(parsed) = parsed {
            if &parsed == fired {
                run_action(app, action);
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
        "copy" => spawn(app, "full", "clipboard"),
        _ => spawn(app, "full", "editor"),
    }
}

fn spawn(app: &AppHandle, mode: &str, output: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    let output = output.to_string();
    std::thread::spawn(move || flow::run(&app, &mode, &output));
}
