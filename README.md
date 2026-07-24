# SnapDoc

App desktop chụp ảnh, quay màn hình & chú thích cho **Windows + macOS**. Ưu tiên tốc độ: hotkey → chụp/quay → chú thích/cắt nhanh → save/copy.

> Stack: **Tauri 2** (Rust) + **React 19 + TypeScript + Vite** + **Konva** (editor) + **zustand** (state).
> Xem [ARCHITECTURE.md](ARCHITECTURE.md) cho thiết kế capture-bar kiểu macOS và sơ đồ thư mục.

## Luồng chính (User Flows)

### 1️⃣ Chụp ảnh nhanh
```
Phím tắt → Chụp (6 chế độ) → Thumbnail popup → Chọn hành động → Kết thúc
                    ↓ (hoặc mở Editor)
            Editor (chú thích) → Lưu/Copy
```

### 2️⃣ Quay màn hình
```
Phím tắt → Chọn vùng/cửa sổ → Đang quay (icon + timer ở tray) → Dừng quay
                                                                      ↓
                    → Xem lại & cắt video (CapCut-style) → Lưu hoặc Xoá
```

### 3️⃣ Chỉnh sửa ảnh
```
Từ thumbnail / Library / Mở file → Editor → Vẽ chú thích / Nối ảnh / Crop
                                         ↓
                    → Lưu / Lưu + Copy / Copy / Flatten
```

### 4️⃣ Quản lý lịch sử (Library)
```
Mở Library → Lọc (ảnh/video, chế độ, ngày) → Xem / Sửa tên / Copy / Xoá
                                        ↓
                    → Trash (xoá mềm) → Khôi phục hoặc Xoá vĩnh viễn
```

---

## Tính năng

### 📸 Chụp ảnh — 6 chế độ
| Chế độ | Mô tả | Phím tắt |
|-------|-------|----------|
| **Toàn màn hình** | Chụp màn hình hiện tại | `Cmd/Ctrl+Shift+1` |
| **Vùng chọn** | Kéo vùng → chụp | `Cmd/Ctrl+Shift+2` |
| **Cửa sổ** | Hover highlight window → chụp | `Cmd/Ctrl+Shift+3` |
| **Tất cả màn hình** | Ghép ngang nhiều monitor | `Cmd/Ctrl+Shift+4` |
| **Chụp cuộn** | Tự cuộn trang → ghép ảnh dài | `Cmd/Ctrl+Shift+6` |
| **Chụp nhanh** | Vẽ trên overlay → chú thích ngay → lưu khi bấm Lưu/Copy | (trong Capture Bar) |

**Sau chụp — chọn hành động:**
- Mở Editor → chú thích chi tiết
- Copy → clipboard
- Lưu → thư mục
- Lưu + Copy → cả hai
- Copy + Editor → copy và mở editor liên tiếp
- (cấu hình mặc định trong Settings)

### 🎥 Quay màn hình
- **Chế độ:** Vùng chọn / Cửa sổ / Toàn màn hình
- **Chất lượng:** 30fps
- **Âm thanh:** Tắt / Micro / Âm thanh hệ thống (tuỳ chọn)
- **Xem lại bắt buộc:** Sau quay dừng → màn "Xem lại" để cắt video trước khi lưu

### ✂️ Cắt video (Video Trim) — kiểu CapCut
- **Chế độ:** Nhiều đoạn chọn được giữ, các đoạn còn lại xoá
- **Tính năng:**
  - Chia đoạn: `Ctrl/Cmd+B`
  - Xoá đoạn: `Delete`
  - Cắt đầu: `Q` (tại vị trí pause)
  - Cắt cuối: `W` (tại vị trí pause)
  - Undo/Redo: `Ctrl/Cmd+Z` / `+Shift`
  - Xem trước: Filmstrip theo từng khung hình
- **Kết thúc:** Lưu vào Library hoặc Xoá — không tự động

