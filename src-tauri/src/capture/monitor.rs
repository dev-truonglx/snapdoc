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

