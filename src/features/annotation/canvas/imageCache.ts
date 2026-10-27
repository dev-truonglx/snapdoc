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

/**
 * Cache ảnh của annotation kiểu "image" (key = `ann.src`, thường là data URL
 * rất dài). Giới hạn LRU để không giữ mãi ảnh đã xoá/đổi. Node Konva đang
 * render vẫn giữ tham chiếu riêng → bị evict chỉ có nghĩa lần sau miss sẽ
 * load lại.
 */
const IMAGE_ANN_CACHE_LIMIT = 20;

class LruImageMap {
  private map = new Map<string, HTMLImageElement>();
  constructor(private readonly limit: number) {}

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): HTMLImageElement | undefined {
    const el = this.map.get(key);
    if (el) {
      // Đẩy lên cuối (mới dùng nhất)
      this.map.delete(key);
      this.map.set(key, el);
    }
    return el;
  }

  set(key: string, el: HTMLImageElement): this {
    if (!key) return this;
    this.map.delete(key);
    while (this.map.size >= this.limit) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
    this.map.set(key, el);
    return this;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }
}

export const imageAnnCache = new LruImageMap(IMAGE_ANN_CACHE_LIMIT);
