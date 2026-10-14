//! Hoàn tất 1 bản quay: từ video MP4 phân mảnh + các file PCM thô trong thư
//! mục phiên (`record::session`) → 1 file MP4 thường (faststart) ở thư mục lưu.
//!
//! Nguyên tắc AN TOÀN DỮ LIỆU (bản cũ từng xoá mất video ở vài nhánh):
//! - Không bao giờ đụng vào file nguồn trong thư mục phiên — caller chỉ xoá
//!   thư mục phiên SAU KHI hàm này trả `Ok`.
//! - Ghi ra file `.snapdoc-part.mp4` cạnh file đích, KIỂM TRA đọc lại được
//!   luồng video, rồi mới đổi tên thành file đích (cùng thư mục → atomic).
//! - Thứ tự dự phòng: ghép audio → (lỗi) ghép 1 nguồn không bộ lọc → (lỗi)
//!   chỉ video + XUẤT AUDIO RA FILE WAV cạnh video (không bao giờ mất tiếng) →
//!   (lỗi) copy nguyên file phân mảnh (vẫn phát được) → (lỗi) trả `Err`, giữ
//!   nguyên thư mục phiên để lần mở app sau khôi phục lại.
//! - Kiểm tra file kết quả đọc được VÀ đủ thời lượng so với video nguồn.
//! - Audio luôn được `apad` + `-shortest`: audio ngắn hơn video thì đệm lặng,
//!   dài hơn thì cắt — video KHÔNG BAO GIỜ bị cắt theo audio (bản cũ dùng
//!   `-shortest` trần nên audio hụt là video bị cắt cụt).

use std::path::{Path, PathBuf};
use std::process::Command;

/// 1 track audio PCM s16le thô.
#[derive(Clone, Debug)]
pub struct Track {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub is_mic: bool,
}

pub struct Finalized {
    pub path: PathBuf,
    /// Cảnh báo cho người dùng (vd ghép audio lỗi nên bản quay không có tiếng).
    pub warnings: Vec<String>,
}

/// Bộ lọc riêng cho từng nguồn: mic được chuẩn hoá âm lượng (giọng nói to rõ,
/// chống vỡ tiếng), audio hệ thống giữ nguyên.
const MIC_FILTER: &str = "dynaudnorm=f=150:g=15:p=0.95:m=10.0";

/// Track có ít nhất 1 frame audio thật — file rỗng làm ffmpeg lỗi "no streams".
fn usable(t: &Track) -> bool {
    let frame = t.channels.max(1) as u64 * 2;
    t.sample_rate > 0
        && t.channels > 0
        && std::fs::metadata(&t.path).map(|m| m.len() >= frame).unwrap_or(false)
}

/// Dựng tham số ffmpeg (KHÔNG gồm tên binary) để ghép `tracks` vào `video` → `out`.
/// `plain`: không dùng bộ lọc nào ngoài `apad` (đường dự phòng khi bộ lọc lỗi).
fn mux_args(video: &Path, tracks: &[&Track], out: &Path, plain: bool) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = Vec::new();
    let mut push = |v: &str| a.push(v.into());
    for v in ["-hide_banner", "-loglevel", "error", "-y", "-i"] {
        push(v);
    }
    a.push(video.as_os_str().to_owned());
    for t in tracks {
        let (sr, ch) = (t.sample_rate.to_string(), t.channels.to_string());
        for v in ["-f", "s16le", "-ar", sr.as_str(), "-ac", ch.as_str(), "-i"] {
            a.push(v.into());
        }
        a.push(t.path.as_os_str().to_owned());
    }
    let mut push = |v: &str| a.push(v.into());
    push("-map");
    push("0:v:0");
    match tracks {
        [] => {
            for v in ["-c", "copy"] {
                push(v);
            }
        }
        [t] => {
            let chain = if t.is_mic && !plain { format!("{MIC_FILTER},apad") } else { "apad".to_string() };
            for v in ["-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-af", chain.as_str(), "-shortest"] {
                push(v);
            }
        }
        [t1, t2, ..] => {
            // Mic (nếu có) to rõ, audio hệ thống làm nền 0.45× để không lấn giọng nói.
            let f = |i: usize, t: &Track| {
                if t.is_mic {
                    format!("[{i}:a]{MIC_FILTER}[a{i}]")
                } else {
                    format!("[{i}:a]volume=0.45[a{i}]")
                }
            };
            let graph = format!(
                "{};{};[a1][a2]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,apad[aout]",
                f(1, t1),
                f(2, t2)
            );
            for v in [
                "-filter_complex", graph.as_str(), "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
            ] {
                push(v);
            }
        }
    }
    for v in ["-movflags", "+faststart", "-f", "mp4"] {
        push(v);
    }
    a.push(out.as_os_str().to_owned());
    a
}

