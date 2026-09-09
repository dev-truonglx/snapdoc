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
 * Layout: [⠿ Grip] [⏸/▶ Pause] [divider] [● 00:00] [divider] [■ Stop] [spacer]
 * Nút Pause và Stop được tách biệt nhau bằng divider + khoảng trống để tránh
 * bấm nhầm khi quay full màn hình trên Windows. Có thể kéo thả (drag) để di
 * chuyển popup ra vị trí khác tránh che khuất nội dung cần thao tác. */
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
    }).catch(() => { });
    ipc.recordingPausedState().then((v) => {
      if (!cancelled && v != null) setPaused(v);
    }).catch(() => { });

    const unlistenTick = listen<RecordingTick>("recording-tick", (e) => {
      if (!cancelled) {
        setElapsedMs(e.payload.ms);
        setPaused(e.payload.paused);
      }
    });

    const unlistenReset = listen("recording-indicator-reset", () => {
      if (!cancelled) {
        setElapsedMs(0);
        setStopping(false);
        setPaused(false);
        setPauseBusy(false);
        ipc.recordingStatus().then((ms) => {
          if (!cancelled && ms != null) setElapsedMs(ms);
        }).catch(() => { });
        ipc.recordingPausedState().then((v) => {
          if (!cancelled && v != null) setPaused(v);
        }).catch(() => { });
      }
    });

    return () => {
      cancelled = true;
      unlistenTick.then((f) => f());
      unlistenReset.then((f) => f());
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
    ipc.stopRecording()
      .catch((e) => {
        alert(String(e));
        setStopping(false);
      });
  };

  const timeLabel = paused ? t("recordingIndicator.paused") : fmt(elapsedMs);

  return (
    <div
      style={wrap}
      data-tauri-drag-region
      onDragStart={(e) => e.preventDefault()}
      className="sd-rec-wrap"
    >
      {/* Grip handle kéo thả bên trái — hit-area rộng rãi 22px */}
      <div
        data-tauri-drag-region
        style={gripHandle}
        title={t("recordingIndicator.dragToMove")}
        className="sd-rec-grip"
      >
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" style={{ display: "block", pointerEvents: "none" }}>
          <circle cx="2" cy="2" r="1.3" fill="rgba(255,255,255,0.4)" />
          <circle cx="6" cy="2" r="1.3" fill="rgba(255,255,255,0.4)" />
          <circle cx="2" cy="7" r="1.3" fill="rgba(255,255,255,0.4)" />
          <circle cx="6" cy="7" r="1.3" fill="rgba(255,255,255,0.4)" />
          <circle cx="2" cy="12" r="1.3" fill="rgba(255,255,255,0.4)" />
          <circle cx="6" cy="12" r="1.3" fill="rgba(255,255,255,0.4)" />
        </svg>
      </div>

      {/* Nút Tạm dừng / Tiếp tục — tách biệt hoàn toàn với nút Stop */}
      <button
        style={{
          ...pauseBtn,
          opacity: pauseBusy || stopping ? 0.5 : 1,
          background: paused ? "rgba(34,197,94,0.2)" : "transparent",
          color: paused ? "#22c55e" : "rgba(255,255,255,0.8)",
        }}
        onClick={togglePause}
        disabled={pauseBusy || stopping}
        title={paused ? t("recordingIndicator.resume") : t("recordingIndicator.pause")}
      >
        {paused ? "▶" : "⏸"}
      </button>

      {/* Divider ngăn cách Pause với phần giữa */}
      <span style={divider} data-tauri-drag-region />

      {/* Chấm đỏ nhấp nháy + đồng hồ — có thể kéo thả để di chuyển */}
      <span
        style={centerGroup}
        data-tauri-drag-region
        title={t("recordingIndicator.dragToMove")}
        className="sd-rec-center"
      >
        {!paused && <span style={{ ...dot, pointerEvents: "none" }} />}
        {paused && <span style={{ ...pausedDot, pointerEvents: "none" }} />}
        <span style={{ ...time, pointerEvents: "none" }}>{timeLabel}</span>
      </span>

      {/* Divider ngăn cách phần giữa với nút Stop */}
      <span style={divider} data-tauri-drag-region />

      {/* Nút Dừng quay — tách biệt hoàn toàn với nút Pause */}
      <button
        style={{
          ...stopBtn,
          opacity: stopping ? 0.5 : 1,
        }}
        onClick={stop}
        disabled={stopping}
        title={t("recordingIndicator.stop")}
      >
        {stopping ? "…" : "■"}
      </button>

      {/* Spacer cân bằng bên phải đối ứng với gripHandle */}
      <div style={gripSpacer} data-tauri-drag-region />

      <style>{`
        @keyframes sd-rec-dot-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.55); }
          70%  { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
          100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
        }
        .sd-rec-wrap,
        .sd-rec-grip,
        .sd-rec-center,
        [data-tauri-drag-region] {
          -webkit-app-region: drag;
          app-region: drag;
          user-select: none;
          -webkit-user-select: none;
        }
        .sd-rec-wrap:active,
        .sd-rec-grip:active,
        .sd-rec-center:active {
          cursor: grabbing;
        }
        .sd-rec-grip:hover svg circle {
          fill: rgba(255,255,255,0.75);
        }
        button,
        button * {
          -webkit-app-region: no-drag;
          app-region: no-drag;
          cursor: pointer;
          border: none;
        }
        button:disabled { cursor: not-allowed; }
      `}</style>
    </div>
  );
}

const wrap: React.CSSProperties = {
  width: "100vw",
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-evenly",
  gap: 0,
  boxSizing: "border-box",
  background: "rgba(28,28,32,0.96)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 22,
  userSelect: "none",
  WebkitUserSelect: "none",
  padding: "0 6px",
  cursor: "grab",
};

/** Grip handle 6 chấm bên trái báo hiệu thanh có thể kéo thả — rộng 22px để dễ click trúng */
const gripHandle: React.CSSProperties = {
  width: 22,
  height: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "grab",
  flexShrink: 0,
};

/** Spacer bên phải để đảm bảo centerGroup nằm chính giữa thanh */
const gripSpacer: React.CSSProperties = {
  width: 22,
  height: 30,
  flexShrink: 0,
  pointerEvents: "none",
};

/** Nút Pause/Resume — hình tròn nhỏ, màu xanh khi đang paused */
const pauseBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  lineHeight: 1,
  flexShrink: 0,
  transition: "background 0.15s, color 0.15s, opacity 0.15s",
};

const divider: React.CSSProperties = {
  width: 1,
  height: 20,
  background: "rgba(255,255,255,0.15)",
  flexShrink: 0,
  margin: "0 4px",
};

const centerGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "0 4px",
  cursor: "grab",
};

const dot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#ef4444",
  flexShrink: 0,
  animation: "sd-rec-dot-pulse 1.4s ease-in-out infinite",
};

const pausedDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#f59e0b",
  flexShrink: 0,
};

const time: React.CSSProperties = {
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  userSelect: "none",
  WebkitUserSelect: "none",
};

/** Nút Stop — hình vuông đỏ, tách biệt hoàn toàn với nút Pause */
const stopBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  background: "#ef4444",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  color: "#fff",
  flexShrink: 0,
  transition: "opacity 0.15s",
};
