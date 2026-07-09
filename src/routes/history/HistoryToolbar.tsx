import { useState } from "react";
import { ipc } from "../../lib/ipc";
import { useHistory } from "./useHistoryStore";
import { dayStartMs, msToDayStr, ONE_DAY_MS } from "./dateUtils";

const MODES = [
  { id: "", label: "Tất cả loại" },
  { id: "region", label: "Vùng chọn" },
  { id: "window", label: "Cửa sổ" },
  { id: "full", label: "Toàn màn hình" },
  { id: "all", label: "Mọi màn hình" },
  { id: "scroll", label: "Cuộn dài" },
  { id: "quick", label: "Chụp nhanh" },
] as const;

const MEDIA_TYPES = [
  { id: "", label: "Tất cả nội dung" },
  { id: "image", label: "Ảnh" },
  { id: "video", label: "Video" },
] as const;

export default function HistoryToolbar() {
  const filter = useHistory((s) => s.filter);
  const setFilter = useHistory((s) => s.setFilter);
  const reload = useHistory((s) => s.reload);
  const [emptying, setEmptying] = useState(false);

  const onFromChange = (v: string) => {
    setFilter({ from: v ? dayStartMs(v) : undefined });
  };
  const onToChange = (v: string) => {
    // "to" là mốc loại trừ (created_at < to) → +1 ngày để bao trọn ngày đã chọn.
    setFilter({ to: v ? dayStartMs(v) + ONE_DAY_MS : undefined });
  };

  const onEmptyTrash = async () => {
    if (!confirm("Xoá vĩnh viễn toàn bộ mục trong Trash? Không thể hoàn tác.")) return;
    setEmptying(true);
    try {
      await ipc.emptyTrash();
      await reload();
    } finally {
      setEmptying(false);
    }
  };

  return (
    <div style={bar}>
      <select
        value={filter.mediaType ?? ""}
        onChange={(e) => setFilter({ mediaType: (e.target.value || undefined) as "image" | "video" | undefined })}
      >
        {MEDIA_TYPES.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>

      <select
        value={filter.captureMode ?? ""}
        onChange={(e) => setFilter({ captureMode: e.target.value || undefined })}
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>

      {/* Controlled — hiện ĐÚNG ngày đang lọc (mặc định hôm nay, xem
          `useHistoryStore.ts`) thay vì luôn trống như bản input uncontrolled
          cũ. "to" lưu dạng mốc loại trừ (+1 ngày) nên trừ lại 1 ngày khi hiện
          ra cho khớp với ngày người dùng thực sự chọn. */}
      <input
        type="date"
        value={filter.from != null ? msToDayStr(filter.from) : ""}
        onChange={(e) => onFromChange(e.target.value)}
        title="Từ ngày"
      />
      <span style={{ color: "var(--text-dim)" }}>—</span>
      <input
        type="date"
        value={filter.to != null ? msToDayStr(filter.to - ONE_DAY_MS) : ""}
        onChange={(e) => onToChange(e.target.value)}
        title="Đến ngày"
      />

      <div style={{ flex: 1 }} />

      <button
        style={toggleBtn(!filter.trashOnly)}
        onClick={() => setFilter({ trashOnly: false })}
      >
        Thư viện
      </button>
      <button
        style={toggleBtn(!!filter.trashOnly)}
        onClick={() => setFilter({ trashOnly: true })}
      >
        Trash
      </button>
      {filter.trashOnly && (
        <button style={dangerBtn} disabled={emptying} onClick={onEmptyTrash}>
          Empty Trash
        </button>
      )}
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-elevated)",
};

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--accent-text)" : "var(--text-dim)",
    fontSize: 13,
  };
}

const dangerBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid rgba(239,68,68,0.4)",
  background: "rgba(239,68,68,0.15)",
  color: "#fca5a5",
  fontSize: 13,
};
