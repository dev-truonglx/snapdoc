import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  putHistoryDraft: vi.fn(async (_key: string, _json: string) => {}),
  saveHistoryDoc: vi.fn(async (_id: string, _json: string, _preview: string, _base?: string) => {}),
  saveSnapdocFile: vi.fn(async (_path: string, _json: string, _preview: string, _base?: string) => {}),
}));
vi.mock("../../lib/ipc", () => ({ ipc }));
vi.mock("../../lib/blobUtils", () => ({ ensureDataUrl: async (src: string) => `data:base(${src})` }));
vi.mock("./canvas/imageCache", () => ({ evictCachedImage: () => {} }));

import type { Annotation, Doc, RectAnn } from "./model";
import { useEditor } from "./store";
import {
  commitActiveDoc,
  dirtySessionKeys,
  flushDraft,
  noteActiveKey,
  ownBlobUrl,
  parseDocPayload,
  resetSessions,
  setPreviewProvider,
  suspendActive,
  tryResume,
  DOC_PAYLOAD_VERSION,
} from "./sessions";

const rect = (id: string): RectAnn => ({ id, type: "rect", color: "#ef4444", strokeWidth: 2, x: 10, y: 10, width: 50, height: 40 });
const doc = (over: Partial<Doc> = {}, annotations: Annotation[] = []): Doc => ({
  image: "blob:base",
  imgW: 800,
  imgH: 600,
  scaleFactor: 1,
  annotations,
  historyId: "h1",
  ...over,
});
const st = () => useEditor.getState();

/** Mở `d` như editor làm: loadDoc rồi báo key đang mở. */
function open(key: string, d: Doc) {
  st().loadDoc(d);
  noteActiveKey(key);
}

const revoked: string[] = [];

