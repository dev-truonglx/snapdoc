import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { HistoryItem } from "../../lib/ipc";
import { fmtTime, fmtDuration } from "./formatUtils";

export const MODE_LABEL: Record<string, string> = {
  region: "Region",
  window: "Window",
  full: "Full screen",
  all: "All screens",
  scroll: "Scrolling",
  quick: "Quick",
};

interface Props {
  item: HistoryItem;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onToggleCheck: (e: React.MouseEvent) => void;
  onOpenEditor: () => void;
}

export default function HistoryItemCard({ item, selected, onSelect, onToggleCheck, onOpenEditor }: Props) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const [hovered, setHovered] = useState(false);
  const isVideo = item.mediaType === "video";

  return (
    <div
      style={{
        ...card,
        background: hovered ? "var(--bg-hover)" : "var(--bg-elevated)",
        outline: selected
          ? "2px solid var(--accent)"
          : hovered
          ? "2px solid rgba(59, 130, 246, 0.7)"
          : "2px solid transparent",
        boxShadow: selected
          ? "0 0 0 1px var(--accent), 0 4px 14px rgba(0,0,0,0.3)"
          : hovered
          ? "0 4px 14px rgba(0,0,0,0.35)"
          : "none",
        transition: "outline 0.15s ease, background 0.15s ease, box-shadow 0.15s ease",
      }}
      onClick={onSelect}
      onDoubleClick={onOpenEditor}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={item.title ?? undefined}
    >
      <div style={thumbWrap}>
        {/* Checkbox chọn mục */}
        <div
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            width: 20,
            height: 20,
            borderRadius: 5,
            border: selected ? "1px solid var(--accent)" : "1.5px solid rgba(255,255,255,0.85)",
            background: selected ? "var(--accent)" : "rgba(0,0,0,0.45)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transition: "opacity 0.15s ease",
            opacity: selected || hovered ? 1 : 0,
            pointerEvents: selected || hovered ? "auto" : "none",
            zIndex: 3,
            boxShadow: "0 2px 5px rgba(0,0,0,0.4)",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(e);
          }}
          title={selected ? t("history.deselectAll") : t("history.selectAll")}
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 20 20" fill="#fff">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </div>

        {!broken ? (
          <img
            // `?v=updatedAt`: thumbPath không đổi khi cắt video (ghi đè tại
            // chỗ) — bust cache để hiện đúng thumbnail mới sau khi cắt.
            src={`${convertFileSrc(item.thumbPath)}?v=${item.updatedAt}`}
            alt=""
            style={{
              ...thumbImg,
              filter: hovered ? "brightness(1.05)" : "none",
              transition: "filter 0.15s ease",
            }}
            onError={() => setBroken(true)}
            loading="lazy"
          />
        ) : (
          <div style={brokenBox}>{t("historyItemCard.cannotLoadImage")}</div>
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
        {item.isEdited && <span style={{ ...badge, top: "auto", bottom: 4, left: 4, right: "auto" }}>✎</span>}
      </div>
      <div style={{ ...meta, color: hovered || selected ? "var(--text)" : "var(--text-dim)" }}>
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
