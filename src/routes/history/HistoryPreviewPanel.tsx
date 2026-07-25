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
  const filter = useHistory((s) => s.filter);
  const patchItem = useHistory((s) => s.patchItem);
  const removeItem = useHistory((s) => s.removeItem);

  const item = items.find((it) => it.id === selectedId) ?? null;
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRenaming(false);
    setTitleDraft(item?.title ?? "");
  }, [item?.id]);

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
        ) : (
          // `?v=` bust cache như HistoryItemCard: sửa ảnh từ Editor ghi đè
          // TẠI CHỖ cùng asset_path — thiếu query này preview hiện bản cũ
          // trong cache của webview.
          <img src={`${convertFileSrc(item.assetPath)}?v=${item.updatedAt}`} alt="" style={previewImg} />
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

