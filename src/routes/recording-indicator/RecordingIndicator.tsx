import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";

/** `93500` → `"01:33"` — mm:ss, luôn 2 chữ số. */
function fmt(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Popup nổi "đang quay" trên Windows (xem `windows::open_recording_indicator`)
 * — thay cho vai trò của `NSStatusItem.title` bên macOS (hiện đồng hồ đếm
 * ngay cạnh icon tray), vì tray icon Win32 không có API tương đương. Poll
 * `recording_status` mỗi giây để hiện mm:ss; bấm vào bất kỳ đâu trên popup để
 * dừng quay ngay (`stop_recording`). Cửa sổ đã được content-protected ở phía
 * Rust nên popup này không lọt vào chính video đang quay. */
export default function RecordingIndicator() {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      ipc.recordingStatus().then((ms) => {
        if (!cancelled && ms != null) setElapsedMs(ms);
      }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const stop = () => {
    if (stopping) return;
    setStopping(true);
    ipc.stopRecording().catch(() => setStopping(false));
  };

  return (
    <div style={wrap} onClick={stop} title="Bấm để dừng quay">
      <span style={dot} />
      <span style={time}>{fmt(elapsedMs)}</span>
      <style>{`
        @keyframes sd-rec-dot-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.55); }
          70%  { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
          100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
        }
      `}</style>
    </div>
  );
}

const wrap: React.CSSProperties = {
  width: "100vw",
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 9,
  boxSizing: "border-box",
  background: "rgba(28,28,32,0.96)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 22,
  boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
  cursor: "pointer",
  userSelect: "none",
};

const dot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "#ef4444",
  flexShrink: 0,
  animation: "sd-rec-dot-pulse 1.4s ease-in-out infinite",
};

const time: React.CSSProperties = {
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};
