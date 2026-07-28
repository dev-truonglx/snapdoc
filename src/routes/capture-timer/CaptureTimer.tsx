import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

/** Cửa sổ nổi độc lập chỉ để hiển thị số đếm ngược "hẹn giờ chụp" — tách hẳn
 * khỏi capture-bar (xem `flow::wait_capture_delay`, `windows::open_capture_timer`)
 * để hoạt động đúng bất kể capture-bar đang ẩn hay hiện, nhưng đặt ĐÚNG vị trí
 * capture-bar và giữ nguyên style pill (nền tối, số vàng) mà bar dùng trước
 * đây. Rust build cửa sổ này mới mỗi lần đếm và tự đóng ngay sau khi đếm
 * xong/huỷ — component không cần tự lo việc ẩn/đóng. */
export default function CaptureTimer() {
  const { t } = useTranslation();
  // Giá trị ban đầu nhúng sẵn trong query string (`secs`) để hiện đúng số
  // ngay từ frame đầu tiên, tránh trống 1 nhịp nếu tick đầu tiên từ Rust bắn
  // ra trước khi listener kịp gắn xong.
  const initialSecs = Number(new URLSearchParams(window.location.search).get("secs")) || 0;
  const [countdown, setCountdown] = useState(initialSecs);

  useEffect(() => {
    const unlistenTick = listen<number>("capture-countdown-tick", (e) => {
      setCountdown(e.payload);
    });
    return () => {
      unlistenTick.then((fn) => fn());
    };
  }, []);

  return (
    <div style={wrap}>
      <div style={container}>
        <div style={bar}>
          <div style={countdownWrap}>
            <span style={countdownNumber}>{countdown}</span>
            <span style={countdownLabel}>{t("captureBar.aboutToCapture")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Styles — y hệt pill đếm ngược cũ của CaptureBar.tsx ── */

const wrap: React.CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  paddingBottom: 12,
};

// Container bao bar + popover, không có overflow hidden
const container: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 6,
};

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  background: "rgba(32,32,38,0.97)",
  borderRadius: 16,
  padding: "7px 20px",
  width: "max-content",
};

const countdownWrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "4px 14px",
  minWidth: 200,
};

const countdownNumber: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  color: "#fbbf24",
  minWidth: 28,
  textAlign: "center",
};

const countdownLabel: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
};
