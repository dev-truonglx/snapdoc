import type { ReactNode } from "react";
import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, HIGHLIGHT_COLORS, STROKE_WIDTHS, type Tool } from "../../features/annotation/model";

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
      <path d="M3.5 4.5h11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M9 4.5v9.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  step: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <text x="9" y="12.4" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">1</text>
    </svg>
  ),
  arrow: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <line x1="3" y1="15" x2="14" y2="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <polygon points="14,4 9,5.5 12.5,9" fill="currentColor" />
    </svg>
  ),
  line: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <line x1="3" y1="15" x2="15" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  "numbered-arrow": (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="4.5" cy="13.5" r="3.5" fill="currentColor" />
      <text x="4.5" y="16.2" textAnchor="middle" fontSize="5" fontWeight="700" fill="#fff">1</text>
      <line x1="7.5" y1="11" x2="14.5" y2="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <polygon points="14.5,4 10,5.5 13,8.5" fill="currentColor" />
    </svg>
  ),
  highlight: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      {/* Bút dạ quang nghiêng: thân hình chữ nhật bo góc + mũi nhọn dưới + nắp trên */}
      {/* Thân bút */}
      <rect x="6.5" y="2" width="5" height="9" rx="1.2" fill="currentColor" opacity="0.85" />
      {/* Nắp bút (trên) */}
      <rect x="6.5" y="2" width="5" height="2.8" rx="1.2" fill="currentColor" />
      {/* Mũi nhọn dưới */}
      <polygon points="8,11 10,11 9,13.5" fill="currentColor" opacity="0.85" />
      {/* Vệt mực (highlight line dưới đáy) */}
      <rect x="3" y="14.5" width="12" height="2" rx="1" fill="currentColor" opacity="0.55" />
    </svg>
  ),
  blur: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      {/* Biểu tượng blur: ô vuông + vài chấm mờ bên trong */}
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="6"  cy="9" r="1.1" fill="currentColor" opacity="0.9" />
      <circle cx="9"  cy="9" r="1.1" fill="currentColor" opacity="0.55" />
      <circle cx="12" cy="9" r="1.1" fill="currentColor" opacity="0.25" />
      <circle cx="6"  cy="6.5" r="0.7" fill="currentColor" opacity="0.5" />
      <circle cx="9"  cy="6.5" r="0.7" fill="currentColor" opacity="0.3" />
      <circle cx="12" cy="6.5" r="0.7" fill="currentColor" opacity="0.15" />
      <circle cx="6"  cy="11.5" r="0.7" fill="currentColor" opacity="0.5" />
      <circle cx="9"  cy="11.5" r="0.7" fill="currentColor" opacity="0.3" />
      <circle cx="12" cy="11.5" r="0.7" fill="currentColor" opacity="0.15" />
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

const SOLID_COLORS = ["#1a1a1a", "#ef4444", "#111827", "#ffffff", "#0f172a"];

// Tools chia thành 2 nhóm để tránh toolbar quá dài
const TOOLS_GROUP1: { id: Tool; label: string; hint: string }[] = [
  { id: "select",         label: "Chọn",        hint: "V" },
  { id: "rect",           label: "Khung",        hint: "R" },
  { id: "ellipse",        label: "Tròn",         hint: "O" },
  { id: "text",           label: "Chữ",          hint: "T" },
  { id: "step",           label: "Số bước",      hint: "N" },
];

const TOOLS_GROUP2: { id: Tool; label: string; hint: string }[] = [
  { id: "arrow",          label: "Mũi tên",      hint: "A" },
  { id: "line",           label: "Đường thẳng",  hint: "L" },
  { id: "numbered-arrow", label: "Mũi tên số",   hint: "W" },
  { id: "highlight",      label: "Highlight",    hint: "H" },
  { id: "blur",           label: "Che mờ",       hint: "B" },
  { id: "crop",           label: "Crop",         hint: "C" },
];

interface Props {
  onSave: () => void;
  onCopy: () => void;
  onSaveCopy: () => void;
  onFlatten: () => void;
  onNew: () => void;
  busy: boolean;
}

