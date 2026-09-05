# SnapDoc

<p>
  <strong>Ngôn ngữ / Language:</strong> <a href="README.md">English</a> | <b>Tiếng Việt</b>
</p>

Ứng dụng chụp ảnh màn hình, quay video màn hình & chú thích đa phương tiện cho **Windows + macOS**. Thiết kế ưu tiên tốc độ: phím tắt → chụp/quay → chú thích/cắt tỉa → lưu/sao chép.

> Công nghệ: **Tauri 2** (Rust) + **React 19 + TypeScript + Vite** + **Konva** (trình vẽ canvas) + **zustand** (quản lý state) + **FFmpeg** (xử lý video).  
> Bộ máy chụp native: **ScreenCaptureKit** (macOS) & **Windows Graphics Capture (WGC)** (Windows).  
> Xem thêm [ARCHITECTURE.md](ARCHITECTURE.md) về kiến trúc và [BUILD.md](BUILD.md) về hướng dẫn đóng gói phát hành.

---

## ⚡ Luồng hoạt động chính (Core Workflows)

### 1️⃣ Chụp ảnh tức thì & Chú thích nhanh
```text
Phím tắt / Capture Bar → Chụp (7 chế độ) → Thumbnail popup → Chọn tác vụ (Editor / Copy / Lưu)
                                               ↓
                              Trình biên tập (15+ công cụ) → Lưu / Copy / Flatten
```

### 2️⃣ Quay màn hình kèm Hiển thị phím bấm & Âm thanh
```text
Phím tắt / Capture Bar → Chọn Vùng / Cửa sổ / Toàn màn hình → Đếm ngược 3-2-1
                                                                  ↓
        Quay video (Viền nhấp nháy + Bàn phím ảo HUD + Timer khay + Nút dừng nổi)
                                                                  ↓
                  → Xem lại & Cắt video CapCut-style → Lưu / Xuất GIF / Hủy bỏ
```

### 3️⃣ Chú thích ảnh & Tạo khung nền Mockup
```text
Từ Ảnh chụp / Thư viện / Mở file / Kéo thả → Editor (Canvas)
                                                  ↓
      Chú thích (Mũi tên, Đánh số, Che mờ) + Tạo nền Mockup (Gradient/Đổ bóng) + Ghép ảnh
                                                  ↓
                  → Lưu (.snapdoc không phá hủy / PNG) / Copy vào Clipboard
```

### 4️⃣ Cắt sửa Video & Xuất ảnh động GIF
```text
Xem lại video / Thư viện / Editor → Video Trimmer
                                       ↓
      Tách & Cắt đoạn (Q / W / Cmd+B) + Chèn Overlay (Chữ, Mũi tên, Che mờ) + Tắt tiếng
                                       ↓
           → Lưu (Ghi đè / Lưu bản mới) / Xuất Frame ảnh / Xuất ảnh GIF
```

### 5️⃣ Quản lý Thư viện lịch sử (Library)
```text
Mở Thư viện → Lọc theo Loại (Ảnh/Video), Chế độ chụp, Khoảng ngày → Dạng Lưới / Danh sách
                                       ↓
         Xem trước & Metadata → Đổi tên / Copy / Mở lại trong Editor / Cắt / Thùng rác
```

---

## 🚀 Toàn bộ Chức năng & Công cụ

### 📸 1. Chụp màn hình (Screenshot — 7 chế độ)
| Chế độ | Mô tả | Phím tắt mặc định (macOS / Windows) |
|---|---|---|
| **Chụp vùng (Region)** | Kéo chuột chọn vùng linh hoạt với kính lúp phóng to từng pixel, toạ độ & kích thước | `Cmd+Shift+2` / `Ctrl+Shift+2` |
| **Chụp cửa sổ (Window)** | Tự động phát hiện thông minh và highlight viền cửa sổ ứng dụng khi rê chuột | `Cmd+Shift+3` / `Ctrl+Shift+3` |
| **Toàn màn hình (Full Screen)** | Chụp ngay màn hình hiện tại nơi con trỏ chuột đang đứng | `Cmd+Shift+1` / `Ctrl+Shift+1` |
| **Tất cả màn hình (All Monitors)** | Ghép toàn bộ các màn hình hiển thị thành một bức ảnh toàn cảnh duy nhất | `Cmd+Shift+4` / `Ctrl+Shift+4` |
| **Chụp & Copy (Capture & Copy)** | Kéo chọn vùng và copy ngay lập tức vào clipboard (con đường nhanh nhất) | `Cmd+Shift+C` / `Ctrl+Shift+C` |
| **Chụp cuộn (Scrolling Capture)** | Tự động/thủ công cuộn trang web hoặc tài liệu dài để ghép thành một bức ảnh dài | `Cmd+Shift+6` / `Ctrl+Shift+6` |
| **Chụp nhanh (Quick Capture)** | Đóng băng màn hình và cho phép vẽ chú thích trực tiếp lên màn hình, lưu/copy ngay | `Cmd+Shift+Q` / `Ctrl+Shift+Q` |

