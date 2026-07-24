# SnapDoc — Folder Architecture & Capture UX (macOS-style control bar)

> Companion to the main README. This document: (1) defines the capture flow
> around a **floating control bar at the bottom of the screen**, modeled on
> macOS `Cmd+Shift+5`, and (2) sketches the project's folder architecture.

---

## A. Capture UX — learning from macOS Screenshot (`Cmd+Shift+5`)

### A.1 Lessons from macOS
macOS has **two hotkey tiers**, and this is the core idea worth copying:

| Tier | macOS | Behavior | When users reach for it |
|---|---|---|---|
| **Instant** | `Cmd+Shift+3` (full), `Cmd+Shift+4` (region) | Captures immediately, **no** picker UI | User already knows what they want → fastest path |
| **Control bar** | `Cmd+Shift+5` | Shows a **floating control bar at the bottom of the screen** to pick mode + options before capturing | When the mode / save location / timer needs to change |

→ SnapDoc implements **both tiers**. Direct hotkeys for power users; the
control bar for anyone who needs to choose. This is the key difference from
the original plan (which only had direct hotkeys).

### A.2 What the control bar looks like
Pressing the **master hotkey** (`Ctrl/Cmd+Shift+5`, chosen so macOS users
feel at home) dims the screen slightly and shows a rounded floating bar
**centered at the bottom of the screen**:

```
        ┌─────────────────────────────────────────────────────────────┐
        │  [▢ Full]  [◱ Window]  [⬚ Region]   │   ⚙ Options ▾   │  Capture │   ✕
        └─────────────────────────────────────────────────────────────┘
            ↑ mode switch                ↑ options dropdown   ↑ button ↑ Esc/close
```

**Mode switch:** Full / Window / Region — click to select, the active mode
is highlighted.
- **Full** → click "Capture" (or Enter) to instantly capture the screen
  containing the cursor.
- **Window** → cursor turns into a window picker, hovering highlights a
  window, click to capture it.
- **Region** → crosshair + drag to select an area (live size readout); the
  bar stays floating so options can still be changed.

**⚙ Options dropdown (learned from macOS "Options"):**
- **Save to:** default folder · Clipboard · Save + Copy · *choose another
  folder…* (sticky — remembers the last choice).
- **Open editor after capture:** on/off (this is SnapDoc's addition over
  macOS, which only shows a thumbnail).
- **Timer:** None / 3s / 5s.
- **Remember last selected region** (for Region mode).
- **Show mouse cursor:** on/off.

**"Capture" button** = executes with the currently selected mode + options.
**Esc / ✕** = closes the bar without capturing.

### A.3 Post-capture behavior (learned from macOS's "thumbnail", improved)
macOS shows a **floating thumbnail in the bottom-right corner** for a few
seconds — click it to open markup, ignore it and it auto-saves. SnapDoc does
the same, but configurable:

- If **"Open editor" = ON** → opens the editor directly.
- If **OFF** → shows a **floating thumbnail in the bottom-right corner** +
  a toast. The thumbnail has quick actions:
  `[✎ Edit]  [📋 Copy]  [💾 Save]  [↗ Open folder]`. It auto-hides after
  ~5s and falls back to the default action (per "Save to").
- *Why keep the thumbnail:* it enables a "capture and forget" flow (fast
  path) while still offering a quick way into the editor if you change your
  mind — matching the spirit of macOS's behavior.

### A.4 Impact on hotkeys
| Action | Windows | macOS |
|---|---|---|
| **Open control bar** (master) | `Ctrl+Shift+5` | `Cmd+Shift+5` |
| Instant full screen | `Ctrl+Shift+1` | `Cmd+Shift+1` |
| Instant region | `Ctrl+Shift+2` | `Cmd+Shift+2` |
| Instant window | `Ctrl+Shift+3` | `Cmd+Shift+3` |
| Capture & copy (instant, region) | `Ctrl+Shift+C` | `Cmd+Shift+C` |

→ The control bar is a new must-have. Direct hotkeys are kept. Both call the
same capture engine in Rust (only the calling UI layer differs).

