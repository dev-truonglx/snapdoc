import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, type HistoryItem } from "../../lib/ipc";
import { useEditor } from "../../features/annotation/store";
import { fmtDuration } from "../history/formatUtils";

const LIMIT = 20;

interface Props {
  onFlash: (msg: string) => void;
  /** Id item History đang mở trong Editor — ảnh (`doc.historyId`) hoặc video
   * (`videoDoc.historyId`), Editor tự tính rồi truyền xuống (xem `Editor.tsx`). */
  currentId?: string | null;
  /** Bấm 1 item video trong dải — Editor tự chuyển sang chế độ video. */
  onOpenVideo: (item: HistoryItem) => void;
  /** Bấm 1 item ẢNH trong dải trong lúc Editor đang ở chế độ video — Editor
   * cần biết để thoát chế độ video (`setVideoDoc(null)`) và hiện lại
   * `AnnotationStage`. Ảnh không tự đổi được `doc` trong store (đã có sẵn ở
   * `openImageInEditor`), chỉ thiếu bước thoát chế độ video này. */
  onOpenImage: () => void;
}

/** Dải "Gần đây" ở cạnh dưới Editor — xem nhanh, copy hoặc mở lại các capture
 * gần nhất mà không cần mở cửa sổ History đầy đủ. */
