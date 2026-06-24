import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Toolbar from "./Toolbar";
import AnnotationStage, { type StageHandle } from "../../features/annotation/canvas/AnnotationStage";
import { useEditor } from "../../features/annotation/store";
import { copyToClipboard, saveToFile } from "../../features/output/useOutput";
import { ipc, type Pending } from "../../lib/ipc";

export default function Editor() {
  const stageRef = useRef<StageHandle>(null);
  const loadDoc = useEditor((s) => s.loadDoc);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  const loadPending = async (p: Pending | null) => {
    if (!p) return;
    loadDoc({
      image: `data:image/png;base64,${p.base64}`,
      imgW: p.width,
      imgH: p.height,
      annotations: [],
    });
  };

  // Lấy ảnh chờ khi mở editor + khi có ảnh mới (event refresh-capture)
  useEffect(() => {
    ipc.takePending().then(loadPending);
    const un = listen("refresh-capture", () => {
      ipc.takePending().then(loadPending);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const doCopy = async () => {
    const url = stageRef.current?.exportPng();
    if (!url) return;
    setBusy(true);
    try {
      await copyToClipboard(url);
      flash("Đã copy vào clipboard");
    } finally {
      setBusy(false);
    }
  };

  const doSave = async (alsoCopy = false) => {
    const url = stageRef.current?.exportPng();
    if (!url) return;
    setBusy(true);
    try {
      const saved = await saveToFile(url, alsoCopy);
      if (saved) flash(alsoCopy ? "Đã lưu + copy" : `Đã lưu: ${saved}`);
    } finally {
      setBusy(false);
    }
  };

  // Phím tắt editor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useEditor.getState();
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? s.redo() : s.undo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doSave(e.shiftKey);
      } else if (mod && e.key.toLowerCase() === "c" && s.tool === "select") {
        doCopy();
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) {
        e.preventDefault();
        s.removeSelected();
      } else if (!mod) {
        const map: Record<string, string> = { v: "select", r: "rect", o: "ellipse", t: "text", n: "step", c: "crop" };
        const t = map[e.key.toLowerCase()];
        if (t) s.setTool(t as never);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="solid-bg" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar onSave={() => doSave(false)} onCopy={doCopy} onSaveCopy={() => doSave(true)} busy={busy} />
      <div style={{ flex: 1, minHeight: 0, background: "#161619" }}>
        <AnnotationStage ref={stageRef} />
      </div>
      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

const toastStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 20,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(20,20,24,0.95)",
  border: "1px solid var(--border)",
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 13,
};
