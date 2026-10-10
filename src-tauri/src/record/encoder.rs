//! Encode video quay màn hình: chạy `ffmpeg` như sidecar binary (đóng gói
//! cùng app qua `tauri.conf.json` → `bundle.externalBin`), nhận raw frame
//! BGRA qua stdin, xuất H.264.
//!
//! KHÔNG dùng `tauri-plugin-shell` cho việc này: API sidecar cấp cao của
//! plugin (`CommandChild`) không cho đóng RIÊNG stdin (chỉ có `write()` và
//! `kill()`) — mà ffmpeg cần thấy EOF trên stdin để flush encoder rồi tự
//! thoát. Dùng thẳng `std::process::Command` để ta tự kiểm soát vòng đời:
//! đóng `ChildStdin` (drop) → ffmpeg tự kết thúc sạch → `wait()` lấy exit
//! code. Việc tìm binary vẫn theo đúng quy ước sidecar của Tauri (nằm cạnh
//! executable chính sau khi CLI copy theo `externalBin`).
//!
//! File ghi TRONG LÚC QUAY là MP4 PHÂN MẢNH (`frag_keyframe+empty_moov`,
//! keyframe mỗi 2 giây, `-flush_packets 1` để mỗi fragment xuống đĩa ngay —
//! thiếu cờ này, nội dung ít chuyển động nằm hết trong bộ đệm của ffmpeg và
//! file chỉ có vài chục byte tới tận lúc dừng): mỗi fragment tự chứa đủ thông
//! tin để phát, nên nếu app bị crash/kill/mất điện giữa chừng, phần đã ghi
//! vẫn khôi phục được (xem `record::session::recover_orphans`). MP4 thường chỉ ghi `moov` lúc kết
//! thúc — chết giữa chừng là mất trắng cả bản quay. Bước hoàn tất sau khi
//! dừng (`record::finalize`) remux lại thành MP4 thường + `faststart`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Tham số muxer của file ghi trong lúc quay (xem doc-comment đầu module).
const LIVE_MUX_ARGS: [&str; 6] =
    ["-flush_packets", "1", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Kích thước tối đa encode (cạnh dài × cạnh ngắn). Lớn hơn (màn 5K/6K,
/// ultrawide 5120×1440...) vượt giới hạn H.264 của nhiều encoder phần cứng và
/// đẩy hàng GB/s qua pipe — thu nhỏ về trong khung này (giữ tỉ lệ).
pub const MAX_LONG_EDGE: u32 = 3840;
pub const MAX_SHORT_EDGE: u32 = 2160;

/// Tìm binary sidecar cạnh executable hiện tại — cùng quy ước
/// `tauri-plugin-shell` dùng cho `externalBin`: lúc `tauri dev`/`tauri build`,
/// CLI copy `binaries/ffmpeg-<target-triple>` → cạnh binary chính, bỏ hậu tố
/// triple. Khi chạy qua `cargo test`, executable nằm trong `target/debug/deps/`
/// nên phải lùi lên 1 cấp mới đúng chỗ CLI sẽ copy tới.
pub(crate) fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Không đọc được đường dẫn executable: {e}"))?;
    let exe_dir = exe.parent().ok_or("Executable không có thư mục cha")?;
    let base_dir = if exe_dir.ends_with("deps") {
        exe_dir.parent().unwrap_or(exe_dir)
    } else {
        exe_dir
    };
    #[allow(unused_mut)]
    let mut path = base_dir.join(name);
    #[cfg(windows)]
    {
        path.set_extension("exe");
    }
    if !path.exists() {
        return Err(format!(
            "Không tìm thấy sidecar '{name}' tại {} — kiểm tra bundle.externalBin trong tauri.conf.json \
             và src-tauri/binaries/{name}-<target-triple>",
            path.display()
        ));
    }
    Ok(path)
}

/// Các encoder H.264 có thể dùng, theo thứ tự ưu tiên.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum H264Kind {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Nvenc,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Qsv,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Amf,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    MediaFoundation,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    VideoToolbox,
    X264,
}

