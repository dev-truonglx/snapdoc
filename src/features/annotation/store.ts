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
  selectedId: string | null;
  stepCounter: number;

  // setup
  loadDoc: (doc: Doc) => void;

  // tool / style
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
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
  selectedId: null,
  stepCounter: 1,

  loadDoc: (doc) =>
    set({ doc, past: [], future: [], selectedId: null, stepCounter: 1, tool: "select" }),

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
  select: (selectedId) => set({ selectedId }),

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
