import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Stage, Layer, Rect, Line, Ellipse, Text, Circle, Group, Image as KImage, Transformer, Arrow } from "react-konva";
import type Konva from "konva";
import { useEditor } from "../store";
import type { Annotation } from "../model";
import { uid } from "../model";

export interface StageHandle {
  exportPng: () => string | null;
  flattenPng: () => string | null;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

interface Draft {
  type: "rect" | "ellipse" | "crop" | "highlight" | "blur";
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Draft cho mũi tên / đường thẳng đang kéo. */
interface ArrowDraft {
  type: "arrow" | "line" | "numbered-arrow";
  x: number;
  y: number;
  x2: number;
  y2: number;
}

const AnnotationStage = forwardRef<StageHandle>((_props, ref) => {
  const doc = useEditor((s) => s.doc);
  const tool = useEditor((s) => s.tool);
  const color = useEditor((s) => s.color);
  const highlightColor = useEditor((s) => s.highlightColor);
  const strokeWidth = useEditor((s) => s.strokeWidth);
  const fontSize = useEditor((s) => s.fontSize);
  const blurRadius = useEditor((s) => s.blurRadius);
  const blurMode   = useEditor((s) => s.blurMode);
  const selectedId = useEditor((s) => s.selectedId);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const scale = fitScale * zoom;
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Ref luôn trỏ đến giá trị mới nhất — dùng trong wheel handler (closure cũ)
  const fitScaleRef = useRef(fitScale);
  const docRef = useRef(doc);
  useEffect(() => { fitScaleRef.current = fitScale; }, [fitScale]);
  useEffect(() => { docRef.current = doc; }, [doc]);

  // Scroll cần apply sau khi React render canvas ở scale mới
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null);

  // --- Pan (kéo để cuộn) ---
  // Kích hoạt bằng Space+drag hoặc middle mouse button.
  const [isPanMode, setIsPanMode]   = useState(false); // Space đang giữ
  const [isPanDrag, setIsPanDrag]   = useState(false); // đang kéo thật sự
  const isPanModeRef = useRef(false);
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [arrowDraft, setArrowDraft] = useState<ArrowDraft | null>(null);
  const [cropRect, setCropRect] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  // Focus tường minh ô nhập chữ khi bắt đầu sửa. `autoFocus` không đáng tin
  // trong webview (Tauri) khi phần tử được tạo ngay trong handler mousedown —
  // nếu mất focus, phím gõ rơi xuống window và bị hiểu thành phím tắt công cụ.
  useEffect(() => {
    // Đồng bộ trạng thái "đang gõ chữ" lên store để phím tắt công cụ
    // (v/r/o/t/n/c) không cướp ký tự dù focus chưa về textarea.
    useEditor.getState().setEditingText(editing?.id ?? null);
    if (!editing) {
      console.log("[text-input] kết thúc nhập (editing = null)");
      return;
    }
    console.log("[text-input] bắt đầu nhập", { id: editing.id });
    const id = window.setTimeout(() => {
      const ta = textareaRef.current;
      console.log("[text-input] thử focus textarea", {
        hasTextarea: !!ta,
        activeBefore: document.activeElement?.tagName,
      });
      if (ta) {
        ta.focus();
        ta.select();
        console.log("[text-input] đã focus", {
          activeAfter: document.activeElement?.tagName,
          focused: document.activeElement === ta,
        });
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [editing?.id]);

  // Tải ảnh nền
  useEffect(() => {
    if (!doc) return;
    const el = new window.Image();
    el.src = doc.image;
    el.onload = () => setImg(el);
  }, [doc?.image]);

  // Tính fitScale để ảnh vừa container, reset zoom khi tải ảnh mới
  useLayoutEffect(() => {
    if (!doc) return;
    const measure = () => {
      const c = containerRef.current;
      if (!c) return;
      // Padding nhỏ (8px mỗi bên) để ảnh không dính mép cứng
      const cw = c.clientWidth - 16;
      const ch = c.clientHeight - 16;
      // Không giới hạn max — ảnh nhỏ hơn window sẽ hiển thị 1:1 hoặc lớn hơn
      const s = Math.max(0.05, Math.min(cw / doc.imgW, ch / doc.imgH));
      setFitScale(s);
    };
    setZoom(1);
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [doc?.imgW, doc?.imgH]);

  // Cập nhật kích thước stage khi scale thay đổi
  useEffect(() => {
    if (!doc) return;
    setBox({ w: doc.imgW * scale, h: doc.imgH * scale });
  }, [scale, doc?.imgW, doc?.imgH]);

  // Gắn Transformer vào node đang chọn
  useEffect(() => {
    const tr = trRef.current;
    const layer = layerRef.current;
    if (!tr || !layer) return;
    if (selectedId && tool === "select") {
      const node = layer.findOne("#" + selectedId);
      tr.nodes(node ? [node] : []);
    } else {
      tr.nodes([]);
    }
    layer.batchDraw();
  }, [selectedId, tool, doc]);

  // Zoom giữ nguyên điểm (vx,vy) — toạ độ trong viewport container (px từ mép
  // trái/trên). Dùng chung cho wheel/pinch, nút bấm và phím tắt nên mọi đường
  // vào zoom đều neo đúng tâm, không bị "trôi" ảnh. Truyền factor (nhân vào zoom)
  // hoặc target (zoom tuyệt đối). Logic scroll-centering dẫn xuất từ phương trình
  // "cursor ≡ canvas_left + imageX × scale" (xem comment wheel bên dưới).
  const zoomAround = (vx: number, vy: number, opts: { factor?: number; target?: number }) => {
    const el = containerRef.current;
    if (!el) return;
    setZoom((oldZoom) => {
      const fs = fitScaleRef.current;
      const d = docRef.current;
      if (!d) return oldZoom;

      const newZoom = clampZoom(opts.target ?? oldZoom * (opts.factor ?? 1));
      if (newZoom === oldZoom) return oldZoom; // đã chạm giới hạn → không đổi

      const oldScale = fs * oldZoom;
      const newScale = fs * newZoom;
      const containerW = el.clientWidth;
      const containerH = el.clientHeight;

      const oldOffsetX = Math.max(0, (containerW - d.imgW * oldScale) / 2);
      const oldOffsetY = Math.max(0, (containerH - d.imgH * oldScale) / 2);
      const imageX = (el.scrollLeft + vx - oldOffsetX) / oldScale;
      const imageY = (el.scrollTop  + vy - oldOffsetY) / oldScale;

      const newOffsetX = Math.max(0, (containerW - d.imgW * newScale) / 2);
      const newOffsetY = Math.max(0, (containerH - d.imgH * newScale) / 2);
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
  const doZoomFit = () => { pendingScrollRef.current = null; setZoom(1); };
  // Actual size 1:1 pixel: scale=1 ⇒ zoom = 1/fitScale. Neo tâm viewport.
  const doZoomActual = () => zoomCenter({ target: 1 / fitScaleRef.current });
  // Toggle nhanh giữa Fit và 100% khi bấm vào ô phần trăm.
  const toggleFitActual = () =>
    Math.abs(scale - 1) < 0.001 ? doZoomFit() : doZoomActual();

  useImperativeHandle(ref, () => ({
    exportPng: () => {
      const stage = stageRef.current;
      if (!stage || !doc) return null;
      trRef.current?.nodes([]);
      const url = stage.toDataURL({ pixelRatio: 1 / scale, mimeType: "image/png" });
      return url;
    },
    flattenPng: () => {
      // Export toàn bộ stage thành PNG rồi trả về data URL.
      // Caller (Editor) sẽ dùng loadDoc để replace ảnh nền + xoá annotations
      // → không còn layer riêng, an toàn tuyệt đối.
      const stage = stageRef.current;
      if (!stage || !doc) return null;
      trRef.current?.nodes([]);
      return stage.toDataURL({ pixelRatio: 1 / scale, mimeType: "image/png" });
    },
    zoomIn:  doZoomIn,
    zoomOut: doZoomOut,
    zoomFit: doZoomFit,
  }));

  // Không gắn ref vào fallback: containerRef chỉ trỏ scroll container khi doc sẵn sàng,
  // tránh wheel listener bị attach vào div đã unmount khi doc load sau.
  if (!doc) return <div style={fill} />;

  const toImg = (p: { x: number; y: number }) => ({ x: p.x / scale, y: p.y / scale });

  const onStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    // Pan mode (Space giữ) hoặc middle-button → nhường cho pointer handler
    if (isPanModeRef.current || e.evt.button === 1) return;
    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const { x, y } = toImg(pos);

    if (tool === "select") {
      if (e.target === stage || e.target.id() === "bg") useEditor.getState().select(null);
      return;
    }
    if (tool === "rect" || tool === "ellipse" || tool === "crop" || tool === "highlight" || tool === "blur") {
      setDraft({ type: tool, x, y, width: 0, height: 0 });
      return;
    }
    if (tool === "arrow" || tool === "line" || tool === "numbered-arrow") {
      setArrowDraft({ type: tool, x, y, x2: x, y2: y });
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
        radius: 22,
        color,
        strokeWidth,
      });
      return;
    }
    if (tool === "text") {
      // Chặn default action của mousedown — nếu không, sau khi handler chạy
      // trình duyệt sẽ giật focus về <canvas> của Konva, làm textarea blur ngay
      // (onBlur → commitText rỗng → annotation bị xoá trước khi gõ được chữ).
      e.evt.preventDefault();
      const id = uid();
      console.log("[text-input] tạo text annotation", { id, x, y });
      useEditor.getState().addAnnotation({
        id,
        type: "text",
        x,
        y,
        text: "",
        fontSize,
        color,
        strokeWidth,
      });
      beginEdit(id, "");
    }
  };

  const onStageMouseMove = () => {
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos) return;
    const { x, y } = toImg(pos);
    if (draft) {
      setDraft({ ...draft, width: x - draft.x, height: y - draft.y });
    }
    if (arrowDraft) {
      setArrowDraft({ ...arrowDraft, x2: x, y2: y });
    }
  };

  const onStageMouseUp = () => {
    if (arrowDraft) {
      const dx = arrowDraft.x2 - arrowDraft.x;
      const dy = arrowDraft.y2 - arrowDraft.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      setArrowDraft(null);
      if (len < 8) return;
      if (arrowDraft.type === "line") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "line",
          x: arrowDraft.x, y: arrowDraft.y,
          x2: arrowDraft.x2, y2: arrowDraft.y2,
          color, strokeWidth,
        });
      } else if (arrowDraft.type === "arrow") {
        useEditor.getState().addAnnotation({
          id: uid(), type: "arrow",
          x: arrowDraft.x, y: arrowDraft.y,
          x2: arrowDraft.x2, y2: arrowDraft.y2,
          color, strokeWidth,
        });
      } else {
        const value = useEditor.getState().nextStep();
        const radius = Math.max(strokeWidth * 4, 14);
        useEditor.getState().addAnnotation({
          id: uid(), type: "numbered-arrow",
          x: arrowDraft.x, y: arrowDraft.y,
          x2: arrowDraft.x2, y2: arrowDraft.y2,
          value, radius, color, strokeWidth,
        });
      }
      return;
    }
    if (!draft) return;
    const x = Math.min(draft.x, draft.x + draft.width);
    const y = Math.min(draft.y, draft.y + draft.height);
    const width = Math.abs(draft.width);
    const height = Math.abs(draft.height);
    setDraft(null);
    if (width < 4 || height < 4) return;

    if (draft.type === "crop") {
      setCropRect({ type: "crop", x, y, width, height });
      return;
    }
    if (draft.type === "highlight") {
      useEditor.getState().addAnnotation({
        id: uid(), type: "highlight",
        x, y, width, height,
        color: highlightColor, strokeWidth,
      });
      return;
    }
    if (draft.type === "blur") {
      useEditor.getState().addAnnotation({
        id: uid(), type: "blur",
        x, y, width, height,
        color: "#000", strokeWidth,
        blurRadius,
        blurMode: useEditor.getState().blurMode,
        solidColor: useEditor.getState().blurSolidColor,
      });
      return;
    }
    useEditor.getState().addAnnotation({
      id: uid(), type: draft.type as "rect" | "ellipse",
      x, y, width, height, color, strokeWidth,
    });
  };

  const onDragEnd = (id: string, e: Konva.KonvaEventObject<DragEvent>) => {
    useEditor.getState().updateAnnotation(id, { x: e.target.x(), y: e.target.y() });
  };

  const onTransformEnd = (a: Annotation, node: Konva.Node) => {
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    if (a.type === "rect" || a.type === "ellipse" || a.type === "highlight" || a.type === "blur") {
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
    }
  };

  const applyCrop = () => {
    if (!cropRect || !img) return;
    const { x, y, width, height } = cropRect;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
    const newImage = canvas.toDataURL("image/png");
    const annotations = doc.annotations
      .map((a) => ({ ...a, x: a.x - x, y: a.y - y }))
      .filter((a) => a.x > -50 && a.y > -50 && a.x < width + 50 && a.y < height + 50);
    useEditor.getState().applyCrop(newImage, Math.round(width), Math.round(height), annotations);
    setCropRect(null);
    useEditor.getState().setTool("select");
  };

  // Mở ô nhập chữ và focus NGAY trong cùng cử chỉ người dùng. flushSync ép
  // textarea render đồng bộ để ref sẵn sàng — bắt buộc cho WKWebView (Tauri),
  // nơi .focus() chỉ ăn khi chạy trong stack sự kiện chuột gốc.
  const beginEdit = (id: string, value: string) => {
    flushSync(() => setEditing({ id, value }));
    const ta = textareaRef.current;
    console.log("[text-input] beginEdit focus đồng bộ", { id, hasTextarea: !!ta });
    if (ta) {
      ta.focus();
      ta.setSelectionRange(value.length, value.length);
    }
  };

  const commitText = () => {
    if (!editing) return;
    const value = editing.value.trim();
    console.log("[text-input] commit", { id: editing.id, value });
    if (!value) {
      useEditor.getState().select(editing.id);
      useEditor.getState().removeSelected();
    } else {
      useEditor.getState().updateAnnotation(editing.id, { text: value } as Partial<Annotation>);
    }
    setEditing(null);
  };

  const draggable = tool === "select";

  // % so với pixel gốc của ảnh (scale), KHÔNG phải so với fit — 100% = 1:1 pixel.
  const zoomPct = Math.round(scale * 100);
  const atZoomMin = zoom <= ZOOM_MIN + 1e-6;
  const atZoomMax = zoom >= ZOOM_MAX - 1e-6;

  // Step / numbered-arrow luôn tròn → keepRatio. Line/arrow không có bounding box resize.
  const selectedAnn = selectedId ? doc.annotations.find((a) => a.id === selectedId) : null;
  const isCircleSelected = selectedAnn?.type === "step" || selectedAnn?.type === "numbered-arrow";
  // Line / arrow → Transformer ẩn (kéo bằng draggable, không resize bounding box)
  const isLineSelected = selectedAnn?.type === "line" || selectedAnn?.type === "arrow";

  // DPI info từ metadata ảnh chụp (1 = normal, 2 = Retina 2×, ...)
  const scaleFactor = doc.scaleFactor ?? 1;
  const dpiLabel = scaleFactor >= 2 ? `${scaleFactor}×` : null;

  return (
    // outer: bao quanh cả scroll area và zoom bar cố định
    <div style={{ ...fill, position: "relative" }}>
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
          onMouseDown={onStageMouseDown}
          onMouseMove={onStageMouseMove}
          onMouseUp={onStageMouseUp}
          style={{ cursor: isPanMode ? (isPanDrag ? "grabbing" : "grab") : tool === "select" ? "default" : tool === "text" ? "text" : "crosshair" }}
        >
          <Layer ref={layerRef} scaleX={scale} scaleY={scale}>
            {img && <KImage image={img} id="bg" width={doc.imgW} height={doc.imgH} listening={false} />}

            {doc.annotations.map((a) => {
              if (a.type === "rect")
                return (
                  <Rect
                    key={a.id}
                    id={a.id}
                    x={a.x}
                    y={a.y}
                    width={a.width}
                    height={a.height}
                    stroke={a.color}
                    strokeWidth={a.strokeWidth}
                    draggable={draggable}
                    onClick={() => useEditor.getState().select(a.id)}
                    onTap={() => useEditor.getState().select(a.id)}
                    onDragEnd={(e) => onDragEnd(a.id, e)}
                    onTransformEnd={(e) => onTransformEnd(a, e.target)}
                  />
                );
              if (a.type === "ellipse")
                return (
                  <Ellipse
                    key={a.id}
                    id={a.id}
                    x={a.x + a.width / 2}
                    y={a.y + a.height / 2}
                    radiusX={Math.abs(a.width / 2)}
                    radiusY={Math.abs(a.height / 2)}
                    stroke={a.color}
                    strokeWidth={a.strokeWidth}
                    draggable={draggable}
                    onClick={() => useEditor.getState().select(a.id)}
                    onTap={() => useEditor.getState().select(a.id)}
                    onDragEnd={(e) =>
                      useEditor.getState().updateAnnotation(a.id, {
                        x: e.target.x() - a.width / 2,
                        y: e.target.y() - a.height / 2,
                      })
                    }
                    onTransformEnd={(e) => onTransformEnd(a, e.target)}
                  />
                );
              if (a.type === "text")
                return (
                  <Text
                    key={a.id}
                    id={a.id}
                    x={a.x}
                    y={a.y}
                    text={a.text || " "}
                    fontSize={a.fontSize}
                    fill={a.color}
                    fontStyle="bold"
                    draggable={draggable}
                    onClick={() => useEditor.getState().select(a.id)}
                    onDblClick={() => beginEdit(a.id, a.text)}
                    onDragEnd={(e) => onDragEnd(a.id, e)}
                  />
                );
              // step
              if (a.type === "step")
              return (
                <Group
                  key={a.id}
                  id={a.id}
                  x={a.x}
                  y={a.y}
                  draggable={draggable}
                  onClick={() => useEditor.getState().select(a.id)}
                  onTap={() => useEditor.getState().select(a.id)}
                  onDragEnd={(e) => onDragEnd(a.id, e)}
                  onTransformEnd={(e) => onTransformEnd(a, e.target)}
                >
                  <Circle radius={a.radius} fill={a.color} />
                  <Text
                    text={String(a.value)}
                    fontSize={a.radius}
                    fontStyle="bold"
                    fill="#ffffff"
                    width={a.radius * 2}
                    height={a.radius * 2}
                    offsetX={a.radius}
                    offsetY={a.radius}
                    align="center"
                    verticalAlign="middle"
                  />
                </Group>
              );
              // arrow
              if (a.type === "arrow")
              return (
                <Arrow
                  key={a.id}
                  id={a.id}
                  points={[a.x, a.y, a.x2, a.y2]}
                  stroke={a.color}
                  strokeWidth={a.strokeWidth}
                  fill={a.color}
                  pointerLength={Math.max(10, a.strokeWidth * 3)}
                  pointerWidth={Math.max(8, a.strokeWidth * 2.5)}
                  lineCap="round"
                  lineJoin="round"
                  draggable={draggable}
                  onClick={() => useEditor.getState().select(a.id)}
                  onTap={() => useEditor.getState().select(a.id)}
                  onDragEnd={(e) => {
                    const dx = e.target.x();
                    const dy = e.target.y();
                    e.target.x(0);
                    e.target.y(0);
                    useEditor.getState().updateAnnotation(a.id, {
                      x: a.x + dx, y: a.y + dy,
                      x2: a.x2 + dx, y2: a.y2 + dy,
                    } as Partial<Annotation>);
                  }}
                />
              );
              // line
              if (a.type === "line")
              return (
                <Line
                  key={a.id}
                  id={a.id}
                  points={[a.x, a.y, a.x2, a.y2]}
                  stroke={a.color}
                  strokeWidth={a.strokeWidth}
                  lineCap="round"
                  lineJoin="round"
                  draggable={draggable}
                  onClick={() => useEditor.getState().select(a.id)}
                  onTap={() => useEditor.getState().select(a.id)}
                  onDragEnd={(e) => {
                    const dx = e.target.x();
                    const dy = e.target.y();
                    e.target.x(0);
                    e.target.y(0);
                    useEditor.getState().updateAnnotation(a.id, {
                      x: a.x + dx, y: a.y + dy,
                      x2: a.x2 + dx, y2: a.y2 + dy,
                    } as Partial<Annotation>);
                  }}
                />
              );
              // numbered-arrow
              if (a.type === "numbered-arrow") {
                const dx = a.x2 - a.x;
                const dy = a.y2 - a.y;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                // Đặt vòng tròn tại đuôi mũi tên (điểm bắt đầu)
                const nx = dx / len;
                const ny = dy / len;
                // Điểm bắt đầu thật sự của đường thẳng = mép vòng tròn
                const startX = a.x + nx * a.radius;
                const startY = a.y + ny * a.radius;
                return (
                  <Group
                    key={a.id}
                    id={a.id}
                    draggable={draggable}
                    onClick={() => useEditor.getState().select(a.id)}
                    onTap={() => useEditor.getState().select(a.id)}
                    onDragEnd={(e) => {
                      const ddx = e.target.x();
                      const ddy = e.target.y();
                      e.target.x(0);
                      e.target.y(0);
                      useEditor.getState().updateAnnotation(a.id, {
                        x: a.x + ddx, y: a.y + ddy,
                        x2: a.x2 + ddx, y2: a.y2 + ddy,
                      } as Partial<Annotation>);
                    }}
                    onTransformEnd={(e) => onTransformEnd(a, e.target)}
                  >
                    {/* Vòng tròn số thứ tự tại đuôi */}
                    <Circle x={a.x} y={a.y} radius={a.radius} fill={a.color} />
                    <Text
                      x={a.x}
                      y={a.y}
                      text={String(a.value)}
                      fontSize={a.radius}
                      fontStyle="bold"
                      fill="#ffffff"
                      width={a.radius * 2}
                      height={a.radius * 2}
                      offsetX={a.radius}
                      offsetY={a.radius}
                      align="center"
                      verticalAlign="middle"
                    />
                    {/* Mũi tên từ mép vòng tròn đến đầu mũi tên */}
                    <Arrow
                      points={[startX, startY, a.x2, a.y2]}
                      stroke={a.color}
                      strokeWidth={a.strokeWidth}
                      fill={a.color}
                      pointerLength={Math.max(10, a.strokeWidth * 3)}
                      pointerWidth={Math.max(8, a.strokeWidth * 2.5)}
                      lineCap="round"
                      lineJoin="round"
                    />
                  </Group>
                );
              }
              // highlight
              if (a.type === "highlight")
              return (
                <Rect
                  key={a.id}
                  id={a.id}
                  x={a.x}
                  y={a.y}
                  width={a.width}
                  height={a.height}
                  fill={a.color}
                  opacity={0.38}
                  draggable={draggable}
                  onClick={() => useEditor.getState().select(a.id)}
                  onTap={() => useEditor.getState().select(a.id)}
                  onDragEnd={(e) => onDragEnd(a.id, e)}
                  onTransformEnd={(e) => onTransformEnd(a, e.target)}
                />
              );
              // blur — dùng canvas 2D để process pixel
              if (a.type === "blur")
              return (
                <BlurRect
                  key={a.id}
                  ann={a}
                  img={img}
                  draggable={draggable}
                  onSelect={() => useEditor.getState().select(a.id)}
                  onDragEnd={(newX, newY) =>
                    useEditor.getState().updateAnnotation(a.id, {
                      x: newX, y: newY,
                    } as Partial<Annotation>)
                  }
                  onTransformEnd={(node) => onTransformEnd(a, node)}
                />
              );
              return null;
            })}

            {/* Draft preview cho rect/ellipse/highlight/blur/crop */}
            {draft && draft.type === "ellipse" ? (
              <Ellipse
                x={draft.x + draft.width / 2}
                y={draft.y + draft.height / 2}
                radiusX={Math.abs(draft.width / 2)}
                radiusY={Math.abs(draft.height / 2)}
                stroke={color}
                strokeWidth={strokeWidth}
                dash={[6, 4]}
              />
            ) : draft && draft.type === "highlight" ? (
              <Rect
                x={draft.x} y={draft.y} width={draft.width} height={draft.height}
                fill={highlightColor} opacity={0.38}
              />
            ) : draft && draft.type === "blur" ? (
              <Rect
                x={draft.x} y={draft.y} width={draft.width} height={draft.height}
                fill={blurMode === "solid" ? useEditor.getState().blurSolidColor : "#334155"}
                opacity={blurMode === "solid" ? 0.85 : 0.35}
                stroke={blurMode === "pixelate" ? "#f59e0b" : blurMode === "solid" ? "#ef4444" : "#94a3b8"}
                strokeWidth={1.5} dash={[6, 3]}
              />
            ) : draft ? (
              <Rect
                x={draft.x} y={draft.y} width={draft.width} height={draft.height}
                stroke={draft.type === "crop" ? "#3b82f6" : color}
                strokeWidth={draft.type === "crop" ? 2 : strokeWidth}
                dash={[6, 4]}
              />
            ) : null}

            {/* Preview mũi tên / đường thẳng đang kéo */}
            {arrowDraft && (() => {
              const dx = arrowDraft.x2 - arrowDraft.x;
              const dy = arrowDraft.y2 - arrowDraft.y;
              const len = Math.sqrt(dx * dx + dy * dy) || 1;
              const nx = dx / len;
              const ny = dy / len;
              if (arrowDraft.type === "line") {
                return (
                  <Line
                    points={[arrowDraft.x, arrowDraft.y, arrowDraft.x2, arrowDraft.y2]}
                    stroke={color} strokeWidth={strokeWidth}
                    lineCap="round" opacity={0.7} dash={[8, 4]}
                  />
                );
              }
              if (arrowDraft.type === "arrow") {
                return (
                  <Arrow
                    points={[arrowDraft.x, arrowDraft.y, arrowDraft.x2, arrowDraft.y2]}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    fill={color}
                    pointerLength={Math.max(10, strokeWidth * 3)}
                    pointerWidth={Math.max(8, strokeWidth * 2.5)}
                    lineCap="round"
                    lineJoin="round"
                    opacity={0.7}
                    dash={[8, 4]}
                  />
                );
              }
              // numbered-arrow preview
              const radius = Math.max(strokeWidth * 4, 14);
              const startX = arrowDraft.x + nx * radius;
              const startY = arrowDraft.y + ny * radius;
              return (
                <Group opacity={0.7}>
                  <Circle x={arrowDraft.x} y={arrowDraft.y} radius={radius} fill={color} />
                  <Arrow
                    points={[startX, startY, arrowDraft.x2, arrowDraft.y2]}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    fill={color}
                    pointerLength={Math.max(10, strokeWidth * 3)}
                    pointerWidth={Math.max(8, strokeWidth * 2.5)}
                    lineCap="round"
                    lineJoin="round"
                    dash={[8, 4]}
                  />
                </Group>
              );
            })()}

            {cropRect && (
              <Rect
                x={cropRect.x}
                y={cropRect.y}
                width={cropRect.width}
                height={cropRect.height}
                stroke="#3b82f6"
                strokeWidth={2}
                dash={[8, 4]}
              />
            )}

            <Transformer
              ref={trRef}
              rotateEnabled={false}
              ignoreStroke
              keepRatio={isCircleSelected}
              visible={!isLineSelected}
              enabledAnchors={
                isCircleSelected
                  ? ["top-left", "top-right", "bottom-left", "bottom-right"]
                  : ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]
              }
              boundBoxFunc={(_old, next) => next}
            />
          </Layer>
        </Stage>

        {editing && (
          <textarea
            ref={textareaRef}
            autoFocus
            value={editing.value}
            onChange={(e) => {
              console.log("[text-input] onChange", { value: e.target.value });
              setEditing({ ...editing, value: e.target.value });
            }}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitText();
              }
              if (e.key === "Escape") commitText();
            }}
            style={{
              position: "absolute",
              left: textPos(editing.id).x,
              top: textPos(editing.id).y,
              fontSize: fontSize * scale,
              fontWeight: "bold",
              color,
              background: "rgba(0,0,0,0.35)",
              border: "1px dashed #3b82f6",
              outline: "none",
              resize: "none",
              minWidth: 120,
              padding: 2,
              // Bù lại user-select:none kế thừa từ <body> — nếu không, WKWebView
              // (Tauri) sẽ không cho gõ chữ vào ô này.
              WebkitUserSelect: "text",
              userSelect: "text",
            }}
          />
        )}

