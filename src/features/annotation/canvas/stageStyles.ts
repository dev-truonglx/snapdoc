/** Style inline của thanh zoom / badge trong `AnnotationStage`. */
import type React from "react";

export const fill: React.CSSProperties = { width: "100%", height: "100%" };

export const zoomBar: React.CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: 12,
  display: "flex",
  alignItems: "center",
  gap: 2,
  background: "rgba(18,18,22,0.90)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 10,
  padding: "3px 5px",
  backdropFilter: "blur(10px)",
  boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
  zIndex: 10,
};

/** Chip có label: Fit / 100% */
export const zoomChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 26,
  padding: "0 8px",
  borderRadius: 6,
  background: "transparent",
  color: "rgba(242,242,245,0.75)",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.12s, color 0.12s",
};

export const zoomChipActive: React.CSSProperties = {
  background: "rgba(59,130,246,0.22)",
  color: "#7eb8ff",
};

/** Nút icon tròn: zoom in / zoom out */
export const zoomIconBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  background: "transparent",
  color: "rgba(242,242,245,0.75)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
};

/** Ô hiển thị % zoom — nhấn để toggle Fit / 100% */
export const zoomPctBtn: React.CSSProperties = {
  height: 26,
  minWidth: 46,
  padding: "0 6px",
  borderRadius: 6,
  background: "transparent",
  color: "rgba(242,242,245,0.9)",
  fontSize: 12,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  cursor: "pointer",
  textAlign: "center",
};

export const zoomBtnDisabled: React.CSSProperties = {
  opacity: 0.3,
  cursor: "not-allowed",
};

export function cropBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? "#3b82f6" : "#2a2a30",
    color: "#fff",
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 13,
    whiteSpace: "nowrap",
    flexShrink: 0,
  };
}

/** Badge HiDPI — hiện khi ảnh là Retina 2× trở lên */
export const dpiBadge: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 18,
  padding: "0 6px",
  borderRadius: 4,
  background: "rgba(59,130,246,0.18)",
  color: "#7eb8ff",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.04em",
  cursor: "default",
};
