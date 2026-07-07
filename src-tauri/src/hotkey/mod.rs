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
pub const DEFAULT_SCROLL: &str = "CmdOrCtrl+Shift+6";
pub const DEFAULT_QUICK: &str = "CmdOrCtrl+Shift+Q";
pub const DEFAULT_RECORD: &str = "CmdOrCtrl+Shift+7";

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
        ("scroll".into(),      get("scroll",      DEFAULT_SCROLL)),
        ("quick".into(),       get("quick",       DEFAULT_QUICK)),
        ("record".into(),      get("record",      DEFAULT_RECORD)),
    ]
}

/// Đăng ký tất cả phím tắt từ settings lúc khởi động.
/// Bỏ qua các combo rỗng (user đã xóa phím tắt đó).
///
/// Thử đăng ký HẾT mọi phím tắt thay vì dừng ở combo lỗi đầu tiên (như trước
/// đây `?` sẽ return ngay giữa vòng lặp) — 1 combo bị OS/app khác chiếm không
/// còn kéo theo mọi phím tắt SAU nó trong danh sách bị bỏ lỡ luôn. Trả về lỗi
/// gộp nếu có combo nào thất bại, để gọi nơi báo cho user (xem `lib.rs` setup
/// lưu vào `AppState.hotkey_warning` cho Settings hiển thị).
pub fn register_all(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut errors = Vec::new();
    for (action, combo) in shortcuts_from_settings(app) {
        if combo.is_empty() {
            continue; // user đã xóa shortcut này
        }
        if let Err(e) = gs.register(combo.as_str()) {
            errors.push(format!("'{combo}' ({action}): {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Một số phím tắt không đăng ký được (có thể đã bị hệ điều hành/app khác chiếm): {}",
            errors.join("; ")
        ))
    }
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
        "quick" => {
            let app = app.clone();
            std::thread::spawn(move || flow::start_quick(&app));
        }
        "record" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if crate::record::status(&app).is_some() {
                    if let Err(e) = crate::record::stop_recording(&app) {
                        eprintln!("[SnapDoc] Dừng quay (phím tắt) thất bại: {e}");
                    }
                    return;
                }
                // Nhiều màn hình: mở overlay chọn quay màn hình nào (đúng
                // hành vi mode "full" của nút "Quay" trong CaptureBar, xem
                // `flow::run_record_picker`) — 1 màn hình thì quay thẳng
                // luôn, không có gì để chọn nên bỏ qua overlay cho nhanh.
                let monitor_count = xcap::Monitor::all().map(|m| m.len()).unwrap_or(1);
                if monitor_count > 1 {
                    flow::run_record_picker(&app, "full");
                } else if let Err(e) = crate::record::start_recording(&app) {
                    eprintln!("[SnapDoc] Bắt đầu quay (phím tắt) thất bại: {e}");
                }
            });
        }
        _ => {
            // Lấy defaultOutput từ settings để áp dụng cho mọi phím tắt chụp.
            let output = default_output(app);
            match action {
                "region" => spawn(app, "region", &output),
                "window" => spawn(app, "window", &output),
                "scroll" => spawn(app, "scroll", &output),
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
