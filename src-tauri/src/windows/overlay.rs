//! Overlay chọn vùng/chụp: dựng, tái dùng (prewarm), hiện khi sẵn sàng,
//! vòng đọc chuột, đóng. Tách khỏi `windows/mod.rs` — giữ nguyên logic.

use super::*;

/// Mở overlay trên TẤT CẢ màn hình (mỗi màn một cái). `mode` =
/// "region" | "window" | "monitor". Input do `input_loop` xử lý qua con trỏ +
/// nút chuột toàn cục (không cần focus) → không nháy, độ trễ chuyển màn = 0.
///
/// Toạ độ dùng hệ NHẤT QUÁN: trên macOS là POINTS (CGDisplayBounds/xcap) —
/// vì `Tauri::Monitor::position()` (physical = points×scale-riêng) KHÔNG nhất
/// quán giữa các màn khác scale. Định vị overlay trên macOS qua `NSScreen.frame`
/// (native, chính xác); các OS khác dùng set_position/set_size physical.
pub fn open_overlays(app: &AppHandle, mode: &str) -> Result<(), String> {
    open_overlays_ex(app, mode, false, None)
}

/// Mở dialog "Chọn cửa sổ" dạng lưới thumbnail (tham khảo dialog "Select App
/// Window" của macOS) — dùng cho CẢ chụp ảnh cửa sổ lẫn bắt đầu quay cửa sổ
/// (cờ `pending_record`, set TRƯỚC khi gọi hàm này ở `flow::run`/
/// `flow::run_record_picker`, quyết định `finalize_window` rẽ nhánh nào).
///
/// Khác hẳn `open_overlays_ex`: đây là 1 cửa sổ dialog BÌNH THƯỜNG (có viền/
/// tiêu đề, không transparent/click-through/always-on-top-phủ-kín-màn-hình)
/// — giống `open_editor`, không phải overlay phủ kín màn hình nên không cần
/// freeze màn hình hay `ActivationPolicy::Accessory`.
pub fn open_window_picker(app: &AppHandle, record: bool) -> Result<(), String> {
    close_window_picker(app);
    let query = if record { "win=window-picker&record=1" } else { "win=window-picker" };
    let win = WebviewWindowBuilder::new(
        app,
        "window-picker",
        WebviewUrl::App(format!("index.html?{query}").into()),
    )
        .title("SnapDoc")
        .inner_size(880.0, 620.0)
        .min_inner_size(560.0, 420.0)
        .resizable(true)
        .center()
        .always_on_top(true)
        .build()
        .map_err(|e| format!("Không tạo được dialog chọn cửa sổ: {e}"))?;
    let _ = win.set_focus();
    Ok(())
}

/// Đóng dialog "Chọn cửa sổ" nếu đang mở — an toàn khi gọi dù chưa từng có.
pub fn close_window_picker(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("window-picker") {
        let _ = win.close();
    }
}

/// Tìm index màn hình khớp với preset vùng quay trước đó theo mức độ ưu tiên:
/// 1. Khớp runtime ID (cùng phiên làm việc hoặc macOS CGDirectDisplayID).
/// 2. Khớp theo tên thiết bị GDI bền vững (vd "\\.\DISPLAY1" trên Windows).
/// 3. Khớp màn hình chính nếu trước đó ghi nhận ở màn hình chính.
/// 4. Khớp fallback khi hệ thống chỉ có đúng 1 màn hình duy nhất.
pub fn find_matching_monitor_index(
    preset: &crate::flow::LastRecordRegion,
    snaps: &[MonitorSnap],
) -> Option<usize> {
    if snaps.is_empty() {
        return None;
    }
    // 1. Runtime ID
    if let Some(idx) = snaps.iter().position(|s| s.id == preset.display_id) {
        return Some(idx);
    }
    // 2. Persistent name
    if let Some(ref name) = preset.display_name {
        if !name.is_empty() {
            if let Some(idx) = snaps.iter().position(|s| &s.name == name) {
                return Some(idx);
            }
        }
    }
    // 3. Primary monitor
    if preset.is_primary.unwrap_or(false) {
        if let Some(idx) = snaps.iter().position(|s| s.is_primary) {
            return Some(idx);
        }
    }
    // 4. Fallback cho hệ thống 1 màn hình
    if snaps.len() == 1 {
        return Some(0);
    }
    None
}

/// Tính toạ độ CSS px và tự động clamp nếu độ phân giải/DPI scale thay đổi
pub fn compute_preset_css_rect(
    snap: &MonitorSnap,
    preset: &crate::flow::LastRecordRegion,
) -> Option<(f64, f64, f64, f64)> {
    #[cfg(target_os = "windows")]
    let scale_conv = snap.scale.max(0.0001);
    #[cfg(not(target_os = "windows"))]
    let scale_conv = 1.0_f64;

    let snap_w_css = snap.w / scale_conv;
    let snap_h_css = snap.h / scale_conv;

    let cw = (preset.w / scale_conv).min(snap_w_css);
    let ch = (preset.h / scale_conv).min(snap_h_css);
    if cw < 20.0 || ch < 20.0 {
        return None;
    }

    let mut cx = preset.x / scale_conv;
    let mut cy = preset.y / scale_conv;

    // Clamp để đảm bảo khung luôn nằm trọn vẹn trong màn hình
    cx = cx.clamp(0.0, (snap_w_css - cw).max(0.0));
    cy = cy.clamp(0.0, (snap_h_css - ch).max(0.0));

    Some((cx, cy, cw, ch))
}

/// Query string cho 1 overlay ở monitor `snap` (idx `i`) — tách riêng khỏi
/// `open_overlays_ex` để `prewarm_overlays`/`try_reuse_prewarmed_overlays`
/// dùng chung, không lặp lại logic tính preset/scale.
pub(super) fn build_overlay_query(
    mode: &str,
    i: usize,
    snap: &MonitorSnap,
    record: bool,
    preset: Option<&crate::flow::LastRecordRegion>,
    matched_idx: Option<usize>,
    gen: u64,
) -> String {
    // scale: cần cho mode "quick" (Chụp nhanh) để canvas chú thích render
    // đúng độ phân giải vật lý; các mode khác bỏ qua tham số này.
    // gen: overlay echo lại nguyên giá trị này khi báo "đã paint xong" (xem
    // `wait_for_overlays_ready`) — để Rust lọc bỏ tín hiệu trễ từ phiên cũ.
    let mut query = format!("win=overlay&mode={mode}&idx={i}&scale={}&gen={gen}", snap.scale);
    if record {
        query.push_str("&record=1");
    }
    if matched_idx == Some(i) {
        if let Some(p) = preset {
            if let Some((cx, cy, cw, ch)) = compute_preset_css_rect(snap, p) {
                query.push_str(&format!("&px={cx}&py={cy}&pw={cw}&ph={ch}"));
            }
        }
    }
    query
}

