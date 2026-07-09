use xcap::Monitor;

/// Màn hình chính (fallback khi không xác định được theo điểm).
pub fn primary() -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    let mut fallback: Option<Monitor> = None;
    for m in monitors {
        if m.is_primary().unwrap_or(false) {
            return Ok(m);
        }
        if fallback.is_none() {
            fallback = Some(m);
        }
    }
    fallback.ok_or_else(|| "Không tìm thấy màn hình nào".to_string())
}

/// Màn hình chứa điểm (x,y) theo POINTS (global). Fallback về primary.
pub fn at_point(x: i32, y: i32) -> Result<Monitor, String> {
    Monitor::from_point(x, y).or_else(|_| primary())
}

/// Tìm màn hình theo id (`xcap::Monitor::id()`) — dùng khi chỉ có id sẵn
/// (vd `display_id` lưu lại từ lúc bắt đầu quay), không có toạ độ điểm để
/// tra qua `at_point`.
pub fn by_id(display_id: u32) -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    monitors
        .into_iter()
        .find(|m| m.id().map(|i| i == display_id).unwrap_or(false))
        .ok_or_else(|| "Không tìm thấy màn hình với id này".to_string())
}
