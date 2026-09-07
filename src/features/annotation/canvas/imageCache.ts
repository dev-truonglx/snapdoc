/**
 * Bộ nhớ đệm giữ các đối tượng HTMLImageElement đã giải mã (decode) hoàn tất trong RAM.
 * Giúp việc chuyển qua lại giữa các ảnh (đặc biệt là ảnh chụp cuộn dài hàng chục ngàn pixel)
 * diễn ra TỨC THÌ (0ms), không xuất hiện spinner loading lại và không bị rò rỉ hay cấp phát lại
 * hàng trăm MB bộ nhớ đệm bitmap.
 */

const IMAGE_CACHE_LIMIT = 5;
const cache = new Map<string, HTMLImageElement>();

export function getCachedImage(url: string): HTMLImageElement | null {
  if (!url) return null;
  const el = cache.get(url);
  if (el && el.complete && el.naturalWidth > 0) {
    // Đẩy lên đầu danh sách LRU
    cache.delete(url);
    cache.set(url, el);
    return el;
  }
  return null;
}

export function setCachedImage(url: string, el: HTMLImageElement): void {
  if (!url || !el || !el.complete || el.naturalWidth === 0) return;
  if (cache.size >= IMAGE_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(url, el);
}

export function evictCachedImage(url: string): void {
  if (url) cache.delete(url);
}

export function clearImageCache(): void {
  cache.clear();
}
