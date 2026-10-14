//! Điều phối 1 phiên quay màn hình — macOS (ScreenCaptureKit, xem
//! `capture::mac_stream`) và Windows (Windows.Graphics.Capture, xem
//! `capture::windows_stream`).
//!
//! Kiến trúc 1 phiên quay:
//! - `RecordingClock` (`clock.rs`): đồng hồ CHUNG (đã trừ thời gian pause) —
//!   video, audio, telemetry chuột và đồng hồ hiển thị đều bám theo nó.
//! - Nguồn quay chỉ cập nhật "frame mới nhất"; `Pacer` (`pacer.rs`) đẩy frame
//!   vào encoder đúng số lượng theo đồng hồ (lặp frame khi encoder bận) nên
//!   thời lượng video luôn đúng.
//! - Encoder ghi MP4 PHÂN MẢNH vào thư mục phiên (`session.rs`) — crash giữa
//!   chừng vẫn khôi phục được ở lần mở app sau.
//! - Audio (mic / hệ thống) ghi PCM thô ra file, bám đồng hồ (`pcm_writer.rs`:
//!   chèn lặng vào chỗ hổng, bỏ pre-roll), rồi GHÉP vào video SAU khi dừng
//!   bằng 1 lần chạy ffmpeg tĩnh (`finalize.rs`). Không nạp audio "sống" vào
//!   cùng tiến trình ffmpeg với video: ffmpeg đồng bộ nhiều input sống với
//!   nhau, hễ audio khựng là ngừng đọc cả video → kênh đầy → mất frame.
//! - Vòng đời có trạng thái tường minh `Idle → Starting → Recording →
//!   Stopping → Idle` (`Phase`) — chống mọi race giữa hotkey/tray/indicator/
//!   thoát app (bấm dừng lúc đang khởi động, bấm quay lúc đang lưu...).
//!
//! Âm thanh: chọn 1 trong `off | mic | system | both` (setting `recordAudioSource`).

pub mod audio_mic;
#[cfg(target_os = "windows")]
mod audio_wasapi;
pub mod clock;
pub mod encoder;
pub mod filmstrip;
mod finalize;
pub mod keystroke;
pub mod mouse_click;
mod pacer;
pub(crate) mod pcm_writer;
pub mod probe;
pub mod proc;
pub mod session;

use crate::capture::frame::Frame;
use crate::state::{AppState, PendingVideo};
use clock::RecordingClock;
use pacer::{PacedFrame, Pacer};
use session::Session;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use crate::capture::mac_stream as stream_impl;
#[cfg(target_os = "windows")]
use crate::capture::windows_stream as stream_impl;

/// fps cố định — đủ mượt cho demo/hướng dẫn, giữ CPU/dung lượng thấp.
pub const FPS: u32 = 30;

/// Số frame tối đa chờ trong kênh pacer → writer. Nhỏ để giới hạn RAM (mỗi
/// frame Retina ~20MB, 5K ~59MB — bound cũ 60 frame có thể ngốn vài GB đúng
/// lúc máy đang quá tải); pacer gửi kèm số lần lặp nên kênh đầy KHÔNG làm
/// mất thời lượng video.
const FRAME_CHANNEL_BOUND: usize = 4;

/// Payload của event `recording-tick` — emit mỗi giây từ ticker trạng thái.
/// `ms`: thời gian ghi thật (không kể thời gian paused).
#[derive(Clone, serde::Serialize)]
pub struct RecordingTick {
    pub ms: u64,
    pub paused: bool,
}

// ── Vòng đời phiên quay ───────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Idle,
    Starting,
    Recording,
    Stopping,
}

struct PhaseInfo {
    phase: Phase,
    /// Người dùng bấm dừng trong lúc đang khởi động — dừng ngay khi khởi động xong.
    stop_requested: bool,
    /// Pha `Stopping`: file đã được lưu (và đưa vào Thư viện) — phần còn lại
    /// (mở Editor) không còn liên quan tới an toàn dữ liệu.
    saved: bool,
    /// Tăng mỗi phiên — ticker trạng thái của phiên cũ tự thoát khi thấy đổi.
    generation: u64,
}

pub struct RecordingState {
    active: Mutex<Option<ActiveRecording>>,
    phase: Mutex<PhaseInfo>,
    phase_cv: Condvar,
}

impl Default for RecordingState {
    fn default() -> Self {
        RecordingState {
            active: Mutex::new(None),
            phase: Mutex::new(PhaseInfo { phase: Phase::Idle, stop_requested: false, saved: false, generation: 0 }),
            phase_cv: Condvar::new(),
        }
    }
}

fn lock_phase(st: &RecordingState) -> MutexGuard<'_, PhaseInfo> {
    st.phase.lock().unwrap_or_else(|p| p.into_inner())
}

fn lock_active(st: &RecordingState) -> MutexGuard<'_, Option<ActiveRecording>> {
    st.active.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn phase(app: &AppHandle) -> Phase {
    match app.try_state::<RecordingState>() {
        Some(st) => lock_phase(&st).phase,
        None => Phase::Idle,
    }
}

/// Đang có phiên quay ở BẤT KỲ pha nào (khởi động / quay / đang lưu).
pub fn is_busy(app: &AppHandle) -> bool {
    phase(app) != Phase::Idle
}

/// App đang thoát (`finalize_on_exit`) — bỏ mọi việc cần main thread (mở
/// Editor, dựng lại overlay, hộp thoại): ở đường Cmd+Q, `finalize_on_exit` chạy
/// NGAY TRÊN main thread nên các việc đó sẽ chặn chờ chính nó.
static EXITING: AtomicBool = AtomicBool::new(false);

fn exiting() -> bool {
    EXITING.load(Ordering::SeqCst)
}

/// Trở về `Idle` + báo mọi bên đang chờ + hiện các thông báo đã hoãn.
fn set_idle(app: &AppHandle) {
    if let Some(st) = app.try_state::<RecordingState>() {
        let mut g = lock_phase(&st);
        g.phase = Phase::Idle;
        g.stop_requested = false;
        drop(g);
        st.phase_cv.notify_all();
    }
    if !exiting() {
        crate::notify::flush_deferred(app);
    }
}

/// Vé "đang khởi động": giữ pha `Starting` tới khi `commit` (→ `Recording`);
/// bị drop mà chưa commit (mọi đường lỗi, kể cả panic) thì tự trả về `Idle`.
struct StartTicket<'a> {
    app: &'a AppHandle,
    committed: bool,
}

fn begin_start(app: &AppHandle) -> Result<StartTicket<'_>, String> {
    let st = app.state::<RecordingState>();
    let mut g = lock_phase(&st);
    match g.phase {
        Phase::Idle => {
            g.phase = Phase::Starting;
            g.stop_requested = false;
            Ok(StartTicket { app, committed: false })
        }
        Phase::Starting => Err("Đang khởi động 1 phiên quay khác — thử lại sau giây lát".to_string()),
        Phase::Recording => Err("Đã có phiên quay đang chạy".to_string()),
        Phase::Stopping => Err("Đang lưu bản quay trước — vui lòng chờ trong giây lát".to_string()),
    }
}

impl StartTicket<'_> {
    /// → `Recording`. Trả (có yêu cầu dừng trong lúc khởi động không, generation).
    fn commit(mut self, active: ActiveRecording) -> (bool, u64) {
        let st = self.app.state::<RecordingState>();
        let mut active = active;
        let mut g = lock_phase(&st);
        g.generation += 1;
        active.generation = g.generation;
        *lock_active(&st) = Some(active);
        g.phase = Phase::Recording;
        let stop = std::mem::take(&mut g.stop_requested);
        let generation = g.generation;
        drop(g);
        st.phase_cv.notify_all();
        self.committed = true;
        (stop, generation)
    }
}

