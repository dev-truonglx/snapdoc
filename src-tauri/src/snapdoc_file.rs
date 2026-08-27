//! Đọc/ghi định dạng tài liệu `.snapdoc` — container ZIP giữ ĐỒNG THỜI ảnh nền
//! gốc và lớp annotation, nhờ đó một ảnh chụp mở lại lúc nào cũng sửa tiếp
//! được (di chuyển/đổi màu/xoá từng annotation), thay vì bị "burn" thành pixel
//! ngay lần lưu đầu như trước.
//!
//! # Vì sao ZIP mà không phải PNG có chunk riêng
//!
//! Nhúng JSON vào một chunk `zTXt` của PNG thì file vừa là ảnh xem được ở mọi
//! nơi vừa mang được dữ liệu — nghe hay hơn. Nhưng pixel của PNG chỉ được là
//! MỘT trong hai: nền sạch (xem ra không thấy annotation) hoặc bản đã ghép
//! (mất nền gốc, hết sửa tiếp được). Muốn có cả hai thì vẫn phải nhúng ảnh thứ
//! hai vào chunk — tức vẫn là container, chỉ là container khó soi hơn. ZIP thì
//! `unzip -l` là xem được, thêm asset chỉ là thêm entry, và `preview.png` đã
//! lo phần "người khác xem được".
//!
//! # Bố cục
//!
//! ```text
//! manifest.json   { format, formatVersion, kind, appVersion, createdAt, updatedAt }
//! base.png        pixel nền CHƯA annotate — nguồn thật, không bao giờ mất
//! doc.json        trạng thái ĐÃ LƯU (annotations + counters + kích thước)
//! draft.json      (tuỳ chọn) trạng thái ĐANG SỬA chưa Save — autosave ghi vào đây
//! preview.png     bản đã ghép từ doc.json — cho clipboard / xem nhanh / thumbnail
//! ```
//!
//! Hai slot `doc.json` / `draft.json` là điểm cốt lõi: autosave ghi `draft.json`
//! nên crash/mất điện không mất việc, NHƯNG `Cmd+S` vẫn có nghĩa thật (đổi
//! `draft` → `doc`, xoá draft, render lại preview). Nếu autosave ghi thẳng vào
//! `doc.json` thì nút Save và chỉ báo "chưa lưu" trở thành vô nghĩa.

use std::io::{Read, Seek, Write};
use std::path::Path;

use zip::write::SimpleFileOptions;

pub const MANIFEST: &str = "manifest.json";
pub const BASE_PNG: &str = "base.png";
pub const DOC_JSON: &str = "doc.json";
pub const DRAFT_JSON: &str = "draft.json";
pub const PREVIEW_PNG: &str = "preview.png";

/// Version của BỐ CỤC container. Chỉ tăng khi đổi tên/ngữ nghĩa entry.
///
/// Tách khỏi version của payload JSON bên trong (`doc.json` tự mang
/// `payloadV`): thêm một loại annotation mới không phải là đổi bố cục file, nên
/// không được buộc bản cũ từ chối cả file.
pub const FORMAT_VERSION: u32 = 1;

/// 4 byte đầu của mọi file ZIP. Dùng để PHÂN BIỆT `.snapdoc` với ảnh trần thay
/// vì tin vào phần mở rộng: Library còn đầy `{id}.png` từ các bản trước, và
/// việc viết lại toàn bộ dữ liệu người dùng một lượt là rủi ro không cần thiết
/// khi chỉ cần sniff 4 byte là đọc đúng cả hai.
const ZIP_MAGIC: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Manifest {
    pub format: String,
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    /// "image" — để dành cho "video" (GĐ4) mà không phải bump `formatVersion`.
    pub kind: String,
    #[serde(rename = "appVersion", default)]
    pub app_version: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: i64,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: i64,
}

/// Nội dung một `.snapdoc` đã đọc xong.
pub struct SnapdocFile {
    pub base_png: Vec<u8>,
    pub doc_json: String,
    /// `None` khi không có bản nháp (tức trạng thái trên đĩa = đã lưu).
    pub draft_json: Option<String>,
    pub created_at: i64,
}

