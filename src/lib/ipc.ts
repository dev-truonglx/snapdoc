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
  /** Mode đã chụp ra ảnh này ("region"/"window"/"full"/"all"/"scroll"/"quick"/
   * "file") — Editor dùng để chọn zoom mặc định, xem `AnnotationStage.tsx`. */
  capture_mode: string;
}

// ── History / Library ────────────────────────────────────────────────────────

export interface HistoryItem {
  id: string;
  createdAt: number;
  updatedAt: number;
  captureMode: "region" | "window" | "full" | "all" | "scroll" | "quick";
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
  mediaType?: "image" | "video";
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

/** Nguồn audio ghi kèm khi quay màn hình — chỉ chọn 1, không trộn (xem lý do
 * ở record/mod.rs: ghép audio+video "sống" qua ffmpeg từng gây bug video bị
 * cắt cụt sau vài giây). */
export type AudioSource = "off" | "mic" | "system";

export interface Settings {
  saveDir: string;
  format: string;
  defaultOutput: OutputMode;
  openEditorAfterCapture: boolean;
  timerSeconds: number;
  rememberLastRegion: boolean;
  launchAtLogin: boolean;
  /** Nguồn audio ghi kèm khi quay màn hình — chỉ 1 trong 3, mặc định "off". */
  recordAudioSource: AudioSource;
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
  /** Mở cửa sổ "Cắt video" riêng cho 1 item — cùng khuôn `record-review`
   * (titlebar thật, thu nhỏ/phóng to/đóng). Cửa sổ mới đọc `id` qua query
   * string (`HistoryTrim.tsx`), không qua tham số truyền trực tiếp. */
  openHistoryTrim: (id: string) => invoke<void>("open_history_trim", { id }),
  closeHistoryTrim: () => invoke<void>("close_history_trim"),
  finishQuickCapture: (data: string, width: number, height: number, output: string) =>
    invoke<string | null>("finish_quick_capture", { data, width, height, output }),
  // Quay màn hình — dừng quay/xem trạng thái chủ yếu vẫn qua tray icon (menu
  // bar, xem src-tauri/src/tray.rs); `stopRecording`/`recordingStatus` bên
  // dưới chỉ thêm 1 đường nữa cho popup "đang quay" trên Windows.
  /** Bắt đầu quay toàn màn hình chính NGAY, không qua overlay (dùng cho hotkey). */
  startRecording: () => invoke<void>("start_recording"),
  /** Mở overlay chọn phạm vi quay — dùng chung CaptureMode với nút "Chụp" ("full" | "window" | "region"). */
  startRecordPicker: (mode: "full" | "window" | "region") =>
    invoke<void>("start_record_picker", { mode }),
  // Xem lại bản quay trước khi lưu vào History (record-review window).
  peekPendingRecording: () => invoke<PendingRecording | null>("peek_pending_recording"),
  confirmRecordingSave: () => invoke<void>("confirm_recording_save"),
  confirmRecordingDiscard: () => invoke<void>("confirm_recording_discard"),
  /** Dừng quay — dùng cho popup "đang quay" trên Windows (bấm vào để dừng). */
  stopRecording: () => invoke<string>("stop_recording"),
  /** Thời lượng đã quay (ms), `null` nếu không có phiên quay — popup "đang quay" poll mỗi giây. */
  recordingStatus: () => invoke<number | null>("recording_status"),
  /** Cắt bản quay đang chờ xác nhận (trước khi Lưu) — `ranges` là các đoạn GIỮ LẠI (ms). */
  trimPendingRecording: (ranges: [number, number][]) =>
    invoke<PendingRecording>("trim_pending_recording", { ranges: roundRanges(ranges) }),
  /** Cắt 1 video ĐÃ LƯU trong History — KHÁC `trimPendingRecording` (ghi đè
   * tại chỗ): tạo 1 item MỚI cho bản đã cắt, giữ nguyên item gốc — trả về
   * item MỚI (id khác `id` truyền vào), không phải bản đã update tại chỗ. */
  trimHistoryVideo: (id: string, ranges: [number, number][]) =>
    invoke<HistoryItem>("trim_history_video", { id, ranges: roundRanges(ranges) }),
  /** Trích frame tại các mốc ms cho trước — trả data URL JPEG base64, `null`
   * cho mốc nào trích lỗi. `scaleW` là bề rộng đích (px): filmstrip zoom của
   * `VideoTrimmer` dùng nhỏ (160, nhiều tile), hover-scrub preview dùng lớn
   * hơn hẳn (~480, xem `HOVER_PREVIEW_SCALE_W`) để không bị mờ khi phóng to. */
  generateVideoFrames: (path: string, timestampsMs: number[], scaleW: number) =>
    invoke<(string | null)[]>("generate_video_frames", {
      path,
      timestampsMs: timestampsMs.map(Math.round),
      scaleW,
    }),
};

/** Rust nhận `Vec<(i64, i64)>` — `ranges` tính từ tỉ lệ pixel kéo-thả
 * (`VideoTrimmer.tsx`) luôn ra số thập phân (JS không phân biệt int/float),
 * làm tròn ở biên IPC để tránh lỗi deserialize "expected i64". */
function roundRanges(ranges: [number, number][]): [number, number][] {
  return ranges.map(([s, e]) => [Math.round(s), Math.round(e)]);
}

export interface PendingRecording {
  path: string;
  width: number;
  height: number;
  durationMs: number;
  captureMode: string;
}