        {cropRect && (
          <div style={{ position: "absolute", left: 8, bottom: 8, display: "flex", gap: 8 }}>
            <button onClick={applyCrop} style={cropBtn(true)}>
              Áp dụng crop
            </button>
            <button onClick={() => setCropRect(null)} style={cropBtn(false)}>
              Huỷ
            </button>
          </div>
        )}

      </div>
      </div> {/* end flex centering */}
    </div>  {/* end scroll container */}

    {/* Zoom bar — absolute trên outer wrapper, không bị cuộn, luôn hiện */}
    <div style={zoomBar}>
      {/* DPI badge — chỉ hiện khi HiDPI (Retina 2×, 3×, ...) */}
      {dpiLabel && (
        <>
          <span
            style={dpiBadge}
            title={`HiDPI ${dpiLabel} — ${doc.imgW}×${doc.imgH}px vật lý (${Math.round(doc.imgW / scaleFactor)}×${Math.round(doc.imgH / scaleFactor)} pts)`}
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
        title="Vừa khung — ảnh fill cửa sổ (Ctrl/Cmd 0)"
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
        title="Kích thước thật — 1 pixel ảnh = 1 pixel màn hình"
      >100%</button>

      {/* Separator */}
      <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)", margin: "0 2px" }} />

      {/* Zoom out */}
      <button
        onClick={doZoomOut}
        disabled={atZoomMin}
        style={{ ...zoomIconBtn, ...(atZoomMin ? zoomBtnDisabled : null) }}
        title="Thu nhỏ (Ctrl/Cmd −)"
        aria-label="Thu nhỏ"
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
        title="Bấm để đổi Fit ↔ 100%"
      >
        {zoomPct}%
      </button>

      {/* Zoom in */}
      <button
        onClick={doZoomIn}
        disabled={atZoomMax}
        style={{ ...zoomIconBtn, ...(atZoomMax ? zoomBtnDisabled : null) }}
        title="Phóng to (Ctrl/Cmd +)"
        aria-label="Phóng to"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="6" y1="4" x2="6" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
    </div>
  );

