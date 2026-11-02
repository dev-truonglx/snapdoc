// Self-update flow built on tauri-plugin-updater. Fetch/install logic lives in
// Rust; the UI lives in the webview. `check_update` returns structured data
// (no native dialogs).
//
// Startup behavior: silently check → download in background, no popup.
// Both macOS and Windows keep the downloaded payload in memory (`DOWNLOADED`)
// without modifying the running binary/bundle on disk:
// - macOS: replacing `/Applications/SnapDoc.app` while the old process is still
//   alive unlinks the running executable's vnode, causing `tccd` to fail with
//   `Failed to fetch responsible file descriptor: [2: No such file or directory]`
//   and mismatching in-memory CDHash vs on-disk staticCode. Instead, we install
//   only when the user clicks "Restart to update" (or when the app exits).
// - Windows: installing exits the process immediately, so the downloaded update
//   waits until the user picks "Restart to update" (tray / Settings), see
//   `restart_to_apply`. Manual update via Settings is preserved.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Caches the most recently fetched update so `install_pending` can install it
/// without re-checking. The plugin's `Update` is not `Serialize`, so it can't be
/// handed to the frontend directly — only the `UpdateInfo` summary is.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// Persists across the session: true once a silent background download succeeds.
/// Settings queries this on mount so it shows the restart banner even if the
/// window was opened after the event was emitted.
pub static UPDATE_READY: AtomicBool = AtomicBool::new(false);

/// Bản cập nhật đã TẢI xong nhưng CHƯA ghi đè lên đĩa:
/// - Windows: `Update::install` chạy installer rồi `std::process::exit(0)` NGAY.
/// - macOS: `Update::install` xóa (unlink) `.app` đang chạy để thay bằng `.app`
///   mới; nếu thay ngay dưới nền khi app cũ còn sống, `tccd` mất responsible
///   file descriptor (`ENOENT`) và lệch chữ ký giữa tiến trình trên RAM với
///   bundle trên đĩa. Giữ lại tới khi user bấm "Khởi động lại để cập nhật"
///   (hoặc cài lúc thoát app trong `install_downloaded_on_exit`).
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
            let _ = app.emit("update-available", &info);
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

/// Silently download the update in the background WITHOUT replacing the running
/// binary on disk. Both macOS and Windows apply the downloaded payload in
/// `restart_to_apply` (or `install_downloaded_on_exit` when the user quits on macOS).
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
    log::info!("[SnapDoc][update] silent download started for v{version}");
    let bytes = update
        .download(
            |_chunk, _total| {},
            || { log::info!("[SnapDoc][update] download finished, ready to apply on restart."); },
        )
        .await
        .map_err(|e| {
            log::warn!("[SnapDoc][update] silent download failed: {e}");
            e.to_string()
        })?;

    // Giữ bản tải trong bộ nhớ thay vì ghi đè `.app` ngay khi app cũ còn chạy:
    // - Windows: `install` thoát app ngay lập tức.
    // - macOS: `install` xóa (unlink) `.app` đang chạy trên đĩa, làm `tccd` báo
    //   `Failed to fetch responsible file descriptor: [2: No such file or directory]`
    //   và lệch `staticCode` cho tới khi restart.
    *DOWNLOADED.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
    log::info!("[SnapDoc][update] v{version} downloaded — waiting for the user to restart");

    // Đánh dấu trạng thái toàn cục để Settings có thể query bất cứ lúc nào.
    UPDATE_READY.store(true, Ordering::Relaxed);

    // Thông báo cho tray và frontend: update đã sẵn sàng, cần restart để áp dụng.
    crate::tray::set_restart_badge(&app);
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
    if let Some(u) = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return Some(UpdateInfo {
            available: true,
            version: u.version.clone(),
            current_version: u.current_version.clone(),
        });
    }
    DOWNLOADED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|(u, _)| UpdateInfo {
            available: true,
            version: u.version.clone(),
            current_version: u.current_version.clone(),
        })
}

/// Tìm đường dẫn `.app` bundle hiện tại trên macOS (ví dụ `/Applications/SnapDoc.app`)
/// TRƯỚC khi `Update::install` di chuyển/xóa bundle cũ.
#[cfg(target_os = "macos")]
fn macos_app_bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents_dir = exe.parent()?.parent()?;
    if contents_dir.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let app_dir = contents_dir.parent()?;
    if app_dir.extension()?.to_str()? == "app" {
        Some(app_dir.to_path_buf())
    } else {
        None
    }
}

/// Đồng bộ lại LaunchServices cho `.app` bundle vừa được ghi đè để tránh lỗi
/// `_LSBundleCreateNode for bundleID ... returned -43` trong `tccd`.
#[cfg(target_os = "macos")]
fn refresh_macos_launch_services(app_bundle: &std::path::Path) {
    let _ = std::process::Command::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
    .arg("-f")
    .arg(app_bundle)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .status();
}

