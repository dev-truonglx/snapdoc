//! Thống kê sử dụng ẩn danh qua Aptabase — CHỈ 2 sự kiện:
//! `app_started` và `capture_done`. Không gửi thao tác chỉnh sửa, phím bấm,
//! đường dẫn hay nội dung ảnh. Mỗi máy được nhận diện bằng 1 UUID ngẫu nhiên
//! sinh lần đầu chạy (`telemetry_id` trong thư mục config), không liên quan
//! tới tài khoản hay phần cứng.
//!
//! Key lấy lúc build từ `APTABASE_KEY` (xem build.rs); không có key → no-op.

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_aptabase::EventTracker;

fn app_key() -> Option<&'static str> {
    option_env!("APTABASE_KEY").filter(|k| !k.is_empty())
}

/// Plugin Aptabase, hoặc `None` nếu build không có key.
pub fn plugin<R: Runtime>() -> Option<tauri::plugin::TauriPlugin<R>> {
    // Crash reporting bật cả bản dev lẫn release: panic Rust + lỗi JS chưa bắt.
    app_key().map(|k| tauri_plugin_aptabase::Builder::new(k).with_crash_reporting().build())
}

fn device_id(app: &AppHandle) -> String {
    let Ok(dir) = app.path().app_config_dir() else {
        return "unknown".into();
    };
    let path = dir.join("telemetry_id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&path, &id);
    id
}

fn track(app: &AppHandle, name: &str, extra: Option<(&str, &str)>) {
    if app_key().is_none() {
        return;
    }
    let mut props = json!({ "device": device_id(app) });
    if let Some((k, v)) = extra {
        props[k] = json!(v);
    }
    let _ = app.track_event(name, Some(props));
}

pub fn app_started(app: &AppHandle) {
    track(app, "app_started", None);
}

/// `kind`: "image" | "video".
pub fn capture_done(app: &AppHandle, kind: &str) {
    track(app, "capture_done", Some(("kind", kind)));
}
