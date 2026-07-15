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

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Manager};

/// fps cố định cho v1 — đủ mượt cho demo/hướng dẫn, giữ CPU/dung lượng thấp.
pub const FPS: u32 = 30;

/// Nguồn audio ghi kèm khi quay — CHỈ được chọn 1 trong 3, không trộn (xem
/// doc-comment đầu file để hiểu vì sao). Đọc từ setting `recordAudioSource`
/// (`"off" | "mic" | "system"`, mặc định `"off"` — xem `storage::settings`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum AudioSource {
    Off,
    Mic,
    System,
}

fn audio_source_setting(app: &AppHandle) -> AudioSource {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let settings = crate::storage::settings::load(&config_dir);
    match settings.get("recordAudioSource").and_then(|v| v.as_str()) {
        Some("mic") => AudioSource::Mic,
        Some("system") => AudioSource::System,
        _ => AudioSource::Off,
    }
}

/// 1 phiên ghi audio đang chạy song song với video — `writer` ghi PCM thô
/// nhận từ `mac_stream`/`audio_mic` ra `raw_path` (file thường, KHÔNG phải
/// fifo — xem doc-comment đầu file).
struct ActiveAudio {
    /// `Some` khi nguồn là mic — cần dừng TRƯỚC `stream.stop()` ở
    /// `stop_recording` để đóng kênh PCM, cho `writer` thấy channel đóng mà
    /// tự kết thúc (đóng file). Audio hệ thống trên macOS dùng chung sender
    /// với video (`RecordingHandle`) nên tự đóng theo `stream.stop()`, không
    /// cần field riêng; audio hệ thống trên Windows là 1 capture ĐỘC LẬP
    /// (WASAPI loopback qua `audio_wasapi.rs`) nên cần field riêng bên dưới.
    mic: Option<audio_mic::MicCapture>,
    /// `Some` khi nguồn là audio hệ thống TRÊN WINDOWS — xem giải thích ở
    /// field `mic` phía trên.
    #[cfg(target_os = "windows")]
    system_audio: Option<audio_wasapi::SystemAudioCapture>,
    writer: std::thread::JoinHandle<()>,
    raw_path: PathBuf,
    sample_rate: u32,
    channels: u16,
    /// Thư mục tạm chứa `raw_path` + video tạm (`ActiveRecording::video_path`
    /// khi có audio) — dọn ở `stop_recording` sau khi ghép xong.
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
}

#[derive(Default)]
pub struct RecordingState(pub Mutex<Option<ActiveRecording>>);

/// 1 bản quay đã ghi xong (mp4 hợp lệ trên đĩa) nhưng CHƯA được người dùng
/// xác nhận lưu hay xoá — chờ `record-review` (xem `windows::open_record_review`)
/// gọi `confirm_save`/`confirm_discard`. Serialize được để cửa sổ review đọc
/// qua `peek_pending_recording`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRecording {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub duration_ms: i64,
    pub capture_mode: String,
    /// Đường dẫn bản THÔ (trước khi cắt lần đầu) — chỉ set sau lần
    /// `trim_pending_recording` ĐẦU TIÊN, giữ nguyên ở các lần cắt tiếp theo
    /// (xem đó để hiểu vì sao). `#[serde(skip)]`: thuần nội bộ, frontend
    /// không cần biết — `confirm_recording_save` tự ingest thêm bản này vào
    /// History nếu có, `confirm_recording_discard` tự xoá luôn file này.
    #[serde(skip)]
    pub raw_path: Option<PathBuf>,
    /// Thời lượng (ms) của bản thô — `duration_ms` ở trên bị ghi đè thành
    /// thời lượng MỚI mỗi lần cắt nên phải lưu riêng, dùng khi ingest bản thô
    /// vào History lúc Lưu.
    #[serde(skip)]
    pub raw_duration_ms: Option<i64>,
}

#[derive(Default)]
pub struct PendingRecordingState(pub Mutex<Option<PendingRecording>>);

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
    // (record-review + History video player) mới đọc được, nếu không trình
    // duyệt sẽ chặn request và video không tài phát được (404/blocked).
    allow_asset_scope(app, &dir);
    Ok(dir.join(format!("{}.mp4", crate::flow::stamp_filename("Recording"))))
}