/// Định vị 1 overlay đúng khung `snap` rồi show() — tách riêng khỏi
/// `open_overlays_ex` để dùng chung cho cả nhánh build() mới lẫn nhánh
/// navigate() tái sử dụng cửa sổ đã pre-warm (xem `try_reuse_prewarmed_overlays`).
/// Đặt frame/level cho overlay TRƯỚC khi show() — cửa sổ vẫn ẩn, nhưng đã
/// đúng vị trí/kích thước để frontend bắt đầu vẽ (fetch ảnh đóng băng) ngay,
/// không phải chờ thêm một nhịp "nhảy vị trí" sau khi đã lên hình.
pub(super) fn position_overlay(
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] app: &AppHandle,
    win: &tauri::WebviewWindow,
    snap: &MonitorSnap,
) {
    #[cfg(target_os = "macos")]
    {
        // Đặt frame qua NSScreen (points, native) trên main thread.
        let win_main = win.clone();
        let did = snap.id;
        let record_self = crate::storage::settings::is_record_self(app);
        let _ = app.run_on_main_thread(move || {
            configure_overlay_ns_window_main_thread(&win_main, did, record_self);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows: tương đương NSWindowAnimationBehaviorNone trên macOS.
        // Đặt cờ trước khi window được reveal để DWM không fade/transition
        // ảnh freeze đã chuẩn bị sẵn lúc overlay xuất hiện.
        #[cfg(target_os = "windows")]
        disable_overlay_transitions(win);
        // Windows/Linux: snapshot ở physical pixels → đặt trực tiếp.
        let _ = win.set_position(PhysicalPosition::new(snap.x as i32, snap.y as i32));
        let _ = win.set_size(PhysicalSize::new(snap.w as u32, snap.h as u32));
    }
}

/// order-front THẬT (win.show()) + áp lại frame sau show (NSWindow borderless
/// đôi khi chỉ áp đúng frame sau khi đã order-front; Windows thì
/// WM_DPICHANGED khi đổi màn đích DPI khác có thể ghi đè set_size gọi trước
/// show()). CHỈ gọi hàm này SAU KHI `wait_for_overlays_ready` đã xác nhận (hoặc
/// timeout) frontend paint xong ảnh đóng băng — để frame đầu tiên hiện ra đã
/// có sẵn nội dung đúng, không có nhịp trống/nháy (cơ chế freeze mượt như
/// Snagit: không bao giờ show() rồi mới paint sau).
pub(super) fn reveal_overlay(
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] app: &AppHandle,
    win: &tauri::WebviewWindow,
    snap: &MonitorSnap,
) {
    let record_self = crate::storage::settings::is_record_self(app);
    let _ = win.set_content_protected(!record_self);

    // macOS đặt NSWindowAnimationBehaviorNone trong configure_overlay...;
    // Windows dùng thuộc tính DWM tương đương và phải đặt TRƯỚC show() để
    // frame đầu tiên của ảnh freeze không bị transition/fade.
    #[cfg(target_os = "windows")]
    disable_overlay_transitions(win);

    let _ = win.show();

    #[cfg(target_os = "macos")]
    {
        let win_main = win.clone();
        let did = snap.id;
        let _ = app.run_on_main_thread(move || {
            configure_overlay_ns_window_main_thread(&win_main, did, record_self);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows: áp lại SAU show. Khi set_position chuyển cửa sổ sang màn
        // đích khác DPI, Windows gửi WM_DPICHANGED và tự rescale kích thước →
        // lần set trước show có thể bị ghi đè/bỏ qua. Đặt position TRƯỚC (để
        // DPI ổn định ở màn đích) rồi set_size để phủ trọn vẹn toàn màn hình.
        let _ = win.set_position(PhysicalPosition::new(snap.x as i32, snap.y as i32));
        let _ = win.set_size(PhysicalSize::new(snap.w as u32, snap.h as u32));
    }
}

/// Chờ frontend báo "đã paint xong ảnh đóng băng" cho từng overlay-{idx}
/// (qua Tauri command `notify_overlay_ready`, xem `commands::notify_overlay_ready`
/// và `useFrozenScreen` trong Overlay.tsx) trước khi `reveal_overlay` cho
/// TẤT CẢ màn hình. Mục đích: tất cả overlay trồi lên compositor gần như
/// cùng một nhịp, với nội dung đã đúng — không màn nào lộ ra chậm hơn màn
/// khác, không có nhịp "trống" trước khi ảnh đóng băng kịp vẽ.
///
/// Có timeout an toàn (xem `wait_for_overlays_ready`) — hết giờ thì CHỈ show
/// những overlay đã báo ready, không bao giờ show overlay chưa xác nhận sống.
pub(super) fn prepare_overlay_ready_channel(app: &AppHandle) -> std::sync::mpsc::Receiver<(u64, usize)> {
    let (tx, rx) = std::sync::mpsc::channel::<(u64, usize)>();
    if let Ok(mut slot) = app.state::<AppState>().overlay_ready_tx.lock() {
        *slot = Some(tx);
    }
    rx
}

/// Overlay ở màn hình phụ đã báo ready sớm thì vẫn chờ thêm tối đa chừng này
/// (tính từ lúc bắt đầu chờ) cho các màn khác, để tất cả lên hình cùng nhịp.
pub(super) const OVERLAY_READY_SOFT_MS: u64 = 250;
/// Trần chờ overlay của màn hình được focus (có con trỏ / chứa preset). Quá
/// mốc này mà nó vẫn chưa báo ready → coi như frontend không sống (trang chưa
/// load, mất event phiên, WebView2 treo...) và HUỶ phiên thay vì show().
/// Nhánh reuse pool prewarm: trang thường đã load sẵn (hoặc đang load dở).
pub(super) const OVERLAY_READY_HARD_MS_REUSE: u64 = 2000;
/// Nhánh build() mới: WebView2 khởi tạo từ đầu nên cho trần rộng hơn.
pub(super) const OVERLAY_READY_HARD_MS_BUILD: u64 = 4000;

/// Chờ frontend báo "đã paint xong ảnh đóng băng" cho từng overlay-{idx}
/// (qua Tauri command `notify_overlay_ready`, xem `commands::notify_overlay_ready`
/// và `useFrozenScreen` trong Overlay.tsx) trước khi `reveal_overlay`.
///
/// Trả về tập idx ĐÃ báo ready (đúng `gen`) — CHỈ những overlay này được phép
/// show(). Trước đây hết giờ là show() tất cả bất kể frontend có sống hay
/// không → một cửa sổ trong suốt, always-on-top, phủ toàn màn hình nhưng
/// không có JS (trang trắng / gen=0 render null) nuốt toàn bộ chuột/phím =
/// "treo màn hình". Giờ: chờ tối đa `OVERLAY_READY_SOFT_MS` cho đủ mọi màn,
/// riêng màn `focus_idx` được chờ tới `hard_ms`. Trả lại `rx`
/// để `reveal_ready_overlays` tiếp tục nhận tín hiệu trễ của màn phụ.
pub(super) fn wait_for_overlays_ready(
    app: &AppHandle,
    rx: std::sync::mpsc::Receiver<(u64, usize)>,
    gen: u64,
    expected: usize,
    focus_idx: usize,
    hard_ms: u64,
) -> (std::collections::HashSet<usize>, std::sync::mpsc::Receiver<(u64, usize)>) {
    use std::collections::HashSet;
    use std::time::Instant;

    let t_start = Instant::now();
    let soft = t_start + Duration::from_millis(OVERLAY_READY_SOFT_MS);
    let hard = t_start + Duration::from_millis(hard_ms);
    let mut seen: HashSet<usize> = HashSet::with_capacity(expected);
    while seen.len() < expected {
        // Chưa thấy màn focus → được chờ tới mốc cứng; thấy rồi → chỉ chờ
        // nốt tới mốc mềm cho các màn còn lại.
        let deadline = if seen.contains(&focus_idx) { soft } else { hard };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok((g, idx)) if g == gen => {
                seen.insert(idx);
            }
            Ok((g, idx)) => {
                log::debug!("[SnapDoc Timing] wait_for_overlays_ready: ignored stale signal g={g} != gen={gen}, idx={idx}");
            }
            Err(_) => break, // timeout hoặc sender đã bị phiên mới thay
        }
    }

    log::debug!("[SnapDoc Timing] wait_for_overlays_ready: {:?}, seen={}/{}", t_start.elapsed(), seen.len(), expected);

    if seen.len() == expected {
        if let Ok(mut slot) = app.state::<AppState>().overlay_ready_tx.lock() {
            *slot = None;
        }
    }
    (seen, rx)
}

/// show() các overlay ĐÃ báo ready (xem `wait_for_overlays_ready`), focus đúng
/// `focus_idx`. Nếu chính màn focus không ready → đóng toàn bộ overlay, trả
/// `Err` (caller báo lỗi qua `snapdoc-error`) — tuyệt đối không show một
/// overlay mà frontend chưa xác nhận đang sống. Màn phụ chưa ready được giữ
/// ẨN; một thread nền tiếp tục nhận tín hiệu trễ và show() chúng khi sẵn
/// sàng (nếu phiên `gen` vẫn còn hiệu lực), thêm tối đa `hard_ms`.
pub(super) fn reveal_ready_overlays(
    app: &AppHandle,
    wins: &[tauri::WebviewWindow],
    snaps: &[MonitorSnap],
    focus_idx: usize,
    gen: u64,
    ready: std::collections::HashSet<usize>,
    rx: std::sync::mpsc::Receiver<(u64, usize)>,
    hard_ms: u64,
) -> Result<(), String> {
    if !ready.contains(&focus_idx) {
        log::info!(
            "[SnapDoc] overlay-{focus_idx} (màn focus) không báo ready sau {}ms — huỷ phiên, không show overlay",
            hard_ms
        );
        close_overlays(app);
        restore_regular_activation(app);
        return Err("Overlay chụp màn hình chưa sẵn sàng, vui lòng thử lại.".to_string());
    }

    for (i, win) in wins.iter().enumerate() {
        if !ready.contains(&i) {
            log::info!("[SnapDoc] overlay-{i} chưa báo ready — giữ ẩn, chờ tín hiệu trễ");
            continue;
        }
        reveal_overlay(app, win, &snaps[i]);
        if i == focus_idx {
            let _ = win.set_focus();
        }
    }

    if ready.len() < wins.len() {
        let handle = app.clone();
        let wins = wins.to_vec();
        let snaps = snaps.to_vec();
        let mut revealed = ready;
        std::thread::spawn(move || {
            let hard = std::time::Instant::now() + Duration::from_millis(hard_ms);
            while revealed.len() < wins.len() {
                let remaining = hard.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let Ok((g, idx)) = rx.recv_timeout(remaining) else { break };
                let state = handle.state::<AppState>();
                if state.overlay_gen.load(Ordering::SeqCst) != gen {
                    break; // phiên mới đã thay
                }
                // `close_overlays` (Esc, chụp xong...) xoá session nhưng không
                // bump gen — không show lại overlay của phiên đã đóng.
                if !state.overlay_session.lock().map(|g| g.is_some()).unwrap_or(false) {
                    break;
                }
                if g != gen || revealed.contains(&idx) {
                    continue;
                }
                if let (Some(win), Some(snap)) = (wins.get(idx), snaps.get(idx)) {
                    log::info!("[SnapDoc] overlay-{idx} ready trễ — show()");
                    reveal_overlay(&handle, win, snap);
                    revealed.insert(idx);
                }
            }
        });
    }
    Ok(())
}

/// Payload phiên cho từng overlay (cùng nội dung event `overlay-session-start`).
/// Lưu vào `AppState::overlay_session` để overlay tự kéo về lúc mount
/// (`commands::get_overlay_session`) — event Tauri không được buffer, trang
/// prewarm chưa kịp đăng ký listener sẽ mất event và kẹt ở gen=0.
pub(super) fn overlay_session_payloads(
    mode: &str,
    record: bool,
    preset: Option<&crate::flow::LastRecordRegion>,
    matched_idx: Option<usize>,
    snaps: &[MonitorSnap],
    gen: u64,
) -> Vec<serde_json::Value> {
    snaps
        .iter()
        .enumerate()
        .map(|(i, snap)| {
            let preset_json = if matched_idx == Some(i) {
                preset
                    .and_then(|p| compute_preset_css_rect(snap, p))
                    .map(|(cx, cy, cw, ch)| serde_json::json!({ "x": cx, "y": cy, "w": cw, "h": ch }))
            } else {
                None
            };
            serde_json::json!({
                "targetIdx": i,
                "mode": mode,
                "gen": gen,
                "record": record,
                "preset": preset_json,
            })
        })
        .collect()
}

pub(super) fn store_overlay_session(app: &AppHandle, payloads: &[serde_json::Value]) {
    if let Ok(mut g) = app.state::<AppState>().overlay_session.lock() {
        *g = Some(payloads.to_vec());
    }
}

/// Dựng 1 cửa sổ overlay với đúng bộ thuộc tính chuẩn (dùng chung cho cả
/// `prewarm_overlays` lẫn nhánh fallback của `open_overlays_ex`) — RETRY khi
/// `build()` báo lỗi "already exists": `close_overlays()` chỉ RA LỆNH
/// `win.close()` rồi return ngay (không chờ xác nhận), trong khi việc đóng
/// cửa sổ ở tầng OS/DWM có thể xảy ra SAU đó một khoảng ngắn (đặc biệt
/// Windows) — nếu build() lại đúng label đó ngay lập tức, OS có thể vẫn còn
/// coi label cũ là "đang tồn tại". Retry ngắn (tối đa 5 lần, cách nhau 40ms,
/// tổng tối đa ~200ms) đủ để hứng đúng khoảng hở này mà không cần đoán 1 con
/// số sleep cố định trước khi build() như cách cũ. Lỗi KHÁC "already exists"
/// (ví dụ hết bộ nhớ, permission...) trả về ngay lập tức, không retry.
pub(super) const OVERLAY_INIT_SCRIPT: &str =
    "window.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);";

pub(super) fn build_overlay_window_with_retry(
    app: &AppHandle,
    label: &str,
    query: &str,
) -> Result<tauri::WebviewWindow, String> {
    const MAX_RETRIES: u32 = 15;
    const RETRY_DELAY_MS: u64 = 50;

    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        let result = WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::App(format!("index.html?{query}").into()),
        )
        .title("SnapDoc")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        // Windows: tắt DWM drop-shadow để set_position khớp chính xác pixel
        // gốc màn hình. Shadow DWM làm nội dung lệch phải/xuống một khoảng
        // bằng shadow margin (~8 px ở 100% DPI, tự scale theo DPI).
        .shadow(false)
        // Không cho OS resize overlay — toạ độ CSS/tính rect trong
        // Overlay.tsx giả định cửa sổ luôn khớp CHÍNH XÁC `MonitorSnap`.
        .resizable(false)
        // Chặn menu chuột phải mặc định (Back/Reload/Share...) NGAY từ lúc tạo
        // document — trước cả khi bundle JS (`main.tsx`) kịp load. Overlay
        // toàn màn hình không bao giờ được để lộ menu này.
        .initialization_script(OVERLAY_INIT_SCRIPT)
        .build();

        match result {
            Ok(w) => return Ok(w),
            Err(e) => {
                last_err = e.to_string();
                let is_label_conflict = last_err.contains("already exists");
                if !is_label_conflict || attempt == MAX_RETRIES {
                    break;
                }
                log::info!(
                    "[SnapDoc] overlay {label}: label vừa đóng chưa giải phóng xong (lần {attempt}), thử lại..."
                );
                std::thread::sleep(Duration::from_millis(RETRY_DELAY_MS));
            }
        }
    }
    Err(format!("Không tạo được overlay: {last_err}"))
}