impl Drop for StartTicket<'_> {
    fn drop(&mut self) {
        if !self.committed {
            set_idle(self.app);
        }
    }
}

// ── Settings ──────────────────────────────────────────────────────────────

/// Nguồn audio ghi kèm khi quay (setting `recordAudioSource`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AudioSource {
    Off,
    Mic,
    System,
    Both,
}

fn settings(app: &AppHandle) -> serde_json::Value {
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    crate::storage::settings::load(&config_dir)
}

fn audio_source_setting(s: &serde_json::Value) -> AudioSource {
    match s.get("recordAudioSource").and_then(|v| v.as_str()) {
        Some("mic") => AudioSource::Mic,
        Some("system") => AudioSource::System,
        Some("both") => AudioSource::Both,
        _ => AudioSource::Off,
    }
}

// ── Đường dẫn / dọn dẹp ───────────────────────────────────────────────────

/// Thư mục lưu video: `saveDir` đã cấu hình trong Settings, hoặc
/// `Pictures/SnapDoc` mặc định — cùng quy tắc với ảnh chụp.
fn resolve_save_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let custom_dir = settings(app)
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

/// Đường dẫn file mp4 mới: `{saveDir hoặc Pictures/SnapDoc}/Recording_<timestamp>.mp4`.
pub(crate) fn new_output_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_save_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Không tạo được thư mục lưu: {e}"))?;
    // mp4 nằm NGOÀI `$APPDATA/SnapDoc/library` (scope tĩnh trong
    // tauri.conf.json) — phải mở thêm scope asset-protocol cho đúng thư mục
    // này thì Editor/History mới phát được video.
    allow_asset_scope(app, &dir);
    // dedupe: 2 bản quay bắt đầu trong cùng 1 giây không được ghi đè nhau.
    Ok(crate::storage::save::dedupe(
        dir.join(format!("{}.mp4", crate::flow::stamp_filename("Recording"))),
    ))
}

/// Mở scope asset-protocol cho 1 thư mục chứa video.
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