/// Khởi chạy lại `.app` trên macOS qua LaunchServices (`/usr/bin/open`) sau khi
/// process cũ thoát hẳn, thay vì `app.restart()` (`Command::new(exe).spawn()`).
///
/// Lý do: sau khi `Update::install` unlink binary của process cũ, nếu dùng
/// `posix_spawn` trực tiếp từ process cũ thì process mới sẽ kế thừa `responsible`
/// file descriptor đã bị xóa (`tccd: Failed to fetch responsible file descriptor:
/// [2: No such file or directory]`). Mở qua `/usr/bin/open` sau khi PID cũ đã
/// kết thúc giúp `launchd` khởi tạo process mới với responsible file descriptor
/// sạch và không đụng khóa `tauri-plugin-single-instance`.
#[cfg(target_os = "macos")]
fn relaunch_macos_via_launch_services(app: &AppHandle, app_bundle: Option<std::path::PathBuf>) -> bool {
    let Some(bundle) = app_bundle else {
        return false;
    };
    refresh_macos_launch_services(&bundle);
    let pid = std::process::id().to_string();
    let ok = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            "i=0; while kill -0 \"$1\" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; /usr/bin/open \"$2\"",
            "--",
            &pid,
        ])
        .arg(&bundle)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok();
    if ok {
        app.exit(0);
    }
    ok
}

/// Trên macOS, nếu user thoát app bình thường (Cmd+Q / Quit tray) khi đã có bản
/// cập nhật tải sẵn trong `DOWNLOADED`, cài đặt ngay lúc thoát để lần mở tiếp
/// theo dùng bản mới mà không bao giờ phải ghi đè `.app` lúc app đang chạy.
#[cfg(target_os = "macos")]
pub fn install_downloaded_on_exit() {
    let downloaded = DOWNLOADED.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((update, bytes)) = downloaded {
        let bundle_path = macos_app_bundle_path();
        match update.install(bytes) {
            Ok(()) => {
                if let Some(ref bundle) = bundle_path {
                    refresh_macos_launch_services(bundle);
                }
                log::info!("[SnapDoc][update] installed pending update on exit");
            }
            Err(e) => {
                log::warn!("[SnapDoc][update] install on exit failed: {e}");
            }
        }
    }
}

/// "Khởi động lại để cập nhật" (tray / Settings): chốt bản quay đang chạy, rồi
/// cài bản đã tải ngầm và khởi động lại sạch.
pub fn restart_to_apply(app: &AppHandle) {
    crate::record::finalize_on_exit(app);
    #[cfg(target_os = "macos")]
    let bundle_path = macos_app_bundle_path();

    let downloaded = DOWNLOADED.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((update, bytes)) = downloaded {
        // Trên Windows, nếu thành công thì process thoát ngay bên trong `install`.
        // Trên macOS, `install` thay thế `.app` rồi trả về `Ok(())`.
        if let Err(e) = update.install(bytes) {
            log::warn!("[SnapDoc][update] deferred install failed: {e}");
        }
    }

    #[cfg(target_os = "macos")]
    if relaunch_macos_via_launch_services(app, bundle_path) {
        return;
    }

    app.restart();
}

/// Download + install the cached pending update, then relaunch.
/// Used by the manual install flow in Settings. Errors bubble up to the webview.
pub async fn install_pending(app: AppHandle) -> Result<(), String> {
    // Nếu bản cập nhật đã được tải ngầm vào `DOWNLOADED`, dùng luôn không tải lại.
    let predownloaded = DOWNLOADED.lock().unwrap_or_else(|e| e.into_inner()).take();
    let (update, bytes) = if let Some(pair) = predownloaded {
        pair
    } else {
        // Take the update out of state first so the lock isn't held across `.await`.
        let update = app.state::<PendingUpdate>().0.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(update) = update else {
            return Err("No update is pending.".to_string());
        };
        let bytes = update
            .download(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| {
                log::warn!("[SnapDoc][update] download failed: {e}");
                e.to_string()
            })?;
        (update, bytes)
    };

    // Nếu đang quay, dừng sạch trước khi ghi đè `.app` và relaunch.
    crate::record::finalize_on_exit(&app);
    #[cfg(target_os = "macos")]
    let bundle_path = macos_app_bundle_path();

    update.install(bytes).map_err(|e| {
        log::warn!("[SnapDoc][update] install failed: {e}");
        e.to_string()
    })?;

    #[cfg(target_os = "macos")]
    if relaunch_macos_via_launch_services(&app, bundle_path) {
        return Ok(());
    }

    app.restart();
}
