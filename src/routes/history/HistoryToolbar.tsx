import { useState } from "react";
import { ipc } from "../../lib/ipc";
import { useHistory } from "./useHistoryStore";

const MODES = [
  { id: "", label: "Tất cả loại" },
  { id: "region", label: "Vùng chọn" },
  { id: "window", label: "Cửa sổ" },
  { id: "monitor", label: "Toàn màn hình" },
  { id: "all", label: "Mọi màn hình" },
  { id: "scroll", label: "Cuộn dài" },
  { id: "quick", label: "Chụp nhanh" },
] as const;

/** Chuyển "YYYY-MM-DD" (input date, local) sang unix-ms đầu ngày local. */
function dayStartMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

export default function HistoryToolbar() {
  const filter = useHistory((s) => s.filter);
  const setFilter = useHistory((s) => s.setFilter);
  const reload = useHistory((s) => s.reload);
  const [search, setSearch] = useState("");
  const [emptying, setEmptying] = useState(false);

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFilter({ search: search || undefined });
  };

  const onFromChange = (v: string) => {
    setFilter({ from: v ? dayStartMs(v) : undefined });
  };
  const onToChange = (v: string) => {
    // "to" là mốc loại trừ (created_at < to) → +1 ngày để bao trọn ngày đã chọn.
    setFilter({ to: v ? dayStartMs(v) + 86400_000 : undefined });
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
      <form onSubmit={onSearchSubmit} style={{ display: "flex", gap: 6 }}>
        <input
          placeholder="Tìm theo tên..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 160 }}
        />
      </form>

      <select
        value={filter.captureMode ?? ""}
        onChange={(e) => setFilter({ captureMode: e.target.value || undefined })}
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>

      <input type="date" onChange={(e) => onFromChange(e.target.value)} title="Từ ngày" />
      <span style={{ color: "var(--text-dim)" }}>—</span>
      <input type="date" onChange={(e) => onToChange(e.target.value)} title="Đến ngày" />

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
