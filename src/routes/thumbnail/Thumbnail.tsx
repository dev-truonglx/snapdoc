import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { copyToClipboard, saveToFile } from "../../features/output/useOutput";

export default function Thumbnail() {
  const [src, setSrc] = useState("");

  useEffect(() => {
    ipc.peekPending().then((p) => {
      if (p) setSrc(`data:image/png;base64,${p.base64}`);
    });
    const t = window.setTimeout(() => ipc.closeSelf(), 6000);
    return () => window.clearTimeout(t);
  }, []);

  const edit = async () => {
    await ipc.openEditor();
    ipc.closeSelf();
  };
  const copy = async () => {
    if (src) await copyToClipboard(src);
    ipc.closeSelf();
  };
  const saveFile = async () => {
    if (src) await saveToFile(src);
    ipc.closeSelf();
  };

  return (
    <div style={card}>
      {src && <img src={src} style={preview} />}
      <div style={actions}>
        <button style={btn} onClick={edit} title="Sửa">
          ✎ Sửa
        </button>
        <button style={btn} onClick={copy} title="Copy">
          📋
        </button>
        <button style={btn} onClick={saveFile} title="Lưu">
          💾
        </button>
        <button style={btn} onClick={() => ipc.closeSelf()} title="Đóng">
          ✕
        </button>
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
const preview: React.CSSProperties = { flex: 1, minHeight: 0, objectFit: "cover", width: "100%" };
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
