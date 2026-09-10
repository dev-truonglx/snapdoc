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
  /** Tốc độ phát (0.25 .. 8.0, mặc định 1.0). */
  speed?: number;
}

export const MIN_SEG_MS = 300;

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `seg-${nextId}`;
}

export function initialSegments(durationMs: number): Segment[] {
  return [{ id: makeId(), srcStart: 0, srcEnd: Math.max(0, durationMs), speed: 1.0 }];
}

/** Thời lượng hiển thị trên timeline của 1 segment sau khi chia theo tốc độ */
export function segmentPlayMs(seg: Segment): number {
  const speed = seg.speed != null && seg.speed > 0 ? seg.speed : 1.0;
  return Math.max(0, Math.round((seg.srcEnd - seg.srcStart) / speed));
}

export function totalTimelineMs(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + segmentPlayMs(s), 0);
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
    const seg = segments[i];
    const speed = seg.speed != null && seg.speed > 0 ? seg.speed : 1.0;
    const playLen = segmentPlayMs(seg);
    const isLast = i === segments.length - 1;
    if (clamped <= acc + playLen || isLast) {
      const offsetPlay = Math.min(Math.max(clamped - acc, 0), playLen);
      const offsetSrc = Math.round(offsetPlay * speed);
      return { segIndex: i, srcMs: Math.min(seg.srcStart + offsetSrc, seg.srcEnd) };
    }
    acc += playLen;
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
    const speed = seg.speed != null && seg.speed > 0 ? seg.speed : 1.0;
    const playLen = segmentPlayMs(seg);
    if (srcMs >= seg.srcStart && srcMs <= seg.srcEnd) {
      const offsetSrc = srcMs - seg.srcStart;
      return acc + Math.round(offsetSrc / speed);
    }
    acc += playLen;
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
    acc += segmentPlayMs(seg);
    result.push(acc);
  }
  return result;
}

/** Có chia được tại `timelineMs` không — cả 2 nửa sau khi chia phải
 * >= `MIN_SEG_MS` trên timeline. Dùng để disable nút "Chia đoạn" trên UI. */
export function canSplitAt(segments: Segment[], timelineMs: number): boolean {
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos) return false;
  const seg = segments[pos.segIndex];
  const speed = seg.speed != null && seg.speed > 0 ? seg.speed : 1.0;
  const leftPlayMs = (pos.srcMs - seg.srcStart) / speed;
  const rightPlayMs = (seg.srcEnd - pos.srcMs) / speed;
  return leftPlayMs >= MIN_SEG_MS && rightPlayMs >= MIN_SEG_MS;
}

/** Chia đoạn đang chứa `timelineMs` thành 2 tại đúng mốc đó. Trả nguyên
 * `segments` (không đổi) nếu không chia được — luôn kiểm `canSplitAt` trước
 * ở UI để disable nút thay vì dựa vào no-op này. Cả hai đoạn con kế thừa
 * tốc độ (`speed`) của đoạn gốc. */
export function splitSegmentAt(segments: Segment[], timelineMs: number): Segment[] {
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos || !canSplitAt(segments, timelineMs)) return segments;
  const seg = segments[pos.segIndex];
  const left: Segment = { id: makeId(), srcStart: seg.srcStart, srcEnd: pos.srcMs, speed: seg.speed };
  const right: Segment = { id: makeId(), srcStart: pos.srcMs, srcEnd: seg.srcEnd, speed: seg.speed };
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
 * Đoạn giữ lại bảo lưu `speed` vốn có. */
export function trimHead(segments: Segment[], timelineMs: number): Segment[] {
  if (!canTrimHead(segments, timelineMs)) return segments;
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos) return segments;
  const seg = segments[pos.segIndex];
  const head: Segment = { id: seg.id, srcStart: pos.srcMs, srcEnd: seg.srcEnd, speed: seg.speed };
  const result = [head, ...segments.slice(pos.segIndex + 1)].filter((s) => s.srcEnd - s.srcStart > 0);
  return result.length > 0 ? result : segments;
}

/** Cắt bỏ mọi thứ SAU `timelineMs` — đối xứng với `trimHead`. Đoạn giữ lại bảo lưu `speed`. */
export function trimTail(segments: Segment[], timelineMs: number): Segment[] {
  if (!canTrimTail(segments, timelineMs)) return segments;
  const pos = timelineMsToSource(segments, timelineMs);
  if (!pos) return segments;
  const seg = segments[pos.segIndex];
  const tail: Segment = { id: seg.id, srcStart: seg.srcStart, srcEnd: pos.srcMs, speed: seg.speed };
  const result = [...segments.slice(0, pos.segIndex), tail].filter((s) => s.srcEnd - s.srcStart > 0);
  return result.length > 0 ? result : segments;
}

