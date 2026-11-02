import React, { useEffect, useState, useTransition } from "react";
import { useTranslation } from "react-i18next";
import { loadImageElement, resampleImageCanvas, MIN_RESIZE_PX, MAX_RESIZE_PX } from "./resize";

export interface ResizeResult {
  dataUrl: string;
  width: number;
  height: number;
  scaleFactor: number;
  scaleAnnotations: boolean;
}

interface Props {
  initialWidth: number;
  initialHeight: number;
  scaleFactor: number;
  imageSrc: string;
  onApply: (result: ResizeResult) => void;
  onCancel: () => void;
}

type Unit = "px" | "pct";

export default function ResizeDialog({
  initialWidth,
  initialHeight,
  scaleFactor,
  imageSrc,
  onApply,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<Unit>("px");
  const [width, setWidth] = useState<number>(initialWidth);
  const [height, setHeight] = useState<number>(initialHeight);
  const [pct, setPct] = useState<number>(100);
  const [keepAspect, setKeepAspect] = useState<boolean>(true);
  const [scaleAnnotations, setScaleAnnotations] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const aspect = initialWidth / (initialHeight || 1);

  // Esc để huỷ, Enter để áp dụng
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Chỉ apply khi không đang focus vào nút Cancel
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "BUTTON" && target.innerText === t("resizeDialog.cancel")) return;
        e.preventDefault();
        handleApply();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [width, height, scaleAnnotations, busy]);

  const handleWidthChange = (valStr: string) => {
    const val = parseInt(valStr, 10);
    if (isNaN(val)) return;
    const clampedW = Math.max(1, Math.min(MAX_RESIZE_PX, val));
    setWidth(clampedW);
    setPct(Math.round((clampedW / initialWidth) * 100));
    if (keepAspect) {
      setHeight(Math.max(1, Math.round(clampedW / aspect)));
    }
  };

  const handleHeightChange = (valStr: string) => {
    const val = parseInt(valStr, 10);
    if (isNaN(val)) return;
    const clampedH = Math.max(1, Math.min(MAX_RESIZE_PX, val));
    setHeight(clampedH);
    setPct(Math.round((clampedH / initialHeight) * 100));
    if (keepAspect) {
      setWidth(Math.max(1, Math.round(clampedH * aspect)));
    }
  };

  const handlePctChange = (valStr: string) => {
    const val = parseInt(valStr, 10);
    if (isNaN(val)) return;
    const clampedPct = Math.max(1, Math.min(1000, val));
    setPct(clampedPct);
    const newW = Math.max(1, Math.round((initialWidth * clampedPct) / 100));
    const newH = Math.max(1, Math.round((initialHeight * clampedPct) / 100));
    setWidth(newW);
    setHeight(newH);
  };

  const applyPresetPct = (p: number) => {
    setPct(p);
    const newW = Math.max(1, Math.round((initialWidth * p) / 100));
    const newH = Math.max(1, Math.round((initialHeight * p) / 100));
    setWidth(newW);
    setHeight(newH);
  };

  const applyPresetWidth = (targetW: number) => {
    setWidth(targetW);
    setPct(Math.round((targetW / initialWidth) * 100));
    if (keepAspect) {
      setHeight(Math.max(1, Math.round(targetW / aspect)));
    }
  };

  const handleApply = async () => {
    if (busy) return;
    const finalW = Math.max(MIN_RESIZE_PX, Math.min(MAX_RESIZE_PX, Math.round(width)));
    const finalH = Math.max(MIN_RESIZE_PX, Math.min(MAX_RESIZE_PX, Math.round(height)));

    if (finalW === initialWidth && finalH === initialHeight) {
      onCancel();
      return;
    }

    setBusy(true);
    setError(null);

    startTransition(async () => {
      try {
        const img = await loadImageElement(imageSrc);
        const resizedDataUrl = resampleImageCanvas(img, finalW, finalH, "high");

        // Nếu thu nhỏ tương đương giảm scaleFactor (vd Retina 2x -> 1x khi giảm 50%)
        const avgScale = (finalW / initialWidth + finalH / initialHeight) / 2;
        const newScaleFactor = Math.max(1, +(scaleFactor * avgScale).toFixed(2));

        onApply({
          dataUrl: resizedDataUrl,
          width: finalW,
          height: finalH,
          scaleFactor: newScaleFactor,
          scaleAnnotations,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    });
  };

  const isRetina = scaleFactor >= 1.5;
  const currentRatioPct = Math.round((width / initialWidth) * 100);

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={header}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📐</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text, #f1f5f9)" }}>
              {t("resizeDialog.title", "Đổi kích thước ảnh")}
            </span>
          </div>
          <button
            onClick={onCancel}
            style={closeBtn}
            title={t("resizeDialog.close", "Đóng (Esc)")}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Thông số kích thước: Gốc vs Mới */}
        <div style={sizeSummaryBox}>
          <div style={sizeSummaryCol}>
            <span style={sizeSummaryLabel}>{t("resizeDialog.originalSize", "Kích thước gốc")}</span>
            <div style={sizeSummaryVal}>
              {initialWidth} × {initialHeight} px
              {isRetina && <span style={retinaBadge}>Retina {scaleFactor}×</span>}
            </div>
          </div>
          <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 16 }}>→</div>
          <div style={sizeSummaryCol}>
            <span style={sizeSummaryLabel}>{t("resizeDialog.newSize", "Kích thước mới")}</span>
            <div style={sizeSummaryVal}>
              <strong style={{ color: "var(--accent, #3b82f6)" }}>
                {width} × {height} px
              </strong>
              <span style={pctBadge}>{currentRatioPct}%</span>
            </div>
          </div>
        </div>

        {/* Presets 1-Click */}
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>{t("resizeDialog.quickPresets", "Tùy chọn nhanh")}</div>
          <div style={presetRow}>
            {/* Nếu là ảnh Retina (2x), ưu tiên hiển thị preset 50% nổi bật */}
            {isRetina && (
              <button
                type="button"
                onClick={() => applyPresetPct(50)}
                style={{
                  ...presetBtn,
                  background: pct === 50 ? "rgba(59,130,246,0.35)" : "rgba(59,130,246,0.15)",
                  borderColor: "rgba(59,130,246,0.5)",
                  color: "#93c5fd",
                  fontWeight: 700,
                }}
                title={t("resizeDialog.retinaPresetHint", "Thu nhỏ 2× về 1× cho ảnh Retina")}
              >
                ⚡ 50% (1× Retina)
              </button>
            )}
            <button
              type="button"
              onClick={() => applyPresetPct(50)}
              style={{ ...presetBtn, ...(pct === 50 && !isRetina ? presetBtnActive : null) }}
            >
              50%
            </button>
            <button
              type="button"
              onClick={() => applyPresetPct(75)}
              style={{ ...presetBtn, ...(pct === 75 ? presetBtnActive : null) }}
            >
              75%
            </button>
            <button
              type="button"
              onClick={() => applyPresetPct(100)}
              style={{ ...presetBtn, ...(pct === 100 ? presetBtnActive : null) }}
            >
              100% ({t("resizeDialog.presetOriginal", "Gốc")})
            </button>
            <button
              type="button"
              onClick={() => applyPresetPct(150)}
              style={{ ...presetBtn, ...(pct === 150 ? presetBtnActive : null) }}
            >
              150%
            </button>
            <button
              type="button"
              onClick={() => applyPresetPct(200)}
              style={{ ...presetBtn, ...(pct === 200 ? presetBtnActive : null) }}
            >
              200%
            </button>
          </div>

          <div style={{ ...presetRow, marginTop: 6 }}>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", alignSelf: "center", marginRight: 4 }}>
              {t("resizeDialog.presetWidth", "Bề rộng:")}
            </span>
            <button
              type="button"
              onClick={() => applyPresetWidth(800)}
              style={{ ...presetBtn, ...(width === 800 ? presetBtnActive : null) }}
            >
              800 px
            </button>
            <button
              type="button"
              onClick={() => applyPresetWidth(1200)}
              style={{ ...presetBtn, ...(width === 1200 ? presetBtnActive : null) }}
            >
              1200 px
            </button>
            <button
              type="button"
              onClick={() => applyPresetWidth(1920)}
              style={{ ...presetBtn, ...(width === 1920 ? presetBtnActive : null) }}
            >
              1920 px
            </button>
          </div>
        </div>

        {/* Inputs form */}
        <div style={formBox}>
          {/* Tabs đơn vị: Px / % */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={sectionLabel}>{t("resizeDialog.customDimensions", "Kích thước tùy chỉnh")}</span>
            <div style={unitToggleContainer}>
              <button
                type="button"
                onClick={() => setUnit("px")}
                style={{ ...unitTabBtn, ...(unit === "px" ? unitTabBtnActive : null) }}
              >
                Pixels (px)
              </button>
              <button
                type="button"
                onClick={() => setUnit("pct")}
                style={{ ...unitTabBtn, ...(unit === "pct" ? unitTabBtnActive : null) }}
              >
                {t("resizeDialog.unitPercent", "Phần trăm (%)")}
              </button>
            </div>
          </div>

          {unit === "px" ? (
            <div style={inputRow}>
              {/* Width */}
              <div style={inputGroup}>
                <label style={inputLabel}>{t("resizeDialog.width", "Chiều rộng")}</label>
                <div style={inputWrapper}>
                  <input
                    type="number"
                    min={MIN_RESIZE_PX}
                    max={MAX_RESIZE_PX}
                    value={width}
                    onChange={(e) => handleWidthChange(e.target.value)}
                    style={numberInput}
                    autoFocus
                  />
                  <span style={inputUnitSuffix}>px</span>
                </div>
              </div>

              {/* Lock Aspect Ratio Button */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setKeepAspect((v) => !v)}
                  style={{
                    ...lockAspectBtn,
                    background: keepAspect ? "rgba(59,130,246,0.2)" : "rgba(255,255,255,0.06)",
                    borderColor: keepAspect ? "rgba(59,130,246,0.5)" : "rgba(255,255,255,0.15)",
                    color: keepAspect ? "#60a5fa" : "rgba(255,255,255,0.4)",
                  }}
                  title={
                    keepAspect
                      ? t("resizeDialog.aspectLocked", "Đang khóa tỉ lệ khung hình (Click để mở khóa)")
                      : t("resizeDialog.aspectUnlocked", "Đang mở khóa tỉ lệ (Click để khóa)")
                  }
                >
                  {keepAspect ? (
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5A1.5 1.5 0 0 1 13.5 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2.5 13.5v-5A1.5 1.5 0 0 1 4 7h.5zm1.5-2a2 2 0 1 1 4 0v2h-4V5z"/>
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M11 5a3.5 3.5 0 0 0-7 0v2H3.5A1.5 1.5 0 0 0 2 8.5v5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-5a1.5 1.5 0 0 0-1.5-1.5H11V5zm-1.5 2h-3V5a1.5 1.5 0 0 1 3 0v2z"/>
                    </svg>
                  )}
                </button>
              </div>

              {/* Height */}
              <div style={inputGroup}>
                <label style={inputLabel}>{t("resizeDialog.height", "Chiều cao")}</label>
                <div style={inputWrapper}>
                  <input
                    type="number"
                    min={MIN_RESIZE_PX}
                    max={MAX_RESIZE_PX}
                    value={height}
                    onChange={(e) => handleHeightChange(e.target.value)}
                    style={numberInput}
                  />
                  <span style={inputUnitSuffix}>px</span>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={inputLabel}>{t("resizeDialog.scalePercent", "Tỉ lệ phần trăm")}</label>
                <div style={inputWrapper}>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={pct}
                    onChange={(e) => handlePctChange(e.target.value)}
                    style={numberInput}
                    autoFocus
                  />
                  <span style={inputUnitSuffix}>%</span>
                </div>
              </div>
              <div style={{ flex: 1.4, fontSize: 12, color: "rgba(255,255,255,0.6)", paddingTop: 18 }}>
                = {width} × {height} px
              </div>
            </div>
          )}

          {/* Scale annotations checkbox */}
          <label style={checkboxLabel}>
            <input
              type="checkbox"
              checked={scaleAnnotations}
              onChange={(e) => setScaleAnnotations(e.target.checked)}
              style={checkbox}
            />
            <span style={{ fontSize: 12, color: "var(--text, #e2e8f0)" }}>
              {t("resizeDialog.scaleAnnotations", "Tỉ lệ lại các chú thích đã vẽ (mũi tên, chữ, khung...)")}
            </span>
          </label>
        </div>

        {error && <div style={errorBanner}>{error}</div>}

        {/* Actions */}
        <div style={actionsRow}>
          <button type="button" onClick={onCancel} disabled={busy} style={cancelBtn}>
            {t("resizeDialog.cancel", "Hủy")}
          </button>
          <button type="button" onClick={handleApply} disabled={busy} style={applyBtn}>
            {busy ? t("resizeDialog.applying", "Đang xử lý…") : t("resizeDialog.apply", "Áp dụng")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Styles */
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.65)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialog: React.CSSProperties = {
  background: "linear-gradient(145deg, #1c1d24, #14151a)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 12,
  padding: "18px 20px",
  width: 440,
  maxWidth: "92vw",
  boxShadow: "0 20px 50px rgba(0, 0, 0, 0.7), 0 0 30px rgba(59, 130, 246, 0.1)",
  color: "#e2e8f0",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 14,
};

const closeBtn: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "rgba(255, 255, 255, 0.6)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
};

const sizeSummaryBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px",
  borderRadius: 8,
  background: "rgba(255, 255, 255, 0.04)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  marginBottom: 14,
};

const sizeSummaryCol: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const sizeSummaryLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "rgba(255, 255, 255, 0.45)",
};

const sizeSummaryVal: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const retinaBadge: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "rgba(59, 130, 246, 0.2)",
  color: "#93c5fd",
  fontWeight: 700,
};

const pctBadge: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "rgba(255, 255, 255, 0.1)",
  color: "#e2e8f0",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(255, 255, 255, 0.65)",
  marginBottom: 6,
};

const presetRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const presetBtn: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 500,
  background: "rgba(255, 255, 255, 0.06)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  color: "rgba(255, 255, 255, 0.85)",
  cursor: "pointer",
  transition: "all 0.12s",
};

const presetBtnActive: React.CSSProperties = {
  background: "rgba(59, 130, 246, 0.25)",
  borderColor: "#3b82f6",
  color: "#93c5fd",
  fontWeight: 600,
};

const formBox: React.CSSProperties = {
  padding: "12px",
  borderRadius: 8,
  background: "rgba(0, 0, 0, 0.2)",
  border: "1px solid rgba(255, 255, 255, 0.06)",
  marginBottom: 16,
};

const unitToggleContainer: React.CSSProperties = {
  display: "flex",
  borderRadius: 6,
  background: "rgba(255, 255, 255, 0.06)",
  padding: 2,
};

