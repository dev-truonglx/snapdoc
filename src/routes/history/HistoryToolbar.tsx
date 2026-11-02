import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";
import { useHistory } from "./useHistoryStore";
import { dayStartMs, msToDayStr, todayStartMs, ONE_DAY_MS } from "./dateUtils";

type DatePreset = "all" | "today" | "7d" | "30d";

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

  const filter = useHistory((s) => s.filter);
  const setFilter = useHistory((s) => s.setFilter);
  const reload = useHistory((s) => s.reload);
  const viewMode = useHistory((s) => s.viewMode);
  const setViewMode = useHistory((s) => s.setViewMode);
  const searchQuery = useHistory((s) => s.searchQuery);
  const setSearchQuery = useHistory((s) => s.setSearchQuery);
  const isRightPanelCollapsed = useHistory((s) => s.isRightPanelCollapsed);
  const toggleRightPanel = useHistory((s) => s.toggleRightPanel);
  const [emptying, setEmptying] = useState(false);

  // Khoảng ngày nhanh — tính tại thời điểm bấm (không cache) để không bị lệch
  // ngày khi cửa sổ mở qua nửa đêm. `to` là mốc loại trừ (hết ngày hôm nay).
  const presetRange = (id: DatePreset): { from?: number; to?: number } => {
    if (id === "all") return { from: undefined, to: undefined };
    const today = todayStartMs();
    const days = id === "today" ? 1 : id === "7d" ? 7 : 30;
    return { from: today - (days - 1) * ONE_DAY_MS, to: today + ONE_DAY_MS };
  };
  const activePreset: DatePreset | "custom" =
    (["all", "today", "7d", "30d"] as const).find((id) => {
      const r = presetRange(id);
      return r.from === filter.from && r.to === filter.to;
    }) ?? "custom";

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
      <div style={searchWrap}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          style={searchInput}
          type="text"
          placeholder={t("history.searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button style={clearSearchBtn} onClick={() => setSearchQuery("")} title={t("common.cancel")}>
            ✕
          </button>
        )}
      </div>

      <select
        value={filter.captureMode ?? ""}
        onChange={(e) => setFilter({ captureMode: e.target.value || undefined })}
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>

      <select
        value={activePreset}
        onChange={(e) => {
          const v = e.target.value as DatePreset | "custom";
          if (v !== "custom") setFilter(presetRange(v));
        }}
        title={t("history.dateRange")}
      >
        <option value="all">{t("history.rangeAll")}</option>
        <option value="today">{t("history.rangeToday")}</option>
        <option value="7d">{t("history.rangeLast7")}</option>
        <option value="30d">{t("history.rangeLast30")}</option>
        {activePreset === "custom" && <option value="custom">{t("history.rangeCustom")}</option>}
      </select>

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
        style={viewIconBtn(!isRightPanelCollapsed)}
        title={isRightPanelCollapsed ? t("history.showDetails") : t("history.hideDetails")}
        onClick={toggleRightPanel}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
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

const dangerBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid rgba(239,68,68,0.4)",
  background: "rgba(239,68,68,0.15)",
  color: "#fca5a5",
  fontSize: 13,
};

const searchWrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderRadius: 6,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  width: 200,
};

const searchInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  padding: 0,
};

const clearSearchBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
};

