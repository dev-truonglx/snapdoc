import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation, Doc, EmojiAnn, PenAnn, RectAnn, TextAnn } from "./model";
import { annotationBounds, simplifyPoints } from "./model";
import { useEditor } from "./store";

const rect = (id: string, x = 10): RectAnn => ({ id, type: "rect", color: "#ef4444", strokeWidth: 2, x, y: 10, width: 50, height: 40 });
const doc = (annotations: Annotation[] = []): Doc => ({ image: "blob:base", imgW: 800, imgH: 600, scaleFactor: 1, annotations, historyId: "h1" });
const st = () => useEditor.getState();

beforeEach(() => {
  vi.useFakeTimers();
  st().loadDoc(doc());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("undo / redo", () => {
  it("hoàn tác rồi làm lại đúng thứ tự", () => {
    st().addAnnotation(rect("a"));
    st().addAnnotation(rect("b"));
    expect(st().doc!.annotations.map((a) => a.id)).toEqual(["a", "b"]);

    st().undo();
    expect(st().doc!.annotations.map((a) => a.id)).toEqual(["a"]);
    st().undo();
    expect(st().doc!.annotations).toEqual([]);
    expect(st().canUndo()).toBe(false);

    st().redo();
    st().redo();
    expect(st().doc!.annotations.map((a) => a.id)).toEqual(["a", "b"]);
    expect(st().canRedo()).toBe(false);
  });

  it("thao tác mới sau undo xoá nhánh redo", () => {
    st().addAnnotation(rect("a"));
    st().undo();
    st().addAnnotation(rect("c"));
    expect(st().canRedo()).toBe(false);
  });

  it("giữ tối đa 30 bước", () => {
    for (let i = 0; i < 40; i++) st().addAnnotation(rect(`r${i}`));
    expect(st().past.length).toBe(30);
    for (let i = 0; i < 30; i++) st().undo();
    expect(st().doc!.annotations.length).toBe(10);
    expect(st().canUndo()).toBe(false);
  });

  it("live update (kéo slider/tay nắm) không tạo bước undo", () => {
    st().addAnnotation(rect("a"));
    const pastLen = st().past.length;
    st().updateAnnotationLive("a", { x: 99 });
    expect(st().past.length).toBe(pastLen);
    expect((st().doc!.annotations[0] as RectAnn).x).toBe(99);
  });

  it("đổi style liên tiếp trong 800ms gộp thành 1 bước, quá hạn thì tách", () => {
    st().addAnnotation(rect("a"));
    const base = st().past.length;
    st().updateAnnotation("a", { color: "#000" });
    vi.advanceTimersByTime(200);
    st().updateAnnotation("a", { color: "#111" });
    vi.advanceTimersByTime(200);
    st().updateAnnotation("a", { color: "#222" });
    expect(st().past.length).toBe(base + 1);
    st().undo();
    expect((st().doc!.annotations[0] as RectAnn).color).toBe("#ef4444");

    st().redo();
    vi.advanceTimersByTime(1000);
    st().updateAnnotation("a", { color: "#333" });
    expect(st().past.length).toBe(base + 2);
  });

  it("di chuyển (không phải style) luôn là bước riêng", () => {
    st().addAnnotation(rect("a"));
    const base = st().past.length;
    st().updateAnnotation("a", { x: 20 });
    st().updateAnnotation("a", { x: 30 });
    expect(st().past.length).toBe(base + 2);
  });
});

describe("dirty / markSaved", () => {
  it("vừa nạp là sạch, sửa là bẩn, undo về đúng bản đã lưu là sạch lại", () => {
    expect(st().isDirty()).toBe(false);
    st().addAnnotation(rect("a"));
    expect(st().isDirty()).toBe(true);
    st().undo();
    expect(st().isDirty()).toBe(false);
  });

  it("markSaved() chốt bản hiện tại và xoá cờ nền đã đổi", () => {
    st().addAnnotation(rect("a"));
    st().markBaseDirty();
    st().markSaved();
    expect(st().isDirty()).toBe(false);
    expect(st().baseDirty).toBe(false);
  });

  it("markSaved(doc) chốt đúng bản đã ghi, sửa tiếp sau đó vẫn bẩn", () => {
    st().addAnnotation(rect("a"));
    const written = st().doc!;
    st().addAnnotation(rect("b")); // sửa trong lúc đang ghi
    st().markSaved(written);
    expect(st().isDirty()).toBe(true);
    st().undo();
    expect(st().isDirty()).toBe(false);
  });

  it("nạp bản nháp (markClean = false) bị coi là chưa lưu, kể cả nền", () => {
    st().loadDoc(doc([rect("a")]), false);
    expect(st().isDirty()).toBe(true);
    expect(st().baseDirty).toBe(true);
  });

  it("crop đổi nền: đánh dấu baseDirty, giữ historyId, undo được", () => {
    st().addAnnotation(rect("a"));
    st().applyCrop("blob:cropped", 400, 300, []);
    expect(st().baseDirty).toBe(true);
    expect(st().doc!.historyId).toBe("h1");
    expect(st().doc!.imgW).toBe(400);
    st().undo();
    expect(st().doc!.image).toBe("blob:base");
  });
});

describe("chọn và xoá", () => {
  it("xoá nhiều hình đang chọn trong 1 bước undo", () => {
    st().addAnnotation(rect("a"));
    st().addAnnotation(rect("b"));
    st().addAnnotation(rect("c"));
    st().selectMany(["a", "c"]);
    st().removeSelected();
    expect(st().doc!.annotations.map((a) => a.id)).toEqual(["b"]);
    st().undo();
    expect(st().doc!.annotations.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });
});

describe("công cụ mới", () => {
  it("preset áp màu + nét + cỡ chữ lên các hình đang chọn trong 1 bước undo", () => {
    st().addAnnotation(rect("a"));
    const text: TextAnn = { id: "t", type: "text", color: "#000", strokeWidth: 1, x: 0, y: 0, text: "hi", fontSize: 20 };
    st().addAnnotation(text);
    st().selectMany(["a", "t"]);
    const base = st().past.length;
    st().applyStylePreset({ color: "#22c55e", strokeWidth: 6, fontSize: 40 });
    expect(st().past.length).toBe(base + 1);
    const [r, tx] = st().doc!.annotations as [RectAnn, TextAnn];
    expect([r.color, r.strokeWidth]).toEqual(["#22c55e", 6]);
    expect([tx.color, tx.fontSize]).toEqual(["#22c55e", 40]);
    expect([st().color, st().strokeWidth, st().fontSize]).toEqual(["#22c55e", 6, 40]);
  });

  it("đổi emoji khi đang chọn sticker → đổi luôn sticker đó; không chọn gì → không tạo bước undo", () => {
    const em: EmojiAnn = { id: "e", type: "emoji", x: 0, y: 0, emoji: "👉", size: 40 };
    st().addAnnotation(em);
    st().select("e");
    st().setCurrentEmoji("🔥");
    expect((st().doc!.annotations[0] as EmojiAnn).emoji).toBe("🔥");
    st().select(null);
    const base = st().past.length;
    st().setCurrentEmoji("✅");
    expect(st().past.length).toBe(base);
    expect(st().currentEmoji).toBe("✅");
  });

  it("nét bút: bỏ điểm sát nhau, giữ điểm cuối; khung bao tính theo điểm", () => {
    expect(simplifyPoints([0, 0, 0.5, 0, 1, 0, 5, 0, 5.2, 0])).toEqual([0, 0, 5, 0, 5.2, 0]);
    const pen: PenAnn = { id: "p", type: "pen", color: "#000", strokeWidth: 2, x: 10, y: 20, points: [0, 0, 30, -5, 15, 40] };
    expect(annotationBounds(pen)).toEqual({ x1: 10, y1: 15, x2: 40, y2: 60 });
  });
});
