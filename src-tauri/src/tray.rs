use crate::{flow, windows};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle,
};

/// Tạo tray icon với menu thao tác nhanh.
/// Accelerator trong menu chỉ mang tính hiển thị — phím tắt thực sự
/// được quản lý bởi `hotkey::register_all` và có thể đổi trong Settings.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // Đọc shortcuts hiện tại để hiển thị đúng trong menu.
    let shortcuts = crate::hotkey::shortcuts_from_settings(app);
    let sc = |action: &str| -> Option<String> {
        shortcuts.iter().find(|(a, _)| a == action).map(|(_, c)| c.clone())
    };

    let all    = MenuItem::with_id(app, "all",    "Chụp tất cả màn hình", true, sc("all").as_deref())?;
    let full   = MenuItem::with_id(app, "full",   "Chụp toàn màn hình",   true, sc("full").as_deref())?;
    let region = MenuItem::with_id(app, "region", "Chụp vùng chọn",       true, sc("region").as_deref())?;
    let window = MenuItem::with_id(app, "window", "Chụp cửa sổ",          true, sc("window").as_deref())?;
    let bar    = MenuItem::with_id(app, "bar",    "Mở thanh chụp…",       true, sc("bar").as_deref())?;
    let settings = MenuItem::with_id(app, "settings", "Cài đặt…",         true, None::<&str>)?;
    let quit   = MenuItem::with_id(app, "quit",   "Thoát SnapDoc",         true, None::<&str>)?;
    let sep1   = PredefinedMenuItem::separator(app)?;
    let sep2   = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&all, &full, &region, &window, &sep1, &bar, &settings, &sep2, &quit],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .tooltip("SnapDoc")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "all" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    flow::capture_all_screens(&app, "editor").ok();
                });
            }
            "full"   => dispatch(app, "full"),
            "region" => dispatch(app, "region"),
            "window" => dispatch(app, "window"),
            "bar" => {
                let _ = windows::open_capture_bar(app);
            }
            "settings" => {
                let _ = windows::open_settings(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn dispatch(app: &AppHandle, mode: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    std::thread::spawn(move || flow::run(&app, &mode, "editor"));
}