/// Mở scope asset-protocol cho 1 thư mục lưu video — gọi lúc quay (phòng
/// `saveDir` vừa đổi trong Settings) VÀ lúc khởi động app (phòng người dùng
/// mở lại History để xem video đã quay ở phiên trước, khi scope runtime của
/// phiên cũ không còn — xem `allow_asset_scope_at_startup`).
fn allow_asset_scope(app: &AppHandle, dir: &std::path::Path) {
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

/// Ghi liên tục PCM thô (mic hoặc audio hệ thống — cùng dạng `Vec<u8>` s16le)
/// ra 1 FILE THƯỜNG trong lúc quay. KHÔNG phải fifo — không có gì đọc trực
/// tiếp trong lúc quay nên `file.write_all` không bao giờ bị chặn bởi ffmpeg
/// hay bất kỳ ai khác (khác hẳn hướng fifo cũ). Ghép vào video xảy ra SAU
/// khi dừng quay (xem `encoder::mux_audio`, `stop_recording`).
fn spawn_pcm_file_writer(path: PathBuf, rx: Receiver<Vec<u8>>) -> std::thread::JoinHandle<()> {
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

/// Chặn bắt đầu quay mới khi đã có 1 phiên đang chạy, hoặc còn 1 bản quay
/// trước chưa xác nhận lưu/xoá (`PendingRecordingState` chỉ giữ được 1 slot,
/// quay tiếp sẽ GHI ĐÈ và làm mất hẳn đường dẫn tới bản trước). Dùng chung
/// cho cả 2 nền tảng.
fn guard_can_start_recording(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RecordingState>();
    {
        let guard = state.0.lock().map_err(|_| "Lock RecordingState lỗi".to_string())?;
        if guard.is_some() {
            return Err("Đã có phiên quay đang chạy".to_string());
        }
    }
    let pending = app.state::<PendingRecordingState>();
    let guard = pending.0.lock().map_err(|_| "Lock PendingRecordingState lỗi".to_string())?;
    if guard.is_some() {
        return Err("Còn 1 bản quay chưa xác nhận lưu/xoá — hãy xử lý cửa sổ xem lại trước".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_with_target(app: &AppHandle, target: crate::capture::mac_stream::RecordTarget) -> Result<(), String> {
    guard_can_start_recording(app)?;
    let state = app.state::<RecordingState>();

    let capture_mode: &'static str = match &target {
        crate::capture::mac_stream::RecordTarget::Display(_) => "full",
        crate::capture::mac_stream::RecordTarget::Region { .. } => "region",
        crate::capture::mac_stream::RecordTarget::Window(_) => "window",
    };

    let audio_source = audio_source_setting(app);
    let want_system_audio = audio_source == AudioSource::System;

    let (stream, frame_rx, system_audio_rx) =
        crate::capture::mac_stream::start(target, FPS, want_system_audio)?;
    let (width, height) = (stream.width, stream.height);

    // Mic là nguồn ĐỘC LẬP với SCStream (xem `audio_mic.rs`) — lỗi ở đây
    // (vd không có quyền micro) không nên làm hỏng cả phiên quay: log rồi
    // tiếp tục quay KHÔNG audio, còn hơn để người dùng mất trắng bản quay.
    let mic_result = if audio_source == AudioSource::Mic {
        match audio_mic::start() {
            Ok(m) => Some(m),
            Err(e) => {
                eprintln!("[SnapDoc][record] Không ghi được mic (vẫn tiếp tục quay không audio): {e}");
                None
            }
        }
    } else {
        None
    };

    // Chuẩn hoá về ĐÚNG 1 nguồn PCM (bất kể mic hay audio hệ thống) — chỉ 1
    // trong 2 có thể khác `None` vì `audio_source` đã loại trừ lẫn nhau.
    struct AudioProducer {
        rx: Receiver<Vec<u8>>,
        sample_rate: u32,
        channels: u16,
        mic: Option<audio_mic::MicCapture>,
    }
    let audio_producer = if let Some(rx) = system_audio_rx {
        Some(AudioProducer {
            rx,
            sample_rate: crate::capture::mac_stream::AUDIO_SAMPLE_RATE,
            channels: crate::capture::mac_stream::AUDIO_CHANNELS,
            mic: None,
        })
    } else {
        mic_result.map(|(mic, rx, sample_rate, channels)| AudioProducer {
            rx,
            sample_rate,
            channels: channels as u16,
            mic: Some(mic),
        })
    };

    // Có audio: video quay ra 1 file TẠM trong `tmp_dir` (ghép audio vào sau
    // mới ra `output_path` thật, xem `stop_recording`). Không audio: video
    // quay THẲNG ra `output_path` — giữ nguyên đường đi ngắn nhất của v1.
    let (video_path, output_path, audio) = match audio_producer {
        Some(producer) => {
            let tmp_dir = std::env::temp_dir().join(format!("snapdoc-rec-audio-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&tmp_dir)
                .map_err(|e| format!("Không tạo được thư mục tạm cho audio: {e}"))?;
            let raw_path = tmp_dir.join("audio.pcm");
            let video_tmp_path = tmp_dir.join("video.mp4");
            let writer = spawn_pcm_file_writer(raw_path.clone(), producer.rx);
            let final_path = new_output_path(app)?;
            (
                video_tmp_path,
                final_path,
                Some(ActiveAudio {
                    mic: producer.mic,
                    writer,
                    raw_path,
                    sample_rate: producer.sample_rate,
                    channels: producer.channels,
                    tmp_dir,
                }),
            )
        }
        None => {
            let final_path = new_output_path(app)?;
            (final_path.clone(), final_path, None)
        }
    };

    let mut encoder = encoder::Encoder::start(&video_path, width, height, FPS)?;

    // Luồng riêng: kéo frame liên tục cho tới khi channel đóng (xảy ra khi
    // `stop_recording` gọi `stream.stop()` → drop sender bên trong
    // `mac_stream`), rồi TỰ gọi `encoder.finish()` để đóng stdin/mux file.
    let writer = std::thread::spawn(move || -> Result<(), String> {
        while let Ok(frame) = frame_rx.recv() {
            // ffmpeg nhận rawvideo với -s cố định từ lúc start() — 1 frame
            // lệch kích thước (vd đổi độ phân giải màn hình giữa lúc quay) sẽ
            // làm lệch byte-offset của MỌI frame sau, hỏng cả file. Bỏ qua
            // thay vì ghi nhầm.
            if frame.width != width || frame.height != height {
                eprintln!(
                    "[SnapDoc][record] Bỏ qua frame sai kích thước ({}x{}, cần {width}x{height})",
                    frame.width, frame.height
                );
                continue;
            }
            encoder.write_frame(&frame.bgra)?;
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
        });
    }

    crate::tray::show_recording_tray(app);
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
#[cfg(target_os = "macos")]
fn spawn_tray_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        if stopped_externally(&app) {
            if let Err(e) = stop_recording(&app) {
                eprintln!("[SnapDoc][record] Dừng quay (SCStream tự dừng bên ngoài) thất bại: {e}");
            }
            break;
        }
        match status(&app) {
            Some(ms) => {
                crate::tray::update_recording_time(ms);
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
    let audio_source = audio_source_setting(app);

    let (stream, frame_rx, _system_audio_rx) =
        crate::capture::windows_stream::start(target, FPS, false)?;
    let (width, height) = (stream.width, stream.height);

    // Chuẩn hoá về ĐÚNG 1 nguồn PCM (mic hoặc audio hệ thống) — lỗi lúc mở
    // thiết bị (vd không có quyền micro, hoặc cpal không mở được loopback)
    // không nên làm hỏng cả phiên quay: log rồi tiếp tục quay KHÔNG audio,
    // còn hơn để người dùng mất trắng bản quay (giống hệt lý do bên macOS).
    enum AudioCapture {
        Mic(audio_mic::MicCapture),
        System(audio_wasapi::SystemAudioCapture),
    }
    struct AudioProducer {
        rx: Receiver<Vec<u8>>,
        sample_rate: u32,
        channels: u16,
        capture: AudioCapture,
    }
    let audio_producer: Option<AudioProducer> = match audio_source {
        AudioSource::Mic => match audio_mic::start() {
            Ok((mic, rx, sample_rate, channels)) => {
                Some(AudioProducer { rx, sample_rate, channels: channels as u16, capture: AudioCapture::Mic(mic) })
            }
            Err(e) => {
                eprintln!("[SnapDoc][record] Không ghi được mic (vẫn tiếp tục quay không audio): {e}");
                None
            }
        },
        AudioSource::System => match audio_wasapi::start() {
            Ok((sys, rx, sample_rate, channels)) => {
                Some(AudioProducer { rx, sample_rate, channels, capture: AudioCapture::System(sys) })
            }
            Err(e) => {
                eprintln!("[SnapDoc][record] Không ghi được audio hệ thống (vẫn tiếp tục quay không audio): {e}");
                None
            }
        },
        AudioSource::Off => None,
    };

    let (video_path, output_path, audio) = match audio_producer {
        Some(producer) => {
            let tmp_dir = std::env::temp_dir().join(format!("snapdoc-rec-audio-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&tmp_dir)
                .map_err(|e| format!("Không tạo được thư mục tạm cho audio: {e}"))?;
            let raw_path = tmp_dir.join("audio.pcm");
            let video_tmp_path = tmp_dir.join("video.mp4");
            let writer = spawn_pcm_file_writer(raw_path.clone(), producer.rx);
            let final_path = new_output_path(app)?;
            let (mic, system_audio) = match producer.capture {
                AudioCapture::Mic(m) => (Some(m), None),
                AudioCapture::System(s) => (None, Some(s)),
            };
            (
                video_tmp_path,
                final_path,
                Some(ActiveAudio {
                    mic,
                    system_audio,
                    writer,
                    raw_path,
                    sample_rate: producer.sample_rate,
                    channels: producer.channels,
                    tmp_dir,
                }),
            )
        }
        None => {
            let final_path = new_output_path(app)?;
            (final_path.clone(), final_path, None)
        }
    };

    let mut encoder = encoder::Encoder::start(&video_path, width, height, FPS)?;

    let writer = std::thread::spawn(move || -> Result<(), String> {
        while let Ok(frame) = frame_rx.recv() {
            if frame.width != width || frame.height != height {
                eprintln!(
                    "[SnapDoc][record] Bỏ qua frame sai kích thước ({}x{}, cần {width}x{height})",
                    frame.width, frame.height
                );
                continue;
            }
            encoder.write_frame(&frame.bgra)?;
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
        });
    }

    crate::tray::show_recording_tray(app);
    if let Err(e) = crate::windows::open_recording_indicator(app) {
        eprintln!("[SnapDoc][record] Không hiện được popup đang quay: {e}");
    }
    spawn_tray_ticker(app.clone());
    Ok(())
}

/// Cập nhật đồng hồ đếm cạnh icon "đang quay" mỗi giây — tự dừng khi
/// `status()` trả `None`. Đồng thời poll `is_stopped_externally()` để phát
/// hiện WGC tự dừng ngoài ý muốn, cùng vai trò với bản macOS (xem đó để hiểu
/// đầy đủ lý do).
#[cfg(target_os = "windows")]
fn spawn_tray_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        if stopped_externally(&app) {
            if let Err(e) = stop_recording(&app) {
                eprintln!("[SnapDoc][record] Dừng quay (WGC tự dừng bên ngoài) thất bại: {e}");
            }
            break;
        }
        match status(&app) {
            Some(ms) => {
                crate::tray::update_recording_time(ms);
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
/// `encoder::mux_audio`). KHÔNG ingest vào History ngay — chuyển bản quay
/// vào `PendingRecordingState` và mở cửa sổ xem lại (`record-review`) để
/// người dùng chọn "Lưu" hay "Xoá" trước (`confirm_recording_save`/
/// `confirm_recording_discard` mới thực sự ingest/xoá file). Trả về đường
/// dẫn file mp4 cuối cùng (vẫn hữu ích cho log/test).
pub fn stop_recording(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<RecordingState>();
    let active = state
        .0
        .lock()
        .map_err(|_| "Lock RecordingState lỗi".to_string())?
        .take()
        .ok_or_else(|| "Không có phiên quay nào đang chạy".to_string())?;

    // Thời lượng thật của video = đúng khoảng thời gian SCStream đã chạy —
    // tính TRƯỚC khi `stream.stop()` tiêu thụ field `stream` (partial move).
    let duration_ms = active.started_at.elapsed().as_millis() as i64;

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

    #[cfg(target_os = "macos")]
    active.stream.stop()?;
    #[cfg(target_os = "windows")]
    active.stream.stop()?;

    // Ghi file audio KHÔNG qua ffmpeg lúc quay (chỉ `File::write_all`) nên
    // join ở đây luôn nhanh — không có rủi ro treo như hướng fifo cũ.
    let audio_meta = audio.map(|a| {
        let _ = a.writer.join();
        (a.raw_path, a.sample_rate, a.channels, a.tmp_dir)
    });

    let write_result = active
        .writer
        .join()
        .map_err(|_| "Luồng ghi video bị panic".to_string())?;

    crate::tray::hide_recording_tray(app);
    // Đóng overlay (khung + nền mờ, vẫn đang hiển thị/click-through suốt lúc
    // quay — xem `flow::finalize_region`) + thanh "Dừng quay" riêng (nếu
    // phiên quay này bắt đầu từ `RecordRegionSelect`). No-op nếu không có.
    crate::windows::close_overlays(app);
    crate::windows::close_stop_control(app);
    #[cfg(target_os = "windows")]
    crate::windows::close_recording_indicator(app);

    write_result?;

    // Có audio: ghép vào `output_path` thật bằng 1 lần chạy ffmpeg TĨNH (2
    // file đã hoàn tất, không còn "sống" — không có rủi ro deadlock như
    // hướng live-mux cũ, xem doc-comment đầu file). Lỗi ghép KHÔNG làm mất
    // bản quay: dùng thẳng video tạm (không tiếng) làm kết quả cuối, không
    // xoá `tmp_dir` trong trường hợp này vì video tạm đang nằm trong đó.
    let output_path = match audio_meta {
        Some((raw_path, sample_rate, channels, tmp_dir)) => {
            match encoder::mux_audio(&active.video_path, &raw_path, sample_rate, channels, &active.output_path) {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&tmp_dir);
                    active.output_path
                }
                Err(e) => {
                    eprintln!("[SnapDoc][record] Ghép audio thất bại, dùng video không tiếng: {e}");
                    active.video_path
                }
            }
        }
        None => active.output_path,
    };

    let path = output_path.to_string_lossy().to_string();
    {
        let pending = app.state::<PendingRecordingState>();
        let mut guard = pending.0.lock().map_err(|_| "Lock PendingRecordingState lỗi".to_string())?;
        *guard = Some(PendingRecording {
            path: path.clone(),
            width: active.width,
            height: active.height,
            duration_ms,
            capture_mode: active.capture_mode.to_string(),
            raw_path: None,
            raw_duration_ms: None,
        });
    }

    if let Err(e) = crate::windows::open_record_review(app) {
        eprintln!("[SnapDoc][record] Không mở được cửa sổ xem lại bản quay: {e}");
    }

    Ok(path)
}

/// Đọc (không xoá) bản quay đang chờ xác nhận — `record-review` gọi lúc mount
/// để biết đường dẫn/kích thước/thời lượng cần hiển thị.
pub fn peek_pending_recording(app: &AppHandle) -> Option<PendingRecording> {
    app.state::<PendingRecordingState>().0.lock().ok()?.clone()
}

/// Cắt bản quay đang chờ xác nhận (trước khi Lưu/Xoá ở `record-review`).
/// `path` giữ nguyên vị trí (nội dung thay đổi) NHƯNG lần cắt ĐẦU TIÊN sẽ
/// dời bản THÔ (chưa cắt gì) sang 1 file riêng (`raw_path`) trước khi ghi đè
/// — cắt sai thì vẫn còn bản gốc để Lưu cùng lúc lúc bấm "Lưu" (xem
/// `confirm_recording_save`), thay vì mất trắng ngay khi cắt. Các lần cắt
/// tiếp theo (đã có `raw_path` từ trước) KHÔNG dời lại — bản thô luôn là bản
/// DUY NHẤT trước lần cắt đầu tiên, không phải "bản trước lần cắt gần nhất".
/// `keep_ranges_ms`: danh sách đoạn GIỮ LẠI (ms), xem `encoder::trim`.
pub fn trim_pending_recording(app: &AppHandle, keep_ranges_ms: &[(i64, i64)]) -> Result<PendingRecording, String> {
    let pending_state = app.state::<PendingRecordingState>();
    let (path, has_raw, current_duration_ms) = {
        let guard = pending_state.0.lock().map_err(|_| "Lock PendingRecordingState lỗi".to_string())?;
        let pending = guard
            .as_ref()
            .ok_or_else(|| "Không có bản quay nào đang chờ xác nhận".to_string())?;
        (pending.path.clone(), pending.raw_path.is_some(), pending.duration_ms)
    };

    // Không giữ lock trong lúc chạy ffmpeg (có thể mất vài giây) — chỉ khoá
    // lại ở bước đọc state (trên) và bước ghi kết quả (dưới).
    let input_path = PathBuf::from(&path);

    // `rename` (không `copy`) — tránh nhân đôi I/O với file video có thể vài
    // trăm MB, chỉ đổi tên/entry thư mục nên gần như tức thời trên cùng ổ đĩa.
    // Bản thô luôn được lưu vào `{saveDir}/records/` — không phụ thuộc vào
    // nơi user chọn Save As — để tách biệt khỏi file đã cắt.
    let new_raw: Option<(PathBuf, i64)> = if has_raw {
        None
    } else {
        // Thư mục records nằm trong saveDir mặc định (settings), không theo
        // folder Save As mà user chọn sau.
        let base_dir = resolve_save_dir(app)
            .unwrap_or_else(|_| input_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf());
        let records_dir = base_dir.join("records");
        let raw_path = match std::fs::create_dir_all(&records_dir) {
            Ok(_) => {
                let stem = input_path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
                records_dir.join(format!("{stem}-raw.mp4"))
            }
            Err(e) => {
                eprintln!("[SnapDoc][record] Không tạo được thư mục records ({e}), fallback về cùng thư mục");
                let stem = input_path.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
                input_path.with_file_name(format!("{stem}-raw.mp4"))
            }
        };
        // Mở asset scope cho thư mục records để video player đọc được bản thô
        allow_asset_scope(app, raw_path.parent().unwrap_or(&records_dir));
        std::fs::rename(&input_path, &raw_path)
            .map_err(|e| format!("Không sao lưu được bản thô: {e}"))?;
        Some((raw_path, current_duration_ms))
    };

    // Nguồn để trim: lần đầu là bản thô vừa dời đi; các lần sau là bản HIỆN
    // TẠI ở `input_path` (đã cắt từ lần trước, ranges frontend gửi luôn tính
    // theo toạ độ của bản hiện tại, không phải bản thô).
    let trim_source: &Path = new_raw.as_ref().map(|(p, _)| p.as_path()).unwrap_or(&input_path);
    let tmp_output = input_path.with_extension("trimtmp.mp4");
    // Báo tiến độ % cho `record-review` qua event toàn app (webview đang mở
    // sẽ tự lắng, xem `RecordReview.tsx`) — xem doc-comment `encoder::trim`.
    let progress_app = app.clone();
    encoder::trim(trim_source, keep_ranges_ms, &tmp_output, move |frac| {
        use tauri::Emitter;
        let _ = progress_app.emit("trim-progress", frac);
    })?;
    std::fs::rename(&tmp_output, &input_path)
        .map_err(|e| format!("Không ghi đè được file đã cắt: {e}"))?;

    let new_duration_ms: i64 = keep_ranges_ms.iter().map(|(s, e)| (e - s).max(0)).sum();

    let mut guard = pending_state.0.lock().map_err(|_| "Lock PendingRecordingState lỗi".to_string())?;
    let pending = guard
        .as_mut()
        .ok_or_else(|| "Không có bản quay nào đang chờ xác nhận".to_string())?;
    pending.duration_ms = new_duration_ms;
    if let Some((raw_path, raw_duration_ms)) = new_raw {
        pending.raw_path = Some(raw_path);
        pending.raw_duration_ms = Some(raw_duration_ms);
    }
    Ok(pending.clone())
}

/// Di chuyển 1 file vào `dest_dir` (giữ nguyên tên file) — thử `rename` trước
/// (tức thời, cùng ổ đĩa), fallback `copy` + xoá bản gốc nếu khác ổ đĩa
/// (`rename` lỗi `CrossesDevices` trên 1 số hệ thống). Trả về `None` (giữ
/// nguyên đường dẫn cũ, chỉ log lỗi) nếu cả 2 cách đều thất bại — KHÔNG được để
/// mất file chỉ vì đổi thư mục lưu không thành công.
fn move_into_dir(src: &Path, dest_dir: &Path) -> Option<PathBuf> {
    let name = src.file_name()?;
    let dest = dest_dir.join(name);
    if std::fs::rename(src, &dest).is_ok() {
        return Some(dest);
    }
    match std::fs::copy(src, &dest) {
        Ok(_) => {
            if let Err(e) = std::fs::remove_file(src) {
                eprintln!("[SnapDoc][record] Đã copy sang thư mục mới nhưng không xoá được bản gốc: {e}");
            }
            Some(dest)
        }
        Err(e) => {
            eprintln!("[SnapDoc][record] Không chuyển được file sang thư mục đã chọn ({}): {e}", dest_dir.display());
            None
        }
    }
}

/// Trả về `true` nếu `path` nên được coi là đường dẫn đến một FILE đích
/// (người dùng muốn lưu video với tên cụ thể đó), `false` nếu là thư mục đích
/// (video giữ nguyên tên gốc, chỉ chuyển vào thư mục đó).
///
/// Logic: nếu path **đang tồn tại và là thư mục** → đây là thư mục đích.
/// Mọi trường hợp còn lại (chưa tồn tại, hoặc tồn tại là file) → coi là file
/// đích — bao gồm cả trường hợp tên không có extension (ví dụ `my_video` gõ
/// từ dialog Save As trên Windows), vì native save dialog luôn trả về file path.
///
/// **Lưu ý quan trọng**: `path.extension().is_some()` KHÔNG đủ để phân biệt
/// file/thư mục — người dùng hoàn toàn có thể gõ tên không có extension trong
/// dialog, lúc đó path chưa tồn tại trên đĩa nên không thể dùng `is_dir()` mà
/// phải coi mặc định là file path (mục đích tạo file mới).
fn looks_like_file_path(path: &Path) -> bool {
    // Nếu path đã tồn tại và thực sự là thư mục → không phải file path
    if path.is_dir() {
        return false;
    }
    // Path chưa tồn tại hoặc là file → coi là file đích (bao gồm tên không có extension)
    true
}

fn move_into_target(src: &Path, target: &Path, raw_variant: bool) -> Option<PathBuf> {
    let dest = if looks_like_file_path(target) {
        let parent = target.parent()?;
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[SnapDoc][record] Không tạo được thư mục đích ({}): {e}", parent.display());
            return None;
        }

        if raw_variant {
            let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("recording");
            let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("mp4");
            parent.join(format!("{stem}-raw.{ext}"))
        } else {
            target.to_path_buf()
        }
    } else {
        let name = src.file_name()?;
        target.join(name)
    };

    if std::fs::rename(src, &dest).is_ok() {
        return Some(dest);
    }
    match std::fs::copy(src, &dest) {
        Ok(_) => {
            if let Err(e) = std::fs::remove_file(src) {
                eprintln!("[SnapDoc][record] Đã copy sang vị trí mới nhưng không xoá được bản gốc: {e}");
            }
            Some(dest)
        }
        Err(e) => {
            eprintln!("[SnapDoc][record] Không chuyển được file sang vị trí đã chọn ({}): {e}", dest.display());
            None
        }
    }
}

/// Người dùng chọn "Lưu" ở `record-review`: ingest bản quay đang chờ vào
/// History rồi đóng cửa sổ. Nếu đã từng cắt (có `raw_path`) thì ingest CẢ bản
/// thô lẫn bản đã cắt — 2 item riêng trong History, giống hành vi cắt video
/// đã lưu (`history::trim_history_video_sync`): không đánh đổi "cắt sai mất
/// bản gốc" chỉ vì cắt trước khi Lưu thay vì sau. Ingest bản thô TRƯỚC (nếu
/// có) rồi bản hiện tại SAU, để bản hiện tại — thứ người dùng vừa hoàn tất —
/// hiện lên đầu danh sách (sort theo `created_at DESC`). Lỗi ingest
/// (thumbnail/DB) vẫn coi là thành công đối với người dùng — file mp4 đã tồn
/// tại sẵn trên đĩa từ trước, không mất; lỗi ở bản thô không chặn ingest bản
/// hiện tại (vẫn còn ít nhất 1 bản trong History thay vì mất trắng cả 2).
///
/// `dest_dir`: nếu có giá trị (người dùng chọn "Lưu vào thư mục khác…" ở
/// `record-review`), CHỈ di chuyển file đã cắt vào đó TRƯỚC khi ingest.
/// Bản thô (`raw_path`) KHÔNG bị di chuyển — nó đã nằm sẵn trong
/// `{saveDir}/records/` từ bước `trim_pending_recording` và ở lại đó.
/// Hỗ trợ cả thư mục đích lẫn file đích cụ thể (ví dụ từ dialog Save As):
/// nếu là file path thì video chính sẽ theo đúng tên đó.
/// `None`/rỗng → giữ nguyên vị trí cũ.
pub fn confirm_recording_save_to(app: &AppHandle, dest_dir: Option<String>) -> Result<(), String> {
    let mut pending = app
        .state::<PendingRecordingState>()
        .0
        .lock()
        .map_err(|_| "Lock PendingRecordingState lỗi".to_string())?
        .take()
        .ok_or_else(|| "Không có bản quay nào đang chờ xác nhận".to_string())?;

    if let Some(target) = dest_dir.filter(|d| !d.is_empty()) {
        // Nếu người dùng nhập tên không có extension (ví dụ "my_video" thay vì
        // "my_video.mp4"), tự động thêm extension lấy từ file gốc đang pending.
        // Chỉ áp dụng khi target chưa có extension và không phải thư mục đang
        // tồn tại (tức là đây là file path mới sẽ tạo ra).
        let target_with_ext: String;
        let effective_target = {
            let p = Path::new(&target);
            if !p.is_dir() && p.extension().is_none() {
                // Lấy extension từ file nguồn (pending.path), fallback về "mp4"
                let src_ext = Path::new(&pending.path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("mp4");
                target_with_ext = format!("{}.{}", target, src_ext);
                target_with_ext.as_str()
            } else {
                target.as_str()
            }
        };

        // Chỉ di chuyển file đã cắt (pending.path) — bản thô (raw_path) đã
        // nằm trong {saveDir}/records/ từ bước trim và KHÔNG bị di chuyển theo.
        // Sau khi biết tên file cuối cùng user chọn, đổi tên raw thành
        // `raw_<tên_user_chọn>` để dễ nhận diện.
        let target_path = Path::new(effective_target);
        if looks_like_file_path(target_path) {
            if let Some(new_path) = move_into_target(Path::new(&pending.path), target_path, false) {
                pending.path = new_path.to_string_lossy().to_string();
            }
        } else {
            if let Err(e) = std::fs::create_dir_all(target_path) {
                eprintln!("[SnapDoc][record] Không tạo được thư mục đã chọn, giữ nguyên vị trí cũ: {e}");
            } else {
                if let Some(new_path) = move_into_dir(Path::new(&pending.path), target_path) {
                    pending.path = new_path.to_string_lossy().to_string();
                }
            }
        }

        // Đổi tên raw theo tên file đã cắt vừa được xác định — ví dụ user lưu
        // thành "my_video.mp4" thì raw sẽ thành "raw_my_video.mp4" trong records/.
        if let Some(raw_path) = &pending.raw_path {
            let final_stem = Path::new(&pending.path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("recording");
            let new_raw_name = format!("raw_{final_stem}.mp4");
            let new_raw_path = raw_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join(&new_raw_name);
            if new_raw_path != *raw_path {
                if std::fs::rename(raw_path, &new_raw_path).is_ok() {
                    pending.raw_path = Some(new_raw_path);
                } else {
                    eprintln!("[SnapDoc][record] Không đổi tên được file raw, giữ nguyên tên cũ");
                }
            }
        }
    }

    if let (Some(raw_path), Some(raw_duration_ms)) = (&pending.raw_path, pending.raw_duration_ms) {
        if let Err(e) = crate::history::ingest_video(
            app,
            raw_path,
            pending.width,
            pending.height,
            raw_duration_ms,
            &pending.capture_mode,
        ) {
            eprintln!("[SnapDoc][record] Ingest bản thô vào History thất bại: {e}");
        }
    }

    if let Err(e) = crate::history::ingest_video(
        app,
        std::path::Path::new(&pending.path),
        pending.width,
        pending.height,
        pending.duration_ms,
        &pending.capture_mode,
    ) {
        eprintln!("[SnapDoc][record] Ingest video vào History thất bại (file mp4 vẫn còn nguyên): {e}");
    }

    crate::windows::close_record_review(app);
    Ok(())
}

/// Người dùng chọn "Xoá" ở `record-review`: xoá hẳn file mp4 HIỆN TẠI lẫn
/// bản thô (`raw_path`, nếu có — tức đã cắt ít nhất 1 lần trước khi Xoá) —
/// cả 2 chưa từng vào History nên không cần dọn DB, chỉ xoá file trên đĩa.
pub fn confirm_recording_discard(app: &AppHandle) -> Result<(), String> {
    let pending = app
        .state::<PendingRecordingState>()
        .0
        .lock()
        .map_err(|_| "Lock PendingRecordingState lỗi".to_string())?
        .take()
        .ok_or_else(|| "Không có bản quay nào đang chờ xác nhận".to_string())?;

    if let Some(raw_path) = &pending.raw_path {
        if let Err(e) = std::fs::remove_file(raw_path) {
            eprintln!("[SnapDoc][record] Không xoá được bản thô: {e}");
        }
    }

    let result = std::fs::remove_file(&pending.path).map_err(|e| format!("Không xoá được file: {e}"));
    crate::windows::close_record_review(app);
    result
}

/// Nút "Quay lại" ở `record-review`: XOÁ bản quay đang xem (cùng logic
/// `confirm_recording_discard`) rồi mở CaptureBar với đúng chế độ vừa quay
/// (`pending.capture_mode`) để người dùng quay lại NGAY, không phải tự chọn
/// lại phạm vi từ đầu. Trả về `capture_mode` để `windows::open_capture_bar_with_record_mode`
/// biết chế độ cần sync sang CaptureBar.
pub fn redo_recording(app: &AppHandle) -> Result<String, String> {
    let pending = app
        .state::<PendingRecordingState>()
        .0
        .lock()
        .map_err(|_| "Lock PendingRecordingState lỗi".to_string())?
        .take()
        .ok_or_else(|| "Không có bản quay nào đang chờ xác nhận".to_string())?;

    if let Some(raw_path) = &pending.raw_path {
        if let Err(e) = std::fs::remove_file(raw_path) {
            eprintln!("[SnapDoc][record] Không xoá được bản thô: {e}");
        }
    }
    if let Err(e) = std::fs::remove_file(&pending.path) {
        eprintln!("[SnapDoc][record] Không xoá được file: {e}");
    }
    crate::windows::close_record_review(app);
    Ok(pending.capture_mode)
}

/// Thời gian đã quay (ms) nếu đang có phiên quay — cửa sổ chỉ báo poll hàm
/// này định kỳ để hiện đồng hồ đếm, tránh cần thêm 1 ticker thread ở Rust.
pub fn status(app: &AppHandle) -> Option<u64> {
    let state = app.state::<RecordingState>();
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|r| r.started_at.elapsed().as_millis() as u64)
}
