/** Logic thuần cho model "nhiều đoạn giữ lại" của `VideoTrimmer` — không phụ
 * thuộc React, tách riêng để dễ đọc/khoanh vùng lỗi (xem plan cắt video kiểu
 * CapCut). `segments` LUÔN giữ đúng thứ tự thời gian gốc, không chồng lấp,
 * không hỗ trợ sắp xếp lại — chỉ split (chia) và xoá.
 *
 * 2 hệ toạ độ dùng xuyên suốt:
 * - "source ms": mốc thời gian trong file video GỐC (0..durationMs thật).
 * - "timeline ms": vị trí trên timeline ĐÃ GHÉP hiển thị cho người dùng
 *   (đoạn bị xoá thì đóng khoảng trống lại) — 0..totalTimelineMs(segments).
 */

export interface Segment {
  id: string;
  /** ms trong video gốc, đầu đoạn (giữ lại). */
  srcStart: number;
  /** ms trong video gốc, cuối đoạn (giữ lại). */
  srcEnd: number;
}

export const MIN_SEG_MS = 300;

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `seg-${nextId}`;
}

export function initialSegments(durationMs: number): Segment[] {
  return [{ id: makeId(), srcStart: 0, srcEnd: Math.max(0, durationMs) }];
}

export function totalTimelineMs(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + (s.srcEnd - s.srcStart), 0);
}

export interface TimelinePos {
  segIndex: number;
  srcMs: number;
}

/** Quy đổi 1 vị trí trên timeline đã ghép sang (segment chứa nó, mốc nguồn
 * tương ứng). `timelineMs` được kẹp vào [0, tổng thời lượng] trước khi tính.
 * Trả `null` chỉ khi `segments` rỗng. */
export function timelineMsToSource(segments: Segment[], timelineMs: number): TimelinePos | null {
  if (segments.length === 0) return null;
  const total = totalTimelineMs(segments);
  const clamped = Math.min(Math.max(timelineMs, 0), total);
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const segLen = segments[i].srcEnd - segments[i].srcStart;
    const isLast = i === segments.length - 1;
    if (clamped <= acc + segLen || isLast) {
      const offset = Math.min(Math.max(clamped - acc, 0), segLen);
      return { segIndex: i, srcMs: segments[i].srcStart + offset };
    }
    acc += segLen;
  }
  return null;
}

/** Chiều ngược lại `timelineMsToSource` — 1 mốc nguồn đang nằm trong segment
 * nào (nếu còn) → vị trí trên timeline đã ghép. Trả `null` nếu mốc đó thuộc
 * 1 đoạn đã bị xoá (dùng `nearestValidSourceMs` để tự snap về chỗ gần nhất
 * còn hợp lệ trước khi gọi lại hàm này, ví dụ sau undo/redo/xoá). */
export function sourceMsToTimeline(segments: Segment[], srcMs: number): number | null {
  if (segments.length === 0) return null;
  if (srcMs <= segments[0].srcStart) return 0;
  const lastSeg = segments[segments.length - 1];
  if (srcMs >= lastSeg.srcEnd) return totalTimelineMs(segments);
  let acc = 0;
  for (const seg of segments) {
    if (srcMs >= seg.srcStart && srcMs <= seg.srcEnd) return acc + (srcMs - seg.srcStart);
    acc += seg.srcEnd - seg.srcStart;
  }
  return null;
}

/** Mốc nguồn gần nhất còn nằm trong 1 đoạn hợp lệ — dùng để snap playhead về
 * chỗ an toàn khi vị trí đang phát/đang đứng rơi vào 1 đoạn vừa bị xoá. */
export function nearestValidSourceMs(segments: Segment[], srcMs: number): number {
  if (segments.length === 0) return 0;
  let best = segments[0].srcStart;
  let bestDist = Infinity;
  for (const seg of segments) {
    if (srcMs >= seg.srcStart && srcMs <= seg.srcEnd) return srcMs;
    const dStart = Math.abs(srcMs - seg.srcStart);
    const dEnd = Math.abs(srcMs - seg.srcEnd);
    if (dStart < bestDist) { bestDist = dStart; best = seg.srcStart; }
    if (dEnd < bestDist) { bestDist = dEnd; best = seg.srcEnd; }
  }
  return best;
}

/** Mốc timeline-ms của MỌI ranh giới đoạn hiện có (0, cuối, và từng điểm nối
 * giữa 2 đoạn liên tiếp) — dùng để "hút" (snap) playhead/điểm chia vào đúng
 * ranh giới đã có khi kéo gần đó, xem `snapTimelineMs` ở `VideoTrimmer.tsx`. */
export function segmentBoundariesMs(segments: Segment[]): number[] {
  const result: number[] = [0];
  let acc = 0;
  for (const seg of segments) {
    acc += seg.srcEnd - seg.srcStart;
    result.push(acc);
  }
  return result;
}

