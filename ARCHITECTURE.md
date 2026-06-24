# SnapDoc — Kiến trúc thư mục & Capture UX (macOS-style control bar)

> Bổ sung cho tài liệu MVP. Tài liệu này: (1) định nghĩa lại luồng chụp theo kiểu **control bar ở đáy màn hình** học từ macOS `Cmd+Shift+5`, và (2) phác kiến trúc thư mục project Tauri.

---

## A. Capture UX — học từ macOS Screenshot (`Cmd+Shift+5`)

### A.1 Bài học rút ra từ macOS
macOS có **2 tầng hotkey**, và đây là điểm cốt lõi cần copy:

| Tầng | macOS | Hành vi | Khi nào user dùng |
|---|---|---|---|
| **Instant** | `Cmd+Shift+3` (full), `Cmd+Shift+4` (region) | Chụp ngay, **không** hiện UI chọn | Người dùng đã biết mình muốn gì → nhanh nhất |
| **Control bar** | `Cmd+Shift+5` | Hiện **thanh điều khiển nổi ở đáy màn hình** để chọn chế độ + options rồi mới chụp | Khi cần đổi chế độ / đổi nơi lưu / hẹn giờ |

→ SnapDoc làm **cả hai tầng**. Direct hotkey cho người quen; control bar cho người cần lựa chọn. Đây là sự khác biệt then chốt so với plan ban đầu (vốn chỉ có direct hotkey).

### A.2 Control bar trông như thế nào
Khi nhấn **master hotkey** (đề xuất `Ctrl/Cmd+Shift+5` để user macOS thấy quen), màn hình dim nhẹ và một thanh nổi bo góc xuất hiện **giữa-đáy màn hình**:

```
        ┌─────────────────────────────────────────────────────────────┐
        │  [▢ Full]  [◱ Window]  [⬚ Region]   │   ⚙ Options ▾   │  Chụp  │   ✕
        └─────────────────────────────────────────────────────────────┘
            ↑ nhóm chọn chế độ           ↑ dropdown tùy chọn   ↑ nút   ↑ Esc/đóng
```

**Nhóm chế độ (mode):** Full / Window / Region — click chọn, mode đang chọn được highlight. Khi chọn:
- **Full** → click "Chụp" (hoặc Enter) chụp ngay màn hình chứa con trỏ.
- **Window** → con trỏ thành dạng chọn cửa sổ, hover highlight window, click để chụp.
- **Region** → crosshair + kéo chọn vùng (kích thước realtime); thanh bar vẫn nổi để đổi options.

**⚙ Options dropdown (học từ macOS "Options"):**
- **Lưu vào:** Thư mục mặc định · Clipboard · Save + Copy · *Chọn thư mục khác…* (sticky — nhớ lần chọn gần nhất).
- **Mở editor sau khi chụp:** bật/tắt (đây là điểm SnapDoc thêm so với macOS — macOS chỉ hiện thumbnail).
- **Hẹn giờ:** Không / 3s / 5s.
- **Nhớ vùng chọn gần nhất** (cho Region).
- **Hiện con trỏ chuột:** bật/tắt.

**Nút "Chụp"** = thực thi theo mode + options đang chọn. **Esc / ✕** = đóng bar, không chụp.

### A.3 Sau khi chụp — hành vi đầu ra (học "thumbnail" của macOS, cải tiến)
macOS hiện một **thumbnail nổi góc dưới-phải** vài giây; click vào → mở markup, kệ nó → tự lưu. SnapDoc làm tương tự nhưng theo cấu hình:

- Nếu **"Mở editor" = ON** → mở thẳng editor.
- Nếu **OFF** → hiện **thumbnail nổi góc dưới-phải** + toast. Trên thumbnail có quick actions:
  `[✎ Sửa]  [📋 Copy]  [💾 Lưu]  [↗ Mở thư mục]`. Tự ẩn sau ~5s và áp dụng hành vi mặc định (theo "Lưu vào").
- *Lý do giữ thumbnail:* cho phép "chụp xong quên luôn" (flow nhanh) NHƯNG vẫn có đường tắt vào editor nếu đổi ý — đúng tinh thần macOS.

### A.4 Hệ quả tới hotkey (cập nhật mục 8 của MVP)
| Hành động | Windows | macOS |
|---|---|---|
| **Mở control bar** (master) | `Ctrl+Shift+5` | `Cmd+Shift+5` |
| Instant full screen | `Ctrl+Shift+1` | `Cmd+Shift+1` |
| Instant region | `Ctrl+Shift+2` | `Cmd+Shift+2` |
| Instant window | `Ctrl+Shift+3` | `Cmd+Shift+3` |
| Capture & copy (instant, region) | `Ctrl+Shift+C` | `Cmd+Shift+C` |