  function textPos(id: string) {
    const a = doc?.annotations.find((x) => x.id === id);
    if (!a) return { x: 0, y: 0 };
    return { x: a.x * scale, y: a.y * scale };
  }
});

const fill: React.CSSProperties = { width: "100%", height: "100%" };

const zoomBar: React.CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: 12,
  display: "flex",
  alignItems: "center",
  gap: 2,
  background: "rgba(18,18,22,0.90)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 10,
  padding: "3px 5px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
  zIndex: 10,
};

/** Chip có label: Fit / 100% */
const zoomChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 26,
  padding: "0 8px",
  borderRadius: 6,
  background: "transparent",
  color: "rgba(242,242,245,0.75)",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.12s, color 0.12s",
};

const zoomChipActive: React.CSSProperties = {
  background: "rgba(59,130,246,0.22)",
  color: "#7eb8ff",
};

/** Nút icon tròn: zoom in / zoom out */
const zoomIconBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  background: "transparent",
  color: "rgba(242,242,245,0.75)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
};

/** Ô hiển thị % zoom — nhấn để toggle Fit / 100% */
const zoomPctBtn: React.CSSProperties = {
  height: 26,
  minWidth: 46,
  padding: "0 6px",
  borderRadius: 6,
  background: "transparent",
  color: "rgba(242,242,245,0.9)",
  fontSize: 12,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  cursor: "pointer",
  textAlign: "center",
};

