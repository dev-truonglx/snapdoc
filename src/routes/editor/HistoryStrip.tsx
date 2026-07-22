import { useCallback, useEffect, useRef, useState } from "react";
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
  const [openingId, setOpeningId] = useState<string | null>(null);
  const currentHistoryId = useEditor((s) => s.doc?.historyId);
  // URL blob của ảnh đang hiển thị trong Editor (nếu nạp qua đường tắt bên
  // dưới) — cần revoke khi đổi ảnh khác để không rò rỉ memory.
  const lastBlobUrlRef = useRef<string | null>(null);
  // Id của lần bấm gần nhất — bấm nhanh 2 ảnh khác nhau trước khi ảnh đầu tải
  // xong có thể khiến 2 promise resolve KHÔNG đúng thứ tự bấm; so khớp id
  // này sau await để bỏ qua kết quả đã cũ, tránh hiện sai ảnh + gắn nhầm
  // `historyId` (Save sẽ ghi đè nhầm record).
  const latestRequestRef = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!("__TAURI_INTERNALS__" in window)) return; // dev-mode ngoài Tauri: bỏ qua
    ipc.listHistory({ limit: LIMIT, offset: 0, trashOnly: false })
      // Dải này chỉ phục vụ "mở lại trong Editor"/"copy nhanh" — cả 2 đều
      // chưa hỗ trợ video (xem history/commands.rs), nên lọc bớt ở đây thay
      // vì hiện video rồi báo lỗi khi bấm vào.
      .then((page) => setItems(page.items.filter((it) => it.mediaType !== "video")))
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

  useEffect(() => {
    return () => {
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
    };
  }, []);

  if (items.length === 0) return null;

  // Đổi ảnh đang xem TẠI CHỖ trong Editor: nạp bytes gốc trực tiếp qua
  // `getHistoryAssetBytes` (raw binary, không base64) rồi gọi `loadDoc` ngay
  // trên store — KHÔNG đi qua `openHistoryItemInEditor` (round-trip
  // PendingCapture/base64/JSON + show/focus/reposition lại chính cửa sổ
  // Editor đang mở, vốn là nguồn gây lag/giật khi bấm chọn ảnh ở dải này).
  const openInEditor = async (id: string) => {
    if (id === currentHistoryId) return;
    latestRequestRef.current = id;
    setOpeningId(id);
    try {
      const [item, bytes] = await Promise.all([ipc.getHistoryItem(id), ipc.getHistoryAssetBytes(id)]);
      if (latestRequestRef.current !== id) return; // đã bấm ảnh khác trong lúc chờ — bỏ kết quả này
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
      lastBlobUrlRef.current = url;
      useEditor.getState().loadDoc({
        image: url,
        imgW: item.width,
        imgH: item.height,
        scaleFactor: item.scaleFactor,
        annotations: [],
        historyId: item.id,
        captureMode: item.captureMode,
      });
    } catch (e) {
      if (latestRequestRef.current === id) onFlash(String(e));
    } finally {
      if (latestRequestRef.current === id) setOpeningId(null);
    }
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
            style={{
              ...thumbBtn,
              outline: item.id === currentHistoryId ? "2px solid var(--accent)" : "2px solid transparent",
              opacity: openingId === item.id ? 0.55 : 1,
              // Chặn double-click gây race giữa 2 lần nạp ảnh trong lúc 1
              // ảnh khác đang nạp — không chặn hover/click ảnh đang mở (item
              // đó bấm lại chỉ no-op, xem `openInEditor`).
              cursor: openingId ? "wait" : "pointer",
            }}
            onClick={() => openInEditor(item.id)}
            title="Mở lại trong Editor"
          >
            <img src={convertFileSrc(item.thumbPath)} alt="" style={thumbImg} loading="lazy" />
            {openingId === item.id && <div style={spinner}>···</div>}
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

const spinner: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#fff",
  fontSize: 10,
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
