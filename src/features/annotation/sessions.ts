import { useEditor } from "./store";
import type { Annotation, Doc } from "./model";
import { ipc } from "../../lib/ipc";

/**
 * Sổ đăng ký PHIÊN SỬA trong RAM — giữ nguyên trạng thái đang sửa của từng
 * ảnh khi user chuyển sang ảnh khác (chụp mới, bấm thumbnail ở dải "Gần đây",
 * mở file...), để quay lại là sửa tiếp được, kể cả undo stack.
 *
 * # Vì sao chỉ RAM là đã đủ để hết mất dữ liệu ở 4/5 đường
 *
 * `windows::hide_editor` bên Rust chỉ gọi `win.hide()`, KHÔNG destroy webview
 * (xem `src-tauri/src/windows/mod.rs`). Nên suốt cả phiên chụp — ẩn editor,
 * freeze màn hình, mở overlay, chụp, hiện lại editor — heap JS, cây React và
 * store zustand sống nguyên. Toàn bộ mất dữ liệu ở các đường đó chỉ đến từ
 * việc `loadDoc` ghi đè state đang sống. Chỉ cần đừng ném nó đi.
 *
 * Đường duy nhất THẬT SỰ huỷ heap là Save/Save As (`ipc.closeSelf()`) và bấm
 * X trên titlebar — cần lưu xuống đĩa mới cứu được (xem `.snapdoc`, GĐ3).
 *
 * # Vì sao Map cấp module, không phải React state / không nằm trong store
 *
 * - React state: mỗi lần snapshot sẽ kéo theo re-render cả editor — vô nghĩa
 *   vì không có gì trong registry được render trực tiếp.
 * - Trong `store.ts`: module `useEditor` được import CẢ ở cửa sổ overlay Chụp
 *   nhanh (`routes/overlay/Overlay.tsx` gọi `loadDoc`). Cửa sổ Tauri khác nhau
 *   có heap JS riêng nên state không rò sang nhau, nhưng đặt logic phiên +
 *   autosave trong store dễ dẫn tới việc nó chạy như side-effect của module ở
 *   cửa sổ không mong muốn. Ở đây là module riêng, và `Editor.tsx` chủ động
 *   gọi vào — chỉ cửa sổ `editor` mới dùng.
 */

/** `historyId` cho ảnh trong Library, hoặc `file:<uuid>` cho ảnh mở từ đĩa
 * chưa có mặt trong Library (chưa Save lần nào). */
export type SessionKey = string;

interface ImageSession {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  stepCounter: number;
  arrowCounter: number;
  baseDirty: boolean;
  savedRef: Doc | null;
  /** Các object URL do phiên này SỞ HỮU — chỉ revoke khi phiên bị evict.
   *
   * Trước đây `HistoryStrip` revoke URL của ảnh trước ngay khi đổi ảnh; giữ
   * cách đó thì `doc.image` của phiên vừa bị treo lại chính là URL vừa bị
   * revoke → quay lại là ảnh vỡ. Quyền sở hữu phải nằm ở đây. */
  blobUrls: string[];
  touchedAt: number;
}

/** Trần số phiên giữ trong RAM. Vượt trần thì evict phiên cũ nhất (LRU).
 *
 * Evict KHÔNG mất việc của user: autosave đã ghi bản nháp xuống `.snapdoc` (mỗi
 * ~2s và ở mọi mốc treo/rời cửa sổ), nên phiên bị evict vẫn mở lại được từ đĩa
 * — chỉ mất undo stack. Tức evict là hạ tầng RAM → đĩa, không phải mất mát.
 *
 * 6 là đủ rộng cho luồng dùng thật (chụp liên tiếp vài ảnh rồi quay lại) mà
 * không giữ hàng chục ảnh nền trong RAM. */
const MAX_SESSIONS = 6;

/** Undo stack của phiên bị treo bị cắt còn nhiêu đây entry.
 *
 * Các entry trong `past` được tạo bằng `{...doc, annotations: [...]}` nên
 * chúng DÙNG CHUNG một string `image` — 30 entry của một phiên chỉ-annotation
 * gần như miễn phí. Nhưng crop/stitch sinh ảnh nền RIÊNG cho từng entry, nên
 * một phiên đã crop vài lần có thể giữ vài chục MB. Cắt bớt ở phiên NỀN (phiên
 * đang active vẫn đủ 30) là đánh đổi có ý thức: undo xuyên qua một lần crop
 * chỉ còn đầy đủ ở tài liệu đang mở. */
