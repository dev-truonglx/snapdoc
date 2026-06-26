// Self-update flow built on tauri-plugin-updater. Fetch/install logic lives in
// Rust; the UI lives in the webview. `check_update` returns structured data
// (no native dialogs), and the silent startup check emits an event + shows the
// "update" window so the user is notified even when Settings isn't open.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Caches the most recently fetched update so `install_pending` can install it
/// without re-checking. The plugin's `Update` is not `Serialize`, so it can't be
/// handed to the frontend directly — only the `UpdateInfo` summary is.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// Update summary sent to the frontend.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub current_version: String,
}

/// Check for an update and return the outcome.
///
/// When an update is available it is cached in `PendingUpdate`. `manual = false`
/// (startup check) additionally emits `update-available` and shows the update
/// window, so a new build is surfaced even with no Settings window open. Errors
/// are returned to the caller; on the silent path they are just logged.
pub async fn check_update(app: AppHandle, manual: bool) -> Result<UpdateInfo, String> {
    match fetch(&app).await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                available: true,
                version: update.version.clone(),
                current_version: update.current_version.clone(),
            };
            *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update);
            if !manual {
                notify_update_window(&app, &info);
            }
            Ok(info)
        }
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: String::new(),
            current_version: app.package_info().version.to_string(),
        }),
        Err(e) => {
            let msg = e.to_string();
            // 404 = chưa có release nào — không phải lỗi thật, trả về "no update"
            // thay vì throw để frontend không hiện error dialog.
            if msg.contains("404")
                || msg.contains("status code 404")
                || msg.contains("No releases found")
            {
                log::info!("[UPDATE] no releases published yet (404)");
                return Ok(UpdateInfo {
                    available: false,
                    version: String::new(),
                    current_version: app.package_info().version.to_string(),
                });
            }
            log::warn!("[UPDATE] check failed: {e}");
            Err(msg)
        }
    }
}

async fn fetch(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater()?.check().await
}

/// Summary of the currently cached pending update, if any. Lets the update
/// window render immediately on load without relying on the event timing.
pub fn pending_info(app: &AppHandle) -> Option<UpdateInfo> {
    app.state::<PendingUpdate>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|u| UpdateInfo {
            available: true,
            version: u.version.clone(),
            current_version: u.current_version.clone(),
        })
}

/// Download + install the cached pending update, then relaunch. No native
/// dialogs: errors bubble up to the webview as a `String`.
pub async fn install_pending(app: AppHandle) -> Result<(), String> {
    // Take the update out of state first so the lock isn't held across `.await`.
    let update = app.state::<PendingUpdate>().0.lock().unwrap().take();
    let Some(update) = update else {
        return Err("No update is pending.".to_string());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| {
            log::error!("[UPDATE] install failed: {e}");
            e.to_string()
        })?;
    app.restart();
}

/// Show the update window and push the latest info to it.
/// Creates the window if it doesn't exist yet (startup check path),
/// or re-shows and re-emits if already open (rare).
fn notify_update_window(app: &AppHandle, info: &UpdateInfo) {
    // Tạo/show cửa sổ trước
    let _ = crate::windows::open_update_window(app);

    // Emit event sau 300ms để frontend kịp mount và đăng ký listener.
    let app = app.clone();
    let info = info.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Some(win) = app.get_webview_window("update") {
            let _ = win.emit("update-available", info);
        }
    });
}
