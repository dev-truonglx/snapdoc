import { create } from "zustand";
import { ipc, type HistoryFilter, type HistoryItem, type HistoryCounts } from "../../lib/ipc";

const PAGE_SIZE = 60;

export type ViewMode = "grid" | "list";
export type ActiveNav = "all" | "images" | "videos" | "trash" | "settings";

export function filterHistoryItems(items: HistoryItem[], searchQuery: string): HistoryItem[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) =>
      it.title?.toLowerCase().includes(q) ||
      it.sourceApp?.toLowerCase().includes(q) ||
      it.captureMode.toLowerCase().includes(q),
  );
}

interface HistoryState {
  items: HistoryItem[];
  filter: HistoryFilter;
  counts: HistoryCounts;
  refreshCounts: () => Promise<void>;
  selectedId: string | null;
  selectedIds: string[];
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  activeNav: ActiveNav;
  setActiveNav: (nav: ActiveNav) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  isRightPanelCollapsed: boolean;
  toggleRightPanel: () => void;
  /** Tăng mỗi lần filter đổi/reload — dùng để bỏ qua kết quả của request cũ
   * (setFilter) trả về sau khi user đã đổi sang filter khác, tránh trộn
   * nhầm kết quả của 2 filter khác nhau vào cùng danh sách hiển thị. */
  generation: number;
  setSelected: (id: string | null) => void;
  toggleSelect: (id: string, isShift?: boolean, isMetaOrCtrl?: boolean) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setFilter: (f: Partial<Omit<HistoryFilter, "limit" | "offset">>) => void;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Cập nhật 1 item tại chỗ (sau update_history_asset/rename) không reload cả trang. */
  patchItem: (id: string, patch: Partial<HistoryItem>) => void;
  /** Cập nhật tên của nhiều item cùng lúc (sau batch rename). */
  batchRenameItems: (renames: { id: string; title: string }[]) => void;
  /** Bỏ 1 item khỏi danh sách hiện tại (sau delete/restore đổi view). */
  removeItem: (id: string) => void;
  /** Bỏ nhiều item khỏi danh sách hiện tại (sau batch delete/restore). */
  removeItems: (ids: string[]) => void;
  /** Thêm 1 item MỚI lên đầu danh sách (sau khi cắt video — tạo record mới,
   * KHÔNG ghi đè bản gốc, xem `trim_history_video_sync`) rồi chọn luôn item
   * đó — người dùng vừa cắt xong nên thấy ngay kết quả, không phải tự tìm
   * trong danh sách. Không kiểm tra trùng filter hiện tại (ví dụ đang filter
   * theo `capture_mode` khác) — hiếm gặp và item mới luôn hợp lệ dữ liệu, chỉ
   * là có thể bị ẩn tạm nếu filter không khớp, tự nhất quán lại ở lần
   * `reload()`/`setFilter()` kế tiếp. */
  addItem: (item: HistoryItem) => void;
}

