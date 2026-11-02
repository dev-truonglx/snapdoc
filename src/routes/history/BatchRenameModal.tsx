import { useState, useMemo, useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ipc, type HistoryItem } from "../../lib/ipc";
import { useHistory } from "./useHistoryStore";

type RenameMode = "template" | "replace" | "prefixSuffix";

interface Props {
  items: HistoryItem[];
  onClose: () => void;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}-${m}-${s}`;
}

export default function BatchRenameModal({ items, onClose }: Props) {
  const { t } = useTranslation();
  const batchRenameItems = useHistory((s) => s.batchRenameItems);

  const [mode, setMode] = useState<RenameMode>("template");
  const [template, setTemplate] = useState("Screenshot_{index:02}");
  const [startIndex, setStartIndex] = useState(1);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const templateInputRef = useRef<HTMLInputElement>(null);

  // Đóng khi bấm Escape, áp dụng khi nhấn Enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Tính toán trước danh sách tên mới theo thời gian thực (0ms)
  const previews = useMemo(() => {
    const unnamedLabel = t("history.unnamed");
    return items.map((item, idx) => {
      const originalTitle = (item.title ?? "").trim();
      const fallbackBase = originalTitle || unnamedLabel;
      let newTitle = "";

      if (mode === "template") {
        const curIdx = startIndex + idx;
        const pad2 = String(curIdx).padStart(2, "0");
        const pad3 = String(curIdx).padStart(3, "0");
        const plainIdx = String(curIdx);

        newTitle = template
          .replace(/{index:03}/g, pad3)
          .replace(/{index:02}/g, pad2)
          .replace(/{index:01}/g, plainIdx)
          .replace(/{index}/g, plainIdx)
          .replace(/{name}/g, fallbackBase)
          .replace(/{date}/g, formatDate(item.createdAt))
          .replace(/{time}/g, formatTime(item.createdAt))
          .replace(/{app}/g, item.sourceApp || "");
      } else if (mode === "replace") {
        if (!findText) {
          newTitle = originalTitle;
        } else {
          try {
            let replaced: string;
            if (matchCase) {
              replaced = fallbackBase.replaceAll(findText, replaceText);
            } else {
              const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
              replaced = fallbackBase.replace(regex, replaceText);
            }
            newTitle = replaced === fallbackBase ? originalTitle : replaced;
          } catch {
            newTitle = originalTitle;
          }
        }
      } else if (mode === "prefixSuffix") {
        if (!prefix && !suffix) {
          newTitle = originalTitle;
        } else {
          newTitle = `${prefix}${fallbackBase}${suffix}`;
        }
      }

      newTitle = newTitle.trim();
      const effectiveTitle = newTitle || originalTitle;
      const isChanged = effectiveTitle !== originalTitle && effectiveTitle.length > 0;
      return {
        id: item.id,
        item,
        rawNewTitle: effectiveTitle,
        oldTitle: originalTitle || unnamedLabel,
        newTitle: effectiveTitle || unnamedLabel,
        isChanged,
      };
    });
  }, [items, mode, template, startIndex, findText, replaceText, matchCase, prefix, suffix, t]);

  const insertTag = (tag: string) => {
    const input = templateInputRef.current;
    if (!input) {
      setTemplate((prev) => prev + tag);
      return;
    }
    const start = input.selectionStart ?? template.length;
    const end = input.selectionEnd ?? template.length;
    const nextVal = template.substring(0, start) + tag + template.substring(end);
    setTemplate(nextVal);
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(start + tag.length, start + tag.length);
    }, 0);
  };

  const changedPreviews = useMemo(() => previews.filter((p) => p.isChanged), [previews]);
  const hasAnyChange = changedPreviews.length > 0;

  const handleApply = async () => {
    if (busy || !hasAnyChange) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const entries = changedPreviews.map((p) => ({
        id: p.id,
        title: p.rawNewTitle,
      }));
      await ipc.batchRenameHistoryItems(entries);
      batchRenameItems(entries);
      onClose();
    } catch (err) {
      console.error("[BatchRename] Failed to apply:", err);
      setErrorMsg(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={header}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>✏️</span>
            <div>
              <div style={title}>{t("history.batchRename.modalTitle", { count: items.length })}</div>
              <div style={subtitle}>{t("history.batchRename.subtitle")}</div>
            </div>
          </div>
          <button style={closeBtn} onClick={onClose} aria-label={t("history.cancel")}>
            ✕
          </button>
        </div>

        {/* Tab chuyển mode */}
        <div style={tabRow}>
          <button
            style={mode === "template" ? activeTabBtn : tabBtn}
            onClick={() => setMode("template")}
          >
            {t("history.batchRename.tabTemplate")}
          </button>
          <button
            style={mode === "replace" ? activeTabBtn : tabBtn}
            onClick={() => setMode("replace")}
          >
            {t("history.batchRename.tabReplace")}
          </button>
          <button
            style={mode === "prefixSuffix" ? activeTabBtn : tabBtn}
            onClick={() => setMode("prefixSuffix")}
          >
            {t("history.batchRename.tabPrefixSuffix")}
          </button>
        </div>

        {/* Nội dung form theo mode */}
        <div style={formBody}>
          {mode === "template" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <label style={labelStyle}>{t("history.batchRename.templateLabel")}</label>
                <input
                  ref={templateInputRef}
                  style={inputStyle}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  placeholder="Screenshot_{index:02}"
                  onKeyDown={(e) => e.key === "Enter" && handleApply()}
                  autoFocus
                />
              </div>

              {/* Tags gợi ý */}
              <div style={tagsRow}>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("history.batchRename.insertTag")}:</span>
                {[
                  "{index:02}",
                  "{index:03}",
                  "{index}",
                  "{date}",
                  "{time}",
                  "{name}",
                  "{app}",
                ].map((tag) => (
                  <button
                    key={tag}
                    style={tagPill}
                    onClick={() => insertTag(tag)}
                    type="button"
                    title={t("history.batchRename.clickToInsertTag", { tag })}
                  >
                    +{tag}
                  </button>
                ))}
              </div>

              {/* Bắt đầu từ số */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                <label style={{ fontSize: 12, color: "var(--text)" }}>{t("history.batchRename.startAt")}:</label>
                <input
                  type="number"
                  min="0"
                  style={{ ...inputStyle, width: 70, textAlign: "center" }}
                  value={startIndex}
                  onChange={(e) => setStartIndex(Math.max(0, parseInt(e.target.value) || 0))}
                  onKeyDown={(e) => e.key === "Enter" && handleApply()}
                />
              </div>
            </div>
          )}

          {mode === "replace" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={labelStyle}>{t("history.batchRename.findLabel")}</label>
                <input
                  style={inputStyle}
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  placeholder={t("history.batchRename.findPlaceholder")}
                  onKeyDown={(e) => e.key === "Enter" && handleApply()}
                  autoFocus
                />
              </div>
              <div>
                <label style={labelStyle}>{t("history.batchRename.replaceWithLabel")}</label>
                <input
                  style={inputStyle}
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  placeholder={t("history.batchRename.replaceWithPlaceholder")}
                  onKeyDown={(e) => e.key === "Enter" && handleApply()}
                />
              </div>
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={matchCase}
                  onChange={(e) => setMatchCase(e.target.checked)}
                />
                <span>{t("history.batchRename.matchCase")}</span>
              </label>
            </div>
          )}

          {mode === "prefixSuffix" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={labelStyle}>{t("history.batchRename.prefixLabel")}</label>
                <input
                  style={inputStyle}
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="[ProjectA]_"
                  onKeyDown={(e) => e.key === "Enter" && handleApply()}
                  autoFocus
                />
              </div>
              <div>
                <label style={labelStyle}>{t("history.batchRename.suffixLabel")}</label>
                <input
                  style={inputStyle}
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value)}
                  placeholder="_v2"
                  onKeyDown={(e) => e.key === "Enter" && handleApply()}
                />
              </div>
            </div>
          )}
        </div>

        {/* Live Preview List */}
        <div style={previewSection}>
          <div style={previewHeader}>
            <span>{t("history.batchRename.livePreviewTitle")}</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("history.batchRename.previewItemsCount", { count: items.length })}
            </span>
          </div>

          <div style={previewList}>
            {previews.map((p) => (
              <div key={p.id} style={previewRow}>
                <img
                  src={convertFileSrc(p.item.thumbPath)}
                  alt=""
                  style={previewThumb}
                  loading="lazy"
                />
                <span style={p.isChanged ? oldTitleMuted : oldTitleNormal} title={p.oldTitle}>
                  {p.oldTitle}
                </span>
                <span style={arrowIcon}>➜</span>
                <span style={p.isChanged ? newTitleHighlighted : newTitleNormal} title={p.newTitle}>
                  {p.newTitle}
                </span>
              </div>
            ))}
          </div>
        </div>

        {errorMsg && <div style={errorBanner}>{errorMsg}</div>}

        {/* Footer actions */}
        <div style={footer}>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {t("history.batchRename.pressEnterHint")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={cancelBtn} onClick={onClose} disabled={busy}>
              {t("history.cancel")}
            </button>
            <button
              style={applyBtn}
              onClick={handleApply}
              disabled={busy || !hasAnyChange}
              title={!hasAnyChange ? t("history.batchRename.noChangesHint") : undefined}
            >
              {busy ? t("history.saving") : t("history.batchRename.applyButton", { count: changedPreviews.length || items.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.65)",
  backdropFilter: "blur(6px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const modal: React.CSSProperties = {
  width: 580,
  maxWidth: "100%",
  maxHeight: "90vh",
  background: "var(--bg-elevated, #18191f)",
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  borderRadius: 14,
  boxShadow: "0 25px 60px rgba(0,0,0,0.6)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 20px 14px",
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
};

const title: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "var(--text, #f1f5f9)",
};

const subtitle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim, #94a3b8)",
  marginTop: 2,
};

const closeBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 14,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const tabRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "12px 20px 0",
};

const tabBtn: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  border: "1px solid var(--border, rgba(255,255,255,0.08))",
  background: "rgba(255,255,255,0.03)",
  color: "var(--text-dim, #94a3b8)",
  fontSize: 12,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const activeTabBtn: React.CSSProperties = {
  ...tabBtn,
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  borderColor: "var(--accent, #3b82f6)",
  fontWeight: 600,
};

const formBody: React.CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--text, #cbd5e1)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 7,
  border: "1px solid var(--border, rgba(255,255,255,0.15))",
  background: "var(--bg, #101115)",
  color: "var(--text, #f1f5f9)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const tagsRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 4,
};

const tagPill: React.CSSProperties = {
  padding: "2px 7px",
  borderRadius: 5,
  border: "1px solid rgba(59, 130, 246, 0.4)",
  background: "rgba(59, 130, 246, 0.12)",
  color: "#93c5fd",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "monospace",
};

const checkboxLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--text, #e2e8f0)",
  cursor: "pointer",
  marginTop: 2,
};

const previewSection: React.CSSProperties = {
  padding: "14px 20px",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

const previewHeader: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text, #cbd5e1)",
  marginBottom: 8,
};

const previewList: React.CSSProperties = {
  maxHeight: 180,
  overflowY: "auto",
  border: "1px solid var(--border, rgba(255,255,255,0.08))",
  borderRadius: 8,
  background: "rgba(0,0,0,0.25)",
};

const previewRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.05)",
  fontSize: 12,
};

const previewThumb: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 4,
  objectFit: "cover",
  flexShrink: 0,
};

const oldTitleNormal: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--text-dim, #94a3b8)",
};

const oldTitleMuted: React.CSSProperties = {
  ...oldTitleNormal,
  opacity: 0.6,
  textDecoration: "line-through",
};

const arrowIcon: React.CSSProperties = {
  color: "var(--accent, #60a5fa)",
  flexShrink: 0,
  fontSize: 11,
};

const newTitleNormal: React.CSSProperties = {
  flex: 1.2,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--text, #f1f5f9)",
  fontWeight: 500,
};

const newTitleHighlighted: React.CSSProperties = {
  ...newTitleNormal,
  color: "#67e8f9",
  fontWeight: 600,
};

const errorBanner: React.CSSProperties = {
  margin: "0 20px 10px",
  padding: "8px 12px",
  borderRadius: 6,
  background: "rgba(239, 68, 68, 0.15)",
  border: "1px solid rgba(239, 68, 68, 0.35)",
  color: "#fca5a5",
  fontSize: 12,
};

const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 20px",
  borderTop: "1px solid var(--border, rgba(255,255,255,0.08))",
  background: "rgba(0,0,0,0.15)",
};

const cancelBtn: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 7,
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "transparent",
  color: "var(--text-dim, #94a3b8)",
  fontSize: 13,
  cursor: "pointer",
};

const applyBtn: React.CSSProperties = {
  padding: "7px 20px",
  borderRadius: 7,
  border: "none",
  background: "var(--accent, #3b82f6)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  transition: "opacity 0.15s ease",
};
