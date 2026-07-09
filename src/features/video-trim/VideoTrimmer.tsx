import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import {
  type Segment,
  MIN_SEG_MS,
  initialSegments,
  totalTimelineMs,
  timelineMsToSource,
  sourceMsToTimeline,
  nearestValidSourceMs,
  segmentBoundariesMs,
  canSplitAt,
  splitSegmentAt,
  deleteSegment,
  canTrimHead,
  canTrimTail,
  trimHead,
  trimTail,
  computeKeepRanges,
} from "./segments";

export interface VideoTrimmerProps {
  src: string;
  /** Đường dẫn file thật trên đĩa (KHÔNG phải URL `convertFileSrc`) — dùng để
   * gọi `generate_video_frames` sinh filmstrip, xem `filePath` ở
   * `RecordReview.tsx`/`HistoryPreviewPanel.tsx`. */
  filePath: string;
  durationMs: number;
  busy?: boolean;
  /** Gọi khi bấm nút "Áp dụng cắt" TRONG toolbar — chỉ cần khi
   * `showApplyButton` (mặc định `true`), bỏ qua khi màn hình cha tự gộp nút
   * Áp dụng vào hành động của riêng nó (xem `showApplyButton`). */
  onApply?: (keepRangesMs: [number, number][]) => void;
  /** `false`: ẩn nút "Áp dụng cắt" khỏi toolbar — dùng khi màn hình cha (ví dụ
   * `RecordReview`) muốn GỘP hành động áp dụng cắt vào nút Lưu của riêng nó
   * (1 nút "Áp dụng cắt và lưu" duy nhất cho cả màn hình, thay vì 2 nút tách
   * biệt: áp dụng rồi mới lưu). Cha phải tự lắng `onStateChange` để biết lúc
   * nào có thay đổi cần áp dụng + đoạn giữ lại tương ứng, rồi tự gọi
   * `ipc.trimPendingRecording` khi cần. Mặc định `true` (giữ hành vi cũ). */
  showApplyButton?: boolean;
  /** Báo cho cha biết trạng thái chỉnh sửa hiện tại — chỉ hữu ích khi
   * `showApplyButton={false}` (xem trên); bỏ qua nếu cha không cần gộp nút. */
  onStateChange?: (state: { hasChanges: boolean; keepRanges: [number, number][] }) => void;
}

/** Chỉ giữ cạnh dài nhất chưa gộp, dùng lặp lại cho track/playhead math. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** `93500` → `"1:34"` — mm:ss (cùng định dạng `RecordReview.tsx`/`HistoryPreviewPanel.tsx`). */
function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** `timeupdate` không đảm bảo bắn đúng lúc chạm biên segment (phụ thuộc tần
 * suất trình duyệt bắn event) — coi như đã chạm biên nếu còn cách dưới mức
 * này, tránh phát lẹm/lặp vài chục ms ở mỗi điểm nối đoạn. */
const BOUNDARY_EPS_MS = 20;

const MIN_ZOOM = 1;
const MAX_ZOOM = 32;
const ZOOM_STEP = 1.5;
/** ~1 thumbnail mỗi 100px bề rộng khung nhìn — vừa đủ dày để trông như 1
 * filmstrip liên tục mà không cần quá nhiều lệnh ffmpeg mỗi lần fetch. */
const THUMB_TARGET_PX = 100;
const MIN_THUMBS_PER_SEG = 2;
const MAX_THUMBS = 60;
/** Đệm thêm 2 bên khung đang xem khi tính mốc cần fetch — đỡ giật/trắng khi
 * cuộn nhẹ (mốc đã fetch sẵn ngay ngoài rìa khung nhìn). */
const VISIBLE_PADDING_RATIO = 0.25;
/** Làm tròn mốc thời gian NGUỒN trước khi fetch/cache — giảm số lệnh ffmpeg
 * (nhiều điểm tính ra rất gần nhau khi zoom thấp/video dài) và cho phép tái
 * dùng cache giữa các lần cuộn/zoom/split/xoá/undo/redo (cache khoá theo mốc
 * NGUỒN nên không đổi bất kể segment nào chứa nó — xem `frames` bên dưới). */
const FRAME_ROUND_MS = 10;
const FETCH_DEBOUNCE_MS = 120;
/** Số mốc lấy đều trên toàn video, fetch 1 lần duy nhất lúc mount — CapCut và
 * các NLE khác luôn có sẵn 1 "lớp nền" thumbnail phủ toàn bộ clip trước khi
 * người dùng tương tác, để zoom/cuộn không bao giờ thấy ô trắng hoàn toàn:
 * ô trắng — không phải fetch chậm — mới là nguyên nhân chính gây cảm giác
 * "nháy" khi đổi zoom, vì mỗi mức zoom cần mật độ khác nên cache theo tile cũ
 * gần như luôn miss. Xem `nearestFrameUrl` — tile hiển thị frame GẦN NHẤT đã
 * có trong cache (kể cả từ lớp nền này) thay vì đợi đúng mốc rồi mới hiện. */
const BASE_FRAME_COUNT = 40;
/** Bề rộng đích (px) khi trích frame cho tile filmstrip — nhỏ, vì mỗi tile
 * trên timeline chỉ rộng ~100px (xem `THUMB_TARGET_PX`). */
const FILMSTRIP_SCALE_W = 160;
/** Chiều cao dải khung hình filmstrip — giữ NGUYÊN giá trị cũ (không đổi độ
 * phân giải/tỉ lệ hiện của frame), xem `track`/`filmstripLayer`. */
const FILMSTRIP_BAND_H = 64;
/** Chiều cao khối timeline — CAO HƠN dải khung hình (`FILMSTRIP_BAND_H`) để
 * `playhead` tràn ra lề trên/dưới dải frame, dễ thấy đang chạy tới đâu (trước
 * đây playhead cao bằng đúng dải frame nên bị "chìm" khi clip có màu trắng
 * trùng màu vạch). */
const TRACK_H = 104;
/** Bán kính bắt "hút" (snap) playhead/điểm chia vào ranh giới đoạn gần nhất
 * khi kéo/rê chuột trên timeline, tính bằng px màn hình (không đổi theo
 * zoom) — xem `snapTimelineMs`. */