const BACKGROUND_PAST_LIMIT = 10;

const sessions = new Map<SessionKey, ImageSession>();

/** Key của tài liệu ĐANG mở trong editor.
 *
 * Giữ ở đây thay vì đọc `doc.historyId`: ảnh mở từ file ngoài không có
 * `historyId` nào để làm khoá, mà vẫn cần được treo/khôi phục như mọi ảnh
 * khác. Đây là nguồn sự thật duy nhất cho "đang mở cái gì". */
let activeKey: SessionKey | null = null;

/** Đếm thế hệ cho MỌI lần đổi tài liệu.
 *
 * Bấm nhanh 2 thumbnail thì 2 promise có thể resolve KHÔNG đúng thứ tự bấm —
 * `HistoryStrip` trước đây tự chống bằng `latestRequestRef` riêng của nó, còn
 * đường `refresh-capture` thì không chống gì. Nay mọi đường đổi tài liệu đều
 * lấy token từ ĐÚNG một bộ đếm này, nên chúng loại lẫn nhau đúng cách thay vì
 * mỗi đường tự canh một mình. */
let switchGen = 0;

/** Mở một lượt đổi tài liệu. Trả token để kiểm lại sau các `await`. */
export function beginSwitch(): number {
  return ++switchGen;
}

/** `false` nếu đã có lượt đổi khác chen vào — caller phải BỎ kết quả của mình
 * (đừng `loadDoc`, đừng đặt `historyId`, đừng tắt spinner của lượt mới). */
export function isCurrentSwitch(token: number): boolean {
  return token === switchGen;
}

export function getActiveKey(): SessionKey | null {
  return activeKey;
}

/** Báo editor vừa nạp xong tài liệu `key` (gọi NGAY SAU `loadDoc`). */
export function noteActiveKey(key: SessionKey | null): void {
  activeKey = key;
  if (key) touch(key);
}

/** Chuyển quyền sở hữu một object URL cho phiên `key` — nó sẽ được revoke khi
 * và chỉ khi phiên đó bị evict. */
export function ownBlobUrl(key: SessionKey, url: string): void {
  const s = sessions.get(key);
  if (s) {
    if (!s.blobUrls.includes(url)) s.blobUrls.push(url);
    return;
  }
  // Chưa có phiên (ảnh vừa nạp lần đầu, chưa sửa gì nên chưa treo lần nào) →
  // ghi tạm để lần `suspendActive` đầu tiên nhặt vào phiên.
  const pending = pendingBlobUrls.get(key) ?? [];
  if (!pending.includes(url)) pending.push(url);
  pendingBlobUrls.set(key, pending);
}

const pendingBlobUrls = new Map<SessionKey, string[]>();

function touch(key: SessionKey): void {
  const s = sessions.get(key);
  if (s) s.touchedAt = Date.now();
}

export interface SuspendResult {
  key: SessionKey;
  /** Tài liệu vừa treo có thay đổi chưa lưu hay không — `Editor` dùng để quyết
   * định có hiện banner "đã giữ lại bản chỉnh sửa trước" hay không. */
  dirty: boolean;
}

/**
 * Treo tài liệu đang mở vào registry. **Hoàn toàn đồng bộ** — bắt buộc, vì
 * hàm này được gọi ngay đầu các đường có `await` phía sau (`loadAnyPending`,
 * đổi thumbnail); nếu nó phụ thuộc IPC và lỗi/treo thì ảnh mới sẽ không bao
 * giờ hiện ra, tức là còn tệ hơn cái bug đang sửa.
 *
 * Không xoá tài liệu khỏi store — chỉ chụp lại. Nên gọi thừa là vô hại.
 */