- **Hẹn giờ chụp trễ:** Cấu hình đếm ngược (`0s`, `5s`, `10s`) trước khi chụp với giao diện đếm ngược trực quan.
- **Hành vi sau khi chụp (Sau thao tác):**
  - **Mở trình biên tập (Editor):** Mở ảnh vào studio để vẽ chú thích chi tiết.
  - **Sao chép vào Clipboard:** Sao chép dữ liệu ảnh để paste nhanh vào chat hoặc tài liệu.
  - **Lưu vào ổ đĩa:** Lưu trực tiếp vào thư mục lưu trữ đã thiết lập.
  - **Lưu + Copy:** Thực hiện đồng thời cả hai: vừa lưu file vừa sao chép vào clipboard.
  - **Copy + Mở Editor:** Sao chép vào clipboard trước rồi mở trình biên tập.
- **Popup Thumbnail xem nhanh:** Nổi ở góc dưới màn hình ngay sau khi chụp, tích hợp nút thao tác nhanh (Mở Editor, Copy, Lưu, Xóa) và thanh thời gian tự ẩn.

---

### 🎚️ 2. Thanh điều khiển nổi (Capture Bar)
Lấy cảm hứng từ `Cmd+Shift+5` trên macOS, thanh nổi nằm căn giữa ở cạnh dưới của màn hình đang hoạt động:
- **Kích hoạt:** `Cmd+Shift+5` (macOS) / `Ctrl+Shift+5` (Windows) hoặc từ menu Khay hệ thống.
- **Chuyển đổi nhóm tác vụ:**
  - **Nhóm Chụp ảnh:** Toàn màn hình, Cửa sổ, Vùng chọn, Toàn bộ màn hình, Chụp cuộn.
  - **Nhóm Quay video:** Toàn màn hình, Cửa sổ, Vùng chọn.
- **Menu cài đặt nhanh (Options Popover):**
  - Chọn hành vi đầu ra mặc định (Mở Editor / Copy / Lưu / Lưu + Copy / Copy + Editor).
  - Chọn nguồn âm thanh ghi âm (Tắt / Microphone / Âm thanh hệ thống / Cả hai).
  - Bật/tắt hiển thị phím bấm trực tiếp (Keystroke HUD).
  - Đặt hẹn giờ chụp (Không trễ / 5s / 10s).
- **Nút Chụp / Quay một chạm & Phím đóng (`Esc`).**

---

### 🎥 3. Quay video màn hình & Hiển thị phím bấm
- **Phạm vi quay:** Tùy chọn kéo vùng bất kỳ, chọn một cửa sổ ứng dụng cụ thể hoặc toàn màn hình.
- **Hiệu năng cao:** Khung hình 30fps mượt mà, mã hóa phần cứng tối ưu thông qua FFmpeg.
- **Ghi âm đa nguồn:**
  - **Tắt:** Chỉ ghi hình, không ghi âm.
  - **Microphone:** Thu giọng nói qua micro của thiết bị.
  - **Âm thanh hệ thống:** Thu âm thanh phát ra từ máy tính (WASAPI Loopback trên Windows / ScreenCaptureKit audio trên macOS).
  - **Cả hai:** Ghi đồng thời cả âm thanh máy tính và giọng nói qua micro.
