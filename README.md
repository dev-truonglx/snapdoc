# SnapDoc

<p>
  <strong>Language / Ngôn ngữ:</strong> <b>English</b> | <a href="README.vi.md">Tiếng Việt</a>
</p>

Desktop screenshot, screen recording & multimedia annotation app for **Windows + macOS**. Speed-first design: hotkey → capture/record → annotate/trim → save/copy.

> Stack: **Tauri 2** (Rust) + **React 19 + TypeScript + Vite** + **Konva** (canvas editor) + **zustand** (state) + **FFmpeg** (video engine).  
> Native capture: **ScreenCaptureKit** (macOS) & **Windows Graphics Capture (WGC)** (Windows).  
> See [ARCHITECTURE.md](ARCHITECTURE.md) for architecture blueprints and [BUILD.md](BUILD.md) for compilation and release packaging.

---

## ⚡ Core Workflows

### 1️⃣ Instant Screenshot & Quick Capture
```text
Hotkey / Capture Bar → Capture (7 modes) → Thumbnail popup → Pick action (Editor / Copy / Save)
                                               ↓
                                   Editor (15+ annotation tools) → Save / Copy / Flatten
```

### 2️⃣ Screen Recording with Keystrokes & Audio
```text
Hotkey / Capture Bar → Pick Region / Window / Full Screen → 3-2-1 Countdown
                                                                 ↓
      Recording (Active border + Live Keystroke HUD + Tray timer + Floating stop widget)
                                                                 ↓
                  → Review & CapCut-style Video Trimmer → Save / Export GIF / Discard
```

### 3️⃣ Image Annotation & Beautifier
```text
From Capture / Library / Open File / Drag & Drop → Editor (Canvas)
                                                      ↓
      Annotate (Arrows, Steps, Blur/Redact) + Mockup Background (Gradients/Shadows) + Stitch
                                                      ↓
               → Save (.snapdoc non-destructive / PNG) / Copy to Clipboard
```

### 4️⃣ Video Editing & GIF Generation
```text
Video Review / Library / Editor → Video Trimmer
                                      ↓
      Split & Trim Segments (Q / W / Cmd+B) + Overlays (Text, Arrows, Blur) + Mute Audio
                                      ↓
           → Save (Overwrite / Save As) / Export Frame / Export Animated GIF
```

### 5️⃣ Library & History Management
```text
Open Library → Filter by Media (Image/Video), Mode, Date Range → Grid/List View
                                      ↓
       Preview & Metadata → Rename / Copy / Reopen in Editor / Trim / Trash & Restore
```

---

## 🚀 Complete Feature & Tool Catalog

### 📸 1. Screenshot Capture — 7 Modes
| Mode | Description | Default Shortcut (macOS / Windows) |
|---|---|---|
| **Region Capture** | Drag to select an area with pixel-precise crosshair, magnifier & dimensions | `Cmd+Shift+2` / `Ctrl+Shift+2` |
| **Window Capture** | Hover to intelligently detect and highlight application windows | `Cmd+Shift+3` / `Ctrl+Shift+3` |
| **Full Screen** | Instantly capture the active monitor under the cursor | `Cmd+Shift+1` / `Ctrl+Shift+1` |
| **All Monitors** | Seamlessly stitch all connected displays into one panoramic image | `Cmd+Shift+4` / `Ctrl+Shift+4` |
| **Capture & Copy** | Instant region capture directly copied to clipboard (fastest path) | `Cmd+Shift+C` / `Ctrl+Shift+C` |
| **Scrolling Capture** | Automatically/manually scroll long documents & web pages into a single image | `Cmd+Shift+6` / `Ctrl+Shift+6` |
| **Quick Capture** | Interactive freeze-frame overlay: draw & annotate directly on screen, then save/copy | `Cmd+Shift+Q` / `Ctrl+Shift+Q` |