const SNAP_PX = 8;
/** Debounce riêng cho fetch khung hình chính xác dưới con trỏ khi rê chuột
 * (hover-scrub) — tách khỏi `FETCH_DEBOUNCE_MS` (fetch cả loạt tile theo
 * khung nhìn) vì cần phản hồi nhanh hơn để preview theo kịp con trỏ. */
const HOVER_FETCH_DEBOUNCE_MS = 60;
/** Bề rộng đích (px) khi trích frame cho hover-scrub preview — LỚN HƠN
 * `FILMSTRIP_SCALE_W` nhiều (preview hiện to ~340px trên UI, xem
 * `hoverPreviewImgBox`) và fetch riêng cache (`hoverFrames`, không dùng
 * chung `frames` với filmstrip) — nếu dùng chung, 1 tile filmstrip đã cache
 * đúng mốc đó ở 160px sẽ "chặn" hover không bao giờ fetch lại bản nét hơn. */
const HOVER_PREVIEW_SCALE_W = 480;

/** Timeline cắt video dùng chung cho RecordReview (trước khi Lưu) và
 * HistoryPreviewPanel (video đã lưu) — mô hình "nhiều đoạn giữ lại" kiểu
 * CapCut: chia nhỏ / xoá đoạn đã chọn / cắt đầu-cuối theo playhead, có
 * undo/redo. Logic thuần (split/xoá/quy đổi toạ độ) nằm ở `./segments` để dễ
 * đọc/khoanh vùng lỗi — component này chỉ giữ state React + tương tác +
 * đồng bộ với `<video>`.
 *
 * 2 hệ toạ độ: "source ms" (mốc trong file gốc, dùng để điều khiển
 * `<video>`) và "timeline ms" (vị trí trên timeline ĐÃ GHÉP sau khi xoá đoạn
 * — 0..`totalTimelineMs(segments)`, dùng để vẽ UI/tính vị trí click). Xem
 * doc-comment đầu file `./segments`. */