/// Bitrate mục tiêu cho các encoder chỉ hỗ trợ bitrate (không có chế độ chất
/// lượng cố định): ~0.08 bit/pixel/frame, kẹp trong [4, 40] Mbps.
fn target_bitrate(w: u32, h: u32, fps: u32) -> String {
    let (w, h) = if w == 0 || h == 0 { (1920, 1080) } else { (w, h) };
    let bps = (w as f64 * h as f64 * fps.max(1) as f64 * 0.08).clamp(4.0e6, 40.0e6);
    format!("{}k", (bps / 1000.0).round() as u64)
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Tham số encode cho 1 loại encoder ở kích thước `w×h` (`0×0` = không rõ).
fn kind_args(kind: H264Kind, w: u32, h: u32, fps: u32) -> Vec<String> {
    let br = target_bitrate(w, h, fps);
    let large = (w as u64) * (h as u64) > 1920 * 1200;
    match kind {
        H264Kind::Nvenc => s(&["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p"]),
        H264Kind::Qsv => s(&["-c:v", "h264_qsv", "-global_quality", "23", "-pix_fmt", "nv12"]),
        H264Kind::Amf => s(&[
            "-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23", "-pix_fmt", "yuv420p",
        ]),
        H264Kind::MediaFoundation => {
            let mut a = s(&["-c:v", "h264_mf", "-b:v"]);
            a.push(br);
            a.extend(s(&["-pix_fmt", "yuv420p"]));
            a
        }
        H264Kind::VideoToolbox => {
            // `-q:v` (chất lượng cố định) CHỈ được ffmpeg bật cho VideoToolbox
            // trên Apple Silicon — Mac Intel báo lỗi "-q:v qscale not
            // available", khiến bản cũ luôn rơi về libx264 (không theo kịp ở
            // độ phân giải Retina). Mac Intel dùng bitrate.
            let mut a = s(&["-c:v", "h264_videotoolbox", "-realtime", "1"]);
            if cfg!(target_arch = "aarch64") {
                a.extend(s(&["-q:v", "60"]));
            } else {
                a.push("-b:v".into());
                a.push(br);
            }
            a.extend(s(&["-pix_fmt", "yuv420p"]));
            a
        }
        H264Kind::X264 => {
            // Khung hình lớn (Retina/2K+) với veryfast không encode kịp 30fps
            // trên CPU — dùng ultrafast, chấp nhận file lớn hơn.
            if cfg!(target_os = "windows") || large {
                s(&["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "24", "-pix_fmt", "yuv420p"])
            } else {
                s(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"])
            }
        }
    }
}

fn candidates() -> &'static [H264Kind] {
    #[cfg(target_os = "windows")]
    {
        &[H264Kind::Nvenc, H264Kind::Qsv, H264Kind::Amf, H264Kind::MediaFoundation, H264Kind::X264]
    }
    #[cfg(target_os = "macos")]
    {
        &[H264Kind::VideoToolbox, H264Kind::X264]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        &[H264Kind::X264]
    }
}

/// Encode thử vài frame đen `w×h` bằng `kind`, ghi ra ĐÚNG muxer MP4 phân
/// mảnh như lúc quay thật (vài encoder chỉ lỗi khi muxer cần global header) —
/// có timeout (driver lỗi có thể treo vô hạn).
fn test_encoder(ffmpeg: &Path, kind: H264Kind, w: u32, h: u32, fps: u32) -> bool {
    let out = std::env::temp_dir().join(format!("snapdoc-enc-test-{}.mp4", uuid::Uuid::new_v4()));
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("color=c=black:s={w}x{h}:r={fps}"))
        .args(["-frames:v", "3"])
        .args(kind_args(kind, w, h, fps))
        .args(["-g", &(fps.max(1) * 2).to_string()])
        .args(LIVE_MUX_ARGS)
        .arg(&out);
    let ok = match super::proc::run(&mut cmd, Duration::from_secs(15)) {
        Ok(r) => r.status.success() && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false),
        Err(e) => {
            eprintln!("[SnapDoc][record] Thử encoder {kind:?} {w}x{h} lỗi: {e}");
            false
        }
    };
    let _ = std::fs::remove_file(&out);
    ok
}

/// Encoder dùng được trên máy này (thử ở kích thước nhỏ, cache cả phiên app).
static DETECTED: std::sync::OnceLock<Vec<H264Kind>> = std::sync::OnceLock::new();
/// Kết quả thử encoder ở ĐÚNG kích thước quay (encoder phần cứng có giới hạn
/// kích thước riêng, chạy được 320×240 chưa chắc chạy được 5120×1440). Kết quả
/// THẤT BẠI chỉ giữ 10 phút — có thể chỉ là tạm thời (vd NVENC hết phiên do
/// app khác đang dùng), không được khoá encoder phần cứng cả phiên app.
static VALIDATED: Mutex<Vec<(H264Kind, u32, u32, bool, Instant)>> = Mutex::new(Vec::new());
const FAILED_RETRY_AFTER: Duration = Duration::from_secs(600);

fn detected(ffmpeg: &Path) -> &'static [H264Kind] {
    DETECTED.get_or_init(|| {
        let mut ok: Vec<H264Kind> = candidates()
            .iter()
            .copied()
            .filter(|&k| k == H264Kind::X264 || test_encoder(ffmpeg, k, 320, 240, 30))
            .collect();
        if !ok.contains(&H264Kind::X264) {
            ok.push(H264Kind::X264);
        }
        eprintln!("[SnapDoc][record] Encoder H.264 khả dụng: {ok:?}");
        ok
    })
}

fn validated_at(ffmpeg: &Path, kind: H264Kind, w: u32, h: u32, fps: u32) -> bool {
    if kind == H264Kind::X264 {
        return true;
    }
    {
        let mut g = VALIDATED.lock().unwrap_or_else(|p| p.into_inner());
        g.retain(|&(_, _, _, ok, at)| ok || at.elapsed() < FAILED_RETRY_AFTER);
        if let Some(&(_, _, _, ok, _)) = g.iter().find(|(k, kw, kh, _, _)| *k == kind && *kw == w && *kh == h) {
            return ok;
        }
    }
    let ok = test_encoder(ffmpeg, kind, w, h, fps);
    VALIDATED.lock().unwrap_or_else(|p| p.into_inner()).push((kind, w, h, ok, Instant::now()));
    if !ok {
        eprintln!("[SnapDoc][record] Encoder {kind:?} không chạy được ở {w}x{h}, thử encoder kế tiếp");
    }
    ok
}

/// Pre-warm dò encoder ở nền lúc khởi động app — lần quay đầu không phải chờ.
pub fn prewarm_encoder() {
    std::thread::Builder::new()
        .name("snapdoc-encoder-prewarm".into())
        .spawn(|| {
            if let Ok(ffmpeg) = sidecar_path("ffmpeg") {
                let _ = detected(&ffmpeg);
            }
        })
        .ok();
}

/// Tham số encoder tốt nhất cho các tác vụ KHÔNG phải quay trực tiếp (cắt
/// video, áp hiệu ứng...) — kích thước tuỳ ý nên dùng tham số mặc định.
fn best_h264_encoder_args(ffmpeg: &Path) -> &'static [String] {
    static ARGS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ARGS.get_or_init(|| kind_args(detected(ffmpeg)[0], 0, 0, 30))
}

/// Tiến trình ffmpeg đang encode — ghi frame qua `write_frame`, kết thúc
/// bằng `finish()` (đóng stdin, đợi ffmpeg ghi xong).
///
/// `stderr_thread` bọc `Option` để cả `finish()` lẫn `Drop` đều join được —
/// `Drop` là lưới an toàn cho nhánh LỖI (vd `write_frame` gặp broken pipe):
/// không có nó, `Child` bị drop mà không `kill()`/`wait()` → tiến trình
/// ffmpeg thành zombie (Unix không tự reap con).
pub struct Encoder {
    /// Dùng chung với `EncoderKiller` — watchdog ở thread khác kill được
    /// ffmpeg bị treo (writer đang kẹt trong `write_all` không tự thoát được).
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    stderr_thread: Option<std::thread::JoinHandle<()>>,
    in_size: (u32, u32),
    out_size: (u32, u32),
    finished: bool,
}

/// Tay cầm kill tiến trình ffmpeg từ thread khác (watchdog của phiên quay).
#[derive(Clone)]
pub struct EncoderKiller(Arc<Mutex<Child>>);

impl EncoderKiller {
    pub fn kill(&self) {
        let _ = self.0.lock().unwrap_or_else(|p| p.into_inner()).kill();
    }
}

