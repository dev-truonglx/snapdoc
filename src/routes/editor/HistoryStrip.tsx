import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ipc, type HistoryItem } from "../../lib/ipc";
import {
  openLibraryImage,
  suspendActive,
  tryResume,
  dropSession,
  noteActiveKey,
} from "../../features/annotation/sessions";
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
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>([]);
  // Cache-bust counter theo id — tăng lên mỗi khi Rust báo thumbnail item đó
  // vừa được cập nhật, buộc <img> reload file mới từ đĩa thay vì dùng cache cũ.
  const [thumbVersions, setThumbVersions] = useState<Record<string, number>>({});
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Menu chuột phải trên 1 thumbnail — toạ độ VIEWPORT (`clientX`/`clientY`
  // lúc bấm chuột phải) để đặt menu qua `position: fixed`, item đang nhắm tới
  // giữ trong `id` (không lưu cả `HistoryItem` vì `items` có thể đổi trong
  // lúc menu mở, tra lại theo id khi cần).
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Id của lần bấm gần nhất — chỉ để quản spinner theo id. Việc chống race
  // "2 promise resolve sai thứ tự bấm" (từng gây hiện sai ảnh + gắn nhầm
  // `historyId`, khiến Save ghi đè nhầm record) nay do bộ đếm thế hệ DÙNG
  // CHUNG trong `sessions.ts` đảm nhiệm — xem `beginSwitch`/`isCurrentSwitch`.
  const latestRequestRef = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    ipc.listHistory({ limit: LIMIT, offset: 0, trashOnly: false })
      .then((page) => setItems(page.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const un = listen("refresh-capture", load);
    const unAdded = listen("history:item-added", load);
    // Thumbnail của item vừa được cập nhật (user vẽ annotation) — bump version
    // để <img> buộc reload file mới từ đĩa, không dùng cache cũ.
    const unThumb = listen<string>("history:thumb-updated", (e) => {
      setThumbVersions((prev) => ({ ...prev, [e.payload]: (prev[e.payload] ?? 0) + 1 }));
    });
    return () => {
      un.then((f) => f());
      unAdded.then((f) => f());
      unThumb.then((f) => f());
    };
  }, [load]);

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
    // Treo tài liệu đang mở NGAY, đồng bộ, trước mọi `await` — nếu không thì
    // `loadDoc` bên dưới ghi đè thẳng lên việc user đang làm dở.
    try {
      suspendActive();
    } catch (e) {
      console.error("[SnapDoc] Treo phiên sửa thất bại:", e);
    }
    onOpenImage();

    // Phiên còn trong RAM → khôi phục TỨC THÌ, đầy đủ cả undo stack, không cần
    // đọc lại file. Đi trước `beginSwitch`-rồi-await nên cũng không có race.
    if (tryResume(id)) {
      latestRequestRef.current = id;
      setOpeningId(null);
      return;
    }

    // Việc nạp thật đi qua `openLibraryImage` — ĐƯỜNG DUY NHẤT mở ảnh từ
    // Library (dùng chung với nút "Quay lại" ở banner), nơi gom token thế hệ +
    // quyền sở hữu object URL + cờ `markClean` khi nạp từ nháp.
    // `latestRequestRef` giữ lại chỉ để quản spinner theo id.
    latestRequestRef.current = id;
    setOpeningId(id);
    try {
      await openLibraryImage(id);
    } catch (e) {
      onFlash(String(e));
    } finally {
      // So theo id thay vì token: `openLibraryImage` tự quản token bên trong,
      // còn ở đây chỉ cần biết spinner đang là của lượt bấm nào.
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
      onFlash(t("historyStrip.copiedToClipboard"));
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

  // Xoá tạm (chuyển vào Thùng rác) — row DB được gắn deleted_at, file vẫn còn
  // trên đĩa và có thể xem/khôi phục trong Thùng rác (Trash).
  const doTrash = async (id: string) => {
    setDeletingId(id);
    try {
      await ipc.deleteHistoryItem(id);
      dropSession(id);
      onFlash(t("historyStrip.movedToTrash"));

      // Nếu tài liệu đang bị xoá chính là tài liệu đang mở trong Editor:
      if (id === currentId) {
        noteActiveKey(null);
        const remaining = items.filter((it) => it.id !== id);
        if (remaining.length > 0) {
          const idx = items.findIndex((it) => it.id === id);
          const nextItem = idx < remaining.length ? remaining[idx] : remaining[remaining.length - 1];
          openItem(nextItem);
        } else {
          onOpenImage(); // Thoát video nếu đang xem video
          useEditor.getState().loadDoc(null);
        }
      }
      load();
    } catch (err) {
      onFlash(String(err));
    } finally {
      setDeletingId(null);
    }
  };

  // Xoá vĩnh viễn khỏi máy tính — xoá cả row DB lẫn file asset/thumbnail trên đĩa.
  const doPermanentDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await ipc.permanentlyDeleteHistoryItem(id);
      dropSession(id);
      onFlash(t("historyStrip.deletedPermanent"));

      // Nếu tài liệu đang bị xoá chính là tài liệu đang mở trong Editor:
      if (id === currentId) {
        noteActiveKey(null);
        const remaining = items.filter((it) => it.id !== id);
        if (remaining.length > 0) {
          const idx = items.findIndex((it) => it.id === id);
          const nextItem = idx < remaining.length ? remaining[idx] : remaining[remaining.length - 1];
          openItem(nextItem);
        } else {
          onOpenImage(); // Thoát video nếu đang xem video
          useEditor.getState().loadDoc(null);
        }
      }
      load();
    } catch (err) {
      onFlash(String(err));
    } finally {
      setDeletingId(null);
    }
  };

  const quickDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    doTrash(id);
  };

  // "Xem trong Thư mục" — mở Finder/Explorer, tự bôi đen đúng file asset
  // (`ipc.revealHistoryItem`, đã có sẵn cho `HistoryPreviewPanel.tsx`).
  const doReveal = (id: string) => {
    ipc.revealHistoryItem(id).catch((err) => onFlash(String(err)));
  };

  return (
    <div style={strip}>
      <span style={label}>{t("historyStrip.recent")}</span>
      <div style={scrollRow}>
        {items.map((item) => {
          const isVideo = item.mediaType === "video";
          return (
            <div
              key={item.id}
              className="history-thumb"
              style={{
                ...thumbBtn,
                outline:
                  item.id === currentId
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                opacity: openingId === item.id ? 0.55 : 1,
                cursor: openingId ? "wait" : "pointer",
              }}
              onClick={() => openItem(item)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: item.id, x: e.clientX, y: e.clientY });
              }}
              title={
                isVideo
                  ? t("historyStrip.openVideoEditor")
                  : t("historyStrip.reopenEditor")
              }
            >
              <img
                src={thumbVersions[item.id]
                  ? `${convertFileSrc(item.thumbPath)}?v=${thumbVersions[item.id]}`
                  : convertFileSrc(item.thumbPath)}
                alt=""
                style={thumbImg}
                loading="lazy"
              />
              {/* `.history-thumb-action`: ẩn mặc định, chỉ hiện khi hover vào
                  `.history-thumb` (xem CSS ở `global.css`) — dùng class thay vì
                  style JS vì đây thuần hiệu ứng hover, không cần biết state ở
                  React (đỡ re-render mỗi lần di chuột qua hàng chục thumbnail). */}
              <button
                className="history-thumb-action"
                style={deleteBtn}
                disabled={deletingId === item.id}
                onClick={(e) => quickDelete(e, item.id)}
                title={isVideo ? t("historyStrip.deleteVideo") : t("historyStrip.deleteImage")}
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
                  title={t("historyStrip.quickCopy")}
                >
                  {CopyIcon}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button style={viewAllBtn} onClick={() => ipc.openHistory()}>{t("historyStrip.viewAll")}</button>
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
              {isVideo ? t("historyStrip.openVideoEditor") : t("historyStrip.reopenEditor")}
            </button>
            <button style={contextMenuItem} onClick={() => { setMenu(null); doReveal(item.id); }}>
              {t("historyStrip.viewInFolder")}
            </button>
            {!isVideo && (
              <button style={contextMenuItem} onClick={() => { setMenu(null); doCopy(item.id); }}>
                {t("historyStrip.quickCopy")}
              </button>
            )}
            <div style={contextMenuDivider} />
            <button style={contextMenuItem} onClick={() => { setMenu(null); doTrash(item.id); }}>
              {t("historyStrip.moveToTrash")}
            </button>
            <button style={{ ...contextMenuItem, color: "#fca5a5" }} onClick={() => { setMenu(null); doPermanentDelete(item.id); }}>
              {t("historyStrip.deletePermanent")}
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
