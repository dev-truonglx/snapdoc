export type VideoOverlayType = "rect" | "blur" | "text" | "arrow";

export interface VideoOverlayItem {
  id: string;
  type: VideoOverlayType;
  /** Tọa độ chuẩn hóa (0..1) theo khung hình gốc của video */
  relX: number;
  relY: number;
  relW: number;
  relH: number;
  /** Khoảng thời gian hiển thị (tính theo mili-giây trên timeline) */
  startTimeMs: number;
  endTimeMs: number;
  /** Màu viền / màu nét / màu chữ — mặc định '#ef4444' */
  strokeColor?: string;
  /** Độ dày viền (px) — mặc định 3 */
  strokeWidth?: number;
  /** Hộp đen che phủ tuyệt đối thay vì làm mờ sương (cho blur) */
  isBlackout?: boolean;

  // --- Thuộc tính bổ sung cho Chữ (Text) ---
  text?: string;
  fontSize?: number; // mặc định 18
  textColor?: string; // mặc định '#ffffff'
  hasBackground?: boolean; // mặc định true (nền badge đen mờ)

  // --- Thuộc tính bổ sung cho Mũi tên (Arrow) ---
  // Toạ độ điểm bắt đầu và kết thúc (chuẩn hoá 0..1 bên trong bounding box của overlay)
  arrowStartX?: number;
  arrowStartY?: number;
  arrowEndX?: number;
  arrowEndY?: number;

  // --- Dữ liệu ảnh PNG phục vụ xuất video (FFmpeg) ---
  imageData?: string;
}

export const OVERLAY_COLORS = [
  "#ef4444", // Đỏ
  "#f97316", // Cam
  "#eab308", // Vàng
  "#22c55e", // Xanh lá
  "#3b82f6", // Xanh dương
  "#a855f7", // Tím
  "#ffffff", // Trắng
];

export const OVERLAY_STROKE_WIDTHS = [2, 3, 5];
export const OVERLAY_FONT_SIZES = [14, 18, 24, 32];

export const DEFAULT_OVERLAY_DURATION_MS = 3000;
export const MIN_OVERLAY_DURATION_MS = 200;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function makeOverlayUid(): string {
  return "ovl_" + Math.random().toString(36).slice(2, 9);
}

/**
 * Render một overlay dạng Text hoặc Arrow thành transparent PNG Data URL để đưa vào FFmpeg.
 */
export function renderOverlayToDataUrl(
  item: VideoOverlayItem,
  videoWidth: number,
  videoHeight: number,
): string | null {
  if (item.type !== "text" && item.type !== "arrow") return null;

  const vw = videoWidth > 0 ? videoWidth : 1280;
  const vh = videoHeight > 0 ? videoHeight : 720;
  const w = Math.max(16, Math.round(vw * item.relW));
  const h = Math.max(16, Math.round(vh * item.relH));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, w, h);

  if (item.type === "text") {
    const text = item.text?.trim() || "";
    if (!text) return null;

    // Scale font size theo độ phân giải video
    const scale = Math.max(0.75, Math.min(2.5, videoWidth / 1280));
    const baseSize = item.fontSize || 18;
    const fontSizePx = Math.round(baseSize * scale);

    ctx.font = `600 ${fontSizePx}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = "middle";

    const paddingX = Math.round(14 * scale);

    if (item.hasBackground !== false) {
      // Vẽ nền badge bo góc với đổ bóng nhẹ
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = Math.round(8 * scale);
      ctx.shadowOffsetY = Math.round(2 * scale);

      ctx.fillStyle = "rgba(18, 18, 22, 0.85)";
      const r = Math.round(6 * scale);
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, r);
      ctx.fill();

      // Viền tinh tế
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = Math.max(1, Math.round(1 * scale));
      ctx.stroke();
      ctx.restore();
    }

    // Vẽ chữ
    ctx.fillStyle = item.textColor || item.strokeColor || "#ffffff";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;

    // Căn giữa hoặc vẽ nhiều dòng
    const lines = text.split("\n");
    const lineHeight = fontSizePx * 1.35;
    const totalTextHeight = lines.length * lineHeight;
    let startY = (h - totalTextHeight) / 2 + lineHeight / 2;

    for (const line of lines) {
      ctx.fillText(line, paddingX, startY);
      startY += lineHeight;
    }
  } else if (item.type === "arrow") {
    const color = item.strokeColor || "#ef4444";
    const scale = Math.max(0.75, Math.min(2.5, videoWidth / 1280));
    const strokeWidth = (item.strokeWidth || 3) * scale;

    const sx = (item.arrowStartX ?? 0.1) * w;
    const sy = (item.arrowStartY ?? 0.1) * h;
    const ex = (item.arrowEndX ?? 0.9) * w;
    const ey = (item.arrowEndY ?? 0.9) * h;

    const dx = ex - sx;
    const dy = ey - sy;
    const angle = Math.atan2(dy, dx);
    const headLen = Math.max(12, strokeWidth * 4.5);

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = Math.round(5 * scale);
    ctx.shadowOffsetY = Math.round(1.5 * scale);

    // Thân mũi tên
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex - (headLen * 0.6) * Math.cos(angle), ey - (headLen * 0.6) * Math.sin(angle));
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.stroke();

    // Đầu mũi tên (tam giác)
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(
      ex - headLen * Math.cos(angle - Math.PI / 6),
      ey - headLen * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      ex - (headLen * 0.5) * Math.cos(angle),
      ey - (headLen * 0.5) * Math.sin(angle),
    );
    ctx.lineTo(
      ex - headLen * Math.cos(angle + Math.PI / 6),
      ey - headLen * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  return canvas.toDataURL("image/png");
}