const zoomBtnDisabled: React.CSSProperties = {
  opacity: 0.3,
  cursor: "not-allowed",
};

function cropBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? "#3b82f6" : "#2a2a30",
    color: "#fff",
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 13,
  };
}

/** Badge HiDPI — hiện khi ảnh là Retina 2× trở lên */
const dpiBadge: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 18,
  padding: "0 6px",
  borderRadius: 4,
  background: "rgba(59,130,246,0.18)",
  color: "#7eb8ff",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.04em",
  cursor: "default",
};

// ─────────────────────────────────────────────────────────────────────────────
// BlurRect — render vùng che mờ với 3 mode:
//
//  "blur"     — Gaussian blur qua CSS filter (mềm, không phá vỡ cấu trúc ảnh)
//  "pixelate" — Mosaic: scale ảnh xuống nhỏ (tileSize × tileSize) rồi scale
//               lại to → hiệu ứng pixel hoá, che chắn mạnh hơn
//  "solid"    — Hình chữ nhật màu đặc, không thể hoàn tác bằng kỹ thuật xử lý ảnh
//
// Pipeline chung: cắt patch từ ảnh gốc (image-space coords) → xử lý → KImage.
// Mọi mode đều hoạt động đúng với exportPng (toDataURL lấy pixel đã render).
//
// Flatten/export an toàn:
//   BlurAnn được flatten thành pixel trước khi export bằng cách exportPng dùng
//   pixelRatio = 1/scale → các BlurRect đã được KImage render thật trên canvas
//   Konva. Để an toàn tối đa với solid redact, Toolbar có nút "Flatten" để
//   merge toàn bộ annotation vào ảnh nền → không còn layer tách biệt.
// ─────────────────────────────────────────────────────────────────────────────