export default function Toolbar({ onSave, onCopy, onSaveCopy, onFlatten, onNew, busy }: Props) {
  const {
    tool, setTool,
    color, setColor,
    highlightColor, setHighlightColor,
    strokeWidth, setStrokeWidth,
    fontSize, setFontSize,
    blurRadius, setBlurRadius, commitBlurRadius,
    blurMode, setBlurMode,
    blurSolidColor, setBlurSolidColor,
    undo, redo, canUndo, canRedo,
    removeSelected, selectedId,
    doc,
  } = useEditor();

  // Annotation đang được chọn (nếu có)
  const selectedAnn = selectedId && doc
    ? doc.annotations.find((a) => a.id === selectedId)
    : null;

  const isHighlight = tool === "highlight";
  // Hiện blur controls khi: đang dùng tool blur HOẶC đang select một BlurAnn
  const isBlur      = tool === "blur" || selectedAnn?.type === "blur";
  const isText      = tool === "text";
  // Tools dùng color + strokeWidth
  const hasStroke   = !isHighlight && !isBlur && !isText && tool !== "select" && tool !== "crop";

  return (
    <div style={bar}>
      {/* New — chụp lại theo chế độ gần nhất + mở capture bar */}
      <button onClick={onNew} style={newBtn} title="Chụp mới (chế độ gần nhất + mở thanh chụp)">
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden fill="none">
          <circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" strokeWidth="1.6"/>
          <path d="M7.5 4v7M4 7.5h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600 }}>New</span>
      </button>

      <div style={sep} />

      {/* Nhóm 1 */}
      <div style={group}>
        {TOOLS_GROUP1.map((t) => (
          <button key={t.id} onClick={() => setTool(t.id)}
            title={`${t.label} (${t.hint})`} aria-label={t.label}
            style={toolBtn(tool === t.id)}>
            {ICONS[t.id]}
          </button>
        ))}
      </div>

      <div style={sep} />

      {/* Nhóm 2 */}
      <div style={group}>
        {TOOLS_GROUP2.map((t) => (
          <button key={t.id} onClick={() => setTool(t.id)}
            title={`${t.label} (${t.hint})`} aria-label={t.label}
            style={toolBtn(tool === t.id)}>
            {ICONS[t.id]}
          </button>
        ))}
      </div>

      <div style={sep} />

      {/* Màu stroke — ẩn khi đang dùng highlight/blur */}
      {!isHighlight && !isBlur && (
        <div style={group}>
          {PRESET_COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} title={c}
              style={{
                width: 22, height: 22, borderRadius: "50%",
                background: c,
                border: color === c ? "2px solid #fff" : "2px solid transparent",
                boxShadow: color === c ? "0 0 0 1.5px #3b82f6" : "none",
                flexShrink: 0,
              }} />
          ))}
        </div>
      )}

      {/* Màu highlight — chỉ hiện khi tool = highlight */}
      {isHighlight && (
        <div style={group}>
          <span style={dimLabel}>Màu</span>
          {HIGHLIGHT_COLORS.map((c) => (
            <button key={c} onClick={() => setHighlightColor(c)} title={c}
              style={{
                width: 22, height: 22, borderRadius: 4,
                background: c,
                opacity: 0.8,
                border: highlightColor === c ? "2px solid #fff" : "2px solid transparent",
                boxShadow: highlightColor === c ? "0 0 0 1.5px #3b82f6" : "none",
                flexShrink: 0,
              }} />
          ))}
        </div>
      )}

      {/* Độ dày nét — chỉ với tools vẽ đường */}
      {hasStroke && (
        <>
          <div style={sep} />
          <div style={group}>
            {STROKE_WIDTHS.map((w) => (
              <button key={w} onClick={() => setStrokeWidth(w)}
                style={toolBtn(strokeWidth === w)} title={`Nét ${w}px`}>
                <span style={{ display: "inline-block", width: 18, height: w, background: "currentColor", borderRadius: 2 }} />
              </button>
            ))}
          </div>
        </>
      )}

      {/* Cỡ chữ — chỉ khi tool = text */}
      {isText && (
        <>
          <div style={sep} />
          <div style={group}>
            <span style={dimLabel}>Cỡ chữ</span>
            <button onClick={() => setFontSize(clampFont(fontSize - 2))} style={toolBtn(false)} title="Nhỏ hơn">−</button>
            <input
              type="number" min={FONT_MIN} max={FONT_MAX} value={fontSize}
              onChange={(e) => setFontSize(clampFont(Number(e.target.value)))}
              style={fontInput}
            />
            <button onClick={() => setFontSize(clampFont(fontSize + 2))} style={toolBtn(false)} title="Lớn hơn">+</button>
          </div>
        </>
      )}

      {/* Blur controls — chỉ khi tool = blur */}
      {isBlur && (
        <>
          <div style={sep} />
          {/* Sub-mode */}
          <div style={group}>
            {(["blur", "pixelate", "solid"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setBlurMode(m)}
                style={modeBtn(blurMode === m)}
                title={m === "blur" ? "Blur mềm" : m === "pixelate" ? "Pixel hoá" : "Che đặc"}
              >
                {m === "blur" ? "Blur" : m === "pixelate" ? "Pixel" : "Solid"}
              </button>
            ))}
          </div>

          {/* Intensity slider — chỉ khi blur hoặc pixelate */}
          {blurMode !== "solid" && (
            <>
              <div style={sep} />
              <div style={group}>
                <span style={dimLabel}>{blurMode === "pixelate" ? "Tile" : "Mờ"}</span>
                <input
                  type="range"
                  min={2} max={blurMode === "pixelate" ? 32 : 20}
                  value={blurRadius}
                  onChange={(e) => setBlurRadius(Number(e.target.value))}
                  onMouseUp={commitBlurRadius}
                  onPointerUp={commitBlurRadius}
                  style={sliderStyle}
                  title={`Cường độ: ${blurRadius}`}
                />
                <span style={blurLabel}>{blurRadius}</span>
              </div>
            </>
          )}

          {/* Solid color picker */}
          {blurMode === "solid" && (
            <>
              <div style={sep} />
              <div style={group}>
                <span style={dimLabel}>Màu</span>
                {SOLID_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setBlurSolidColor(c)}
                    title={c}
                    style={{
                      width: 22, height: 22, borderRadius: 4,
                      background: c,
                      border: blurSolidColor === c ? "2px solid #fff" : "2px solid transparent",
                      boxShadow: blurSolidColor === c ? "0 0 0 1.5px #3b82f6" : "none",
                      flexShrink: 0,
                    }}
                  />
                ))}
              </div>
            </>
          )}

          {/* Flatten */}
          <div style={sep} />
          <button
            onClick={onFlatten}
            disabled={busy}
            style={flattenBtn}
            title="Flatten — ghi đè annotation vào ảnh gốc, không thể hoàn tác"
          >
            🔒 Flatten
          </button>
        </>
      )}

      <div style={sep} />

      {/* Undo / redo / xoá */}
      <div style={group}>
        <button onClick={undo} disabled={!canUndo()} style={toolBtn(false)} title="Hoàn tác (Ctrl/Cmd+Z)">↩︎</button>
        <button onClick={redo} disabled={!canRedo()} style={toolBtn(false)} title="Làm lại">↪︎</button>
        <button onClick={removeSelected} disabled={!selectedId} style={toolBtn(false)} title="Xoá (Delete)">🗑</button>
      </div>

      <div style={{ flex: 1 }} />

      {/* Output */}
      <div style={group}>
        <button onClick={onCopy} disabled={busy} style={outBtn(false)} title="Copy vào clipboard (Ctrl/Cmd+C)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </button>
        <button onClick={onSave} disabled={busy} style={outBtn(false)} title="Lưu file (Ctrl/Cmd+S)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M13 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.5L14 5.5V13a1 1 0 0 1-1 1Z" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M5 2v3.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M4 14v-4.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V14" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </button>
        <button onClick={onSaveCopy} disabled={busy} style={outBtn(true)} title="Lưu + Copy (Ctrl/Cmd+Shift+S)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M12 13.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.5L13 5v7.5a1 1 0 0 1-1 1Z" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M4.5 2v3a.5.5 0 0 0 .5.5h4.5a.5.5 0 0 0 .5-.5V2" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M3.5 13.5V10h9v3.5" stroke="currentColor" strokeWidth="1.4"/>
            {/* Small clipboard badge */}
            <rect x="9" y="8.5" width="5.5" height="5.5" rx="1" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M10.5 9.5h2.5M10.5 11h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "var(--bg-elevated)",
  borderBottom: "1px solid var(--border)",
  flexWrap: "wrap",
};
const newBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 30,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};
const group: React.CSSProperties = { display: "flex", alignItems: "center", gap: 3 };
const sep: React.CSSProperties = { width: 1, height: 24, background: "var(--border)", flexShrink: 0 };
const dimLabel: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginRight: 2, whiteSpace: "nowrap" };
const blurLabel: React.CSSProperties = {
  minWidth: 28, textAlign: "center", fontSize: 12,
  color: "var(--text)", fontVariantNumeric: "tabular-nums",
};
const fontInput: React.CSSProperties = {
  width: 44, height: 28, textAlign: "center", borderRadius: 6,
  background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 13,
};

