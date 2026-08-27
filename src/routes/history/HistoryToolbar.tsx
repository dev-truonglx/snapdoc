import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";
import { useHistory } from "./useHistoryStore";
import { dayStartMs, msToDayStr, ONE_DAY_MS } from "./dateUtils";

export default function HistoryToolbar() {
  const { t } = useTranslation();

  const MODES = [
    { id: "", label: t("history.allModes") },
    { id: "region", label: t("capture.region") },
    { id: "window", label: t("capture.window") },
    { id: "full", label: t("capture.full") },
    { id: "all", label: t("capture.all") },
    { id: "scroll", label: t("capture.scroll") },
    { id: "quick", label: t("shortcuts.quick") },
  ] as const;

  const MEDIA_TYPES = [
    { id: "", label: t("history.allTypes") },
    { id: "image", label: t("history.images") },
    { id: "video", label: t("history.videos") },
  ] as const;

  const filter = useHistory((s) => s.filter);
  const setFilter = useHistory((s) => s.setFilter);
  const reload = useHistory((s) => s.reload);
  const viewMode = useHistory((s) => s.viewMode);
  const setViewMode = useHistory((s) => s.setViewMode);
  const [emptying, setEmptying] = useState(false);

  const onFromChange = (v: string) => {
    setFilter({ from: v ? dayStartMs(v) : undefined });
  };
  const onToChange = (v: string) => {
    // "to" là mốc loại trừ (created_at < to) → +1 ngày để bao trọn ngày đã chọn.
    setFilter({ to: v ? dayStartMs(v) + ONE_DAY_MS : undefined });
  };

  const onEmptyTrash = async () => {
    if (!confirm(t("history.emptyTrashConfirm"))) return;
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
        title={t("history.fromDate")}
      />
      <span style={{ color: "var(--text-dim)" }}>—</span>
      <input
        type="date"
        value={filter.to != null ? msToDayStr(filter.to - ONE_DAY_MS) : ""}
        onChange={(e) => onToChange(e.target.value)}
        title={t("history.toDate")}
      />

      <div style={{ flex: 1 }} />

      <div style={viewSwitch}>
        <button
          style={viewIconBtn(viewMode === "grid")}
          title={t("history.gridView")}
          onClick={() => setViewMode("grid")}
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
            <rect x="2" y="2" width="7" height="7" rx="1.5" />
            <rect x="11" y="2" width="7" height="7" rx="1.5" />
            <rect x="2" y="11" width="7" height="7" rx="1.5" />
            <rect x="11" y="11" width="7" height="7" rx="1.5" />
          </svg>
        </button>
        <button
          style={viewIconBtn(viewMode === "list")}
          title={t("history.listView")}
          onClick={() => setViewMode("list")}
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
            <rect x="2" y="3" width="16" height="3" rx="1" />
            <rect x="2" y="8.5" width="16" height="3" rx="1" />
            <rect x="2" y="14" width="16" height="3" rx="1" />
          </svg>
        </button>
      </div>

      <button
        style={toggleBtn(!filter.trashOnly)}
        onClick={() => setFilter({ trashOnly: false })}
      >
        {t("history.library")}
      </button>
      <button
        style={toggleBtn(!!filter.trashOnly)}
        onClick={() => setFilter({ trashOnly: true })}
      >
        {t("history.trash")}
      </button>
      {filter.trashOnly && (
        <button style={dangerBtn} disabled={emptying} onClick={onEmptyTrash}>
          {t("history.emptyTrash")}
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

const viewSwitch: React.CSSProperties = {
  display: "flex",
  gap: 2,
  padding: 2,
  borderRadius: 7,
  background: "var(--bg)",
  border: "1px solid var(--border)",
};

function viewIconBtn(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 24,
    borderRadius: 5,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--accent-text)" : "var(--text-dim)",
  };
}

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
