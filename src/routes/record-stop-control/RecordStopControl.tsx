import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";

/**
 * Cửa sổ NHỎ, RIÊNG chỉ chứa nút "Dừng quay" — nổi cạnh vùng đang quay (xem
 * `windows::open_stop_control`). Tách khỏi overlay chọn/chỉnh vùng
 * (`RecordRegionSelect`) vì overlay đó được giữ NGUYÊN, click-through suốt
 * lúc quay để đóng vai trò khung viền (không nháy hình) — 1 cửa sổ click-
 * through thì KHÔNG THỂ vừa vẫn có 1 nút bấm được trong đó, nên nút phải nằm
 * ở cửa sổ khác, không click-through, chỉ che đúng khoảng của chính nó.
 *
 * Cửa sổ này được TÁI SỬ DỤNG giữa các phiên quay (chỉ `hide()`, không
 * `close()` — xem `windows::close_stop_control`) nên state React SỐNG SÓT
 * qua nhiều lần quay. Phải nghe event `record-stop-control-reset` (bắn từ
 * `open_stop_control` mỗi lần show lại) để reset `busy` — nếu không, `busy`
 * còn sót lại `true` từ lần bấm Dừng quay trước sẽ khiến phiên quay MỚI mở ra
 * nút đã hiện sẵn "Đang dừng…", bấm không có tác dụng.
 */
export default function RecordStopControl() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const un = listen("record-stop-control-reset", () => setBusy(false));
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

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
      }}
    >
      <button
        onClick={doStop}
        disabled={busy}
        style={{
          border: "none",
          borderRadius: 8,
          padding: "10px 18px",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          color: "#fff",
          background: "#ef4444",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          whiteSpace: "nowrap",
        }}
      >
        {busy ? t("recordStop.stopping") : t("recordStop.stopRecording")}
      </button>
    </div>
  );
}
