import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc, type WindowInfo } from "../../lib/ipc";

const params = new URLSearchParams(window.location.search);
const MODE = params.get("mode") ?? "region";
const MY_IDX = Number(params.get("idx") ?? "0");

type Vec2 = [number, number];

/**
 * Nhận input do Rust phát (không cần focus cửa sổ):
 * - onInput(active, x, y): con trỏ có đang trên overlay này không + toạ độ CSS.
 * - onPress(x, y) / onRelease(x, y): nhấn/thả chuột trái trên overlay này.
 */
function useInput(
  onInput: (active: boolean, x: number, y: number) => void,
  onPress: (x: number, y: number) => void,
  onRelease: (x: number, y: number) => void,
) {
  const i = useRef(onInput);
  const p = useRef(onPress);
  const r = useRef(onRelease);
  i.current = onInput;
  p.current = onPress;
  r.current = onRelease;

  useEffect(() => {
    const subs = [
      listen<[number, number, number]>("overlay-input", (e) => {
        const [idx, x, y] = e.payload;
        i.current(idx === MY_IDX, x, y);
      }),
      listen<[number, number, number]>("overlay-press", (e) => {
        const [idx, x, y] = e.payload;
        if (idx === MY_IDX) p.current(x, y);
      }),
      listen<[number, number, number]>("overlay-release", (e) => {
        const [idx, x, y] = e.payload;
        if (idx === MY_IDX) r.current(x, y);
      }),
    ];
    return () => {
      subs.forEach((s) => s.then((f) => f()));
    };
  }, []);
}

export default function Overlay() {
  if (MODE === "window") return <WindowPicker />;
  if (MODE === "monitor") return <MonitorPick />;
  return <RegionSelect />;
}

/* ───────────── Region: kéo vùng chọn (live, đa màn hình) ───────────── */

interface Sel {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectFrom(sx: number, sy: number, x: number, y: number): Sel {
  return { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
}

function RegionSelect() {
  const startRef = useRef<Vec2 | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);

  useInput(
    (active, x, y) => {
      if (!active || !startRef.current) return;
      setSel(rectFrom(startRef.current[0], startRef.current[1], x, y));
    },
    (x, y) => {
      startRef.current = [x, y];
      setSel({ x, y, w: 0, h: 0 });
    },
    (x, y) => {
      const s = startRef.current;
      startRef.current = null;
      setSel(null);
      if (!s) return;
      const r = rectFrom(s[0], s[1], x, y);
      if (r.w >= 3 && r.h >= 3) ipc.finalizeRegion(r.x, r.y, r.w, r.h);
    },
  );

  return (
    <div style={{ ...root, cursor: "crosshair" }}>
      {sel && sel.w > 0 ? (
        <div
          style={{
            position: "fixed",
            left: sel.x,
            top: sel.y,
            width: sel.w,
            height: sel.h,
            border: "2px solid #3b82f6",
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
          }}
        >
          <span style={sizeLabel}>
            {Math.round(sel.w)} × {Math.round(sel.h)}
          </span>
        </div>
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.2)" }}>
          <div style={banner}>Kéo để chọn vùng • Esc / chuột phải để huỷ</div>
        </div>
      )}
    </div>
  );
}

/* ───────────── Window: chọn cửa sổ (đa màn hình) ───────────── */

function WindowPicker() {
  const winsRef = useRef<WindowInfo[]>([]);
  const [hover, setHover] = useState<WindowInfo | null>(null);

  useEffect(() => {
    ipc.listWindows().then((w) => {
      winsRef.current = w;
    });
  }, []);

  // Front-to-back → cửa sổ ĐẦU TIÊN chứa con trỏ là trên cùng.
  const pick = (x: number, y: number) =>
    winsRef.current.find((w) => x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) ??
    null;

  useInput(
    (active, x, y) => setHover(active ? pick(x, y) : null),
    (x, y) => {
      const w = pick(x, y);
      if (w) ipc.finalizeWindow(w.id);
    },
    () => {},
  );

  return (
    <div style={{ ...root, background: "rgba(0,0,0,0.28)", cursor: CAMERA_CURSOR }}>
      {hover && (
        <div
          style={{
            position: "fixed",
            left: hover.x,
            top: hover.y,
            width: hover.width,
            height: hover.height,
            border: "3px solid #3b82f6",
            background: "rgba(59,130,246,0.15)",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        >
          <span style={{ ...sizeLabel, top: 6, left: 6 }}>{hover.app || hover.title || "Cửa sổ"}</span>
        </div>
      )}
      <div style={banner}>Di chuột tới cửa sổ rồi click để chụp • Esc / chuột phải để huỷ</div>
    </div>
  );
}

/* ───────────── Monitor: chọn cả màn hình (chế độ full) ───────────── */

function MonitorPick() {
  const [active, setActive] = useState(false);

  useInput(
    (a) => setActive(a),
    () => ipc.finalizeMonitor(),
    () => {},
  );

  return (
    <div
      style={{
        ...root,
        cursor: CAMERA_CURSOR,
        background: active ? "rgba(59,130,246,0.12)" : "rgba(0,0,0,0.28)",
        border: active ? "5px solid #3b82f6" : "5px solid transparent",
        boxSizing: "border-box",
      }}
    >
      <div style={banner}>Click để chụp toàn bộ màn hình này • Esc / chuột phải để huỷ</div>
    </div>
  );
}

/* ───────────── styles ───────────── */

// Con trỏ hình máy ảnh (giống macOS). SVG trắng-viền-đen; hotspot giữa (16,16).
const CAMERA_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>
<rect x='3' y='9' width='26' height='18' rx='3' fill='#fff' stroke='#000' stroke-width='1.5'/>
<rect x='11' y='5.5' width='10' height='5' rx='1.5' fill='#fff' stroke='#000' stroke-width='1.5'/>
<circle cx='16' cy='18' r='6' fill='#fff' stroke='#000' stroke-width='1.5'/>
<circle cx='16' cy='18' r='3' fill='#000'/>
</svg>`;
const CAMERA_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(CAMERA_SVG)}") 16 16, crosshair`;

const root: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  overflow: "hidden",
  background: "transparent",
};
const sizeLabel: React.CSSProperties = {
  position: "absolute",
  top: -24,
  left: 0,
  background: "#3b82f6",
  color: "#fff",
  fontSize: 12,
  padding: "2px 6px",
  borderRadius: 4,
  whiteSpace: "nowrap",
  maxWidth: 320,
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const banner: React.CSSProperties = {
  position: "fixed",
  top: 20,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(20,20,24,0.92)",
  color: "#fff",
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 13,
  pointerEvents: "none",
};
