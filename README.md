# SnapDoc

Desktop screenshot, screen recording & annotation app for **Windows +
macOS**. Speed-first: hotkey → capture/record → annotate/trim → save/copy.

> Stack: **Tauri 2** (Rust) + **React 19 + TypeScript + Vite** + **Konva**
> (editor) + **zustand** (state).
> See [ARCHITECTURE.md](ARCHITECTURE.md) for the macOS-style capture-bar
> design and folder layout.

## Main flows

### 1️⃣ Quick screenshot
```
Hotkey → Capture (6 modes) → Thumbnail popup → Pick an action → Done
                    ↓ (or open Editor)
            Editor (annotate) → Save/Copy
```

### 2️⃣ Screen recording
```
Hotkey → Pick region/window → Recording (icon + timer in tray) → Stop
                                                                      ↓
                    → Review & trim (CapCut-style) → Save or Discard
```

### 3️⃣ Image editing
```
From thumbnail / Library / Open file → Editor → Annotate / Stitch / Crop
                                         ↓
                    → Save / Save + Copy / Copy / Flatten
```

### 4️⃣ History management (Library)
```
Open Library → Filter (image/video, mode, date) → View / Rename / Copy / Delete
                                        ↓
                    → Trash (soft delete) → Restore or Delete permanently
```

---

## Features

### 📸 Screenshot — 6 modes
| Mode | Description | Hotkey |
|-------|-------|----------|
| **Full screen** | Capture the current screen | `Cmd/Ctrl+Shift+1` |
| **Region** | Drag to select an area → capture | `Cmd/Ctrl+Shift+2` |
| **Window** | Hover to highlight a window → capture | `Cmd/Ctrl+Shift+3` |
| **All screens** | Stitch every monitor side by side | `Cmd/Ctrl+Shift+4` |
| **Scrolling capture** | Auto-scroll the page → stitch into one long image | `Cmd/Ctrl+Shift+6` |
| **Quick capture** | Draw on an overlay → annotate instantly → save on Save/Copy | (from the Capture Bar) |

**After capture — choose an action:**
- Open Editor → detailed annotation
- Copy → clipboard
- Save → to a folder
- Save + Copy → both
- Copy + Editor → copy then open the editor
- (default action configurable in Settings)

### 🎥 Screen recording
- **Modes:** Region / Window / Full screen
- **Quality:** 30fps
- **Audio:** Off / Microphone / System audio (optional)
- **Mandatory review:** after stopping, a "Review" screen lets you trim the
  video before saving

### ✂️ Video trim — CapCut-style
- **Mode:** keep multiple selected segments, the rest gets removed
- **Features:**
  - Split segment: `Ctrl/Cmd+B`
  - Delete segment: `Delete`
  - Trim start: `Q` (at the paused position)
  - Trim end: `W` (at the paused position)
  - Undo/Redo: `Ctrl/Cmd+Z` / `+Shift`
  - Preview: frame-by-frame filmstrip
- **Finish:** Save to Library or Discard — never automatic

### 🎨 Image editing (Editor)
**Annotation tools (built on Konva):**
- Select (V)
- Rectangle (R)
- Ellipse (O)
- Arrow (T)
- Line
- Numbered arrow (N)
- Text (C)
- Step counter
- Highlight
- Blur
- Pixelate
- Solid color cover
- Crop

**Capabilities:**
- **Undo/Redo:** `Cmd/Ctrl+Z` / `+Shift`
- **Smart zoom:** 100% for region captures; auto-fit for other modes
- **Stitching:** merge multiple images into one long image
- **Open file:** drag-drop or "Open with" — edit image files from any folder
- **Export:**
  - Save: overwrite the original file (or create a copy)
  - Save + Copy: save + copy to clipboard
  - Copy: copy only, no save
  - Flatten: bake annotations into the base image

### 📚 Library (History)
- **Auto-saved:** every captured/recorded image or video is saved to the
  Library, independent of the export action taken
- **Filters:**
  - Type (image / video)
  - Mode (full screen / region / window / scrolling / all screens)
  - Date range
- **Management:**
  - Soft delete (Trash)
  - Restore from Trash
  - Delete permanently
  - Empty Trash (delete everything in Trash)
- **Per-item actions:**
  - Rename
  - Open containing folder
  - Copy to clipboard
  - Reopen in Editor (overwrites the existing record)
  - Trim a saved video (creates a new record, keeps the original)

### ⚙️ Settings
- Image/video save folder
- Default action after capture (6 options: Edit / Copy / Save / Save+Copy /
  Copy+Edit / Quick capture)
- Recording audio source (Off / Microphone / System audio)
- Launch at startup
- **Custom shortcuts:** every global hotkey can be remapped
- Screen Recording permission (macOS) — status check

### 🎚️ Capture Bar (control bar)
- **Position:** floats at the bottom of the screen (always-on-top)
- **Open:** `Cmd/Ctrl+Shift+5` or from the tray menu
- **Capabilities:**
  - Pick capture mode (Full / Window / Region)
  - Options dropdown (save location / timer / open editor / remember region)
  - Capture / Esc (close) button
- **Tray menu:**
  - Every capture/recording mode (direct hotkey)
  - Open Capture Bar
  - Open Library
  - Open Settings
  - Icon + timer while recording

### 🔄 Auto-update
- Checked once on every app launch
- Downloaded + installed silently in the background (no popup, no forced
  restart)
- Applied on the next launch
- Manual check/install available in Settings