fn run_ffmpeg(args: &[std::ffi::OsString], timeout: std::time::Duration, what: &str) -> Result<(), String> {
    let ffmpeg = super::encoder::sidecar_path("ffmpeg")?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(args);
    super::proc::run_ok(&mut cmd, timeout, what).map(|_| ())
}

/// Thời lượng (giây) của 1 track PCM.
fn track_secs(t: &Track) -> u64 {
    let bytes_per_sec = t.sample_rate.max(1) as u64 * t.channels.max(1) as u64 * 2;
    std::fs::metadata(&t.path).map(|m| m.len() / bytes_per_sec).unwrap_or(0)
}

/// Timeout cho lệnh ghép: theo dung lượng video (remux) + độ dài audio (mã
/// hoá AAC ~2–3s mỗi phút audio; cho dư gấp vài lần).
fn mux_timeout(video: &Path, tracks: &[&Track]) -> std::time::Duration {
    let audio_secs: u64 = tracks.iter().map(|t| track_secs(t)).sum();
    super::proc::timeout_for_file(video) + std::time::Duration::from_secs(audio_secs / 6)
}

/// File đích đọc được luồng video VÀ không ngắn hơn video nguồn (trừ sai số).
fn verify(path: &Path, src_duration_ms: i64) -> Result<(), String> {
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if len == 0 {
        return Err("file kết quả rỗng".to_string());
    }
    let meta = super::probe::probe_video_metadata(path)?;
    let tolerance = (src_duration_ms / 20).max(1000);
    if src_duration_ms > 0 && meta.duration_ms + tolerance < src_duration_ms {
        return Err(format!("file kết quả bị ngắn ({}ms so với {}ms)", meta.duration_ms, src_duration_ms));
    }
    Ok(())
}

/// Ghi 1 track PCM s16le thành file WAV (header 44 byte + dữ liệu) — đường
/// cuối cùng để KHÔNG mất tiếng khi ghép vào video thất bại.
fn export_wav(t: &Track, out: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let data_len = std::fs::metadata(&t.path)?.len();
    let clamp = |v: u64| v.min(u32::MAX as u64) as u32;
    let byte_rate = t.sample_rate * t.channels as u32 * 2;
    let mut f = std::io::BufWriter::new(std::fs::File::create(out)?);
    f.write_all(b"RIFF")?;
    f.write_all(&clamp(data_len + 36).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&t.channels.to_le_bytes())?;
    f.write_all(&t.sample_rate.to_le_bytes())?;
    f.write_all(&byte_rate.to_le_bytes())?;
    f.write_all(&(t.channels * 2).to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&clamp(data_len).to_le_bytes())?;
    std::io::copy(&mut std::fs::File::open(&t.path)?, &mut f)?;
    f.flush()
}

pub(super) fn export_wav_pub(t: &Track, out: &Path) -> std::io::Result<()> {
    export_wav(t, out)
}

/// Đường dẫn file tạm cạnh `output` (cùng thư mục → rename atomic).
fn part_path(output: &Path) -> PathBuf {
    let stem = output.file_stem().and_then(|s| s.to_str()).unwrap_or("Recording");
    output.with_file_name(format!("{stem}.snapdoc-part.mp4"))
}

