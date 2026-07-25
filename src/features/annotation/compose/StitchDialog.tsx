import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../../../lib/ipc";
import { uid } from "../model";
import {
  composeStitch,
  type StitchAlign,
  type StitchDirection,
  type StitchResult,
} from "./stitch";

interface Item {
  id: string;
  src: string;
}

interface Props {
  /** Ảnh hiện tại trên editor (đã flatten) — luôn là phần tử đầu khi mở. */
  initialImage: string;
  onApply: (result: StitchResult) => void;
  onCancel: () => void;
}

const BG_SWATCHES = ["#ffffff", "#000000", "#161619", "transparent"] as const;

export default function StitchDialog({ initialImage, onApply, onCancel }: Props) {
  const { t } = useTranslation();
  const initialIdRef = useRef(uid());
  const [items, setItems] = useState<Item[]>([
    { id: initialIdRef.current, src: initialImage },
  ]);
  const [direction, setDirection] = useState<StitchDirection>("vertical");
  const [align, setAlign] = useState<StitchAlign>("center");
  const [gap, setGap] = useState(0);
  const [background, setBackground] = useState<string>("#ffffff");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Recompute preview mỗi khi danh sách / tuỳ chọn đổi. Guard chống race.
  useEffect(() => {
    let cancelled = false;
    if (items.length === 0) {
      setPreviewUrl(null);
      setDims(null);
      return;
    }
    composeStitch(items.map((i) => i.src), { direction, align, gap, background })
      .then((r) => {
        if (cancelled) return;
        setPreviewUrl(r.dataUrl);
        setDims({ w: r.width, h: r.height });
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [items, direction, align, gap, background]);

  // Esc để huỷ.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Dán ảnh từ clipboard (Cmd/Ctrl+V) → thêm vào cuối danh sách.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length === 0) return;
      e.preventDefault();
      Promise.all(files.map((f) => fileToDataUrl(f, t("stitchDialog.cannotReadFile")))).then((urls) => {
        setItems((prev) => [...prev, ...urls.map((src) => ({ id: uid(), src }))]);
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const addImages = async () => {
    setAdding(true);
    try {
      const urls = await ipc.openFiles();
      if (urls.length) {
        setItems((prev) => [...prev, ...urls.map((src) => ({ id: uid(), src }))]);
      }
    } catch (e) {
      setError(t("stitchDialog.openImageError", { error: e }));
    } finally {
      setAdding(false);
    }
  };

  const removeItem = (id: string) =>
    setItems((prev) => prev.filter((it) => it.id !== id));

  const move = (id: string, dir: -1 | 1) =>
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.id === id);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      return copy;
    });

  const apply = async () => {
    if (items.length < 2) {
      setError(t("stitch.minImages"));
      return;
    }
    setBusy(true);
    try {
      const result = await composeStitch(items.map((i) => i.src), {
        direction,
        align,
        gap,
        background,
      });
      onApply(result);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const vertical = direction === "vertical";
  const alignLabels: Record<StitchAlign, string> = vertical
    ? { start: t("stitchDialog.left"), center: t("stitchDialog.center"), end: t("stitchDialog.right") }
    : { start: t("stitchDialog.top"), center: t("stitchDialog.center"), end: t("stitchDialog.bottom") };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text, #e2e8f0)" }}>
            {t("stitchDialog.title")}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-dim, #94a3b8)" }}>
            {t("stitchDialog.imageCount", { count: items.length })}
            {dims && ` · ${dims.w} × ${dims.h}px`}
          </span>
        </div>

        <div style={body}>
          {/* Cột trái: danh sách ảnh */}
          <div style={listCol}>
            <div style={listScroll}>
              {items.map((it, i) => (
                <div key={it.id} style={row}>
                  <span style={rowIndex}>{i + 1}</span>
                  <img src={it.src} alt="" style={thumb} />
                  {it.id === initialIdRef.current && <span style={badge}>{t("stitchDialog.current")}</span>}
                  <span style={{ flex: 1 }} />
                  <button style={iconBtn} title={t("stitchDialog.moveUp")} disabled={i === 0}
                    onClick={() => move(it.id, -1)}>↑</button>
                  <button style={iconBtn} title={t("stitchDialog.moveDown")} disabled={i === items.length - 1}
                    onClick={() => move(it.id, 1)}>↓</button>
                  <button style={iconBtn} title={t("stitchDialog.delete")} disabled={items.length <= 1}
                    onClick={() => removeItem(it.id)}>✕</button>
                </div>
              ))}
            </div>
            <button style={addBtn} onClick={addImages} disabled={adding}>
              {adding ? t("stitchDialog.opening") : t("stitchDialog.addImages")}
            </button>
            <span style={hint}>{t("stitchDialog.pasteHint")}</span>
          </div>

          {/* Cột phải: preview */}
          <div style={previewCol}>
            {previewUrl ? (
              <img src={previewUrl} alt="preview" style={previewImg} />
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-dim, #94a3b8)" }}>
                {t("stitchDialog.noPreview")}
              </span>
            )}
          </div>
        </div>

        {/* Tuỳ chọn */}
        <div style={optionsRow}>
          <div style={optGroup}>
            <span style={optLabel}>{t("stitchDialog.direction")}</span>
            <Seg active={vertical} onClick={() => setDirection("vertical")}>{t("stitch.vertical")}</Seg>
            <Seg active={!vertical} onClick={() => setDirection("horizontal")}>{t("stitch.horizontal")}</Seg>
          </div>

          <div style={optGroup}>
            <span style={optLabel}>{t("stitchDialog.alignment")}</span>
            {(["start", "center", "end"] as StitchAlign[]).map((a) => (
              <Seg key={a} active={align === a} onClick={() => setAlign(a)}>
                {alignLabels[a]}
              </Seg>
            ))}
          </div>

          <div style={optGroup}>
            <span style={optLabel}>{t("stitchDialog.gap")}</span>
            <input type="number" min={0} max={400} value={gap}
              onChange={(e) => setGap(Math.max(0, Math.min(400, Number(e.target.value) || 0)))}
              style={gapInput} />
            <span style={{ fontSize: 11, color: "var(--text-dim, #94a3b8)" }}>px</span>
          </div>

          <div style={optGroup}>
            <span style={optLabel}>{t("stitchDialog.background")}</span>
            {BG_SWATCHES.map((c) => (
              <button key={c} title={c === "transparent" ? t("stitchDialog.transparent") : c}
                onClick={() => setBackground(c)}
                style={{
                  width: 22, height: 22, borderRadius: 4, flexShrink: 0,
                  background: c === "transparent"
                    ? "repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 50%/8px 8px"
                    : c,
                  border: background === c ? "2px solid #fff" : "1px solid var(--border, rgba(255,255,255,0.2))",
                  boxShadow: background === c ? "0 0 0 1.5px var(--accent, #3b82f6)" : "none",
                }} />
            ))}
          </div>
        </div>

        {error && <p style={errStyle}>{error}</p>}

        <div style={actions}>
          <button style={cancelBtn} onClick={onCancel}>{t("stitchDialog.cancel")}</button>
          <button style={applyBtn} onClick={apply} disabled={busy || items.length < 2}>
            {busy ? t("stitchDialog.stitching") : t("stitchDialog.stitch")}
          </button>
        </div>
      </div>
    </div>
  );
}

function fileToDataUrl(file: File, errorMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error(errorMessage));
    r.readAsDataURL(file);
  });
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      height: 28, padding: "0 11px", borderRadius: 6, fontSize: 12, fontWeight: 600,
      background: active ? "var(--accent, #3b82f6)" : "rgba(255,255,255,0.06)",
      color: active ? "#fff" : "var(--text-dim, #94a3b8)",
      border: active ? "none" : "1px solid var(--border, rgba(255,255,255,0.12))",
      cursor: "pointer", whiteSpace: "nowrap",
    }}>{children}</button>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};
