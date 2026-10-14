//! Windows: quay video liên tục bằng Windows.Graphics.Capture (WGC) qua crate
//! `windows-capture` — vai trò tương đương `mac_stream.rs` bên macOS
//! (ScreenCaptureKit `SCStream`). Xem plan Phase 5
//! (`.claude/plans/sprightly-yawning-ritchie.md`) để hiểu lý do chọn WGC thay
//! vì DXGI Desktop Duplication.
//!
//! Hỗ trợ cả 3 `RecordTarget` (`Display`, `Window`, `Region`). Audio hệ thống
//! KHÔNG đi qua WGC mà qua WASAPI loopback riêng (`record::audio_wasapi`).
//!
//! KIẾN TRÚC FRAME PACING: WGC (`on_frame_arrived`) chỉ gọi callback khi nội
//! dung THỰC SỰ thay đổi — module này chỉ cập nhật "frame mới nhất"
//! (`LatestFrame`); nhịp đẩy frame vào encoder theo đúng đồng hồ của phiên
//! quay nằm ở `record::pacer` (dùng chung với macOS).
//!
//! Với màn hình tần số quét cao (144/240Hz), WGC có thể gọi callback tới
//! 144–240 lần/giây — mỗi lần đọc ngược cả khung hình từ GPU về CPU trong khi
//! encoder chỉ cần 30fps. Khi hệ điều hành hỗ trợ (`MinUpdateInterval`,
//! Windows 11), giới hạn WGC ở đúng 1/fps.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::frame::{publish, Frame, LatestFrame};
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor as WgcMonitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window as WgcWindow;
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use std::sync::Arc;

/// Phạm vi quay — cùng hình dạng với `mac_stream::RecordTarget` để
/// `record/mod.rs` dùng chung 1 kiểu dispatch cho cả 2 nền tảng.
pub enum RecordTarget {
    /// Toàn bộ 1 màn hình, `display_id` là id từ `xcap::Monitor::id()` (cùng
    /// id dùng cho overlay chọn màn hình + chụp ảnh).
    Display(u32),
    /// 1 vùng trong 1 màn hình — `x,y,w,h` là pixel vật lý, LOCAL theo gốc
    /// màn hình (cùng hệ toạ độ `flow::finalize_region` đã tính cho chụp ảnh
    /// vùng). WGC không có `sourceRect` như SCStream nên `start()` quay
    /// nguyên `display_id` rồi tự crop trong `on_frame_arrived`.
    Region { display_id: u32, x: f64, y: f64, w: f64, h: f64 },
    /// 1 cửa sổ theo id từ `xcap::Window::id()`, map sang `HWND` trong
    /// `resolve_window`.
    Window(u32),
}

/// Làm tròn XUỐNG số chẵn gần nhất — `yuv420p` bắt buộc width/height chẵn.
fn even_floor(v: u32) -> u32 {
    v & !1
}

struct CapturerFlags {
    latest: LatestFrame,
    stopped_externally: Arc<AtomicBool>,
    /// Kích thước ĐÃ làm tròn chẵn, khớp đúng `-s WxH` đã khai với `Encoder` —
    /// MỌI frame gửi đi phải đúng kích thước này.
    target_width: u32,
    target_height: u32,
    /// Góc trên-trái của vùng cần crop trong frame WGC (pixel vật lý) — khác
    /// 0 chỉ khi quay `Region`.
    crop_x: u32,
    crop_y: u32,
}

struct Capturer {
    latest: LatestFrame,
    stopped_externally: Arc<AtomicBool>,
    target_width: u32,
    target_height: u32,
    crop_x: u32,
    crop_y: u32,
    /// Buffer của frame cũ (không còn ai giữ) để tái dùng.
    spare_buf: Option<Vec<u8>>,
}

