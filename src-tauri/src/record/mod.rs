//! Điều phối 1 phiên quay màn hình: nối `capture::mac_stream` (frame BGRA
//! thật từ ScreenCaptureKit) với `encoder` (ffmpeg) + quản lý vòng đời qua
//! `RecordingState` (managed trong Tauri) và tray icon "đang quay" (`tray.rs`).
//!
//! v1: chỉ macOS, không audio, fps cố định. Phase 3 thêm chọn PHẠM VI quay
//! (màn hình cụ thể / vùng chọn / cửa sổ) qua overlay chọn vùng có sẵn của
//! tính năng chụp ảnh (xem `flow::run_record_picker` +
//! `flow::finalize_region/finalize_window/finalize_monitor`).
//!
//! Phase 4 thêm âm thanh — CHỈ 1 nguồn tại 1 thời điểm (mic HOẶC audio hệ
//! thống, xem `AudioSource`, cấu hình ở Settings/CaptureBar qua khoá
//! `recordAudioSource`). Trong lúc quay, audio KHÔNG đi qua ffmpeg cùng lúc
//! với video — chỉ ghi PCM thô ra 1 file thường (`spawn_pcm_file_writer`),
//! rồi GHÉP vào video sau khi dừng quay bằng 1 lần chạy ffmpeg tĩnh
//! (`encoder::mux_audio`). Bản đầu tiên thử nạp cả video (qua stdin) lẫn
//! audio (qua fifo) SỐNG vào cùng 1 tiến trình ffmpeg — gặp bug: ffmpeg
//! (scheduler đa luồng bản mới) đồng bộ nhiều input sống với nhau, hễ audio
//! khựng lại vì bất kỳ lý do gì thì ffmpeg tạm dừng đọc luôn video để tránh
//! 2 stream lệch xa nhau, kéo theo kênh buffer riêng của app đầy sau đúng
//! vài giây rồi âm thầm drop frame — video luôn bị cắt cụt bất kể quay bao
//! lâu. Ghép audio SAU (2 file tĩnh, không còn "sống") loại bỏ hẳn lớp bug
//! này.

pub mod encoder;
pub mod filmstrip;
mod audio_mic;
#[cfg(target_os = "windows")]
mod audio_wasapi;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager};
use crate::state::{AppState, PendingVideo};

/// Payload của event `recording-tick` — emit mỗi giây từ `spawn_tray_ticker`.
/// `ms`: thời gian ghi thật (không kể thời gian paused). `paused`: trạng thái
/// tạm dừng hiện tại — UI dùng để hiện/ẩn icon pause và đóng băng đồng hồ.
#[derive(Clone, serde::Serialize)]
pub struct RecordingTick {
    pub ms: u64,
    pub paused: bool,
}

/// Cảnh báo người dùng về sự cố KHÔNG làm hỏng cả phiên quay (mic lỗi, drop
/// frame, ghép audio thất bại...) — trước đây chỉ `eprintln!` (vô hình trong
/// bản đóng gói), giờ emit thêm qua kênh lỗi chung (`CaptureBar.tsx` lắng
/// `snapdoc-error`) để người dùng biết bản quay của mình có vấn đề gì.
fn notify_warning(app: &AppHandle, msg: &str) {
    use tauri::Emitter;
    eprintln!("[SnapDoc][record] {msg}");
    let _ = app.emit("snapdoc-error", msg.to_string());
}

/// Cổng chống 2 lệnh bắt đầu quay chạy ĐUA nhau (vd hotkey + nút bấm gần như
/// đồng thời — mỗi command spawn thread riêng, xem `commands.rs`).
/// `guard_can_start_recording` check xong thì NHẢ lock, còn việc ghi
/// `RecordingState` chỉ xảy ra SAU khi stream/encoder đã dựng xong (vài trăm
/// ms) — không có gate, 2 lệnh cùng lọt qua guard sẽ tạo 2 phiên capture,
/// phiên sau ghi đè phiên trước mà không `stop()` (rò stream OS + ffmpeg).
/// Gate giữ từ TRƯỚC lúc check tới SAU khi ghi state, tự nhả cả trên đường
/// lỗi (RAII qua `Drop`).
static START_GATE: AtomicBool = AtomicBool::new(false);

struct StartGate;

impl StartGate {
    fn acquire() -> Result<Self, String> {
        if START_GATE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Ok(StartGate)
        } else {
            Err("Đang khởi động 1 phiên quay khác — thử lại sau giây lát".to_string())
        }
    }
}

impl Drop for StartGate {
    fn drop(&mut self) {
        START_GATE.store(false, Ordering::SeqCst);
    }
}

/// fps cố định cho v1 — đủ mượt cho demo/hướng dẫn, giữ CPU/dung lượng thấp.
pub const FPS: u32 = 30;

/// Nguồn audio ghi kèm khi quay — CHỈ được chọn 1 trong 3, không trộn (xem
/// doc-comment đầu file để hiểu vì sao). Đọc từ setting `recordAudioSource`
/// (`"off" | "mic" | "system"`, mặc định `"off"` — xem `storage::settings`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AudioSource {
    Off,
    Mic,
    System,
    Both,
}

fn audio_source_setting(app: &AppHandle) -> AudioSource {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let settings = crate::storage::settings::load(&config_dir);
    match settings.get("recordAudioSource").and_then(|v| v.as_str()) {
        Some("mic") => AudioSource::Mic,
        Some("system") => AudioSource::System,
        Some("both") => AudioSource::Both,
        _ => AudioSource::Off,
    }
}

/// 1 track audio ghi PCM thô nhận từ `mac_stream`/`audio_mic`/`audio_wasapi`.
struct AudioTrack {
    writer: std::thread::JoinHandle<()>,
    raw_path: PathBuf,
    sample_rate: u32,
    channels: u16,
}

/// 1 phiên ghi audio đang chạy song song với video — lưu riêng từng nguồn (mic / audio hệ thống)
/// để căn chỉnh gain boost và balance âm lượng chính xác khi mux.
struct ActiveAudio {
    /// `Some` khi có thu mic — cần dừng TRƯỚC `stream.stop()` ở
    /// `stop_recording` để đóng kênh PCM.
    mic: Option<audio_mic::MicCapture>,
    /// `Some` khi có thu audio hệ thống TRÊN WINDOWS.
    #[cfg(target_os = "windows")]
    system_audio: Option<audio_wasapi::SystemAudioCapture>,
    mic_track: Option<AudioTrack>,
    system_track: Option<AudioTrack>,
    /// Thư mục tạm chứa các file PCM + video tạm — dọn ở `stop_recording` sau khi ghép xong.
    tmp_dir: PathBuf,
}

