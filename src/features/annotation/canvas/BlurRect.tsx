import { useEffect, useState } from "react";
import { Rect, Image as KImage } from "react-konva";
import type Konva from "konva";

// ─────────────────────────────────────────────────────────────────────────────
// BlurRect — render vùng che mờ với 3 mode:
//
//  "blur"     — Gaussian blur qua CSS filter (mềm, không phá vỡ cấu trúc ảnh)
//  "pixelate" — Mosaic: scale ảnh xuống nhỏ (tileSize × tileSize) rồi scale
//               lại to → hiệu ứng pixel hoá, che chắn mạnh hơn
//  "solid"    — Hình chữ nhật màu đặc, không thể hoàn tác bằng kỹ thuật xử lý ảnh
//
// Pipeline chung: cắt patch từ ảnh gốc (image-space coords) → xử lý → KImage.
// Mọi mode đều hoạt động đúng với exportPng (toDataURL lấy pixel đã render).
//
// Flatten/export an toàn:
//   BlurAnn được flatten thành pixel trước khi export bằng cách exportPng dùng
//   pixelRatio = 1/scale → các BlurRect đã được KImage render thật trên canvas
//   Konva. Để an toàn tối đa với solid redact, Toolbar có nút "Flatten" để
//   merge toàn bộ annotation vào ảnh nền → không còn layer tách biệt.
// ─────────────────────────────────────────────────────────────────────────────

export interface BlurRectProps {
  ann: import("../model").BlurAnn;
  img: HTMLImageElement | null;
  draggable: boolean;
  onSelect: (multi: boolean) => void;
  /** Truyền về tọa độ tuyệt đối mới (x, y) sau khi drag xong. */
  onDragEnd: (newX: number, newY: number) => void;
  onTransformEnd: (node: Konva.Node) => void;
}

/** Pixel hoá một canvas: scale xuống rồi scale lên để tạo mosaic. */
export function pixelateCanvas(src: HTMLCanvasElement, tileSize: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width  = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const ts = Math.max(2, tileSize);
  const tw = Math.max(1, Math.round(src.width  / ts));
  const th = Math.max(1, Math.round(src.height / ts));
  // Bước 1: scale xuống nhỏ
  ctx.drawImage(src, 0, 0, tw, th);
  // Bước 2: scale lên to với nearest-neighbor → mosaic
  ctx.drawImage(out, 0, 0, tw, th, 0, 0, src.width, src.height);
  return out;
}

/**
 * Gaussian blur thuần JS — không dùng CSS filter (không đáng tin trong WKWebView).
 * Thuật toán: box blur 3-pass theo cả chiều ngang và dọc ≈ Gaussian.
 * Mỗi "pass" = blur ngang rồi blur dọc → tổng 6 lần scan.
 * radius: 1–20px.
 */
export function gaussianBlurCanvas(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const r = Math.max(1, Math.round(radius));
  const w = src.width;
  const h = src.height;
  if (w === 0 || h === 0) return src;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(src, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  let buf = new Float32Array(imageData.data);   // kênh RGBA flattened
  const tmp = new Float32Array(buf.length);

  // Blur 1 hàng theo chiều ngang
  const blurH = (s: Float32Array, d: Float32Array) => {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 4; c++) {
        // Tổng ban đầu
        let sum = s[(y * w) * 4 + c] * (r + 1);
        for (let x = 0; x < r; x++) sum += s[(y * w + x) * 4 + c];
        // Slide window
        for (let x = 0; x < w; x++) {
          const lead  = Math.min(x + r,     w - 1);
          const trail = Math.max(x - r - 1, 0);
          sum += s[(y * w + lead)  * 4 + c] - s[(y * w + trail) * 4 + c];
          d[(y * w + x) * 4 + c] = sum * inv;
        }
      }
    }
  };

  // Blur 1 cột theo chiều dọc
  const blurV = (s: Float32Array, d: Float32Array) => {
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = s[x * 4 + c] * (r + 1);
        for (let y = 0; y < r; y++) sum += s[(y * w + x) * 4 + c];
        for (let y = 0; y < h; y++) {
          const lead  = Math.min(y + r,     h - 1);
          const trail = Math.max(y - r - 1, 0);
          sum += s[(lead  * w + x) * 4 + c] - s[(trail * w + x) * 4 + c];
          d[(y * w + x) * 4 + c] = sum * inv;
        }
      }
    }
  };

  // 3 pass box blur (H + V mỗi pass) ≈ Gaussian
  for (let pass = 0; pass < 3; pass++) {
    blurH(buf, tmp);
    blurV(tmp, buf);
  }

  // Ghi lại vào ImageData
  const u8 = imageData.data;
  for (let i = 0; i < buf.length; i++) u8[i] = buf[i] + 0.5;
  ctx.putImageData(imageData, 0, 0);
  return out;
}