→ Control bar là Must-have mới. Direct hotkey vẫn giữ. Cùng một capture engine ở Rust phục vụ cả hai (chỉ khác lớp UI gọi nó).

### A.5 Hệ quả kiến trúc cửa sổ
Vì capture bar + overlay phải nổi trên mọi app và phủ toàn màn hình, app dùng **nhiều cửa sổ webview riêng** (mỗi cái một route), không phải 1 cửa sổ:

| Cửa sổ | Đặc tính | Route frontend |
|---|---|---|
| **Capture bar** | nổi (always-on-top), không viền, trong suốt, ở đáy màn hình | `/capture-bar` |
| **Overlay** | full-screen mỗi màn hình, trong suốt, click-through có kiểm soát, crosshair/highlight | `/overlay` |
| **Editor** | cửa sổ thường, có viền, resize được | `/editor` |
| **Thumbnail** | nổi nhỏ góc dưới-phải, tự ẩn | `/thumbnail` |
| **Settings** | cửa sổ thường | `/settings` |
| (Tray/menu bar) | native, không phải webview | — (Rust) |

Multi-monitor: overlay tạo **một cửa sổ cho mỗi màn hình**; capture bar hiện trên màn hình chứa con trỏ.

---

## B. Kiến trúc thư mục (Tauri v2 + React/TS + Konva)

```
screenshort-app/
├── ARCHITECTURE.md                  # tài liệu này
├── README.md
├── package.json                     # FE deps + scripts (tauri dev/build)
├── vite.config.ts
├── tsconfig.json
├── index.html
│
├── src/                             # ───── FRONTEND (webview UI) ─────
│   ├── main.tsx                     # bootstrap; route theo window label
│   ├── routes/                      # mỗi cửa sổ Tauri = 1 route
│   │   ├── capture-bar/             # thanh điều khiển kiểu Cmd+Shift+5
│   │   │   ├── CaptureBar.tsx
│   │   │   ├── ModeSwitch.tsx       # Full / Window / Region
│   │   │   ├── OptionsMenu.tsx      # lưu vào / timer / mở editor / nhớ vùng
│   │   │   └── CaptureButton.tsx
│   │   ├── overlay/                 # lớp phủ chọn vùng / chọn window
│   │   │   ├── Overlay.tsx
│   │   │   ├── RegionSelector.tsx   # kéo chọn + kích thước realtime
│   │   │   └── WindowPicker.tsx     # highlight window dưới con trỏ
│   │   ├── editor/                  # editor chú thích
│   │   │   ├── Editor.tsx
│   │   │   ├── Toolbar.tsx
│   │   │   └── OutputActions.tsx    # Save / Copy / Save+Copy
│   │   ├── thumbnail/               # thumbnail nổi sau chụp
│   │   │   └── Thumbnail.tsx
│   │   └── settings/
│   │       ├── Settings.tsx
│   │       ├── GeneralTab.tsx
│   │       └── ShortcutsTab.tsx     # remap + cảnh báo xung đột
│   │
│   ├── features/                    # logic theo domain (tách khỏi UI route)
│   │   ├── capture/
│   │   │   ├── captureMode.ts       # enum Full|Window|Region
│   │   │   └── useCapture.ts        # gọi command Rust
│   │   ├── annotation/              # ⭐ trái tim của editor
│   │   │   ├── canvas/
│   │   │   │   └── AnnotationStage.tsx   # Konva Stage + Layer
│   │   │   ├── tools/               # mỗi tool 1 file
│   │   │   │   ├── RectTool.ts
│   │   │   │   ├── EllipseTool.ts
│   │   │   │   ├── TextTool.ts
│   │   │   │   ├── StepNumberTool.ts     # badge tự tăng 1,2,3…
│   │   │   │   ├── SelectTool.ts         # move/resize/delete
│   │   │   │   └── CropTool.ts
│   │   │   ├── model.ts             # kiểu Annotation (object-based)
│   │   │   ├── history.ts           # undo/redo stack (≥20)
│   │   │   └── flatten.ts           # gộp annotation + ảnh → PNG export
│   │   ├── output/
│   │   │   └── useOutput.ts         # save / copy / save+copy + sticky pref
│   │   └── settings/
│   │       └── useSettings.ts
│   │
│   ├── lib/
│   │   ├── ipc.ts                   # wrapper invoke() → Rust commands
│   │   ├── events.ts               # listen() event từ Rust (hotkey fired…)
│   │   ├── shortcuts.ts            # phím tắt trong editor
│   │   └── store.ts                # state toàn cục (zustand)
│   ├── components/                 # UI dùng chung (Button, Dropdown, Toast…)
│   ├── styles/
│   └── types/                      # type chia sẻ FE (khớp với Rust)
│
├── src-tauri/                       # ───── BACKEND (Rust, native) ─────
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json              # khai báo windows, bundle, permissions
│   ├── icons/
│   ├── capabilities/                # Tauri v2: phân quyền per-window
│   │   └── default.json
│   └── src/
│       ├── main.rs                  # entry
│       ├── lib.rs                   # setup app, tray, đăng ký windows + commands
│       ├── commands.rs              # #[tauri::command] expose cho FE
│       ├── capture/                 # ⭐ engine chụp (dùng chung cho mọi hotkey)
│       │   ├── mod.rs
│       │   ├── fullscreen.rs
│       │   ├── window.rs            # liệt kê + chụp cửa sổ
│       │   ├── region.rs
│       │   ├── monitor.rs           # multi-monitor, DPI/scale (HiDPI/Retina)
│       │   └── mac_sck.rs           # macOS: grab pixel qua ScreenCaptureKit
│       ├── hotkey/
│       │   ├── mod.rs               # global-hotkey: master + direct
│       │   └── conflict.rs          # phát hiện xung đột khi đăng ký
│       ├── windows/                 # tạo & quản lý các cửa sổ webview
│       │   ├── mod.rs
│       │   ├── capture_bar.rs       # nổi, always-on-top, đáy màn hình
│       │   ├── overlay.rs           # 1 cửa sổ / 1 màn hình
│       │   ├── editor.rs
│       │   └── thumbnail.rs
│       ├── clipboard.rs             # ghi ảnh vào clipboard (Win CF_DIB / mac NSPasteboard)
│       ├── storage/
│       │   ├── mod.rs
│       │   ├── save.rs              # ghi file, dedup tên (_1,_2), fallback Desktop
│       │   └── settings.rs          # persist settings (JSON)
│       ├── permissions/             # ⚠ cạm bẫy macOS
│       │   ├── mod.rs
│       │   └── macos.rs             # check Screen Recording + Accessibility
│       └── tray.rs                  # tray (Win) / menu bar (mac)
│
└── .github/
    └── workflows/
        └── build.yml                # CI build .dmg (ký+notarize) + .msi/.exe
```

