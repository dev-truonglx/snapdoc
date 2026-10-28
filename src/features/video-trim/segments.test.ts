import { describe, expect, it } from "vitest";
import {
  MIN_SEG_MS,
  buildEffectiveSegments,
  canSplitAt,
  canTrimHead,
  canTrimTail,
  computeKeepRanges,
  deleteSegment,
  initialSegments,
  nearestValidSourceMs,
  playbackGapAction,
  segmentBoundariesMs,
  sourceMsToTimeline,
  splitSegmentAt,
  timelineMsToSource,
  totalTimelineMs,
  trimHead,
  trimTail,
  type Segment,
} from "./segments";

const seg = (id: string, srcStart: number, srcEnd: number, speed = 1): Segment => ({ id, srcStart, srcEnd, speed });

/** Video 10s đã xoá đoạn 3–6s: giữ [0,3000] và [6000,10000]. */
const withGap = (): Segment[] => [seg("a", 0, 3000), seg("b", 6000, 10000)];

describe("timeline ↔ source", () => {
  it("bỏ qua khoảng đã xoá khi quy đổi", () => {
    const s = withGap();
    expect(totalTimelineMs(s)).toBe(7000);
    expect(timelineMsToSource(s, 1000)).toEqual({ segIndex: 0, srcMs: 1000 });
    expect(timelineMsToSource(s, 4000)).toEqual({ segIndex: 1, srcMs: 7000 });
    expect(sourceMsToTimeline(s, 7000)).toBe(4000);
    // Mốc nằm trong đoạn đã xoá → null (phải snap trước).
    expect(sourceMsToTimeline(s, 4500)).toBeNull();
  });

  it("đổi qua rồi đổi lại ra đúng giá trị ban đầu, kể cả khi có tốc độ", () => {
    const s = [seg("a", 0, 4000, 2), seg("b", 5000, 9000, 0.5)];
    expect(totalTimelineMs(s)).toBe(2000 + 8000);
    for (const t of [0, 500, 1999, 2000, 2500, 6000, 9999, 10000]) {
      const pos = timelineMsToSource(s, t)!;
      // Nguồn tính theo ms nguyên: ở tốc độ 0.5, 1ms nguồn = 2ms timeline → lệch tối đa 1ms.
      expect(Math.abs(sourceMsToTimeline(s, pos.srcMs)! - t)).toBeLessThanOrEqual(1);
    }
  });

  it("kẹp mốc timeline ngoài phạm vi", () => {
    const s = withGap();
    expect(timelineMsToSource(s, -50)).toEqual({ segIndex: 0, srcMs: 0 });
    expect(timelineMsToSource(s, 99_999)).toEqual({ segIndex: 1, srcMs: 10000 });
    expect(timelineMsToSource([], 10)).toBeNull();
  });

  it("snap mốc trong đoạn đã xoá về ranh giới gần nhất", () => {
    const s = withGap();
    expect(nearestValidSourceMs(s, 3500)).toBe(3000);
    expect(nearestValidSourceMs(s, 5800)).toBe(6000);
    expect(nearestValidSourceMs(s, 8000)).toBe(8000);
  });
});

describe("playbackGapAction (bỏ qua đoạn đã xoá khi phát)", () => {
  const EPS = 20;
  it("trong đoạn giữ lại → không làm gì", () => {
    expect(playbackGapAction(withGap(), 1000, EPS)).toBeNull();
    expect(playbackGapAction(withGap(), 8000, EPS)).toBeNull();
  });
  it("lọt vào khoảng đã xoá → nhảy tới đầu đoạn kế", () => {
    expect(playbackGapAction(withGap(), 3500, EPS)).toEqual({ seekIdx: 1 });
  });
  it("qua cuối đoạn cuối → dừng", () => {
    expect(playbackGapAction(withGap(), 9990, EPS)).toBe("end");
    expect(playbackGapAction(withGap(), 12000, EPS)).toBe("end");
  });
  it("2 đoạn liền nhau (chỉ khác tốc độ) không bao giờ seek", () => {
    const s = [seg("a", 0, 3000, 1), seg("b", 3000, 6000, 2)];
    for (const ms of [2985, 2995, 3000, 3005]) expect(playbackGapAction(s, ms, EPS)).toBeNull();
  });
  it("đoạn đầu đã bị cắt → nhảy tới đoạn đầu", () => {
    expect(playbackGapAction([seg("a", 2000, 5000)], 0, EPS)).toEqual({ seekIdx: 0 });
  });
});