/// 1 phiên quay đang chạy. Field `stream` chỉ tồn tại trên macOS (nguồn frame
/// duy nhất hiện có); `writer` sở hữu cả `Receiver<Frame>` lẫn `Encoder`, tự
/// gọi `encoder.finish()` khi kênh đóng (xem `stop_recording`).
pub struct ActiveRecording {
    #[cfg(target_os = "macos")]
    stream: crate::capture::mac_stream::RecordingHandle,
    #[cfg(target_os = "windows")]
    stream: crate::capture::windows_stream::RecordingHandle,
    writer: std::thread::JoinHandle<Result<(), String>>,
    audio: Option<ActiveAudio>,
    /// Nơi `Encoder` ghi video lúc quay — TRÙNG `output_path` nếu không bật
    /// audio; là 1 file TẠM (trong `audio.tmp_dir`) nếu có audio, vì còn phải
    /// ghép audio vào rồi mới ra `output_path` thật (xem `stop_recording`).
    video_path: PathBuf,
    pub output_path: PathBuf,
    pub started_at: Instant,
    /// Kích thước pixel thật của video (khớp `RecordingHandle::width/height`
    /// lúc `start()`) — cần lại ở `stop_recording` để ingest vào History,
    /// nhưng `stream` đã bị tiêu thụ (move) bởi `stream.stop()` lúc đó nên
    /// phải lưu riêng ở đây từ trước.
    width: u32,
    height: u32,
    /// "full" | "window" | "region" — khớp đúng `CaptureMode` phía chụp ảnh
    /// (xem `flow::run_record_picker`), để History coi quay và chụp cùng 1
    /// khái niệm "phạm vi" thay vì tạo thêm 1 tập giá trị capture_mode riêng.
    capture_mode: &'static str,
    // ── Pause / Resume ────────────────────────────────────────────────────
    /// `true` khi phiên quay đang tạm dừng — writer thread video và writer
    /// thread audio đều kiểm tra cờ này để skip frame/chunk.
    pub paused: Arc<AtomicBool>,
    /// Tổng số millisecond đã ở trạng thái paused (tích luỹ qua nhiều lần
    /// pause) — `status()` trừ giá trị này ra khỏi `started_at.elapsed()`
    /// để đồng hồ không chạy trong lúc tạm dừng.
    paused_accumulated_ms: Arc<AtomicU64>,
    /// Thời điểm bắt đầu đoạn pause HIỆN TẠI — `Some` khi đang paused,
    /// `None` khi đang chạy. Dùng để tính thêm khoảng ms cho
    /// `paused_accumulated_ms` khi resume (xem `resume_recording`).
    pause_started_at: Arc<Mutex<Option<Instant>>>,
}

#[derive(Default)]
pub struct RecordingState(pub Mutex<Option<ActiveRecording>>);

/// Thư mục lưu video: `saveDir` đã cấu hình trong Settings, hoặc
/// `Pictures/SnapDoc` mặc định — cùng quy tắc với ảnh chụp.
fn resolve_save_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let settings = crate::storage::settings::load(&config_dir);
    let custom_dir = settings
        .get("saveDir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if custom_dir.is_empty() {
        app.path()
            .picture_dir()
            .map(|p| p.join("SnapDoc"))
            .map_err(|e| format!("Không tìm thấy thư mục Pictures: {e}"))
    } else {
        Ok(PathBuf::from(custom_dir))
    }
}

/// Đường dẫn file mp4 mới: `{saveDir hoặc Pictures/SnapDoc}/Recording_<timestamp>.mp4`
/// — cùng thư mục lưu với ảnh chụp (tôn trọng `saveDir` đã cấu hình trong Settings).
pub(crate) fn new_output_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_save_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Không tạo được thư mục lưu: {e}"))?;
    // mp4 nằm NGOÀI `$APPDATA/SnapDoc/library` (scope tĩnh khai trong
    // tauri.conf.json chỉ cho phép thư mục đó) — khác ảnh chụp, video không
    // copy vào Library nội bộ (xem `history::ingest_video`), nên phải tự mở
    // thêm scope asset-protocol cho ĐÚNG thư mục này thì `convertFileSrc`
    // (Editor chế độ video + History video player) mới đọc được, nếu không trình
    // duyệt sẽ chặn request và video không tài phát được (404/blocked).
    allow_asset_scope(app, &dir);
    // dedupe: 2 bản quay bắt đầu trong cùng 1 giây (timestamp trùng) không
    // được ghi đè nhau — thêm hậu tố `_1`, `_2`... như luồng auto-save ảnh.
    Ok(crate::storage::save::dedupe(
        dir.join(format!("{}.mp4", crate::flow::stamp_filename("Recording"))),
    ))
}

/// Mở scope asset-protocol cho 1 thư mục lưu video — gọi lúc quay (phòng
/// `saveDir` vừa đổi trong Settings) VÀ lúc khởi động app (phòng người dùng
/// mở lại History để xem video đã quay ở phiên trước, khi scope runtime của
/// phiên cũ không còn — xem `allow_asset_scope_at_startup`).
pub(crate) fn allow_asset_scope(app: &AppHandle, dir: &std::path::Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!("[SnapDoc][record] Không mở được asset scope cho {}: {e}", dir.display());
    }
}

/// Gọi 1 lần lúc khởi động app — xem `allow_asset_scope`.
pub fn allow_asset_scope_at_startup(app: &AppHandle) {
    if let Ok(dir) = resolve_save_dir(app) {
        allow_asset_scope(app, &dir);
    }
}