- **Bàn phím ảo trực tiếp trên màn hình (Keycaster / Keystroke HUD Overlay):**
  - Tự động hiển thị các phím gõ và tổ hợp phím tắt theo thời gian thực khi đang quay video.
  - Huy hiệu phím chuẩn phong cách Apple (`⌘ Cmd`, `⌥ Opt`, `⌃ Ctrl`, `⇧ Shift`, `⊞ Win`, `⎋ Esc`, `⏎ Enter`, `␣ Space`...).
  - Tích hợp quyền Accessibility API trên macOS.
- **Hỗ trợ trực quan khi quay:**
  - Viền màu nhấp nháy bao quanh ranh giới khu vực đang quay (`record-border`).
  - Widget nổi tạm dừng/dừng quay trên màn hình (`record-stop-control`).
  - Biểu tượng khay hệ thống kèm đồng hồ đếm thời gian quay thực tế.
  - Đếm ngược `3.. 2.. 1..` trước khi bắt đầu bấm máy.
  - Tự động ẩn cửa sổ SnapDoc khỏi video quay (`recordSelf`).
- **Quy trình kiểm tra bắt buộc (Review Screen):** Khi dừng quay, video tự động chuyển vào màn hình biên tập để xem và cắt gọt (không lưu bừa bãi khi chưa duyệt).

---

### ✂️ 4. Biên tập & Cắt video chuyên sâu (CapCut-Style Video Trimmer)
Được tích hợp trực tiếp trong cửa sổ Editor và Review:
- **Cắt tỉa phân đoạn không phá hủy (Multi-segment Trim):**
  - Chia đoạn tại vị trí con trỏ phát: `Ctrl/Cmd+B`
  - Xóa phân đoạn đang chọn: `Delete` / `Backspace`
  - Cắt bỏ phần đầu đoạn đến vị trí hiện tại: `Q`
  - Cắt bỏ phần đuôi đoạn từ vị trí hiện tại: `W`
  - Hoàn tác / Làm lại: `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`
  - Timeline Filmstrip: Dải xem trước từng khung hình dạng cuộn mượt mà.
  - Tua từng frame hình: Tiến/lùi từng khung hình (`←` / `→`), Phát/Tạm dừng (`Space`).
- **Chèn Chú thích & Overlay trực tiếp lên Video:**
  - Vẽ chú thích xuất hiện theo khoảng thời gian xác định trên video:
    - **Hộp chữ nhật (Rectangle):** Khoanh vùng làm nổi bật đối tượng trên video.
    - **Che mờ / Che đen (Blur & Blackout):** Che mờ hoặc che đen hoàn toàn thông tin nhạy cảm (mật khẩu, thẻ ngân hàng, token bí mật).
    - **Chữ chú thích (Text Badge):** Nhãn văn bản bo góc với tùy chọn cỡ chữ, màu sắc và độ tương phản cao.
    - **Mũi tên (Arrow):** Mũi tên chỉ hướng đến các chi tiết cần nhấn mạnh.
  - **Dòng thời gian Overlay (`OverlayTimelineTrack`):** Kéo thả thanh timeline để chỉnh chính xác giây bắt đầu và kết thúc hiển thị của từng chú thích.
- **Điều khiển âm thanh:** Nút bật/tắt (Mute / Remove Audio) để loại bỏ âm thanh khỏi video xuất xưởng.
- **Tùy chọn Xuất & Lưu trữ:**
  - **Lưu (Save):** Ghi đè vào tệp video gốc.
  - **Lưu thành bản mới (Save As):** Xuất thành một tệp video mới độc lập.
  - **Xuất khung hình (Export Frame):** Trích xuất khung hình đang dừng thành ảnh PNG chất lượng cao.
  - **Xuất ảnh động GIF (`GifExportModal`):**
    - Phạm vi xuất: Phân đoạn đang chọn, Toàn bộ video hoặc Khoảng thời gian tùy chỉnh.
    - Tốc độ khung hình (FPS): `10`, `15`, `24`, hoặc `30` FPS.
    - Độ phân giải: Kích thước gốc, 1080p, 720p, 480p hoặc kích thước tùy biến.
    - Tốc độ phát lại: `0.5x`, `1.0x`, `1.5x`, `2.0x`.
    - Tùy chọn lặp vô hạn (Loop forever).
    - Trình phát xem trước lặp lại kèm thanh trượt scrubbing trực tiếp.
    - Thanh tiến trình xuất file kèm nút hủy bỏ.

