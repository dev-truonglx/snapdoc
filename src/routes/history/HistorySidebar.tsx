import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";
import { useHistory, type ActiveNav } from "./useHistoryStore";
import { fmtSize } from "./formatUtils";

interface Props {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function HistorySidebar({ collapsed }: Props) {
  const { t, i18n } = useTranslation();
  const activeNav = useHistory((s) => s.activeNav);
  const setActiveNav = useHistory((s) => s.setActiveNav);
  const counts = useHistory((s) => s.counts);
  const refreshCounts = useHistory((s) => s.refreshCounts);

  const [saveDir, setSaveDir] = useState<string>("");
  const [appVersion, setAppVersion] = useState<string>("");

  const currentLang = i18n.language?.startsWith("vi") ? "vi" : "en";

  const handleLanguageChange = async (lang: "vi" | "en") => {
    if (currentLang === lang) return;
    i18n.changeLanguage(lang);
    localStorage.setItem("app-language", lang);
    const s = await ipc.getSettings().catch(() => null);
    if (s) {
      await ipc.setSettings({ ...s, language: lang }).catch(() => {});
    }
  };

  useEffect(() => {
    refreshCounts();
    ipc.getSettings().then(async (s) => {
      const dir = s?.saveDir || (await ipc.defaultSaveDir().catch(() => ""));
      setSaveDir(dir);
    }).catch(() => {});

    if ("__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/app").then(({ getVersion }) =>
        getVersion().then(setAppVersion).catch(() => {})
      );
    }
  }, [refreshCounts]);

  const handleOpenFolder = async () => {
    if (!saveDir) return;
    try {
      await ipc.revealPath(saveDir);
    } catch {
      // Best-effort
    }
  };

  const NAV_ITEMS: { id: ActiveNav; label: string; icon: string; badge: number }[] = [
    { id: "all", label: t("history.navAll"), icon: "🖼️", badge: counts.all },
    { id: "images", label: t("history.navImages"), icon: "📸", badge: counts.images },
    { id: "videos", label: t("history.navVideos"), icon: "🎥", badge: counts.videos },
    { id: "trash", label: t("history.navTrash"), icon: "🗑️", badge: counts.trash },
  ];

  return (
    <div style={{ ...sidebarStyle, width: collapsed ? 56 : 220 }}>
      {/* App Branding */}
      <div style={brandBox}>
        <div style={logoIcon}>⚡</div>
        {!collapsed && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={brandText}>SnapDoc</span>
            {appVersion && <span style={versionText}>v{appVersion}</span>}
          </div>
        )}
      </div>