/// Tạo sẵn (ẩn) 1 cửa sổ overlay cho mỗi màn hình hiện có — gọi lúc khởi
/// động app và sau mỗi lần `close_overlays` (xem đó) — để lần
/// `open_overlays_ex` TIẾP THEO chỉ cần `navigate()` cửa sổ đã có sẵn thay vì
/// phải `build()` mới hoàn toàn N cửa sổ webview. Trên máy nhiều màn hình, N
/// lần build() TUẦN TỰ (mỗi lần tạo native window + webview từ đầu) là nguồn
/// trễ chính khiến overlay không hiện "tức thì" khi bấm phím tắt chụp — build()
/// một lần duy nhất/1 cửa sổ (editor/thumbnail/capture-bar) vốn đã prewarm
/// theo đúng cách này, ở đây áp dụng lại cho N cửa sổ overlay.
///
/// Query đặt tạm mode=region làm placeholder — không ai nhìn thấy (cửa sổ
/// đang ẩn); `try_reuse_prewarmed_overlays` sẽ `navigate()` ghi đè đúng
/// mode/scale/record/preset thật ngay trước khi show(). Không đụng vào
/// overlay-{i} đã tồn tại (dù đang ẩn/idle hay đang LIVE của 1 phiên khác) —
/// chỉ tạo bù cho những index còn thiếu.
pub(super) struct OverlayPrewarmGuard(AppHandle);
impl Drop for OverlayPrewarmGuard {
    fn drop(&mut self) {
        self.0
            .state::<AppState>()
            .overlay_prewarming
            .store(false, Ordering::SeqCst);
    }
}

