# SnapDoc

App desktop chụp ảnh, quay màn hình & chú thích cho **Windows + macOS**. Ưu tiên tốc độ: hotkey → chụp/quay → chú thích/cắt nhanh → save/copy.

> Stack: **Tauri 2** (Rust) + **React 19 + TypeScript + Vite** + **Konva** (editor) + **zustand** (state).
> Xem [ARCHITECTURE.md](ARCHITECTURE.md) cho thiết kế capture-bar kiểu macOS và sơ đồ thư mục.

## Tính năng

**Chụp ảnh màn hình**
- 6 chế độ: Vùng chọn, Cửa sổ, Toàn màn hình, Tất cả màn hình (ghép ngang nhiều monitor), Chụp cuộn (tự cuộn + ghép ảnh dài), Chụp nhanh (vẽ vùng trên overlay trong suốt, chú thích ngay tại chỗ, chỉ chụp thật lúc bấm Lưu/Copy).
- Sau khi chụp: mở Editor / Copy / Lưu file / Lưu + Copy / Copy + Editor — chọn ở capture bar hoặc đặt mặc định trong Settings.

**Quay màn hình**
- Quay Vùng chọn / Cửa sổ / Toàn màn hình, 30fps; tuỳ chọn ghi âm (Tắt / Micro / Âm thanh hệ thống).
- Sau khi dừng quay, màn "Xem lại" bắt buộc trước khi lưu — cắt video kiểu CapCut: nhiều đoạn giữ lại, chia đoạn (`Ctrl/Cmd+B`), xoá đoạn đang chọn (`Delete`), cắt đầu (`Q`) / cắt cuối (`W`) theo vị trí đang dừng, undo/redo đầy đủ, filmstrip xem trước theo từng khung hình.
- Lưu vào Library hoặc Xoá — không tự lưu, không tự huỷ nếu không xác nhận.

**Chỉnh sửa ảnh (Editor)**
- Công cụ: chọn, chữ nhật, ellipse, mũi tên, đường thẳng, mũi tên đánh số, chữ, số bước (step), highlight, làm mờ/che (blur/pixelate/solid), crop.
- Undo/redo, zoom thông minh theo chế độ chụp (100% cho ảnh vùng chọn, tự fit khung cho các chế độ khác), Nối ảnh (ghép nhiều ảnh thành 1 ảnh dài), mở trực tiếp file ảnh ngoài qua "Open with".
- Xuất: Lưu / Lưu + Copy / Copy clipboard / Flatten (gộp chú thích vào ảnh gốc).

**Library (lịch sử)**
- Tự lưu mọi ảnh/video đã chụp hoặc quay, không phụ thuộc hành động xuất đã chọn.
- Lọc theo loại nội dung (ảnh/video), chế độ chụp, khoảng ngày.
- Trash (xoá mềm) + Khôi phục + Xoá vĩnh viễn + Empty Trash.
- Đổi tên, mở thư mục chứa file, copy vào clipboard, mở lại trong Editor (lưu đè đúng bản ghi cũ), cắt video đã lưu (luôn tạo bản ghi mới, giữ nguyên bản gốc).

**Cài đặt**
- Thư mục lưu ảnh, hành động mặc định sau khi chụp, nguồn ghi âm khi quay, khởi động cùng hệ thống, tuỳ biến toàn bộ phím tắt toàn cục, trạng thái quyền Screen Recording (macOS).

**Capture bar & phím tắt**
- Thanh chụp nổi luôn ở trên, gộp 2 nhóm chức năng (chụp ảnh / quay màn hình), mở nhanh bằng phím tắt hoặc từ tray.
- Menu tray đầy đủ: mọi chế độ chụp/quay, mở capture bar, Library, Settings; icon riêng + đồng hồ đếm khi đang quay.
- Toàn bộ phím tắt toàn cục có thể tuỳ biến trong Settings (xem bảng mặc định bên dưới).

