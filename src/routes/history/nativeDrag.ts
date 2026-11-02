import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ipc, type HistoryItem } from "../../lib/ipc";
import { useHistory } from "./useHistoryStore";

const DRAG_THRESHOLD = 5;

let justDragged = false;

/**
 * Kiểm tra xem người dùng vừa thực hiện hành động kéo thả hay không.
 * Giúp ngăn chặn sự kiện click / select ngoài ý muốn ngay sau khi thả chuột.
 */
export function wasJustDragged(): boolean {
  return justDragged;
}

/**
 * Bắt đầu native drag trực tiếp cho 1 hoặc nhiều HistoryItem.
 */
export async function startNativeDrag(item: HistoryItem, customSelectedIds?: string[]) {
  try {
    justDragged = true;
    (window as any).__snapdocDraggingHistoryId = item.id;
    const storeSelectedIds = customSelectedIds ?? useHistory.getState().selectedIds;
    // Nếu item đang kéo nằm trong danh sách chọn nhiều, kéo toàn bộ các item được chọn
    const targetIds =
      storeSelectedIds.length > 1 && storeSelectedIds.includes(item.id)
        ? storeSelectedIds
        : [item.id];

    // Lấy đường dẫn file thật trên hệ thống từ backend Rust
    const filePaths = await ipc.prepareHistoryDragItems(targetIds);
    if (!filePaths || filePaths.length === 0) {
      justDragged = false;
      (window as any).__snapdocDraggingHistoryId = null;
      return;
    }

    // Bắt đầu native drag OS session (macOS NSDraggingSession / Windows DoDragDrop)
    await startDrag({
      item: filePaths,
      icon: item.thumbPath,
      mode: "copy",
    });
  } catch (err) {
    console.error("[NativeDrag] Failed to start native drag:", err);
  } finally {
    // Trì hoãn một chút để browser nuốt sự kiện click/mouseUp sau drag
    setTimeout(() => {
      justDragged = false;
      (window as any).__snapdocDraggingHistoryId = null;
    }, 250);
  }
}

/**
 * Kéo thả trực tiếp tài liệu đang chỉnh sửa trong Editor ra ngoài app.
 */
export async function startEditorCanvasDrag(
  getImageData: () => string | null | undefined,
  fileName?: string
) {
  try {
    justDragged = true;
    const dataUrl = getImageData();
    if (!dataUrl) {
      justDragged = false;
      return;
    }

    const filePath = await ipc.prepareEditorDragFile(dataUrl, fileName);
    if (!filePath) {
      justDragged = false;
      return;
    }

    await startDrag({
      item: [filePath],
      icon: filePath,
      mode: "copy",
    });
  } catch (err) {
    console.error("[NativeDrag] Lỗi kéo thả ảnh từ Editor:", err);
  } finally {
    setTimeout(() => {
      justDragged = false;
    }, 150);
  }
}

/**
 * Kéo thả trực tiếp video đang chỉnh sửa trong Editor ra ngoài app.
 */
export async function startVideoDocDrag(filePath: string, thumbPath?: string) {
  try {
    justDragged = true;
    await startDrag({
      item: [filePath],
      icon: thumbPath || filePath,
      mode: "copy",
    });
  } catch (err) {
    console.error("[NativeDrag] Lỗi kéo thả video từ Editor:", err);
  } finally {
    setTimeout(() => {
      justDragged = false;
    }, 150);
  }
}

/**
 * Handler pointerdown cho nút kéo thả trên Toolbar của Editor.
 */
export function createEditorDragPointerDownHandler(
  getDocData: () => { type: "image"; getDataUrl: () => string | null | undefined; title?: string } | { type: "video"; filePath: string; thumbPath?: string } | null
) {
  return (e: React.PointerEvent) => {
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragInitiated = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (dragInitiated) return;

      const deltaX = Math.abs(moveEvent.clientX - startX);
      const deltaY = Math.abs(moveEvent.clientY - startY);

      if (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD) {
        dragInitiated = true;
        cleanup();
        const doc = getDocData();
        if (!doc) return;
        if (doc.type === "image") {
          void startEditorCanvasDrag(doc.getDataUrl, doc.title);
        } else if (doc.type === "video") {
          void startVideoDocDrag(doc.filePath, doc.thumbPath);
        }
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    const onPointerUp = () => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };
}

/**
 * Tạo listener onPointerDown cho một HistoryItem để hỗ trợ Native Drag & Drop Out.
 * Không can thiệp click / double-click bình thường nếu không di chuyển chuột quá 5px.
 */
export function createItemPointerDownHandler(item: HistoryItem, customSelectedIds?: string[]) {
  return (e: React.PointerEvent) => {
    // Chỉ kích hoạt khi nhấn chuột trái
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragInitiated = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (dragInitiated) return;

      const deltaX = Math.abs(moveEvent.clientX - startX);
      const deltaY = Math.abs(moveEvent.clientY - startY);

      if (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD) {
        dragInitiated = true;
        cleanup();
        void startNativeDrag(item, customSelectedIds);
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    const onPointerUp = () => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };
}
