import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";

const params = new URLSearchParams(window.location.search);
const mx = Number(params.get("mx") ?? "0");
const my = Number(params.get("my") ?? "0");
const rx = Number(params.get("rx") ?? "0");
const ry = Number(params.get("ry") ?? "0");
const rw = Number(params.get("rw") ?? "0");
const rh = Number(params.get("rh") ?? "0");

// Toàn bộ thuật toán so khớp/ghép nằm ở Rust (`capture::scroll_stitch`); panel
// này chỉ điều nhịp chụp, hiển thị preview thu nhỏ và các nút tuỳ chọn.
const DEBUG = false; // bật true để hiện log chẩn đoán (do Rust trả về) trên panel
const TICK_GAP_MS = 40; // nghỉ giữa 2 nhịp — nhịp sau chỉ bắt đầu khi nhịp trước xong
// Giới hạn chiều cao preview canvas để không vượt trần texture của trình duyệt.
const MAX_PREVIEW_CANVAS_HEIGHT = 16384;

// Khớp `scroll_stitch::TickStatus` và cờ trong `commands::scroll_response`.
const ST_FIRST = 0;
const ST_APPENDED = 1;
const ST_IDLE = 2;
const ST_LOST = 3;
const ST_REANCHORED = 4;
const FLAG_FOOTER = 1;
const FLAG_SIDEBAR = 2;
const FLAG_FAST = 4;

interface ScrollTick {
  status: number;
  flags: number;
  dy: number;
  canvasH: number;
  strips: number;
  previewW: number;
  previewFrom: number;
  previewTotal: number;
  diag: string;
  rgba: Uint8ClampedArray;
}

// Giải mã Binary IPC của `commands::scroll_response` (little-endian).
function parseScrollTick(buf: ArrayBuffer): ScrollTick {
  const v = new DataView(buf);
  const diagLen = v.getUint32(28, true);
  return {
    status: v.getUint8(0),
    flags: v.getUint8(1),
    dy: v.getInt32(4, true),
    canvasH: v.getUint32(8, true),
    strips: v.getUint32(12, true),
    previewW: v.getUint32(16, true),
    previewFrom: v.getUint32(20, true),
    previewTotal: v.getUint32(24, true),
    diag: new TextDecoder().decode(new Uint8Array(buf, 32, diagLen)),
    rgba: new Uint8ClampedArray(buf, 32 + diagLen),
  };
}

