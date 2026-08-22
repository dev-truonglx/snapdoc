import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ipc, type CaptureMode, type OutputMode } from "../../lib/ipc";

type RecordMode = "full" | "window" | "region";
type ActiveGroup = "photo" | "video";

// Icon dùng chung cho "phạm vi" (Full/Window/Region)
const SCOPE_ICONS: Record<RecordMode, React.ReactNode> = {
  full: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="3" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
    </svg>
  ),
  window: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3" y="5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      <line x1="3" y1="8.5" x2="17" y2="8.5" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  ),
  region: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M12 3h3.5A1.5 1.5 0 0 1 17 4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M17 12v3.5A1.5 1.5 0 0 1 15.5 17H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M8 17H4.5A1.5 1.5 0 0 1 3 15.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  ),
};

export default function CaptureBar() {
  const { t } = useTranslation();
  const [photoMode, setPhotoMode] = useState<CaptureMode>("region");
  const [videoMode, setVideoMode] = useState<RecordMode>("full");
  const [activeGroup, setActiveGroup] = useState<ActiveGroup>("photo");
  const [output, setOutput] = useState<OutputMode>("editor");

  const PHOTO_MODES: { id: CaptureMode; label: string; icon: React.ReactNode }[] = [
    {
      id: "all", label: t("captureBar.all"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect x="1" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
          <rect x="11" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        </svg>
      ),
    },
    { id: "full", label: t("captureBar.full"), icon: SCOPE_ICONS.full },
    { id: "window", label: t("captureBar.window"), icon: SCOPE_ICONS.window },
    { id: "region", label: t("captureBar.region"), icon: SCOPE_ICONS.region },
    {
      id: "scroll", label: t("captureBar.scroll"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/>
          <path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
  ];

  const RECORD_MODES: { id: RecordMode; label: string }[] = [
    { id: "full", label: t("captureBar.full") },
    { id: "window", label: t("captureBar.window") },
    { id: "region", label: t("captureBar.region") },
  ];

  const photoModeRef = useRef(photoMode);
  photoModeRef.current = photoMode;
  const videoModeRef = useRef(videoMode);
  videoModeRef.current = videoMode;
  const activeGroupRef = useRef(activeGroup);
  activeGroupRef.current = activeGroup;
  const outputRef = useRef(output);
  outputRef.current = output;

  useEffect(() => {
    // Load settings lần đầu
    ipc.getSettings().then((s) => {
      if (s?.defaultOutput) setOutput(s.defaultOutput);
    }).catch(() => {});

    // Sync output khi settings thay đổi
    const unlistenSettings = listen<Record<string, unknown>>("settings-changed", (e) => {
      if (e.payload?.defaultOutput) {
        setOutput(e.payload.defaultOutput as OutputMode);
      }
    });

    const unlistenRecordMode = listen<{ mode: string }>("set-record-mode", (e) => {
      selectVideoMode(e.payload.mode as RecordMode);
    });

    const unlistenError = listen<string>("snapdoc-error", (e) => {
      alert(e.payload);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        ipc.hideCaptureBarPopover().catch(() => {});
        ipc.closeSelf();
      }
      if (e.key === "Enter") {
        ipc.hideCaptureBarPopover().catch(() => {});
        if (activeGroupRef.current === "video") {
          if (videoModeRef.current === "region") {
            ipc.confirmRegionRecordStart().catch((err) => alert(String(err)));
          } else {
            ipc.startRecordPicker(videoModeRef.current).catch((err) => alert(String(err)));
          }
        } else if (photoModeRef.current === "all") {
          ipc.captureAllScreens(outputRef.current).catch((err) => alert(String(err)));
        } else {
          ipc.captureNow(photoModeRef.current, outputRef.current).catch((err) => alert(String(err)));
        }
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      unlistenRecordMode.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, []);

  const selectPhotoMode = (m: CaptureMode) => {
    ipc.hideCaptureBarPopover().catch(() => {});
    setPhotoMode(m);
    setActiveGroup("photo");
    if (m === "all") {
      ipc.captureAllScreens(output).catch((e) => alert(String(e)));
    } else {
      ipc.captureNow(m, output).catch((e) => alert(String(e)));
    }
  };

  const selectVideoMode = (m: RecordMode) => {
    ipc.hideCaptureBarPopover().catch(() => {});
    setVideoMode(m);
    setActiveGroup("video");
    ipc.startRecordPicker(m).catch((e) => alert(String(e)));
  };

  const toggleOptions = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    ipc.toggleCaptureBarPopover({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    }).catch(() => {});
  };

  const handleClose = () => {
    ipc.hideCaptureBarPopover().catch(() => {});
    ipc.closeSelf();
  };

  return (
    <div style={wrap}>
      <div style={bar}>
        {/* Khu vực 1: chế độ CHỤP ẢNH */}
        <div style={modeGroup}>
          <button
            onClick={() => {
              ipc.hideCaptureBarPopover().catch(() => {});
              ipc.startQuick().catch((e) => alert(String(e)));
            }}
            style={quickModeBtn}
            title={t("captureBar.quickCaptureHint")}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
              <path d="M11 2 3 12h6l-1 6 8-10h-6l1-6Z" fill="currentColor" />
            </svg>
            <span style={{ fontSize: 11, lineHeight: 1 }}>Quick</span>
          </button>
          {PHOTO_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => selectPhotoMode(m.id)}
              style={scopeBtn}
              title={m.label}
            >
              {m.icon}
              <span style={{ fontSize: 11, lineHeight: 1 }}>{m.label}</span>
            </button>
          ))}
        </div>

        <div style={divider} />

        {/* Khu vực 2: chế độ QUAY MÀN HÌNH */}
        <div style={modeGroup}>
          {RECORD_MODES.map((r) => (
            <button
              key={r.id}
              onClick={() => selectVideoMode(r.id)}
              style={scopeBtn}
              title={`Quay ${r.label.toLowerCase()}`}
            >
              <span style={recordIconWrap}>
                {SCOPE_ICONS[r.id]}
                <span style={recordDotBadge} aria-hidden />
              </span>
              <span style={{ fontSize: 11, lineHeight: 1 }}>{r.label}</span>
            </button>
          ))}
        </div>

        <div style={divider} />

        {/* Option: Nút mở Popover độc lập */}
        <button
          style={optBtn}
          onClick={toggleOptions}
          title={t("captureBar.options") || "Options"}
        >
          <span>Options</span>
          <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>▾</span>
        </button>

        {/* Close */}
        <button aria-label={t("captureBar.close")} style={closeBtn} onClick={handleClose}>
          ✕
        </button>
      </div>
    </div>
  );
}

/* ── Styles ── */

const wrap: React.CSSProperties = {
  height: "100%",
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
};

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  background: "rgba(32,32,38,0.97)",
  borderRadius: 12,
  padding: "7px 10px",
  width: "max-content",
  boxShadow: "0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.08)",
};

const modeGroup: React.CSSProperties = {
  display: "flex",
  gap: 2,
  background: "rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 2,
};

const scopeBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  width: 56,
  padding: "6px 4px",
  borderRadius: 6,
  color: "var(--text-dim)",
  cursor: "pointer",
  transition: "background 0.1s, color 0.1s",
};

const divider: React.CSSProperties = {
  width: 1,
  height: 36,
  background: "rgba(255,255,255,0.08)",
  flexShrink: 0,
};

const optBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 11px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  fontSize: 12,
  color: "var(--text)",
  background: "transparent",
  whiteSpace: "nowrap",
  cursor: "pointer",
};

const quickModeBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  width: 56,
  padding: "6px 4px",
  borderRadius: 6,
  background: "rgba(245,158,11,0.16)",
  color: "#fbbf24",
  cursor: "pointer",
  transition: "background 0.12s",
};

const recordIconWrap: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
};

const recordDotBadge: React.CSSProperties = {
  position: "absolute",
  top: -1,
  right: -2,
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--danger)",
};

const closeBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  color: "var(--text-dim)",
  fontSize: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};
