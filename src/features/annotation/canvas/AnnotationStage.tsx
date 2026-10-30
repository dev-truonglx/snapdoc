import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Stage, Layer, Rect, Line, Ellipse, Text, Circle, Group, Image as KImage, Transformer, Arrow, Path } from "react-konva";
import type Konva from "konva";
import { useTranslation } from "react-i18next";
import { useEditor, EDIT_TOOLS } from "../store";
import type { Annotation, SpotlightAnn, TextAnn } from "../model";
import { annotationBounds, simplifyPoints, translateAnnotation, uid } from "../model";
import { copyToClipboard } from "../../output/useOutput";
import { toSafeBlobUrl } from "../../../lib/blobUtils";
import { getCachedImage, setCachedImage, imageAnnCache } from "./imageCache";
import { SelectionFrame, LineEndpoints, linePts, CalloutBar, LineHandles, getPointOnRoundedRect, getCalloutPath, StepSelectionFrame, drawRoundedRect } from "./selectionShapes";
import { DraftPreview, MarqueePreview, type ArrowDraft, type Box, type Draft, type DraftPreviewHandle, type MarqueePreviewHandle } from "./DraftPreview";
import { fill, zoomBar, zoomChip, zoomChipActive, zoomIconBtn, zoomPctBtn, zoomBtnDisabled, cropBtn, dpiBadge } from "./stageStyles";
import { BlurRect } from "./BlurRect";
import { ImageItem } from "./ImageItem";
import { EmojiItem, MagnifierItem, PenItem, SpotlightHit, SpotlightOverlay } from "./annotationExtras";

export interface StageHandle {
  exportPng: () => string | null;
  exportCropPng: () => string | null;
  hasActiveCrop: () => boolean;
  flattenPng: () => string | null;
  /** Render nhỏ cho thumbnail lịch sử: cạnh dài ≈ 2×`maxEdge` (không vượt 1:1). */
  exportThumbPng: (maxEdge: number) => string | null;
  /** Cả ảnh đã ghép annotation ở 1:1 để lưu làm preview của tài liệu — khác
   * `exportPng`: KHÔNG áp dụng/bỏ vùng crop đang chọn và giữ nguyên selection,
   * nên gọi được ngầm (autosave) giữa lúc user đang thao tác. */
  exportPreviewPng: () => string | null;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
}

const ZOOM_STEP = 1.25;
const SCALE_MIN = 0.01;
const SCALE_MAX = 6.0;
const clampZoom = (z: number, fs: number) => {
  const currentFit = fs > 0 ? fs : 1;
  const minZ = SCALE_MIN / currentFit;
  const maxZ = SCALE_MAX / currentFit;
  return Math.max(minZ, Math.min(maxZ, z));
};

interface AnnotationStageProps {
  /** Ẩn thanh zoom (Fit/100%/±) — dùng cho "Chụp nhanh". Mặc định hiện. */
  hideZoomBar?: boolean;
  onFlash?: (msg: string) => void;
}

/**
 * Component Canvas chỉnh sửa ảnh SnapDoc (React-Konva).
 * Hỗ trợ vẽ vector annotations (text, arrow, rect, ellipse, step counter, highlight, blur)
 * và tương tác chuột mượt mà 60 FPS (zoom quanh con trỏ, pan Space/Middle drag, crop, crop history).
 */
// LRU giới hạn (xem imageCache.ts) — re-export cho Editor.
export { imageAnnCache };

const toSafeImageUrl = (src: string) => toSafeBlobUrl(src, 500_000);

