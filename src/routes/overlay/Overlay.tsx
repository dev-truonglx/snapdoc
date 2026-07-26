import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ipc, type WindowInfo } from "../../lib/ipc";
import AnnotationStage, { type StageHandle } from "../../features/annotation/canvas/AnnotationStage";
import { useEditor } from "../../features/annotation/store";
import { PRESET_COLORS, type Tool } from "../../features/annotation/model";
import { quickToolFromKey } from "../../lib/toolShortcuts";
import QuickToolbar, { quickToolbarLayout } from "../quick-capture/QuickToolbar";

/**
 * Lấy ảnh "đóng băng màn hình" từ Rust (JPEG base64) khi mount overlay.
 * Trả { url, ready }:
 *   - url: data URL để dùng làm CSS background-image (null khi chưa có)
 *   - ready: true khi đã lấy xong (dù thành công hay thất bại) — overlay
 *     dùng để quyết định có render hay không, tránh flash transparent.
 *
 * Overlay giữ `visibility: hidden` cho đến khi ready=true, sau đó hiện ngay
 * với frozen image đã có → không có frame nào bị "trong suốt" lộ ra màn hình.
 *
 * Sau khi ready=true, báo ngược lại cho Rust (`notify_overlay_ready`) rằng
 * overlay này đã paint xong — Rust (`windows::wait_for_overlays_ready`) chờ
 * đủ tín hiệu từ mọi overlay rồi mới `show()` TẤT CẢ cùng lúc, để frame đầu
 * tiên hiện ra trên màn hình đã có sẵn ảnh đúng (cơ chế freeze mượt như
 * Snagit: không bao giờ show() window rồi mới paint nội dung vào sau).
 * Double rAF: rAF đầu chờ trình duyệt schedule vẽ DOM mới (ready=true), rAF
 * thứ hai chạy sau khi frame đó đã thực sự được composite.
 */
