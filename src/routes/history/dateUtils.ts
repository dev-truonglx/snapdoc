/** Chuyển "YYYY-MM-DD" (`<input type="date">`, local) sang unix-ms đầu ngày
 * local — dùng cho `HistoryToolbar.tsx` (đọc input date + khoảng ngày nhanh). */
export function dayStartMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** Chiều ngược lại `dayStartMs` — dùng làm `value` cho input date, để input
 * hiện ĐÚNG ngày filter hiện tại thay vì luôn trống (input uncontrolled cũ). */
export function msToDayStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Unix-ms đầu ngày HÔM NAY (local) — gốc tính khoảng ngày nhanh ở toolbar. */
export function todayStartMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

/** 1 ngày tính bằng ms — cộng vào `dayStartMs`/`todayStartMs` để ra mốc loại
 * trừ (exclusive upper bound) cho filter "to" (`created_at < to`), bao trọn
 * hết ngày đã chọn. */
export const ONE_DAY_MS = 86_400_000;
