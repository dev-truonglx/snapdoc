import { useState } from "react";
import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, HIGHLIGHT_COLORS, type Tool } from "../../features/annotation/model";

const TOOLBAR_W = 44;
const GAP = 8;
const EST_V_H = 370; // ước lượng cao thanh dọc (9 nút × 34 + gap + padding)
const BOTTOM_H = 44;
const BOTTOM_W = 184; // ước lượng rộng thanh ngang (4 nút icon) để canh phải

interface Rect { x: number; y: number; w: number; h: number }

const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
  {
    id: "select", label: "Chọn / sửa",
    icon: <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M4 2l10 5.2-4.1 1.3 2.4 4.8-1.8.9-2.4-4.8L4 13z" fill="currentColor" /></svg>,
  },
  {
    id: "rect", label: "Vẽ khung",
    icon: <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><rect x="2.5" y="4" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>,
  },
  {
    id: "step", label: "Đánh số",
    icon: <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" /><text x="9" y="12.4" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">1</text></svg>,
  },
  {
    id: "text", label: "Viết chữ",
    icon: <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M3.5 4.5h11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><path d="M9 4.5v9.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>,
  },
  {
    id: "arrow", label: "Mũi tên",
    icon: <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><line x1="3" y1="15" x2="14" y2="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><polygon points="14,4 9,5.5 12.5,9" fill="currentColor" /></svg>,
  },
  {
    id: "numbered-arrow", label: "Mũi tên số",
    icon: <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><circle cx="4.5" cy="13.5" r="3.5" fill="currentColor" /><text x="4.5" y="16.2" textAnchor="middle" fontSize="5" fontWeight="700" fill="#fff">1</text><line x1="7.5" y1="11" x2="14.5" y2="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><polygon points="14.5,4 10,5.5 13,8.5" fill="currentColor" /></svg>,
  },
  {
    id: "highlight", label: "Highlight",
    icon: <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><rect x="6.5" y="2" width="5" height="9" rx="1.2" fill="currentColor" opacity="0.85" /><rect x="6.5" y="2" width="5" height="2.8" rx="1.2" fill="currentColor" /><polygon points="8,11 10,11 9,13.5" fill="currentColor" opacity="0.85" /><rect x="3" y="14.5" width="12" height="2" rx="1" fill="currentColor" opacity="0.55" /></svg>,
  },
];

const UndoIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
    <path d="M4 8H12.5A3.5 3.5 0 0 1 16 11.5A3.5 3.5 0 0 1 12.5 15H8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M7 4.5 3.5 8 7 11.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CopyIcon = (
  <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
    <rect x="6" y="6" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 3 4v6A1.5 1.5 0 0 0 4.5 11.5H6" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const SaveIcon = (
  <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
    <path d="M9 2.5v8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    <path d="M5.5 7.5 9 11l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3.5 13.5h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);
