use crate::{flow, windows};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};

/// Track whether the "restart to update" item should be shown in tray menu.
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);

/// Icon tray template (16×16 và 32×32 PNG đen/trắng cho macOS menu bar).
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

/// Tạo tray icon với menu thao tác nhanh.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    // Dùng tray.png riêng (nhỏ, template-friendly) thay vì default_window_icon
    // (icon app đầy màu sắc không phù hợp với menu bar macOS).
    let icon = Image::from_bytes(TRAY_ICON)
        .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(false)  // dùng icon màu thực, không template
        .tooltip("SnapDoc")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "restart_update" => app.restart(),
            
            "full"   => dispatch(app, "full"),
            "region" => dispatch(app, "region"),
            "window" => dispatch(app, "window"),
            "scroll" => dispatch(app, "scroll"),
            "all" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let output = crate::hotkey::default_output(&app);
                    flow::capture_all_screens(&app, &output).ok();
                });
            }
            "record_full"   => dispatch_record(app, "full"),
            "record_region" => dispatch_record(app, "region"),
            "record_window" => dispatch_record(app, "window"),
            "quick" => {
                let app = app.clone();
                std::thread::spawn(move || flow::start_quick(&app));
            }
            "bar" => {
                let _ = windows::open_capture_bar(app);
            }
            "settings" => {
                let _ = windows::open_settings(app);
            }
            "history" => {
                let _ = windows::open_history(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Xây dựng menu mới từ shortcuts hiện tại trong settings.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    build_menu_inner(app, false)
}

fn build_menu_inner(app: &AppHandle, show_restart: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let shortcuts = crate::hotkey::shortcuts_from_settings(app);
    // Chỉ hiển thị accelerator nếu combo không rỗng
    let sc = |action: &str| -> Option<String> {
        shortcuts
            .iter()
            .find(|(a, _)| a == action)
            .and_then(|(_, c)| if c.is_empty() { None } else { Some(c.clone()) })
    };

    let quick  = MenuItem::with_id(app, "quick",  "Chụp nhanh",           true, sc("quick").as_deref())?;
    let all    = MenuItem::with_id(app, "all",    "Chụp tất cả màn hình", true, sc("all").as_deref())?;
    let full   = MenuItem::with_id(app, "full",   "Chụp toàn màn hình",   true, sc("full").as_deref())?;
    let region = MenuItem::with_id(app, "region", "Chụp vùng chọn",       true, sc("region").as_deref())?;
    let window = MenuItem::with_id(app, "window", "Chụp cửa sổ",          true, sc("window").as_deref())?;
    let scroll = MenuItem::with_id(app, "scroll", "Chụp cuộn",            true, sc("scroll").as_deref())?;
    let bar    = MenuItem::with_id(app, "bar",    "Mở thanh chụp…",       true, sc("bar").as_deref())?;
    let history = MenuItem::with_id(app, "history", "Thư viện (History)…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Cài đặt…",         true, None::<&str>)?;
    let quit   = MenuItem::with_id(app, "quit",   "Thoát SnapDoc",         true, None::<&str>)?;
    let sep1   = PredefinedMenuItem::separator(app)?;
    let sep2   = PredefinedMenuItem::separator(app)?;

    // Menu con "Quay màn hình" — 1 mục duy nhất, xổ ra 3 lựa chọn phạm vi quay
    // (giống hệt 3 lựa chọn của nút "Quay" trong CaptureBar). Không có
    // accelerator riêng cho từng lựa chọn — phím tắt "Quay màn hình" chung
    // (xem `hotkey::run_action`) vẫn hoạt động song song, độc lập với menu này.
    let record_full   = MenuItem::with_id(app, "record_full",   "Toàn màn hình", true, None::<&str>)?;
    let record_region = MenuItem::with_id(app, "record_region", "Vùng chọn",     true, None::<&str>)?;
    let record_window = MenuItem::with_id(app, "record_window", "Cửa sổ",        true, None::<&str>)?;
    let record_menu = Submenu::with_items(
        app,
        "Quay màn hình",
        true,
        &[&record_full, &record_region, &record_window],
    )?;

    if show_restart {
        let restart = MenuItem::with_id(app, "restart_update", "↺ Khởi động lại để cập nhật", true, None::<&str>)?;
        let sep3    = PredefinedMenuItem::separator(app)?;
        Menu::with_items(app, &[&restart, &sep3, &quick, &full, &region, &window, &scroll, &all, &record_menu, &sep1, &bar, &history, &settings, &sep2, &quit])
    } else {
        Menu::with_items(app, &[&quick, &full, &region, &window, &scroll, &all, &record_menu, &sep1, &bar, &history, &settings, &sep2, &quit])
    }
}

// ── Icon "đang quay" — TÁCH RIÊNG khỏi tray icon chính của app ─────────────
//
// Một `TrayIcon` bị Tauri gỡ khỏi menu bar ngay khi instance cuối cùng bị
// drop, nên giữ nó ở static: `Some` = đang hiện trên menu bar, `.take()` =
// ẩn ngay lập tức. Icon này KHÔNG gắn menu — click trái vào nó DỪNG QUAY
// NGAY LẬP TỨC, không qua bước chọn trong menu nào cả.
static RECORDING_TRAY: Mutex<Option<TrayIcon<tauri::Wry>>> = Mutex::new(None);

/// Kích thước (px) của icon chấm đỏ tự vẽ — 32 để nét trên màn Retina,
/// NSStatusItem tự co về đúng kích thước chuẩn của menu bar khi hiển thị.
const DOT_SIZE: u32 = 32;

/// Vẽ trực tiếp 1 chấm đỏ tròn (RGBA8, có alpha + khử răng cưa viền ngoài)
/// làm icon tray "đang quay" — sinh runtime, không cần thêm file asset.
fn recording_dot_rgba() -> Vec<u8> {
    let size = DOT_SIZE as f32;
    let center = size / 2.0;
    let radius = size / 2.0 - 3.0;
    let mut buf = vec![0u8; (DOT_SIZE * DOT_SIZE * 4) as usize];
    for y in 0..DOT_SIZE {
        for x in 0..DOT_SIZE {
            let dx = x as f32 + 0.5 - center;
            let dy = y as f32 + 0.5 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = if dist <= radius {
                255.0
            } else if dist <= radius + 1.0 {
                (radius + 1.0 - dist) * 255.0 // viền mềm 1px
            } else {
                0.0
            };
            let i = ((y * DOT_SIZE + x) * 4) as usize;
            buf[i] = 239; // #ef4444
            buf[i + 1] = 68;
            buf[i + 2] = 68;
            buf[i + 3] = alpha.clamp(0.0, 255.0) as u8;
        }
    }
    buf
}

/// Thời lượng đã quay (ms) → chuỗi `mm:ss`.
fn format_elapsed(ms: u64) -> String {
    let total_secs = ms / 1000;
    format!("{:02}:{:02}", total_secs / 60, total_secs % 60)
}

/// Hiện icon "đang quay" riêng biệt trên menu bar — gọi từ
/// `record::start_recording` ngay sau khi phiên quay khởi động thành công.
/// Không set menu (`show_menu_on_left_click(false)`): click trái là hành
/// động DỪNG NGAY, không phải mở danh sách lựa chọn.
pub fn show_recording_tray(app: &AppHandle) {
    let mut guard = match RECORDING_TRAY.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_some() {
        return; // đã hiện rồi (phòng gọi start 2 lần)
    }
    let rgba = recording_dot_rgba();
    let icon = Image::new(&rgba, DOT_SIZE, DOT_SIZE);
    let result = TrayIconBuilder::with_id("recording-tray")
        .icon(icon)
        .icon_as_template(false)
        .tooltip("Đang quay màn hình — bấm để dừng")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = crate::record::stop_recording(&app) {
                        eprintln!("[SnapDoc][record] Dừng quay từ tray icon thất bại: {e}");
                        let _ = app.emit("snapdoc-error", format!("Dừng quay thất bại: {e}"));
                    }
                });
            }
        })
        .build(app);
    match result {
        Ok(tray) => *guard = Some(tray),
        Err(e) => {
            // Trước đây chỉ `eprintln!` (vô hình trong bản đóng gói, không có
            // console đính kèm) — quay vẫn chạy (file vẫn ghi) nhưng người
            // dùng không thấy DẤU HIỆU nào là đang quay. Emit qua kênh lỗi
            // chung (CaptureBar.tsx lắng `snapdoc-error`) để ít nhất còn 1
            // thông báo hiện ra thay vì im lặng hoàn toàn.
            eprintln!("[SnapDoc][record] Không tạo được tray icon quay: {e}");
            let _ = app.emit("snapdoc-error", format!("Đang quay nhưng không hiện được icon trên tray: {e}"));
        }
    }
}

