//! Thư mục làm việc của 1 phiên quay + khôi phục bản quay bị gián đoạn.
//!
//! Mỗi phiên ghi vào `{app_data}/SnapDoc/rec-sessions/<uuid>/`:
//! - `video.mp4`   — MP4 phân mảnh do encoder ghi trực tiếp (xem `encoder.rs`),
//! - `mic.pcm`, `system.pcm` + `*.json` — audio thô và định dạng của nó,
//! - `session.json` — đích lưu, chế độ quay, pid của process đang ghi.
//!
//! KHÔNG dùng thư mục tạm của OS như bản cũ: macOS tự dọn `/var/folders` sau
//! vài ngày, Windows Disk Cleanup dọn `%TEMP%`, và chính app từng xoá mọi
//! `snapdoc-rec-audio-*` lúc khởi động — trong khi History có thể đang trỏ vào
//! video nằm trong đó (nhánh ghép audio lỗi). Thư mục phiên CHỈ bị xoá sau khi
//! `finalize` đã ghi + kiểm tra xong file cuối cùng; còn sót lại nghĩa là app
//! đã thoát/crash giữa chừng → `recover_orphans` hoàn tất nốt ở lần mở sau.

use super::finalize::{self, Track};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const VIDEO_FILE: &str = "video.mp4";
const META_FILE: &str = "session.json";
/// Ghi SAU KHI file cuối đã nằm ở thư mục lưu — crash từ đó tới lúc xoá thư
/// mục phiên thì lần khôi phục sau chỉ cần đưa file đó vào Thư viện, không
/// hoàn tất lại (tránh tạo bản trùng).
const DONE_FILE: &str = "finalized.json";
/// Tiền tố thư mục đang dựng dở (chưa có `session.json`) — recovery bỏ qua.
const STAGING_PREFIX: &str = ".staging-";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub version: u32,
    pub pid: u32,
    pub output_path: String,
    pub capture_mode: String,
    pub fps: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct TrackMeta {
    sample_rate: u32,
    channels: u16,
    is_mic: bool,
}

pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::history::assets::root_dir(app)?.join("rec-sessions"))
}

pub struct Session {
    pub dir: PathBuf,
}

impl Session {
    pub fn create(app: &AppHandle, output: &Path, capture_mode: &str, fps: u32) -> Result<Self, String> {
        let root = root(app)?;
        let id = uuid::Uuid::new_v4().to_string();
        // Dựng trong thư mục staging rồi mới đổi tên: recovery (chạy song song
        // lúc mở app) không bao giờ thấy 1 thư mục phiên thiếu `session.json`.
        let staging = root.join(format!("{STAGING_PREFIX}{id}"));
        std::fs::create_dir_all(&staging).map_err(|e| format!("Không tạo được thư mục phiên quay: {e}"))?;
        let meta = SessionMeta {
            version: 1,
            pid: std::process::id(),
            output_path: output.to_string_lossy().to_string(),
            capture_mode: capture_mode.to_string(),
            fps,
        };
        let json = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
        let dir = root.join(&id);
        if let Err(e) = std::fs::write(staging.join(META_FILE), json).and_then(|_| std::fs::rename(&staging, &dir)) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("Không ghi được thông tin phiên quay: {e}"));
        }
        Ok(Session { dir })
    }

    /// File cuối đã nằm ở `path` — xem `DONE_FILE`.
    pub fn mark_finalized(&self, path: &Path) {
        let json = serde_json::json!({ "path": path.to_string_lossy() }).to_string();
        if let Err(e) = std::fs::write(self.dir.join(DONE_FILE), json) {
            eprintln!("[SnapDoc][record] Không ghi được marker hoàn tất: {e}");
        }
    }

    pub fn video_path(&self) -> PathBuf {
        self.dir.join(VIDEO_FILE)
    }

    pub fn track_path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.pcm"))
    }

    /// Ghi định dạng của 1 track audio TRƯỚC khi bắt đầu ghi PCM — cần cho cả
    /// bước hoàn tất bình thường lẫn khôi phục sau crash.
    pub fn register_track(&self, name: &str, sample_rate: u32, channels: u16, is_mic: bool) {
        let meta = TrackMeta { sample_rate, channels, is_mic };
        if let Ok(json) = serde_json::to_vec(&meta) {
            if let Err(e) = std::fs::write(self.dir.join(format!("{name}.json")), json) {
                eprintln!("[SnapDoc][record] Không ghi được thông tin track {name}: {e}");
            }
        }
    }

    pub fn tracks(&self) -> Vec<Track> {
        read_tracks(&self.dir)
    }

    pub fn remove(&self) {
        if let Err(e) = std::fs::remove_dir_all(&self.dir) {
            eprintln!("[SnapDoc][record] Không xoá được thư mục phiên {}: {e}", self.dir.display());
        }
    }
}

