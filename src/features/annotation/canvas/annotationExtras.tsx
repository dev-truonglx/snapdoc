/** Hiển thị các annotation: nét vẽ tự do, spotlight, kính lúp, sticker emoji. */
import { Circle, Line, Rect, Shape, Text } from "react-konva";
import type Konva from "konva";
import type { EmojiAnn, MagnifierAnn, PenAnn, SpotlightAnn } from "../model";

interface Interactive {
  draggable: boolean;
  isSelected: boolean;
  onSelect: (multi: boolean) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd: (node: Konva.Node) => void;
}

const isMulti = (e: Konva.KonvaEventObject<MouseEvent>) => e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey;

export function PenItem({ ann, draggable, isSelected, onSelect, onDragEnd, onTransformEnd }: Interactive & { ann: PenAnn }) {
  return (
    <Line
      id={ann.id}
      x={ann.x}
      y={ann.y}
      points={ann.points}
      stroke={ann.color}
      strokeWidth={ann.strokeWidth}
      tension={0.4}
      lineCap="round"
      lineJoin="round"
      hitStrokeWidth={Math.max(12, ann.strokeWidth + 8)}
      shadowColor={isSelected ? "#3b82f6" : undefined}
      shadowBlur={isSelected ? 6 : 0}
      shadowOpacity={isSelected ? 0.9 : 0}
      draggable={draggable}
      onClick={(e) => onSelect(isMulti(e))}
      onTap={() => onSelect(false)}
      onDragEnd={onDragEnd}
      onTransformEnd={(e) => onTransformEnd(e.target)}
    />
  );
}

/**
 * Lớp tối của TẤT CẢ spotlight (1 node cho cả tài liệu, đặt ở vị trí spotlight
 * đầu tiên theo thứ tự lớp). Mỗi vùng sáng được trừ bằng 1 lần `clip` evenodd
 * (rect toàn ảnh + vùng): các clip giao nhau ⇒ phần còn tô = ảnh TRỪ HỢP các
 * vùng, nên spotlight chồng nhau vẫn sáng đúng (tô evenodd 1 lượt thì chỗ chồng
 * lại bị tối). Hình học đọc từ node chọn/kéo (`SpotlightHit`) lúc vẽ → kéo/resize
 * thấy vùng sáng chạy theo ngay, không cần cập nhật store từng frame.
 */
export function SpotlightOverlay({ spots, imgW, imgH }: { spots: SpotlightAnn[]; imgW: number; imgH: number }) {
  const dim = Math.max(...spots.map((s) => s.dim));
  return (
    <Shape
      listening={false}
      sceneFunc={(ctx, shape) => {
        const c = (ctx as unknown as { _context: CanvasRenderingContext2D })._context;
        const layer = shape.getLayer();
        c.save();
        for (const s of spots) {
          const node = layer?.findOne<Konva.Rect>("#" + s.id);
          const x = node ? node.x() : s.x;
          const y = node ? node.y() : s.y;
          const w = node ? node.width() * node.scaleX() : s.width;
          const h = node ? node.height() * node.scaleY() : s.height;
          c.beginPath();
          c.rect(0, 0, imgW, imgH);
          if (s.shape === "ellipse") {
            c.moveTo(x + w, y + h / 2);
            c.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
          } else {
            const r = Math.min(10, Math.abs(w) / 2, Math.abs(h) / 2);
            c.moveTo(x + r, y);
            c.arcTo(x + w, y, x + w, y + h, r);
            c.arcTo(x + w, y + h, x, y + h, r);
            c.arcTo(x, y + h, x, y, r);
            c.arcTo(x, y, x + w, y, r);
            c.closePath();
          }
          c.clip("evenodd");
        }
        c.fillStyle = `rgba(0,0,0,${dim})`;
        c.fillRect(0, 0, imgW, imgH);
        c.restore();
      }}
    />
  );
}

/** Vùng chọn/kéo/resize của 1 spotlight — trong suốt (lớp tối do `SpotlightOverlay` vẽ). */
export function SpotlightHit({ ann, draggable, isSelected, onSelect, onDragEnd, onTransformEnd }: Interactive & { ann: SpotlightAnn }) {
  return (
    <Rect
      id={ann.id}
      x={ann.x}
      y={ann.y}
      width={ann.width}
      height={ann.height}
      fill="transparent"
      stroke={isSelected ? "#3b82f6" : undefined}
      strokeWidth={isSelected ? 1.5 : 0}
      dash={[6, 4]}
      cornerRadius={ann.shape === "ellipse" ? Math.min(ann.width, ann.height) / 2 : 10}
      draggable={draggable}
      onClick={(e) => onSelect(isMulti(e))}
      onTap={() => onSelect(false)}
      onDragEnd={onDragEnd}
      onTransformEnd={(e) => onTransformEnd(e.target)}
    />
  );
}

/** Kính lúp: phóng to ảnh nền tại đúng chỗ đặt — 1 hình tròn duy nhất tô bằng
 * ảnh nền (fill pattern, phóng `zoom` lần quanh tâm) + viền. KHÔNG dùng Group
 * cắt tròn chứa ảnh phóng to: khung bao (và khung resize của Transformer) của
 * Group tính cả ảnh bên trong dù bị cắt → tay nắm resize nằm ngoài màn hình. */
export function MagnifierItem({
  ann,
  img,
  draggable,
  isSelected,
  onSelect,
  onDragEnd,
  onTransformEnd,
}: Interactive & { ann: MagnifierAnn; img: HTMLImageElement | null }) {
  return (
    <Circle
      id={ann.id}
      x={ann.x}
      y={ann.y}
      radius={ann.radius}
      fill={img ? undefined : "#fff"}
      fillPatternImage={img ?? undefined}
      fillPatternRepeat="no-repeat"
      fillPatternScaleX={ann.zoom}
      fillPatternScaleY={ann.zoom}
      // Điểm ảnh (x, y) nằm đúng tâm vòng tròn.
      fillPatternOffsetX={ann.x}
      fillPatternOffsetY={ann.y}
      stroke={ann.color}
      strokeWidth={Math.max(2, ann.strokeWidth + 1)}
      shadowColor={isSelected ? "#3b82f6" : "#000"}
      shadowBlur={isSelected ? 10 : 8}
      shadowOpacity={isSelected ? 0.9 : 0.35}
      shadowForStrokeEnabled
      draggable={draggable}
      onClick={(e) => onSelect(isMulti(e))}
      onTap={() => onSelect(false)}
      // Đang kéo: soi theo vị trí mới ngay (ghi thẳng node, không qua store mỗi frame).
      onDragMove={(e) => {
        const c = e.target as Konva.Circle;
        c.fillPatternOffset({ x: c.x(), y: c.y() });
      }}
      onDragEnd={onDragEnd}
      onTransformEnd={(e) => onTransformEnd(e.target)}
    />
  );
}

export function EmojiItem({ ann, draggable, isSelected, onSelect, onDragEnd, onTransformEnd }: Interactive & { ann: EmojiAnn }) {
  return (
    <Text
      id={ann.id}
      x={ann.x}
      y={ann.y}
      text={ann.emoji}
      fontSize={ann.size}
      lineHeight={1.15}
      shadowColor={isSelected ? "#3b82f6" : undefined}
      shadowBlur={isSelected ? 8 : 0}
      shadowOpacity={isSelected ? 0.9 : 0}
      draggable={draggable}
      onClick={(e) => onSelect(isMulti(e))}
      onTap={() => onSelect(false)}
      onDragEnd={onDragEnd}
      onTransformEnd={(e) => onTransformEnd(e.target)}
    />
  );
}
