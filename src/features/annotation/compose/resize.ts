/**
 * Tiện ích resample và tính toán kích thước ảnh (Image Resize) cho SnapDoc.
 */

/**
 * Resample ảnh bằng HTML5 Canvas với thuật toán Multi-step Halving (chống aliasing)
 * khi thu nhỏ sâu (> 2x reduction), đảm bảo độ sắc nét cao nhất cho ảnh chụp màn hình / tài liệu.
 */
export function resampleImageCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  targetW: number,
  targetH: number,
  quality: ImageSmoothingQuality = "high"
): string {
  const tW = Math.max(1, Math.round(targetW));
  const tH = Math.max(1, Math.round(targetH));

  let currentW = source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  let currentH = source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;
  let currentSource: CanvasImageSource = source;

  // Nếu tỉ lệ giảm > 2 lần cả 2 chiều, thu nhỏ từng bước 50% để giữ chi tiết và chống răng cưa
  while (currentW * 0.5 >= tW && currentH * 0.5 >= tH) {
    const stepW = Math.round(currentW * 0.5);
    const stepH = Math.round(currentH * 0.5);
    const stepCanvas = document.createElement("canvas");
    stepCanvas.width = stepW;
    stepCanvas.height = stepH;
    const stepCtx = stepCanvas.getContext("2d");
    if (!stepCtx) break;

    stepCtx.imageSmoothingEnabled = true;
    stepCtx.imageSmoothingQuality = quality;
    stepCtx.drawImage(currentSource, 0, 0, stepW, stepH);

    currentSource = stepCanvas;
    currentW = stepW;
    currentH = stepH;
  }

  // Bước vẽ cuối cùng về kích thước đích chính xác
  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = tW;
  finalCanvas.height = tH;
  const finalCtx = finalCanvas.getContext("2d");
  if (!finalCtx) {
    throw new Error("Không thể khởi tạo canvas 2D context");
  }

  finalCtx.imageSmoothingEnabled = true;
  finalCtx.imageSmoothingQuality = quality;
  finalCtx.drawImage(currentSource, 0, 0, tW, tH);

  return finalCanvas.toDataURL("image/png");
}

export const MIN_RESIZE_PX = 16;
export const MAX_RESIZE_PX = 16384;

/**
 * Tải HTMLImageElement từ URL / DataURL một cách an toàn
 */
export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Không thể load ảnh: ${String(e)}`));
    img.src = src;
  });
}
