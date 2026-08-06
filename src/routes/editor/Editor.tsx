import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation, Trans } from "react-i18next";
import Toolbar from "./Toolbar";
import HistoryStrip from "./HistoryStrip";
import AnnotationStage, { type StageHandle } from "../../features/annotation/canvas/AnnotationStage";
import VideoTrimmer from "../../features/video-trim/VideoTrimmer";
import { useEditor } from "../../features/annotation/store";
import {
  beginSwitch,
  isCurrentSwitch,
  noteActiveKey,
  initAutosave,
  parseDocPayload,
  suspendActive,
} from "../../features/annotation/sessions";
import { uid } from "../../features/annotation/model";
import {
  copyToClipboard,
  saveToFile,
  saveAsToFile,
  promptSaveVideoPath,
  stampVideoName,
  dirnameOf,
} from "../../features/output/useOutput";
import { ipc, type Pending, type HistoryItem } from "../../lib/ipc";
import { editorToolFromKey } from "../../lib/toolShortcuts";
import StitchDialog from "../../features/annotation/compose/StitchDialog";
import type { StitchResult } from "../../features/annotation/compose/stitch";

interface VideoDoc {
  historyId: string;
  filePath: string;
  src: string;
  durationMs: number;
}

const EMPTY_TRIM_STATE = { hasChanges: false, keepRanges: [] as [number, number][], removeAudio: false };

/** "Dấu vân tay" của trạng thái cắt video — dùng để so với lần lưu gần nhất.
 *
 * KHÔNG dùng thẳng `videoTrimState.hasChanges` (= `past.length > 0` bên
 * `VideoTrimmer`) làm "chưa lưu": sau "Lưu thành video mới" (`doSaveAsVideo`)
 * bản gốc không hề đổi nên `hasChanges` vẫn `true` → user bị nhắc về đúng
 * việc vừa export xong. (Sau "Lưu đè" thì đã đúng sẵn vì `doSaveVideo` reset
 * `videoTrimState` và bump `videoVersion` để remount trimmer.) */
const trimSig = (s: typeof EMPTY_TRIM_STATE) => JSON.stringify([s.keepRanges, s.removeAudio]);