/// Dọn rác tạm của các phiên TRƯỚC bị bỏ lại do crash/quit giữa chừng — gọi
/// 1 lần lúc khởi động (app là single-instance nên không phiên nào khác đang
/// dùng các file này): thư mục `snapdoc-rec-audio-*` (audio PCM + video tạm,
/// bình thường dọn sau khi mux; bị bỏ lại khi mux lỗi/discard/crash),
/// `snapdoc-trim-*` (segment tạm của trim, bị bỏ lại khi crash giữa trim)
/// trong temp dir, và `*.trimtmp.mp4` trong saveDir (file trung gian giữa
/// bước encode và bước rename đè của `history::commands::overwrite_history_video_sync`).
pub fn cleanup_stale_temp(app: &AppHandle) {
    let tmp = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("snapdoc-rec-audio-") || name.starts_with("snapdoc-trim-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    if let Ok(dir) = resolve_save_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".trimtmp.mp4") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Khớp kích thước frame về đúng (dst_w, dst_h) đã khai với encoder khi bắt đầu quay.
/// Nếu cửa sổ đang quay bị co giãn (resize) giữa chừng, hàm này tự động crop hoặc
/// pad viền đen thay vì bỏ qua frame khiến video bị đứng hình (dùng chung cho cả macOS và Windows).
fn fit_frame_to_target(
    src_bgra: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    let mut dst = vec![0u8; (dst_w * dst_h * 4) as usize];
    let copy_w = src_w.min(dst_w) as usize;
    let copy_h = src_h.min(dst_h) as usize;
    let src_row_len = (src_w * 4) as usize;
    let dst_row_len = (dst_w * 4) as usize;
    let copy_bytes = copy_w * 4;
    for y in 0..copy_h {
        let src_off = y * src_row_len;
        let dst_off = y * dst_row_len;
        if src_off + copy_bytes <= src_bgra.len() && dst_off + copy_bytes <= dst.len() {
            dst[dst_off..dst_off + copy_bytes].copy_from_slice(&src_bgra[src_off..src_off + copy_bytes]);
        }
    }
    dst
}

/// Ghi liên tục PCM thô (mic hoặc audio hệ thống — cùng dạng `Vec<u8>` s16le)
/// ra 1 FILE THƯỜNG trong lúc quay. KHÔNG phải fifo — không có gì đọc trực
/// tiếp trong lúc quay nên `file.write_all` không bao giờ bị chặn bởi ffmpeg
/// hay bất kỳ ai khác (khác hẳn hướng fifo cũ). Ghép vào video xảy ra SAU
/// khi dừng quay (xem `encoder::mux_audio`, `stop_recording`).
///
/// `paused`: cờ dùng chung với `pause_recording`/`resume_recording` — khi
/// `true`, chunk được DROP thay vì ghi ra file, giữ audio đồng bộ với video
/// (video cũng drop frame trong cùng khoảng thời gian đó, xem writer thread
/// trong `start_with_target`). Dùng `Arc<AtomicBool>` để đọc không cần lock.
fn spawn_pcm_file_writer(
    path: PathBuf,
    rx: Receiver<Vec<u8>>,
    paused: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        use std::io::Write;
        let mut file = match std::fs::File::create(&path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[SnapDoc][record] Không tạo được file audio tạm {}: {e}", path.display());
                return;
            }
        };
        while let Ok(chunk) = rx.recv() {
            // Khi đang paused: drop chunk âm thanh — không ghi vào file,
            // giữ đồng bộ với video (video cũng bị drop cùng khoảng thời
            // gian này trong writer thread). ffmpeg mux_audio / mux_dual_audio
            // sau này nhận các file có cùng "khoảng trắng" nên timeline khớp tuyệt đối.
            if paused.load(Ordering::SeqCst) {
                continue;
            }
            if let Err(e) = file.write_all(&chunk) {
                eprintln!("[SnapDoc][record] Lỗi ghi file audio tạm {}: {e}", path.display());
                break;
            }
        }
    })
}

/// Quay toàn màn hình CHÍNH (hành vi v1, dùng cho nút "Quay" mặc định + hotkey).
#[cfg(target_os = "macos")]
pub fn start_recording(app: &AppHandle) -> Result<(), String> {
    let monitor = crate::capture::monitor::primary()?;
    let display_id = monitor
        .id()
        .map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
    start_with_target(app, crate::capture::mac_stream::RecordTarget::Display(display_id))
}

/// Quay toàn bộ 1 màn hình CỤ THỂ (người dùng chọn qua overlay — Phase 3).
#[cfg(target_os = "macos")]
pub fn start_recording_monitor(app: &AppHandle, display_id: u32) -> Result<(), String> {
    start_with_target(app, crate::capture::mac_stream::RecordTarget::Display(display_id))
}

/// Quay 1 VÙNG đã chọn qua overlay. `x,y,w,h` là points, LOCAL theo gốc màn
/// hình `display_id` (cùng hệ toạ độ `flow::finalize_region` đã tính sẵn cho
/// chụp ảnh vùng — xem đó để hiểu vì sao không cần cộng thêm gốc màn hình).
#[cfg(target_os = "macos")]
pub fn start_recording_region(
    app: &AppHandle,
    display_id: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    start_with_target(
        app,
        crate::capture::mac_stream::RecordTarget::Region { display_id, x, y, w, h },
    )
    // KHÔNG tự mở khung viền ở đây nữa — caller duy nhất (`flow::finalize_region`)
    // đã có sẵn overlay đang hiển thị đúng khung này (từ lúc chọn/chỉnh vùng)
    // và tự chuyển nó thành lớp click-through cho khung viền, tránh nháy hình
    // do phải tạo/ẩn 1 cửa sổ khung viền RIÊNG (xem comment ở đó).
}

/// Quay 1 cửa sổ đã chọn qua overlay.
#[cfg(target_os = "macos")]
pub fn start_recording_window(app: &AppHandle, window_id: u32) -> Result<(), String> {
    start_with_target(app, crate::capture::mac_stream::RecordTarget::Window(window_id))
}

/// Vùng (x, y, w, h) LOGICAL/points, toạ độ GLOBAL desktop, để vẽ khung viền
/// "đang quay" (xem `windows::open_record_border`) cho quay TOÀN màn hình
/// hoặc quay 1 CỬA SỔ — quay VÙNG trả `None` vì đã có khung riêng (chính
/// overlay chọn vùng, xem `flow::finalize_region`). Phải gọi TRƯỚC khi
/// `target` bị tiêu thụ (move) vào `mac_stream::start`/`windows_stream::start`.
#[cfg(target_os = "macos")]
fn record_border_rect(target: &crate::capture::mac_stream::RecordTarget) -> Option<(f64, f64, f64, f64)> {
    use crate::capture::mac_stream::RecordTarget;
    use xcap::Monitor;
    match target {
        RecordTarget::Display(display_id) => {
            let m = Monitor::all()
                .ok()?
                .into_iter()
                .find(|m| m.id().map(|i| i == *display_id).unwrap_or(false))?;
            Some((m.x().ok()? as f64, m.y().ok()? as f64, m.width().ok()? as f64, m.height().ok()? as f64))
        }
        RecordTarget::Window(window_id) => {
            let list = crate::capture::window::list(0.0, 0.0, 1.0).ok()?;
            let w = list.into_iter().find(|w| w.id == *window_id)?;
            Some((w.x, w.y, w.width, w.height))
        }
        RecordTarget::Region { .. } => None,
    }
}

