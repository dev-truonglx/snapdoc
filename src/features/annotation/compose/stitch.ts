// Nối nhiều ảnh thành một ảnh dài (long screenshot): dọc hoặc ngang.
// Vẽ tất cả lên một canvas offscreen rồi xuất ra data URL — kết quả là một ảnh
// phẳng, nạp lại vào editor qua loadDoc (không đụng tới model annotation).

export type StitchDirection = "vertical" | "horizontal";
/** Canh lề theo trục vuông góc với hướng nối. */
export type StitchAlign = "start" | "center" | "end";

export interface StitchOptions {
  direction: StitchDirection;
  align: StitchAlign;
  /** Khoảng cách giữa các ảnh (px ở không gian ảnh gốc). */
  gap: number;
  /** Màu nền cho khe gap + phần thừa khi các ảnh lệch kích thước. "transparent" = giữ alpha. */
  background: string;
}

export interface StitchResult {
  dataUrl: string;
  width: number;
  height: number;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Không tải được ảnh"));
    img.src = src;
  });
}

/** Vị trí canh lề trên trục phụ: trả về offset (px) cho một item dài `size` trong khung `extent`. */
function alignOffset(extent: number, size: number, align: StitchAlign): number {
  if (align === "center") return Math.round((extent - size) / 2);
  if (align === "end") return extent - size;
  return 0;
}

/** Nối danh sách ảnh (data URL) theo `opt`. Cần ít nhất 1 ảnh. */
export async function composeStitch(
  srcs: string[],
  opt: StitchOptions,
): Promise<StitchResult> {
  if (srcs.length === 0) throw new Error("Chưa có ảnh nào để nối");

  const imgs = await Promise.all(srcs.map(loadImage));
  const n = imgs.length;
  const gap = Math.max(0, Math.round(opt.gap));
  const vertical = opt.direction === "vertical";

  let width: number;
  let height: number;
  if (vertical) {
    width = Math.max(...imgs.map((i) => i.naturalWidth));
    height = imgs.reduce((s, i) => s + i.naturalHeight, 0) + gap * (n - 1);
  } else {
    height = Math.max(...imgs.map((i) => i.naturalHeight));
    width = imgs.reduce((s, i) => s + i.naturalWidth, 0) + gap * (n - 1);
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không tạo được canvas context");

  if (opt.background && opt.background !== "transparent") {
    ctx.fillStyle = opt.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  let cursor = 0;
  for (const img of imgs) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (vertical) {
      const x = alignOffset(width, w, opt.align);
      ctx.drawImage(img, x, cursor, w, h);
      cursor += h + gap;
    } else {
      const y = alignOffset(height, h, opt.align);
      ctx.drawImage(img, cursor, y, w, h);
      cursor += w + gap;
    }
  }

  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}
