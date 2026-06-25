import type { ReactNode } from "react";
import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, STROKE_WIDTHS, type Tool } from "../../features/annotation/model";

/** Icon 18×18, dùng currentColor để kế thừa màu nút. */
const ICONS: Record<Tool, ReactNode> = {
  select: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M4 2l10 5.2-4.1 1.3 2.4 4.8-1.8.9-2.4-4.8L4 13z" fill="currentColor" />
    </svg>
  ),
  rect: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  ellipse: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <ellipse cx="9" cy="9" rx="7" ry="5.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  text: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      {/* chữ "T" đậm, dễ nhận: thanh ngang trên + chân đứng giữa */}
      <path d="M3.5 4.5h11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M9 4.5v9.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  step: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <text x="9" y="12.4" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">
        1
      </text>
    </svg>
  ),
  crop: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        d="M5 1.5v11.5a.9.9 0 0 0 .9.9H17M1 5h11.1a.9.9 0 0 1 .9.9V17"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  ),
};

const FONT_MIN = 8;
const FONT_MAX = 200;
const clampFont = (n: number) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n || FONT_MIN)));

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "select", label: "Chọn", hint: "V" },
  { id: "rect", label: "Khung", hint: "R" },
  { id: "ellipse", label: "Tròn", hint: "O" },
  { id: "text", label: "Chữ", hint: "T" },
  { id: "step", label: "Số bước", hint: "N" },
  { id: "crop", label: "Crop", hint: "C" },
];

interface Props {
  onSave: () => void;
  onCopy: () => void;
  onSaveCopy: () => void;
  busy: boolean;
}

export default function Toolbar({ onSave, onCopy, onSaveCopy, busy }: Props) {
  const { tool, setTool, color, setColor, strokeWidth, setStrokeWidth, fontSize, setFontSize, undo, redo, canUndo, canRedo, removeSelected, selectedId } =
    useEditor();

  return (
    <div style={bar}>
      <div style={group}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            title={`${t.label} (${t.hint})`}
            aria-label={t.label}
            style={toolBtn(tool === t.id)}
          >
            {ICONS[t.id]}
          </button>
        ))}
      </div>

      <div style={sep} />

      <div style={group}>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            title={c}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: c,
              border: color === c ? "2px solid #fff" : "2px solid transparent",
              boxShadow: color === c ? "0 0 0 1px #3b82f6" : "none",
            }}
          />
        ))}
      </div>

      <div style={sep} />

      <div style={group}>
        {STROKE_WIDTHS.map((w) => (
          <button key={w} onClick={() => setStrokeWidth(w)} style={toolBtn(strokeWidth === w)} title={`Nét ${w}px`}>
            <span style={{ display: "inline-block", width: 18, height: w, background: "currentColor", borderRadius: 2 }} />
          </button>
        ))}
      </div>

      {tool === "text" && (
        <>
          <div style={sep} />
          <div style={group}>
            <span style={fontLabel}>Cỡ chữ</span>
            <button onClick={() => setFontSize(clampFont(fontSize - 2))} style={toolBtn(false)} title="Nhỏ hơn">
              −
            </button>
            <input
              type="number"
              min={FONT_MIN}
              max={FONT_MAX}
              value={fontSize}
              onChange={(e) => setFontSize(clampFont(Number(e.target.value)))}
              style={fontInput}
            />
            <button onClick={() => setFontSize(clampFont(fontSize + 2))} style={toolBtn(false)} title="Lớn hơn">
              +
            </button>
          </div>
        </>
      )}

      <div style={sep} />

      <div style={group}>
        <button onClick={undo} disabled={!canUndo()} style={toolBtn(false)} title="Hoàn tác (Ctrl/Cmd+Z)">
          ↩︎
        </button>
        <button onClick={redo} disabled={!canRedo()} style={toolBtn(false)} title="Làm lại">
          ↪︎
        </button>
        <button onClick={removeSelected} disabled={!selectedId} style={toolBtn(false)} title="Xoá (Delete)">
          🗑
        </button>
      </div>

      <div style={{ flex: 1 }} />

      <div style={group}>
        <button onClick={onCopy} disabled={busy} style={outBtn(false)}>
          Copy
        </button>
        <button onClick={onSave} disabled={busy} style={outBtn(false)}>
          Lưu file
        </button>
        <button onClick={onSaveCopy} disabled={busy} style={outBtn(true)}>
          Lưu + Copy
        </button>
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  background: "var(--bg-elevated)",
  borderBottom: "1px solid var(--border)",
  flexWrap: "wrap",
};
const group: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const sep: React.CSSProperties = { width: 1, height: 24, background: "var(--border)" };
const fontLabel: React.CSSProperties = { fontSize: 12, color: "var(--text-dim)", marginRight: 2 };
const fontInput: React.CSSProperties = {
  width: 48,
  height: 28,
  textAlign: "center",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  fontSize: 13,
};

function toolBtn(active: boolean): React.CSSProperties {
  return {
    minWidth: 30,
    height: 30,
    padding: "0 8px",
    borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
}
function outBtn(primary: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: "0 14px",
    borderRadius: 6,
    fontWeight: 500,
    background: primary ? "var(--accent)" : "transparent",
    color: primary ? "#fff" : "var(--text)",
    border: primary ? "none" : "1px solid var(--border)",
  };
}
