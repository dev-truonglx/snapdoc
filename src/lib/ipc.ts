import { invoke } from "@tauri-apps/api/core";
import type { VideoOverlayItem } from "../features/video-trim/types";

/** Video đang chờ mở trong Editor — đã CÓ SẴN trong History (`historyId`
 * luôn là id thật): mở từ Library hoặc vừa quay xong (ingest ngay lập tức,
 * xem `record::stop_recording_impl`) — không còn khái niệm "video chưa lưu". */
export interface PendingVideo {
  path: string;
  width: number;
  height: number;
  durationMs: number;
  historyId: string;
}

export interface Pending {
  /** Pixel NỀN (chưa ghép annotation) — base64 trần, không prefix data URL. */
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
  /** Lớp annotation đi kèm (`doc.json` hiệu lực trong container `.snapdoc`,
   * tức `draft.json` nếu có) — Editor dựng lại đúng trạng thái đang sửa. `null`
   * cho ảnh vừa chụp (chưa có annotation) và item PNG thế hệ cũ. */
  docJson?: string | null;
  /** `true` khi `docJson` là BẢN NHÁP chưa lưu — Editor phải đánh dấu tài liệu
   * là chưa lưu (nếu để clean thì badge tắt và autosave ngừng ghi) và hỏi user
   * muốn tiếp tục hay bỏ. */
  docIsDraft?: boolean;
  /** Đường dẫn file `.snapdoc` nguồn — có giá trị → Save ghi thẳng lại file đó. */
  filePath?: string | null;
}

