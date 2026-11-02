import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  ipc,
  type ExportHistoryImagesResult,
  type ExportProgressPayload,
} from "../../lib/ipc";

interface Props {
  imageIds: string[];
  targetDir: string;
  onClose: () => void;
}

export default function ExportProgressModal({ imageIds, targetDir, onClose }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"exporting" | "completed" | "error">("exporting");
  const [progress, setProgress] = useState<ExportProgressPayload>({
    current: 0,
    total: imageIds.length,
    filename: "",
  });
  const [result, setResult] = useState<ExportHistoryImagesResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Đăng ký listener tiến độ TRƯỚC khi kích hoạt tiến trình export để tránh hụt sự kiện đầu tiên
  useEffect(() => {
    let alive = true;
    let unlistenFn: (() => void) | null = null;

    const run = async () => {
      try {
        const unlisten = await listen<ExportProgressPayload>("history:export-progress", (event) => {
          if (alive) setProgress(event.payload);
        });
        if (!alive) {
          unlisten();
          return;
        }
        unlistenFn = unlisten;

        const res = await ipc.exportHistoryImages(imageIds, targetDir);
        if (!alive) return;
        setResult(res);
        setStatus("completed");
      } catch (err) {
        if (!alive) return;
        setErrorMsg(typeof err === "string" ? err : String(err));
        setStatus("error");
      }
    };

    void run();

    return () => {
      alive = false;
      unlistenFn?.();
    };
  }, [imageIds, targetDir]);

  const percent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;

  const handleOpenFolder = async () => {
    const path = result?.firstExportedPath || result?.targetDir || targetDir;
    try {
      await ipc.revealPath(path);
    } catch {
      // Best-effort
    }
    onClose();
  };

  return (
    <div style={backdropStyle} onClick={status !== "exporting" ? onClose : undefined}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Nút đóng ở góc trên khi đã xong hoặc lỗi */}
        {status !== "exporting" && (
          <button style={closeBtnStyle} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        )}

        {status === "exporting" && (
          <>
            <div style={headerStyle}>
              <div style={iconBoxStyle}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={titleStyle}>{t("history.exportProgressTitle")}</span>
                <span style={subTitleStyle}>
                  {progress.filename
                    ? t("history.exportProcessingFile", { filename: progress.filename })
                    : t("common.loading")}
                </span>
              </div>
            </div>

            <div style={bodyStyle}>
              <div style={progressMetaStyle}>
                <span>
                  {t("history.exportProgressCount", {
                    current: progress.current,
                    total: progress.total,
                  })}
                </span>
                <span style={{ fontWeight: 600, color: "var(--accent)" }}>{percent}%</span>
              </div>

              <div style={progressTrackStyle}>
                <div style={{ ...progressFillStyle, width: `${Math.max(4, percent)}%` }} />
              </div>

              <div style={targetDirBox}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                  {t("history.exportSaveDir")}
                </span>
                <span style={targetDirText} title={targetDir}>
                  📁 {targetDir}
                </span>
              </div>
            </div>

            <div style={footerStyle}>
              <button style={busyBtnStyle} disabled>
                {t("history.exporting")}
              </button>
            </div>
          </>
        )}

        {status === "completed" && (
          <>
            <div style={{ ...headerStyle, alignItems: "center", flexDirection: "column", textAlign: "center" }}>
              <div style={successIconBox}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span style={{ ...titleStyle, fontSize: 16 }}>{t("history.exportCompletedTitle")}</span>
              <span style={{ fontSize: 13, color: "var(--text)", marginTop: 4 }}>
                {t("history.exportSuccessSummary", { count: result?.exportedCount ?? progress.total })}
              </span>
              {result && result.skippedCount > 0 && (
                <span style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
                  {t("history.exportSkippedVideosNotice", { count: result.skippedCount })}
                </span>
              )}
            </div>

            <div style={bodyStyle}>
              <div style={targetDirBox}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                  {t("history.exportSaveDir")}
                </span>
                <span style={targetDirText} title={result?.targetDir || targetDir}>
                  📁 {result?.targetDir || targetDir}
                </span>
              </div>
            </div>

            <div style={{ ...footerStyle, justifyContent: "flex-end" }}>
              <button style={secondaryBtnStyle} onClick={onClose}>
                {t("history.exportClose")}
              </button>
              <button style={primaryBtnStyle} onClick={handleOpenFolder}>
                📁 {t("history.exportOpenFolder")}
              </button>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div style={{ ...headerStyle, alignItems: "center", flexDirection: "column", textAlign: "center" }}>
              <div style={errorIconBox}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <span style={{ ...titleStyle, fontSize: 16 }}>{t("history.exportFailed")}</span>
              <span style={{ fontSize: 12, color: "#fca5a5", marginTop: 6, wordBreak: "break-word" }}>
                {errorMsg}
              </span>
            </div>

            <div style={{ ...footerStyle, justifyContent: "flex-end" }}>
              <button style={secondaryBtnStyle} onClick={onClose}>
                {t("history.exportClose")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1200,
  background: "rgba(0, 0, 0, 0.65)",
  backdropFilter: "blur(6px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};

const modalStyle: React.CSSProperties = {
  position: "relative",
  width: 440,
  maxWidth: "92vw",
  background: "var(--bg-elevated, #1c1c22)",
  border: "1px solid var(--border, rgba(255, 255, 255, 0.12))",
  borderRadius: 12,
  padding: "20px 22px",
  boxShadow: "0 20px 48px rgba(0, 0, 0, 0.6)",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  color: "var(--text, #f3f4f6)",
};

const closeBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  width: 26,
  height: 26,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "var(--text-dim, #9ca3af)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
};

const iconBoxStyle: React.CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 8,
  background: "rgba(59, 130, 246, 0.15)",
  color: "var(--accent, #3b82f6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const successIconBox: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 24,
  background: "rgba(34, 197, 94, 0.15)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 6,
};

const errorIconBox: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 24,
  background: "rgba(239, 68, 68, 0.15)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 6,
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--text, #fff)",
};

const subTitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim, #9ca3af)",
  maxWidth: 340,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const progressMetaStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 12,
  color: "var(--text-dim, #9ca3af)",
};

const progressTrackStyle: React.CSSProperties = {
  height: 8,
  background: "#22222c",
  borderRadius: 4,
  overflow: "hidden",
};

const progressFillStyle: React.CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg, var(--accent, #3b82f6), #60a5fa)",
  borderRadius: 4,
  transition: "width 0.15s ease",
};

const targetDirBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  background: "rgba(0, 0, 0, 0.25)",
  borderRadius: 6,
  border: "1px solid var(--border, rgba(255, 255, 255, 0.08))",
  fontSize: 12,
};

const targetDirText: React.CSSProperties = {
  color: "var(--text, #f3f4f6)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  direction: "rtl",
  textAlign: "left",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 4,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 7,
  background: "var(--accent, #3b82f6)",
  color: "var(--accent-text, #fff)",
  fontSize: 13,
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 7,
  border: "1px solid var(--border, rgba(255, 255, 255, 0.15))",
  background: "transparent",
  color: "var(--text, #f3f4f6)",
  fontSize: 13,
  cursor: "pointer",
};

const busyBtnStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 14px",
  borderRadius: 7,
  background: "rgba(255, 255, 255, 0.08)",
  color: "var(--text-dim, #9ca3af)",
  fontSize: 13,
  border: "none",
  cursor: "not-allowed",
};