### A.5 Window architecture implications
Since the capture bar + overlay must float above every app and cover the
whole screen, the app uses **several dedicated webview windows** (one route
each), not a single window:

| Window | Characteristics | Frontend route |
|---|---|---|
| **Capture bar** | floating (always-on-top), borderless, transparent, bottom of screen | `/capture-bar` |
| **Overlay** | full-screen per monitor, transparent, controlled click-through, crosshair/highlight | `/overlay` |
| **Editor** | regular window, has a border, resizable | `/editor` |
| **Thumbnail** | small floating popup in the bottom-right corner, auto-hides | `/thumbnail` |
| **Settings** | regular window | `/settings` |
| (Tray/menu bar) | native, not a webview | — (Rust) |

Multi-monitor: the overlay creates **one window per monitor**; the capture
bar appears on the monitor containing the cursor.

---

## B. Folder architecture (Tauri v2 + React/TS + Konva)

```
screenshort-app/
├── ARCHITECTURE.md                  # this document
├── README.md
├── package.json                     # FE deps + scripts (tauri dev/build)
├── vite.config.ts
├── tsconfig.json
├── index.html
│
├── src/                             # ───── FRONTEND (webview UI) ─────
│   ├── main.tsx                     # bootstrap; routes by window label
│   ├── routes/                      # each Tauri window = one route
│   │   ├── capture-bar/             # Cmd+Shift+5-style control bar
│   │   │   ├── CaptureBar.tsx
│   │   │   ├── ModeSwitch.tsx       # Full / Window / Region
│   │   │   ├── OptionsMenu.tsx      # save to / timer / open editor / remember region
│   │   │   └── CaptureButton.tsx
│   │   ├── overlay/                 # region/window selection overlay
│   │   │   ├── Overlay.tsx
│   │   │   ├── RegionSelector.tsx   # drag-select + live size readout
│   │   │   └── WindowPicker.tsx     # highlight the window under the cursor
│   │   ├── editor/                  # annotation editor
│   │   │   ├── Editor.tsx
│   │   │   ├── Toolbar.tsx
│   │   │   └── OutputActions.tsx    # Save / Copy / Save+Copy
│   │   ├── thumbnail/               # post-capture floating thumbnail
│   │   │   └── Thumbnail.tsx
│   │   └── settings/
│   │       ├── Settings.tsx
│   │       ├── GeneralTab.tsx
│   │       └── ShortcutsTab.tsx     # remap + conflict warnings
│   │
│   ├── features/                    # domain logic (separate from UI routes)
│   │   ├── capture/
│   │   │   ├── captureMode.ts       # enum Full|Window|Region
│   │   │   └── useCapture.ts        # calls the Rust command
│   │   ├── annotation/              # ⭐ the heart of the editor
│   │   │   ├── canvas/
│   │   │   │   └── AnnotationStage.tsx   # Konva Stage + Layer
│   │   │   ├── tools/               # one file per tool
│   │   │   │   ├── RectTool.ts
│   │   │   │   ├── EllipseTool.ts
│   │   │   │   ├── TextTool.ts
│   │   │   │   ├── StepNumberTool.ts     # auto-incrementing badge 1,2,3…
│   │   │   │   ├── SelectTool.ts         # move/resize/delete
│   │   │   │   └── CropTool.ts
│   │   │   ├── model.ts             # Annotation type (object-based)
│   │   │   ├── history.ts           # undo/redo stack (≥20)
│   │   │   └── flatten.ts           # merges annotations + image → PNG export
│   │   ├── output/
│   │   │   └── useOutput.ts         # save / copy / save+copy + sticky pref
│   │   └── settings/
│   │       └── useSettings.ts
│   │
│   ├── lib/
│   │   ├── ipc.ts                   # invoke() wrapper → Rust commands
│   │   ├── events.ts               # listen() for events from Rust (hotkey fired…)
│   │   ├── shortcuts.ts            # editor keyboard shortcuts
│   │   └── store.ts                # global state (zustand)
│   ├── components/                 # shared UI (Button, Dropdown, Toast…)
│   ├── styles/
│   └── types/                      # shared FE types (mirroring Rust structs)
│
├── src-tauri/                       # ───── BACKEND (Rust, native) ─────
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json              # window declarations, bundle, permissions
│   ├── icons/
│   ├── capabilities/                # Tauri v2: per-window permissions
│   │   └── default.json
│   └── src/
│       ├── main.rs                  # entry point
│       ├── lib.rs                   # app setup, tray, window + command registration
│       ├── commands.rs              # #[tauri::command] surface exposed to FE
│       ├── capture/                 # ⭐ capture engine (shared by every hotkey)
│       │   ├── mod.rs
│       │   ├── fullscreen.rs
│       │   ├── window.rs            # enumerate + capture windows
│       │   ├── region.rs
│       │   ├── monitor.rs           # multi-monitor, DPI/scale (HiDPI/Retina)
│       │   └── mac_sck.rs           # macOS: pixel grabbing via ScreenCaptureKit
│       ├── hotkey/
│       │   ├── mod.rs               # global-hotkey: master + direct
│       │   └── conflict.rs          # conflict detection on registration
│       ├── windows/                 # webview window creation & management
│       │   ├── mod.rs
│       │   ├── capture_bar.rs       # floating, always-on-top, bottom of screen
│       │   ├── overlay.rs           # one window per monitor
│       │   ├── editor.rs
│       │   └── thumbnail.rs
│       ├── clipboard.rs             # writes images to the clipboard (Win CF_DIB / mac NSPasteboard)
│       ├── storage/
│       │   ├── mod.rs
│       │   ├── save.rs              # file writing, name dedup (_1,_2), Desktop fallback
│       │   └── settings.rs          # settings persistence (JSON)
│       ├── permissions/             # ⚠ macOS pitfalls
│       │   ├── mod.rs
│       │   └── macos.rs             # checks Screen Recording + Accessibility
│       └── tray.rs                  # tray (Windows) / menu bar (macOS)
│
└── .github/
    └── workflows/
        └── build.yml                # CI build: .dmg (signed+notarized) + .msi/.exe
```

