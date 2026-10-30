// Self-update flow built on tauri-plugin-updater. Fetch/install logic lives in
// Rust; the UI lives in the webview. `check_update` returns structured data
// (no native dialogs).
//
// Startup behavior: silently check → download in background, no popup.
// macOS: also installs right away (the .app bundle is replaced in place, the
// running process is untouched) — the new version applies on the next launch.
// Windows: installing exits the process immediately, so the downloaded update
// waits until the user picks "Restart to update" (tray / Settings), see
// `restart_to_apply`. Manual update via Settings is preserved.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Caches the most recently fetched update so `install_pending` can install it
/// without re-checking. The plugin's `Update` is not `Serialize`, so it can't be
/// handed to the frontend directly — only the `UpdateInfo` summary is.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// Persists across the session: true once a silent background install succeeds.
/// Settings queries this on mount so it shows the restart banner even if the
/// window was opened after the event was emitted.
pub static UPDATE_READY: AtomicBool = AtomicBool::new(false);

/// Windows: bản cập nhật đã TẢI xong nhưng CHƯA cài. `Update::install` trên
/// Windows chạy installer rồi `std::process::exit(0)` NGAY — cài ngầm vài giây
/// sau khi mở app là đóng sập app giữa lúc user đang chỉnh ảnh (mất việc chưa
/// lưu). Giữ lại tới khi user chủ động "Khởi động lại để cập nhật".
#[cfg(target_os = "windows")]
static DOWNLOADED: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);

/// Update summary sent to the frontend.
#[derive(Serialize, Clone, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub current_version: String,
}

/// Check for an update and return the outcome.
///
/// When an update is available it is cached in `PendingUpdate`.
/// `manual = true` (called from Settings): returns info to UI so user can install manually.
/// `manual = false` (startup): caller handles silent download+install — no popup shown.
/// Errors are returned to the caller; on the silent path they are just logged.
pub async fn check_update(app: AppHandle, manual: bool) -> Result<UpdateInfo, String> {
    let _ = manual; // kept for API compatibility with commands.rs
    match fetch(&app).await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                available: true,
                version: update.version.clone(),
                current_version: update.current_version.clone(),
            };
            *app.state::<PendingUpdate>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
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
                log::info!("[SnapDoc][update] chưa có release nào được publish (404)");
                return Ok(UpdateInfo {
                    available: false,
                    version: String::new(),
                    current_version: app.package_info().version.to_string(),
                });
            }
            log::warn!("[SnapDoc][update] check failed: {e}");
            Err(msg)
        }
    }
}

/// Silently download (and, except on Windows, install) the update in the
/// background WITHOUT restarting. macOS: the new version applies on the next
/// launch. Windows: it is installed by `restart_to_apply`.
/// Called automatically on startup when an update is found.
/// Chỉ được gọi trong `lib.rs` bên trong `#[cfg(not(debug_assertions))]` — nên
/// `cargo check` (debug profile) báo "never used" dù hàm này CÓ dùng thật ở
/// release build.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub async fn silent_download_and_install(app: AppHandle) -> Result<(), String> {
    // Take the update out of state so the lock isn't held across .await.
    let update = app.state::<PendingUpdate>().0.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(update) = update else {
        return Err("No update is pending.".to_string());
    };
    let version = update.version.clone();
    log::info!("[SnapDoc][update] silent download+install started for v{version}");
    let bytes = update
        .download(
            |_chunk, _total| {},
            || { log::info!("[SnapDoc][update] download finished, installing…"); },
        )
        .await
        .map_err(|e| {
            log::warn!("[SnapDoc][update] silent download failed: {e}");
            e.to_string()
        })?;
    // Windows: KHÔNG cài ở đây (cài = thoát app ngay) — chờ user bấm
    // "Khởi động lại để cập nhật", xem `restart_to_apply`.
    #[cfg(target_os = "windows")]
    {
        *DOWNLOADED.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
        log::info!("[SnapDoc][update] v{version} downloaded — waiting for the user to restart");
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Thay bundle giữa lúc đang quay vẫn rủi ro (ffmpeg sidecar nằm trong
        // bundle) — chờ phiên quay (nếu có) kết thúc hẳn rồi mới cài.
        while crate::record::is_busy(&app) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        update.install(bytes).map_err(|e| {
                log::warn!("[SnapDoc][update] silent install failed: {e}");
                e.to_string()
            })?;
        log::info!("[SnapDoc][update] silent install complete — new version will apply on next launch");
    }

    // Đánh dấu trạng thái toàn cục để Settings có thể query bất cứ lúc nào.
    UPDATE_READY.store(true, Ordering::Relaxed);

    // Thông báo cho tray và frontend: update đã sẵn sàng, cần restart để áp dụng.
    crate::tray::set_restart_badge(&app);
    use tauri::Emitter;
    let _ = app.emit("update-ready-to-relaunch", &version);

    Ok(())
}

async fn fetch(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    // Windows: installer thoát app bằng `std::process::exit(0)` — không qua
    // `ExitRequested`/`Exit` của Tauri. Hook này là cơ hội cuối để chốt bản
    // quay đang chạy/đang lưu dở (no-op nếu không quay).
    let handle = app.clone();
    app.updater_builder()
        .on_before_exit(move || crate::record::finalize_on_exit(&handle))
        .build()?
        .check()
        .await
}

/// Summary of the currently cached pending update, if any. Lets the update
/// window render immediately on load without relying on the event timing.
pub fn pending_info(app: &AppHandle) -> Option<UpdateInfo> {
    app.state::<PendingUpdate>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|u| UpdateInfo {
            available: true,
            version: u.version.clone(),
            current_version: u.current_version.clone(),
        })
}

/// "Khởi động lại để cập nhật" (tray / Settings): chốt bản quay đang chạy, rồi
/// - Windows: cài bản đã tải ngầm — installer thoát app và tự mở lại bản mới;
/// - nơi khác (hoặc chưa có bản tải sẵn): bản mới đã nằm sẵn trên đĩa, chỉ
///   cần khởi động lại.
pub fn restart_to_apply(app: &AppHandle) {
    crate::record::finalize_on_exit(app);
    #[cfg(target_os = "windows")]
    {
        let downloaded = DOWNLOADED.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((update, bytes)) = downloaded {
            // Thành công thì process đã thoát bên trong `install`; tới được
            // dòng dưới nghĩa là cài lỗi → vẫn khởi động lại như thường.
            if let Err(e) = update.install(bytes) {
                log::warn!("[SnapDoc][update] deferred install failed: {e}");
            }
        }
    }
    app.restart();
}

/// Download + install the cached pending update, then relaunch.
/// Used by the manual install flow in Settings. Errors bubble up to the webview.
pub async fn install_pending(app: AppHandle) -> Result<(), String> {
    // Take the update out of state first so the lock isn't held across `.await`.
    let update = app.state::<PendingUpdate>().0.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(update) = update else {
        return Err("No update is pending.".to_string());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| {
            log::warn!("[SnapDoc][update] install failed: {e}");
            e.to_string()
        })?;
    // Nếu đang quay, dừng sạch trước khi relaunch — xem `record::finalize_on_exit`.
    crate::record::finalize_on_exit(&app);
    app.restart();
}
