mod capture;
mod clipboard;
mod commands;
mod flow;
mod hotkey;
mod input;
mod permissions;
mod state;
mod storage;
mod tray;
mod windows;

use state::AppState;
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        hotkey::handle(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::peek_pending,
            commands::take_pending,
            commands::capture_now,
            commands::finalize_region,
            commands::finalize_window,
            commands::finalize_monitor,
            commands::list_windows,
            commands::cancel_overlay,
            commands::copy_image,
            commands::save_image,
            commands::save_and_copy,
            commands::open_capture_bar,
            commands::open_editor,
            commands::open_settings,
            commands::close_self,
            commands::default_save_dir,
            commands::get_settings,
            commands::set_settings,
            commands::check_screen_permission,
            commands::request_screen_permission,
            commands::capture_all_screens,
            commands::reload_shortcuts,
        ])
        .setup(|app| {
            let handle = app.handle();
            tray::build(handle)?;
            if let Err(e) = hotkey::register_all(handle) {
                eprintln!("[SnapDoc] {e}");
            }

            // Pre-warm editor (ẩn) → lần chụp đầu hiển thị tức thì.
            let _ = windows::prewarm_editor(handle);

            // macOS: app sống ở menu bar, ẩn khỏi Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Lỗi khởi tạo SnapDoc")
        .run(|_app, event| {
            // Giữ app chạy nền (tray) khi đóng hết cửa sổ.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
