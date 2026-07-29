import { create } from "zustand";
import type { Annotation, Doc, Tool } from "./model";
import { HIGHLIGHT_COLORS } from "./model";

const HISTORY_LIMIT = 30;

/** Các key style được phép GỘP undo-entry khi đổi liên tiếp trên CÙNG 1
 * annotation trong `COALESCE_WINDOW_MS` — kéo trong color picker của OS /
 * bấm spinner cỡ chữ liên tục bắn ra hàng loạt `updateAnnotation`, mỗi lần
 * từng push 1 history entry riêng → 1 thao tác chỉnh style cần cả chục lần
 * Ctrl+Z để hoàn tác. Gộp: giữ nguyên `past`, undo về thẳng trạng thái TRƯỚC
 * chuỗi chỉnh. CHỈ áp dụng cho key style — di chuyển/resize (x, y, width...)
 * vẫn mỗi lần 1 entry như cũ. */
const COALESCE_KEYS = new Set(["color", "strokeWidth", "fontSize", "blurMode", "solidColor", "blurRadius"]);
const COALESCE_WINDOW_MS = 800;

interface EditorState {
  doc: Doc | null;
  past: Doc[];
  future: Doc[];

  tool: Tool;
  color: string;
  /** Màu nền highlight (riêng biệt với color stroke). */
  highlightColor: string;
  strokeWidth: number;
  fontSize: number;
  /** Bán kính blur (px image-space). */
  blurRadius: number;
  /** Kiểu che mờ hiện tại. */
  blurMode: "blur" | "pixelate" | "solid";
  /** Màu dùng cho solid redact. */
  blurSolidColor: string;
  selectedId: string | null;
  /** Bộ đếm số thứ tự cho tool "step" (số bước) — độc lập với mũi tên số. */
  stepCounter: number;
  /** Bộ đếm số thứ tự cho tool "numbered-arrow" (mũi tên số) — độc lập với số bước. */
  arrowCounter: number;
  editingTextId: string | null;

  // setup
  loadDoc: (doc: Doc) => void;

  // tool / style
  setEditingText: (id: string | null) => void;
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  setHighlightColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  setFontSize: (size: number) => void;
  setBlurRadius: (r: number) => void;
  commitBlurRadius: () => void;
  setBlurMode: (m: "blur" | "pixelate" | "solid") => void;
  setBlurSolidColor: (c: string) => void;
  select: (id: string | null) => void;

  // mutations (đều đi qua history)
  addAnnotation: (a: Annotation) => void;
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void;
  /** Cập nhật annotation KHÔNG tạo history entry — dùng cho live preview (slider kéo). */
  updateAnnotationLive: (id: string, patch: Partial<Annotation>) => void;
  removeSelected: () => void;
  applyCrop: (image: string, imgW: number, imgH: number, annotations: Annotation[]) => void;
  /** Nối ảnh: thay ảnh nền bằng ảnh đã ghép, ĐI QUA history → Ctrl/Cmd+Z hoàn tác được. */
  applyStitch: (image: string, imgW: number, imgH: number) => void;

  // history
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  nextStep: () => number;
  nextArrowStep: () => number;

  /** Metadata gộp history (xem `COALESCE_KEYS`) — nội bộ, không render. */
  _lastCommitKey: string | null;
  _lastCommitAt: number;

  /** Đặt số sẽ gán cho badge "step" kế tiếp (>= 1). */
  setStepCounter: (n: number) => void;
  /** Đặt số sẽ gán cho "numbered-arrow" kế tiếp (>= 1). */
  setArrowCounter: (n: number) => void;
  /** Đánh số lại toàn bộ badge "step" theo thứ tự tạo (1..N), dọn gap sau khi xóa. */
  renumberSteps: () => void;
  /** Đánh số lại toàn bộ "numbered-arrow" theo thứ tự tạo (1..N). */
  renumberArrows: () => void;
}