/** Cập nhật tốc độ phát của một segment cụ thể theo ID. */
export function updateSegmentSpeed(segments: Segment[], id: string, speed: number): Segment[] {
  const cleanSpeed = Math.max(0.25, Math.min(8.0, Number(speed.toFixed(2))));
  return segments.map((s) => (s.id === id ? { ...s, speed: cleanSpeed } : s));
}

/** Áp dụng một tốc độ phát chung cho tất cả các segment hiện có. */
export function updateAllSegmentsSpeed(segments: Segment[], speed: number): Segment[] {
  const cleanSpeed = Math.max(0.25, Math.min(8.0, Number(speed.toFixed(2))));
  return segments.map((s) => ({ ...s, speed: cleanSpeed }));
}

/** Danh sách đoạn giữ lại gửi cho `record::encoder::trim` qua
 * `trim_pending_recording`/`trim_history_video` — tuple [srcStart, srcEnd, speed].
 * Đã đúng thứ tự tăng dần, không chồng lấp (bất biến của `segments`). */
export function computeKeepRanges(segments: Segment[]): [number, number, number][] {
  return segments.map((s) => [s.srcStart, s.srcEnd, s.speed != null && s.speed > 0 ? s.speed : 1.0]);
}

/**
 * Hợp nhất các đoạn cắt gốc (baseSegments) với các vùng tốc độ độc lập (speedRegions).
 * Cho phép người dùng chỉnh tốc độ cho bất kỳ phân đoạn nào mà KHÔNG CẦN phải cắt clip gốc.
 *
 * Thuật toán:
 * 1. Với mỗi segment gốc [srcStart, srcEnd], tìm các speedRegions có giao thoa.
 * 2. Chia nhỏ segment thành các lát cắt thời gian theo biên của các speedRegions.
 * 3. Mỗi lát cắt được gán tốc độ tương ứng của speedRegion (hoặc globalSpeed nếu nằm ngoài).
 * 4. Ghép nối (merge) các lát cắt liên tiếp có cùng tốc độ để tối ưu hóa pipeline FFmpeg.
 */
export function buildEffectiveSegments(
  baseSegments: Segment[],
  speedRegions: import("./types").SpeedRegion[] = [],
  globalSpeed: number = 1.0,
): Segment[] {
  const cleanGlobalSpeed = Math.max(0.25, Math.min(8.0, Number(globalSpeed.toFixed(2))));

  // Nếu không có speedRegion nào, trả về baseSegments với globalSpeed
  if (speedRegions.length === 0) {
    return baseSegments.map((s) => ({
      ...s,
      speed: s.speed ?? cleanGlobalSpeed,
    }));
  }

  // Lọc và sắp xếp các speedRegion hợp lệ
  const validRegions = speedRegions
    .filter((r) => r.endTimeMs > r.startTimeMs)
    .sort((a, b) => a.startTimeMs - b.startTimeMs);

  const effective: Segment[] = [];
  let subId = 0;

  for (const base of baseSegments) {
    const bStart = base.srcStart;
    const bEnd = base.srcEnd;
    if (bEnd <= bStart) continue;

    // Tìm tất cả các điểm mốc phân chia bên trong [bStart, bEnd]
    const splitPoints = new Set<number>([bStart, bEnd]);

    for (const r of validRegions) {
      if (r.endTimeMs <= bStart || r.startTimeMs >= bEnd) continue;
      if (r.startTimeMs > bStart && r.startTimeMs < bEnd) splitPoints.add(Math.round(r.startTimeMs));
      if (r.endTimeMs > bStart && r.endTimeMs < bEnd) splitPoints.add(Math.round(r.endTimeMs));
    }

    const sortedPoints = Array.from(splitPoints).sort((a, b) => a - b);

    // Duyệt qua từng lát cắt giữa 2 điểm liên tiếp
    for (let i = 0; i < sortedPoints.length - 1; i++) {
      const pStart = sortedPoints[i];
      const pEnd = sortedPoints[i + 1];
      if (pEnd <= pStart) continue;

      const mid = (pStart + pEnd) / 2;
      // Tìm xem điểm giữa lát cắt này thuộc về speedRegion nào
      const matchingRegion = validRegions.find(
        (r) => mid >= r.startTimeMs && mid <= r.endTimeMs,
      );

      const sp = matchingRegion
        ? Math.max(0.25, Math.min(8.0, Number(matchingRegion.speed.toFixed(2))))
        : (base.speed ?? cleanGlobalSpeed);

      // Thử gộp với lát cắt trước nếu cùng tốc độ và nối tiếp nhau
      const last = effective[effective.length - 1];
      if (last && last.srcEnd === pStart && Math.abs((last.speed ?? 1.0) - sp) < 0.01) {
        last.srcEnd = pEnd;
      } else {
        subId += 1;
        effective.push({
          id: `${base.id}_eff${subId}`,
          srcStart: pStart,
          srcEnd: pEnd,
          speed: sp,
        });
      }
    }
  }

  return effective.length > 0 ? effective : baseSegments;
}
