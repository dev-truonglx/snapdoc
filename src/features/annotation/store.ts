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

  /** ĐÚNG object `Doc` đang khớp với bản đã persist (Save / vừa nạp xong).
   *
   * Dùng SO SÁNH REFERENCE để tính "chưa lưu" thay vì `past.length > 0`:
   * mọi mutation đều tạo object `Doc` MỚI (xem `commit`), còn `undo`/`redo`
   * trả về ĐÚNG object cũ lấy ra từ `past`/`future` — nên `doc !== savedRef`
   * là phép thử O(1) chính xác, tự xử lý luôn ca "user undo về đúng trạng
   * thái đã lưu thì hết dirty". Còn `past.length > 0` thì sau khi Save mà
   * sửa tiếp vẫn sai (không reset được), và undo về đầu cũng không sạch.
   *
   * Đổi style khi KHÔNG chọn annotation nào (vd `setColor`) chỉ set field
   * style, không đụng `doc` → cùng reference → tự động không dirty, không
   * cần đặc-cách gì. */
  savedRef: Doc | null;
  /** Video (`VideoTrimmer`) không dùng store này — `Editor.tsx` tự tính rồi
   * đẩy lên đây, để `isDirty()` là nguồn sự thật DUY NHẤT cho cả 2 chế độ. */
  videoDirty: boolean;
  /** `true` khi ẢNH NỀN trong RAM đã khác nền trên đĩa — tức đã crop / stitch /
   * flatten, khác với chỉ sửa annotation.
   *
   * Đường Save dùng cờ này để quyết định có gửi kèm base image lên Rust hay
   * không: một lần Save chỉ-annotation thì nền không đổi, khỏi phải đẩy vài MB
   * base64 qua IPC. */
  baseDirty: boolean;

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
  selectedIds: string[];
  /** Bộ đếm số thứ tự cho tool "step" (số bước) — độc lập với mũi tên số. */
  stepCounter: number;
  /** Bộ đếm số thứ tự cho tool "numbered-arrow" (mũi tên số) — độc lập với số bước. */
  arrowCounter: number;
  /** Bộ đếm số thứ tự cho tool "numbered-rect" (khung số). */
  rectCounter: number;
  editingTextId: string | null;

  // setup
  /** `markClean` = doc vừa nạp có coi như "đã lưu" hay không. Mặc định `true`
   * (ảnh vừa chụp / vừa mở từ Library → đúng bằng bản trên đĩa). Đường
   * FLATTEN phải truyền `false`: nó `loadDoc` lại với ảnh đã burn nhưng CHƯA
   * hề được lưu — chính app cũng nói vậy (xem `editorMain.flattenItem3`). */
  loadDoc: (doc: Doc | null, markClean?: boolean) => void;
  /** Khôi phục một phiên sửa đã bị treo (xem `sessions.ts`) — khác `loadDoc` ở
   * chỗ nó KHÔI PHỤC undo stack thay vì xoá.
   *
   * Cố tình là `set()` đa-field DUY NHẤT ở đây thay vì để `sessions.ts` tự gọi
   * `useEditor.setState({...})`: giữ mọi hiểu biết về hình dạng state bên
   * trong store, và không phải nới ngữ nghĩa `loadDoc` (vốn còn được cửa sổ
   * overlay Chụp nhanh dùng, xem `routes/overlay/Overlay.tsx`). */
  hydrateSession: (s: {
    doc: Doc;
    past: Doc[];
    future: Doc[];
    stepCounter: number;
    arrowCounter: number;
    rectCounter?: number;
    baseDirty: boolean;
    savedRef: Doc | null;
  }) => void;
  /** Đánh dấu trạng thái hiện tại là đã persist — gọi sau Save thành công. */
  markSaved: () => void;
  setVideoDirty: (v: boolean) => void;
  /** Báo ảnh nền vừa bị thay ngoài `applyCrop`/`applyStitch` (hiện chỉ có
   * đường FLATTEN, vốn đi qua `loadDoc` chứ không qua `commit`). */
  markBaseDirty: () => void;
  /** Nguồn sự thật duy nhất cho "có việc chưa lưu" (cả ảnh lẫn video). */
  isDirty: () => boolean;

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
  select: (id: string | null, multi?: boolean) => void;
  selectMany: (ids: string[], append?: boolean) => void;
  selectAll: () => void;

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

  /** Metadata gộp history (xem `COALESCE_KEYS`) — nội bộ, không render. */
  _lastCommitKey: string | null;
  _lastCommitAt: number;

  nextStep: () => number;
  nextArrowStep: () => number;
  nextRectStep: () => number;

  /** Đặt số sẽ gán cho badge "step" kế tiếp (>= 1). */
  setStepCounter: (n: number) => void;
  /** Đặt số sẽ gán cho "numbered-arrow" kế tiếp (>= 1). */
  setArrowCounter: (n: number) => void;
  /** Đặt số sẽ gán cho "numbered-rect" kế tiếp (>= 1). */
  setRectCounter: (n: number) => void;
  /** Đánh số lại toàn bộ badge "step" theo thứ tự tạo (1..N), dọn gap sau khi xóa. */
  renumberSteps: () => void;
  /** Đánh số lại toàn bộ "numbered-arrow" theo thứ tự tạo (1..N). */
  renumberArrows: () => void;
  /** Đánh số lại toàn bộ "numbered-rect" theo thứ tự tạo (1..N). */
  renumberRects: () => void;
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
  savedRef: null,
  videoDirty: false,
  baseDirty: false,
  tool: "select",
  color: "#ef4444",
  highlightColor: HIGHLIGHT_COLORS[0],
  strokeWidth: 2,
  fontSize: 22,
  blurRadius: 10,
  blurMode: "blur" as const,
  blurSolidColor: "#1a1a1a",
  selectedId: null,
  selectedIds: [],
  stepCounter: 1,
  arrowCounter: 1,
  rectCounter: 1,
  editingTextId: null,
  _lastCommitKey: null,
  _lastCommitAt: 0,

  loadDoc: (doc, markClean = true) =>
    set({
      doc,
      savedRef: markClean ? doc : null,
      // Reset theo `markClean`: nạp ảnh mới thì nền trong RAM ĐÚNG bằng nền trên
      // đĩa (`false`); còn đường FLATTEN (`markClean = false`) vừa thay nền bằng
      // ảnh đã burn nên phải là `true`, nếu không lần Save sau sẽ không gửi nền
      // mới lên và annotation cũ sẽ được đắp lại lên nền đã burn — VẼ ĐÔI.
      baseDirty: !markClean,
      past: [],
      future: [],
      selectedId: null,
      selectedIds: [],
      stepCounter: 1,
      arrowCounter: 1,
      rectCounter: 1,
      tool: "select",
      editingTextId: null,
    }),

  hydrateSession: (s) =>
    set({
      doc: s.doc,
      past: s.past,
      future: s.future,
      stepCounter: s.stepCounter,
      arrowCounter: s.arrowCounter,
      rectCounter: s.rectCounter ?? 1,
      baseDirty: s.baseDirty,
      savedRef: s.savedRef,
      // Reset phần state phù du: chọn/đang gõ text/metadata gộp undo không
      // thuộc về nội dung tài liệu, khôi phục lại chỉ gây trạng thái lơ lửng
      // (vd transformer bám vào annotation đã bị undo mất).
      selectedId: null,
      selectedIds: [],
      editingTextId: null,
      tool: "select",
      _lastCommitKey: null,
      _lastCommitAt: 0,
    }),

  // Save xong thì cả annotation LẪN nền đều đã khớp đĩa.
  markSaved: () => set((s) => ({ savedRef: s.doc, baseDirty: false })),

  setVideoDirty: (videoDirty) => set({ videoDirty }),

  markBaseDirty: () => set({ baseDirty: true }),

  isDirty: () => {
    const s = get();
    if (s.videoDirty) return true;
    return s.doc != null && s.doc !== s.savedRef;
  },

  setEditingText: (editingTextId) => set({ editingTextId }),
  setTool: (tool) =>
    set({
      tool,
      selectedId: tool === "select" ? get().selectedId : null,
      selectedIds: tool === "select" ? (get().selectedIds ?? []) : [],
    }),

  setColor: (color) => {
    const { selectedIds, selectedId, doc } = get();
    const targets = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (targets.length > 0 && doc) {
      const targetSet = new Set(targets);
      const next = {
        ...doc,
        annotations: doc.annotations.map((a) =>
          targetSet.has(a.id) && "color" in a && a.type !== "highlight"
            ? ({ ...a, color } as Annotation)
            : a,
        ),
      };
      set({ ...commit(get(), next), color });
      return;
    }
    set({ color });
  },

  setHighlightColor: (highlightColor) => {
    const { selectedIds, selectedId, doc } = get();
    const targets = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (targets.length > 0 && doc) {
      const targetSet = new Set(targets);
      const next = {
        ...doc,
        annotations: doc.annotations.map((a) =>
          targetSet.has(a.id) && a.type === "highlight"
            ? ({ ...a, color: highlightColor } as Annotation)
            : a,
        ),
      };
      set({ ...commit(get(), next), highlightColor });
      return;
    }
    set({ highlightColor });
  },

  setStrokeWidth: (strokeWidth) => {
    const { selectedIds, selectedId, doc } = get();
    const targets = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (targets.length > 0 && doc) {
      const targetSet = new Set(targets);
      const next = {
        ...doc,
        annotations: doc.annotations.map((a) => {
          if (!targetSet.has(a.id) || !("strokeWidth" in a)) return a;
          if (a.type === "numbered-rect" || a.type === "numbered-arrow" || a.type === "step") {
            return {
              ...a,
              strokeWidth,
              radius: Math.max(Math.round(strokeWidth * 2 + 5), 10),
            } as Annotation;
          }
          return { ...a, strokeWidth } as Annotation;
        }),
      };
      set({ ...commit(get(), next), strokeWidth });
      return;
    }
    set({ strokeWidth });
  },

  setFontSize: (fontSize) => {
    const { editingTextId, selectedIds, selectedId, doc } = get();
    const targets = editingTextId ? [editingTextId] : (selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []));
    if (targets.length > 0 && doc) {
      const targetSet = new Set(targets);
      const next = {
        ...doc,
        annotations: doc.annotations.map((a) =>
          targetSet.has(a.id) && a.type === "text"
            ? ({ ...a, fontSize } as Annotation)
            : a,
        ),
      };
      set({ ...commit(get(), next), fontSize });
      return;
    }
    set({ fontSize });
  },

  setBlurRadius: (blurRadius) => {
    const { selectedIds, selectedId, doc } = get();
    const targets = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (targets.length > 0 && doc) {
      for (const id of targets) {
        const ann = doc.annotations.find((a) => a.id === id);
        if (ann?.type === "blur") {
          get().updateAnnotationLive(id, { blurRadius } as Partial<Annotation>);
        }
      }
    }
    set({ blurRadius });
  },

  commitBlurRadius: () => {
    // Gọi khi nhả slider (onMouseUp / onPointerUp) để push history entry
    const { selectedIds, selectedId, doc, blurRadius } = get();
    const targets = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (targets.length === 0 || !doc) return;
    const targetSet = new Set(targets);
    const next = {
      ...doc,
      annotations: doc.annotations.map((a) =>
        targetSet.has(a.id) && a.type === "blur"
          ? ({ ...a, blurRadius } as Annotation)
          : a,
      ),
    };
    set({ ...commit(get(), next) });
  },

  setBlurMode: (blurMode) => {
    const { selectedIds, selectedId, doc } = get();
    const targets = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (targets.length > 0 && doc) {
      const targetSet = new Set(targets);
      const next = {
        ...doc,
        annotations: doc.annotations.map((a) =>
          targetSet.has(a.id) && a.type === "blur"
            ? ({ ...a, blurMode } as Annotation)
            : a,
        ),
      };
      set({ ...commit(get(), next), blurMode });
      return;
    }
    set({ blurMode });
  },

  setBlurSolidColor: (blurSolidColor) => {
    const { selectedIds, selectedId, doc } = get();
    const targets = selectedIds.length > 0 ? selectedIds : (selectedId ? [selectedId] : []);
    if (targets.length > 0 && doc) {
      const targetSet = new Set(targets);
      const next = {
        ...doc,
        annotations: doc.annotations.map((a) =>
          targetSet.has(a.id) && a.type === "blur"
            ? ({ ...a, solidColor: blurSolidColor } as Annotation)
            : a,
        ),
      };
      set({ ...commit(get(), next), blurSolidColor });
      return;
    }
    set({ blurSolidColor });
  },

  select: (id, multi = false) => {
    const { doc } = get();
    const selectedIds = get().selectedIds ?? [];
    if (!id) {
      set({ selectedId: null, selectedIds: [] });
      return;
    }
    let nextIds: string[];
    if (multi) {
      if (selectedIds.includes(id)) {
        nextIds = selectedIds.filter((x) => x !== id);
      } else {
        nextIds = [...selectedIds, id];
      }
    } else {
      nextIds = [id];
    }
    const nextId = nextIds[nextIds.length - 1] ?? null;
    const ann = nextId && doc ? doc.annotations.find((a) => a.id === nextId) : null;
    set({
      selectedId: nextId,
      selectedIds: nextIds,
      ...(ann && "color" in ann && ann.type !== "highlight" ? { color: (ann as any).color } : null),
      ...(ann && "strokeWidth" in ann ? { strokeWidth: (ann as any).strokeWidth } : null),
      ...(ann?.type === "text"      ? { fontSize: ann.fontSize }                                    : null),
      ...(ann?.type === "highlight" ? { highlightColor: ann.color }                                 : null),
      ...(ann?.type === "blur"      ? { blurRadius: ann.blurRadius, blurMode: ann.blurMode,
                                        blurSolidColor: ann.solidColor }                            : null),
    });
  },

  selectMany: (ids, append = false) => {
    const { doc } = get();
    const selectedIds = get().selectedIds ?? [];
    let nextIds: string[];
    if (append) {
      nextIds = Array.from(new Set([...selectedIds, ...ids]));
    } else {
      nextIds = ids;
    }
    const nextId = nextIds[nextIds.length - 1] ?? null;
    const ann = nextId && doc ? doc.annotations.find((a) => a.id === nextId) : null;
    set({
      selectedId: nextId,
      selectedIds: nextIds,
      ...(ann && "color" in ann && ann.type !== "highlight" ? { color: (ann as any).color } : null),
      ...(ann && "strokeWidth" in ann ? { strokeWidth: (ann as any).strokeWidth } : null),
      ...(ann?.type === "text"      ? { fontSize: ann.fontSize }                                    : null),
      ...(ann?.type === "highlight" ? { highlightColor: ann.color }                                 : null),
      ...(ann?.type === "blur"      ? { blurRadius: ann.blurRadius, blurMode: ann.blurMode,
                                        blurSolidColor: ann.solidColor }                            : null),
    });
  },

  selectAll: () => {
    const { doc } = get();
    if (!doc || doc.annotations.length === 0) return;
    const ids = doc.annotations.map((a) => a.id);
    get().selectMany(ids, false);
  },

  addAnnotation: (a) =>
    set((s) => {
      if (!s.doc) return {};
      const next = { ...s.doc, annotations: [...s.doc.annotations, a] };
      return { ...commit(s, next), selectedId: a.id, selectedIds: [a.id] };
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
      if (!s.doc) return {};
      const targets = s.selectedIds.length > 0 ? s.selectedIds : (s.selectedId ? [s.selectedId] : []);
      if (targets.length === 0) return {};
      const targetSet = new Set(targets);
      const annotations = s.doc.annotations.filter((a) => !targetSet.has(a.id));
      const next = { ...s.doc, annotations };
      // B1: khi không còn badge nào, tự đặt bộ đếm về 1 → lượt sau bắt đầu từ 1.
      const reset: Partial<EditorState> = {};
      if (!annotations.some((a) => a.type === "step")) reset.stepCounter = 1;
      if (!annotations.some((a) => a.type === "numbered-arrow")) reset.arrowCounter = 1;
      if (!annotations.some((a) => a.type === "numbered-rect")) reset.rectCounter = 1;
      return { ...commit(s, next), selectedId: null, selectedIds: [], ...reset };
    }),

  applyCrop: (image, imgW, imgH, annotations) =>
    set((s) => {
      if (!s.doc) return {};
      return {
        // `filePath` phải đi theo: mất nó thì tài liệu `.snapdoc` mở từ đĩa sau
        // khi crop sẽ không còn biết đường về file gốc, và Save rơi xuống nhánh
        // "xuất PNG mới" thay vì ghi lại chính file đó.
        ...commit(s, { image, imgW, imgH, scaleFactor: s.doc.scaleFactor, annotations, historyId: s.doc.historyId, filePath: s.doc.filePath }),
        selectedId: null,
        baseDirty: true,
      };
    }),

  applyStitch: (image, imgW, imgH) =>
    set((s) => {
      if (!s.doc) return {};
      // Ảnh ghép ở pixel vật lý (không gắn với DPI nguồn nào) → scaleFactor 1.
      // commit() đẩy doc hiện tại vào past → undo khôi phục lại trạng thái trước nối.
      return {
        // Giữ `filePath` — xem giải thích ở `applyCrop`.
        ...commit(s, { image, imgW, imgH, scaleFactor: 1, annotations: [], historyId: s.doc.historyId, filePath: s.doc.filePath }),
        selectedId: null,
        baseDirty: true,
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

  nextRectStep: () => {
    const v = get().rectCounter;
    set({ rectCounter: v + 1 });
    return v;
  },

  setStepCounter: (n) => set({ stepCounter: Math.max(1, Math.floor(n) || 1) }),
  setArrowCounter: (n) => set({ arrowCounter: Math.max(1, Math.floor(n) || 1) }),
  setRectCounter: (n) => set({ rectCounter: Math.max(1, Math.floor(n) || 1) }),

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

  renumberRects: () =>
    set((s) => {
      if (!s.doc || !s.doc.annotations.some((a) => a.type === "numbered-rect")) return {};
      let n = 0;
      const annotations = s.doc.annotations.map((a) =>
        a.type === "numbered-rect" ? ({ ...a, value: ++n } as Annotation) : a,
      );
      return { ...commit(s, { ...s.doc, annotations }), rectCounter: n + 1 };
    }),
}));

/** Hook render-safe cho "có việc chưa lưu" — dùng ở component thay vì tự viết
 * lại biểu thức, để chỉ có MỘT định nghĩa dirty trong toàn bộ codebase.
 * (`isDirty()` là bản gọi-được-ngoài-React, cho guard/side-effect.) */
export const useIsDirty = (): boolean =>
  useEditor((s) => s.videoDirty || (s.doc != null && s.doc !== s.savedRef));
