import { invoke } from "@tauri-apps/api/core";

export interface Pending {
  base64: string;
  width: number;
  height: number;
  temp_path: string;
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
  shortcuts: Record<string, string>;
}

export const ipc = {
  peekPending: () => invoke<Pending | null>("peek_pending"),
  takePending: () => invoke<Pending | null>("take_pending"),
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
  openEditor: () => invoke<void>("open_editor"),
  openSettings: () => invoke<void>("open_settings"),
  closeSelf: () => invoke<void>("close_self"),
  defaultSaveDir: () => invoke<string>("default_save_dir"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (value: Settings) => invoke<void>("set_settings", { value }),
  checkPermission: () => invoke<boolean>("check_screen_permission"),
};