export default function HistoryStrip({ onFlash, currentId, onOpenVideo, onOpenImage }: Props) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Menu chuột phải trên 1 thumbnail — toạ độ VIEWPORT (`clientX`/`clientY`
  // lúc bấm chuột phải) để đặt menu qua `position: fixed`, item đang nhắm tới
  // giữ trong `id` (không lưu cả `HistoryItem` vì `items` có thể đổi trong
  // lúc menu mở, tra lại theo id khi cần).
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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
      .then((page) => setItems(page.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // Capture mới (vd hotkey trong lúc Editor đang mở, hoặc nút "New") → nạp lại dải.
    const un = listen("refresh-capture", load);
    // Chụp khung hình từ video đang xem trong Editor (chế độ "in-place", xem
    // `VideoTrimmer.doCaptureFrame`) KHÔNG emit "refresh-capture" (tránh Editor
    // nạp lại pending ảnh và mất video đang xem) — nghe riêng event ingest xong
    // để dải này vẫn tự cập nhật ngay.
    const unAdded = listen("history:item-added", load);
    return () => {
      un.then((f) => f());
      unAdded.then((f) => f());
    };
  }, [load]);

  useEffect(() => {
    return () => {
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
    };
  }, []);

  // Đóng menu chuột phải khi click ra ngoài hoặc nhấn Escape — cùng pattern
  // `showSaveMenu` ở `Toolbar.tsx`.
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);

  if (items.length === 0) return null;

  // Đổi ảnh đang xem TẠI CHỖ trong Editor: nạp bytes gốc trực tiếp qua
  // `getHistoryAssetBytes` (raw binary, không base64) rồi gọi `loadDoc` ngay
  // trên store — KHÔNG đi qua `openHistoryItemInEditor` (round-trip
  // PendingCapture/base64/JSON + show/focus/reposition lại chính cửa sổ
  // Editor đang mở, vốn là nguồn gây lag/giật khi bấm chọn ảnh ở dải này).
  const openImageInEditor = async (id: string) => {
    if (id === currentId) return;
    onOpenImage();
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

  const openItem = (item: HistoryItem) => {
    if (item.mediaType === "video") {
      onOpenVideo(item);
      return;
    }
    openImageInEditor(item.id);
  };

  // Logic thuần (không cần `MouseEvent`) — dùng chung cho cả nút nổi trên
  // thumbnail (cần `stopPropagation`, xem `quickCopy`) LẪN mục trong menu
  // chuột phải (`menu`, đứng riêng ngoài thumbnail nên không cần chặn nổi bọt).
  const doCopy = async (id: string) => {
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

  const quickCopy = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    doCopy(id);
  };

  // Xoá nhanh ngay từ dải "Gần đây" — VĨNH VIỄN (xoá cả row DB lẫn file
  // asset/thumbnail trên đĩa, xem `permanently_delete_history_item_sync` ở
  // backend), không qua Thùng rác. Không hỏi xác nhận theo yêu cầu — khác
  // `doPermanentDelete` ở `HistoryPreviewPanel.tsx` (có `confirm()`) vì đây
  // là thao tác được yêu cầu rõ ràng: bấm là xoá luôn, không hỏi lại.
  const doDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await ipc.permanentlyDeleteHistoryItem(id);
      // `load()` (gọi lại đúng `LIMIT` cũ) thay vì tự lọc `id` khỏi `items` —
      // lọc tại chỗ chỉ làm dải NGẮN LẠI 1 item, còn `load()` kéo thêm đúng 1
      // item kế tiếp (trước đó bị `LIMIT` cắt bớt) lên để dải luôn đủ số
      // lượng như trước khi xoá.
      load();
    } catch (err) {
      onFlash(String(err));
    } finally {
      setDeletingId(null);
    }
  };

  const quickDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    doDelete(id);
  };

  // "Xem trong Thư mục" — mở Finder/Explorer, tự bôi đen đúng file asset
  // (`ipc.revealHistoryItem`, đã có sẵn cho `HistoryPreviewPanel.tsx`).
  const doReveal = (id: string) => {
    ipc.revealHistoryItem(id).catch((err) => onFlash(String(err)));
  };

  return (
    <div style={strip}>
      <span style={label}>Gần đây</span>
      <div style={scrollRow}>
        {items.map((item) => {
          const isVideo = item.mediaType === "video";
          return (
            <div
              key={item.id}
              className="history-thumb"
              style={{
                ...thumbBtn,
                outline: item.id === currentId ? "2px solid var(--accent)" : "2px solid transparent",
                opacity: openingId === item.id ? 0.55 : 1,
                // Chặn double-click gây race giữa 2 lần nạp ảnh trong lúc 1
                // ảnh khác đang nạp — không chặn hover/click ảnh đang mở (item
                // đó bấm lại chỉ no-op, xem `openImageInEditor`).
                cursor: openingId ? "wait" : "pointer",
              }}
              onClick={() => openItem(item)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: item.id, x: e.clientX, y: e.clientY });
              }}
              title={isVideo ? "Mở video trong Editor" : "Mở lại trong Editor"}
            >
              <img src={convertFileSrc(item.thumbPath)} alt="" style={thumbImg} loading="lazy" />
              {/* `.history-thumb-action`: ẩn mặc định, chỉ hiện khi hover vào
                  `.history-thumb` (xem CSS ở `global.css`) — dùng class thay vì
                  style JS vì đây thuần hiệu ứng hover, không cần biết state ở
                  React (đỡ re-render mỗi lần di chuột qua hàng chục thumbnail). */}
              <button
                className="history-thumb-action"
                style={deleteBtn}
                disabled={deletingId === item.id}
                onClick={(e) => quickDelete(e, item.id)}
                title={isVideo ? "Xoá vĩnh viễn video này (cả file trên máy)" : "Xoá vĩnh viễn ảnh này (cả file trên máy)"}
              >
                {DeleteIcon}
              </button>
              {isVideo && (
                <>
                  <div style={playBadge} aria-hidden>
                    <svg width="12" height="12" viewBox="0 0 20 20" fill="#fff">
                      <path d="M6 4.5v11l9-5.5-9-5.5Z" />
                    </svg>
                  </div>
                  {item.durationMs != null && <span style={durationBadge}>{fmtDuration(item.durationMs)}</span>}
                </>
              )}
              {openingId === item.id && <div style={spinner}>···</div>}
              {/* Copy nhanh vào clipboard chưa hỗ trợ video — ẩn nút cho item video. */}
              {!isVideo && (
                <button
                  className="history-thumb-action"
                  style={copyBtn}
                  disabled={copyingId === item.id}
                  onClick={(e) => quickCopy(e, item.id)}
                  title="Copy nhanh vào clipboard"
                >
                  {CopyIcon}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button style={viewAllBtn} onClick={() => ipc.openHistory()}>Xem tất cả →</button>
      {/* Menu chuột phải trên 1 thumbnail — `position: fixed` theo đúng toạ độ
          bấm chuột (`menu.x`/`menu.y`), không phụ thuộc `scrollRow` cuộn
          ngang. Đóng khi click ra ngoài/Escape, xem effect ở trên. */}
      {menu && (() => {
        const item = items.find((it) => it.id === menu.id);
        if (!item) return null;
        const isVideo = item.mediaType === "video";
        // `translateY(-100%)`: neo ĐÁY menu vào đúng điểm bấm chuột phải, mở
        // NGƯỢC LÊN TRÊN thay vì xuống dưới — dải "Gần đây" nằm sát cạnh DƯỚI
        // cùng của cửa sổ Editor nên mở xuống dưới như menu thường lệ sẽ bị
        // tràn ra ngoài viewport, khuất mất phần lớn menu.
        return (
          <div ref={menuRef} style={{ ...contextMenu, left: menu.x, top: menu.y - 6, transform: "translateY(-100%)" }}>
            <button style={contextMenuItem} onClick={() => { setMenu(null); openItem(item); }}>
              {isVideo ? "Mở video trong Editor" : "Mở lại trong Editor"}
            </button>
            <button style={contextMenuItem} onClick={() => { setMenu(null); doReveal(item.id); }}>
              Xem file trong Thư mục
            </button>
            {!isVideo && (
              <button style={contextMenuItem} onClick={() => { setMenu(null); doCopy(item.id); }}>
                Copy nhanh vào clipboard
              </button>
            )}
            <div style={contextMenuDivider} />
            <button style={{ ...contextMenuItem, color: "#fca5a5" }} onClick={() => { setMenu(null); doDelete(item.id); }}>
              Xoá vĩnh viễn (cả file trên máy)
            </button>
          </div>
        );
      })()}
    </div>
  );
}

const CopyIcon = (
  <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden>
    <rect x="6" y="6" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 3 4v6A1.5 1.5 0 0 0 4.5 11.5H6" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const DeleteIcon = (
  <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden>
    <path d="M4 5.5h10M7.5 5.5V4a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M5.5 5.5l.6 8.4a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.4"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const strip: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 12px",
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
  width: 92,
  height: 64,
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
  width: 24,
  height: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 5,
  background: "rgba(0,0,0,0.65)",
  color: "#fff",
};

/** Nút xoá nhanh — góc TRÊN TRÁI (đối xứng `copyBtn` ở trên phải), luôn hiện
 * cho cả ảnh lẫn video (khác `copyBtn` chỉ hiện với ảnh). */
const deleteBtn: React.CSSProperties = {
  position: "absolute",
  top: 2,
  left: 2,
  width: 24,
  height: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 5,
  background: "rgba(0,0,0,0.65)",
  color: "#fff",
  zIndex: 1,
};

const playBadge: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 26,
  height: 26,
  borderRadius: "50%",
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

const durationBadge: React.CSSProperties = {
  position: "absolute",
  bottom: 3,
  right: 3,
  background: "rgba(0,0,0,0.65)",
  color: "#fff",
  fontSize: 10,
  padding: "1px 4px",
  borderRadius: 3,
};

const viewAllBtn: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
  padding: "4px 8px",
};

// Menu chuột phải trên thumbnail — cùng kiểu popover với `saveMenuPopover` ở
// `Toolbar.tsx` (nền tối, viền mảnh, đổ bóng), nhưng `position: fixed` theo
// toạ độ con trỏ lúc bấm chuột phải thay vì neo cạnh 1 phần tử cố định.
const contextMenu: React.CSSProperties = {
  position: "fixed",
  background: "rgba(30,30,36,0.99)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
  zIndex: 200,
  whiteSpace: "nowrap",
  minWidth: 200,
};

const contextMenuItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text, #cdd6f4)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};

const contextMenuDivider: React.CSSProperties = {
  height: 1,
  background: "rgba(255,255,255,0.1)",
  margin: "3px 2px",
};