/// Xem doc-comment đầu module.
pub fn finalize(video: &Path, tracks: &[Track], output: &Path) -> Result<Finalized, String> {
    let video_len = std::fs::metadata(video).map(|m| m.len()).unwrap_or(0);
    if video_len == 0 {
        return Err("Không có dữ liệu video nào được ghi".to_string());
    }
    if let Some(dir) = output.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Không tạo được thư mục lưu {}: {e}", dir.display()))?;
    }
    let part = part_path(output);
    let mut warnings = Vec::new();
    let usable_tracks: Vec<&Track> = tracks.iter().filter(|t| usable(t)).collect();
    // Thời lượng video nguồn — chuẩn để kiểm tra file kết quả không bị cắt cụt.
    let src_duration_ms = super::probe::probe_video_metadata(video).map(|m| m.duration_ms).unwrap_or(0);
    let timeout = mux_timeout(video, &usable_tracks);

    let attempt = |label: &str, f: &dyn Fn() -> Result<(), String>| -> bool {
        let _ = std::fs::remove_file(&part);
        match f().and_then(|_| verify(&part, src_duration_ms)) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[SnapDoc][record] Hoàn tất bản quay ({label}) thất bại: {e}");
                let _ = std::fs::remove_file(&part);
                false
            }
        }
    };

    let mut done = false;
    let mut audio_lost = false;
    if !usable_tracks.is_empty() {
        done = attempt("ghép audio", &|| run_ffmpeg(&mux_args(video, &usable_tracks, &part, false), timeout, "Ghép audio"));
        if !done {
            // Dự phòng: chỉ 1 nguồn (ưu tiên mic), không bộ lọc.
            let first = [usable_tracks[0]];
            done = attempt("ghép 1 nguồn audio", &|| run_ffmpeg(&mux_args(video, &first, &part, true), timeout, "Ghép audio"));
            if done && usable_tracks.len() > 1 {
                audio_lost = true;
                warnings.push("Không trộn được 2 nguồn âm thanh — bản quay chỉ có tiếng mic.".to_string());
            } else if !done {
                audio_lost = true;
            }
        }
    }
    if !done {
        done = attempt("chỉ video", &|| run_ffmpeg(&mux_args(video, &[], &part, true), timeout, "Remux video"));
    }
    if !done {
        // MP4 phân mảnh gốc vẫn phát được — thà giữ nguyên còn hơn mất bản quay.
        done = attempt("copy nguyên bản", &|| {
            std::fs::copy(video, &part).map(|_| ()).map_err(|e| format!("copy lỗi: {e}"))
        });
    }
    if !done {
        return Err("Không hoàn tất được file video (bản quay vẫn được giữ lại và sẽ được khôi phục ở lần mở app sau)".to_string());
    }

    // Không ghi đè file đã tồn tại (tên đã dedupe từ lúc bắt đầu quay, nhưng
    // phòng trường hợp người dùng tự tạo trùng tên trong lúc quay).
    let final_path = if output.exists() { crate::storage::save::dedupe(output.to_path_buf()) } else { output.to_path_buf() };
    std::fs::rename(&part, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("Không đổi tên được file video hoàn tất: {e}")
    })?;

    // Âm thanh không vào được video → lưu riêng từng nguồn ra WAV cạnh video
    // (thư mục phiên — nơi chứa PCM gốc — sẽ bị xoá sau khi hàm này trả Ok).
    if audio_lost {
        let stem = final_path.file_stem().and_then(|s| s.to_str()).unwrap_or("Recording").to_string();
        let mut saved = Vec::new();
        for t in &usable_tracks {
            let suffix = if t.is_mic { "mic" } else { "system" };
            let wav = crate::storage::save::dedupe(final_path.with_file_name(format!("{stem}_{suffix}.wav")));
            match export_wav(t, &wav) {
                Ok(()) => saved.push(wav.to_string_lossy().to_string()),
                Err(e) => {
                    let _ = std::fs::remove_file(&wav);
                    return Err(format!("Ghép âm thanh thất bại và không lưu riêng được âm thanh ({e}) — bản quay được giữ lại để khôi phục ở lần mở app sau"));
                }
            }
        }
        if !saved.is_empty() {
            warnings.push(format!(
                "Không ghép được âm thanh vào video — âm thanh được lưu riêng tại:\n{}",
                saved.join("\n")
            ));
        }
    }
    Ok(Finalized { path: final_path, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::encoder::Encoder;

    fn has_ffmpeg() -> bool {
        crate::record::encoder::sidecar_path("ffmpeg").is_ok()
    }

    /// Video phân mảnh 3s (10fps × 30 frame) giống encoder live tạo ra.
    fn make_video(dir: &Path) -> PathBuf {
        let p = dir.join("video.mp4");
        let mut enc = Encoder::start(&p, 160, 120, 10).expect("Encoder::start");
        for i in 0..30u32 {
            let mut f = vec![0u8; 160 * 120 * 4];
            for px in f.chunks_exact_mut(4) {
                px[0] = (i * 8) as u8;
                px[3] = 255;
            }
            enc.write_frame(&f).unwrap();
        }
        enc.finish().unwrap();
        p
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snapdoc_finalize_{name}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn duration_ms(p: &Path) -> i64 {
        crate::record::probe::probe_video_metadata(p).unwrap().duration_ms
    }

    #[test]
    fn short_audio_never_truncates_video() {
        if !has_ffmpeg() {
            return;
        }
        let d = tmpdir("short_audio");
        let video = make_video(&d);
        // Audio chỉ 0.5s trong khi video 3s (vd WASAPI im lặng phần sau).
        let pcm = d.join("system.pcm");
        std::fs::write(&pcm, vec![0u8; 48_000 * 2 * 2 / 2]).unwrap();
        let out = d.join("out.mp4");
        let r = finalize(&video, &[Track { path: pcm, sample_rate: 48_000, channels: 2, is_mic: false }], &out).unwrap();
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        let dur = duration_ms(&r.path);
        assert!(dur >= 2800, "video bị cắt cụt theo audio: {dur}ms");
        assert!(video.exists(), "không được đụng vào file nguồn");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn dual_audio_mix_works() {
        if !has_ffmpeg() {
            return;
        }
        let d = tmpdir("dual");
        let video = make_video(&d);
        let mic = d.join("mic.pcm");
        std::fs::write(&mic, vec![0u8; 44_100 * 2 * 3]).unwrap();
        let sys = d.join("system.pcm");
        std::fs::write(&sys, vec![0u8; 48_000 * 4]).unwrap();
        let out = d.join("out.mp4");
        let tracks = [
            Track { path: mic, sample_rate: 44_100, channels: 1, is_mic: true },
            Track { path: sys, sample_rate: 48_000, channels: 2, is_mic: false },
        ];
        let r = finalize(&video, &tracks, &out).unwrap();
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        assert!(duration_ms(&r.path) >= 2800);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn broken_audio_falls_back_to_video_only() {
        if !has_ffmpeg() {
            return;
        }
        let d = tmpdir("broken_audio");
        let video = make_video(&d);
        let pcm = d.join("mic.pcm");
        std::fs::write(&pcm, vec![0u8; 4096]).unwrap();
        let out = d.join("out.mp4");
        // sample_rate vô lý → ffmpeg từ chối → phải rơi về chỉ video, KHÔNG mất bản quay,
        // và âm thanh được lưu riêng ra WAV.
        let r = finalize(&video, &[Track { path: pcm, sample_rate: 999_999_999, channels: 2, is_mic: true }], &out).unwrap();
        assert_eq!(r.warnings.len(), 1, "{:?}", r.warnings);
        assert!(duration_ms(&r.path) >= 2800);
        let wav = r.path.with_file_name(format!("{}_mic.wav", r.path.file_stem().unwrap().to_str().unwrap()));
        assert_eq!(std::fs::metadata(&wav).unwrap().len(), 4096 + 44, "WAV phải chứa đủ dữ liệu PCM");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_tracks_are_skipped_and_existing_output_is_not_overwritten() {
        if !has_ffmpeg() {
            return;
        }
        let d = tmpdir("empty_tracks");
        let video = make_video(&d);
        let empty = d.join("mic.pcm");
        std::fs::write(&empty, b"").unwrap();
        let out = d.join("out.mp4");
        std::fs::write(&out, b"user file").unwrap();
        let r = finalize(&video, &[Track { path: empty, sample_rate: 48_000, channels: 1, is_mic: true }], &out).unwrap();
        assert_ne!(r.path, out, "không được ghi đè file đã có");
        assert_eq!(std::fs::read(&out).unwrap(), b"user file");
        assert!(r.warnings.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_video_is_an_error() {
        let d = tmpdir("missing");
        assert!(finalize(&d.join("nope.mp4"), &[], &d.join("out.mp4")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