### 🎨 Chỉnh sửa ảnh (Editor)
**Công cụ chú thích (bằng Konva):**
- Chọn (V)
- Chữ nhật (R)
- Ellipse (O)
- Mũi tên (T)
- Đường thẳng
- Mũi tên đánh số (N)
- Chữ (C)
- Số bước / Step counter
- Highlight
- Làm mờ (Blur)
- Pixelate
- Che toàn bộ (Solid color)
- Crop

**Chức năng:**
- **Undo/Redo:** `Cmd/Ctrl+Z` / `+Shift`
- **Zoom thông minh:** 100% cho ảnh vùng chọn; tự fit cho các chế độ khác
- **Nối ảnh:** Ghép nhiều ảnh thành 1 ảnh dài (stitch)
- **Mở file:** Drag-drop hoặc "Open with" — chỉnh sửa file ảnh từ thư mục khác
- **Xuất:**
  - Lưu: lưu đè file gốc (hoặc tạo bản copy)
  - Lưu + Copy: lưu + copy clipboard
  - Copy: chỉ copy không lưu
  - Flatten: gộp chú thích vào ảnh gốc

### 📚 Library (Lịch sử)
- **Tự động lưu:** Mọi ảnh/video chụp/quay được lưu vào Library, không phụ thuộc hành động xuất
- **Lọc:**
  - Loại (ảnh / video)
  - Chế độ (full screen / region / window / scrolling / all screens)
  - Khoảng ngày
- **Quản lý:**
  - Xoá mềm (Trash)
  - Khôi phục từ Trash
  - Xoá vĩnh viễn
  - Empty Trash (xoá tất cả ở Trash)
- **Hành động trên file:**
  - Đổi tên
  - Mở thư mục chứa file
  - Copy vào clipboard
  - Mở lại trong Editor (lưu đè bản ghi cũ)
  - Cắt video đã lưu (tạo bản ghi mới, giữ nguyên bản gốc)

### ⚙️ Cài đặt (Settings)
- Thư mục lưu ảnh/video
- Hành động mặc định sau chụp (6 tùy chọn: Edit / Copy / Save / Save+Copy / Copy+Edit / Quick capture)
- Nguồn ghi âm khi quay (Tắt / Micro / Âm thanh hệ thống)
- Khởi động cùng hệ thống
- **Tuỳ biến phím tắt:** Mọi phím tắt toàn cục có thể thay đổi
- Quyền Screen Recording (macOS) — kiểm tra trạng thái

### 🎚️ Capture Bar (Thanh điều khiển)
- **Vị trí:** Nổi lên ở đáy màn hình (always-on-top)
- **Mở:** `Cmd/Ctrl+Shift+5` hoặc từ Menu Tray
- **Chức năng:**
  - Chọn chế độ chụp (Full / Window / Region)
  - Dropdown Options (lưu vào / timer / mở editor / nhớ vùng)
  - Nút Chụp / Esc (đóng)
- **Menu Tray:**
  - Mọi chế độ chụp/quay (direct hotkey)
  - Mở Capture Bar
  - Mở Library
  - Mở Settings
  - Icon + Đồng hồ đếm khi đang quay

### 🔄 Tự động cập nhật
- Kiểm tra 1 lần mỗi khi mở app
- Tải + cài âm thầm ở nền (không popup, không bắt restart)
- Áp dụng ở lần khởi động kế tiếp
- Kiểm tra/cài thủ công trong Settings

### 🖥️ Đa màn hình & Đa nền tảng
- **Nền tảng:** macOS (ScreenCaptureKit) + Windows (Windows Graphics Capture)
- **Capture:** Chụp, quay, ghi âm hệ thống hỗ trợ cả 2 nền tảng
- **UI multi-monitor:** Mọi cửa sổ (Capture Bar, Editor, Library, Settings, Xem lại video...) luôn mở trên màn hình chứa con trỏ chuột

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
**Tất cả tuỳ biến được trong Settings** → Keybindings.

