mod capture;
mod clipboard;
mod commands;
mod flow;
mod history;
mod hotkey;
mod input;
mod permissions;
mod record;
mod state;
mod storage;
mod tray;
mod update;
mod windows;

use state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_global_shortcut::ShortcutState;

/// True khi process này được khởi chạy qua "Open with" (Windows argv có ảnh).
/// Instance đó là editor tạm: không tray, không chạy nền — đóng cửa sổ là thoát.
static OPEN_WITH_MODE: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            eprintln!("[SnapDoc] Single instance launched with argv: {:?}", argv);
            let open_with_path: Option<String> = argv.get(1).and_then(|path| {
                let ext = std::path::Path::new(path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif") {
                    Some(path.clone())
                } else {
                    None
                }
            });

            if let Some(path) = open_with_path {
                let h = app.clone();
                std::thread::spawn(move || {
                    let _ = commands::open_file_path_sync(&h, path);
                });
            } else {
                let _ = windows::open_capture_bar(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
        .manage(record::RecordingState::default())
        .manage(record::PendingRecordingState::default())
        .invoke_handler(tauri::generate_handler![
            commands::peek_pending,
            commands::take_pending,
            commands::set_pending_image,
            commands::capture_now,
            commands::cancel_capture_countdown,
            commands::start_quick,
            commands::capture_quick_region,
            commands::finalize_region,
            commands::finalize_window,
            commands::finalize_monitor,
            commands::list_windows,
            commands::cancel_overlay,
            commands::keep_capture_focus,
            commands::copy_image,
            commands::save_image,
            commands::save_and_copy,
            commands::open_capture_bar,
            commands::open_capture_bar_for_new,
            windows::resize_capture_bar,
            commands::open_editor,
            commands::open_settings,
            commands::close_self,
            commands::hide_thumbnail,
            commands::open_file_dialog,
            commands::open_files_dialog,
            commands::open_file_path,
            commands::take_open_file,
            commands::default_save_dir,
            commands::get_settings,
            commands::set_settings,
            commands::check_screen_permission,
            commands::request_screen_permission,
            commands::capture_all_screens,
            commands::reload_shortcuts,
            commands::suspend_shortcuts,
            commands::resume_shortcuts,
            commands::get_hotkey_warning,
            commands::get_autostart,
            commands::set_autostart,
            commands::check_update,
            commands::get_pending_update,
            commands::get_update_ready,
            commands::install_update,
            commands::restart_app,
            commands::capture_scroll_slice,
            commands::finalize_scroll_capture,
            commands::start_scroll_session,
            commands::finalize_scroll_stitch,
            commands::start_recording,
            commands::get_frozen_screen,
            commands::notify_overlay_ready,
            commands::start_record_picker,
            commands::confirm_region_record_start,
            commands::peek_pending_recording,
            commands::confirm_recording_save,
            commands::confirm_recording_discard,
            commands::redo_recording,
            commands::stop_recording,
            commands::recording_status,
            commands::trim_pending_recording,
            record::filmstrip::generate_video_frames,
            history::commands::list_history,
            history::commands::get_history_item,
            history::commands::delete_history_item,
            history::commands::restore_history_item,
            history::commands::permanently_delete_history_item,
            history::commands::empty_trash,
            history::commands::rename_history_item,
            history::commands::open_history_item_in_editor,
            history::commands::get_history_asset_bytes,
            history::commands::update_history_asset,
            history::commands::trim_history_video,
            history::commands::copy_history_item,
            history::commands::reveal_history_item,
            history::commands::open_history,
            history::commands::open_history_trim,
            history::commands::close_history_trim,
            history::commands::finish_quick_capture,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Windows: phát hiện khởi chạy qua "Open with" (argv[1] là ảnh).
            // macOS dùng RunEvent::Opened trên instance đang chạy → không qua đây.
            #[cfg(target_os = "windows")]
            let open_with_path: Option<String> = {
                let args: Vec<String> = std::env::args().collect();
                args.get(1).and_then(|path| {
                    let ext = std::path::Path::new(path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif") {
                        Some(path.clone())
                    } else {
                        None
                    }
                })
            };
            #[cfg(not(target_os = "windows"))]
            let open_with_path: Option<String> = None;

            // Instance "Open with": chỉ mở editor với ảnh — KHÔNG tray, KHÔNG
            // hotkey/prewarm/autostart/update. Đóng cửa sổ editor là thoát hẳn
            // (xem ExitRequested kiểm tra OPEN_WITH_MODE).
            if open_with_path.is_some() {
                OPEN_WITH_MODE.store(true, Ordering::SeqCst);

                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Regular);

                #[cfg(target_os = "windows")]
                if let Some(path) = open_with_path {
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        let _ = commands::open_file_path_sync(&h, path);
                    });
                }
                return Ok(());
            }

            // History DB — trước tray/hotkey vì global shortcut có thể trigger
            // capture ngay sau đó (ingest cần HistoryState đã sẵn sàng).
            // Lỗi init KHÔNG chặn khởi động app — chỉ tắt tính năng Library
            // (mọi command History sẽ trả lỗi rõ ràng qua `try_state`).
            match history::assets::db_path(&handle).and_then(|p| history::db::open(&p)) {
                Ok(conn) => {
                    use tauri::Manager;
                    let ingest_tx = history::spawn_ingest_worker(handle.clone());
                    app.manage(history::db::HistoryState::new(conn, ingest_tx));
                }
                Err(e) => {
                    eprintln!("[SnapDoc][history] init thất bại, tính năng Library sẽ tắt: {e}");
                }
            }

            // Tự động dọn Trash quá hạn 30 ngày — thread riêng, không chặn
            // khởi động, cùng convention với cleanup_stale_temp bên dưới. Xem
            // STABILITY_RISKS.md mục B.5/E.7: trước đây Trash chỉ được dọn
            // khi user tự bấm "Dọn thùng rác", library/assets+thumbs lớn dần
            // vô hạn.
            {
                let h = handle.clone();
                std::thread::spawn(move || match history::commands::purge_old_trash(&h) {
                    Ok(n) if n > 0 => {
                        eprintln!("[SnapDoc][history] Đã tự xoá {n} mục trong Trash quá hạn 30 ngày")
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[SnapDoc][history] Tự dọn Trash quá hạn thất bại: {e}"),
                });
            }

            // Mở scope asset-protocol cho thư mục lưu video hiện tại — nếu
            // không, `convertFileSrc` trong record-review/History sẽ bị chặn
            // đọc video đã quay ở phiên trước (scope tĩnh trong tauri.conf.json
            // chỉ cho phép $APPDATA/SnapDoc/library, không phải saveDir).
            record::allow_asset_scope_at_startup(&handle);

            // Dọn rác tạm phiên trước (crash/quit giữa lúc quay/trim) — thread
            // riêng, không chặn khởi động.
            {
                let h = handle.clone();
                std::thread::spawn(move || record::cleanup_stale_temp(&h));
            }

            tray::build(&handle)?;
            if let Err(e) = hotkey::register_all(&handle) {
                eprintln!("[SnapDoc] {e}");
                use tauri::Manager;
                if let Ok(mut g) = handle.state::<AppState>().hotkey_warning.lock() {
                    *g = Some(e);
                }
            }

            // Pre-warm editor (ẩn) → lần chụp đầu hiển thị tức thì.
            let _ = windows::prewarm_editor(&handle);
            // Pre-warm thumbnail (ẩn) → hiển thị tức thì sau khi chụp.
            let _ = windows::prewarm_thumbnail(&handle);
            // Pre-warm thanh "Dừng quay" (ẩn) → lần bắt đầu quay vùng chọn đầu
            // tiên hiện tức thì, không chờ tải webview mới.
            let _ = windows::prewarm_stop_control(&handle);

            // Pre-warm overlay (ẩn, 1 cửa sổ/màn hình) → lần chụp đầu trên máy
            // nhiều màn hình không phải chờ build() tuần tự N cửa sổ webview
            // (nguồn trễ chính khiến overlay không hiện "tức thì" — xem
            // `windows::prewarm_overlays`). Chạy nền, không chặn khởi động vì
            // `xcap::Monitor::all()` + build() N cửa sổ có thể mất vài chục ms.
            {
                let h = handle.clone();
                std::thread::spawn(move || windows::prewarm_overlays(&h));
            }

            // Pre-warm capture-bar (ẩn) NGAY khi app khởi động — giữ icon Dock
            // (macOS)/Taskbar (Windows) hiện diện xuyên suốt vòng đời app kể
            // từ lúc mở app, không còn im lặng ở tray như trước.
            let _ = windows::prewarm_capture_bar(&handle);

            // Lần đầu chạy sau khi cài: tự động bật "khởi động cùng hệ thống".
            // Phát hiện "lần đầu" bằng việc FILE settings.json đã tồn tại
            // trên đĩa hay chưa (`storage::settings::exists`) — KHÔNG dùng
            // key trong giá trị `load()` trả về như bản cũ: `load()` fallback
            // về `defaults()` khi file chưa tồn tại, mà `defaults()` đã có
            // sẵn key "launchAtLogin" → điều kiện cũ luôn đúng, block này
            // không bao giờ chạy, nên Settings hiện "ON" nhưng LaunchAgent
            // chưa từng được đăng ký thật — chỉ có tác dụng sau khi user tự
            // tắt/bật lại (gọi `set_autostart`, xem `commands.rs`). Sau lần
            // đầu này, user có thể tắt từ Settings bất cứ lúc nào.
            // Đồng bộ lại trạng thái autostart thật của OS với `launchAtLogin`
            // trong settings.json ở MỌI lần khởi động (không chỉ lần đầu).
            // Windows có thể tự xoá registry Run key đã đăng ký (SmartScreen/
            // Defender gắn cờ app chưa ký số, hoặc bug đã biết của
            // tauri-plugin-autostart — xem
            // github.com/tauri-apps/plugins-workspace/issues/771) khiến
            // settings.json vẫn ghi "true" nhưng OS thật ra KHÔNG còn tự khởi
            // động app — Settings UI hiện "ON" nhưng thực tế sai. Gọi lại
            // enable()/disable() mỗi lần app chạy để tự "chữa lành" trạng thái
            // lệch này thay vì chỉ tin vào lần bật/tắt gần nhất của user.
            {
                use tauri::Manager;
                use tauri_plugin_autostart::ManagerExt;
                let config_dir = handle.path().app_config_dir().unwrap_or_default();
                let first_run = !storage::settings::exists(&config_dir);
                let mut settings = storage::settings::load(&config_dir);
                if first_run {
                    settings["launchAtLogin"] = serde_json::Value::Bool(true);
                    let _ = storage::settings::save(&config_dir, &settings);
                }
                let want_enabled = settings["launchAtLogin"].as_bool().unwrap_or(true);
                let autolaunch = handle.autolaunch();
                let is_enabled = autolaunch.is_enabled().unwrap_or(!want_enabled);
                if want_enabled && !is_enabled {
                    let _ = autolaunch.enable();
                } else if !want_enabled && is_enabled {
                    let _ = autolaunch.disable();
                }
            }

            // Startup: kiểm tra update im lặng sau 3s (không chặn khởi động).
            // Khi có update → tự động tải về và cài đặt ở nền, KHÔNG hiện popup.
            // Phiên bản mới sẽ được áp dụng khi app khởi động lại lần tiếp theo.
            //
            // CHỈ chạy ở release build (`#[cfg(not(debug_assertions))]`) — build
            // debug (`npm run dev:mac`/`tauri build --debug`) LUÔN có
            // `debug_assertions` bật, bất kể target/`--debug` flag. Thiếu guard
            // này từng khiến 1 phiên dev-test tự âm thầm ghi đè .app đang chạy
            // bằng bản release mới hơn tải từ update server (v0.2.9) NGAY GIỮA
            // lúc test — biến mất mọi fix cục bộ chưa release, và có thể là
            // nguyên nhân trực tiếp của lỗi "chọn vùng xong không quay" (file
            // trong bundle bị ghi đè khi process đang chạy).
            #[cfg(not(debug_assertions))]
            {
                let app_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let result = update::check_update(app_handle.clone(), false).await;
                    if let Ok(info) = result {
                        if info.available {
                            tray::set_update_badge(&app_handle);
                            // Tự động tải và cài — không restart, không hiện cửa sổ.
                            if let Err(e) = update::silent_download_and_install(app_handle.clone()).await {
                                eprintln!("[SnapDoc][update] background install failed: {e}");
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|_window, _event| {
            if let tauri::WindowEvent::Focused(focused) = _event {
                if !*focused && _window.label() == "capture-bar" {
                    use tauri::Emitter;
                    let _ = _window.emit("hide-popover", ());
                }
            }
            // "record-review" giờ có titlebar thật (nút đóng, xem
            // `open_record_review`) nhưng KHÔNG được phép đóng "trắng" —
            // buộc người dùng phải quyết định Lưu/Xoá bản quay (dữ liệu quan
            // trọng, không tự phục hồi được). Chặn close mặc định, coi như
            // bấm "Xoá": để RecordReview.tsx tự chạy lại xác nhận + dọn dẹp
            // (`confirmRecordingDiscard`) rồi mới đóng thật.
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                if _window.label() == "record-review" {
                    api.prevent_close();
                    use tauri::Emitter;
                    let _ = _window.emit("record-review-close-requested", ());
                }
            }
            // macOS: khi cửa sổ "thật" bị đóng (editor, settings, capture-bar,
            // record-review, history-trim), trả về Accessory policy (ẩn Dock
            // icon). Windows: khi cửa sổ "thật" bị đóng, ẩn icon trên taskbar.
            if let tauri::WindowEvent::Destroyed = _event {
                use tauri::Manager;
                let label = _window.label();
                // Settings đóng ngay GIỮA lúc đang ghi phím tắt mới:
                // `suspendShortcuts()` (unregister-all) đã chạy nhưng webview
                // bị huỷ trước khi `resumeShortcuts()` kịp gọi → toàn bộ
                // hotkey toàn cục chết cho tới khi restart app. Reload từ
                // settings ở đây là idempotent (unregister-all + register-all)
                // và rẻ nên chạy vô điều kiện mỗi lần đóng Settings.
                if label == "settings" {
                    if let Err(e) = hotkey::reload(_window.app_handle()) {
                        eprintln!("[SnapDoc][hotkey] reload sau khi đóng Settings thất bại: {e}");
                    }
                }
                // "editor" (capture) lẫn "editor-ow-N" ("Open with") + "settings"
                // + "capture-bar" + "record-review" + "history-trim" = cửa sổ
                // thật → khi đóng, cân nhắc trả về Accessory policy (macOS)
                // hoặc ẩn taskbar icon (Windows).
                if label.starts_with("editor") || label == "settings" || label == "capture-bar" || label == "history" || label == "record-review" || label == "history-trim" {
                    windows::on_editor_closed(_window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Lỗi khởi tạo SnapDoc")
        .run(|_app, event| {
            match event {
                // Giữ app chạy nền (tray) khi đóng hết cửa sổ — TRỪ instance
                // "Open with": đóng cửa sổ editor là thoát hẳn process đó.
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if code.is_none() && !OPEN_WITH_MODE.load(Ordering::SeqCst) {
                        api.prevent_exit();
                    }
                }
                // macOS: click dock icon / Spotlight search khi app đang chạy.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    // Đã có cửa sổ nào đó (editor/history/record-review/capture-bar...)
                    // đang visible → macOS tự đưa nó lên trước, không mở thêm capture bar.
                    // Chỉ mở capture bar khi app đang "im lặng" hoàn toàn trong tray.
                    if !has_visible_windows {
                        let _ = windows::open_capture_bar(_app);
                    }
                }
                // macOS: nhận file từ "Open with" / Finder / kéo vào Dock icon.
                // Tauri v2 expose qua RunEvent::Opened (tao: application:openURLs:).
                // Xử lý được cả cold-start (Apple Event đến ngay sau launch)
                // lẫn runtime (app đang chạy, user chọn "Open with" lần nữa).
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    eprintln!("[SnapDoc] RunEvent::Opened nhận {} url", urls.len());
                    // Mở MỌI ảnh được chọn (mỗi ảnh một cửa sổ editor riêng),
                    // không chỉ ảnh đầu tiên — hỗ trợ chọn nhiều file → Open with.
                    for url in &urls {
                        if url.scheme() == "file" {
                            if let Ok(path) = url.to_file_path() {
                                let path_str = path.to_string_lossy().to_string();
                                let ext = path
                                    .extension()
                                    .and_then(|e| e.to_str())
                                    .unwrap_or("")
                                    .to_lowercase();
                                if matches!(
                                    ext.as_str(),
                                    "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif"
                                ) {
                                    let _ = commands::open_file_path_sync(_app, path_str);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}