#[cfg(target_os = "windows")]
fn record_border_rect(target: &crate::capture::windows_stream::RecordTarget) -> Option<(f64, f64, f64, f64)> {
    use crate::capture::windows_stream::RecordTarget;
    use xcap::Monitor;
    match target {
        RecordTarget::Display(display_id) => {
            let m = Monitor::all()
                .ok()?
                .into_iter()
                .find(|m| m.id().map(|i| i == *display_id).unwrap_or(false))?;
            let scale = m.scale_factor().unwrap_or(1.0).max(1.0) as f64;
            Some((
                m.x().ok()? as f64 / scale,
                m.y().ok()? as f64 / scale,
                m.width().ok()? as f64 / scale,
                m.height().ok()? as f64 / scale,
            ))
        }
        RecordTarget::Window(window_id) => {
            let list = crate::capture::window::list(0.0, 0.0, 1.0).ok()?;
            let w = list.into_iter().find(|w| w.id == *window_id)?;
            Some((w.x, w.y, w.width, w.height))
        }
        RecordTarget::Region { .. } => None,
    }
}

/// Chặn bắt đầu quay mới khi đã có 1 phiên đang chạy. Dùng chung cho cả 2
/// nền tảng.
fn guard_can_start_recording(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RecordingState>();
    let guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
    if guard.is_some() {
        return Err("Đã có phiên quay đang chạy".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_with_target(app: &AppHandle, target: crate::capture::mac_stream::RecordTarget) -> Result<(), String> {
    // Giữ gate suốt hàm (tới sau khi ghi RecordingState) — xem `StartGate`.
    let _gate = StartGate::acquire()?;
    guard_can_start_recording(app)?;
    let state = app.state::<RecordingState>();

    let capture_mode: &'static str = match &target {
        crate::capture::mac_stream::RecordTarget::Display(_) => "full",
        crate::capture::mac_stream::RecordTarget::Region { .. } => "region",
        crate::capture::mac_stream::RecordTarget::Window(_) => "window",
    };

    // Phải tính TRƯỚC khi `target` bị move vào `mac_stream::start` bên dưới.
    let border_rect = record_border_rect(&target);

    let audio_source = audio_source_setting(app);
    let want_system_audio = audio_source == AudioSource::System || audio_source == AudioSource::Both;
    let want_mic = audio_source == AudioSource::Mic || audio_source == AudioSource::Both;

    let (stream, frame_rx, system_audio_rx) =
        crate::capture::mac_stream::start(target, FPS, want_system_audio)?;
    let (width, height) = (stream.width, stream.height);

    // Mic là nguồn ĐỘC LẬP với SCStream (xem `audio_mic.rs`) — lỗi ở đây
    // (vd không có quyền micro) không nên làm hỏng cả phiên quay: log rồi
    // tiếp tục quay, còn hơn để người dùng mất trắng bản quay.
    let mic_result = if want_mic {
        match audio_mic::start() {
            Ok(m) => Some(m),
            Err(e) => {
                notify_warning(app, &format!("Không ghi được mic — vẫn tiếp tục quay: {e}"));
                None
            }
        }
    } else {
        None
    };

    // Cờ pause dùng chung giữa writer thread video, writer thread audio, và
    // ticker — khởi tạo `false` (đang chạy bình thường).
    let paused = Arc::new(AtomicBool::new(false));
    let paused_accumulated_ms = Arc::new(AtomicU64::new(0));
    let pause_started_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

    let has_any_audio = system_audio_rx.is_some() || mic_result.is_some();
    let (video_path, output_path, audio) = if has_any_audio {
        let tmp_dir = std::env::temp_dir().join(format!("snapdoc-rec-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir)
            .map_err(|e| format!("Không tạo được thư mục tạm cho audio: {e}"))?;
        let video_tmp_path = tmp_dir.join("video.mp4");
        let final_path = new_output_path(app)?;
        let system_track = if let Some(sys_rx) = system_audio_rx {
            let sys_raw_path = tmp_dir.join("system.pcm");
            let writer = spawn_pcm_file_writer(sys_raw_path.clone(), sys_rx, paused.clone());
            Some(AudioTrack {
                writer,
                raw_path: sys_raw_path,
                sample_rate: crate::capture::mac_stream::AUDIO_SAMPLE_RATE,
                channels: crate::capture::mac_stream::AUDIO_CHANNELS,
            })
        } else {
            None
        };

        let (mic_capture, mic_track) = if let Some((mic, mic_rx, sample_rate, channels)) = mic_result {
            let mic_raw_path = tmp_dir.join("mic.pcm");
            let writer = spawn_pcm_file_writer(mic_raw_path.clone(), mic_rx, paused.clone());
            (
                Some(mic),
                Some(AudioTrack {
                    writer,
                    raw_path: mic_raw_path,
                    sample_rate,
                    channels: channels as u16,
                }),
            )
        } else {
            (None, None)
        };

        (
            video_tmp_path,
            final_path,
            Some(ActiveAudio {
                mic: mic_capture,
                mic_track,
                system_track,
                tmp_dir,
            }),
        )
    } else {
        let final_path = new_output_path(app)?;
        (final_path.clone(), final_path, None)
    };

    let mut encoder = encoder::Encoder::start(&video_path, width, height, FPS)?;
    let paused_for_writer = paused.clone();

    // Luồng riêng: kéo frame liên tục cho tới khi channel đóng (xảy ra khi
    // `stop_recording` gọi `stream.stop()` → drop sender bên trong
    // `mac_stream`), rồi TỰ gọi `encoder.finish()` để đóng stdin/mux file.
    let writer = std::thread::spawn(move || -> Result<(), String> {
        while let Ok(frame) = frame_rx.recv() {
            // Khi paused: drop frame, không ghi vào encoder — video giữ nguyên
            // timestamp liên tục (ffmpeg đếm frame theo fps cố định) nên đoạn
            // paused sẽ bị "đứng hình" hoặc nối liền tuỳ frame cuối cùng trước
            // pause. Đây là hành vi mong muốn: video output chỉ chứa nội dung
            // thật sự được ghi, không có khoảng trống thời gian.
            if paused_for_writer.load(Ordering::Relaxed) {
                continue;
            }
            // ffmpeg nhận rawvideo với -s cố định từ lúc start(). Nếu cửa sổ
            // hoặc màn hình bị đổi kích thước giữa lúc quay, tự động fit/crop/pad
            // về đúng (width, height) thay vì bỏ qua frame khiến video đứng hình.
            if frame.width != width || frame.height != height {
                let fit_data = fit_frame_to_target(&frame.bgra, frame.width, frame.height, width, height);
                encoder.write_frame(&fit_data)?;
            } else {
                encoder.write_frame(&frame.bgra)?;
            }
        }
        encoder.finish()
    });

    {
        let mut guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
        *guard = Some(ActiveRecording {
            stream,
            writer,
            audio,
            video_path,
            output_path,
            started_at: Instant::now(),
            width,
            height,
            capture_mode,
            paused,
            paused_accumulated_ms,
            pause_started_at,
        });
    }

    crate::tray::show_recording_tray(app);
    if let Some((bx, by, bw, bh)) = border_rect {
        if let Err(e) = crate::windows::open_record_border(app, bx, by, bw, bh) {
            eprintln!("[SnapDoc][record] Không hiện được khung viền đang quay: {e}");
        }
    }
    spawn_tray_ticker(app.clone());
    Ok(())
}

/// Cập nhật đồng hồ đếm cạnh icon "đang quay" mỗi giây — tự dừng khi
/// `status()` trả `None` (đã `stop_recording`). Đồng thời poll
/// `is_stopped_externally()`: nếu người dùng bấm "Stop" trên icon "Screen
/// Sharing" của HỆ THỐNG macOS (khác icon riêng của app), `SCStream` tự dừng
/// mà không ai gọi `stop_recording()` của ta — nếu không phát hiện, phiên
/// quay coi như "kẹt" mãi ở trạng thái đang chạy: `writer` thread chờ frame
/// không bao giờ tới nữa, và icon "đang quay" không bao giờ bị ẩn.
///
/// Đây vẫn là 1 poll BẮT BUỘC (không có callback OS nào báo "SCStream tự
/// dừng") — nhưng thay vì để `RecordingIndicator.tsx` tự poll `recording_status`
/// THÊM 1 lần/giây riêng (IPC round-trip trùng lặp với đúng giá trị `ms` vừa
/// tính ở đây), emit luôn `recording-tick` cho MỌI cửa sổ đang lắng nghe —
/// gộp 2 vòng poll độc lập (Rust ticker + JS setInterval) thành 1 nguồn duy
/// nhất, phản hồi ngay khi tính xong thay vì lệch pha tới 1s giữa 2 timer.
#[cfg(target_os = "macos")]
fn spawn_tray_ticker(app: AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || loop {
        if stopped_externally(&app) {
            if let Err(e) = stop_recording(&app) {
                eprintln!("[SnapDoc][record] Dừng quay (SCStream tự dừng bên ngoài) thất bại: {e}");
            }
            break;
        }
        match status(&app) {
            Some(ms) => {
                let is_paused = paused_state(&app).unwrap_or(false);
                // Khi paused: không cập nhật đồng hồ tray (giữ nguyên giá trị
                // cuối trước lúc pause, thay vì nhảy số lên rồi reset khi resume).
                if !is_paused {
                    crate::tray::update_recording_time(ms);
                }
                let _ = app.emit("recording-tick", RecordingTick { ms, paused: is_paused });
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            None => break,
        }
    });
}

/// `true` nếu phiên quay hiện tại đã bị SCStream tự dừng ngoài ý muốn (xem
/// `spawn_tray_ticker`).
#[cfg(target_os = "macos")]
fn stopped_externally(app: &AppHandle) -> bool {
    let state = app.state::<RecordingState>();
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    guard
        .as_ref()
        .map(|r| r.stream.is_stopped_externally())
        .unwrap_or(false)
}

/// Quay toàn màn hình CHÍNH trên Windows (giai đoạn 1 của plan Phase 5 —
/// xem `capture::windows_stream` doc-comment: chưa hỗ trợ audio/window/region).
#[cfg(target_os = "windows")]
pub fn start_recording(app: &AppHandle) -> Result<(), String> {
    let monitor = crate::capture::monitor::primary()?;
    let display_id = monitor
        .id()
        .map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
    start_with_target(app, crate::capture::windows_stream::RecordTarget::Display(display_id))
}

#[cfg(target_os = "windows")]
pub fn start_recording_monitor(app: &AppHandle, display_id: u32) -> Result<(), String> {
    start_with_target(app, crate::capture::windows_stream::RecordTarget::Display(display_id))
}

#[cfg(target_os = "windows")]
pub fn start_recording_region(
    app: &AppHandle,
    display_id: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    start_with_target(
        app,
        crate::capture::windows_stream::RecordTarget::Region { display_id, x, y, w, h },
    )
    // KHÔNG tự mở khung viền ở đây nữa — xem comment ở bản macOS phía trên.
}

#[cfg(target_os = "windows")]
pub fn start_recording_window(app: &AppHandle, window_id: u32) -> Result<(), String> {
    start_with_target(app, crate::capture::windows_stream::RecordTarget::Window(window_id))
}

#[cfg(target_os = "windows")]
fn start_with_target(app: &AppHandle, target: crate::capture::windows_stream::RecordTarget) -> Result<(), String> {
    // Giữ gate suốt hàm (tới sau khi ghi RecordingState) — xem `StartGate`.
    let _gate = StartGate::acquire()?;
    guard_can_start_recording(app)?;
    let state = app.state::<RecordingState>();

    let capture_mode: &'static str = match &target {
        crate::capture::windows_stream::RecordTarget::Display(_) => "full",
        crate::capture::windows_stream::RecordTarget::Region { .. } => "region",
        crate::capture::windows_stream::RecordTarget::Window(_) => "window",
    };

    // Giai đoạn 6 (plan Phase 5): audio hệ thống trên Windows dùng WASAPI
    // loopback qua `audio_wasapi.rs` — ĐỘC LẬP với WGC (khác macOS, nơi audio
    // hệ thống lấy chung sender với video từ `mac_stream`), giống hệt cách
    // mic đã là 1 capture riêng từ trước.
    // Phải tính TRƯỚC khi `target` bị move vào `windows_stream::start` bên dưới.
    let border_rect = record_border_rect(&target);

    let audio_source = audio_source_setting(app);
    let want_system_audio = audio_source == AudioSource::System || audio_source == AudioSource::Both;
    let want_mic = audio_source == AudioSource::Mic || audio_source == AudioSource::Both;

    // Khởi tạo song song: Video capture (WGC), Mic audio (CPAL), và System audio (WASAPI)
    // để loại bỏ độ trễ tuần tự khi bắt đầu quay.
    let (stream_res, mic_res, sys_res) = std::thread::scope(|s| {
        let stream_handle = s.spawn(|| crate::capture::windows_stream::start(target, FPS, false));
        let mic_handle = s.spawn(|| if want_mic { Some(audio_mic::start()) } else { None });
        let sys_handle = s.spawn(|| if want_system_audio { Some(audio_wasapi::start()) } else { None });
        (
            stream_handle.join().unwrap_or_else(|_| Err("Video capture thread bị lỗi".to_string())),
            mic_handle.join().unwrap_or_else(|_| Some(Err("Mic thread bị lỗi".to_string()))),
            sys_handle.join().unwrap_or_else(|_| Some(Err("Audio hệ thống thread bị lỗi".to_string()))),
        )
    });

    let (stream, frame_rx, _system_audio_rx) = match stream_res {
        Ok(res) => res,
        Err(e) => {
            // Nếu luồng video lỗi, dọn dẹp các luồng audio đã khởi chạy thành công
            if let Some(Ok((mic, _, _, _))) = mic_res {
                mic.stop();
            }
            if let Some(Ok((sys, _, _, _))) = sys_res {
                sys.stop();
            }
            return Err(e);
        }
    };
    let (width, height) = (stream.width, stream.height);

    let mic_result = match mic_res {
        Some(Ok((mic, rx, sample_rate, channels))) => {
            Some((mic, rx, sample_rate, channels as u16))
        }
        Some(Err(e)) => {
            notify_warning(app, &format!("Không ghi được mic — vẫn tiếp tục quay: {e}"));
            None
        }
        None => None,
    };

    let sys_result = match sys_res {
        Some(Ok((sys, rx, sample_rate, channels))) => {
            Some((sys, rx, sample_rate, channels))
        }
        Some(Err(e)) => {
            notify_warning(app, &format!("Không ghi được audio hệ thống — vẫn tiếp tục quay: {e}"));
            None
        }
        None => None,
    };

    // Cờ pause dùng chung giữa writer thread video, writer thread audio, và ticker.
    let paused = Arc::new(AtomicBool::new(false));
    let paused_accumulated_ms = Arc::new(AtomicU64::new(0));
    let pause_started_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

    let has_any_audio = sys_result.is_some() || mic_result.is_some();
    let (video_path, output_path, audio) = if has_any_audio {
        let tmp_dir = std::env::temp_dir().join(format!("snapdoc-rec-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir)
            .map_err(|e| format!("Không tạo được thư mục tạm cho audio: {e}"))?;
        let video_tmp_path = tmp_dir.join("video.mp4");
        let final_path = new_output_path(app)?;

        let (system_audio, system_track) = if let Some((sys, sys_rx, sample_rate, channels)) = sys_result {
            let sys_raw_path = tmp_dir.join("system.pcm");
            let writer = spawn_pcm_file_writer(sys_raw_path.clone(), sys_rx, paused.clone());
            (
                Some(sys),
                Some(AudioTrack {
                    writer,
                    raw_path: sys_raw_path,
                    sample_rate,
                    channels,
                }),
            )
        } else {
            (None, None)
        };

        let (mic_capture, mic_track) = if let Some((mic, mic_rx, sample_rate, channels)) = mic_result {
            let mic_raw_path = tmp_dir.join("mic.pcm");
            let writer = spawn_pcm_file_writer(mic_raw_path.clone(), mic_rx, paused.clone());
            (
                Some(mic),
                Some(AudioTrack {
                    writer,
                    raw_path: mic_raw_path,
                    sample_rate,
                    channels,
                }),
            )
        } else {
            (None, None)
        };

        (
            video_tmp_path,
            final_path,
            Some(ActiveAudio {
                mic: mic_capture,
                system_audio,
                mic_track,
                system_track,
                tmp_dir,
            }),
        )
    } else {
        let final_path = new_output_path(app)?;
        (final_path.clone(), final_path, None)
    };

    let mut encoder = encoder::Encoder::start(&video_path, width, height, FPS)?;
    let paused_for_writer = paused.clone();

    let writer = std::thread::spawn(move || -> Result<(), String> {
        while let Ok(frame) = frame_rx.recv() {
            if paused_for_writer.load(Ordering::Relaxed) {
                continue;
            }
            if frame.width != width || frame.height != height {
                let fit_data = fit_frame_to_target(&frame.bgra, frame.width, frame.height, width, height);
                encoder.write_frame(&fit_data)?;
            } else {
                encoder.write_frame(&frame.bgra)?;
            }
        }
        encoder.finish()
    });

    {
        let mut guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
        *guard = Some(ActiveRecording {
            stream,
            writer,
            audio,
            video_path,
            output_path,
            started_at: Instant::now(),
            width,
            height,
            capture_mode,
            paused,
            paused_accumulated_ms,
            pause_started_at,
        });
    }

    crate::tray::show_recording_tray(app);
    if let Some((bx, by, bw, bh)) = border_rect {
        if let Err(e) = crate::windows::open_record_border(app, bx, by, bw, bh) {
            eprintln!("[SnapDoc][record] Không hiện được khung viền đang quay: {e}");
        }
    }
    if let Err(e) = crate::windows::open_recording_indicator(app) {
        eprintln!("[SnapDoc][record] Không hiện được popup đang quay: {e}");
    }
    spawn_tray_ticker(app.clone());
    Ok(())
}

/// Cập nhật đồng hồ đếm cạnh icon "đang quay" mỗi giây — tự dừng khi
/// `status()` trả `None`. Đồng thời poll `is_stopped_externally()` để phát
/// hiện WGC tự dừng ngoài ý muốn, cùng vai trò với bản macOS (xem đó để hiểu
/// đầy đủ lý do, kể cả lý do emit thêm `recording-tick` thay vì để
/// `RecordingIndicator.tsx` tự poll riêng — quan trọng hơn trên Windows vì
/// đây chính là nơi hiện popup "đang quay").
#[cfg(target_os = "windows")]
fn spawn_tray_ticker(app: AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || loop {
        if stopped_externally(&app) {
            if let Err(e) = stop_recording(&app) {
                eprintln!("[SnapDoc][record] Dừng quay (WGC tự dừng bên ngoài) thất bại: {e}");
            }
            break;
        }
        match status(&app) {
            Some(ms) => {
                let is_paused = paused_state(&app).unwrap_or(false);
                if !is_paused {
                    crate::tray::update_recording_time(ms);
                }
                let _ = app.emit("recording-tick", RecordingTick { ms, paused: is_paused });
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            None => break,
        }
    });
}

#[cfg(target_os = "windows")]
fn stopped_externally(app: &AppHandle) -> bool {
    let state = app.state::<RecordingState>();
    let guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    guard
        .as_ref()
        .map(|r| r.stream.is_stopped_externally())
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_recording(_app: &AppHandle) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS/Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_recording_monitor(_app: &AppHandle, _display_id: u32) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS/Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_recording_region(
    _app: &AppHandle,
    _display_id: u32,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS/Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_recording_window(_app: &AppHandle, _window_id: u32) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS/Windows".to_string())
}

/// Dừng phiên quay hiện tại, đợi ffmpeg mux xong (+ ghép audio nếu có — xem
/// `encoder::mux_audio`), ingest NGAY vào History (không còn chờ xác nhận
/// Lưu/Xoá — video quay xong coi như đã lưu, y hệt 1 ảnh chụp xong), rồi mở
/// Editor (chế độ video, xem `Editor.tsx`) để xem/cắt tiếp nếu muốn. Trả về
/// đường dẫn file mp4 cuối cùng (vẫn hữu ích cho log/test).
pub fn stop_recording(app: &AppHandle) -> Result<String, String> {
    stop_recording_impl(app, true)
}

/// Gọi TRƯỚC khi thoát app (tray "Quit") — nếu đang quay, dừng SẠCH để file
/// mp4 phát được (đóng stdin ffmpeg → flush + moov atom, ghép audio nếu có)
/// và ingest thẳng vào History (không mở Editor vì app sắp thoát — bản quay
/// sẽ nằm sẵn trong Library ở lần mở sau). No-op nếu không quay.
/// Trước đây thoát giữa lúc quay giết ffmpeg giữa chừng → mp4 hỏng, mất trắng.
pub fn finalize_on_exit(app: &AppHandle) {
    if status(app).is_none() {
        return;
    }
    match stop_recording_impl(app, false) {
        Ok(p) if !p.is_empty() => {
            eprintln!("[SnapDoc][record] Đã lưu bản quay trước khi thoát: {p}");
        }
        Ok(_) => {}
        Err(e) => eprintln!("[SnapDoc][record] Không dừng sạch được phiên quay trước khi thoát: {e}"),
    }
}

/// Lõi dùng chung của `stop_recording` (ingest + mở Editor) và
/// `finalize_on_exit` (`open_editor_after=false`: chỉ ingest, không mở Editor).
fn stop_recording_impl(app: &AppHandle, open_editor_after: bool) -> Result<String, String> {
    let state = app.state::<RecordingState>();
    // Dừng có thể được kích hoạt gần-như-đồng-thời từ nhiều nơi (tray icon,
    // hotkey, thanh "Dừng quay", indicator, ticker phát hiện dừng ngoài) —
    // caller "thua cuộc" (state đã bị caller khác `take`) coi là NO-OP thay
    // vì lỗi, tránh alert giả "Không có phiên quay nào đang chạy".
    let Some(active) = state
        .0
        .lock()
        .map_err(|_| "Lock RecordingState lỗi".to_string())?
        .take()
    else {
        return Ok(String::new());
    };

    // Thời lượng thật của video = đúng khoảng thời gian ghi thật sự (không kể
    // thời gian đã tạm dừng). Tính TRƯỚC khi `stream.stop()` tiêu thụ field
    // `stream` (partial move). Nếu đang pause tại thời điểm dừng, cộng thêm
    // khoảng pause dở đó vào accumulated trước khi trừ.
    let extra_paused_ms = if let Ok(guard) = active.pause_started_at.lock() {
        guard.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0)
    } else { 0 };
    let total_paused_ms = active.paused_accumulated_ms.load(Ordering::Relaxed) + extra_paused_ms;
    let duration_ms = (active.started_at.elapsed().as_millis() as i64)
        .saturating_sub(total_paused_ms as i64);

    // Dừng mic/audio hệ thống (Windows) TRƯỚC `stream.stop()` — đóng kênh PCM
    // để `spawn_pcm_file_writer` thấy channel đóng mà tự kết thúc (đóng
    // file). Audio hệ thống trên macOS tự đóng theo `stream.stop()` bên dưới
    // (chung sender với video, không có field riêng ở đây).
    let audio = active.audio.map(|mut a| {
        if let Some(mic) = a.mic.take() {
            mic.stop();
        }
        #[cfg(target_os = "windows")]
        if let Some(sys) = a.system_audio.take() {
            sys.stop();
        }
        a
    });

    // Clone cờ drop-frame TRƯỚC khi `stop()` tiêu thụ (move) field `stream`
    // — để còn cảnh báo người dùng sau khi dừng xong (xem `notify_warning`).
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let dropped_flag = active.stream.dropped_flag();

    #[cfg(target_os = "macos")]
    active.stream.stop()?;
    #[cfg(target_os = "windows")]
    active.stream.stop()?;

    // Ghi file audio KHÔNG qua ffmpeg lúc quay (chỉ `File::write_all`) nên
    // join ở đây luôn nhanh — không có rủi ro treo như hướng fifo cũ.
    let audio_meta = audio.map(|mut a| {
        let mic_meta = a.mic_track.take().map(|t| {
            let _ = t.writer.join();
            (t.raw_path, t.sample_rate, t.channels)
        });
        let sys_meta = a.system_track.take().map(|t| {
            let _ = t.writer.join();
            (t.raw_path, t.sample_rate, t.channels)
        });
        (mic_meta, sys_meta, a.tmp_dir)
    });

    let write_join_res = active.writer.join();

    // Luôn dọn dẹp giao diện UI (khung viền, overlay, thanh dừng quay, tray icon)
    // TRƯỚC khi kiểm tra kết quả ghi video — tránh rủi ro kẹt UI trên màn hình
    // nếu luồng ghi video bị lỗi broken pipe/disk full/panic.
    crate::tray::hide_recording_tray(app);
    crate::windows::close_overlays(app);
    crate::windows::close_stop_control(app);
    crate::windows::close_record_border(app);
    #[cfg(target_os = "windows")]
    crate::windows::close_recording_indicator(app);

    let write_result = write_join_res.map_err(|_| "Luồng ghi video bị panic".to_string())?;
    write_result?;

    // Có audio: ghép vào `output_path` thật bằng 1 lần chạy ffmpeg TĨNH (2
    // file đã hoàn tất, không còn "sống" — không có rủi ro deadlock như
    // hướng live-mux cũ, xem doc-comment đầu file). Lỗi ghép KHÔNG làm mất
    // bản quay: dùng thẳng video tạm (không tiếng) làm kết quả cuối, không
    // xoá `tmp_dir` trong trường hợp này vì video tạm đang nằm trong đó.
    let output_path = match audio_meta {
        // CẢ 2 NGUỒN (Mic + Hệ thống): Trộn qua mux_dual_audio với gain boost cho mic + cân bằng âm lượng hệ thống
        Some((Some((mic_path, mic_sr, mic_ch)), Some((sys_path, sys_sr, sys_ch)), tmp_dir)) => {
            match encoder::mux_dual_audio(
                &active.video_path,
                &mic_path,
                mic_sr,
                mic_ch,
                &sys_path,
                sys_sr,
                sys_ch,
                &active.output_path,
            ) {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&tmp_dir);
                    active.output_path
                }
                Err(e) => {
                    notify_warning(app, &format!("Ghép dual audio thất bại — video được giữ lại KHÔNG có tiếng: {e}"));
                    if let Some(parent) = active.video_path.parent() {
                        allow_asset_scope(app, parent);
                    }
                    active.video_path
                }
            }
        }
        // CHỈ MIC: Ghép qua mux_audio với is_mic = true (gain boost 2.2x to rõ)
        Some((Some((mic_path, mic_sr, mic_ch)), None, tmp_dir)) => {
            match encoder::mux_audio(&active.video_path, &mic_path, mic_sr, mic_ch, true, &active.output_path) {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&tmp_dir);
                    active.output_path
                }
                Err(e) => {
                    notify_warning(app, &format!("Ghép audio mic thất bại — video được giữ lại KHÔNG có tiếng: {e}"));
                    if let Some(parent) = active.video_path.parent() {
                        allow_asset_scope(app, parent);
                    }
                    active.video_path
                }
            }
        }
        // CHỈ HỆ THỐNG: Ghép qua mux_audio với is_mic = false (âm lượng chuẩn 1.0x)
        Some((None, Some((sys_path, sys_sr, sys_ch)), tmp_dir)) => {
            match encoder::mux_audio(&active.video_path, &sys_path, sys_sr, sys_ch, false, &active.output_path) {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&tmp_dir);
                    active.output_path
                }
                Err(e) => {
                    notify_warning(app, &format!("Ghép audio hệ thống thất bại — video được giữ lại KHÔNG có tiếng: {e}"));
                    if let Some(parent) = active.video_path.parent() {
                        allow_asset_scope(app, parent);
                    }
                    active.video_path
                }
            }
        }
        Some((None, None, tmp_dir)) => {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            if active.video_path != active.output_path {
                let _ = std::fs::rename(&active.video_path, &active.output_path);
            }
            active.output_path
        }
        None => active.output_path,
    };

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if dropped_flag.load(Ordering::Relaxed) {
        notify_warning(
            app,
            "Một số khung hình đã bị bỏ qua vì máy không theo kịp tốc độ quay — video có thể bị giật nhẹ",
        );
    }

    let path = output_path.to_string_lossy().to_string();
    // Ingest NGAY vào History — dùng chung cho cả 2 nhánh gọi (trước đây chỉ
    // nhánh thoát app mới ingest ngay, nhánh mở Editor phải chờ user bấm Lưu).
    let ingested = crate::history::ingest_video(
        app,
        std::path::Path::new(&path),
        active.width,
        active.height,
        duration_ms,
        active.capture_mode,
    );
    if open_editor_after {
        match ingested {
            Ok(record) => {
                let state = app.state::<AppState>();
                let mut g = state.pending_video.lock().map_err(|_| "Lock error".to_string())?;
                *g = Some(PendingVideo {
                    path: path.clone(),
                    width: active.width,
                    height: active.height,
                    duration_ms,
                    history_id: record.id,
                });
                drop(g);
                // Video đã lưu vào Library — Editor mở lên (chế độ video) chỉ để
                // xem/cắt tiếp nếu muốn, tự đọc `PendingVideo` qua
                // `takePendingVideo` khi mở, y hệt mở 1 video từ Library.
                if let Err(e) = crate::windows::open_editor(app) {
                    eprintln!("[SnapDoc][record] Không mở được Editor để xem bản quay vừa lưu: {e}");
                }
            }
            Err(e) => {
                eprintln!("[SnapDoc][record] Ingest bản quay vào History thất bại (file vẫn còn trên đĩa, không mở Editor): {e}");
            }
        }
    } else if let Err(e) = ingested {
        eprintln!("[SnapDoc][record] Ingest bản quay vào History trước khi thoát thất bại (file vẫn còn trên đĩa): {e}");
    }

    Ok(path)
}

