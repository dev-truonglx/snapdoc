import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { HistoryItem } from "../../lib/ipc";
import { MODE_LABEL } from "./HistoryItemCard";
import { fmtDateTime, fmtSize, fmtDuration } from "./formatUtils";

interface Props {
  item: HistoryItem;
  selected: boolean;
  onSelect: () => void;
  onOpenEditor: () => void;
}

/** 1 hàng trong list view — cùng dữ liệu với `HistoryItemCard` (grid) nhưng
 * bày ngang: thumbnail nhỏ + loại chụp + thời gian + dung lượng + kích thước. */
export default function HistoryListRow({ item, selected, onSelect, onOpenEditor }: Props) {
  const [broken, setBroken] = useState(false);
  const isVideo = item.mediaType === "video";

  return (
    <div
      style={{ ...row, background: selected ? "var(--accent)" : "transparent" }}
      onClick={onSelect}
      onDoubleClick={isVideo ? undefined : onOpenEditor}
      title={item.title ?? undefined}
    >
      <div style={thumbWrap}>
        {!broken ? (
          <img
            src={`${convertFileSrc(item.thumbPath)}?v=${item.updatedAt}`}
            alt=""
            style={thumbImg}
            onError={() => setBroken(true)}
            loading="lazy"
          />
        ) : (
          <div style={brokenBox} />
        )}
        {isVideo && (
          <div style={playBadge} aria-hidden>
            <svg width="10" height="10" viewBox="0 0 20 20" fill="#fff">
              <path d="M6 4.5v11l9-5.5-9-5.5Z" />
            </svg>
          </div>
        )}
      </div>

      <span style={{ ...cell, flex: "1 1 auto", minWidth: 0, color: selected ? "var(--accent-text)" : "var(--text)" }}>
        <span style={titleText}>{item.title || "(Không tên)"}</span>
      </span>
      <span style={{ ...cell, width: 100, color: selected ? "var(--accent-text)" : "var(--text-dim)" }}>
        {MODE_LABEL[item.captureMode] ?? item.captureMode}
      </span>
      <span style={{ ...cell, width: 130, color: selected ? "var(--accent-text)" : "var(--text-dim)" }}>
        {fmtDateTime(item.createdAt)}
      </span>
      <span style={{ ...cell, width: 70, color: selected ? "var(--accent-text)" : "var(--text-dim)" }}>
        {fmtSize(item.fileSize)}
      </span>
      <span style={{ ...cell, width: 100, color: selected ? "var(--accent-text)" : "var(--text-dim)" }}>
        {item.width} × {item.height}
      </span>
      <span style={{ ...cell, width: 56, color: selected ? "var(--accent-text)" : "var(--text-dim)" }}>
        {isVideo && item.durationMs != null ? fmtDuration(item.durationMs) : "—"}
      </span>
    </div>
  );
}

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: "100%",
  padding: "0 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

const thumbWrap: React.CSSProperties = {
  position: "relative",
  width: 64,
  height: 48,
  flexShrink: 0,
  borderRadius: 4,
  overflow: "hidden",
  background: "#000",
};

const thumbImg: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

const brokenBox: React.CSSProperties = { width: "100%", height: "100%" };

const playBadge: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

const cell: React.CSSProperties = { flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

const titleText: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" };