export default function ScrollControl() {
  const { t } = useTranslation();
  // Bắt đầu thẳng ở trạng thái "capturing": vẽ xong khung là tự động chụp
  const [status, setStatus] = useState<"ready" | "capturing" | "processing">("capturing");
  const [frameCount, setFrameCount] = useState(0);
  const [stitchedHeight, setStitchedHeight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Cảnh báo cuộn quá nhanh
  const [fastWarn, setFastWarn] = useState(false);
  // Mất dấu nối (hiện nút "nối tiếp" để bỏ qua khoảng trống)
  const [lostTracking, setLostTracking] = useState(false);

  // Chẩn đoán hiển thị ngay trên panel
  const [dbg, setDbg] = useState<string>("");
  const [logText, setLogText] = useState<string>("");
  const logRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const [copied, setCopied] = useState(false);

  // Footer cố định (ghim xuống đáy ảnh) & sidebar cố định (kéo dài màu nền) — Rust nhận diện
  const [pinFooterToBottom, setPinFooterToBottom] = useState(true);
  const [hasStickyFooter, setHasStickyFooter] = useState(false);
  const [extendSidebar, setExtendSidebar] = useState(true);
  const [hasSidebar, setHasSidebar] = useState(false);
  const optionsRef = useRef({ pinFooter: true, extendSidebar: true });

  // Preview canvas (độ phân giải preview) dùng "capacity doubling"
  const masterRef = useRef<HTMLCanvasElement | null>(null);
  const masterCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const usedHeightRef = useRef(0);
  const previewWRef = useRef(0);

  const isCapturingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  // Hàng đợi tuần tự hoá mọi lệnh IPC của phiên (nhịp chụp, tuỳ chọn, nối tiếp,
  // hoàn tất) để kết quả preview luôn áp dụng đúng thứ tự.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const cropWrapperRef = useRef<HTMLDivElement | null>(null);

  const runExclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queueRef.current.then(fn, fn);
    queueRef.current = next.catch(() => undefined);
    return next;
  };

  const stopLoop = () => {
    isCapturingRef.current = false;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const cleanupMemory = () => {
    stopLoop();
    if (masterRef.current) {
      masterRef.current.width = 0;
      masterRef.current.height = 0;
      masterRef.current = null;
      masterCtxRef.current = null;
    }
    if (cropWrapperRef.current) {
      cropWrapperRef.current.replaceChildren();
    }
    usedHeightRef.current = 0;
  };

  // Phím tắt bắt đầu / hoàn thành / huỷ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cleanupMemory();
        ipc.closeSelf();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (status === "ready") {
          startCapture();
        } else if (status === "capturing") {
          finishCapture();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  // Bảo đảm preview canvas đủ chỗ cho `neededHeight` dòng
  const ensureCapacity = (neededHeight: number, width: number) => {
    const current = masterRef.current;
    if (current && current.width === width && current.height >= neededHeight) {
      return;
    }
    const clampedNeeded = Math.min(neededHeight, MAX_PREVIEW_CANVAS_HEIGHT);
    const newCapacity = Math.min(
      MAX_PREVIEW_CANVAS_HEIGHT,
      Math.max(clampedNeeded, current && current.width === width ? current.height * 2 : clampedNeeded),
    );
    if (current && current.width === width && current.height >= newCapacity) {
      return;
    }
    const next = document.createElement("canvas");
    next.width = width;
    next.height = newCapacity;
    const ctx = next.getContext("2d");
    if (!ctx) return;
    if (current && current.width === width) ctx.drawImage(current, 0, 0);

    masterRef.current = next;
    masterCtxRef.current = ctx;

    // Gắn canvas vào DOM để hiển thị trực tiếp
    const host = cropWrapperRef.current;
    if (host) {
      next.style.position = "absolute";
      next.style.top = "0";
      next.style.left = "0";
      next.style.width = "100%";
      next.style.display = "block";
      host.replaceChildren(next);
    }
  };

  // Cắt vùng hiển thị theo nội dung thực
  const updatePreview = () => {
    const host = cropWrapperRef.current;
    const cont = scrollContainerRef.current;
    const fw = previewWRef.current;

    const stickToBottom = cont
      ? cont.scrollHeight - cont.scrollTop - cont.clientHeight < 48
      : true;

    if (host && fw > 0) {
      const contentWidth = host.clientWidth || cont?.clientWidth || fw;
      const scale = contentWidth / fw;
      host.style.height = `${Math.round(usedHeightRef.current * scale)}px`;
    }
    if (cont && stickToBottom) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
      });
    }
  };

  // Vẽ phần preview Rust trả về (chỉ các dòng đã đổi) và cập nhật thống kê.
  const applyTick = (tk: ScrollTick) => {
    const pw = tk.previewW;
    const rows = tk.previewTotal - tk.previewFrom;
    if (pw > 0 && rows > 0 && tk.rgba.length >= rows * pw * 4) {
      ensureCapacity(tk.previewTotal, pw);
      const data = new Uint8ClampedArray(tk.rgba.subarray(0, rows * pw * 4));
      masterCtxRef.current?.putImageData(new ImageData(data, pw, rows), 0, tk.previewFrom);
    }
    if (pw > 0) {
      usedHeightRef.current = Math.min(tk.previewTotal, MAX_PREVIEW_CANVAS_HEIGHT);
      setStitchedHeight(tk.canvasH);
      setFrameCount(tk.strips);
      setHasStickyFooter((tk.flags & FLAG_FOOTER) !== 0);
      setHasSidebar((tk.flags & FLAG_SIDEBAR) !== 0);
      updatePreview();
    }

    if (DEBUG && tk.diag) {
      seqRef.current++;
      const line = `#${seqRef.current} [${tk.status}] ${tk.diag} h=${tk.canvasH}`;
      setDbg(line);
      const buf = logRef.current;
      buf.push(line);
      if (buf.length > 400) buf.splice(0, buf.length - 400);
      setLogText(buf.join("\n"));
    }
  };

  // Nối tiếp từ vị trí hiện tại nếu người dùng chủ động bỏ qua khoảng nhảy
  const handleBridgeCurrentFrame = () => {
    void runExclusive(async () => {
      const tk = parseScrollTick(await ipc.scrollBridge(previewWRef.current));
      applyTick(tk);
      if (tk.status === ST_APPENDED) {
        setLostTracking(false);
        setFastWarn(false);
      }
    }).catch((err) => setError(String(err)));
  };

  const syncOptions = (next: { pinFooter: boolean; extendSidebar: boolean }) => {
    optionsRef.current = next;
    void runExclusive(async () => {
      const buf = await ipc.scrollSetOptions(next.pinFooter, next.extendSidebar, previewWRef.current);
      applyTick(parseScrollTick(buf));
    }).catch(console.error);
  };

  const togglePinFooter = () => {
    const next = { ...optionsRef.current, pinFooter: !optionsRef.current.pinFooter };
    setPinFooterToBottom(next.pinFooter);
    syncOptions(next);
  };

  const toggleExtendSidebar = () => {
    const next = { ...optionsRef.current, extendSidebar: !optionsRef.current.extendSidebar };
    setExtendSidebar(next.extendSidebar);
    syncOptions(next);
  };

  const captureTick = async () => {
    if (!isCapturingRef.current) return;
    try {
      const buf = await ipc.scrollTick(mx, my, rx, ry, rw, rh, previewWRef.current);
      if (!isCapturingRef.current) return;
      const tk = parseScrollTick(buf);
      applyTick(tk);
      switch (tk.status) {
        case ST_FIRST:
        case ST_APPENDED:
        case ST_REANCHORED:
          setFastWarn(false);
          setLostTracking(false);
          break;
        case ST_IDLE:
          setFastWarn(false);
          break;
        case ST_LOST:
          setLostTracking(true);
          setFastWarn((tk.flags & FLAG_FAST) !== 0);
          break;
      }
    } catch (err) {
      console.error(t("scroll.captureSliceError"), err);
      setError(String(err));
    }
  };

  const scheduleNext = () => {
    if (!isCapturingRef.current) return;
    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      await runExclusive(captureTick);
      scheduleNext();
    }, TICK_GAP_MS);
  };

  const startCapture = async () => {
    setStatus("capturing");
    isCapturingRef.current = true;
    setError(null);
    setFastWarn(false);
    setLostTracking(false);
    setHasStickyFooter(false);
    setHasSidebar(false);
    setPinFooterToBottom(true);
    setExtendSidebar(true);
    optionsRef.current = { pinFooter: true, extendSidebar: true };
    const cssW = cropWrapperRef.current?.clientWidth || scrollContainerRef.current?.clientWidth || 300;
    previewWRef.current = Math.max(120, Math.round(cssW * (window.devicePixelRatio || 1)));
    await ipc.startScrollSession().catch(console.error);

    // Chụp khung đầu tiên ngay lập tức, sau đó chạy vòng nhịp liên tục.
    await runExclusive(captureTick);
    scheduleNext();
  };

  // Tự động bắt đầu chụp ngay khi cửa sổ mở
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      void startCapture();
    }
    return () => cleanupMemory();
  }, []);

  const finishCapture = async () => {
    stopLoop();

    if (usedHeightRef.current === 0) {
      cleanupMemory();
      ipc.closeSelf();
      return;
    }

    setStatus("processing");
    try {
      // Rust dựng ảnh cuối theo tuỳ chọn ghim footer / kéo dài sidebar đã đồng bộ.
      await runExclusive(() => ipc.finalizeScrollStitch(mx, my));
      cleanupMemory();
      ipc.closeSelf();
    } catch (err) {
      setError(String(err));
      setStatus("capturing");
    }
  };

  return (
    <div style={panel} data-tauri-drag-region>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      {/* Header */}
      <div style={header} data-tauri-drag-region>
        <div style={status === "capturing" ? pulseDot : inactiveDot} />
        <span style={title} data-tauri-drag-region>{t("scroll.title")}</span>
      </div>

      {/* Slices Counter / Status */}
      <div style={statusRow} data-tauri-drag-region>
        {status === "ready" && <span style={statusText}>{t("scroll.readyCapture")}</span>}
        {status === "capturing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={fastWarn || lostTracking ? statusWarn : statusText}>
              {fastWarn
                ? t("scroll.scrollWarning")
                : lostTracking
                ? t("scroll.lostTracking")
                : t("scroll.recording")}
            </span>
            {lostTracking && (
              <button
                onClick={handleBridgeCurrentFrame}
                style={bridgeBtn}
                onMouseOver={(e) => Object.assign(e.currentTarget.style, bridgeBtnHover)}
                onMouseOut={(e) => Object.assign(e.currentTarget.style, bridgeBtn)}
              >
                {t("scroll.bridgeButton")}
              </button>
            )}
          </div>
        )}
        {status === "processing" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                display: "inline-block",
                width: 14,
                height: 14,
                border: "2px solid rgba(255,255,255,0.3)",
                borderTopColor: "var(--accent, #6366f1)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <span style={{ ...statusText, color: "var(--accent, #6366f1)", fontWeight: 600 }}>
              {t("scroll.rendering", "Đang kết xuất ảnh...")}
            </span>
          </div>
        )}
      </div>

      {/* Info Stats */}
      {status !== "ready" && (
        <div style={statsRow} data-tauri-drag-region>
          <span>{t("scroll.frameCount")} {frameCount}</span>
          <span>·</span>
          <span>{t("scroll.height")} {stitchedHeight}px</span>
          {hasStickyFooter && (
            <>
              <span>·</span>
              <button
                onClick={togglePinFooter}
                style={pinFooterToBottom ? footerPinBtnActive : footerPinBtnInactive}
                title={pinFooterToBottom ? t("scroll.removeFooter") : t("scroll.pinFooter")}
              >
                {pinFooterToBottom ? `📌 ${t("scroll.pinFooter")}` : `🚫 ${t("scroll.removeFooter")}`}
              </button>
            </>
          )}
          {hasSidebar && (
            <>
              <span>·</span>
              <button
                onClick={toggleExtendSidebar}
                style={extendSidebar ? footerPinBtnActive : footerPinBtnInactive}
                title={extendSidebar ? t("scroll.normalSidebar") : t("scroll.extendSidebar")}
              >
                {extendSidebar ? `📁 ${t("scroll.extendSidebar")}` : `📁 ${t("scroll.normalSidebar")}`}
              </button>
            </>
          )}
        </div>
      )}

      {DEBUG && status !== "ready" && dbg && (
        <div style={debugRow}>{dbg}</div>
      )}

      {DEBUG && status !== "ready" && (
        <div style={logBox}>
          <div style={logHeader}>
            <span>{t("scroll.diagnosticLog")} ({logRef.current.length})</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                style={logBtn}
                onClick={async () => {
                  const text = logRef.current.join("\n");
                  try {
                    await navigator.clipboard.writeText(text);
                  } catch {
                    /* fallback: bôi đen ô bên dưới rồi Ctrl/Cmd+C */
                  }
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? t("scroll.copied") : t("scroll.copy")}
              </button>
              <button
                style={logBtn}
                onClick={() => {
                  logRef.current = [];
                  seqRef.current = 0;
                  setLogText("");
                }}
              >
                {t("scroll.clear")}
              </button>
            </div>
          </div>
          <textarea readOnly style={logArea} value={logText} />
        </div>
      )}

      {/* Preview: canvas gắn thẳng vào DOM, cắt theo usedHeight — không encode PNG mỗi frame.
          LUÔN mount scrollContainer/cropWrapper để ref sẵn sàng trước khi chụp
          (startCapture gọi captureTick ngay, trước khi React kịp mount). */}
      <style>{`
        .preview-scroll-container {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        .preview-scroll-container::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `}</style>
      <div style={{ ...previewBox, position: "relative" }}>
        <div ref={scrollContainerRef} className="preview-scroll-container" style={scrollList}>
          <div ref={cropWrapperRef} style={cropWrapper} />
        </div>
        {status === "ready" && (
          <div style={emptyOverlay} data-tauri-drag-region>
            {t("scroll.startMessage")}
          </div>
        )}
        {status === "processing" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              background: "rgba(15, 23, 42, 0.75)",
              backdropFilter: "blur(4px)",
              color: "#fff",
              zIndex: 10,
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                border: "3px solid rgba(255, 255, 255, 0.2)",
                borderTopColor: "var(--accent, #6366f1)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <span>{t("scroll.rendering", "Đang kết xuất ảnh...")}</span>
          </div>
        )}
      </div>

      {error && <div style={errorBox}>{error}</div>}

      {/* Actions */}
      <div style={actionRow}>
        {status === "ready" && (
          <button
            onClick={startCapture}
            style={startBtn}
            onMouseOver={(e) => Object.assign(e.currentTarget.style, startBtnHover)}
            onMouseOut={(e) => Object.assign(e.currentTarget.style, startBtn)}
          >
            {t("scroll.startButton")}
          </button>
        )}

        {status === "capturing" && (
          <button
            onClick={finishCapture}
            style={finishBtn}
            onMouseOver={(e) => Object.assign(e.currentTarget.style, finishBtnHover)}
            onMouseOut={(e) => Object.assign(e.currentTarget.style, finishBtn)}
          >
            {t("scroll.finishButton")}
          </button>
        )}

        {status === "processing" && (
          <button disabled style={processingBtn}>
            {t("scroll.processingButton")}
          </button>
        )}

        <button
          onClick={() => {
            cleanupMemory();
            ipc.closeSelf();
          }}
          disabled={status === "processing"}
          style={cancelBtn}
          onMouseOver={(e) => Object.assign(e.currentTarget.style, cancelBtnHover)}
          onMouseOut={(e) => Object.assign(e.currentTarget.style, cancelBtn)}
        >
          {t("scroll.cancelButton")}
        </button>
      </div>
    </div>
  );
}