/// Mic luôn đứng trước audio hệ thống — thứ tự trộn cố định.
fn read_tracks(dir: &Path) -> Vec<Track> {
    let mut out = Vec::new();
    for name in ["mic", "system"] {
        let pcm = dir.join(format!("{name}.pcm"));
        let Ok(raw) = std::fs::read(dir.join(format!("{name}.json"))) else { continue };
        let Ok(m) = serde_json::from_slice::<TrackMeta>(&raw) else { continue };
        if pcm.exists() {
            out.push(Track { path: pcm, sample_rate: m.sample_rate, channels: m.channels, is_mic: m.is_mic });
        }
    }
    out
}

/// Kết quả kiểm tra 1 file video: đọc được / chắc chắn hỏng / KHÔNG kiểm tra
/// được (thiếu ffmpeg, bị antivirus chặn, timeout...) — trường hợp cuối KHÔNG
/// được coi là hỏng để xoá dữ liệu.
enum Readable {
    Yes,
    No,
    Unknown,
}

fn check_video(path: &Path) -> Readable {
    if !std::fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false) {
        return Readable::No;
    }
    match super::probe::probe_video_metadata(path) {
        Ok(_) => Readable::Yes,
        Err(e) if e.starts_with("Không đọc được luồng video") => Readable::No,
        Err(_) => Readable::Unknown,
    }
}

/// Video không cứu được nhưng audio còn → lưu riêng ra WAV (không mất tiếng).
fn salvage_audio(app: &AppHandle, dir: &Path, output_hint: Option<&Path>) -> usize {
    let tracks: Vec<Track> = read_tracks(dir)
        .into_iter()
        .filter(|t| std::fs::metadata(&t.path).map(|m| m.len() > 4096).unwrap_or(false))
        .collect();
    if tracks.is_empty() {
        return 0;
    }
    let base = match output_hint {
        Some(p) if p.parent().map(|d| std::fs::create_dir_all(d).is_ok()).unwrap_or(false) => p.to_path_buf(),
        _ => match super::new_output_path(app) {
            Ok(p) => p,
            Err(_) => return 0,
        },
    };
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("Recording").to_string();
    let mut n = 0;
    for t in &tracks {
        let suffix = if t.is_mic { "mic" } else { "system" };
        let wav = crate::storage::save::dedupe(base.with_file_name(format!("{stem}_{suffix}_recovered.wav")));
        if super::finalize::export_wav_pub(t, &wav).is_ok() {
            n += 1;
        } else {
            let _ = std::fs::remove_file(&wav);
        }
    }
    n
}

/// Hoàn tất + đưa vào History mọi phiên quay bị bỏ dở (app crash/bị kill/tắt
/// máy giữa lúc quay hoặc lúc đang lưu). Gọi 1 lần lúc khởi động, ở thread nền.
pub fn recover_orphans(app: &AppHandle, scan_started: std::time::SystemTime) {
    // Không có ffmpeg thì không kiểm tra/hoàn tất được gì — giữ nguyên mọi thứ.
    if super::encoder::sidecar_path("ffmpeg").is_err() {
        return;
    }
    let Ok(root) = root(app) else { return };
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    let me = std::process::id();
    let mut recovered = 0usize;
    let mut audio_only = 0usize;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        // Thư mục tạo/sửa SAU khi bắt đầu quét = phiên của chính process này.
        let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(scan_started);
        if modified >= scan_started {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(STAGING_PREFIX) {
            // Dựng dở từ phiên trước (crash ngay lúc tạo) — chưa có dữ liệu gì.
            let _ = std::fs::remove_dir_all(&dir);
            continue;
        }
        let meta: Option<SessionMeta> = std::fs::read(dir.join(META_FILE))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok());
        if meta.as_ref().map(|m| m.pid == me).unwrap_or(false) {
            continue;
        }
        let capture_mode = meta.as_ref().map(|m| m.capture_mode.clone()).unwrap_or_else(|| "full".to_string());
        let output_hint = meta.as_ref().map(|m| PathBuf::from(&m.output_path));

        // Crash SAU khi file cuối đã lưu xong: chỉ cần chắc chắn nó có trong Thư viện.
        let done_path = std::fs::read(dir.join(DONE_FILE))
            .ok()
            .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(PathBuf::from));
        if let Some(done) = done_path {
            if done.exists() {
                let in_library = crate::history::find_history_item_by_asset_path_sync(app, &done.to_string_lossy())
                    .map(|r| r.is_some())
                    .unwrap_or(false);
                if !in_library && ingest_recovered(app, &done, &capture_mode) {
                    recovered += 1;
                }
                let _ = std::fs::remove_dir_all(&dir);
                continue;
            }
        }

        let video = dir.join(VIDEO_FILE);
        match check_video(&video) {
            Readable::Unknown => {
                eprintln!("[SnapDoc][record] Chưa kiểm tra được phiên quay {} — thử lại lần sau", dir.display());
                continue;
            }
            Readable::No => {
                // Video không cứu được — vẫn giữ lại audio (nếu có) rồi mới dọn.
                audio_only += salvage_audio(app, &dir, output_hint.as_deref());
                eprintln!("[SnapDoc][record] Bỏ phiên quay không có video đọc được: {}", dir.display());
                let _ = std::fs::remove_dir_all(&dir);
                continue;
            }
            Readable::Yes => {}
        }
        let output = match output_hint.clone() {
            Some(p) if p.parent().map(|d| std::fs::create_dir_all(d).is_ok()).unwrap_or(false) => {
                crate::storage::save::dedupe(p)
            }
            _ => match super::new_output_path(app) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[SnapDoc][record] Không có thư mục lưu để khôi phục bản quay: {e}");
                    continue;
                }
            },
        };
        match finalize::finalize(&video, &read_tracks(&dir), &output) {
            Ok(done) => {
                Session { dir: dir.clone() }.mark_finalized(&done.path);
                if ingest_recovered(app, &done.path, &capture_mode) {
                    recovered += 1;
                }
                let _ = std::fs::remove_dir_all(&dir);
            }
            // Lỗi I/O tạm thời (đầy đĩa, ổ lưu chưa mount...) — giữ nguyên để thử lại lần sau.
            Err(e) => eprintln!("[SnapDoc][record] Khôi phục bản quay {} thất bại, thử lại lần sau: {e}", dir.display()),
        }
    }
    if recovered > 0 {
        crate::notify::info(
            app,
            &format!(
                "Đã khôi phục {recovered} bản quay bị gián đoạn (app đã thoát giữa lúc quay) — bạn có thể xem trong Thư viện."
            ),
        );
    }
    if audio_only > 0 {
        crate::notify::info(
            app,
            &format!("Đã khôi phục {audio_only} file âm thanh (.wav) từ bản quay bị gián đoạn không còn hình — nằm trong thư mục lưu."),
        );
    }
}