- **Delay Timer:** Configure a countdown timer (`0s`, `5s`, `10s`) before capture with a visual countdown overlay.
- **After-Capture Actions:**
  - **Open in Editor:** Immediate launch into the annotation canvas.
  - **Copy to Clipboard:** Copy image data for instant pasting into chat/docs.
  - **Save to Disk:** Save directly to the configured storage directory.
  - **Save + Copy:** Dual action — persist to file and copy to clipboard.
  - **Copy + Editor:** Copy to clipboard first, then open editor.
- **Floating Thumbnail Popup:** Appears at the bottom-right corner immediately after capture with quick-action buttons (Open Editor, Copy, Save, Delete) and auto-dismiss countdown.

---

### 🎚️ 2. Floating Capture Bar
Modeled after macOS `Cmd+Shift+5`, this floating dock centers at the bottom of the active display:
- **Trigger:** `Cmd+Shift+5` (macOS) / `Ctrl+Shift+5` (Windows) or via System Tray menu.
- **Dual-Mode Switcher:**
  - **Photo Group:** Full Screen, Window, Region, All Monitors, Scrolling Capture.
  - **Video Group:** Full Screen, Window, Region.
- **Quick Options Popover:**
  - Default output destination selector (Editor / Clipboard / Save / Save + Copy / Copy + Editor).
  - Audio recording input selector (Off / Microphone / System Audio / Both).
  - Live Keystroke visualizer toggle.
  - Delay timer (None / 5s / 10s).
- **One-click Capture / Record & Close (`Esc`).**

---

### 🎥 3. Screen Recording & Real-Time Keystrokes
- **Recording Targets:** Custom Region, Specific Application Window, or Entire Display.
- **High Performance:** Smooth 30fps screen capture with hardware-accelerated encoding via FFmpeg.
- **Multi-Source Audio Capture:**
  - **Off:** Video only.
  - **Microphone:** Voice commentary via system microphone.
  - **System Audio:** High-fidelity internal audio (WASAPI Loopback on Windows / ScreenCaptureKit audio on macOS).
  - **Both:** Simultaneous recording of system audio + mic voice track.
- **Live Keystroke Visualizer (Keycaster HUD Overlay):**
  - Displays real-time keypresses and shortcuts on-screen during recording.
  - Apple-style key badges (`⌘ Cmd`, `⌥ Opt`, `⌃ Ctrl`, `⇧ Shift`, `⊞ Win`, `⎋ Esc`, `⏎ Enter`, `␣ Space`, etc.).
  - macOS Accessibility API integration.
- **Visual Recording Helpers:**
  - Flashing boundary guide around the active recording zone (`record-border`).
  - Floating stop/pause controls widget (`record-stop-control`).
  - System tray icon with live elapsed time indicator.
  - Pre-recording `3.. 2.. 1..` countdown overlay.
  - Self-exclusion: Hides SnapDoc UI windows from the recorded video stream (`recordSelf` toggle).
- **Mandatory Review:** Stops recording and opens the video directly in the editor for review and trimming (never saves unreviewed files).

---

### ✂️ 4. CapCut-Style Video Editor & Trimmer
Integrated directly into the unified Editor and Review window:
- **Non-Destructive Multi-Segment Trimming:**
  - Split segment at playhead: `Ctrl/Cmd+B`
  - Delete selected segment: `Delete` / `Backspace`
  - Trim head to playhead: `Q`
  - Trim tail to playhead: `W`
  - Undo / Redo: `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`
  - Timeline Filmstrip: Visual thumbnail track with frame-by-frame scrubbing.
  - Frame seeking: Step forward / backward by frame (`←` / `→`), play/pause (`Space`).
- **Video Overlays & Annotations:**
  - Draw annotations that appear over specific time intervals of the video:
    - **Rectangle Overlay:** Highlight areas on the video frame.
    - **Blur / Blackout Overlay:** Redact sensitive information (passwords, tokens, faces) with smooth blur or absolute blackout.
    - **Text Overlay:** Styled text labels with font size, color, and semi-transparent badges.
    - **Arrow Overlay:** Pointing arrows with customizable stroke width and color.
  - **Overlay Timeline Track:** Interactive timeline bars to adjust start time, end time, and duration of each overlay element.