export function suspendActive(): SuspendResult | null {
  const key = activeKey;
  if (!key) return null;
  const s = useEditor.getState();
  if (!s.doc) return null;

  // Chốt NGAY (đồng bộ) nội dung cần ghi xuống đĩa, rồi bắn IPC không chờ:
  // caller sẽ đổi `activeKey` ngay sau lời gọi này, nên không thể để việc ghi
  // tự đi đọc `activeKey` sau đó. Không `await` — treo vào RAM đã đủ cứu dữ
  // liệu cho 4/5 đường; ghi đĩa chỉ để sống qua đóng cửa sổ/khởi động lại.
  const draftWrite = pendingDraftWrite();
  if (draftWrite) void flushDraftFor(draftWrite.key, draftWrite.json);

  const existing = sessions.get(key);
  const blobUrls = existing?.blobUrls ?? [];
  const adopted = pendingBlobUrls.get(key);
  if (adopted) {
    for (const u of adopted) if (!blobUrls.includes(u)) blobUrls.push(u);
    pendingBlobUrls.delete(key);
  }

  sessions.set(key, {
    doc: s.doc,
    past: s.past.slice(-BACKGROUND_PAST_LIMIT),
    future: s.future,
    stepCounter: s.stepCounter,
    arrowCounter: s.arrowCounter,
    baseDirty: s.baseDirty,
    savedRef: s.savedRef,
    blobUrls,
    touchedAt: Date.now(),
  });

  evictIfNeeded(key);
  return { key, dirty: s.doc !== s.savedRef };
}

/** Khôi phục phiên `key` vào store nếu còn trong RAM. Trả `true` nếu có.
 * Khôi phục đầy đủ CẢ undo stack — quay lại là Ctrl+Z lùi được như chưa đi. */
export function tryResume(key: SessionKey): boolean {
  const s = sessions.get(key);
  if (!s) return false;
  useEditor.getState().hydrateSession({
    doc: s.doc,
    past: s.past,
    future: s.future,
    stepCounter: s.stepCounter,
    arrowCounter: s.arrowCounter,
    baseDirty: s.baseDirty,
    savedRef: s.savedRef,
  });
  activeKey = key;
  s.touchedAt = Date.now();
  return true;
}

export function hasSession(key: SessionKey): boolean {
  return sessions.has(key);
}

/** Các key đang có phiên **chưa lưu** — dải "Gần đây" dùng để gắn badge. */
export function dirtySessionKeys(): SessionKey[] {
  const out: SessionKey[] = [];
  for (const [key, s] of sessions) {
    if (s.doc !== s.savedRef) out.push(key);
  }
  return out;
}

/** Bỏ phiên (đã Save xong, hoặc user chủ động bỏ thay đổi) và revoke URL. */
export function dropSession(key: SessionKey): void {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  revokeAll(s, key);
}

function evictIfNeeded(protectKey: SessionKey): void {
  while (sessions.size > MAX_SESSIONS) {
    let oldestKey: SessionKey | null = null;
    let oldestAt = Infinity;
    for (const [key, s] of sessions) {
      // Không bao giờ evict phiên vừa treo, và không evict tài liệu đang mở.
      if (key === protectKey || key === activeKey) continue;
      if (s.touchedAt < oldestAt) {
        oldestAt = s.touchedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return; // không còn gì evict được — thà vượt trần
    const s = sessions.get(oldestKey)!;
    sessions.delete(oldestKey);
    revokeAll(s, oldestKey);
  }
}

/** Revoke URL của một phiên bị bỏ — nhưng KHÔNG revoke URL mà tài liệu ĐANG
 * mở còn dùng (crop/stitch có thể để 2 phiên trỏ chung một ảnh nền). */
function revokeAll(s: ImageSession, key: SessionKey): void {
  const activeDoc = key === activeKey ? null : useEditor.getState().doc;
  for (const url of s.blobUrls) {
    if (activeDoc && activeDoc.image === url) continue;
    URL.revokeObjectURL(url);
  }
}

/** Shape của `doc.json` trong container `.snapdoc`.
 *
 * `payloadV` tách khỏi `formatVersion` của container: thêm một loại annotation
 * mới KHÔNG phải là đổi bố cục file, nên không được buộc bản cũ từ chối cả
 * file. Ngược lại, bản đọc thấy `payloadV` lớn hơn nó biết thì phải BỎ QUA cả
 * lớp annotation thay vì parse phần hiểu được — parse nửa vời sẽ lặng lẽ skip
 * annotation lạ rồi LÀM MẤT chúng ở lần lưu tiếp theo. */
export const DOC_PAYLOAD_VERSION = 1;

export interface DocPayload {
  payloadV: number;
  kind: "image";
  annotations: Annotation[];
  stepCounter: number;
  arrowCounter: number;
  imgW: number;
  imgH: number;
  scaleFactor: number;
  captureMode?: string;
}

/** Serialize trạng thái đang mở thành `doc.json`. `Doc.image` CỐ TÌNH không
 * được ghi vào: pixel nền đã nằm trong `base.png` của cùng container, nhân bản
 * nó vào JSON sẽ làm file phình gấp đôi và tạo ra 2 nguồn sự thật. */
export function serializeDoc(): string | null {
  const s = useEditor.getState();
  if (!s.doc) return null;
  const payload: DocPayload = {
    payloadV: DOC_PAYLOAD_VERSION,
    kind: "image",
    annotations: s.doc.annotations,
    stepCounter: s.stepCounter,
    arrowCounter: s.arrowCounter,
    imgW: s.doc.imgW,
    imgH: s.doc.imgH,
    scaleFactor: s.doc.scaleFactor,
    captureMode: s.doc.captureMode,
  };
  return JSON.stringify(payload);
}

/** Parse `doc.json` → phần cần đắp lên `Doc`. `null` khi không dùng được (JSON
 * lỗi, hoặc `payloadV` mới hơn bản này hiểu). */
export function parseDocPayload(raw: string | null | undefined): DocPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as DocPayload;
    if (typeof p !== "object" || p === null) return null;
    if (typeof p.payloadV === "number" && p.payloadV > DOC_PAYLOAD_VERSION) {
      console.warn(
        `[SnapDoc] Bỏ qua lớp annotation payloadV=${p.payloadV} (bản này hỗ trợ tới ${DOC_PAYLOAD_VERSION})`,
      );
      return null;
    }
    if (!Array.isArray(p.annotations)) return null;
    return p;
  } catch (e) {
    console.error("[SnapDoc] doc.json không đọc được:", e);
    return null;
  }
}

