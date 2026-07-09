import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ipc, type HistoryItem } from "../../lib/ipc";
import VideoTrimmer from "../../features/video-trim/VideoTrimmer";

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
  // Tiến độ cắt (0..1) — cùng kỹ thuật `RecordReview.tsx`, backend emit %
  // thật từ ffmpeg qua event `trim-progress`, xem `encoder::trim`.
  const [trimProgress, setTrimProgress] = useState(0);

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

  useEffect(() => {
    const unlisten = listen<number>("trim-progress", (e) => setTrimProgress(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
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
    setTrimProgress(0);
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

      <div style={actions}>
        {/* Đóng: an toàn tuyệt đối (không áp dụng thì bản gốc không đổi) nên
            chỉ cần ghost/nhẹ tay, không cần cảnh báo đỏ như "Xoá bản quay" ở
            RecordReview. */}
        <button style={closeBtn} disabled={busy} onClick={doClose}>Đóng</button>
        {/* Kích thước ảnh: dời từ `metaRow` (đã bỏ) lên đây, bên phải cùng
            hàng với nút Áp dụng cắt — thời lượng không cần lặp lại nữa vì đã
            có ruler thời gian ngay trên timeline (xem `VideoTrimmer`). */}
        <div style={rightGroup}>
          {item && <span style={dimText}>{item.width} × {item.height}px</span>}
          <button style={applyBtn} disabled={busy || !item || !trimState.hasChanges} onClick={doApply}>
            {busy ? `Đang cắt… ${Math.round(trimProgress * 100)}%` : "Lưu"}
          </button>
        </div>
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

const actions: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
  // Đen — đồng bộ với `RecordReview.tsx` (cùng khuôn cửa sổ cắt video).
  background: "#000",
};

const rightGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const dimText: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
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
