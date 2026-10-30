import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";
import { copyToClipboard, saveToFile } from "../../features/output/useOutput";

export default function Thumbnail() {
  const { t } = useTranslation();
  const [src, setSrc] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `src` hiện tại (để revoke blob: URL cũ) + số thứ tự lần nạp (bỏ kết quả
  // peekPending đã cũ khi có capture mới hơn).
  const srcRef = useRef("");
  const seqRef = useRef(0);
  // Ảnh FULL-RES cho Copy/Save khi `src` chỉ là ảnh xem trước nhỏ do Rust gửi
  // kèm event (`null` = `src` đã là full-res). Lấy ngay lúc hiện, không đợi
  // tới lúc bấm: pending có thể bị Editor lấy mất trong lúc thumbnail còn mở.
  const fullRef = useRef<Promise<string> | null>(null);

  const revokeIfBlob = (url: string) => {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  };

  const replaceSrc = (next: string) => {
    const prev = srcRef.current;
    if (prev === next) return;
    revokeIfBlob(prev);
    srcRef.current = next;
    setSrc(next);
  };

  const releaseFull = () => {
    const full = fullRef.current;
    fullRef.current = null;
    void full?.then(revokeIfBlob);
  };

  const fetchFull = async (): Promise<string> => {
    const p = await ipc.peekPending().catch(() => null);
    return p?.imageUrl || (p?.base64 ? `data:image/png;base64,${p.base64}` : "");
  };

  /** Ảnh dùng cho Copy/Save — luôn là bản full-res của đúng lần chụp đang hiện
   * (không lấy được thì trả rỗng, KHÔNG lùi về ảnh xem trước nhỏ). */
  const fullImage = async (): Promise<string> =>
    fullRef.current ? await fullRef.current : srcRef.current;

  // Ẩn cửa sổ + giải phóng ảnh (blob: URL) — lần show sau luôn nạp ảnh mới.
  const hideAndRelease = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    seqRef.current++;
    replaceSrc("");
    releaseFull();
    ipc.hideThumbnail();
  };

  const dismiss = hideAndRelease;

  const startAutoClose = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(hideAndRelease, 6000);
  };

  // Đang copy/lưu (dialog có thể mở lâu) → không để auto-close revoke ảnh giữa chừng.
  const stopAutoClose = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  useEffect(() => {
    /** `onlyIfEmpty`: nhánh fallback lúc mount — không đè ảnh event đã nạp. */
    const loadThumbnail = async (onlyIfEmpty: boolean) => {
      const seq = ++seqRef.current;
      const p = await ipc.peekPending();
      const next = p?.imageUrl || (p?.base64 ? `data:image/png;base64,${p.base64}` : "");
      if (!next) return;
      if (seq !== seqRef.current || (onlyIfEmpty && srcRef.current)) {
        revokeIfBlob(next);
        return;
      }
      replaceSrc(next);
    };

    const unlisten = listen<string>("show-thumbnail", (e) => {
      // Capture mới → luôn thay ảnh cũ.
      releaseFull();
      if (e.payload) {
        // Payload = ảnh xem trước JPEG nhỏ (xem `windows::open_thumbnail`).
        seqRef.current++;
        replaceSrc(`data:image/jpeg;base64,${e.payload}`);
        fullRef.current = fetchFull();
      } else {
        loadThumbnail(false);
      }
      startAutoClose();
    });

    // Fallback: window vừa được show nhưng event "show-thumbnail" có thể đến
    // trước listener mount (race condition). Dùng peekPending để lấy ảnh nếu src chưa có.
    const fallbackTimer = setTimeout(() => {
      if (!srcRef.current) loadThumbnail(true);
    }, 100);

    startAutoClose();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      clearTimeout(fallbackTimer);
      unlisten.then((fn) => fn());
      seqRef.current++;
      revokeIfBlob(srcRef.current);
      srcRef.current = "";
      releaseFull();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const edit = async () => {
    stopAutoClose();
    await ipc.openEditor();
    dismiss();
  };
  const copy = async () => {
    stopAutoClose();
    const img = await fullImage();
    if (img) await copyToClipboard(img).catch((e) => console.error("Thumbnail copy failed:", e));
    dismiss();
  };
  const saveFile = async () => {
    stopAutoClose();
    const img = await fullImage();
    if (img) await saveToFile(img).catch((e) => console.error("Thumbnail save failed:", e));
    dismiss();
  };

  return (
    <div style={card}>
      {src && <img src={src} style={preview} onClick={edit} title={t("thumbnail.openEditorTooltip")} />}
      <div style={actions}>
        <button style={btn} onClick={edit} title={t("thumbnail.editTitle")}>{t("thumbnail.editButton")}</button>
        <button style={btn} onClick={copy} title={t("thumbnail.copyTitle")}>📋</button>
        <button style={btn} onClick={saveFile} title={t("thumbnail.saveTitle")}>💾</button>
        <button style={btn} onClick={dismiss} title={t("thumbnail.closeTitle")}>✕</button>
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "rgba(38,38,44,0.97)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
};
const preview: React.CSSProperties = { flex: 1, minHeight: 0, objectFit: "cover", width: "100%", cursor: "pointer" };
const actions: React.CSSProperties = {
  display: "flex",
  gap: 4,
  padding: 6,
  borderTop: "1px solid rgba(255,255,255,0.08)",
};
const btn: React.CSSProperties = {
  flex: 1,
  padding: "6px 4px",
  borderRadius: 6,
  fontSize: 12,
  background: "rgba(255,255,255,0.06)",
};
