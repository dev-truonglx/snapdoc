import { message } from "@tauri-apps/plugin-dialog";

/**
 * Báo lỗi cho người dùng bằng hộp thoại NATIVE (NSAlert / MessageBox).
 *
 * KHÔNG dùng `window.alert()`: WKWebView (macOS) không hiện `alert()` nên lỗi
 * biến mất hoàn toàn; trên Windows alert lại hiện trong đúng cửa sổ webview
 * gọi nó (thường đang ẩn, vd CaptureBar trong lúc quay).
 */
export function showError(err: unknown): void {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  console.error("[SnapDoc]", text);
  message(text, { title: "SnapDoc", kind: "error" }).catch(() => {});
}
