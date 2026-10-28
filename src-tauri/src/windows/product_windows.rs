//! macOS: giữ/ẩn cửa sổ Settings/Library khi chụp (tránh lọt vào ảnh).
//! Tách khỏi `windows/mod.rs` — giữ nguyên logic.

use super::*;

/// Cửa sổ "sản phẩm" của SnapDoc (không phải overlay/thanh công cụ tạm) — có
/// thể đang mở nhưng bị app khác che ở thời điểm chụp, hoặc — đã quan sát
/// thấy trên macOS — bị hệ thống tự đưa lên trước ngay lúc xử lý phím tắt
/// Copy/Save trong 1 phiên chụp. Xem `snapshot_visible_product_windows` +
/// `protect_product_windows` bên dưới.
pub(super) const PRODUCT_WINDOW_LABELS: &[&str] = &["settings", "history"];

pub(super) fn is_product_window(label: &str) -> bool {
    label.starts_with("editor") || PRODUCT_WINDOW_LABELS.contains(&label)
}

/// macOS: cửa sổ có đang thật sự hiển thị MỘT PHẦN trên màn hình hay không
/// (KHÔNG bị cửa sổ khác che hoàn toàn) tại đúng thời điểm gọi — dựa trên
/// `NSWindow.occlusionState`, do WindowServer duy trì liên tục theo occlusion
/// THẬT, khác `is_visible()` (chỉ biết `isVisible` bất kể có bị che hay
/// không).
pub(super) fn is_occlusion_visible(win: &tauri::WebviewWindow) -> bool {
    use objc2::msg_send;
    let ptr = match win.ns_window() {
        Ok(p) => p as *mut objc2_app_kit::NSWindow,
        Err(_) => return false,
    };
    if ptr.is_null() {
        return false;
    }
    unsafe {
        let ns_win: &objc2_app_kit::NSWindow = &*ptr;
        let state: usize = msg_send![ns_win, occlusionState];
        state & 0x2 != 0 // NSWindowOcclusionStateVisible = 1 << 1
    }
}

/// Chụp nhanh tập nhãn cửa sổ sản phẩm ĐANG THẬT SỰ HIỂN THỊ (không bị che)
/// ngay lúc BẮT ĐẦU một phiên chụp (mở overlay/trước khi hiện thực sự chụp
/// pixel) — tức là TRƯỚC KHI user có cơ hội bấm phím tắt Copy/Save, trước khi
/// hiện tượng "tự đưa cửa sổ lên trước" có thể xảy ra. Dùng làm allowlist cho
/// `protect_product_windows`: cửa sổ nào đã hiển thị thật từ đầu (ý người
/// dùng đang muốn tự chụp chính nó) sẽ KHÔNG bị loại khỏi ảnh sau này, dù nó
/// có bị hệ thống đẩy lên/xuống trong lúc chờ user bấm nút.
pub fn snapshot_visible_product_windows(app: &AppHandle) -> std::collections::HashSet<String> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| is_product_window(label))
        .filter_map(|(label, win)| {
            (win.is_visible().unwrap_or(false) && is_occlusion_visible(&win)).then_some(label)
        })
        .collect()
}

/// `WebviewWindow::set_content_protected` gửi `WindowMessage::SetContentProtected`
/// qua `send_user_message` — CHỈ áp dụng ngay lập tức nếu gọi TỪ main thread;
/// gọi từ thread khác (đúng trường hợp của ta: `capture_quick_region`/
/// `finalize_region`/… chạy trên OS thread riêng, xem comment ở
/// `finalize_region`) chỉ ENQUEUE message rồi trả về NGAY, không chờ main
/// thread xử lý xong. Lệnh chụp native gọi ngay sau đó trên cùng thread nền
/// có thể chạy TRƯỚC KHI main thread kịp áp `NSWindow.sharingType` — 1 race
/// condition khiến `set_content_protected(true)` không kịp phát huy tác dụng.
/// Chạy qua `run_on_main_thread` + kênh chặn để đảm bảo áp dụng xong THẬT SỰ
/// trước khi trả quyền điều khiển lại cho caller.
pub(super) fn run_on_main_sync(app: &AppHandle, f: impl FnOnce() + Send + 'static) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    if app
        .run_on_main_thread(move || {
            f();
            let _ = tx.send(());
        })
        .is_ok()
    {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
    }
}

