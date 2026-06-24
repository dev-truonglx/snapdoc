use crate::{flow, windows};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle,
};

/// Tạo tray icon (Windows) / menu bar (macOS) với menu thao tác nhanh.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let full = MenuItem::with_id(app, "full", "Chụp toàn màn hình", true, Some("CmdOrCtrl+Shift+1"))?;
    let region = MenuItem::with_id(app, "region", "Chụp vùng chọn", true, Some("CmdOrCtrl+Shift+2"))?;
    let window = MenuItem::with_id(app, "window", "Chụp cửa sổ", true, Some("CmdOrCtrl+Shift+3"))?;
    let bar = MenuItem::with_id(app, "bar", "Mở thanh chụp…", true, Some("CmdOrCtrl+Shift+5"))?;
    let settings = MenuItem::with_id(app, "settings", "Cài đặt…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Thoát SnapDoc", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&full, &region, &window, &sep1, &bar, &settings, &sep2, &quit],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .tooltip("SnapDoc")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "full" => dispatch(app, "full"),
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
