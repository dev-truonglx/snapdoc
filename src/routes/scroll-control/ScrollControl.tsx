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

function isRowInteresting(imgData: ImageData, y: number, w: number): boolean {
  const data = imgData.data;
  const rowStride = w * 4;
  const offset = y * rowStride;

  // Lấy màu của điểm ảnh đầu tiên (trừ lề) làm gốc
  const r0 = data[offset + 4];
  const g0 = data[offset + 5];
  const b0 = data[offset + 6];

  // So sánh các điểm khác trên dòng để xem có biến động màu sắc không
  for (let x = 12; x < w - 25; x += 12) {
    const idx = offset + x * 4;
    if (
      Math.abs(data[idx] - r0) > 10 ||
      Math.abs(data[idx + 1] - g0) > 10 ||
      Math.abs(data[idx + 2] - b0) > 10
    ) {
      return true; // Dòng này có chi tiết (chữ, viền, ảnh...)
    }
  }
  return false; // Dòng màu trơn
}

function findVerticalOverlap(imgData1: ImageData, imgData2: ImageData): number {
  const w = imgData1.width;
  const h = imgData1.height;
  const data1 = imgData1.data;
  const data2 = imgData2.data;

  // 1. Kiểm tra xem 2 ảnh có giống hệt nhau không (dy = 0)
  let isIdentical = true;
  const rowStride = w * 4;
  for (let y = 0; y < h; y += Math.max(1, Math.round(h / 15))) {
    const offset = y * rowStride;
    for (let x = 0; x < w - 25; x += 5) {
      const idx = offset + x * 4;
      if (
        Math.abs(data1[idx] - data2[idx]) > 8 ||
        Math.abs(data1[idx + 1] - data2[idx + 1]) > 8 ||
        Math.abs(data1[idx + 2] - data2[idx + 2]) > 8
      ) {
        isIdentical = false;
        break;
      }
    }
    if (!isIdentical) break;
  }
  if (isIdentical) {
    return 0;
  }

  // 2. Tìm 3 dòng chứa chi tiết nội dung (không phải dòng trắng trơn) ở sát cạnh dưới ảnh 1
  const testRows1: number[] = [];
  let currentY = h - 10;
  while (currentY > Math.max(10, h - 180) && testRows1.length < 3) {
    if (isRowInteresting(imgData1, currentY, w)) {
      testRows1.push(currentY);
    }
    currentY -= 6;
  }

  // Fallback nếu không quét đủ 3 dòng có nội dung
  if (testRows1.length < 3) {
    testRows1.length = 0;
    testRows1.push(h - 10, h - 20, h - 30);
  }

  let bestDy = h;

  // Quét dy (khoảng cuộn) từ 1 tới h - 25
  for (let dy = 1; dy < h - 25; dy++) {
    let isMatch = true;

    for (const testY1 of testRows1) {
      const testY2 = testY1 - dy;
      if (testY2 < 0) {
        isMatch = false;
        break;
      }

      const offset1 = testY1 * rowStride;
      const offset2 = testY2 * rowStride;

      // So sánh nhanh, bỏ lề phải 25px tránh dính thanh cuộn
      for (let x = 0; x < w - 25; x += 6) {
        const idx1 = offset1 + x * 4;
        const idx2 = offset2 + x * 4;

        if (
          Math.abs(data1[idx1] - data2[idx2]) > 10 ||
          Math.abs(data1[idx1 + 1] - data2[idx2 + 1]) > 10 ||
          Math.abs(data1[idx1 + 2] - data2[idx2 + 2]) > 10
        ) {
          isMatch = false;
          break;
        }
      }
      if (!isMatch) break;
    }

    if (isMatch) {
      // Xác thực kỹ toàn bộ vùng chồng lấn (tránh dính thanh cuộn và bỏ qua phần header đầu trang)
      let fullVerify = true;
      const startY2 = Math.max(0, h - dy - 180);
      const endY2 = h - dy;

      if (endY2 - startY2 > 5) {
        const verifyRows2 = [];
        const step = Math.max(1, Math.round((endY2 - startY2) / 8));
        for (let y2 = startY2; y2 < endY2; y2 += step) {
          verifyRows2.push(y2);
        }

        for (const y2 of verifyRows2) {
          const y1 = y2 + dy;
          const offset1 = y1 * rowStride;
          const offset2 = y2 * rowStride;

          for (let x = 0; x < w - 25; x += 4) {
            const idx1 = offset1 + x * 4;
            const idx2 = offset2 + x * 4;
            if (
              Math.abs(data1[idx1] - data2[idx2]) > 15 ||
              Math.abs(data1[idx1 + 1] - data2[idx2 + 1]) > 15 ||
              Math.abs(data1[idx1 + 2] - data2[idx2 + 2]) > 15
            ) {
              fullVerify = false;
              break;
            }
          }
          if (!fullVerify) break;
        }
      }

      if (fullVerify) {
        bestDy = dy;
        break;
      }
    }
  }

  return bestDy;
}