const unitTabBtn: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: "rgba(255, 255, 255, 0.6)",
  fontSize: 11,
  fontWeight: 500,
  cursor: "pointer",
};

const unitTabBtnActive: React.CSSProperties = {
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontWeight: 600,
};

const inputRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-end",
};

const inputGroup: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const inputLabel: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255, 255, 255, 0.6)",
};

const inputWrapper: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
};

const numberInput: React.CSSProperties = {
  width: "100%",
  height: 32,
  padding: "0 28px 0 10px",
  borderRadius: 6,
  background: "#121317",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  color: "#f8fafc",
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  outline: "none",
};

const inputUnitSuffix: React.CSSProperties = {
  position: "absolute",
  right: 8,
  fontSize: 11,
  color: "rgba(255, 255, 255, 0.4)",
  pointerEvents: "none",
};

const lockAspectBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 6,
  border: "1px solid",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  marginBottom: 0,
};

const checkboxLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 12,
  cursor: "pointer",
  userSelect: "none",
};

const checkbox: React.CSSProperties = {
  accentColor: "#3b82f6",
  width: 14,
  height: 14,
  cursor: "pointer",
};

const errorBanner: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  background: "rgba(239, 68, 68, 0.15)",
  border: "1px solid rgba(239, 68, 68, 0.3)",
  color: "#fca5a5",
  fontSize: 12,
  marginBottom: 12,
};

const actionsRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const cancelBtn: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "transparent",
  color: "rgba(255, 255, 255, 0.75)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const applyBtn: React.CSSProperties = {
  padding: "6px 18px",
  borderRadius: 6,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 2px 8px rgba(59, 130, 246, 0.35)",
};