function toolBtn(active: boolean): React.CSSProperties {
  return {
    minWidth: 30, height: 30, padding: "0 6px", borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text)",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  };
}
function outBtn(primary: boolean): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    padding: 0,
    borderRadius: 6,
    fontWeight: 500,
    background: primary ? "var(--accent)" : "transparent",
    color: primary ? "#fff" : "var(--text)",
    border: primary ? "none" : "1px solid var(--border)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

function modeBtn(active: boolean): React.CSSProperties {
  return {
    height: 26, padding: "0 9px", borderRadius: 5, fontSize: 11, fontWeight: 600,
    background: active ? "var(--accent)" : "rgba(255,255,255,0.06)",
    color: active ? "#fff" : "var(--text-dim)",
    border: active ? "none" : "1px solid var(--border)",
    whiteSpace: "nowrap", cursor: "pointer",
  };
}

const sliderStyle: React.CSSProperties = {
  width: 80, height: 4, accentColor: "var(--accent)", cursor: "pointer",
};

const flattenBtn: React.CSSProperties = {
  height: 28, padding: "0 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
  background: "rgba(239,68,68,0.15)", color: "#fca5a5",
  border: "1px solid rgba(239,68,68,0.35)", whiteSpace: "nowrap", cursor: "pointer",
};
