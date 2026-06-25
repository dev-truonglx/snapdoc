import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Stage, Layer, Rect, Ellipse, Text, Circle, Group, Image as KImage, Transformer } from "react-konva";
import type Konva from "konva";
import { useEditor } from "../store";
import type { Annotation } from "../model";
import { uid } from "../model";

export interface StageHandle {
  exportPng: () => string | null;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

interface Draft {
  type: "rect" | "ellipse" | "crop";
  x: number;
  y: number;
  width: number;
  height: number;
}

const AnnotationStage = forwardRef<StageHandle>((_props, ref) => {
  const doc = useEditor((s) => s.doc);
  const tool = useEditor((s) => s.tool);
  const color = useEditor((s) => s.color);
  const strokeWidth = useEditor((s) => s.strokeWidth);
  const fontSize = useEditor((s) => s.fontSize);
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
      const cw = c.clientWidth - 32;
      const ch = c.clientHeight - 32;
      const s = Math.max(0.05, Math.min(cw / doc.imgW, ch / doc.imgH, 2));
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
    if (tool === "rect" || tool === "ellipse" || tool === "crop") {
      setDraft({ type: tool, x, y, width: 0, height: 0 });
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
    if (!draft) return;
    const stage = stageRef.current;
    const pos = stage?.getPointerPosition();
    if (!pos) return;
    const { x, y } = toImg(pos);
    setDraft({ ...draft, width: x - draft.x, height: y - draft.y });
  };

  const onStageMouseUp = () => {
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
    useEditor.getState().addAnnotation({
      id: uid(),
      type: draft.type,
      x,
      y,
      width,
      height,
      color,
      strokeWidth,
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
    if (a.type === "rect" || a.type === "ellipse") {
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

  // Step luôn tròn → chỉ cho kéo 4 góc + giữ tỉ lệ (vuông). Các loại khác kéo tự do.
  const selectedAnn = selectedId ? doc.annotations.find((a) => a.id === selectedId) : null;
  const isStepSelected = selectedAnn?.type === "step";

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
            })}

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
            ) : draft ? (
              <Rect
                x={draft.x}
                y={draft.y}
                width={draft.width}
                height={draft.height}
                stroke={draft.type === "crop" ? "#3b82f6" : color}
                strokeWidth={draft.type === "crop" ? 2 : strokeWidth}
                dash={[6, 4]}
              />
            ) : null}

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
              keepRatio={isStepSelected}
              enabledAnchors={
                isStepSelected
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
      <button
        onClick={doZoomOut}
        disabled={atZoomMin}
        style={{ ...zoomBtn, ...(atZoomMin ? zoomBtnDisabled : null) }}
        title="Thu nhỏ (Ctrl/Cmd -)"
      >−</button>
      <button
        onClick={toggleFitActual}
        style={{ ...zoomBtn, minWidth: 52, fontSize: 12 }}
        title="Bấm để chuyển Fit ↔ 100% (1:1 pixel)"
      >
        {zoomPct}%
      </button>
      <button
        onClick={doZoomIn}
        disabled={atZoomMax}
        style={{ ...zoomBtn, ...(atZoomMax ? zoomBtnDisabled : null) }}
        title="Phóng to (Ctrl/Cmd +)"
      >+</button>
      <button
        onClick={doZoomFit}
        style={{ ...zoomBtn, minWidth: 38, fontSize: 11 }}
        title="Vừa khung (Ctrl/Cmd 0)"
      >Fit</button>
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
  right: 10,
  bottom: 10,
  display: "flex",
  alignItems: "center",
  gap: 2,
  background: "rgba(20,20,24,0.88)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "2px 4px",
  backdropFilter: "blur(8px)",
  zIndex: 10,
};

const zoomBtn: React.CSSProperties = {
  width: 28,
  height: 26,
  borderRadius: 5,
  background: "transparent",
  color: "#f2f2f5",
  fontSize: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const zoomBtnDisabled: React.CSSProperties = {
  opacity: 0.35,
  cursor: "default",
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

AnnotationStage.displayName = "AnnotationStage";
export default AnnotationStage;
