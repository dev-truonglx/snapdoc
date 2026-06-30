import { useEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";

const params = new URLSearchParams(window.location.search);
const mx = Number(params.get("mx") ?? "0");
const my = Number(params.get("my") ?? "0");
const rx = Number(params.get("rx") ?? "0");
const ry = Number(params.get("ry") ?? "0");
const rw = Number(params.get("rw") ?? "0");
const rh = Number(params.get("rh") ?? "0");

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Không tải được ảnh chụp"));
    img.src = src;
  });
}

const COLOR_TOL = 12; // sai khác màu cho phép mỗi kênh
const SCROLLBAR_MARGIN = 25; // bỏ lề phải tránh thanh cuộn
const SAME_RATIO = 0.92; // tỉ lệ điểm khớp để coi 2 dòng "y hệt" (vùng cố định)
const MATCH_RATIO = 0.82; // tỉ lệ điểm khớp để coi 2 dòng là "cùng nội dung" (đã dịch)

// Tỉ lệ điểm ảnh khớp giữa 2 dòng (so theo mẫu, bỏ lề phải tránh thanh cuộn).
// Trả về [0..1]. Dùng tỉ lệ thay vì "tất-cả-hoặc-không" để bền với con trỏ
// chuột, cột sidebar tĩnh, khử răng cưa hay widget động nhỏ trên dòng.
function rowMatchRatio(
  d1: Uint8ClampedArray,
  off1: number,
  d2: Uint8ClampedArray,
  off2: number,
  w: number,
): number {
  let total = 0;
  let ok = 0;
  for (let x = 0; x < w - SCROLLBAR_MARGIN; x += 6) {
    const i1 = off1 + x * 4;
    const i2 = off2 + x * 4;
    total++;
    if (
      Math.abs(d1[i1] - d2[i2]) <= COLOR_TOL &&
      Math.abs(d1[i1 + 1] - d2[i2 + 1]) <= COLOR_TOL &&
      Math.abs(d1[i1 + 2] - d2[i2 + 2]) <= COLOR_TOL
    ) {
      ok++;
    }
  }
  return total === 0 ? 1 : ok / total;
}

// Dòng có "nội dung" (chữ, viền, ảnh...) chứ không phải nền trơn — dùng làm mốc.
function isRowInteresting(img: ImageData, y: number, w: number): boolean {
  const d = img.data;
  const off = y * w * 4;
  const r0 = d[off + 4];
  const g0 = d[off + 5];
  const b0 = d[off + 6];
  for (let x = 12; x < w - SCROLLBAR_MARGIN; x += 12) {
    const i = off + x * 4;
    if (
      Math.abs(d[i] - r0) > 12 ||
      Math.abs(d[i + 1] - g0) > 12 ||
      Math.abs(d[i + 2] - b0) > 12
    ) {
      return true;
    }
  }
  return false;
}

interface ScrollAnalysis {
  dy: number; // số pixel nội dung mới (0 = không cuộn, -1 = không khớp được)
  topFixed: number; // chiều cao dải cố định trên (header dính)
  botFixed: number; // chiều cao dải cố định dưới (footer dính / nền trơn cuối)
}

