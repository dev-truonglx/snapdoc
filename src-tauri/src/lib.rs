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
mod update;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .manage(update::PendingUpdate::default())
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
            commands::open_capture_bar_for_new,
            commands::open_editor,
            commands::open_settings,
            commands::close_self,
            commands::hide_thumbnail,
            commands::open_file_dialog,
            commands::default_save_dir,
            commands::get_settings,
            commands::set_settings,
            commands::check_screen_permission,
            commands::request_screen_permission,
            commands::capture_all_screens,
            commands::reload_shortcuts,
            commands::suspend_shortcuts,
            commands::resume_shortcuts,
            commands::get_last_capture_mode,
            commands::check_update,
            commands::get_pending_update,
            commands::install_update,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            if let Err(e) = hotkey::register_all(&handle) {
                eprintln!("[SnapDoc] {e}");
            }

            // Pre-warm editor (ẩn) → lần chụp đầu hiển thị tức thì.
            let _ = windows::prewarm_editor(&handle);
            // Pre-warm thumbnail (ẩn) → hiển thị tức thì sau khi chụp.
            let _ = windows::prewarm_thumbnail(&handle);

            // macOS: app sống ở menu bar, ẩn khỏi Dock lúc khởi động.
            // Khi editor mở sẽ chuyển sang Regular (xem windows::open_editor).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Startup: kiểm tra update im lặng sau 3s (không chặn khởi động).
            // Khi có update → tray icon đổi + cửa sổ update mở.
            let app_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let result = update::check_update(app_handle.clone(), false).await;
                if let Ok(info) = result {
                    if info.available {
                        tray::set_update_badge(&app_handle);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|_window, _event| {
            // macOS: khi editor bị đóng hoàn toàn, trả về Accessory policy
            // (ẩn Dock icon) nếu không còn cửa sổ "thật" nào khác đang mở.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::Destroyed = _event {
                use tauri::Manager;
                let label = _window.label();
                if label == "editor" || label == "settings" {
                    windows::on_editor_closed(_window.app_handle());
                }
            }
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
