import { useEffect } from "react";
import HistoryToolbar from "./HistoryToolbar";
import HistoryGrid from "./HistoryGrid";
import HistoryPreviewPanel from "./HistoryPreviewPanel";
import { useHistory } from "./useHistoryStore";
import { ipc } from "../../lib/ipc";

export default function HistoryWindow() {
  const reload = useHistory((s) => s.reload);

  useEffect(() => {
    reload();
  }, [reload]);

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
