//! Sinh thumbnail JPEG cho video đã quay — trích 1 frame bằng chính ffmpeg
//! sidecar đã dùng để encode (xem `record::encoder`), KHÔNG cần decode video
//! trong Rust. ffmpeg tự scale + ghi thẳng ra file JPEG, không cần bước trung
//! gian qua `history::thumbnail::generate` (vốn nhận PNG bytes — không hợp
//! với luồng ở đây).

use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// Trích frame ở giây thứ 0.5 (đủ để tránh frame đen đầu tiên của vài video),
/// scale chiều rộng về tối đa 320px (giữ tỉ lệ), ghi JPEG (`-q:v 4`, chất
/// lượng vừa đủ cho thumbnail nhỏ) tại `out_thumb_path`. Video ngắn hơn 0.5s
/// (seek quá cuối → ffmpeg không ra frame nào) thì lấy frame đầu tiên.
pub fn generate(mp4_path: &Path, out_thumb_path: &Path) -> Result<(), String> {
    let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;
    let attempt = |seek: Option<&str>| -> Result<(), String> {
        let _ = std::fs::remove_file(out_thumb_path);
        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
        if let Some(ss) = seek {
            cmd.args(["-ss", ss]);
        }
        cmd.arg("-i")
            .arg(mp4_path)
            .args(["-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4"])
            .arg(out_thumb_path);
        crate::record::proc::run_ok(&mut cmd, Duration::from_secs(30), "ffmpeg trích thumbnail")?;
        let ok = std::fs::metadata(out_thumb_path).map(|m| m.len() > 0).unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err("ffmpeg không xuất được frame thumbnail".to_string())
        }
    };
    attempt(Some("0.5")).or_else(|_| attempt(None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::encoder::Encoder;

    /// Encode vài frame gradient (giống test của `encoder.rs`) rồi trích
    /// thumbnail từ chính file đó — xác nhận cú pháp lệnh ffmpeg đúng với
    /// sidecar binary thật, không chỉ đúng trên lý thuyết.
    #[test]
    fn generates_thumbnail_from_synthetic_video() {
        let width = 320u32;
        let height = 240u32;
        let fps = 10u32;
        let frame_count = 20u32;

        let mp4 = std::env::temp_dir().join("snapdoc_video_thumb_test.mp4");
        let mut encoder = Encoder::start(&mp4, width, height, fps).expect("Encoder::start thất bại");
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

        let thumb = std::env::temp_dir().join("snapdoc_video_thumb_test.jpg");
        generate(&mp4, &thumb).expect("generate() thumbnail thất bại");

        let meta = std::fs::metadata(&thumb).expect("không đọc được file thumbnail");
        assert!(meta.len() > 100, "thumbnail quá nhỏ ({} byte)", meta.len());
        eprintln!("[test] đã sinh thumbnail {} ({} byte)", thumb.display(), meta.len());
    }

    /// Video ngắn hơn 0.5s: seek 0.5s không ra frame nào — phải rơi về frame đầu.
    #[test]
    fn short_video_still_gets_thumbnail() {
        let (width, height, fps) = (160u32, 120u32, 10u32);
        let mp4 = std::env::temp_dir().join(format!("snapdoc_thumb_short_{}.mp4", uuid::Uuid::new_v4()));
        let mut encoder = Encoder::start(&mp4, width, height, fps).expect("Encoder::start thất bại");
        for _ in 0..2 {
            encoder.write_frame(&vec![200u8; (width * height * 4) as usize]).unwrap();
        }
        encoder.finish().unwrap();
        let thumb = mp4.with_extension("jpg");
        generate(&mp4, &thumb).expect("video 0.2s vẫn phải có thumbnail");
        assert!(std::fs::metadata(&thumb).unwrap().len() > 100);
        let _ = std::fs::remove_file(&mp4);
        let _ = std::fs::remove_file(&thumb);
    }
}