pub fn prewarm_overlays(app: &AppHandle) {
    if app.state::<AppState>().overlay_opening.load(Ordering::SeqCst) {
        return;
    }
    app.state::<AppState>()
        .overlay_prewarming
        .store(true, Ordering::SeqCst);
    let _guard = OverlayPrewarmGuard(app.clone());

    let xmons = match xcap::Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            log::warn!("[SnapDoc] prewarm_overlays: không liệt kê được màn hình: {e}");
            return;
        }
    };
    let mut snaps = Vec::with_capacity(xmons.len());
    for (i, m) in xmons.iter().enumerate() {
        let snap = MonitorSnap {
            id: m.id().unwrap_or(0),
            name: m.name().unwrap_or_default(),
            is_primary: m.is_primary().unwrap_or(false),
            x: m.x().unwrap_or(0) as f64,
            y: m.y().unwrap_or(0) as f64,
            w: m.width().unwrap_or(0) as f64,
            h: m.height().unwrap_or(0) as f64,
            scale: m.scale_factor().unwrap_or(1.0).max(1.0) as f64,
        };
        snaps.push(snap.clone());

        // Một phiên vừa bắt đầu mở overlay (open_overlays_ex không chờ prewarm
        // quá 600ms) → dừng ngay, không build() tranh label với nhánh fallback
        // (vòng retry "already exists" chỉ đổ thêm tải lên UI thread).
        if app.state::<AppState>().overlay_opening.load(Ordering::SeqCst) {
            log::info!("[SnapDoc] prewarm_overlays: phiên mở overlay đang chạy — dừng prewarm");
            return;
        }
        let label = format!("overlay-{i}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        // gen=0: cửa sổ pre-warm chưa thuộc phiên chụp thật nào — sẽ được
        // navigate() lại với gen thật trước khi dùng (xem `try_reuse_prewarmed_overlays`).
        let query = build_overlay_query("region", i, &snap, false, None, None, 0);
        let win = match build_overlay_window_with_retry(app, &label, &query) {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[SnapDoc] prewarm_overlays: không tạo được overlay-{i}: {e}");
                continue;
            }
        };
        let record_self = crate::storage::settings::is_record_self(app);
        let _ = win.set_content_protected(!record_self);
        // Định vị đúng ngay từ lúc prewarm (dù đang ẩn) — tránh 1 nhịp "nhảy
        // vị trí" nếu lỡ bị show() trước khi kịp navigate() lần dùng thật.
        #[cfg(target_os = "macos")]
        {
            let win_main = win.clone();
            let did = snap.id;
            let _ = app.run_on_main_thread(move || {
                configure_overlay_ns_window_main_thread(&win_main, did, record_self);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = win.set_position(PhysicalPosition::new(snap.x as i32, snap.y as i32));
            let _ = win.set_size(PhysicalSize::new(snap.w as u32, snap.h as u32));
        }
    }

    // Không ghi đè snapshot của một phiên vừa mở trong lúc prewarm đang chạy
    // (input_loop/finalize dùng nó để quy đổi toạ độ theo idx).
    if !app.state::<AppState>().overlay_opening.load(Ordering::SeqCst) {
        if let Ok(mut g) = app.state::<AppState>().overlay_monitors.lock() {
            *g = snaps;
        }
    }
}

/// Thử tái sử dụng pool overlay đã pre-warm (ẩn, idle) thay vì `close_overlays`
/// + `build()` lại từ đầu (xem `prewarm_overlays`). Chỉ reuse khi TOÀN BỘ N
/// cửa sổ overlay-{0..N-1} đã tồn tại, đang ẨN (`is_visible() == false` — nếu
/// đang hiện tức là phiên khác đang chạy thật, TUYỆT ĐỐI không đụng vào) và
/// không có label overlay-* nào thừa (topology màn hình đổi khác lúc
/// prewarm). Bất kỳ điều kiện nào không khớp → trả `false`, caller tự
/// fallback về nhánh build() cũ — an toàn tuyệt đối, không đổi hành vi trong
/// các trường hợp đó (kể cả khi navigate() lỗi giữa chừng: các cửa sổ đã
/// navigate xong trong vòng lặp này sẽ bị `close_overlays` ở nhánh fallback
/// dọn sạch cùng phần còn lại, không để lại state lệch).
///
/// Dùng `WebviewWindow::navigate()` (điều hướng lại TRANG trên cửa sổ có sẵn,
/// KHÔNG tạo native window mới) để đổi mode/scale/record/preset — tương
/// đương 1 lần "reload", `Overlay.tsx` đọc lại `window.location.search` từ
/// đầu nên toàn bộ state module-level (MODE/MY_IDX/SCALE/RECORD/PRESET) tự
/// đúng, KHÔNG cần sửa gì ở phía frontend.
pub(super) fn try_reuse_prewarmed_overlays(
    app: &AppHandle,
    mode: &str,
    record: bool,
    preset: Option<&crate::flow::LastRecordRegion>,
    matched_idx: Option<usize>,
    snaps: &[MonitorSnap],
    focus_idx: usize,
    gen: u64,
) -> Option<Result<(), String>> {
    let windows = app.webview_windows();
    let has_extra = windows.keys().any(|l| {
        l.starts_with("overlay-")
            && l.strip_prefix("overlay-")
                .and_then(|s| s.parse::<usize>().ok())
                .map(|idx| idx >= snaps.len())
                .unwrap_or(true)
    });
    if has_extra {
        return None;
    }

    let mut wins = Vec::with_capacity(snaps.len());
    for i in 0..snaps.len() {
        match windows.get(&format!("overlay-{i}")) {
            Some(w) => wins.push(w.clone()),
            None => return None,
        }
    }
    // LƯU Ý: Cho phép tái sử dụng cả khi overlay đang hiển thị (ví dụ người dùng đang
    // mở overlay hoặc đang kéo dở khung chụp mà bấm tiếp phím tắt chụp nhanh để chụp lại).
    // Bằng cách tăng gen và gửi overlay-session-start, React frontend sẽ tự động unmount
    // component cũ, nạp ảnh freeze mới và reset vùng chọn ngay tức thì mà không cần
    // close_overlays() rồi build() lại native window (tránh lỗi label conflict trên Windows).

    // Chuẩn bị channel nhận tín hiệu TRƯỚC KHI emit session-start để không bao giờ bị rớt tín hiệu
    let ready_rx = prepare_overlay_ready_channel(app);
    let t_prep = std::time::Instant::now();

    // Lưu session TRƯỚC khi emit: trang nào chưa kịp nghe event sẽ tự kéo về
    // lúc mount (xem `overlay_session_payloads`).
    let payloads = overlay_session_payloads(mode, record, preset, matched_idx, snaps, gen);
    store_overlay_session(app, &payloads);

    for (i, (snap, win)) in snaps.iter().zip(wins.iter()).enumerate() {
        position_overlay(app, win, snap);
        if let Err(e) = app.emit_to(win.label(), "overlay-session-start", &payloads[i]) {
            log::warn!("[SnapDoc] Gửi session tới overlay-{i} thất bại: {e}");
            return None;
        }
    }
    let prep_dur = t_prep.elapsed();

    // Chờ frontend từng overlay báo đã paint xong ảnh đóng băng, rồi mới
    // order-front những overlay đã sẵn sàng — overlay chưa xác nhận sống thì
    // KHÔNG bao giờ được show (xem `reveal_ready_overlays`).
    let t_wait = std::time::Instant::now();
    let hard_ms = OVERLAY_READY_HARD_MS_REUSE;
    let (ready, ready_rx) = wait_for_overlays_ready(app, ready_rx, gen, snaps.len(), focus_idx, hard_ms);
    let wait_dur = t_wait.elapsed();

    let t_reveal = std::time::Instant::now();
    let result = reveal_ready_overlays(app, &wins, snaps, focus_idx, gen, ready, ready_rx, hard_ms);
    let reveal_dur = t_reveal.elapsed();
    log::debug!(
        "[SnapDoc Timing] try_reuse_prewarmed_overlays breakdown: prep={:?}, wait={:?}, reveal={:?}",
        prep_dur, wait_dur, reveal_dur
    );
    Some(result)
}

/// Nhả `overlay_opening` khi ra khỏi scope của `open_overlays_ex` — kể cả qua
/// return sớm bằng `?` — để ĐẢM BẢO không có đường thoát nào quên nhả cờ.
/// Xem doc-comment `AppState::overlay_opening` để hiểu lý do cần cờ này (chặn
/// 2 lệnh mở overlay chạy chồng lên nhau, tránh lỗi build() "already exists").
pub(super) struct OverlayOpenGuard(AppHandle);
impl Drop for OverlayOpenGuard {
    fn drop(&mut self) {
        self.0
            .state::<AppState>()
            .overlay_opening
            .store(false, Ordering::SeqCst);
    }
}

pub fn open_overlays_ex(
    app: &AppHandle,
    mode: &str,
    record: bool,
    preset: Option<crate::flow::LastRecordRegion>,
) -> Result<(), String> {
    // Nếu prewarm_overlays đang chạy ngầm lúc khởi động app, chờ tối đa 600ms
    // để nó hoàn tất việc tạo pool overlay thay vì race condition hoặc rebuild.
    if app.state::<AppState>().overlay_prewarming.load(Ordering::SeqCst) {
        let t0 = std::time::Instant::now();
        while app.state::<AppState>().overlay_prewarming.load(Ordering::SeqCst) {
            if t0.elapsed() > Duration::from_millis(600) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    // Chặn 2 lệnh mở overlay chạy CHỒNG NHAU (double-click nút chụp, hotkey
    // double-fire, ...) — nếu không, cả 2 luồng có thể cùng lúc chạy
    // `close_overlays()` + build() lại đúng label `overlay-{i}`, dẫn tới lỗi
    // "a webview with label ... already exists" (xem phân tích trong hội
    // thoại/commit liên quan). Luồng tới sau bị từ chối thẳng thay vì race.
    let acquired = app
        .state::<AppState>()
        .overlay_opening
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    if !acquired {
        return Err("Đang có một phiên mở overlay khác chạy, bỏ qua yêu cầu trùng".to_string());
    }
    let _overlay_open_guard = OverlayOpenGuard(app.clone());

    // macOS: hạ về Accessory TRƯỚC khi show/focus overlay bên dưới. Verify
    // thực nghiệm (2026-07-22, panel_test/testN.m): dưới Accessory policy, gọi
    // `activateIgnoringOtherApps` + `makeKeyAndOrderFront` (đúng những gì
    // `win.set_focus()` làm) vẫn cho overlay nhận bàn phím thật (Esc/Enter/gõ
    // chú thích Chụp nhanh) NHƯNG KHÔNG đưa SnapDoc lên frontmost hệ thống —
    // app đang active trước đó giữ nguyên menu bar suốt phiên overlay. Dưới
    // Regular (chế độ mặc định vì `prewarm_capture_bar` cần Regular để giữ
    // Dock icon) thì cùng lệnh đó chắc chắn cướp menu bar. Trả lại Regular ở
    // `restore_regular_activation` khi phiên overlay/chụp/quay kết thúc.
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }

    // Snapshot từ xcap: trên macOS = POINTS (CGDisplayBounds) + CGDirectDisplayID;
    // trên Windows/Linux = physical pixels.
    let xmons = xcap::Monitor::all().map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    if xmons.is_empty() {
        return Err("Không tìm thấy màn hình nào".to_string());
    }
    let snaps: Vec<MonitorSnap> = xmons
        .iter()
        .map(|m| MonitorSnap {
            id: m.id().unwrap_or(0),
            name: m.name().unwrap_or_default(),
            is_primary: m.is_primary().unwrap_or(false),
            x: m.x().unwrap_or(0) as f64,
            y: m.y().unwrap_or(0) as f64,
            w: m.width().unwrap_or(0) as f64,
            h: m.height().unwrap_or(0) as f64,
            scale: m.scale_factor().unwrap_or(1.0).max(1.0) as f64,
        })
        .collect();

    // Kiểm tra xem cấu trúc màn hình (topology) có bị thay đổi (cắm/rút màn hình) so với pool prewarm trước đó không.
    // Nếu topology thay đổi, TUYỆT ĐỐI không tái sử dụng cửa sổ cũ vì Windows đã dồn các cửa sổ về màn hình chính
    // và làm lệch toạ độ native / DPI của WebView2.
    let topology_changed = match app.state::<AppState>().overlay_monitors.lock() {
        Ok(g) => {
            if g.is_empty() || g.len() != snaps.len() {
                true
            } else {
                g.iter().zip(snaps.iter()).any(|(old, new)| {
                    old.id != new.id
                        || (old.x - new.x).abs() > 0.5
                        || (old.y - new.y).abs() > 0.5
                        || (old.w - new.w).abs() > 0.5
                        || (old.h - new.h).abs() > 0.5
                        || (old.scale - new.scale).abs() > 0.01
                })
            }
        }
        Err(_) => true,
    };

    if let Ok(mut g) = app.state::<AppState>().overlay_monitors.lock() {
        *g = snaps.clone();
    }

    // Màn hình đang có con trỏ (toạ độ cùng hệ với snapshot).
    let cursor_idx = {
        #[cfg(target_os = "macos")]
        {
            cursor_points()
                .and_then(|(x, y)| snap_index_at(&snaps, x, y))
                .unwrap_or(0)
        }
        #[cfg(not(target_os = "macos"))]
        {
            app.cursor_position()
                .ok()
                .and_then(|p| snap_index_at(&snaps, p.x, p.y))
                .unwrap_or(0)
        }
    };

    // Khớp preset vùng quay cũ với màn hình tương ứng
    let matched_preset_idx = preset
        .as_ref()
        .and_then(|p| find_matching_monitor_index(p, &snaps));
    // Ưu tiên focus vào màn hình chứa khung preset nếu có
    let focus_idx = matched_preset_idx.unwrap_or(cursor_idx);

    // Tính gen TRƯỚC khi mở overlay (không phải sau như trước): cần nhúng
    // vào query string ngay từ navigate()/build() đầu tiên để frontend echo
    // lại đúng giá trị khi báo "đã paint xong" (xem `wait_for_overlays_ready`).
    let gen = app
        .state::<AppState>()
        .overlay_gen
        .fetch_add(1, Ordering::SeqCst)
        + 1;

    let t_reuse = std::time::Instant::now();
    let reused = if topology_changed {
        None
    } else {
        try_reuse_prewarmed_overlays(
            app,
            mode,
            record,
            preset.as_ref(),
            matched_preset_idx,
            &snaps,
            focus_idx,
            gen,
        )
    };
    log::debug!("[SnapDoc Timing] try_reuse_prewarmed_overlays: {:?}, reused={}", t_reuse.elapsed(), reused.is_some());
    match reused {
        Some(result) => result?,
        None => {
            let t_build = std::time::Instant::now();
            let ready_rx = prepare_overlay_ready_channel(app);
            close_overlays_no_prewarm(app);
            // Sau close (close xoá session) — trang mới đọc session từ query
            // string, lưu thêm để đồng nhất với nhánh reuse.
            let payloads = overlay_session_payloads(mode, record, preset.as_ref(), matched_preset_idx, &snaps, gen);
            store_overlay_session(app, &payloads);
            let mut wins = Vec::with_capacity(snaps.len());
            for (i, snap) in snaps.iter().enumerate() {
                let label = format!("overlay-{i}");
                let query = build_overlay_query(
                    mode,
                    i,
                    snap,
                    record,
                    preset.as_ref(),
                    matched_preset_idx,
                    gen,
                );
                let win = build_overlay_window_with_retry(app, &label, &query)?;

                let record_self = crate::storage::settings::is_record_self(app);
                let _ = win.set_content_protected(!record_self);
                // Chỉ định vị (ẩn) — CHƯA show(), giống nhánh reuse ở trên.
                position_overlay(app, &win, snap);
                wins.push(win);
            }

            let hard_ms = OVERLAY_READY_HARD_MS_BUILD;
            let (ready, ready_rx) = wait_for_overlays_ready(app, ready_rx, gen, snaps.len(), focus_idx, hard_ms);
            reveal_ready_overlays(app, &wins, &snaps, focus_idx, gen, ready, ready_rx, hard_ms)?;
            log::debug!("[SnapDoc Timing] rebuild overlays total: {:?}", t_build.elapsed());
        }
    }

    let handle = app.clone();
    let mode_owned = mode.to_string();

    std::thread::spawn(move || {
        input_loop(handle, gen, cursor_idx, mode_owned);
    });

    Ok(())
}

pub(super) fn snap_index_at(snaps: &[MonitorSnap], x: f64, y: f64) -> Option<usize> {
    snaps
        .iter()
        .position(|s| x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h)
}

/// Đọc con trỏ trong CÙNG hệ với snapshot. macOS = POINTS (CGEvent);
/// OS khác = physical pixels (Tauri).
pub(super) fn read_cursor(app: &AppHandle) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        cursor_points()
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.cursor_position().ok().map(|p| (p.x, p.y))
    }
}