/// Gọi 1 lần lúc khởi động (thread nền): khôi phục các bản quay bị gián đoạn
/// (`session::recover_orphans`), chuyển video còn kẹt trong thư mục tạm của
/// bản cũ ra thư mục lưu, rồi mới dọn rác tạm của trim/filmstrip.
pub fn cleanup_stale_temp(app: &AppHandle) {
    // Chỉ dọn thứ có TRƯỚC thời điểm này — file/thư mục do chính process này
    // đang tạo (người dùng quay/mở video ngay khi app vừa mở) không bị đụng tới.
    let scan_started = std::time::SystemTime::now();
    let older = |entry: &std::fs::DirEntry| {
        entry.metadata().and_then(|m| m.modified()).map(|t| t < scan_started).unwrap_or(false)
    };
    session::recover_orphans(app, scan_started);

    let tmp = std::env::temp_dir();
    let mut migrated = 0usize;
    if let Ok(entries) = std::fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("snapdoc-rec-audio-") {
                if session::migrate_legacy_temp(app, &entry.path()) {
                    migrated += 1;
                }
            } else if name.starts_with("snapdoc-trim-") || name.starts_with("snapdoc-filmstrip-") {
                let _ = std::fs::remove_dir_all(entry.path());
            } else if name.starts_with("snapdoc-frame-") && name.ends_with(".jpg") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    if migrated > 0 {
        crate::notify::info(
            app,
            &format!("Đã chuyển {migrated} bản quay từ thư mục tạm cũ về thư mục lưu (tên có hậu tố _recovered)."),
        );
    }
    if let Ok(dir) = resolve_save_dir(app) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // File trung gian của trim / bước hoàn tất bản quay bị bỏ dở.
                if (name.ends_with(".trimtmp.mp4") || name.ends_with(".snapdoc-part.mp4")) && older(&entry) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    if let Ok(remux) = crate::history::assets::root_dir(app).map(|r| r.join("library").join("remux")) {
        if let Ok(entries) = std::fs::read_dir(&remux) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().ends_with(".part.mp4") && older(&entry) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Khớp kích thước frame về đúng (dst_w, dst_h) đã khai với encoder khi bắt
/// đầu quay — cửa sổ bị resize giữa chừng thì crop/pad viền đen thay vì bỏ frame.
fn fit_frame_to_target(src_bgra: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
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

// ── Audio ─────────────────────────────────────────────────────────────────

/// Nguồn audio có thể dừng (mic / WASAPI loopback) — sở hữu `cpal::Stream`
/// trên thread riêng, `stop()` đóng sender để writer thấy EOF.
trait AudioCapture: Send {
    fn stop_capture(self: Box<Self>);
}

impl AudioCapture for audio_mic::MicCapture {
    fn stop_capture(self: Box<Self>) {
        (*self).stop();
    }
}

#[cfg(target_os = "windows")]
impl AudioCapture for audio_wasapi::SystemAudioCapture {
    fn stop_capture(self: Box<Self>) {
        (*self).stop();
    }
}

/// Kết quả mở 1 nguồn audio: tay cầm, kênh PCM s16le, sample rate, số kênh,
/// cờ "thiết bị lỗi giữa chừng" (rút mic, AirPods mất kết nối...).
type AudioOpen = (Box<dyn AudioCapture>, Receiver<pcm_writer::PcmChunk>, u32, u16, Arc<AtomicBool>);

struct RunningTrack {
    label: &'static str,
    capture: Option<Box<dyn AudioCapture>>,
    writer: JoinHandle<pcm_writer::PcmStats>,
    writer_stop: Arc<AtomicBool>,
    device_error: Option<Arc<AtomicBool>>,
}

/// Mọi track audio của 1 phiên. Nguồn mở chậm (mic Bluetooth có thể mất
/// 1–2s) được mở ở THREAD NỀN — quay bắt đầu ngay, phần đầu của track đó tự
/// được đệm lặng nhờ `pcm_writer` bám đồng hồ.
struct AudioSet {
    tracks: Arc<Mutex<Vec<RunningTrack>>>,
    init_threads: Vec<JoinHandle<()>>,
    aborted: Arc<AtomicBool>,
}

impl AudioSet {
    fn new() -> Self {
        AudioSet { tracks: Arc::new(Mutex::new(Vec::new())), init_threads: Vec::new(), aborted: Arc::new(AtomicBool::new(false)) }
    }

    fn spawn_writer(
        session: &Session,
        name: &'static str,
        is_mic: bool,
        rx: Receiver<pcm_writer::PcmChunk>,
        sample_rate: u32,
        channels: u16,
        clock: &Arc<RecordingClock>,
    ) -> (JoinHandle<pcm_writer::PcmStats>, Arc<AtomicBool>) {
        session.register_track(name, sample_rate, channels, is_mic);
        let stop = Arc::new(AtomicBool::new(false));
        let writer = pcm_writer::spawn(
            session.track_path(name),
            rx,
            pcm_writer::PcmFormat { sample_rate, channels },
            clock.clone(),
            stop.clone(),
        );
        (writer, stop)
    }

    /// Track mà kênh PCM đã có sẵn (audio hệ thống từ SCStream trên macOS).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn add_ready(
        &mut self,
        session: &Session,
        name: &'static str,
        rx: Receiver<pcm_writer::PcmChunk>,
        sample_rate: u32,
        channels: u16,
        clock: &Arc<RecordingClock>,
    ) {
        let (writer, writer_stop) = Self::spawn_writer(session, name, false, rx, sample_rate, channels, clock);
        self.tracks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(RunningTrack { label: "Âm thanh hệ thống", capture: None, writer, writer_stop, device_error: None });
    }

    /// Mở nguồn bằng `open` ở thread nền rồi gắn writer.
    fn add_async(
        &mut self,
        app: &AppHandle,
        session: &Session,
        name: &'static str,
        is_mic: bool,
        clock: &Arc<RecordingClock>,
        open: fn() -> Result<AudioOpen, String>,
    ) {
        let tracks = self.tracks.clone();
        let aborted = self.aborted.clone();
        let clock = clock.clone();
        let app_c = app.clone();
        let session = Session { dir: session.dir.clone() };
        let label = if is_mic { "mic" } else { "âm thanh hệ thống" };
        let spawned = std::thread::Builder::new().name(format!("snapdoc-audio-init-{name}")).spawn(move || {
            let opened = open();
            if aborted.load(Ordering::SeqCst) {
                if let Ok((cap, ..)) = opened {
                    cap.stop_capture();
                }
                return;
            }
            match opened {
                Ok((cap, rx, sample_rate, channels, err_flag)) => {
                    let (writer, writer_stop) = Self::spawn_writer(&session, name, is_mic, rx, sample_rate, channels, &clock);
                    tracks.lock().unwrap_or_else(|p| p.into_inner()).push(RunningTrack {
                        label: if is_mic { "Mic" } else { "Âm thanh hệ thống" },
                        capture: Some(cap),
                        writer,
                        writer_stop,
                        device_error: Some(err_flag),
                    });
                }
                // Báo NGAY (không đợi quay xong): quay cả tiếng rồi mới biết mất tiếng thì quá muộn.
                Err(e) => crate::notify::warning_now(&app_c, &format!("Không ghi được {label} — bản quay vẫn tiếp tục: {e}")),
            }
        });
        match spawned {
            Ok(t) => self.init_threads.push(t),
            Err(e) => crate::notify::warning(app, &format!("Không khởi tạo được {label}: {e}")),
        }
    }

    /// Dừng mọi nguồn, chờ writer ghi xong. Trả cảnh báo cho người dùng.
    fn stop_and_collect(mut self) -> Vec<String> {
        self.aborted.store(true, Ordering::SeqCst);
        for t in self.init_threads.drain(..) {
            let _ = t.join();
        }
        let tracks = std::mem::take(&mut *self.tracks.lock().unwrap_or_else(|p| p.into_inner()));
        let mut warnings = Vec::new();
        for mut t in tracks {
            if let Some(cap) = t.capture.take() {
                cap.stop_capture();
            }
            t.writer_stop.store(true, Ordering::SeqCst);
            let stats = t.writer.join().unwrap_or(pcm_writer::PcmStats { io_error: true, ..Default::default() });
            if stats.io_error {
                warnings.push(format!("{}: lỗi ghi file âm thanh tạm — phần tiếng có thể bị thiếu.", t.label));
            }
            if t.device_error.map(|f| f.load(Ordering::SeqCst)).unwrap_or(false) {
                warnings.push(format!(
                    "{}: thiết bị âm thanh bị ngắt/đổi giữa lúc quay — đoạn bị mất được thay bằng khoảng lặng.",
                    t.label
                ));
            }
        }
        warnings
    }
}

impl Drop for AudioSet {
    /// Đường lỗi lúc khởi động: dừng mọi thứ đã mở (không cần kết quả).
    fn drop(&mut self) {
        self.aborted.store(true, Ordering::SeqCst);
        for t in self.init_threads.drain(..) {
            let _ = t.join();
        }
        let tracks = std::mem::take(&mut *self.tracks.lock().unwrap_or_else(|p| p.into_inner()));
        for mut t in tracks {
            if let Some(cap) = t.capture.take() {
                cap.stop_capture();
            }
            t.writer_stop.store(true, Ordering::SeqCst);
            let _ = t.writer.join();
        }
    }
}

fn open_mic() -> Result<AudioOpen, String> {
    let (cap, rx, sr, ch, err) = audio_mic::start()?;
    Ok((Box::new(cap), rx, sr, ch, err))
}

#[cfg(target_os = "windows")]
fn open_system_audio() -> Result<AudioOpen, String> {
    let (cap, rx, sr, ch, err) = audio_wasapi::start()?;
    Ok((Box::new(cap), rx, sr, ch, err))
}

// ── Video writer ──────────────────────────────────────────────────────────

struct WriterOutcome {
    frames: u64,
    error: Option<String>,
}

/// Kéo `PacedFrame` từ pacer, ghi đủ `repeat` lần vào encoder; kênh đóng
/// (pacer xong) thì `finish()` encoder. `progress` đếm số frame đã ghi (cho
/// watchdog phát hiện ffmpeg bị treo).
fn spawn_video_writer(
    rx: Receiver<PacedFrame>,
    mut encoder: encoder::Encoder,
    progress: Arc<std::sync::atomic::AtomicU64>,
) -> JoinHandle<WriterOutcome> {
    std::thread::Builder::new()
        .name("snapdoc-record-writer".into())
        .spawn(move || {
            let (w, h) = encoder.in_size();
            let expected_len = (w as usize) * (h as usize) * 4;
            let mut frames = 0u64;
            let mut error = None;
            // Frame lệch kích thước (cửa sổ bị resize) → fit 1 lần cho mỗi frame
            // nguồn, giữ Arc để so sánh danh tính an toàn.
            let mut fitted: Option<(Arc<Frame>, Vec<u8>)> = None;
            'outer: while let Ok(msg) = rx.recv() {
                let data: &[u8] = if msg.frame.width == w && msg.frame.height == h && msg.frame.bgra.len() == expected_len {
                    &msg.frame.bgra
                } else {
                    if !fitted.as_ref().map(|(f, _)| Arc::ptr_eq(f, &msg.frame)).unwrap_or(false) {
                        let buf = fit_frame_to_target(&msg.frame.bgra, msg.frame.width, msg.frame.height, w, h);
                        fitted = Some((msg.frame.clone(), buf));
                    }
                    &fitted.as_ref().expect("vừa gán ở trên").1
                };
                for _ in 0..msg.repeat {
                    if let Err(e) = encoder.write_frame(data) {
                        error = Some(e);
                        break 'outer;
                    }
                    frames += 1;
                    progress.store(frames, Ordering::Relaxed);
                }
            }
            // Đóng kênh trước (pacer thấy Disconnected thay vì chờ mãi), rồi kết thúc encoder.
            drop(rx);
            drop(fitted);
            if error.is_none() {
                if let Err(e) = encoder.finish() {
                    error = Some(e);
                }
            } else {
                drop(encoder); // Drop: đóng stdin, chờ tối đa 3s rồi kill.
            }
            WriterOutcome { frames, error }
        })
        .expect("không tạo được thread ghi video")
}

/// Watchdog encoder: pacer có frame chờ gửi mà writer KHÔNG ghi thêm được
/// frame nào suốt `STALL_LIMIT` → ffmpeg đã treo (driver encoder phần cứng
/// kẹt...). Kill ffmpeg để writer thoát khỏi `write_all` đang chặn — ticker
/// thấy writer chết sẽ tự dừng + lưu phần đã ghi; đang dừng thì luồng dừng
/// không bị kẹt mãi ở "Đang lưu…".
const STALL_LIMIT: Duration = Duration::from_secs(30);

fn spawn_encoder_watchdog(
    killer: encoder::EncoderKiller,
    progress: Arc<std::sync::atomic::AtomicU64>,
    backlog: Arc<std::sync::atomic::AtomicU64>,
    writer_done: Arc<AtomicBool>,
) {
    let _ = std::thread::Builder::new().name("snapdoc-encoder-watchdog".into()).spawn(move || {
        let mut last = progress.load(Ordering::Relaxed);
        let mut since = Instant::now();
        while !writer_done.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(500));
            let p = progress.load(Ordering::Relaxed);
            if p != last || backlog.load(Ordering::Relaxed) == 0 {
                last = p;
                since = Instant::now();
                continue;
            }
            if since.elapsed() >= STALL_LIMIT {
                eprintln!("[SnapDoc][record] ffmpeg không nhận frame suốt {}s — dừng encoder", STALL_LIMIT.as_secs());
                killer.kill();
                return;
            }
        }
    });
}