beforeEach(() => {
  // sessions.ts chỉ ghi khi chạy trong Tauri.
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => void revoked.push(u));
  revoked.length = 0;
  resetSessions();
  setPreviewProvider(null);
  ipc.putHistoryDraft.mockClear();
  ipc.saveHistoryDoc.mockClear();
  ipc.saveSnapdocFile.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("autosave bản nháp", () => {
  it("không ghi khi chưa có gì thay đổi", async () => {
    open("h1", doc());
    await flushDraft();
    expect(ipc.putHistoryDraft).not.toHaveBeenCalled();
    expect(ipc.saveHistoryDoc).not.toHaveBeenCalled();
  });

  it("chỉ annotation đổi → ghi JSON nháp vào đúng container", async () => {
    open("h1", doc());
    st().addAnnotation(rect("a"));
    await flushDraft();
    expect(ipc.putHistoryDraft).toHaveBeenCalledTimes(1);
    const [key, json] = ipc.putHistoryDraft.mock.calls[0];
    expect(key).toBe("h1");
    expect(parseDocPayload(json)!.annotations.map((a) => a.id)).toEqual(["a"]);
  });

  it("nền đã đổi (crop) mà chưa render được preview → KHÔNG ghi nháp lệch toạ độ", async () => {
    open("h1", doc({}, [rect("a")]));
    st().applyCrop("blob:cropped", 400, 300, [rect("a")]);
    await flushDraft();
    expect(ipc.putHistoryDraft).not.toHaveBeenCalled();
    expect(ipc.saveHistoryDoc).not.toHaveBeenCalled();
  });

  it("nền đã đổi + có preview → ghi cả nền, sau đó hết bẩn", async () => {
    open("h1", doc());
    setPreviewProvider(() => "data:preview");
    st().applyCrop("blob:cropped", 400, 300, []);
    await flushDraft();
    expect(ipc.saveHistoryDoc).toHaveBeenCalledWith("h1", expect.any(String), "data:preview", "data:base(blob:cropped)");
    expect(st().isDirty()).toBe(false);
    await flushDraft();
    expect(ipc.saveHistoryDoc).toHaveBeenCalledTimes(1);
  });

  it("undo xuyên qua crop về đúng nền trên đĩa → chỉ còn ghi JSON", async () => {
    open("h1", doc());
    st().applyCrop("blob:cropped", 400, 300, []);
    st().undo();
    st().addAnnotation(rect("a"));
    await flushDraft();
    expect(ipc.saveHistoryDoc).not.toHaveBeenCalled();
    expect(ipc.putHistoryDraft).toHaveBeenCalledTimes(1);
  });

  it("ảnh mở từ file ngoài (chưa có trong Library) không ghi nháp", async () => {
    open("file:/tmp/a.png", doc({ historyId: null }));
    st().addAnnotation(rect("a"));
    await flushDraft();
    expect(ipc.putHistoryDraft).not.toHaveBeenCalled();
  });
});

describe("commitActiveDoc (Save)", () => {
  it("tài liệu Library → saveHistoryDoc, không kèm nền khi nền chưa đổi", async () => {
    open("h1", doc());
    st().addAnnotation(rect("a"));
    expect(await commitActiveDoc("data:preview")).toBe(true);
    expect(ipc.saveHistoryDoc).toHaveBeenCalledWith("h1", expect.any(String), "data:preview", undefined);
    expect(st().isDirty()).toBe(false);
  });

  it("tài liệu .snapdoc mở từ đĩa → ghi lại đúng file đó, kèm nền nếu đã crop", async () => {
    open("file:/docs/a.snapdoc", doc({ historyId: null, filePath: "/docs/a.snapdoc" }));
    st().applyCrop("blob:cropped", 400, 300, []);
    expect(await commitActiveDoc("data:preview")).toBe(true);
    expect(ipc.saveSnapdocFile).toHaveBeenCalledWith(
      "/docs/a.snapdoc",
      expect.any(String),
      "data:preview",
      "data:base(blob:cropped)",
    );
    expect(ipc.saveHistoryDoc).not.toHaveBeenCalled();
    expect(st().baseDirty).toBe(false);
  });

  it("ảnh thường không có nơi lưu → false, không ghi gì", async () => {
    open("file:/tmp/a.png", doc({ historyId: null }));
    expect(await commitActiveDoc("data:preview")).toBe(false);
    expect(ipc.saveHistoryDoc).not.toHaveBeenCalled();
    expect(ipc.saveSnapdocFile).not.toHaveBeenCalled();
  });
});

describe("registry phiên", () => {
  it("treo rồi khôi phục giữ nguyên undo stack và trạng thái chưa lưu", () => {
    open("h1", doc());
    st().addAnnotation(rect("a"));
    st().addAnnotation(rect("b"));
    expect(suspendActive()).toEqual({ key: "h1", dirty: true });
    expect(dirtySessionKeys()).toEqual(["h1"]);

    open("h2", doc({ historyId: "h2" }));
    expect(st().doc!.annotations).toEqual([]);

    expect(tryResume("h1")).toBe(true);
    expect(st().doc!.annotations.map((a) => a.id)).toEqual(["a", "b"]);
    st().undo();
    expect(st().doc!.annotations.map((a) => a.id)).toEqual(["a"]);
  });

  it("vượt 6 phiên thì bỏ phiên cũ nhất và revoke blob URL nó sở hữu", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 7; i++) {
        vi.advanceTimersByTime(10);
        const key = `k${i}`;
        open(key, doc({ historyId: key, image: `blob:${key}` }));
        ownBlobUrl(key, `blob:${key}`);
        suspendActive();
      }
      expect(revoked).toEqual(["blob:k0"]);
      expect(tryResume("k0")).toBe(false);
      expect(tryResume("k1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseDocPayload", () => {
  it("bỏ qua payload của phiên bản mới hơn (tránh làm mất annotation lạ khi lưu lại)", () => {
    const json = JSON.stringify({ payloadV: DOC_PAYLOAD_VERSION + 1, kind: "image", annotations: [] });
    expect(parseDocPayload(json)).toBeNull();
  });
  it("JSON hỏng hoặc thiếu annotations → null", () => {
    expect(parseDocPayload("{oops")).toBeNull();
    expect(parseDocPayload(JSON.stringify({ payloadV: 1 }))).toBeNull();
    expect(parseDocPayload(null)).toBeNull();
  });
});