export default function VideoTrimmer({
  src,
  filePath,
  durationMs,
  busy,
  onApply,
  showApplyButton = true,
  onStateChange,
}: VideoTrimmerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  /** Đảm bảo chỉ 1 lần gọi `generateVideoFrames` chạy đồng thời — nếu 1 lần
   * debounce khác "muốn" fetch trong lúc batch trước còn chạy, chỉ ghi đè
   * `pendingMissingRef` (thay batch mới nhất) thay vì bắn thêm request chồng
   * lên. Tránh trường hợp zoom/cuộn nhanh spawn hàng chục lệnh ffmpeg cùng
   * lúc — rủi ro nặng máy đã lường trước khi làm lại tính năng này. */
  const fetchInFlightRef = useRef(false);
  const pendingMissingRef = useRef<number[] | null>(null);
  /** Index segment đang chứa vị trí phát hiện tại — chỉ cập nhật trong hiệu
   * ứng đồng bộ video, KHÔNG dùng state để tránh re-render mỗi frame phát. */
  const currentSegIndexRef = useRef(0);

  // `segments`/`past`/`future`/`selectedSegmentId` gộp chung 1 state (thay vì
  // 4 `useState` riêng) — undo/redo/split/xoá đều là "state mới phụ thuộc cả
  // 4 giá trị cũ CÙNG LÚC". Tách riêng từng state rồi tự đọc nhau qua closure
  // sẽ sai khi 2 lần gọi dồn vào cùng 1 batch (double-click nhanh, giữ phím
  // Ctrl+Z lặp): cả 2 lần cùng thấy 1 giá trị closure cũ, ghi đè lẫn nhau
  // thay vì áp tuần tự — lỗi này đã tự bắt được khi test 2 cú redo liên tiếp.
  // Gộp vào 1 object + luôn dùng dạng updater `setEditState(st => ...)` thì
  // React đảm bảo áp lần lượt, mỗi lần tính trên đúng kết quả của lần trước.
  interface EditState {
    segments: Segment[];
    past: Segment[][];
    future: Segment[][];
    selectedSegmentId: string | null;
  }
  const makeInitialEditState = (): EditState => ({
    segments: initialSegments(durationMs),
    past: [],
    future: [],
    selectedSegmentId: null,
  });
  const [editState, setEditState] = useState<EditState>(makeInitialEditState);
  const { segments, past, future, selectedSegmentId } = editState;
  const [playheadMs, setPlayheadMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── Filmstrip zoom ──────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [frames, setFrames] = useState<Map<number, string>>(new Map());
  /** Vị trí đang rê chuột trên timeline (chưa click) — hiện preview lớn nổi
   * theo con trỏ, kiểu "hover-scrub" của CapCut. `clientX`/`trackTop` là toạ
   * độ viewport (dùng `position: fixed` để không bị `trackScroll` cắt mất do
   * `overflow` của nó), `srcMs` là mốc NGUỒN đã snap để tra frame + hiện thời
   * gian đúng với chỗ playhead sẽ đứng nếu click. `null` khi chuột rời khỏi
   * track và không đang kéo. */
  const [hoverInfo, setHoverInfo] = useState<{ clientX: number; trackTop: number; srcMs: number } | null>(null);
  /** Cache RIÊNG cho frame nét (`HOVER_PREVIEW_SCALE_W`) dùng cho hover-scrub
   * — tách khỏi `frames` (filmstrip, chỉ 160px) để hover không bao giờ bị
   * "kẹt" hiện bản mờ đã cache trùng mốc, xem hằng số `HOVER_PREVIEW_SCALE_W`. */
  const [hoverFrames, setHoverFrames] = useState<Map<number, string>>(new Map());
  const hoverFetchInFlightRef = useRef(false);
  /** Bản sao `zoom` cho các listener native (wheel/gesture) đăng ký 1 lần —
   * đọc qua ref để luôn thấy giá trị mới nhất mà không phải đăng ký lại
   * listener mỗi lần zoom đổi (pinch bắn hàng chục event/giây). */
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** scrollLeft cần đặt SAU khi track re-render với width mới (đặt ngay trong
   * handler thì DOM chưa layout lại, scrollLeft bị kẹp theo width cũ) — lưu
   * tạm ở đây, `useLayoutEffect([zoom])` bên dưới áp vào trước khi paint. */
  const pendingScrollRef = useRef<number | null>(null);

  /** Zoom giữ nguyên điểm timeline đang nằm dưới `clientX` (neo theo con trỏ/
   * tâm pinch — kỳ vọng tự nhiên của thao tác 2 ngón, thay vì zoom xong điểm
   * đang nhìn trôi đi mất). Dùng chung cho pinch, Ctrl+lăn chuột và nút +/−. */
  const zoomAtPoint = (clientX: number, newZoomRaw: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const oldZoom = zoomRef.current;
    const newZoom = clamp(newZoomRaw, MIN_ZOOM, MAX_ZOOM);
    if (newZoom === oldZoom) return;
    const rect = el.getBoundingClientRect();
    const offsetInView = clamp(clientX - rect.left, 0, rect.width);
    // Vị trí tuyệt đối (px nội dung) đang nằm dưới con trỏ → giữ nguyên tỉ lệ
    // sau khi đổi width, trừ ngược lại ra scrollLeft mới.
    const contentX = el.scrollLeft + offsetInView;
    pendingScrollRef.current = contentX * (newZoom / oldZoom) - offsetInView;
    setZoom(newZoom);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScrollRef.current != null) {
      el.scrollLeft = Math.max(0, pendingScrollRef.current);
      pendingScrollRef.current = null;
      // Đồng bộ state với giá trị THẬT sau khi trình duyệt kẹp vào biên cuộn.
      setScrollLeft(el.scrollLeft);
    }
  }, [zoom]);

  // Pinch 2 ngón để zoom timeline. 2 cơ chế tuỳ engine:
  // - WKWebView (macOS): pinch bắn gesture events phi chuẩn
  //   (`gesturestart/gesturechange/gestureend`, `e.scale` = tỉ lệ tích luỹ
  //   từ lúc bắt đầu pinch).
  // - Chromium/WebView2 (Windows): pinch được dịch thành `wheel` +
  //   `ctrlKey=true` — nhánh này đồng thời cho luôn Ctrl+lăn chuột để zoom.
  // Cả 2 cần `preventDefault` để chặn zoom cả trang, mà React 17+ gắn
  // wheel/touch listener dạng passive (preventDefault vô hiệu) → phải đăng
  // ký native listener với `{passive: false}` thay vì prop `onWheel`.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // lăn/vuốt ngang thường: để scroll mặc định
      e.preventDefault();
      // deltaY của pinch nhỏ và liên tục — exp() cho cảm giác mượt, đối xứng
      // 2 chiều (phóng/thu cùng tốc độ).
      zoomAtPoint(e.clientX, zoomRef.current * Math.exp(-e.deltaY * 0.01));
    };

    let gestureStartZoom = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStartZoom = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale?: number; clientX?: number };
      if (typeof ge.scale !== "number") return;
      const anchorX = typeof ge.clientX === "number"
        ? ge.clientX
        : el.getBoundingClientRect().left + el.clientWidth / 2;
      zoomAtPoint(anchorX, gestureStartZoom * ge.scale);
    };
    const onGestureEnd = (e: Event) => e.preventDefault();

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    el.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);

  // Đồng bộ `<video>` với `segments` mỗi khi đổi (split/xoá/undo/redo) HOẶC
  // lúc mount: nếu vị trí đang đứng rơi vào 1 đoạn vừa bị xoá thì snap về mốc
  // hợp lệ gần nhất; đồng thời đăng ký lại listener `timeupdate` để closure
  // luôn thấy `segments` mới nhất (chi phí đăng ký lại rất rẻ, chỉ chạy khi
  // user chỉnh sửa chứ không phải mỗi frame).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const srcMs = v.currentTime * 1000;
    let idx = segments.findIndex((s) => srcMs >= s.srcStart && srcMs <= s.srcEnd);
    if (idx < 0) {
      const snapped = nearestValidSourceMs(segments, srcMs);
      v.currentTime = snapped / 1000;
      idx = Math.max(0, segments.findIndex((s) => snapped >= s.srcStart && snapped <= s.srcEnd));
    }
    currentSegIndexRef.current = idx;
    setPlayheadMs(sourceMsToTimeline(segments, v.currentTime * 1000) ?? 0);

    const onTime = () => {
      const seg = segments[currentSegIndexRef.current];
      if (seg && v.currentTime * 1000 >= seg.srcEnd - BOUNDARY_EPS_MS) {
        const next = segments[currentSegIndexRef.current + 1];
        if (next) {
          currentSegIndexRef.current += 1;
          v.currentTime = next.srcStart / 1000;
        } else {
          v.pause();
        }
      }
      setPlayheadMs(sourceMsToTimeline(segments, v.currentTime * 1000) ?? 0);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [segments]);

  // Phím tắt Undo/Redo/Xoá — không dep array (chạy lại mỗi render) để closure
  // luôn thấy `segments`/`past`/`future`/`selectedSegmentId` mới nhất, tránh
  // lớp bug "stale closure" hay gặp với listener gắn 1 lần trên window.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedSegmentId) {
        e.preventDefault();
        doDeleteSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setContainerWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Danh sách tile filmstrip cần hiển thị/fetch cho khung đang xem — tính
  // theo timeline-ms (zoom/cuộn) rồi quy đổi phần giao với TỪNG segment sang
  // source-ms qua `srcStart` (segment chưa từng bị chia cắt nội bộ nên map
  // tuyến tính là đủ). CHỈ phụ thuộc zoom/cuộn/kích thước khung/segments —
  // KHÔNG phụ thuộc `playheadMs` (đổi liên tục lúc phát) nên giữ nguyên tham
  // chiếu giữa các lần render do phát video gây ra, tránh debounce fetch bên
  // dưới không bao giờ "lắng" được.
  const visibleTiles = useMemo(() => {
    const trackWidthPx = containerWidth * zoom;
    const total = totalTimelineMs(segments);
    if (containerWidth <= 0 || trackWidthPx <= 0 || total <= 0) {
      return [] as { key: string; srcMs: number; leftPct: number; widthPct: number }[];
    }
    const visStart = (scrollLeft / trackWidthPx) * total;
    const visEnd = ((scrollLeft + containerWidth) / trackWidthPx) * total;
    const pad = (visEnd - visStart) * VISIBLE_PADDING_RATIO;
    const winStart = clamp(visStart - pad, 0, total);
    const winEnd = clamp(visEnd + pad, 0, total);

    const tiles: { key: string; srcMs: number; leftPct: number; widthPct: number }[] = [];
    let acc = 0;
    for (const seg of segments) {
      const segTlStart = acc;
      acc += seg.srcEnd - seg.srcStart;
      const segTlEnd = acc;

      const iStart = Math.max(segTlStart, winStart);
      const iEnd = Math.min(segTlEnd, winEnd);
      if (iEnd <= iStart) continue;

      const iPx = ((iEnd - iStart) / total) * trackWidthPx;
      const count = clamp(Math.ceil(iPx / THUMB_TARGET_PX), MIN_THUMBS_PER_SEG, MAX_THUMBS);
      for (let i = 0; i < count; i++) {
        const tlMs = count === 1 ? iStart : iStart + ((iEnd - iStart) * i) / (count - 1);
        const rightMs = i < count - 1 ? iStart + ((iEnd - iStart) * (i + 1)) / (count - 1) : iEnd;
        const srcMs = seg.srcStart + (tlMs - segTlStart);
        tiles.push({
          key: `${seg.id}-${i}`,
          srcMs: Math.round(srcMs / FRAME_ROUND_MS) * FRAME_ROUND_MS,
          leftPct: (tlMs / total) * 100,
          widthPct: Math.max(0, ((rightMs - tlMs) / total) * 100),
        });
      }
    }
    return tiles;
  }, [segments, containerWidth, zoom, scrollLeft]);

  const runFetch = (missing: number[]) => {
    if (fetchInFlightRef.current) {
      // Gộp thêm vào batch đang chờ (không ghi đè) — batch nền toàn video
      // (mount) và batch theo khung nhìn (zoom/cuộn) có thể cùng muốn chạy
      // trong lúc 1 batch khác đang bay; ghi đè sẽ làm rơi mất 1 trong 2.
      const merged = new Set(pendingMissingRef.current ?? []);
      missing.forEach((ms) => merged.add(ms));
      pendingMissingRef.current = Array.from(merged);
      return;
    }
    fetchInFlightRef.current = true;
    ipc.generateVideoFrames(filePath, missing, FILMSTRIP_SCALE_W)
      .then((urls) => {
        setFrames((prev) => {
          // QUAN TRỌNG: chỉ tạo Map mới (đổi tham chiếu) khi thực sự thêm được
          // gì — nếu 1 mốc trích lỗi vĩnh viễn (ví dụ đúng ranh giới vừa
          // split/cuối video) mà vẫn trả `prev` nguyên tham chiếu ở đây, mốc đó
          // vẫn nằm trong `missing` mỗi lần tính lại NHƯNG effect fetch (dep
          // `frames`) không bị coi là "đổi" nên không tự lặp lại vô hạn. Thiếu
          // guard này từng gây lặp gọi `generateVideoFrames` liên tục mỗi ~200ms
          // cho đúng 1 mốc lỗi (đã tái hiện: 12 lần gọi/5s cho mốc không bao
          // giờ thành công) — đúng nguyên nhân chữ "Đang tải khung hình" nháy
          // liên tục và tile ở đúng mốc đó vĩnh viễn không hiện ảnh.
          let changed = false;
          const next = new Map(prev);
          missing.forEach((ms, i) => {
            const url = urls[i];
            if (url) {
              next.set(ms, url);
              changed = true;
            }
          });
          return changed ? next : prev;
        });
      })
      .catch(() => {})
      .finally(() => {
        fetchInFlightRef.current = false;
        const queued = pendingMissingRef.current;
        pendingMissingRef.current = null;
        if (queued && queued.length > 0) runFetch(queued);
      });
  };

  // Lớp nền: fetch 1 lần duy nhất ~BASE_FRAME_COUNT mốc rải đều toàn video
  // ngay khi có `filePath`/`durationMs` — không phụ thuộc zoom/cuộn, không
  // debounce (chỉ chạy 1 lần nên không có gì để dồn). Nhờ `nearestFrameUrl`
  // dùng khi render, những mốc này đóng vai trò "phao cứu sinh" cho MỌI tile
  // ở MỌI mức zoom trong lúc chờ đúng mốc chính xác — xem const
  // `BASE_FRAME_COUNT`.
  useEffect(() => {
    if (!filePath || durationMs <= 0) return;
    const step = durationMs / (BASE_FRAME_COUNT - 1);
    const base = Array.from({ length: BASE_FRAME_COUNT }, (_, i) =>
      Math.round((i * step) / FRAME_ROUND_MS) * FRAME_ROUND_MS,
    );
    const missing = Array.from(new Set(base)).filter((ms) => !frames.has(ms));
    if (missing.length > 0) runFetch(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, durationMs]);

  // Fetch (debounce) đúng các mốc còn thiếu trong cache — merge kết quả trả
  // về dù có đến trễ (frame ở 1 mốc source-ms luôn đúng bất kể fetch lúc
  // nào, không cần huỷ/bỏ qua kết quả trễ như 1 request thông thường).
  useEffect(() => {
    if (!filePath || visibleTiles.length === 0) return;
    const missing = Array.from(new Set(visibleTiles.map((t) => t.srcMs))).filter((ms) => !frames.has(ms));
    if (missing.length === 0) return;
    const timer = setTimeout(() => runFetch(missing), FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filePath, visibleTiles, frames]);

  // Fetch riêng đúng mốc đang rê chuột (hover-scrub), ở độ phân giải CAO
  // (`HOVER_PREVIEW_SCALE_W`) — cache riêng `hoverFrames`, KHÔNG dùng chung
  // `frames`/`runFetch` của filmstrip (xem giải thích ở khai báo `hoverFrames`
  // — dùng chung sẽ bị mốc filmstrip 160px đã cache "chặn" không cho fetch
  // lại bản nét hơn). Guard đơn giản bằng 1 ref (không cần hàng đợi kiểu
  // `pendingMissingRef` của filmstrip): tần suất thấp do debounce + luôn có
  // ảnh tạm từ `nearestFrameUrl` trong lúc chờ, bỏ lỡ 1 lần hoạ hoằn khi rê
  // rất nhanh sẽ tự fetch lại ở lần dừng chuột kế tiếp.
  useEffect(() => {
    if (!filePath || hoverInfo == null) return;
    const target = Math.round(hoverInfo.srcMs / FRAME_ROUND_MS) * FRAME_ROUND_MS;
    if (hoverFrames.has(target) || hoverFetchInFlightRef.current) return;
    const timer = setTimeout(() => {
      hoverFetchInFlightRef.current = true;
      ipc.generateVideoFrames(filePath, [target], HOVER_PREVIEW_SCALE_W)
        .then((urls) => {
          const url = urls[0];
          if (!url) return;
          setHoverFrames((prev) => {
            const next = new Map(prev);
            next.set(target, url);
            return next;
          });
        })
        .catch(() => {})
        .finally(() => {
          hoverFetchInFlightRef.current = false;
        });
    }, HOVER_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, hoverInfo?.srcMs, hoverFrames]);

  // Mốc đã cache, sắp theo thứ tự tăng — dùng để binary-search "mốc gần
  // nhất" cho `nearestFrameUrl`. Tính lại mỗi khi `frames` đổi (thêm frame
  // mới), rẻ vì chỉ có vài chục–vài trăm mốc.
  const sortedCachedMs = useMemo(() => {
    const arr = Array.from(frames.keys());
    arr.sort((a, b) => a - b);
    return arr;
  }, [frames]);

  /** Trả URL của frame đã cache GẦN mốc `srcMs` nhất (không cần khớp tuyệt
   * đối) — đây là điểm mấu chốt để zoom/cuộn mượt kiểu CapCut: tile LUÔN có
   * gì đó để hiện (kể cả frame từ lớp nền `BASE_FRAME_COUNT` hoặc từ mức zoom
   * trước), thay vì hiện ô trắng rồi "nháy" lên khi đúng mốc mới fetch xong.
   * Frame gần đúng hiện tạm trong lúc chờ mốc chính xác tới, sau đó tự thay
   * thế êm vì cùng 1 `<img>` chỉ đổi `src`. */
  const nearestFrameUrl = (srcMs: number): string | undefined => {
    const arr = sortedCachedMs;
    if (arr.length === 0) return undefined;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < srcMs) lo = mid + 1;
      else hi = mid;
    }
    let best = arr[lo];
    if (lo > 0 && Math.abs(arr[lo - 1] - srcMs) < Math.abs(best - srcMs)) {
      best = arr[lo - 1];
    }
    return frames.get(best);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement === wrapRef.current) {
      void document.exitFullscreen();
    } else {
      void wrapRef.current?.requestFullscreen();
    }
  };

  /** Nút +/− neo tại TÂM khung nhìn — cùng hành vi giữ-điểm-đang-nhìn như
   * pinch (`zoomAtPoint`), thay vì zoom từ mép trái rồi để nội dung trôi. */
  const zoomByButton = (factor: number) => {
    const el = scrollRef.current;
    const centerX = el ? el.getBoundingClientRect().left + el.clientWidth / 2 : 0;
    zoomAtPoint(centerX, zoomRef.current * factor);
  };
  const zoomIn = () => zoomByButton(ZOOM_STEP);
  const zoomOut = () => zoomByButton(1 / ZOOM_STEP);
  const zoomReset = () => {
    setZoom(1);
    setScrollLeft(0);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const seekTo = (timelineMs: number) => {
    const v = videoRef.current;
    const pos = timelineMsToSource(segments, timelineMs);
    if (!v || !pos) return;
    v.currentTime = pos.srcMs / 1000;
    currentSegIndexRef.current = pos.segIndex;
    setPlayheadMs(clamp(timelineMs, 0, totalTimelineMs(segments)));
  };

  const segmentAtTimelineMs = (segs: Segment[], timelineMs: number): Segment | null => {
    const pos = timelineMsToSource(segs, timelineMs);
    return pos ? segs[pos.segIndex] : null;
  };

  const posToTimelineMs = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    const total = totalTimelineMs(segments);
    if (!rect || rect.width === 0) return 0;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * total;
  };

  /** Hút `ms` vào ranh giới đoạn gần nhất (đầu/cuối timeline hoặc điểm nối 2
   * đoạn) nếu trong bán kính `SNAP_PX` — giúp kéo/chia trúng đúng ranh giới
   * đã có mà không cần zoom cực sâu để nhắm bằng tay. Bán kính tính theo px
   * MÀN HÌNH nên quy đổi qua bề rộng track thực tế (`containerWidth * zoom`)
   * để không đổi cảm giác bắt dính giữa các mức zoom khác nhau. */
  const snapTimelineMs = (ms: number): number => {
    const trackWidthPx = containerWidth * zoom;
    const total = totalTimelineMs(segments);
    if (trackWidthPx <= 0 || total <= 0) return ms;
    const tolMs = (SNAP_PX / trackWidthPx) * total;
    let best = ms;
    let bestDist = tolMs;
    for (const b of segmentBoundariesMs(segments)) {
      const d = Math.abs(b - ms);
      if (d <= bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  };

  const onTrackDown = (e: React.PointerEvent) => {
    trackRef.current?.setPointerCapture?.(e.pointerId);
    videoRef.current?.pause();
    draggingRef.current = true;
    const ms = snapTimelineMs(posToTimelineMs(e.clientX));
    seekTo(ms);
    setEditState((st) => ({ ...st, selectedSegmentId: segmentAtTimelineMs(st.segments, ms)?.id ?? null }));
  };

  /** Dùng chung cho cả kéo-scrub (playhead) VÀ hover-scrub (preview nổi chưa
   * click) — luôn cập nhật `hoverInfo` để hiện preview, CHỈ seek/chọn đoạn
   * khi đang kéo (`draggingRef`). */
  const onTrackMove = (e: React.PointerEvent) => {
    const rect = trackRef.current?.getBoundingClientRect();
    const ms = snapTimelineMs(posToTimelineMs(e.clientX));
    const pos = timelineMsToSource(segments, ms);
    setHoverInfo({ clientX: e.clientX, trackTop: rect?.top ?? 0, srcMs: pos?.srcMs ?? 0 });
    if (!draggingRef.current) return;
    seekTo(ms);
    setEditState((st) => ({ ...st, selectedSegmentId: segmentAtTimelineMs(st.segments, ms)?.id ?? null }));
  };

  const onTrackLeave = () => {
    if (!draggingRef.current) setHoverInfo(null);
  };

  const onTrackUp = () => {
    draggingRef.current = false;
  };

  /** Áp thao tác chỉnh sửa: tính `segments` mới + đẩy trạng thái cũ vào
   * lịch sử undo, TẤT CẢ trong 1 lần `setEditState` để atomic (xem giải
   * thích ở khai báo `EditState`). Bỏ qua (không đẩy lịch sử) nếu `compute`
   * trả về nguyên `segments` cũ (thao tác bị chặn, ví dụ split quá sát biên,
   * hoặc xoá 1 id đã stale — do đó double-click/double-tap phím tắt luôn an
   * toàn, lần gọi thừa chỉ ra no-op chứ không lặp/sai thao tác). `selectAfter`
   * (tuỳ chọn) tính `selectedSegmentId` mới từ `next` — dùng cho `doSplit`
   * cần tự chọn lại đúng đoạn mới sau khi chia (đoạn cũ đổi id). */
  const applyEdit = (
    compute: (s: Segment[]) => Segment[],
    selectAfter?: (next: Segment[]) => string | null,
  ) => {
    setEditState((st) => {
      const next = compute(st.segments);
      if (next === st.segments) return st;
      return {
        segments: next,
        past: [...st.past, st.segments],
        future: [],
        selectedSegmentId: selectAfter ? selectAfter(next) : null,
      };
    });
  };

  const doSplit = () =>
    applyEdit(
      (s) => splitSegmentAt(s, playheadMs),
      (next) => {
        const pos = timelineMsToSource(next, playheadMs);
        return pos ? next[pos.segIndex].id : null;
      },
    );

  // KHÔNG dùng `applyEdit` (helper chỉ nhận `segments`) — thao tác này còn
  // phụ thuộc `selectedSegmentId`, cũng là 1 field của `editState`, nên phải
  // đọc từ `st` (đảm bảo mới nhất tại đúng thời điểm áp dụng) thay vì closure
  // ngoài. Đọc `selectedSegmentId` ngoài closure ở đây từng gây bug: gọi
  // ngay sau `doSplit` trong cùng 1 tick (chưa kịp re-render) sẽ thấy giá trị
  // cũ (chưa chọn gì) và chặn nhầm thao tác xoá.
  const doDeleteSelected = () => {
    setEditState((st) => {
      if (!st.selectedSegmentId || st.segments.length <= 1) return st;
      const next = deleteSegment(st.segments, st.selectedSegmentId);
      if (next === st.segments) return st;
      return { segments: next, past: [...st.past, st.segments], future: [], selectedSegmentId: null };
    });
  };

  const doTrimHead = () => applyEdit((s) => trimHead(s, playheadMs));
  const doTrimTail = () => applyEdit((s) => trimTail(s, playheadMs));

  const undo = () => {
    setEditState((st) => {
      if (st.past.length === 0) return st;
      const prev = st.past[st.past.length - 1];
      return {
        segments: prev,
        past: st.past.slice(0, -1),
        future: [st.segments, ...st.future],
        selectedSegmentId: null,
      };
    });
  };

  const redo = () => {
    setEditState((st) => {
      if (st.future.length === 0) return st;
      const next = st.future[0];
      return {
        segments: next,
        past: [...st.past, st.segments],
        future: st.future.slice(1),
        selectedSegmentId: null,
      };
    });
  };

  const doReset = () => setEditState(makeInitialEditState());

  const total = totalTimelineMs(segments);
  // useMemo (không tính thẳng mỗi render như trước) — tham chiếu ổn định
  // giữa các lần render KHÔNG đổi `segments` (phát video/hover-scrub/zoom đổi
  // liên tục) để effect báo `onStateChange` bên dưới không bắn dồn dập.
  const keepRanges = useMemo(() => computeKeepRanges(segments), [segments]);
  const hasChanges = past.length > 0;
  const canApply = hasChanges && total >= MIN_SEG_MS && !busy;

  // Báo cho cha biết trạng thái chỉnh sửa — chỉ cha nào cần gộp nút Áp dụng
  // vào hành động riêng mới lắng (xem `showApplyButton`); vô hại nếu không ai
  // lắng (`onStateChange` optional).
  useEffect(() => {
    onStateChange?.({ hasChanges, keepRanges });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChanges, keepRanges]);

  const pct = (ms: number) => (total <= 0 ? 0 : (clamp(ms, 0, total) / total) * 100);

  let acc = 0;
  const laidOut = segments.map((seg) => {
    const lenMs = seg.srcEnd - seg.srcStart;
    const startMs = acc;
    acc += lenMs;
    return { seg, startMs, lenMs };
  });

  return (
    <div ref={wrapRef} style={{ ...wrap, ...(isFullscreen ? fullscreenWrap : null) }}>
      <div style={videoWrap}>
        <video ref={videoRef} key={src} src={src} style={videoStyle} autoPlay />
      </div>

      <div style={playbackRow}>
        <button style={playBtn} onClick={togglePlay} title={isPlaying ? "Tạm dừng" : "Phát"}>
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <span style={timeText}>{fmtDuration(playheadMs)} / {fmtDuration(total)}</span>
        <div style={toolsGroup}>
          <button style={toolBtn} onClick={zoomOut} disabled={zoom <= MIN_ZOOM} title="Thu nhỏ timeline">−</button>
          <button style={toolBtn} onClick={zoomReset} title="Đặt lại zoom 100%">{Math.round(zoom * 100)}%</button>
          <button style={toolBtn} onClick={zoomIn} disabled={zoom >= MAX_ZOOM} title="Phóng to timeline (xem từng khung hình)">+</button>
          <button style={toolBtn} onClick={toggleFullscreen} title={isFullscreen ? "Thoát toàn màn hình" : "Phóng to toàn màn hình"}>
            {isFullscreen ? "⤡" : "⤢"}
          </button>
        </div>
      </div>

      <div style={editToolbar}>
        <button style={iconToolBtn} disabled={past.length === 0} onClick={undo} title="Hoàn tác (Ctrl+Z)">↶</button>
        <button style={iconToolBtn} disabled={future.length === 0} onClick={redo} title="Làm lại (Ctrl+Shift+Z)">↷</button>
        <div style={toolDivider} />
        <button style={iconToolBtn} disabled={!canSplitAt(segments, playheadMs)} onClick={doSplit} title="Chia đoạn tại vị trí đang dừng">
          <ScissorsIcon />
        </button>
        <button style={iconToolBtn} disabled={!selectedSegmentId || segments.length <= 1} onClick={doDeleteSelected} title="Xoá đoạn đang chọn (Delete)">
          <TrashIcon />
        </button>
        <button style={iconToolBtn} disabled={!canTrimHead(segments, playheadMs)} onClick={doTrimHead} title="Cắt từ đầu tới vị trí đang dừng">
          <span style={bracketGlyph}>[</span>
        </button>
        <button style={iconToolBtn} disabled={!canTrimTail(segments, playheadMs)} onClick={doTrimTail} title="Cắt từ vị trí đang dừng tới cuối">
          <span style={bracketGlyph}>]</span>
        </button>
        {/* Đặt lại: đặt NGAY CẠNH nhóm icon cắt (chia/xoá/cắt đầu-cuối) —
            đây là hành động "bỏ hết" cho đúng nhóm công cụ này, đứng liền kề
            dễ liên tưởng hơn là gộp chung với Áp dụng cắt ở xa bên phải như
            bản cũ. */}
        <button style={resetBtn} disabled={!hasChanges || busy} onClick={doReset} title="Bỏ hết thay đổi, về lại video gốc">
          Đặt lại
        </button>
        {/* Áp dụng cắt: chỉ hiện khi `showApplyButton` (mặc định true) — màn
            hình cha muốn gộp hành động này vào nút Lưu của riêng nó (xem
            `RecordReview.tsx`) sẽ tự ẩn nút này và tự xử lý qua
            `onStateChange`. */}
        {showApplyButton && (
          <div style={trimCommitGroup}>
            <button style={applyBtn} disabled={!canApply} onClick={() => onApply?.(keepRanges)}>
              {busy ? "Đang cắt…" : "Áp dụng cắt"}
            </button>
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        style={trackScroll}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div
          ref={trackRef}
          style={{ ...track, width: `${zoom * 100}%`, touchAction: "none" }}
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerLeave={onTrackLeave}
        >
          {/* Filmstrip — frame thật lấy theo khung đang xem/mức zoom, xem
              `visibleTiles`/`runFetch` ở trên. Nằm dưới các lớp segment/playhead
              (thứ tự DOM = thứ tự layer), `pointerEvents:none` để không chặn
              kéo/bấm trên track. */}
          <div style={filmstripLayer}>
            {visibleTiles.map(({ key, srcMs, leftPct, widthPct }) => {
              const url = nearestFrameUrl(srcMs);
              return (
                <div key={key} style={{ ...filmstripTile, left: `${leftPct}%`, width: `${widthPct}%` }}>
                  {url ? (
                    <img src={url} style={filmstripImg} draggable={false} alt="" />
                  ) : (
                    // Chưa có frame nào cho mốc này (kể cả từ lớp nền
                    // `BASE_FRAME_COUNT`) — thường chỉ xảy ra rất ngắn lúc mới
                    // mount. Shimmer NGAY TRÊN tile (kiểu YouTube/CapCut) thay
                    // chữ "Đang tải khung hình…" ở góc — dễ nhận ra hơn vì
                    // đúng ngay chỗ người dùng đang nhìn.
                    <div className="filmstrip-shimmer" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Từng đoạn giữ lại — ghép liền nhau, đoạn đã xoá đóng khoảng trống
              (khác bản cũ làm mờ tại chỗ). Thuần hiển thị (pointerEvents:none),
              mọi tương tác xử lý ở track cha. */}
          {laidOut.map(({ seg, startMs, lenMs }, i) => (
            <div
              key={seg.id}
              style={{
                ...segmentBlock,
                left: `${pct(startMs)}%`,
                width: `${pct(startMs + lenMs) - pct(startMs)}%`,
                ...(seg.id === selectedSegmentId ? segmentSelected : null),
                ...(i < laidOut.length - 1 ? { borderRight: "1px solid rgba(0,0,0,0.5)" } : null),
              }}
            />
          ))}

          {/* Vạch phát hiện tại. */}
          <div style={{ ...playhead, left: `${pct(playheadMs)}%` }} />
        </div>
      </div>

      {/* Chỉ còn thông tin thuần (không có nút) — xem `trimCommitGroup` ở
          hàng editToolbar phía trên, đã gộp Đặt lại/Áp dụng cắt lên đó. */}
      <div style={infoRow}>
        Giữ lại: {fmtDuration(total)} / {fmtDuration(durationMs)}
        {segments.length > 1 && ` · ${segments.length} đoạn`}
      </div>

      {/* Preview lớn nổi theo con trỏ khi rê chuột (chưa click) qua timeline —
          kiểu "hover-scrub" của CapCut, giúp tìm điểm cắt mà không cần
          thử-sai bằng playhead. `position:fixed` theo toạ độ viewport
          (`clientX`/`trackTop` lấy lúc di chuột) để không bị `trackScroll`
          cắt mất do nó cuộn ngang + `overflowY:hidden`. */}
      {hoverInfo && (
        <div style={{ ...hoverPreview, left: hoverInfo.clientX, top: hoverInfo.trackTop }}>
          <div style={hoverPreviewImgBox}>
            {(() => {
              const target = Math.round(hoverInfo.srcMs / FRAME_ROUND_MS) * FRAME_ROUND_MS;
              // Ưu tiên bản NÉT (`hoverFrames`, đúng mốc) — trong lúc chờ fetch
              // xong, tạm hiện bản filmstrip GẦN NHẤT (mờ hơn nhưng có ngay,
              // không để trống) rồi tự thay khi bản nét tới.
              const url = hoverFrames.get(target) ?? nearestFrameUrl(target);
              return url ? <img src={url} style={hoverPreviewImg} draggable={false} alt="" /> : null;
            })()}
          </div>
          <span style={hoverPreviewTime}>{fmtDuration(hoverInfo.srcMs)}</span>
        </div>
      )}
    </div>
  );
}

function ScissorsIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <line x1="8.2" y1="7.6" x2="20" y2="19" />
      <line x1="8.2" y1="16.4" x2="20" y2="5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="7" x2="20" y2="7" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7L7.5 20h9l1-13" />
      <line x1="10" y1="10.5" x2="10.5" y2="17" />
      <line x1="14" y1="10.5" x2="13.5" y2="17" />
    </svg>
  );
}

const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 };

/** Merge thêm vào `wrap` khi `document.fullscreenElement === wrapRef.current`
 * — UA stylesheet mặc định của `:fullscreen` co giãn element theo viewport
 * nhưng không tự đặt nền, cần nền đen để tránh hở khoảng trống. */
const fullscreenWrap: React.CSSProperties = { background: "#000", padding: 16, boxSizing: "border-box" };

const videoWrap: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  background: "#000",
  borderRadius: 8,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const videoStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain" };

const playbackRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexShrink: 0,
};

const playBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  flexShrink: 0,
  borderRadius: "50%",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text)",
  fontSize: 11,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

const timeText: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
  fontVariantNumeric: "tabular-nums",
};

const toolsGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginLeft: "auto",
};

const editToolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  flexWrap: "wrap",
};