interface BlurRectProps {
  ann: import("../model").BlurAnn;
  img: HTMLImageElement | null;
  draggable: boolean;
  onSelect: () => void;
  /** Truyền về tọa độ tuyệt đối mới (x, y) sau khi drag xong. */
  onDragEnd: (newX: number, newY: number) => void;
  onTransformEnd: (node: Konva.Node) => void;
}

/** Pixel hoá một canvas: scale xuống rồi scale lên để tạo mosaic. */
function pixelateCanvas(src: HTMLCanvasElement, tileSize: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width  = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const ts = Math.max(2, tileSize);
  const tw = Math.max(1, Math.round(src.width  / ts));
  const th = Math.max(1, Math.round(src.height / ts));
  // Bước 1: scale xuống nhỏ
  ctx.drawImage(src, 0, 0, tw, th);
  // Bước 2: scale lên to với nearest-neighbor → mosaic
  ctx.drawImage(out, 0, 0, tw, th, 0, 0, src.width, src.height);
  return out;
}

/**
 * Gaussian blur thuần JS — không dùng CSS filter (không đáng tin trong WKWebView).
 * Thuật toán: box blur 3-pass theo cả chiều ngang và dọc ≈ Gaussian.
 * Mỗi "pass" = blur ngang rồi blur dọc → tổng 6 lần scan.
 * radius: 1–20px.
 */