/// Thời gian đã quay (ms) nếu đang có phiên quay — cửa sổ chỉ báo poll hàm
/// này định kỳ để hiện đồng hồ đếm, tránh cần thêm 1 ticker thread ở Rust.
/// Trả về thời gian GHI THẬT (không kể thời gian đã tạm dừng).
pub fn status(app: &AppHandle) -> Option<u64> {
    let state = app.state::<RecordingState>();
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|r| {
        let raw_ms = r.started_at.elapsed().as_millis() as u64;
        let accumulated = r.paused_accumulated_ms.load(Ordering::Relaxed);
        // Nếu đang paused thì cũng cộng thêm khoảng pause dở vào để đồng hồ
        // đứng yên hoàn toàn (không nhích thêm giây nào trong lúc paused).
        let current_pause_ms = if r.paused.load(Ordering::Relaxed) {
            if let Ok(g) = r.pause_started_at.lock() {
                g.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0)
            } else { 0 }
        } else { 0 };
        raw_ms.saturating_sub(accumulated + current_pause_ms)
    })
}

/// Trạng thái tạm dừng hiện tại — `None` nếu không có phiên quay, `Some(true)`
/// nếu đang paused, `Some(false)` nếu đang chạy.
pub fn paused_state(app: &AppHandle) -> Option<bool> {
    let state = app.state::<RecordingState>();
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|r| r.paused.load(Ordering::Relaxed))
}

