import { create } from "zustand";
import type { Annotation, Doc, Tool } from "./model";

const HISTORY_LIMIT = 30;

interface EditorState {
  doc: Doc | null;
  past: Doc[];
  future: Doc[];

  tool: Tool;
  color: string;
  strokeWidth: number;
  fontSize: number;
  selectedId: string | null;
  stepCounter: number;
  // id của text annotation đang được gõ (null = không gõ).
  // Dùng để phím tắt công cụ không cướp ký tự khi đang nhập chữ.
  editingTextId: string | null;

  // setup
  loadDoc: (doc: Doc) => void;

  // tool / style
  setEditingText: (id: string | null) => void;
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  setFontSize: (size: number) => void;
  select: (id: string | null) => void;

  // mutations (đều đi qua history)
  addAnnotation: (a: Annotation) => void;
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void;
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
  strokeWidth: 4,
  fontSize: 22,
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
  setStrokeWidth: (strokeWidth) => {
    const { selectedId, doc } = get();
    if (selectedId && doc) {
      get().updateAnnotation(selectedId, { strokeWidth } as Partial<Annotation>);
    }
    set({ strokeWidth });
  },
  setFontSize: (fontSize) => {
    // Ưu tiên text đang gõ, sau đó tới text đang chọn — đổi cỡ là thấy ngay.
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
  select: (selectedId) => {
    // Chọn 1 text → đồng bộ cỡ chữ trên toolbar về cỡ của nó.
    const { doc } = get();
    const ann = selectedId && doc ? doc.annotations.find((a) => a.id === selectedId) : null;
    set({ selectedId, ...(ann?.type === "text" ? { fontSize: ann.fontSize } : null) });
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
      return { ...commit(s, { image, imgW, imgH, annotations }), selectedId: null };
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