function gaussianBlurCanvas(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const r = Math.max(1, Math.round(radius));
  const w = src.width;
  const h = src.height;
  if (w === 0 || h === 0) return src;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(src, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  let buf = new Float32Array(imageData.data);   // kênh RGBA flattened
  const tmp = new Float32Array(buf.length);

  // Blur 1 hàng theo chiều ngang
  const blurH = (s: Float32Array, d: Float32Array) => {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        // Tổng ban đầu
        let sum = s[(y * w) * 4 + c] * (r + 1);
        for (let x = 0; x < r; x++) sum += s[(y * w + x) * 4 + c];
        // Slide window
        for (let x = 0; x < w; x++) {
          const lead  = Math.min(x + r,     w - 1);
          const trail = Math.max(x - r - 1, 0);
          sum += s[(y * w + lead)  * 4 + c] - s[(y * w + trail) * 4 + c];
          d[(y * w + x) * 4 + c] = sum * inv;
        }
      }
    }
  };

  // Blur 1 cột theo chiều dọc
  const blurV = (s: Float32Array, d: Float32Array) => {
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = s[x * 4 + c] * (r + 1);
        for (let y = 0; y < r; y++) sum += s[(y * w + x) * 4 + c];
        for (let y = 0; y < h; y++) {
          const lead  = Math.min(y + r,     h - 1);
          const trail = Math.max(y - r - 1, 0);
          sum += s[(lead  * w + x) * 4 + c] - s[(trail * w + x) * 4 + c];
          d[(y * w + x) * 4 + c] = sum * inv;
        }
      }
    }
  };

  // 3 pass box blur (H + V mỗi pass) ≈ Gaussian
  for (let pass = 0; pass < 3; pass++) {
    blurH(buf, tmp);
    blurV(tmp, buf);
  }

  // Ghi lại vào ImageData
  const u8 = imageData.data;
  for (let i = 0; i < buf.length; i++) u8[i] = buf[i] + 0.5;
  ctx.putImageData(imageData, 0, 0);
  return out;
}

