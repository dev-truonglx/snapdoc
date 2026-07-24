import type { ReactNode } from "react";
import { useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, HIGHLIGHT_COLORS, STROKE_WIDTHS, SOLID_COLORS, type Tool } from "../../features/annotation/model";

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
  /** "video": đang xem/cắt video trong Editor — ẩn hết công cụ vẽ ảnh
   * (New/Open/Ghép, 2 nhóm tool, đổi màu/nét, undo-redo-xoá, flatten),
   * Copy/Save+Copy (clipboard video chưa hỗ trợ), VÀ cả Save/Save As (2 nút
   * "Lưu đè"/"Lưu thành video mới" nay nằm trong `editToolbar` của
   * `VideoTrimmer`, ngay cạnh các nút chỉnh sửa video, thay vì ở đây). */
  mode: "image" | "video";
  onSave: () => void;
  onSaveAs: () => void;
  onCopy: () => void;
  onSaveCopy: () => void;
  onFlatten: () => void;
  onNew: () => void;
  onOpen: () => void;
  onStitch: () => void;
  busy: boolean;
}

/**
 * Ô nhập số dùng draft cục bộ. Dùng type="text" + inputMode numeric để KHÔNG có
 * nút spinner (tránh click vào input bị tăng/giảm số). Cho phép gõ/xoá tự do,
 * kể cả để TRỐNG; commit (clamp) khi gõ số hợp lệ để xem trước trực tiếp. Khi
 * rời focus mà để trống thì KHÔI PHỤC đúng giá trị TẠI LÚC FOCUS (trước khi sửa).
 */
function NumberField({
  value,
  min,
  max,
  onCommit,
  width = 60,
  title,
}: {
  value: number;
  min: number;
  max?: number;
  onCommit: (n: number) => void;
  width?: number;
  title?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const focusedRef = useRef(false);
  const focusValueRef = useRef(value); // giá trị ngay trước khi user bắt đầu sửa

  // Đồng bộ giá trị ngoài (vd nút +/- hoặc đổi tool) khi không đang gõ.
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);

  const clamp = (n: number) => Math.max(min, max != null ? Math.min(max, n) : n);

  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      title={title}
      onFocus={(e) => {
        focusedRef.current = true;
        focusValueRef.current = value;
        e.currentTarget.select();
      }}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d]/g, ""); // chỉ cho chữ số
        setDraft(raw); // giữ nguyên những gì user gõ, kể cả rỗng
        if (raw !== "") onCommit(clamp(Number(raw))); // xem trước trực tiếp
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (draft === "") {
          // Xóa hết, không nhập → khôi phục đúng giá trị trước khi sửa.
          setDraft(String(focusValueRef.current));
          onCommit(focusValueRef.current);
          return;
        }
        const n = clamp(Number(draft));
        setDraft(String(n));
        onCommit(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      style={{ ...fontInput, width }}
    />
  );
}

/**
 * Nút chọn màu tùy chỉnh — đồng nhất cho mọi chỗ có chọn màu. Ẩn hẳn input
 * type=color gốc (tránh viền/inset mặc định của OS làm lệch ô màu), dùng <label>
 * bọc làm ô màu phẳng cân đối; icon "+" trắng có viền tối để rõ trên mọi nền.
 */
function CustomColorButton({
  value,
  selected,
  onChange,
  round = false,
  title = "Chọn màu tùy chỉnh",
}: {
  value: string;
  selected: boolean;
  onChange: (c: string) => void;
  round?: boolean;
  title?: string;
}) {
  return (
    <label
      title={title}
      style={{
        position: "relative",
        width: 24,
        height: 24,
        borderRadius: round ? "50%" : 6,
        flexShrink: 0,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: value,
        border: selected ? "2.5px solid #fff" : "1px solid rgba(255,255,255,0.15)",
        boxShadow: selected
          ? "0 0 0 1.5px #3b82f6, 0 2px 4px rgba(0,0,0,0.2)"
          : "0 1px 2px rgba(0,0,0,0.2)",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ pointerEvents: "none" }}>
        <g stroke="rgba(0,0,0,0.45)" strokeWidth="3" strokeLinecap="round">
          <line x1="6" y1="2.5" x2="6" y2="9.5" />
          <line x1="2.5" y1="6" x2="9.5" y2="6" />
        </g>
        <g stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
          <line x1="6" y1="2.5" x2="6" y2="9.5" />
          <line x1="2.5" y1="6" x2="9.5" y2="6" />
        </g>
      </svg>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          border: "none",
          padding: 0,
          margin: 0,
          cursor: "pointer",
        }}
      />
    </label>
  );
}

