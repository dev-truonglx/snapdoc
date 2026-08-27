import type { ReactNode } from "react";
import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, HIGHLIGHT_COLORS, STROKE_WIDTHS, SOLID_COLORS, type Tool, type Annotation } from "../../features/annotation/model";

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
  "numbered-rect": (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="5" cy="6.5" r="3.2" fill="currentColor" />
      <text x="5" y="8.8" textAnchor="middle" fontSize="4.5" fontWeight="700" fill="#fff">1</text>
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

// Tools will be initialized inside component with translations

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
  title,
}: {
  value: string;
  selected: boolean;
  onChange: (c: string) => void;
  round?: boolean;
  title?: string;
}) {
  const { t } = useTranslation();
  return (
    <label
      title={title ?? t("editorToolbar.customColor")}
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
  const { t } = useTranslation();

  // Initialize tool groups with translations
  const TOOLS_GROUP1: { id: Tool; label: string; hint: string }[] = [
    { id: "select",         label: t("tools.select"),       hint: "V" },
    { id: "rect",           label: t("tools.rect"),         hint: "R" },
    { id: "numbered-rect",  label: t("tools.numberedRect") || (t("tools.rect") + " #"), hint: "E" },
    { id: "ellipse",        label: t("tools.circle"),       hint: "O" },
    { id: "text",           label: t("tools.text"),         hint: "T" },
    { id: "step",           label: t("tools.step"),         hint: "N" },
  ];

  const TOOLS_GROUP2: { id: Tool; label: string; hint: string }[] = [
    { id: "arrow",          label: t("tools.arrow"),        hint: "A" },
    { id: "line",           label: t("tools.line"),         hint: "L" },
    { id: "numbered-arrow", label: t("tools.arrow") + " #", hint: "W" },
    { id: "highlight",      label: t("tools.highlight"),    hint: "H" },
    { id: "blur",           label: t("tools.blur"),         hint: "B" },
    { id: "crop",           label: "Crop",                  hint: "C" },
  ];

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
    bringToFront, sendToBack,
    removeSelected, selectedId, selectedIds,
    stepCounter, arrowCounter, rectCounter,
    setStepCounter, setArrowCounter, setRectCounter,
    renumberSteps, renumberArrows, renumberRects,
    doc,
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
      bringToFront: s.bringToFront, sendToBack: s.sendToBack,
      removeSelected: s.removeSelected, selectedId: s.selectedId, selectedIds: s.selectedIds ?? [],
      stepCounter: s.stepCounter, arrowCounter: s.arrowCounter, rectCounter: s.rectCounter,
      setStepCounter: s.setStepCounter, setArrowCounter: s.setArrowCounter, setRectCounter: s.setRectCounter,
      renumberSteps: s.renumberSteps, renumberArrows: s.renumberArrows, renumberRects: s.renumberRects,
      doc: s.doc,
    })),
  );

  const safeSelectedIds = selectedIds ?? [];
  const selectedAnn = useMemo(() => {
    if (!selectedId || !doc) return null;
    return doc.annotations.find((a) => a.id === selectedId) ?? null;
  }, [selectedId, doc]);

  const selectedAnns = useMemo(() => {
    if (!doc || safeSelectedIds.length === 0) return [];
    const set = new Set(safeSelectedIds);
    return doc.annotations.filter((a) => set.has(a.id));
  }, [doc, safeSelectedIds]);

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

  const isMultiple = selectedIds.length > 1;
  const isHighlight = (!isMultiple && (tool === "highlight" || selectedAnn?.type === "highlight")) || (isMultiple && selectedAnns.length > 0 && selectedAnns.every((a: Annotation) => a.type === "highlight"));
  const isBlur      = (!isMultiple && (tool === "blur" || selectedAnn?.type === "blur")) || (isMultiple && selectedAnns.length > 0 && selectedAnns.every((a: Annotation) => a.type === "blur"));
  const isText      = (!isMultiple && (tool === "text" || selectedAnn?.type === "text")) || (isMultiple && selectedAnns.length > 0 && selectedAnns.every((a: Annotation) => a.type === "text"));
  const isStep      = !isMultiple && (tool === "step" || selectedAnn?.type === "step");
  const isNumberedArrow = !isMultiple && (tool === "numbered-arrow" || selectedAnn?.type === "numbered-arrow");
  const isNumberedRect  = !isMultiple && (tool === "numbered-rect" || selectedAnn?.type === "numbered-rect");
  const isCrop      = tool === "crop";
  const isImage     = (!isMultiple && selectedAnn?.type === "image") || (isMultiple && selectedAnns.length > 0 && selectedAnns.every((a: Annotation) => a.type === "image"));
  // Tools dùng color + strokeWidth: hiển thị đầy đủ khi ở chế độ vẽ hoặc khi ở chế độ chọn/sửa
  const hasStroke   = isMultiple ? selectedAnns.some((a: Annotation) => "strokeWidth" in a) : (!isHighlight && !isBlur && !isText && !isCrop && !isImage);

  return (
    <div style={bar}>
      {mode === "image" && (
        <>
          {/* CỘT TRÁI: 2 DÒNG CỐ ĐỊNH CHIỀU CAO (Dòng 1: Danh sách công cụ, Dòng 2: Tùy chọn thuộc tính) */}
          <div style={leftSection}>
            {/* DÒNG 1: THAO TÁC ẢNH & TOÀN BỘ CÔNG CỤ VẼ & UNDO/REDO */}
            <div style={toolbarRow}>
              {/* File / Doc actions */}
              <div style={group}>
                {/* New */}
                <button onClick={onNew} style={newBtn} title={t("editorToolbar.newCapture")}>
                  <svg width="14" height="14" viewBox="0 0 15 15" aria-hidden fill="none">
                    <circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" strokeWidth="1.6"/>
                    <path d="M7.5 4v7M4 7.5h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>New</span>
                </button>

                {/* Open */}
                <button onClick={onOpen} style={newBtn} title={t("editorToolbar.openFile")}>
                  <svg width="14" height="14" viewBox="0 0 15 15" aria-hidden fill="none">
                    <path d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.8l1.2 1.5H12.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5Z" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Open</span>
                </button>

                {/* Stitch */}
                <button onClick={onStitch} style={newBtn} title={t("editorToolbar.stitchImages")}>
                  <svg width="14" height="14" viewBox="0 0 15 15" aria-hidden fill="none">
                    <rect x="2" y="1.5" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
                    <rect x="2" y="8.5" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
                  </svg>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t("editorToolbar.stitchButton")}</span>
                </button>
              </div>

              <div style={sep} />

              {/* Nhóm công cụ 1 */}
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

              {/* Nhóm công cụ 2 */}
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

              {/* Undo / redo / xoá / layer order */}
              <div style={group}>
                <button onClick={undo} disabled={!canUndo()} style={toolBtn(false)} title={t("editorToolbar.undo")}>↩︎</button>
                <button onClick={redo} disabled={!canRedo()} style={toolBtn(false)} title={t("editorToolbar.redo")}>↪︎</button>
                <button onClick={removeSelected} disabled={!selectedId && selectedIds.length === 0} style={toolBtn(false)} title={t("editorToolbar.delete")}>🗑</button>
              </div>

              {/* Thứ tự lớp (Lên trên / Xuống dưới) — hiện khi có đối tượng được chọn */}
              {(selectedId || selectedIds.length > 0) && (
                <>
                  <div style={sep} />
                  <div style={group}>
                    <button
                      onClick={bringToFront}
                      style={toolBtn(false)}
                      title={t("editorToolbar.bringToFront")}
                      aria-label="Bring to Front"
                    >
                      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
                        {/* Hình vuông dưới (mờ, nằm sau) */}
                        <path d="M4.5 2.5h6.5a2 2 0 0 1 2 2V7M2.5 4.5v6.5a2 2 0 0 0 2 2H7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4"/>
                        {/* Hình vuông trên (đậm, đè lên trước) */}
                        <rect x="7" y="7" width="10.5" height="10.5" rx="2" fill="currentColor" stroke="currentColor" strokeWidth="1.2"/>
                      </svg>
                    </button>
                    <button
                      onClick={sendToBack}
                      style={toolBtn(false)}
                      title={t("editorToolbar.sendToBack")}
                      aria-label="Send to Back"
                    >
                      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
                        {/* Hình vuông dưới (đậm, nằm sau) */}
                        <path d="M4.5 2.5h6.5a2 2 0 0 1 2 2V7H7v6H4.5a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2z" fill="currentColor"/>
                        {/* Hình vuông trên (mờ, đè lên trước) */}
                        <rect x="7" y="7" width="10.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.6" opacity="0.4"/>
                      </svg>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* DÒNG 2: THUỘC TÍNH CHI TIẾT THEO CÔNG CỤ ĐANG CHỌN (Màu, Nét, Size chữ, Đếm số, Blur...) */}
            <div style={toolbarRow}>
              {/* Màu stroke — ẩn khi đang dùng highlight/blur/image */}
              {!isHighlight && !isBlur && !isImage && (
                <div style={group}>
                  <span style={dimLabel}>{t("editorToolbar.color")}</span>
                  {PRESET_COLORS.map((c) => (
                    <button key={c} onClick={() => setColor(c)} title={c}
                      style={{
                        width: 20, height: 20, borderRadius: "50%",
                        background: c,
                        border: color === c ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
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
                  <span style={dimLabel}>{t("editorToolbar.color")}</span>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button key={c} onClick={() => setHighlightColor(c)} title={c}
                      style={{
                        width: 20, height: 20, borderRadius: 4,
                        background: c,
                        opacity: highlightColor === c ? 0.9 : 0.7,
                        border: highlightColor === c ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
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
                        style={toolBtn(strokeWidth === w)} title={t("editorToolbar.strokeWidth", { n: w })}>
                        <span style={{ display: "inline-block", width: 16, height: w, background: "currentColor", borderRadius: 2 }} />
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
                    <span style={dimLabel}>{t("editorToolbar.fontSize")}</span>
                    <button onClick={() => setFontSize(clampFont(fontSize - 2))} style={toolBtn(false)} title={t("editorToolbar.fontSizeSmaller")}>−</button>
                    <NumberField value={fontSize} min={FONT_MIN} max={FONT_MAX} onCommit={(n) => setFontSize(clampFont(n))} title={t("editorToolbar.fontSizeInput")} />
                    <button onClick={() => setFontSize(clampFont(fontSize + 2))} style={toolBtn(false)} title={t("editorToolbar.fontSizeLarger")}>+</button>
                  </div>
                </>
              )}

              {/* Đếm số — khi tool = step (số bước), numbered-arrow (mũi tên số) hoặc numbered-rect (khung số) */}
              {(isStep || isNumberedArrow || isNumberedRect) && (
                <>
                  <div style={sep} />
                  <div style={group}>
                    <span style={dimLabel}>{t("editorToolbar.nextNumber")}</span>
                    <NumberField
                      value={isStep ? stepCounter : isNumberedArrow ? arrowCounter : rectCounter}
                      min={1}
                      onCommit={isStep ? setStepCounter : isNumberedArrow ? setArrowCounter : setRectCounter}
                      title={t("editorToolbar.nextNumberToAssign")}
                    />
                    <button
                      onClick={() => (isStep ? setStepCounter : isNumberedArrow ? setArrowCounter : setRectCounter)(1)}
                      style={toolBtn(false)}
                      title={t("editorToolbar.resetCounter")}
                    >
                      ↺ 1
                    </button>
                    <button
                      onClick={() => (isStep ? renumberSteps : isNumberedArrow ? renumberArrows : renumberRects)()}
                      style={newBtn}
                      title={t("editorToolbar.renumberAll")}
                    >
                      {t("editorToolbar.renumber")}
                    </button>
                  </div>
                </>
              )}

              {/* Đổi vị trí góc số khi đang chọn 1 NumberedRect */}
              {selectedAnn?.type === "numbered-rect" && (
                <>
                  <div style={sep} />
                  <div style={group}>
                    <span style={dimLabel}>{t("editorToolbar.badgeCorner") || "Góc"}</span>
                    {(["tl", "tr", "bl", "br"] as const).map((c) => (
                      <button
                        key={c}
                        onClick={() => useEditor.getState().updateAnnotation(selectedAnn.id, { corner: c } as Partial<Annotation>)}
                        style={modeBtn((selectedAnn.corner || "tl") === c)}
                        title={c.toUpperCase()}
                      >
                        {c.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Blur controls — chỉ khi tool = blur */}
              {isBlur && (
                <>
                  {/* Sub-mode */}
                  <div style={group}>
                    {(["blur", "pixelate", "solid"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setBlurMode(m)}
                        style={modeBtn(blurMode === m)}
                        title={m === "blur" ? t("editorToolbar.blurSoft") : m === "pixelate" ? t("editorToolbar.pixelate") : t("editorToolbar.solidMode")}
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
                        <span style={dimLabel}>{blurMode === "pixelate" ? t("editorToolbar.pixelTileSize") : t("editorToolbar.blurIntensity")}</span>
                        <input
                          type="range"
                          min={2} max={blurMode === "pixelate" ? 32 : 20}
                          value={blurRadius}
                          onChange={(e) => setBlurRadius(Number(e.target.value))}
                          onMouseUp={commitBlurRadius}
                          onPointerUp={commitBlurRadius}
                          style={sliderStyle}
                          title={t("editorToolbar.intensityLabel", { n: blurRadius })}
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
                        <span style={dimLabel}>{t("editorToolbar.color")}</span>
                        {SOLID_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setBlurSolidColor(c)}
                            title={c}
                            style={{
                              width: 20, height: 20, borderRadius: 4,
                              background: c,
                              border: blurSolidColor === c ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
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
                    title={t("editorToolbar.flattenTooltip")}
                  >
                    {t("editorToolbar.flatten")}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* CỘT PHẢI: KHU VỰC CÁC NÚT ACTION XUẤT (Save, Save+Copy, Copy) */}
          <div style={rightSection}>
            {/* Save: split button */}
            <div ref={saveMenuRef} style={splitGroup}>
              <button
                onClick={onSave}
                disabled={busy}
                style={savePillBtn}
                title={t("editorToolbar.save")}
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
                title={t("editorToolbar.saveOptions")}
                aria-label={t("editorToolbar.saveOptions")}
              >
                ▾
              </button>
              {showSaveMenu && (
                <div style={saveMenuPopover}>
                  <button
                    style={saveMenuItem}
                    onClick={() => { setShowSaveMenu(false); onSaveAs(); }}
                  >
                    {t("editorToolbar.saveAs")}
                  </button>
                </div>
              )}
            </div>

            <button onClick={onSaveCopy} disabled={busy} style={actionBtn} title={t("editorToolbar.saveCopy")}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M12 13.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7.5L13 5v7.5a1 1 0 0 1-1 1Z" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M4.5 2v3a.5.5 0 0 0 .5.5h4.5a.5.5 0 0 0 .5-.5V2" stroke="currentColor" strokeWidth="1.4"/>
                <path d="M3.5 13.5V10h9v3.5" stroke="currentColor" strokeWidth="1.4"/>
                <rect x="9" y="8.5" width="5.5" height="5.5" rx="1" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M10.5 9.5h2.5M10.5 11h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Save+Copy</span>
            </button>

            <button onClick={onCopy} disabled={busy} style={actionBtn} title={t("editorToolbar.copy")}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Copy</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "6px 12px",
  background: "var(--bg-elevated)",
  borderBottom: "1px solid var(--border)",
  minHeight: 74,
  height: 74,
  boxSizing: "border-box",
  flexShrink: 0,
};

const leftSection: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 6,
  flex: 1,
  minWidth: 0,
  height: "100%",
};

const toolbarRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  minHeight: 28,
  overflowX: "auto",
  overflowY: "hidden",
  whiteSpace: "nowrap",
  scrollbarWidth: "none",
};

const rightSection: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  paddingLeft: 12,
  borderLeft: "1px solid var(--border)",
  flexShrink: 0,
  height: "100%",
};

const newBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 26,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const actionBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 32,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--text)",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const group: React.CSSProperties = { display: "flex", alignItems: "center", gap: 3, flexShrink: 0 };

// Bọc nút Save + mũi tên "▾" — cùng khối để trông như 1 nút "split button"
const splitGroup: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "stretch",
};

const savePillBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 32,
  padding: "0 11px",
  borderRadius: "6px 0 0 6px",
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const saveCaretBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 32,
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
  right: 0,
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

const sep: React.CSSProperties = { width: 1, height: 18, background: "var(--border)", flexShrink: 0 };
const dimLabel: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginRight: 2, whiteSpace: "nowrap" };
const blurLabel: React.CSSProperties = {
  minWidth: 24, textAlign: "center", fontSize: 11,
  color: "var(--text)", fontVariantNumeric: "tabular-nums",
};
const fontInput: React.CSSProperties = {
  width: 40, height: 24, textAlign: "center", borderRadius: 5,
  background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 12,
};

function toolBtn(active: boolean): React.CSSProperties {
  return {
    minWidth: 26, height: 26, padding: "0 5px", borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text)",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  };
}

function modeBtn(active: boolean): React.CSSProperties {
  return {
    height: 24, padding: "0 8px", borderRadius: 5, fontSize: 11, fontWeight: 600,
    background: active ? "var(--accent)" : "rgba(255,255,255,0.06)",
    color: active ? "#fff" : "var(--text-dim)",
    border: active ? "none" : "1px solid var(--border)",
    whiteSpace: "nowrap", cursor: "pointer",
  };
}

const sliderStyle: React.CSSProperties = {
  width: 75, height: 4, accentColor: "var(--accent)", cursor: "pointer",
};

const flattenBtn: React.CSSProperties = {
  height: 24, padding: "0 9px", borderRadius: 5, fontSize: 11, fontWeight: 600,
  background: "rgba(239,68,68,0.15)", color: "#fca5a5",
  border: "1px solid rgba(239,68,68,0.35)", whiteSpace: "nowrap", cursor: "pointer",
};

