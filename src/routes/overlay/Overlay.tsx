import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc, type WindowInfo } from "../../lib/ipc";
import AnnotationStage, { type StageHandle } from "../../features/annotation/canvas/AnnotationStage";
import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, type Tool } from "../../features/annotation/model";
import QuickToolbar, { quickToolbarLayout } from "../quick-capture/QuickToolbar";

const params = new URLSearchParams(window.location.search);
const MODE = params.get("mode") ?? "region";
const MY_IDX = Number(params.get("idx") ?? "0");
const SCALE = Number(params.get("scale") ?? "1") || 1;

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
  if (MODE === "quick") return <QuickAnnotate />;
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
    <div style={{ ...root, cursor: CROSSHAIR_CURSOR }}>
      {sel && sel.w > 0 ? (
        <div
          style={{
            position: "fixed",
            left: sel.x,
            top: sel.y,
            width: sel.w,
            height: sel.h,
            border: "2px solid #3b82f6",
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)",
          }}
        >
          <span style={sizeLabel}>
            {Math.round(sel.w)} × {Math.round(sel.h)}
          </span>
        </div>
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)" }}>
          <div style={banner}>Kéo để chọn vùng • Esc / chuột phải để huỷ</div>
        </div>
      )}
    </div>
  );
}

/* ───────────── Quick: Chụp nhanh (chọn vùng + chú thích tại chỗ) ───────────── */

const MIN_SEL = 12;
const STAGE_PAD = 8;
type QuickPhase = "selecting" | "adjusting" | "annotating";

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function transparentPng(w: number, h: number): string {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c.toDataURL("image/png");
}
function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