**Tự động cập nhật**
- Bản release tự kiểm tra 1 lần mỗi khi mở app, tải + cài âm thầm ở nền (không popup, không bắt restart ngay) — áp dụng ở lần khởi động kế tiếp. Có thể kiểm tra/cài thủ công trong Settings.

**Đa màn hình & đa nền tảng**
- macOS (ScreenCaptureKit) và Windows (Windows Graphics Capture) — chụp, quay, ghi âm hệ thống đều hỗ trợ cả 2.
- Mọi cửa sổ (capture bar, popup ảnh vừa chụp, Editor, Library, Settings, Xem lại bản quay...) luôn mở đúng màn hình đang chứa con trỏ chuột khi có nhiều màn hình.

## Yêu cầu môi trường
- Node ≥ 20, Rust ≥ 1.80 (đã test Node 22 / Rust 1.96).
- macOS: cấp quyền **Screen Recording** (System Settings → Privacy & Security) cho app/terminal khi chạy dev.

## Chạy dev
```bash
npm install
npm run app:dev      # = tauri dev (tự chạy vite + build Rust)
```
App khởi động vào **tray / menu bar** (không có cửa sổ chính).

## Dev trên macOS — giữ quyền Screen Recording qua mỗi lần build
`tauri dev` chạy binary trần (ad-hoc), mỗi lần build lại đổi code identity → macOS **thu hồi quyền Screen Recording**, ảnh chụp ra đen. Dùng:
```bash
npm run dev:mac      # build .app debug + ký bằng identity ổn định + mở app
```
- Lần đầu: bật **System Settings → Privacy & Security → Screen Recording → SnapDoc**, thoát app, chạy lại.
- Các lần `npm run dev:mac` sau **giữ nguyên quyền** (cùng một self-signed identity).
- Identity được lưu tại `~/.tauri/snapdoc-codesign.p12` — **back up file này**; xoá/đổi sẽ phải cấp quyền lại.
- Ký lại thủ công 1 bundle bất kỳ: `npm run sign:mac [path/SnapDoc.app]`.

> Iterate UI nhanh (có HMR, chấp nhận phải cấp lại quyền): dùng `npm run app:dev`.

## Build bản phát hành
```bash
npm run app:build    # tạo .dmg (mac) / .msi,.exe (Windows)
```

## Phím tắt mặc định
Tất cả tuỳ biến được trong Settings.

| Hành động | Phím |
|---|---|
| Mở thanh chụp (capture bar) | `Cmd/Ctrl + Shift + 5` |
| Chụp toàn màn hình | `Cmd/Ctrl + Shift + 1` |
| Chụp vùng chọn | `Cmd/Ctrl + Shift + 2` |
| Chụp cửa sổ | `Cmd/Ctrl + Shift + 3` |
| Chụp tất cả màn hình | `Cmd/Ctrl + Shift + 4` |
| Chụp cuộn | `Cmd/Ctrl + Shift + 6` |
| Quay màn hình | `Cmd/Ctrl + Shift + 7` |
| Chụp & copy clipboard | `Cmd/Ctrl + Shift + C` |

Trong editor: `V/R/O/T/N/C` đổi tool · `Cmd/Ctrl+Z` undo · `+Shift` redo · `Delete` xoá · `Cmd/Ctrl+S` lưu · `+Shift` lưu & copy.

Trong màn cắt video (sau khi quay / cắt video đã lưu): `Ctrl/Cmd+B` chia đoạn · `Q` cắt đầu · `W` cắt cuối · `Delete` xoá đoạn đang chọn · `Ctrl/Cmd+Z` / `+Shift` undo/redo.

## Cấu trúc
- `src-tauri/` — Rust: `capture/` (chụp ảnh, xcap/ScreenCaptureKit/WGC), `record/` (quay màn hình + ghi âm + encode ffmpeg), `history/` (SQLite Library), `hotkey/`, `windows/` (quản lý mọi cửa sổ), `tray`, `storage`, `update`.
- `src/` — React: `routes/` (capture-bar, overlay, editor, history, record-review, history-trim, settings, thumbnail...) + `features/annotation` (Konva editor) + `features/video-trim` (cắt video).