impl SnapdocFile {
    /// Trạng thái NÊN mở ra cho user: ưu tiên bản nháp nếu có.
    pub fn effective_doc(&self) -> &str {
        self.draft_json.as_deref().unwrap_or(&self.doc_json)
    }
}

/// `true` nếu file ở `path` là container `.snapdoc` (theo magic bytes, không
/// theo phần mở rộng). `false` cho ảnh trần, file không đọc được, file rỗng.
pub fn is_snapdoc(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    match f.read_exact(&mut magic) {
        Ok(()) => magic == ZIP_MAGIC,
        Err(_) => false,
    }
}

fn read_entry<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    match zip.by_name(name) {
        Ok(mut e) => {
            // Cap tại 256MB để tránh OOM từ file lạ/corrupt khai size giả.
            let mut buf = Vec::with_capacity(e.size().min(256 * 1024 * 1024) as usize);
            e.read_to_end(&mut buf)
                .map_err(|err| format!("Không đọc được entry {name}: {err}"))?;
            Ok(Some(buf))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(err) => Err(format!("Không mở được entry {name}: {err}")),
    }
}

pub fn read_snapdoc(path: &Path) -> Result<SnapdocFile, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Không mở được file: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("File .snapdoc không hợp lệ: {e}"))?;

    let manifest_raw = read_entry(&mut zip, MANIFEST)?
        .ok_or_else(|| "File .snapdoc thiếu manifest.json".to_string())?;
    let manifest: Manifest = serde_json::from_slice(&manifest_raw)
        .map_err(|e| format!("manifest.json không đọc được: {e}"))?;

    // Từ chối HẲN file mới hơn thay vì parse phần hiểu được: một bản cũ đọc
    // nửa vời sẽ lặng lẽ bỏ qua annotation nó không biết, rồi LÀM MẤT chúng ở
    // lần lưu tiếp theo — mất dữ liệu im lặng, tệ hơn là báo lỗi thẳng.
    if manifest.format_version > FORMAT_VERSION {
        return Err(format!(
            "File được tạo bởi bản SnapDoc mới hơn (định dạng v{}, bản này hỗ trợ tới v{}). \
             Hãy cập nhật SnapDoc để mở file này.",
            manifest.format_version, FORMAT_VERSION
        ));
    }

    let base_png = read_entry(&mut zip, BASE_PNG)?
        .ok_or_else(|| "File .snapdoc thiếu base.png".to_string())?;
    let doc_json = read_entry(&mut zip, DOC_JSON)?
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_else(|| "{}".to_string());
    let draft_json =
        read_entry(&mut zip, DRAFT_JSON)?.map(|b| String::from_utf8_lossy(&b).into_owned());

    Ok(SnapdocFile {
        base_png,
        doc_json,
        draft_json,
        created_at: manifest.created_at,
    })
}

/// Có bản nháp chưa lưu hay không — **chỉ đọc central directory của ZIP**,
/// không giải nén entry nào.
///
/// Cần bản rẻ riêng vì đường quét "item nào còn việc dở" phải chạy qua nhiều
/// file một lượt; dùng `read_snapdoc` ở đó sẽ kéo cả `base.png` (vài MB mỗi
/// ảnh) vào RAM chỉ để xem một entry có tồn tại không.
///
/// `false` cho file không đọc được / không phải container — caller ở đây chỉ
/// cần biết "có nháp để mời user quay lại", không phải chỗ báo lỗi.
pub fn has_draft(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(zip) = zip::ZipArchive::new(file) else {
        return false;
    };
    // `index_for_name` chỉ tra central directory (đã nạp sẵn khi mở archive) và
    // KHÔNG mượn `zip`, khác `by_name` (trả reader mượn archive → không sống
    // qua được cuối hàm).
    zip.index_for_name(DRAFT_JSON).is_some()
}

/// Đọc lẻ một entry — cho các đường chỉ cần `preview.png` (copy clipboard, xem
/// nhanh) mà không muốn kéo cả `base.png` vào RAM.
pub fn read_snapdoc_entry(path: &Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Không mở được file: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("File .snapdoc không hợp lệ: {e}"))?;
    read_entry(&mut zip, name)
}

pub struct WriteSnapdoc<'a> {
    pub base_png: &'a [u8],
    pub doc_json: &'a str,
    pub draft_json: Option<&'a str>,
    pub preview_png: &'a [u8],
    pub created_at: i64,
    pub updated_at: i64,
}