function QuickAnnotate() {
  const loadDoc = useEditor((s) => s.loadDoc);
  const setTool = useEditor((s) => s.setTool);
  const annCount = useEditor((s) => s.doc?.annotations.length ?? 0);
  const stageRef = useRef<StageHandle>(null);

  const [phase, setPhase] = useState<QuickPhase>("selecting");
  const [sel, setSel] = useState<Sel | null>(null);
  const [busy, setBusy] = useState(false);
  const startRef = useRef<Vec2 | null>(null);

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const prevSelRef = useRef<Sel | null>(null);
  const prevPhaseRef = useRef<QuickPhase>("selecting");

  // Cú bấm chuột native gần nhất rơi vào ĐÂU: nền trống (root) hay một phần UI
  // (khung / handle / toolbar / canvas)? Global input loop phát `overlay-press`
  // cho MỌI cú bấm — kể cả khi bấm vào nút toolbar (nằm ngoài khung) — nên chỉ
  // dựa vào toạ độ sẽ hiểu nhầm mọi thao tác thành "chọn lại". Vì thế ta xác
  // định qua target của native pointerdown (capture-phase, luôn chạy trước).
  const rootRef = useRef<HTMLDivElement>(null);
  const pressInfoRef = useRef<{ onBackdrop: boolean; t: number } | null>(null);
  const onDownCapture = (e: React.PointerEvent) => {
    pressInfoRef.current = { onBackdrop: e.target === rootRef.current, t: performance.now() };
  };

  // ── Chọn vùng qua global input loop — CHẠY SUỐT PHIÊN trên MỌI màn hình,
  // dùng cho cả chọn lần đầu lẫn chọn lại (kể cả sang màn hình khác). ──
  useInput(
    (active, x, y) => {
      if (!active || !startRef.current) return;
      setSel(rectFrom(startRef.current[0], startRef.current[1], x, y));
    },
    (x, y) => {
      // Đang có khung: CHỈ chọn lại khi bấm NGOÀI khung VÀ NGOÀI cả hai thanh
      // công cụ (phải + dưới). Kiểm tra theo HÌNH HỌC vùng (khớp đúng vùng
      // toolbar render). Popup chọn màu bung ra ngoài thanh → thêm guard target
      // native (bấm vào UI thì target khác root).
      if (sel && phase !== "selecting") {
        const inRect = (r: { x: number; y: number; w: number; h: number }, m = 0) =>
          x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
        const lay = quickToolbarLayout(sel, winW, winH);
        const onBox = inRect(sel, 14); // 14 = phủ luôn handle resize
        const onBar = inRect(lay.vRect, 4) || inRect(lay.hRect, 4);
        const info = pressInfoRef.current;
        const onUI = !!info && performance.now() - info.t < 600 && !info.onBackdrop;
        if (onBox || onBar || onUI) return; // không khởi tạo chọn lại
      }
      prevSelRef.current = sel;
      prevPhaseRef.current = phase;
      startRef.current = [x, y];
      setSel({ x, y, w: 0, h: 0 });
      setPhase("selecting");
    },
    (x, y) => {
      const s = startRef.current;
      startRef.current = null;
      if (!s) return; // không phải đang kéo chọn (vd: đang vẽ/di chuyển native)
      const r = rectFrom(s[0], s[1], x, y);
      if (r.w >= MIN_SEL && r.h >= MIN_SEL) {
        setSel(r);
        setPhase("adjusting");
        // khung mới → xoá chú thích cũ (annCount về 0 → hiện lại handle resize)
        loadDoc({ image: transparentPng(1, 1), imgW: 1, imgH: 1, scaleFactor: SCALE, annotations: [] });
      } else {
        // kéo quá nhỏ → khôi phục khung + pha trước (nếu có), tránh mất chú thích
        setSel(prevSelRef.current);
        setPhase(prevSelRef.current ? (prevPhaseRef.current === "selecting" ? "adjusting" : prevPhaseRef.current) : "selecting");
      }
    },
  );

  // Màn hình KHÁC vừa được bấm → xoá khung ở màn này (chỉ một khung active).
  useEffect(() => {
    const un = listen<[number, number, number]>("overlay-press", (e) => {
      if (e.payload[0] !== MY_IDX) {
        startRef.current = null;
        setSel(null);
        setPhase("selecting");
      }
    });
    return () => { un.then((f) => f()); };
  }, []);

  // ── Pha "adjusting": di chuyển / resize khung bằng sự kiện native ──
  const moveRef = useRef<{ mx: number; my: number; start: Sel } | null>(null);
  const onMoveDown = (e: React.PointerEvent) => {
    if (phase !== "adjusting" || !sel) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    moveRef.current = { mx: e.clientX, my: e.clientY, start: sel };
  };
  const resizeRef = useRef<{ id: string; mx: number; my: number; start: Sel } | null>(null);
  const onResizeDown = (id: string) => (e: React.PointerEvent) => {
    if (!sel) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeRef.current = { id, mx: e.clientX, my: e.clientY, start: sel };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const m = moveRef.current;
    if (m) {
      const dx = e.clientX - m.mx;
      const dy = e.clientY - m.my;
      setSel({
        x: clampN(m.start.x + dx, 0, winW - m.start.w),
        y: clampN(m.start.y + dy, 0, winH - m.start.h),
        w: m.start.w,
        h: m.start.h,
      });
      return;
    }
    const r = resizeRef.current;
    if (r) {
      const dx = e.clientX - r.mx;
      const dy = e.clientY - r.my;
      let { x, y, w, h } = r.start;
      if (r.id.includes("w")) { const nx = clampN(x + dx, 0, x + w - MIN_SEL); w += x - nx; x = nx; }
      if (r.id.includes("e")) { w = clampN(w + dx, MIN_SEL, winW - x); }
      if (r.id.includes("n")) { const ny = clampN(y + dy, 0, y + h - MIN_SEL); h += y - ny; y = ny; }
      if (r.id.includes("s")) { h = clampN(h + dy, MIN_SEL, winH - y); }
      setSel({ x, y, w, h });
    }
  };
  const onPointerUp = () => {
    moveRef.current = null;
    resizeRef.current = null;
  };

  // ── Commit: nạp canvas trong suốt kích thước khung để bắt đầu chú thích ──
  const loadTransparent = useCallback((r: Sel) => {
    const pw = Math.max(1, Math.round(r.w * SCALE));
    const ph = Math.max(1, Math.round(r.h * SCALE));
    loadDoc({ image: transparentPng(pw, ph), imgW: pw, imgH: ph, scaleFactor: SCALE, annotations: [] });
  }, [loadDoc]);

  const pickTool = useCallback((t: Tool) => {
    if (phase === "annotating") { setTool(t); return; }
    if (!sel) return;
    loadTransparent(sel);
    setPhase("annotating");
    setTool(t);
  }, [phase, sel, setTool, loadTransparent]);

  // ── Xuất ảnh: chụp đúng vùng (ẩn overlay) rồi ghép lớp chú thích ──
  const doExport = useCallback(async (): Promise<{ url: string; w: number; h: number } | null> => {
    if (!sel) return null;
    const layer = phase === "annotating" ? (stageRef.current?.exportPng() ?? null) : null;
    const b64 = await ipc.captureQuickRegion(sel.x, sel.y, sel.w, sel.h);
    const base = await loadImg(`data:image/png;base64,${b64}`);
    const c = document.createElement("canvas");
    c.width = base.naturalWidth;
    c.height = base.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(base, 0, 0);
    if (layer) {
      const l = await loadImg(layer);
      g.drawImage(l, 0, 0, c.width, c.height);
    }
    return { url: c.toDataURL("image/png"), w: c.width, h: c.height };
  }, [sel, phase]);

  const doCopy = async () => {
    setBusy(true);
    try { const r = await doExport(); if (r) await ipc.finishQuickCapture(r.url, r.w, r.h, "clipboard"); }
    finally { ipc.cancelOverlay(); }
  };
  const doSave = async () => {
    setBusy(true);
    try { const r = await doExport(); if (r) await ipc.finishQuickCapture(r.url, r.w, r.h, "save"); }
    finally { ipc.cancelOverlay(); }
  };
  const doOpenEditor = async () => {
    setBusy(true);
    try { const r = await doExport(); if (r) { await ipc.setPendingImage(r.url, r.w, r.h); await ipc.openEditor(); } }
    finally { ipc.cancelOverlay(); }
  };
  // Đóng TẤT CẢ overlay (mọi màn hình) — không chỉ overlay hiện tại.
  const doClose = () => ipc.cancelOverlay();

  // ── Phím tắt (native) — loop đã dừng sau khi vào pha adjusting ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const s = useEditor.getState();
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable || s.editingTextId) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") { e.preventDefault(); doClose(); return; }
      if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); doCopy(); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); doSave(); return; }
      if (phase !== "annotating") return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); s.undo(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) { e.preventDefault(); s.removeSelected(); return; }
      if (!mod) {
        const cmap: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5 };
        if (e.key in cmap) { const c = PRESET_COLORS[cmap[e.key]]; if (c) s.setColor(c); return; }
        const tmap: Record<string, Tool> = { r: "rect", n: "step", t: "text", a: e.shiftKey ? "numbered-arrow" : "arrow", h: "highlight" };
        const t = tmap[e.key.toLowerCase()];
        if (t) s.setTool(t);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sel]);

  return (
    <div
      ref={rootRef}
      style={{ ...root, cursor: phase === "selecting" ? CROSSHAIR_CURSOR : "default" }}
      onPointerDownCapture={onDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => { e.preventDefault(); doClose(); }}
    >
      {sel ? (
        <div
          style={{
            position: "fixed", left: sel.x, top: sel.y, width: sel.w, height: sel.h,
            outline: "2px solid #3b82f6",
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
            cursor: phase === "adjusting" ? "move" : "default",
          }}
          onPointerDown={onMoveDown}
        >
          {phase === "selecting" && sel.w > 0 && (
            <span style={sizeLabel}>{Math.round(sel.w)} × {Math.round(sel.h)}</span>
          )}
          {/* Resize handles — chỉ khi đang chỉnh khung & chưa vẽ gì */}
          {phase === "adjusting" && annCount === 0 && QUICK_HANDLES.map((hd) => (
            <div key={hd.id} onPointerDown={onResizeDown(hd.id)} style={quickHandleStyle(hd)} />
          ))}
        </div>
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)" }}>
          <div style={banner}>Kéo để chọn vùng • Esc / chuột phải để huỷ</div>
        </div>
      )}

      {/* Canvas chú thích phủ đúng khung (trong suốt → thấy màn hình thật) */}
      {phase === "annotating" && sel && (
        <div
          style={{ position: "fixed", left: sel.x - STAGE_PAD, top: sel.y - STAGE_PAD, width: sel.w + STAGE_PAD * 2, height: sel.h + STAGE_PAD * 2 }}
        >
          <AnnotationStage ref={stageRef} hideZoomBar />
        </div>
      )}

      {sel && phase !== "selecting" && (
        <QuickToolbar
          sel={sel}
          winW={winW}
          winH={winH}
          annotating={phase === "annotating"}
          busy={busy}
          onPickTool={pickTool}
          onCopy={doCopy}
          onSave={doSave}
          onOpenEditor={doOpenEditor}
          onClose={doClose}
        />
      )}
    </div>
  );
}