/// Cập nhật đồng hồ đếm cạnh icon "đang quay" — gọi mỗi giây từ ticker trong
/// `record::start_recording`. No-op nếu icon chưa/không còn hiện.
pub fn update_recording_time(elapsed_ms: u64) {
    if let Ok(guard) = RECORDING_TRAY.lock() {
        if let Some(tray) = guard.as_ref() {
            let _ = tray.set_title(Some(format_elapsed(elapsed_ms)));
        }
    }
}

/// Ẩn icon "đang quay" NGAY LẬP TỨC — gọi từ `record::stop_recording`.
///
/// GỐC RỄ thật sự (2 lớp, phải xử lý cả 2):
///
/// 1) `tray_icon::TrayIcon` bên trong chỉ là 1 handle đếm tham chiếu
///    (`Rc<RefCell<..>>`) — icon chỉ thật sự bị gỡ khỏi menu bar khi CLONE
///    CUỐI CÙNG bị drop. Nhưng `TrayIconBuilder::build()` của Tauri tự giữ
///    thêm 1 bản clone trong `resources_table` nội bộ (để `app.tray_by_id()`
///    tra cứu được sau này) — bản clone đó KHÔNG do ta nắm giữ. Vì vậy chỉ
///    `.take()` bản trong `RECORDING_TRAY` static (bản clone của TA) không
///    bao giờ đưa refcount về 0 → `Drop` (và do đó
///    `NSStatusBar.removeStatusItem`) không bao giờ chạy → icon kẹt vĩnh
///    viễn trên menu bar bất kể gọi từ thread nào. Phải gọi
///    `app.remove_tray_by_id(...)` để Tauri tự rút bản clone của NÓ ra khỏi
///    resources_table trước, thì tổng refcount mới có thể về 0.
///
/// 2) Trên macOS, `Drop` của `TrayIcon` gọi thẳng
///    `NSStatusBar.removeStatusItem` KHÔNG qua main-thread dispatch (khác
///    với các method khác như `set_title`/`set_icon` — Tauri tự marshal qua
///    `run_on_main_thread` nội bộ cho các method đó). `stop_recording` luôn
///    chạy trên 1 thread nền (tray click handler / hotkey đều
///    `std::thread::spawn`), nên vẫn phải ép toàn bộ việc gỡ (cả bước 1 lẫn
///    việc drop clone cuối) chạy trên main thread.
pub fn hide_recording_tray(app: &AppHandle) {
    let app_for_closure = app.clone();
    let _ = app.run_on_main_thread(move || {
        let app = app_for_closure;
        // Rút bản clone Tauri tự giữ trong resources_table ra trước (và drop
        // luôn — không gán biến) — thiếu bước này thì bước bên dưới vô nghĩa.
        app.remove_tray_by_id("recording-tray");
        if let Ok(mut guard) = RECORDING_TRAY.lock() {
            guard.take();
        }
    });
}