export const useHistory = create<HistoryState>((set, get) => ({
  items: [],
  // Mặc định KHÔNG giới hạn ngày (toàn bộ, mới nhất trước) — trước đây lọc
  // "hôm nay" tính 1 lần lúc load module nên bị lệch sau nửa đêm. Khoảng ngày
  // nhanh (Hôm nay / 7 ngày / 30 ngày) chọn ở `HistoryToolbar.tsx`.
  filter: {
    limit: PAGE_SIZE,
    offset: 0,
    trashOnly: false,
  },
  selectedId: null,
  selectedIds: [],
  loading: false,
  hasMore: true,
  error: null,
  generation: 0,
  viewMode: "grid",
  activeNav: "all",
  searchQuery: "",
  isRightPanelCollapsed: false,
  counts: { all: 0, images: 0, videos: 0, trash: 0, totalSize: 0 },

  refreshCounts: async () => {
    try {
      const counts = await ipc.getHistoryCounts();
      set({ counts });
    } catch {
      // Best-effort
    }
  },

  setViewMode: (mode) => set({ viewMode: mode }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  toggleRightPanel: () => set((s) => ({ isRightPanelCollapsed: !s.isRightPanelCollapsed })),
  setActiveNav: (nav) => {
    if (nav === "settings") {
      set({ activeNav: "settings" });
      return;
    }
    set({ activeNav: nav });
    if (nav === "all") {
      get().setFilter({ mediaType: undefined, trashOnly: false });
    } else if (nav === "images") {
      get().setFilter({ mediaType: "image", trashOnly: false });
    } else if (nav === "videos") {
      get().setFilter({ mediaType: "video", trashOnly: false });
    } else if (nav === "trash") {
      get().setFilter({ mediaType: undefined, trashOnly: true });
    }
  },

  setSelected: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),

  toggleSelect: (id, isShift, isMetaOrCtrl) => {
    const { items, searchQuery, selectedIds, selectedId } = get();
    const visibleItems = filterHistoryItems(items, searchQuery);
    if (isShift && selectedId) {
      const idx1 = visibleItems.findIndex((it) => it.id === selectedId);
      const idx2 = visibleItems.findIndex((it) => it.id === id);
      if (idx1 !== -1 && idx2 !== -1) {
        const start = Math.min(idx1, idx2);
        const end = Math.max(idx1, idx2);
        const rangeIds = visibleItems.slice(start, end + 1).map((it) => it.id);
        const newSelected = isMetaOrCtrl
          ? Array.from(new Set([...selectedIds, ...rangeIds]))
          : rangeIds;
        set({ selectedIds: newSelected, selectedId: id });
        return;
      }
    }
    if (isMetaOrCtrl) {
      if (selectedIds.includes(id)) {
        const next = selectedIds.filter((x) => x !== id);
        set({
          selectedIds: next,
          selectedId: selectedId === id ? (next[next.length - 1] ?? null) : selectedId,
        });
      } else {
        set({
          selectedIds: [...selectedIds, id],
          selectedId: id,
        });
      }
      return;
    }
    set({
      selectedIds: [id],
      selectedId: id,
    });
  },

  selectAll: () => {
    const visibleItems = filterHistoryItems(get().items, get().searchQuery);
    const allIds = visibleItems.map((it) => it.id);
    set({ selectedIds: allIds, selectedId: allIds[0] ?? null });
  },

  clearSelection: () => set({ selectedIds: [], selectedId: null }),

  setFilter: (f) => {
    const generation = get().generation + 1;
    // loading: false — ép reset để loadMore() bên dưới không bị chặn bởi
    // guard `loading` của 1 request cũ (filter trước) còn đang bay.
    set((s) => ({
      filter: { ...s.filter, ...f },
      items: [],
      hasMore: true,
      selectedId: null,
      selectedIds: [],
      error: null,
      generation,
      loading: false,
    }));
    get().loadMore();
  },

  reload: async () => {
    get().refreshCounts();
    const generation = get().generation + 1;
    set({ items: [], hasMore: true, selectedId: null, selectedIds: [], error: null, generation, loading: false });
    await get().loadMore();
  },

  loadMore: async () => {
    if (get().loading || !get().hasMore) return;
    const generation = get().generation;
    set({ loading: true, error: null });
    try {
      const { filter, items } = get();
      const page = await ipc.listHistory({ ...filter, limit: PAGE_SIZE, offset: items.length });
      // Filter đã đổi trong lúc chờ (setFilter/reload đã bump generation) —
      // kết quả này thuộc về 1 filter cũ, bỏ qua, KHÔNG đụng `loading`
      // (request cho generation mới đang tự quản lý trạng thái đó).
      if (get().generation !== generation) return;
      set((s) => ({
        items: [...s.items, ...page.items],
        loading: false,
        hasMore: s.items.length + page.items.length < page.total,
      }));
    } catch (e) {
      if (get().generation !== generation) return;
      set({ loading: false, error: String(e) });
    }
  },

  patchItem: (id, patch) => {
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  },

  batchRenameItems: (renames) => {
    const map = new Map(renames.map((r) => [r.id, r.title]));
    const now = Date.now();
    set((s) => ({
      items: s.items.map((it) => {
        const newTitle = map.get(it.id);
        return newTitle !== undefined ? { ...it, title: newTitle || null, updatedAt: now } : it;
      }),
    }));
  },

  removeItem: (id) => {
    set((s) => ({
      items: s.items.filter((it) => it.id !== id),
      selectedIds: s.selectedIds.filter((x) => x !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
    get().refreshCounts();
  },

  removeItems: (ids) => {
    const idSet = new Set(ids);
    set((s) => ({
      items: s.items.filter((it) => !idSet.has(it.id)),
      selectedIds: s.selectedIds.filter((x) => !idSet.has(x)),
      selectedId: idSet.has(s.selectedId ?? "") ? null : s.selectedId,
    }));
    get().refreshCounts();
  },

  addItem: (item) => {
    set((s) => ({ items: [item, ...s.items], selectedId: item.id, selectedIds: [item.id] }));
    get().refreshCounts();
  },
}));