/* ── Panel Styles ── */
const panel: React.CSSProperties = {
  height: "100%",
  boxSizing: "border-box",
  background: "rgba(22, 22, 28, 0.88)",
  backdropFilter: "blur(20px)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 16,
  padding: "16px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  color: "#f8fafc",
  fontFamily: "Inter, system-ui, sans-serif",
  boxShadow: "0 24px 48px rgba(0,0,0,0.5)",
  overflow: "hidden",
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const pulseDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#ef4444",
  boxShadow: "0 0 12px #ef4444",
  animation: "pulse 1.8s infinite alternate",
};

const inactiveDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#64748b",
};

const title: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const statusRow: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: "#f1f5f9",
};

const statusText: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.3,
};

const statusWarn: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.3,
  color: "#fbbf24",
};

const statsRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "#94a3b8",
};

const footerPinBtnActive: React.CSSProperties = {
  background: "rgba(99, 102, 241, 0.18)",
  border: "1px solid rgba(99, 102, 241, 0.4)",
  borderRadius: 6,
  padding: "1px 6px",
  fontSize: 10,
  fontWeight: 500,
  color: "#a5b4fc",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  transition: "all 0.15s ease",
};

const footerPinBtnInactive: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.05)",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  borderRadius: 6,
  padding: "1px 6px",
  fontSize: 10,
  fontWeight: 500,
  color: "#64748b",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  transition: "all 0.15s ease",
};

