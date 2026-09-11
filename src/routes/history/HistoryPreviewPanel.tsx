import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";
import { useHistory } from "./useHistoryStore";
import { MODE_LABEL } from "./HistoryItemCard";
import { fmtDateTime, fmtSize, fmtDuration } from "./formatUtils";

interface Props {
  onOpenEditor: (id: string) => void;
}

export default function HistoryPreviewPanel({ onOpenEditor }: Props) {
  const { t } = useTranslation();
  const items = useHistory((s) => s.items);
  const selectedId = useHistory((s) => s.selectedId);
  const selectedIds = useHistory((s) => s.selectedIds);
  const selectAll = useHistory((s) => s.selectAll);
  const clearSelection = useHistory((s) => s.clearSelection);
  const filter = useHistory((s) => s.filter);
  const patchItem = useHistory((s) => s.patchItem);
  const removeItem = useHistory((s) => s.removeItem);
  const removeItems = useHistory((s) => s.removeItems);

  const item = items.find((it) => it.id === (selectedId ?? selectedIds[0])) ?? null;
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRenaming(false);
    setTitleDraft(item?.title ?? "");
  }, [item?.id]);

  // Ảnh xem trước phải đi qua IPC → Blob → object URL, KHÔNG dùng
  // `convertFileSrc(assetPath)` như trước: asset của ảnh giờ là container
  // `.snapdoc` (ZIP chứa nền + lớp annotation), `<img>` không render được. Bytes
  // lấy về là `preview.png` — bản ĐÃ ghép annotation, tức đúng cái user thấy
  // trong Editor và trên thumbnail. Video thì `asset_path` vẫn là file .mp4
  // thật nên giữ nguyên đường asset protocol.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewKey = item && item.mediaType !== "video" ? `${item.id}:${item.updatedAt}` : null;
  useEffect(() => {
    if (!previewKey) {
      setPreviewUrl(null);
      return;
    }
    if (!("__TAURI_INTERNALS__" in window)) return;
    let url: string | null = null;
    let alive = true;
    ipc
      .getHistoryPreviewBytes(previewKey.split(":")[0])
      .then((bytes) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setPreviewUrl(url);
      })
      .catch(() => {
        if (alive) setPreviewUrl(null);
      });
    // Revoke ngay khi đổi item / unmount — thiếu bước này là rò memory ở cửa
    // sổ History (mỗi lần chọn ảnh giữ lại một bản ảnh gốc trong RAM).
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [previewKey]);

  if (selectedIds.length > 1) {
    const selectedItems = items.filter((it) => selectedIds.includes(it.id));
    const totalSize = selectedItems.reduce((acc, it) => acc + (it.fileSize ?? 0), 0);
    const imageCount = selectedItems.filter((it) => it.mediaType !== "video").length;
    const videoCount = selectedItems.filter((it) => it.mediaType === "video").length;
    const isTrash = !!filter.trashOnly;

    const doBatchDelete = async () => {
      setBusy(true);
      try {
        await ipc.deleteHistoryItems(selectedIds);
        removeItems(selectedIds);
      } finally {
        setBusy(false);
      }
    };

    const doBatchRestore = async () => {
      setBusy(true);
      try {
        await ipc.restoreHistoryItems(selectedIds);
        removeItems(selectedIds);
      } finally {
        setBusy(false);
      }
    };

    const doBatchPermanentDelete = async () => {
      if (!confirm(t("history.permanentDeleteSelectedConfirm", { count: selectedIds.length }))) return;
      setBusy(true);
      try {
        await ipc.permanentlyDeleteHistoryItems(selectedIds);
        removeItems(selectedIds);
      } finally {
        setBusy(false);
      }
    };

    return (
      <div style={panel}>
        <div style={batchThumbGrid}>
          {selectedItems.slice(0, 4).map((it) => (
            <div key={it.id} style={batchThumbCell}>
              <img
                src={`${convertFileSrc(it.thumbPath)}?v=${it.updatedAt}`}
                alt=""
                style={previewImg}
                loading="lazy"
              />
              {it.mediaType === "video" && (
                <div style={playBadge} aria-hidden>
                  <svg width="10" height="10" viewBox="0 0 20 20" fill="#fff">
                    <path d="M6 4.5v11l9-5.5-9-5.5Z" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={metaSection}>
          <div style={{ ...titleRow, borderBottom: "none", cursor: "default" }}>
            {t("history.selectedCount", { count: selectedIds.length })}
          </div>

          <Row label={t("history.batchActions")} value={`${selectedIds.length}`} />
          {imageCount > 0 && <Row label={t("history.images")} value={String(imageCount)} />}
          {videoCount > 0 && <Row label={t("history.videos")} value={String(videoCount)} />}
          <Row label={t("history.totalSelectedSize")} value={fmtSize(totalSize)} />
          {isTrash && <Row label={t("history.status")} value={t("history.inTrash")} />}
        </div>

        <div style={actions}>
          {!isTrash ? (
            <button style={dangerBtn} disabled={busy} onClick={doBatchDelete}>
              {t("history.deleteSelected", { count: selectedIds.length })}
            </button>
          ) : (
            <>
              <button style={primaryBtn} disabled={busy} onClick={doBatchRestore}>
                {t("history.restoreSelected", { count: selectedIds.length })}
              </button>
              <button style={dangerBtn} disabled={busy} onClick={doBatchPermanentDelete}>
                {t("history.permanentDeleteSelected", { count: selectedIds.length })}
              </button>
            </>
          )}
          <button style={secondaryBtn} disabled={busy} onClick={selectAll}>
            {t("history.selectAll")}
          </button>
          <button style={secondaryBtn} disabled={busy} onClick={clearSelection}>
            {t("history.deselectAll")}
          </button>
        </div>
      </div>
    );
  }

  if (!item) {
    return <div style={{ ...panel, alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>{t("history.selectItem")}</div>;
  }

  const isTrashed = item.deletedAt != null;
  const isVideo = item.mediaType === "video";

  const doRename = async () => {
    setBusy(true);
    try {
      await ipc.renameHistoryItem(item.id, titleDraft);
      patchItem(item.id, { title: titleDraft || null });
      setRenaming(false);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await ipc.deleteHistoryItem(item.id);
      if (!filter.trashOnly) removeItem(item.id);
      else patchItem(item.id, { deletedAt: Date.now() });
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async () => {
    setBusy(true);
    try {
      await ipc.restoreHistoryItem(item.id);
      if (filter.trashOnly) removeItem(item.id);
      else patchItem(item.id, { deletedAt: null });
    } finally {
      setBusy(false);
    }
  };

  const doPermanentDelete = async () => {
    if (!confirm(t("history.permanentDeleteConfirm"))) return;
    setBusy(true);
    try {
      await ipc.permanentlyDeleteHistoryItem(item.id);
      removeItem(item.id);
    } finally {
      setBusy(false);
    }
  };

  const doReveal = () => ipc.revealHistoryItem(item.id).catch(() => {});

  return (
    <div style={panel}>
      <div style={previewWrap}>
        {isVideo ? (
          // key gồm cả `updatedAt`: buộc React tạo lại <video> khi đổi item
          // chọn LẪN khi asset bị ghi đè tại chỗ (cắt video — path không đổi,
          // xem `?v=` bust cache bên dưới) — tránh giữ nguyên vị trí phát
          // hoặc nội dung cache cũ.
          <video
            key={`${item.id}-${item.updatedAt}`}
            src={`${convertFileSrc(item.assetPath)}?v=${item.updatedAt}`}
            style={previewImg}
            controls
          />
        ) : previewUrl ? (
          // Object URL mới mỗi lần đổi item/`updatedAt` nên KHÔNG cần `?v=`
          // bust cache như trước (asset ghi đè tại chỗ từng khiến webview hiện
          // bản cũ trong cache).
          <img src={previewUrl} alt="" style={previewImg} />
        ) : (
          <div style={{ ...previewImg, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
            …
          </div>
        )}
      </div>

      <div style={metaSection}>
        {renaming ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doRename()}
              style={{ flex: 1 }}
            />
            <button onClick={doRename} disabled={busy}>{t("history.save")}</button>
            <button onClick={() => setRenaming(false)}>{t("history.cancel")}</button>
          </div>
        ) : (
          <div style={titleRow} onClick={() => setRenaming(true)} title={t("history.renameTooltip")}>
            {item.title || t("history.unnamed")}
          </div>
        )}

        <Row label={t("history.capturedAt")} value={fmtDateTime(item.createdAt)} />
        <Row label={t("history.imageSize")} value={`${item.width} × ${item.height}px${item.scaleFactor > 1 ? ` (${item.scaleFactor}×)` : ""}`} />
        {isVideo && item.durationMs != null && <Row label={t("history.duration")} value={fmtDuration(item.durationMs)} />}
        <Row label={t("history.fileSize")} value={fmtSize(item.fileSize)} />
        <Row label={t("history.captureType")} value={MODE_LABEL[item.captureMode] ?? item.captureMode} />
        {item.isEdited && <Row label={t("history.status")} value={t("history.edited")} />}
        {isTrashed && <Row label={t("history.status")} value={t("history.inTrash")} />}
      </div>

      <div style={actions}>
        {!isTrashed ? (
          <>
            <button style={primaryBtn} disabled={busy} onClick={() => onOpenEditor(item.id)}>{t("history.openEditor")}</button>
            <button style={secondaryBtn} disabled={busy} onClick={doReveal}>{t("history.showInFinder")}</button>
            <button style={dangerBtn} disabled={busy} onClick={doDelete}>{t("history.moveToTrash")}</button>
          </>
        ) : (
          <>
            <button style={primaryBtn} disabled={busy} onClick={doRestore}>{t("history.restore")}</button>
            <button style={dangerBtn} disabled={busy} onClick={doPermanentDelete}>{t("history.permanentDelete")}</button>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={rowStyle}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const panel: React.CSSProperties = {
  width: 320,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderLeft: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  padding: 14,
  gap: 12,
  overflowY: "auto",
};

const previewWrap: React.CSSProperties = {
  width: "100%",
  aspectRatio: "4 / 3",
  background: "#000",
  borderRadius: 8,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const previewImg: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain" };

const metaSection: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 12 };

const titleRow: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  padding: "4px 0",
  borderBottom: "1px dashed var(--border)",
};

const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8 };

const actions: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, marginTop: "auto" };

const primaryBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 7,
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontSize: 13,
  fontWeight: 600,
};

const secondaryBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 13,
};

const dangerBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 7,
  border: "1px solid rgba(239,68,68,0.4)",
  background: "rgba(239,68,68,0.15)",
  color: "#fca5a5",
  fontSize: 13,
};

const batchThumbGrid: React.CSSProperties = {
  width: "100%",
  aspectRatio: "4 / 3",
  background: "#111",
  borderRadius: 8,
  overflow: "hidden",
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gridTemplateRows: "1fr 1fr",
  gap: 2,
  padding: 2,
};

const batchThumbCell: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  borderRadius: 4,
  background: "#000",
};

const playBadge: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 18,
  height: 18,
  borderRadius: "50%",
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

