import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, STROKE_WIDTHS, type Tool } from "../../features/annotation/model";

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
  const { tool, setTool, color, setColor, strokeWidth, setStrokeWidth, undo, redo, canUndo, canRedo, removeSelected, selectedId } =
    useEditor();

  return (
    <div style={bar}>
      <div style={group}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTool(t.id)}
            title={`${t.label} (${t.hint})`}
            style={toolBtn(tool === t.id)}
          >
            {t.label}
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