/// Tạm dừng phiên quay hiện tại. No-op nếu không có phiên hoặc đã paused.
pub fn pause_recording(app: &AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let state = app.state::<RecordingState>();
    let guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
    let Some(active) = guard.as_ref() else {
        return Err("Không có phiên quay nào đang chạy".to_string());
    };
    if active.paused.load(Ordering::Relaxed) {
        return Ok(()); // đã paused rồi
    }
    // Ghi lại mốc thời điểm bắt đầu pause TRƯỚC khi set cờ — nếu set cờ
    // trước thì `status()` có thể đọc cờ=true nhưng `pause_started_at` vẫn
    // None (race nhỏ giữa 2 thao tác), dẫn đến đồng hồ nhích thêm 1 tick.
    if let Ok(mut g) = active.pause_started_at.lock() {
        *g = Some(Instant::now());
    }
    active.paused.store(true, Ordering::Relaxed);
    let _ = app.emit("recording-paused", true);
    Ok(())
}

/// Tiếp tục phiên quay sau khi tạm dừng. No-op nếu không có phiên hoặc đang
/// chạy.
pub fn resume_recording(app: &AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let state = app.state::<RecordingState>();
    let guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
    let Some(active) = guard.as_ref() else {
        return Err("Không có phiên quay nào đang chạy".to_string());
    };
    if !active.paused.load(Ordering::Relaxed) {
        return Ok(()); // đang chạy rồi
    }
    // Cộng thêm khoảng thời gian vừa pause vào accumulated TRƯỚC khi xoá cờ
    // — nếu xoá cờ trước, `status()` sẽ không cộng `current_pause_ms` nữa
    // nhưng `accumulated` chưa được cộng thêm → đồng hồ nhảy vọt.
    if let Ok(mut g) = active.pause_started_at.lock() {
        if let Some(t) = g.take() {
            let elapsed = t.elapsed().as_millis() as u64;
            active.paused_accumulated_ms.fetch_add(elapsed, Ordering::Relaxed);
        }
    }
    active.paused.store(false, Ordering::Relaxed);
    let _ = app.emit("recording-paused", false);
    Ok(())
}