export default function Toolbar({
  mode, onSave, onSaveAs, onCopy, onSaveCopy, onFlatten, onNew, onOpen, onStitch, busy,
}: Props) {
  // Selector + useShallow thay vì subscribe cả store: trước đây MỌI thay đổi
  // store (mỗi tick kéo slider blur qua `updateAnnotationLive`, mỗi lần di
  // chuyển annotation) đều re-render toàn bộ toolbar (hàng chục nút SVG).
  // `selectedAnn` tính ngay trong selector — chỉ đổi khi CHÍNH annotation
  // đang chọn đổi, không phải khi bất kỳ phần nào khác của doc đổi.
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
    stepCounter, arrowCounter,
    setStepCounter, setArrowCounter,
    renumberSteps, renumberArrows,
    selectedAnn,
  } = useEditor(
    useShallow((s) => ({
      tool: s.tool, setTool: s.setTool,
      color: s.color, setColor: s.setColor,
      highlightColor: s.highlightColor, setHighlightColor: s.setHighlightColor,
      strokeWidth: s.strokeWidth, setStrokeWidth: s.setStrokeWidth,
      fontSize: s.fontSize, setFontSize: s.setFontSize,
      blurRadius: s.blurRadius, setBlurRadius: s.setBlurRadius, commitBlurRadius: s.commitBlurRadius,
      blurMode: s.blurMode, setBlurMode: s.setBlurMode,
      blurSolidColor: s.blurSolidColor, setBlurSolidColor: s.setBlurSolidColor,
      undo: s.undo, redo: s.redo, canUndo: s.canUndo, canRedo: s.canRedo,
      removeSelected: s.removeSelected, selectedId: s.selectedId,
      stepCounter: s.stepCounter, arrowCounter: s.arrowCounter,
      setStepCounter: s.setStepCounter, setArrowCounter: s.setArrowCounter,
      renumberSteps: s.renumberSteps, renumberArrows: s.renumberArrows,
      selectedAnn:
        s.selectedId && s.doc
          ? s.doc.annotations.find((a) => a.id === s.selectedId) ?? null
          : null,
    })),
  );

  const [customColor, setCustomColor] = useState("#ef4444");
  const [customHighlight, setCustomHighlight] = useState("#fbbf24");
  const [customSolid, setCustomSolid] = useState("#1a1a1a");

  // Popover "Save As…" gắn cạnh nút Save (split button) — đóng khi click ra
  // ngoài, cùng cơ chế với các popover khác trong app (CaptureBar, RecordReview).
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSaveMenu) return;
    const onClickOutside = (e: MouseEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setShowSaveMenu(false);
      }
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [showSaveMenu]);

  // Sync custom colors with store values
  useEffect(() => {
    if (color && !PRESET_COLORS.includes(color)) {
      setCustomColor(color);
    }
  }, [color]);

  useEffect(() => {
    if (highlightColor && !HIGHLIGHT_COLORS.includes(highlightColor)) {
      setCustomHighlight(highlightColor);
    }
  }, [highlightColor]);

  useEffect(() => {
    if (blurSolidColor && !SOLID_COLORS.includes(blurSolidColor)) {
      setCustomSolid(blurSolidColor);
    }
  }, [blurSolidColor]);

  const isHighlight = tool === "highlight";
  // Hiện blur controls khi: đang dùng tool blur HOẶC đang select một BlurAnn
  const isBlur      = tool === "blur" || selectedAnn?.type === "blur";
  const isText      = tool === "text";
  const isStep      = tool === "step";
  const isNumberedArrow = tool === "numbered-arrow";
  // Tools dùng color + strokeWidth
  const hasStroke   = !isHighlight && !isBlur && !isText && tool !== "select" && tool !== "crop";

  return (
    <div style={bar}>
      {mode === "image" && (
      <>
      {/* New — chụp lại theo chế độ gần nhất + mở capture bar */}
      <button onClick={onNew} style={newBtn} title="Chụp mới (chế độ gần nhất + mở thanh chụp)">
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden fill="none">
          <circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" strokeWidth="1.6"/>
          <path d="M7.5 4v7M4 7.5h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600 }}>New</span>
      </button>

      {/* Open — mở ảnh từ file */}
      <button onClick={onOpen} style={newBtn} title="Mở ảnh từ file (Ctrl/Cmd+O)">
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden fill="none">
          <path d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.8l1.2 1.5H12.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5Z" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Open</span>
      </button>

      {/* Ghép — nối nhiều ảnh thành ảnh dài */}
      <button onClick={onStitch} style={newBtn} title="Nối ảnh dài (ghép nhiều ảnh)">
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden fill="none">
          <rect x="2" y="1.5" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
          <rect x="2" y="8.5" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Ghép</span>
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
          <span style={dimLabel}>Màu</span>
          {PRESET_COLORS.map((c) => (
            <button key={c} onClick={() => setColor(c)} title={c}
              style={{
                width: 24, height: 24, borderRadius: "50%",
                background: c,
                border: color === c ? "2.5px solid #fff" : "1px solid rgba(255,255,255,0.15)",
                boxShadow: color === c ? "0 0 0 1.5px #3b82f6, 0 2px 4px rgba(0,0,0,0.2)" : "0 1px 2px rgba(0,0,0,0.2)",
                flexShrink: 0,
                cursor: "pointer",
                transition: "all 0.12s",
              }} />
          ))}
          {/* Custom color picker */}
          <CustomColorButton
            round
            value={customColor}
            selected={color === customColor && !PRESET_COLORS.includes(color)}
            onChange={(c) => {
              setCustomColor(c);
              setColor(c);
            }}
          />
        </div>
      )}

      {/* Màu highlight — chỉ hiện khi tool = highlight */}
      {isHighlight && (
        <div style={group}>
          <span style={dimLabel}>Màu</span>
          {HIGHLIGHT_COLORS.map((c) => (
            <button key={c} onClick={() => setHighlightColor(c)} title={c}
              style={{
                width: 24, height: 24, borderRadius: 6,
                background: c,
                opacity: highlightColor === c ? 0.9 : 0.7,
                border: highlightColor === c ? "2.5px solid #fff" : "1px solid rgba(255,255,255,0.15)",
                boxShadow: highlightColor === c ? "0 0 0 1.5px #3b82f6, 0 2px 4px rgba(0,0,0,0.2)" : "0 1px 2px rgba(0,0,0,0.2)",
                flexShrink: 0,
                cursor: "pointer",
                transition: "all 0.12s",
              }} />
          ))}
          {/* Custom highlight color picker */}
          <CustomColorButton
            value={customHighlight}
            selected={highlightColor === customHighlight && !HIGHLIGHT_COLORS.includes(highlightColor)}
            onChange={(c) => {
              setCustomHighlight(c);
              setHighlightColor(c);
            }}
          />
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
            <NumberField value={fontSize} min={FONT_MIN} max={FONT_MAX} onCommit={(n) => setFontSize(clampFont(n))} title="Cỡ chữ (px)" />
            <button onClick={() => setFontSize(clampFont(fontSize + 2))} style={toolBtn(false)} title="Lớn hơn">+</button>
          </div>
        </>
      )}

      {/* Đếm số — khi tool = step (số bước) hoặc numbered-arrow (mũi tên số) */}
      {(isStep || isNumberedArrow) && (
        <>
          <div style={sep} />
          <div style={group}>
            <span style={dimLabel}>Số tiếp theo</span>
            <NumberField
              value={isStep ? stepCounter : arrowCounter}
              min={1}
              onCommit={isStep ? setStepCounter : setArrowCounter}
              title="Số sẽ gán cho mục kế tiếp"
            />
            <button
              onClick={() => (isStep ? setStepCounter : setArrowCounter)(1)}
              style={toolBtn(false)}
              title="Đặt lại bộ đếm về 1"
            >
              ↺ 1
            </button>
            <button
              onClick={() => (isStep ? renumberSteps : renumberArrows)()}
              style={newBtn}
              title="Đánh số lại toàn bộ theo thứ tự tạo (dọn khoảng trống sau khi xóa)"
            >
              Đánh số lại
            </button>
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
                      width: 24, height: 24, borderRadius: 6,
                      background: c,
                      border: blurSolidColor === c ? "2.5px solid #fff" : "1px solid rgba(255,255,255,0.15)",
                      boxShadow: blurSolidColor === c ? "0 0 0 1.5px #3b82f6, 0 2px 4px rgba(0,0,0,0.2)" : "0 1px 2px rgba(0,0,0,0.2)",
                      flexShrink: 0,
                      cursor: "pointer",
                      transition: "all 0.12s",
                    }}
                  />
                ))}
                {/* Custom solid color picker */}
                <CustomColorButton
                  value={customSolid}
                  selected={blurSolidColor === customSolid && !SOLID_COLORS.includes(blurSolidColor)}
                  onChange={(c) => {
                    setCustomSolid(c);
                    setBlurSolidColor(c);
                  }}
                />
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
      </>
      )}

      <div style={{ flex: 1 }} />

      {/* Output — nhóm Save (chính) / Save+Copy / Copy, chỉ ở chế độ ảnh.
          Video: 2 nút "Lưu đè"/"Lưu thành video mới" nay nằm trong
          `editToolbar` của `VideoTrimmer` (cạnh chia/xoá/cắt đầu-cuối), không
          còn ở đây — xem doc-comment `mode` ở `Props`. */}
      {mode === "image" && (
      <div style={group}>
        {/* Save: split button — bấm chính ghi đè tại chỗ record History nếu
            có, hoặc mở dialog nếu không; "▾" mở "Save As…" (xuất file mới,
            không đụng History). */}
        <div ref={saveMenuRef} style={splitGroup}>
          <button
            onClick={onSave}
            disabled={busy}
            style={savePillBtn}
            title="Lưu (Ctrl/Cmd+S)"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M13 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.5L14 5.5V13a1 1 0 0 1-1 1Z" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M5 2v3.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5V2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M4 14v-4.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V14" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Save</span>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setShowSaveMenu((v) => !v); }}
            disabled={busy}
            style={saveCaretBtn}
            title="Tuỳ chọn lưu khác"
            aria-label="Tuỳ chọn lưu khác"
          >
            ▾
          </button>
          {showSaveMenu && (
            <div style={saveMenuPopover}>
              <button
                style={saveMenuItem}
                onClick={() => { setShowSaveMenu(false); onSaveAs(); }}
              >
                Save As… (Ctrl/Cmd+Shift+S)
              </button>
            </div>
          )}
        </div>

        <button onClick={onSaveCopy} disabled={busy} style={newBtn} title="Lưu + Copy (Ctrl/Cmd+Alt+S)">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M12 13.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.5L13 5v7.5a1 1 0 0 1-1 1Z" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M4.5 2v3a.5.5 0 0 0 .5.5h4.5a.5.5 0 0 0 .5-.5V2" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M3.5 13.5V10h9v3.5" stroke="currentColor" strokeWidth="1.4"/>
            <rect x="9" y="8.5" width="5.5" height="5.5" rx="1" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M10.5 9.5h2.5M10.5 11h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Save+Copy</span>
        </button>

        <button onClick={onCopy} disabled={busy} style={newBtn} title="Copy vào clipboard (Ctrl/Cmd+C)">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Copy</span>
        </button>
      </div>
      )}
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