describe("chia / xoá / cắt", () => {
  it("chia đúng mốc và kế thừa tốc độ", () => {
    const s = [seg("a", 0, 10000, 2)];
    expect(canSplitAt(s, 2500)).toBe(true);
    const out = splitSegmentAt(s, 2500);
    expect(out.map((x) => [x.srcStart, x.srcEnd, x.speed])).toEqual([
      [0, 5000, 2],
      [5000, 10000, 2],
    ]);
  });

  it("không chia nếu một nửa ngắn hơn MIN_SEG_MS", () => {
    const s = initialSegments(10000);
    expect(canSplitAt(s, MIN_SEG_MS - 1)).toBe(false);
    expect(splitSegmentAt(s, MIN_SEG_MS - 1)).toBe(s);
  });

  it("xoá id không tồn tại trả nguyên tham chiếu (không tạo bản undo rác)", () => {
    const s = withGap();
    expect(deleteSegment(s, "zzz")).toBe(s);
    expect(deleteSegment(s, "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("cắt đầu / cắt cuối theo timeline đã ghép", () => {
    const s = withGap();
    expect(trimHead(s, 4000).map((x) => [x.srcStart, x.srcEnd])).toEqual([[7000, 10000]]);
    expect(trimTail(s, 2000).map((x) => [x.srcStart, x.srcEnd])).toEqual([[0, 2000]]);
    // Phần còn lại quá ngắn → không cắt.
    expect(canTrimHead(s, 7000 - MIN_SEG_MS + 1)).toBe(false);
    expect(canTrimTail(s, MIN_SEG_MS - 1)).toBe(false);
  });

  it("ranh giới và keep ranges", () => {
    expect(segmentBoundariesMs(withGap())).toEqual([0, 3000, 7000]);
    expect(computeKeepRanges([seg("a", 0, 3000, 1.5)])).toEqual([[0, 3000, 1.5]]);
  });
});

describe("buildEffectiveSegments (vùng tốc độ)", () => {
  it("không có vùng tốc độ → giữ nguyên đoạn", () => {
    const out = buildEffectiveSegments(withGap(), [], 1);
    expect(out.map((x) => [x.srcStart, x.srcEnd])).toEqual([
      [0, 3000],
      [6000, 10000],
    ]);
  });

  it("tách đoạn theo biên vùng tốc độ, không lan sang khoảng đã xoá", () => {
    const out = buildEffectiveSegments(withGap(), [{ id: "r", startTimeMs: 2000, endTimeMs: 7000, speed: 2 }], 1);
    expect(out.map((x) => [x.srcStart, x.srcEnd, x.speed])).toEqual([
      [0, 2000, 1],
      [2000, 3000, 2],
      [6000, 7000, 2],
      [7000, 10000, 1],
    ]);
  });

  it("gộp lát cắt liền nhau cùng tốc độ", () => {
    const out = buildEffectiveSegments(
      [seg("a", 0, 6000)],
      [
        { id: "r1", startTimeMs: 1000, endTimeMs: 2000, speed: 2 },
        { id: "r2", startTimeMs: 2000, endTimeMs: 3000, speed: 2 },
      ],
      1,
    );
    expect(out.map((x) => [x.srcStart, x.srcEnd, x.speed])).toEqual([
      [0, 1000, 1],
      [1000, 3000, 2],
      [3000, 6000, 1],
    ]);
  });
});
