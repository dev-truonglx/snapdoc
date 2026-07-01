import { invoke } from "@tauri-apps/api/core";

export interface Pending {
  base64: string;
  width: number;
  height: number;
  /** DPI scale factor của màn hình nguồn (1.0 = normal, 2.0 = Retina 2×). */
  scale_factor: number;
  output: string;
}

export type CaptureMode = "full" | "window" | "region" | "all" | "scroll";
export type OutputMode = "editor" | "clipboard" | "save" | "save_copy" | "copy_editor";

export interface WindowInfo {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  app: string;
}

export interface Settings {
  saveDir: string;
  format: string;
  defaultOutput: OutputMode;
  openEditorAfterCapture: boolean;
  timerSeconds: number;
  rememberLastRegion: boolean;
  launchAtLogin: boolean;
  shortcuts: Record<string, string>;
}

export interface UpdateInfo {
  available: boolean;
  version: string;
  currentVersion: string;
}

export const ipc = {
  peekPending: () => invoke<Pending | null>("peek_pending"),
  takePending: () => invoke<Pending | null>("take_pending"),
  /** Ghi đè ảnh đang chờ (output="editor") — dùng khi "Chụp nhanh" bàn giao ảnh đã annotate sang Editor. */
  setPendingImage: (data: string, width: number, height: number) =>
    invoke<void>("set_pending_image", { data, width, height }),
  /** macOS: lấy data URL ảnh "Open with" của chính cửa sổ editor này (theo label). */
  takeOpenFile: () => invoke<string | null>("take_open_file"),
  captureNow: (mode: CaptureMode, output: OutputMode) =>
    invoke<void>("capture_now", { mode, output }),
  /** Chụp nhanh: mở overlay trong suốt trên mọi màn hình để chọn vùng + chú thích. */
  startQuick: () => invoke<void>("start_quick"),
  /** Chụp đúng vùng đã chọn (ẩn overlay trước khi chụp) → base64 PNG. */
  captureQuickRegion: (x: number, y: number, w: number, h: number) =>
    invoke<string>("capture_quick_region", { x, y, w, h }),
  captureAllScreens: (output: OutputMode) =>
    invoke<void>("capture_all_screens", { output }),
  finalizeRegion: (x: number, y: number, w: number, h: number) =>
    invoke<void>("finalize_region", { x, y, w, h }),
  finalizeWindow: (id: number) => invoke<void>("finalize_window", { id }),
  finalizeMonitor: () => invoke<void>("finalize_monitor"),
  listWindows: () => invoke<WindowInfo[]>("list_windows"),
  cancelOverlay: () => invoke<void>("cancel_overlay"),
  copyImage: (data: string) => invoke<void>("copy_image", { data }),
  saveImage: (path: string, data: string) => invoke<string>("save_image", { path, data }),
  saveAndCopy: (path: string, data: string) =>
    invoke<string>("save_and_copy", { path, data }),
  openCaptureBar: () => invoke<void>("open_capture_bar"),
  openCaptureBarForNew: () => invoke<void>("open_capture_bar_for_new"),
  openEditor: () => invoke<void>("open_editor"),
  openSettings: () => invoke<void>("open_settings"),
  closeSelf: () => invoke<void>("close_self"),
  hideThumbnail: () => invoke<void>("hide_thumbnail"),
  openFile: () => invoke<string | null>("open_file_dialog"),
  /** Chọn nhiều ảnh cùng lúc (cho tính năng nối ảnh) → mảng data URL theo thứ tự chọn. */
  openFiles: () => invoke<string[]>("open_files_dialog"),
  defaultSaveDir: () => invoke<string>("default_save_dir"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (value: Settings) => invoke<void>("set_settings", { value }),
  checkPermission: () => invoke<boolean>("check_screen_permission"),
  reloadShortcuts: () => invoke<void>("reload_shortcuts"),
  suspendShortcuts: () => invoke<void>("suspend_shortcuts"),
  resumeShortcuts: () => invoke<void>("resume_shortcuts"),
  getLastCaptureMode: () => invoke<[string, string]>("get_last_capture_mode"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  // Update
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
  getPendingUpdate: () => invoke<UpdateInfo | null>("get_pending_update"),
  installUpdate: () => invoke<void>("install_update"),
  // Scroll
  captureScrollSlice: (mx: number, my: number, rx: number, ry: number, rw: number, rh: number) =>
    invoke<string>("capture_scroll_slice", { mx, my, rx, ry, rw, rh }),
  finalizeScrollCapture: (base64: string, width: number, height: number) =>
    invoke<void>("finalize_scroll_capture", { base64, width, height }),
  startScrollSession: () =>
    invoke<void>("start_scroll_session"),
  finalizeScrollStitch: (width: number, instructions: { sliceIndex: number; srcY: number; srcH: number }[]) =>
    invoke<void>("finalize_scroll_stitch", { width, instructions }),
};
