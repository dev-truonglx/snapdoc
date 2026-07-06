import { invoke } from "@tauri-apps/api/core";

export interface Pending {
  base64: string;
  width: number;
  height: number;
  /** DPI scale factor của màn hình nguồn (1.0 = normal, 2.0 = Retina 2×). */
  scale_factor: number;
  output: string;
  /** Id bản ghi History tương ứng (nếu đã ingest) — dùng để Save ghi đè tại chỗ. */
  history_id: string | null;
}

// ── History / Library ────────────────────────────────────────────────────────

export interface HistoryItem {
  id: string;
  createdAt: number;
  updatedAt: number;
  captureMode: "region" | "window" | "monitor" | "all" | "scroll" | "quick";
  mediaType: "image" | "video" | "gif";
  width: number;
  height: number;
  scaleFactor: number;
  durationMs: number | null;
  assetPath: string;
  thumbPath: string;
  fileSize: number | null;
  sourceApp: string | null;
  title: string | null;
  isEdited: boolean;
  deletedAt: number | null;
}

export interface HistoryFilter {
  from?: number;
  to?: number;
  captureMode?: string;
  search?: string;
  trashOnly?: boolean;
  limit: number;
  offset: number;
}

export interface HistoryPage {
  items: HistoryItem[];
  total: number;
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
  getHotkeyWarning: () => invoke<string | null>("get_hotkey_warning"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  // Update
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
  getPendingUpdate: () => invoke<UpdateInfo | null>("get_pending_update"),
  getUpdateReady: () => invoke<boolean>("get_update_ready"),
  installUpdate: () => invoke<void>("install_update"),
  restartApp: () => invoke<void>("restart_app"),
  // Scroll
  captureScrollSlice: (mx: number, my: number, rx: number, ry: number, rw: number, rh: number) =>
    invoke<string>("capture_scroll_slice", { mx, my, rx, ry, rw, rh }),
  finalizeScrollCapture: (base64: string, width: number, height: number) =>
    invoke<void>("finalize_scroll_capture", { base64, width, height }),
  startScrollSession: () =>
    invoke<void>("start_scroll_session"),
  finalizeScrollStitch: (width: number, instructions: { sliceIndex: number; srcY: number; srcH: number }[]) =>
    invoke<void>("finalize_scroll_stitch", { width, instructions }),
  // History / Library
  listHistory: (filter: HistoryFilter) => invoke<HistoryPage>("list_history", { filter }),
  getHistoryItem: (id: string) => invoke<HistoryItem>("get_history_item", { id }),
  deleteHistoryItem: (id: string) => invoke<void>("delete_history_item", { id }),
  restoreHistoryItem: (id: string) => invoke<void>("restore_history_item", { id }),
  permanentlyDeleteHistoryItem: (id: string) => invoke<void>("permanently_delete_history_item", { id }),
  emptyTrash: () => invoke<number>("empty_trash"),
  renameHistoryItem: (id: string, title: string) => invoke<void>("rename_history_item", { id, title }),
  openHistoryItemInEditor: (id: string) => invoke<void>("open_history_item_in_editor", { id }),
  updateHistoryAsset: (id: string, data: string) => invoke<HistoryItem>("update_history_asset", { id, data }),
  copyHistoryItem: (id: string) => invoke<void>("copy_history_item", { id }),
  revealHistoryItem: (id: string) => invoke<void>("reveal_history_item", { id }),
  openHistory: () => invoke<void>("open_history"),
  finishQuickCapture: (data: string, width: number, height: number, output: string) =>
    invoke<string | null>("finish_quick_capture", { data, width, height, output }),
  // Quay màn hình — dừng quay/xem trạng thái giờ qua tray icon (menu bar),
  // không qua IPC từ JS nữa (xem src-tauri/src/tray.rs).
  /** Bắt đầu quay toàn màn hình chính NGAY, không qua overlay (dùng cho hotkey). */
  startRecording: () => invoke<void>("start_recording"),
  /** Mở overlay chọn phạm vi quay — dùng chung CaptureMode với nút "Chụp" ("full" | "window" | "region"). */
  startRecordPicker: (mode: "full" | "window" | "region") =>
    invoke<void>("start_record_picker", { mode }),
};
