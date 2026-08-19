import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";

/** Payload của event `recording-tick` từ Rust — cùng struct `RecordingTick`. */
interface RecordingTick {
  ms: number;
  paused: boolean;
}

/**
 * Cửa sổ NHỎ, RIÊNG chỉ chứa nút "Tạm dừng" và "Dừng quay" — nổi cạnh vùng
 * đang quay (xem `windows::open_stop_control`). Tách khỏi overlay chọn/chỉnh
 * vùng (`RecordRegionSelect`) vì overlay đó được giữ NGUYÊN, click-through
 * suốt lúc quay để đóng vai trò khung viền (không nháy hình) — 1 cửa sổ
 * click-through thì KHÔNG THỂ vừa vẫn có nút bấm được trong đó, nên nút
 * phải nằm ở cửa sổ khác, không click-through, chỉ che đúng khoảng của
 * chính nó.
 *
 * Cửa sổ này được TÁI SỬ DỤNG giữa các phiên quay (chỉ `hide()`, không
 * `close()` — xem `windows::close_stop_control`) nên state React SỐNG SÓT
 * qua nhiều lần quay. Phải nghe event `record-stop-control-reset` (bắn từ
 * `open_stop_control` mỗi lần show lại) để reset state — nếu không, state
 * còn sót lại từ lần quay trước sẽ khiến phiên quay MỚI mở ra bất thường.
 *
 * Layout: [⏸/▶ Pause]  ·····divider·····  [■ Dừng quay]
 * Hai nút được tách biệt bằng divider + khoảng cách rõ ràng để tránh bấm nhầm
 * khi quay toàn màn hình trên Windows.
 */
export default function RecordStopControl() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);

  // Reset toàn bộ state mỗi lần cửa sổ được show lại cho phiên quay mới.
  useEffect(() => {
    const un = listen("record-stop-control-reset", () => {
      setBusy(false);
      setPaused(false);
      setPauseBusy(false);
    });
    return () => { un.then((f) => f()); };
  }, []);

  // Đồng bộ trạng thái paused từ ticker Rust (cùng event recording-tick mà
  // RecordingIndicator dùng) — không cần poll riêng, dùng chung 1 nguồn.
  useEffect(() => {
    const un = listen<RecordingTick>("recording-tick", (e) => {
      setPaused(e.payload.paused);
    });
    // Lấy giá trị ngay khi mount (tick đầu tiên có thể tới trễ ~1s)
    ipc.recordingPausedState().then((v) => {
      if (v != null) setPaused(v);
    }).catch(() => {});
    return () => { un.then((f) => f()); };
  }, []);

  const doStop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await ipc.stopRecording();
    } catch (e) {
      setBusy(false);
      alert(String(e));
    }
  };

  const doTogglePause = async () => {
    if (pauseBusy || busy) return;
    setPauseBusy(true);
    try {
      if (paused) {
        await ipc.resumeRecording();
      } else {
        await ipc.pauseRecording();
      }
      // Trạng thái sẽ được cập nhật qua recording-tick, không cần set ở đây.
    } catch (e) {
      alert(String(e));
    } finally {
      setPauseBusy(false);
    }
  };

  return (
    <div style={container}>
      {/* Nút Tạm dừng / Tiếp tục */}
      <button
        onClick={doTogglePause}
        disabled={pauseBusy || busy}
        title={paused ? t("recordStop.resume") : t("recordStop.pause")}
        style={{
          border: "none",
          borderRadius: 8,
          width: 40,
          height: 40,
          fontSize: 17,
          cursor: "pointer",
          color: "#fff",
          background: paused ? "#22c55e" : "rgba(255,255,255,0.15)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          backdropFilter: "blur(4px)",
          opacity: pauseBusy || busy ? 0.6 : 1,
          transition: "background 0.15s, opacity 0.15s",
        }}
      >
        {paused ? "▶" : "⏸"}
      </button>

      {/* Divider ngăn cách rõ ràng 2 nút — giảm nguy cơ bấm nhầm */}
      <div style={divider} />

      {/* Nút Dừng quay — tách biệt hẳn về vị trí và visual */}
      <button
        onClick={doStop}
        disabled={busy}
        title={t("recordStop.stopRecording")}
        style={{
          border: "none",
          borderRadius: 8,
          padding: "10px 16px",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          color: "#fff",
          background: "#ef4444",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          whiteSpace: "nowrap",
          opacity: busy ? 0.6 : 1,
          transition: "opacity 0.15s",
        }}
      >
        {busy ? t("recordStop.stopping") : t("recordStop.stopRecording")}
      </button>
    </div>
  );
}

const container: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // Gap lớn hơn và có divider để user khó bấm nhầm hơn
  gap: 10,
  background: "transparent",
};

const divider: React.CSSProperties = {
  width: 1,
  height: 28,
  background: "rgba(255,255,255,0.2)",
  flexShrink: 0,
};
