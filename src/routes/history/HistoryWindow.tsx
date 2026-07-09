import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import HistoryToolbar from "./HistoryToolbar";
import HistoryGrid from "./HistoryGrid";
import HistoryPreviewPanel from "./HistoryPreviewPanel";
import { useHistory } from "./useHistoryStore";
import { ipc, type HistoryItem } from "../../lib/ipc";

export default function HistoryWindow() {
  const reload = useHistory((s) => s.reload);
  const addItem = useHistory((s) => s.addItem);

  useEffect(() => {
    reload();
  }, [reload]);

  // Cửa sổ "history-trim" (xem `HistoryTrim.tsx`) là 1 webview RIÊNG — item
  // mới cắt xong không thể `addItem` thẳng vào store ở đây được (mỗi cửa sổ
  // Tauri có JS heap/Zustand store độc lập), nên backend
  // (`history/commands.rs::trim_history_video`) emit event này để cửa sổ
  // History (đúng chỗ hiển thị danh sách) tự cập nhật.
  useEffect(() => {
    const unlisten = listen<HistoryItem>("history:item-added", (e) => addItem(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, [addItem]);

  const openEditor = async (id: string) => {
    try {
      await ipc.openHistoryItemInEditor(id);
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <div className="solid-bg" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <HistoryToolbar />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <HistoryGrid onOpenEditor={openEditor} />
        <HistoryPreviewPanel onOpenEditor={openEditor} />
      </div>
    </div>
  );
}
