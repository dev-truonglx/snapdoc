import { useTranslation } from "react-i18next";
import type { UpdateInfo } from "../../lib/ipc";

interface UpdateBannerProps {
  updateReady: boolean;
  pendingUpdate: UpdateInfo | null;
  isUpdating: boolean;
  onRestart: () => void;
  onInstall: () => void;
  onDismiss: () => void;
}

export default function UpdateBanner({
  updateReady,
  pendingUpdate,
  isUpdating,
  onRestart,
  onInstall,
  onDismiss,
}: UpdateBannerProps) {
  const { t } = useTranslation();

  const isAvailable = updateReady || (pendingUpdate?.available ?? false);
  if (!isAvailable) return null;

  const version = pendingUpdate?.version ?? "";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "6px 14px",
        background: updateReady
          ? "linear-gradient(90deg, rgba(16, 185, 129, 0.16) 0%, rgba(16, 185, 129, 0.08) 100%)"
          : "linear-gradient(90deg, rgba(59, 130, 246, 0.16) 0%, rgba(59, 130, 246, 0.08) 100%)",
        borderBottom: `1px solid ${
          updateReady ? "rgba(16, 185, 129, 0.35)" : "rgba(59, 130, 246, 0.35)"
        }`,
        minHeight: 38,
        boxSizing: "border-box",
        zIndex: 20,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: updateReady ? "#10b981" : "#3b82f6",
            color: "#ffffff",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {updateReady ? "✓" : "↑"}
        </span>
        <span
          style={{
            fontSize: 12.5,
            color: "var(--text, #e4e4e7)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {updateReady
            ? t("editorUpdate.updateReadyMsg", { version })
            : t("editorUpdate.updateAvailableMsg", { version })}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {updateReady ? (
          <button
            onClick={onRestart}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 26,
              padding: "0 12px",
              background: "#059669",
              color: "#ffffff",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.2)",
              transition: "background 0.15s ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#047857")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#059669")}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L1.5 6.5M1.5 2v4.5H6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t("editorUpdate.restartNow")}</span>
          </button>
        ) : (
          <button
            onClick={onInstall}
            disabled={isUpdating}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 26,
              padding: "0 12px",
              background: isUpdating ? "rgba(37, 99, 235, 0.5)" : "#2563eb",
              color: "#ffffff",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: isUpdating ? "wait" : "pointer",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.2)",
              transition: "background 0.15s ease",
            }}
            onMouseEnter={(e) => {
              if (!isUpdating) e.currentTarget.style.background = "#1d4ed8";
            }}
            onMouseLeave={(e) => {
              if (!isUpdating) e.currentTarget.style.background = "#2563eb";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M8 2v8m0 0 3-3m-3 3-3-3M2 12v1.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V12"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{isUpdating ? t("editorUpdate.updating") : t("editorUpdate.updateNow")}</span>
          </button>
        )}

        <button
          onClick={onDismiss}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            background: "transparent",
            color: "var(--text-dim, #a1a1aa)",
            border: "none",
            borderRadius: 4,
            fontSize: 14,
            cursor: "pointer",
            padding: 0,
            lineHeight: 1,
            transition: "color 0.15s ease, background 0.15s ease",
          }}
          title={t("editorUpdate.dismiss")}
          aria-label={t("editorUpdate.dismiss")}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text, #ffffff)";
            e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-dim, #a1a1aa)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
