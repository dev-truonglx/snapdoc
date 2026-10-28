/** Hình xem trước khi đang kéo vẽ (tách khỏi `AnnotationStage` để chỉ khối nhỏ này re-render theo chuột). */
import { forwardRef, useImperativeHandle, useState } from "react";
import { Rect, Line, Ellipse, Text, Circle, Group, Arrow } from "react-konva";
import { useEditor } from "../store";

export interface Draft {
  type: "rect" | "ellipse" | "crop" | "highlight" | "blur" | "numbered-rect" | "spotlight";
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Draft cho mũi tên / đường thẳng đang kéo. */
export interface ArrowDraft {
  type: "arrow" | "double-arrow" | "line" | "numbered-arrow";
  x: number;
  y: number;
  x2: number;
  y2: number;
}

/** Khung chữ nhật đang kéo (toạ độ ảnh). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DraftPreviewHandle {
  setDraft: (d: Draft | null) => void;
  setArrowDraft: (d: ArrowDraft | null) => void;
  /** Nét bút tự do đang vẽ (toạ độ ảnh tuyệt đối). */
  setPenDraft: (points: number[] | null) => void;
}

/**
 * Hình xem trước đang kéo (rect/ellipse/highlight/blur/crop/mũi tên/đường
 * thẳng). State nằm ở component con này: mỗi mousemove lúc vẽ chỉ re-render
 * khối nhỏ này, không re-render cả `AnnotationStage` (hàng trăm node annotation
 * với props mảng/object inline — mỗi lần render lại bị Konva setAttrs lại).
 * Vẫn nằm ĐÚNG vị trí cũ trong Layer chính (thứ tự vẽ không đổi, không tốn
 * thêm canvas như khi tách Layer riêng).
 */
export const DraftPreview = forwardRef<
  DraftPreviewHandle,
  { imgW: number; imgH: number; color: string; strokeWidth: number; highlightColor: string; blurMode: string }
>(({ imgW, imgH, color, strokeWidth, highlightColor, blurMode }, ref) => {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [arrowDraft, setArrowDraft] = useState<ArrowDraft | null>(null);
  const [penDraft, setPenDraft] = useState<number[] | null>(null);
  useImperativeHandle(ref, () => ({ setDraft, setArrowDraft, setPenDraft }), []);
  return (
    <>
      {penDraft && (
        <Line points={penDraft} stroke={color} strokeWidth={strokeWidth} tension={0.4} lineCap="round" lineJoin="round" />
      )}
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
      ) : draft && draft.type === "crop" ? (
        <>
          {/* Overlay xám cho vùng ngoài crop khi đang kéo — dải trên/dưới
              phải trải HẾT chiều ngang ảnh (x=0, width=imgW), không
              chỉ theo chiều rộng vùng chọn, nếu không 4 góc ảnh (ngoài
              dải trên/dưới) sẽ không bị phủ mờ, để lộ vùng sáng ở góc
              đối diện vùng đang chọn. */}
          <Rect x={0} y={0} width={imgW} height={Math.min(draft.y, draft.y + draft.height)} fill="#000000" opacity={0.5} listening={false} />
          <Rect x={0} y={Math.min(draft.y, draft.y + draft.height)} width={Math.min(draft.x, draft.x + draft.width)} height={Math.abs(draft.height)} fill="#000000" opacity={0.5} listening={false} />
          <Rect x={Math.max(draft.x, draft.x + draft.width)} y={Math.min(draft.y, draft.y + draft.height)} width={imgW - Math.max(draft.x, draft.x + draft.width)} height={Math.abs(draft.height)} fill="#000000" opacity={0.5} listening={false} />
          <Rect x={0} y={Math.max(draft.y, draft.y + draft.height)} width={imgW} height={imgH - Math.max(draft.y, draft.y + draft.height)} fill="#000000" opacity={0.5} listening={false} />
          
          {/* Khung crop sáng */}
          <Rect
            x={draft.x} y={draft.y} width={draft.width} height={draft.height}
            stroke="#3b82f6"
            strokeWidth={2}
            dash={[6, 4]}
            listening={false}
          />
          {/* Overlay sáng bên trong */}
          <Rect
            x={Math.min(draft.x, draft.x + draft.width)} 
            y={Math.min(draft.y, draft.y + draft.height)} 
            width={Math.abs(draft.width)} 
            height={Math.abs(draft.height)}
            fill="#ffffff"
            opacity={0.08}
            listening={false}
          />
        </>
      ) : draft && draft.type === "numbered-rect" ? (() => {
        const nx = Math.min(draft.x, draft.x + draft.width);
        const ny = Math.min(draft.y, draft.y + draft.height);
        const w = Math.abs(draft.width);
        const h = Math.abs(draft.height);
        const isLeft = draft.width >= 0;
        const isTop = draft.height >= 0;
        const cx = isLeft ? nx : nx + w;
        const cy = isTop ? ny : ny + h;
        const radius = Math.max(Math.round(strokeWidth * 2 + 5), 10);
        const nextVal = useEditor.getState().rectCounter;
        const valStr = String(nextVal);
        const fontSize = Math.max(9, Math.round(radius * (valStr.length > 1 ? 0.78 : 0.88)));
        return (
          <Group opacity={0.8}>
            <Rect
              x={nx}
              y={ny}
              width={w}
              height={h}
              stroke={color}
              strokeWidth={strokeWidth}
              dash={[6, 4]}
            />
            <Circle
              x={cx}
              y={cy}
              radius={radius}
              fill={color}
              stroke="#ffffff"
              strokeWidth={1}
            />
            <Text
              x={cx}
              y={cy}
              text={valStr}
              fontSize={fontSize}
              fontStyle="bold"
              fill="#ffffff"
              width={radius * 2}
              height={radius * 2}
              offsetX={radius}
              offsetY={radius}
              align="center"
              verticalAlign="middle"
            />
          </Group>
        );
      })() : draft ? (
        <Rect
          x={draft.x} y={draft.y} width={draft.width} height={draft.height}
          stroke={color}
          strokeWidth={strokeWidth}
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
        if (arrowDraft.type === "double-arrow") {
          return (
            <Arrow
              points={[arrowDraft.x, arrowDraft.y, arrowDraft.x2, arrowDraft.y2]}
              stroke={color}
              strokeWidth={strokeWidth}
              fill={color}
              pointerAtBeginning={true}
              pointerAtEnding={true}
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
        const radius = Math.max(Math.round(strokeWidth * 2 + 5), 10);
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
    </>
  );
});
DraftPreview.displayName = "DraftPreview";

export interface MarqueePreviewHandle {
  setBox: (b: Box | null) => void;
}

/** Khung quét chọn (marquee) — state riêng, cùng lý do với `DraftPreview`. */
export const MarqueePreview = forwardRef<MarqueePreviewHandle, { scale: number }>(({ scale }, ref) => {
  const [box, setBox] = useState<Box | null>(null);
  useImperativeHandle(ref, () => ({ setBox }), []);
  return (
    <>
      {box && (
        <Rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          fill="rgba(59, 130, 246, 0.15)"
          stroke="#3b82f6"
          strokeWidth={1 / scale}
          dash={[4 / scale, 4 / scale]}
          listening={false}
        />
      )}
    </>
  );
});
MarqueePreview.displayName = "MarqueePreview";