/// Ghi container. **Luôn ATOMIC**: dựng ra `<path>.tmp` rồi `rename`.
///
/// Bắt buộc phải atomic vì autosave ghi lại file này liên tục: viết đè trực
/// tiếp mà crash giữa đường là mất CẢ nền lẫn annotation — mất nhiều hơn đúng
/// cái bug đang sửa. `rename` trong cùng filesystem là atomic ở cả macOS và
/// Windows (`fs::rename` dùng `MoveFileEx` với REPLACE_EXISTING).
///
/// Mọi entry nén **level 0 (stored)**: PNG đã nén sẵn nên deflate thêm gần 0%
/// nhưng tốn CPU ở MỖI lần autosave.
pub fn write_snapdoc(path: &Path, data: WriteSnapdoc<'_>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Không tạo được thư mục chứa .snapdoc: {e}"))?;
    }
    // Tên tmp gắn với đúng file đích (không phải tmp dùng chung) để 2 lần ghi
    // 2 file khác nhau chạy song song không đạp lên nhau.
    let tmp = path.with_extension("snapdoc.tmp");

    {
        let f = std::fs::File::create(&tmp).map_err(|e| format!("Không tạo được file tạm: {e}"))?;
        let mut zip = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        let manifest = Manifest {
            format: "snapdoc".to_string(),
            format_version: FORMAT_VERSION,
            kind: "image".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            created_at: data.created_at,
            updated_at: data.updated_at,
        };
        let manifest_raw = serde_json::to_vec(&manifest)
            .map_err(|e| format!("Không serialize được manifest: {e}"))?;

        let mut put = |name: &str, bytes: &[u8]| -> Result<(), String> {
            zip.start_file(name, opts)
                .map_err(|e| format!("Không ghi được entry {name}: {e}"))?;
            zip.write_all(bytes)
                .map_err(|e| format!("Không ghi được entry {name}: {e}"))
        };

        put(MANIFEST, &manifest_raw)?;
        put(BASE_PNG, data.base_png)?;
        put(DOC_JSON, data.doc_json.as_bytes())?;
        if let Some(draft) = data.draft_json {
            put(DRAFT_JSON, draft.as_bytes())?;
        }
        put(PREVIEW_PNG, data.preview_png)?;

        zip.finish()
            .map_err(|e| format!("Không hoàn tất được .snapdoc: {e}"))?;
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        // Dọn tmp nếu rename lỗi — đừng để lại rác trong thư mục Library.
        let _ = std::fs::remove_file(&tmp);
        format!("Không thay được file .snapdoc: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("snapdoc-test-{name}.snapdoc"))
    }

    fn write_sample(path: &Path, draft: Option<&str>) {
        write_snapdoc(
            path,
            WriteSnapdoc {
                base_png: b"BASEPIXELS",
                doc_json: r#"{"kind":"image","annotations":[]}"#,
                draft_json: draft,
                preview_png: b"PREVIEWPIXELS",
                created_at: 111,
                updated_at: 222,
            },
        )
        .unwrap();
    }

    #[test]
    fn round_trip_without_draft() {
        let p = tmp_path("round-trip");
        write_sample(&p, None);

        assert!(is_snapdoc(&p), "phải nhận ra là container .snapdoc");
        let f = read_snapdoc(&p).unwrap();
        assert_eq!(f.base_png, b"BASEPIXELS");
        assert_eq!(f.doc_json, r#"{"kind":"image","annotations":[]}"#);
        assert!(f.draft_json.is_none());
        assert_eq!(f.created_at, 111);
        // Không có draft → trạng thái mở ra là bản đã lưu.
        assert_eq!(f.effective_doc(), f.doc_json);

        assert_eq!(
            read_snapdoc_entry(&p, PREVIEW_PNG).unwrap().as_deref(),
            Some(&b"PREVIEWPIXELS"[..]),
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn draft_takes_precedence_over_saved_doc() {
        let p = tmp_path("draft");
        write_sample(&p, Some(r#"{"kind":"image","annotations":[1]}"#));

        let f = read_snapdoc(&p).unwrap();
        assert_eq!(f.draft_json.as_deref(), Some(r#"{"kind":"image","annotations":[1]}"#));
        // Đây là ngữ nghĩa cốt lõi: có nháp thì mở nháp, không mất việc chưa lưu.
        assert_eq!(f.effective_doc(), r#"{"kind":"image","annotations":[1]}"#);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rewrite_drops_draft_entry() {
        let p = tmp_path("rewrite");
        write_sample(&p, Some("{\"draft\":true}"));
        assert!(read_snapdoc(&p).unwrap().draft_json.is_some());

        // Đúng những gì Save làm: ghi lại không kèm draft.
        write_sample(&p, None);
        assert!(
            read_snapdoc(&p).unwrap().draft_json.is_none(),
            "ghi lại phải XOÁ hẳn draft cũ, không được để sót entry",
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rejects_newer_format_version() {
        let p = tmp_path("newer");
        // Dựng tay 1 container khai formatVersion cao hơn.
        {
            let f = std::fs::File::create(&p).unwrap();
            let mut zip = zip::ZipWriter::new(f);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zip.start_file(MANIFEST, opts).unwrap();
            zip.write_all(
                br#"{"format":"snapdoc","formatVersion":99,"kind":"image"}"#,
            )
            .unwrap();
            zip.start_file(BASE_PNG, opts).unwrap();
            zip.write_all(b"X").unwrap();
            zip.finish().unwrap();
        }
        let err = match read_snapdoc(&p) {
            Err(e) => e,
            Ok(_) => panic!("phải từ chối file khai định dạng mới hơn"),
        };
        assert!(err.contains("mới hơn"), "thông báo phải nói rõ lý do: {err}");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn plain_image_is_not_snapdoc() {
        // Ảnh PNG trần (Library của các bản trước) — phải nhận ra để đọc đúng
        // đường tương thích ngược, không phải cố mở như zip.
        let p = std::env::temp_dir().join("snapdoc-test-plain.png");
        std::fs::write(&p, [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).unwrap();
        assert!(!is_snapdoc(&p));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_and_truncated_files_are_not_snapdoc() {
        assert!(!is_snapdoc(Path::new("/khong/ton/tai/abc.snapdoc")));
        // File ngắn hơn 4 byte: `read_exact` lỗi, không được panic.
        let p = std::env::temp_dir().join("snapdoc-test-short.snapdoc");
        std::fs::write(&p, b"PK").unwrap();
        assert!(!is_snapdoc(&p));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn corrupt_zip_reports_error_not_panic() {
        let p = tmp_path("corrupt");
        // Magic đúng nhưng phần còn lại là rác → phải trả Err.
        std::fs::write(&p, [0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFF, 0xFF, 0xFF]).unwrap();
        assert!(is_snapdoc(&p));
        assert!(read_snapdoc(&p).is_err());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn base_survives_round_trip_as_decodable_png() {
        // Hợp đồng dữ liệu thật giữa Rust và Editor: `base.png` lấy ra khỏi
        // container phải decode được bằng `image` (đường
        // `save_history_doc_sync` gọi `image::load_from_memory` để lấy w/h ghi
        // vào DB) và giữ ĐÚNG kích thước. Nén Stored + ghi qua ZipWriter là chỗ
        // duy nhất có thể làm hỏng byte, nên kiểm ở đây thay vì tin.
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            7,
            3,
            image::Rgba([1, 2, 3, 255]),
        ))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();

        let p = tmp_path("real-png");
        write_snapdoc(
            &p,
            WriteSnapdoc {
                base_png: &png,
                doc_json: r#"{"payloadV":1,"kind":"image","annotations":[]}"#,
                draft_json: None,
                preview_png: &png,
                created_at: 1,
                updated_at: 2,
            },
        )
        .unwrap();

        let f = read_snapdoc(&p).unwrap();
        assert_eq!(f.base_png, png, "byte của base.png phải nguyên vẹn");
        let img = image::load_from_memory(&f.base_png).expect("base.png phải decode được");
        assert_eq!((img.width(), img.height()), (7, 3));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn no_tmp_file_left_behind() {
        let p = tmp_path("no-tmp");
        write_sample(&p, None);
        assert!(
            !p.with_extension("snapdoc.tmp").exists(),
            "file tạm phải được rename đi, không để lại rác",
        );
        std::fs::remove_file(&p).ok();
    }
}