/** Lớp annotation kèm cờ "là bản nháp chưa lưu". */
export interface DocLayer {
  json: string;
  isDraft: boolean;
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
  /** Đường dẫn bản Save/Save As gần nhất ra thư mục tuỳ chọn — `null` nếu
   * chưa từng export ra ngoài (khi đó "Xem file trong Thư mục" mở `assetPath`
   * — file gốc trong thư mục dữ liệu nội bộ). Xem `setHistoryExportedPath`. */
  exportedPath: string | null;
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

export interface GifExportOptions {
  startMs: number;
  durationMs: number;
  fps: number;
  maxWidth?: number | null;
  speed: number;
  loopCount: number; // 0 = loop vô hạn, -1 = phát 1 lần
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

/** Metadata 1 cửa sổ cho dialog "Chọn cửa sổ" dạng lưới (`WindowPickerDialog`) —
 * KHÔNG kèm ảnh (trả về ngay để vẽ khung lưới trước), không có toạ độ overlay
 * vì đây là dialog độc lập, không vẽ đè màn hình thật. Ảnh thumbnail lấy sau
 * qua `captureWindowThumbsStream` + lắng nghe event `"window-thumb-ready"`. */
export interface WindowMetaInfo {
  id: number;
  title: string;
  app: string;
  width: number;
  height: number;
}

/** Payload event `"window-thumb-ready"` — bắn 1 lần cho mỗi cửa sổ ngay khi
 * chụp xong (thứ tự hoàn thành thực tế, không phải thứ tự trong danh sách).
 * `thumb` là PNG base64 đã thu nhỏ (KHÔNG có prefix `data:...`), `null` nếu
 * chụp lỗi (vd cửa sổ vừa đóng giữa chừng). */
export type WindowThumbReady = [id: number, thumb: string | null];

/** Nguồn audio ghi kèm khi quay màn hình: Tắt, Microphone, Âm thanh hệ thống hoặc Cả hai. */
export type AudioSource = "off" | "mic" | "system" | "both";

export interface Settings {
  saveDir: string;
  format: string;
  defaultOutput: OutputMode;
  openEditorAfterCapture: boolean;
  timerSeconds: number;
  rememberLastRegion: boolean;
  launchAtLogin: boolean;
  /** Nguồn audio ghi kèm khi quay màn hình — mặc định "off". */
  recordAudioSource: AudioSource;
  /** Ghi lại cả giao diện SnapDoc (overlay, toolbar) khi quay video — mặc định false. */
  recordSelf?: boolean;
  /** Hiển thị phím bấm trên màn hình khi đang quay video — mặc định false. */
  recordShowKeystrokes?: boolean;
  shortcuts: Record<string, string>;
  /** Thư mục lần cuối user chọn qua "Save As…" ở editor (ảnh) — dùng làm mặc
   * định cho lần Save As kế tiếp, xem `useOutput.saveAsToFile`. */
  lastImageSaveAsDir?: string;
  /** Thư mục lần cuối user chọn qua dropdown "Chọn nơi lưu…" của nút "Lưu
   * thành video mới" ở VideoTrimmer — dùng làm mặc định cho lần kế tiếp,
   * xem `useOutput.promptSaveVideoPath` + `Editor.doSaveAsVideo`. */
  lastVideoSaveAsDir?: string;
  /** Thư mục lần cuối user chọn qua "Lưu file (.gif)" ở GifExportModal — dùng làm
   * mặc định cho lần kế tiếp. */
  lastGifSaveAsDir?: string;
  /** Ngôn ngữ giao diện ("vi"/"en") — đồng bộ với i18next ở webview VÀ ghi

   * xuống settings.json để tray menu (native, Rust-side) đọc được, xem
   * `Settings.tsx` language switcher + `tray::current_lang`. */
  language?: string;
}

/** Kết quả mở file từ dialog. Không chỉ là data URL vì `.snapdoc` mang thêm lớp
 * annotation và đường dẫn gốc (Save ghi thẳng lại file đó). */
export interface OpenedFile {
  /** Data URL của pixel NỀN (với ảnh thường: chính nội dung file). */
  dataUrl: string;
  /** Lớp annotation — chỉ có với `.snapdoc`. */
  docJson: string | null;
  /** Đường dẫn file — chỉ có với `.snapdoc` (tài liệu file-backed). */
  filePath: string | null;
}

export interface UpdateInfo {
  available: boolean;
  version: string;
  currentVersion: string;
}

export const ipc = {
  /** Lấy ảnh "đóng băng màn hình" (JPEG base64 trần) cho overlay `idx` —
   * frontend dùng làm background tĩnh khi kéo chọn vùng, tránh tương tác
   * nhầm với app đang chạy phía sau (như Snagit/Lightshot). */
  getFrozenScreen: (idx: number) => invoke<string | null>("get_frozen_screen", { idx }),
  /** Báo cho Rust biết overlay `idx` (phiên `gen`) đã paint xong ảnh đóng
   * băng — Rust chờ tín hiệu này (tất cả overlay) rồi mới show() đồng loạt,
   * tránh nhịp trống/nháy khi show() rồi mới paint sau (xem `useFrozenScreen`). */
  notifyOverlayReady: (idx: number, gen: number) => invoke<void>("notify_overlay_ready", { idx, gen }),
  peekPending: () => invoke<Pending | null>("peek_pending"),
  takePending: () => invoke<Pending | null>("take_pending"),
  peekPendingVideo: () => invoke<PendingVideo | null>("peek_pending_video"),
  takePendingVideo: () => invoke<PendingVideo | null>("take_pending_video"),
  /** Ghi đè ảnh đang chờ (output="editor") — dùng khi "Chụp nhanh" bàn giao sang Editor.
   * `docJson`: lớp annotation serialize (DocPayload JSON) — khi có, Editor dựng lại
   * annotation objects để user chỉnh tiếp; `null` = ảnh sạch không có annotation.
   * `scaleFactor`: DPI scale factor của màn hình nguồn (1.0 = normal, 2.0 = Retina 2×). */
  setPendingImage: (data: string, width: number, height: number, docJson?: string | null, scaleFactor?: number) =>
    invoke<void>("set_pending_image", { data, width, height, docJson: docJson ?? null, scaleFactor: scaleFactor ?? 1.0 }),
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
  /** Huỷ phiên đếm ngược "hẹn giờ chụp" đang chạy (nếu có) — xem
   * `flow::wait_capture_delay`/`flow::cancel_capture_countdown`. */
  cancelCaptureCountdown: () => invoke<void>("cancel_capture_countdown"),
  finalizeRegion: (x: number, y: number, w: number, h: number) =>
    invoke<void>("finalize_region", { x, y, w, h }),
  finalizeWindow: (id: number) => invoke<void>("finalize_window", { id }),
  finalizeMonitor: () => invoke<void>("finalize_monitor"),
  listWindows: () => invoke<WindowInfo[]>("list_windows"),
  listWindowMetas: () => invoke<WindowMetaInfo[]>("list_window_metas"),
  captureWindowThumbsStream: (ids: number[]) => invoke<void>("capture_window_thumbs_stream", { ids }),
  cancelOverlay: () => invoke<void>("cancel_overlay"),
  // Chụp nhanh "Mở trong Editor": giữ SnapDoc frontmost (không trả focus về
  // app cũ). Gọi TRƯỚC openEditor. Xem `flow::keep_capture_focus`.
  keepCaptureFocus: () => invoke<void>("keep_capture_focus"),
  copyImage: (data: string) => invoke<void>("copy_image", { data }),
  saveImage: (path: string, data: string) => invoke<string>("save_image", { path, data }),
  saveAndCopy: (path: string, data: string) =>
    invoke<string>("save_and_copy", { path, data }),
  openCaptureBar: () => invoke<void>("open_capture_bar"),
  openCaptureBarForNew: () => invoke<void>("open_capture_bar_for_new"),
  toggleCaptureBarPopover: (anchor: { x: number; y: number; width: number; height: number }) =>
    invoke<void>("toggle_capture_bar_popover", {
      anchorX: anchor.x,
      anchorY: anchor.y,
      anchorW: anchor.width,
      anchorH: anchor.height,
    }),
  hideCaptureBarPopover: () => invoke<void>("hide_capture_bar_popover"),
  /** @deprecated Không còn dùng do popover đã tách thành cửa sổ riêng */
  resizeCaptureBar: (height: number) => invoke<void>("resize_capture_bar", { height }),
  openEditor: () => invoke<void>("open_editor"),
  openSettings: () => invoke<void>("open_settings"),
  closeSelf: () => invoke<void>("close_self"),
  /** Báo Rust cửa sổ editor này đang có / không còn thay đổi chưa lưu. Rust
   * dùng để đặt title cửa sổ VÀ để biết có phải hiện lại editor sau những
   * nhánh chụp không tự mở editor (xem `windows::show_editor_if_hidden_dirty`). */
  setEditorDirty: (dirty: boolean) => invoke<void>("set_editor_dirty", { dirty }),
  hideThumbnail: () => invoke<void>("hide_thumbnail"),
  openFile: () => invoke<OpenedFile | null>("open_file_dialog"),
  /** Ghi lại một file `.snapdoc` trên đĩa — Save cho tài liệu file-backed (mở
   * qua "Open with"/Cmd+O). `base` chỉ truyền khi ảnh nền thật sự đổi. */
  saveSnapdocFile: (path: string, docJson: string, preview: string, base?: string) =>
    invoke<void>("save_snapdoc_file", { path, docJson, preview, base }),
  /** Chọn nhiều ảnh cùng lúc (cho tính năng nối ảnh) → mảng data URL theo thứ tự chọn. */
  openFiles: () => invoke<string[]>("open_files_dialog"),
  defaultSaveDir: () => invoke<string>("default_save_dir"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (value: Settings) => invoke<void>("set_settings", { value }),
  checkPermission: () => invoke<boolean>("check_screen_permission"),
  checkAccessibilityPermission: () => invoke<boolean>("check_accessibility_permission"),
  requestAccessibilityPermission: () => invoke<boolean>("request_accessibility_permission"),
  reloadShortcuts: () => invoke<void>("reload_shortcuts"),
  suspendShortcuts: () => invoke<void>("suspend_shortcuts"),
  resumeShortcuts: () => invoke<void>("resume_shortcuts"),
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
    invoke<{ sliceIndex: number; base64: string }>("capture_scroll_slice", { mx, my, rx, ry, rw, rh }),
  commitScrollSlice: (sliceIndex: number) =>
    invoke<void>("commit_scroll_slice", { sliceIndex }),
  finalizeScrollCapture: (base64: string, width: number, height: number, mx?: number, my?: number) =>
    invoke<void>("finalize_scroll_capture", { base64, width, height, mx, my }),
  startScrollSession: () =>
    invoke<void>("start_scroll_session"),
  finalizeScrollStitch: (width: number, instructions: { sliceIndex: number; srcY: number; srcH: number }[], mx?: number, my?: number) =>
    invoke<void>("finalize_scroll_stitch", { width, instructions, mx, my }),
  // History / Library
  listHistory: (filter: HistoryFilter) => invoke<HistoryPage>("list_history", { filter }),
  getHistoryItem: (id: string) => invoke<HistoryItem>("get_history_item", { id }),
  deleteHistoryItem: (id: string) => invoke<void>("delete_history_item", { id }),
  restoreHistoryItem: (id: string) => invoke<void>("restore_history_item", { id }),
  permanentlyDeleteHistoryItem: (id: string) => invoke<void>("permanently_delete_history_item", { id }),
  emptyTrash: () => invoke<number>("empty_trash"),
  renameHistoryItem: (id: string, title: string) => invoke<void>("rename_history_item", { id, title }),
  openHistoryItemInEditor: (id: string) => invoke<void>("open_history_item_in_editor", { id }),
  /** Đọc raw bytes ảnh gốc (không base64) — dùng để đổi ảnh tại chỗ trong
   * Editor (xem `HistoryStrip.tsx`), tránh chi phí base64+JSON của
   * `openHistoryItemInEditor`. */
  getHistoryAssetBytes: (id: string) => invoke<ArrayBuffer>("get_history_asset_bytes", { id }),
  /** Bản ĐÃ ghép annotation của một item ảnh (`preview.png` trong container
   * `.snapdoc`) — raw bytes. Cửa sổ History dùng để render `<img>` qua Blob:
   * `.snapdoc` là ZIP nên `convertFileSrc(assetPath)` không render được. */
  getHistoryPreviewBytes: (id: string) => invoke<ArrayBuffer>("get_history_preview_bytes", { id }),
  /** Lớp annotation hiệu lực (nháp nếu có, ngược lại bản đã lưu) của một item.
   * `null` cho video và cho item PNG thế hệ cũ. */
  getHistoryDocJson: (id: string) => invoke<DocLayer | null>("get_history_doc_json", { id }),
  /** Editor Save — PHI HUỶ: giữ nguyên pixel nền, lưu annotation thành JSON
   * cạnh nó, xoá bản nháp, render lại preview + thumbnail. `base` chỉ truyền
   * khi ẢNH NỀN thật sự đổi (crop/stitch/flatten) để một lần Save
   * chỉ-annotation không phải đẩy vài MB base64 qua IPC. */
  saveHistoryDoc: (id: string, docJson: string, preview: string, base?: string) =>
    invoke<HistoryItem>("save_history_doc", { id, docJson, preview, base }),
  /** Autosave bản nháp. `false` = chưa ghi được (container chưa tồn tại, hoặc
   * item còn ở định dạng PNG cũ) — KHÔNG phải lỗi, xem `put_history_draft_sync`. */
  putHistoryDraft: (id: string, docJson: string) =>
    invoke<boolean>("put_history_draft", { id, docJson }),
  discardHistoryDraft: (id: string) => invoke<void>("discard_history_draft", { id }),
  /** Id các item còn bản nháp chưa lưu — badge ở dải "Gần đây" sau khi khởi
   * động lại app (phiên trong RAM đã mất nhưng nháp trên đĩa còn). */
  listItemsWithDraft: () => invoke<string[]>("list_items_with_draft"),
  copyHistoryItem: (id: string) => invoke<void>("copy_history_item", { id }),
  revealHistoryItem: (id: string) => invoke<void>("reveal_history_item", { id }),
  /** Ghi lại đường dẫn bản Save/Save As gần nhất ra thư mục tuỳ chọn — gọi
   * ngay sau khi export ảnh/video thành công, để lần sau "Xem file trong Thư
   * mục" mở đúng chỗ user đã lưu thay vì file gốc nội bộ. */
  setHistoryExportedPath: (id: string, path: string) => invoke<HistoryItem>("set_history_exported_path", { id, path }),
  openHistory: () => invoke<void>("open_history"),
  /** Cập nhật thumbnail của một item ảnh từ preview đã ghép annotation —
   * dùng để live-update dải "Gần đây" khi user vẽ. Best-effort, lỗi chỉ log. */
  updateHistoryThumb: (id: string, previewData: string) =>
    invoke<void>("update_history_thumb", { id, previewData }),
  finishQuickCapture: (data: string, width: number, height: number, output: string, baseData?: string | null, docJson?: string | null) =>
    invoke<string | null>("finish_quick_capture", { data, width, height, output, baseData: baseData ?? null, docJson: docJson ?? null }),
  // Quay màn hình — dừng quay/xem trạng thái chủ yếu vẫn qua tray icon (menu
  // bar, xem src-tauri/src/tray.rs); `stopRecording`/`recordingStatus` bên
  // dưới chỉ thêm 1 đường nữa cho popup "đang quay" trên Windows.
  /** Bắt đầu quay toàn màn hình chính NGAY, không qua overlay (dùng cho hotkey). */
  startRecording: () => invoke<void>("start_recording"),
  /** Mở overlay chọn phạm vi quay — dùng chung CaptureMode với nút "Chụp" ("full" | "window" | "region"). */
  startRecordPicker: (mode: "full" | "window" | "region") =>
    invoke<void>("start_record_picker", { mode }),
  /** Bấm nút "Quay" ở CaptureBar trong lúc khung chọn vùng quay đã đang mở —
   * coi như bấm "Bắt đầu quay" ngay tại khung đó, không mở lại phiên chọn
   * vùng mới. */
  confirmRegionRecordStart: () => invoke<void>("confirm_region_record_start"),
  /** Dừng quay — dùng cho popup "đang quay" trên Windows (bấm vào để dừng). */
  stopRecording: () => invoke<string>("stop_recording"),
  /** Tạm dừng phiên quay đang chạy — writer thread video/audio sẽ drop frame/chunk. */
  pauseRecording: () => invoke<void>("pause_recording"),
  /** Tiếp tục phiên quay sau khi tạm dừng. */
  resumeRecording: () => invoke<void>("resume_recording"),
  /** Trạng thái tạm dừng hiện tại, `null` nếu không có phiên quay. */
  recordingPausedState: () => invoke<boolean | null>("recording_paused_state"),
  /** Thời lượng đã quay (ms), `null` nếu không có phiên quay — popup "đang quay" poll mỗi giây. */
  recordingStatus: () => invoke<number | null>("recording_status"),
  /** Cắt 1 video ĐÃ LƯU trong History, tạo THÀNH 1 ITEM MỚI trong Library
   * (giữ nguyên item gốc) — lựa chọn "Lưu thành video mới" ở Editor. Trả về
   * item MỚI (id khác `id` truyền vào). */
  trimHistoryVideo: (
    id: string,
    ranges: [number, number][],
    removeAudio: boolean,
    outputPath?: string,
    overlays?: VideoOverlayItem[],
  ) =>
    invoke<HistoryItem>("trim_history_video", {
      id,
      ranges: roundRanges(ranges),
      removeAudio,
      outputPath: outputPath ?? null,
      overlays: sanitizeOverlays(overlays),
    }),
  /** Cắt 1 video ĐÃ LƯU trong History, ghi ĐÈ TẠI CHỖ asset/thumbnail của
   * ĐÚNG item đó — lựa chọn "Lưu đè bản gốc" ở Editor. Vĩnh viễn, không giữ
   * bản gốc. */
  overwriteHistoryVideo: (
    id: string,
    ranges: [number, number][],
    removeAudio: boolean,
    overlays?: VideoOverlayItem[],
  ) =>
    invoke<HistoryItem>("overwrite_history_video", {
      id,
      ranges: roundRanges(ranges),
      removeAudio,
      overlays: sanitizeOverlays(overlays),
    }),
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
  exportVideoGif: (inputPath: string, outputPath: string, options: GifExportOptions) =>
    invoke<string>("export_video_gif", {
      inputPath,
      outputPath,
      options: {
        ...options,
        startMs: Math.round(options.startMs),
        durationMs: Math.round(options.durationMs),
        fps: Math.round(options.fps),
        maxWidth: options.maxWidth ? Math.round(options.maxWidth) : null,
      },
    }),
  copyGifToClipboard: (filePath: string) =>
    invoke<void>("copy_gif_to_clipboard", { filePath }),
  saveGifToHistory: (sourceHistoryId: string | null, gifPath: string, durationMs: number) =>
    invoke<HistoryItem>("save_gif_to_history", {
      sourceHistoryId,
      gifPath,
      durationMs: Math.round(durationMs),
    }),
};


/** Rust nhận `Vec<(i64, i64)>` — `ranges` tính từ tỉ lệ pixel kéo-thả
 * (`VideoTrimmer.tsx`) luôn ra số thập phân (JS không phân biệt int/float),
 * làm tròn ở biên IPC để tránh lỗi deserialize "expected i64". */
function roundRanges(ranges: [number, number][]): [number, number][] {
  return ranges.map(([s, e]) => [Math.round(s), Math.round(e)]);
}

/** Làm sạch và chuẩn hoá các overlay trước khi truyền sang backend qua IPC,
 * đảm bảo toạ độ/thời lượng là số hữu hạn hợp lệ và làm tròn mili-giây. */
function sanitizeOverlays(overlays?: VideoOverlayItem[]): VideoOverlayItem[] {
  if (!overlays || !Array.isArray(overlays)) return [];
  return overlays.map((o) => ({
    ...o,
    relX: Number.isFinite(o.relX) ? o.relX : 0,
    relY: Number.isFinite(o.relY) ? o.relY : 0,
    relW: Number.isFinite(o.relW) ? Math.max(0, o.relW) : 0,
    relH: Number.isFinite(o.relH) ? Math.max(0, o.relH) : 0,
    startTimeMs: Math.round(Number.isFinite(o.startTimeMs) ? o.startTimeMs : 0),
    endTimeMs: Math.round(Number.isFinite(o.endTimeMs) ? o.endTimeMs : 0),
    strokeWidth: o.strokeWidth != null && Number.isFinite(o.strokeWidth) ? Math.round(o.strokeWidth) : undefined,
  }));
}