### B.1 Layering principles
- **Rust = permissions & native integration:** capture, global hotkeys,
  image clipboard, files, OS permissions, tray, window creation. Rationale:
  this is the part that must touch the OS, and it's Tauri's core strength.
- **Frontend = UX & drawing:** control bar, overlay UI, editor canvas
  (Konva), settings. Annotations are object-based, which fits Konva well
  (each shape is a movable/selectable/undoable node).
- **`commands.rs` + `lib/ipc.ts` are the contract boundary:** all FE↔Rust
  communication goes through here; types in `src/types` must mirror the
  Rust structs.
- **Shared capture engine:** both direct hotkeys and the control bar call
  the same `capture::{fullscreen,window,region}` — no duplicated logic.
- **Pixel grabbing is OS-specific, preferring modern native APIs:**
  - **macOS (≥14.0):** ScreenCaptureKit — `SCScreenshotManager.captureImageInRect`
    for region/screen capture (display-agnostic, multi-monitor, preserves
    Retina) and `SCContentFilter` + `captureImageWithFilter` for windows
    (captures exactly one window even if occluded). Replaces the deprecated
    `CGWindowListCreateImage`. Permission is checked via
    `CGPreflightScreenCaptureAccess`.
  - **Windows:** WGC — Windows.Graphics.Capture (via the xcap `wgc`
    feature), replacing GDI BitBlt.
  - **Linux:** pipewire / X11 (via xcap).
  - **Enumerating** displays & windows (metadata) still uses xcap on every
    OS; only the pixel-grabbing step is split by native API.

### B.2 Build order (suggested sprint plan)
1. **Sprint 0 (highest-risk PoC):** `capture/` + `hotkey/` +
   `permissions/macos.rs` + `clipboard.rs` — prove the native layer works
   on both OSes (the biggest risk in a Tauri+Rust app).
2. **Sprint 1:** control bar + overlay + direct hotkeys → capture to
   file/clipboard (no editor yet).
3. **Sprint 2:** editor + annotation tools + undo/redo + crop.
4. **Sprint 3:** floating thumbnail, settings (remapping + folder), sticky
   output, polish + CI build.