// ── Theo dõi vị trí cửa sổ đang quay (cho telemetry chuột) ──────────────────

/// (x, y, w, h) của vùng đang quay theo toạ độ màn hình — chia sẻ với
/// listener chuột. Khi quay 1 CỬA SỔ, `WindowTracker` cập nhật gốc (x, y)
/// mỗi khi cửa sổ bị kéo đi (nội dung video luôn bám cửa sổ).
pub type SharedRect = Arc<Mutex<(f64, f64, f64, f64)>>;

struct WindowTracker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WindowTracker {
    fn spawn(window_id: u32, rect: SharedRect) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        let thread = std::thread::Builder::new()
            .name("snapdoc-window-tracker".into())
            .spawn(move || {
                while !s.load(Ordering::SeqCst) {
                    for _ in 0..10 {
                        if s.load(Ordering::SeqCst) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    let origin = xcap::Window::all().ok().and_then(|ws| {
                        ws.into_iter()
                            .find(|w| w.id().map(|i| i == window_id).unwrap_or(false))
                            .and_then(|w| Some((w.x().ok()? as f64, w.y().ok()? as f64)))
                    });
                    if let Some((x, y)) = origin {
                        let mut g = rect.lock().unwrap_or_else(|p| p.into_inner());
                        g.0 = x;
                        g.1 = y;
                    }
                }
            })
            .ok();
        WindowTracker { stop, thread }
    }
}

impl Drop for WindowTracker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

// ── Phiên quay đang chạy ──────────────────────────────────────────────────

pub struct ActiveRecording {
    // Thứ tự field = thứ tự Drop (đường lỗi): dừng nguồn input trước.
    keystroke_listener: Option<keystroke::KeystrokeListener>,
    mouse_click_listener: Option<mouse_click::MouseClickListener>,
    window_tracker: Option<WindowTracker>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    stream: stream_impl::RecordingHandle,
    pacer: Pacer,
    writer: JoinHandle<WriterOutcome>,
    audio: AudioSet,
    clock: Arc<RecordingClock>,
    session: Session,
    output_path: PathBuf,
    /// "full" | "window" | "region" — khớp `CaptureMode` phía chụp ảnh.
    capture_mode: &'static str,
    /// Kích thước thật của video (đã thu nhỏ nếu vượt 4K).
    out_size: (u32, u32),
    generation: u64,
}

/// Cửa sổ phụ cần đóng nếu khởi động thất bại giữa chừng.
struct StartCleanup<'a> {
    app: &'a AppHandle,
    armed: bool,
}

impl Drop for StartCleanup<'_> {
    fn drop(&mut self) {
        if self.armed {
            crate::windows::close_record_keystroke(self.app);
            crate::windows::close_record_clicks(self.app);
        }
    }
}