const dialog: React.CSSProperties = {
  background: "var(--bg-elevated, #1e1e24)",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 12, padding: "18px 20px", width: 640, maxWidth: "94vw",
  boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14,
};
const body: React.CSSProperties = { display: "flex", gap: 14, height: 300 };
const listCol: React.CSSProperties = {
  width: 260, display: "flex", flexDirection: "column", gap: 8, flexShrink: 0,
};
const listScroll: React.CSSProperties = {
  flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6,
  border: "1px solid var(--border, rgba(255,255,255,0.1))", borderRadius: 8, padding: 6,
};
const row: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  background: "rgba(255,255,255,0.04)", borderRadius: 6, padding: "4px 6px",
};
const rowIndex: React.CSSProperties = {
  fontSize: 11, color: "var(--text-dim, #94a3b8)", width: 14, textAlign: "center",
  fontVariantNumeric: "tabular-nums",
};
const thumb: React.CSSProperties = {
  width: 48, height: 34, objectFit: "cover", borderRadius: 4,
  background: "#000", flexShrink: 0,
};
const badge: React.CSSProperties = {
  fontSize: 10, color: "var(--accent, #93c5fd)", border: "1px solid var(--accent, #3b82f6)",
  borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap",
};
const iconBtn: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 5, fontSize: 12,
  background: "transparent", color: "var(--text, #e2e8f0)",
  border: "1px solid var(--border, rgba(255,255,255,0.12))", cursor: "pointer", flexShrink: 0,
};
const addBtn: React.CSSProperties = {
  height: 32, borderRadius: 7, fontSize: 13, fontWeight: 600,
  background: "rgba(255,255,255,0.06)", color: "var(--text, #e2e8f0)",
  border: "1px dashed var(--border, rgba(255,255,255,0.25))", cursor: "pointer",
};
const hint: React.CSSProperties = { fontSize: 11, color: "var(--text-dim, #94a3b8)", textAlign: "center" };
const previewCol: React.CSSProperties = {
  flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
  borderRadius: 8, padding: 8, minWidth: 0,
  background: "repeating-conic-gradient(#2a2a30 0% 25%, #222228 0% 50%) 50%/16px 16px",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
};
const previewImg: React.CSSProperties = {
  maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
  boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
};
const optionsRow: React.CSSProperties = {
  display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", marginTop: 14,
};
const optGroup: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const optLabel: React.CSSProperties = {
  fontSize: 11, color: "var(--text-dim, #94a3b8)", marginRight: 2,
};
const gapInput: React.CSSProperties = {
  width: 52, height: 28, textAlign: "center", borderRadius: 6,
  background: "var(--bg, #14141a)", color: "var(--text, #e2e8f0)",
  border: "1px solid var(--border, rgba(255,255,255,0.15))", fontSize: 13,
};
const errStyle: React.CSSProperties = {
  fontSize: 12, color: "#fca5a5", margin: "10px 0 0",
};
const actions: React.CSSProperties = {
  display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16,
};
const cancelBtn: React.CSSProperties = {
  padding: "7px 18px", borderRadius: 7, border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "transparent", color: "var(--text-dim, #94a3b8)", fontSize: 13, cursor: "pointer",
};
const applyBtn: React.CSSProperties = {
  padding: "7px 20px", borderRadius: 7, border: "none",
  background: "var(--accent, #3b82f6)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
};