### Chụp ảnh & Quay video
| Hành động | macOS | Windows |
|---|---|---|
| **Mở Capture Bar** | `Cmd+Shift+5` | `Ctrl+Shift+5` |
| **Chụp toàn màn hình** (instant) | `Cmd+Shift+1` | `Ctrl+Shift+1` |
| **Chụp vùng chọn** (instant) | `Cmd+Shift+2` | `Ctrl+Shift+2` |
| **Chụp cửa sổ** (instant) | `Cmd+Shift+3` | `Ctrl+Shift+3` |
| **Chụp tất cả màn hình** | `Cmd+Shift+4` | `Ctrl+Shift+4` |
| **Chụp cuộn** | `Cmd+Shift+6` | `Ctrl+Shift+6` |
| **Quay màn hình** | `Cmd+Shift+7` | `Ctrl+Shift+7` |
| **Chụp & Copy** (instant region) | `Cmd+Shift+C` | `Ctrl+Shift+C` |

### Trong Editor (chú thích)
| Phím | Chức năng |
|-----|----------|
| `V/R/O/T/N/C` | Chọn tool (Chọn/Hình chữ nhật/Ellipse/Text/Mũi tên/Mũi tên số) |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `Delete` | Xoá object chọn |
| `Cmd/Ctrl+S` | Lưu |
| `Cmd/Ctrl+Shift+S` | Lưu + Copy |

### Trong Video Trim (cắt video)
| Phím | Chức năng |
|-----|----------|
| `Ctrl/Cmd+B` | Chia đoạn (split) |
| `Q` | Cắt đầu (trim start) |
| `W` | Cắt cuối (trim end) |
| `Delete` | Xoá đoạn đang chọn |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` | Redo |

## Cấu trúc Project

### Backend — `src-tauri/` (Rust + Tauri)
| Module | Chức năng |
|--------|----------|
| `capture/` | Chụp ảnh (xcap + ScreenCaptureKit macOS + WGC Windows) |
| `record/` | Quay video + ghi âm + encode FFmpeg |
| `history/` | SQLite Library (lưu trữ metadata) |
| `hotkey/` | Đăng ký + xử lý phím tắt toàn cục |
| `windows/` | Quản lý lifecycle mọi cửa sổ webview |
| `tray/` | Menu tray + icon + timer quay |
| `storage/` | Cấu hình, settings |
| `update/` | Auto-update checks + silent install |

### Frontend — `src/` (React + TypeScript + Vite)

**Routes** (`routes/` — mỗi cửa sổ = 1 route):
| Route | Cửa sổ | Chức năng |
|-------|--------|----------|
| `capture-bar/` | Capture Bar | Thanh điều khiển chụp/quay nổi |
| `overlay/` | Overlay | Chọn vùng / chọn window / preview |
| `editor/` | Editor Window | Chú thích ảnh (Konva canvas) |
| `history/` | Library Window | Xem lịch sử ảnh/video |
| `record-review/` | Video Review | Xem lại video sau quay, chọn cắt |
| `history-trim/` | History Trim | Cắt video từ Library |
| `settings/` | Settings Window | Cấu hình app |
| `thumbnail/` | Thumbnail Popup | Popup ảnh vừa chụp (tự ẩn) |
| `quick-capture/` | Quick Capture | Chế độ chụp nhanh + vẽ |
| `recording-indicator/` | Recording Indicator | Icon + timer khi đang quay |
| `update/` | Update Window | Thông báo cập nhật |

**Features** (logic chia sẻ):
| Module | Chức năng |
|--------|----------|
| `features/annotation/` | Konva editor (canvas, tools, undo/redo) |
| `features/video-trim/` | Logic cắt video (segments, frame seeking) |
| `features/output/` | Xử lý output (copy/save/flatten) |
| `lib/` | Utilities (IPC, shortcut bindings) |