/// Thư mục phiên bị xoá nếu khởi động thất bại (chưa có dữ liệu gì đáng giữ).
struct SessionGuard {
    dir: Option<PathBuf>,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Some(d) = self.dir.take() {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

// ── Toạ độ khung viền / overlay ───────────────────────────────────────────

#[cfg(target_os = "macos")]
fn record_target_rect(target: &stream_impl::RecordTarget) -> Option<(f64, f64, f64, f64)> {
    use stream_impl::RecordTarget;
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
        RecordTarget::Region { display_id, x, y, w, h } => {
            let m = Monitor::all()
                .ok()?
                .into_iter()
                .find(|m| m.id().map(|i| i == *display_id).unwrap_or(false))?;
            Some((m.x().ok()? as f64 + *x, m.y().ok()? as f64 + *y, *w, *h))
        }
    }
}

#[cfg(target_os = "windows")]
fn record_target_rect_scaled(target: &stream_impl::RecordTarget) -> Option<(f64, f64, f64, f64, f64)> {
    use stream_impl::RecordTarget;
    use xcap::Monitor;
    match target {
        RecordTarget::Display(display_id) => {
            let m = Monitor::all()
                .ok()?
                .into_iter()
                .find(|m| m.id().map(|i| i == *display_id).unwrap_or(false))?;
            let scale = m.scale_factor().unwrap_or(1.0).max(1.0) as f64;
            Some((m.x().ok()? as f64, m.y().ok()? as f64, m.width().ok()? as f64, m.height().ok()? as f64, scale))
        }
        RecordTarget::Window(window_id) => {
            let list = crate::capture::window::list(0.0, 0.0, 1.0).ok()?;
            let w = list.into_iter().find(|w| w.id == *window_id)?;
            let scale = crate::capture::monitor::at_point(w.x as i32, w.y as i32)
                .ok()
                .and_then(|m| m.scale_factor().ok())
                .unwrap_or(1.0)
                .max(1.0) as f64;
            Some((w.x, w.y, w.width, w.height, scale))
        }
        RecordTarget::Region { display_id, x, y, w, h } => {
            let m = Monitor::all()
                .ok()?
                .into_iter()
                .find(|m| m.id().map(|i| i == *display_id).unwrap_or(false))?;
            let scale = m.scale_factor().unwrap_or(1.0).max(1.0) as f64;
            Some((m.x().ok()? as f64 + *x, m.y().ok()? as f64 + *y, *w, *h, scale))
        }
    }
}

/// Khung viền "đang quay" cho quay TOÀN màn hình / 1 CỬA SỔ — quay VÙNG trả
/// `None` vì đã có khung riêng (chính overlay chọn vùng, xem `flow::finalize_region`).
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn record_border_rect(target: &stream_impl::RecordTarget, rect: Option<(f64, f64, f64, f64)>) -> Option<(f64, f64, f64, f64)> {
    match target {
        stream_impl::RecordTarget::Region { .. } => None,
        _ => rect,
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn record_keystroke_rect(rect: (f64, f64, f64, f64), scale: f64) -> (f64, f64, f64, f64) {
    let (rx, ry, rw, rh) = rect;
    let kw = (780.0 * scale).min(rw - (20.0 * scale)).max(220.0 * scale);
    let kh = 130.0 * scale;
    let kx = rx + (rw - kw) / 2.0;
    let ky = (ry + rh - kh - (44.0 * scale)).max(ry);
    (kx, ky, kw, kh)
}

// ── Bắt đầu quay ──────────────────────────────────────────────────────────

/// Quay toàn màn hình CHÍNH (nút "Quay" mặc định + hotkey khi chỉ có 1 màn hình).
pub fn start_recording(app: &AppHandle) -> Result<(), String> {
    let monitor = crate::capture::monitor::primary()?;
    let display_id = monitor.id().map_err(|e| format!("Không đọc được id màn hình: {e}"))?;
    start_recording_monitor(app, display_id)
}

/// Quay toàn bộ 1 màn hình CỤ THỂ (người dùng chọn qua overlay).
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn start_recording_monitor(app: &AppHandle, display_id: u32) -> Result<(), String> {
    start_with_target(app, stream_impl::RecordTarget::Display(display_id))
}

/// Quay 1 VÙNG đã chọn qua overlay. Đơn vị/hệ toạ độ: xem `flow::finalize_region`.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn start_recording_region(app: &AppHandle, display_id: u32, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    start_with_target(app, stream_impl::RecordTarget::Region { display_id, x, y, w, h })
}

/// Quay 1 cửa sổ đã chọn qua overlay.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn start_recording_window(app: &AppHandle, window_id: u32) -> Result<(), String> {
    start_with_target(app, stream_impl::RecordTarget::Window(window_id))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_recording_monitor(_app: &AppHandle, _display_id: u32) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS/Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_recording_region(_app: &AppHandle, _display_id: u32, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS/Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_recording_window(_app: &AppHandle, _window_id: u32) -> Result<(), String> {
    Err("Quay màn hình hiện chỉ hỗ trợ macOS/Windows".to_string())
}

/// Những gì cần hiển thị SAU KHI phiên quay đã chính thức chạy.
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct StartedUi {
    border_rect: Option<(f64, f64, f64, f64)>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    indicator_rect: Option<(f64, f64, f64, f64, f64)>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start_with_target(app: &AppHandle, target: stream_impl::RecordTarget) -> Result<(), String> {
    let ticket = begin_start(app)?;
    let (active, ui) = start_inner(app, target)?;
    let (stop_requested, generation) = ticket.commit(active);

    if let Some((bx, by, bw, bh)) = ui.border_rect {
        if let Err(e) = crate::windows::open_record_border(app, bx, by, bw, bh) {
            eprintln!("[SnapDoc][record] Không hiện được khung viền đang quay: {e}");
        }
    }
    #[cfg(target_os = "windows")]
    if let Err(e) = crate::windows::open_recording_indicator(app, ui.indicator_rect) {
        eprintln!("[SnapDoc][record] Không hiện được popup đang quay: {e}");
    }
    // Lệnh dừng tới ĐÚNG lúc đang mở khung viền/popup (đóng trước khi chúng
    // kịp tồn tại) → tự đóng lại, không để khung đỏ kẹt trên màn hình.
    if phase(app) != Phase::Recording {
        crate::windows::close_record_border(app);
        #[cfg(target_os = "windows")]
        crate::windows::close_recording_indicator(app);
    }
    spawn_status_ticker(app.clone(), generation);
    // Tạo tray icon ở thread nền: Shell_NotifyIconW có thể mất ~760ms trên
    // Windows. `show_recording_tray` tự bỏ nếu phiên đã dừng trong lúc đó.
    let app_for_tray = app.clone();
    let _ = std::thread::Builder::new().name("snapdoc-tray-init".into()).spawn(move || {
        if phase(&app_for_tray) == Phase::Recording {
            crate::tray::show_recording_tray(&app_for_tray);
        }
    });
    if stop_requested {
        let app = app.clone();
        // Lỗi lưu file đã được `stop_recording` tự báo cho người dùng.
        std::thread::spawn(move || {
            if let Err(e) = stop_recording(&app) {
                eprintln!("[SnapDoc][record] Dừng quay (yêu cầu lúc đang khởi động) thất bại: {e}");
            }
        });
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start_inner(app: &AppHandle, target: stream_impl::RecordTarget) -> Result<(ActiveRecording, StartedUi), String> {
    use stream_impl::RecordTarget;

    let capture_mode: &'static str = match &target {
        RecordTarget::Display(_) => "full",
        RecordTarget::Region { .. } => "region",
        RecordTarget::Window(_) => "window",
    };
    let window_id = match &target {
        RecordTarget::Window(id) => Some(*id),
        _ => None,
    };

    // Phải tính TRƯỚC khi `target` bị move vào `stream_impl::start`.
    #[cfg(target_os = "macos")]
    let (target_rect, scale) = (record_target_rect(&target), 1.0);
    #[cfg(target_os = "windows")]
    let (target_rect, scale, indicator_rect) = {
        let r = record_target_rect_scaled(&target);
        (r.map(|(x, y, w, h, _)| (x, y, w, h)), r.map(|v| v.4).unwrap_or(1.0), r)
    };
    let border_rect = record_border_rect(&target, target_rect);

    let s = settings(app);
    let audio_source = audio_source_setting(&s);
    let want_system_audio = matches!(audio_source, AudioSource::System | AudioSource::Both);
    let want_mic = matches!(audio_source, AudioSource::Mic | AudioSource::Both);
    let show_keystrokes = s.get("recordShowKeystrokes").and_then(|v| v.as_bool()).unwrap_or(false);
    let show_clicks = s.get("recordShowClicks").and_then(|v| v.as_bool()).unwrap_or(true);

    let output_path = new_output_path(app)?;
    let session = Session::create(app, &output_path, capture_mode, FPS)?;
    let mut session_guard = SessionGuard { dir: Some(session.dir.clone()) };
    let clock = RecordingClock::new();
    let mut cleanup = StartCleanup { app, armed: true };

    // Overlay phím bấm / hiệu ứng click: mở TRƯỚC stream — trên macOS cần id
    // cửa sổ để SCContentFilter cho phép chúng xuất hiện trong video.
    let mut overlay_ids: Vec<u32> = Vec::new();
    let keystroke_listener = if show_keystrokes {
        if let Some(rect) = target_rect {
            let (kx, ky, kw, kh) = record_keystroke_rect(rect, scale);
            match crate::windows::open_record_keystroke(app, kx, ky, kw, kh) {
                Ok(id) => overlay_ids.extend(id),
                Err(e) => eprintln!("[SnapDoc][record] Không hiện được overlay phím bấm: {e}"),
            }
        }
        match keystroke::KeystrokeListener::start(app.clone()) {
            Ok(l) => Some(l),
            Err(e) => {
                crate::notify::warning_now(app, &format!("Không hiển thị được phím bấm: {e}"));
                None
            }
        }
    } else {
        None
    };
    if show_clicks {
        if let Some((cx, cy, cw, ch)) = target_rect {
            match crate::windows::open_record_clicks(app, cx, cy, cw, ch) {
                Ok(id) => overlay_ids.extend(id),
                Err(e) => eprintln!("[SnapDoc][record] Không hiện được overlay click chuột: {e}"),
            }
        }
    }
    #[cfg(target_os = "windows")]
    let _ = &overlay_ids;

    // Telemetry chuột (auto-zoom trong Editor) — luôn bật, kể cả khi tắt hiệu ứng click.
    let shared_rect: Option<SharedRect> = target_rect.map(|r| Arc::new(Mutex::new(r)));
    let window_tracker = match (window_id, &shared_rect) {
        (Some(id), Some(rect)) => Some(WindowTracker::spawn(id, rect.clone())),
        _ => None,
    };
    let mouse_click_listener = match &shared_rect {
        Some(rect) => match mouse_click::MouseClickListener::start(app.clone(), rect.clone(), clock.clone(), scale) {
            Ok(l) => Some(l),
            Err(e) => {
                eprintln!("[SnapDoc][record] Không bật được theo dõi chuột: {e}");
                None
            }
        },
        None => None,
    };

    // Nguồn quay video.
    #[cfg(target_os = "macos")]
    let (stream, system_audio_rx) = {
        let record_self = crate::storage::settings::is_record_self(app);
        stream_impl::start(target, FPS, want_system_audio, !record_self, &overlay_ids)?
    };
    #[cfg(target_os = "windows")]
    let stream = stream_impl::start(target, FPS)?;
    #[cfg(target_os = "windows")]
    if let Some(w) = &stream.warning {
        crate::notify::warning_now(app, w);
    }
    let (width, height) = (stream.width, stream.height);

    // Audio.
    let mut audio = AudioSet::new();
    #[cfg(target_os = "macos")]
    if let Some(rx) = system_audio_rx {
        audio.add_ready(&session, "system", rx, stream_impl::AUDIO_SAMPLE_RATE, stream_impl::AUDIO_CHANNELS, &clock);
    }
    #[cfg(target_os = "windows")]
    if want_system_audio {
        audio.add_async(app, &session, "system", false, &clock, open_system_audio);
    }
    if want_mic {
        audio.add_async(app, &session, "mic", true, &clock, open_mic);
    }

    // Encoder + writer + pacer (+ watchdog).
    let encoder = encoder::Encoder::start(&session.video_path(), width, height, FPS)?;
    let out_size = encoder.out_size();
    let killer = encoder.killer();
    let (tx, rx) = std::sync::mpsc::sync_channel::<PacedFrame>(FRAME_CHANNEL_BOUND);
    let progress = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let writer_done = Arc::new(AtomicBool::new(false));
    let writer = {
        let inner = spawn_video_writer(rx, encoder, progress.clone());
        let done = writer_done.clone();
        // Bọc để báo "writer đã xong" cho watchdog.
        std::thread::Builder::new()
            .name("snapdoc-record-writer-wait".into())
            .spawn(move || {
                let r = inner.join().unwrap_or(WriterOutcome { frames: 0, error: Some("Luồng ghi video bị panic".to_string()) });
                done.store(true, Ordering::SeqCst);
                r
            })
            .map_err(|e| format!("Không tạo được thread ghi video: {e}"))?
    };
    let pacer = Pacer::spawn(stream.latest(), clock.clone(), FPS, tx);
    spawn_encoder_watchdog(killer, progress, pacer.backlog(), writer_done);

    // Mốc 0 CHÍNH THỨC — video, audio, telemetry và đồng hồ hiển thị đều tính từ đây.
    clock.start();

    cleanup.armed = false;
    session_guard.dir = None;
    let active = ActiveRecording {
        keystroke_listener,
        mouse_click_listener,
        window_tracker,
        stream,
        pacer,
        writer,
        audio,
        clock,
        session,
        output_path,
        capture_mode,
        out_size,
        generation: 0,
    };
    Ok((
        active,
        StartedUi {
            border_rect,
            #[cfg(target_os = "windows")]
            indicator_rect,
            #[cfg(not(target_os = "windows"))]
            indicator_rect: None,
        },
    ))
}

// ── Ticker trạng thái ─────────────────────────────────────────────────────

/// Mỗi giây: cập nhật đồng hồ tray + emit `recording-tick` cho indicator, và
/// GIÁM SÁT phiên quay:
/// - nguồn quay bị hệ thống dừng (nút "Stop sharing" của macOS, màn hình bị
///   ngắt, cửa sổ đang quay bị đóng...) → tự dừng + lưu,
/// - encoder chết giữa chừng (ffmpeg crash, đầy đĩa) → tự dừng + lưu phần đã
///   ghi + báo lỗi — trước đây UI vẫn "đang quay" hàng giờ mà không ghi gì.
fn spawn_status_ticker(app: AppHandle, generation: u64) {
    let _ = std::thread::Builder::new().name("snapdoc-record-ticker".into()).spawn(move || loop {
        let snapshot = {
            let st = app.state::<RecordingState>();
            let g = lock_active(&st);
            match g.as_ref() {
                Some(a) if a.generation == generation => Some((
                    a.clock.elapsed_ms().unwrap_or(0),
                    a.clock.is_paused(),
                    a.stream.is_stopped_externally(),
                    a.writer.is_finished(),
                )),
                _ => None,
            }
        };
        let Some((ms, paused, external_stop, writer_dead)) = snapshot else { break };
        if writer_dead || external_stop {
            let reason = if writer_dead {
                "Bộ mã hoá video đã dừng bất thường (có thể do đầy ổ đĩa) — phần đã quay được lưu lại."
            } else {
                "Hệ thống đã dừng việc ghi màn hình (màn hình bị ngắt, cửa sổ đang quay bị đóng hoặc bạn bấm dừng chia sẻ màn hình) — phần đã quay được lưu lại."
            };
            crate::notify::warning(&app, reason);
            // Lỗi lưu file đã được `stop_recording` tự báo cho người dùng.
            if let Err(e) = stop_recording(&app) {
                eprintln!("[SnapDoc][record] Tự dừng quay thất bại: {e}");
            }
            break;
        }
        if !paused {
            crate::tray::update_recording_time(&app, ms);
        }
        let _ = app.emit("recording-tick", RecordingTick { ms, paused });
        std::thread::sleep(Duration::from_secs(1));
    });
}

// ── Dừng quay ─────────────────────────────────────────────────────────────

/// Dừng phiên quay hiện tại, hoàn tất file (ghép audio nếu có), ingest NGAY
/// vào History rồi mở Editor (chế độ video). Trả đường dẫn file mp4 cuối
/// (chuỗi rỗng nếu không có gì để dừng — gọi trùng từ nhiều nơi là no-op).
pub fn stop_recording(app: &AppHandle) -> Result<String, String> {
    stop_recording_impl(app, true)
}

/// Gọi TRƯỚC khi thoát app (tray "Quit", restart, cài update, Cmd+Q...):
/// dừng SẠCH phiên đang quay (hoặc CHỜ phiên đang lưu dở xong) để file mp4
/// hoàn chỉnh và có trong Library. Không mở Editor. No-op nếu không quay.
pub fn finalize_on_exit(app: &AppHandle) {
    let Some(st) = app.try_state::<RecordingState>() else { return };
    if lock_phase(&st).phase == Phase::Idle {
        return;
    }
    EXITING.store(true, Ordering::SeqCst);
    // Lưu bản quay dài có thể mất vài chục giây — chờ tối đa 10 phút.
    let deadline = Instant::now() + Duration::from_secs(600);
    // Đường Cmd+Q/Dock Quit của macOS gọi hàm này NGAY TRÊN main thread: không
    // được chờ việc nào cần main thread (tạo cửa sổ lúc khởi động, mở Editor).
    let on_main_thread = std::thread::current().name() == Some("main");
    loop {
        let (current, saved) = {
            let g = lock_phase(&st);
            (g.phase, g.saved)
        };
        match current {
            Phase::Idle => return,
            // File đã an toàn — phần còn lại chỉ là mở Editor.
            Phase::Stopping if saved => return,
            Phase::Starting if on_main_thread => {
                eprintln!("[SnapDoc][record] Thoát app giữa lúc đang khởi động quay — bỏ qua");
                return;
            }
            Phase::Recording => {
                match stop_recording_impl(app, false) {
                    Ok(p) if !p.is_empty() => eprintln!("[SnapDoc][record] Đã lưu bản quay trước khi thoát: {p}"),
                    Ok(_) => {}
                    Err(e) => eprintln!("[SnapDoc][record] Không dừng sạch được phiên quay trước khi thoát: {e}"),
                }
            }
            Phase::Starting | Phase::Stopping => {
                let now = Instant::now();
                if now >= deadline {
                    eprintln!("[SnapDoc][record] Hết thời gian chờ phiên quay hoàn tất trước khi thoát");
                    return;
                }
                let g = lock_phase(&st);
                if g.phase == current && g.saved == saved {
                    let _ = st.phase_cv.wait_timeout(g, (deadline - now).min(Duration::from_millis(500)));
                }
            }
        }
    }
}

/// Báo cho `finalize_on_exit` (nếu đang chờ) là dữ liệu đã an toàn trên đĩa.
fn mark_saved(app: &AppHandle) {
    let st = app.state::<RecordingState>();
    lock_phase(&st).saved = true;
    st.phase_cv.notify_all();
}

/// Gỡ icon tray + trả pha về `Idle` khi rời khỏi hàm dừng ở MỌI đường (kể cả panic).
struct IdleOnDrop<'a>(&'a AppHandle);

impl Drop for IdleOnDrop<'_> {
    fn drop(&mut self) {
        crate::tray::hide_recording_tray(self.0);
        set_idle(self.0);
    }
}

fn stop_recording_impl(app: &AppHandle, open_editor_after: bool) -> Result<String, String> {
    let st = app.state::<RecordingState>();
    {
        let mut g = lock_phase(&st);
        match g.phase {
            Phase::Recording => {
                g.phase = Phase::Stopping;
                g.saved = false;
            }
            // Đang khởi động: ghi nhận yêu cầu, dừng ngay khi khởi động xong.
            Phase::Starting => {
                g.stop_requested = true;
                return Ok(String::new());
            }
            // Đang lưu / không quay: lệnh dừng trùng (tray + hotkey + indicator...) → no-op.
            Phase::Stopping | Phase::Idle => return Ok(String::new()),
        }
    }
    let _idle = IdleOnDrop(app);
    let Some(active) = lock_active(&st).take() else { return Ok(String::new()) };

    // 1. Dọn giao diện "đang quay" NGAY — không bắt người dùng nhìn khung đỏ
    //    trong lúc chờ lưu file (icon tray chuyển sang "Đang lưu…", gỡ hẳn khi
    //    xong). Không prewarm overlay ở đây: Editor mở sau đó tự đóng +
    //    prewarm lại (tránh dựng pool overlay 2 lần).
    crate::tray::set_recording_tray_saving(app);
    crate::windows::close_overlays_no_prewarm(app);
    crate::windows::close_stop_control(app);
    crate::windows::close_record_border(app);
    crate::windows::close_record_keystroke(app);
    crate::windows::close_record_clicks(app);
    #[cfg(target_os = "windows")]
    crate::windows::close_recording_indicator(app);

    let ActiveRecording {
        keystroke_listener,
        mouse_click_listener,
        window_tracker,
        stream,
        pacer,
        writer,
        audio,
        clock,
        session,
        output_path,
        capture_mode,
        out_size,
        generation: _,
    } = active;

    // 2. Chốt độ dài: đóng băng đồng hồ — video (pacer) và audio (writer) cùng
    //    dừng ĐÚNG tại mốc này.
    clock.stop();
    if let Some(mut kl) = keystroke_listener {
        kl.stop();
    }
    let mut mouse_click_listener = mouse_click_listener;
    if let Some(ml) = mouse_click_listener.as_mut() {
        ml.stop();
    }
    drop(window_tracker);

    let mut warnings: Vec<String> = Vec::new();

    // 3. Tắt NGUỒN trước (màn hình + mic — đèn báo ghi của hệ thống tắt ngay,
    //    kể cả khi encoder còn phải xử lý nốt phần tồn đọng). Frame cuối vẫn
    //    nằm trong `LatestFrame` cho pacer dùng. Dừng SCStream cũng đóng
    //    sender audio hệ thống.
    let latest_frame = stream.latest();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Err(e) = stream.stop() {
        eprintln!("[SnapDoc][record] Cảnh báo dừng nguồn quay: {e}");
    }
    warnings.extend(audio.stop_and_collect());
    // 4. Đẩy nốt frame còn nợ tới mốc dừng, đóng kênh → writer kết thúc encoder.
    let lagging = pacer.lagging();
    pacer.finish();
    drop(latest_frame);
    // 5. Chờ encoder ghi xong.
    let outcome = writer.join().unwrap_or(WriterOutcome { frames: 0, error: Some("Luồng ghi video bị panic".to_string()) });
    if let Some(e) = &outcome.error {
        warnings.push(format!("Bộ mã hoá video gặp lỗi: {e}"));
    }
    if lagging {
        warnings.push("Máy không theo kịp tốc độ quay ở một số đoạn — video có thể bị giật nhẹ.".to_string());
    }

    // 7. Hoàn tất file (ghép audio, kiểm tra, đổi tên). Lỗi → GIỮ thư mục
    //    phiên để khôi phục ở lần mở app sau, không mất bản quay.
    let finalized = match finalize::finalize(&session.video_path(), &session.tracks(), &output_path) {
        Ok(f) => {
            // Chỉ xoá thư mục phiên SAU KHI file đã vào Thư viện (bên dưới) —
            // crash ở giữa thì lần mở sau dựa vào marker này để hoàn tất nốt.
            session.mark_finalized(&f.path);
            f
        }
        Err(e) => {
            for w in &warnings {
                crate::notify::warning(app, w);
            }
            mark_saved(app);
            if !exiting() {
                crate::windows::prewarm_overlays(app);
            }
            let msg = format!("Không lưu được bản quay: {e}");
            crate::notify::error(app, &msg);
            return Err(msg);
        }
    };
    warnings.extend(finalized.warnings.iter().cloned());
    let final_path = finalized.path;
    if let Some(parent) = final_path.parent() {
        allow_asset_scope(app, parent);
    }

    // Thời lượng THẬT = số frame đã ghi / fps (khớp file 100%).
    let duration_ms: i64 = if outcome.frames > 0 {
        (outcome.frames * 1000 / FPS as u64) as i64
    } else {
        clock.elapsed_ms().unwrap_or(0) as i64
    };
    let (width, height) = out_size;

    if let Some(ml) = mouse_click_listener.as_ref() {
        if let Err(e) = ml.save_telemetry(app, &final_path, width, height, duration_ms as u64) {
            eprintln!("[SnapDoc][record] Lưu telemetry chuột thất bại: {e}");
        }
    }

    for w in &warnings {
        crate::notify::warning(app, w);
    }

    let path = final_path.to_string_lossy().to_string();
    let ingested = crate::history::ingest_video(app, &final_path, width, height, duration_ms, capture_mode);
    // Chưa vào được Thư viện → giữ thư mục phiên (đã có marker hoàn tất): lần
    // mở app sau `recover_orphans` tự thêm file này vào Thư viện.
    if ingested.is_ok() {
        session.remove();
    }
    mark_saved(app);
    if exiting() {
        if let Err(e) = ingested {
            eprintln!("[SnapDoc][record] Ingest bản quay trước khi thoát thất bại (file vẫn ở {path}): {e}");
        }
        return Ok(path);
    }
    match ingested {
        Ok(record) if open_editor_after => {
            let pending = PendingVideo {
                path: path.clone(),
                width,
                height,
                duration_ms,
                history_id: record.id,
                thumb_path: Some(record.thumb_path),
            };
            match app.state::<AppState>().pending_video.lock() {
                Ok(mut g) => *g = Some(pending),
                Err(p) => *p.into_inner() = Some(pending),
            }
            // Editor mở lên (chế độ video) tự đọc `PendingVideo` qua `takePendingVideo`.
            if let Err(e) = crate::windows::open_editor(app) {
                eprintln!("[SnapDoc][record] Không mở được Editor để xem bản quay vừa lưu: {e}");
                crate::windows::prewarm_overlays(app);
            }
        }
        Ok(_) => crate::windows::prewarm_overlays(app),
        Err(e) => {
            crate::windows::prewarm_overlays(app);
            crate::notify::warning(
                app,
                &format!("Bản quay đã lưu tại {path} nhưng chưa đưa được vào Thư viện ({e}) — sẽ tự thử lại ở lần mở app sau."),
            );
        }
    }
    Ok(path)
}

// ── Trạng thái / pause ────────────────────────────────────────────────────

/// Thời gian đã quay (ms, không kể thời gian pause) nếu đang quay.
pub fn status(app: &AppHandle) -> Option<u64> {
    let st = app.try_state::<RecordingState>()?;
    let g = lock_active(&st);
    g.as_ref().map(|a| a.clock.elapsed_ms().unwrap_or(0))
}

/// `None` nếu không quay, `Some(true)` nếu đang pause.
pub fn paused_state(app: &AppHandle) -> Option<bool> {
    let st = app.try_state::<RecordingState>()?;
    let g = lock_active(&st);
    g.as_ref().map(|a| a.clock.is_paused())
}

fn set_paused(app: &AppHandle, pause: bool) -> Result<(), String> {
    let changed = {
        let st = app.state::<RecordingState>();
        if lock_phase(&st).phase != Phase::Recording {
            return Err("Không có phiên quay nào đang chạy".to_string());
        }
        let g = lock_active(&st);
        let Some(active) = g.as_ref() else {
            return Err("Không có phiên quay nào đang chạy".to_string());
        };
        if pause {
            active.clock.pause()
        } else {
            active.clock.resume()
        }
    };
    if changed {
        let _ = app.emit("recording-paused", pause);
        // Mọi đường pause (tray, indicator, IPC) đều cập nhật nhãn menu tray.
        crate::tray::update_recording_tray_menu(app);
    }
    Ok(())
}

/// Tạm dừng phiên quay hiện tại. No-op nếu đã pause.
pub fn pause_recording(app: &AppHandle) -> Result<(), String> {
    set_paused(app, true)
}

/// Tiếp tục sau khi tạm dừng. No-op nếu đang chạy.
pub fn resume_recording(app: &AppHandle) -> Result<(), String> {
    set_paused(app, false)
}

#[cfg(test)]
mod pipeline_tests {
    //! Chạy TOÀN BỘ pipeline của 1 phiên quay (trừ API chụp màn hình của OS,
    //! cần quyền Screen Recording): nguồn frame giả → pacer → writer → ffmpeg
    //! (MP4 phân mảnh) + audio PCM có khoảng lặng kiểu WASAPI + pause giữa
    //! chừng → finalize. Kiểm tra file cuối có ĐÚNG thời lượng theo đồng hồ.
    use super::*;
    use crate::capture::frame::{new_latest, publish};

    #[test]
    fn full_pipeline_keeps_duration_and_audio_through_gaps_and_pause() {
        if encoder::sidecar_path("ffmpeg").is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("snapdoc_pipeline_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let session = Session { dir: dir.clone() };
        let (w, h) = (320u32, 240u32);

        let clock = RecordingClock::new();
        let latest = new_latest();
        let stop_src = Arc::new(AtomicBool::new(false));

        // Nguồn video giả: đổi nội dung ~20 lần/giây (giống màn hình thật — không đều).
        let src = {
            let (latest, stop) = (latest.clone(), stop_src.clone());
            std::thread::spawn(move || {
                let mut i = 0u8;
                while !stop.load(Ordering::SeqCst) {
                    publish(&latest, Frame { bgra: vec![i; (w * h * 4) as usize], width: w, height: h });
                    i = i.wrapping_add(7);
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
        };

        // Audio giả 48kHz stereo: có tiếng 0.5s đầu, IM LẶNG (không gói nào) 1s, rồi có tiếng lại.
        let (atx, arx) = std::sync::mpsc::sync_channel::<pcm_writer::PcmChunk>(200);
        session.register_track("system", 48_000, 2, false);
        let audio_stop = Arc::new(AtomicBool::new(false));
        let pcm = pcm_writer::spawn(
            session.track_path("system"),
            arx,
            pcm_writer::PcmFormat { sample_rate: 48_000, channels: 2 },
            clock.clone(),
            audio_stop.clone(),
        );
        let audio_src = {
            let (clock, stop) = (clock.clone(), stop_src.clone());
            std::thread::spawn(move || {
                let chunk = vec![1u8; 480 * 4]; // 10ms
                while !stop.load(Ordering::SeqCst) {
                    let t = clock.elapsed_ms().unwrap_or(0);
                    if !(500..1500).contains(&t) {
                        let _ = atx.try_send((Instant::now(), chunk.clone()));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
        };

        let enc = encoder::Encoder::start(&session.video_path(), w, h, FPS).unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel::<PacedFrame>(FRAME_CHANNEL_BOUND);
        let writer = spawn_video_writer(rx, enc, Arc::new(std::sync::atomic::AtomicU64::new(0)));
        let pacer = Pacer::spawn(latest.clone(), clock.clone(), FPS, tx);

        clock.start();
        std::thread::sleep(Duration::from_millis(1800));
        clock.pause();
        std::thread::sleep(Duration::from_millis(700)); // không được tính
        clock.resume();
        std::thread::sleep(Duration::from_millis(700));

        // Trình tự dừng giống `stop_recording_impl`.
        clock.stop();
        let expected_ms = clock.elapsed_ms().unwrap();
        let expected_frames = pacer::frames_due(clock.elapsed().unwrap(), FPS);
        pacer.finish();
        stop_src.store(true, Ordering::SeqCst);
        src.join().unwrap();
        audio_src.join().unwrap();
        audio_stop.store(true, Ordering::SeqCst);
        let stats = pcm.join().unwrap();
        let outcome = writer.join().unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        assert_eq!(outcome.frames, expected_frames, "số frame ghi ra phải đúng bằng số frame theo đồng hồ");
        assert!(stats.padded >= Duration::from_millis(800), "khoảng im lặng phải được đệm: {:?}", stats.padded);

        let out = dir.join("final.mp4");
        let done = finalize::finalize(&session.video_path(), &session.tracks(), &out).unwrap();
        assert!(done.warnings.is_empty(), "{:?}", done.warnings);
        let meta = probe::probe_video_metadata(&done.path).unwrap();
        let frames_ms = (outcome.frames * 1000 / FPS as u64) as i64;
        assert!(
            (meta.duration_ms - expected_ms as i64).abs() <= 150,
            "thời lượng file {}ms phải khớp đồng hồ {}ms (frames={}ms)",
            meta.duration_ms,
            expected_ms,
            frames_ms
        );
        assert!((expected_ms as i64 - 2500).abs() < 300, "pause 700ms không được tính: {expected_ms}ms");

        // File cuối phải có cả audio.
        let mut cmd = std::process::Command::new(encoder::sidecar_path("ffmpeg").unwrap());
        cmd.args(["-hide_banner", "-i"]).arg(&done.path);
        let info = proc::run(&mut cmd, Duration::from_secs(20)).unwrap();
        assert!(info.stderr.contains("Audio: aac"), "thiếu track audio:\n{}", info.stderr);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
