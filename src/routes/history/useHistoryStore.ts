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
  /** Tăng mỗi lần filter đổi/reload — dùng để bỏ qua kết quả của request cũ
   * (setFilter) trả về sau khi user đã đổi sang filter khác, tránh trộn
   * nhầm kết quả của 2 filter khác nhau vào cùng danh sách hiển thị. */
  generation: number;
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
  generation: 0,

  setSelected: (id) => set({ selectedId: id }),

  setFilter: (f) => {
    const generation = get().generation + 1;
    // loading: false — ép reset để loadMore() bên dưới không bị chặn bởi
    // guard `loading` của 1 request cũ (filter trước) còn đang bay.
    set((s) => ({ filter: { ...s.filter, ...f }, items: [], hasMore: true, selectedId: null, error: null, generation, loading: false }));
    get().loadMore();
  },

  reload: async () => {
    const generation = get().generation + 1;
    set({ items: [], hasMore: true, error: null, generation, loading: false });
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

  removeItem: (id) => {
    set((s) => ({
      items: s.items.filter((it) => it.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },
}));
