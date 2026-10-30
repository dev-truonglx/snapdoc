export type Tool =
  | "select"
  | "rect"
  | "ellipse"
  | "text"
  | "step"
  | "arrow"
  | "double-arrow"
  | "line"
  | "numbered-arrow"
  | "numbered-rect"
  | "highlight"
  | "blur"
  | "crop"
  | "background"
  | "pen"
  | "spotlight"
  | "magnifier"
  | "emoji";

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
  /** Màu nền khung chữ (hex/rgba hoặc undefined cho không nền) */
  bgColor?: string;
  /** Bật/tắt mũi tên chỉ đích (Callout) */
  hasTargetArrow?: boolean;
  /** Toạ độ đích mũi tên trỏ tới */
  targetX?: number;
  targetY?: number;
}
export interface StepAnn extends Base {
  type: "step";
  value: number;
  radius: number;
}
/** Mũi tên có đầu nhọn: từ (x,y) → (x2,y2). */
export interface ArrowAnn extends Base {
  /** Điểm điều khiển (đường cong đi qua điểm này). Không có → đường thẳng. */
  cx?: number;
  cy?: number;
  type: "arrow";
  x2: number;
  y2: number;
}
/** Mũi tên 2 chiều (hai đầu nhọn): từ (x,y) ↔ (x2,y2) dùng chỉ khoảng cách / kích thước. */
export interface DoubleArrowAnn extends Base {
  /** Điểm điều khiển (đường cong đi qua điểm này). Không có → đường thẳng. */
  cx?: number;
  cy?: number;
  type: "double-arrow";
  x2: number;
  y2: number;
}
/** Đường thẳng (không đầu mũi tên): từ (x,y) → (x2,y2). */
export interface LineAnn extends Base {
  /** Điểm điều khiển (đường cong đi qua điểm này). Không có → đường thẳng. */
  cx?: number;
  cy?: number;
  type: "line";
  x2: number;
  y2: number;
}
/** Mũi tên kèm số thứ tự: số hiện tại vị trí đuôi mũi tên. */
export interface NumberedArrowAnn extends Base {
  /** Điểm điều khiển (đường cong đi qua điểm này). Không có → đường thẳng. */
  cx?: number;
  cy?: number;
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

/** Nét vẽ tự do: `points` = [x0, y0, x1, y1, …] TƯƠNG ĐỐI so với (x, y). */
export interface PenAnn extends Base {
  type: "pen";
  points: number[];
}

/** Spotlight: làm tối CẢ ẢNH trừ vùng này (nhiều spotlight → chừa hợp các vùng). */
export interface SpotlightAnn {
  id: string;
  type: "spotlight";
  x: number;
  y: number;
  width: number;
  height: number;
  shape: "rect" | "ellipse";
  /** Độ tối phần ngoài vùng (0..1). */
  dim: number;
}

/** Kính lúp: hình tròn tâm (x, y) bán kính `radius`, phóng to ảnh nền ngay tại chỗ. */
export interface MagnifierAnn extends Base {
  type: "magnifier";
  radius: number;
  zoom: number;
}

/** Sticker emoji: góc trên-trái (x, y), cỡ chữ `size`. */
export interface EmojiAnn {
  id: string;
  type: "emoji";
  x: number;
  y: number;
  emoji: string;
  size: number;
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
  | DoubleArrowAnn
  | LineAnn
  | NumberedArrowAnn
  | NumberedRectAnn
  | HighlightAnn
  | BlurAnn
  | ImageAnn
  | PenAnn
  | SpotlightAnn
  | MagnifierAnn
  | EmojiAnn;

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

/** Dời annotation theo (dx, dy), kể cả các toạ độ tuyệt đối phụ (x2/y2 của
 * mũi tên/đường thẳng, targetX/targetY của callout). */
export const translateAnnotation = (a: Annotation, dx: number, dy: number): Annotation => {
  const moved = { ...a, x: a.x + dx, y: a.y + dy };
  if (moved.type === "arrow" || moved.type === "double-arrow" || moved.type === "line" || moved.type === "numbered-arrow") {
    moved.x2 += dx;
    moved.y2 += dy;
    if (moved.cx !== undefined && moved.cy !== undefined) {
      moved.cx += dx;
      moved.cy += dy;
    }
  } else if (moved.type === "text") {
    if (moved.targetX !== undefined) moved.targetX += dx;
    if (moved.targetY !== undefined) moved.targetY += dy;
  }
  return moved;
};

/** Khung bao (ước lượng) của annotation trong không gian ảnh. */
export const annotationBounds = (a: Annotation): { x1: number; y1: number; x2: number; y2: number } => {
  let x1 = a.x;
  let y1 = a.y;
  let x2 = a.x;
  let y2 = a.y;
  if (a.type === "rect" || a.type === "ellipse" || a.type === "highlight" || a.type === "blur" || a.type === "numbered-rect" || a.type === "image" || a.type === "spotlight") {
    x2 = a.x + a.width;
    y2 = a.y + a.height;
  } else if (a.type === "pen") {
    for (let i = 0; i + 1 < a.points.length; i += 2) {
      x1 = Math.min(x1, a.x + a.points[i]);
      y1 = Math.min(y1, a.y + a.points[i + 1]);
      x2 = Math.max(x2, a.x + a.points[i]);
      y2 = Math.max(y2, a.y + a.points[i + 1]);
    }
  } else if (a.type === "magnifier") {
    x1 = a.x - a.radius;
    y1 = a.y - a.radius;
    x2 = a.x + a.radius;
    y2 = a.y + a.radius;
  } else if (a.type === "emoji") {
    x2 = a.x + a.size * 1.25;
    y2 = a.y + a.size * 1.25;
  } else if (a.type === "arrow" || a.type === "double-arrow" || a.type === "line" || a.type === "numbered-arrow") {
    const cx = a.cx ?? a.x;
    const cy = a.cy ?? a.y;
    x1 = Math.min(a.x, a.x2, cx);
    y1 = Math.min(a.y, a.y2, cy);
    x2 = Math.max(a.x, a.x2, cx);
    y2 = Math.max(a.y, a.y2, cy);
  } else if (a.type === "step") {
    x1 = a.x - a.radius;
    y1 = a.y - a.radius;
    x2 = a.x + a.radius;
    y2 = a.y + a.radius;
  } else if (a.type === "text") {
    const fs = a.fontSize || 22;
    const padX = a.bgColor ? Math.max(8, Math.round(fs * 0.35)) : 0;
    const padY = a.bgColor ? Math.max(6, Math.round(fs * 0.25)) : 0;
    const lines = (a.text || "").split("\n");
    const maxLineLen = Math.max(...lines.map((l) => l.length), 1);
    const estW = a.width || Math.max(40, maxLineLen * fs * 0.62);
    const estH = Math.max(fs * 1.35, lines.length * fs * 1.35);
    x2 = a.x + estW + padX * 2;
    y2 = a.y + estH + padY * 2;
    if (a.hasTargetArrow && a.targetX !== undefined && a.targetY !== undefined) {
      x1 = Math.min(x1, a.targetX);
      y1 = Math.min(y1, a.targetY);
      x2 = Math.max(x2, a.targetX);
      y2 = Math.max(y2, a.targetY);
    }
  }
  return { x1, y1, x2, y2 };
};

/** Bảng sticker emoji cho công cụ "emoji". */
export const EMOJI_STICKERS = [
  "👉", "👈", "👆", "👇", "✅", "❌", "⚠️", "❗", "❓", "💡",
  "⭐", "🔥", "🎯", "📌", "🔍", "👍", "👎", "👀", "😀", "😂",
  "😮", "🤔", "😡", "🎉", "❤️", "💯", "🚀", "🐞",
];
export const MAGNIFIER_ZOOMS = [1.5, 2, 3, 4];

/** Nét vẽ tự do: bỏ điểm sát nhau (< `minDist`) để giảm dữ liệu, luôn giữ điểm cuối. */
export const simplifyPoints = (pts: number[], minDist = 1.5): number[] => {
  if (pts.length <= 4) return pts.slice();
  const out = [pts[0], pts[1]];
  for (let i = 2; i + 1 < pts.length; i += 2) {
    const lx = out[out.length - 2];
    const ly = out[out.length - 1];
    if (Math.hypot(pts[i] - lx, pts[i + 1] - ly) >= minDist || i + 2 >= pts.length) out.push(pts[i], pts[i + 1]);
  }
  return out;
};

export const PRESET_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827"];
export const STROKE_WIDTHS = [1, 2, 4, 6];
export const HIGHLIGHT_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f87171", "#e879f9"];
export const SOLID_COLORS = ["#1a1a1a", "#ef4444", "#111827", "#ffffff", "#0f172a"];
export const TEXT_BG_PRESETS = [
  { id: "none", color: "" },
  { id: "white", color: "#ffffff" },
  { id: "dark", color: "#18181b" },
  { id: "yellow", color: "#fef08a" },
  { id: "blue", color: "#dbeafe" },
  { id: "red", color: "#fee2e2" },
];