      {/* Navigation List */}
      <div style={navScroll}>
        <div style={sectionTitle}>{!collapsed && t("history.sectionLibrary")}</div>
        {NAV_ITEMS.map((item) => {
          const active = activeNav === item.id;
          return (
            <button
              key={item.id}
              style={{
                ...navItemBtn,
                background: active ? "var(--accent)" : "transparent",
                color: active ? "var(--accent-text)" : "var(--text)",
                justifyContent: collapsed ? "center" : "flex-start",
              }}
              onClick={() => setActiveNav(item.id)}
              title={item.label}
            >
              <span style={navIcon}>{item.icon}</span>
              {!collapsed && <span style={navLabel}>{item.label}</span>}
              {!collapsed && (
                <span
                  style={{
                    ...badgeStyle,
                    color: active ? "var(--accent-text)" : item.badge > 0 ? "var(--text)" : "var(--text-dim)",
                    opacity: item.badge > 0 ? 1 : 0.6,
                  }}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}

        <div style={dividerStyle} />

        <div style={sectionTitle}>{!collapsed && t("history.sectionSettings")}</div>
        <button
          style={{
            ...navItemBtn,
            background: activeNav === "settings" ? "var(--accent)" : "transparent",
            color: activeNav === "settings" ? "var(--accent-text)" : "var(--text)",
            justifyContent: collapsed ? "center" : "flex-start",
          }}
          onClick={() => setActiveNav("settings")}
          title={t("history.navSettings")}
        >
          <span style={navIcon}>⚙️</span>
          {!collapsed && <span style={navLabel}>{t("history.navSettings")}</span>}
        </button>
      </div>

      {/* Footer / Storage Bar & Language Switcher */}
      {!collapsed ? (
        <div style={footerBox}>
          <div style={storageMeta}>
            <span>💾 {t("history.storageUsed")}:</span>
            <span style={{ fontWeight: 600 }}>{fmtSize(counts.totalSize)}</span>
          </div>
          {saveDir && (
            <button style={folderLinkBtn} onClick={handleOpenFolder} title={saveDir}>
              📂 {t("history.openStorageDir")}
            </button>
          )}

          {/* Language Switcher Tabs */}
          <div style={langTabsContainer}>
            <button
              style={{
                ...langTabBtn,
                background: currentLang === "vi" ? "var(--accent)" : "transparent",
                color: currentLang === "vi" ? "var(--accent-text)" : "var(--text-dim)",
                fontWeight: currentLang === "vi" ? 600 : 500,
              }}
              onClick={() => handleLanguageChange("vi")}
            >
              🇻🇳 Tiếng Việt
            </button>
            <button
              style={{
                ...langTabBtn,
                background: currentLang === "en" ? "var(--accent)" : "transparent",
                color: currentLang === "en" ? "var(--accent-text)" : "var(--text-dim)",
                fontWeight: currentLang === "en" ? 600 : 500,
              }}
              onClick={() => handleLanguageChange("en")}
            >
              🇬🇧 English
            </button>
          </div>
        </div>
      ) : (
        <div style={miniLangBox}>
          <button
            style={miniLangBtn}
            onClick={() => handleLanguageChange(currentLang === "vi" ? "en" : "vi")}
            title={currentLang === "vi" ? "Switch to English" : "Chuyển sang Tiếng Việt"}
          >
            {currentLang === "vi" ? "VI" : "EN"}
          </button>
        </div>
      )}
    </div>
  );
}

const sidebarStyle: React.CSSProperties = {
  flexShrink: 0,
  height: "100%",
  background: "var(--bg-elevated)",
  borderRight: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  transition: "width 0.2s ease",
  userSelect: "none",
};

const brandBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 16px",
  borderBottom: "1px solid var(--border)",
};

const logoIcon: React.CSSProperties = {
  fontSize: 18,
  width: 28,
  height: 28,
  borderRadius: 7,
  background: "rgba(59, 130, 246, 0.15)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const brandText: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: -0.2,
  color: "var(--text)",
};

const versionText: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-dim)",
};

const navScroll: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "10px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--text-dim)",
  padding: "8px 8px 4px 8px",
};

const navItemBtn: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 7,
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
  textAlign: "left",
  transition: "background 0.12s ease",
};

const navIcon: React.CSSProperties = {
  fontSize: 15,
  flexShrink: 0,
};

const navLabel: React.CSSProperties = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const badgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.2)",
};

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: "var(--border)",
  margin: "8px 4px",
};

const footerBox: React.CSSProperties = {
  padding: "12px 14px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontSize: 12,
  background: "rgba(0,0,0,0.1)",
};

const storageMeta: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  color: "var(--text-dim)",
};

const folderLinkBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const langTabsContainer: React.CSSProperties = {
  display: "flex",
  padding: 2,
  borderRadius: 7,
  background: "rgba(0, 0, 0, 0.25)",
  border: "1px solid var(--border)",
  gap: 2,
  marginTop: 2,
};

const langTabBtn: React.CSSProperties = {
  flex: 1,
  padding: "5px 4px",
  borderRadius: 5,
  border: "none",
  fontSize: 11,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  transition: "all 0.12s ease",
};

const miniLangBox: React.CSSProperties = {
  padding: "8px 4px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  justifyContent: "center",
  background: "rgba(0,0,0,0.1)",
};

const miniLangBtn: React.CSSProperties = {
  padding: "4px 6px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontSize: 10,
  fontWeight: 700,
  cursor: "pointer",
};

