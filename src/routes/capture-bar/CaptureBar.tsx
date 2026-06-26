import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc, type CaptureMode, type OutputMode } from "../../lib/ipc";

const MODES: { id: CaptureMode; label: string; icon: React.ReactNode }[] = [
  {
    id: "all", label: "All",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="1" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        <rect x="11" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      </svg>
    ),
  },
  {
    id: "full", label: "Full",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="2" y="3" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      </svg>
    ),
  },
  {
    id: "window", label: "Window",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="3" y="5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        <line x1="3" y1="8.5" x2="17" y2="8.5" stroke="currentColor" strokeWidth="1.4"/>
      </svg>
    ),
  },
  {
    id: "region", label: "Region",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M12 3h3.5A1.5 1.5 0 0 1 17 4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M17 12v3.5A1.5 1.5 0 0 1 15.5 17H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M8 17H4.5A1.5 1.5 0 0 1 3 15.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    ),
  },
];

const OUTPUTS: { id: OutputMode; label: string }[] = [
  { id: "editor",    label: "Mở editor" },
  { id: "clipboard", label: "Clipboard" },
  { id: "save",      label: "Lưu file" },
  { id: "save_copy", label: "Lưu + Copy" },
];

const TIMERS = [0, 3, 5];

export default function CaptureBar() {
  const [mode, setMode] = useState<CaptureMode>("region");
  const [output, setOutput] = useState<OutputMode>("editor");
  const [timer, setTimer] = useState(0);
  const [showOptions, setShowOptions] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    // Load theo thứ tự ưu tiên: lastCaptureMode > settings default
    // lastCaptureMode được set mỗi khi user chụp → phản ánh lần chụp gần nhất
    Promise.all([
      ipc.getSettings().catch(() => null),
      ipc.getLastCaptureMode().catch(() => null),
    ]).then(([settings, last]) => {
      // Áp settings default trước
      if (settings) {
        setOutput(settings.defaultOutput ?? "editor");
        setTimer(settings.timerSeconds ?? 0);
      }
      // Override bằng lastCaptureMode nếu có (user đã chụp ít nhất 1 lần)
      if (last) {
        const [m, o] = last;
        if (m) setMode(m as CaptureMode);
        if (o) setOutput(o as OutputMode);
      }
    });

    // Nhận event từ Editor "New" (gửi sau khi bar đã show)
    const unlisten = listen<{ mode: string; output: string }>("set-capture-mode", (e) => {
      setMode(e.payload.mode as CaptureMode);
      setOutput(e.payload.output as OutputMode);
    });

    // Khi window được focus lại (reuse sau hide) → fetch lại lastMode
    // Đây là fallback khi event set-capture-mode bị miss
    const onFocus = () => {
      ipc.getLastCaptureMode().then(([m, o]) => {
        if (m) setMode(m as CaptureMode);
        if (o) setOutput(o as OutputMode);
      }).catch(() => {});
    };
    window.addEventListener("focus", onFocus);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ipc.closeSelf();
      if (e.key === "Enter") capture();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
      unlisten.then((fn) => fn());
    };
  }, []);

  const capture = () => {
    if (timer > 0) {
      let n = timer;
      setCountdown(n);
      const iv = window.setInterval(() => {
        n -= 1;
        if (n <= 0) {
          window.clearInterval(iv);
          setCountdown(null);
          doCapture();
        } else {
          setCountdown(n);
        }
      }, 1000);
    } else {
      doCapture();
    }
  };

  const doCapture = () => {
    if (mode === "all") {
      ipc.captureAllScreens(output);
    } else {
      ipc.captureNow(mode, output);
    }
  };

  return (
    <div style={wrap} data-tauri-drag-region>
      <div style={bar}>
        {/* Mode buttons */}
        <div style={modeGroup}>
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              style={modeBtn(mode === m.id)}
              title={m.label}
            >
              {m.icon}
              <span style={{ fontSize: 11, lineHeight: 1 }}>{m.label}</span>
            </button>
          ))}
        </div>

        <div style={divider} />

        {/* Options popover */}
        <div style={{ position: "relative" }}>
          <button style={optBtn} onClick={() => setShowOptions((v) => !v)}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
              <circle cx="7.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M2.93 2.93l1.41 1.41M10.66 10.66l1.41 1.41M2.93 12.07l1.41-1.41M10.66 4.34l1.41-1.41" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            {OUTPUTS.find(o => o.id === output)?.label ?? "Options"}
            <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
          </button>
          {showOptions && (
            <div style={popover} onClick={(e) => e.stopPropagation()}>
              <div style={popLabel}>Lưu vào</div>
              {OUTPUTS.map((o) => (
                <button key={o.id} style={popItem(output === o.id)} onClick={() => { setOutput(o.id); setShowOptions(false); }}>
                  {o.label}
                </button>
              ))}
              <div style={{ ...popLabel, marginTop: 8 }}>Hẹn giờ</div>
              <div style={{ display: "flex", gap: 6 }}>
                {TIMERS.map((t) => (
                  <button key={t} style={popItem(timer === t)} onClick={() => setTimer(t)}>
                    {t === 0 ? "Không" : `${t}s`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Capture button */}
        <button style={shootBtn} onClick={capture}>
          {countdown !== null ? `${countdown}…` : "Chụp"}
        </button>

        {/* Close */}
        <button aria-label="Đóng" style={closeBtn} onClick={() => ipc.closeSelf()}>
          ✕
        </button>
      </div>
    </div>
  );
}

/* ── Styles ── */

const wrap: React.CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  background: "rgba(32,32,38,0.97)",
  border: "none",
  borderRadius: 12,
  padding: "7px 10px",
  // Bỏ box-shadow theo yêu cầu
};

const modeGroup: React.CSSProperties = {
  display: "flex",
  gap: 2,
  background: "rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 2,
};

function modeBtn(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    width: 56,
    padding: "6px 4px",
    borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text-dim)",
    transition: "background 0.12s",
  };
}

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
};

const shootBtn: React.CSSProperties = {
  padding: "7px 18px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  border: "none",
  cursor: "pointer",
};

const closeBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  color: "var(--text-dim)",
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};

const popover: React.CSSProperties = {
  position: "absolute",
  bottom: "110%",
  left: 0,
  width: 180,
  background: "rgba(36,36,42,0.99)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  zIndex: 100,
};

const popLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  color: "var(--text-dim)",
  padding: "2px 4px",
  textTransform: "uppercase",
};

function popItem(active: boolean): React.CSSProperties {
  return {
    textAlign: "left",
    padding: "6px 8px",
    borderRadius: 6,
    fontSize: 12,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text)",
    flex: 1,
    border: "none",
    cursor: "pointer",
  };
}