/// Đổi toạ độ con trỏ (hệ snapshot) sang CSS px tương đối gốc overlay.
/// macOS: snapshot ở points = CSS px → trừ gốc là xong. OS khác: physical →
/// chia thêm scale.
pub(super) fn to_css(s: &MonitorSnap, cx: f64, cy: f64) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        (cx - s.x, cy - s.y)
    }
    #[cfg(not(target_os = "macos"))]
    {
        ((cx - s.x) / s.scale, (cy - s.y) / s.scale)
    }
}

/// Kích thước 1 màn hình theo đơn vị CSS px (cùng hệ với `to_css`) — dùng để
/// clamp con trỏ khi đang kéo vượt biên (xem `input_loop`).
pub(super) fn css_size(s: &MonitorSnap) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        (s.w, s.h)
    }
    #[cfg(not(target_os = "macos"))]
    {
        (s.w / s.scale, s.h / s.scale)
    }
}

/// `to_css` + clamp vào đúng biên `s` — dùng khi con trỏ đã ra khỏi màn hình
/// `s` (đang kéo/thả từ màn khác sang) để toạ độ trả về LUÔN nằm trong
/// `[0, css_w] × [0, css_h]` của `s`, không tràn ra ngoài. Dùng chung cho cả
/// `overlay-input` (di chuyển) lẫn `overlay-release` (thả chuột) trong
/// `input_loop` — nếu chỉ clamp 1 trong 2 nơi, nơi còn lại vẫn có thể phát ra
/// toạ độ tràn biên, làm khung chọn/toolbar lệch hoặc nằm ngoài viewport (bị
/// `overflow: hidden` của overlay cắt mất, xem `Overlay.tsx`).
pub(super) fn to_css_clamped(s: &MonitorSnap, cx: f64, cy: f64) -> (f64, f64) {
    let (x, y) = to_css(s, cx, cy);
    let (cw, ch) = css_size(s);
    (x.clamp(0.0, cw), y.clamp(0.0, ch))
}

