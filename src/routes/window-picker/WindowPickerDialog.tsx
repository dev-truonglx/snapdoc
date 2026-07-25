import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ipc, type WindowMetaInfo, type WindowThumbReady } from "../../lib/ipc";

const params = new URLSearchParams(window.location.search);
const RECORD = params.get("record") === "1";

const ACCENT = "#f59e0b";

/**
 * Dialog "Chọn cửa sổ" dạng lưới thumbnail — tham khảo dialog "Select App
 * Window" của macOS: liệt kê TẤT CẢ cửa sổ đang mở kèm ảnh xem trước, người
 * dùng bấm chọn 1 ô rồi bấm nút Chụp/Quay để xác nhận. Khác hẳn overlay chọn
 * vùng/màn hình (không phủ kín màn hình, là 1 cửa sổ dialog bình thường —
 * xem `windows::open_window_picker`).
 *
 * Tải theo 2 bước KHÔNG đồng bộ để cảm giác nhanh hơn: (1) lấy metadata
 * (id/tên/kích thước, KHÔNG có ảnh) ngay lập tức, vẽ khung lưới + spinner
 * từng ô; (2) chụp thumbnail từng cửa sổ chạy nền, cửa sổ nào xong TRƯỚC
 * hiện ảnh TRƯỚC qua event `"window-thumb-ready"`, không đợi cả danh sách
 * chụp xong mới hiển thị.
 */
export default function WindowPickerDialog() {
  const { t } = useTranslation();
  const [metas, setMetas] = useState<WindowMetaInfo[] | null>(null);
  // undefined = chưa có kết quả (đang chụp), string = thumbnail sẵn sàng,
  // null = chụp lỗi (ẩn ô đó khỏi lưới).
  const thumbsRef = useRef<Record<number, string | null>>({});
  const [, bump] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentWindow().setTitle(t(RECORD ? "windowPicker.titleRecord" : "windowPicker.title")).catch(() => {});
  }, [t]);

  // Bước 1: metadata trước (nhanh) để vẽ khung lưới ngay.
  useEffect(() => {
    let cancelled = false;
    ipc.listWindowMetas()
      .then((m) => { if (!cancelled) setMetas(m); })
      .catch((e) => { if (!cancelled) { setMetas([]); setError(String(e)); } });
    return () => { cancelled = true; };
  }, []);

  // Bước 2: lắng nghe thumbnail đến dần — đăng ký TRƯỚC khi bắn lệnh chụp để
  // không lỡ mất event nào (race condition nếu backend trả về quá nhanh).
  useEffect(() => {
    const unlisten = listen<WindowThumbReady>("window-thumb-ready", (e) => {
      const [id, thumb] = e.payload;
      thumbsRef.current = { ...thumbsRef.current, [id]: thumb };
      bump((n) => n + 1);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (!metas || metas.length === 0) return;
    ipc.captureWindowThumbsStream(metas.map((m) => m.id)).catch(() => {});
  }, [metas]);

  const doCancel = () => ipc.cancelOverlay();

  const doConfirm = (id: number | null = selected) => {
    if (id == null || busy) return;
    setBusy(true);
    ipc.finalizeWindow(id).catch((e) => {
      setBusy(false);
      alert(String(e));
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); doCancel(); }
      if (e.key === "Enter" && selected != null) { e.preventDefault(); doConfirm(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, busy]);

  // Ẩn hẳn ô đã biết chụp lỗi (thumb === null); còn lại (chưa có kết quả)
  // vẫn hiện với spinner riêng trong ô, không chặn cả lưới.
  const visible = (metas ?? []).filter((m) => thumbsRef.current[m.id] !== null);
  const allSettled = (metas ?? []).every((m) => thumbsRef.current[m.id] !== undefined);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "#1e1e22",
        color: "#fff",
        fontFamily: "inherit",
      }}
    >
      <style>{SPIN_KEYFRAMES}</style>
      <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
        {metas === null ? (
          <div style={centerMsg}>
            <div style={spinnerStyle} />
          </div>
        ) : metas.length === 0 || (allSettled && visible.length === 0) ? (
          <div style={centerMsg}>{error ?? t("windowPicker.empty")}</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 16,
            }}
          >
            {visible.map((m) => {
              const isSel = m.id === selected;
              const thumb = thumbsRef.current[m.id];
              return (
                <div
                  key={m.id}
                  onClick={() => setSelected(m.id)}
                  onDoubleClick={() => { setSelected(m.id); doConfirm(m.id); }}
                  style={{
                    cursor: "pointer",
                    borderRadius: 10,
                    padding: 8,
                    background: isSel ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.04)",
                    border: `2px solid ${isSel ? ACCENT : "transparent"}`,
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      width: "100%",
                      aspectRatio: "16 / 10",
                      borderRadius: 6,
                      overflow: "hidden",
                      background: "#000",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {thumb ? (
                      <img
                        src={`data:image/png;base64,${thumb}`}
                        alt={m.title || m.app}
                        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                        draggable={false}
                      />
                    ) : (
                      <div style={{ ...spinnerStyle, width: 22, height: 22, borderWidth: 2 }} />
                    )}
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12.5,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      textAlign: "center",
                    }}
                    title={m.title || m.app}
                  >
                    {m.app || m.title}
                    {m.title && m.app && m.title !== m.app ? ` – ${m.title}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          padding: "14px 20px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(0,0,0,0.2)",
        }}
      >
        <button style={btnStyle(false)} onClick={doCancel} disabled={busy}>
          {t("windowPicker.cancel")}
        </button>
        <button style={btnStyle(true)} onClick={() => doConfirm()} disabled={busy || selected == null}>
          {busy
            ? t(RECORD ? "windowPicker.starting" : "windowPicker.capturing")
            : t(RECORD ? "windowPicker.record" : "windowPicker.capture")}
        </button>
      </div>
    </div>
  );
}

const centerMsg: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "rgba(255,255,255,0.6)",
  fontSize: 14,
};

const SPIN_KEYFRAMES = `@keyframes window-picker-spin { to { transform: rotate(360deg); } }`;

const spinnerStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.15)",
  borderTopColor: ACCENT,
  animation: "window-picker-spin 0.8s linear infinite",
};

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    cursor: "pointer",
    color: primary ? "#fff" : "#e5e7eb",
    background: primary ? ACCENT : "rgba(255,255,255,0.12)",
    whiteSpace: "nowrap",
  };
}