---

### 🎨 5. Chú thích ảnh & Studio thiết kế (Konva Canvas)
Studio chỉnh sửa ảnh chuyên nghiệp phục vụ viết tài liệu, báo cáo lỗi và hướng dẫn:

#### 🛠️ Bộ 15 công cụ chú thích
1. **Con trỏ chọn (`V`):** Di chuyển, kéo dãn kích thước, biến đổi và xóa các đối tượng vẽ.
2. **Hình chữ nhật (`R`):** Vẽ khung viền tùy chọn màu sắc và độ dày nét.
3. **Hình chữ nhật đánh số (Numbered Rect):** Khung chữ nhật có sẵn huy hiệu số thứ tự ở góc.
4. **Hình Elip / Tròn (`O`):** Khoanh tròn đối tượng cần chú ý.
5. **Mũi tên (`T`):** Mũi tên chỉ dẫn sắc nét.
6. **Mũi tên đánh số (Numbered Arrow):** Mũi tên kèm vòng tròn số thứ tự tự tăng ở đuôi mũi tên.
7. **Đường thẳng (Line):** Kẻ đường thẳng đánh dấu mốc.
8. **Bước số thứ tự (`N`):** Huy hiệu tròn đánh số tự tăng (`1`, `2`, `3`...) cho các hướng dẫn từng bước.
9. **Văn bản (`C`):** Hộp nhập ghi chú nhiều dòng với cỡ chữ tùy chỉnh (8–200px) và bảng màu phong phú.
10. **Bút dạ quang (Highlighter):** Bút đánh dấu bán trong suốt (độ mờ 0.35) làm nổi bật chữ hoặc nút bấm.
11. **Che mờ bảo mật (Blur / Pixelate / Redact):** 3 chế độ bảo mật:
    - **Gaussian Blur:** Làm mờ quang học dịu mắt.
    - **Pixelate / Mosaic:** Khối pixel điểm ảnh che trung bình.
    - **Solid Redact:** Khối màu đặc che tuyệt đối, an toàn nhất.
    - Thanh trượt chỉnh độ mờ / kích thước khối pixel.
12. **Cắt ảnh (Crop):** Khung kéo xén ảnh trực quan.
13. **Tạo khung nền Mockup / Beautifier:**
    - Khung viền sang trọng, chuyên nghiệp phục vụ đăng mạng xã hội.
    - Bộ preset phối màu gradient hiện đại hoặc màu đơn sắc (Solid).
    - Chỉnh góc xoay gradient.
    - Tùy chỉnh độ rộng viền đệm (padding), bo góc ảnh (border radius) và đổ bóng (`None`, `Subtle`, `Medium`, `Strong`).
14. **Chèn thêm ảnh:** Dán trực tiếp từ clipboard (`Cmd/Ctrl+V`) hoặc kéo thả tệp ảnh từ máy tính vào canvas.
15. **Ghép nhiều ảnh (`StitchDialog`):** Nối và ghép nhiều ảnh chụp màn hình theo chiều dọc hoặc chiều ngang thành một ảnh duy nhất.

#### ⚙️ Khả năng Canvas & Lưu trữ
- **Undo / Redo:** Ngăn xếp lịch sử thao tác đầy đủ (`Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`).
- **Zoom & Điều hướng:** Zoom thông minh (100% kích thước thật, vừa vặn màn hình, phóng to/thu nhỏ bằng con lăn chuột hoặc nút bấm).
- **Đầu ra linh hoạt:**
  - **Lưu:** Ghi đè vào ảnh gốc.
  - **Lưu bản mới (Save As):** Xuất ra tệp mới.
  - **Sao chép (Copy):** Copy ảnh hoàn thiện vào clipboard.
  - **Lưu + Copy:** Vừa lưu vào đĩa vừa copy vào clipboard chỉ với một thao tác.
  - **Flatten:** Hòa trộn vĩnh viễn toàn bộ lớp chú thích vào ảnh nền gốc.
