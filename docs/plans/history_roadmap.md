# Kế hoạch & Lộ trình Nâng cấp Màn hình Thư viện (History Roadmap)

Tài liệu này tổng hợp chiến lược phát triển, kiến trúc kỹ thuật và lộ trình nâng cấp màn hình **Thư viện (History)** của Snapdoc nhằm nâng cao năng suất, tối ưu hóa trải nghiệm người dùng desktop và giữ vững độ ổn định, hiệu năng cao.

---

## 🧭 Lộ trình Triển khai (Phased Implementation)

### Giai đoạn 1: Trải nghiệm Năng suất & Thao tác Nhanh (Quick Wins & Productivity)
> **Mục tiêu**: Tối ưu thao tác chuột, bàn phím và điều hướng xem ảnh nhanh mà không cần mở nhiều cửa sổ.

1. **Menu chuột phải (Context Menu)**
   - Click chuột phải trên card ảnh / dòng danh sách:
     - 📋 Sao chép ảnh (Copy to Clipboard)
     - ✏️ Mở trong Editor (Open in Editor)
     - 📂 Hiện trong Finder / Explorer (Reveal in Finder)
     - ⭐ Đánh dấu Yêu thích (Toggle Favorite)
     - 📤 Xuất ảnh ra... (Export Image)
     - 🗑️ Xoá vào Thùng rác / Khôi phục
   - Tương thích cả khi chọn 1 item hoặc chọn nhiều item (Batch context menu).

2. **Xem ảnh nhanh toàn màn hình bằng phím Spacebar (Quick Look / Lightbox)**
   - Nhấn `Space`: Bật modal Lightbox xem ảnh kích thước gốc hoặc xem video preview.
   - Nhấn `←` / `→`: Chuyển mượt mà giữa các ảnh kế tiếp.
   - Nhấn `Esc` hoặc `Space`: Đóng Lightbox.
   - Thanh công cụ nổi đáy Lightbox: Copy, Edit, Export, Delete.

3. **Thanh tìm kiếm theo Tên & Ứng dụng nguồn (Search Bar)**
   - Thêm ô tìm kiếm trên Toolbar (`Cmd/Ctrl + F`).
   - Tìm kiếm realtime theo: `title`, `source_app` (Chrome, VS Code, Figma, Slack...).

---

### Giai đoạn 2: Quản lý & Tổ chức Thông minh (Smart Organization)

1. **Đánh dấu Yêu thích ⭐ (Favorites / Pin to Top)**
   - Bổ sung cờ `is_favorite: bool` trong SQLite (`history`).
   - Icon ngôi sao click 1 chạm trên từng card ảnh.
   - Tab chuyển nhanh: `Tất cả` | `⭐ Yêu thích` | `🗑️ Thùng rác`.

2. **Kéo thả ảnh trực tiếp ra ngoài (Native Drag & Drop Out)** ✅ *(Đã hoàn thành)*
   - Kéo trực tiếp thumbnail từ Snapdoc thả vào Telegram, Slack, Discord, trình duyệt web, Figma, Finder/Explorer.
   - Sử dụng cơ chế file dragging native của OS (`tauri-plugin-drag` / `@crabnebula/tauri-plugin-drag`) với lazy PNG cache rendering đạt hiệu năng 0-1ms.
   - Hỗ trợ kéo thả cả 1 ảnh hoặc hàng loạt ảnh khi chọn nhiều (multi-select drag). Tương thích cả Grid view, List view và Preview Panel.

3. **Thu gọn / Mở rộng Preview Panel (Toggle Collapsible Panel)**
   - Cho phép người dùng thu gọn panel bên phải để dành 100% không gian hiển thị lưới ảnh.
   - Hiển thị Floating Action Dock ở cạnh dưới khi chọn nhiều ảnh trong lúc panel bên phải đang ẩn.

---

### Giai đoạn 3: Xử lý Hàng loạt & Công cụ Nâng cao (Batch Tools)

0. **Đổi tên hàng loạt theo mẫu (Batch Rename)** ✅ *(Đã hoàn thành)*
   - Đổi tên hàng loạt với 3 chế độ: Theo mẫu đánh số tự động (`{name}`, `{index:02}`, `{date}`, `{time}`, `{app}`), Tìm & thay thế (Find & Replace), và Thêm tiền tố / hậu tố (Prefix/Suffix).
   - Live Preview thời gian thực trực quan, cập nhật nguyên tử qua SQLite Transaction (1-2ms cho 100 mục).
   - Tự động đồng bộ ngay vào Zustand Store mà không cần tải lại trang.

1. **Ghép nhiều ảnh đã chọn thành 1 ảnh dài (Batch Stitch / Combine)**
   - Tận dụng thuật toán ghép ảnh có sẵn (`StitchDialog.tsx`).
   - Ghép dọc (ảnh cuộn) hoặc ghép ngang (so sánh trước/sau) và lưu ngay vào Thư viện / mở Editor.

2. **Xuất thành 1 file PDF (Export to PDF)**
   - Gom các ảnh tài liệu / slide / hoá đơn đã chọn thành 1 file PDF duy nhất.

3. **Chính sách tự động dọn dẹp bộ nhớ (Storage Retention)**
   - Tuỳ chọn tự động dọn Thùng rác sau 30 ngày.
   - Cảnh báo dung lượng khi Thư viện vượt quá ngưỡng cấu hình (ví dụ 5GB / 10GB).

---

### Giai đoạn 4: Đột phá Tìm kiếm với Trí tuệ Nhân tạo / OCR (AI & Offline OCR)

1. **Offline OCR & Full-Text Search**
   - Chạy nhận diện chữ ngầm khi chụp (sử dụng Apple Vision API trên macOS / Windows Media OCR trên Windows).
   - Lưu text vào bảng `FTS5` (Full-Text Search SQLite).
   - Tìm kiếm ảnh theo nội dung chữ xuất hiện bên trong ảnh (báo lỗi terminal, tin nhắn, đoạn code...).

---

## 🛡️ Nguyên tắc Kỹ thuật & Cam kết An toàn

1. **Documentation & Architecture Integrity**: Không phá vỡ cấu trúc schema SQLite hiện có; mọi thay đổi DB đều đi qua migration an toàn (`migrate_v3`).
2. **Hiệu năng I/O & Bộ nhớ**:
   - Mọi tác vụ nặng (OCR, encode PDF, ghép ảnh, xuất file) chạy ở backend Rust trong `spawn_blocking`.
   - Không chuyển khối lượng lớn base64 qua IPC giữa Webview và Rust.
3. **Phạm vi tác động cô lập**: Từng tính năng được triển khai độc lập, kiểm tra build (`npm run build`) và verify kỹ lưỡng trước khi chuyển giai đoạn.