/// Rebuild tray menu với shortcuts mới nhất — gọi sau `reload_shortcuts`.
/// Accelerator text trong menu sẽ phản ánh đúng shortcuts hiện tại,
/// kể cả khi user đã xóa một phím tắt (sẽ không còn accelerator đó).
pub fn rebuild_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let show_restart = RESTART_PENDING.load(Ordering::Relaxed);
        if let Ok(menu) = build_menu_inner(app, show_restart) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Đổi tooltip tray để báo có update đang tải/cài.
pub fn set_update_badge(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some("SnapDoc — 🔄 Đang tải bản cập nhật…"));
    }
}

/// Đổi tooltip + menu tray sau khi update đã cài xong, chờ restart.
/// Chỉ được gọi từ `update::silent_download_and_install`, nơi bị loại khỏi
/// debug build bởi `#[cfg(not(debug_assertions))]` — nên `cargo check` (debug
/// profile) báo "never used" dù hàm này CÓ dùng thật ở release build.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn set_restart_badge(app: &AppHandle) {
    RESTART_PENDING.store(true, Ordering::Relaxed);
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some("SnapDoc — ✅ Đã cập nhật! Khởi động lại để áp dụng"));
        if let Ok(menu) = build_menu_inner(app, true) {
            let _ = tray.set_menu(Some(menu));
        }
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

/// Mở overlay chọn phạm vi QUAY (không phải chụp ảnh) — dùng cho menu con
/// "Quay màn hình" trên tray. Tái dùng nguyên `flow::run_record_picker`, cùng
/// hàm mà nút "Quay" trong CaptureBar gọi qua IPC `start_record_picker`.
fn dispatch_record(app: &AppHandle, mode: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    std::thread::spawn(move || flow::run_record_picker(&app, &mode));
}