/// Chờ tiến trình kết thúc tối đa `timeout` (quá hạn thì kill) — chỉ giữ lock
/// trong từng lần `try_wait` để `EncoderKiller` vẫn kill được song song.
fn wait_shared(child: &Mutex<Child>, timeout: Duration) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let mut c = child.lock().unwrap_or_else(|p| p.into_inner());
            match c.try_wait() {
                Ok(Some(status)) => return Ok(status),
                Ok(None) if Instant::now() >= deadline => {
                    let _ = c.kill();
                    let _ = c.wait();
                    return Err(format!("quá thời gian chờ ({}s)", timeout.as_secs()));
                }
                Ok(None) => {}
                Err(e) => {
                    let _ = c.kill();
                    let _ = c.wait();
                    return Err(format!("lỗi chờ tiến trình: {e}"));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // Đóng stdin để ffmpeg thấy EOF → flush; chờ tối đa 3s cho nó tự thoát
        // sạch, quá hạn thì kill để không rò process. File phân mảnh vẫn giữ
        // được mọi fragment đã ghi xong.
        drop(self.stdin.take());
        let _ = wait_shared(&self.child, Duration::from_secs(3));
        if let Some(t) = self.stderr_thread.take() {
            let _ = t.join();
        }
    }
}

impl Encoder {
    /// Bắt đầu 1 tiến trình ffmpeg nhận rawvideo BGRA (`width`×`height`, `fps`
    /// khung/giây) qua stdin, encode H.264 (phần cứng nếu chạy được ở đúng
    /// kích thước này, không thì libx264), ghi MP4 PHÂN MẢNH tại `output_path`.
    /// Khung lớn hơn `MAX_LONG_EDGE×MAX_SHORT_EDGE` được ffmpeg thu nhỏ — xem
    /// `out_size()` để biết kích thước thật của video.
    pub fn start(output_path: &Path, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        let ffmpeg = sidecar_path("ffmpeg")?;
        let (ow, oh) = crate::capture::frame::fit_even(width, height, MAX_LONG_EDGE, MAX_SHORT_EDGE);
        let kind = detected(&ffmpeg)
            .iter()
            .copied()
            .find(|&k| validated_at(&ffmpeg, k, ow, oh, fps))
            .unwrap_or(H264Kind::X264);

        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgra", "-s"])
            .arg(format!("{width}x{height}"))
            .arg("-r")
            .arg(fps.to_string())
            .args(["-i", "pipe:0"]);
        if (ow, oh) != (width, height) {
            cmd.args(["-vf", &format!("scale={ow}:{oh}:flags=bilinear")]);
        }
        cmd.args(kind_args(kind, ow, oh, fps))
            // Keyframe mỗi 2 giây: mỗi keyframe mở 1 fragment mới (giới hạn
            // phần mất khi crash ~2s) và giúp cắt/tua chính xác hơn.
            .args(["-g", &(fps.max(1) * 2).to_string()])
            .args(LIVE_MUX_ARGS)
            .arg(output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;
        eprintln!("[SnapDoc][record] Encoder {kind:?}, vào {width}x{height}, ra {ow}x{oh} @{fps}fps");

        // Phải đọc liên tục stderr — pipe đầy (thường 64KB) sẽ làm ffmpeg
        // treo khi ghi log lỗi, kéo theo cả write_frame() bị chặn.
        let stderr = child.stderr.take().expect("stderr đã được piped ở trên");
        let stderr_thread = std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[ffmpeg] {line}");
            }
        });

        let stdin = child.stdin.take();
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            stdin,
            stderr_thread: Some(stderr_thread),
            in_size: (width, height),
            out_size: (ow, oh),
            finished: false,
        })
    }

    pub fn killer(&self) -> EncoderKiller {
        EncoderKiller(self.child.clone())
    }

    /// Kích thước frame đầu vào (đúng `-s` đã khai với ffmpeg).
    pub fn in_size(&self) -> (u32, u32) {
        self.in_size
    }

    /// Kích thước thật của video ghi ra (đã thu nhỏ nếu vượt giới hạn).
    pub fn out_size(&self) -> (u32, u32) {
        self.out_size
    }

    /// Ghi 1 frame BGRA thô (đúng `width*height*4` byte) vào stdin ffmpeg.
    pub fn write_frame(&mut self, data: &[u8]) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or_else(|| "ffmpeg đã đóng stdin".to_string())?;
        stdin
            .write_all(data)
            .map_err(|e| format!("Lỗi ghi frame vào ffmpeg: {e}"))
    }

    /// Đóng stdin (ffmpeg thấy EOF → flush fragment cuối + tự thoát), đợi
    /// tiến trình kết thúc (tối đa 2 phút — hết hạn thì kill: mọi fragment đã
    /// ghi trước đó vẫn dùng được) và kiểm tra exit code.
    pub fn finish(mut self) -> Result<(), String> {
        drop(self.stdin.take());
        let status = wait_shared(&self.child, Duration::from_secs(120)).map_err(|e| format!("ffmpeg không kết thúc: {e}"));
        self.finished = true;
        if let Some(t) = self.stderr_thread.take() {
            let _ = t.join();
        }
        let status = status?;
        if !status.success() {
            return Err(format!("ffmpeg thoát với lỗi: {status}"));
        }
        Ok(())
    }
}

/// Stream copy video nhanh mà không cần re-encode, chỉ loại bỏ audio stream (-an).
pub fn copy_without_audio(input_path: &Path, output_path: &Path) -> Result<(), String> {
    let ffmpeg = sidecar_path("ffmpeg")?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(input_path)
        .args(["-c:v", "copy", "-an", "-movflags", "+faststart"])
        .arg(output_path);
    super::proc::run_ok(&mut cmd, super::proc::timeout_for_file(input_path), "ffmpeg tách âm thanh")?;
    Ok(())
}