export default function Editor() {
  const { t } = useTranslation();
  const stageRef = useRef<StageHandle>(null);
  const loadDoc = useEditor((s) => s.loadDoc);
  const docHistoryId = useEditor((s) => s.doc?.historyId);
  const docAnnotations = useEditor((s) => s.doc?.annotations);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showFlattenConfirm, setShowFlattenConfirm] = useState(false);
  const [stitchImage, setStitchImage] = useState<string | null>(null);
  // Video đang xem/cắt trong Editor (song song với `doc` — ảnh — trong store
  // `useEditor`; chỉ 1 trong 2 được render tại 1 thời điểm, xem JSX bên dưới).
  const [videoDoc, setVideoDoc] = useState<VideoDoc | null>(null);
  const [videoTrimState, setVideoTrimState] = useState(EMPTY_TRIM_STATE);
  // Tăng lên sau mỗi lần "Lưu đè" thành công — ép `VideoTrimmer` remount lại
  // từ đầu (key dưới JSX ghép `historyId`+số này) vì file vừa bị ghi đè có
  // thời lượng/nội dung MỚI, trong khi `historyId` không đổi (cùng record) —
  // segments/zoom/cache filmstrip cũ của lần mount trước không còn khớp.
  const [videoVersion, setVideoVersion] = useState(0);
  // Signature của trạng thái cắt tại lần lưu gần nhất (`null` = chưa lưu lần
  // nào cho video đang mở). Xem `trimSig`.
  const [videoSavedSig, setVideoSavedSig] = useState<string | null>(null);

  // Video dirty = có thay đổi VÀ thay đổi đó khác lần lưu gần nhất.
  const videoDirty =
    !!videoDoc && videoTrimState.hasChanges && trimSig(videoTrimState) !== videoSavedSig;
  useEffect(() => {
    useEditor.getState().setVideoDirty(videoDirty);
  }, [videoDirty]);

  // Live-update thumbnail dải "Gần đây" khi annotation thay đổi.
  // Debounce 1.5s — đủ thưa để không gọi liên tục khi đang kéo vẽ,
  // đủ dày để thumbnail cập nhật nhanh sau khi dừng tay.
  const thumbTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (thumbTimerRef.current !== null) window.clearTimeout(thumbTimerRef.current);
    thumbTimerRef.current = window.setTimeout(() => {
      thumbTimerRef.current = null;
      const historyId = useEditor.getState().doc?.historyId;
      if (!historyId) return;
      const preview = stageRef.current?.exportPng();
      if (!preview) return;
      ipc.updateHistoryThumb(historyId, preview).catch(() => {});
    }, 1500);
    return () => {
      if (thumbTimerRef.current !== null) window.clearTimeout(thumbTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docAnnotations]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  const loadPending = (p: Pending | null) => {
    if (!p) return false;
    const payload = parseDocPayload(p.docJson);
    // Nạp từ bản nháp hay ảnh mới: luôn markClean=true — annotation được autosave
    // liên tục, không cần phân biệt "đã lưu" hay "chưa lưu".
    loadDoc(
      {
        image: `data:image/png;base64,${p.base64}`,
        imgW: p.width,
        imgH: p.height,
        scaleFactor: p.scale_factor ?? 1,
        annotations: payload?.annotations ?? [],
        historyId: p.history_id,
        captureMode: p.capture_mode,
        filePath: p.filePath,
      },
      true,
    );
    if (payload) {
      useEditor.getState().setStepCounter(payload.stepCounter);
      useEditor.getState().setArrowCounter(payload.arrowCounter);
    }
    noteActiveKey(p.history_id ?? `file:${uid()}`);
    return true;
  };

  const loadFromUrl = (dataUrl: string) => {
    const img = new Image();
    img.onload = () => {
      loadDoc({
        image: dataUrl,
        imgW: img.naturalWidth,
        imgH: img.naturalHeight,
        scaleFactor: 1,
        annotations: [],
      });
      // Ảnh từ file ngoài chưa có mặt trong Library → khoá tổng hợp, chỉ sống
      // trong phiên app này (xem `sessions.ts`).
      noteActiveKey(`file:${uid()}`);
    };
    img.src = dataUrl;
  };

  // Lấy ảnh chờ khi mở editor + khi có ảnh mới (event refresh-capture)
  useEffect(() => {
    // [DEV] Chạy trên trình duyệt thuần (không Tauri) → nạp ảnh test để thử UI.
    if (!("__TAURI_INTERNALS__" in window)) {
      const c = document.createElement("canvas");
      c.width = 800;
      c.height = 500;
      const g = c.getContext("2d")!;
      g.fillStyle = "#cbd5e1";
      g.fillRect(0, 0, 800, 500);
      g.fillStyle = "#475569";
      g.fillRect(40, 40, 720, 420);
      loadDoc({ image: c.toDataURL("image/png"), imgW: 800, imgH: 500, scaleFactor: 1, annotations: [] });
      return;
    }

    // macOS: cửa sổ "Open with" (editor-ow-N) chỉ hiển thị ĐÚNG ảnh của nó và
    // KHÔNG nghe event chụp — tránh bị thay ảnh khi user chụp màn hình mới.
    const label = getCurrentWebviewWindow().label;
    if (label.startsWith("editor-ow")) {
      // Cố tình KHÔNG bật autosave ở cửa sổ này: ảnh "Open with" không có mặt
      // trong Library nên chẳng có container nào để ghi nháp, và 2 cửa sổ cùng
      // ghi vào một file là điều phải tránh.
      ipc.takeOpenFile().then((url) => {
        if (url) loadFromUrl(url);
      });
      return;
    }

    // Video (mở từ Library, hoặc vừa quay xong — cả 2 đều đã ingest vào
    // History trước khi tới đây, xem `record::stop_recording_impl`) LUÔN
    // được kiểm tra TRƯỚC ảnh — chỉ 1 trong 2 loại pending chờ tại 1 thời điểm.
    const loadAnyPending = async () => {
      let suspended = null;
      try {
        suspended = suspendActive();
      } catch (e) {
        console.error("[SnapDoc] Treo phiên sửa thất bại, vẫn nạp ảnh mới:", e);
      }
      void suspended; // không dùng nữa, giữ lại để suspendActive vẫn chạy
      const token = beginSwitch();

      const pv = await ipc.takePendingVideo();
      if (!isCurrentSwitch(token)) return;
      if (pv) {
        setVideoDoc({
          historyId: pv.historyId,
          filePath: pv.path,
          src: convertFileSrc(pv.path),
          durationMs: pv.durationMs,
        });
        setVideoTrimState(EMPTY_TRIM_STATE);
        setVideoSavedSig(null);
        noteActiveKey(null);
        return;
      }
      const p = await ipc.takePending();
      if (!isCurrentSwitch(token)) return;
      if (p) setVideoDoc(null);
      loadPending(p);
    };

    loadAnyPending();
    // Bật autosave TƯỜNG MINH ở đây (không phải side-effect của module) — chỉ
    // cửa sổ `editor` được ghi nháp, xem `initAutosave`.
    const stopAutosave = initAutosave();
    const un = listen("refresh-capture", loadAnyPending);
    // Windows "Open with" / double-click: Rust emit event này với data URL đầy đủ,
    // không cần round-trip IPC takePending (timing an toàn hơn).
    const unOpenFile = listen<string>("open-file", (e) => {
      suspendActive();
      setVideoDoc(null);
      loadFromUrl(e.payload);
    });
    return () => {
      stopAutosave();
      un.then((f) => f());
      unOpenFile.then((f) => f());
    };
  }, []);

  const doCopy = async () => {
    const url = stageRef.current?.exportPng();
    if (!url) return;
    setBusy(true);
    try {
      await copyToClipboard(url);
      flash(t("editorMain.copiedClipboard"));
    } finally {
      setBusy(false);
    }
  };

  // "Lưu đè bản gốc" — ghi đè vĩnh viễn asset/thumbnail của ĐÚNG record này
  // (không tạo record mới). Không có gì để lưu đè nếu chưa cắt gì. KHÔNG đóng
  // Editor sau khi lưu (khác trước đây) — nạp lại đúng bản đã cắt (thời
  // lượng/nội dung mới) để user xem kết quả và có thể tiếp tục chỉnh sửa
  // ngay, không phải mở lại từ Library.
  const doSaveVideo = async () => {
    if (!videoDoc || !videoTrimState.hasChanges) return;
    setBusy(true);
    try {
      const updated = await ipc.overwriteHistoryVideo(videoDoc.historyId, videoTrimState.keepRanges, videoTrimState.removeAudio);
      setVideoDoc({
        historyId: updated.id,
        filePath: updated.assetPath,
        src: convertFileSrc(updated.assetPath),
        durationMs: updated.durationMs ?? 0,
      });
      setVideoTrimState(EMPTY_TRIM_STATE);
      setVideoSavedSig(null);
      setVideoVersion((v) => v + 1);
      flash(t("editorMain.videoOverwritten"));
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  // "Lưu thành video mới" — áp dụng cắt (hoặc y nguyên nếu chưa cắt gì) thành
  // 1 record MỚI trong Library, giữ nguyên bản gốc. Không đóng Editor, không
  // đụng gì tới `videoDoc`/`videoTrimState` hiện tại (đang xem/sửa) — bản gốc
  // không hề đổi, chỉ có thêm 1 item mới xuất hiện trong dải "Gần đây".
  // `pickLocation` = true → dropdown "Chọn nơi lưu…" ở nút "Lưu thành video
  // mới" (VideoTrimmer): mở dialog Save As để user chọn thư mục VÀ sửa tên
  // file, thay vì auto lưu vào `saveDir` với tên `Recording_<timestamp>.mp4`.
  const doSaveAsVideo = async (pickLocation = false) => {
    if (!videoDoc) return;
    let outputPath: string | undefined;
    if (pickLocation) {
      const settings = await ipc.getSettings().catch(() => null);
      const dir = settings?.lastVideoSaveAsDir || settings?.saveDir || (await ipc.defaultSaveDir());
      const path = await promptSaveVideoPath(dir ? `${dir}/${stampVideoName()}.mp4` : `${stampVideoName()}.mp4`);
      if (!path) {
        flash(t("editorMain.videoSaveAsCancelled"));
        return;
      }
      outputPath = path;
    }
    setBusy(true);
    try {
      await ipc.trimHistoryVideo(
        videoDoc.historyId,
        videoTrimState.keepRanges,
        videoTrimState.removeAudio,
        outputPath,
      );
      if (outputPath) {
        const settings = await ipc.getSettings().catch(() => null);
        if (settings) ipc.setSettings({ ...settings, lastVideoSaveAsDir: dirnameOf(outputPath) }).catch(() => {});
      }
      // Bản gốc KHÔNG đổi (chỉ thêm 1 record mới) nên `videoTrimState` giữ
      // nguyên — chốt signature lại để trạng thái cắt hiện tại được coi là
      // "đã lưu", tránh nhắc user về đúng việc vừa export xong.
      setVideoSavedSig(trimSig(videoTrimState));
      flash(t("editorMain.videoSavedNew"));
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Save — xuất PNG (ghép annotation vào pixel) ra file/clipboard.
   * Annotation được tự động lưu non-destructive qua autosave riêng.
   * Với ảnh mở từ Library (historyId có giá trị): mở dialog chọn nơi lưu PNG.
   * Với ảnh mở từ file ngoài: mở dialog chọn nơi lưu PNG rồi đóng editor. */
  const doSave = async (alsoCopy = false) => {
    if (videoDoc) return doSaveVideo();
    const preview = stageRef.current?.exportPng();
    if (!preview) return;
    setBusy(true);
    try {
      if (alsoCopy) {
        // Save+Copy: lưu PNG ra thư mục mặc định và copy vào clipboard cùng lúc.
        const { saveToFileAuto } = await import("../../features/output/useOutput");
        await saveToFileAuto(preview, true);
        flash(t("editorMain.saved"));
        return;
      }
      // Save / Save As: mở dialog chọn nơi lưu.
      const saved = await saveToFile(preview, false);
      if (saved) {
        const historyId = useEditor.getState().doc?.historyId;
        if (historyId) ipc.setHistoryExportedPath(historyId, saved).catch(() => {});
        flash(t("editorMain.saved"));
      }
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  // "Save As…" — LUÔN mở dialog chọn file, xuất PNG ra vị trí tuỳ chọn.
  const doSaveAs = async () => {
    if (videoDoc) return doSaveAsVideo();
    const url = stageRef.current?.exportPng();
    if (!url) return;
    setBusy(true);
    try {
      const saved = await saveAsToFile(url);
      if (saved) {
        const historyId = useEditor.getState().doc?.historyId;
        if (historyId) ipc.setHistoryExportedPath(historyId, saved).catch(() => {});
        flash(t("editorMain.saved"));
      }
    } finally {
      setBusy(false);
    }
  };

  // Phím tắt editor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Đang gõ trong ô nhập (vd: textarea chú thích chữ) → không cướp phím,
      // nếu không các ký tự v/r/o/t/n/c sẽ bị hiểu thành phím đổi công cụ.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const s = useEditor.getState();

      // Guard 1 (theo focus): mục tiêu sự kiện là ô nhập liệu.
      // Guard 2 (theo state): đang có text annotation mở để gõ, kể cả khi
      // focus chưa kịp về textarea (hay gặp trong webview Tauri).
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable || s.editingTextId) {
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? s.redo() : s.undo();
      } else if (mod && e.key.toLowerCase() === "s") {
        // Ctrl/Cmd+S = Save; Ctrl/Cmd+Shift+S = Save As (chuẩn ngành, giống
        // Photoshop/Office/Sketch); Ctrl/Cmd+Alt+S = Save+Copy (dời từ
        // Shift+S cũ để nhường chỗ cho Save As).
        e.preventDefault();
        if (e.shiftKey) doSaveAs();
        else if (e.altKey) doSave(true);
        else doSave(false);
      } else if (mod && e.key.toLowerCase() === "n") {
        // Giống nút "New" trên toolbar — chụp mới theo chế độ gần nhất.
        e.preventDefault();
        doNew();
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        doOpen();
      } else if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        doCopy();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        stageRef.current?.zoomIn();
      } else if (mod && e.key === "-") {
        e.preventDefault();
        stageRef.current?.zoomOut();
      } else if (mod && e.key === "0") {
        e.preventDefault();
        stageRef.current?.zoomFit();
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) {
        e.preventDefault();
        s.removeSelected();
      } else if (!mod) {
        const t = editorToolFromKey(e);
        if (t) {
          e.preventDefault();
          s.setTool(t);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const doFlatten = () => {
    setShowFlattenConfirm(true);
  };

  // "New" — mở capture bar với mode gần nhất pre-selected (xử lý timing ở Rust)
  const doNew = async () => {
    await ipc.openCaptureBarForNew().catch(() => {});
  };

  // "Open" — mở file dialog chọn ảnh, load vào editor
  const doOpen = async () => {
    try {
      // Treo trước khi mở dialog: dialog là blocking, user có thể mất một lúc
      // mới chọn xong file.
      suspendActive();
      const opened = await ipc.openFile();
      if (!opened) return;
      // `.snapdoc` mang theo lớp annotation + đường dẫn gốc → mở ra là sửa tiếp
      // được ngay, và Save sẽ ghi thẳng lại chính file đó.
      const payload = parseDocPayload(opened.docJson);
      const img = new Image();
      img.onload = () => {
        setVideoDoc(null);
        loadDoc({
          image: opened.dataUrl,
          imgW: img.naturalWidth,
          imgH: img.naturalHeight,
          scaleFactor: 1,
          annotations: payload?.annotations ?? [],
          filePath: opened.filePath,
        });
        if (payload) {
          useEditor.getState().setStepCounter(payload.stepCounter);
          useEditor.getState().setArrowCounter(payload.arrowCounter);
        }
        // File-backed thì lấy chính đường dẫn làm khoá phiên (ổn định, mở lại
        // cùng file là về đúng phiên cũ); ảnh thường thì khoá tổng hợp.
        noteActiveKey(opened.filePath ? `file:${opened.filePath}` : `file:${uid()}`);
      };
      img.src = opened.dataUrl;
    } catch (e) {
      flash(t("editorMain.errorOpeningFile", { error: e }));
    }
  };

  // "Ghép" — mở dialog nối ảnh dài; ảnh đầu = canvas hiện tại (đã flatten).
  const doStitch = () => {
    const current = stageRef.current?.flattenPng();
    if (!current) {
      flash(t("editorMain.noImagesToStitch"));
      return;
    }
    setStitchImage(current);
  };

  const handleStitchApply = (result: StitchResult) => {
    setStitchImage(null);
    // Đi qua history (không loadDoc reset) → Ctrl/Cmd+Z hoàn tác về trước khi nối.
    useEditor.getState().applyStitch(result.dataUrl, result.width, result.height);
    flash(t("editorMain.imageStitched"));
  };

  const confirmFlatten = () => {
    setShowFlattenConfirm(false);
    // Export canvas thành data URL rồi loadDoc lại với annotations rỗng.
    // Blur/highlight/annotation đều được "burn" vào pixel → không thể undo bằng metadata.
    const url = stageRef.current?.flattenPng();
    if (!url) return;
    const { doc } = useEditor.getState();
    if (!doc) return;
    // Đo kích thước ảnh đã flatten qua Image element
    const el = new Image();
    el.onload = () => {
      useEditor.getState().loadDoc(
        {
          image: url,
          imgW: el.naturalWidth,
          imgH: el.naturalHeight,
          scaleFactor: doc.scaleFactor,
          annotations: [],
          historyId: doc.historyId,
          // Giữ đường về file gốc — mất nó thì `.snapdoc` mở từ đĩa sau khi
          // flatten sẽ không ghi lại được chính file đó nữa.
          filePath: doc.filePath,
        },
        // `markClean = false`: ảnh vừa flatten CHƯA được lưu ở đâu cả (chính
        // dialog xác nhận cũng nói vậy — `editorMain.flattenItem3`). Nếu để
        // mặc định `true` thì chỉ báo "chưa lưu" tắt ngay sau khi flatten và
        // user đóng editor là mất trắng thao tác vừa rồi.
        false,
      );
      // Ảnh nền đã bị thay (annotation burn vào pixel) → đường lưu draft phải
      // biết mà gửi kèm base image mới, nếu không nó sẽ đắp annotation CŨ lên
      // nền đã burn → mở lại thấy vẽ đôi.
      useEditor.getState().markBaseDirty();
      flash(t("editorMain.flattened"));
    };
    el.src = url;
  };

  return (
    <div className="solid-bg" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar
        mode={videoDoc ? "video" : "image"}
        onSave={() => doSave(false)}
        onSaveAs={doSaveAs}
        onCopy={doCopy}
        onSaveCopy={() => doSave(true)}
        onFlatten={doFlatten}
        onNew={doNew}
        onOpen={doOpen}
        onStitch={doStitch}
        busy={busy}
      />
      <div style={{ flex: 1, minHeight: 0, background: "#161619", display: "flex", ...(videoDoc ? { padding: 10, boxSizing: "border-box" } : null) }}>
        {videoDoc ? (
          <VideoTrimmer
            key={`${videoDoc.historyId}:${videoVersion}`}
            src={videoDoc.src}
            filePath={videoDoc.filePath}
            durationMs={videoDoc.durationMs}
            busy={busy}
            onSave={doSaveVideo}
            onSaveAs={doSaveAsVideo}
            onStateChange={setVideoTrimState}
            frameCaptureMode="in-place"
          />
        ) : (
          <AnnotationStage ref={stageRef} />
        )}
      </div>
      <HistoryStrip
        onFlash={flash}
        currentId={videoDoc ? videoDoc.historyId : docHistoryId}
        onOpenVideo={(item: HistoryItem) => {
          // `HistoryStrip.openItem` chỉ gọi `suspendActive` ở nhánh ẢNH
          // (`openImageInEditor`), nhánh video đi thẳng vào đây — nên treo ở
          // đây, nếu không đổi từ ảnh-đang-sửa sang video là mất việc.
          try {
            suspendActive();
          } catch (e) {
            console.error("[SnapDoc] Treo phiên sửa thất bại:", e);
          }
          setVideoDoc({
            historyId: item.id,
            filePath: item.assetPath,
            src: convertFileSrc(item.assetPath),
            durationMs: item.durationMs ?? 0,
          });
          setVideoTrimState(EMPTY_TRIM_STATE);
          setVideoSavedSig(null);
          // `null` chứ không phải `item.id` — xem giải thích ở nhánh video của
          // `loadAnyPending`: `doc` trong store vẫn là ảnh cũ.
          noteActiveKey(null);
        }}
        onOpenImage={() => setVideoDoc(null)}
      />
      {toast && <div style={toastStyle}>{toast}</div>}
      {showFlattenConfirm && (
        <FlattenConfirmDialog
          onConfirm={confirmFlatten}
          onCancel={() => setShowFlattenConfirm(false)}
        />
      )}
      {stitchImage && (
        <StitchDialog
          initialImage={stitchImage}
          onApply={handleStitchApply}
          onCancel={() => setStitchImage(null)}
        />
      )}
    </div>
  );
}

/* ── Flatten Confirm Dialog ── */

function FlattenConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  // Đóng khi nhấn Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        {/* Icon + tiêu đề */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 22 }}>🔒</span>
          <span style={{ fontSize: 15, fontWeight: 600, color: "#fca5a5" }}>{t("editorMain.flattenConfirmTitle")}</span>
        </div>

        {/* Mô tả */}
        <p style={descStyle}>
          <Trans i18nKey="editorMain.flattenDescription" components={{ 1: <strong style={{ color: "#f87171" }} /> }} />
        </p>

        <ul style={listStyle}>
          <li><Trans i18nKey="editorMain.flattenItem1" components={{ 1: <strong /> }} /></li>
          <li><Trans i18nKey="editorMain.flattenItem2" components={{ 1: <strong /> }} /></li>
          <li><Trans i18nKey="editorMain.flattenItem3" components={{ 1: <strong /> }} /></li>
        </ul>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
          <button style={cancelBtnStyle} onClick={onCancel}>
            {t("editorMain.flattenCancel")}
          </button>
          <button style={confirmBtnStyle} onClick={onConfirm} autoFocus>
            {t("editorMain.flattenConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: "var(--bg-elevated, #1e1e24)",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 12,
  padding: "22px 24px",
  width: 380,
  maxWidth: "90vw",
  boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
};

const descStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--text, #e2e8f0)",
  lineHeight: 1.6,
  margin: "0 0 12px",
};

const listStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim, #94a3b8)",
  lineHeight: 1.7,
  paddingLeft: 18,
  margin: 0,
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 18px",
  borderRadius: 7,
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "transparent",
  color: "var(--text-dim, #94a3b8)",
  fontSize: 13,
  cursor: "pointer",
};

const confirmBtnStyle: React.CSSProperties = {
  padding: "7px 18px",
  borderRadius: 7,
  border: "1px solid rgba(239,68,68,0.4)",
  background: "rgba(239,68,68,0.2)",
  color: "#fca5a5",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const toastStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 20,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(20,20,24,0.95)",
  border: "1px solid var(--border)",
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 13,
};