fn ingest_recovered(app: &AppHandle, path: &Path, capture_mode: &str) -> bool {
    if let Some(parent) = path.parent() {
        super::allow_asset_scope(app, parent);
    }
    let meta = match super::probe::probe_video_metadata(path) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[SnapDoc][record] Không đọc được bản quay đã khôi phục {}: {e}", path.display());
            return false;
        }
    };
    match crate::history::ingest_video(app, path, meta.width, meta.height, meta.duration_ms, capture_mode) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[SnapDoc][record] Đưa bản quay khôi phục vào Thư viện thất bại (file vẫn ở {}): {e}", path.display());
            true
        }
    }
}

/// Thư mục tạm `snapdoc-rec-audio-*` của các bản TRƯỚC: bản cũ để video nằm
/// lại trong đó khi ghép audio lỗi (và History trỏ thẳng vào file đó), rồi tự
/// xoá cả thư mục ở lần khởi động sau. Giờ chuyển video ra thư mục lưu, trỏ
/// lại History, rồi mới dọn.
pub fn migrate_legacy_temp(app: &AppHandle, dir: &Path) -> bool {
    let video = dir.join("video.mp4");
    let mut migrated = false;
    let readable = if video.exists() { check_video(&video) } else { Readable::No };
    if matches!(readable, Readable::Unknown) {
        // Không kiểm tra được (thiếu ffmpeg/timeout) — KHÔNG xoá, thử lại lần sau.
        return false;
    }
    if matches!(readable, Readable::Yes) {
        let target = super::new_output_path(app).map(|p| {
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("Recording").to_string();
            crate::storage::save::dedupe(p.with_file_name(format!("{stem}_recovered.mp4")))
        });
        match target {
            Ok(target) => match std::fs::copy(&video, &target) {
                Ok(_) => {
                    let old = video.to_string_lossy().to_string();
                    let new = target.to_string_lossy().to_string();
                    let relinked = crate::history::commands::relink_video_asset_sync(app, &old, &new).unwrap_or(0);
                    if relinked == 0 {
                        ingest_recovered(app, &target, "full");
                    }
                    migrated = true;
                }
                Err(e) => {
                    // Không copy được (đầy đĩa...) → KHÔNG xoá, thử lại lần sau.
                    eprintln!("[SnapDoc][record] Không chuyển được video tạm cũ {}: {e}", video.display());
                    return false;
                }
            },
            Err(e) => {
                eprintln!("[SnapDoc][record] Không có thư mục lưu để chuyển video tạm cũ: {e}");
                return false;
            }
        }
    }
    let _ = std::fs::remove_dir_all(dir);
    migrated
}
