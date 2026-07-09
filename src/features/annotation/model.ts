export type Tool =
  | "select"
  | "rect"
  | "ellipse"
  | "text"
  | "step"
  | "arrow"
  | "line"
  | "numbered-arrow"
  | "highlight"
  | "blur"
  | "crop";

interface Base {
  id: string;
  color: string;
  strokeWidth: number;
  x: number;
  y: number;
}

export interface RectAnn extends Base {
  type: "rect";
  width: number;
  height: number;
}
export interface EllipseAnn extends Base {
  type: "ellipse";
  width: number;
  height: number;
}
export interface TextAnn extends Base {
  type: "text";
  text: string;
  fontSize: number;
}
export interface StepAnn extends Base {
  type: "step";
  value: number;
  radius: number;
}
/** Mũi tên có đầu nhọn: từ (x,y) → (x2,y2). */
export interface ArrowAnn extends Base {
  type: "arrow";
  x2: number;
  y2: number;
}
/** Đường thẳng (không đầu mũi tên): từ (x,y) → (x2,y2). */
export interface LineAnn extends Base {
  type: "line";
  x2: number;
  y2: number;
}
/** Mũi tên kèm số thứ tự: số hiện tại vị trí đuôi mũi tên. */
export interface NumberedArrowAnn extends Base {
  type: "numbered-arrow";
  x2: number;
  y2: number;
  value: number;
  radius: number;
}
/** Highlight (tô màu bán trong suốt) trên vùng chữ nhật. */
export interface HighlightAnn extends Base {
  type: "highlight";
  width: number;
  height: number;
  /** Màu nền highlight (hex/rgba). opacity cố định 0.35. */
  color: string;
}
/** Blur / pixelate / redact: che mờ vùng nhạy cảm. */
export interface BlurAnn extends Base {
  type: "blur";
  width: number;
  height: number;
  /**
   * Kiểu che:
   * - "blur"    — Gaussian blur mềm (ẩn nhẹ, vẫn nhận ra hình dạng)
   * - "pixelate" — Pixelate (mosaic, che trung bình)
   * - "solid"   — Màu đặc (che tuyệt đối, an toàn nhất)
   */
  blurMode: "blur" | "pixelate" | "solid";
  /** Cường độ: 1–20 cho blur/pixelate (radius/tile size), không dùng cho solid. */
  blurRadius: number;
  /** Màu cho solid mode. Mặc định "#1a1a1a". */
  solidColor: string;
}

export type Annotation =
  | RectAnn
  | EllipseAnn
  | TextAnn
  | StepAnn
  | ArrowAnn
  | LineAnn
  | NumberedArrowAnn
  | HighlightAnn
  | BlurAnn;

/** Một "tài liệu" editor: ảnh nền + danh sách annotation (object-based). */
export interface Doc {
  image: string; // data URL
  imgW: number;
  imgH: number;
  /** DPI scale factor của màn hình nguồn (1.0 = normal, 2.0 = Retina 2×). */
  scaleFactor: number;
  annotations: Annotation[];
  /** Id bản ghi History tương ứng, nếu có — Save sẽ ghi đè tại chỗ record này
   * thay vì save-as ra vị trí khác. `null`/`undefined` cho ảnh mở từ file ngoài. */
  historyId?: string | null;
  /** Mode đã chụp ra ảnh này — `AnnotationStage` dùng để chọn zoom mặc định:
   * "region" → 100%, còn lại → fit cả chiều rộng/cao. `undefined` cho ảnh mở
   * từ file ngoài (không có khái niệm "mode", fit như bình thường). */
  captureMode?: string;
}

export const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.floor(Math.random() * 1e9)}`;

export const PRESET_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827"];
export const STROKE_WIDTHS = [2, 4, 6];
export const HIGHLIGHT_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f87171", "#e879f9"];
export const SOLID_COLORS = ["#1a1a1a", "#ef4444", "#111827", "#ffffff", "#0f172a"];