/** Có chia được tại `timelineMs` không — cả 2 nửa sau khi chia phải
 * >= `MIN_SEG_MS`. Dùng để disable nút "Chia đoạn" trên UI. */
export function canSplitAt(segments: Segment[], timelineMs: number): boolean {
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos) return false;
  const seg = segments[pos.segIndex];
  return pos.srcMs - seg.srcStart >= MIN_SEG_MS && seg.srcEnd - pos.srcMs >= MIN_SEG_MS;
}

/** Chia đoạn đang chứa `timelineMs` thành 2 tại đúng mốc đó. Trả nguyên
 * `segments` (không đổi) nếu không chia được — luôn kiểm `canSplitAt` trước
 * ở UI để disable nút thay vì dựa vào no-op này. */
export function splitSegmentAt(segments: Segment[], timelineMs: number): Segment[] {
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos || !canSplitAt(segments, timelineMs)) return segments;
  const seg = segments[pos.segIndex];
  const left: Segment = { id: makeId(), srcStart: seg.srcStart, srcEnd: pos.srcMs };
  const right: Segment = { id: makeId(), srcStart: pos.srcMs, srcEnd: seg.srcEnd };
  return [...segments.slice(0, pos.segIndex), left, right, ...segments.slice(pos.segIndex + 1)];
}

/** Trả nguyên `segments` (cùng tham chiếu) nếu `id` không tồn tại — để
 * `applyEdit` ở component (so sánh tham chiếu) không đẩy nhầm 1 bản undo rác
 * khi gọi xoá với id đã stale (ví dụ sau khi segment đó vừa bị split/xoá bởi
 * thao tác khác). */
export function deleteSegment(segments: Segment[], id: string): Segment[] {
  const idx = segments.findIndex((s) => s.id === id);
  if (idx < 0) return segments;
  return [...segments.slice(0, idx), ...segments.slice(idx + 1)];
}

/** Có cắt đầu tại `timelineMs` được không — cần có gì đó để cắt (mốc > 0)
 * VÀ phần giữ lại phía sau còn >= MIN_SEG_MS, tránh đưa người dùng vào trạng
 * thái tổng thời lượng quá ngắn để "Áp dụng cắt" (nút bị disable, chỉ còn
 * đường undo). */
export function canTrimHead(segments: Segment[], timelineMs: number): boolean {
  return timelineMs > 0 && totalTimelineMs(segments) - timelineMs >= MIN_SEG_MS;
}

/** Đối xứng `canTrimHead` — phần giữ lại phía TRƯỚC còn >= MIN_SEG_MS. */
export function canTrimTail(segments: Segment[], timelineMs: number): boolean {
  return timelineMs >= MIN_SEG_MS && timelineMs < totalTimelineMs(segments);
}

/** Cắt bỏ mọi thứ TRƯỚC `timelineMs` — segment chứa mốc đó bị rút ngắn lại
 * (giữ từ `timelineMs` tới hết đoạn), mọi segment đứng trước bị loại hẳn.
 * Tự no-op (trả nguyên tham chiếu `segments`) khi `canTrimHead` không cho
 * phép — cùng khuôn an-toàn-double-invoke với `splitSegmentAt`/`deleteSegment`
 * (xem `applyEdit` ở VideoTrimmer: so sánh tham chiếu để bỏ qua lịch sử). */
export function trimHead(segments: Segment[], timelineMs: number): Segment[] {
  if (!canTrimHead(segments, timelineMs)) return segments;
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos) return segments;
  const seg = segments[pos.segIndex];
  const head: Segment = { id: seg.id, srcStart: pos.srcMs, srcEnd: seg.srcEnd };
  const result = [head, ...segments.slice(pos.segIndex + 1)].filter((s) => s.srcEnd - s.srcStart > 0);
  return result.length > 0 ? result : segments;
}

/** Cắt bỏ mọi thứ SAU `timelineMs` — đối xứng với `trimHead`. */
export function trimTail(segments: Segment[], timelineMs: number): Segment[] {
  if (!canTrimTail(segments, timelineMs)) return segments;
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos) return segments;
  const seg = segments[pos.segIndex];
  const tail: Segment = { id: seg.id, srcStart: seg.srcStart, srcEnd: pos.srcMs };
  const result = [...segments.slice(0, pos.segIndex), tail].filter((s) => s.srcEnd - s.srcStart > 0);
  return result.length > 0 ? result : segments;
}

/** Danh sách đoạn giữ lại gửi cho `record::encoder::trim` qua
 * `trim_pending_recording`/`trim_history_video` — đã đúng thứ tự tăng dần,
 * không chồng lấp (bất biến của `segments`), không cần sort/merge thêm. */
export function computeKeepRanges(segments: Segment[]): [number, number][] {
  return segments.map((s) => [s.srcStart, s.srcEnd]);
}