impl GraphicsCaptureApiHandler for Capturer {
    type Flags = CapturerFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            latest: ctx.flags.latest,
            stopped_externally: ctx.flags.stopped_externally,
            target_width: ctx.flags.target_width,
            target_height: ctx.flags.target_height,
            crop_x: ctx.flags.crop_x,
            crop_y: ctx.flags.crop_y,
            spare_buf: None,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WgcFrame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let src_width = frame.width();
        let src_height = frame.height();
        // KHÔNG trả lỗi ra ngoài: windows-capture coi lỗi của callback là dừng
        // hẳn phiên capture mà KHÔNG gọi `on_closed` → video đứng hình âm thầm.
        // 1 frame đọc lỗi (GPU bận, đổi chế độ hiển thị...) thì bỏ qua frame đó.
        let Ok(mut buffer) = frame.buffer() else { return Ok(()) };
        let row_pitch = buffer.row_pitch() as usize;
        let raw = buffer.as_raw_buffer();
        // Guard: buffer lệch với kích thước báo về → bỏ frame (panic trong
        // callback FFI = unwind qua biên C++ = abort cả app).
        if row_pitch < (src_width as usize) * 4 || raw.len() < (src_height as usize).saturating_sub(1) * row_pitch + (src_width as usize) * 4 {
            return Ok(());
        }

        // Luôn crop/pad về ĐÚNG (target_width, target_height) đã khai với
        // encoder, bắt đầu từ (crop_x, crop_y): xử lý làm tròn chẵn, frame
        // thật lệch vài pixel so với ước tính ban đầu, cửa sổ bị resize, và
        // là bước crop THẬT cho `RecordTarget::Region`.
        let avail_w = src_width.saturating_sub(self.crop_x);
        let avail_h = src_height.saturating_sub(self.crop_y);
        let copy_w = self.target_width.min(avail_w) as usize;
        let copy_h = self.target_height.min(avail_h) as usize;
        let dst_row_len = (self.target_width as usize) * 4;
        let copy_row_bytes = copy_w * 4;
        let needed_len = dst_row_len * self.target_height as usize;

        let mut bgra = match self.spare_buf.take() {
            Some(v) if v.len() == needed_len => v,
            _ => vec![0u8; needed_len],
        };
        // Chỉ cần xoá nền khi nguồn KHÔNG phủ kín khung đích (cửa sổ bị thu nhỏ
        // giữa chừng) — trường hợp thường gặp mọi byte đều bị ghi đè bên dưới.
        if copy_w < self.target_width as usize || copy_h < self.target_height as usize {
            bgra.fill(0);
        }
        for y in 0..copy_h {
            let src_off = (y + self.crop_y as usize) * row_pitch + (self.crop_x as usize) * 4;
            let dst_off = y * dst_row_len;
            if src_off + copy_row_bytes > raw.len() {
                break;
            }
            bgra[dst_off..dst_off + copy_row_bytes].copy_from_slice(&raw[src_off..src_off + copy_row_bytes]);
        }

