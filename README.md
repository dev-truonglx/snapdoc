# SnapDoc

App desktop chụp & chú thích ảnh màn hình cho **Windows + macOS**. Ưu tiên tốc độ: hotkey → chụp → chú thích nhanh → save/copy.

> Stack: **Tauri 2** (Rust) + **React 19 + TypeScript + Vite** + **Konva** (editor) + **zustand** (state).
> Xem [ARCHITECTURE.md](ARCHITECTURE.md) cho thiết kế capture-bar kiểu macOS và sơ đồ thư mục.

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
| Hành động | Phím |
|---|---|
| Mở thanh chụp (control bar) | `Cmd/Ctrl + Shift + 5` |
| Chụp toàn màn hình | `Cmd/Ctrl + Shift + 1` |
| Chụp vùng chọn | `Cmd/Ctrl + Shift + 2` |
| Chụp cửa sổ | `Cmd/Ctrl + Shift + 3` |
| Chụp & copy clipboard | `Cmd/Ctrl + Shift + C` |

Trong editor: `V/R/O/T/N/C` đổi tool · `Cmd/Ctrl+Z` undo · `+Shift` redo · `Delete` xoá · `Cmd/Ctrl+S` lưu · `+Shift` lưu & copy.

## Cấu trúc
- `src-tauri/` — Rust: capture (xcap), hotkey, clipboard (arboard), windows, tray, storage.
- `src/` — React: routes (capture-bar, overlay, editor, thumbnail, settings) + features/annotation (Konva).

## Trạng thái (v0.1 scaffold)
Đã chạy được: tray, hotkey toàn cục, capture bar, editor (rect/ellipse/text/step/crop/undo-redo), copy clipboard, save file, settings.

Luồng chụp (đã tối ưu):
- **Full**: chụp ngay (PNG nén nhanh, không ghi file tạm).
- **Region**: overlay **trong suốt thấy desktop thật** → kéo chọn vùng → mới capture & crop (giống `Cmd+Shift+4`).
- **Window**: overlay liệt kê cửa sổ → **highlight cửa sổ dưới con trỏ** → click để chụp.

Chưa làm (v1.1+): chọn màn hình theo con trỏ (multi-monitor), re-register hotkey runtime, API quyền macOS chuẩn (CGPreflightScreenCaptureAccess), renumber step tự động.