// Phân tích 2 khung liên tiếp: phát hiện dải cố định (header/footer dính) rồi
// tính khoảng cuộn dy CHỈ trong vùng thực sự cuộn. Nhờ đó:
//   - Không nhận nhầm "không cuộn" khi một phần khung (đáy/đỉnh) đứng yên.
//   - Không nhân đôi header/footer dính khi ghép.
function analyzeScroll(prev: ImageData, cur: ImageData): ScrollAnalysis {
  const w = prev.width;
  const h = prev.height;
  const stride = w * 4;
  const p = prev.data;
  const c = cur.data;
  const maxBand = Math.floor(h * 0.5);

  // 1) Dải cố định trên: các dòng đầu KHỚP Ở CÙNG VỊ TRÍ giữa 2 khung.
  let topFixed = 0;
  while (
    topFixed < maxBand &&
    rowMatchRatio(p, topFixed * stride, c, topFixed * stride, w) >= SAME_RATIO
  ) {
    topFixed++;
  }

  // 2) Dải cố định dưới.
  let botFixed = 0;
  while (
    botFixed < maxBand &&
    rowMatchRatio(p, (h - 1 - botFixed) * stride, c, (h - 1 - botFixed) * stride, w) >= SAME_RATIO
  ) {
    botFixed++;
  }

  const scrollTop = topFixed;
  const scrollBottom = h - botFixed;

  // Cả khung gần như tĩnh ở cùng vị trí → không cuộn.
  if (scrollBottom - scrollTop < 24) {
    return { dy: 0, topFixed, botFixed };
  }

  // 3) Chọn dòng mốc có nội dung, gần ĐÁY vùng cuộn của prev.
  const landmarks: number[] = [];
  let y = scrollBottom - 4;
  while (y > scrollTop + 4 && landmarks.length < 4) {
    if (isRowInteresting(prev, y, w)) landmarks.push(y);
    y -= 8;
  }
  if (landmarks.length < 2) {
    landmarks.length = 0;
    for (let k = 1; k <= 4; k++) {
      const ly = scrollBottom - k * 6;
      if (ly > scrollTop) landmarks.push(ly);
    }
  }

  // 4) Quét dy: nội dung dịch LÊN dy px nên prev[y] ≈ cur[y - dy] trong vùng cuộn.
  const maxDy = scrollBottom - scrollTop - 4;
  for (let dy = 2; dy <= maxDy; dy++) {
    let matched = 0;
    let tooFar = false;
    for (const ly of landmarks) {
      const ty = ly - dy;
      if (ty < scrollTop) {
        tooFar = true;
        break;
      }
      if (rowMatchRatio(p, ly * stride, c, ty * stride, w) >= MATCH_RATIO) matched++;
    }
    if (tooFar) break; // dy đã vượt quá tầm của mốc
    if (matched < landmarks.length) continue;

    // Xác thực toàn vùng chồng lấn (đa số dòng phải khớp).
    const startY = scrollTop + dy;
    if (scrollBottom - startY < 8) continue;
    const step = Math.max(1, Math.floor((scrollBottom - startY) / 12));
    let rows = 0;
    let okRows = 0;
    for (let vy = startY; vy < scrollBottom; vy += step) {
      rows++;
      if (rowMatchRatio(p, vy * stride, c, (vy - dy) * stride, w) >= MATCH_RATIO) okRows++;
    }
    if (rows > 0 && okRows / rows >= 0.85) {
      return { dy, topFixed, botFixed };
    }
  }

  return { dy: -1, topFixed, botFixed };
}

