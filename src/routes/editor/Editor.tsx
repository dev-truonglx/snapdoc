import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation, Trans } from "react-i18next";
import Toolbar from "./Toolbar";
import HistoryStrip from "./HistoryStrip";
import AnnotationStage, { type StageHandle } from "../../features/annotation/canvas/AnnotationStage";
import VideoTrimmer from "../../features/video-trim/VideoTrimmer";
import { useEditor, useIsDirty } from "../../features/annotation/store";
import {
  beginSwitch,
  flushDraft,
  isCurrentSwitch,
  noteActiveKey,
  openLibraryImage,
  initAutosave,
  parseDocPayload,
  serializeDoc,
  suspendActive,
  tryResume,
  type SuspendResult,
} from "../../features/annotation/sessions";
import ResumeBanner from "./ResumeBanner";
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
  // Key của phiên sửa vừa bị đẩy sang nền trong lúc còn thay đổi chưa lưu —
  // `null` = không có gì để báo. Xem `announceKept` / `ResumeBanner`.
  const [keptKey, setKeptKey] = useState<string | null>(null);
  // Id item vừa được nạp TỪ BẢN NHÁP TRÊN ĐĨA (sau khi app khởi động lại) —
  // hỏi user tiếp tục hay bỏ. `null` = không có gì để hỏi.
  const [draftPromptId, setDraftPromptId] = useState<string | null>(null);

  // Video dirty = có thay đổi VÀ thay đổi đó khác lần lưu gần nhất. Đẩy vào
  // store để `isDirty()` là nguồn sự thật duy nhất cho cả ảnh lẫn video.
  const videoDirty =
    !!videoDoc && videoTrimState.hasChanges && trimSig(videoTrimState) !== videoSavedSig;
  useEffect(() => {
    useEditor.getState().setVideoDirty(videoDirty);
  }, [videoDirty]);

  // Mirror cờ dirty xuống Rust — DEBOUNCE BẤT ĐỐI XỨNG: `true` gửi NGAY,
  // `false` gửi trễ 300ms. Lý do bất đối xứng: cờ `true` còn sót lại chỉ gây
  // 1 cảnh báo thừa, còn cờ `false` còn sót lại thì Rust tưởng editor sạch và
  // để nó bị ẩn mất cùng việc chưa lưu. Sai về phía an toàn.
  const dirty = useIsDirty();
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    if (dirty) {
      ipc.setEditorDirty(true).catch(() => {});
      return;
    }
    const id = window.setTimeout(() => {
      ipc.setEditorDirty(false).catch(() => {});
    }, 300);
    return () => window.clearTimeout(id);
  }, [dirty]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  /** Báo cho user biết bản chỉnh sửa vừa rồi ĐÃ ĐƯỢC GIỮ LẠI, kèm nút quay về.
   *
   * Đây là mảnh quan trọng nhất về mặt UX: nó xuất hiện đúng vào khoảnh khắc
   * mà hành vi cũ phá dữ liệu, nên nó dạy user cơ chế mới ngay tại chỗ thay vì
   * để user tự phát hiện. Cố tình KHÔNG chặn (không modal): chụp ảnh không bao
   * giờ bị chặn lại để hỏi.
   *
   * Chỉ hiện khi tài liệu vừa treo THẬT SỰ có thay đổi chưa lưu, và tài liệu
   * mới khác tài liệu cũ. */
  const announceKept = (suspended: SuspendResult | null, newKey: string | null) => {
    if (!suspended?.dirty) return;
    if (suspended.key === newKey) return;
    setKeptKey(suspended.key);
  };

  /** Bỏ bản nháp → tài liệu về đúng bản đã Save gần nhất. */
  const discardDraft = async (id: string) => {
    setBusy(true);
    try {
      await ipc.discardHistoryDraft(id);
      const layer = await ipc.getHistoryDocJson(id).catch(() => null);
      const payload = parseDocPayload(layer?.json);
      const st = useEditor.getState();
      if (st.doc) {
        // Chỉ thay lớp annotation — nền không đổi khi bỏ nháp (nháp chưa bao giờ
        // ghi vào `base.png`), nên giữ nguyên `image` đang hiển thị.
        st.loadDoc({ ...st.doc, annotations: payload?.annotations ?? [] }, true);
        if (payload) {
          useEditor.getState().setStepCounter(payload.stepCounter);
          useEditor.getState().setArrowCounter(payload.arrowCounter);
        }
      }
      setDraftPromptId(null);
      flash(t("editorMain.draftDiscarded"));
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Quay về một phiên sửa đang treo (nút "Quay lại" ở banner, hoặc bấm item
   * có badge ở dải "Gần đây"). Treo tài liệu hiện tại trước để đi-về được. */
  const resumeSession = async (key: string) => {
    beginSwitch();
    try {
      suspendActive();
    } catch (e) {
      console.error("[SnapDoc] Treo phiên sửa thất bại:", e);
    }
    if (tryResume(key)) {
      // Phiên còn trong RAM → về đầy đủ, kể cả undo stack.
      setVideoDoc(null);
      setKeptKey(null);
      return true;
    }
    // Đã bị evict khỏi RAM (quá `MAX_SESSIONS`) → rơi về tầng đĩa: bản nháp
    // vẫn nằm trong `.snapdoc` (autosave), chỉ mất undo stack. Ảnh mở từ file
    // ngoài (`file:` key) thì không có gì trên đĩa để lấy.
    setKeptKey(null);
    if (key.startsWith("file:")) {
      flash(t("editorMain.resumeUnavailable"));
      return false;
    }
    setVideoDoc(null);
    await openLibraryImage(key);
    return true;
  };

  const loadPending = (p: Pending | null) => {
    if (!p) return false;
    // `base64` là pixel NỀN (chưa ghép annotation); lớp annotation đi riêng qua
    // `doc_json` — có giá trị khi mở lại một item đã sửa từ Library, `null` cho
    // ảnh vừa chụp và cho item PNG thế hệ cũ.
    const payload = parseDocPayload(p.docJson);
    // Nạp từ BẢN NHÁP → tài liệu đúng nghĩa là CHƯA LƯU (`markClean = false`).
    // Nếu để clean thì badge "chưa lưu" tắt, autosave ngừng ghi, và user tưởng
    // việc đã được lưu trong khi bản chính thức trên đĩa vẫn là bản cũ.
    const fromDraft = !!p.docIsDraft && !!payload;
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
      !fromDraft,
    );
    if (payload) {
      useEditor.getState().setStepCounter(payload.stepCounter);
      useEditor.getState().setArrowCounter(payload.arrowCounter);
    }
    // Không lặng lẽ đắp annotation cũ lên một ảnh mà user tưởng còn nguyên —
    // hỏi. Chỉ ở đường này (nạp từ đĩa sau khi app khởi động lại); quay lại
    // trong CÙNG phiên thì `tryResume` bắt trước nên phục hồi im lặng, vì user
    // vừa rời đi và quay lại, badge ở dải "Gần đây" đã báo rồi.
    if (fromDraft && p.history_id) setDraftPromptId(p.history_id);
    // Ảnh vừa chụp/mở luôn có `history_id` thật (`flow::finish` ingest vào
    // Library TRƯỚC khi mở editor). Fallback `file:` chỉ để phòng đường
    // `set_pending_image` nếu sau này không ingest.
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
      // Treo tài liệu đang mở NGAY — đồng bộ, TRƯỚC mọi `await` bên dưới. Đây
      // là chỗ trước đây mất dữ liệu: `loadDoc` ghi đè thẳng lên việc đang làm.
      // Bọc try/catch vì nếu bước này lỗi mà làm hỏng cả hàm thì ảnh vừa chụp
      // sẽ không bao giờ hiện ra — tệ hơn hẳn bug đang sửa.
      let suspended: SuspendResult | null = null;
      try {
        suspended = suspendActive();
      } catch (e) {
        console.error("[SnapDoc] Treo phiên sửa thất bại, vẫn nạp ảnh mới:", e);
      }
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
        // `null`, KHÔNG phải `pv.historyId`: chuyển sang chế độ video chỉ set
        // `videoDoc` chứ không gọi `loadDoc`, nên `doc` trong store VẪN GIỮ ảnh
        // trước đó. Nếu đặt activeKey = id của video thì lần treo phiên kế tiếp
        // sẽ lưu ẢNH CŨ dưới khoá của VIDEO — sai nội dung, và badge "chưa lưu"
        // sẽ hiện trên item video. Trạng thái cắt video được giữ lại là việc
        // của GĐ4 (`VideoTrimmer` cần prop `initialState`), chưa làm ở đây.
        noteActiveKey(null);
        announceKept(suspended, pv.historyId);
        return;
      }
      const p = await ipc.takePending();
      if (!isCurrentSwitch(token)) return;
      if (p) setVideoDoc(null);
      // `loadPending` trả `false` khi không có gì chờ (vd `refresh-capture` bắn
      // ra mà pending đã bị lấy) — khi đó KHÔNG báo "đã giữ lại", vì chẳng có
      // gì thay thế tài liệu đang mở cả.
      if (loadPending(p)) announceKept(suspended, p?.history_id ?? null);
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

  /** Save — **PHI HUỶ**: giữ nguyên pixel nền, lưu lớp annotation thành JSON
   * cạnh nó trong container `.snapdoc`. Nhờ vậy mở lại ảnh lúc nào cũng di
   * chuyển / đổi màu / xoá từng annotation được, thay vì bị burn thành pixel
   * vĩnh viễn như hành vi cũ (`update_history_asset` ghi đè asset bằng ảnh đã
   * ghép, mất luôn bản gốc sạch).
   *
   * KHÔNG còn đóng editor sau khi lưu: "lưu rồi sửa tiếp" mới là điểm của việc
   * này, mà đóng cửa sổ thì mâu thuẫn trực tiếp với nó. Muốn đóng thì bấm X. */
  const doSave = async (alsoCopy = false) => {
    if (videoDoc) return doSaveVideo();
    const preview = stageRef.current?.exportPng();
    if (!preview) return;
    setBusy(true);
    try {
      const st = useEditor.getState();
      const historyId = st.doc?.historyId;
      const filePath = st.doc?.filePath;
      const docJson = serializeDoc();
      // Tài liệu `.snapdoc` mở từ đĩa: ghi THẲNG lại chính file đó, không dialog,
      // không đụng Library — như mọi trình soạn tài liệu.
      if (filePath && docJson) {
        const base = st.baseDirty ? st.doc?.image : undefined;
        await ipc.saveSnapdocFile(filePath, docJson, preview, base);
        useEditor.getState().markSaved();
        if (alsoCopy) await copyToClipboard(preview);
        flash(t("editorMain.saved"));
        return;
      }
      if (historyId && docJson) {
        // Nền chỉ gửi lên khi thật sự đã đổi (crop / stitch / flatten) —
        // Save chỉ-annotation khỏi phải đẩy vài MB base64 qua IPC.
        const base = st.baseDirty ? st.doc?.image : undefined;
        await ipc.saveHistoryDoc(historyId, docJson, preview, base);
        useEditor.getState().markSaved();
        if (alsoCopy) await copyToClipboard(preview);
        flash(t("editorMain.saved"));
        return;
      }
      // Ảnh mở từ file ngoài (chưa có mặt trong Library) → hỏi nơi lưu như cũ.
      const saved = await saveToFile(preview, alsoCopy);
      if (saved) {
        useEditor.getState().markSaved();
        ipc.closeSelf();
      }
    } catch (e) {
      flash(String(e));
    } finally {
      setBusy(false);
    }
  };

  // "Save As…" — LUÔN mở dialog chọn file (kể cả khi ảnh có `historyId`, tức
  // ảnh chụp/mở từ Library), khác `doSave` (ghi đè tại chỗ record History nếu
  // có). Xuất ra 1 file mới ở vị trí tuỳ chọn, KHÔNG đụng tới record History
  // gốc (giống "Save As" của các phần mềm khác: tạo bản sao, giữ nguyên bản gốc).
  const doSaveAs = async () => {
    if (videoDoc) return doSaveAsVideo();
    const url = stageRef.current?.exportPng();
    if (!url) return;
    setBusy(true);
    try {
      const saved = await saveAsToFile(url);
      if (saved) {
        // Ghi lại đường dẫn vừa export — "Xem file trong Thư mục" ở dải "Gần
        // đây"/Library sau này sẽ mở đúng chỗ này thay vì file gốc nội bộ.
        // Không chặn `closeSelf()` nếu lệnh này lỗi (mất tính năng phụ, không
        // phải mất dữ liệu — ảnh đã lưu ra đĩa thành công rồi).
        const historyId = useEditor.getState().doc?.historyId;
        if (historyId) ipc.setHistoryExportedPath(historyId, saved).catch(() => {});
        // "Save As" chỉ XUẤT một file PNG mới, KHÔNG lưu tài liệu — bản chỉnh
        // sửa trong Library vẫn là chưa lưu. Nên cố tình KHÔNG `markSaved()`,
        // mà phải FLUSH bản nháp xuống đĩa TRƯỚC khi đóng: `closeSelf` huỷ
        // webview (đường DUY NHẤT thật sự xoá heap), autosave debounce đang chờ
        // sẽ không bao giờ chạy nữa.
        await flushDraft();
        ipc.closeSelf();
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
      {keptKey && (
        <ResumeBanner
          sessionKey={keptKey}
          onResume={() => resumeSession(keptKey)}
          onDismiss={() => setKeptKey(null)}
        />
      )}
      {draftPromptId && (
        <div style={draftPromptBar} role="status">
          <span style={{ flex: 1, minWidth: 0 }}>{t("editorMain.draftFoundPrompt")}</span>
          <button style={draftKeepBtn} disabled={busy} onClick={() => setDraftPromptId(null)}>
            {t("editorMain.draftKeep")}
          </button>
          <button style={draftDropBtn} disabled={busy} onClick={() => discardDraft(draftPromptId)}>
            {t("editorMain.draftDiscard")}
          </button>
        </div>
      )}
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

// Thanh hỏi "phục hồi bản nháp?" — cùng ngôn ngữ màu amber với `ResumeBanner`
// và badge "chưa lưu": đều là "có việc dở", không phải lỗi.
const draftPromptBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "7px 10px",
  background: "rgba(245,158,11,0.12)",
  borderBottom: "1px solid rgba(245,158,11,0.3)",
  color: "#fbbf24",
  fontSize: 12.5,
  flexShrink: 0,
};

const draftKeepBtn: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 6,
  border: "1px solid rgba(245,158,11,0.45)",
  background: "rgba(245,158,11,0.2)",
  color: "#fcd34d",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const draftDropBtn: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

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
