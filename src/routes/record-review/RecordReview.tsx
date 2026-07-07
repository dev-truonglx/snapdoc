import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, type PendingRecording } from "../../lib/ipc";
import VideoTrimmer from "../../features/video-trim/VideoTrimmer";

/** `93500` → `"1:34"` — mm:ss. */
function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Cửa sổ bắt buộc xác nhận NGAY sau khi dừng quay (xem
 * `record::stop_recording` — không ingest vào History tự động nữa, chờ
 * người dùng chọn ở đây). Không tự đóng/timeout: quay xong là dữ liệu quan
 * trọng, phải để người dùng chủ động quyết định thay vì tự huỷ như
 * `Thumbnail.tsx` (ảnh có thể chụp lại dễ, video thì không). */
export default function RecordReview() {
  const [pending, setPending] = useState<PendingRecording | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trimming, setTrimming] = useState(false);
  // `pending.path` KHÔNG đổi sau khi cắt (ghi đè tại chỗ) — bump nonce này để
  // đổi `key` của VideoTrimmer/video, buộc webview tải lại nội dung mới thay
  // vì dùng bản đã cache theo URL cũ.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    ipc.peekPendingRecording()
      .then((p) => (p ? setPending(p) : setNotFound(true)))
      .catch(() => setNotFound(true));
  }, []);

  const doTrim = async (ranges: [number, number][]) => {
    setTrimming(true);
    try {
      const updated = await ipc.trimPendingRecording(ranges);
      setPending(updated);
      setReloadNonce((n) => n + 1);
    } catch (e) {
      alert(String(e));
    } finally {
      setTrimming(false);
    }
  };

  const doSave = async () => {
    setBusy(true);
    try {
      await ipc.confirmRecordingSave();
    } catch (e) {
      alert(String(e));
      setBusy(false);
    }
  };

  const doDiscard = async () => {
    if (!confirm("Xoá bản quay này? Không thể hoàn tác.")) return;
    setBusy(true);
    try {
      await ipc.confirmRecordingDiscard();
    } catch (e) {
      alert(String(e));
      setBusy(false);
    }
  };

  return (
    <div style={card}>
      <div style={previewWrap}>
        {pending ? (
          <VideoTrimmer
            key={`${pending.path}-${reloadNonce}`}
            src={`${convertFileSrc(pending.path)}?v=${reloadNonce}`}
            durationMs={pending.durationMs}
            busy={trimming}
            onApply={doTrim}
          />
        ) : (
          <div style={placeholder}>{notFound ? "Không tìm thấy bản quay để xem lại" : "Đang tải…"}</div>
        )}
      </div>

      {pending && (
        <div style={metaRow}>
          <span>{fmtDuration(pending.durationMs)}</span>
          <span>{pending.width} × {pending.height}px</span>
        </div>
      )}

      <div style={actions}>
        <button style={discardBtn} disabled={busy || !pending} onClick={doDiscard}>Xoá</button>
        <button style={saveBtn} disabled={busy || !pending} onClick={doSave}>Lưu</button>
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "rgba(30,30,36,0.99)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
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
  borderTop: "1px solid rgba(255,255,255,0.08)",
};

const actions: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: 12,
};

const saveBtn: React.CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
};

const discardBtn: React.CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid rgba(239,68,68,0.4)",
  background: "rgba(239,68,68,0.15)",
  color: "#fca5a5",
  fontWeight: 600,
  fontSize: 13,
};
