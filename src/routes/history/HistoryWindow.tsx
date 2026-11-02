import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import HistorySidebar from "./HistorySidebar";
import HistoryToolbar from "./HistoryToolbar";
import HistoryGrid from "./HistoryGrid";
import HistoryList from "./HistoryList";
import HistoryPreviewPanel from "./HistoryPreviewPanel";
import Settings from "../settings/Settings";
import { useHistory } from "./useHistoryStore";
import { ipc, type HistoryItem } from "../../lib/ipc";
import { showError } from "../../lib/notify";

export default function HistoryWindow() {
  const { t } = useTranslation();
  const reload = useHistory((s) => s.reload);
  const addItem = useHistory((s) => s.addItem);
  const viewMode = useHistory((s) => s.viewMode);
  const activeNav = useHistory((s) => s.activeNav);
  const setActiveNav = useHistory((s) => s.setActiveNav);
  const isRightPanelCollapsed = useHistory((s) => s.isRightPanelCollapsed);

  // Điều hướng từ Tray hoặc URL params (?nav=settings)
  useEffect(() => {
    const navParam = new URLSearchParams(window.location.search).get("nav");
    if (navParam === "settings") {
      setActiveNav("settings");
    } else if (navParam === "all" || navParam === "library") {
      setActiveNav("all");
    }

    const unlisten = listen<string>("history:navigate", (e) => {
      if (e.payload === "settings") {
        setActiveNav("settings");
      } else if (e.payload === "all" || e.payload === "library") {
        setActiveNav("all");
      } else if (e.payload === "trash") {
        setActiveNav("trash");
      }
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [setActiveNav]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Cắt video giờ xảy ra ngay trong Editor (webview RIÊNG với cửa sổ này) —
  // item mới cắt xong không thể `addItem` thẳng vào store ở đây được (mỗi
  // cửa sổ Tauri có JS heap/Zustand store độc lập), nên backend
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
      showError(e);
    }
  };

  // Phím tắt trong Thư viện: Delete/Backspace = xoá (vào Thùng rác; trong
  // Thùng rác thì xoá vĩnh viễn, có confirm như nút), Cmd/Ctrl+A = chọn hết,
  // Enter = mở Editor (chỉ khi chọn 1 mục), Esc = bỏ chọn. Bỏ qua khi đang gõ
  // trong input/textarea/contentEditable (vd ô đổi tên ở HistoryPreviewPanel).
  const busyRef = useRef(false);
  const openEditorRef = useRef(openEditor);
  openEditorRef.current = openEditor;
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (useHistory.getState().activeNav === "settings") return;
      const st = useHistory.getState();
      const ids = st.selectedIds.length > 0 ? st.selectedIds : st.selectedId ? [st.selectedId] : [];
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        st.selectAll();
      } else if (e.key === "Escape") {
        if (ids.length > 0) st.clearSelection();
      } else if (e.key === "Enter" && !mod) {
        if (tag === "BUTTON" || ids.length !== 1) return;
        const item = st.items.find((it) => it.id === ids[0]);
        if (!item || item.deletedAt != null) return;
        e.preventDefault();
        openEditorRef.current(item.id);
      } else if ((e.key === "Delete" || e.key === "Backspace") && !mod) {
        if (ids.length === 0 || busyRef.current) return;
        e.preventDefault();
        const trash = !!st.filter.trashOnly;
        if (
          trash &&
          !confirm(
            ids.length === 1
              ? t("history.permanentDeleteConfirm")
              : t("history.permanentDeleteSelectedConfirm", { count: ids.length }),
          )
        ) return;
        busyRef.current = true;
        try {
          if (trash) await ipc.permanentlyDeleteHistoryItems(ids);
          else await ipc.deleteHistoryItems(ids);
          useHistory.getState().removeItems(ids);
        } catch (err) {
          showError(err);
        } finally {
          busyRef.current = false;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t]);

  return (
    <div className="solid-bg" style={{ display: "flex", height: "100%", width: "100%", overflow: "hidden" }}>
      <HistorySidebar />

      {activeNav === "settings" ? (
        <div style={{ flex: 1, minWidth: 0, height: "100%", overflow: "hidden" }}>
          <Settings inline />
        </div>
      ) : (
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%" }}>
          <HistoryToolbar />
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {viewMode === "grid" ? (
              <HistoryGrid onOpenEditor={openEditor} />
            ) : (
              <HistoryList onOpenEditor={openEditor} />
            )}
            {!isRightPanelCollapsed && <HistoryPreviewPanel onOpenEditor={openEditor} />}
          </div>
        </div>
      )}
    </div>
  );
}