- **Định dạng tệp `.snapdoc` không phá hủy:**
  - Định dạng container (ZIP) lưu trữ đồng thời ảnh nền gốc sạch (`base.png`), dữ liệu vector chú thích (`doc.json`), bản nháp tự động (`draft.json`) và ảnh xem trước (`preview.png`).
  - Mở lại ảnh đã chụp bất kỳ lúc nào để di chuyển, đổi màu, sửa chữ hoặc xóa từng chú thích mà không làm mất ảnh gốc!
  - Tự động lưu bản nháp và phục hồi sau sự cố với `ResumeBanner`.

---

### ⚡ 6. Dải xem nhanh gần đây (Recent History Strip)
- Nằm ngang ở đáy cửa sổ Editor.
- Hiển thị thumbnail của các ảnh và video vừa chụp gần nhất kèm huy hiệu thời lượng/độ phân giải.
- Nhấp chuột để chuyển đổi tức thì giữa các ảnh/video mà không cần mở cửa sổ Thư viện riêng.
- Menu chuột phải: Sao chép nhanh, Mở, Xóa.

---

### 📚 7. Thư viện lịch sử (Library Management)
- **Tự động lưu trữ:** Cơ sở dữ liệu SQLite lưu toàn bộ ảnh chụp và video kèm metadata.
- **Hai chế độ hiển thị:** Chuyển đổi linh hoạt giữa **Chế độ Lưới (Grid View)** và **Chế độ Danh sách (List View)**.
- **Bộ lọc mạnh mẽ:**
  - **Loại tệp:** Tất cả, Chỉ hình ảnh, Chỉ video.
  - **Chế độ chụp:** Tất cả, Vùng chọn, Cửa sổ, Toàn màn hình, Toàn bộ màn hình, Chụp cuộn, Chụp nhanh.
  - **Khoảng thời gian:** Chọn ngày bắt đầu và ngày kết thúc (`Từ ngày` — `Đến ngày`).
- **Bảng xem trước & Thanh thông tin (Inspector Panel):**
  - Trình xem ảnh sắc nét hoặc trình phát video HTML5 đầy đủ tính năng tua/phát.
  - Thông tin chi tiết: Tên tệp, kích thước điểm ảnh, dung lượng, thời lượng, chế độ chụp, ngày giờ tạo, đường dẫn tệp.
  - Phím chức năng: Đổi tên tệp trực tiếp, Sao chép vào clipboard, Mở thư mục chứa file, Mở lại trong Editor (giữ nguyên các layer chú thích), Cắt video.
- **Thùng rác & Xóa mềm (Trash & Soft Delete):**
  - Chuyển ảnh/video thừa vào Thùng rác.
  - Khôi phục từng tệp hoặc Xóa vĩnh viễn.
  - Nút **Dọn sạch thùng rác (Empty Trash)** một chạm.

---

### ⚙️ 8. Cài đặt & Tùy biến (Settings)
- **Thư mục lưu trữ:** Chọn thư mục lưu ảnh/video tùy thích bằng hộp thoại chọn thư mục của hệ thống.
- **Hành vi đầu ra mặc định:** Đặt hành vi tự động sau khi chụp (Mở Editor, Sao chép clipboard, Lưu file, Lưu + Copy, hoặc Copy + Mở Editor).
- **Cài đặt quay màn hình:** Nguồn âm thanh (Tắt / Mic / Hệ thống / Cả hai), tùy chọn ẩn cửa sổ SnapDoc, bật/tắt hiển thị phím bấm.
- **Đa ngôn ngữ (i18n):** Chuyển đổi ngôn ngữ giao diện tức thì giữa **Tiếng Việt** và **English**.
- **Khởi động cùng máy tính:** Tùy chọn tự động chạy SnapDoc khi đăng nhập hệ thống.
- **Quản lý phím tắt toàn cục:** Đổi bất kỳ tổ hợp phím tắt nào, hỗ trợ trình thu phím trực quan và cảnh báo trùng phím.
- **Chẩn đoán quyền hệ thống:** Kiểm tra trạng thái cấp quyền Ghi màn hình (Screen Recording) và Trợ năng (Accessibility) trên macOS.
- **Tự động cập nhật (In-App Auto-Updater):**
  - Tự động kiểm tra bản phát hành mới khi khởi động ứng dụng.
  - Tự tải và cài đặt ngầm trong nền mà không làm gián đoạn công việc.
  - Nút kiểm tra thủ công kèm thông báo Khởi động lại khi cài xong.

