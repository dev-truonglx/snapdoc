import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { useHistory } from "./useHistoryStore";
import HistoryItemCard from "./HistoryItemCard";

const CARD_MIN_WIDTH = 160;
const CARD_GAP = 10;
const ROW_HEIGHT = 150;

interface Props {
  onOpenEditor: (id: string) => void;
}

/** Grid virtualized (chỉ render hàng trong viewport) + background loading:
 * cuộn gần đáy sẽ tự nạp trang tiếp theo qua `loadMore()` thay vì tải hết. */
export default function HistoryGrid({ onOpenEditor }: Props) {
  const { t } = useTranslation();
  const items = useHistory((s) => s.items);
  const selectedId = useHistory((s) => s.selectedId);
  const setSelected = useHistory((s) => s.setSelected);
  const loadMore = useHistory((s) => s.loadMore);
  const hasMore = useHistory((s) => s.hasMore);
  const loading = useHistory((s) => s.loading);

  const parentRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      setColumns(Math.max(2, Math.floor(w / (CARD_MIN_WIDTH + CARD_GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = Math.max(1, Math.ceil(items.length / columns));

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 4,
  });
  const virtualRows = virtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (last && last.index >= rowCount - 3 && hasMore && !loading) {
      loadMore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualRows.map((r) => r.index).join(","), rowCount, hasMore, loading]);

  return (
    <div ref={parentRef} style={scrollArea}>
      {items.length === 0 && !loading ? (
        <div style={emptyState}>{t("historyView.noCaptures")}</div>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualRows.map((vRow) => {
            const start = vRow.index * columns;
            const rowItems = items.slice(start, start + columns);
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
                  display: "grid",
                  gridTemplateColumns: `repeat(${columns}, ${CARD_MIN_WIDTH}px)`,
                  justifyContent: "center",
                  gap: CARD_GAP,
                  padding: `0 ${CARD_GAP}px`,
                }}
              >
                {rowItems.map((item) => (
                  <HistoryItemCard
                    key={item.id}
                    item={item}
                    selected={item.id === selectedId}
                    onSelect={() => setSelected(item.id)}
                    onOpenEditor={() => onOpenEditor(item.id)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
      {loading && <div style={loadingRow}>{t("historyView.loading")}</div>}
    </div>
  );
}

const scrollArea: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "10px 0",
};

const emptyState: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-dim)",
  fontSize: 13,
};

const loadingRow: React.CSSProperties = {
  textAlign: "center",
  padding: 10,
  fontSize: 12,
  color: "var(--text-dim)",
};
