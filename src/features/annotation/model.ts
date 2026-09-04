export type Tool =
  | "select"
  | "rect"
  | "ellipse"
  | "text"
  | "step"
  | "arrow"
  | "line"
  | "numbered-arrow"
  | "numbered-rect"
  | "highlight"
  | "blur"
  | "crop"
  | "background";

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
  width?: number;
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
/** Hình vuông / chữ nhật kèm số thứ tự ở góc. */
export interface NumberedRectAnn extends Base {
  type: "numbered-rect";
  width: number;
  height: number;
  value: number;
  radius: number;
  corner?: "tl" | "tr" | "bl" | "br";
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

/** Ảnh chèn thêm vào tài liệu (từ kéo thả hoặc dán clipboard). */
export interface ImageAnn {
  id: string;
  type: "image";
  /** Data URL hoặc URL ảnh. */
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Annotation =
  | RectAnn
  | EllipseAnn
  | TextAnn
  | StepAnn
  | ArrowAnn
  | LineAnn
  | NumberedArrowAnn
  | NumberedRectAnn
  | HighlightAnn
  | BlurAnn
  | ImageAnn;

/** Cấu hình khung nền gradient / solid (Mockup / Beautifier) */
export interface BackgroundConfig {
  enabled: boolean;
  type: "gradient" | "solid";
  /** ID preset nếu là preset dựng sẵn, hoặc "custom" */
  presetId?: string;
  /** Mảng màu gradient hoặc 1 màu duy nhất nếu solid */
  colors: string[];
  /** Góc gradient (độ, mặc định 135) */
  angle?: number;
  /** Khoảng đệm viền (px trong không gian ảnh) */
  padding: number;
  /** Bo góc của ảnh chụp (px) */
  borderRadius: number;
  /** Kiểu đổ bóng dưới ảnh chụp */
  shadow: "none" | "subtle" | "medium" | "strong";
}

export interface BackgroundPreset {
  id: string;
  name: string;
  type: "gradient" | "solid";
  colors: string[];
  angle?: number;
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { id: "sunset", name: "Sunset", type: "gradient", colors: ["#f97316", "#e11d48", "#8b5cf6"], angle: 135 },
  { id: "ocean", name: "Ocean", type: "gradient", colors: ["#06b6d4", "#2563eb", "#4f46e5"], angle: 135 },
  { id: "cyberpunk", name: "Cyberpunk", type: "gradient", colors: ["#7928ca", "#ff0080", "#ff7a00"], angle: 135 },
  { id: "emerald", name: "Emerald", type: "gradient", colors: ["#059669", "#10b981", "#06b6d4"], angle: 135 },
  { id: "lavender", name: "Cosmic", type: "gradient", colors: ["#4f46e5", "#9333ea", "#f43f5e"], angle: 135 },
  { id: "peach", name: "Peach", type: "gradient", colors: ["#f43f5e", "#fb7185", "#fbbf24"], angle: 135 },
  { id: "aurora", name: "Aurora", type: "gradient", colors: ["#10b981", "#06b6d4", "#8b5cf6"], angle: 135 },
  { id: "midnight", name: "Midnight", type: "gradient", colors: ["#0f0c29", "#302b63", "#24243e"], angle: 135 },
  { id: "frost", name: "Frost", type: "gradient", colors: ["#c4b5fd", "#93c5fd", "#6ee7b7"], angle: 135 },
  { id: "dark-solid", name: "Dark", type: "solid", colors: ["#18181b"] },
  { id: "light-solid", name: "Light", type: "solid", colors: ["#f8fafc"] },
];

export const DEFAULT_BACKGROUND_CONFIG: BackgroundConfig = {
  enabled: true,
  type: "gradient",
  presetId: "sunset",
  colors: ["#f97316", "#e11d48", "#8b5cf6"],
  angle: 135,
  padding: 32,
  borderRadius: 12,
  shadow: "medium",
};

/** Một "tài liệu" editor: ảnh nền + danh sách annotation (object-based). */
export interface Doc {
  image: string; // data URL
  imgW: number;
  imgH: number;
  /** DPI scale factor của màn hình nguồn (1.0 = normal, 2.0 = Retina 2×). */
  scaleFactor: number;
  annotations: Annotation[];
  /** Cấu hình khung nền gradient / solid (nếu có) */
  background?: BackgroundConfig;
  /** Id bản ghi History tương ứng, nếu có — Save sẽ ghi đè tại chỗ record này
   * thay vì save-as ra vị trí khác. `null`/`undefined` cho ảnh mở từ file ngoài. */
  historyId?: string | null;
  /** Mode đã chụp ra ảnh này — `AnnotationStage` dùng để chọn zoom mặc định:
   * "region" → 100%, còn lại → fit cả chiều rộng/cao. `undefined` cho ảnh mở
   * từ file ngoài (không có khái niệm "mode", fit như bình thường). */
  captureMode?: string;
  /** Đường dẫn file `.snapdoc` trên đĩa mà tài liệu này đến từ (mở qua "Open
   * with"/Cmd+O). Có giá trị → Save ghi THẲNG lại chính file đó, không mở dialog
   * và không đụng Library, đúng ngữ nghĩa một trình soạn tài liệu.
   * `undefined` cho mọi thứ đến từ Library hoặc vừa chụp. */
  filePath?: string | null;
}

export const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.floor(Math.random() * 1e9)}`;

export const PRESET_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827"];
export const STROKE_WIDTHS = [1, 2, 4, 6];
export const HIGHLIGHT_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f87171", "#e879f9"];
export const SOLID_COLORS = ["#1a1a1a", "#ef4444", "#111827", "#ffffff", "#0f172a"];