/// Cắt video theo danh sách đoạn GIỮ LẠI (ms, đã sort tăng dần, không chồng
/// lấp) — dùng cho cả trim đầu/cuối (1 đoạn) và xoá đoạn giữa (nhiều đoạn).
/// Re-encode từng đoạn (KHÔNG dùng `-c:v copy`) để cắt chính xác tới bất kỳ
/// mốc thời gian nào: `Encoder::start` không set GOP nhỏ nên `-c copy` chỉ
/// cắt được ở keyframe gần nhất (mặc định libx264 ~250 frame, tức ~8s ở
/// 30fps) — không đủ chính xác cho việc người dùng tự chọn mốc cắt. Video
/// quay màn hình thường ngắn nên re-encode không đáng lo hiệu năng.
///
/// Mỗi đoạn giữ lại được encode ra 1 file tạm riêng (`-ss`/`-t` ĐẶT SAU
/// `-i` để seek chính xác tới frame thay vì snap theo keyframe; dùng `-t`
/// thay vì `-to` để tránh nhập nhằng absolute/relative timestamp của ffmpeg
/// khi `-ss` cũng là output option), rồi LUÔN ghép lại bằng 1 lệnh concat
/// demuxer `-c copy` — kể cả khi chỉ có 1 đoạn (1 code path duy nhất, chi phí
/// thêm không đáng kể). `output_path` chỉ được ghi khi mọi bước thành công —
/// `input_path` không bao giờ bị đụng vào (caller tự quyết định
/// `fs::rename` đè lên file gốc sau khi hàm này trả về `Ok`).
///
/// `on_progress` được gọi liên tục với tỉ lệ 0.0..=1.0 trong lúc encode từng
/// đoạn (đọc `out_time_us=` từ `-progress pipe:1` của ffmpeg — machine-
/// readable, ổn định hơn parse chuỗi `time=` trong stderr thường), quy đổi
/// theo tổng thời lượng CÒN LẠI của mọi đoạn (không phải % số đoạn xong, vì 1
/// đoạn dài có thể chiếm hầu hết thời gian trong khi các đoạn khác rất ngắn).
/// Bước ghép cuối (`-c copy`) rất nhanh nên không cần progress riêng — nhảy
/// thẳng lên `1.0` khi xong.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOverlay {
    pub id: String,
    #[serde(rename = "type")]
    pub overlay_type: String,
    #[serde(default)]
    pub rel_x: f64,
    #[serde(default)]
    pub rel_y: f64,
    #[serde(default)]
    pub rel_w: f64,
    #[serde(default)]
    pub rel_h: f64,
    #[serde(default)]
    pub start_time_ms: f64,
    #[serde(default)]
    pub end_time_ms: f64,
    #[serde(default)]
    pub stroke_color: Option<String>,
    #[serde(default)]
    pub stroke_width: Option<f64>,
    #[serde(default)]
    pub is_blackout: Option<bool>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub image_data: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub text_color: Option<String>,
    #[serde(default)]
    pub has_background: Option<bool>,
    #[serde(default)]
    pub arrow_start_x: Option<f64>,
    #[serde(default)]
    pub arrow_start_y: Option<f64>,
    #[serde(default)]
    pub arrow_end_x: Option<f64>,
    #[serde(default)]
    pub arrow_end_y: Option<f64>,
}

/// Toạ độ và kích thước vùng crop không gian (X, Y, W, H tính theo pixel thực tế của video).
#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoCrop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoomSegment {
    pub id: String,
    pub start_time_ms: f64,
    pub end_time_ms: f64,
    pub scale: f64,
    pub focus_x: f64,
    pub focus_y: f64,
    #[serde(default)]
    pub easing: Option<String>,
}

