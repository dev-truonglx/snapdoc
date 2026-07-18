import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ipc, type PendingRecording } from "../../lib/ipc";
import VideoTrimmer from "../../features/video-trim/VideoTrimmer";
import { promptSaveVideoPath, dirnameOf, basenameOf } from "../../features/output/useOutput";

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
  const [trimState, setTrimState] = useState<{ hasChanges: boolean; keepRanges: [number, number][]; removeAudio: boolean }>({
    hasChanges: false,
    keepRanges: [],
    removeAudio: false,
  });
  // Tiến độ cắt (0..1), `null` = không đang cắt (đang chờ khác/đã xong) — chỉ
  // có ý nghĩa trong lúc `trimPendingRecording` chạy, xem `doApplyAndSave`.
  // Backend emit % thật từ ffmpeg (`out_time_us`, xem `encoder::trim`), không
  // phải giả lập — nên bỏ qua an toàn nếu không nhận được gì (giữ `null`).
  const [trimProgress, setTrimProgress] = useState<number | null>(null);
  // Thư mục lưu tuỳ chọn cho LẦN LƯU NÀY — `null` = giữ nguyên vị trí mặc định
  // (saveDir trong Settings, nơi file mp4 đã nằm sẵn từ lúc quay xong). Chỉ là
  // lựa chọn tạm thời của phiên xem lại này, không ghi đè `saveDir` trong
  // Settings (xem `record::confirm_recording_save_to`).
  const [customSaveTarget, setCustomSaveTarget] = useState<string | null>(null);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSaveMenu) return;
    const onClickOutside = (e: MouseEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setShowSaveMenu(false);
      }
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [showSaveMenu]);

  useEffect(() => {
    ipc.peekPendingRecording()
      .then((p) => (p ? setPending(p) : setNotFound(true)))
      .catch(() => setNotFound(true));
  }, []);

  useEffect(() => {
    const unlisten = listen<number>("trim-progress", (e) => setTrimProgress(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
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
  // `destTargetOverride`: dùng khi gọi thẳng từ `pickSaveTarget` (chọn xong
  // là lưu luôn ngay, không đợi bấm thêm nút Lưu) — ưu tiên hơn
  // `customSaveTarget` đã lưu trong state vì state đó có thể chưa kịp cập
  // nhật (setState bất đồng bộ) tại thời điểm gọi hàm này trong cùng 1 handler.
  const doApplyAndSave = async (destTargetOverride?: string) => {
    if (busy || !pending) return;
    setBusy(true);
    try {
      if (trimState.hasChanges) {
        setTrimProgress(0);
        await ipc.trimPendingRecording(trimState.keepRanges, trimState.removeAudio);
        // Xong bước cắt — quay về `null` để nhãn nút chuyển qua "Đang lưu…"
        // (ingest vào History không có tiến độ %, xem `confirmRecordingSave`).
        setTrimProgress(null);
      }
      await ipc.confirmRecordingSave(destTargetOverride ?? customSaveTarget ?? undefined);
    } catch (e) {
      alert(String(e));
      setBusy(false);
      setTrimProgress(null);
    }
  };

  // Đường dẫn lưu SẼ dùng nếu bấm "Lưu" ngay bây giờ — ưu tiên lựa chọn tuỳ ý
  // (`customSaveTarget`), rơi về file mp4 đang nằm sẵn (mặc định) nếu chưa
  // chọn gì khác.
  const currentSaveTarget = customSaveTarget ?? (pending ? pending.path : null);
  const currentSaveDir = currentSaveTarget ? dirnameOf(currentSaveTarget) : null;

  /** Mở dialog lưu file — cho phép đổi cả thư mục lẫn tên file, rồi lưu ngay.
   * Ưu tiên thư mục LẦN CUỐI user từng chọn qua "Lưu thành…" (`lastVideoSaveAsDir`)
   * làm mặc định (giữ nguyên tên file gốc), thay vì luôn quay về vị trí file
   * đang nằm sẵn — để lần "Lưu thành…" kế tiếp không phải tự điều hướng lại.
   * Lưu xong ghi nhớ luôn thư mục vừa chọn cho lần sau. */
  const pickSaveTarget = async () => {
    setShowSaveMenu(false);
    if (!pending) return;
    const settings = await ipc.getSettings().catch(() => null);
    const lastDir = settings?.lastVideoSaveAsDir;
    const defaultPath = lastDir
      ? `${lastDir}/${basenameOf(pending.path)}`
      : currentSaveTarget ?? pending.path;
    const path = await promptSaveVideoPath(defaultPath);
    if (!path) return;
    if (settings) {
      ipc.setSettings({ ...settings, lastVideoSaveAsDir: dirnameOf(path) }).catch(() => {});
    }
    setCustomSaveTarget(path);
    doApplyAndSave(path);
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

  // "Quay lại": xoá bản quay đang xem rồi mở CaptureBar đúng phạm vi vừa quay
  // (`pending.captureMode`) — xem `record::redo_recording`. Cửa sổ này tự
  // đóng ở backend sau khi xoá xong (giống Xoá/Lưu), không cần tự đóng ở đây.
  const doRedo = async () => {
    if (busy || !pending) return;
    if (!confirm("Xoá bản quay này để quay lại?")) return;
    setBusy(true);
    try {
      await ipc.redoRecording();
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

      <div style={actions}>
        {/* Huỷ/Xoá + Quay lại: cả 2 đều là thao tác phụ, nhẹ tay (ghost, không
            tô đậm) — nút đóng titlebar thật vẫn dẫn tới đúng hành động Xoá
            (xem `doDiscardRef`), nên không cần 1 khối to ngang hàng với Lưu. */}
        <div style={leftGroup}>
          <button style={discardBtn} disabled={busy || !pending} onClick={doDiscard}>Xoá</button>
          {/* "Quay lại": xoá bản quay này rồi mở CaptureBar đúng phạm vi vừa
              quay để quay lại ngay — xem `doRedo`. */}
          <button style={discardBtn} disabled={busy || !pending} onClick={doRedo}>Quay lại</button>
        </div>
        {/* Kích thước ảnh: dời từ `metaRow` (đã bỏ, xem `previewWrap`) lên
            đây, bên phải cùng hàng với nút Lưu — thời lượng không cần lặp lại
            nữa vì đã có ruler thời gian ngay trên timeline (xem `VideoTrimmer`). */}
        <div style={rightGroup}>
          {pending && <span style={dimText}>{pending.width} × {pending.height}px</span>}
          {/* Luôn hiện thư mục SẼ lưu vào — mặc định là chỗ file mp4 đang nằm
              sẵn (thư mục chứa `pending.path`, xem `dirnameOf`), hoặc thư mục
              vừa chọn ở popover nếu có — để người dùng biết ngay từ lúc mở màn
              xem lại, không phải đợi bấm gì mới rõ. */}
          {currentSaveDir && (
            <span style={dimText} title={currentSaveDir}>
              Lưu tại: {currentSaveDir.split(/[\\/]/).filter(Boolean).pop()}
            </span>
          )}
          <div ref={saveMenuRef} style={saveGroup}>
            {/* Lưu: hành động CHÍNH của màn hình này — gộp cả áp dụng cắt (nếu
                có thay đổi chưa áp dụng) vào chung nút này, xem `doApplyAndSave`.
                Đổi nhãn theo `trimState.hasChanges` để không "hứa" áp dụng cắt
                khi chẳng có gì để cắt. */}
            <button style={saveBtn} disabled={busy || !pending} onClick={() => doApplyAndSave()}>
              {trimProgress != null
                ? `Đang cắt… ${Math.round(trimProgress * 100)}%`
                : busy
                ? "Đang lưu…"
                : "Lưu"}
            </button>
            {/* Option nhỏ cạnh nút Lưu — chọn thư mục lưu khác cho riêng lần
                này, không đụng tới nút Lưu chính (tránh bấm nhầm mở dialog khi
                chỉ muốn lưu ngay). */}
            <button
              style={saveMenuBtn}
              disabled={busy || !pending}
              title="Chọn thư mục lưu khác"
              aria-label="Chọn thư mục lưu khác"
              onClick={(e) => { e.stopPropagation(); setShowSaveMenu((v) => !v); }}
            >
              ▾
            </button>
            {showSaveMenu && (
              <div style={saveMenuPopover}>
                <button style={saveMenuItem} onClick={pickSaveTarget}>Lưu thành…</button>
                {customSaveTarget && (
                  <button
                    style={saveMenuItem}
                    onClick={() => { setCustomSaveTarget(null); setShowSaveMenu(false); }}
                  >
                    Dùng file mặc định
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
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

// `space-between` (không phải 2 nút `flex:1` bằng nhau như cũ) — Xoá là thao
// tác PHỤ (nút đóng titlebar thật đã lo phần này, xem `doDiscardRef`), Lưu là
// thao tác CHÍNH của cả màn hình → tách rõ 2 đầu, không đặt cạnh nhau như 1
// cặp lựa chọn ngang hàng.
const actions: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 14px",
  // borderTop: "1px solid var(--border)",
  // Đen (thay vì màu nền app xám mặc định) — đồng bộ với `previewWrap` phía
  // trên, để cả preview + footer nút Lưu/Xoá liền thành 1 khối đen.
  background: "#000",
};

const leftGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
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

// Bọc nút Lưu + nút mũi tên nhỏ chọn thư mục — cùng khối để trông như 1 nút
// "split button" (Lưu | ▾) thay vì 2 nút rời rạc, và làm điểm neo `position:
// relative` cho popover bên dưới.
const saveGroup: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "stretch",
};

const saveBtn: React.CSSProperties = {
  padding: "10px 22px",
  borderRadius: "8px 0 0 8px",
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontWeight: 600,
  fontSize: 13,
};

// Mũi tên nhỏ mở popover chọn thư mục — cùng màu nền với nút Lưu nhưng tách
// biệt bằng 1 viền mảnh, đúng hình dáng "split button" quen thuộc.
const saveMenuBtn: React.CSSProperties = {
  padding: "10px 10px",
  borderRadius: "0 8px 8px 0",
  borderLeft: "1px solid rgba(0,0,0,0.15)",
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontSize: 11,
  opacity: 0.85,
};

const saveMenuPopover: React.CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  right: 0,
  background: "rgba(30,30,36,0.99)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 -4px 20px rgba(0,0,0,0.4)",
  zIndex: 100,
  whiteSpace: "nowrap",
};

const saveMenuItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text, #cdd6f4)",
  background: "transparent",
  textAlign: "left",
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
