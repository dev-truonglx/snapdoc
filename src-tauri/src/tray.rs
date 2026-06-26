use crate::{flow, windows};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

/// Tạo tray icon với menu thao tác nhanh.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

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
                    let output = crate::hotkey::default_output(&app);
                    flow::capture_all_screens(&app, &output).ok();
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

/// Xây dựng menu mới từ shortcuts hiện tại trong settings.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let shortcuts = crate::hotkey::shortcuts_from_settings(app);
    // Chỉ hiển thị accelerator nếu combo không rỗng
    let sc = |action: &str| -> Option<String> {
        shortcuts
            .iter()
            .find(|(a, _)| a == action)
            .and_then(|(_, c)| if c.is_empty() { None } else { Some(c.clone()) })
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

    Menu::with_items(app, &[&all, &full, &region, &window, &sep1, &bar, &settings, &sep2, &quit])
}

/// Rebuild tray menu với shortcuts mới nhất — gọi sau `reload_shortcuts`.
/// Accelerator text trong menu sẽ phản ánh đúng shortcuts hiện tại,
/// kể cả khi user đã xóa một phím tắt (sẽ không còn accelerator đó).
pub fn rebuild_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Đổi tooltip tray để báo có update.
pub fn set_update_badge(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some("SnapDoc — 🆕 Có bản cập nhật mới!"));
        // TODO: khi có tray-update.png, bỏ comment để đổi icon:
        // const BADGE: &[u8] = include_bytes!("../icons/tray-update.png");
        // if let Ok(icon) = Image::from_bytes(BADGE) {
        //     let _ = tray.set_icon(Some(icon));
        //     let _ = tray.set_icon_as_template(false);
        // }
    }
}

fn dispatch(app: &AppHandle, mode: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    std::thread::spawn(move || {
        let output = crate::hotkey::default_output(&app);
        flow::run(&app, &mode, &output);
    });
}