/**
 * Nạp một item ẢNH từ Library vào editor (nền + lớp annotation) và đặt nó làm
 * tài liệu đang mở. Trả `null` nếu có lượt đổi khác chen vào giữa (caller phải
 * bỏ mọi việc dọn dẹp của lượt mình).
 *
 * ĐƯỜNG DUY NHẤT để mở ảnh từ Library — dùng chung cho dải "Gần đây" và cho
 * nút "Quay lại" ở banner khi phiên đã bị evict khỏi RAM. Gom về một chỗ vì
 * đây là nơi tập trung mấy cái bẫy: token thế hệ, quyền sở hữu object URL, và
 * cờ `markClean` khi nạp từ bản nháp.
 *
 * KHÔNG tự treo tài liệu hiện tại — caller phải gọi `suspendActive()` ĐỒNG BỘ
 * trước, vì chỉ caller biết mình có đang ở giữa một lượt đổi khác hay không.
 */
export async function openLibraryImage(
  id: SessionKey,
): Promise<{ fromDraft: boolean } | null> {
  const token = beginSwitch();
  // Nền (bytes thô, không base64) và lớp annotation (chuỗi nhỏ) lấy song song.
  const [item, bytes, layer] = await Promise.all([
    ipc.getHistoryItem(id),
    ipc.getHistoryAssetBytes(id),
    ipc.getHistoryDocJson(id).catch(() => null),
  ]);
  if (!isCurrentSwitch(token)) return null;

  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const payload = parseDocPayload(layer?.json);
  // Nạp từ bản nháp → tài liệu là CHƯA LƯU. Để clean thì badge tắt, autosave
  // ngừng ghi, và user tưởng đã lưu trong khi bản chính thức trên đĩa vẫn cũ.
  const fromDraft = !!layer?.isDraft && !!payload;
  useEditor.getState().loadDoc(
    {
      image: url,
      imgW: item.width,
      imgH: item.height,
      scaleFactor: item.scaleFactor,
      annotations: payload?.annotations ?? [],
      historyId: item.id,
      captureMode: item.captureMode,
    },
    !fromDraft,
  );
  if (payload) {
    useEditor.getState().setStepCounter(payload.stepCounter);
    useEditor.getState().setArrowCounter(payload.arrowCounter);
  }
  noteActiveKey(item.id);
  // Quyền sở hữu URL giao cho registry — KHÔNG revoke URL của ảnh trước ở đây:
  // phiên vừa bị treo có `doc.image` trỏ đúng vào URL đó, revoke là quay lại
  // thấy ảnh vỡ. Registry revoke khi và chỉ khi evict phiên.
  ownBlobUrl(item.id, url);
  return { fromDraft };
}

/* ── Autosave bản nháp xuống `.snapdoc` ─────────────────────────────────── */