export default function ScrollControl() {
  // Bắt đầu thẳng ở trạng thái "capturing": vẽ xong khung là tự động chụp, nút
  // "Hoàn thành" hiện ngay (không cần nhấn "Bắt đầu").
  const [status, setStatus] = useState<"ready" | "capturing" | "processing">("capturing");
  const [frameCount, setFrameCount] = useState(0);
  const [stitchedHeight, setStitchedHeight] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Master canvas dùng "capacity doubling": vùng nhớ (capacity) cao hơn nội
  // dung thực (usedHeight) để KHÔNG phải tạo canvas mới + copy lại toàn bộ ảnh
  // mỗi khung hình (tránh O(n²) copy). Canvas được gắn thẳng vào DOM để xem
  // trước, nên KHÔNG cần encode PNG (toDataURL) mỗi tick nữa — đây là điểm tốn
  // kém nhất của bản cũ.
  const masterRef = useRef<HTMLCanvasElement | null>(null);
  const masterCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const usedHeightRef = useRef(0);
  const frameWidthRef = useRef(0);
  const prevImageDataRef = useRef<ImageData | null>(null);
  const instructionsRef = useRef<{ sliceIndex: number; srcY: number; srcH: number }[]>([]);
  const totalSlicesRef = useRef(0);

  const isCapturingRef = useRef(false);
  const tickBusyRef = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const startedRef = useRef(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const cropWrapperRef = useRef<HTMLDivElement | null>(null);

  // Phím tắt bắt đầu / hoàn thành / huỷ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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

  // Bảo đảm master canvas đủ chỗ cho `neededHeight` dòng. Chỉ tạo canvas mới +
  // copy lại khi thật sự hết chỗ (nhân đôi dung lượng) → amortized O(n) thay vì
  // tạo + copy toàn bộ mỗi frame như bản cũ (O(n²)).
  const ensureCapacity = (neededHeight: number, width: number) => {
    const current = masterRef.current;
    if (current && current.width === width && current.height >= neededHeight) {
      return;
    }
    const newCapacity = Math.max(
      neededHeight,
      current ? current.height * 2 : neededHeight,
    );
    const next = document.createElement("canvas");
    next.width = width;
    next.height = newCapacity;
    const ctx = next.getContext("2d");
    if (!ctx) return;
    if (current) ctx.drawImage(current, 0, 0);

    masterRef.current = next;
    masterCtxRef.current = ctx;

    // Gắn (hoặc thay) canvas vào DOM để hiển thị trực tiếp, không encode PNG.
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

  // Cắt vùng hiển thị theo nội dung thực (ẩn phần capacity dư) và tự cuộn theo
  // ảnh ghép để tiện theo dõi. Chỉ bám đáy khi người dùng ĐANG ở gần đáy — nếu
  // họ chủ động cuộn lên xem lại thì không bị kéo xuống.
  const updatePreview = () => {
    const host = cropWrapperRef.current;
    const cont = scrollContainerRef.current;
    const fw = frameWidthRef.current;

    // Đo trạng thái cuộn TRƯỚC khi đổi chiều cao (dựa trên nội dung cũ).
    const stickToBottom = cont
      ? cont.scrollHeight - cont.scrollTop - cont.clientHeight < 48
      : true;

    if (host && fw > 0) {
      const contentWidth = host.clientWidth || cont?.clientWidth || fw;
      const scale = contentWidth / fw;
      host.style.height = `${Math.round(usedHeightRef.current * scale)}px`;
    }
    if (cont && stickToBottom) cont.scrollTop = cont.scrollHeight;
  };

  const captureTick = async () => {
    // tickBusyRef chống chồng lấn: nếu 1 tick xử lý lâu hơn 220ms thì tick kế
    // tiếp bị bỏ qua thay vì xếp chồng (gây giật + trùng frame).
    if (!isCapturingRef.current || tickBusyRef.current) return;
    tickBusyRef.current = true;
    try {
      const base64 = await ipc.captureScrollSlice(mx, my, rx, ry, rw, rh);
      if (!base64 || !isCapturingRef.current) return;

      const sliceIdx = totalSlicesRef.current;
      totalSlicesRef.current++;

      const img = await loadImage(`data:image/png;base64,${base64}`);
      const fw = img.naturalWidth;
      const fh = img.naturalHeight;

      // Lấy ImageData của frame mới để so khớp.
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = fw;
      tempCanvas.height = fh;
      const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
      if (!tempCtx) return;
      tempCtx.drawImage(img, 0, 0);
      const newImgData = tempCtx.getImageData(0, 0, fw, fh);

      if (!masterRef.current || !prevImageDataRef.current) {
        // Frame đầu tiên.
        frameWidthRef.current = fw;
        ensureCapacity(fh, fw);
        masterCtxRef.current?.drawImage(img, 0, 0);
        usedHeightRef.current = fh;
        prevImageDataRef.current = newImgData;
        instructionsRef.current = [
          { sliceIndex: sliceIdx, srcY: 0, srcH: fh }
        ];
        setStitchedHeight(fh);
        setFrameCount(1);
        updatePreview();
        return;
      }

      // Các frame tiếp theo: phân tích cuộn + dải cố định.
      const { dy, botFixed } = analyzeScroll(prevImageDataRef.current, newImgData);

      if (dy > 0) {
        // Có cuộn THẬT. Chỉ NỐI đúng dy dòng nội dung mới vừa lộ ra ở đáy vùng
        // cuộn (ngay trên footer dính nếu có) — KHÔNG vẽ lại header/footer dính
        // nên không bị lặp/chồng chéo.
        const srcY = fh - botFixed - dy; // đáy vùng cuộn, lùi lên dy dòng
        const at = usedHeightRef.current;
        ensureCapacity(at + dy, fw);
        masterCtxRef.current?.drawImage(img, 0, srcY, fw, dy, 0, at, fw, dy);
        usedHeightRef.current = at + dy;
        prevImageDataRef.current = newImgData;
        instructionsRef.current.push({
          sliceIndex: sliceIdx,
          srcY,
          srcH: dy
        });
        setStitchedHeight(usedHeightRef.current);
        setFrameCount((prev) => prev + 1);
        updatePreview();
      } else {
        // dy === 0 (không cuộn / trang đứng yên) hoặc dy === -1 (không khớp được,
        // ví dụ cuộn > 1 màn hình mỗi tick): KHÔNG nối để tránh lặp/đứt đoạn,
        // chỉ cập nhật khung tham chiếu cho lần sau.
        prevImageDataRef.current = newImgData;
      }
    } catch (err) {
      console.error("Lỗi chụp cuộn slice:", err);
    } finally {
      tickBusyRef.current = false;
    }
  };

  const stopLoop = () => {
    isCapturingRef.current = false;
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const startCapture = async () => {
    setStatus("capturing");
    isCapturingRef.current = true;
    setError(null);
    instructionsRef.current = [];
    totalSlicesRef.current = 0;
    await ipc.startScrollSession().catch(console.error);

    // Chụp lát cắt đầu tiên ngay lập tức.
    await captureTick();

    // Vòng lặp chụp mỗi 220ms.
    intervalRef.current = window.setInterval(() => {
      if (!isCapturingRef.current) {
        stopLoop();
        return;
      }
      void captureTick();
    }, 220);
  };

  // Tự động bắt đầu chụp ngay khi cửa sổ mở (vẽ xong khung). startedRef chống
  // gọi 2 lần do StrictMode double-invoke effect ở chế độ dev.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startCapture();
  }, []);

  const finishCapture = async () => {
    stopLoop();

    // Dùng ref (luôn cập nhật) thay vì state frameCount — tránh stale closure
    // khi gọi từ handler bàn phím (effect bắt phím chỉ re-subscribe theo status).
    if (usedHeightRef.current === 0) {
      ipc.closeSelf();
      return;
    }

    setStatus("processing");
    try {
      const w = frameWidthRef.current;
      await ipc.finalizeScrollStitch(w, instructionsRef.current);
      ipc.closeSelf();
    } catch (err) {
      setError(String(err));
      setStatus("capturing");
    }
  };

  return (
    <div style={panel} data-tauri-drag-region>
      {/* Header */}
      <div style={header} data-tauri-drag-region>
        <div style={status === "capturing" ? pulseDot : inactiveDot} />
        <span style={title} data-tauri-drag-region>Chụp cuộn</span>
      </div>

      {/* Slices Counter / Status */}
      <div style={statusRow} data-tauri-drag-region>
        {status === "ready" && <span style={statusText}>Sẵn sàng chụp</span>}
        {status === "capturing" && (
          <span style={statusText}>Đang ghi... Cuộn trang</span>
        )}
        {status === "processing" && <span style={statusText}>Đang kết xuất...</span>}
      </div>

      {/* Info Stats */}
      {status !== "ready" && (
        <div style={statsRow} data-tauri-drag-region>
          <span>Khung hình: {frameCount}</span>
          <span>·</span>
          <span>Chiều cao: {stitchedHeight}px</span>
        </div>
      )}

      {/* Preview: canvas gắn thẳng vào DOM, cắt theo usedHeight — không encode PNG mỗi frame.
          LUÔN mount scrollContainer/cropWrapper để ref sẵn sàng trước khi chụp
          (startCapture gọi captureTick ngay, trước khi React kịp mount). */}
      <div style={previewBox}>
        <div ref={scrollContainerRef} style={scrollList}>
          <div ref={cropWrapperRef} style={cropWrapper} />
        </div>
        {status === "ready" && (
          <div style={emptyOverlay} data-tauri-drag-region>
            Nhấn Bắt đầu rồi cuộn chuột từ từ để ghi lại trang dài
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
            Bắt đầu (Space)
          </button>
        )}

        {status === "capturing" && (
          <button
            onClick={finishCapture}
            style={finishBtn}
            onMouseOver={(e) => Object.assign(e.currentTarget.style, finishBtnHover)}
            onMouseOut={(e) => Object.assign(e.currentTarget.style, finishBtn)}
          >
            Hoàn thành (Enter)
          </button>
        )}

        {status === "processing" && (
          <button disabled style={processingBtn}>
            Đang xử lý...
          </button>
        )}

        <button
          onClick={() => {
            stopLoop();
            ipc.closeSelf();
          }}
          disabled={status === "processing"}
          style={cancelBtn}
          onMouseOver={(e) => Object.assign(e.currentTarget.style, cancelBtnHover)}
          onMouseOut={(e) => Object.assign(e.currentTarget.style, cancelBtn)}
        >
          Huỷ
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

const statusText: React.CSSProperties = {};

const statsRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  fontSize: 11,
  color: "#94a3b8",
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