function useFrozenScreen(): { url: string | null; ready: boolean } {
  const [state, setState] = useState<{ url: string | null; ready: boolean }>({
    url: null,
    ready: false,
  });
  useEffect(() => {
    let cancelled = false;
    ipc.getFrozenScreen(MY_IDX)
      .then((b64) => {
        if (!cancelled) {
          setState({ url: b64 ? `data:image/jpeg;base64,${b64}` : null, ready: true });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, ready: true });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!state.ready) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        ipc.notifyOverlayReady(MY_IDX, GEN).catch(() => {});
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [state.ready]);

  return state;
}

const params = new URLSearchParams(window.location.search);
const MODE = params.get("mode") ?? "region";
const MY_IDX = Number(params.get("idx") ?? "0");
const SCALE = Number(params.get("scale") ?? "1") || 1;
// Phiên overlay hiện tại (Rust gán, xem `windows::open_overlays_ex`) — echo
// lại qua `notifyOverlayReady` để Rust lọc bỏ tín hiệu trễ từ phiên cũ.
const GEN = Number(params.get("gen") ?? "0");
// "record=1" = đang chọn phạm vi QUAY (không phải chụp ảnh) — chỉ MODE=="region"
// quan tâm tới cờ này (window/monitor picker chọn tức thì, không cần bước
// chỉnh vùng). "px/py/pw/ph" (nếu có) = vùng đã quay lần gần nhất, đề xuất lại
// ngay trên đúng màn hình đã lưu (xem `windows::open_overlays_ex`).
const RECORD = params.get("record") === "1";
const PRESET: Sel | null = (() => {
  const px = params.get("px");
  const py = params.get("py");
  const pw = params.get("pw");
  const ph = params.get("ph");
  if (px == null || py == null || pw == null || ph == null) return null;
  return { x: Number(px), y: Number(py), w: Number(pw), h: Number(ph) };
})();

type Vec2 = [number, number];

/**
 * Nhận input do Rust phát (không cần focus cửa sổ):
 * - onInput(active, x, y): con trỏ có đang trên overlay này không + toạ độ CSS.
 * - onPress(x, y) / onRelease(x, y): nhấn/thả chuột trái trên overlay này.
 */
function useInput(
  onInput: (active: boolean, x: number, y: number) => void,
  onPress: (x: number, y: number) => void,
  onRelease: (x: number, y: number) => void,
) {
  const i = useRef(onInput);
  const p = useRef(onPress);
  const r = useRef(onRelease);
  i.current = onInput;
  p.current = onPress;
  r.current = onRelease;

  useEffect(() => {
    const subs = [
      listen<[number, number, number]>("overlay-input", (e) => {
        const [idx, x, y] = e.payload;
        i.current(idx === MY_IDX, x, y);
      }),
      listen<[number, number, number]>("overlay-press", (e) => {
        const [idx, x, y] = e.payload;
        if (idx === MY_IDX) p.current(x, y);
      }),
      listen<[number, number, number]>("overlay-release", (e) => {
        const [idx, x, y] = e.payload;
        if (idx === MY_IDX) r.current(x, y);
      }),
    ];
    return () => {
      subs.forEach((s) => s.then((f) => f()));
    };
  }, []);
}

export default function Overlay() {
  return (
    <>
      {/* Keyframes dùng chung cho hiệu ứng "kiến bò" (marching ants) của mọi
          viền cam nét đứt trong overlay — xem `antsBorder()`. */}
      <style>{ANTS_KEYFRAMES}</style>
      {MODE === "monitor" ? (
        <MonitorPick />
      ) : MODE === "quick" ? (
        <QuickAnnotate />
      ) : MODE === "region" && RECORD ? (
        <RecordRegionSelect />
      ) : (
        <RegionSelect />
      )}
    </>
  );
}

/* ───────────── Region: kéo vùng chọn (live, đa màn hình) ───────────── */

interface Sel {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectFrom(sx: number, sy: number, x: number, y: number): Sel {
  return { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
}

/** Cửa sổ trên cùng (front-to-back, phần tử đầu tiên khớp) chứa điểm (x, y).
 * Dùng trong `RegionSelect` để gợi ý hover cửa sổ trước khi kéo vùng — nhận
 * `WindowInfo[]` theo hệ toạ độ CSS px tương đối theo overlay hiện tại (xem
 * `capture/window.rs::list`). */
function pickWindow(wins: WindowInfo[], x: number, y: number): WindowInfo | null {
  return wins.find((w) => x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) ?? null;
}

/*
 * Chụp cuộn (scroll capture) dùng CHUNG overlay này (Rust mở overlay ở mode
 * "region" bình thường, không phân biệt lúc mở — xem `flow::run`). Khác với
 * chụp ảnh (thả chuột chụp NGAY, overlay đóng gần như tức thì): nếu backend
 * xác định đây là phiên chụp cuộn (`flow::finalize_region`, nhánh "scroll"),
 * nó KHÔNG đóng cửa sổ này — chỉ bật click-through rồi bắn sự kiện
 * `scroll-border-activate` NGAY TRONG CHÍNH cửa sổ này (đã lắng nghe sẵn từ
 * lúc mount). Component chuyển từ hiển thị "khung xanh + backdrop mờ" sang
 * khung viền nét đứt pulsing (giao diện cũ của cửa sổ `scroll-border` rời,
 * xem `ScrollBorder.tsx`) NGAY TẠI VỊ TRÍ đã đứng yên — không một cửa sổ nào
 * bị đóng/tạo lại nên không có khoảng hở gây "nháy khung".
 */
function RegionSelect() {
  const { t } = useTranslation();
  const { url: frozenUrl, ready: frozenReady } = useFrozenScreen();
  const startRef = useRef<Vec2 | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  // Vùng vừa chốt (mouseup) — giữ lại NGOÀI `sel` (bị xoá về null ngay khi thả
  // chuột) để còn khung để vẽ nếu backend báo đây là phiên chụp cuộn.
  const scrollRectRef = useRef<Sel | null>(null);
  const [scrollRect, setScrollRect] = useState<Sel | null>(null);

  // Gợi ý cửa sổ khi hover (giống Snagit: di chuột qua cửa sổ → viền gợi ý;
  // click không kéo = chụp nguyên cửa sổ đó; kéo = bỏ qua gợi ý, chọn vùng tự
  // do như cũ). Danh sách cửa sổ fetch 1 lần lúc mount, cùng cách `WindowPicker`
  // đã làm — không polling lại trong lúc chọn.
  const winsRef = useRef<WindowInfo[]>([]);
  const [hoverWin, setHoverWin] = useState<WindowInfo | null>(null);
  // Cửa sổ đang hover TẠI THỜI ĐIỂM press — dùng để quyết định lúc release có
  // phải "click nhanh trúng cửa sổ" hay không.
  const pressWinRef = useRef<WindowInfo | null>(null);
  // true nếu con trỏ THẬT SỰ đang ở overlay này (đa màn hình: mỗi overlay chỉ
  // biết cursor có đang trên MÀN HÌNH của chính nó hay không). Dùng để bỏ lớp
  // phủ xám ở đúng màn hình đang thao tác — các màn hình còn lại vẫn xám như
  // cũ, chỉ màn hình có con trỏ mới cho nhìn rõ nội dung bên dưới.
  const [cursorHere, setCursorHere] = useState(false);
  // Vị trí con trỏ hiện tại (đủ để vẽ 2 đường dóng ngang/dọc kéo dài hết màn
  // hình, giúp canh mép vùng chọn theo cửa sổ/nội dung bên dưới — giống vạch
  // dóng của Snagit). `null` khi con trỏ rời khỏi màn hình này.
  const [cursorPos, setCursorPos] = useState<Vec2 | null>(null);

  useEffect(() => {
    ipc.listWindows().then((w) => { winsRef.current = w; }).catch(() => {});
  }, []);

  useEffect(() => {
    const un = listen("scroll-border-activate", () => {
      setScrollRect(scrollRectRef.current);
    });
    return () => { un.then((f) => f()); };
  }, []);

  useInput(
    (active, x, y) => {
      if (scrollRect) return;
      setCursorHere(active);
      setCursorPos(active ? [x, y] : null);
      if (startRef.current) {
        if (active) setSel(rectFrom(startRef.current[0], startRef.current[1], x, y));
        return;
      }
      setHoverWin(active ? pickWindow(winsRef.current, x, y) : null);
    },
    (x, y) => {
      if (scrollRect) return;
      startRef.current = [x, y];
      pressWinRef.current = hoverWin;
      setHoverWin(null);
      setSel({ x, y, w: 0, h: 0 });
    },
    (x, y) => {
      if (scrollRect) return;
      const s = startRef.current;
      startRef.current = null;
      setSel(null);
      const w = pressWinRef.current;
      pressWinRef.current = null;
      if (!s) return;
      // Click nhanh (di chuyển rất ít) trong lúc đang hover 1 cửa sổ, và vẫn
      // đang đứng trong đúng cửa sổ đó lúc thả chuột → chụp nguyên cửa sổ,
      // giống Snagit. Kéo đủ xa (hoặc đã rời khỏi cửa sổ) → rơi về free-region
      // như cũ, không đổi hành vi.
      const dist = Math.hypot(x - s[0], y - s[1]);
      if (dist < 4 && w && pickWindow(winsRef.current, x, y)?.id === w.id) {
        ipc.finalizeWindow(w.id).catch((e) => alert(String(e)));
        return;
      }
      const r = rectFrom(s[0], s[1], x, y);
      if (r.w >= 3 && r.h >= 3) {
        scrollRectRef.current = r;
        ipc.finalizeRegion(r.x, r.y, r.w, r.h).catch((e) => {
          scrollRectRef.current = null;
          alert(String(e));
        });
      }
    },
  );

  // Phiên chụp cuộn đã kích hoạt: khung viền cam nét đứt "kiến bò" bao quanh
  // vùng chọn (lớn hơn 12px mỗi chiều, cùng kích thước cửa sổ `scroll-border` cũ),
  // click-through/content-protected đã được Rust bật ngay trên cửa sổ này.
  // `key` KHÁC với root ở nhánh "đang kéo chọn" bên dưới — bắt buộc: cả hai
  // đều là <div> ở cùng vị trí trong cây, nếu không có `key` riêng, React coi
  // đây là CÙNG 1 node và chỉ cập nhật style — khiến `left/top` "nhảy" từ giá
  // trị cũ (backdrop dùng `inset: 0`, tức góc trên-trái) sang vị trí khung
  // thật, và vì có `transition: all` nên trình duyệt ANIMATE luôn cú nhảy đó
  // (chính là hiện tượng "khung trôi từ góc trái ra vị trí vừa vẽ"). `key`
  // khác buộc React unmount node cũ + mount node mới, loại bỏ hoàn toàn.
  if (scrollRect) {
    return (
      <div key="scroll-active" style={{ ...root, background: "transparent" }}>
        <div
          style={{
            position: "fixed",
            left: scrollRect.x - 6,
            top: scrollRect.y - 6,
            width: scrollRect.w + 12,
            height: scrollRect.h + 12,
            ...antsBorder(2.5),
            // Dim toàn bộ phần NGOÀI khung (giống backdrop lúc kéo chọn) để
            // phân biệt rõ vùng đang chụp cuộn với phần còn lại — trước đây
            // nền trong suốt khiến vùng chụp và phần ngoài trông giống hệt
            // nhau, chỉ có nét đứt mảnh để nhận biết. An toàn với ảnh chụp:
            // cửa sổ đã `content_protected(true)` nên toàn bộ overlay (kể cả
            // lớp dim này) bị loại khỏi mọi lát cắt chụp cuộn.
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.45), inset 0 0 12px rgba(245, 158, 11, 0.25)",
            pointerEvents: "none",
          }}
        />
      </div>
    );
  }

  const rootStyle: React.CSSProperties = {
    ...root,
    // Ẩn hoàn toàn cho đến khi frozen image load xong — tránh flash transparent.
    visibility: frozenReady ? "visible" : "hidden",
    ...(frozenUrl ? {
      backgroundImage: `url("${frozenUrl}")`,
      backgroundSize: "100% 100%",
      backgroundRepeat: "no-repeat",
    } : {}),
    cursor: CROSSHAIR_CURSOR,
  };

  return (
    <div key="drag" style={rootStyle}>
      {sel && sel.w > 0 ? (
        <div
          style={{
            position: "fixed",
            left: sel.x,
            top: sel.y,
            width: sel.w,
            height: sel.h,
            ...antsBorder(2),
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        >
          <span style={sizeLabel}>
            {Math.round(sel.w)} × {Math.round(sel.h)}
          </span>
        </div>
      ) : (
        <div
          style={{
            position: "fixed",
            inset: 0,
            // Màn hình đang có con trỏ: bỏ lớp phủ xám để nhìn rõ nội dung bên
            // dưới (chỉ còn viền cam khi hover cửa sổ + khung khi kéo chọn).
            // Các màn hình còn lại vẫn xám như cũ.
            background: cursorHere ? "transparent" : frozenUrl ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.5)",
          }}
        >
          <div style={banner}>{t("overlay.dragToSelect")}</div>
        </div>
      )}
      {/* Gợi ý cửa sổ khi hover — chỉ trước khi press (`sel === null`), ẩn
          ngay khi bắt đầu kéo để không che khung đang chọn. */}
      {!sel && hoverWin && (
        <div
          style={{
            position: "fixed",
            left: hoverWin.x,
            top: hoverWin.y,
            width: hoverWin.width,
            height: hoverWin.height,
            ...antsBorder(2.5),
            pointerEvents: "none",
          }}
        >
          <span style={sizeLabel}>
            {hoverWin.app || hoverWin.title || t("overlay.windowLabel")}
          </span>
        </div>
      )}
      {!sel && (
        <RegionFullscreenButton onClick={() => ipc.finalizeMonitor().catch((e) => alert(String(e)))} />
      )}
      {/* Đường dóng ngang/dọc nét đứt kéo dài hết màn hình theo vị trí con
          trỏ — giúp canh mép vùng chọn theo nội dung bên dưới, giống vạch
          dóng của Snagit. */}
      {cursorPos && (
        <>
          <div
            style={{
              position: "fixed",
              left: 0,
              top: cursorPos[1],
              width: "100%",
              height: 0,
              borderTop: `1.5px dashed ${ANTS_COLOR}`,
              opacity: 0.85,
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "fixed",
              left: cursorPos[0],
              top: 0,
              width: 0,
              height: "100%",
              borderLeft: `1.5px dashed ${ANTS_COLOR}`,
              opacity: 0.85,
              pointerEvents: "none",
            }}
          />
        </>
      )}
    </div>
  );
}

/** Nút nổi "Chụp toàn màn hình" trên overlay Region — gọi thẳng action đã có
 * (`ipc.finalizeMonitor`, giống `MonitorPick`) để người dùng đổi ý sang chụp
 * toàn màn hình ngay trong lúc đang thao tác, không cần đóng overlay quay lại
 * capture bar. */
function RegionFullscreenButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      style={{
        position: "fixed",
        top: 64,
        left: "50%",
        transform: "translateX(-50%)",
        border: "none",
        borderRadius: 999,
        padding: "10px 22px",
        background: "#3b82f6",
        color: "#fff",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {t("overlay.captureFullscreen")}
    </button>
  );
}

/* ───────────── Record region: chọn/nhớ vùng quay, kéo chỉnh + nút Bắt đầu ─────────────
 *
 * Khác `RegionSelect` (chụp ảnh — thả chuột là chụp NGAY): ở đây thả chuột chỉ
 * chuyển sang pha "adjusting" (khung có thể kéo di chuyển + resize, giống
 * pattern của `QuickAnnotate` bên dưới) — phải bấm nút "Bắt đầu quay" mới thật
 * sự start recording (`ipc.finalizeRegion`, Rust tự nhận biết qua cờ
 * `pending_record` để rẽ sang quay thay vì chụp). Nếu có `PRESET` (vùng quay
 * lần gần nhất, do Rust đề xuất qua query string) thì vào thẳng "adjusting"
 * với khung đó, khỏi cần kéo lại từ đầu.
 *
 * KHÔNG có nút "Chọn vùng khác" riêng — bấm/kéo NGOÀI khung hiện tại (dù đang
 * ở pha nào) tự động bắt đầu 1 lần chọn vùng mới, giống hành vi tự nhiên của
 * việc vẽ lại. Bấm bên TRONG khung hoặc lên thanh nút thì di chuyển/resize/bấm
 * nút như bình thường (phân biệt qua toạ độ + target capture-phase, xem
 * `pressInfoRef`, cùng kỹ thuật `QuickAnnotate` bên dưới dùng).
 *
 * Sau khi bấm "Bắt đầu quay" thành công: cửa sổ overlay này KHÔNG bị đóng/ẩn/
 * resize/reposition gì cả — Rust chỉ bật `ignore_cursor_events` (click xuyên
 * qua) trên chính nó, giữ khung đỏ + nền mờ hiển thị Y NGUYÊN PIXEL suốt từ
 * lúc "adjusting" sang lúc quay (không một khung hình nào bị bỏ lỡ → không
 * còn nháy hình). Component chỉ đơn giản BỎ handle resize + thanh nút (vì giờ
 * click xuyên qua, không còn ai bấm được nữa) — nút "■ Dừng quay" thật sự nằm
 * ở 1 cửa sổ NHỎ RIÊNG (`record-stop-control`, xem `windows::open_stop_control`),
 * không click-through, nổi cạnh khung.
 */

const REC_MIN_SEL = 20;
const recClamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type RecPhase = "selecting" | "adjusting";

const REC_HANDLES = [
  { id: "nw", cx: 0, cy: 0, cur: "nwse-resize" },
  { id: "n", cx: 0.5, cy: 0, cur: "ns-resize" },
  { id: "ne", cx: 1, cy: 0, cur: "nesw-resize" },
  { id: "e", cx: 1, cy: 0.5, cur: "ew-resize" },
  { id: "se", cx: 1, cy: 1, cur: "nwse-resize" },
  { id: "s", cx: 0.5, cy: 1, cur: "ns-resize" },
  { id: "sw", cx: 0, cy: 1, cur: "nesw-resize" },
  { id: "w", cx: 0, cy: 0.5, cur: "ew-resize" },
] as const;

/** Vị trí + kích thước thanh nút "Bắt đầu quay" — DÙNG CHUNG giữa lúc render
 * (`RecordRegionToolbar`) và lúc hit-test press toàn cục (xem `useInput` bên
 * dưới) để bấm nút không bao giờ bị hiểu nhầm thành "chọn vùng khác". */
function recToolbarRect(sel: Sel, winW: number, winH: number): Sel {
  const barH = 48;
  // Khoảng cách từ mép khung tới thanh nút — tăng so với trước (12→16px) để
  // dễ nhìn/dễ bấm hơn, đồng bộ với `QuickToolbar`.
  const gap = 16;
  const barW = 260;
  const below = sel.y + sel.h + gap + barH <= winH;
  const top = below ? sel.y + sel.h + gap : Math.max(gap, sel.y - gap - barH);
  const left = recClamp(sel.x, 0, Math.max(0, winW - barW));
  // An toàn cuối: đảm bảo thanh nút luôn nằm trọn trong viewport kể cả khi
  // khung chọn chiếm gần hết chiều cao màn hình (cùng lớp bug đã sửa ở
  // `quickToolbarLayout`).
  return { x: left, y: recClamp(top, 0, Math.max(0, winH - barH)), w: barW, h: barH };
}

/** true nếu (x,y) rơi vào khung đang chỉnh HOẶC thanh nút của nó — dùng
 * CHUNG cho cả phép hit-test khi bấm (chặn "chọn lại" nhầm) lẫn khi hover
 * (đổi con trỏ gợi ý), xem `RecordRegionSelect`. */
function isOverBoxOrBar(sel: Sel, winW: number, winH: number, x: number, y: number): boolean {
  const inRect = (r: Sel, m: number) =>
    x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
  return inRect(sel, 14) || inRect(recToolbarRect(sel, winW, winH), 6);
}

function RecordRegionSelect() {
  const { t } = useTranslation();
  const { url: frozenUrl, ready: frozenReady } = useFrozenScreen();
  const [phase, setPhase] = useState<RecPhase>(PRESET ? "adjusting" : "selecting");
  const [sel, setSel] = useState<Sel | null>(PRESET);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  // true khi con trỏ đang ở nền trống (ngoài khung + ngoài thanh nút) lúc
  // "adjusting" — đổi con trỏ sang crosshair để user biết bấm/kéo tại đây sẽ
  // chọn lại vùng khác, thay vì để con trỏ "default" gây hiểu lầm không bấm
  // được (chính là nguyên nhân gốc của lỗi bấm nhầm nút Bắt đầu quay).
  const [bgHover, setBgHover] = useState(false);
  const startRef = useRef<Vec2 | null>(null);
  // true nếu con trỏ THẬT SỰ đang ở overlay này (đa màn hình) — dùng để bỏ
  // lớp phủ xám ở đúng màn hình đang thao tác, giống `RegionSelect`.
  const [cursorHere, setCursorHere] = useState(false);
  // Vị trí con trỏ — vẽ 2 đường dóng ngang/dọc nét đứt kéo dài hết màn hình,
  // chỉ khi crosshair đang hoạt động (đang chọn/định vị lại vùng), giống
  // `RegionSelect`/`QuickAnnotate`.
  const [cursorPos, setCursorPos] = useState<Vec2 | null>(null);

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  // Cú bấm native gần nhất rơi vào NỀN TRỐNG (root) hay 1 phần UI (khung/
  // handle/toolbar)? `overlay-press` bắn cho MỌI cú bấm kể cả lên nút toolbar
  // (nằm ngoài khung) — chỉ dựa toạ độ sẽ hiểu nhầm bấm nút thành "chọn lại".
  const rootRef = useRef<HTMLDivElement>(null);
  const pressInfoRef = useRef<{ onBackdrop: boolean; t: number } | null>(null);
  const onDownCapture = (e: React.PointerEvent) => {
    pressInfoRef.current = { onBackdrop: e.target === rootRef.current, t: performance.now() };
  };

  // ── Pha "adjusting": kéo di chuyển / resize khung bằng pointer event thường ──
  // (khai báo TRƯỚC useInput bên dưới — callback hover cần đọc `.current` của
  // 2 ref này để không đổi con trỏ giữa lúc đang kéo/resize dở).
  const moveRef = useRef<{ mx: number; my: number; start: Sel } | null>(null);
  const resizeRef = useRef<{ id: string; mx: number; my: number; start: Sel } | null>(null);

  // ── Kéo chọn vùng: hoạt động ở CẢ 2 pha — trong "adjusting", bấm/kéo NGOÀI
  // khung hiện tại (và ngoài thanh nút) tự khởi động 1 lần chọn mới. ──
  useInput(
    (active, x, y) => {
      if (recording) return;
      setCursorHere(active);
      // Hover thường (không đang kéo chọn/di chuyển/resize) → cập nhật gợi ý
      // con trỏ cho vùng nền trống.
      if (active && phase === "adjusting" && sel && !startRef.current && !moveRef.current && !resizeRef.current) {
        setBgHover(!isOverBoxOrBar(sel, winW, winH, x, y));
      }
      setCursorPos(
        active && (phase === "selecting" || (phase === "adjusting" && bgHover)) ? [x, y] : null,
      );
      if (!active || !startRef.current) return;
      setSel(rectFrom(startRef.current[0], startRef.current[1], x, y));
    },
    (x, y) => {
      if (recording) return;
      if (sel && phase === "adjusting") {
        const info = pressInfoRef.current;
        const onUI = !!info && performance.now() - info.t < 600 && !info.onBackdrop;
        if (isOverBoxOrBar(sel, winW, winH, x, y) || onUI) return; // đang kéo di chuyển/resize khung, hoặc bấm nút toolbar
      }
      startRef.current = [x, y];
      setSel({ x, y, w: 0, h: 0 });
      setPhase("selecting");
    },
    (x, y) => {
      if (recording) return;
      const s = startRef.current;
      startRef.current = null;
      if (!s) return; // không phải đang kéo chọn (đang move/resize khung)
      const r = rectFrom(s[0], s[1], x, y);
      if (r.w >= REC_MIN_SEL && r.h >= REC_MIN_SEL) {
        setSel(r);
        setPhase("adjusting");
        getCurrentWindow().setFocus().catch(() => {});
      } else if (phase === "selecting") {
        setSel(null);
      }
      // Kéo quá nhỏ khi đang "adjusting" (vd: click nhầm) → giữ nguyên khung cũ.
    },
  );

  // Màn hình KHÁC vừa được bấm → xoá khung ở màn này (chỉ 1 khung active tại
  // 1 thời điểm, đa màn hình — mỗi overlay-{i} là 1 webview/state React RIÊNG
  // nên không tự biết màn khác vừa bắt đầu vẽ, phải nghe global input loop).
  useEffect(() => {
    const un = listen<[number, number, number]>("overlay-press", (e) => {
      if (recording) return;
      if (e.payload[0] !== MY_IDX) {
        startRef.current = null;
        setSel(null);
        setPhase("selecting");
      }
    });
    return () => { un.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const onMoveDown = (e: React.PointerEvent) => {
    if (phase !== "adjusting" || !sel) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    moveRef.current = { mx: e.clientX, my: e.clientY, start: sel };
  };
  const onResizeDown = (id: string) => (e: React.PointerEvent) => {
    if (!sel) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeRef.current = { id, mx: e.clientX, my: e.clientY, start: sel };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const m = moveRef.current;
    if (m) {
      const dx = e.clientX - m.mx;
      const dy = e.clientY - m.my;
      setSel({
        x: recClamp(m.start.x + dx, 0, winW - m.start.w),
        y: recClamp(m.start.y + dy, 0, winH - m.start.h),
        w: m.start.w,
        h: m.start.h,
      });
      return;
    }
    const r = resizeRef.current;
    if (r) {
      const dx = e.clientX - r.mx;
      const dy = e.clientY - r.my;
      let { x, y, w, h } = r.start;
      if (r.id.includes("w")) { const nx = recClamp(x + dx, 0, x + w - REC_MIN_SEL); w += x - nx; x = nx; }
      if (r.id.includes("e")) { w = recClamp(w + dx, REC_MIN_SEL, winW - x); }
      if (r.id.includes("n")) { const ny = recClamp(y + dy, 0, y + h - REC_MIN_SEL); h += y - ny; y = ny; }
      if (r.id.includes("s")) { h = recClamp(h + dy, REC_MIN_SEL, winH - y); }
      setSel({ x, y, w, h });
    }
  };
  const onPointerUp = () => {
    moveRef.current = null;
    resizeRef.current = null;
  };

  const doCancel = () => ipc.cancelOverlay();
  const doStart = async () => {
    if (!sel || busy) return;
    setBusy(true);
    try {
      await ipc.finalizeRegion(sel.x, sel.y, sel.w, sel.h);
      // Thành công → cửa sổ này giờ đã click-through (Rust), khung đỏ + nền
      // mờ vẫn hiển thị y nguyên vị trí. Chỉ cần bỏ handle/thanh nút vì không
      // ai bấm được nữa (nút "Dừng quay" thật ở cửa sổ nhỏ riêng).
      setRecording(true);
      setBusy(false);
    } catch (e) {
      setBusy(false);
      alert(String(e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recording) return;
      if (e.key === "Escape") { e.preventDefault(); doCancel(); }
      if (e.key === "Enter" && phase === "adjusting") { e.preventDefault(); doStart(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sel, busy, recording]);

  // Nút "Quay" ở CaptureBar bấm trong lúc khung này đang mở (xem
  // `flow::confirm_region_record_start`) = coi như bấm "Bắt đầu quay" ngay
  // tại đây — chỉ phản ứng khi đang ở pha "adjusting" (đã có khung); bắn cho
  // MỌI overlay-{i} nên các màn hình khác (đang "selecting", chưa có khung)
  // tự bỏ qua.
  useEffect(() => {
    const un = listen("region-record-confirm", () => {
      if (phase === "adjusting" && sel && !recording && !busy) doStart();
    });
    return () => { un.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sel, recording, busy]);

  return (
    <div
      ref={rootRef}
      style={{
        ...root,
        visibility: frozenReady ? "visible" : "hidden",
        // Khi đang quay: bỏ frozen background để màn hình thật hiện ra.
        // 4 div nền xám bên dưới sẽ che phần ngoài vùng quay.
        ...(!recording && frozenUrl ? {
          backgroundImage: `url("${frozenUrl}")`,
          backgroundSize: "100% 100%",
          backgroundRepeat: "no-repeat",
        } : {}),
        cursor: !recording && (phase === "selecting" || (phase === "adjusting" && bgHover)) ? CROSSHAIR_CURSOR : "default",
      }}
      onPointerDownCapture={onDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => { e.preventDefault(); doCancel(); }}
    >
      {sel && sel.w > 0 ? (
        <>
          {/* Khi đang quay: 4 dải nền xám mờ che 4 phía ngoài vùng quay —
              thay thế box-shadow (bị bỏ khi recording) để user phân biệt rõ
              vùng đang quay với phần còn lại. Overlay đã click-through nên
              các div này không chặn chuột. */}
          {recording && (
            <>
              {/* Trên */}
              <div style={{ position: "fixed", inset: 0, bottom: "auto", height: sel.y, background: "rgba(0,0,0,0.4)", pointerEvents: "none" }} />
              {/* Dưới */}
              <div style={{ position: "fixed", left: 0, top: sel.y + sel.h, right: 0, bottom: 0, background: "rgba(0,0,0,0.4)", pointerEvents: "none" }} />
              {/* Trái (chỉ khoảng giữa trên-dưới) */}
              <div style={{ position: "fixed", left: 0, top: sel.y, width: sel.x, height: sel.h, background: "rgba(0,0,0,0.4)", pointerEvents: "none" }} />
              {/* Phải */}
              <div style={{ position: "fixed", left: sel.x + sel.w, top: sel.y, right: 0, height: sel.h, background: "rgba(0,0,0,0.4)", pointerEvents: "none" }} />
            </>
          )}
          <div
            style={{
              position: "fixed",
              left: sel.x,
              top: sel.y,
              width: sel.w,
              height: sel.h,
              outline: "2px solid #ef4444",
              // Khi chưa quay: dim phần ngoài bằng box-shadow.
              // Khi đang quay: dùng 4 div riêng ở trên, box-shadow = none.
              boxShadow: recording ? "none" : "0 0 0 9999px rgba(0,0,0,0.55)",
              cursor: !recording && phase === "adjusting" ? "move" : "default",
            }}
            onPointerDown={onMoveDown}
          >
            {!recording && phase === "selecting" && (
              <span style={sizeLabel}>{Math.round(sel.w)} × {Math.round(sel.h)}</span>
            )}
            {!recording && phase === "adjusting" && REC_HANDLES.map((hd) => (
              <div key={hd.id} onPointerDown={onResizeDown(hd.id)} style={quickHandleStyle(hd)} />
            ))}
            {!recording && phase === "adjusting" && (
              <RecordRegionToolbar sel={sel} winW={winW} winH={winH} busy={busy} onStart={doStart} onCancel={doCancel} />
            )}
          </div>
        </>
      ) : (
        <div
          style={{
            position: "fixed",
            inset: 0,
            // Màn hình đang có con trỏ: bỏ lớp phủ xám để nhìn rõ nội dung bên
            // dưới, giống `RegionSelect`. Các màn hình còn lại vẫn xám như cũ.
            background: cursorHere ? "transparent" : frozenUrl ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.5)",
          }}
        >
          <div style={banner}>{t("overlay.dragToSelectRecord")}</div>
        </div>
      )}
      {/* Đường dóng ngang/dọc nét đứt theo con trỏ — chỉ khi crosshair đang
          hoạt động (đang chọn/định vị lại vùng), giống `RegionSelect`/`QuickAnnotate`. */}
      {!recording && cursorPos && (
        <>
          <div
            style={{
              position: "fixed", left: 0, top: cursorPos[1], width: "100%", height: 0,
              borderTop: `1.5px dashed ${ANTS_COLOR}`, opacity: 0.85, pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "fixed", left: cursorPos[0], top: 0, width: 0, height: "100%",
              borderLeft: `1.5px dashed ${ANTS_COLOR}`, opacity: 0.85, pointerEvents: "none",
            }}
          />
        </>
      )}
    </div>
  );
}

/** Thanh nút nổi ngay dưới (hoặc trên nếu sát mép dưới màn hình) khung đang chỉnh. */
function RecordRegionToolbar({
  sel, winW, winH, busy, onStart, onCancel,
}: {
  sel: Sel; winW: number; winH: number; busy: boolean;
  onStart: () => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const bar = recToolbarRect(sel, winW, winH);
  return (
    <div
      style={{
        position: "fixed",
        left: bar.x,
        top: bar.y,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "rgba(20,20,24,0.97)",
        borderRadius: 10,
        padding: "8px 10px",
        border: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "0 6px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.3)",
        cursor: "default",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span style={{ color: "#fff", fontSize: 12, whiteSpace: "nowrap", padding: "0 4px" }}>
        {Math.round(sel.w)} × {Math.round(sel.h)}
      </span>
      <button style={recBtnStyle(false)} onClick={onCancel} disabled={busy}>{t("overlay.cancel")}</button>
      <button style={recBtnStyle(true)} onClick={onStart} disabled={busy}>
        {busy ? t("overlay.startingRecording") : t("overlay.startRecording")}
      </button>
    </div>
  );
}

function recBtnStyle(primary: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: primary ? 600 : 500,
    cursor: "pointer",
    color: primary ? "#fff" : "#e5e7eb",
    background: primary ? "#ef4444" : "rgba(255,255,255,0.12)",
    whiteSpace: "nowrap",
  };
}

/* ───────────── Quick: Chụp nhanh (chọn vùng + chú thích tại chỗ) ───────────── */

const MIN_SEL = 12;
const STAGE_PAD = 8;
type QuickPhase = "selecting" | "adjusting" | "annotating";

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function transparentPng(w: number, h: number): string {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c.toDataURL("image/png");
}
function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

function QuickAnnotate() {
  const { t } = useTranslation();
  const { url: frozenUrl, ready: frozenReady } = useFrozenScreen();
  const loadDoc = useEditor((s) => s.loadDoc);
  const setTool = useEditor((s) => s.setTool);
  const annCount = useEditor((s) => s.doc?.annotations.length ?? 0);
  const stageRef = useRef<StageHandle>(null);

  const [phase, setPhase] = useState<QuickPhase>("selecting");
  const [sel, setSel] = useState<Sel | null>(null);
  const [busy, setBusy] = useState(false);
  const startRef = useRef<Vec2 | null>(null);
  // Vị trí con trỏ hiện tại — vẽ 2 đường dóng ngang/dọc nét đứt kéo dài hết
  // màn hình để canh mép vùng chọn theo nội dung bên dưới (giống `RegionSelect`).
  const [cursorPos, setCursorPos] = useState<Vec2 | null>(null);
  // true nếu con trỏ THẬT SỰ đang ở overlay này (đa màn hình) — dùng để bỏ lớp
  // phủ xám ở đúng màn hình đang thao tác, giống `RegionSelect`.
  const [cursorHere, setCursorHere] = useState(false);

  // Gợi ý cửa sổ khi hover (giống `RegionSelect`): click nhanh không kéo khi
  // đang hover 1 cửa sổ → nạp thẳng khung = đúng cửa sổ đó (pha "adjusting",
  // y hệt vừa kéo-chọn xong) thay vì phải tự kéo tay. Chỉ áp dụng lúc CHƯA có
  // khung nào (`phase === "selecting"`) — xem gate trong `useInput` bên dưới.
  const winsRef = useRef<WindowInfo[]>([]);
  const [hoverWin, setHoverWin] = useState<WindowInfo | null>(null);
  const pressWinRef = useRef<WindowInfo | null>(null);

  useEffect(() => {
    ipc.listWindows().then((w) => { winsRef.current = w; }).catch(() => {});
  }, []);

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const prevSelRef = useRef<Sel | null>(null);
  const prevPhaseRef = useRef<QuickPhase>("selecting");

  // Cú bấm chuột native gần nhất rơi vào ĐÂU: nền trống (root) hay một phần UI
  // (khung / handle / toolbar / canvas)? Global input loop phát `overlay-press`
  // cho MỌI cú bấm — kể cả khi bấm vào nút toolbar (nằm ngoài khung) — nên chỉ
  // dựa vào toạ độ sẽ hiểu nhầm mọi thao tác thành "chọn lại". Vì thế ta xác
  // định qua target của native pointerdown (capture-phase, luôn chạy trước).
  const rootRef = useRef<HTMLDivElement>(null);
  const pressInfoRef = useRef<{ onBackdrop: boolean; t: number } | null>(null);
  const onDownCapture = (e: React.PointerEvent) => {
    pressInfoRef.current = { onBackdrop: e.target === rootRef.current, t: performance.now() };
  };

  // ── Chọn vùng qua global input loop — CHẠY SUỐT PHIÊN trên MỌI màn hình,
  // dùng cho cả chọn lần đầu lẫn chọn lại (kể cả sang màn hình khác). ──
  useInput(
    (active, x, y) => {
      setCursorHere(active);
      const stillSelecting = active && phase === "selecting" && !startRef.current;
      setCursorPos(active && phase === "selecting" ? [x, y] : null);
      setHoverWin(stillSelecting ? pickWindow(winsRef.current, x, y) : null);
      if (!active || !startRef.current) return;
      setSel(rectFrom(startRef.current[0], startRef.current[1], x, y));
    },
    (x, y) => {
      // Đang có khung: CHỈ chọn lại khi bấm NGOÀI khung VÀ NGOÀI cả hai thanh
      // công cụ (phải + dưới). Kiểm tra theo HÌNH HỌC vùng (khớp đúng vùng
      // toolbar render). Popup chọn màu bung ra ngoài thanh → thêm guard target
      // native (bấm vào UI thì target khác root).
      if (sel && phase !== "selecting") {
        const inRect = (r: { x: number; y: number; w: number; h: number }, m = 0) =>
          x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
        const lay = quickToolbarLayout(sel, winW, winH);
        const onBox = inRect(sel, 14); // 14 = phủ luôn handle resize
        const onBar = inRect(lay.vRect, 4) || inRect(lay.hRect, 4);
        const info = pressInfoRef.current;
        const onUI = !!info && performance.now() - info.t < 600 && !info.onBackdrop;
        if (onBox || onBar || onUI) return; // không khởi tạo chọn lại
      }
      prevSelRef.current = sel;
      prevPhaseRef.current = phase;
      startRef.current = [x, y];
      pressWinRef.current = hoverWin;
      setHoverWin(null);
      setSel({ x, y, w: 0, h: 0 });
      setPhase("selecting");
    },
    (x, y) => {
      const s = startRef.current;
      startRef.current = null;
      const hovered = pressWinRef.current;
      pressWinRef.current = null;
      if (!s) return; // không phải đang kéo chọn (vd: đang vẽ/di chuyển native)
      // Click nhanh (không kéo) trúng 1 cửa sổ đang hover → nạp thẳng khung =
      // đúng cửa sổ đó, y hệt vừa kéo-chọn xong — giống Snagit/`RegionSelect`.
      const dist = Math.hypot(x - s[0], y - s[1]);
      if (dist < 4 && hovered && pickWindow(winsRef.current, x, y)?.id === hovered.id) {
        setSel({ x: hovered.x, y: hovered.y, w: hovered.width, h: hovered.height });
        setPhase("adjusting");
        loadDoc({ image: transparentPng(1, 1), imgW: 1, imgH: 1, scaleFactor: SCALE, annotations: [] });
        getCurrentWindow().setFocus().catch(() => {});
        return;
      }
      const r = rectFrom(s[0], s[1], x, y);
      if (r.w >= MIN_SEL && r.h >= MIN_SEL) {
        setSel(r);
        setPhase("adjusting");
        // khung mới → xoá chú thích cũ (annCount về 0 → hiện lại handle resize)
        loadDoc({ image: transparentPng(1, 1), imgW: 1, imgH: 1, scaleFactor: SCALE, annotations: [] });
        // Đảm bảo overlay nhận phím tắt ngay sau khi thả chuột (không cần click toolbar).
        getCurrentWindow().setFocus().catch(() => {});
      } else {
        // kéo quá nhỏ → khôi phục khung + pha trước (nếu có), tránh mất chú thích
        setSel(prevSelRef.current);
        setPhase(prevSelRef.current ? (prevPhaseRef.current === "selecting" ? "adjusting" : prevPhaseRef.current) : "selecting");
      }
    },
  );

  // Màn hình KHÁC vừa được bấm → xoá khung ở màn này (chỉ một khung active).
  useEffect(() => {
    const un = listen<[number, number, number]>("overlay-press", (e) => {
      if (e.payload[0] !== MY_IDX) {
        startRef.current = null;
        setSel(null);
        setPhase("selecting");
      }
    });
    return () => { un.then((f) => f()); };
  }, []);

  // ── Pha "adjusting": di chuyển / resize khung bằng sự kiện native ──
  const moveRef = useRef<{ mx: number; my: number; start: Sel } | null>(null);
  const onMoveDown = (e: React.PointerEvent) => {
    if (phase !== "adjusting" || !sel) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    moveRef.current = { mx: e.clientX, my: e.clientY, start: sel };
  };
  const resizeRef = useRef<{ id: string; mx: number; my: number; start: Sel } | null>(null);
  const onResizeDown = (id: string) => (e: React.PointerEvent) => {
    if (!sel) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeRef.current = { id, mx: e.clientX, my: e.clientY, start: sel };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const m = moveRef.current;
    if (m) {
      const dx = e.clientX - m.mx;
      const dy = e.clientY - m.my;
      setSel({
        x: clampN(m.start.x + dx, 0, winW - m.start.w),
        y: clampN(m.start.y + dy, 0, winH - m.start.h),
        w: m.start.w,
        h: m.start.h,
      });
      return;
    }
    const r = resizeRef.current;
    if (r) {
      const dx = e.clientX - r.mx;
      const dy = e.clientY - r.my;
      let { x, y, w, h } = r.start;
      if (r.id.includes("w")) { const nx = clampN(x + dx, 0, x + w - MIN_SEL); w += x - nx; x = nx; }
      if (r.id.includes("e")) { w = clampN(w + dx, MIN_SEL, winW - x); }
      if (r.id.includes("n")) { const ny = clampN(y + dy, 0, y + h - MIN_SEL); h += y - ny; y = ny; }
      if (r.id.includes("s")) { h = clampN(h + dy, MIN_SEL, winH - y); }
      setSel({ x, y, w, h });
    }
  };
  const onPointerUp = () => {
    moveRef.current = null;
    resizeRef.current = null;
  };

  // ── Commit: nạp canvas trong suốt kích thước khung để bắt đầu chú thích ──
  const loadTransparent = useCallback((r: Sel) => {
    const pw = Math.max(1, Math.round(r.w * SCALE));
    const ph = Math.max(1, Math.round(r.h * SCALE));
    loadDoc({ image: transparentPng(pw, ph), imgW: pw, imgH: ph, scaleFactor: SCALE, annotations: [] });
  }, [loadDoc]);

  const pickTool = useCallback((t: Tool) => {
    if (phase === "annotating") { setTool(t); return; }
    if (!sel) return;
    loadTransparent(sel);
    setPhase("annotating");
    setTool(t);
  }, [phase, sel, setTool, loadTransparent]);
  const pickToolRef = useRef(pickTool);
  pickToolRef.current = pickTool;

  // ── Xuất ảnh: chụp đúng vùng (ẩn overlay) rồi ghép lớp chú thích ──
  const doExport = useCallback(async (): Promise<{ url: string; w: number; h: number } | null> => {
    if (!sel) return null;
    const layer = phase === "annotating" ? (stageRef.current?.exportPng() ?? null) : null;
    const b64 = await ipc.captureQuickRegion(sel.x, sel.y, sel.w, sel.h);
    const base = await loadImg(`data:image/png;base64,${b64}`);
    const c = document.createElement("canvas");
    c.width = base.naturalWidth;
    c.height = base.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(base, 0, 0);
    if (layer) {
      const l = await loadImg(layer);
      g.drawImage(l, 0, 0, c.width, c.height);
    }
    return { url: c.toDataURL("image/png"), w: c.width, h: c.height };
  }, [sel, phase]);

  const doCopy = async () => {
    setBusy(true);
    try { const r = await doExport(); if (r) await ipc.finishQuickCapture(r.url, r.w, r.h, "clipboard"); }
    finally { ipc.cancelOverlay(); }
  };
  const doSave = async () => {
    setBusy(true);
    try { const r = await doExport(); if (r) await ipc.finishQuickCapture(r.url, r.w, r.h, "save"); }
    finally { ipc.cancelOverlay(); }
  };
  const doOpenEditor = async () => {
    setBusy(true);
    try {
      const r = await doExport();
      if (r) {
        // Giữ SnapDoc frontmost để hiện Editor — huỷ việc `cancelOverlay`
        // (chạy trong finally) trả focus về app cũ (chỉ áp dụng cho
        // copy/save/hủy). Xem `flow::keep_capture_focus`.
        await ipc.keepCaptureFocus();
        await ipc.setPendingImage(r.url, r.w, r.h);
        await ipc.openEditor();
      }
    }
    finally { ipc.cancelOverlay(); }
  };
  // Đóng TẤT CẢ overlay (mọi màn hình) — không chỉ overlay hiện tại.
  const doClose = () => ipc.cancelOverlay();

  // ── Phím tắt: công cụ hoạt động ngay sau khi kéo khung (pha adjusting),
  // không cần click toolbar trước — pickTool tự chuyển sang annotating. ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const s = useEditor.getState();
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable || s.editingTextId) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") { e.preventDefault(); doClose(); return; }
      if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); doCopy(); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); doSave(); return; }
      if (phase === "selecting" || !sel) return;

      if (!mod) {
        const t = quickToolFromKey(e);
        if (t) {
          e.preventDefault();
          pickToolRef.current(t);
          return;
        }
      }

      if (phase !== "annotating") return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); s.undo(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedId) { e.preventDefault(); s.removeSelected(); return; }
      if (!mod) {
        const cmap: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5 };
        if (e.key in cmap) { const c = PRESET_COLORS[cmap[e.key]]; if (c) s.setColor(c); return; }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sel]);

  return (
    <div
      ref={rootRef}
      style={{
        ...root,
        // Ẩn cho đến khi frozen image load xong — tránh flash transparent.
        visibility: frozenReady ? "visible" : "hidden",
        ...(frozenUrl ? {
          backgroundImage: `url("${frozenUrl}")`,
          backgroundSize: "100% 100%",
          backgroundRepeat: "no-repeat",
        } : {}),
        cursor: phase === "selecting" ? CROSSHAIR_CURSOR : "default",
      }}
      onPointerDownCapture={onDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => { e.preventDefault(); if (!sel) doClose(); }}
    >
      {sel ? (
        <div
          style={{
            position: "fixed", left: sel.x, top: sel.y, width: sel.w, height: sel.h,
            ...antsBorder(2),
            // Dim phần ngoài; frozen image vẫn hiện rõ bên trong qua background root.
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            cursor: phase === "adjusting" ? "move" : "default",
          }}
          onPointerDown={onMoveDown}
        >
          {phase === "selecting" && sel.w > 0 && (
            <span style={sizeLabel}>{Math.round(sel.w)} × {Math.round(sel.h)}</span>
          )}
          {/* Resize handles — chỉ khi đang chỉnh khung & chưa vẽ gì */}
          {phase === "adjusting" && annCount === 0 && QUICK_HANDLES.map((hd) => (
            <div key={hd.id} onPointerDown={onResizeDown(hd.id)} style={quickHandleStyle(hd)} />
          ))}
        </div>
      ) : (
        <div
          style={{
            position: "fixed",
            inset: 0,
            // Màn hình đang có con trỏ: bỏ lớp phủ xám để nhìn rõ nội dung bên
            // dưới, giống `RegionSelect`. Các màn hình còn lại vẫn xám như cũ.
            background: cursorHere ? "transparent" : "rgba(0,0,0,0.45)",
          }}
        >
          <div style={banner}>{t("overlay.quickDragSelect")}</div>
        </div>
      )}
      {/* Gợi ý cửa sổ khi hover — chỉ trước khi có khung (`phase === "selecting"`),
          giống `RegionSelect`. */}
      {phase === "selecting" && !sel && hoverWin && (
        <div
          style={{
            position: "fixed",
            left: hoverWin.x,
            top: hoverWin.y,
            width: hoverWin.width,
            height: hoverWin.height,
            ...antsBorder(2.5),
            pointerEvents: "none",
          }}
        >
          <span style={sizeLabel}>
            {hoverWin.app || hoverWin.title || t("overlay.windowLabel")}
          </span>
        </div>
      )}
      {phase === "selecting" && !sel && (
        <RegionFullscreenButton
          onClick={() => {
            setSel({ x: 0, y: 0, w: winW, h: winH });
            setPhase("adjusting");
            loadDoc({ image: transparentPng(1, 1), imgW: 1, imgH: 1, scaleFactor: SCALE, annotations: [] });
            getCurrentWindow().setFocus().catch(() => {});
          }}
        />
      )}

      {/* Canvas chú thích phủ đúng khung (trong suốt → thấy frozen image bên dưới) */}
      {phase === "annotating" && sel && (
        <div
          style={{ position: "fixed", left: sel.x - STAGE_PAD, top: sel.y - STAGE_PAD, width: sel.w + STAGE_PAD * 2, height: sel.h + STAGE_PAD * 2 }}
        >
          <AnnotationStage ref={stageRef} hideZoomBar />
        </div>
      )}

      {sel && phase !== "selecting" && (
        <QuickToolbar
          sel={sel}
          winW={winW}
          winH={winH}
          annotating={phase === "annotating"}
          busy={busy}
          onPickTool={pickTool}
          onCopy={doCopy}
          onSave={doSave}
          onOpenEditor={doOpenEditor}
          onClose={doClose}
        />
      )}
      {/* Đường dóng ngang/dọc nét đứt theo con trỏ — chỉ khi đang định vị vùng
          chọn (`phase === "selecting"`), giống `RegionSelect`. */}
      {cursorPos && (
        <>
          <div
            style={{
              position: "fixed", left: 0, top: cursorPos[1], width: "100%", height: 0,
              borderTop: `1.5px dashed ${ANTS_COLOR}`, opacity: 0.85, pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "fixed", left: cursorPos[0], top: 0, width: 0, height: "100%",
              borderLeft: `1.5px dashed ${ANTS_COLOR}`, opacity: 0.85, pointerEvents: "none",
            }}
          />
        </>
      )}
    </div>
  );
}

const QUICK_HANDLES = [
  { id: "nw", cx: 0, cy: 0, cur: "nwse-resize" },
  { id: "n", cx: 0.5, cy: 0, cur: "ns-resize" },
  { id: "ne", cx: 1, cy: 0, cur: "nesw-resize" },
  { id: "e", cx: 1, cy: 0.5, cur: "ew-resize" },
  { id: "se", cx: 1, cy: 1, cur: "nwse-resize" },
  { id: "s", cx: 0.5, cy: 1, cur: "ns-resize" },
  { id: "sw", cx: 0, cy: 1, cur: "nesw-resize" },
  { id: "w", cx: 0, cy: 0.5, cur: "ew-resize" },
];
function quickHandleStyle(hd: { cx: number; cy: number; cur: string }): React.CSSProperties {
  const S = 10;
  return {
    position: "absolute",
    left: `calc(${hd.cx * 100}% - ${S / 2}px)`,
    top: `calc(${hd.cy * 100}% - ${S / 2}px)`,
    width: S, height: S, background: "#fff", border: `1.5px solid ${ANTS_COLOR}`, borderRadius: 2,
    cursor: hd.cur,
  };
}

/* ───────────── Monitor: chọn cả màn hình (chế độ full) ───────────── */

function MonitorPick() {
  const { t } = useTranslation();
  const { url: frozenUrl, ready: frozenReady } = useFrozenScreen();
  const [active, setActive] = useState(false);

  useInput(
    (a) => setActive(a),
    () => ipc.finalizeMonitor().catch((e) => alert(String(e))),
    () => {},
  );

  const rootStyle: React.CSSProperties = frozenUrl
    ? {
        ...root,
        visibility: frozenReady ? "visible" : "hidden",
        backgroundImage: `url("${frozenUrl}")`,
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
        cursor: CAMERA_CURSOR,
      }
    : {
        ...root,
        visibility: frozenReady ? "visible" : "hidden",
        cursor: CAMERA_CURSOR,
        background: active ? "rgba(245,158,11,0.12)" : "rgba(0,0,0,0.28)",
      };

  return (
    <div style={rootStyle}>
      {/* Dim layer khi có frozen image */}
      {frozenUrl && <div style={{ position: "fixed", inset: 0, background: active ? "rgba(245,158,11,0.12)" : "rgba(0,0,0,0.45)", pointerEvents: "none" }} />}
      {/* Viền cam "kiến bò" bao trọn màn hình khi đang hover — tách riêng
          khỏi `rootStyle` vì div gốc còn dùng `backgroundImage` cho ảnh
          màn hình đóng băng, không thể gộp chung với lớp gradient của
          `antsBorder`. */}
      {active && <div style={{ position: "fixed", inset: 0, pointerEvents: "none", ...antsBorder(5) }} />}
      <div style={banner}>{t("overlay.selectMonitor")}</div>
    </div>
  );
}

/* ───────────── styles ───────────── */

// Con trỏ hình máy ảnh (giống macOS). SVG trắng-viền-đen; hotspot giữa (16,16).
const CAMERA_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>
<rect x='3' y='9' width='26' height='18' rx='3' fill='#fff' stroke='#000' stroke-width='1.5'/>
<rect x='11' y='5.5' width='10' height='5' rx='1.5' fill='#fff' stroke='#000' stroke-width='1.5'/>
<circle cx='16' cy='18' r='6' fill='#fff' stroke='#000' stroke-width='1.5'/>
<circle cx='16' cy='18' r='3' fill='#000'/>
</svg>`;
const CAMERA_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(CAMERA_SVG)}") 16 16, crosshair`;

// Con trỏ chữ thập cho chế độ vẽ vùng. Trắng lõi + viền đen → rõ trên mọi nền;
// chừa khoảng hở giữa + chấm tâm để ngắm chính xác. Hotspot ở tâm (24,24).
// Kích thước tăng so với trước (32→48px, nét dày hơn) để dễ thấy hơn, giống
// yêu cầu đối chiếu với crosshair to của Snagit.
const CROSSHAIR_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'>
<g stroke='#000' stroke-width='5' stroke-linecap='round'>
<line x1='24' y1='2' x2='24' y2='18'/><line x1='24' y1='30' x2='24' y2='46'/>
<line x1='2' y1='24' x2='18' y2='24'/><line x1='30' y1='24' x2='46' y2='24'/></g>
<g stroke='#fff' stroke-width='2.5' stroke-linecap='round'>
<line x1='24' y1='2' x2='24' y2='18'/><line x1='24' y1='30' x2='24' y2='46'/>
<line x1='2' y1='24' x2='18' y2='24'/><line x1='30' y1='24' x2='46' y2='24'/></g>
<circle cx='24' cy='24' r='3' fill='#fff' stroke='#000' stroke-width='2'/>
</svg>`;
const CROSSHAIR_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(CROSSHAIR_SVG)}") 24 24, crosshair`;

// Viền "kiến bò" (marching ants) — thay cho mọi viền xanh liền nét trước đây,
// dùng chung 1 màu cam + 1 kích thước nét đứt cho toàn bộ chế độ chụp. Vẽ
// bằng 4 lớp linear-gradient (mỗi lớp 1 cạnh) thay vì `border`/`outline` vì
// CSS không animate được dash-offset của border thật — đây là kỹ thuật thuần
// CSS phổ biến để giả lập hiệu ứng này. `animation` tham chiếu keyframes toàn
// cục `marching-ants` (bơm 1 lần qua `<style>` ở `Overlay()`).
const ANTS_COLOR = "#f59e0b";
const ANTS_DASH = 10;
const ANTS_KEYFRAMES = `@keyframes marching-ants {
  to {
    background-position: left ${ANTS_DASH}px top, right -${ANTS_DASH}px bottom, left bottom ${ANTS_DASH}px, right top -${ANTS_DASH}px;
  }
}`;

function antsBorder(width = 2.5): React.CSSProperties {
  return {
    backgroundImage:
      `linear-gradient(90deg, ${ANTS_COLOR} 50%, transparent 50%),` +
      `linear-gradient(90deg, ${ANTS_COLOR} 50%, transparent 50%),` +
      `linear-gradient(0deg, ${ANTS_COLOR} 50%, transparent 50%),` +
      `linear-gradient(0deg, ${ANTS_COLOR} 50%, transparent 50%)`,
    backgroundRepeat: "repeat-x, repeat-x, repeat-y, repeat-y",
    backgroundSize: `${ANTS_DASH}px ${width}px, ${ANTS_DASH}px ${width}px, ${width}px ${ANTS_DASH}px, ${width}px ${ANTS_DASH}px`,
    backgroundPosition: "left top, right bottom, left bottom, right top",
    boxSizing: "border-box",
    animation: "marching-ants 0.5s infinite linear",
  };
}

const root: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  overflow: "hidden",
  background: "transparent",
};
const sizeLabel: React.CSSProperties = {
  position: "absolute",
  top: -24,
  left: 0,
  background: ANTS_COLOR,
  color: "#fff",
  fontSize: 12,
  padding: "2px 6px",
  borderRadius: 4,
  whiteSpace: "nowrap",
  maxWidth: 320,
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const banner: React.CSSProperties = {
  position: "fixed",
  top: 20,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(20,20,24,0.92)",
  color: "#fff",
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 13,
  pointerEvents: "none",
};
