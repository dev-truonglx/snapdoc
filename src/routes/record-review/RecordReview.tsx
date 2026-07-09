import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  // Gương lại trạng thái chỉnh sửa của VideoTrimmer (nó ẩn nút "Áp dụng cắt"
  // riêng — xem `showApplyButton={false}` bên dưới) để nút Lưu ở đây biết có
  // cần tự áp dụng cắt trước khi lưu không, xem `doApplyAndSave`.
  const [trimState, setTrimState] = useState<{ hasChanges: boolean; keepRanges: [number, number][] }>({
    hasChanges: false,
    keepRanges: [],
  });

  useEffect(() => {
    ipc.peekPendingRecording()
      .then((p) => (p ? setPending(p) : setNotFound(true)))
      .catch(() => setNotFound(true));
  }, []);

  // Cửa sổ giờ có titlebar thật (nút đóng, xem `open_record_review` ở
  // backend) — Rust chặn close mặc định cho label "record-review" và emit
  // event này thay vào đó, để bấm nút "x" cũng phải qua đúng xác nhận
  // Xoá/Huỷ (không được đóng "trắng" làm mất bản quay mà không hỏi).
  // `doDiscardRef` giữ bản MỚI NHẤT của `doDiscard` — effect chỉ đăng ký
  // listener 1 lần (mount), không muốn phụ thuộc `busy`/`pending` (sẽ phải
  // huỷ/đăng ký lại listener liên tục, tốn kém không cần thiết).
  const doDiscardRef = useRef<() => void>(() => {});
  useEffect(() => {
    const unlisten = listen("record-review-close-requested", () => doDiscardRef.current());
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Gộp "Áp dụng cắt" + "Lưu" thành 1 hành động — nếu còn thay đổi chưa áp
  // dụng (`trimState.hasChanges`), tự cắt trước rồi mới lưu, người dùng chỉ
  // cần bấm 1 nút thay vì phải bấm Áp dụng cắt xong rồi bấm tiếp Lưu. Không
  // cần cập nhật lại `pending`/reload video sau khi cắt như bản cũ — cửa sổ
  // đóng ngay sau khi lưu thành công, không ai còn xem lại video trong này
  // nữa (xem `confirmRecordingSave` → đóng cửa sổ ở backend).
  const doApplyAndSave = async () => {
    if (busy || !pending) return;
    setBusy(true);
    try {
      if (trimState.hasChanges) {
        await ipc.trimPendingRecording(trimState.keepRanges);
      }
      await ipc.confirmRecordingSave();
    } catch (e) {
      alert(String(e));
      setBusy(false);
    }
  };

  const doDiscard = async () => {
    if (busy || !pending) return;
    if (!confirm("Xoá bản quay này? Không thể hoàn tác.")) return;
    setBusy(true);
    try {
      await ipc.confirmRecordingDiscard();
    } catch (e) {
      alert(String(e));
      setBusy(false);
    }
  };
  doDiscardRef.current = doDiscard;

  return (
    <div style={card}>
      <div style={previewWrap}>
        {pending ? (
          <VideoTrimmer
            key={pending.path}
            src={convertFileSrc(pending.path)}
            filePath={pending.path}
            durationMs={pending.durationMs}
            busy={busy}
            showApplyButton={false}
            onStateChange={setTrimState}
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
        {/* Huỷ/Xoá: thao tác phụ, nhẹ tay (ghost, không tô đậm) — nút đóng
            titlebar thật giờ cũng dẫn tới đúng hành động này (xem
            `doDiscardRef`), nên không cần 1 khối to ngang hàng với Lưu nữa. */}
        <button style={discardBtn} disabled={busy || !pending} onClick={doDiscard}>Xoá bản quay</button>
        {/* Lưu: hành động CHÍNH của màn hình này — gộp cả áp dụng cắt (nếu có
            thay đổi chưa áp dụng) vào chung nút này, xem `doApplyAndSave`.
            Đổi nhãn theo `trimState.hasChanges` để không "hứa" áp dụng cắt
            khi chẳng có gì để cắt. */}
        <button style={saveBtn} disabled={busy || !pending} onClick={doApplyAndSave}>
          {busy ? "Đang lưu…" : trimState.hasChanges ? "Áp dụng cắt và lưu" : "Lưu vào Lịch sử"}
        </button>
      </div>
    </div>
  );
}

// Cửa sổ giờ có titlebar/nền thật (xem `open_record_review`) — không cần tự
// vẽ khối "card" nổi (bo góc/viền/đổ bóng/nền riêng) như hồi còn borderless
// nữa, để mặc `--bg` chuẩn của app hiện qua `<body>`.
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

// `space-between` (không phải 2 nút `flex:1` bằng nhau như cũ) — Xoá là thao
// tác PHỤ (nút đóng titlebar thật đã lo phần này, xem `doDiscardRef`), Lưu là
// thao tác CHÍNH của cả màn hình → tách rõ 2 đầu, không đặt cạnh nhau như 1
// cặp lựa chọn ngang hàng.
const actions: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
};

const saveBtn: React.CSSProperties = {
  padding: "10px 22px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontWeight: 600,
  fontSize: 13,
};

// Ghost/text button — không viền/nền tô đậm như bản cũ, chỉ chữ màu đỏ nhạt,
// đúng mức "phụ" (xem giải thích ở `actions`).
const discardBtn: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "transparent",
  color: "#f87171",
  fontWeight: 500,
  fontSize: 13,
};