/// Luồng input: poll con trỏ + nút chuột toàn cục, phát sự kiện cho overlay.
/// - `overlay-input` (idx_active, x, y): con trỏ đang ở overlay nào + toạ độ CSS.
/// - `overlay-press` / `overlay-release` (idx, x, y): cạnh nhấn/thả chuột trái.
/// - `overlay-key` (idx, "c" | "m"): cạnh nhấn phím C (copy màu) / M (thước đo)
///   — overlay không giữ focus nên phím phải đọc toàn cục như Esc.
/// Esc → luôn huỷ. Phải → huỷ, TRỪ mode "quick" sau khi đã vẽ khung (đã có ít
/// nhất 1 lần nhấn/thả chuột trái) — lúc đó chuột phải không làm gì cả, để
/// không mất khung đang vẽ (xem `QuickAnnotate` ở `Overlay.tsx`).
/// Dừng khi sang phiên mới hoặc overlay đã đóng.
pub(super) fn input_loop(app: AppHandle, gen: u64, initial_idx: usize, mode: String) {
    let mut prev_left = crate::input::left_down();
    let mut prev_right = crate::input::right_down();
    let mut prev_esc = crate::input::escape_down();
    let mut prev_c = crate::input::c_down();
    let mut prev_m = crate::input::m_down();
    let mut focused_idx: Option<usize> = Some(initial_idx);
    let mut drag_idx: Option<usize> = None;
    let mut has_dragged = false;
    // `overlay-input` lần phát gần nhất: bỏ qua tick không đổi, nhưng vẫn phát
    // lại định kỳ (HEARTBEAT) cho overlay đăng ký listener muộn / vừa load
    // xong danh sách cửa sổ (hover gợi ý cần toạ độ con trỏ hiện tại).
    const HEARTBEAT: Duration = Duration::from_millis(100);
    let mut last_input: Option<(usize, f64, f64, usize, std::time::Instant)> = None;

    loop {
        if app.state::<AppState>().overlay_gen.load(Ordering::SeqCst) != gen {
            break;
        }

        // Dùng snapshot lưu trong AppState để chỉ số khớp 1-1 với label
        // `overlay-{i}` đã tạo ở open_overlays. Không gọi lại
        // available_monitors() — tránh khác thứ tự giữa các lần gọi.
        let snaps: Vec<MonitorSnap> = match app.state::<AppState>().overlay_monitors.lock() {
            Ok(g) => g.clone(),
            Err(_) => break,
        };
        if snaps.is_empty() {
            break;
        }
        // Tra đúng label `overlay-{i}` thay vì clone cả map `webview_windows()`
        // mỗi 8ms.
        if !(0..snaps.len()).any(|i| app.get_webview_window(&format!("overlay-{i}")).is_some()) {
            break;
        }

        let left = crate::input::left_down();
        if let Some((cx, cy)) = read_cursor(&app) {
            let hit = snap_index_at(&snaps, cx, cy);

            if let Some(i) = hit {
                let s = &snaps[i];
                let (x, y) = to_css(s, cx, cy);

                if !left && focused_idx != Some(i) {
                    if let Some(win) = app.get_webview_window(&format!("overlay-{i}")) {
                        let _ = win.set_focus();
                    }
                    focused_idx = Some(i);
                }

                // Khi đang drag, mọi input/release route về overlay bắt đầu
                // drag để không "rớt" sang overlay khác giữa chừng — kể cả
                // khi con trỏ vượt biên màn hình. QUAN TRỌNG: toạ độ CSS phải
                // quy đổi theo snapshot của overlay ĐÍCH (`target_idx`), KHÔNG
                // phải overlay con trỏ đang thực sự đứng (`i`) — trộn lẫn 2 hệ
                // gốc toạ độ khác nhau (khi `i != target_idx`, tức con trỏ đã
                // sang màn hình khác) khiến x/y "nhảy cóc" về giá trị nhỏ/âm,
                // làm khung chọn bị lật (rectFrom ở frontend dùng min/abs nên
                // đảo ngược ngay khi x/y đột ngột đổi dấu/độ lớn).
                // `drag_idx` lấy từ snapshot của vòng lặp trước — nếu số màn hình
                // vừa đổi (cắm/rút màn) thì bỏ drag, KHÔNG index vượt biên (panic
                // = mất luôn Esc/chuột phải native trong khi overlay vẫn hiện).
                if drag_idx.is_some_and(|d| d >= snaps.len()) {
                    drag_idx = None;
                }
                let target_idx = drag_idx.unwrap_or(i);
                // Vùng chọn vốn không thể kéo sang màn hình khác, nên khi con
                // trỏ vượt biên, khung chỉ dừng lại đúng mép thay vì báo kích
                // thước tràn ra ngoài màn hình gốc — xem `to_css_clamped`.
                let (x, y) = if target_idx == i { (x, y) } else { to_css_clamped(&snaps[target_idx], cx, cy) };
                // Vẫn broadcast (`emit`): mọi overlay cần biết con trỏ đã rời
                // khỏi nó (`idx !== MY_IDX`). Tauri chỉ đẩy JS tới webview có
                // listener `overlay-input` (tức các overlay).
                let now = std::time::Instant::now();
                let changed = match last_input {
                    Some((li, lx, ly, ln, lt)) => {
                        li != target_idx
                            || lx != x
                            || ly != y
                            || ln != snaps.len()
                            || now.duration_since(lt) >= HEARTBEAT
                    }
                    None => true,
                };
                if changed {
                    let _ = app.emit("overlay-input", (target_idx, x, y));
                    last_input = Some((target_idx, x, y, snaps.len(), now));
                }
                if left && !prev_left {
                    drag_idx = Some(i);
                    has_dragged = true;
                    let _ = app.emit("overlay-press", (i, x, y));
                }
                if !left && prev_left {
                    let release_idx = drag_idx.take().unwrap_or(i);
                    // Nếu thả ở overlay khác, đổi hệ trục về snapshot nguồn
                    // (clamp — CÙNG lý do với nhánh di chuyển ở trên, nếu không
                    // toạ độ thả chuột có thể tràn biên dù lúc di chuyển đã
                    // được clamp đúng, làm khung/toolbar cuối cùng vẫn lệch).
                    let (rx, ry) = if release_idx != i {
                        // release_idx = drag_idx đã được kiểm tra biên ở trên.
                        to_css_clamped(&snaps[release_idx], cx, cy)
                    } else {
                        (x, y)
                    };
                    let _ = app.emit("overlay-release", (release_idx, rx, ry));
                    // Focus overlay vừa thả chuột để phím tắt công cụ hoạt động ngay.
                    if let Some(win) = app.get_webview_window(&format!("overlay-{release_idx}")) {
                        let _ = win.set_focus();
                    }
                    focused_idx = Some(release_idx);
                }
            } else if !left && prev_left {
                // Thả chuột ở NGOÀI mọi màn hình (kéo tràn ra rìa desktop ảo)
                // — cùng lý do clamp với 2 nhánh trên.
                if let Some((src_idx, src)) = drag_idx.take().and_then(|d| snaps.get(d).map(|s| (d, s))) {
                    let (rx, ry) = to_css_clamped(src, cx, cy);
                    let _ = app.emit("overlay-release", (src_idx, rx, ry));
                }
            }
        }
        prev_left = left;

        let right = crate::input::right_down();
        let esc = crate::input::escape_down();
        let right_edge = right && !prev_right;
        let right_cancels = right_edge && !(mode == "quick" && has_dragged);
        if right_cancels || (esc && !prev_esc) {
            close_overlays(&app);
            restore_regular_activation(&app);
            break;
        }
        prev_right = right;
        prev_esc = esc;

        let (c, m) = (crate::input::c_down(), crate::input::m_down());
        if let Some(idx) = focused_idx {
            if c && !prev_c {
                let _ = app.emit("overlay-key", (idx, "c"));
            }
            if m && !prev_m {
                let _ = app.emit("overlay-key", (idx, "m"));
            }
        }
        prev_c = c;
        prev_m = m;

        std::thread::sleep(Duration::from_millis(8));
    }
}

