import { useEffect, useState } from "react";
import { ipc, type CaptureMode, type OutputMode } from "../../lib/ipc";

const MODES: { id: CaptureMode; label: string; icon: string }[] = [
  { id: "all",    label: "All",    icon: "⬛" },
  { id: "full",   label: "Full",   icon: "▢" },
  { id: "window", label: "Window", icon: "◱" },
  { id: "region", label: "Region", icon: "⬚" },
];

const OUTPUTS: { id: OutputMode; label: string }[] = [
  { id: "editor", label: "Mở editor" },
  { id: "clipboard", label: "Clipboard" },
  { id: "save", label: "Lưu file" },
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
    ipc.getSettings().then((s) => {
      setOutput(s.defaultOutput ?? "editor");
      setTimer(s.timerSeconds ?? 0);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ipc.closeSelf();
      if (e.key === "Enter") capture();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
        <div style={modeGroup}>
          {MODES.map((m) => (
            <button key={m.id} onClick={() => setMode(m.id)} style={modeBtn(mode === m.id)}>
              <span style={{ fontSize: 18 }}>{m.icon}</span>
              <span style={{ fontSize: 11 }}>{m.label}</span>
            </button>
          ))}
        </div>

        <div style={divider} />

        <div style={{ position: "relative" }}>
          <button style={optBtn} onClick={() => setShowOptions((v) => !v)}>
            ⚙ Options ▾
          </button>
          {showOptions && (
            <div style={popover}>
              <div style={popLabel}>Lưu vào</div>
              {OUTPUTS.map((o) => (
                <button key={o.id} style={popItem(output === o.id)} onClick={() => setOutput(o.id)}>
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

        <button style={shootBtn} onClick={capture}>
          {countdown !== null ? `${countdown}…` : "📷 Chụp"}
        </button>

        <button aria-label="Đóng" style={closeBtn} onClick={() => ipc.closeSelf()}>
          ✕
        </button>
      </div>

      <div style={hints}>
        <span style={pill}>Lưu vào: {OUTPUTS.find((o) => o.id === output)?.label}</span>
        <span style={pill}>Hẹn giờ: {timer === 0 ? "Không" : `${timer}s`}</span>
        <span style={pill}>Esc để đóng</span>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};
const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  background: "rgba(38,38,44,0.96)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 14,
  padding: "8px 10px",
  boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
};
const modeGroup: React.CSSProperties = {
  display: "flex",
  gap: 4,
  background: "rgba(0,0,0,0.25)",
  borderRadius: 8,
  padding: 3,
};
function modeBtn(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    width: 60,
    padding: "6px 4px",
    borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text-dim)",
  };
}
const divider: React.CSSProperties = { width: 1, height: 38, background: "rgba(255,255,255,0.1)" };
const optBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.12)",
  fontSize: 13,
};
const shootBtn: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#fff",
  fontWeight: 500,
  fontSize: 13,
};
const closeBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: "50%",
  color: "var(--text-dim)",
};
const popover: React.CSSProperties = {
  position: "absolute",
  bottom: "120%",
  left: 0,
  width: 180,
  background: "rgba(40,40,46,0.98)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const popLabel: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", padding: "2px 4px" };
function popItem(active: boolean): React.CSSProperties {
  return {
    textAlign: "left",
    padding: "6px 8px",
    borderRadius: 6,
    fontSize: 13,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text)",
    flex: 1,
  };
}
const hints: React.CSSProperties = { display: "flex", gap: 6 };
const pill: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
  background: "rgba(0,0,0,0.3)",
  padding: "3px 8px",
  borderRadius: 6,
};