const debugRow: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "ui-monospace, Menlo, monospace",
  color: "#fbbf24",
  background: "rgba(0,0,0,0.35)",
  borderRadius: 6,
  padding: "4px 6px",
  wordBreak: "break-all",
};

const logBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const logHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 10,
  color: "#94a3b8",
};

const logBtn: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.08)",
  color: "#e2e8f0",
  cursor: "pointer",
};

const logArea: React.CSSProperties = {
  width: "100%",
  height: 90,
  resize: "vertical",
  fontSize: 10,
  lineHeight: 1.35,
  fontFamily: "ui-monospace, Menlo, monospace",
  color: "#cbd5e1",
  background: "rgba(0,0,0,0.45)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 6,
  padding: 6,
  boxSizing: "border-box",
  whiteSpace: "pre",
};

const previewBox: React.CSSProperties = {
  flex: 1,
  position: "relative",
  background: "rgba(0, 0, 0, 0.25)",
  border: "1px solid rgba(255, 255, 255, 0.05)",
  borderRadius: 10,
  minHeight: 120,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const emptyOverlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  color: "#64748b",
  textAlign: "center",
  padding: 12,
  lineHeight: 1.4,
};

const scrollList: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  scrollbarWidth: "none",
  padding: 6,
  display: "flex",
  flexDirection: "column",
  background: "repeating-conic-gradient(#1e1e24 0% 25%, #16161c 0% 50%) 50%/12px 12px",
};