---

### 🖥️ 9. Tích hợp hệ thống & Đa màn hình
- **Tối ưu native cho macOS & Windows:** Tận dụng ScreenCaptureKit trên macOS và Windows Graphics Capture (WGC) cùng WASAPI trên Windows.
- **Nhận diện đa màn hình thông minh:** Mọi cửa sổ (Capture Bar, Editor, Library, Settings, Overlays) luôn tự động mở trên màn hình đang chứa con trỏ chuột của người dùng.
- **Menu khay hệ thống (System Tray):** Truy cập tức thì mọi chế độ chụp, quay video, thư viện, cài đặt và đồng hồ đếm giờ khi đang quay.

---

## ⌨️ Bảng tra cứu phím tắt (Keyboard Shortcuts)

*(Tất cả phím tắt toàn cục đều có thể đổi trong phần Cài đặt → Phím tắt)*

### 🎯 Chụp & Quay toàn cục
| Thao tác | macOS | Windows |
|---|---|---|
| **Mở thanh Capture Bar** | `Cmd+Shift+5` | `Ctrl+Shift+5` |
| **Chụp vùng chọn** | `Cmd+Shift+2` | `Ctrl+Shift+2` |
| **Chụp cửa sổ** | `Cmd+Shift+3` | `Ctrl+Shift+3` |
| **Chụp toàn màn hình** | `Cmd+Shift+1` | `Ctrl+Shift+1` |
| **Chụp tất cả màn hình** | `Cmd+Shift+4` | `Ctrl+Shift+4` |
| **Chụp & Copy nhanh** | `Cmd+Shift+C` | `Ctrl+Shift+C` |
| **Chụp cuộn trang** | `Cmd+Shift+6` | `Ctrl+Shift+6` |
| **Chụp nhanh & Vẽ trực tiếp** | `Cmd+Shift+Q` | `Ctrl+Shift+Q` |
| **Bắt đầu quay màn hình** | `Cmd+Shift+7` | `Ctrl+Shift+7` |

### 🎨 Trong Trình biên tập ảnh (Editor)
| Phím | Thao tác |
|---|---|
| `V` | Công cụ Chọn / Di chuyển / Biến đổi |
| `R` | Công cụ Hình chữ nhật |
| `O` | Công cụ Hình Elip / Tròn |
| `T` | Công cụ Mũi tên |
| `N` | Công cụ Bước số thứ tự |
| `C` | Công cụ Nhập văn bản |
| `Cmd/Ctrl + Z` | Hoàn tác (Undo) |
| `Cmd/Ctrl + Shift + Z` | Làm lại (Redo) |
| `Delete` / `Backspace` | Xóa đối tượng đang chọn |
| `Cmd/Ctrl + S` | Lưu (ghi đè vào file / định dạng `.snapdoc`) |
| `Cmd/Ctrl + Shift + S` | Lưu + Sao chép vào clipboard |
| `Cmd/Ctrl + C` | Sao chép ảnh vào clipboard |
| `Cmd/Ctrl + V` | Dán ảnh từ clipboard vào canvas |
| `Cmd/Ctrl + O` | Mở tệp ảnh từ ổ đĩa |
| `Cmd/Ctrl + N` | Tạo canvas trống mới |

### ✂️ Trong Trình cắt & Xem lại video
| Phím | Thao tác |
|---|---|
| `Space` | Phát / Tạm dừng video |
| `←` / `→` | Tua lùi / Tua tiến từng khung hình |
| `Ctrl/Cmd + B` | Chia tách đoạn tại vị trí phát |
| `Q` | Cắt bỏ phần đầu đoạn đến vị trí hiện tại |
| `W` | Cắt bỏ phần đuôi đoạn từ vị trí hiện tại |
| `Delete` / `Backspace` | Xóa phân đoạn đang chọn |
| `Ctrl/Cmd + Z` | Hoàn tác thao tác cắt |
| `Ctrl/Cmd + Shift + Z` | Làm lại thao tác cắt |

---

## 🏗️ Cấu trúc dự án