// Bọc nút Save + mũi tên "▾" — cùng khối để trông như 1 nút "split button"
// (Save | ▾) thay vì 2 nút rời, và làm điểm neo `position: relative` cho
// popover "Save As…" bên dưới (cùng pattern với `RecordReview.tsx`).
const splitGroup: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "stretch",
};

// Nút Save chính — cùng kiểu pill icon+label với `newBtn` nhưng tô accent vì
// là hành động dùng nhiều nhất trong toolbar (đứng đầu nhóm Output).
const savePillBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 30,
  padding: "0 10px",
  borderRadius: "6px 0 0 6px",
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

// Mũi tên nhỏ mở popover "Save As…" — cùng màu nền với Save, tách biệt bằng
// viền mảnh, đúng hình dáng "split button" quen thuộc.
const saveCaretBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 30,
  padding: "0 8px",
  borderRadius: "0 6px 6px 0",
  borderLeft: "1px solid rgba(0,0,0,0.15)",
  background: "var(--accent)",
  color: "#fff",
  fontSize: 11,
  opacity: 0.85,
  cursor: "pointer",
  flexShrink: 0,
};

const saveMenuPopover: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  left: 0,
  background: "rgba(30,30,36,0.99)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
  zIndex: 100,
  whiteSpace: "nowrap",
};

const saveMenuItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text, #cdd6f4)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};
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