function BlurRect({ ann, img, draggable, onSelect, onDragEnd, onTransformEnd }: BlurRectProps) {
  const [processed, setProcessed] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (ann.blurMode === "solid") {
      // Solid: không cần xử lý ảnh, render bằng Rect thường
      setProcessed(null);
      return;
    }
    if (!img || !img.complete || ann.width < 2 || ann.height < 2) return;

    const { x, y, width, height, blurRadius, blurMode } = ann;
    const outW = Math.max(1, Math.round(width));
    const outH = Math.max(1, Math.round(height));
    const iw   = img.naturalWidth  || img.width;
    const ih   = img.naturalHeight || img.height;

    // Cắt patch chính xác từ ảnh gốc
    const src = document.createElement("canvas");
    src.width  = outW;
    src.height = outH;
    const sc = src.getContext("2d")!;
    sc.drawImage(img,
      Math.max(0, x), Math.max(0, y),
      Math.min(width,  iw - Math.max(0, x)),
      Math.min(height, ih - Math.max(0, y)),
      Math.max(0, -x), Math.max(0, -y),
      Math.min(outW, iw - Math.max(0, x)),
      Math.min(outH, ih - Math.max(0, y)),
    );

    if (blurMode === "pixelate") {
      setProcessed(pixelateCanvas(src, Math.max(2, blurRadius)));
      return;
    }

    // blur mode — Gaussian blur thuần JS (CSS filter không đáng tin trong WKWebView)
    setProcessed(gaussianBlurCanvas(src, blurRadius));

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, ann.x, ann.y, ann.width, ann.height, ann.blurRadius, ann.blurMode, ann.solidColor]);

  const sharedProps = {
    id: ann.id,
    x: ann.x, y: ann.y, width: ann.width, height: ann.height,
    draggable,
    onClick: onSelect, onTap: onSelect,
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
      // e.target.x()/y() = tọa độ image-space mới (layer có scaleX=scale
      // nhưng node position luôn ở image-space — giống onDragEnd chung).
      onDragEnd(e.target.x(), e.target.y());
    },
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => onTransformEnd(e.target),
  };

  // Solid mode — hình chữ nhật màu đặc, không liên quan đến dữ liệu ảnh
  if (ann.blurMode === "solid") {
    return <Rect {...sharedProps} fill={ann.solidColor || "#1a1a1a"} />;
  }

  // Chưa render xong → placeholder tối
  if (!processed) {
    return <Rect {...sharedProps} fill="rgba(15,20,30,0.5)" />;
  }

  return <KImage {...sharedProps} image={processed} />;
}

AnnotationStage.displayName = "AnnotationStage";
export default AnnotationStage;