/// Đóng toàn bộ overlay (mọi màn hình).
///
/// QUAN TRỌNG: KHÔNG poll app.webview_windows() sau win.close() trên Windows.
/// win.close() gửi WM_CLOSE async — cần main thread message pump xử lý.
/// Nếu gọi từ std::thread đang được Tokio IPC thread chờ (rx.recv()), main
/// thread có thể bị stall → polling không bao giờ thấy overlay biến mất →
/// deadlock → Windows báo AppHang sau ~5 giây.
///
/// Giải pháp: gửi close rồi return ngay. Sleep cố định 150ms trong
/// finalize_window/finalize_region để DWM có thời gian unregister protected
/// surface — không cần xác nhận overlay đã đóng hẳn.
pub fn close_overlays(app: &AppHandle) {
    close_overlays_internal(app, true);
}

/// Có phiên overlay nào đang chạy không: payload phiên còn đó, một overlay
/// đang HIỆN (kể cả overlay giữ lại làm khung viền quay/chụp cuộn), hoặc
/// dialog "Chọn cửa sổ" đang mở. Không chắc (lock lỗi...) thì coi là CÓ —
/// caller khi đó đóng overlay như trước, an toàn hơn để sót một phiên.
pub(super) fn overlay_session_in_progress(app: &AppHandle) -> bool {
    let has_session = app
        .state::<AppState>()
        .overlay_session
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(true);
    has_session
        || app.get_webview_window("window-picker").is_some()
        || app
            .webview_windows()
            .iter()
            .any(|(label, w)| label.starts_with("overlay") && w.is_visible().unwrap_or(true))
}