const EditorIcon = (
  <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
    <path d="M11.5 3.2 14.8 6.5 6.3 15H3v-3.3z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M10.3 4.4 13.6 7.7" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const CloseIcon = (
  <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden>
    <path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

interface Props {
  sel: Rect;
  winW: number;
  winH: number;
  annotating: boolean;
  busy: boolean;
  onPickTool: (t: Tool) => void;
  onCopy: () => void;
  onSave: () => void;
  onOpenEditor: () => void;
  onClose: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Toạ độ (CSS px) của thanh dọc + thanh ngang quanh khung `sel`. Dùng CHUNG
 * cho render (QuickToolbar) và hit-test (QuickAnnotate) → luôn khớp nhau. */
export function quickToolbarLayout(sel: Rect, winW: number, winH: number) {
  // Thanh dọc: ưu tiên bên phải khung; hết chỗ → sang trái. Bottom-align đáy khung.
  const rightX = sel.x + sel.w + GAP;
  const flipX = rightX + TOOLBAR_W > winW;
  const vLeft = flipX ? sel.x - GAP - TOOLBAR_W : rightX;
  const vTop = clamp(sel.y + sel.h - EST_V_H, GAP, Math.max(GAP, winH - EST_V_H - GAP));
  // Thanh ngang: ưu tiên dưới khung; hết chỗ → lên trên. Right-align mép phải khung.
  const belowY = sel.y + sel.h + GAP;
  const flipY = belowY + BOTTOM_H > winH;
  const hTop = flipY ? sel.y - GAP - BOTTOM_H : belowY;
  const hLeft = clamp(sel.x + sel.w - BOTTOM_W, GAP, Math.max(GAP, winW - BOTTOM_W - GAP));
  return {
    flipX,
    vRect: { x: vLeft, y: vTop, w: TOOLBAR_W, h: EST_V_H },
    hRect: { x: hLeft, y: hTop, w: BOTTOM_W, h: BOTTOM_H },
  };
}

export default function QuickToolbar({ sel, winW, winH, annotating, busy, onPickTool, onCopy, onSave, onOpenEditor, onClose }: Props) {
  const tool = useEditor((s) => s.tool);
  const color = useEditor((s) => s.color);
  const highlightColor = useEditor((s) => s.highlightColor);
  const setColor = useEditor((s) => s.setColor);
  const setHighlightColor = useEditor((s) => s.setHighlightColor);
  const undo = useEditor((s) => s.undo);
  const canUndo = useEditor((s) => s.canUndo());
  const [showColors, setShowColors] = useState(false);

  const isHighlight = tool === "highlight";
  const swatch = isHighlight ? highlightColor : color;
  const palette = isHighlight ? HIGHLIGHT_COLORS : PRESET_COLORS;

  const { flipX, vRect, hRect } = quickToolbarLayout(sel, winW, winH);
  const vLeft = vRect.x, vTop = vRect.y;
  const hLeft = hRect.x, hTop = hRect.y;

  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <>
      <div style={{ ...sideBar, left: vLeft, top: vTop }} onPointerDown={stop}>
        {TOOLS.map((t) => (
          <button key={t.id} title={t.label} onClick={() => onPickTool(t.id)} style={toolBtn(annotating && tool === t.id)}>
            {t.icon}
          </button>
        ))}
        <div style={{ position: "relative" }}>
          <button title="Chọn màu" disabled={!annotating} onClick={() => setShowColors((v) => !v)} style={toolBtn(showColors, !annotating)}>
            <span style={{ width: 16, height: 16, borderRadius: "50%", background: swatch, border: "1.5px solid rgba(255,255,255,0.6)" }} />
          </button>
          {showColors && annotating && (
            <div style={{ ...colorPopover, [flipX ? "left" : "right"]: TOOLBAR_W + 4 }}>
              {palette.map((c) => (
                <button key={c} onClick={() => { isHighlight ? setHighlightColor(c) : setColor(c); setShowColors(false); }}
                  style={{ width: 20, height: 20, borderRadius: "50%", background: c, border: c === swatch ? "2px solid #fff" : "1px solid rgba(255,255,255,0.3)", cursor: "pointer" }} />
              ))}
            </div>
          )}
        </div>
        <button title="Hoàn tác (Ctrl/Cmd+Z)" disabled={!annotating || !canUndo} onClick={() => undo()} style={toolBtn(false, !annotating || !canUndo)}>
          {UndoIcon}
        </button>
      </div>

      <div style={{ ...bottomBar, left: hLeft, top: hTop }} onPointerDown={stop}>
        <button title="Copy (Ctrl/Cmd+C)" style={actionBtn()} disabled={busy} onClick={onCopy}>{CopyIcon}</button>
        <button title="Lưu (Ctrl/Cmd+S)" style={actionBtn()} disabled={busy} onClick={onSave}>{SaveIcon}</button>
        <button title="Mở Editor" style={actionBtn()} disabled={busy} onClick={onOpenEditor}>{EditorIcon}</button>
        <button title="Đóng (Esc)" style={actionBtn("danger")} disabled={busy} onClick={onClose}>{CloseIcon}</button>
      </div>
    </>
  );
}

const sideBar: React.CSSProperties = {
  position: "absolute", width: TOOLBAR_W,
  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
  background: "rgba(28,28,32,0.96)", borderRadius: 10, padding: "8px 4px",
  boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
};
const bottomBar: React.CSSProperties = {
  position: "absolute", height: BOTTOM_H,
  display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6,
  background: "rgba(28,28,32,0.96)", borderRadius: 10, padding: "0 8px",
  boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
};

function toolBtn(active: boolean, disabled = false): React.CSSProperties {
  return {
    width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 8, border: "none",
    background: active ? "var(--accent, #3b82f6)" : "transparent",
    color: disabled ? "rgba(255,255,255,0.25)" : active ? "#fff" : "var(--text-dim, #9aa0aa)",
    cursor: disabled ? "default" : "pointer",
  };
}
function actionBtn(kind: "primary" | "danger" = "primary"): React.CSSProperties {
  const danger = kind === "danger";
  return {
    width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 8, border: "none",
    background: danger ? "rgba(239,68,68,0.16)" : "rgba(59,130,246,0.16)",
    color: danger ? "#fca5a5" : "#93c5fd", cursor: "pointer",
  };
}
const colorPopover: React.CSSProperties = {
  position: "absolute", top: 0,
  display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6,
  background: "rgba(30,30,36,0.99)", border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10, padding: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.4)", zIndex: 10,
};