const cropWrapper: React.CSSProperties = {
  position: "relative",
  width: "100%",
  // KHÔNG để flexbox của scrollList co lại — nếu co, chiều cao đặt động bị bóp
  // vừa khung nên container không tràn để cuộn được.
  flexShrink: 0,
  overflow: "hidden",
  borderRadius: 4,
  transform: "translateZ(0)",
  backfaceVisibility: "hidden",
};

const errorBox: React.CSSProperties = {
  fontSize: 11,
  color: "#fca5a5",
  background: "rgba(239, 68, 68, 0.1)",
  border: "1px solid rgba(239, 68, 68, 0.2)",
  borderRadius: 6,
  padding: 8,
};

const actionRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const startBtn: React.CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: "none",
  background: "linear-gradient(135deg, #10b981, #059669)",
  color: "#ffffff",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  boxShadow: "0 4px 12px rgba(16, 185, 129, 0.25)",
  transition: "all 0.15s ease",
};

const startBtnHover: React.CSSProperties = {
  background: "linear-gradient(135deg, #34d399, #059669)",
  transform: "translateY(-1px)",
  boxShadow: "0 6px 16px rgba(16, 185, 129, 0.35)",
};

const finishBtn: React.CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: "none",
  background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
  color: "#ffffff",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  boxShadow: "0 4px 12px rgba(59, 130, 246, 0.3)",
  transition: "all 0.15s ease",
};

const finishBtnHover: React.CSSProperties = {
  background: "linear-gradient(135deg, #60a5fa, #2563eb)",
  transform: "translateY(-1px)",
  boxShadow: "0 6px 16px rgba(59, 130, 246, 0.4)",
};

const processingBtn: React.CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: "none",
  background: "rgba(255, 255, 255, 0.1)",
  color: "#64748b",
  fontWeight: 600,
  fontSize: 13,
  cursor: "not-allowed",
};

const cancelBtn: React.CSSProperties = {
  width: "100%",
  height: 32,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.06)",
  background: "rgba(255, 255, 255, 0.05)",
  color: "#94a3b8",
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const cancelBtnHover: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.1)",
  color: "#cbd5e1",
};

const bridgeBtn: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid rgba(251, 191, 36, 0.4)",
  background: "rgba(251, 191, 36, 0.15)",
  color: "#fef08a",
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.15s ease",
  alignSelf: "flex-start",
  marginTop: 2,
};

const bridgeBtnHover: React.CSSProperties = {
  background: "rgba(251, 191, 36, 0.25)",
  color: "#ffffff",
  borderColor: "rgba(251, 191, 36, 0.6)",
};

