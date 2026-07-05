import { create } from "zustand";
import { ipc, type HistoryFilter, type HistoryItem } from "../../lib/ipc";

const PAGE_SIZE = 60;

interface HistoryState {
  items: HistoryItem[];
  filter: HistoryFilter;
  selectedId: string | null;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  setSelected: (id: string | null) => void;
  setFilter: (f: Partial<Omit<HistoryFilter, "limit" | "offset">>) => void;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Cập nhật 1 item tại chỗ (sau update_history_asset/rename) không reload cả trang. */
  patchItem: (id: string, patch: Partial<HistoryItem>) => void;
  /** Bỏ 1 item khỏi danh sách hiện tại (sau delete/restore đổi view). */
  removeItem: (id: string) => void;
}

export const useHistory = create<HistoryState>((set, get) => ({
  items: [],
  filter: { limit: PAGE_SIZE, offset: 0, trashOnly: false },
  selectedId: null,
  loading: false,
  hasMore: true,
  error: null,

  setSelected: (id) => set({ selectedId: id }),

  setFilter: (f) => {
    set((s) => ({ filter: { ...s.filter, ...f }, items: [], hasMore: true, selectedId: null, error: null }));
    get().loadMore();
  },

  reload: async () => {
    set({ items: [], hasMore: true, error: null });
    await get().loadMore();
  },

  loadMore: async () => {
    if (get().loading || !get().hasMore) return;
    set({ loading: true, error: null });
    try {
      const { filter, items } = get();
      const page = await ipc.listHistory({ ...filter, limit: PAGE_SIZE, offset: items.length });
      set((s) => ({
        items: [...s.items, ...page.items],
        loading: false,
        hasMore: s.items.length + page.items.length < page.total,
      }));
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  patchItem: (id, patch) => {
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  },

  removeItem: (id) => {
    set((s) => ({
      items: s.items.filter((it) => it.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },
}));