        let new_frame = Frame { bgra, width: self.target_width, height: self.target_height };
        if let Some(buf) = publish(&self.latest, new_frame) {
            if buf.len() == needed_len {
                self.spare_buf = Some(buf);
            }
        }
        Ok(())
    }

    /// WGC gọi khi phiên capture kết thúc NGOÀI Ý MUỐN (màn hình bị ngắt, cửa
    /// sổ đang quay bị đóng...) — vai trò giống `stream:didStopWithError:` bên macOS.
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.stopped_externally.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Tìm `windows_capture::monitor::Monitor` khớp `display_id` (id từ
/// `xcap::Monitor::id()`, dùng chung cho overlay chọn màn hình). Windows-capture
/// không có API "tạo theo id của xcap" — đối chiếu qua VỊ TRÍ trong danh sách
/// liệt kê của cả 2 crate (giả định thứ tự liệt kê giống nhau vì cùng dựa
/// trên `EnumDisplayMonitors` của hệ điều hành — CẦN xác minh trên máy thật,
/// xem mục "Xác định monitor/window" trong plan Phase 5; nếu lệch, đổi sang
/// đối chiếu theo toạ độ/kích thước màn hình thay vì theo vị trí index).
/// Trả `(monitor, không_xác_minh_được)` — `true` khi phải đoán theo thứ tự
/// liệt kê hoặc rơi về màn hình chính.
fn resolve_monitor(display_id: u32) -> Result<(WgcMonitor, bool), String> {
    let mut wgc_monitors = WgcMonitor::enumerate().map_err(|e| format!("Không liệt kê được màn hình (WGC): {e}"))?;
    if wgc_monitors.is_empty() {
        return WgcMonitor::primary()
            .map(|m| (m, false))
            .map_err(|e| format!("Không tìm thấy màn hình để quay: {e}"));
    }
    if wgc_monitors.len() == 1 {
        return Ok((wgc_monitors.remove(0), false));
    }

    // 1. Ưu tiên đối chiếu trực tiếp qua handle HMONITOR của WgcMonitor
    if let Some(pos) = wgc_monitors
        .iter()
        .position(|m| (m.as_raw_hmonitor() as usize as u32) == display_id)
    {
        return Ok((wgc_monitors.remove(pos), false));
    }

    // 2. Thử dựng WgcMonitor trực tiếp từ HMONITOR nếu handle hợp lệ
    let raw_hmon = display_id as i32 as isize as *mut std::ffi::c_void;
    let direct = WgcMonitor::from_raw_hmonitor(raw_hmon);
    if direct.device_name().is_ok() {
        return Ok((direct, false));
    }

    // 3. Fallback: đối chiếu qua xcap::Monitor (theo index hoặc kích thước)
    let xcap_monitors = xcap::Monitor::all().map_err(|e| format!("Không liệt kê được màn hình: {e}"))?;
    let target = xcap_monitors
        .iter()
        .enumerate()
        .find(|(_, m)| m.id().map(|i| i == display_id).unwrap_or(false));

    if let Some((index, xcap_m)) = target {
        // Kích thước của màn hình cần quay theo xcap — dùng để XÁC MINH ứng
        // viên WGC, vì thứ tự liệt kê giữa 2 crate KHÔNG được đảm bảo giống
        // nhau: cùng dựa trên EnumDisplayMonitors nhưng khác phiên bản/filter
        // có thể lệch → quay nhầm màn hình trên setup nhiều màn hình.
        let want_w = xcap_m.width().unwrap_or(0);
        let want_h = xcap_m.height().unwrap_or(0);

        // Ưu tiên 1: đúng index VÀ khớp kích thước (trường hợp bình thường).
        // Ưu tiên 2: bất kỳ monitor WGC nào khớp kích thước duy nhất — cứu
        // được trường hợp 2 danh sách lệch thứ tự (miễn các màn hình không
        // trùng độ phân giải). Cuối cùng mới rơi về đúng index bất kể kích
        // thước (hành vi cũ), rồi primary.
        let size_of = |m: &WgcMonitor| -> (u32, u32) {
            (m.width().unwrap_or(0), m.height().unwrap_or(0))
        };
        let by_index_ok = wgc_monitors
            .get(index)
            .map(|m| want_w > 0 && size_of(m) == (want_w, want_h))
            .unwrap_or(false);
        if by_index_ok {
            return wgc_monitors.into_iter().nth(index)
                .map(|m| (m, false))
                .ok_or_else(|| format!("Không lấy được monitor theo index {index}"));
        }
        if want_w > 0 {
            let matches: Vec<usize> = wgc_monitors
                .iter()
                .enumerate()
                .filter(|(_, m)| size_of(m) == (want_w, want_h))
                .map(|(i, _)| i)
                .collect();
            if matches.len() == 1 {
                return wgc_monitors.into_iter().nth(matches[0])
                    .map(|m| (m, false))
                    .ok_or_else(|| format!("Không lấy được monitor theo index {}", matches[0]));
            }
        }
        if let Some(m) = wgc_monitors.into_iter().nth(index) {
            // Chỉ khớp theo thứ tự liệt kê, không xác minh được — có thể nhầm màn hình.
            return Ok((m, true));
        }
    }
    // Không khớp được — quay màn hình chính còn hơn báo lỗi hẳn, nhưng phải báo
    // người dùng (trước đây im lặng quay nhầm màn hình).
    WgcMonitor::primary()
        .map(|m| (m, true))
        .map_err(|e| format!("Không tìm thấy màn hình để quay: {e}"))
}

/// Tìm `windows_capture::window::Window` khớp `window_id` (id từ
/// `xcap::Window::id()`, dùng chung cho overlay chọn cửa sổ). Ép kiểu TRỰC
/// TIẾP `window_id` (u32) ngược lại thành `HWND` — giả định `xcap::Window::id()`
/// trên Windows chính là giá trị `HWND` (CẦN xác minh trên máy thật, xem mục
/// "Xác định monitor/window" trong plan Phase 5). Nếu quay NHẦM cửa sổ, đổi
/// sang đối chiếu qua `WgcWindow::enumerate()` + `title()`/`process_id()`
/// thay vì ép kiểu thẳng.
fn resolve_window(window_id: u32) -> Result<WgcWindow, String> {
    // Ưu tiên đối chiếu qua danh sách cửa sổ THẬT của WGC: tìm cửa sổ có HWND
    // (truncate về u32 — handle Win32 theo spec tương thích 32-bit) khớp id —
    // tránh tự dựng lại HWND từ u32 với rủi ro sign-extension/truncation sai.
    if let Ok(windows) = WgcWindow::enumerate() {
        if let Some(w) = windows
            .into_iter()
            .find(|w| (w.as_raw_hwnd() as usize as u32) == window_id)
        {
            return Ok(w);
        }
    }
    // Fallback hành vi cũ: dựng HWND trực tiếp từ id (đúng khi
    // `xcap::Window::id()` chính là giá trị HWND).
    let hwnd = window_id as i32 as isize as *mut std::ffi::c_void;
    let window = WgcWindow::from_raw_hwnd(hwnd);
    if !window.is_valid() {
        return Err("Cửa sổ không còn hợp lệ để quay (có thể đã đóng hoặc bị thu nhỏ)".to_string());
    }
    Ok(window)
}

/// Kích thước THẬT của 1 cửa sổ để khởi tạo encoder TRƯỚC khi frame đầu tiên
/// từ WGC tới — dùng `DWMWA_EXTENDED_FRAME_BOUNDS` (không dùng
/// `Window::rect()`/`GetWindowRect`, vì hàm đó tính CẢ viền bóng đổ vô hình do
/// DWM vẽ thêm, thường lệch vài pixel so với nội dung WGC thực sự quay —
/// crate `windows-capture` cũng tự dùng đúng API này nội bộ cho
/// `title_bar_height()`, xem window.rs).
fn window_capture_size(hwnd: *mut std::ffi::c_void) -> Result<(u32, u32), String> {
    use windows_sys::Win32::Foundation::RECT;
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if hr != 0 {
        return Err(format!("Không đọc được kích thước cửa sổ (DwmGetWindowAttribute lỗi, HRESULT={hr:#x})"));
    }
    let width = (rect.right - rect.left).max(0) as u32;
    let height = (rect.bottom - rect.top).max(0) as u32;
    if width == 0 || height == 0 {
        return Err("Cửa sổ có kích thước 0, không thể quay".to_string());
    }
    Ok((width, height))
}

/// Phiên quay đang chạy — giữ `CaptureControl` (thread nền của WGC) cho tới
/// khi `stop()`. `control` bọc `Option` để cả `stop()` lẫn `Drop` (lưới an
/// toàn cho nhánh lỗi lúc khởi động) đều lấy ra dừng được.
pub struct RecordingHandle {
    control: Option<CaptureControl<Capturer, Box<dyn std::error::Error + Send + Sync>>>,
    latest: LatestFrame,
    stopped_externally: Arc<AtomicBool>,
    pub width: u32,
    pub height: u32,
    /// Cảnh báo cho người dùng (vd không xác định chắc chắn được màn hình cần quay).
    pub warning: Option<String>,
}

impl RecordingHandle {
    /// Ô frame mới nhất — `record::pacer` đọc theo nhịp fps.
    pub fn latest(&self) -> LatestFrame {
        self.latest.clone()
    }

    /// WGC đã tự dừng phiên capture ngoài ý muốn hay chưa — kể cả khi thread
    /// capture của windows-capture tự kết thúc vì lỗi (không qua `on_closed`).
    pub fn is_stopped_externally(&self) -> bool {
        self.stopped_externally.load(Ordering::SeqCst)
            || self.control.as_ref().map(|c| c.is_finished()).unwrap_or(false)
    }

    /// Dừng phiên WGC qua `CaptureControl::stop()`.
    pub fn stop(mut self) -> Result<(), String> {
        let control = self.control.take();
        if self.stopped_externally.load(Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(control) = control {
            control.stop().map_err(|e| format!("Lỗi dừng quay: {e}"))?;
        }
        Ok(())
    }
}

impl Drop for RecordingHandle {
    fn drop(&mut self) {
        let Some(control) = self.control.take() else { return };
        if !self.stopped_externally.load(Ordering::SeqCst) {
            eprintln!("[SnapDoc][record] RecordingHandle bị drop khi chưa stop() — dừng WGC khẩn cấp");
            let _ = control.stop();
        }
    }
}

/// Bắt đầu quay theo `RecordTarget` (audio hệ thống trên Windows đi riêng
/// qua WASAPI loopback, xem `record::audio_wasapi`).
pub fn start(target: RecordTarget, fps: u32) -> Result<RecordingHandle, String> {
    let stopped_externally = Arc::new(AtomicBool::new(false));
    let latest = super::frame::new_latest();
    let min_interval = if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
        MinimumUpdateIntervalSettings::Custom(Duration::from_secs_f64(1.0 / fps.max(1) as f64))
    } else {
        MinimumUpdateIntervalSettings::Default
    };

    // Tắt viền vàng mặc định của Windows (WGC) nếu hệ thống hỗ trợ (Windows 10 2004+ / Windows 11),
    // vì SnapDoc đã có khung viền riêng (RecordBorder / overlay).
    let draw_border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };
    // WGC luôn trả đủ độ phân giải (khung > 4K do encoder thu nhỏ, xem
    // `record::encoder`) — ở đây chỉ cần làm tròn chẵn.
    let max = |w: u32, h: u32| (even_floor(w).max(2), even_floor(h).max(2));
    let flags = |w: u32, h: u32, crop_x: u32, crop_y: u32| CapturerFlags {
        latest: latest.clone(),
        stopped_externally: stopped_externally.clone(),
        target_width: w,
        target_height: h,
        crop_x,
        crop_y,
    };

    // `Settings<Flags, T>` khác kiểu cụ thể giữa `Monitor` và `Window` (T khác
    // nhau) nên mỗi nhánh tự dựng settings + gọi `start_free_threaded`.
    let mut warning = None;
    let fallback_msg = "Không xác định chắc chắn được màn hình đã chọn — có thể đang quay nhầm màn hình (đã dùng màn hình chính/khớp theo thứ tự).";
    let (control, width, height) = match target {
        RecordTarget::Display(display_id) => {
            let (monitor, fallback) = resolve_monitor(display_id)?;
            if fallback {
                warning = Some(fallback_msg.to_string());
            }
            let (width, height) = max(
                monitor.width().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?,
                monitor.height().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?,
            );
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                draw_border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags(width, height, 0, 0),
            );
            let control = Capturer::start_free_threaded(settings)
                .map_err(|e| format!("Không bắt đầu quay (Windows.Graphics.Capture): {e}"))?;
            (control, width, height)
        }
        RecordTarget::Window(window_id) => {
            let window = resolve_window(window_id)?;
            let (raw_width, raw_height) = window_capture_size(window.as_raw_hwnd())?;
            let (width, height) = max(raw_width, raw_height);
            let settings = Settings::new(
                window,
                CursorCaptureSettings::Default,
                draw_border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags(width, height, 0, 0),
            );
            let control = Capturer::start_free_threaded(settings)
                .map_err(|e| format!("Không bắt đầu quay (Windows.Graphics.Capture): {e}"))?;
            (control, width, height)
        }
        RecordTarget::Region { display_id, x, y, w, h } => {
            // WGC không có `sourceRect` — quay NGUYÊN màn hình rồi crop trong `on_frame_arrived`.
            let (monitor, fallback) = resolve_monitor(display_id)?;
            if fallback {
                warning = Some(fallback_msg.to_string());
            }
            let full_width = monitor.width().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?;
            let full_height = monitor.height().map_err(|e| format!("Không đọc được kích thước màn hình: {e}"))?;
            let crop_x = x.max(0.0).round() as u32;
            let crop_y = y.max(0.0).round() as u32;
            let width = even_floor(w.max(0.0).round() as u32).min(even_floor(full_width.saturating_sub(crop_x)));
            let height = even_floor(h.max(0.0).round() as u32).min(even_floor(full_height.saturating_sub(crop_y)));
            if width < 2 || height < 2 {
                return Err("Vùng chọn không hợp lệ để quay".to_string());
            }
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                draw_border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags(width, height, crop_x, crop_y),
            );
            let control = Capturer::start_free_threaded(settings)
                .map_err(|e| format!("Không bắt đầu quay (Windows.Graphics.Capture): {e}"))?;
            (control, width, height)
        }
    };

    Ok(RecordingHandle { control: Some(control), latest, stopped_externally, width, height, warning })
}
