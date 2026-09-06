use std::collections::HashMap;

#[cfg_attr(target_os = "macos", allow(unused_imports))]
use image::codecs::jpeg::JpegEncoder;
#[cfg_attr(target_os = "macos", allow(unused_imports))]
use image::ImageEncoder;
use xcap::Monitor;

/// Chụp toàn bộ N màn hình SONG SONG (spawn thread / join) rồi encode JPEG
/// quality 85 — dùng làm "frozen screen" background của overlay để màn hình
/// trông đóng băng khi user kéo vùng chọn (giống Snagit/Lightshot).
///
/// Trả `HashMap<usize, Vec<u8>>` trong đó key = chỉ số màn hình (khớp với
/// label `overlay-{i}` và `overlay_monitors[i]`), value = JPEG binary bytes.
/// Frontend nhận qua Binary IPC (Response / ArrayBuffer) và tạo Blob URL.
///
/// Lỗi trên một màn hình cụ thể được bỏ qua lặng lẽ (overlay vẫn mở, chỉ là
/// không có frozen background cho màn đó) thay vì huỷ cả phiên.
#[allow(dead_code)]
pub fn capture_frozen_screens() -> HashMap<usize, Vec<u8>> {
    capture_frozen_screens_ex(&[])
}

/// Phiên bản nội bộ nhận danh sách monitor IDs cần exclude (để không chụp freeze).
/// Được gọi từ `flow.rs` để loại bỏ editor/settings/history monitors.
/// Chụp ảnh đóng băng toàn bộ màn hình và STREAM trực tiếp kết quả vào `AppState.frozen_screens`
/// ngay khi từng màn hình nén xong, đồng thời gọi `cvar.notify_all()` để webview tương ứng
/// nhận ảnh và vẽ ngay lập tức.
pub fn capture_frozen_screens_streaming(
    app: &tauri::AppHandle,
    exclude_monitor_ids: &[u32],
) {
    let monitors = match Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[SnapDoc][freeze] Không liệt kê được màn hình: {e}");
            return;
        }
    };

    #[cfg(target_os = "macos")]
    {
        let _ = exclude_monitor_ids;
        let t_total = std::time::Instant::now();
        let targets: Vec<(usize, u32)> = monitors
            .iter()
            .enumerate()
            .filter_map(|(i, m)| m.id().ok().map(|id| (i, id)))
            .collect();

        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();

        super::mac_sck::capture_displays_excluding_own_app_jpeg(&targets, 0.8, |idx, res| {
            match res {
                Ok(buf) => {
                    if let Ok(mut g) = state.frozen_screens.lock() {
                        g.insert(idx, buf);
                    }
                    state.frozen_screens_cvar.notify_all();
                    eprintln!("[SnapDoc Timing] stream display {idx} ready (hardware jpeg)");
                }
                Err(e) => {
                    eprintln!("[SnapDoc][freeze] Màn hình {idx} lỗi: {e}");
                }
            }
        });
        eprintln!("[SnapDoc Timing] capture_frozen_screens_streaming total: {:?}", t_total.elapsed());
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::Manager;
        let state = app.state::<crate::state::AppState>();
        let points: Vec<(usize, i32, i32, u32)> = monitors
            .iter()
            .enumerate()
            .filter_map(|(i, m)| match (m.x(), m.y(), m.id()) {
                (Ok(x), Ok(y), Ok(id)) => {
                    if exclude_monitor_ids.contains(&id) {
                        return None;
                    }
                    Some((i, x, y, id))
                }
                _ => None,
            })
            .collect();

        std::thread::scope(|s| {
            for (i, x, y, _id) in points {
                let state_ref = &state;
                s.spawn(move || {
                    let result = Monitor::from_point(x, y)
                        .map_err(|e| format!("Không tìm lại được màn hình: {e}"))
                        .and_then(|m| capture_one_jpeg(&m));
                    if let Ok(bytes) = result {
                        if let Ok(mut g) = state_ref.frozen_screens.lock() {
                            g.insert(i, bytes);
                        }
                        state_ref.frozen_screens_cvar.notify_all();
                    }
                });
            }
        });
    }
}