/// Bật `content_protected` cho các cửa sổ sản phẩm KHÔNG có trong
/// `keep_visible` (allowlist từ `snapshot_visible_product_windows` lúc bắt
/// đầu phiên) — loại chúng khỏi ảnh chụp trong đúng khoảnh khắc chụp pixel,
/// bất kể vì sao chúng đang hiển thị lúc này. Cửa sổ NẰM TRONG allowlist (đã
/// hiển thị thật từ đầu phiên) được giữ nguyên để user vẫn tự chụp được
/// chính Editor/Settings/History khi cố ý làm vậy. Chạy đồng bộ qua main
/// thread — xem `run_on_main_sync`.
pub fn protect_product_windows(app: &AppHandle, keep_visible: &std::collections::HashSet<String>) {
    let app2 = app.clone();
    let keep = keep_visible.clone();
    run_on_main_sync(app, move || {
        for (label, win) in app2.webview_windows() {
            if is_product_window(&label) && !keep.contains(&label) {
                let _ = win.set_content_protected(true);
            }
        }
    });
}

/// Gỡ `content_protected` cho toàn bộ cửa sổ sản phẩm — gọi ngay sau mỗi lần
/// chụp pixel thật, kể cả khi capture lỗi. Chạy đồng bộ qua main thread —
/// xem `run_on_main_sync` (không bắt buộc về đúng, nhưng nhất quán và tránh
/// để lại `sharingType` áp dụng trễ sau khi hàm đã return).
pub fn unprotect_product_windows(app: &AppHandle) {
    let app2 = app.clone();
    run_on_main_sync(app, move || {
        for (label, win) in app2.webview_windows() {
            if is_product_window(&label) {
                let _ = win.set_content_protected(false);
            }
        }
    });
}

/// Ẩn THẬT SỰ (`orderOut` qua `.hide()`, không chỉ occluded) các cửa sổ sản
/// phẩm đang "visible" nhưng KHÔNG được user thật sự nhìn thấy lúc này (bị 1
/// app khác che — `is_occlusion_visible() == false`). Cửa sổ đang thật sự
/// hiển thị (user chủ ý đang xem, kể cả trên màn hình khác) được GIỮ NGUYÊN.
///
/// Gọi TRƯỚC khi mở overlay Chụp nhanh — TRƯỚC bước sẽ `set_focus()` (activate
/// app). Lý do phải ẩn THẬT thay vì chỉ trả focus về app cũ SAU đó (cách đã
/// thử trước, không đủ): `set_focus()` activate app ĐỒNG BỘ ngay trong lệnh
/// gọi đó — thời điểm activate xảy ra, macOS coi MỌI cửa sổ "visible" của app
/// (kể cả đang bị 1 app khác che, không phải đã `.hide()`) là cần đưa lên
/// TRÊN app vừa mất frontmost. Việc này xảy ra TRƯỚC KHI code Rust/JS kịp
/// chạy bất kỳ dòng nào để phản ứng — dù sau đó có trả focus về app cũ nhanh
/// đến đâu, vẫn đã có 1-2 khung hình cửa sổ đó hiện ra rồi mới ẩn lại (đúng
/// hiện tượng "hiện lên xong rồi mới ẩn"). Ẩn thật (orderOut) trước thì không
/// còn gì để mà bị đưa lên nữa. Trả về nhãn các cửa sổ đã ẩn để
/// `restore_hidden_product_windows` phục hồi đúng chúng sau đó.
pub fn hide_occluded_product_windows(app: &AppHandle) -> Vec<String> {
    let mut hidden = Vec::new();
    for (label, win) in app.webview_windows() {
        if is_product_window(&label) && win.is_visible().unwrap_or(false) && !is_occlusion_visible(&win) {
            if win.hide().is_ok() {
                hidden.push(label);
            }
        }
    }
    hidden
}

/// Phục hồi các cửa sổ đã ẩn bởi `hide_occluded_product_windows`. Dùng
/// `orderBack:` gọi TRỰC TIẾP qua Objective-C (KHÔNG `.show()`/`set_focus()`
/// của Tauri — cả 2 đều đi qua `makeKeyAndOrderFront:`, có thể tự activate
/// lại app) để chỉ đưa cửa sổ trở lại đúng vị trí "đang mở nhưng bị app khác
/// che" ở z-order phía sau như trước khi ẩn, không cướp lại frontmost hay chèn lên Chrome.
pub fn restore_hidden_product_windows(app: &AppHandle, labels: &[String]) {
    use objc2::{msg_send, runtime::AnyObject};
    for label in labels {
        let Some(win) = app.get_webview_window(label) else { continue };
        let _ = app.run_on_main_thread(move || {
            if let Ok(ptr) = win.ns_window() {
                let ptr = ptr as *mut objc2_app_kit::NSWindow;
                if !ptr.is_null() {
                    unsafe {
                        let ns_win: &objc2_app_kit::NSWindow = &*ptr;
                        let _: () = msg_send![ns_win, orderBack: Option::<&AnyObject>::None];
                    }
                }
            }
        });
    }
}