### B.1 Nguyên tắc tách lớp
- **Rust = quyền & native:** capture, global hotkey, clipboard ảnh, file, quyền OS, tray, tạo cửa sổ. Lý do: đây là phần phải chạm OS, và là thế mạnh kiểm soát của Tauri.
- **Frontend = trải nghiệm & vẽ:** control bar, overlay UI, editor canvas (Konva), settings. Annotation là object-based nên hợp với Konva (mỗi shape là 1 node move/select/undo được — đúng mục 6 MVP).
- **`commands.rs` + `lib/ipc.ts` là ranh giới hợp đồng:** mọi giao tiếp FE↔Rust đi qua đây; type ở `src/types` phải khớp struct Rust.
- **Capture engine dùng chung:** cả direct hotkey lẫn control bar đều gọi cùng `capture::{fullscreen,window,region}` — không nhân đôi logic.
- **Backend grab pixel theo OS (ưu tiên API native hiện đại):**
  - **macOS (≥14.0):** ScreenCaptureKit — `SCScreenshotManager.captureImageInRect` cho vùng/màn hình (display-agnostic, đa màn hình, giữ Retina) và `SCContentFilter` + `captureImageWithFilter` cho cửa sổ (chụp đúng 1 cửa sổ kể cả bị che). Thay cho `CGWindowListCreateImage` đã deprecated. Quyền kiểm tra bằng `CGPreflightScreenCaptureAccess`.
  - **Windows:** WGC — Windows.Graphics.Capture (qua xcap feature `wgc`), thay GDI BitBlt.
  - **Linux:** pipewire / X11 (qua xcap).
  - Việc **liệt kê** màn hình & cửa sổ (metadata) vẫn dùng xcap trên mọi OS; chỉ bước grab pixel mới tách theo API native.

### B.2 Thứ tự dựng (gợi ý cho sprint)
1. **Sprint 0 (PoC rủi ro):** `capture/` + `hotkey/` + `permissions/macos.rs` + `clipboard.rs` — chứng minh phần native chạy trên cả 2 OS (đây là rủi ro lớn nhất của Tauri-Rust).
2. **Sprint 1:** control bar + overlay + direct hotkey → chụp ra file/clipboard (chưa editor).
3. **Sprint 2:** editor + annotation tools + undo/redo + crop.
4. **Sprint 3:** thumbnail nổi, settings (remap + thư mục), sticky output, đánh bóng + CI build.
```