- **Audio Control:** One-click toggle to remove/mute audio track from the final video.
- **Export & Output Options:**
  - **Save:** Overwrite the original recording.
  - **Save As:** Export as a new video file.
  - **Export Frame:** Grab the current paused frame as a high-resolution PNG image.
  - **Export to Animated GIF (`GifExportModal`):**
    - Scope: Selected segment, Entire video, or Custom in/out range.
    - Frame rate: `10`, `15`, `24`, or `30` FPS.
    - Resolutions: Original, 1080p, 720p, 480p, and custom dimensions.
    - Speed Multipliers: `0.5x`, `1.0x`, `1.5x`, `2.0x`.
    - Infinite looping option.
    - Real-time looping preview player with timeline scrubber.
    - Asynchronous export with progress bar and cancellation.

---

### 🎨 5. Image Annotation & Studio (Konva Canvas)
A professional annotation studio built for documentation, bug reporting, and tutorials:

#### 🛠️ Annotation Tools
1. **Select (`V`):** Move, resize, transform, and delete canvas objects.
2. **Rectangle (`R`):** Box annotation with custom stroke colors and widths.
3. **Numbered Rectangle:** Bounding rectangle with an auto-incrementing numbered badge at the corner.
4. **Ellipse (`O`):** Circle / oval callouts.
5. **Arrow (`T`):** Directional arrows with clean pointer heads.
6. **Numbered Arrow:** Arrow with an auto-incrementing numbered circle at the tail.
7. **Line:** Clean straight lines.
8. **Step Counter (`N`):** Numbered badge counters (`1`, `2`, `3`...) with auto-incrementing sequence for step-by-step guides.
9. **Text (`C`):** Multi-line text boxes with adjustable font size (8–200px) and text color.
10. **Highlighter:** Semi-transparent fluorescent marker (opacity 0.35) for emphasizing text and UI elements.
11. **Blur / Pixelate / Redact:** Privacy masking with 3 distinct modes:
    - **Gaussian Blur:** Soft optical blurring.
    - **Pixelate / Mosaic:** Tiled pixel blocks.
    - **Solid Blackout:** Opaque redact cover for maximum privacy.
    - Adjustable blur radius / tile intensity slider.
12. **Crop:** Interactive marquee tool to crop and resize the canvas image.
13. **Mockup / Beautifier Background:**
    - Social-ready aesthetic frame backdrops.
    - Presets: Multi-color gradient meshes, twilight, sunrise, modern tech, or solid colors.
    - Custom gradient rotation angle.
    - Outer padding slider, corner radius rounding, and realistic drop shadow (`None`, `Subtle`, `Medium`, `Strong`).
14. **Image Insertion:** Paste images directly from clipboard (`Cmd/Ctrl+V`) or drag-and-drop image files onto the canvas.
15. **Image Stitcher (`StitchDialog`):** Merge and concatenate multiple images vertically or horizontally into a single document.

#### ⚙️ Canvas Capabilities & Output
- **Undo / Redo:** Full history stack (`Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`).
- **Zoom & Navigation:** Smart zoom (100% actual pixels, auto-fit to screen, zoom in/out with mouse wheel or buttons).
- **Save Modes:**
  - **Save:** Overwrite the original capture.
  - **Save As:** Export as a new file.
  - **Copy:** Copy rendered image to clipboard.
  - **Save + Copy:** Save to disk and copy to clipboard in a single stroke.
  - **Flatten:** Burn all annotation layers permanently into the base image.
- **Editable `.snapdoc` File Format:**
  - Custom container format (ZIP) storing clean base pixels (`base.png`), vector annotations (`doc.json`), autosave draft (`draft.json`), and preview (`preview.png`).
  - Reopen past screenshots at any time to adjust, move, recolor, or delete annotations non-destructively!
  - Auto-save and crash recovery with `ResumeBanner`.

---

### ⚡ 6. Recent History Strip (Integrated in Editor)
- Located horizontally at the bottom of the Editor window.
- Displays thumbnail previews of recent captures (both screenshots and recordings) with duration/dimension badges.
- One-click switching between recent media items without leaving the editor.
- Right-click context menu: Quick Copy, Open, Delete.