```text
snapdoc/
├── src-tauri/                 # Backend (Rust + Tauri 2)
│   └── src/
│       ├── capture/           # Bộ máy chụp ảnh (ScreenCaptureKit, WGC, xcap, freeze)
│       ├── record/            # Bộ máy quay video, WASAPI/SCK audio, FFmpeg encoder, keystrokes
│       ├── history/           # Cơ sở dữ liệu SQLite, lưu trữ asset, tạo thumbnail
│       ├── hotkey/            # Đăng ký phím tắt toàn cục & lắng nghe sự kiện
│       ├── windows/           # Quản lý vòng đời cửa sổ trên hệ thống đa màn hình
│       ├── storage/           # Đọc ghi cấu hình và cài đặt
│       ├── snapdoc_file.rs    # Xử lý tệp container .snapdoc (ZIP, base, annotations, draft)
│       ├── tray.rs            # Menu khay hệ thống native & chỉ báo timer
│       └── update.rs          # Kiểm tra và cài đặt cập nhật tự động ngầm
├── src/                       # Frontend (React 19 + TypeScript + Vite)
│   ├── features/
│   │   ├── annotation/        # Canvas Konva, công cụ vẽ, quản lý phiên .snapdoc, undo/redo
│   │   ├── video-trim/        # VideoTrimmer, overlay video, timeline tracks, modal xuất GIF
│   │   └── output/            # Xử lý xuất file (clipboard, hệ thống tệp, hộp thoại lưu)
│   ├── routes/                # Các route webview đa cửa sổ
│   │   ├── capture-bar/       # Thanh điều khiển nổi & popover tùy chọn
│   │   ├── editor/            # Studio biên tập ảnh & video hợp nhất + dải xem nhanh gần đây
│   │   ├── history/           # Cửa sổ Thư viện SQLite (Lưới/Danh sách, bộ lọc, xem trước, thùng rác)
│   │   ├── overlay/           # Kính ngắm kéo chọn vùng & chọn cửa sổ
│   │   ├── quick-capture/     # Lớp phủ vẽ trực tiếp tức thì
│   │   ├── record-border/     # Viền ranh giới khu vực đang quay
│   │   ├── record-keystroke/  # Bàn phím ảo HUD hiển thị phím bấm trực tiếp
│   │   ├── record-stop-control/# Widget nổi dừng và tạm dừng quay
│   │   ├── recording-indicator/# Cửa sổ thông báo đang ghi hình trên khay
│   │   ├── scroll-control/    # Giao diện điều khiển khi chụp cuộn
│   │   ├── thumbnail/         # Popup xem nhanh ảnh chụp ở góc màn hình
│   │   └── settings/          # Cửa sổ Cài đặt (phím tắt, âm thanh, đa ngôn ngữ, updater)
│   ├── locales/               # Bản dịch Tiếng Anh & Tiếng Việt (i18next)
│   └── lib/                   # Tauri IPC & cầu nối sự kiện
```

---

## 💻 Yêu cầu hệ thống & Hướng dẫn phát triển

- **Node.js** ≥ 20 (khuyên dùng Node 22)
- **Rust** ≥ 1.80 (khuyên dùng Rust 1.96+)
- **macOS:** Cần cấp quyền **Screen Recording** (Ghi màn hình) và **Accessibility** (Trợ năng) trong Cài đặt hệ thống → Quyền riêng tư & Bảo mật cho ứng dụng / terminal.

### Chạy chế độ phát triển (Development)
```bash
npm install
npm run app:dev      # Khởi động dev server Vite + biên dịch backend Rust
```

> **macOS Code Signing:** Để giữ quyền Ghi màn hình không bị reset sau mỗi lần rebuild:
> ```bash
> npm run dev:mac      # Tạo bản debug .app, tự ký bằng self-signed identity ổn định và chạy
> ```

### Đóng gói bản phát hành (Production)
```bash
npm run build        # Kiểm tra kiểu TypeScript + build Vite production
npm run app:build    # Đóng gói cài đặt hoàn chỉnh (.dmg cho macOS, .msi/.exe cho Windows)
```

Xem thêm [BUILD.md](BUILD.md) để biết chi tiết về cross-compile Windows qua Docker, chữ ký số và quy trình phát hành phiên bản.

---

## 📄 Bản quyền (License)

[MIT](LICENSE)