const QUICK_HANDLES = [
  { id: "nw", cx: 0, cy: 0, cur: "nwse-resize" },
  { id: "n", cx: 0.5, cy: 0, cur: "ns-resize" },
  { id: "ne", cx: 1, cy: 0, cur: "nesw-resize" },
  { id: "e", cx: 1, cy: 0.5, cur: "ew-resize" },
  { id: "se", cx: 1, cy: 1, cur: "nwse-resize" },
  { id: "s", cx: 0.5, cy: 1, cur: "ns-resize" },
  { id: "sw", cx: 0, cy: 1, cur: "nesw-resize" },
  { id: "w", cx: 0, cy: 0.5, cur: "ew-resize" },
];
function quickHandleStyle(hd: { cx: number; cy: number; cur: string }): React.CSSProperties {
  const S = 10;
  return {
    position: "absolute",
    left: `calc(${hd.cx * 100}% - ${S / 2}px)`,
    top: `calc(${hd.cy * 100}% - ${S / 2}px)`,
    width: S, height: S, background: "#fff", border: "1.5px solid #3b82f6", borderRadius: 2,
    cursor: hd.cur,
  };
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
      if (w) ipc.finalizeWindow(w.id).catch((e) => alert(String(e)));
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

// Con trỏ chữ thập cho chế độ vẽ vùng. Trắng lõi + viền đen → rõ trên mọi nền;
// chừa khoảng hở giữa + chấm tâm để ngắm chính xác. Hotspot ở tâm (16,16).
const CROSSHAIR_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>
<g stroke='#000' stroke-width='4' stroke-linecap='round'>
<line x1='16' y1='2' x2='16' y2='12'/><line x1='16' y1='20' x2='16' y2='30'/>
<line x1='2' y1='16' x2='12' y2='16'/><line x1='20' y1='16' x2='30' y2='16'/></g>
<g stroke='#fff' stroke-width='2' stroke-linecap='round'>
<line x1='16' y1='2' x2='16' y2='12'/><line x1='16' y1='20' x2='16' y2='30'/>
<line x1='2' y1='16' x2='12' y2='16'/><line x1='20' y1='16' x2='30' y2='16'/></g>
<circle cx='16' cy='16' r='2.5' fill='#fff' stroke='#000' stroke-width='1.5'/>
</svg>`;
const CROSSHAIR_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(CROSSHAIR_SVG)}") 16 16, crosshair`;

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