---

### 📚 7. Library (History Management)
- **Automatic Storage:** Every captured screenshot and video is cataloged in an SQLite database.
- **Dual Views:** Switch between responsive **Grid View** and compact **List View**.
- **Comprehensive Filters:**
  - **Media Type:** All, Images only, Videos only.
  - **Capture Mode:** All, Region, Window, Full screen, All monitors, Scrolling capture, Quick capture.
  - **Date Range:** Date picker with `From` and `To` boundaries.
- **Inspector Preview Panel:**
  - Built-in high-res image viewer and HTML5 video player with seek controls.
  - Detailed metadata: Dimensions, file size, duration, capture mode, created date, file path.
  - Action buttons: Inline rename, Copy to clipboard, Open containing folder, Reopen in Editor (with full layer history), Trim video.
- **Trash & Soft Delete:**
  - Move unwanted items to Trash.
  - View Trash items with one-click **Restore** or **Delete Permanently**.
  - **Empty Trash** to clean up storage safely.

---

### ⚙️ 8. Settings & Customization
- **Save Location:** Choose custom default save directory with native folder picker.
- **Default Capture Behavior:** Configure default action (Open Editor, Copy to Clipboard, Save to File, Save + Copy, Copy + Editor).
- **Screen Recording Options:** Audio input selection (Off / Mic / System / Both), exclude SnapDoc windows toggle, live keystroke HUD toggle.
- **Internationalization (i18n):** Real-time language switching between **English** and **Tiếng Việt**.
- **Startup:** Launch at system login toggle (via native autostart).
- **Global Keybinding Manager:** Remap every global hotkey with conflict detection warnings and live shortcut recorder.
- **Permission Diagnostics:** Visual status checks for macOS Screen Recording & Accessibility permissions.
- **In-App Auto-Updater:**
  - Automatic background check on launch.
  - Silent download and installation.
  - Manual "Check for Updates" button with version badges and "Restart Now" banner.

---

### 🖥️ 9. System Integration & Multi-Monitor
- **Cross-Platform Parity:** Optimized for macOS (ScreenCaptureKit) and Windows (Windows Graphics Capture & WASAPI).
- **Multi-Monitor Awareness:** Every window (Capture Bar, Editor, Library, Settings, Overlays) automatically spawns on the monitor containing the user's cursor.
- **System Tray Menu:** Complete access to all capture modes, recording, library, settings, update checks, and active recording timer.

---

## ⌨️ Keyboard Shortcuts Cheatsheet

*(All global hotkeys can be customized in Settings → Global Shortcuts)*

### 🎯 Global Capture & Recording
| Action | macOS | Windows |
|---|---|---|
| **Open Capture Bar** | `Cmd+Shift+5` | `Ctrl+Shift+5` |
| **Region Capture** | `Cmd+Shift+2` | `Ctrl+Shift+2` |
| **Window Capture** | `Cmd+Shift+3` | `Ctrl+Shift+3` |
| **Full Screen Capture** | `Cmd+Shift+1` | `Ctrl+Shift+1` |
| **All Monitors Capture** | `Cmd+Shift+4` | `Ctrl+Shift+4` |
| **Capture & Copy** (instant) | `Cmd+Shift+C` | `Ctrl+Shift+C` |
| **Scrolling Capture** | `Cmd+Shift+6` | `Ctrl+Shift+6` |
| **Quick Capture & Draw** | `Cmd+Shift+Q` | `Ctrl+Shift+Q` |
| **Start Screen Recording** | `Cmd+Shift+7` | `Ctrl+Shift+7` |

