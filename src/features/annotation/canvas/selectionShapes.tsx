/** Khung chọn / tay nắm / helper hình học dùng cho các annotation trong `AnnotationStage`. */
import { useRef } from "react";
import { Rect, Circle } from "react-konva";
import type Konva from "konva";
import { useTranslation } from "react-i18next";
import { TEXT_BG_PRESETS, type Annotation, type ArrowAnn, type DoubleArrowAnn, type LineAnn, type NumberedArrowAnn, type TextAnn } from "../model";
import { useEditor } from "../store";

/** Khung viền chọn từng đối tượng khi chọn nhiều */
export function SelectionFrame({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
  const pad = 3;
  const rx = x - pad;
  const ry = y - pad;
  const rw = width + pad * 2;
  const rh = height + pad * 2;
  const handles = [
    { x: rx, y: ry },
    { x: rx + rw, y: ry },
    { x: rx, y: ry + rh },
    { x: rx + rw, y: ry + rh },
  ];
  return (
    <>
      <Rect
        x={rx}
        y={ry}
        width={rw}
        height={rh}
        stroke="#3b82f6"
        strokeWidth={1.5}
        dash={[4, 3]}
        listening={false}
      />
      {handles.map((h, i) => (
        <Rect
          key={i}
          x={h.x - 3.5}
          y={h.y - 3.5}
          width={7}
          height={7}
          fill="#ffffff"
          stroke="#3b82f6"
          strokeWidth={1.5}
          listening={false}
        />
      ))}
    </>
  );
}

export function LineEndpoints({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return (
    <>
      <Circle x={x1} y={y1} radius={4} fill="#ffffff" stroke="#3b82f6" strokeWidth={1.5} listening={false} />
      <Circle x={x2} y={y2} radius={4} fill="#ffffff" stroke="#3b82f6" strokeWidth={1.5} listening={false} />
    </>
  );
}

export const linePts = (a: { x: number; y: number; x2: number; y2: number; cx?: number; cy?: number }): number[] =>
  a.cx !== undefined && a.cy !== undefined ? [a.x, a.y, a.cx, a.cy, a.x2, a.y2] : [a.x, a.y, a.x2, a.y2];

/** Thanh nhỏ nổi cạnh ô chữ: bật/tắt "mũi chỉ đích" (callout) + chọn hướng — áp dụng ngay
 * cho chữ đang gõ hoặc đang chọn, không cần mở toolbar. */
export function CalloutBar({ ann }: { ann: TextAnn }) {
  const { t } = useTranslation();
  const on = !!ann.hasTargetArrow;
  const toggle = () => {
    const st = useEditor.getState();
    if (on) {
      st.updateAnnotation(ann.id, { hasTargetArrow: false } as Partial<Annotation>);
      return;
    }
    const fs = ann.fontSize || 22;
    const lightText = ann.color === "#ef4444" || ann.color === "#111827";
    st.updateAnnotation(ann.id, {
      hasTargetArrow: true,
      bgColor: ann.bgColor || "#3b82f6",
      ...(lightText ? { color: "#ffffff" } : null),
      targetX: ann.targetX ?? ann.x - 50,
      targetY: ann.targetY ?? ann.y + (fs * 1.35) / 2 + 8,
    } as Partial<Annotation>);
  };
  const btn = (active: boolean): React.CSSProperties => ({
    height: 22,
    minWidth: 22,
    padding: "0 5px",
    border: "none",
    borderRadius: 5,
    background: active ? "rgba(59,130,246,0.4)" : "transparent",
    color: active ? "#93c5fd" : "rgba(242,242,245,0.85)",
    cursor: "pointer",
    fontSize: 13,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  });
  return (
    <div
      // Giữ focus ở ô nhập: mousedown mặc định sẽ làm textarea blur → kết thúc nhập
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: "3px 4px",
        borderRadius: 8,
        background: "rgba(18,18,22,0.92)",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
        whiteSpace: "nowrap",
      }}
    >
      <button type="button" onClick={toggle} style={btn(on)} title={t("editorToolbar.textTargetArrow")}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="2" y="2" width="7" height="6" rx="1.5" />
          <path d="M9 5h3.5v4" />
          <path d="M10.5 11l2 2 2-2" />
        </svg>
        <span style={{ fontSize: 11 }}>{t("annotationCanvas.calloutLabel", "Mũi chỉ")}</span>
      </button>
      <span style={{ width: 1, height: 16, margin: "0 4px", background: "rgba(255,255,255,0.15)" }} />
      {TEXT_BG_PRESETS.map((p) => {
        const active = p.color === "" ? !ann.bgColor : ann.bgColor === p.color;
        return (
          <button
            type="button"
            key={p.id}
            onClick={() => useEditor.getState().setTextBgColor(p.color)}
            title={t(`editorToolbar.${p.id === "none" ? "textBgNone" : p.id === "white" ? "textBgWhite" : p.id === "dark" ? "textBgDark" : p.id === "yellow" ? "textBgYellow" : p.id === "blue" ? "textBgBlue" : "textBgRed"}`)}
            style={{
              width: 18,
              height: 18,
              padding: 0,
              borderRadius: 4,
              background: p.color || "transparent",
              border: active ? "2px solid #3b82f6" : "1px solid rgba(255,255,255,0.3)",
              boxShadow: active ? "0 0 0 1px #fff" : "none",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {p.id === "none" && (
              <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
                <line x1="3" y1="11" x2="11" y2="3" stroke="#ef4444" strokeWidth="1.6" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Tay nắm 2 đầu của line/arrow đang được chọn: kéo từng đầu để đổi độ dài / hướng
 * (giống Figma/Excalidraw/Skitch). Giữ Shift để khoá góc theo bước 15°. Kích thước
 * tay nắm cố định theo màn hình (chia cho `scale`). */
export function LineHandles({ ann, scale, showMid, onCursor }: { ann: ArrowAnn | DoubleArrowAnn | LineAnn | NumberedArrowAnn; scale: number; showMid: boolean; onCursor: (c: string | null) => void }) {
  const orig = useRef<{ x: number; y: number; x2: number; y2: number; cx?: number; cy?: number } | null>(null);
  const r = 6 / scale;
  const move = (end: 1 | 2, e: Konva.KonvaEventObject<DragEvent>) => {
    let px = e.target.x();
    let py = e.target.y();
    if (e.evt.shiftKey) {
      const ox = end === 1 ? ann.x2 : ann.x;
      const oy = end === 1 ? ann.y2 : ann.y;
      const dx = px - ox;
      const dy = py - oy;
      const len = Math.hypot(dx, dy);
      const step = Math.PI / 12;
      const ang = Math.round(Math.atan2(dy, dx) / step) * step;
      px = ox + Math.cos(ang) * len;
      py = oy + Math.sin(ang) * len;
      e.target.x(px);
      e.target.y(py);
    }
    useEditor.getState().updateAnnotationLive(
      ann.id,
      (end === 1 ? { x: px, y: py } : { x2: px, y2: py }) as Partial<Annotation>,
    );
  };
  const start = () => {
    orig.current = { x: ann.x, y: ann.y, x2: ann.x2, y2: ann.y2, cx: ann.cx, cy: ann.cy };
  };
  const end = (which: 1 | 2, e: Konva.KonvaEventObject<DragEvent>) => {
    const o = orig.current;
    orig.current = null;
    const px = e.target.x();
    const py = e.target.y();
    if (o) useEditor.getState().updateAnnotationLive(ann.id, o as Partial<Annotation>);
    useEditor.getState().updateAnnotation(
      ann.id,
      (which === 1 ? { x: px, y: py } : { x2: px, y2: py }) as Partial<Annotation>,
    );
  };
  const handle = (which: 1 | 2, x: number, y: number) => (
    <Circle
      key={which}
      x={x}
      y={y}
      radius={r}
      fill="#ffffff"
      stroke="#3b82f6"
      strokeWidth={1.5 / scale}
      hitStrokeWidth={8 / scale}
      draggable
      name="handle"
      onMouseEnter={() => onCursor("move")}
      onMouseLeave={() => onCursor(null)}
      onMouseDown={(e) => { e.cancelBubble = true; }}
      onDragStart={start}
      onDragMove={(e) => move(which, e)}
      onDragEnd={(e) => end(which, e)}
    />
  );
  const curved = ann.cx !== undefined && ann.cy !== undefined;
  const mx = curved ? ann.cx! : (ann.x + ann.x2) / 2;
  const my = curved ? ann.cy! : (ann.y + ann.y2) / 2;
  return (
    <>
      {handle(1, ann.x, ann.y)}
      {handle(2, ann.x2, ann.y2)}
      {showMid && (
        <Circle
          x={mx}
          y={my}
          radius={r * 0.85}
          fill="#3b82f6"
          stroke="#ffffff"
          strokeWidth={1.5 / scale}
          hitStrokeWidth={8 / scale}
          draggable
          name="handle"
          onMouseEnter={() => onCursor("grab")}
          onMouseLeave={() => onCursor(null)}
          onMouseDown={(e) => { e.cancelBubble = true; }}
          onDragStart={start}
          onDragMove={(e) =>
            useEditor.getState().updateAnnotationLive(ann.id, { cx: e.target.x(), cy: e.target.y() } as Partial<Annotation>)
          }
          onDragEnd={(e) => {
            const o = orig.current;
            orig.current = null;
            if (o) useEditor.getState().updateAnnotationLive(ann.id, o as Partial<Annotation>);
            useEditor.getState().updateAnnotation(ann.id, { cx: e.target.x(), cy: e.target.y() } as Partial<Annotation>);
          }}
          onDblClick={() =>
            useEditor.getState().updateAnnotation(ann.id, { cx: undefined, cy: undefined } as Partial<Annotation>)
          }
        />
      )}
    </>
  );
}

/** Tìm giao điểm của tia từ tâm theo góc theta với chu vi hình chữ nhật bo góc */
export function getPointOnRoundedRect(w: number, h: number, r: number, theta: number): { x: number; y: number } {
  const hw = w / 2;
  const hh = h / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const tx = Math.abs(cos) > 1e-6 ? hw / Math.abs(cos) : Infinity;
  const ty = Math.abs(sin) > 1e-6 ? hh / Math.abs(sin) : Infinity;
  const t = Math.min(tx, ty);
  const x = t * cos;
  const y = t * sin;
  if (Math.abs(x) <= hw - r + 1e-4) return { x: hw + x, y: hh + y };
  if (Math.abs(y) <= hh - r + 1e-4) return { x: hw + x, y: hh + y };
  const cx = Math.sign(cos) * (hw - r);
  const cy = Math.sign(sin) * (hh - r);
  const b = cos * cx + sin * cy;
  const c = cx * cx + cy * cy - r * r;
  const disc = b * b - c;
  const tCircle = b + Math.sqrt(Math.max(0, disc));
  return { x: hw + tCircle * cos, y: hh + tCircle * sin };
}

/** Tạo chuỗi SVG path cho khung callout / speech bubble bo góc có mỏ nhọn xoay 360 độ linh hoạt */
export function getCalloutPath(w: number, h: number, r: number, tx: number, ty: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const pMid = getPointOnRoundedRect(w, h, r, angle);
  const midDist = Math.hypot(pMid.x - cx, pMid.y - cy);

  const safeR = Math.max(4, Math.min(r, w / 2 - 2, h / 2 - 2));

  // Nếu điểm target nằm bên trong hộp hoặc quá sát mép -> vẽ hình chữ nhật bo góc bình thường
  if (dist <= midDist + 4) {
    return [
      `M ${safeR} 0`,
      `L ${w - safeR} 0`,
      `A ${safeR} ${safeR} 0 0 1 ${w} ${safeR}`,
      `L ${w} ${h - safeR}`,
      `A ${safeR} ${safeR} 0 0 1 ${w - safeR} ${h}`,
      `L ${safeR} ${h}`,
      `A ${safeR} ${safeR} 0 0 1 0 ${h - safeR}`,
      `L 0 ${safeR}`,
      `A ${safeR} ${safeR} 0 0 1 ${safeR} 0`,
      `Z`,
    ].join(" ");
  }

  const baseWidth = Math.min(26, Math.max(16, Math.min(w, h) * 0.35));
  const halfAngle = Math.asin(Math.min(0.7, (baseWidth / 2) / Math.max(10, midDist)));

  const angle1 = angle - halfAngle;
  const angle2 = angle + halfAngle;

  const TWO_PI = Math.PI * 2;
  let sweep = angle1 - angle2;
  while (sweep < 0) sweep += TWO_PI;

  const numSteps = Math.max(48, Math.round((sweep / TWO_PI) * 72));
  let d = "";
  for (let i = 0; i <= numSteps; i++) {
    const a = angle2 + (sweep * i) / numSteps;
    const pt = getPointOnRoundedRect(w, h, safeR, a);
    d += (i === 0 ? "M " : " L ") + pt.x.toFixed(1) + " " + pt.y.toFixed(1);
  }
  d += " L " + tx.toFixed(1) + " " + ty.toFixed(1) + " Z";
  return d;
}

export function StepSelectionFrame({ x, y, radius }: { x: number; y: number; radius: number }) {
  const r = radius + 3;
  const handles = [
    { x: x - r, y },
    { x: x + r, y },
    { x, y: y - r },
    { x, y: y + r },
  ];
  return (
    <>
      <Circle x={x} y={y} radius={r} stroke="#3b82f6" strokeWidth={1.5} dash={[4, 3]} listening={false} />
      {handles.map((h, i) => (
        <Rect
          key={i}
          x={h.x - 3}
          y={h.y - 3}
          width={6}
          height={6}
          fill="#ffffff"
          stroke="#3b82f6"
          strokeWidth={1.5}
          listening={false}
        />
      ))}
    </>
  );
}

export function drawRoundedRect(
  ctx: any,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (radius <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, radius);
  } else {
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
  }
}
