export type Tool = "select" | "rect" | "ellipse" | "text" | "step" | "arrow" | "numbered-arrow" | "crop";

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
/** Mũi tên đơn giản: từ (x,y) → (x2,y2). */
export interface ArrowAnn extends Base {
  type: "arrow";
  x2: number;
  y2: number;
}
/** Mũi tên kèm số thứ tự: số hiện tại vị trí đuôi mũi tên. */
export interface NumberedArrowAnn extends Base {
  type: "numbered-arrow";
  x2: number;
  y2: number;
  value: number; // số thứ tự
  radius: number; // bán kính vòng tròn số
}

export type Annotation = RectAnn | EllipseAnn | TextAnn | StepAnn | ArrowAnn | NumberedArrowAnn;

/** Một "tài liệu" editor: ảnh nền + danh sách annotation (object-based). */
export interface Doc {
  image: string; // data URL
  imgW: number;
  imgH: number;
  annotations: Annotation[];
}

export const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.floor(Math.random() * 1e9)}`;

export const PRESET_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827"];
export const STROKE_WIDTHS = [2, 4, 6];
