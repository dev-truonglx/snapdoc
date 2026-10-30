import { error as logError, warn as logWarn } from "@tauri-apps/plugin-log";

/**
 * Chuyển `console.warn`/`console.error` (và lỗi/promise reject chưa bắt) của
 * webview sang logger Rust (`tauri-plugin-log`) — ghi chung file `SnapDoc.log`
 * với log phía Rust, để báo lỗi từ máy người dùng có đủ cả 2 phía.
 * KHÔNG chuyển `console.log`/`info` (quá nhiều, chủ yếu để debug lúc dev).
 * Console gốc vẫn được gọi như cũ.
 */
export function forwardConsoleToLog(win: string): void {
  if (!("__TAURI_INTERNALS__" in window)) return;

  const fmt = (args: unknown[]) =>
    `[webview:${win}] ` +
    args
      .map((a) => {
        if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");

  const wrap = (method: "warn" | "error", sink: (msg: string) => Promise<void>) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      // Lỗi ghi log không được làm hỏng (hay đệ quy vào) chính console.
      sink(fmt(args)).catch(() => {});
    };
  };
  wrap("warn", logWarn);
  wrap("error", logError);

  window.addEventListener("error", (e) => {
    logError(fmt([e.error ?? e.message])).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    logError(fmt(["Unhandled rejection:", e.reason])).catch(() => {});
  });
}
