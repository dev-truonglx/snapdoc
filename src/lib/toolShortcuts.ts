import type { Tool } from "../features/annotation/model";

/** Phím vật lý → công cụ. Dùng `e.code` (không phụ thuộc layout/bộ gõ). */
export function editorToolFromKey(e: KeyboardEvent): Tool | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.code) {
    case "KeyV": return "select";
    case "KeyR": return e.shiftKey ? "numbered-rect" : "rect";
    case "KeyE": return "numbered-rect";
    case "KeyO": return "ellipse";
    case "KeyT": return "text";
    case "KeyN": return "step";
    case "KeyL": return "line";
    case "KeyH": return "highlight";
    case "KeyB": return "blur";
    case "KeyC": return "crop";
    case "KeyG": return "background";
    case "KeyW": return "numbered-arrow";
    case "KeyA": return e.shiftKey ? "numbered-arrow" : "arrow";
    default: return null;
  }
}

/** Tập con cho chụp nhanh (toolbar không có ellipse/line/blur/crop). */
export function quickToolFromKey(e: KeyboardEvent): Tool | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.code) {
    case "KeyV": return "select";
    case "KeyR": return e.shiftKey ? "numbered-rect" : "rect";
    case "KeyE": return "numbered-rect";
    case "KeyT": return "text";
    case "KeyN": return "step";
    case "KeyH": return "highlight";
    case "KeyW": return "numbered-arrow";
    case "KeyA": return e.shiftKey ? "numbered-arrow" : "arrow";
    default: return null;
  }
}