/// Sinh chuỗi filter atempo cho FFmpeg (hỗ trợ speed từ 0.05 đến 16.0 bằng cách xâu chuỗi atempo=2.0 hoặc atempo=0.5).
pub fn build_atempo_filter(speed: f64) -> String {
    let mut s = if speed > 0.01 { speed } else { 1.0 };
    let mut filters = Vec::new();
    while s > 2.0001 {
        filters.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.4999 {
        filters.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 0.001 {
        if (s - 2.0).abs() < 0.001 {
            filters.push("atempo=2.0".to_string());
        } else if (s - 0.5).abs() < 0.001 {
            filters.push("atempo=0.5".to_string());
        } else {
            let formatted = format!("{:.4}", s);
            let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
            filters.push(format!("atempo={trimmed}"));
        }
    }
    if filters.is_empty() {
        "anull".to_string()
    } else {
        filters.join(",")
    }
}

pub fn build_overlay_filter_graph(
    overlays: &[VideoOverlay],
    image_overlays: &[&VideoOverlay],
    crop: Option<&VideoCrop>,
    zoom_segments: Option<&[ZoomSegment]>,
    video_size: Option<(u32, u32)>,
    speed: Option<f64>,
) -> Option<String> {
    let has_speed = speed.map(|s| (s - 1.0).abs() > 0.01).unwrap_or(false);
    let valid: Vec<&VideoOverlay> = overlays
        .iter()
        .filter(|o| o.rel_w > 0.001 && o.rel_h > 0.001 && o.end_time_ms > o.start_time_ms)
        .collect();
    let has_zooms = zoom_segments
        .map(|zs| zs.iter().any(|z| z.scale > 1.01 && z.end_time_ms > z.start_time_ms))
        .unwrap_or(false);

    let crop_filter = crop.map(|c| {
        let cw = (c.width / 2) * 2;
        let ch = (c.height / 2) * 2;
        format!("crop={cw}:{ch}:{}:{}", c.x, c.y)
    });

    if valid.is_empty() && image_overlays.is_empty() && !has_zooms {
        if let Some(cf) = crop_filter {
            if has_speed {
                let sp = speed.unwrap();
                return Some(format!("[0:v]{cf},setpts={:.4}*PTS[outv]", 1.0 / sp));
            } else {
                return Some(format!("[0:v]{cf}[outv]"));
            }
        } else if has_speed {
            let sp = speed.unwrap();
            return Some(format!("[0:v]setpts={:.4}*PTS[outv]", 1.0 / sp));
        } else {
            return None;
        }
    }

    let mut fg = String::new();
    let base_input: String;

    if let Some(cf) = crop_filter {
        fg.push_str(&format!("[0:v]{cf}[v_cropped];"));
        if has_speed {
            let sp = speed.unwrap();
            fg.push_str(&format!("[v_cropped]setpts={:.4}*PTS[v_speed];", 1.0 / sp));
            base_input = "v_speed".to_string();
        } else {
            base_input = "v_cropped".to_string();
        }
    } else if has_speed {
        let sp = speed.unwrap();
        fg.push_str(&format!("[0:v]setpts={:.4}*PTS[v_speed];", 1.0 / sp));
        base_input = "v_speed".to_string();
    } else {
        base_input = "0:v".to_string();
    }

    let mut soft_blurs = Vec::new();
    let mut boxes = Vec::new();

    for o in &valid {
        if o.overlay_type == "blur" && !o.is_blackout.unwrap_or(false) {
            soft_blurs.push(*o);
        } else if o.overlay_type == "rect" || (o.overlay_type == "blur" && o.is_blackout.unwrap_or(false)) {
            boxes.push(*o);
        }
    }

    let last_blur_label: String;

    if !soft_blurs.is_empty() {
        let n = soft_blurs.len();
        if base_input == "0:v" {
            fg.push_str(&format!("[0:v]split={}[base]", n + 1));
        } else {
            fg.push_str(&format!("[{base_input}]split={}[base]", n + 1));
        }
        for i in 0..n {
            fg.push_str(&format!("[c{i}]"));
        }
        fg.push(';');

        for (i, o) in soft_blurs.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let rw = o.rel_w.clamp(0.001, 1.0 - rx);
            let rh = o.rel_h.clamp(0.001, 1.0 - ry);
            fg.push_str(&format!(
                "[c{i}]crop=w='trunc(iw*{rw:.4})':h='trunc(ih*{rh:.4})':x='trunc(iw*{rx:.4})':y='trunc(ih*{ry:.4})',avgblur=sizeX=16:sizeY=16[b{i}];"
            ));
        }

        let mut prev = "base".to_string();
        for (i, o) in soft_blurs.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let s_sec = o.start_time_ms / 1000.0;
            let e_sec = o.end_time_ms / 1000.0;
            let next_label = format!("m{i}");
            fg.push_str(&format!(
                "[{prev}][b{i}]overlay=x='trunc(main_w*{rx:.4})':y='trunc(main_h*{ry:.4})':enable='between(t,{s_sec:.3},{e_sec:.3})'[{next_label}];"
            ));
            prev = next_label;
        }
        last_blur_label = prev;
    } else {
        last_blur_label = base_input;
    }

    let mut prev = last_blur_label;

    if !boxes.is_empty() {
        for (i, o) in boxes.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let rw = o.rel_w.clamp(0.001, 1.0 - rx);
            let rh = o.rel_h.clamp(0.001, 1.0 - ry);
            let s_sec = o.start_time_ms / 1000.0;
            let e_sec = o.end_time_ms / 1000.0;

            let (color, thickness) = if o.overlay_type == "blur" && o.is_blackout.unwrap_or(false) {
                ("black".to_string(), "fill".to_string())
            } else {
                let col = o.stroke_color.as_deref().unwrap_or("#ef4444");
                let clean_col = if let Some(hex) = col.strip_prefix('#') {
                    format!("0x{hex}")
                } else {
                    col.to_string()
                };
                let w = o.stroke_width.unwrap_or(3.0).max(1.0).round() as u32;
                (clean_col, w.to_string())
            };

            let next_label = format!("box{i}");
            fg.push_str(&format!(
                "[{prev}]drawbox=x='trunc(iw*{rx:.4})':y='trunc(ih*{ry:.4})':w='trunc(iw*{rw:.4})':h='trunc(ih*{rh:.4})':color={color}:t={thickness}:enable='between(t,{s_sec:.3},{e_sec:.3})'[{next_label}];"
            ));
            prev = next_label;
        }
    }

    if !image_overlays.is_empty() {
        for (i, o) in image_overlays.iter().enumerate() {
            let rx = o.rel_x.clamp(0.0, 1.0);
            let ry = o.rel_y.clamp(0.0, 1.0);
            let s_sec = o.start_time_ms / 1000.0;
            let e_sec = o.end_time_ms / 1000.0;
            let input_idx = 1 + i;
            let next_label = format!("img{i}");
            fg.push_str(&format!(
                "[{prev}][{input_idx}:v]overlay=x='trunc(main_w*{rx:.4})':y='trunc(main_h*{ry:.4})':enable='between(t,{s_sec:.3},{e_sec:.3})':shortest=1:eof_action=pass[{next_label}];"
            ));
            prev = next_label;
        }
    }

    if let Some(zooms) = zoom_segments {
        let valid_zooms: Vec<&ZoomSegment> = zooms
            .iter()
            .filter(|z| z.scale > 1.01 && z.end_time_ms > z.start_time_ms)
            .collect();
        if !valid_zooms.is_empty() {
            let (vw, vh) = video_size.unwrap_or((1920, 1080));
            let vw = if vw > 0 { vw } else { 1920 };
            let vh = if vh > 0 { vh } else { 1080 };

            for (idx, z) in valid_zooms.iter().enumerate() {
                let ts = z.start_time_ms / 1000.0;
                let te = z.end_time_ms / 1000.0;
                let dur = te - ts;
                let tr = 0.65f64.min(dur * 0.35).max(0.25);
                let scale = z.scale.max(1.05);
                let fx = z.focus_x.clamp(0.0, 1.0);
                let fy = z.focus_y.clamp(0.0, 1.0);

                let ts_tr = ts + tr;
                let te_tr = te - tr;

                let z_expr = format!(
                    "if(between(it,{ts:.3},{ts_tr:.3}),1.0+({scale}-1.0)*(6*pow((it-{ts:.3})/{tr:.3},5)-15*pow((it-{ts:.3})/{tr:.3},4)+10*pow((it-{ts:.3})/{tr:.3},3)),\
                     if(between(it,{te_tr:.3},{te:.3}),1.0+({scale}-1.0)*(6*pow(({te:.3}-it)/{tr:.3},5)-15*pow(({te:.3}-it)/{tr:.3},4)+10*pow(({te:.3}-it)/{tr:.3},3)),\
                     if(between(it,{ts_tr:.3},{te_tr:.3}),{scale},1.0)))"
                );
                let x_expr = format!(
                    "min(max(0,(iw/2+(iw*{fx:.4}-iw/2)*(zoom-1)/({scale}-1))-iw/zoom/2),iw-iw/zoom)"
                );
                let y_expr = format!(
                    "min(max(0,(ih/2+(ih*{fy:.4}-ih/2)*(zoom-1)/({scale}-1))-ih/zoom/2),ih-ih/zoom)"
                );

                let next_label = format!("zm{idx}");
                fg.push_str(&format!(
                    "[{prev}]zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d=1:s={vw}x{vh}:fps=30[{next_label}];"
                ));
                prev = next_label;
            }
        }
    }

    if prev != "0:v" {
        fg.push_str(&format!("[{prev}]null[outv];"));
    } else {
        fg.push_str("[0:v]null[outv];");
    }

    if fg.ends_with(';') {
        fg.pop();
    }

    Some(fg)
}

