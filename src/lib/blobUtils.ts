/**
 * Tiện ích chuyển đổi dữ liệu Base64 / Data URL sang Blob URL hiệu năng cao.
 * Sử dụng TypedArray phân khối để tránh tắc nghẽn UI thread của JavaScript
 * khi xử lý ảnh chụp màn hình độ phân giải cao hoặc ảnh chụp cuộn dài.
 */

export function base64ToBlob(base64: string, mime: string = "image/png"): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  // Phân khối 64KB để tối ưu hóa CPU cache và JIT optimization
  const CHUNK_SIZE = 65536;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, len);
    for (let j = i; j < end; j++) {
      bytes[j] = binary.charCodeAt(j);
    }
  }

  return new Blob([bytes], { type: mime });
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith("data:")) return null;
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return null;

  const meta = dataUrl.slice(0, commaIdx);
  const rawBase64 = dataUrl.slice(commaIdx + 1);
  const mimeMatch = meta.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";

  try {
    return base64ToBlob(rawBase64, mime);
  } catch (e) {
    console.error("[blobUtils] Lỗi chuyển đổi dataUrl sang Blob:", e);
    return null;
  }
}

export function toSafeBlobUrl(
  src: string,
  minSizeThreshold = 200_000,
): { url: string; revoke?: () => void } {
  if (!src) return { url: "" };
  if (src.startsWith("data:") && src.length > minSizeThreshold) {
    const blob = dataUrlToBlob(src);
    if (blob) {
      const blobUrl = URL.createObjectURL(blob);
      return {
        url: blobUrl,
        revoke: () => URL.revokeObjectURL(blobUrl),
      };
    }
  }
  return { url: src };
}
