import { create } from "zustand";
import type { Annotation, Doc, Tool } from "./model";
import { HIGHLIGHT_COLORS } from "./model";

const HISTORY_LIMIT = 30;

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
  stepCounter: number;
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

  // history
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  nextStep: () => number;
}

function commit(state: EditorState, nextDoc: Doc): Partial<EditorState> {
  if (!state.doc) return {};
  const past = [...state.past, state.doc].slice(-HISTORY_LIMIT);
  return { doc: nextDoc, past, future: [] };
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  past: [],
  future: [],
  tool: "select",
  color: "#ef4444",
  highlightColor: HIGHLIGHT_COLORS[0],
  strokeWidth: 4,
  fontSize: 22,
  blurRadius: 12,
  blurMode: "blur" as const,
  blurSolidColor: "#1a1a1a",
  selectedId: null,
  stepCounter: 1,
  editingTextId: null,

  loadDoc: (doc) =>
    set({ doc, past: [], future: [], selectedId: null, stepCounter: 1, tool: "select", editingTextId: null }),

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
      return commit(s, next);
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
      const next = {
        ...s.doc,
        annotations: s.doc.annotations.filter((a) => a.id !== s.selectedId),
      };
      return { ...commit(s, next), selectedId: null };
    }),

  applyCrop: (image, imgW, imgH, annotations) =>
    set((s) => {
      if (!s.doc) return {};
      return {
        ...commit(s, { image, imgW, imgH, scaleFactor: s.doc.scaleFactor, annotations }),
        selectedId: null,
      };
    }),

  undo: () =>
    set((s) => {
      if (!s.past.length || !s.doc) return {};
      const past = [...s.past];
      const prev = past.pop()!;
      return { doc: prev, past, future: [s.doc, ...s.future], selectedId: null };
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length || !s.doc) return {};
      const [next, ...rest] = s.future;
      return { doc: next, past: [...s.past, s.doc], future: rest, selectedId: null };
    }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  nextStep: () => {
    const v = get().stepCounter;
    set({ stepCounter: v + 1 });
    return v;
  },
}));