pub fn trim(
    input_path: &Path,
    keep_ranges_ms: &[(i64, i64, f64)],
    output_path: &Path,
    remove_audio: bool,
    overlays: Option<&[VideoOverlay]>,
    crop: Option<&VideoCrop>,
    zoom_segments: Option<&[ZoomSegment]>,
    video_size: Option<(u32, u32)>,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    if keep_ranges_ms.is_empty() {
        return Err("Không có đoạn nào được giữ lại".to_string());
    }

    let ffmpeg = sidecar_path("ffmpeg")?;
    let tmp_dir = std::env::temp_dir().join(format!("snapdoc-trim-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Không tạo được thư mục tạm: {e}"))?;

    let total_ms: i64 = keep_ranges_ms
        .iter()
        .map(|(s, e, sp)| {
            let speed = if *sp > 0.01 { *sp } else { 1.0 };
            (((*e - *s).max(0) as f64) / speed).round() as i64
        })
        .sum::<i64>()
        .max(1);
    on_progress(0.0);

    let mut run = || -> Result<(), String> {
        // Giải mã các overlay dạng ảnh (Text, Arrow, ...) ra file PNG tạm trước
        let mut image_overlays: Vec<(std::path::PathBuf, &VideoOverlay)> = Vec::new();
        if let Some(ovls) = overlays {
            for (idx, o) in ovls.iter().enumerate() {
                if let Some(data_url) = &o.image_data {
                    let clean_b64 = if let Some(comma_pos) = data_url.find(',') {
                        &data_url[comma_pos + 1..]
                    } else {
                        data_url.as_str()
                    };
                    use base64::Engine;
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(clean_b64.trim()) {
                        let img_path = tmp_dir.join(format!("ovl_img_{idx}.png"));
                        if std::fs::write(&img_path, bytes).is_ok() {
                            image_overlays.push((img_path, o));
                        }
                    }
                }
            }
        }

        let img_refs: Vec<&VideoOverlay> = image_overlays.iter().map(|(_, o)| *o).collect();
        let single_pass_speed = if keep_ranges_ms.len() == 1 && (keep_ranges_ms[0].2 - 1.0).abs() > 0.01 {
            Some(keep_ranges_ms[0].2)
        } else {
            None
        };
        let filter_graph = build_overlay_filter_graph(
            overlays.unwrap_or(&[]),
            &img_refs,
            crop,
            zoom_segments,
            video_size,
            single_pass_speed,
        );

        // TỐI ƯU HOÁ: Nếu chỉ có 1 đoạn giữ lại (chiếm đa số các tác vụ cắt hoặc thêm overlay),
        // chạy Single-Pass: cắt thời lượng + áp dụng filter graph + encode trong 1 lệnh duy nhất!
        // Tránh hoàn toàn việc encode seg_0.mp4 rồi lại re-encode lần 2 khi có overlay.
        if keep_ranges_ms.len() == 1 {
            let (start_ms, end_ms, speed) = keep_ranges_ms[0];
            let start_s = (start_ms as f64) / 1000.0;
            let dur_ms = (end_ms - start_ms).max(0);
            let dur_s = (dur_ms as f64) / 1000.0;
            let has_speed = (speed - 1.0).abs() > 0.01;
            let effective_speed = if speed > 0.01 { speed } else { 1.0 };
            let seg_play_ms = ((dur_ms as f64) / effective_speed).round() as i64;

            let mut cmd = Command::new(&ffmpeg);
            cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
            if start_ms > 0 {
                // Fast input seek: -ss trước -i
                cmd.args(["-ss", &format!("{start_s:.3}")]);
            }
            cmd.arg("-i").arg(input_path);
            cmd.args(["-t", &format!("{dur_s:.3}")]);

            for (img_path, _) in &image_overlays {
                cmd.args(["-loop", "1", "-i"]).arg(img_path);
            }

            if let Some(fg) = &filter_graph {
                cmd.args(["-filter_complex", fg])
                    .args(["-map", "[outv]"]);
                cmd.arg("-shortest");
            } else {
                cmd.args(["-map", "0:v:0"]);
            }

            cmd.args(best_h264_encoder_args(&ffmpeg));

            if remove_audio {
                cmd.arg("-an");
            } else if has_speed {
                let af = build_atempo_filter(speed);
                cmd.args(["-map", "0:a?", "-af", &af, "-c:a", "aac", "-b:a", "160k"]);
            } else if start_ms > 0 {
                // Tránh lệch sync âm thanh khi seek
                cmd.args(["-map", "0:a?", "-c:a", "aac", "-b:a", "160k"]);
            } else {
                cmd.args(["-map", "0:a?", "-c:a", "copy"]);
            }

            cmd.args(["-movflags", "+faststart"])
                .args(["-progress", "pipe:1"])
                .arg(output_path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;

            let mut stderr_pipe = child.stderr.take().expect("stderr đã piped");
            let stderr_thread = std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = String::new();
                let _ = stderr_pipe.read_to_string(&mut buf);
                buf
            });

            let stdout = child.stdout.take().expect("stdout đã piped");
            {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(v) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = v.trim().parse::<i64>() {
                            let cur_ms = (us / 1000).clamp(0, seg_play_ms);
                            on_progress((cur_ms as f64 / seg_play_ms.max(1) as f64).min(1.0));
                        }
                    }
                }
            }

            let status = child
                .wait()
                .map_err(|e| format!("ffmpeg lỗi khi chờ tiến trình: {e}"))?;
            let stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                return Err(format!("ffmpeg xử lý video thất bại: {status} — {stderr}"));
            }

            on_progress(1.0);
            return Ok(());
        }

        // Trường hợp nhiều đoạn giữ lại (xoá đoạn ở giữa): encode từng đoạn với fast seeking
        let mut seg_paths = Vec::with_capacity(keep_ranges_ms.len());
        let mut done_ms: i64 = 0;
        for (i, (start_ms, end_ms, speed)) in keep_ranges_ms.iter().enumerate() {
            let seg_path = tmp_dir.join(format!("seg_{i}.mp4"));
            let start_s = (*start_ms as f64) / 1000.0;
            let dur_ms = (*end_ms - *start_ms).max(0);
            let dur_s = (dur_ms as f64) / 1000.0;
            let has_speed = (*speed - 1.0).abs() > 0.01;
            let effective_speed = if *speed > 0.01 { *speed } else { 1.0 };
            let seg_play_ms = ((dur_ms as f64) / effective_speed).round() as i64;

            let mut cmd = Command::new(&ffmpeg);
            cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
            if *start_ms > 0 {
                cmd.args(["-ss", &format!("{start_s:.3}")]);
            }
            cmd.arg("-i").arg(input_path);
            cmd.args(["-t", &format!("{dur_s:.3}")]);

            if has_speed {
                cmd.args(["-vf", &format!("setpts={:.4}*PTS", 1.0 / speed)]);
            }

            cmd.args(best_h264_encoder_args(&ffmpeg));
            if remove_audio {
                cmd.arg("-an");
            } else if has_speed {
                let af = build_atempo_filter(*speed);
                cmd.args(["-af", &af, "-c:a", "aac", "-b:a", "160k"]);
            } else {
                cmd.args(["-c:a", "aac", "-b:a", "160k"]);
            }
            cmd.args(["-progress", "pipe:1"])
                .arg(&seg_path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;
            let mut stderr_pipe = child.stderr.take().expect("stderr đã piped");
            let stderr_thread = std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = String::new();
                let _ = stderr_pipe.read_to_string(&mut buf);
                buf
            });

            let stdout = child.stdout.take().expect("stdout đã piped");
            {
                use std::io::{BufRead, BufReader};
                let seg_base_ms = done_ms;
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(v) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = v.trim().parse::<i64>() {
                            let cur_ms = (us / 1000).clamp(0, seg_play_ms);
                            on_progress(((seg_base_ms + cur_ms) as f64 / total_ms as f64).min(1.0));
                        }
                    }
                }
            }

            let status = child
                .wait()
                .map_err(|e| format!("ffmpeg lỗi khi chờ tiến trình: {e}"))?;
            let stderr = stderr_thread.join().unwrap_or_default();
            if !status.success() {
                return Err(format!("ffmpeg cắt đoạn {i} thất bại: {status} — {stderr}"));
            }
            done_ms += seg_play_ms;
            on_progress((done_ms as f64 / total_ms as f64).min(1.0));
            seg_paths.push(seg_path);
        }

        let list_path = tmp_dir.join("list.txt");
        let list_content = seg_paths
            .iter()
            .map(|p| format!("file '{}'", p.to_string_lossy().replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&list_path, list_content)
            .map_err(|e| format!("Không ghi được danh sách ghép: {e}"))?;

        let concat_target = if filter_graph.is_some() {
            tmp_dir.join("concat.mp4")
        } else {
            output_path.to_path_buf()
        };

        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0"])
            .arg("-i")
            .arg(&list_path)
            .args(["-map", "0:v:0"])
            .args(["-c:v", "copy"]);
        if !remove_audio {
            cmd.args(["-map", "0:a?", "-c:a", "copy"]);
        }
        cmd.args(["-movflags", "+faststart"])
            .arg(&concat_target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg ghép các đoạn thất bại: {} — {stderr}", output.status));
        }

        // Nếu có overlay trên nhiều đoạn ghép, áp dụng filter graph từ concat_target
        if let Some(fg) = filter_graph {
            let mut filter_cmd = Command::new(&ffmpeg);
            filter_cmd
                .args(["-hide_banner", "-loglevel", "error", "-y"])
                .arg("-i")
                .arg(&concat_target);
            for (img_path, _) in &image_overlays {
                filter_cmd.args(["-loop", "1", "-i"]).arg(img_path);
            }
            filter_cmd
                .args(["-filter_complex", &fg])
                .args(["-map", "[outv]"]);
            if !remove_audio {
                filter_cmd.args(["-map", "0:a?", "-c:a", "copy"]);
            }
            let total_sec = (total_ms as f64) / 1000.0;
            filter_cmd.args(["-t", &format!("{total_sec:.3}")]);
            filter_cmd.arg("-shortest");
            filter_cmd.args(best_h264_encoder_args(&ffmpeg));
            filter_cmd
                .args(["-movflags", "+faststart"])
                .arg(output_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                filter_cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let filter_out = filter_cmd
                .output()
                .map_err(|e| format!("Không khởi chạy ffmpeg áp dụng hiệu ứng ({}): {e}", ffmpeg.display()))?;
            if !filter_out.status.success() {
                let stderr = String::from_utf8_lossy(&filter_out.stderr);
                return Err(format!("ffmpeg áp dụng khung/che mờ thất bại: {} — {stderr}", filter_out.status));
            }
        }

        on_progress(1.0);
        Ok(())
    };

    let result = run();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Tuỳ chọn xuất video sang ảnh GIF động.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportOptions {
    pub start_ms: i64,
    pub duration_ms: i64,
    pub fps: u32,
    pub max_width: Option<u32>,
    pub speed: f64,
    pub loop_count: i32, // 0 = lặp vô hạn, -1 = phát 1 lần
}

/// Xuất 1 đoạn video (hoặc toàn bộ) ra file ảnh GIF chất lượng cao.
///
/// Dùng ffmpeg filter 2-pass (palettegen + paletteuse với Bayer dithering)
/// để bảng màu 256 màu đạt độ mịn tối đa, hạn chế răng cưa và giảm kích thước
/// file so với bộ encoder mặc định.
pub fn export_gif(
    input_path: &Path,
    output_path: &Path,
    options: &GifExportOptions,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    if !input_path.exists() {
        return Err(format!("File nguồn không tồn tại: {}", input_path.display()));
    }
    if options.duration_ms <= 0 {
        return Err("Thời lượng xuất GIF phải lớn hơn 0".to_string());
    }

    let ffmpeg = sidecar_path("ffmpeg")?;
    let start_s = (options.start_ms.max(0) as f64) / 1000.0;
    let dur_s = (options.duration_ms.max(100) as f64) / 1000.0;
    let speed = if options.speed > 0.05 { options.speed } else { 1.0 };
    let fps = options.fps.clamp(5, 60);

    let pts_filter = if (speed - 1.0).abs() > 0.01 {
        format!("setpts={:.4}*PTS,", 1.0 / speed)
    } else {
        String::new()
    };

    let scale_filter = match options.max_width {
        Some(w) if w > 0 => format!("scale='min({w},iw)':-2:flags=lanczos"),
        _ => "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos".to_string(),
    };

    let filter_complex = format!(
        "[0:v] {pts_filter}fps={fps},{scale_filter},split [s0][s1]; [s0] palettegen=stats_mode=diff [p]; [s1][p] paletteuse=dither=bayer:bayer_scale=3"
    );

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .arg("-ss")
        .arg(format!("{:.3}", start_s))
        .arg("-t")
        .arg(format!("{:.3}", dur_s))
        .arg("-i")
        .arg(input_path)
        .args(["-filter_complex", &filter_complex])
        .args(["-loop", &options.loop_count.to_string()])
        .args(["-progress", "pipe:1"])
        .arg(output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    on_progress(0.0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không khởi chạy ffmpeg ({}): {e}", ffmpeg.display()))?;

    let mut stderr_pipe = child.stderr.take().expect("stderr đã piped");
    let stderr_thread = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stderr_pipe.read_to_string(&mut buf);
        buf
    });

    let total_us = ((dur_s / speed) * 1_000_000.0) as i64;
    let stdout = child.stdout.take().expect("stdout đã piped");
    {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<i64>() {
                    let frac = (us as f64 / total_us.max(1) as f64).clamp(0.0, 0.99);
                    on_progress(frac);
                }
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg lỗi khi chờ tiến trình: {e}"))?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("Xuất GIF thất bại: {status} — {stderr}"));
    }

    on_progress(1.0);
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Encode 30 frame gradient tổng hợp (không cần quyền Screen Recording,
    /// không phụ thuộc macOS) → xác nhận pipeline ffmpeg hoạt động đúng.
    /// Yêu cầu: `src-tauri/binaries/ffmpeg-<target-triple>` tồn tại và đã
    /// được copy cạnh test binary (mô phỏng bước `externalBin` của Tauri CLI)
    /// — khi chạy qua `tauri dev`/`tauri build` việc này tự động.
    #[test]
    fn encodes_synthetic_frames_to_mp4() {
        let width = 320u32;
        let height = 240u32;
        let fps = 10u32;
        let frame_count = 30u32;

        let out = std::env::temp_dir().join("snapdoc_encoder_test.mp4");
        let mut encoder = Encoder::start(&out, width, height, fps).expect("Encoder::start thất bại");

        for i in 0..frame_count {
            let level = ((i * 255) / frame_count) as u8;
            let mut frame = vec![0u8; (width * height * 4) as usize];
            for px in frame.chunks_exact_mut(4) {
                px[0] = level; // B
                px[1] = 255 - level; // G
                px[2] = 128; // R
                px[3] = 255; // A
            }
            encoder.write_frame(&frame).expect("write_frame thất bại");
        }

        encoder.finish().expect("finish thất bại");

        let meta = std::fs::metadata(&out).expect("không đọc được file output");
        assert!(
            meta.len() > 1000,
            "file mp4 quá nhỏ ({} byte), có thể encode lỗi",
            meta.len()
        );
        eprintln!(
            "[test] đã encode {frame_count} frame -> {} ({} byte)",
            out.display(),
            meta.len()
        );
    }

    /// Encode 1 video 5s (10fps × 50 frame) rồi cắt giữ lại 2 đoạn
    /// (0–1.5s và 3.5–5s), mô phỏng đúng thao tác "xoá đoạn giữa" — xác nhận
    /// `trim()` chạy đúng cú pháp ffmpeg (cả bước re-encode từng đoạn lẫn
    /// bước ghép concat) với sidecar binary thật, không chỉ đúng trên lý
    /// thuyết.
    #[test]
    fn trims_video_by_keeping_two_ranges() {
        let width = 160u32;
        let height = 120u32;
        let fps = 10u32;
        let frame_count = 50u32; // 5s

        let tmp_dir = std::env::temp_dir().join("snapdoc_encoder_trim_test");
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let src = tmp_dir.join("source.mp4");
        let mut encoder = Encoder::start(&src, width, height, fps).expect("Encoder::start thất bại");
        for i in 0..frame_count {
            let level = ((i * 255) / frame_count) as u8;
            let mut frame = vec![0u8; (width * height * 4) as usize];
            for px in frame.chunks_exact_mut(4) {
                px[0] = level;
                px[1] = 255 - level;
                px[2] = 128;
                px[3] = 255;
            }
            encoder.write_frame(&frame).expect("write_frame thất bại");
        }
        encoder.finish().expect("finish thất bại");

        let out = tmp_dir.join("trimmed.mp4");
        // Giữ 0–1.5s và 3.5–5s (xoá đoạn giữa 1.5–3.5s) → kết quả ~3s.
        let mut last_progress: f64 = 0.0;
        // `remove_audio = false`: video test không có audio track, và test này
        // kiểm cú pháp ffmpeg của đường cắt, không kiểm nhánh bỏ audio.
        trim(
            &src,
            &[(0, 1_500, 1.0), (3_500, 5_000, 1.0)],
            &out,
            false,
            None,
            None,
            None,
            None,
            |p| last_progress = p,
        )
        .expect("trim() thất bại — kiểm tra cú pháp ffmpeg");
        assert!((last_progress - 1.0).abs() < 1e-9, "progress cuối phải là 1.0, thấy {last_progress}");

        let meta = std::fs::metadata(&out).expect("không đọc được file output");
        assert!(meta.len() > 1000, "file mp4 sau khi cắt quá nhỏ ({} byte)", meta.len());
        eprintln!("[test] đã cắt video -> {} ({} byte)", out.display(), meta.len());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    /// File đang ghi dở (CHƯA finish — mô phỏng app bị crash) với nội dung
    /// tĩnh vẫn phải đọc được phần đã ghi: cần `-flush_packets 1`.
    #[test]
    fn unfinished_recording_is_readable() {
        let (w, h, fps) = (640u32, 360u32, 30u32);
        let dir = std::env::temp_dir().join(format!("snapdoc_frag_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("video.mp4");
        let mut enc = Encoder::start(&out, w, h, fps).expect("Encoder::start");
        let frame = vec![90u8; (w * h * 4) as usize];
        for _ in 0..(fps * 5) {
            enc.write_frame(&frame).unwrap();
        }
        // Chờ ffmpeg xử lý hết các frame đã nhận rồi chụp lại file như lúc crash.
        std::thread::sleep(Duration::from_millis(1500));
        let snap = dir.join("snap.mp4");
        std::fs::copy(&out, &snap).unwrap();
        let meta = crate::record::probe::probe_video_metadata(&snap).expect("phần đã ghi phải đọc được");
        assert!(meta.duration_ms >= 2000, "phải còn ít nhất vài giây: {}ms", meta.duration_ms);
        enc.killer().kill();
        drop(enc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atempo_filter_chain() {
        assert_eq!(build_atempo_filter(1.0), "anull");
        assert_eq!(build_atempo_filter(2.0), "atempo=2.0");
        assert_eq!(build_atempo_filter(4.0), "atempo=2.0,atempo=2.0");
        assert_eq!(build_atempo_filter(0.5), "atempo=0.5");
        assert_eq!(build_atempo_filter(0.25), "atempo=0.5,atempo=0.5");
        assert_eq!(build_atempo_filter(1.5), "atempo=1.5");
    }
}