/** Đẩy Đặt lại/Áp dụng cắt sát phải trong `editToolbar` — cùng kỹ thuật
 * `marginLeft:auto` như `toolsGroup` ở `playbackRow`. */
const trimCommitGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginLeft: "auto",
};

const toolDivider: React.CSSProperties = {
  width: 1,
  height: 18,
  background: "var(--border)",
  margin: "0 2px",
};

const toolBtn: React.CSSProperties = {
  height: 26,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text)",
  fontSize: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

/** Nút icon vuông (undo/redo/chia/xoá/cắt đầu-cuối) — cùng chất liệu với
 * `toolBtn` nhưng vuông + không padding ngang, vì nội dung giờ là icon/glyph
 * cố định thay vì text dài ngắn khác nhau. */
const iconToolBtn: React.CSSProperties = {
  ...toolBtn,
  width: 30,
  padding: 0,
};

const bracketGlyph: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  lineHeight: 1,
};

/** Preview hover-scrub — `position:fixed` theo toạ độ viewport, neo tại
 * (`left`,`top`) rồi tự đẩy lên trên + căn giữa theo con trỏ bằng
 * `transform` (tránh phải tính trước `clientX - popupWidth/2`). */
const hoverPreview: React.CSSProperties = {
  position: "fixed",
  transform: "translate(-50%, calc(-100% - 14px))",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  pointerEvents: "none",
  zIndex: 50,
};