### 🖥️ Multi-monitor & cross-platform
- **Platforms:** macOS (ScreenCaptureKit) + Windows (Windows Graphics
  Capture)
- **Capture:** screenshots, recording, and system audio capture supported on
  both platforms
- **Multi-monitor UI:** every window (Capture Bar, Editor, Library,
  Settings, video review, etc.) always opens on the display containing the
  mouse cursor

## Requirements

- Node ≥ 20, Rust ≥ 1.80 (tested with Node 22 / Rust 1.96).
- macOS: grant **Screen Recording** permission (System Settings → Privacy &
  Security) to the app/terminal when running dev builds.

## Running in dev

```bash
npm install
npm run app:dev      # = tauri dev (runs vite + builds Rust automatically)
```

The app starts in the **tray / menu bar** — there's no main window.

## macOS dev: keeping Screen Recording permission across rebuilds

`tauri dev` runs a bare (ad-hoc signed) binary, and each build changes its
code identity → macOS **revokes the Screen Recording permission**,
producing black captures. Use:
```bash
npm run dev:mac      # builds a debug .app, signs it with a stable identity, and launches it
```
- First run: enable **System Settings → Privacy & Security → Screen
  Recording → SnapDoc**, quit the app, then run it again.
- Subsequent `npm run dev:mac` runs **keep the same grant** (same self-signed
  identity).
- The identity is stored at `~/.tauri/snapdoc-codesign.p12` — **back this
  file up**; deleting/changing it means re-granting permission.
- To re-sign an arbitrary bundle manually: `npm run sign:mac [path/SnapDoc.app]`.

> For fast UI iteration (HMR, accepting the permission re-grant), use
> `npm run app:dev` instead.

## Building a release

```bash
npm run app:build    # produces a .dmg (macOS) / .msi,.exe (Windows)
```

See [BUILD.md](BUILD.md) for signing keys, cross-building Windows via
Docker, and cutting a full release.

## Default keyboard shortcuts

**Everything below is customizable in Settings** → Keybindings.

### Capture & recording
| Action | macOS | Windows |
|---|---|---|
| **Open Capture Bar** | `Cmd+Shift+5` | `Ctrl+Shift+5` |
| **Full screen capture** (instant) | `Cmd+Shift+1` | `Ctrl+Shift+1` |
| **Region capture** (instant) | `Cmd+Shift+2` | `Ctrl+Shift+2` |
| **Window capture** (instant) | `Cmd+Shift+3` | `Ctrl+Shift+3` |
| **All-screens capture** | `Cmd+Shift+4` | `Ctrl+Shift+4` |
| **Scrolling capture** | `Cmd+Shift+6` | `Ctrl+Shift+6` |
| **Screen recording** | `Cmd+Shift+7` | `Ctrl+Shift+7` |
| **Capture & Copy** (instant region) | `Cmd+Shift+C` | `Ctrl+Shift+C` |

### In the Editor (annotation)
| Key | Action |
|-----|----------|
| `V/R/O/T/N/C` | Select tool (Select/Rectangle/Ellipse/Arrow/Numbered arrow/Text) |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |
| `Delete` | Delete selected object |
| `Cmd/Ctrl+S` | Save |
| `Cmd/Ctrl+Shift+S` | Save + Copy |

### In Video Trim
| Key | Action |
|-----|----------|
| `Ctrl/Cmd+B` | Split segment |
| `Q` | Trim start |
| `W` | Trim end |
| `Delete` | Delete selected segment |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` | Redo |

## Project structure

### Backend — `src-tauri/` (Rust + Tauri)
| Module | Responsibility |
|--------|----------|
| `capture/` | Screenshot capture (xcap + macOS ScreenCaptureKit + Windows WGC) |
| `record/` | Screen/audio recording + FFmpeg encoding |
| `history/` | SQLite-backed Library (metadata storage) |
| `hotkey/` | Global shortcut registration + handling |
| `windows/` | Lifecycle management for every webview window |
| `tray/` | Tray menu + icon + recording timer |
| `storage/` | Configuration, settings |
| `update/` | Auto-update checks + silent install |

### Frontend — `src/` (React + TypeScript + Vite)

**Routes** (`routes/` — one route per window):
| Route | Window | Responsibility |
|-------|--------|----------|
| `capture-bar/` | Capture Bar | Floating capture/recording control bar |
| `overlay/` | Overlay | Region select / window pick / preview |
| `editor/` | Editor Window | Image annotation (Konva canvas) |
| `history/` | Library Window | Browse image/video history |
| `record-review/` | Video Review | Review a recording, then trim |
| `history-trim/` | History Trim | Trim a video from the Library |
| `settings/` | Settings Window | App configuration |
| `thumbnail/` | Thumbnail Popup | Popup for a just-captured image (auto-hides) |
| `quick-capture/` | Quick Capture | Fast capture + draw mode |
| `recording-indicator/` | Recording Indicator | Icon + timer while recording |
| `update/` | Update Window | Update notification |

**Features** (shared logic):
| Module | Responsibility |
|--------|----------|
| `features/annotation/` | Konva editor (canvas, tools, undo/redo) |
| `features/video-trim/` | Video trim logic (segments, frame seeking) |
| `features/output/` | Output handling (copy/save/flatten) |
| `lib/` | Utilities (IPC, shortcut bindings) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setting up a dev environment, and
[BUILD.md](BUILD.md) for signing keys and cutting a release. Please report
security issues per [SECURITY.md](SECURITY.md) rather than opening a public
issue.

## License

[MIT](LICENSE)