/// Phiên bản nội bộ nhận danh sách monitor IDs cần exclude (để không chụp freeze).
/// Được gọi từ `flow.rs` để loại bỏ editor/settings/history monitors.
pub fn capture_frozen_screens_ex(exclude_monitor_ids: &[u32]) -> HashMap<usize, Vec<u8>> {
    let monitors = match Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[SnapDoc][freeze] Không liệt kê được màn hình: {e}");
            return HashMap::new();
        }
    };

    #[cfg(target_os = "macos")]
    {
        let _ = exclude_monitor_ids;
        let targets: Vec<(usize, u32)> = monitors
            .iter()
            .enumerate()
            .filter_map(|(i, m)| m.id().ok().map(|id| (i, id)))
            .collect();

        use std::sync::Mutex;
        let result = Mutex::new(HashMap::new());
        super::mac_sck::capture_displays_excluding_own_app_jpeg(&targets, 0.85, |idx, res| {
            match res {
                Ok(buf) => {
                    result.lock().unwrap().insert(idx, buf);
                }
                Err(e) => {
                    eprintln!("[SnapDoc][freeze] Màn hình {idx} lỗi: {e}");
                }
            }
        });
        result.into_inner().unwrap()
    }

    #[cfg(not(target_os = "macos"))]
    {
        let points: Vec<(usize, i32, i32, u32)> = monitors
            .iter()
            .enumerate()
            .filter_map(|(i, m)| match (m.x(), m.y(), m.id()) {
                (Ok(x), Ok(y), Ok(id)) => {
                    if exclude_monitor_ids.contains(&id) {
                        eprintln!("[SnapDoc][freeze] Bỏ qua màn hình {i} (display_id={id}) vì chứa cửa sổ editor");
                        return None;
                    }
                    Some((i, x, y, id))
                }
                _ => {
                    eprintln!("[SnapDoc][freeze] Màn hình {i}: không đọc được toạ độ hoặc id");
                    None
                }
            })
            .collect();

        let handles: Vec<_> = points
            .into_iter()
            .map(|(i, x, y, _id)| {
                std::thread::spawn(move || -> (usize, Option<Vec<u8>>) {
                    let result = Monitor::from_point(x, y)
                        .map_err(|e| format!("Không tìm lại được màn hình: {e}"))
                        .and_then(|m| capture_one_jpeg(&m));
                    match result {
                        Ok(bytes) => (i, Some(bytes)),
                        Err(e) => {
                            eprintln!("[SnapDoc][freeze] Màn hình {i} lỗi: {e}");
                            (i, None)
                        }
                    }
                })
            })
            .collect();

        let mut result = HashMap::new();
        for h in handles {
            if let Ok((i, Some(bytes))) = h.join() {
                result.insert(i, bytes);
            }
        }
        result
    }
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn capture_one_jpeg(m: &Monitor) -> Result<Vec<u8>, String> {
    let t0 = std::time::Instant::now();
    // Chụp raw RGBA.
    let raw = capture_raw(m)?;
    let t_raw = t0.elapsed();

    // Encode JPEG quality 85 vào buffer.
    let mut buf: Vec<u8> = Vec::new();
    let t1 = std::time::Instant::now();
    let rgb: image::RgbImage = image::DynamicImage::ImageRgba8(raw).into_rgb8();
    let t_rgb = t1.elapsed();

    let t2 = std::time::Instant::now();
    JpegEncoder::new_with_quality(&mut buf, 85)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("Lỗi encode JPEG: {e}"))?;
    let t_jpeg = t2.elapsed();

    eprintln!("[SnapDoc Timing] freeze capture_one_jpeg: total={:?}, raw={:?}, into_rgb8={:?}, jpeg_encode={:?}",
        t0.elapsed(), t_raw, t_rgb, t_jpeg);

    Ok(buf)
}

/// Chụp 1 màn hình thành RgbaImage thô — dùng backend phù hợp theo OS.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn capture_raw(m: &Monitor) -> Result<image::RgbaImage, String> {
    #[cfg(target_os = "macos")]
    {
        // macOS: dùng ScreenCaptureKit qua `capture_display_excluding_own_app`
        // — loại trừ TOÀN BỘ cửa sổ của chính app (editor, capture-bar, ...)
        // khỏi ảnh ở tầng content-filter thay vì dựa vào `hide()` + sleep, nên
        // freeze KHÔNG BAO GIỜ dính "bóng mờ" của cửa sổ app dù nó vừa ẩn/đang
        // animate. Vẫn include menu bar (mặc định của filter dạng
        // `excludingApplications`, xem doc `SCContentFilter`).
        let id = m.id().map_err(|e| format!("Lỗi đọc id: {e}"))?;
        super::mac_sck::capture_display_excluding_own_app(id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        m.capture_image()
            .map_err(|e| format!("Lỗi chụp màn hình: {e}"))
    }
}
