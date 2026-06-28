import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../../lib/ipc";
import { copyToClipboard, saveToFile } from "../../features/output/useOutput";

export default function Thumbnail() {
  const [src, setSrc] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    ipc.hideThumbnail();
  };

  const startAutoClose = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => ipc.hideThumbnail(), 6000);
  };

  useEffect(() => {
    // Nhận data trực tiếp qua event từ Rust — không cần IPC peekPending roundtrip.
    // Rust emit "show-thumbnail" với base64 string ngay trước khi show window.
    const unlisten = listen<string>("show-thumbnail", (e) => {
      if (e.payload) setSrc(`data:image/png;base64,${e.payload}`);
      startAutoClose();
    });

    // Fallback: window pre-warmed sẵn, event đã emit trước khi listener mount.
    ipc.peekPending().then((p) => {
      if (p?.base64) setSrc((prev) => prev || `data:image/png;base64,${p.base64}`);
    });
    startAutoClose();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unlisten.then((fn) => fn());
    };
  }, []);

  const edit = async () => {
    await ipc.openEditor();
    dismiss();
  };
  const copy = async () => {
    if (src) await copyToClipboard(src);
    dismiss();
  };
  const saveFile = async () => {
    if (src) await saveToFile(src);
    dismiss();
  };

  return (
    <div style={card}>
      {src && <img src={src} style={preview} onClick={edit} title="Nhấn để mở editor" />}
      <div style={actions}>
        <button style={btn} onClick={edit} title="Sửa">✎ Sửa</button>
        <button style={btn} onClick={copy} title="Copy">📋</button>
        <button style={btn} onClick={saveFile} title="Lưu">💾</button>
        <button style={btn} onClick={dismiss} title="Đóng">✕</button>
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