/** Nhịp autosave. 2s là đủ dày để crash chỉ mất vài giây cuối, đủ thưa để
 * không viết lại container (nền vài MB) liên tục trong lúc user đang kéo vẽ. */
const AUTOSAVE_DEBOUNCE_MS = 2000;

let autosaveTimer: number | null = null;
let unsubscribe: (() => void) | null = null;

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** Ghi ngay bản nháp của tài liệu đang mở (nếu có gì để ghi).
 *
 * Chỉ ghi khi ĐANG dirty: một tài liệu vừa mở/vừa Save mà cũng ghi draft thì
 * badge "chưa lưu" sẽ bật sai sau khi khởi động lại app.
 *
 * Ảnh mở từ file ngoài (`file:` key) chưa có mặt trong Library nên chưa có
 * container nào để ghi vào — chờ tới lần Save đầu (khi đó nó được ingest).
 */
export async function flushDraft(): Promise<void> {
  const pending = pendingDraftWrite();
  if (pending) await flushDraftFor(pending.key, pending.json);
}

/** Tính (đồng bộ) xem có gì cần ghi draft không, và ghi cái gì.
 *
 * Tách riêng để `suspendActive` — vốn PHẢI đồng bộ — chốt được key + JSON
 * NGAY tại thời điểm treo, rồi mới bắn IPC. Nếu để `flushDraft()` tự đọc
 * `activeKey` thì nó sẽ đọc SAU khi caller đã đổi sang tài liệu khác → ghi
 * nháp của ảnh cũ vào container của ảnh mới. */
function pendingDraftWrite(): { key: SessionKey; json: string } | null {
  if (!isTauri()) return null;
  const key = activeKey;
  // Ảnh mở từ file ngoài chưa có mặt trong Library → chưa có container nào để
  // ghi vào; chờ tới lần Save đầu (khi đó nó được ingest).
  if (!key || key.startsWith("file:")) return null;
  const s = useEditor.getState();
  // Chỉ ghi khi ĐANG dirty: tài liệu vừa mở / vừa Save mà cũng ghi draft thì
  // badge "chưa lưu" sẽ bật sai sau khi khởi động lại app.
  if (!s.doc || s.doc === s.savedRef) return null;
  const json = serializeDoc();
  return json ? { key, json } : null;
}

async function flushDraftFor(key: SessionKey, json: string): Promise<void> {
  try {
    await ipc.putHistoryDraft(key, json);
  } catch (e) {
    // Autosave là lưới an toàn, không phải đường chính — lỗi ở đây không được
    // làm gián đoạn việc user đang làm. State trong RAM vẫn nguyên.
    console.error("[SnapDoc] Autosave bản nháp thất bại:", e);
  }
}

function scheduleAutosave(): void {
  if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    void flushDraft();
  }, AUTOSAVE_DEBOUNCE_MS);
}

/**
 * Bật autosave + flush ở các mốc rời tài liệu. Gọi MỘT LẦN từ cửa sổ `editor`.
 *
 * Cố tình là hàm phải gọi tường minh chứ không phải side-effect của module:
 * `store.ts` được import cả ở cửa sổ overlay Chụp nhanh (`Overlay.tsx` gọi
 * `loadDoc`), và cửa sổ đó không được phép ghi draft cho ai.
 */
export function initAutosave(): () => void {
  if (!isTauri()) return () => {};

  unsubscribe?.();
  unsubscribe = useEditor.subscribe((state, prev) => {
    // Chỉ quan tâm nội dung tài liệu đổi — đổi tool/màu/zoom/selection không
    // phải là thay đổi cần lưu.
    if (state.doc !== prev.doc) scheduleAutosave();
  });

  // `blur`/`hidden` là các mốc user rời cửa sổ — flush ngay thay vì chờ hết
  // debounce, vì ngay sau đó có thể là một lần chụp mới (Rust ẩn editor) hoặc
  // user đóng app.
  const onLeave = () => void flushDraft();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void flushDraft();
  };
  window.addEventListener("blur", onLeave);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    unsubscribe?.();
    unsubscribe = null;
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
    window.removeEventListener("blur", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Chỉ dùng cho test / dev-mode reload. */
export function resetSessions(): void {
  for (const [key, s] of sessions) revokeAll(s, key);
  sessions.clear();
  pendingBlobUrls.clear();
  activeKey = null;
}