pub fn close_overlays_no_prewarm(app: &AppHandle) {
    close_overlays_internal(app, false);
}

pub(super) fn close_overlays_internal(app: &AppHandle, should_prewarm: bool) {
    if let Ok(mut g) = app.state::<AppState>().overlay_session.lock() {
        *g = None;
    }
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay") {
            let _ = win.hide();
            let _ = win.close();
        }
    }
    // Dialog "Chọn cửa sổ" dạng lưới (`open_window_picker`) dùng chung vòng
    // đời phiên chụp/quay với pool overlay — mọi nơi gọi `close_overlays` để
    // "kết thúc phiên" (huỷ, chụp xong, chuyển sang quay...) cũng phải đóng
    // luôn dialog này nếu đang mở, dù nó không thuộc pool overlay-{i}.
    close_window_picker(app);
    // KHÔNG poll ở đây — xem comment trên.

    // Dựng lại pool overlay ẩn cho lần mở TIẾP THEO (xem `prewarm_overlays`) —
    // chạy nền, không chặn return (giữ đúng tính chất "gửi rồi return ngay"
    // đã ghi ở trên). Sleep 300ms trước khi build lại: cùng lý do timing đã
    // ghi ở trên (win.close() là async trên Windows — build() label trùng 1
    // cửa sổ vừa đóng nhưng OS/DWM chưa xử lý xong dễ lỗi/không ổn định).
    if should_prewarm {
        let handle = app.clone();
        std::thread::spawn(move || {
            #[cfg(target_os = "macos")]
            std::thread::sleep(Duration::from_millis(50));
            #[cfg(not(target_os = "macos"))]
            std::thread::sleep(Duration::from_millis(300));
            prewarm_overlays(&handle);
        });
    }
}

/// Trả `ActivationPolicy` về Regular sau khi phiên overlay (chụp ảnh/Chụp
/// nhanh/quay) kết thúc thật sự — đối xứng với việc hạ xuống Accessory ở đầu
/// `open_overlays_ex` (xem đó để biết lý do). BẮT BUỘC phải trả lại: capture-bar
/// (`prewarm_capture_bar`) cần Regular để giữ Dock icon suốt vòng đời app.
/// Gọi ở các điểm KẾT THÚC THẬT của phiên (`cancel_overlay`, bắt đầu quay,
/// chuyển sang chế độ scroll, Esc/right-click trong `input_loop`) — KHÔNG gọi
/// trong `close_overlays` dùng chung vì hàm đó còn được gọi GIỮA phiên (rebuild
/// lại overlay khi pool pre-warm không tái dùng được, xem `open_overlays_ex`),
/// trả Regular ở đó sẽ xoá mất đúng hiệu ứng Accessory vừa bật.
#[cfg(target_os = "macos")]
pub fn restore_regular_activation(app: &AppHandle) {
    use tauri::ActivationPolicy;
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
}
#[cfg(not(target_os = "macos"))]
pub fn restore_regular_activation(_app: &AppHandle) {}

/// Như `close_overlays`, TRỪ 1 cửa sổ (`keep_label`) — dùng khi bắt đầu quay
/// vùng chọn qua `RecordRegionSelect`: đóng overlay ở MỌI màn hình khác, giữ
/// lại đúng overlay nơi vùng vừa chọn — cửa sổ này tiếp tục sống SUỐT phiên
/// quay, đóng vai trò khung viền click-through (xem `flow::finalize_region`),
/// không resize/reposition/tạo lại gì cả nên không có nguồn gây nháy hình.
pub fn close_overlays_except(app: &AppHandle, keep_label: &str) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay") && label != keep_label {
            let _ = win.close();
        }
    }
    // Dừng luôn vòng lặp input_loop toàn cục (nếu không, nó vẫn tiếp tục poll
    // + emit overlay-input/press/release cho overlay còn lại dù đã hết tác
    // dụng chọn vùng) — bump generation để lần kiểm tra tiếp theo tự thoát.
    app.state::<AppState>().overlay_gen.fetch_add(1, Ordering::SeqCst);
}

/// Kết thúc THẬT SỰ 1 phiên chụp cuộn (hoàn tất hoặc huỷ) — đóng overlay đang
/// đóng vai khung viền (`close_overlays`), đồng thời:
/// 1) bump `overlay_gen` — phòng hờ trường hợp (hiếm, phụ thuộc máy) vòng lặp
///    `input_loop` của phiên chọn vùng gốc chưa kịp thoát: nếu để sót, nó có
///    thể bắt nhầm 1 cú nhấn/thả chuột TOÀN CỤC về sau (vd user vẽ shape
///    trong Editor) thành sự kiện chọn vùng trên overlay pre-warm ẩn, gọi lại
///    `finalize_region`.
/// 2) xoá `last_capture.mode` — NẾU (1) vẫn lọt lưới và 1 cú `finalize_region`
///    lạc thật sự xảy ra, nó sẽ không còn thấy mode == "scroll" nữa nên không
///    tự khởi động lại phiên chụp cuộn (đây là lớp phòng thủ THỨ HAI, độc lập
///    với (1) — chặn đúng triệu chứng "chụp cuộn tự kích hoạt lại" dù nguyên
///    nhân sâu xa là gì).
pub fn end_scroll_session(app: &AppHandle) {
    close_overlays(app);
    let state = app.state::<AppState>();
    state.overlay_gen.fetch_add(1, Ordering::SeqCst);
    state.last_capture.clear_mode();
    let _ = state.scroll_session.lock().map(|mut s| s.reset());
    let _ = state.frozen_screens.lock().map(|mut s| s.clear());
}
