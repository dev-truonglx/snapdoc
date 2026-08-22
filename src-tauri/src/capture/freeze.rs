use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::jpeg::JpegEncoder;
use image::ImageEncoder;
use xcap::Monitor;

/// Chụp toàn bộ N màn hình SONG SONG (spawn thread / join) rồi encode JPEG
/// quality 85 — dùng làm "frozen screen" background của overlay để màn hình
/// trông đóng băng khi user kéo vùng chọn (giống Snagit/Lightshot).
///
/// Trả `HashMap<usize, String>` trong đó key = chỉ số màn hình (khớp với
/// label `overlay-{i}` và `overlay_monitors[i]`), value = JPEG base64 TRẦN
/// (không có prefix `data:image/jpeg;base64,`). Frontend tự ghép prefix khi
/// dùng làm `backgroundImage`.
///
/// Lỗi trên một màn hình cụ thể được bỏ qua lặng lẽ (overlay vẫn mở, chỉ là
/// không có frozen background cho màn đó) thay vì huỷ cả phiên.
#[allow(dead_code)]
pub fn capture_frozen_screens() -> HashMap<usize, String> {
    capture_frozen_screens_ex(&[])
}

/// Phiên bản nội bộ nhận danh sách monitor IDs cần exclude (để không chụp freeze).
/// Được gọi từ `flow.rs` để loại bỏ editor/settings/history monitors.
pub fn capture_frozen_screens_ex(exclude_monitor_ids: &[u32]) -> HashMap<usize, String> {
    let monitors = match Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[SnapDoc][freeze] Không liệt kê được màn hình: {e}");
            return HashMap::new();
        }
    };

    // Chỉ lấy toạ độ (i32, Send) TRƯỚC khi spawn thread rồi move nguyên `Monitor`
    // qua closure: trên Windows `Monitor` bọc `HMONITOR` (`*mut c_void`) nên
    // KHÔNG phải `Send` → move vào `std::thread::spawn` gây lỗi biên dịch
    // E0277 (chỉ lộ ra khi build cho Windows, macOS thì Monitor là Send nên
    // không phát hiện được lúc dev trên máy Mac). Mỗi thread tự dựng lại
    // Monitor bằng `Monitor::from_point` từ toạ độ top-left của chính màn đó.
    let points: Vec<(usize, i32, i32, u32)> = monitors
        .iter()
        .enumerate()
        .filter_map(|(i, m)| match (m.x(), m.y(), m.id()) {
            (Ok(x), Ok(y), Ok(id)) => {
                // Bỏ qua màn hình chứa editor/settings/history — CHỈ áp dụng
                // ngoài macOS. Trên macOS, `capture_raw` dùng
                // `mac_sck::capture_display_excluding_own_app` để loại trừ
                // TOÀN BỘ cửa sổ của chính app khỏi ảnh ở tầng ScreenCaptureKit
                // (không phụ thuộc `hide()`/timing), nên màn hình chứa editor
                // vẫn freeze bình thường — chỉ là không "lộ" cửa sổ app vào
                // ảnh, không cần bỏ qua nguyên màn hình như trước nữa.
                if !cfg!(target_os = "macos") && exclude_monitor_ids.contains(&id) {
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
            std::thread::spawn(move || -> (usize, Option<String>) {
                let result = Monitor::from_point(x, y)
                    .map_err(|e| format!("Không tìm lại được màn hình: {e}"))
                    .and_then(|m| capture_one_jpeg(&m));
                match result {
                    Ok(b64) => (i, Some(b64)),
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
        if let Ok((i, Some(b64))) = h.join() {
            result.insert(i, b64);
        }
    }
    result
}

/// Chụp 1 màn hình → encode JPEG quality 85 → trả base64 trần.
fn capture_one_jpeg(m: &Monitor) -> Result<String, String> {
    // Chụp raw RGBA.
    let raw = capture_raw(m)?;

    // Encode JPEG quality 85 vào buffer.
    let mut buf: Vec<u8> = Vec::new();
    // image::RgbaImage → JpegEncoder chỉ nhận RGB (không có alpha), cần
    // chuyển sang RgbImage trước.
    let rgb: image::RgbImage = image::DynamicImage::ImageRgba8(raw).into_rgb8();
    JpegEncoder::new_with_quality(&mut buf, 85)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("Lỗi encode JPEG: {e}"))?;

    Ok(STANDARD.encode(&buf))
}

/// Chụp 1 màn hình thành RgbaImage thô — dùng backend phù hợp theo OS.
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
