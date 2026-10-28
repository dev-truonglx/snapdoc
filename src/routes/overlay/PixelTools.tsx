/** Công cụ pixel trên overlay chụp vùng: kính lúp + mã màu (phím C để copy)
 * và thước đo pixel (phím M bật/tắt). Thuần hiển thị — input do `RegionSelect`
 * nhận từ Rust (`overlay-input`/`overlay-key`) rồi truyền vào. */
import type React from "react";
import { useTranslation } from "react-i18next";

type Vec2 = [number, number];

const LOUPE = 120; // CSS px
const ZOOM = 10; // 1 pixel ảnh = ZOOM CSS px
const GAP = 22;

/** Kính lúp bám theo con trỏ, phóng to đúng pixel thật của ảnh đóng băng
 * (`scale` = số pixel vật lý / 1 CSS px), kèm mã màu và toạ độ pixel. */
export function PixelLoupe({ pos, frozenUrl, scale, hex, copied }: {
  pos: Vec2;
  frozenUrl: string;
  scale: number;
  hex: string | null;
  copied: string | null;
}) {
  const { t } = useTranslation();
  const [x, y] = pos;
  const px = Math.floor(x * scale);
  const py = Math.floor(y * scale);
  const bgW = window.innerWidth * scale * ZOOM;
  const bgH = window.innerHeight * scale * ZOOM;
  const offX = LOUPE / 2 - (px * ZOOM + ZOOM / 2);
  const offY = LOUPE / 2 - (py * ZOOM + ZOOM / 2);

  const boxH = LOUPE + 48;
  const left = x + GAP + LOUPE > window.innerWidth ? x - GAP - LOUPE : x + GAP;
  const top = y + GAP + boxH > window.innerHeight ? y - GAP - boxH : y + GAP;

  return (
    <div style={{ ...loupeBox, left, top }}>
      <div
        style={{
          width: LOUPE,
          height: LOUPE,
          backgroundImage: `url("${frozenUrl}")`,
          backgroundSize: `${bgW}px ${bgH}px`,
          backgroundPosition: `${offX}px ${offY}px`,
          backgroundRepeat: "no-repeat",
          imageRendering: "pixelated",
          position: "relative",
        }}
      >
        {/* Ô pixel đang trỏ */}
        <div
          style={{
            position: "absolute",
            left: LOUPE / 2 - ZOOM / 2,
            top: LOUPE / 2 - ZOOM / 2,
            width: ZOOM,
            height: ZOOM,
            boxSizing: "border-box",
            border: "1.5px solid #fff",
            outline: "1px solid rgba(0,0,0,0.7)",
          }}
        />
      </div>
      <div style={loupeInfo}>
        <span style={{ ...swatch, background: hex ?? "transparent" }} />
        <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontWeight: 600 }}>{hex ?? "…"}</span>
        <span style={{ marginLeft: "auto", opacity: 0.75 }}>
          {px}, {py}
        </span>
      </div>
      <div style={loupeHint}>{copied ? t("overlay.colorCopied", { hex: copied }) : t("overlay.pixelHint")}</div>
    </div>
  );
}

/** Thước đo: đoạn thẳng a→b, nhãn khoảng cách + Δx/Δy theo pixel vật lý. */
export function MeasureLine({ a, b, scale }: { a: Vec2; b: Vec2; scale: number }) {
  const dx = Math.round((b[0] - a[0]) * scale);
  const dy = Math.round((b[1] - a[1]) * scale);
  const len = Math.round(Math.hypot(dx, dy));
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const cssLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return (
    <>
      <div
        style={{
          position: "fixed",
          left: a[0],
          top: a[1],
          width: cssLen,
          height: 0,
          borderTop: "2px solid #22d3ee",
          transformOrigin: "0 0",
          transform: `rotate(${angle}rad)`,
          boxShadow: "0 0 0 0.5px rgba(0,0,0,0.6)",
          pointerEvents: "none",
        }}
      />
      {[a, b].map((p, i) => (
        <div key={i} style={{ ...measureDot, left: p[0] - 4, top: p[1] - 4 }} />
      ))}
      {len > 0 && (
        <div style={{ ...measureLabel, left: mid[0] + 10, top: mid[1] + 10 }}>
          <b>{len} px</b>
          <span style={{ opacity: 0.75 }}>
            {" "}
            · Δx {Math.abs(dx)} · Δy {Math.abs(dy)}
          </span>
        </div>
      )}
    </>
  );
}

const loupeBox: React.CSSProperties = {
  position: "fixed",
  width: LOUPE,
  borderRadius: 8,
  overflow: "hidden",
  background: "rgba(20,20,24,0.94)",
  boxShadow: "0 0 0 1px rgba(255,255,255,0.25), 0 6px 18px rgba(0,0,0,0.45)",
  color: "#fff",
  fontSize: 11,
  pointerEvents: "none",
  zIndex: 10,
};
const loupeInfo: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 7px 2px",
};
const loupeHint: React.CSSProperties = {
  padding: "0 7px 6px",
  fontSize: 10,
  opacity: 0.7,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const swatch: React.CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: 3,
  boxShadow: "0 0 0 1px rgba(255,255,255,0.5)",
  flexShrink: 0,
};
const measureDot: React.CSSProperties = {
  position: "fixed",
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#22d3ee",
  boxShadow: "0 0 0 1.5px #fff",
  pointerEvents: "none",
};
const measureLabel: React.CSSProperties = {
  position: "fixed",
  background: "rgba(20,20,24,0.92)",
  color: "#fff",
  fontSize: 12,
  padding: "3px 8px",
  borderRadius: 4,
  whiteSpace: "nowrap",
  pointerEvents: "none",
};