### 🎨 In the Image Editor
| Key | Action |
|---|---|
| `V` | Select / Move / Transform tool |
| `R` | Rectangle tool |
| `O` | Ellipse tool |
| `T` | Arrow tool |
| `N` | Step counter tool |
| `C` | Text tool |
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Delete` / `Backspace` | Delete selected annotation |
| `Cmd/Ctrl + S` | Save (overwrites original / `.snapdoc`) |
| `Cmd/Ctrl + Shift + S` | Save + Copy to clipboard |
| `Cmd/Ctrl + C` | Copy image to clipboard |
| `Cmd/Ctrl + V` | Paste image from clipboard |
| `Cmd/Ctrl + O` | Open image file from disk |
| `Cmd/Ctrl + N` | New blank canvas |

### ✂️ In Video Trimmer & Review
| Key | Action |
|---|---|
| `Space` | Play / Pause playback |
| `←` / `→` | Step backward / forward by frame |
| `Ctrl/Cmd + B` | Split segment at playhead |
| `Q` | Trim start (head) to playhead |
| `W` | Trim end (tail) to playhead |
| `Delete` / `Backspace` | Delete selected segment |
| `Ctrl/Cmd + Z` | Undo trim action |
| `Ctrl/Cmd + Shift + Z` | Redo trim action |

---

## 🏗️ Project Structure

```text
snapdoc/
├── src-tauri/                 # Backend (Rust + Tauri 2)
│   └── src/
│       ├── capture/           # Screenshot engines (ScreenCaptureKit, WGC, xcap, freeze)
│       ├── record/            # Screen recording, WASAPI/SCK audio, FFmpeg encoder, keystrokes
│       ├── history/           # SQLite database, asset caching, thumbnails
│       ├── hotkey/            # Global shortcut registration & event loop
│       ├── windows/           # Multi-monitor window lifecycle management
│       ├── storage/           # Settings & configuration persistence
│       ├── snapdoc_file.rs    # .snapdoc container format (ZIP, base, annotations, draft)
│       ├── tray.rs            # Native system tray menu & timer indicator
│       └── update.rs          # Background auto-update check & silent install
├── src/                       # Frontend (React 19 + TypeScript + Vite)
│   ├── features/
│   │   ├── annotation/        # Konva canvas stage, tools, .snapdoc session management, undo/redo
│   │   ├── video-trim/        # VideoTrimmer, video overlays, timeline tracks, GIF export modal
│   │   └── output/            # Export handlers (clipboard, file system, save prompts)
│   ├── routes/                # Multi-window webview routes
│   │   ├── capture-bar/       # Floating capture control bar & options popover
│   │   ├── editor/            # Unified image & video annotation studio + recent history strip
│   │   ├── history/           # SQLite Library window (Grid/List, filters, preview panel, trash)
│   │   ├── overlay/           # Region & window selection crosshairs & magnifier
│   │   ├── quick-capture/     # Instant freeze-frame draw overlay
│   │   ├── record-border/     # Active recording border outline
│   │   ├── record-keystroke/  # Real-time on-screen keystroke visualizer HUD
│   │   ├── record-stop-control/# Floating stop & pause recording widget
│   │   ├── recording-indicator/# Tray recording status window
│   │   ├── scroll-control/    # Scrolling capture control UI
│   │   ├── thumbnail/         # Bottom-right quick action thumbnail popup
│   │   └── settings/          # Configuration dialog (shortcuts, audio, i18n, updater)
│   ├── locales/               # English & Tiếng Việt translations (i18next)
│   └── lib/                   # Tauri IPC wrappers & event bridge
```

---

## 💻 Requirements & Development

- **Node.js** ≥ 20 (Node 22 recommended)
- **Rust** ≥ 1.80 (Rust 1.96+ recommended)
- **macOS:** Grant **Screen Recording** and **Accessibility** permissions (under System Settings → Privacy & Security) to the app / terminal.

### Running in Development
```bash
npm install
npm run app:dev      # Starts Vite dev server + compiles Rust backend
```

> **macOS Code Signing:** To preserve Screen Recording permissions across builds without re-granting on every compile:
> ```bash
> npm run dev:mac      # Builds a debug .app, signs it with a stable self-signed identity, and launches
> ```

### Building Production Bundles
```bash
npm run build        # TypeScript type-check + Vite production build
npm run app:build    # Compiles full native bundle (.dmg for macOS, .msi/.exe for Windows)
```

See [BUILD.md](BUILD.md) for cross-compiling Windows packages via Docker, code signing certificates, and release workflows.

---

## 📄 License

[MIT](LICENSE)
