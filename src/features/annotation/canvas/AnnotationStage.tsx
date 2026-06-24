import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Stage, Layer, Rect, Ellipse, Text, Circle, Group, Image as KImage, Transformer } from "react-konva";
import type Konva from "konva";
import { useEditor } from "../store";
import type { Annotation } from "../model";
import { uid } from "../model";

export interface StageHandle {
  exportPng: () => string | null;
}

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
  const selectedId = useEditor((s) => s.selectedId);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cropRect, setCropRect] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  // Tải ảnh nền
  useEffect(() => {
    if (!doc) return;
    const el = new window.Image();
    el.src = doc.image;
    el.onload = () => setImg(el);
  }, [doc?.image]);

  // Tính scale fit theo container
  useLayoutEffect(() => {
    if (!doc) return;
    const measure = () => {
      const c = containerRef.current;
      if (!c) return;
      const cw = c.clientWidth - 32;
      const ch = c.clientHeight - 32;
      const s = Math.min(cw / doc.imgW, ch / doc.imgH, 2);
      const clamped = Math.max(0.05, Math.min(s, 3));
      setScale(clamped);
      setBox({ w: doc.imgW * clamped, h: doc.imgH * clamped });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [doc?.imgW, doc?.imgH]);

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

  useImperativeHandle(ref, () => ({
    exportPng: () => {
      const stage = stageRef.current;
      if (!stage || !doc) return null;
      trRef.current?.nodes([]);
      const url = stage.toDataURL({ pixelRatio: 1 / scale, mimeType: "image/png" });
      return url;
    },
  }));

  if (!doc) return <div ref={containerRef} style={fill} />;

  const toImg = (p: { x: number; y: number }) => ({ x: p.x / scale, y: p.y / scale });

  const onStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
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
        radius: 16,
        color,
        strokeWidth,
      });
      return;
    }
    if (tool === "text") {
      const id = uid();
      useEditor.getState().addAnnotation({
        id,
        type: "text",
        x,
        y,
        text: "",
        fontSize: 22,
        color,
        strokeWidth,
      });
      setEditing({ id, value: "" });
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

  const commitText = () => {
    if (!editing) return;
    const value = editing.value.trim();
    if (!value) {
      useEditor.getState().select(editing.id);
      useEditor.getState().removeSelected();
    } else {
      useEditor.getState().updateAnnotation(editing.id, { text: value } as Partial<Annotation>);
    }
    setEditing(null);
  };

  const draggable = tool === "select";

  return (
    <div ref={containerRef} style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative" }}>
        <Stage
          ref={stageRef}
          width={box.w}
          height={box.h}
          onMouseDown={onStageMouseDown}
          onMouseMove={onStageMouseMove}
          onMouseUp={onStageMouseUp}
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
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
                    onDblClick={() => setEditing({ id: a.id, value: a.text })}
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
              boundBoxFunc={(_old, next) => next}
            />
          </Layer>
        </Stage>

        {editing && (
          <textarea
            autoFocus
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
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
              fontSize: 22 * scale,
              fontWeight: "bold",
              color,
              background: "rgba(0,0,0,0.35)",
              border: "1px dashed #3b82f6",
              outline: "none",
              resize: "none",
              minWidth: 120,
              padding: 2,
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
    </div>
  );

  function textPos(id: string) {
    const a = doc?.annotations.find((x) => x.id === id);
    if (!a) return { x: 0, y: 0 };
    return { x: a.x * scale, y: a.y * scale };
  }
});

const fill: React.CSSProperties = { width: "100%", height: "100%" };

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