const hoverPreviewImgBox: React.CSSProperties = {
  width: 340,
  height: 200,
  background: "#000",
  borderRadius: 10,
  overflow: "hidden",
  border: "2px solid rgba(255,255,255,0.35)",
  boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
};

const hoverPreviewImg: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
};

const hoverPreviewTime: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  color: "#fff",
  background: "rgba(0,0,0,0.75)",
  padding: "3px 10px",
  borderRadius: 6,
};

/** Container cuộn ngang chứa `track` — `track` giãn rộng theo `zoom` (xem
 * JSX, `width: zoom*100%`), container này clip + cho cuộn phần bị tràn. */
const trackScroll: React.CSSProperties = {
  position: "relative",
  overflowX: "auto",
  overflowY: "hidden",
  borderRadius: 8,
  flexShrink: 0,
};

/** Lớp filmstrip nằm dưới cùng trong `track` — `pointerEvents:none` để không
 * chặn kéo/bấm (segment/playhead vẫn xử lý pointer riêng ở track cha).
 * Chỉ cao `FILMSTRIP_BAND_H` (giữ đúng chiều cao frame cũ), CANH GIỮA trong
 * `track` (nay cao hơn, xem `track`) — phần lề trên/dưới còn lại là để
 * `playhead` tràn ra ngoài dải khung hình, dễ nhìn thấy đang chạy tới đâu. */