export default function ScrollControl() {
  const [status, setStatus] = useState<"ready" | "capturing" | "processing">("ready");
  const [frameCount, setFrameCount] = useState(0);
  const [stitchedHeight, setStitchedHeight] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevImageDataRef = useRef<ImageData | null>(null);
  const isCapturingRef = useRef(false);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  // Cuộn phần preview xuống đáy khi ảnh dài ra
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [previewUrl]);

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

  const captureTick = async () => {
    if (!isCapturingRef.current) return;
    try {
      const base64 = await ipc.captureScrollSlice(mx, my, rx, ry, rw, rh);
      if (!base64 || !isCapturingRef.current) return;

      const img = await loadImage(`data:image/png;base64,${base64}`);

      // Lấy ImageData của frame mới
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = img.naturalWidth;
      tempCanvas.height = img.naturalHeight;
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) return;
      tempCtx.drawImage(img, 0, 0);
      const newImgData = tempCtx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);

      if (!canvasRef.current || !prevImageDataRef.current) {
        // Frame đầu tiên
        const master = document.createElement("canvas");
        master.width = img.naturalWidth;
        master.height = img.naturalHeight;
        const masterCtx = master.getContext("2d");
        if (!masterCtx) return;
        masterCtx.drawImage(img, 0, 0);
        canvasRef.current = master;
        prevImageDataRef.current = newImgData;
        setPreviewUrl(master.toDataURL("image/png"));
        setStitchedHeight(master.height);
        setFrameCount(1);
      } else {
        // Các frame tiếp theo: tìm khớp
        const dy = findVerticalOverlap(prevImageDataRef.current, newImgData);

        if (dy === img.naturalHeight) {
          // Không tìm thấy phần đè lắp (hoặc cuộn quá nhanh) -> Nối tiếp ở đuôi
          const prevMaster = canvasRef.current;
          const nextMaster = document.createElement("canvas");
          nextMaster.width = prevMaster.width;
          nextMaster.height = prevMaster.height + img.naturalHeight;
          const nextCtx = nextMaster.getContext("2d");
          if (!nextCtx) return;

          nextCtx.drawImage(prevMaster, 0, 0);
          nextCtx.drawImage(img, 0, prevMaster.height);

          canvasRef.current = nextMaster;
          prevImageDataRef.current = newImgData;
          setPreviewUrl(nextMaster.toDataURL("image/png"));
          setStitchedHeight(nextMaster.height);
          setFrameCount((prev) => prev + 1);
        } else if (dy > 3) {
          // Có cuộn và khớp nhau (bỏ qua rung lắc dưới 3 pixel)
          const prevMaster = canvasRef.current;
          const nextMaster = document.createElement("canvas");
          nextMaster.width = prevMaster.width;
          nextMaster.height = prevMaster.height + dy;
          const nextCtx = nextMaster.getContext("2d");
          if (!nextCtx) return;

          nextCtx.drawImage(prevMaster, 0, 0);
          nextCtx.drawImage(img, 0, prevMaster.height - (img.naturalHeight - dy));

          canvasRef.current = nextMaster;
          prevImageDataRef.current = newImgData;
          setPreviewUrl(nextMaster.toDataURL("image/png"));
          setStitchedHeight(nextMaster.height);
          setFrameCount((prev) => prev + 1);
        }
      }
    } catch (err) {
      console.error("Lỗi chụp cuộn slice:", err);
    }
  };

  const startCapture = async () => {
    setStatus("capturing");
    isCapturingRef.current = true;
    setError(null);

    // Chụp lát cắt đầu tiên ngay lập tức
    await captureTick();

    // Khởi động vòng lặp chụp liên tục mỗi 220ms
    const intervalId = setInterval(async () => {
      if (!isCapturingRef.current) {
        clearInterval(intervalId);
        return;
      }
      await captureTick();
    }, 220);

    // Lưu trữ intervalId để dọn dẹp khi hoàn tất
    (window as any)._scrollCaptureInterval = intervalId;
  };

  const finishCapture = async () => {
    isCapturingRef.current = false;
    if ((window as any)._scrollCaptureInterval) {
      clearInterval((window as any)._scrollCaptureInterval);
    }

    if (!canvasRef.current || frameCount === 0) {
      ipc.closeSelf();
      return;
    }

    setStatus("processing");
    try {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const base64Data = dataUrl.split(",")[1];
      await ipc.finalizeScrollCapture(base64Data, canvasRef.current.width, canvasRef.current.height);
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

      {/* Preview list stacked vertically */}
      <div style={previewBox}>
        {status === "ready" ? (
          <div style={emptyState} data-tauri-drag-region>
            Nhấn Bắt đầu rồi cuộn chuột từ từ để ghi lại trang dài
          </div>
        ) : previewUrl ? (
          <div style={scrollList}>
            <img src={previewUrl} alt="preview" style={previewImg} />
            <div ref={scrollEndRef} />
          </div>
        ) : (
          <div style={emptyState}>Đang chuẩn bị...</div>
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
            isCapturingRef.current = false;
            if ((window as any)._scrollCaptureInterval) {
              clearInterval((window as any)._scrollCaptureInterval);
            }
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
  background: "rgba(0, 0, 0, 0.25)",
  border: "1px solid rgba(255, 255, 255, 0.05)",
  borderRadius: 10,
  minHeight: 120,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const emptyState: React.CSSProperties = {
  flex: 1,
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

const previewImg: React.CSSProperties = {
  width: "100%",
  objectFit: "contain",
  display: "block",
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