function commit(state: EditorState, nextDoc: Doc): Partial<EditorState> {
  if (!state.doc) return {};
  const past = [...state.past, state.doc].slice(-HISTORY_LIMIT);
  // Reset metadata gộp: mutation KHÔNG-phải-style (thêm/xoá/crop...) chen vào
  // giữa thì chuỗi style sau đó bắt đầu entry mới (updateAnnotation tự ghi đè
  // 2 field này sau khi spread khi nó muốn tiếp tục chuỗi).
  return { doc: nextDoc, past, future: [], _lastCommitKey: null, _lastCommitAt: 0 };
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  past: [],
  future: [],
  tool: "select",
  color: "#ef4444",
  highlightColor: HIGHLIGHT_COLORS[0],
  strokeWidth: 2,
  fontSize: 22,
  blurRadius: 10,
  blurMode: "blur" as const,
  blurSolidColor: "#1a1a1a",
  selectedId: null,
  stepCounter: 1,
  arrowCounter: 1,
  editingTextId: null,
  _lastCommitKey: null,
  _lastCommitAt: 0,

  loadDoc: (doc) =>
    set({ doc, past: [], future: [], selectedId: null, stepCounter: 1, arrowCounter: 1, tool: "select", editingTextId: null }),

  setEditingText: (editingTextId) => set({ editingTextId }),
  setTool: (tool) => set({ tool, selectedId: tool === "select" ? get().selectedId : null }),

  setColor: (color) => {
    const { selectedId, doc } = get();
    if (selectedId && doc) {
      get().updateAnnotation(selectedId, { color } as Partial<Annotation>);
    }
    set({ color });
  },

  setHighlightColor: (highlightColor) => {
    const { selectedId, doc } = get();
    if (selectedId && doc) {
      const ann = doc.annotations.find((a) => a.id === selectedId);
      if (ann?.type === "highlight") {
        get().updateAnnotation(selectedId, { color: highlightColor } as Partial<Annotation>);
      }
    }
    set({ highlightColor });
  },

  setStrokeWidth: (strokeWidth) => {
    const { selectedId, doc } = get();
    if (selectedId && doc) {
      get().updateAnnotation(selectedId, { strokeWidth } as Partial<Annotation>);
    }
    set({ strokeWidth });
  },

  setFontSize: (fontSize) => {
    const { editingTextId, selectedId, doc } = get();
    const target = editingTextId ?? selectedId;
    if (target && doc) {
      const ann = doc.annotations.find((a) => a.id === target);
      if (ann?.type === "text") {
        get().updateAnnotation(target, { fontSize } as Partial<Annotation>);
      }
    }
    set({ fontSize });
  },

  setBlurRadius: (blurRadius) => {
    const { selectedId, doc } = get();
    if (selectedId && doc) {
      const ann = doc.annotations.find((a) => a.id === selectedId);
      if (ann?.type === "blur") {
        // Live update — không tạo history undo entry mỗi px kéo slider
        get().updateAnnotationLive(selectedId, { blurRadius } as Partial<Annotation>);
      }
    }
    set({ blurRadius });
  },

  commitBlurRadius: () => {
    // Gọi khi nhả slider (onMouseUp / onPointerUp) để push history entry
    const { selectedId, doc, blurRadius } = get();
    if (!selectedId || !doc) return;
    const ann = doc.annotations.find((a) => a.id === selectedId);
    if (ann?.type === "blur") {
      get().updateAnnotation(selectedId, { blurRadius } as Partial<Annotation>);
    }
  },

  setBlurMode: (blurMode) => {
    const { selectedId, doc } = get();
    if (selectedId && doc) {
      const ann = doc.annotations.find((a) => a.id === selectedId);
      if (ann?.type === "blur") {
        get().updateAnnotation(selectedId, { blurMode } as Partial<Annotation>);
      }
    }
    set({ blurMode });
  },

  setBlurSolidColor: (blurSolidColor) => {
    const { selectedId, doc } = get();
    if (selectedId && doc) {
      const ann = doc.annotations.find((a) => a.id === selectedId);
      if (ann?.type === "blur") {
        get().updateAnnotation(selectedId, { solidColor: blurSolidColor } as Partial<Annotation>);
      }
    }
    set({ blurSolidColor });
  },

  select: (selectedId) => {
    const { doc } = get();
    const ann = selectedId && doc ? doc.annotations.find((a) => a.id === selectedId) : null;
    set({
      selectedId,
      ...(ann?.type === "text"      ? { fontSize: ann.fontSize }                                    : null),
      ...(ann?.type === "highlight" ? { highlightColor: ann.color }                                 : null),
      ...(ann?.type === "blur"      ? { blurRadius: ann.blurRadius, blurMode: ann.blurMode,
                                        blurSolidColor: ann.solidColor }                            : null),
    });
  },

  addAnnotation: (a) =>
    set((s) => {
      if (!s.doc) return {};
      const next = { ...s.doc, annotations: [...s.doc.annotations, a] };
      return { ...commit(s, next), selectedId: a.id };
    }),

  updateAnnotation: (id, patch) =>
    set((s) => {
      if (!s.doc) return {};
      const next = {
        ...s.doc,
        annotations: s.doc.annotations.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a,
        ),
      };
      const keys = Object.keys(patch);
      const coalescible = keys.length > 0 && keys.every((k) => COALESCE_KEYS.has(k));
      const key = coalescible ? `${id}|${keys.sort().join(",")}` : null;
      const now = Date.now();
      if (
        key !== null &&
        s._lastCommitKey === key &&
        now - s._lastCommitAt < COALESCE_WINDOW_MS &&
        s.past.length > 0
      ) {
        // Gộp vào entry trước: giữ nguyên `past` — xem `COALESCE_KEYS`.
        return { doc: next, future: [], _lastCommitKey: key, _lastCommitAt: now };
      }
      return { ...commit(s, next), _lastCommitKey: key, _lastCommitAt: now };
    }),

  // Cập nhật KHÔNG đẩy history — dùng cho live preview khi kéo slider.
  // History chỉ được commit khi user nhả (onMouseUp / onBlur).
  updateAnnotationLive: (id, patch) =>
    set((s) => {
      if (!s.doc) return {};
      return {
        doc: {
          ...s.doc,
          annotations: s.doc.annotations.map((a) =>
            a.id === id ? ({ ...a, ...patch } as Annotation) : a,
          ),
        },
      };
    }),

  removeSelected: () =>
    set((s) => {
      if (!s.doc || !s.selectedId) return {};
      const annotations = s.doc.annotations.filter((a) => a.id !== s.selectedId);
      const next = { ...s.doc, annotations };
      // B1: khi không còn badge nào, tự đặt bộ đếm về 1 → lượt sau bắt đầu từ 1.
      const reset: Partial<EditorState> = {};
      if (!annotations.some((a) => a.type === "step")) reset.stepCounter = 1;
      if (!annotations.some((a) => a.type === "numbered-arrow")) reset.arrowCounter = 1;
      return { ...commit(s, next), selectedId: null, ...reset };
    }),

  applyCrop: (image, imgW, imgH, annotations) =>
    set((s) => {
      if (!s.doc) return {};
      return {
        ...commit(s, { image, imgW, imgH, scaleFactor: s.doc.scaleFactor, annotations, historyId: s.doc.historyId }),
        selectedId: null,
      };
    }),

  applyStitch: (image, imgW, imgH) =>
    set((s) => {
      if (!s.doc) return {};
      // Ảnh ghép ở pixel vật lý (không gắn với DPI nguồn nào) → scaleFactor 1.
      // commit() đẩy doc hiện tại vào past → undo khôi phục lại trạng thái trước nối.
      return {
        ...commit(s, { image, imgW, imgH, scaleFactor: 1, annotations: [], historyId: s.doc.historyId }),
        selectedId: null,
      };
    }),

  undo: () =>
    set((s) => {
      if (!s.past.length || !s.doc) return {};
      const past = [...s.past];
      const prev = past.pop()!;
      return { doc: prev, past, future: [s.doc, ...s.future], selectedId: null, _lastCommitKey: null };
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length || !s.doc) return {};
      const [next, ...rest] = s.future;
      return { doc: next, past: [...s.past, s.doc], future: rest, selectedId: null, _lastCommitKey: null };
    }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  nextStep: () => {
    const v = get().stepCounter;
    set({ stepCounter: v + 1 });
    return v;
  },

  nextArrowStep: () => {
    const v = get().arrowCounter;
    set({ arrowCounter: v + 1 });
    return v;
  },

  setStepCounter: (n) => set({ stepCounter: Math.max(1, Math.floor(n) || 1) }),
  setArrowCounter: (n) => set({ arrowCounter: Math.max(1, Math.floor(n) || 1) }),

  renumberSteps: () =>
    set((s) => {
      if (!s.doc || !s.doc.annotations.some((a) => a.type === "step")) return {};
      let n = 0;
      const annotations = s.doc.annotations.map((a) =>
        a.type === "step" ? ({ ...a, value: ++n } as Annotation) : a,
      );
      return { ...commit(s, { ...s.doc, annotations }), stepCounter: n + 1 };
    }),

  renumberArrows: () =>
    set((s) => {
      if (!s.doc || !s.doc.annotations.some((a) => a.type === "numbered-arrow")) return {};
      let n = 0;
      const annotations = s.doc.annotations.map((a) =>
        a.type === "numbered-arrow" ? ({ ...a, value: ++n } as Annotation) : a,
      );
      return { ...commit(s, { ...s.doc, annotations }), arrowCounter: n + 1 };
    }),
}));
