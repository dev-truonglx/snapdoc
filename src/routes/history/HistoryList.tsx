import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useHistory } from "./useHistoryStore";
import HistoryListRow from "./HistoryListRow";

const ROW_HEIGHT = 60;

interface Props {
  onOpenEditor: (id: string) => void;
}

/** List view — 1 dòng/item, virtualized giống `HistoryGrid` nhưng không cần
 * tính số cột (luôn 1 "cột" chiều dọc). */
export default function HistoryList({ onOpenEditor }: Props) {
  const { t } = useTranslation();
  const items = useHistory((s) => s.items);
  const selectedId = useHistory((s) => s.selectedId);
  const setSelected = useHistory((s) => s.setSelected);
  const loadMore = useHistory((s) => s.loadMore);
  const hasMore = useHistory((s) => s.hasMore);
  const loading = useHistory((s) => s.loading);

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualRows = virtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (last && last.index >= items.length - 5 && hasMore && !loading) {
      loadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualRows.map((r) => r.index).join(","), items.length, hasMore, loading]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={header}>
        <span style={{ width: 64 + 10, flexShrink: 0 }} />
        <span style={{ flex: "1 1 auto" }}>{t("historyView.nameColumn")}</span>
        <span style={{ width: 100, flexShrink: 0 }}>{t("historyView.typeColumn")}</span>
        <span style={{ width: 130, flexShrink: 0 }}>{t("historyView.timeColumn")}</span>
        <span style={{ width: 70, flexShrink: 0 }}>{t("historyView.sizeColumn")}</span>
        <span style={{ width: 100, flexShrink: 0 }}>{t("historyView.dimensionsColumn")}</span>
        <span style={{ width: 56, flexShrink: 0 }}>{t("historyView.durationColumn")}</span>
      </div>
      <div ref={parentRef} style={scrollArea}>
        {items.length === 0 && !loading ? (
          <div style={emptyState}>{t("historyView.noCaptures")}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualRows.map((vRow) => {
              const item = items[vRow.index];
              return (
                <div
                  key={vRow.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vRow.size,
                    transform: `translateY(${vRow.start}px)`,
                    padding: "2px 10px",
                  }}
                >
                  <HistoryListRow
                    item={item}
                    selected={item.id === selectedId}
                    onSelect={() => setSelected(item.id)}
                    onOpenEditor={() => onOpenEditor(item.id)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {loading && <div style={loadingRow}>{t("historyView.loading")}</div>}
      </div>
    </div>
  );
}

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 20px",
  fontSize: 11,
  color: "var(--text-dim)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const scrollArea: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "6px 0",
};

const emptyState: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-dim)",
  fontSize: 13,
  height: "100%",
};

const loadingRow: React.CSSProperties = {
  textAlign: "center",
  padding: 10,
  fontSize: 12,
  color: "var(--text-dim)",
};
