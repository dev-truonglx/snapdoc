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
  const [showFlattenConfirm, setShowFlattenConfirm] = useState(false);

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
      scaleFactor: p.scale_factor ?? 1,
      annotations: [],
    });
  };

  // Lấy ảnh chờ khi mở editor + khi có ảnh mới (event refresh-capture)
  useEffect(() => {
    // [DEV] Chạy trên trình duyệt thuần (không Tauri) → nạp ảnh test để thử UI.
    if (!("__TAURI_INTERNALS__" in window)) {
      const c = document.createElement("canvas");
      c.width = 800;
      c.height = 500;
      const g = c.getContext("2d")!;
      g.fillStyle = "#cbd5e1";
      g.fillRect(0, 0, 800, 500);
      g.fillStyle = "#475569";
      g.fillRect(40, 40, 720, 420);
      loadDoc({ image: c.toDataURL("image/png"), imgW: 800, imgH: 500, scaleFactor: 1, annotations: [] });
      return;
    }
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
      // Đang gõ trong ô nhập (vd: textarea chú thích chữ) → không cướp phím,
      // nếu không các ký tự v/r/o/t/n/c sẽ bị hiểu thành phím đổi công cụ.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const s = useEditor.getState();

      // Guard 1 (theo focus): mục tiêu sự kiện là ô nhập liệu.
      // Guard 2 (theo state): đang có text annotation mở để gõ, kể cả khi
      // focus chưa kịp về textarea (hay gặp trong webview Tauri).
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable || s.editingTextId) {
        console.log("[text-input] keydown bỏ qua (đang nhập)", {
          key: e.key,
          tag,
          editingTextId: s.editingTextId,
          active: document.activeElement?.tagName,
        });
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? s.redo() : s.undo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doSave(e.shiftKey);
      } else if (mod && e.key.toLowerCase() === "c" && s.tool === "select") {
        doCopy();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        stageRef.current?.zoomIn();
      } else if (mod && e.key === "-") {
        e.preventDefault();
        stageRef.current?.zoomOut();
      } else if (mod && e.key === "0") {
        e.preventDefault();
        stageRef.current?.zoomFit();
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) {
        e.preventDefault();
        s.removeSelected();
      } else if (!mod) {
        const map: Record<string, string> = { v: "select", r: "rect", o: "ellipse", t: "text", n: "step", a: "arrow", l: "line", w: "numbered-arrow", h: "highlight", b: "blur", c: "crop" };
        const t = map[e.key.toLowerCase()];
        if (t) s.setTool(t as never);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const doFlatten = () => {
    setShowFlattenConfirm(true);
  };

  // "New" — mở capture bar với mode gần nhất pre-selected (xử lý timing ở Rust)
  const doNew = async () => {
    await ipc.openCaptureBarForNew().catch(() => {});
  };

  const confirmFlatten = () => {
    setShowFlattenConfirm(false);
    // Export canvas thành data URL rồi loadDoc lại với annotations rỗng.
    // Blur/highlight/annotation đều được "burn" vào pixel → không thể undo bằng metadata.
    const url = stageRef.current?.flattenPng();
    if (!url) return;
    const { doc } = useEditor.getState();
    if (!doc) return;
    // Đo kích thước ảnh đã flatten qua Image element
    const el = new Image();
    el.onload = () => {
      useEditor.getState().loadDoc({
        image: url,
        imgW: el.naturalWidth,
        imgH: el.naturalHeight,
        scaleFactor: doc.scaleFactor,
        annotations: [],
      });
      flash("Đã flatten — annotation đã được ghi vào ảnh");
    };
    el.src = url;
  };

  return (
    <div className="solid-bg" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar onSave={() => doSave(false)} onCopy={doCopy} onSaveCopy={() => doSave(true)} onFlatten={doFlatten} onNew={doNew} busy={busy} />
      <div style={{ flex: 1, minHeight: 0, background: "#161619" }}>
        <AnnotationStage ref={stageRef} />
      </div>
      {toast && <div style={toastStyle}>{toast}</div>}
      {showFlattenConfirm && (
        <FlattenConfirmDialog
          onConfirm={confirmFlatten}
          onCancel={() => setShowFlattenConfirm(false)}
        />
      )}
    </div>
  );
}

/* ── Flatten Confirm Dialog ── */

function FlattenConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  // Đóng khi nhấn Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        {/* Icon + tiêu đề */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 22 }}>🔒</span>
          <span style={{ fontSize: 15, fontWeight: 600, color: "#fca5a5" }}>Flatten ảnh?</span>
        </div>

        {/* Mô tả */}
        <p style={descStyle}>
          Thao tác này sẽ <strong style={{ color: "#f87171" }}>ghi tất cả annotation vào ảnh gốc</strong> và không thể hoàn tác (Undo sẽ bị xóa).
        </p>

        <ul style={listStyle}>
          <li>Mọi lớp vẽ (blur, highlight, text, mũi tên…) sẽ được <strong>hợp nhất thành pixel</strong> trong ảnh.</li>
          <li>Toàn bộ lịch sử Undo/Redo sẽ bị <strong>xóa sạch</strong>.</li>
          <li>Ảnh sau khi flatten vẫn <strong>chưa được lưu</strong> — bạn cần bấm Save để lưu tiếp.</li>
        </ul>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
          <button style={cancelBtnStyle} onClick={onCancel}>
            Huỷ
          </button>
          <button style={confirmBtnStyle} onClick={onConfirm} autoFocus>
            Flatten
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  background: "var(--bg-elevated, #1e1e24)",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 12,
  padding: "22px 24px",
  width: 380,
  maxWidth: "90vw",
  boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
};

const descStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--text, #e2e8f0)",
  lineHeight: 1.6,
  margin: "0 0 12px",
};

const listStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim, #94a3b8)",
  lineHeight: 1.7,
  paddingLeft: 18,
  margin: 0,
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 18px",
  borderRadius: 7,
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  background: "transparent",
  color: "var(--text-dim, #94a3b8)",
  fontSize: 13,
  cursor: "pointer",
};

const confirmBtnStyle: React.CSSProperties = {
  padding: "7px 18px",
  borderRadius: 7,
  border: "1px solid rgba(239,68,68,0.4)",
  background: "rgba(239,68,68,0.2)",
  color: "#fca5a5",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

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
