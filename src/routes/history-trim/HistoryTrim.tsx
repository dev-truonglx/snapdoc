import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, type HistoryItem } from "../../lib/ipc";
import VideoTrimmer from "../../features/video-trim/VideoTrimmer";

/** `93500` → `"1:34"` — mm:ss (cùng định dạng `RecordReview.tsx`). */
function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Cửa sổ "Cắt video" riêng cho 1 item trong History — cùng khuôn
 * `RecordReview.tsx` (titlebar thật, thu nhỏ/phóng to/đóng), thay cho modal
 * cũ nổi trong cửa sổ History. Đóng lúc nào cũng an toàn (khác
 * `record-review`, không cần chặn nút "x") vì không áp dụng cắt thì bản gốc
 * trong History không đổi gì cả — không cần xác nhận trước khi đóng. */
export default function HistoryTrim() {
  const [item, setItem] = useState<HistoryItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  // Gương lại trạng thái chỉnh sửa của VideoTrimmer (nó ẩn nút "Áp dụng cắt"
  // riêng — xem `showApplyButton={false}` bên dưới) để nút ở đây biết có gì
  // để áp dụng không, cùng kỹ thuật `RecordReview.tsx`.
  const [trimState, setTrimState] = useState<{ hasChanges: boolean; keepRanges: [number, number][] }>({
    hasChanges: false,
    keepRanges: [],
  });

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) {
      setNotFound(true);
      return;
    }
    ipc.getHistoryItem(id)
      .then(setItem)
      .catch(() => setNotFound(true));
  }, []);

  const doClose = () => {
    if (busy) return;
    void ipc.closeHistoryTrim();
  };

  // Backend `trim_history_video` tự emit "history:item-added" cho cửa sổ
  // History cập nhật danh sách (khác webview — không gọi thẳng store được,
  // xem comment ở `history/commands.rs`) — ở đây chỉ cần gọi rồi đóng cửa sổ.
  const doApply = async () => {
    if (busy || !item || !trimState.hasChanges) return;
    setBusy(true);
    try {
      await ipc.trimHistoryVideo(item.id, trimState.keepRanges);
      await ipc.closeHistoryTrim();
    } catch (e) {
      alert(String(e));
      setBusy(false);
    }
  };

  const isVideo = item?.mediaType === "video";

  return (
    <div style={card}>
      <div style={previewWrap}>
        {item && isVideo ? (
          <VideoTrimmer
            key={item.id}
            src={convertFileSrc(item.assetPath)}
            filePath={item.assetPath}
            durationMs={item.durationMs ?? 0}
            busy={busy}
            showApplyButton={false}
            onStateChange={setTrimState}
          />
        ) : (
          <div style={placeholder}>
            {notFound || (item && !isVideo) ? "Không tìm thấy video để cắt" : "Đang tải…"}
          </div>
        )}
      </div>

      {item && (
        <div style={metaRow}>
          <span>{fmtDuration(item.durationMs ?? 0)}</span>
          <span>{item.width} × {item.height}px</span>
        </div>
      )}

      <div style={actions}>
        {/* Đóng: an toàn tuyệt đối (không áp dụng thì bản gốc không đổi) nên
            chỉ cần ghost/nhẹ tay, không cần cảnh báo đỏ như "Xoá bản quay" ở
            RecordReview. */}
        <button style={closeBtn} disabled={busy} onClick={doClose}>Đóng</button>
        <button style={applyBtn} disabled={busy || !item || !trimState.hasChanges} onClick={doApply}>
          {busy ? "Đang cắt…" : "Áp dụng cắt"}
        </button>
      </div>
    </div>
  );
}

// Cùng khuôn `RecordReview.tsx` — cửa sổ có titlebar/nền thật, không tự vẽ
// khối "card" nổi riêng.
const card: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const previewWrap: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: "#000",
  display: "flex",
  padding: 10,
  boxSizing: "border-box",
};

const placeholder: React.CSSProperties = {
  margin: "auto",
  color: "var(--text-dim)",
  fontSize: 13,
};

const metaRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "8px 14px",
  fontSize: 12,
  color: "var(--text-dim)",
  borderTop: "1px solid var(--border)",
};

const actions: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
};

const applyBtn: React.CSSProperties = {
  padding: "10px 22px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontWeight: 600,
  fontSize: 13,
};

const closeBtn: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-dim)",
  fontWeight: 500,
  fontSize: 13,
};
