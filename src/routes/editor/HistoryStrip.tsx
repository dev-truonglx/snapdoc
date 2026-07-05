import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, type HistoryItem } from "../../lib/ipc";
import { useEditor } from "../../features/annotation/store";

const LIMIT = 20;

interface Props {
  onFlash: (msg: string) => void;
}

/** Dải "Gần đây" ở cạnh dưới Editor — xem nhanh, copy hoặc mở lại các capture
 * gần nhất mà không cần mở cửa sổ History đầy đủ. */
export default function HistoryStrip({ onFlash }: Props) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const currentHistoryId = useEditor((s) => s.doc?.historyId);

  const load = useCallback(() => {
    if (!("__TAURI_INTERNALS__" in window)) return; // dev-mode ngoài Tauri: bỏ qua
    ipc.listHistory({ limit: LIMIT, offset: 0, trashOnly: false })
      .then((page) => setItems(page.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // Capture mới (vd hotkey trong lúc Editor đang mở, hoặc nút "New") → nạp lại dải.
    const un = listen("refresh-capture", load);
    return () => {
      un.then((f) => f());
    };
  }, [load]);

  if (items.length === 0) return null;

  const openInEditor = (id: string) => {
    ipc.openHistoryItemInEditor(id).catch((e) => onFlash(String(e)));
  };

  const quickCopy = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setCopyingId(id);
    try {
      await ipc.copyHistoryItem(id);
      onFlash("Đã copy vào clipboard");
    } catch (err) {
      onFlash(String(err));
    } finally {
      setCopyingId(null);
    }
  };

  return (
    <div style={strip}>
      <span style={label}>Gần đây</span>
      <div style={scrollRow}>
        {items.map((item) => (
          <div
            key={item.id}
            style={{ ...thumbBtn, outline: item.id === currentHistoryId ? "2px solid var(--accent)" : "2px solid transparent" }}
            onClick={() => openInEditor(item.id)}
            title="Mở lại trong Editor"
          >
            <img src={convertFileSrc(item.thumbPath)} alt="" style={thumbImg} loading="lazy" />
            <button
              style={copyBtn}
              disabled={copyingId === item.id}
              onClick={(e) => quickCopy(e, item.id)}
              title="Copy nhanh vào clipboard"
            >
              {CopyIcon}
            </button>
          </div>
        ))}
      </div>
      <button style={viewAllBtn} onClick={() => ipc.openHistory()}>Xem tất cả →</button>
    </div>
  );
}

const CopyIcon = (
  <svg width="12" height="12" viewBox="0 0 18 18" aria-hidden>
    <rect x="6" y="6" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 3 4v6A1.5 1.5 0 0 0 4.5 11.5H6" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const strip: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  borderTop: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  flexShrink: 0,
};

const label: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const scrollRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  overflowX: "auto",
  flex: 1,
  minWidth: 0,
};

const thumbBtn: React.CSSProperties = {
  position: "relative",
  flexShrink: 0,
  width: 64,
  height: 44,
  borderRadius: 6,
  overflow: "hidden",
  cursor: "pointer",
  background: "#000",
};

const thumbImg: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const copyBtn: React.CSSProperties = {
  position: "absolute",
  top: 2,
  right: 2,
  width: 18,
  height: 18,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  background: "rgba(0,0,0,0.65)",
  color: "#fff",
};

const viewAllBtn: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
  padding: "4px 8px",
};