const filmstripLayer: React.CSSProperties = {
  position: "absolute",
  top: (TRACK_H - FILMSTRIP_BAND_H) / 2,
  height: FILMSTRIP_BAND_H,
  left: 0,
  right: 0,
  overflow: "hidden",
  borderRadius: 8,
  pointerEvents: "none",
};

const filmstripTile: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  overflow: "hidden",
  background: "rgba(255,255,255,0.04)",
};

const filmstripImg: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const track: React.CSSProperties = {
  position: "relative",
  // Cao hơn dải khung hình thật (`FILMSTRIP_BAND_H`, xem `filmstripLayer`) —
  // phần lề trên/dưới dư ra là để `playhead` tràn ra ngoài, xem `TRACK_H`.
  height: TRACK_H,
  borderRadius: 8,
  background: "rgba(255,255,255,0.08)",
  cursor: "pointer",
  userSelect: "none",
};

const segmentBlock: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "rgba(255,255,255,0.08)",
  borderRadius: 4,
  boxSizing: "border-box",
  pointerEvents: "none",
};

const segmentSelected: React.CSSProperties = {
  outline: "2px solid var(--accent)",
  outlineOffset: -2,
  background: "rgba(255,255,255,0.16)",
};

// Đỏ cam (thay vì trắng cũ) — clip quay màn hình rất hay có nền trắng, vạch
// trắng lúc đó gần như biến mất vào nền. Kèm viền đen mỏng (`boxShadow`) để
// vẫn nổi rõ cả trên clip sáng màu. `top:0, bottom:0` = tràn hết chiều cao
// TĂNG THÊM của `track` (xem `TRACK_H`) — nhô ra khỏi dải khung hình
// (`FILMSTRIP_BAND_H`, thấp hơn) ở cả trên và dưới.
const playhead: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 2,
  background: "#ff5252",
  boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
  borderRadius: 1,
  pointerEvents: "none",
  zIndex: 5,
};

// Chỉ còn text info (không nút, xem `trimCommitGroup`) — dim, nhỏ, đúng mức
// "phụ" của 1 dòng chú thích.
const infoRow: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
  flexShrink: 0,
};

// Cao 26px khớp `iconToolBtn` cùng hàng — to hơn bản cũ (padding "6px 10px",
// font 12px) để không bị lép vế cạnh các icon, đúng mức 1 nút hành động thật
// thay vì trông như phụ chú.
const resetBtn: React.CSSProperties = {
  height: 26,
  padding: "0 12px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 13,
};

const applyBtn: React.CSSProperties = {
  height: 26,
  padding: "0 16px",
  borderRadius: 7,
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontWeight: 600,
  fontSize: 13,
};