const AnnotationStage = forwardRef<StageHandle, AnnotationStageProps>(({ hideZoomBar, onFlash }, ref) => {
  const { t } = useTranslation();
  const doc = useEditor((s) => s.doc);
  const tool = useEditor((s) => s.tool);
  const color = useEditor((s) => s.color);
  const highlightColor = useEditor((s) => s.highlightColor);
  const strokeWidth = useEditor((s) => s.strokeWidth);
  const fontSize = useEditor((s) => s.fontSize);
  const blurRadius = useEditor((s) => s.blurRadius);
  const blurMode   = useEditor((s) => s.blurMode);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedIds = useEditor((s) => s.selectedIds ?? []);

  const bgConfig = doc?.background?.enabled ? doc.background : null;
  const bgPad = bgConfig ? Math.max(0, bgConfig.padding) : 0;
  const totalW = (doc?.imgW ?? 0) + 2 * bgPad;
  const totalH = (doc?.imgH ?? 0) + 2 * bgPad;

  const containerRef = useRef<HTMLDivElement>(null);
  /** Wrapper NGOÀI `containerRef` — không có `overflow:auto` nên kích thước
   * của nó không bị đổi bởi thanh cuộn xuất hiện/biến mất bên trong. Dùng để
   * đo `fitScale` (xem effect bên dưới) thay vì đo trên `containerRef` chính
   * nó — tránh vòng lặp phản hồi (`ResizeObserver` ↔ thanh cuộn) gây nháy
   * liên tục khi ảnh lớn hơn khung (ví dụ mặc định 100% cho ảnh vùng chọn to). */
  const outerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const cropOverlayGroupRef = useRef<Konva.Group>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const scale = fitScale * zoom;
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Quy đổi toạ độ con trỏ THẬT (clientX/clientY, toàn cửa sổ) sang toạ độ
  // ảnh (image-space: 0..imgW, 0..imgH) — bù trừ bgPad khi có khung nền
  const clientToImg = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.container().getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left) / scale - bgPad,
      y: (clientY - rect.top) / scale - bgPad,
    };
  };

  // Ref luôn trỏ đến giá trị mới nhất — dùng trong wheel handler (closure cũ)
  const fitScaleRef = useRef(fitScale);
  const docRef = useRef(doc);
  useEffect(() => { fitScaleRef.current = fitScale; }, [fitScale]);
  useEffect(() => { docRef.current = doc; }, [doc]);

  // true = zoom đang ở mức mặc định tự động theo rule (ảnh nhỏ hơn khung →
  // 100% thật, ảnh lớn hơn khung → fit vừa khung) và phải tự cập nhật lại mỗi
  // khi khung Editor đổi kích thước (resize/full màn) — xem effect đo
  // `fitScale` bên dưới. Tắt (false) ngay khi user tự tay đổi zoom (wheel,
  // nút +/-, Fit, Actual size) để không ghi đè lựa chọn thủ công của họ.
  const autoZoomRef = useRef(true);

  // Scroll cần apply sau khi React render canvas ở scale mới
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null);

  // --- Pan (kéo để cuộn) ---
  // Kích hoạt bằng Space+drag hoặc middle mouse button.
  const [isPanMode, setIsPanMode]   = useState(false); // Space đang giữ
  const [isPanDrag, setIsPanDrag]   = useState(false); // đang kéo thật sự
  const isPanModeRef = useRef(false);
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  // Hình xem trước đang kéo: state nằm ở `DraftPreview`/`MarqueePreview` (xem doc ở đó).
  const draftPreviewRef = useRef<DraftPreviewHandle>(null);
  const marqueePreviewRef = useRef<MarqueePreviewHandle>(null);
  const setDraft = (d: Draft | null) => draftPreviewRef.current?.setDraft(d);
  const setArrowDraft = (d: ArrowDraft | null) => draftPreviewRef.current?.setArrowDraft(d);
  const setMarqueeBox = (b: Box | null) => marqueePreviewRef.current?.setBox(b);
  const setPenDraft = (pts: number[] | null) => draftPreviewRef.current?.setPenDraft(pts);
  // Con trỏ khi rê vào tay nắm / hình chỉnh được (ghi đè con trỏ mặc định của tool)
  // Đang kéo THÂN 1 hình → ẩn tay nắm (chúng đứng yên ở toạ độ cũ nên sẽ lệch/nhảy khi hình dời)
  const [bodyDragging, setBodyDragging] = useState(false);
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  const [cropRect, setCropRect] = useState<Draft | null>(null);
  const [cropHistory, setCropHistory] = useState<Draft[]>([]); // Lưu lại crop history
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [textareaSize, setTextareaSize] = useState({ width: 120, height: 60 });
  const hasResizedTextareaRef = useRef(false);
  const minHeightRef = useRef(32);
  // Cờ đồng bộ: bật khi cú click ra ngoài vừa kết thúc 1 ô nhập, để mousedown
  // ngay sau đó KHÔNG tạo ô nhập mới (phải click thêm lần nữa mới tạo).
  const suppressCreateRef = useRef(false);
  
  // Theo dõi khi đang resize crop rect bằng handle hoặc move crop
  const [resizingCropHandle, setResizingCropHandle] = useState<string | null>(null);
  const [cropHoverHandle, setCropHoverHandle] = useState<string | null>(null);
  const [hoveredTextId, setHoveredTextId] = useState<string | null>(null);

  // Reset crop khi chuyển đổi ảnh hoặc chuyển sang công cụ khác
  useEffect(() => {
    setCropRect(null);
    setCropHistory([]);
  }, [doc?.image, doc?.historyId, doc?.filePath]);

  useEffect(() => {
    if (tool !== "crop") {
      setCropRect(null);
      setCropHistory([]);
    }
  }, [tool]);

  // Focus tường minh ô nhập chữ khi bắt đầu sửa. `autoFocus` không đáng tin
  // trong webview (Tauri) khi phần tử được tạo ngay trong handler mousedown —
  // nếu mất focus, phím gõ rơi xuống window và bị hiểu thành phím tắt công cụ.
  useEffect(() => {
    // Đồng bộ trạng thái "đang gõ chữ" lên store để phím tắt công cụ
    // (v/r/o/t/n/c) không cướp ký tự dù focus chưa về textarea.
    useEditor.getState().setEditingText(editing?.id ?? null);
    if (!editing) return;
    const id = window.setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.select();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [editing?.id]);

  // Lưu lại text khi click chuột ra ngoài textarea
  const commitTextRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!editing) return;

    const handleOutsideClick = (e: PointerEvent) => {
      const container = textareaRef.current?.parentElement;
      if (container && !container.contains(e.target as Node)) {
        // Cú click này CHỈ để kết thúc nhập → chặn mousedown ngay sau tạo ô mới.
        // Reset ở tick sau để click kế tiếp vẫn tạo được ô mới bình thường.
        suppressCreateRef.current = true;
        window.setTimeout(() => {
          suppressCreateRef.current = false;
        }, 0);
        commitTextRef.current?.();
      }
    };

    document.addEventListener("pointerdown", handleOutsideClick, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideClick, true);
    };
  }, [!!editing]);

  // Tải ảnh nền. Cờ `cancelled`: undo/redo/crop/stitch đổi `doc.image` liên
  // tiếp — decode của ảnh CŨ (to hơn → chậm hơn) có thể resolve SAU ảnh mới
  // và ghi đè `img` bằng ảnh sai; huỷ trong cleanup để chỉ lần load mới nhất
  // được set (cùng pattern StitchDialog).
  useEffect(() => {
    if (!doc) {
      setImg(null);
      setImgLoading(false);
      return;
    }
    const safe = toSafeImageUrl(doc.image);
    // Kiểm tra cache: nếu ảnh đã từng giải mã (decode) trong RAM, nạp ngay lập tức 0ms, không hiển thị spinner
    const cached = getCachedImage(safe.url);
    if (cached) {
      setImg(cached);
      setImgLoading(false);
      safe.revoke?.();
      return;
    }

    let cancelled = false;
    setImgLoading(true);
    const el = new window.Image();

    const onDone = () => {
      if (!cancelled) {
        if (el.complete && el.naturalWidth > 0) {
          setCachedImage(safe.url, el);
        }
        setImg(el);
        setImgLoading(false);
      }
    };

    if (typeof el.decode === "function") {
      el.src = safe.url;
      el.decode().then(onDone).catch(onDone);
    } else {
      el.onload = onDone;
      el.onerror = onDone;
      el.src = safe.url;
    }

    return () => {
      cancelled = true;
      el.onload = null;
      el.onerror = null;
      safe.revoke?.();
    };
  }, [doc?.image]);

  // Tính fitScale để ảnh vừa container, đặt zoom mặc định khi tải ảnh mới —
  // và tính lại MỖI LẦN khung Editor đổi kích thước (resize/full màn), không
  // chỉ lúc tải ảnh, miễn user chưa tự tay chỉnh zoom (xem `autoZoomRef`).
  useLayoutEffect(() => {
    if (!doc) return;
    autoZoomRef.current = true; // ảnh mới → về lại chế độ zoom mặc định tự động
    const measure = () => {
      // Đo trên `outerRef` (KHÔNG có overflow:auto) — xem giải thích ở khai
      // báo `outerRef`. Đo trên `containerRef` (vùng cuộn thật) sẽ gây vòng
      // lặp: ảnh tràn khung → thanh cuộn xuất hiện → content-box containerRef
      // co lại → ResizeObserver bắn lại → fitScale đổi → scale đổi → box đổi
      // → có thể lại vừa khung → mất thanh cuộn → containerRef giãn lại → lặp
      // vô hạn — đúng nguyên nhân nháy liên tục khi ảnh lớn hơn khung (ví dụ
      // mặc định 100% cho ảnh vùng chọn to).
      const c = outerRef.current;
      if (!c) return;
      // Padding nhỏ (8px mỗi bên) để ảnh không dính mép cứng
      const cw = c.clientWidth - 16;
      const ch = c.clientHeight - 16;
      const isScroll = doc.captureMode === "scroll" || doc.imgH > doc.imgW * 1.8;

      // Với ảnh dài / chụp cuộn: fit theo chiều ngang (fit-width) để chữ to rõ, dễ đọc và cuộn dọc tự nhiên
      // Với ảnh thông thường: fit cả 2 chiều (fit-contain)
      const s = Math.max(0.01, Math.min(cw / totalW, isScroll ? 1.0 : ch / totalH));
      setFitScale(s);

      // Zoom mặc định tuỳ mode đã chụp ra ảnh:
      // "scroll" → hiện theo chiều ngang (zoom=1 ⇒ scale=fitScale)
      // "region" → nếu ảnh nhỏ hơn khung thì 100% thật (zoom=1/s ⇒ scale=1), lớn hơn thì vừa khung
      if (autoZoomRef.current) {
        if (isScroll) {
          setZoom(1);
        } else {
          setZoom(s ? (s < 1 ? 1 : clampZoom(1 / s, s)) : 1);
        }
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (outerRef.current) ro.observe(outerRef.current);
    return () => ro.disconnect();
  }, [doc?.imgW, doc?.imgH, doc?.captureMode, totalW, totalH]);

  // Cập nhật kích thước stage khi scale thay đổi
  useEffect(() => {
    if (!doc) return;
    setBox({ w: totalW * scale, h: totalH * scale });
  }, [scale, totalW, totalH]);

  // Trần pixelRatio của canvas (tính lúc render, xem `stagePixelRatio`). Prop
  // `pixelRatio` của <Stage> KHÔNG có tác dụng ở Konva 10 — canvas của Layer
  // luôn lấy devicePixelRatio — nên áp thẳng lên canvas của Layer. Konva giữ
  // tỉ lệ này khi Stage đổi kích thước (zoom).
  const stagePixelRatioRef = useRef(1);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const canvas = layer.getCanvas();
    if (Math.abs(canvas.getPixelRatio() - stagePixelRatioRef.current) < 1e-3) return;
    canvas.setPixelRatio(stagePixelRatioRef.current);
    layer.batchDraw();
  });

  // Gắn Transformer vào node đang chọn (chỉ khi chọn đơn 1 phần tử)
  useEffect(() => {
    const tr = trRef.current;
    const layer = layerRef.current;
    if (!tr || !layer) return;
    const activeIds = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (activeIds.length === 1 && (tool === "select" || tool === "text" || EDIT_TOOLS.has(tool)) && editing?.id !== activeIds[0]) {
      const node = layer.findOne("#" + activeIds[0]);
      tr.nodes(node ? [node] : []);
    } else {
      tr.nodes([]);
    }
    layer.batchDraw();
  }, [selectedId, selectedIds, tool, doc, editing?.id]);

  // Zoom giữ nguyên điểm (vx,vy) — toạ độ trong viewport container (px từ mép
  // trái/trên). Dùng chung cho wheel/pinch, nút bấm và phím tắt nên mọi đường
  // vào zoom đều neo đúng tâm, không bị "trôi" ảnh. Truyền factor (nhân vào zoom)
  // hoặc target (zoom tuyệt đối). Logic scroll-centering dẫn xuất từ phương trình
  // "cursor ≡ canvas_left + imageX × scale" (xem comment wheel bên dưới).
  const zoomAround = (vx: number, vy: number, opts: { factor?: number; target?: number }) => {
    const el = containerRef.current;
    if (!el) return;
    autoZoomRef.current = false; // user tự chỉnh zoom → thôi tự động tính lại khi resize
    setZoom((oldZoom) => {
      const fs = fitScaleRef.current;
      const d = docRef.current;
      if (!d) return oldZoom;

      const newZoom = clampZoom(opts.target ?? oldZoom * (opts.factor ?? 1), fs);
      if (newZoom === oldZoom) return oldZoom; // đã chạm giới hạn → không đổi

      const oldScale = fs * oldZoom;
      const newScale = fs * newZoom;
      const containerW = el.clientWidth;
      const containerH = el.clientHeight;
      const curBgPad = d.background?.enabled ? Math.max(0, d.background.padding) : 0;
      const curTotalW = d.imgW + 2 * curBgPad;
      const curTotalH = d.imgH + 2 * curBgPad;

      const oldOffsetX = Math.max(0, (containerW - curTotalW * oldScale) / 2);
      const oldOffsetY = Math.max(0, (containerH - curTotalH * oldScale) / 2);
      const imageX = (el.scrollLeft + vx - oldOffsetX) / oldScale;
      const imageY = (el.scrollTop  + vy - oldOffsetY) / oldScale;

      const newOffsetX = Math.max(0, (containerW - curTotalW * newScale) / 2);
      const newOffsetY = Math.max(0, (containerH - curTotalH * newScale) / 2);
      pendingScrollRef.current = {
        x: Math.max(0, newOffsetX + imageX * newScale - vx),
        y: Math.max(0, newOffsetY + imageY * newScale - vy),
      };
      return newZoom;
    });
  };

  // Zoom quanh tâm viewport — cho nút bấm và phím tắt (không có vị trí con trỏ).
  const zoomCenter = (opts: { factor?: number; target?: number }) => {
    const el = containerRef.current;
    if (!el) return;
    zoomAround(el.clientWidth / 2, el.clientHeight / 2, opts);
  };

  // Smooth cursor-centered zoom qua scroll wheel / trackpad pinch.
  //
  // Trên macOS WKWebView (Tauri): pinch trackpad → WheelEvent { ctrlKey:true,
  // deltaMode:0, deltaY: nhỏ (~1-30) }. Mouse wheel thường deltaMode:1 (lines).
  // Dùng exponential zoom: factor = exp(-δ × k) để tốc độ cảm giác tuyến tính
  // với lực ngón tay (khác discrete ×1.25 cảm giác giật).
  //
  // Scroll centering: khi zoom thay đổi, offset của canvas trong scroll content
  // tính theo: offsetX = max(0, (containerW − canvasW) / 2).
  // Để điểm ảnh dưới con trỏ giữ nguyên:
  //   newScrollLeft = newOffsetX + imageX × newScale − cursorVX
  // (dẫn xuất từ phương trình "cursor ≡ canvas_left + imageX × scale").
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Chỉ bắt khi có modifier (Ctrl/Cmd = pinch trackpad trên macOS/WKWebView)
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      const currentDoc = docRef.current;
      if (!currentDoc) return;

      // Chuẩn hoá delta về đơn vị pixel (deltaMode:1 = dòng, :2 = trang)
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      if (e.deltaMode === 2) delta *= 600;

      // Exponential: cảm giác mượt, tốc độ tỉ lệ lực vuốt
      const factor = Math.exp(-delta * 0.001);

      const containerRect = el.getBoundingClientRect();
      // Vị trí con trỏ trong viewport của container (pixels) → zoom neo tại đó.
      zoomAround(e.clientX - containerRect.left, e.clientY - containerRect.top, { factor });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  // !!doc: chỉ re-attach khi doc từ null → có giá trị (lần ảnh đầu load).
  // Lúc mount, doc=null → containerRef trỏ vào fallback div → không gắn.
  // Sau khi doc load → re-render → containerRef trỏ đúng scroll container.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!doc]);

  // Space key → bật/tắt pan mode (giữ Space = tay kéo ảnh)
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (useEditor.getState().editingTextId) return;
      e.preventDefault();
      isPanModeRef.current = true;
      setIsPanMode(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      isPanModeRef.current = false;
      setIsPanMode(false);
      setIsPanDrag(false);
      panRef.current = null;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // Keyboard shortcuts: Delete để xóa crop, Escape để hủy, Ctrl/Cmd+Z để undo crop, Ctrl/Cmd+C để copy crop
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Bỏ qua nếu đang nhập text
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (useEditor.getState().editingTextId) return;

      // Ctrl/Cmd+C: copy phần ảnh trong khung crop
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && cropRect) {
        e.preventDefault();
        e.stopPropagation();
        handleCopyCrop();
        return;
      }

      // Ctrl/Cmd+Z: undo crop (nếu có crop history)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey && cropRect && cropHistory.length > 0) {
        e.preventDefault();
        undoCrop();
        return;
      }

      // Delete hoặc Backspace: xóa crop rect
      if ((e.key === "Delete" || e.key === "Backspace") && cropRect) {
        e.preventDefault();
        setCropRect(null);
        setCropHistory([]);
        useEditor.getState().setTool("select");
        return;
      }

      // Escape: hủy crop
      if (e.key === "Escape" && cropRect) {
        e.preventDefault();
        setCropRect(null);
        setCropHistory([]);
        useEditor.getState().setTool("select");
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cropRect, cropHistory, scale, doc]);

  // Pointer events trên scroll container cho pan.
  // Dùng setPointerCapture để tiếp tục nhận move/up kể cả khi chuột ra ngoài.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      const isMid = e.button === 1;
      if (!isPanModeRef.current && !isMid) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
      setIsPanDrag(true);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!panRef.current) return;
      el.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.x);
      el.scrollTop  = panRef.current.st - (e.clientY - panRef.current.y);
    };
    const onPointerUp = () => {
      if (!panRef.current) return;
      panRef.current = null;
      setIsPanDrag(false);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup",   onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup",   onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!doc]);

  // Bắt đầu vẽ vùng crop mới bằng native mousedown trên SCROLL CONTAINER (to
  // hơn hẳn khung <canvas> của Konva) — không chỉ Stage — để: (1) cho phép
  // bấm bắt đầu ngay sát/hơi ngoài mép ảnh vài chục pixel (Stage chỉ rộng
  // đúng bằng ảnh nên bấm trượt ra ngoài 1px là không ăn); (2) tiếp tục nhận
  // mousemove/mouseup qua `window` thay vì qua canvas — khi kéo ra khỏi canvas
  // (rất dễ xảy ra khi kéo tới sát mép ảnh), Konva NGỪNG nhận mousemove (canvas
  // không còn dưới con trỏ) khiến khung crop bị "dính" tại mép rồi giật khi
  // chuột quay lại. `beginCropPointerDrag` (bên dưới, sau khi có `doc`) dùng
  // kỹ thuật tương tự để resize/move khung crop đã có.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (isPanModeRef.current) return;
      if (tool !== "crop" || cropRect) return;
      const d = docRef.current;
      if (!d) return;
      const rect = stageRef.current?.container().getBoundingClientRect();
      if (!rect) return;
      const margin = 24; // dung sai (px) quanh mép ảnh để dễ bắt đầu kéo
      if (
        e.clientX < rect.left - margin || e.clientX > rect.right + margin ||
        e.clientY < rect.top - margin || e.clientY > rect.bottom + margin
      ) {
        return;
      }
      e.preventDefault();
      const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
      const start = clientToImg(e.clientX, e.clientY);
      const startX = clamp(start.x, d.imgW);
      const startY = clamp(start.y, d.imgH);
      setDraft({ type: "crop", x: startX, y: startY, width: 0, height: 0 });

      const onMove = (me: MouseEvent) => {
        const p = clientToImg(me.clientX, me.clientY);
        const x = clamp(p.x, d.imgW);
        const y = clamp(p.y, d.imgH);
        setDraft({ type: "crop", x: startX, y: startY, width: x - startX, height: y - startY });
      };
      const onUp = (ue: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const p = clientToImg(ue.clientX, ue.clientY);
        const x = clamp(p.x, d.imgW);
        const y = clamp(p.y, d.imgH);
        setDraft(null);
        const nx = Math.min(startX, x);
        const ny = Math.min(startY, y);
        const w = Math.abs(x - startX);
        const h = Math.abs(y - startY);
        if (w < 4 || h < 4) return;
        const newCrop: Draft = { type: "crop", x: nx, y: ny, width: w, height: h };
        setCropRect(newCrop);
        setCropHistory((prev) => [...prev.slice(-9), newCrop]);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, cropRect, scale]);

  // Apply scroll sau khi React render xong canvas ở scale mới
  useLayoutEffect(() => {
    const el = containerRef.current;
    const p = pendingScrollRef.current;
    if (!el || !p) return;
    el.scrollLeft = p.x;
    el.scrollTop  = p.y;
    pendingScrollRef.current = null;
  }, [zoom]);

  const doZoomIn  = () => zoomCenter({ factor: ZOOM_STEP });
  const doZoomOut = () => zoomCenter({ factor: 1 / ZOOM_STEP });
  // Fit: zoom=1 ⇒ scale=fitScale (ảnh vừa khung). Canvas ≤ container nên flex tự
  // canh giữa, không cần bù scroll.
  const doZoomFit = () => { autoZoomRef.current = false; pendingScrollRef.current = null; setZoom(1); };
  // Actual size 1:1 pixel: scale=1 ⇒ zoom = 1/fitScale. Neo tâm viewport.
  const doZoomActual = () => zoomCenter({ target: 1 / fitScaleRef.current });
  // Toggle nhanh giữa Fit và 100% khi bấm vào ô phần trăm.
  const toggleFitActual = () =>
    Math.abs(scale - 1) < 0.001 ? doZoomFit() : doZoomActual();

  /**
   * Xuất ảnh PNG chất lượng gốc 1:1 (Master Resolution).
   * - Nếu không có annotation: vẽ trực tiếp từ `HTMLImageElement` gốc lên canvas 1:1 (chuẩn tuyệt đối 100%, không qua resample).
   * - Nếu có annotation: tạm đặt scale Layer về 1:1 rồi để Konva vẽ vector sắc nét vào 1 canvas RIÊNG đúng kích thước gốc (`toDataURL` với width/height tường minh), xong trả scale xem — KHÔNG đổi kích thước Stage đang hiển thị (đổi = Konva cấp phát lại + vẽ lại mọi canvas của Stage ở full-res, 2 lần mỗi lần xuất/thumbnail).
   * - `thumbPixelRatio` (chỉ dùng cho thumbnail): render thu nhỏ theo tỉ lệ này và giữ nguyên Transformer đang chọn.
   */
  const renderMasterPng = (
    cropArea?: { x: number; y: number; width: number; height: number } | null,
    thumbPixelRatio?: number,
  ): string | null => {
    if (!doc || !img) return null;

    const imgW = doc.imgW;
    const imgH = doc.imgH;
    const pr = thumbPixelRatio ?? 1;

    // 1. Trường hợp không có annotation nào và không có background: xuất trực tiếp từ ảnh gốc img
    if (doc.annotations.length === 0 && !bgConfig) {
      if (cropArea) {
        const rx = cropArea.width < 0 ? cropArea.x + cropArea.width : cropArea.x;
        const ry = cropArea.height < 0 ? cropArea.y + cropArea.height : cropArea.y;
        const rw = Math.abs(cropArea.width);
        const rh = Math.abs(cropArea.height);
        if (rw <= 0 || rh <= 0) return null;

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(rw * pr));
        canvas.height = Math.max(1, Math.round(rh * pr));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, rx, ry, rw, rh, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      } else {
        if (pr >= 1 && doc.image.startsWith("data:")) {
          return doc.image;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(imgW * pr));
        canvas.height = Math.max(1, Math.round(imgH * pr));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      }
    }

    // 2. Trường hợp có annotations hoặc có background: render qua Konva ở độ phân giải 1:1 chuẩn xác
    const stage = stageRef.current;
    const layer = layerRef.current;
    if (!stage || !layer) return null;

    // Lưu lại scale hiển thị hiện tại của Layer
    const prevScaleX = layer.scaleX();
    const prevScaleY = layer.scaleY();

    // Ẩn Transformer và khung chọn crop (thumbnail: nhớ để gắn lại sau)
    const prevTrNodes = thumbPixelRatio !== undefined ? trRef.current?.nodes() ?? [] : [];
    trRef.current?.nodes([]);
    cropOverlayGroupRef.current?.hide();

    // Layer về tỉ lệ gốc 1:1 (Stage giữ nguyên kích thước xem — vùng xuất
    // truyền tường minh bên dưới, Konva vẽ vào canvas riêng của `toDataURL`).
    layer.scale({ x: 1, y: 1 });

    let dataUrl: string | null = null;
    if (cropArea) {
      const rx = (cropArea.width < 0 ? cropArea.x + cropArea.width : cropArea.x) + bgPad;
      const ry = (cropArea.height < 0 ? cropArea.y + cropArea.height : cropArea.y) + bgPad;
      const rw = Math.abs(cropArea.width);
      const rh = Math.abs(cropArea.height);
      dataUrl = stage.toDataURL({
        x: rx,
        y: ry,
        width: rw,
        height: rh,
        pixelRatio: pr,
        mimeType: "image/png",
      });
    } else {
      dataUrl = stage.toDataURL({
        x: 0,
        y: 0,
        width: totalW,
        height: totalH,
        pixelRatio: pr,
        mimeType: "image/png",
      });
    }

    // Hoàn trả scale viewport của Layer
    layer.scale({ x: prevScaleX, y: prevScaleY });
    cropOverlayGroupRef.current?.show();
    if (prevTrNodes.length > 0) trRef.current?.nodes(prevTrNodes);
    layer.batchDraw();

    return dataUrl;
  };

  const exportCropDataUrl = (): string | null => {
    return renderMasterPng(cropRect);
  };

  const handleCopyCrop = async () => {
    const dataUrl = exportCropDataUrl();
    if (!dataUrl) return;
    setCropRect(null);
    setCropHistory([]);
    useEditor.getState().setTool("select");
    try {
      await copyToClipboard(dataUrl);
      onFlash?.(t("editorMain.copiedClipboard"));
    } catch (err) {
      console.error("Failed to copy crop to clipboard:", err);
    }
  };

  useImperativeHandle(ref, () => ({
    exportPng: () => {
      if (!doc) return null;
      if (cropRect) {
        const cropData = renderMasterPng(cropRect);
        setCropRect(null);
        setCropHistory([]);
        useEditor.getState().setTool("select");
        if (cropData) return cropData;
      }
      return renderMasterPng(null);
    },
    exportCropPng: exportCropDataUrl,
    hasActiveCrop: () => Boolean(cropRect),
    flattenPng: () => {
      if (!doc) return null;
      return renderMasterPng(null);
    },
    exportThumbPng: (maxEdge: number) => {
      if (!doc) return null;
      // 2× cạnh đích cho nét, không bao giờ vượt 1:1
      const longest = Math.max(totalW, totalH, 1);
      return renderMasterPng(null, Math.min(1, (maxEdge * 2) / longest));
    },
    exportPreviewPng: () => {
      if (!doc) return null;
      // Truyền pixelRatio tường minh (= 1) để renderMasterPng giữ Transformer.
      return renderMasterPng(null, 1);
    },
    zoomIn:  doZoomIn,
    zoomOut: doZoomOut,
    zoomFit: doZoomFit,
  }));

  // Không gắn ref vào fallback: containerRef chỉ trỏ scroll container khi doc sẵn sàng,
  // tránh wheel listener bị attach vào div đã unmount khi doc load sau.
  const toImg = (p: { x: number; y: number }) => ({
    x: p.x / scale - bgPad,
    y: p.y / scale - bgPad,
  });

  // Helper function để lấy cursor cho crop handles
  const getCropCursor = (handleId: string): string => {
    if (handleId === "move") return "grab";
    if (handleId.includes("top-left") || handleId.includes("bottom-right")) return "nwse-resize";
    if (handleId.includes("top-right") || handleId.includes("bottom-left")) return "nesw-resize";
    if (handleId.includes("top") || handleId.includes("bottom")) return "ns-resize";
    if (handleId.includes("left") || handleId.includes("right")) return "ew-resize";
    return "default";
  };

  // Helper function để lưu crop vào history
  const saveCropToHistory = (crop: Draft) => {
    setCropHistory(prev => [...prev.slice(-9), crop]); // Giữ tối đa 10 trạng thái
  };

  // Bắt đầu resize (theo 1 trong 8 handle) hoặc move (kéo cả khung) crop rect
  // đã có. Dùng `window` mousemove/mouseup (giống `beginCropDraft` ở effect
  // phía trên) thay vì Konva Stage onMouseMove/onMouseUp — tránh bị "dính" khi
  // kéo handle/khung ra sát mép ảnh (Stage chỉ rộng đúng bằng ảnh nên con trỏ
  // rời khỏi đó là Konva ngừng nhận mousemove).
  const beginCropPointerDrag = (handleId: string, clientX: number, clientY: number) => {
    if (!cropRect || !doc) return;
    const start = clientToImg(clientX, clientY);
    const startSnap = {
      cropX: cropRect.x, cropY: cropRect.y, cropW: cropRect.width, cropH: cropRect.height,
      startX: start.x, startY: start.y, isMove: handleId === "move",
    };
    setResizingCropHandle(handleId);
    let latestCrop: Draft = cropRect;

    const onMove = (e: MouseEvent) => {
      const p = clientToImg(e.clientX, e.clientY);
      const dx = p.x - startSnap.startX;
      const dy = p.y - startSnap.startY;

      if (startSnap.isMove) {
        const newX = Math.max(0, Math.min(startSnap.cropX + dx, doc.imgW - startSnap.cropW));
        const newY = Math.max(0, Math.min(startSnap.cropY + dy, doc.imgH - startSnap.cropH));
        latestCrop = { type: "crop", x: newX, y: newY, width: startSnap.cropW, height: startSnap.cropH };
        setCropRect(latestCrop);
        return;
      }

      let newX = startSnap.cropX;
      let newY = startSnap.cropY;
      let newW = startSnap.cropW;
      let newH = startSnap.cropH;

      if (handleId.includes("top")) {
        newY = Math.min(startSnap.cropY + dy, startSnap.cropY + startSnap.cropH - 8);
        newH = startSnap.cropH - dy;
      }
      if (handleId.includes("bottom")) {
        newH = Math.max(startSnap.cropH + dy, 8);
      }
      if (handleId.includes("left")) {
        newX = Math.min(startSnap.cropX + dx, startSnap.cropX + startSnap.cropW - 8);
        newW = startSnap.cropW - dx;
      }
      if (handleId.includes("right")) {
        newW = Math.max(startSnap.cropW + dx, 8);
      }

      newX = Math.max(0, Math.min(newX, doc.imgW - 8));
      newY = Math.max(0, Math.min(newY, doc.imgH - 8));
      newW = Math.min(newW, doc.imgW - newX);
      newH = Math.min(newH, doc.imgH - newY);

      latestCrop = { type: "crop", x: newX, y: newY, width: newW, height: newH };
      setCropRect(latestCrop);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizingCropHandle(null);
      saveCropToHistory(latestCrop);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Undo crop
  const undoCrop = () => {
    if (cropHistory.length === 0) return;
    const history = [...cropHistory];
    const prevCrop = history.pop();
    setCropHistory(history);
    if (prevCrop && history.length > 0) {
      setCropRect(history[history.length - 1]);
    } else {
      setCropRect(null);
      useEditor.getState().setTool("select");
    }
  };

  // Vẽ rect/ellipse/highlight/blur bằng window mousemove/mouseup (giống kỹ
  // thuật `beginCropPointerDrag` ở trên) thay vì dựa vào Konva Stage
  // onMouseMove/onMouseUp — Stage chỉ rộng đúng bằng ảnh nên khi kéo ra sát
  // mép/ngoài ảnh, Konva ngừng nhận mousemove và (nếu thả chuột ở ngoài) không
  // bao giờ nhận được mouseup, khiến khung vẽ bị "dính" và tiếp tục bám theo
  // con trỏ ở lần kéo sau. Toạ độ luôn được clamp vào [0, imgW]/[0, imgH].
  const beginShapeDraft = (
    type: "rect" | "ellipse" | "highlight" | "blur" | "numbered-rect" | "spotlight",
    startX: number,
    startY: number,
  ) => {
    const d = docRef.current;
    if (!d) return;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    const sx = clamp(startX, d.imgW);
    const sy = clamp(startY, d.imgH);
    setDraft({ type, x: sx, y: sy, width: 0, height: 0 });

    const onMove = (me: MouseEvent) => {
      const p = clientToImg(me.clientX, me.clientY);
      const x = clamp(p.x, d.imgW);
      const y = clamp(p.y, d.imgH);
      setDraft({ type, x: sx, y: sy, width: x - sx, height: y - sy });
    };
    const onUp = (ue: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const p = clientToImg(ue.clientX, ue.clientY);
      const x = clamp(p.x, d.imgW);
      const y = clamp(p.y, d.imgH);
      setDraft(null);
      const nx = Math.min(sx, x);
      const ny = Math.min(sy, y);
      const width = Math.abs(x - sx);
      const height = Math.abs(y - sy);
      if (width < 4 || height < 4) return;
      if (type === "highlight") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "highlight",
          x: nx, y: ny, width, height,
          color: highlightColor, strokeWidth,
        });
        return;
      }
      if (type === "spotlight") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "spotlight",
          x: nx, y: ny, width, height,
          shape: useEditor.getState().spotlightShape,
          dim: 0.6,
        });
        return;
      }
      if (type === "blur") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "blur",
          x: nx, y: ny, width, height,
          color: "#000", strokeWidth,
          blurRadius,
          blurMode: useEditor.getState().blurMode,
          solidColor: useEditor.getState().blurSolidColor,
        });
        return;
      }
      if (type === "numbered-rect") {
        const value = useEditor.getState().nextRectStep();
        const radius = Math.max(Math.round(strokeWidth * 2 + 5), 10);
        const isLeft = x >= sx;
        const isTop = y >= sy;
        const corner: "tl" | "tr" | "bl" | "br" =
          isLeft && isTop ? "tl" :
          !isLeft && isTop ? "tr" :
          isLeft && !isTop ? "bl" : "br";

        useEditor.getState().addAnnotation({
          id: uid(),
          type: "numbered-rect",
          x: nx,
          y: ny,
          width,
          height,
          value,
          radius,
          color,
          strokeWidth,
          corner,
        });
        return;
      }
      useEditor.getState().addAnnotation({
        id: uid(), type,
        x: nx, y: ny, width, height, color, strokeWidth,
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Bút tự do: gom điểm theo window mousemove (như `beginShapeDraft`), thả
  // chuột thì lưu nét với toạ độ tương đối so với góc trên-trái của nét.
  const beginPenDraft = (startX: number, startY: number) => {
    const d = docRef.current;
    if (!d) return;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    const pts = [clamp(startX, d.imgW), clamp(startY, d.imgH)];
    setPenDraft(pts.slice());
    const onMove = (me: MouseEvent) => {
      const p = clientToImg(me.clientX, me.clientY);
      pts.push(clamp(p.x, d.imgW), clamp(p.y, d.imgH));
      setPenDraft(pts.slice());
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPenDraft(null);
      // Click không kéo → 1 chấm (2 điểm trùng nhau + đầu nét tròn).
      const simple = simplifyPoints(pts.length >= 4 ? pts : [pts[0], pts[1], pts[0], pts[1]]);
      let minX = Infinity;
      let minY = Infinity;
      for (let i = 0; i + 1 < simple.length; i += 2) {
        minX = Math.min(minX, simple[i]);
        minY = Math.min(minY, simple[i + 1]);
      }
      useEditor.getState().addAnnotation({
        id: uid(),
        type: "pen",
        x: minX,
        y: minY,
        points: simple.map((v, i) => (i % 2 === 0 ? v - minX : v - minY)),
        color,
        strokeWidth,
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Tương tự `beginShapeDraft` nhưng cho arrow/double-arrow/line/numbered-arrow.
  const beginArrowDraft = (
    type: "arrow" | "double-arrow" | "line" | "numbered-arrow",
    startX: number,
    startY: number,
  ) => {
    const d = docRef.current;
    if (!d) return;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    const sx = clamp(startX, d.imgW);
    const sy = clamp(startY, d.imgH);
    setArrowDraft({ type, x: sx, y: sy, x2: sx, y2: sy });

    const computeEnd = (clientX: number, clientY: number, shift: boolean) => {
      const p = clientToImg(clientX, clientY);
      let x2 = clamp(p.x, d.imgW);
      let y2 = clamp(p.y, d.imgH);
      if (shift) {
        const dx = x2 - sx;
        const dy = y2 - sy;
        const angle = Math.atan2(dy, dx);
        const snapAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const dist = Math.sqrt(dx * dx + dy * dy);
        x2 = clamp(Math.round(sx + dist * Math.cos(snapAngle)), d.imgW);
        y2 = clamp(Math.round(sy + dist * Math.sin(snapAngle)), d.imgH);
      }
      return { x2, y2 };
    };

    const onMove = (me: MouseEvent) => {
      const { x2, y2 } = computeEnd(me.clientX, me.clientY, me.shiftKey);
      setArrowDraft({ type, x: sx, y: sy, x2, y2 });
    };
    const onUp = (ue: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const { x2, y2 } = computeEnd(ue.clientX, ue.clientY, ue.shiftKey);
      setArrowDraft(null);
      const dx = x2 - sx;
      const dy = y2 - sy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 8) return;
      if (type === "line") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "line",
          x: sx, y: sy, x2, y2,
          color, strokeWidth,
        });
      } else if (type === "arrow") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "arrow",
          x: sx, y: sy, x2, y2,
          color, strokeWidth,
        });
      } else if (type === "double-arrow") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "double-arrow",
          x: sx, y: sy, x2, y2,
          color, strokeWidth,
        });
      } else {
        const value = useEditor.getState().nextArrowStep();
        const radius = Math.max(Math.round(strokeWidth * 2 + 5), 10);
        useEditor.getState().addAnnotation({
          id: uid(), type: "numbered-arrow",
          x: sx, y: sy, x2, y2,
          value, radius, color, strokeWidth,
        });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Quét vùng chọn (Marquee selection) khi ở tool select
  const beginMarqueeSelection = (startX: number, startY: number, append: boolean) => {
    const onMove = (me: MouseEvent) => {
      const p = clientToImg(me.clientX, me.clientY);
      const x1 = Math.min(startX, p.x);
      const y1 = Math.min(startY, p.y);
      const w = Math.abs(p.x - startX);
      const h = Math.abs(p.y - startY);
      setMarqueeBox({ x: x1, y: y1, width: w, height: h });
    };

    const onUp = (ue: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const p = clientToImg(ue.clientX, ue.clientY);
      const x1 = Math.min(startX, p.x);
      const y1 = Math.min(startY, p.y);
      const x2 = Math.max(startX, p.x);
      const y2 = Math.max(startY, p.y);
      const w = x2 - x1;
      const h = y2 - y1;
      setMarqueeBox(null);

      if (w < 4 && h < 4) return;

      const d = docRef.current;
      if (!d) return;

      const hitIds = d.annotations
        .filter((a) => {
          const b = annotationBounds(a);
          return !(b.x2 < x1 || b.x1 > x2 || b.y2 < y1 || b.y1 > y2);
        })
        .map((a) => a.id);

      if (hitIds.length > 0) {
        useEditor.getState().selectMany(hitIds, append);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    // Pan mode (Space giữ) hoặc middle-button → nhường cho pointer handler
    if (isPanModeRef.current || e.evt.button === 1) return;
    // Bấm vào tay nắm / anchor của Transformer → để chúng tự xử lý, không vẽ/bỏ chọn
    if (e.target.name() === "handle" || e.target.getParent()?.className === "Transformer") return;
    // Crop: bắt đầu vẽ/resize/move được xử lý riêng qua native mousedown trên
    // containerRef (effect ở trên) + window mousemove/mouseup, để không bị
    // "dính/giật" khi kéo sát mép ảnh — xem effect ngay sau phần pan ở trên.
    if (tool === "crop") return;
    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const { x, y } = toImg(pos);

    if (tool === "select") {
      if (e.target === stage || e.target.id() === "bg") {
        const isMulti = e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey;
        if (!isMulti) {
          useEditor.getState().select(null);
        }
        beginMarqueeSelection(x, y, isMulti);
      }
      return;
    }

    if (EDIT_TOOLS.has(tool)) {
      // Click trúng hình đã vẽ (đang chỉnh được) → chọn nó, để Konva xử lý kéo/resize
      let n: Konva.Node | null = e.target;
      let hit: Annotation | undefined;
      while (n && n !== (stage as Konva.Node)) {
        const nid = n.id();
        if (nid && (hit = doc?.annotations.find((x) => x.id === nid))) break;
        n = n.parent;
      }
      if (hit && dragFor(hit)) {
        useEditor.getState().select(hit.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey);
        return;
      }
      useEditor.getState().select(null);
    }

    if (tool === "rect" || tool === "ellipse" || tool === "highlight" || tool === "blur" || tool === "numbered-rect" || tool === "spotlight") {
      beginShapeDraft(tool, x, y);
      return;
    }
    if (tool === "pen") {
      beginPenDraft(x, y);
      return;
    }
    if (tool === "magnifier" || tool === "emoji") {
      if (!doc) return;
      // Kích thước mặc định theo cỡ ảnh (ảnh 4K không ra 1 chấm bé, ảnh nhỏ không bị che kín).
      const base = Math.min(doc.imgW, doc.imgH);
      const st = useEditor.getState();
      if (tool === "magnifier") {
        st.addAnnotation({
          id: uid(), type: "magnifier", x, y,
          radius: Math.round(Math.max(40, Math.min(160, base * 0.1))),
          zoom: st.magnifierZoom, color, strokeWidth,
        });
      } else {
        const size = Math.round(Math.max(28, Math.min(120, base * 0.07)));
        st.addAnnotation({ id: uid(), type: "emoji", x: x - size / 2, y: y - size / 2, emoji: st.currentEmoji, size });
      }
      return;
    }
    if (tool === "arrow" || tool === "double-arrow" || tool === "line" || tool === "numbered-arrow") {
      beginArrowDraft(tool, x, y);
      return;
    }
    if (tool === "step") {
      const value = useEditor.getState().nextStep();
      useEditor.getState().addAnnotation({
        id: uid(),
        type: "step",
        x,
        y,
        value,
        radius: Math.max(Math.round(strokeWidth * 2 + 5), 10),
        color,
        strokeWidth,
      });
      return;
    }
    if (tool === "text") {
      // Cú click ra ngoài vừa kết thúc 1 ô nhập (handleOutsideClick ở pointerdown
      // capture chạy TRƯỚC mousedown này và đã commit + bật cờ). Lần này chỉ kết
      // thúc nhập, KHÔNG tạo ô mới — phải click thêm lần nữa mới tạo.
      if (suppressCreateRef.current) {
        suppressCreateRef.current = false;
        return;
      }
      // Chặn default action của mousedown — nếu không, sau khi handler chạy
      // trình duyệt sẽ giật focus về <canvas> của Konva, làm textarea blur ngay
      // (onBlur → commitText rỗng → annotation bị xoá trước khi gõ được chữ).
      e.evt.preventDefault();
      // Click trúng chữ đã có → chọn nó (click nhả chuột sẽ mở ô sửa, kéo thì di chuyển)
      {
        let n: Konva.Node | null = e.target;
        while (n && n !== (stage as Konva.Node)) {
          const nid = n.id();
          const hit = nid ? doc?.annotations.find((x) => x.id === nid) : undefined;
          if (hit?.type === "text") {
            useEditor.getState().select(hit.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey);
            return;
          }
          n = n.parent;
        }
        useEditor.getState().select(null);
      }
      const curBgColor = useEditor.getState().textBgColor;
      const assignedBg = curBgColor || undefined;
      const id = uid();
      useEditor.getState().addAnnotation({
        id,
        type: "text",
        x,
        y,
        text: "",
        fontSize,
        color,
        strokeWidth,
        bgColor: assignedBg,
      });
      beginEdit(id, "");
    }
  };

  // Vẽ rect/ellipse/highlight/blur/arrow/line/numbered-arrow/numbered-rect giờ được kéo
  // hoàn toàn qua `beginShapeDraft`/`beginArrowDraft` (window mousemove/
  // mouseup) — xem 2 hàm đó ở trên, nên Stage không cần onMouseMove/onMouseUp
  // riêng cho việc này nữa.

  const onDragEnd = (id: string, e: Konva.KonvaEventObject<DragEvent>) => {
    useEditor.getState().updateAnnotation(id, { x: e.currentTarget.x(), y: e.currentTarget.y() });
  };

  // Text: kéo cạnh trái/phải → đổi độ rộng khung; kéo 4 góc → đổi cỡ chữ (giống Figma/Canva).
  const applyTextTransform = (a: TextAnn, node: Konva.Node, commit: boolean) => {
    const anchor = trRef.current?.getActiveAnchor() ?? "";
    const isCorner = /^(top|bottom)-(left|right)$/.test(anchor);
    // Kéo góc: để Konva tự scale hình ảnh trong lúc kéo (đừng reset scale/ghi store
    // giữa chừng — Transformer sẽ tính lại khung và hình nhảy loạn); chốt ở TransformEnd.
    if (isCorner && !commit) return;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    const st = useEditor.getState();
    if (isCorner) {
      const k = Math.max(sx, sy);
      const patch: Partial<TextAnn> = {
        x: node.x(),
        y: node.y(),
        fontSize: Math.max(8, Math.min(200, Math.round((a.fontSize || 22) * k))),
      };
      if (a.width) patch.width = Math.max(30, Math.round(a.width * k));
      st.updateAnnotation(a.id, patch as Partial<Annotation>);
      return;
    }
    const curW = a.width || Math.max(40, (a.text?.length || 1) * (a.fontSize || 22) * 0.62);
    const width = Math.max(30, Math.round(curW * sx));
    if (commit) st.updateAnnotation(a.id, { x: node.x(), y: node.y(), width } as Partial<Annotation>);
    else st.updateAnnotationLive(a.id, { width } as Partial<Annotation>);
  };

  const onTransformEnd = (a: Annotation, node: Konva.Node) => {
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    if (a.type === "ellipse") {
      // Ellipse được đặt theo TÂM (x = a.x + width/2). node.x()/y() trả về tâm,
      // nên phải quy đổi ngược về góc trên-trái theo kích thước MỚI — nếu lấy
      // thẳng node.x()/y() làm a.x/a.y thì hình bị nhảy +width/2 mỗi lần resize.
      const newW = Math.max(4, a.width * sx);
      const newH = Math.max(4, a.height * sy);
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x() - newW / 2,
        y: node.y() - newH / 2,
        width: newW,
        height: newH,
      } as Partial<Annotation>);
    } else if (a.type === "pen") {
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        points: a.points.map((v, i) => (i % 2 === 0 ? v * sx : v * sy)),
      } as Partial<Annotation>);
    } else if (a.type === "magnifier") {
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        radius: Math.max(12, a.radius * Math.max(sx, sy)),
      } as Partial<Annotation>);
    } else if (a.type === "emoji") {
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        size: Math.max(12, Math.round(a.size * Math.max(sx, sy))),
      } as Partial<Annotation>);
    } else if (a.type === "rect" || a.type === "highlight" || a.type === "blur" || a.type === "numbered-rect" || a.type === "image" || a.type === "spotlight") {
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        width: Math.max(4, a.width * sx),
        height: Math.max(4, a.height * sy),
      } as Partial<Annotation>);
    } else if (a.type === "step") {
      // Step luôn tròn → dùng 1 hệ số scale đồng nhất (Transformer đã keepRatio).
      const s = Math.max(sx, sy);
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        radius: Math.max(8, a.radius * s),
      } as Partial<Annotation>);
    } else if (a.type === "numbered-arrow") {
      const s = Math.max(sx, sy);
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        radius: Math.max(8, a.radius * s),
      } as Partial<Annotation>);
    } else if (a.type === "text") {
      const sx = node.scaleX();
      node.scaleX(1);
      node.scaleY(1);
      const curW = a.width || Math.max(40, Math.round((a.text?.length || 1) * (a.fontSize || 22) * 0.62));
      const newW = Math.max(30, Math.round(curW * sx));
      useEditor.getState().updateAnnotation(a.id, {
        x: node.x(),
        y: node.y(),
        width: newW,
      } as Partial<Annotation>);
    }
  };

  const applyCrop = () => {
    if (!cropRect || !img || !doc) return;
    const { x, y, width, height } = cropRect;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
    const newImage = canvas.toDataURL("image/png");
    // Giữ annotation còn chạm vào vùng crop (theo khung bao, không chỉ điểm đầu).
    const annotations = doc.annotations
      .map((a) => translateAnnotation(a, -x, -y))
      .filter((a) => {
        const b = annotationBounds(a);
        return b.x2 > 0 && b.y2 > 0 && b.x1 < width && b.y1 < height;
      });
    useEditor.getState().applyCrop(newImage, Math.round(width), Math.round(height), annotations);
    setCropRect(null);
    setCropHistory([]); // Reset crop history
    useEditor.getState().setTool("select");
  };

  // Mở ô nhập chữ và focus NGAY trong cùng cử chỉ người dùng. flushSync ép
  // textarea render đồng bộ để ref sẵn sàng — bắt buộc cho WKWebView (Tauri),
  // nơi .focus() chỉ ăn khi chạy trong stack sự kiện chuột gốc.
  const beginEdit = (id: string, value: string, node?: Konva.Node) => {
    hasResizedTextareaRef.current = false;
    const ann = doc?.annotations.find((a) => a.id === id);
    const annFontSize = (ann && ann.type === "text" ? ann.fontSize : fontSize) || fontSize;
    const hasArrow = ann && ann.type === "text" && !!ann.hasTargetArrow;
    const hasBg = ann && ann.type === "text" && (ann.bgColor || hasArrow);
    const padY = hasBg ? (hasArrow ? Math.max(8, Math.round(annFontSize * 0.35)) : Math.max(6, Math.round(annFontSize * 0.25))) * scale : 0;
    const padX = hasBg ? (hasArrow ? Math.max(12, Math.round(annFontSize * 0.5)) : Math.max(8, Math.round(annFontSize * 0.35))) * scale : 0;
    // Chiều cao 1 dòng theo cỡ chữ hiển thị (fontSize × scale) + padding
    const lineH = Math.max(32, Math.round(annFontSize * scale * 1.35) + 12 + padY * 2);
    let w = 120;
    let h = lineH;
    if (node) {
      w = Math.max(120, node.width() * scale + 24 + padX * 2);
      h = Math.max(lineH, node.height() * scale + 12 + padY * 2);
    } else {
      if (ann && ann.type === "text" && ann.width) {
        w = Math.max(120, ann.width * scale + 24 + padX * 2);
      }
    }
    minHeightRef.current = h;
    setTextareaSize({ width: w, height: h });
    flushSync(() => setEditing({ id, value }));
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(value.length, value.length);
    }
  };

  const handleTextareaResize = (e: React.MouseEvent, handle: string) => {
    e.preventDefault();
    e.stopPropagation();
    hasResizedTextareaRef.current = true;
    
    const startWidth = textareaSize.width;
    const startHeight = textareaSize.height;
    const startX = e.clientX;
    const startY = e.clientY;
    
    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      
      let newWidth = startWidth;
      let newHeight = startHeight;
      
      if (handle.includes("right")) newWidth = Math.max(120, Math.min(600, startWidth + dx));
      if (handle.includes("left")) newWidth = Math.max(120, Math.min(600, startWidth - dx));
      if (handle.includes("bottom")) {
        newHeight = Math.max(30, Math.min(400, startHeight + dy));
        minHeightRef.current = newHeight;
      }
      if (handle.includes("top")) {
        newHeight = Math.max(30, Math.min(400, startHeight - dy));
        minHeightRef.current = newHeight;
      }
      
      setTextareaSize({ width: newWidth, height: newHeight });
    };
    
    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  // Tự động mở rộng chiều cao khung textarea khi gõ enter hoặc nội dung vượt quá chiều cao hiện tại
  useLayoutEffect(() => {
    if (!editing) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const borderOffset = 4;
    const requiredH = Math.max(minHeightRef.current, ta.scrollHeight + borderOffset);
    ta.style.height = "100%";
    setTextareaSize((prev) => {
      if (Math.abs(prev.height - requiredH) < 2) return prev;
      return { ...prev, height: requiredH };
    });
  }, [editing?.value, textareaSize.width, scale]);

  const commitText = () => {
    if (!editing) return;
    const value = editing.value.trim();
    if (!value) {
      useEditor.getState().select(editing.id);
      useEditor.getState().removeSelected();
    } else {
      const patch: Partial<Annotation> = { text: value };
      if (hasResizedTextareaRef.current && textareaSize.width > 0) {
        patch.width = Math.round(textareaSize.width / scale);
      }
      useEditor.getState().updateAnnotation(editing.id, patch as Partial<Annotation>);
      useEditor.getState().select(editing.id);
    }
    setEditing(null);
  };

  const cancelText = () => {
    if (!editing) return;
    // Xóa annotation nếu là lần edit đầu tiên (text rỗng ban đầu)
    const ann = doc?.annotations.find((a) => a.id === editing.id);
    if (ann && ann.type === "text" && !ann.text) {
      useEditor.getState().select(editing.id);
      useEditor.getState().removeSelected();
    }
    setEditing(null);
  };

  commitTextRef.current = commitText;

  const draggable = tool === "select";
  // Tool vẽ hình: click đúng hình đã vẽ → chọn/kéo/resize; click chỗ khác → vẽ hình mới.
  // Hình tô đặc (highlight/blur/image) chỉ bắt chuột khi đã được chọn, để vẫn vẽ chồng lên được.
  const dragFor = (a: Annotation) =>
    draggable ||
    (tool === "text" && a.type === "text") ||
    (EDIT_TOOLS.has(tool) &&
      (a.type !== "highlight" && a.type !== "blur" && a.type !== "image" && a.type !== "spotlight" ? true : activeIds.includes(a.id)));

  // % so với pixel gốc của ảnh (scale), KHÔNG phải so với fit — 100% = 1:1 pixel.
  const zoomPct = Math.round(scale * 100);
  const atZoomMin = scale <= SCALE_MIN + 1e-4;
  const atZoomMax = scale >= SCALE_MAX - 1e-4;

  // Step luôn tròn → keepRatio. Line/arrow/numbered-arrow không dùng transformer bounding box
  const activeIds = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
  const selectedAnns = doc ? doc.annotations.filter((a) => activeIds.includes(a.id)) : [];
  const spotlights = (doc?.annotations ?? []).filter((a): a is SpotlightAnn => a.type === "spotlight");
  const isCircleSelected = selectedAnns.length > 0 && selectedAnns.every((a) => a.type === "step" || a.type === "magnifier" || a.type === "emoji");
  const isNumberedRectSelected = selectedAnns.length > 0 && selectedAnns.every((a) => a.type === "numbered-rect");
  // Line / arrow / numbered-arrow → Transformer ẩn (kéo di chuyển trực tiếp, không resize bounding box)
  const isLineSelected = selectedAnns.length > 0 && selectedAnns.every((a) => a.type === "line" || a.type === "arrow" || a.type === "double-arrow" || a.type === "numbered-arrow");
  const isTextSelected = selectedAnns.length > 0 && selectedAnns.every((a) => a.type === "text");

  if (!doc) {
    return (
      <div ref={outerRef} style={{ ...fill, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim, #6c7086)" }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 14 }}>{t("historyStrip.noDocument", "Không có ảnh nào đang mở")}</p>
        </div>
      </div>
    );
  }

  // DPI info từ metadata ảnh chụp (1 = normal, 2 = Retina 2×, ...)
  const scaleFactor = doc.scaleFactor ?? 1;
  const dpiLabel = scaleFactor >= 2 ? `${scaleFactor}×` : null;

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const maxDim = Math.max(1, box.w, box.h);
  const stagePixelRatio = Math.max(0.1, Math.min(dpr, 14000 / maxDim));
  stagePixelRatioRef.current = stagePixelRatio;

  return (
    // outer: bao quanh cả scroll area và zoom bar cố định — cũng là điểm đo
    // fitScale (`outerRef`, xem effect phía trên) vì không có overflow:auto.
    <div ref={outerRef} style={{ ...fill, position: "relative" }}>
      {imgLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            background: "rgba(18, 18, 24, 0.65)",
            backdropFilter: "blur(4px)",
            zIndex: 100,
            color: "var(--text, #cdd6f4)",
            fontSize: 14,
            fontWeight: 500,
            pointerEvents: "none",
            animation: "stageFadeIn 0.2s ease",
          }}
        >
          <style>{`
            @keyframes stageSpin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            @keyframes stageFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `}</style>
          <div
            style={{
              width: 32,
              height: 32,
              border: "3px solid rgba(255, 255, 255, 0.15)",
              borderTopColor: "var(--accent, #6366f1)",
              borderRadius: "50%",
              animation: "stageSpin 0.75s linear infinite",
            }}
          />
          <span>{t("annotationCanvas.loadingImage", "Đang tải ảnh…")}</span>
        </div>
      )}
    {/* scroll container — containerRef để gắn wheel listener và tính scroll */}
    <div ref={containerRef} style={{ ...fill, overflow: "auto" }}>
      {/* Căn giữa bằng margin:auto thay vì justify/align center. Lý do: khi canvas
          to hơn container, justify-content:center đẩy phần tràn ra cả 2 phía nhưng
          gốc cuộn kẹt ở vị trí đã căn giữa → không cuộn ngược về mép trái/trên.
          margin:auto thì còn chỗ mới canh giữa, hết chỗ co về 0 → cuộn đủ 2 chiều. */}
      <div style={{ minWidth: "100%", minHeight: "100%", display: "flex" }}>
      <div style={{ position: "relative", margin: "auto" }}>
        <Stage
          ref={stageRef}
          width={box.w}
          height={box.h}
          pixelRatio={stagePixelRatio}
          onMouseDown={onStageMouseDown}
          onDragStart={(e) => {
            if (e.target.name() === "handle" || e.target.getParent()?.className === "Transformer") return;
            setBodyDragging(true);
          }}
          onDragEnd={() => setBodyDragging(false)}
          onMouseMove={(e) => {
            // Tool vẽ: rê vào hình đã vẽ → con trỏ "move" thay vì dấu + (báo hiệu click để chỉnh)
            if (e.target.name() === "handle" || e.target.getParent()?.className === "Transformer") return;
            if (!EDIT_TOOLS.has(tool)) { if (hoverCursor) setHoverCursor(null); return; }
            let n: Konva.Node | null = e.target;
            let hit: Annotation | undefined;
            while (n && n !== (e.target.getStage() as Konva.Node)) {
              const nid = n.id();
              if (nid && (hit = doc?.annotations.find((x) => x.id === nid))) break;
              n = n.parent;
            }
            setHoverCursor(hit && dragFor(hit) ? "move" : null);
          }}
          style={{ 
            cursor: hoverCursor && !isPanMode ? hoverCursor : isPanMode 
              ? (isPanDrag ? "grabbing" : "grab") 
              : resizingCropHandle && resizingCropHandle !== "move"
              ? getCropCursor(resizingCropHandle)
              : resizingCropHandle === "move"
              ? "grabbing"
              : cropHoverHandle && cropHoverHandle !== "move"
              ? getCropCursor(cropHoverHandle)
              : cropHoverHandle === "move"
              ? "grab"
              : tool === "select" 
              ? "default" 
              : tool === "text" 
              ? "text" 
              : "crosshair" 
          }}
        >
          <Layer ref={layerRef} scaleX={scale} scaleY={scale}>
            {/* Khung nền gradient / solid (nếu có) */}
            {bgConfig && (() => {
              const angle = bgConfig.angle ?? 135;
              const rad = (angle * Math.PI) / 180;
              const cx = totalW / 2;
              const cy = totalH / 2;
              const dx = Math.sin(rad);
              const dy = -Math.cos(rad);
              const len = (Math.abs(totalW * Math.sin(rad)) + Math.abs(totalH * Math.cos(rad))) / 2;
              const startX = cx - dx * len;
              const startY = cy - dy * len;
              const endX = cx + dx * len;
              const endY = cy + dy * len;

              const stops: (number | string)[] = [];
              if (bgConfig.type === "solid" || bgConfig.colors.length === 1) {
                stops.push(0, bgConfig.colors[0], 1, bgConfig.colors[0]);
              } else {
                const lenColors = bgConfig.colors.length;
                bgConfig.colors.forEach((c, idx) => {
                  stops.push(idx / (lenColors - 1), c);
                });
              }

              return (
                <Rect
                  x={0}
                  y={0}
                  width={totalW}
                  height={totalH}
                  fillLinearGradientStartPoint={{ x: startX, y: startY }}
                  fillLinearGradientEndPoint={{ x: endX, y: endY }}
                  fillLinearGradientColorStops={stops}
                  listening={false}
                />
              );
            })()}

            {/* Nhóm chứa ảnh chụp và toàn bộ annotations neo tại (bgPad, bgPad) */}
            <Group x={bgPad} y={bgPad}>
              {/* Đổ bóng cho ảnh chụp */}
              {bgConfig && bgConfig.shadow !== "none" && (() => {
                const shadowConfig =
                  bgConfig.shadow === "strong"
                    ? { blur: 40, offset: 20, opacity: 0.55 }
                    : bgConfig.shadow === "subtle"
                    ? { blur: 14, offset: 7, opacity: 0.25 }
                    : { blur: 26, offset: 13, opacity: 0.40 };
                return (
                  <Rect
                    x={0}
                    y={0}
                    width={doc.imgW}
                    height={doc.imgH}
                    cornerRadius={bgConfig.borderRadius}
                    fill="#000000"
                    shadowColor="rgba(0, 0, 0, 0.45)"
                    shadowBlur={shadowConfig.blur}
                    shadowOffset={{ x: 0, y: shadowConfig.offset }}
                    shadowOpacity={shadowConfig.opacity}
                    listening={false}
                  />
                );
              })()}

              {/* Ảnh chụp chính — bo góc nếu có borderRadius */}
              {bgConfig && bgConfig.borderRadius > 0 ? (
                <Group
                  clipFunc={(ctx) => {
                    ctx.beginPath();
                    drawRoundedRect(ctx, 0, 0, doc.imgW, doc.imgH, bgConfig.borderRadius);
                    ctx.closePath();
                  }}
                >
                  {img && <KImage image={img} id="bg" width={doc.imgW} height={doc.imgH} listening={false} />}
                </Group>
              ) : (
                img && <KImage image={img} id="bg" width={doc.imgW} height={doc.imgH} listening={false} />
              )}

            {doc.annotations.map((a) => {
              const isSelected = activeIds.includes(a.id);
              if (a.type === "rect")
                return (
                  <Group key={a.id}>
                    <Rect
                      id={a.id}
                      x={a.x}
                      y={a.y}
                      width={a.width}
                      height={a.height}
                      stroke={a.color}
                      strokeWidth={a.strokeWidth}
                      shadowColor={isSelected ? "#3b82f6" : undefined}
                      shadowBlur={isSelected ? 6 : 0}
                      shadowOpacity={isSelected ? 0.9 : 0}
                      draggable={dragFor(a)}
                      onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                      onTap={() => useEditor.getState().select(a.id)}
                      onDragEnd={(e) => onDragEnd(a.id, e)}
                      onTransformEnd={(e) => onTransformEnd(a, e.target)}
                    />
                    {isSelected && activeIds.length > 1 && (
                      <SelectionFrame x={a.x} y={a.y} width={a.width} height={a.height} />
                    )}
                  </Group>
                );
              if (a.type === "numbered-rect") {
                const corner = a.corner || "tl";
                const cx = corner === "tl" || corner === "bl" ? 0 : a.width;
                const cy = corner === "tl" || corner === "tr" ? 0 : a.height;
                const badgeRadius = a.radius || Math.max(Math.round(a.strokeWidth * 2 + 5), 10);
                const valStr = String(a.value);
                const fontSize = Math.max(9, Math.round(badgeRadius * (valStr.length > 1 ? 0.78 : 0.88)));
                return (
                  <Group key={a.id}>
                    <Group
                      id={a.id}
                      x={a.x}
                      y={a.y}
                      draggable={dragFor(a)}
                      onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                      onTap={() => useEditor.getState().select(a.id)}
                      onDragEnd={(e) => onDragEnd(a.id, e)}
                      onTransformEnd={(e) => onTransformEnd(a, e.target)}
                    >
                      <Rect
                        x={0}
                        y={0}
                        width={a.width}
                        height={a.height}
                        stroke={a.color}
                        strokeWidth={a.strokeWidth}
                        shadowColor={isSelected ? "#3b82f6" : undefined}
                        shadowBlur={isSelected ? 6 : 0}
                        shadowOpacity={isSelected ? 0.9 : 0}
                      />
                      <Circle
                        x={cx}
                        y={cy}
                        radius={badgeRadius}
                        fill={a.color}
                        stroke={isSelected ? "#3b82f6" : "#ffffff"}
                        strokeWidth={isSelected ? 2 : 1}
                        shadowColor={isSelected ? "#3b82f6" : undefined}
                        shadowBlur={isSelected ? 6 : 0}
                      />
                      <Text
                        x={cx}
                        y={cy}
                        text={valStr}
                        fontSize={fontSize}
                        fontStyle="bold"
                        fill="#ffffff"
                        width={badgeRadius * 2}
                        height={badgeRadius * 2}
                        offsetX={badgeRadius}
                        offsetY={badgeRadius}
                        align="center"
                        verticalAlign="middle"
                      />
                    </Group>
                    {isSelected && activeIds.length > 1 && (
                      <SelectionFrame x={a.x} y={a.y} width={a.width} height={a.height} />
                    )}
                  </Group>
                );
              }
              if (a.type === "ellipse")
                return (
                  <Group key={a.id}>
                    <Ellipse
                      id={a.id}
                      x={a.x + a.width / 2}
                      y={a.y + a.height / 2}
                      radiusX={Math.abs(a.width / 2)}
                      radiusY={Math.abs(a.height / 2)}
                      stroke={a.color}
                      strokeWidth={a.strokeWidth}
                      shadowColor={isSelected ? "#3b82f6" : undefined}
                      shadowBlur={isSelected ? 6 : 0}
                      shadowOpacity={isSelected ? 0.9 : 0}
                      draggable={dragFor(a)}
                      onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                      onTap={() => useEditor.getState().select(a.id)}
                      onDragEnd={(e) =>
                        useEditor.getState().updateAnnotation(a.id, {
                          x: e.target.x() - a.width / 2,
                          y: e.target.y() - a.height / 2,
                        })
                      }
                      onTransformEnd={(e) => onTransformEnd(a, e.target)}
                    />
                    {isSelected && activeIds.length > 1 && (
                      <SelectionFrame x={a.x} y={a.y} width={a.width} height={a.height} />
                    )}
                  </Group>
                );
              if (a.type === "text") {
                const hasArrow = !!a.hasTargetArrow;
                const activeBg = hasArrow ? (a.bgColor || "#3b82f6") : (a.bgColor && a.bgColor !== "transparent" ? a.bgColor : "");
                const hasBg = !!activeBg;
                const padX = hasBg ? (hasArrow ? Math.max(12, Math.round((a.fontSize || 22) * 0.5)) : Math.max(8, Math.round((a.fontSize || 22) * 0.35))) : 0;
                const padY = hasBg ? (hasArrow ? Math.max(8, Math.round((a.fontSize || 22) * 0.35)) : Math.max(6, Math.round((a.fontSize || 22) * 0.25))) : 0;
                const lines = (a.text || " ").split("\n");
                const maxLineLen = Math.max(...lines.map((l) => l.length), 1);
                const estW = a.width || Math.max(40, Math.round(maxLineLen * (a.fontSize || 22) * 0.62));
                const estH = Math.max(Math.round((a.fontSize || 22) * 1.35), lines.length * Math.round((a.fontSize || 22) * 1.35));
                const boxW = estW + padX * 2;
                const boxH = estH + padY * 2;
                const safeR = hasArrow ? Math.min(14, Math.max(8, Math.min(boxW, boxH) * 0.25)) : 6;

                // Tọa độ đỉnh mỏ nhọn callout tương đối so với góc trên-trái hộp text
                const targetX = a.targetX ?? (a.x - 50);
                const targetY = a.targetY ?? (a.y + boxH / 2);
                const tx = targetX - a.x;
                const ty = targetY - a.y;
                const calloutPath = hasArrow ? getCalloutPath(boxW, boxH, safeR, tx, ty) : "";

                // Tính 2 điểm chân mỏ nhọn trên chu vi bo góc
                const cx = boxW / 2;
                const cy = boxH / 2;
                const dx = tx - cx;
                const dy = ty - cy;
                const angle = Math.atan2(dy, dx);
                const pMid = getPointOnRoundedRect(boxW, boxH, safeR, angle);
                const midDist = Math.hypot(pMid.x - cx, pMid.y - cy);
                const baseWidth = Math.min(26, Math.max(16, Math.min(boxW, boxH) * 0.35));
                const halfAngle = Math.asin(Math.min(0.7, (baseWidth / 2) / Math.max(10, midDist)));
                const pt1 = getPointOnRoundedRect(boxW, boxH, safeR, angle - halfAngle);
                const pt2 = getPointOnRoundedRect(boxW, boxH, safeR, angle + halfAngle);

                return (
                  <Group key={a.id}>
                    <Group
                      id={a.id}
                      x={a.x}
                      y={a.y}
                      draggable={dragFor(a)}
                      onClick={(e) => {
                        const multi = e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey;
                        useEditor.getState().select(a.id, multi);
                        // Tool Text: click (không kéo) vào chữ đã có → sửa luôn
                        if (tool === "text" && !multi) beginEdit(a.id, a.text, e.target);
                      }}
                      onDblClick={(e) => beginEdit(a.id, a.text, e.target)}
                      onMouseEnter={() => setHoveredTextId(a.id)}
                      onMouseLeave={() => setHoveredTextId(null)}
                      onDragEnd={(e) => {
                        const nx = e.currentTarget.x();
                        const ny = e.currentTarget.y();
                        const dx = nx - a.x;
                        const dy = ny - a.y;
                        const patch: Partial<TextAnn> = {
                          x: nx,
                          y: ny,
                        };
                        if (a.hasTargetArrow && a.targetX !== undefined && a.targetY !== undefined) {
                          patch.targetX = a.targetX + dx;
                          patch.targetY = a.targetY + dy;
                        }
                        useEditor.getState().updateAnnotation(a.id, patch as Partial<Annotation>);
                      }}
                      onTransform={(e) => applyTextTransform(a, e.target, false)}
                      onTransformEnd={(e) => applyTextTransform(a, e.target, true)}
                      visible={editing?.id !== a.id}
                    >
                      {/* Khung Callout nguyên khối kèm mỏ nhọn (khi có hasTargetArrow) */}
                      {hasArrow && (
                        <Path
                          data={calloutPath}
                          fill={activeBg}
                          shadowColor="rgba(0,0,0,0.22)"
                          shadowBlur={5}
                          shadowOffset={{ x: 0, y: 1.5 }}
                          shadowOpacity={0.25}
                          stroke={isSelected ? "#3b82f6" : "rgba(0,0,0,0.12)"}
                          strokeWidth={isSelected ? 1.5 : 0.8}
                        />
                      )}

                      {/* Khung chữ nhật bo góc thông thường (khi có bgColor nhưng không có arrow) */}
                      {!hasArrow && hasBg && (
                        <Rect
                          x={0}
                          y={0}
                          width={boxW}
                          height={boxH}
                          fill={activeBg}
                          cornerRadius={safeR}
                          shadowColor="rgba(0,0,0,0.25)"
                          shadowBlur={4}
                          shadowOffset={{ x: 0, y: 1 }}
                          shadowOpacity={0.3}
                          stroke={isSelected ? "#3b82f6" : "rgba(0,0,0,0.15)"}
                          strokeWidth={isSelected ? 1.5 : 1}
                        />
                      )}

                      {/* Text */}
                      <Text
                        x={padX}
                        y={padY}
                        text={a.text || " "}
                        fontSize={a.fontSize}
                        fill={a.color}
                        fontStyle="bold"
                        width={a.width}
                        wrap="word"
                        shadowColor={!hasBg && isSelected ? "#3b82f6" : undefined}
                        shadowBlur={!hasBg && isSelected ? 6 : 0}
                        shadowOpacity={!hasBg && isSelected ? 0.9 : 0}
                      />
                    </Group>

                    {/* Đang gõ: Group chữ bị ẩn → vẽ mỏ nhọn thật (nằm dưới ô nhập) + chấm đích để thấy callout trỏ vào đâu */}
                    {editing?.id === a.id && hasArrow && (() => {
                      const ew = Math.max(40, textareaSize.width / scale);
                      const eh = Math.max(20, textareaSize.height / scale);
                      const er = Math.min(14, Math.max(8, Math.min(ew, eh) * 0.25));
                      return (
                        <>
                          <Path
                            x={a.x}
                            y={a.y}
                            data={getCalloutPath(ew, eh, er, targetX - a.x, targetY - a.y)}
                            fill={activeBg}
                            listening={false}
                          />
                          <Circle x={targetX} y={targetY} radius={5 / scale} fill="#3b82f6" stroke="#ffffff" strokeWidth={1.5 / scale} listening={false} />
                        </>
                      );
                    })()}

                    {/* Vùng mỏ nhọn & Handle điều khiển đỉnh mũi tên (xoay 360 độ linh hoạt khi nhấn giữ) */}
                    {!bodyDragging && (tool === "select" || tool === "text") && hasArrow && (isSelected || hoveredTextId === a.id) && (
                      <Group>
                        {/* Hit-area tam giác thân mỏ nhọn: rê chuột vào đổi con trỏ move, click vào select */}
                        <Line
                          points={[
                            a.x + pt1.x, a.y + pt1.y,
                            targetX, targetY,
                            a.x + pt2.x, a.y + pt2.y,
                          ]}
                          closed={true}
                          fill="transparent"
                          hitStrokeWidth={16}
                          name="handle"
                          onMouseEnter={() => setHoverCursor("move")}
                          onMouseLeave={() => setHoverCursor(null)}
                          onMouseDown={(e) => {
                            e.cancelBubble = true;
                            if (!isSelected) {
                              useEditor.getState().select(a.id);
                            }
                          }}
                        />

                        {/* Chấm tròn handle ở đỉnh mỏ nhọn: kéo xoay 360 độ linh hoạt quanh khung chữ */}
                        <Circle
                          x={targetX}
                          y={targetY}
                          radius={7 / scale}
                          fill="#ffffff"
                          stroke="#2563eb"
                          strokeWidth={2.5 / scale}
                          hitStrokeWidth={20 / scale}
                          shadowColor="rgba(0,0,0,0.35)"
                          shadowBlur={6}
                          shadowOffset={{ x: 0, y: 1.5 }}
                          shadowOpacity={0.4}
                          draggable={true}
                          onMouseDown={(e) => {
                            e.cancelBubble = true;
                            if (!isSelected) {
                              useEditor.getState().select(a.id);
                            }
                          }}
                          name="handle"
                          onMouseEnter={() => setHoverCursor("move")}
                          onMouseLeave={() => setHoverCursor(null)}
                          onDragMove={(e) => {
                            const nx = Math.round(e.target.x());
                            const ny = Math.round(e.target.y());
                            useEditor.getState().updateAnnotationLive(a.id, {
                              targetX: nx,
                              targetY: ny,
                            } as Partial<Annotation>);
                          }}
                          onDragEnd={(e) => {
                            const nx = Math.round(e.target.x());
                            const ny = Math.round(e.target.y());
                            useEditor.getState().updateAnnotation(a.id, {
                              targetX: nx,
                              targetY: ny,
                            } as Partial<Annotation>);
                          }}
                        />
                      </Group>
                    )}

                    {isSelected && activeIds.length > 1 && (
                      <SelectionFrame
                        x={a.x}
                        y={a.y}
                        width={boxW}
                        height={boxH}
                      />
                    )}
                  </Group>
                );
              }
              // step
              if (a.type === "step") {
                const badgeRadius = a.radius || Math.max(Math.round(a.strokeWidth * 2 + 5), 10);
                const valStr = String(a.value);
                const fontSize = Math.max(9, Math.round(badgeRadius * (valStr.length > 1 ? 0.78 : 0.88)));
                return (
                  <Group key={a.id}>
                    <Group
                      id={a.id}
                      x={a.x}
                      y={a.y}
                      draggable={dragFor(a)}
                      onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                      onTap={() => useEditor.getState().select(a.id)}
                      onDragEnd={(e) => onDragEnd(a.id, e)}
                      onTransformEnd={(e) => onTransformEnd(a, e.target)}
                    >
                      <Circle
                        radius={badgeRadius}
                        fill={a.color}
                        stroke={isSelected ? "#3b82f6" : "#ffffff"}
                        strokeWidth={isSelected ? 2.5 : 1}
                        shadowColor={isSelected ? "#3b82f6" : undefined}
                        shadowBlur={isSelected ? 6 : 0}
                        shadowOpacity={isSelected ? 0.9 : 0}
                      />
                      <Text
                        text={valStr}
                        fontSize={fontSize}
                        fontStyle="bold"
                        fill="#ffffff"
                        width={badgeRadius * 2}
                        height={badgeRadius * 2}
                        offsetX={badgeRadius}
                        offsetY={badgeRadius}
                        align="center"
                        verticalAlign="middle"
                      />
                    </Group>
                    {isSelected && activeIds.length > 1 && (
                      <StepSelectionFrame x={a.x} y={a.y} radius={badgeRadius} />
                    )}
                  </Group>
                );
              }
              // arrow
              if (a.type === "arrow")
              return (
                <Group key={a.id}>
                  <Arrow
                    id={a.id}
                    points={linePts(a)}
                    tension={a.cx !== undefined ? 0.5 : 0}
                    stroke={a.color}
                    strokeWidth={a.strokeWidth}
                    fill={a.color}
                    pointerLength={Math.max(10, a.strokeWidth * 3)}
                    pointerWidth={Math.max(8, a.strokeWidth * 2.5)}
                    lineCap="round"
                    lineJoin="round"
                    hitStrokeWidth={Math.max(20, a.strokeWidth * 3)}
                    shadowColor={isSelected ? "#3b82f6" : undefined}
                    shadowBlur={isSelected ? 6 : 0}
                    shadowOpacity={isSelected ? 0.9 : 0}
                    draggable={dragFor(a)}
                    onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                    onTap={() => useEditor.getState().select(a.id)}
                    onDragEnd={(e) => {
                      const dx = e.currentTarget.x();
                      const dy = e.currentTarget.y();
                      e.currentTarget.x(0);
                      e.currentTarget.y(0);
                      useEditor.getState().updateAnnotation(a.id, {
                        x: a.x + dx, y: a.y + dy,
                        x2: a.x2 + dx, y2: a.y2 + dy,
                      } as Partial<Annotation>);
                    }}
                  />
                  {isSelected && activeIds.length > 1 && (
                    <LineEndpoints x1={a.x} y1={a.y} x2={a.x2} y2={a.y2} />
                  )}
                </Group>
              );
              // double-arrow (mũi tên 2 chiều đánh dấu khoảng cách)
              if (a.type === "double-arrow")
              return (
                <Group key={a.id}>
                  <Arrow
                    id={a.id}
                    points={linePts(a)}
                    tension={a.cx !== undefined ? 0.5 : 0}
                    stroke={a.color}
                    strokeWidth={a.strokeWidth}
                    fill={a.color}
                    pointerAtBeginning={true}
                    pointerAtEnding={true}
                    pointerLength={Math.max(10, a.strokeWidth * 3)}
                    pointerWidth={Math.max(8, a.strokeWidth * 2.5)}
                    lineCap="round"
                    lineJoin="round"
                    hitStrokeWidth={Math.max(20, a.strokeWidth * 3)}
                    shadowColor={isSelected ? "#3b82f6" : undefined}
                    shadowBlur={isSelected ? 6 : 0}
                    shadowOpacity={isSelected ? 0.9 : 0}
                    draggable={dragFor(a)}
                    onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                    onTap={() => useEditor.getState().select(a.id)}
                    onDragEnd={(e) => {
                      const dx = e.currentTarget.x();
                      const dy = e.currentTarget.y();
                      e.currentTarget.x(0);
                      e.currentTarget.y(0);
                      useEditor.getState().updateAnnotation(a.id, {
                        x: a.x + dx, y: a.y + dy,
                        x2: a.x2 + dx, y2: a.y2 + dy,
                      } as Partial<Annotation>);
                    }}
                  />
                  {isSelected && activeIds.length > 1 && (
                    <LineEndpoints x1={a.x} y1={a.y} x2={a.x2} y2={a.y2} />
                  )}
                </Group>
              );
              // line
              if (a.type === "line")
              return (
                <Group key={a.id}>
                  <Line
                    id={a.id}
                    points={linePts(a)}
                    tension={a.cx !== undefined ? 0.5 : 0}
                    stroke={a.color}
                    strokeWidth={a.strokeWidth}
                    lineCap="round"
                    lineJoin="round"
                    hitStrokeWidth={Math.max(20, a.strokeWidth * 3)}
                    shadowColor={isSelected ? "#3b82f6" : undefined}
                    shadowBlur={isSelected ? 6 : 0}
                    shadowOpacity={isSelected ? 0.9 : 0}
                    draggable={dragFor(a)}
                    onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                    onTap={() => useEditor.getState().select(a.id)}
                    onDragEnd={(e) => {
                      const dx = e.currentTarget.x();
                      const dy = e.currentTarget.y();
                      e.currentTarget.x(0);
                      e.currentTarget.y(0);
                      useEditor.getState().updateAnnotation(a.id, {
                        x: a.x + dx, y: a.y + dy,
                        x2: a.x2 + dx, y2: a.y2 + dy,
                      } as Partial<Annotation>);
                    }}
                  />
                  {isSelected && activeIds.length > 1 && (
                    <LineEndpoints x1={a.x} y1={a.y} x2={a.x2} y2={a.y2} />
                  )}
                </Group>
              );
              // numbered-arrow
              if (a.type === "numbered-arrow") {
                const badgeRadius = a.radius || Math.max(Math.round(a.strokeWidth * 2 + 5), 10);
                const valStr = String(a.value);
                const fontSize = Math.max(9, Math.round(badgeRadius * (valStr.length > 1 ? 0.78 : 0.88)));
                const dx = (a.cx ?? a.x2) - a.x;
                const dy = (a.cy ?? a.y2) - a.y;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                // Đặt vòng tròn tại đuôi mũi tên (điểm bắt đầu)
                const nx = dx / len;
                const ny = dy / len;
                // Điểm bắt đầu thật sự của đường thẳng = mép vòng tròn
                const startX = a.x + nx * badgeRadius;
                const startY = a.y + ny * badgeRadius;
                return (
                  <Group key={a.id}>
                    <Group
                      id={a.id}
                      draggable={dragFor(a)}
                      onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                      onTap={() => useEditor.getState().select(a.id)}
                      onDragEnd={(e) => {
                        const ddx = e.currentTarget.x();
                        const ddy = e.currentTarget.y();
                        e.currentTarget.x(0);
                        e.currentTarget.y(0);
                        useEditor.getState().updateAnnotation(a.id, {
                          x: a.x + ddx, y: a.y + ddy,
                          x2: a.x2 + ddx, y2: a.y2 + ddy,
                        } as Partial<Annotation>);
                      }}
                    >
                      {/* Vòng tròn số thứ tự tại đuôi */}
                      <Circle
                        x={a.x}
                        y={a.y}
                        radius={badgeRadius}
                        fill={a.color}
                        stroke={isSelected ? "#3b82f6" : "#ffffff"}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                        shadowColor={isSelected ? "#3b82f6" : undefined}
                        shadowBlur={isSelected ? 6 : 0}
                      />
                      <Text
                        x={a.x}
                        y={a.y}
                        text={valStr}
                        fontSize={fontSize}
                        fontStyle="bold"
                        fill="#ffffff"
                        width={badgeRadius * 2}
                        height={badgeRadius * 2}
                        offsetX={badgeRadius}
                        offsetY={badgeRadius}
                        align="center"
                        verticalAlign="middle"
                      />
                      {/* Mũi tên từ mép vòng tròn đến đầu mũi tên */}
                      <Arrow
                        points={a.cx !== undefined && a.cy !== undefined ? [startX, startY, a.cx, a.cy, a.x2, a.y2] : [startX, startY, a.x2, a.y2]}
                        tension={a.cx !== undefined ? 0.5 : 0}
                        stroke={a.color}
                        strokeWidth={a.strokeWidth}
                        fill={a.color}
                        pointerLength={Math.max(10, a.strokeWidth * 3)}
                        pointerWidth={Math.max(8, a.strokeWidth * 2.5)}
                        lineCap="round"
                        lineJoin="round"
                        hitStrokeWidth={Math.max(20, a.strokeWidth * 3)}
                        shadowColor={isSelected ? "#3b82f6" : undefined}
                        shadowBlur={isSelected ? 6 : 0}
                        shadowOpacity={isSelected ? 0.9 : 0}
                      />
                    </Group>
                    {isSelected && activeIds.length > 1 && (
                      <LineEndpoints x1={a.x} y1={a.y} x2={a.x2} y2={a.y2} />
                    )}
                  </Group>
                );
              }
              // highlight
              if (a.type === "highlight")
              return (
                <Group key={a.id}>
                  <Rect
                    id={a.id}
                    x={a.x}
                    y={a.y}
                    width={a.width}
                    height={a.height}
                    fill={a.color}
                    opacity={0.38}
                    stroke={isSelected ? "#3b82f6" : undefined}
                    strokeWidth={isSelected ? 1.5 : 0}
                    draggable={dragFor(a)}
                    onClick={(e) => useEditor.getState().select(a.id, e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)}
                    onTap={() => useEditor.getState().select(a.id)}
                    onDragEnd={(e) => onDragEnd(a.id, e)}
                    onTransformEnd={(e) => onTransformEnd(a, e.target)}
                  />
                  {isSelected && activeIds.length > 1 && (
                    <SelectionFrame x={a.x} y={a.y} width={a.width} height={a.height} />
                  )}
                </Group>
              );
              // blur — dùng canvas 2D để process pixel
              if (a.type === "blur")
              return (
                <Group key={a.id}>
                  <BlurRect
                    ann={a}
                    img={img}
                    draggable={dragFor(a)}
                    onSelect={(multi) => useEditor.getState().select(a.id, multi)}
                    onDragEnd={(newX, newY) =>
                      useEditor.getState().updateAnnotation(a.id, {
                        x: newX, y: newY,
                      } as Partial<Annotation>)
                    }
                    onTransformEnd={(node) => onTransformEnd(a, node)}
                  />
                  {isSelected && activeIds.length > 1 && (
                    <SelectionFrame x={a.x} y={a.y} width={a.width} height={a.height} />
                  )}
                </Group>
              );
              const extra = {
                draggable: dragFor(a),
                isSelected,
                onSelect: (multi: boolean) => useEditor.getState().select(a.id, multi),
                onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onDragEnd(a.id, e),
                onTransformEnd: (node: Konva.Node) => onTransformEnd(a, node),
              };
              if (a.type === "pen") return <PenItem key={a.id} ann={a} {...extra} />;
              if (a.type === "emoji") return <EmojiItem key={a.id} ann={a} {...extra} />;
              if (a.type === "magnifier")
                return <MagnifierItem key={a.id} ann={a} img={img} {...extra} />;
              if (a.type === "spotlight")
                return (
                  <Group key={a.id}>
                    {/* Lớp tối chung của mọi spotlight nằm ở spotlight ĐẦU TIÊN theo thứ tự lớp */}
                    {a.id === spotlights[0]?.id && <SpotlightOverlay spots={spotlights} imgW={doc.imgW} imgH={doc.imgH} />}
                    <SpotlightHit ann={a} {...extra} />
                  </Group>
                );
              // image — ảnh chèn thêm
              if (a.type === "image")
              return (
                <ImageItem
                  key={a.id}
                  ann={a}
                  draggable={dragFor(a)}
                  isSelected={isSelected}
                  activeIds={activeIds}
                  onSelect={(multi) => useEditor.getState().select(a.id, multi)}
                  onDragEnd={(e) => onDragEnd(a.id, e)}
                  onTransformEnd={(node) => onTransformEnd(a, node)}
                />
              );
              return null;
            })}

            {/* Draft preview cho rect/ellipse/highlight/blur/crop + mũi tên/đường thẳng đang kéo */}
            <DraftPreview
              ref={draftPreviewRef}
              imgW={doc.imgW}
              imgH={doc.imgH}
              color={color}
              strokeWidth={strokeWidth}
              highlightColor={highlightColor}
              blurMode={blurMode}
            />

            {cropRect && (
              <Group ref={cropOverlayGroupRef}>
                {/* Overlay xám cho các vùng ngoài crop */}
                <Rect x={0} y={0} width={doc.imgW} height={cropRect.y} fill="#000000" opacity={0.5} listening={false} />
                <Rect x={0} y={cropRect.y} width={cropRect.x} height={cropRect.height} fill="#000000" opacity={0.5} listening={false} />
                <Rect x={cropRect.x + cropRect.width} y={cropRect.y} width={doc.imgW - cropRect.x - cropRect.width} height={cropRect.height} fill="#000000" opacity={0.5} listening={false} />
                <Rect x={0} y={cropRect.y + cropRect.height} width={doc.imgW} height={doc.imgH - cropRect.y - cropRect.height} fill="#000000" opacity={0.5} listening={false} />
                
                {/* Khung crop chính - có thể kéo để move */}
                <Rect
                  x={cropRect.x}
                  y={cropRect.y}
                  width={cropRect.width}
                  height={cropRect.height}
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dash={[8, 4]}
                  listening={false}
                />
                
                {/* Area để kéo move crop (invisible, full area của crop) */}
                <Rect
                  x={cropRect.x}
                  y={cropRect.y}
                  width={cropRect.width}
                  height={cropRect.height}
                  fill="transparent"
                  onMouseDown={(e) => {
                    e.evt.preventDefault();
                    e.cancelBubble = true; // Ngăn event lan xuống stage
                    beginCropPointerDrag("move", e.evt.clientX, e.evt.clientY);
                  }}
                  onMouseEnter={() => setCropHoverHandle("move")}
                  onMouseLeave={() => {
                    if (cropHoverHandle === "move") setCropHoverHandle(null);
                  }}
                />
                
                {/* Overlay sáng khi đang kéo (làm rõ vùng được chọn) */}
                {resizingCropHandle && (
                  <Rect
                    x={cropRect.x}
                    y={cropRect.y}
                    width={cropRect.width}
                    height={cropRect.height}
                    fill="#ffffff"
                    opacity={0.08}
                    listening={false}
                  />
                )}
                
                {/* 8 resize handles */}
                {[
                  { id: "top-left", x: cropRect.x, y: cropRect.y, cursor: "nwse-resize" },
                  { id: "top-center", x: cropRect.x + cropRect.width / 2, y: cropRect.y, cursor: "ns-resize" },
                  { id: "top-right", x: cropRect.x + cropRect.width, y: cropRect.y, cursor: "nesw-resize" },
                  { id: "middle-left", x: cropRect.x, y: cropRect.y + cropRect.height / 2, cursor: "ew-resize" },
                  { id: "middle-right", x: cropRect.x + cropRect.width, y: cropRect.y + cropRect.height / 2, cursor: "ew-resize" },
                  { id: "bottom-left", x: cropRect.x, y: cropRect.y + cropRect.height, cursor: "nesw-resize" },
                  { id: "bottom-center", x: cropRect.x + cropRect.width / 2, y: cropRect.y + cropRect.height, cursor: "ns-resize" },
                  { id: "bottom-right", x: cropRect.x + cropRect.width, y: cropRect.y + cropRect.height, cursor: "nwse-resize" },
                ].map((handle) => (
                  <Circle
                    key={handle.id}
                    x={handle.x}
                    y={handle.y}
                    radius={6}
                    fill={cropHoverHandle === handle.id ? "#60a5fa" : "#3b82f6"}
                    stroke="#ffffff"
                    strokeWidth={1.5}
                    onMouseDown={(e) => {
                      e.evt.preventDefault();
                      e.cancelBubble = true; // Ngăn event lan xuống stage
                      beginCropPointerDrag(handle.id, e.evt.clientX, e.evt.clientY);
                    }}
                    onMouseEnter={() => setCropHoverHandle(handle.id)}
                    onMouseLeave={() => {
                      if (cropHoverHandle === handle.id) setCropHoverHandle(null);
                    }}
                  />
                ))}
              </Group>
            )}

            {/* Marquee drag selection box */}
            <MarqueePreview ref={marqueePreviewRef} scale={scale} />

            {!bodyDragging && (tool === "select" || EDIT_TOOLS.has(tool)) && selectedAnns.map((a) =>
              a.type === "arrow" || a.type === "double-arrow" || a.type === "line" || a.type === "numbered-arrow"
                ? <LineHandles key={a.id} ann={a} scale={scale} showMid={activeIds.length === 1} onCursor={setHoverCursor} />
                : null,
            )}

            <Transformer
              ref={trRef}
              rotateEnabled={false}
              ignoreStroke
              keepRatio={isCircleSelected || isTextSelected}
              visible={!isLineSelected}
              enabledAnchors={
                isCircleSelected || isNumberedRectSelected
                  ? ["top-left", "top-right", "bottom-left", "bottom-right"]
                  : isTextSelected
                  ? ["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"]
                  : ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]
              }
              boundBoxFunc={(_old, next) => {
                if (isTextSelected) {
                  next.width = Math.max(30, next.width);
                }
                return next;
              }}
            />
            </Group>
          </Layer>
        </Stage>

        {editing && (() => {
          const activeAnn = doc?.annotations.find((x) => x.id === editing.id);
          const textAnn = activeAnn?.type === "text" ? (activeAnn as TextAnn) : null;
          const activeFontSize = ((textAnn ? textAnn.fontSize : fontSize) ?? fontSize) * scale;
          const activeColor = (activeAnn && "color" in activeAnn ? (activeAnn as any).color : null) ?? color;
          const hasArrow = !!textAnn?.hasTargetArrow;
          const activeBg = hasArrow ? (textAnn?.bgColor || "#3b82f6") : (textAnn?.bgColor && textAnn.bgColor !== "transparent" ? textAnn.bgColor : "transparent");
          const padX = activeBg !== "transparent" ? (hasArrow ? Math.max(12, Math.round(((textAnn?.fontSize) || 22) * 0.5)) : Math.max(8, Math.round(((textAnn?.fontSize) || 22) * 0.35))) * scale : 0;
          const padY = activeBg !== "transparent" ? (hasArrow ? Math.max(8, Math.round(((textAnn?.fontSize) || 22) * 0.35)) : Math.max(6, Math.round(((textAnn?.fontSize) || 22) * 0.25))) * scale : 0;
          return (
            <div 
              style={{
                position: "absolute",
                left: textPos(editing.id).x,
                top: textPos(editing.id).y,
                width: textareaSize.width,
                height: textareaSize.height,
              }}
            >
              {textAnn && (
                <div style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 6, zIndex: 20 }}>
                  <CalloutBar ann={textAnn} />
                </div>
              )}
              <textarea
                ref={textareaRef}
                autoFocus
                value={editing.value}
                onChange={(e) => {
                  setEditing({ ...editing, value: e.target.value });
                }}
                onBlur={() => {
                  commitText();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelText();
                  }
                  if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    commitText();
                  }
                }}
                style={{
                  width: "100%",
                  height: "100%",
                  fontSize: activeFontSize,
                  lineHeight: 1.35,
                  fontWeight: "bold",
                  color: activeColor,
                  fontFamily: "Arial, sans-serif",
                  background: activeBg,
                  borderRadius: activeBg !== "transparent" ? 6 : 0,
                  border: "1px dashed #3b82f6",
                  outline: "none",
                  resize: "none",
                  padding: `${padY}px ${padX}px`,
                  overflow: "hidden",
                  WebkitUserSelect: "text",
                  userSelect: "text",
                  boxSizing: "border-box",
                }}
              />
              
              {/* Custom resize handles */}
              {[
                { id: "top-left", cursor: "nwse-resize", top: -4, left: -4 },
                { id: "top", cursor: "ns-resize", top: -4, left: "50%", transform: "translateX(-50%)" },
                { id: "top-right", cursor: "nesw-resize", top: -4, right: -4 },
                { id: "left", cursor: "ew-resize", top: "50%", left: -4, transform: "translateY(-50%)" },
                { id: "right", cursor: "ew-resize", top: "50%", right: -4, transform: "translateY(-50%)" },
                { id: "bottom-left", cursor: "nesw-resize", bottom: -4, left: -4 },
                { id: "bottom", cursor: "ns-resize", bottom: -4, left: "50%", transform: "translateX(-50%)" },
                { id: "bottom-right", cursor: "nwse-resize", bottom: -4, right: -4 },
              ].map((handle) => (
                <div
                  key={handle.id}
                  onMouseDown={(e) => {
                    e.preventDefault(); // Ngăn textarea blur khi kéo resize
                    handleTextareaResize(e, handle.id);
                  }}
                  style={{
                    position: "absolute",
                    width: 8,
                    height: 8,
                    background: "#3b82f6",
                    border: "1px solid #fff",
                    borderRadius: 2,
                    cursor: handle.cursor,
                    zIndex: 10,
                    top: handle.top,
                    left: handle.left,
                    right: handle.right,
                    bottom: handle.bottom,
                    transform: handle.transform,
                    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                  }}
                />
              ))}
            </div>
          );
        })()}

        {!editing && !bodyDragging && (tool === "select" || tool === "text") && activeIds.length === 1 && selectedAnns[0]?.type === "text" && (() => {
          const a = selectedAnns[0] as TextAnn;
          const pos = textPos(a.id);
          return (
            <div style={{ position: "absolute", left: pos.x, top: Math.max(4, pos.y - 36), zIndex: 12 }}>
              <CalloutBar ann={a} />
            </div>
          );
        })()}

        {cropRect && (() => {
          // Đặt 3 nút (Áp dụng / Sao chép / Huỷ) ở cạnh ĐÁY, canh theo GÓC PHẢI khung crop
          // (toạ độ hiển thị = toạ độ ảnh × scale). Nếu sát đáy stage thì lật vào trong khung.
          const BTN_H = 34;
          const cropBottom = (cropRect.y + cropRect.height) * scale;
          const cropRight = (cropRect.x + cropRect.width) * scale;
          const top =
            cropBottom + 8 + BTN_H > box.h ? cropBottom - BTN_H - 8 : cropBottom + 8;
          // Canh mép phải hàng nút vào mép phải khung bằng thuộc tính `right`
          // (neo theo mép phải container) để width khả dụng = box.w - right luôn
          // đủ rộng → nút không bị bóp/xuống dòng khi khung sát mép phải. Giữ
          // tối thiểu 280px chỗ trống để hàng nút hiển thị đủ 3 nút.
          const rightInset = Math.max(0, Math.min(box.w - cropRight, box.w - 280));
          return (
            <div
              style={{
                position: "absolute",
                top,
                right: rightInset,
                display: "flex",
                gap: 8,
                zIndex: 10,
                whiteSpace: "nowrap",
              }}
            >
              <button onClick={applyCrop} style={cropBtn(true)}>
                {t("crop.apply")}
              </button>
              <button onClick={handleCopyCrop} style={cropBtn(false)} title="Ctrl/Cmd+C">
                {t("crop.copy")}
              </button>
              <button onClick={() => setCropRect(null)} style={cropBtn(false)}>
                {t("crop.cancel")}
              </button>
            </div>
          );
        })()}

      </div>
      </div> {/* end flex centering */}
    </div>  {/* end scroll container */}

    {/* Zoom bar — absolute trên outer wrapper, không bị cuộn. Ẩn ở Chụp nhanh. */}
    {!hideZoomBar && (
    <div style={zoomBar}>
      {/* DPI badge — chỉ hiện khi HiDPI (Retina 2×, 3×, ...) */}
      {dpiLabel && (
        <>
          <span
            style={dpiBadge}
            title={t("annotationCanvas.hidpiInfo", { label: dpiLabel, physicalW: doc.imgW, physicalH: doc.imgH, logicalW: Math.round(doc.imgW / scaleFactor), logicalH: Math.round(doc.imgH / scaleFactor) })}
          >
            {dpiLabel}
          </span>
          <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)", margin: "0 2px" }} />
        </>
      )}
      {/* Nút Fit */}
      <button
        onClick={doZoomFit}
        style={{ ...zoomChip, ...(zoom === 1 ? zoomChipActive : null) }}
        title={t("annotationCanvas.fitWindow")}
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
          <path d="M1 4V1h3M9 1h3v3M12 9v3H9M4 12H1V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Fit
      </button>

      {/* Nút 100% */}
      <button
        onClick={doZoomActual}
        style={{ ...zoomChip, ...(Math.abs(scale - 1) < 0.005 ? zoomChipActive : null) }}
        title={t("annotationCanvas.actualSize")}
      >100%</button>

      {/* Separator */}
      <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)", margin: "0 2px" }} />

      {/* Zoom out */}
      <button
        onClick={doZoomOut}
        disabled={atZoomMin}
        style={{ ...zoomIconBtn, ...(atZoomMin ? zoomBtnDisabled : null) }}
        title={t("annotationCanvas.zoomOut")}
        aria-label={t("annotationCanvas.zoomOutLabel")}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {/* % hiển thị, click để nhập tay */}
      <button
        onClick={toggleFitActual}
        style={zoomPctBtn}
        title={t("annotationCanvas.toggleZoom")}
      >
        {zoomPct}%
      </button>

      {/* Zoom in */}
      <button
        onClick={doZoomIn}
        disabled={atZoomMax}
        style={{ ...zoomIconBtn, ...(atZoomMax ? zoomBtnDisabled : null) }}
        title={t("annotationCanvas.zoomIn")}
        aria-label={t("annotationCanvas.zoomInLabel")}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="6" y1="4" x2="6" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
    )}
    </div>
  );

  function textPos(id: string) {
    const a = doc?.annotations.find((x) => x.id === id);
    if (!a) return { x: 0, y: 0 };
    return { x: (a.x + bgPad) * scale, y: (a.y + bgPad) * scale };
  }
});

AnnotationStage.displayName = "AnnotationStage";
export default AnnotationStage;
