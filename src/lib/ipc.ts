import { invoke } from "@tauri-apps/api/core";

export interface Pending {
  base64: string;
  width: number;
  height: number;
  /** DPI scale factor của màn hình nguồn (1.0 = normal, 2.0 = Retina 2×). */
  scale_factor: number;
  output: string;
}

export type CaptureMode = "full" | "window" | "region" | "all";
export type OutputMode = "editor" | "clipboard" | "save" | "save_copy";

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
  /** macOS: lấy data URL ảnh "Open with" của chính cửa sổ editor này (theo label). */
  takeOpenFile: () => invoke<string | null>("take_open_file"),
  captureNow: (mode: CaptureMode, output: OutputMode) =>
    invoke<void>("capture_now", { mode, output }),
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
};