/**
 * Trần kích thước (cạnh dài, px) cho ảnh đưa vào `gaussianBlurCanvas` — blur
 * là phép LÀM MẤT chi tiết nên không cần chạy trên độ phân giải gốc: thu nhỏ
 * trước (radius thu cùng tỉ lệ) rồi phóng lại cho kết quả gần như y hệt mà
 * nhanh hơn hàng chục lần trên vùng chọn lớn (ảnh Retina/5K) — blur thuần JS
 * chạy ĐỒNG BỘ trên main thread, vùng lớn từng làm đơ hẳn editor khi kéo
 * slider/resize vùng che.
 */
export const BLUR_MAX_EDGE = 480;

export function gaussianBlurDownscaled(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const maxEdge = Math.max(src.width, src.height);
  if (maxEdge <= BLUR_MAX_EDGE) return gaussianBlurCanvas(src, radius);
  const k = BLUR_MAX_EDGE / maxEdge;
  const small = document.createElement("canvas");
  small.width  = Math.max(1, Math.round(src.width  * k));
  small.height = Math.max(1, Math.round(src.height * k));
  small.getContext("2d")!.drawImage(src, 0, 0, small.width, small.height);
  const blurred = gaussianBlurCanvas(small, Math.max(1, radius * k));
  const out = document.createElement("canvas");
  out.width  = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(blurred, 0, 0, src.width, src.height);
  return out;
}

export function BlurRect({ ann, img, draggable, onSelect, onDragEnd, onTransformEnd }: BlurRectProps) {
  const [processed, setProcessed] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (ann.blurMode === "solid") {
      // Solid: không cần xử lý ảnh, render bằng Rect thường
      setProcessed(null);
      return;
    }
    if (!img || !img.complete || ann.width < 2 || ann.height < 2) return;

    const { x, y, width, height, blurRadius, blurMode } = ann;

    // rAF-coalesce: kéo slider radius / drag-resize vùng che phát ra hàng
    // loạt thay đổi liên tiếp — chỉ xử lý tối đa 1 lần mỗi frame, lượt chưa
    // kịp chạy bị huỷ khi có thay đổi mới (hoặc unmount) thay vì tính blur
    // đồng bộ cho TỪNG tick như trước.
    const raf = requestAnimationFrame(() => {
      const outW = Math.max(1, Math.round(width));
      const outH = Math.max(1, Math.round(height));
      const iw   = img.naturalWidth  || img.width;
      const ih   = img.naturalHeight || img.height;

      // Cắt patch chính xác từ ảnh gốc
      const src = document.createElement("canvas");
      src.width  = outW;
      src.height = outH;
      const sc = src.getContext("2d")!;
      sc.drawImage(img,
        Math.max(0, x), Math.max(0, y),
        Math.min(width,  iw - Math.max(0, x)),
        Math.min(height, ih - Math.max(0, y)),
        Math.max(0, -x), Math.max(0, -y),
        Math.min(outW, iw - Math.max(0, x)),
        Math.min(outH, ih - Math.max(0, y)),
      );

      if (blurMode === "pixelate") {
        setProcessed(pixelateCanvas(src, Math.max(2, blurRadius)));
        return;
      }

      // blur mode — Gaussian blur thuần JS (CSS filter không đáng tin trong
      // WKWebView), chạy trên bản thu nhỏ (xem `gaussianBlurDownscaled`).
      setProcessed(gaussianBlurDownscaled(src, blurRadius));
    });
    return () => cancelAnimationFrame(raf);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, ann.x, ann.y, ann.width, ann.height, ann.blurRadius, ann.blurMode, ann.solidColor]);

  const sharedProps = {
    id: ann.id,
    x: ann.x, y: ann.y, width: ann.width, height: ann.height,
    draggable,
    onClick: (e: any) => onSelect(Boolean(e?.evt?.shiftKey || e?.evt?.metaKey || e?.evt?.ctrlKey)),
    onTap: () => onSelect(false),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
      // e.target.x()/y() = tọa độ image-space mới (layer có scaleX=scale
      // nhưng node position luôn ở image-space — giống onDragEnd chung).
      onDragEnd(e.target.x(), e.target.y());
    },
    onTransformEnd: (e: Konva.KonvaEventObject<Event>) => onTransformEnd(e.target),
  };

  // Solid mode — hình chữ nhật màu đặc, không liên quan đến dữ liệu ảnh
  if (ann.blurMode === "solid") {
    return <Rect {...sharedProps} fill={ann.solidColor || "#1a1a1a"} />;
  }

  // Chưa render xong → placeholder tối
  if (!processed) {
    return <Rect {...sharedProps} fill="rgba(15,20,30,0.5)" />;
  }

  return <KImage {...sharedProps} image={processed} />;
}
