import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { HistoryItem } from "../../lib/ipc";
import { fmtTime, fmtDuration } from "./formatUtils";

export const MODE_LABEL: Record<string, string> = {
  region: "Vùng chọn",
  window: "Cửa sổ",
  full: "Toàn màn hình",
  all: "Mọi màn hình",
  scroll: "Cuộn dài",
  quick: "Nhanh",
};

interface Props {
  item: HistoryItem;
  selected: boolean;
  onSelect: () => void;
  onOpenEditor: () => void;
}

export default function HistoryItemCard({ item, selected, onSelect, onOpenEditor }: Props) {
  const [broken, setBroken] = useState(false);
  const isVideo = item.mediaType === "video";

  return (
    <div
      style={{ ...card, outline: selected ? "2px solid var(--accent)" : "2px solid transparent" }}
      onClick={onSelect}
      onDoubleClick={onOpenEditor}
      title={item.title ?? undefined}
    >
      <div style={thumbWrap}>
        {!broken ? (
          <img
            // `?v=updatedAt`: thumbPath không đổi khi cắt video (ghi đè tại
            // chỗ) — bust cache để hiện đúng thumbnail mới sau khi cắt.
            src={`${convertFileSrc(item.thumbPath)}?v=${item.updatedAt}`}
            alt=""
            style={thumbImg}
            onError={() => setBroken(true)}
            loading="lazy"
          />
        ) : (
          <div style={brokenBox}>Không tải được ảnh</div>
        )}
        {isVideo && (
          <>
            <div style={playBadge} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="#fff">
                <path d="M6 4.5v11l9-5.5-9-5.5Z" />
              </svg>
            </div>
            {item.durationMs != null && (
              <span style={{ ...badge, top: "auto", bottom: 4 }}>{fmtDuration(item.durationMs)}</span>
            )}
          </>
        )}
        {item.scaleFactor > 1 && <span style={badge}>{item.scaleFactor}×</span>}
        {item.isEdited && <span style={{ ...badge, left: 4, right: "auto" }}>✎</span>}
      </div>
      <div style={meta}>
        <span style={metaMode}>{MODE_LABEL[item.captureMode] ?? item.captureMode}</span>
        <span style={metaTime}>{fmtTime(item.createdAt)}</span>
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  borderRadius: 8,
  overflow: "hidden",
  cursor: "pointer",
  background: "var(--bg-elevated)",
};

const thumbWrap: React.CSSProperties = {
  position: "relative",
  width: "100%",
  aspectRatio: "4 / 3",
  background: "#000",
};

const thumbImg: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const brokenBox: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  color: "var(--text-dim)",
  textAlign: "center",
  padding: 8,
};

const badge: React.CSSProperties = {
  position: "absolute",
  top: 4,
  right: 4,
  background: "rgba(0,0,0,0.65)",
  color: "#fff",
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
};

const playBadge: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 30,
  height: 30,
  borderRadius: "50%",
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

const meta: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "5px 7px",
  fontSize: 11,
  color: "var(--text-dim)",
};

const metaMode: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const metaTime: React.CSSProperties = { flexShrink: 0, marginLeft: 6 };
