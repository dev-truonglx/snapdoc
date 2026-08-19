import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";

/** `93500` → `"01:33"` — mm:ss, luôn 2 chữ số. */
function fmt(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Payload của event `recording-tick` từ Rust. */
interface RecordingTick {
  ms: number;
  paused: boolean;
}

/** Popup nổi "đang quay" trên Windows (xem `windows::open_recording_indicator`)
 * — thay cho vai trò của `NSStatusItem.title` bên macOS (hiện đồng hồ đếm
 * ngay cạnh icon tray), vì tray icon Win32 không có API tương đương. Lắng
 * nghe event `recording-tick` (do `record::spawn_tray_ticker` bắn mỗi giây)
 * thay vì tự poll `recording_status` riêng 1 vòng lặp khác.
 *
 * Click trái vào popup: toggle tạm dừng / tiếp tục. Click phải (hoặc double-
 * click): dừng quay. Cửa sổ đã được content-protected ở phía Rust nên popup
 * này không lọt vào chính video đang quay. */
export default function RecordingIndicator() {
  const { t } = useTranslation();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Lấy giá trị ban đầu — tick đầu tiên có thể tới trễ ~1s nếu cửa sổ
    // mount không đúng lúc ticker vừa tick.
    ipc.recordingStatus().then((ms) => {
      if (!cancelled && ms != null) setElapsedMs(ms);
    }).catch(() => {});
    ipc.recordingPausedState().then((v) => {
      if (!cancelled && v != null) setPaused(v);
    }).catch(() => {});

    const unlisten = listen<RecordingTick>("recording-tick", (e) => {
      if (!cancelled) {
        setElapsedMs(e.payload.ms);
        setPaused(e.payload.paused);
      }
    });
    return () => {
      cancelled = true;
      unlisten.then((f) => f());
    };
  }, []);

  const togglePause = () => {
    if (pauseBusy || stopping) return;
    setPauseBusy(true);
    const action = paused ? ipc.resumeRecording() : ipc.pauseRecording();
    action.catch((e) => { alert(String(e)); }).finally(() => setPauseBusy(false));
  };

  const stop = () => {
    if (stopping) return;
    setStopping(true);
    ipc.stopRecording().catch((e) => {
      alert(String(e));
      setStopping(false);
    });
  };

  const label = stopping
    ? t("recordingIndicator.stopping")
    : paused
    ? t("recordingIndicator.paused")
    : fmt(elapsedMs);

  return (
    <div style={wrap} title={t("recordingIndicator.clickToToggle")}>
      {/* Nút tạm dừng / tiếp tục */}
      <span
        style={{ ...pauseBtn, opacity: pauseBusy || stopping ? 0.5 : 1 }}
        onClick={togglePause}
        title={paused ? t("recordingIndicator.resume") : t("recordingIndicator.pause")}
      >
        {paused ? "▶" : "⏸"}
      </span>

      {/* Chấm đỏ nhấp nháy (ẩn khi paused) */}
      {!paused && <span style={dot} />}
      {paused && <span style={pausedDot} />}

      {/* Thời gian / trạng thái */}
      <span style={time} onClick={stop}>{label}</span>

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
  gap: 7,
  boxSizing: "border-box",
  background: "rgba(28,28,32,0.96)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 22,
  boxShadow: "0 6px 22px rgba(0,0,0,0.45)",
  userSelect: "none",
};

const pauseBtn: React.CSSProperties = {
  fontSize: 12,
  cursor: "pointer",
  color: "rgba(255,255,255,0.75)",
  padding: "0 2px",
  lineHeight: 1,
};

const dot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "#ef4444",
  flexShrink: 0,
  animation: "sd-rec-dot-pulse 1.4s ease-in-out infinite",
};

const pausedDot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: "#f59e0b",
  flexShrink: 0,
};

const time: React.CSSProperties = {
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  cursor: "pointer",
};
