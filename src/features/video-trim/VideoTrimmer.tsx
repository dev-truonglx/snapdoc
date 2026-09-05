import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";
import GifExportModal from "./GifExportModal";
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
import { type VideoOverlayItem, renderOverlayToDataUrl, drawOverlaysOnCanvas } from "./types";
import VideoCanvasOverlay, { type VideoOverlayTool } from "./VideoCanvasOverlay";
import OverlayTimelineTrack from "./OverlayTimelineTrack";
import { getVideoSession, saveVideoSession, dropVideoSession } from "./videoSessions";

export interface VideoTrimmerProps {
  src: string;
  /** Đường dẫn file thật trên đĩa (KHÔNG phải URL `convertFileSrc`) — dùng để
   * gọi `generate_video_frames` sinh filmstrip. */
  filePath: string;
  durationMs: number;
  busy?: boolean;
  /** "Lưu đè" — ghi đè vĩnh viễn video gốc bằng đoạn đang giữ lại. Đặt ngay
   * trong `editToolbar` (cạnh các nút chỉnh sửa: chia/xoá/cắt đầu-cuối…) thay
   * vì ở Toolbar trên cùng của Editor — 2 nút Lưu tách biệt hẳn (không phải
   * kiểu split-button Save/▾ như ảnh) vì đây là 2 hành động khác nhau rõ rệt
   * (ghi đè vĩnh viễn vs giữ nguyên bản gốc), đặt cạnh nhau ngay chỗ đang thao
   * tác cắt để không phải nhìn lên toolbar xa. */
  onSave: () => void;
  /** "Lưu thành video mới" — áp dụng đoạn đang giữ lại (hoặc y nguyên nếu
   * chưa cắt gì) thành 1 record MỚI, giữ nguyên bản gốc. `pickLocation = true`
   * (từ dropdown "▾" cạnh nút) → mở dialog Save As để chọn thư mục + sửa tên
   * file thay vì auto lưu vào `saveDir` với tên mặc định. */
  onSaveAs: (pickLocation?: boolean) => void;
  /** Báo cho cha (Editor.tsx) biết trạng thái chỉnh sửa hiện tại (có thay
   * đổi/đoạn giữ lại/đã tách nhạc nền) — dùng để hiện toast/điều hướng khác,
   * KHÔNG dùng để tính disabled cho `onSave` (VideoTrimmer tự tính `canSave`
   * nội bộ, xem khai báo `canSave`). */
  onStateChange?: (state: {
    hasChanges: boolean;
    keepRanges: [number, number][];
    removeAudio: boolean;
    overlays: VideoOverlayItem[];
  }) => void;
  /** "open-editor" (mặc định): sau khi chụp frame, ingest xong rồi mở/focus
   * cửa sổ Editor riêng — dùng khi VideoTrimmer đang chạy trong 1 cửa sổ KHÁC
   * Editor. "in-place": chỉ ingest (ảnh vào History ngay), KHÔNG gọi
   * `openEditor` — dùng khi VideoTrimmer đang render ngay trong chính Editor
   * (chế độ video), tránh tự trigger "refresh-capture" khiến Editor nạp lại
   * pending ảnh và mất video đang xem (xem `Editor.tsx`). */
  frameCaptureMode?: "open-editor" | "in-place";
  sourceHistoryId?: string;
  onFlash?: (msg: string) => void;
}


/** Chỉ giữ cạnh dài nhất chưa gộp, dùng lặp lại cho track/playhead math. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** `93500` → `"1:34"` — mm:ss (cùng định dạng `HistoryPreviewPanel.tsx`). */
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
/** Chiều cao dải khung hình filmstrip — giảm cùng tỉ lệ với `TRACK_H` (xem
 * bên dưới) để timeline gọn hơn, xem `track`/`filmstripLayer`. */
const FILMSTRIP_BAND_H = 44;
/** Chiều cao khối timeline — CAO HƠN dải khung hình (`FILMSTRIP_BAND_H`) để
 * `playhead` tràn ra lề trên/dưới dải frame, dễ thấy đang chạy tới đâu (trước
 * đây playhead cao bằng đúng dải frame nên bị "chìm" khi clip có màu trắng
 * trùng màu vạch). Chênh lệch với `FILMSTRIP_BAND_H` (padding cho playhead
 * tràn ra, mỗi bên = (TRACK_H - FILMSTRIP_BAND_H)/2) CỐ Ý giữ đủ lớn (16px,
 * 8px mỗi bên) dù đã giảm tổng chiều cao — hụt xuống quá thấp (như lần thử
 * 72/64 trước, chỉ 4px mỗi bên) khiến phần playhead tràn ra gần như không
 * nhìn thấy được. */
const TRACK_H = 60;
/** Khoảng cách nhỏ chèn giữa 2 đoạn giữ lại liền nhau (mỗi bên inset
 * `SEGMENT_GAP_PX / 2`) — để lộ nền track ở giữa, giúp ranh giới điểm cắt rõ
 * ràng hơn là chỉ dựa vào `borderRight` khi 2 khối chạm sát nhau. */
const SEGMENT_GAP_PX = 4;
/** Chiều cao dải thước thời gian (ruler) phía trên track — hiện mốc giờ:phút
 * dọc theo timeline, mật độ tự đổi theo zoom (xem `NICE_TICK_INTERVALS_MS`). */
const RULER_H = 22;
/** Các bước nhảy thời gian "đẹp" cho mốc trên ruler — chọn bước NHỎ NHẤT
 * trong danh sách vẫn cho khoảng cách giữa 2 mốc ≥ `MIN_TICK_PX` ở mức zoom
 * hiện tại, để mật độ mốc luôn dễ đọc: zoom thấp (video dài hiện gọn) → bước
 * lớn (phút), zoom cao (xem từng giây) → bước nhỏ (giây). */
const NICE_TICK_INTERVALS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
];
/** Khoảng cách tối thiểu (px) giữa 2 mốc ruler — đủ chỗ cho nhãn "12:34". */
const MIN_TICK_PX = 70;
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

/** Trần số frame giữ trong cache filmstrip/hover — 2 Map này trước đây CHỈ
 * `set`, không bao giờ evict: tua/zoom qua lại 1 video dài trong phiên trim
 * kéo dài tích luỹ data-URL không giới hạn (hover 480px có thể ~50-100KB/
 * frame). Khi vượt trần, xoá mốc CŨ NHẤT theo thứ tự insert của Map — mốc bị
 * xoá nếu cần lại sẽ tự được fetch lại qua cơ chế "missing" sẵn có. */
const FRAMES_CACHE_MAX = 1000;
const HOVER_CACHE_MAX = 100;

function capFrameCache(m: Map<number, string>, max: number): Map<number, string> {
  if (m.size <= max) return m;
  const keys = m.keys();
  while (m.size > max) {
    const k = keys.next();
    if (k.done) break;
    m.delete(k.value);
  }
  return m;
}

/** Timeline cắt video dùng trong Editor (chế độ video) và
 * HistoryPreviewPanel (preview nhỏ trong Library) — mô hình "nhiều đoạn giữ lại" kiểu
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
  onSave,
  onSaveAs,
  onStateChange,
  frameCaptureMode = "open-editor",
  sourceHistoryId,
  onFlash,
}: VideoTrimmerProps) {
  const { t } = useTranslation();
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
  /** 1 mốc lịch sử undo/redo — gộp CẢ `segments` LẪN `removeAudio` (không chỉ
   * riêng `segments` như trước khi thêm nút "Tách nhạc nền") để Ctrl+Z hoàn
   * tác đúng bất kể lần sửa gần nhất là cắt đoạn hay bật/tắt xoá âm thanh. */
  interface HistorySnapshot {
    segments: Segment[];
    removeAudio: boolean;
    overlays: VideoOverlayItem[];
  }
  interface EditState {
    segments: Segment[];
    removeAudio: boolean;
    overlays: VideoOverlayItem[];
    past: HistorySnapshot[];
    future: HistorySnapshot[];
    selectedSegmentId: string | null;
    selectedOverlayId: string | null;
  }

  const sessionKey = sourceHistoryId
    ? `history:${sourceHistoryId}`
    : filePath
    ? `file:${filePath}`
    : null;

  const savedSession = useMemo(() => {
    return sessionKey ? getVideoSession(sessionKey, durationMs) : null;
  }, [sessionKey, durationMs]);

  const makeInitialEditState = (): EditState => {
    if (savedSession) {
      return {
        segments: savedSession.segments,
        removeAudio: savedSession.removeAudio,
        overlays: savedSession.overlays,
        past: savedSession.past,
        future: savedSession.future,
        selectedSegmentId: savedSession.selectedSegmentId,
        selectedOverlayId: savedSession.selectedOverlayId,
      };
    }
    return {
      segments: initialSegments(durationMs),
      removeAudio: false,
      overlays: [],
      past: [],
      future: [],
      selectedSegmentId: null,
      selectedOverlayId: null,
    };
  };
  const [editState, setEditState] = useState<EditState>(makeInitialEditState);
  const { segments, removeAudio, overlays, past, future, selectedSegmentId, selectedOverlayId } = editState;
  const [overlayTool, setOverlayTool] = useState<VideoOverlayTool>("select");
  const [gifModalOpen, setGifModalOpen] = useState(false);
  const selectedSegment = useMemo(
    () => segments.find((s) => s.id === selectedSegmentId) ?? null,
    [segments, selectedSegmentId],
  );
  // Popover "Chọn nơi lưu…" gắn cạnh nút "Lưu thành video mới" (split button)
  // — đóng khi click ra ngoài, cùng cơ chế popover "Save As…" ở `Toolbar.tsx`.
  const [showSaveAsMenu, setShowSaveAsMenu] = useState(false);

  const saveAsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSaveAsMenu) return;
    const onClickOutside = (e: MouseEvent) => {
      if (saveAsMenuRef.current && !saveAsMenuRef.current.contains(e.target as Node)) {
        setShowSaveAsMenu(false);
      }
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [showSaveAsMenu]);
  const [playheadMs, setPlayheadMs] = useState(() => savedSession?.playheadMs ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  /** Thanh trượt âm lượng chỉ hiện khi hover vào cụm icon loa (kiểu
   * YouTube/CapCut) — ẩn mặc định để hàng playbackRow gọn. `volumeDragging`
   * giữ thanh mở khi đang kéo dù chuột đã rời khỏi cụm icon/thanh (ví dụ kéo
   * ra ngoài rồi thả), tránh thanh biến mất giữa chừng lúc đang thao tác. */
  const [volumeHover, setVolumeHover] = useState(false);
  const [volumeDragging, setVolumeDragging] = useState(false);
  const volumeGroupRef = useRef<HTMLDivElement>(null);
  /** Toạ độ viewport (không phải toạ độ trong `videoWrap`) để đặt popover âm
   * lượng qua `position: fixed` — bắt buộc vì icon loa giờ nằm TRONG
   * `videoWrap` (`overflow: hidden`, xem `playbackOverlay`); neo bằng
   * `position: absolute` như trước sẽ bị cắt mất phần popover tràn ra ngoài.
   * Đo lại mỗi lần hover vào (icon không di chuyển trong lúc popover mở nên
   * không cần đo lại liên tục). */
  const [volumeAnchor, setVolumeAnchor] = useState<{ left: number; top: number } | null>(null);
  /** Hover trên `videoWrap` — quyết định hiện/ẩn play/âm lượng/thời gian
   * (`overlayCenterGroup`); nhóm zoom/fullscreen (`toolsGroup`) KHÔNG theo cờ
   * này, luôn hiện vì dùng thường xuyên lúc chỉnh sửa. Giữ hiện thêm khi đang
   * kéo thanh âm lượng (`volumeDragging`) — tránh thanh trượt biến mất giữa
   * chừng nếu chuột lỡ rê ra khỏi `videoWrap` trong lúc kéo. */
  const [wrapHover, setWrapHover] = useState(false);
  const showCenterControls = wrapHover || volumeDragging;
  const volumeTrackRef = useRef<HTMLDivElement>(null);
  /** Cờ "đang giữ chuột" đọc qua ref (không phải state) trong
   * `onVolumeTrackMove` — tránh stale closure/re-render mỗi lần kéo, cùng
   * pattern `draggingRef` của timeline scrubber bên dưới. */
  const volumeDraggingActiveRef = useRef(false);

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

  const isInitialMountRef = useRef(true);

  // Đồng bộ `<video>` với `segments` mỗi khi đổi (split/xoá/undo/redo) HOẶC
  // lúc mount: nếu vị trí đang đứng rơi vào 1 đoạn vừa bị xoá thì snap về mốc
  // hợp lệ gần nhất; đồng thời đăng ký lại listener `timeupdate` để closure
  // luôn thấy `segments` mới nhất (chi phí đăng ký lại rất rẻ, chỉ chạy khi
  // user chỉnh sửa chứ không phải mỗi frame).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      const targetMs = savedSession?.playheadMs ?? 0;
      if (targetMs > 0) {
        const pos = timelineMsToSource(segments, targetMs);
        if (pos) {
          v.currentTime = pos.srcMs / 1000;
          currentSegIndexRef.current = pos.segIndex;
          setPlayheadMs(targetMs);
        }
      } else {
        setPlayheadMs(sourceMsToTimeline(segments, v.currentTime * 1000) ?? 0);
      }
    } else {
      const srcMs = v.currentTime * 1000;
      let idx = segments.findIndex((s) => srcMs >= s.srcStart && srcMs <= s.srcEnd);
      if (idx < 0) {
        const snapped = nearestValidSourceMs(segments, srcMs);
        v.currentTime = snapped / 1000;
        idx = Math.max(0, segments.findIndex((s) => snapped >= s.srcStart && snapped <= s.srcEnd));
      }
      currentSegIndexRef.current = idx;
      setPlayheadMs(sourceMsToTimeline(segments, v.currentTime * 1000) ?? 0);
    }

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
    const onEnded = () => {
      setIsPlaying(false);
      setPlayheadMs(totalTimelineMs(segments));
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, [segments]);

  // Tự động cuộn timeline theo playhead khi đang phát video (zoom > 1)
  // để vạch phát luôn nằm trong khung nhìn (kiểu CapCut/Premiere).
  useEffect(() => {
    if (!isPlaying || zoom <= 1 || containerWidth <= 0 || draggingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;

    const total = totalTimelineMs(segments);
    if (total <= 0) return;

    const trackWidthPx = containerWidth * zoom;
    const playheadX = (playheadMs / total) * trackWidthPx;
    const currentScroll = el.scrollLeft;

    // Vạch phát vượt quá 85% khung nhìn hiện tại -> cuộn tiếp để playhead ở ~15% lề trái
    if (playheadX > currentScroll + containerWidth * 0.85) {
      const targetScroll = Math.max(0, playheadX - containerWidth * 0.15);
      el.scrollLeft = targetScroll;
      setScrollLeft(el.scrollLeft);
    } else if (playheadX < currentScroll) {
      // Vạch phát ở phía trước khung nhìn (ví dụ vừa tua lại / lặp lại) -> cuộn về
      const targetScroll = Math.max(0, playheadX - containerWidth * 0.15);
      el.scrollLeft = targetScroll;
      setScrollLeft(el.scrollLeft);
    }
  }, [playheadMs, isPlaying, zoom, containerWidth, segments]);

  // Phím tắt Undo/Redo/Xoá/Chia/Cắt đầu-cuối — handler ghi vào ref MỖI render
  // (luôn thấy `segments`/`past`/`future`/`selectedSegmentId` mới nhất, không
  // stale closure) nhưng listener trên window chỉ đăng ký ĐÚNG 1 LẦN qua
  // effect `[]` bên dưới — bản cũ dùng effect không dep array nên add/remove
  // listener lại mỗi render, mà component re-render theo từng `timeupdate`
  // lúc phát + từng mousemove lúc hover-scrub (hàng chục lần/giây). Cùng
  // pattern `zoomRef` phía trên. Q/W không có modifier (giống quy ước hotkey
  // dựng phim) nên chỉ nhận khi KHÔNG bấm cùng Ctrl/Cmd/Shift/Alt — tránh đè
  // lên tổ hợp hệ thống (ví dụ Cmd+Q thoát app).
  const onKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyDownRef.current = (e: KeyboardEvent) => {
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
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (canSplitAt(segments, playheadMs)) doSplit();
      } else if (!mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        if (canTrimHead(segments, playheadMs)) doTrimHead();
      } else if (!mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (canTrimTail(segments, playheadMs)) doTrimTail();
      } else if (!mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        setOverlayTool((cur) => (cur === "rect" ? "select" : "rect"));
      } else if (!mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setOverlayTool((cur) => (cur === "blur" ? "select" : "blur"));
      } else if (!mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setOverlayTool((cur) => (cur === "text" ? "select" : "text"));
      } else if (!mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setOverlayTool((cur) => (cur === "arrow" ? "select" : "arrow"));
      } else if (e.key === "Escape") {
        setOverlayTool("select");
        setEditState((st) => ({ ...st, selectedOverlayId: null }));
      } else if (!mod && !e.shiftKey && !e.altKey && e.code === "Space") {
        // preventDefault: chặn hành vi mặc định (cuộn trang / bấm lại nút
        // đang focus bằng bàn phím) khi Space dùng để play/pause thay vào đó.
        e.preventDefault();
        togglePlay();
      }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyDownRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // Đồng bộ volume/muted với `<video>` — chạy cả lúc mount VÀ mỗi khi đổi
  // `src` (video element bị remount do `key={src}`, xem JSX) để không bị mất
  // âm lượng người dùng đã chọn khi chuyển sang xem 1 video khác.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = isMuted;
  }, [volume, isMuted, src]);

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

  // Mốc thời gian trên ruler — bước nhảy tự đổi theo zoom (xem
  // `NICE_TICK_INTERVALS_MS`/`MIN_TICK_PX`) để không bao giờ dày đặc/rối mắt
  // hay quá thưa. KHÔNG phụ thuộc `scrollLeft` (khác `visibleTiles`) — chỉ
  // ~vài chục mốc cho toàn timeline nên render hết luôn, không cần cửa sổ nhìn.
  const timeTicks = useMemo(() => {
    const trackWidthPx = containerWidth * zoom;
    const total = totalTimelineMs(segments);
    if (trackWidthPx <= 0 || total <= 0) return [] as { ms: number; leftPct: number }[];

    let intervalMs = NICE_TICK_INTERVALS_MS[NICE_TICK_INTERVALS_MS.length - 1];
    for (const candidate of NICE_TICK_INTERVALS_MS) {
      if ((candidate / total) * trackWidthPx >= MIN_TICK_PX) {
        intervalMs = candidate;
        break;
      }
    }
    const ticks: { ms: number; leftPct: number }[] = [];
    for (let t = 0; t <= total; t += intervalMs) {
      ticks.push({ ms: t, leftPct: (t / total) * 100 });
    }
    return ticks;
  }, [segments, containerWidth, zoom]);

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
          return changed ? capFrameCache(next, FRAMES_CACHE_MAX) : prev;
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
            return capFrameCache(next, HOVER_CACHE_MAX);
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
    if (v.paused) {
      const total = totalTimelineMs(segments);
      const isAtEnd =
        v.ended ||
        (segments.length > 0 &&
          (v.currentTime * 1000 >= segments[segments.length - 1].srcEnd - BOUNDARY_EPS_MS ||
            playheadMs >= total - BOUNDARY_EPS_MS));
      if (isAtEnd && segments.length > 0) {
        currentSegIndexRef.current = 0;
        v.currentTime = segments[0].srcStart / 1000;
        setPlayheadMs(0);
        if (scrollRef.current) {
          scrollRef.current.scrollLeft = 0;
          setScrollLeft(0);
        }
      }
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  /** Chụp khung hình hiện tại của video thành ảnh PNG — dùng canvas để lấy
   * đúng frame đang hiển thị (không round-trip qua ffmpeg như filmstrip), rồi
   * ingest qua `setPendingImage`. Bước tiếp theo tuỳ `frameCaptureMode` — xem
   * doc-comment của prop này ở `VideoTrimmerProps`. */
  const [capturingFrame, setCapturingFrame] = useState(false);
  const doCaptureFrame = async () => {
    const v = videoRef.current;
    if (!v || capturingFrame) return;
    setCapturingFrame(true);
    try {
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return;

      let dataUrl: string | null = null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(v, 0, 0, w, h);
          // Vẽ tất cả text, khung, che mờ, mũi tên đang hiển thị lên khung hình
          drawOverlaysOnCanvas(ctx, canvas, overlays, playheadMs, selectedOverlayId, w, h);
          dataUrl = canvas.toDataURL("image/png");
        }
      } catch (err) {
        console.warn("[SnapDoc] Canvas capture failed (tainted canvas or context error), attempting fallback:", err);
      }

      // Fallback: nếu canvas bị tainted (thường gặp trên Windows khi thiếu CORS) hoặc lỗi toDataURL,
      // dùng ffmpeg qua backend để trích đúng frame tại currentTime
      if (!dataUrl && filePath) {
        const curMs = Math.round(v.currentTime * 1000);
        const frames = await ipc.generateVideoFrames(filePath, [curMs], w);
        if (frames && frames[0]) {
          const fallbackCanvas = document.createElement("canvas");
          fallbackCanvas.width = w;
          fallbackCanvas.height = h;
          const fallbackCtx = fallbackCanvas.getContext("2d");
          if (fallbackCtx) {
            const img = new Image();
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject();
              img.src = frames[0]!;
            });
            fallbackCtx.drawImage(img, 0, 0, w, h);
            drawOverlaysOnCanvas(fallbackCtx, fallbackCanvas, overlays, playheadMs, selectedOverlayId, w, h);
            dataUrl = fallbackCanvas.toDataURL("image/png");
          }
        }
      }

      if (!dataUrl) {
        console.error("[SnapDoc] Không thể chụp khung hình hiện tại của video");
        return;
      }

      // `setPendingImage` tự ingest vào History (emit "history:item-added" khi
      // ghi asset xong) — luôn gọi dù ở chế độ nào, chỉ khác ở bước sau.
      await ipc.setPendingImage(dataUrl, w, h);
      if (frameCaptureMode !== "in-place") {
        await ipc.keepCaptureFocus().catch(() => {});
        await ipc.openEditor();
      }
    } catch (err) {
      console.error("[SnapDoc] Lỗi khi trích xuất khung hình video:", err);
    } finally {
      setCapturingFrame(false);
    }
  };

  const toggleMute = () => setIsMuted((m) => !m);

  /** Đặt `volume` theo vị trí X con trỏ trên track ngang (`volumeTrackRef`) —
   * TRÁI = 0, PHẢI = 1. Tự bỏ mute khi kéo lên khỏi 0 (giống hành vi player
   * thường gặp), tránh kẹt tưởng thanh không phản hồi. */
  const applyVolumeFromClientX = (clientX: number) => {
    const rect = volumeTrackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    setVolume(ratio);
    if (ratio > 0 && isMuted) setIsMuted(false);
  };

  /** Track âm lượng tự vẽ (div + tính vị trí bằng tay) THAY VÌ
   * `<input type="range">` — đã thử input xoay dọc bằng cả
   * `-webkit-appearance: slider-vertical` lẫn CSS transform, cả 2 đều kéo
   * KHÔNG ĂN khi popover đè lên vùng `<video>` phía dưới (test trực tiếp:
   * cùng thao tác hoạt động bình thường khi đặt độc lập ở chỗ khác trên
   * trang) — nghi WebView giành lấy sự kiện con trỏ theo lớp video tăng tốc
   * phần cứng bất kể phần tử nào che nó. Dùng chính cơ chế
   * `setPointerCapture` + tính toạ độ bằng tay đã hoạt động ổn định cho
   * playhead ở timeline (`onTrackDown`/`onTrackMove` bên dưới) để chắc chắn
   * kéo được xuyên suốt, không phụ thuộc hành vi kéo mặc định của input gốc
   * hay việc popover đè lên vùng nào. */
  const onVolumeTrackDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    volumeDraggingActiveRef.current = true;
    setVolumeDragging(true);
    applyVolumeFromClientX(e.clientX);
  };
  const onVolumeTrackMove = (e: React.PointerEvent) => {
    if (!volumeDraggingActiveRef.current) return;
    applyVolumeFromClientX(e.clientX);
  };
  const onVolumeTrackUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    volumeDraggingActiveRef.current = false;
    setVolumeDragging(false);
  };

  // Lưới an toàn: nếu vì lý do gì đó `pointerup` không tới được chính track
  // (ví dụ thả chuột đúng lúc track vừa unmount) thì vẫn tự tắt cờ kéo qua
  // listener trên `window` — tránh kẹt `volumeDraggingActiveRef` ở `true`
  // mãi, khiến những lần rê chuột sau (dù không hề bấm) vẫn bị hiểu nhầm là
  // đang kéo.
  useEffect(() => {
    if (!volumeDragging) return;
    const onUp = () => {
      volumeDraggingActiveRef.current = false;
      setVolumeDragging(false);
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [volumeDragging]);

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
        ...st,
        segments: next,
        past: [...st.past, { segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }],
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
      return {
        ...st,
        segments: next,
        past: [...st.past, { segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }],
        future: [],
        selectedSegmentId: null,
      };
    });
  };

  const doTrimHead = () => applyEdit((s) => trimHead(s, playheadMs));
  const doTrimTail = () => applyEdit((s) => trimTail(s, playheadMs));

  /** Bật/tắt "Tách nhạc nền" (xoá hẳn track âm thanh khỏi file khi Áp dụng
   * cắt) — đẩy vào CHUNG lịch sử undo/redo với các thao tác cắt đoạn, nên
   * Ctrl+Z hoàn tác đúng bất kể đây là thao tác gần nhất hay không. */
  const doToggleRemoveAudio = () => {
    setEditState((st) => ({
      ...st,
      removeAudio: !st.removeAudio,
      past: [...st.past, { segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }],
      future: [],
    }));
  };

  const handleAddOverlay = (item: VideoOverlayItem) => {
    setEditState((st) => ({
      ...st,
      overlays: [...st.overlays, item],
      past: [...st.past, { segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }],
      future: [],
      selectedOverlayId: item.id,
    }));
  };

  const handleChangeOverlay = (item: VideoOverlayItem) => {
    setEditState((st) => ({
      ...st,
      overlays: st.overlays.map((o) => (o.id === item.id ? item : o)),
    }));
  };

  const handleDeleteOverlay = (id: string) => {
    setEditState((st) => ({
      ...st,
      overlays: st.overlays.filter((o) => o.id !== id),
      past: [...st.past, { segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }],
      future: [],
      selectedOverlayId: null,
    }));
  };

  const handleCommitOverlaySnapshot = () => {
    setEditState((st) => ({
      ...st,
      past: [...st.past, { segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }],
      future: [],
    }));
  };

  const undo = () => {
    setEditState((st) => {
      if (st.past.length === 0) return st;
      const prev = st.past[st.past.length - 1];
      return {
        ...st,
        segments: prev.segments,
        removeAudio: prev.removeAudio,
        overlays: prev.overlays,
        past: st.past.slice(0, -1),
        future: [{ segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }, ...st.future],
        selectedSegmentId: null,
        selectedOverlayId: null,
      };
    });
  };

  const redo = () => {
    setEditState((st) => {
      if (st.future.length === 0) return st;
      const next = st.future[0];
      return {
        ...st,
        segments: next.segments,
        removeAudio: next.removeAudio,
        overlays: next.overlays,
        past: [...st.past, { segments: st.segments, removeAudio: st.removeAudio, overlays: st.overlays }],
        future: st.future.slice(1),
        selectedSegmentId: null,
        selectedOverlayId: null,
      };
    });
  };

  const doReset = () => {
    if (sessionKey) dropVideoSession(sessionKey);
    setEditState({
      segments: initialSegments(durationMs),
      removeAudio: false,
      overlays: [],
      past: [],
      future: [],
      selectedSegmentId: null,
      selectedOverlayId: null,
    });
    setPlayheadMs(0);
    seekTo(0);
  };

  const total = totalTimelineMs(segments);
  // useMemo (không tính thẳng mỗi render như trước) — tham chiếu ổn định
  // giữa các lần render KHÔNG đổi `segments` (phát video/hover-scrub/zoom đổi
  // liên tục) để effect báo `onStateChange` bên dưới không bắn dồn dập.
  const keepRanges = useMemo(() => computeKeepRanges(segments), [segments]);
  const hasChanges =
    past.length > 0 ||
    overlays.length > 0 ||
    removeAudio ||
    segments.length > 1 ||
    (segments[0] && (segments[0].srcStart > 0 || (durationMs > 0 && Math.abs(segments[0].srcEnd - durationMs) > 200)));
  // "Lưu đè" cần CÓ thay đổi để ghi đè (không có gì để lưu nếu chưa cắt hoặc chưa vẽ overlay) VÀ
  // đoạn giữ lại còn đủ dài (không cho ghi đè thành video gần như rỗng).
  const canSave = hasChanges && total >= MIN_SEG_MS && !busy;

  // Báo cho cha biết trạng thái chỉnh sửa — cha (Editor.tsx) dùng để quyết
  // định tham số truyền vào `onSave`/`onSaveAs`; vô hại nếu không ai lắng
  // (`onStateChange` optional).
  useEffect(() => {
    const preparedOverlays = overlays.map((o) => {
      if (o.type === "text" || o.type === "arrow") {
        const vw = videoRef.current?.videoWidth || 1920;
        const vh = videoRef.current?.videoHeight || 1080;
        const dataUrl = renderOverlayToDataUrl(o, vw, vh);
        return dataUrl ? { ...o, imageData: dataUrl } : o;
      }
      return o;
    });
    onStateChange?.({ hasChanges, keepRanges, removeAudio, overlays: preparedOverlays });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChanges, keepRanges, removeAudio, overlays]);

  const editStateRef = useRef(editState);
  editStateRef.current = editState;
  const playheadMsRef = useRef(playheadMs);
  playheadMsRef.current = playheadMs;

  // Tự động lưu phiên vào RAM & localStorage khi có thay đổi
  useEffect(() => {
    if (!sessionKey) return;
    saveVideoSession(sessionKey, {
      ...editState,
      playheadMs,
    }, durationMs);
  }, [sessionKey, editState, playheadMs, durationMs]);

  // Luôn chốt lưu phiên tại thời điểm unmount (khi mở ảnh khác hoặc đổi video) hoặc trước khi đóng tab/app
  useEffect(() => {
    const flush = () => {
      if (sessionKey) {
        saveVideoSession(sessionKey, {
          ...editStateRef.current,
          playheadMs: playheadMsRef.current,
        }, durationMs);
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [sessionKey, durationMs]);

  // Khôi phục mốc tua nếu phiên trước đó đang dừng ở một vị trí cụ thể
  useEffect(() => {
    if (savedSession?.playheadMs && savedSession.playheadMs > 0) {
      const timer = setTimeout(() => {
        seekTo(savedSession.playheadMs!);
      }, 100);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      {/* Video + thanh điều khiển phát NỔI đè lên đáy video (kiểu YouTube/
          QuickTime/CapCut) thay vì 1 hàng riêng chiếm chỗ bên dưới — nhường
          tối đa chiều cao cho khung xem, chỉ hiện chrome khi cần nhìn thấy. */}
      <div style={videoWrap} onMouseEnter={() => setWrapHover(true)} onMouseLeave={() => setWrapHover(false)}>
        <video
          ref={videoRef}
          key={src}
          crossOrigin="anonymous"
          src={src}
          style={videoStyle}
          onClick={togglePlay}
          onLoadedMetadata={() => {
            if (savedSession?.playheadMs && savedSession.playheadMs > 0) {
              seekTo(savedSession.playheadMs);
            }
          }}
        />

        <VideoCanvasOverlay
          videoRef={videoRef}
          playheadMs={playheadMs}
          durationMs={total}
          tool={overlayTool}
          onToolChange={setOverlayTool}
          overlays={overlays}
          selectedId={selectedOverlayId}
          onSelect={(id) => setEditState((st) => ({ ...st, selectedOverlayId: id }))}
          onChangeOverlay={handleChangeOverlay}
          onCommitSnapshot={handleCommitOverlaySnapshot}
          onAddOverlay={handleAddOverlay}
          onDeleteOverlay={handleDeleteOverlay}
          isPlaying={isPlaying}
        />

        <div style={playbackOverlay}>
          {/* Cột trái RỖNG — chỉ để `overlayCenterGroup` (cột giữa, "auto")
              được grid canh giữa THẬT SỰ trong toàn overlay bất kể `toolsGroup`
              (cột phải) rộng bao nhiêu, thay vì bị lệch tâm nếu dùng flex +
              marginLeft:auto như trước. */}
          <div />
          {/* Thời gian - Play - Âm lượng: chỉ hiện khi hover vào video
              (`showCenterControls`) — ẩn mặc định để khung xem sạch hơn lúc
              không thao tác, hiện lại ngay khi rê chuột vào (kiểu YouTube). */}
          <div
            style={{
              ...overlayCenterGroup,
              opacity: showCenterControls ? 1 : 0,
              pointerEvents: showCenterControls ? "auto" : "none",
            }}
          >
            <span style={overlayTimeText}>{fmtDuration(playheadMs)} / {fmtDuration(total)}</span>
            <button style={overlayPlayBtn} onClick={togglePlay} title={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
            </button>
            <div
              ref={volumeGroupRef}
              style={volumeGroup}
              onMouseEnter={() => {
                const rect = volumeGroupRef.current?.getBoundingClientRect();
                if (rect) setVolumeAnchor({ left: rect.right, top: rect.top + rect.height / 2 });
                setVolumeHover(true);
              }}
              onMouseLeave={() => setVolumeHover(false)}
            >
              <button style={overlayIconBtn} onClick={toggleMute} title={isMuted || volume === 0 ? "Unmute" : "Mute"}>
                {isMuted || volume === 0 ? <SpeakerMutedIcon /> : <SpeakerIcon />}
              </button>
              {/* Popover nổi NGANG HÀNG bên PHẢI icon (cùng chiều cao, không
                  còn xuống dưới như bản cũ) qua `position: fixed` (toạ độ
                  viewport từ `volumeAnchor`, đo lúc hover vào) — KHÔNG dùng
                  `position: absolute` neo trong `volumeGroup`, vì icon nằm
                  TRONG `videoWrap` (`overflow: hidden`, xem `playbackOverlay`):
                  popover tràn ra sẽ bị cắt mất nếu định vị tương đối trong
                  luồng cha. `position: fixed` thoát được việc bị cắt (cùng kỹ
                  thuật `hoverPreview` bên dưới) NHƯNG vẫn đặt là con DOM của
                  `volumeGroup` (không phải sibling) — bắt buộc để trình duyệt
                  coi việc rê chuột từ icon sang card là "vẫn ở trong
                  `volumeGroup`" (không bắn `mouseleave`), dù popover render ở
                  toạ độ khác trên màn hình. Đặt popover ra NGOÀI (làm sibling)
                  từng khiến rê chuột qua khoảng cách giữa icon và card bị hiểu
                  nhầm là đã rời khỏi, đóng sập popover giữa chừng. */}
              {(volumeHover || volumeDragging) && volumeAnchor && (
                <div style={{ ...volumePopoverAnchor, left: volumeAnchor.left, top: volumeAnchor.top }}>
                  <div style={volumePopoverCard}>
                    <div
                      ref={volumeTrackRef}
                      style={volumeTrackHit}
                      onPointerDown={onVolumeTrackDown}
                      onPointerMove={onVolumeTrackMove}
                      onPointerUp={onVolumeTrackUp}
                      title={t("videoTrimmer.volume")}
                    >
                      <div style={volumeTrackBar}>
                        <div style={{ ...volumeTrackFill, width: `${(isMuted ? 0 : volume) * 100}%` }} />
                        <div style={{ ...volumeThumb, left: `${(isMuted ? 0 : volume) * 100}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div style={toolsGroup}>
            <button style={overlayToolBtn} onClick={zoomOut} disabled={zoom <= MIN_ZOOM} title={t("videoTrimmer.zoomOut")}>−</button>
            <button style={overlayToolBtn} onClick={zoomReset} title={t("videoTrimmer.resetZoom")}>{Math.round(zoom * 100)}%</button>
            <button style={overlayToolBtn} onClick={zoomIn} disabled={zoom >= MAX_ZOOM} title={t("videoTrimmer.zoomIn")}>+</button>
            <button style={overlayIconBtn} onClick={toggleFullscreen} title={isFullscreen ? t("videoTrimmer.exitFullscreen") : t("videoTrimmer.enterFullscreen")}>
              {isFullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
            </button>
          </div>
        </div>
      </div>

      <div style={editToolbar}>
        {/* Cùng glyph ↩︎/↪︎ với Toolbar ảnh (`routes/editor/Toolbar.tsx`) — nhất
            quán trong toàn app thay vì mỗi chế độ dùng 1 cặp ký tự khác nhau. */}
        <button style={iconToolBtn} disabled={past.length === 0} onClick={undo} title={t("editorToolbar.undo")}>↩︎</button>
        <button style={iconToolBtn} disabled={future.length === 0} onClick={redo} title={t("videoTrimmer.redo")}>↪︎</button>
        <div style={toolDivider} />
        <button style={iconToolBtn} disabled={!canSplitAt(segments, playheadMs)} onClick={doSplit} title={t("videoTrimmer.split")}>
          <ScissorsIcon />
        </button>
        <button style={iconToolBtn} disabled={!selectedSegmentId || segments.length <= 1} onClick={doDeleteSelected} title={t("videoTrimmer.deleteSegment")}>
          <TrashIcon />
        </button>
        <button style={iconToolBtn} disabled={!canTrimHead(segments, playheadMs)} onClick={doTrimHead} title={t("videoTrimmer.trimStart")}>
          <span style={bracketGlyph}>[</span>
        </button>
        <button style={iconToolBtn} disabled={!canTrimTail(segments, playheadMs)} onClick={doTrimTail} title={t("videoTrimmer.trimEnd")}>
          <span style={bracketGlyph}>]</span>
        </button>
        <div style={toolDivider} />
        <button style={iconToolBtn} disabled={capturingFrame} onClick={doCaptureFrame} title={t("videoTrimmer.exportFrame")}>
          <CameraIcon />
        </button>
        <button style={iconToolBtn} onClick={() => setGifModalOpen(true)} title={t("videoTrimmer.exportGif")}>
          <GifIcon />
        </button>
        <div style={toolDivider} />

        {/* Vẽ khung, Che mờ, Chèn chữ & Mũi tên */}
        <button
          style={{ ...iconToolBtn, ...(overlayTool === "rect" ? iconToolBtnActive : null) }}
          onClick={() => setOverlayTool((cur) => (cur === "rect" ? "select" : "rect"))}
          title={t("videoTrimmer.drawBox", "Vẽ khung (R)")}
        >
          <RectIcon />
        </button>
        <button
          style={{ ...iconToolBtn, ...(overlayTool === "blur" ? iconToolBtnActive : null) }}
          onClick={() => setOverlayTool((cur) => (cur === "blur" ? "select" : "blur"))}
          title={t("videoTrimmer.drawBlur", "Che mờ (B)")}
        >
          <BlurIcon />
        </button>
        <button
          style={{ ...iconToolBtn, ...(overlayTool === "text" ? iconToolBtnActive : null) }}
          onClick={() => setOverlayTool((cur) => (cur === "text" ? "select" : "text"))}
          title={t("videoTrimmer.drawText", "Chèn chữ (T)")}
        >
          <TextIcon />
        </button>
        <button
          style={{ ...iconToolBtn, ...(overlayTool === "arrow" ? iconToolBtnActive : null) }}
          onClick={() => setOverlayTool((cur) => (cur === "arrow" ? "select" : "arrow"))}
          title={t("videoTrimmer.drawArrow", "Mũi tên (A)")}
        >
          <ArrowIcon />
        </button>
        <div style={toolDivider} />

        {/* Tách nhạc nền: xoá HẲN track âm thanh khỏi file khi Áp dụng cắt —
            chỉ 1 click để bật/tắt, gộp chung lịch sử undo với các thao tác
            cắt đoạn (xem `doToggleRemoveAudio`) nên Ctrl+Z hoàn tác đúng. */}
        <button
          style={{ ...iconToolBtn, ...(removeAudio ? iconToolBtnActive : null) }}
          onClick={doToggleRemoveAudio}
          title={removeAudio ? t("videoTrimmer.audioRemoved") : t("videoTrimmer.removeAudio")}
        >
          <NoAudioIcon />
        </button>
        {/* Đặt lại: đặt NGAY CẠNH nhóm icon cắt (chia/xoá/cắt đầu-cuối) —
            đây là hành động "bỏ hết" cho đúng nhóm công cụ này, đứng liền kề
            dễ liên tưởng hơn là gộp chung với Áp dụng cắt ở xa bên phải như
            bản cũ. */}
        <button style={resetBtn} disabled={!hasChanges || busy} onClick={doReset} title={t("videoTrimmer.resetChanges")}>
          {t("videoTrimmer.resetButton")}
        </button>
        {/* 2 nút Lưu tách biệt, đặt ngay trong hàng công cụ chỉnh sửa (không
            phải ở Toolbar trên cùng của Editor) — xem doc-comment `onSave`/
            `onSaveAs` ở `VideoTrimmerProps`. */}
        <div style={trimCommitGroup}>
          <button
            style={saveOverwriteBtn}
            disabled={!canSave}
            onClick={onSave}
            title={t("videoTrimmer.overwriteOriginal")}
          >
            {busy ? t("videoTrimmer.saving") : t("videoTrimmer.overwrite")}
          </button>
          {/* "Lưu thành video mới": split button — bấm chính auto lưu vào
              `saveDir` (tên mặc định `Recording_<timestamp>.mp4`, giống
              trước); "▾" mở popover "Chọn nơi lưu…" để chọn thư mục + sửa tên
              file qua dialog Save As, cùng pattern split-button Save/▾ ở
              `Toolbar.tsx` (chế độ ảnh). */}
          <div ref={saveAsMenuRef} style={saveAsSplitGroup}>
            <button
              style={saveAsBtn}
              disabled={busy}
              onClick={() => onSaveAs()}
              title={t("videoTrimmer.saveAsNew")}
            >
              {t("videoTrimmer.saveAsNewButton")}
            </button>
            <button
              style={saveAsCaretBtn}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); setShowSaveAsMenu((v) => !v); }}
              title={t("videoTrimmer.saveAsOptions")}
              aria-label={t("videoTrimmer.saveAsOptions")}
            >
              ▾
            </button>
            {showSaveAsMenu && (
              <div style={saveAsMenuPopover}>
                <button
                  style={saveAsMenuItem}
                  onClick={() => { setShowSaveAsMenu(false); onSaveAs(true); }}
                >
                  {t("videoTrimmer.saveAsPickLocation")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{ ...trackScroll, overflowX: zoom > 1 ? "auto" : "hidden" }}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        {/* Bọc chung ruler + track theo đúng 1 chiều rộng (zoom) — cùng cuộn
            với nhau vì là con trực tiếp của `trackScroll`, không cần đồng bộ
            scrollLeft riêng cho ruler. */}
        <div style={{ width: `${zoom * 100}%` }}>
          {/* Track hiệu ứng (Khung vẽ / Che mờ) */}
          <OverlayTimelineTrack
            overlays={overlays}
            totalMs={total}
            playheadMs={playheadMs}
            selectedId={selectedOverlayId}
            onSelect={(id) => setEditState((st) => ({ ...st, selectedOverlayId: id }))}
            onChangeOverlay={handleChangeOverlay}
            onCommitSnapshot={handleCommitOverlaySnapshot}
            onSeek={(ms) => seekTo(ms)}
            snapPoints={segmentBoundariesMs(segments)}
          />

          {/* Thước thời gian — mốc giờ:phút dọc timeline, mật độ tự đổi theo
              zoom (xem `timeTicks`). Thay cho dòng thời lượng cũ ở metaRow. */}
          <div style={timeRuler}>
            {timeTicks.map(({ ms, leftPct }) => (
              <div
                key={ms}
                style={{
                  ...tickWrap,
                  left: `${leftPct}%`,
                  transform: leftPct > 90 ? "translateX(-100%)" : leftPct > 0 ? "translateX(-1px)" : undefined,
                }}
              >
                <span style={tickLabel}>{fmtDuration(ms)}</span>
                <div style={tickLine} />
              </div>
            ))}
          </div>
          <div
            ref={trackRef}
            style={{ ...track, touchAction: "none" }}
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

          {/* Lớp phủ ĐỤC tại mỗi khoảng cách giữa 2 đoạn — che hẳn filmstrip
              bên dưới (nếu không, khoảng hở của segmentBlock vẫn lộ khung
              hình phía dưới do `filmstripLayer` trải liên tục suốt track,
              trông như 2 đoạn còn dính liền). Render TRƯỚC segmentBlock để
              nằm dưới border/outline của segment khi cần, nhưng vẫn trên
              `filmstripLayer` (theo thứ tự DOM). */}
          {laidOut.slice(0, -1).map(({ seg, startMs, lenMs }) => (
            <div
              key={`gap-${seg.id}`}
              style={{ ...segmentGapCover, left: `calc(${pct(startMs + lenMs)}% - ${SEGMENT_GAP_PX / 2}px)` }}
            />
          ))}

          {/* Từng đoạn giữ lại — ghép liền nhau, đoạn đã xoá đóng khoảng trống
              (khác bản cũ làm mờ tại chỗ). Cách nhau `SEGMENT_GAP_PX` ở mỗi
              điểm cắt (trừ 2 đầu timeline) + viền phải trên đoạn trước gap,
              để ranh giới giữa các đoạn rõ ràng hơn khi nhìn. Thuần hiển thị
              (pointerEvents:none), mọi tương tác xử lý ở track cha. */}
          {laidOut.map(({ seg, startMs, lenMs }, i) => {
            const leftPct = pct(startMs);
            const rightPct = pct(startMs + lenMs);
            const isFirst = i === 0;
            const isLast = i === laidOut.length - 1;
            const leftInset = isFirst ? 0 : SEGMENT_GAP_PX / 2;
            const rightInset = isLast ? 0 : SEGMENT_GAP_PX / 2;
            return (
              <div
                key={seg.id}
                style={{
                  ...segmentBlock,
                  left: `calc(${leftPct}% + ${leftInset}px)`,
                  width: `calc(${rightPct - leftPct}% - ${leftInset + rightInset}px)`,
                  ...(seg.id === selectedSegmentId ? segmentSelected : null),
                  ...(!isLast ? { borderRight: "1px solid rgba(0,0,0,0.5)" } : null),
                }}
              />
            );
          })}

          {/* Vạch phát hiện tại — transform kẹp biên để luôn hiển thị và không tràn ra ngoài track */}
          <div
            style={{
              ...playhead,
              left: `${pct(playheadMs)}%`,
              transform:
                pct(playheadMs) >= 99.5
                  ? "translateX(-100%)"
                  : pct(playheadMs) <= 0.5
                  ? "translateX(0)"
                  : "translateX(-50%)",
            }}
          />
          </div>
        </div>
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

      <GifExportModal
        open={gifModalOpen}
        onClose={() => setGifModalOpen(false)}
        filePath={filePath}
        videoSrc={src}
        durationMs={durationMs}
        selectedSegment={selectedSegment}
        sourceHistoryId={sourceHistoryId}
        onFlash={onFlash}
      />
    </div>
  );
}

function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M6.5 4.8v14.4a1 1 0 0 0 1.53.85l11.3-7.2a1 1 0 0 0 0-1.7l-11.3-7.2a1 1 0 0 0-1.53.85Z" />
    </svg>
  );
}

function PauseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <rect x="6" y="4.5" width="4.2" height="15" rx="1" />
      <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" />
    </svg>
  );
}

function FullscreenEnterIcon() {
  return (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 3H4v5M15 3h5v5M9 21H4v-5M15 21h5v-5" />
    </svg>
  );
}

function FullscreenExitIcon() {
  return (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
    </svg>
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

function RectIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
    </svg>
  );
}

function BlurIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" opacity="0.9" />
      <circle cx="16" cy="8" r="1.3" fill="currentColor" opacity="0.5" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" opacity="0.7" />
      <circle cx="8" cy="16" r="1.3" fill="currentColor" opacity="0.4" />
      <circle cx="16" cy="16" r="1.3" fill="currentColor" opacity="0.8" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="9" y1="20" x2="15" y2="20" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="19" x2="19" y2="5" />
      <polyline points="10 5 19 5 19 14" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13.5" r="3.2" />
    </svg>
  );
}

function GifIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="4" />
      <path d="M8 9.5H6.2A1.2 1.2 0 0 0 5 10.7v2.6a1.2 1.2 0 0 0 1.2 1.2H8v-2H6.8" />
      <path d="M12 9.5v5" />
      <path d="M16 14.5v-5h3" />
      <path d="M16 12h2.2" />
    </svg>
  );
}


function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h4l5 5V4L8 9H4z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 6a8 8 0 0 1 0 12" />
    </svg>
  );
}

function SpeakerMutedIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h4l5 5V4L8 9H4z" />
      <line x1="16" y1="9" x2="21" y2="14" />
      <line x1="21" y1="9" x2="16" y2="14" />
    </svg>
  );
}

/** Nốt nhạc gạch chéo — dùng riêng cho nút "Tách nhạc nền" (xoá track âm
 * thanh khỏi FILE khi Áp dụng cắt), phân biệt với `SpeakerIcon`/
 * `SpeakerMutedIcon` (chỉ tắt tiếng lúc XEM TRƯỚC, không đụng vào file). */
function NoAudioIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 16.5V5.5l9-2v11" />
      <circle cx="7.5" cy="16.5" r="2.5" />
      <circle cx="16.5" cy="14.5" r="2.5" />
      <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" />
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
  position: "relative",
  background: "#000",
  borderRadius: 8,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const videoStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain", cursor: "pointer" };

/** Thanh điều khiển phát NỔI đè lên đáy video (kiểu YouTube/QuickTime/CapCut)
 * — gradient tối dần từ trong suốt lên đen để chữ/icon luôn đọc được dù nền
 * video sáng màu, không chiếm thêm chiều cao cố định như 1 hàng riêng bên
 * dưới (video có ít không gian chết hơn, giống trải nghiệm player chuyên
 * nghiệp). Grid 3 cột (`1fr auto 1fr`) — cột giữa (`overlayCenterGroup`) LUÔN
 * canh giữa TOÀN overlay bất kể `toolsGroup` (cột phải) rộng bao nhiêu, cột
 * trái chỉ để giữ cân bằng khoảng trống (xem JSX). `toolsGroup` (zoom/toàn
 * màn hình) luôn hiện — dùng thường xuyên lúc chỉnh sửa; `overlayCenterGroup`
 * (thời gian/play/âm lượng) tự ẩn/hiện theo hover, xem `showCenterControls`. */
const playbackOverlay: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  display: "grid",
  gridTemplateColumns: "1fr auto 1fr",
  alignItems: "center",
  padding: "20px 10px 10px",
  background: "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.35) 65%, rgba(0,0,0,0) 100%)",
};

/** Nhóm Thời gian - Play - Âm lượng, canh giữa (cột "auto" của grid
 * `playbackOverlay`) — thứ tự này (không phải Play trước) để play button —
 * hành động chính — nằm ĐÚNG TÂM overlay, thời gian/âm lượng đối xứng 2 bên.
 * `transition` cho opacity khi ẩn/hiện theo hover mượt hơn là bật/tắt đột
 * ngột (xem `showCenterControls`). */
const overlayCenterGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  transition: "opacity 0.15s ease",
};

const overlayTimeText: React.CSSProperties = {
  fontSize: 12,
  color: "#fff",
  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/** Nút icon trên `playbackOverlay` — trong suốt, chỉ nổi khi hover (kiểu
 * YouTube/QuickTime: chrome player không có "chip" nền cố định, chỉ icon
 * trắng trên nền gradient), khác `iconToolBtn` (chip nền xám dùng cho
 * `editToolbar` — nơi KHÔNG có video làm nền nên cần viền/nền để phân định
 * nút với xung quanh). */
const overlayIconBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  flexShrink: 0,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

/** Nút Play/Pause chính — TO hẳn (không chỉ nhỉnh hơn 1 chút như trước) để dễ
 * bấm trúng, đúng vai trò hành động CHÍNH của thanh phát, cùng mức nhấn mạnh
 * với play button to giữa màn hình của YouTube/QuickTime; nền trắng mờ + viền
 * để vẫn rõ hình dạng nút dù icon/nền video cùng tông màu tối. */
const overlayPlayBtn: React.CSSProperties = {
  ...overlayIconBtn,
  width: 46,
  height: 46,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.16)",
  border: "1px solid rgba(255,255,255,0.3)",
};

/** Nút text (zoom −/100%/+) trên overlay — viền/nền mờ nhẹ để vẫn phân biệt
 * được là 1 nút bấm được (khác `overlayIconBtn` thuần icon, không cần viền
 * vì hình dạng icon đã đủ gợi ý "có thể bấm"). */
const overlayToolBtn: React.CSSProperties = {
  height: 26,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)",
  color: "#fff",
  fontSize: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const toolsGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  // Cột phải ("1fr") của grid `playbackOverlay` — ép sát rìa phải trong cột
  // đó (khác bản flex cũ dùng `marginLeft: auto` để tự đẩy sang phải).
  justifySelf: "end",
};

const volumeGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  position: "relative",
};

/** Neo NGANG HÀNG bên PHẢI icon loa (cùng chiều cao — `top` = tâm icon,
 * `transform: translateY(-50%)` tự canh giữa theo chiều dọc) qua toạ độ
 * viewport đo được (`volumeAnchor`, xem JSX) — `position: fixed` (không phải
 * `absolute`) để thoát khỏi `overflow: hidden` của `videoWrap` chứa icon.
 * `paddingLeft` (KHÔNG phải gap/margin) chừa khoảng cách nhìn thấy với card
 * bên phải, đồng thời vẫn giữ popover là CON DOM của `volumeGroup` (không
 * phải sibling) — cả 2 điểm này đảm bảo di chuột từ icon sang card không hề
 * bị trình duyệt hiểu nhầm là đã rời `volumeGroup` (xem giải thích dài hơn ở
 * JSX).
 * LƯU Ý: đặt ngang hàng nghĩa là popover đè lên `<video>` (khác bản cũ đặt
 * XUỐNG DƯỚI hẳn ra ngoài `videoWrap` để né đúng vùng này) — từng có bug kéo
 * thanh âm lượng bị "nuốt" mất giữa chừng khi popover chồng lên `<video>` ở 1
 * số WebView (nghi lớp video tăng tốc phần cứng giành sự kiện con trỏ bất kể
 * z-index). Nếu tái hiện lại bug đó sau thay đổi này, cân nhắc quay về đặt
 * dưới `videoWrap`. */
const volumePopoverAnchor: React.CSSProperties = {
  position: "fixed",
  transform: "translateY(-50%)",
  paddingLeft: 8,
  zIndex: 20,
};

const volumePopoverCard: React.CSSProperties = {
  display: "flex",
  justifyContent: "center",
  padding: "9px 10px",
  borderRadius: 8,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
};

/** Vùng BẮT chuột của track âm lượng — CAO HƠN NHIỀU dải hiện (`volumeTrackBar`
 * chỉ 4px) để dễ trúng/kéo, đặc biệt ở 2 đầu mút (đúng chỗ user báo không kéo
 * hết được). `touchAction:"none"` cùng lý do với timeline track (`track` bên
 * dưới) — chặn cuộn/pinch mặc định của trình duyệt đè lên thao tác kéo. */
const volumeTrackHit: React.CSSProperties = {
  width: 84,
  height: 28,
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  touchAction: "none",
};

const volumeTrackBar: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: 4,
  borderRadius: 2,
  background: "var(--border)",
};

/** Phần đã "đổ đầy" tính từ TRÁI sang — kéo sang phải = tăng âm, đúng thứ tự
 * trái→phải quen thuộc của thanh trượt ngang (xem `applyVolumeFromClientX`). */
const volumeTrackFill: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  height: "100%",
  borderRadius: 2,
  background: "var(--accent)",
};

const volumeThumb: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: "var(--accent)",
  transform: "translate(-50%, -50%)",
  boxShadow: "0 0 0 2px var(--bg-elevated)",
  pointerEvents: "none",
};

// Nền/viền/bo góc nhẹ — đọc thành 1 "thanh công cụ cắt" tách bạch khỏi
// video phía trên (giờ không còn playbackRow ngăn cách, xem `playbackOverlay`)
// và timeline phía dưới, giống thanh tool ngay trên timeline của Premiere/CapCut.
const editToolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  flexWrap: "wrap",
  padding: "6px 8px",
  borderRadius: 8,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
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

/** Merge thêm vào `iconToolBtn` khi nút đang ở trạng thái BẬT (toggle) — hiện
 * chỉ dùng cho "Tách nhạc nền" (`removeAudio`), khác các icon còn lại vốn là
 * hành động một lần chứ không phải toggle bật/tắt. */
const iconToolBtnActive: React.CSSProperties = {
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "var(--accent-text)",
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
  // Cao CỐ ĐỊNH bằng ruler + track (RULER_H + TRACK_H) — không để trình
  // duyệt tự cộng thêm chiều cao cho thanh cuộn ngang lúc nó xuất hiện
  // (Windows/WebView2 dùng scrollbar "classic" chiếm chỗ layout, khác overlay
  // scrollbar của macOS). Thiếu height cố định, mỗi lần zoom làm thanh cuộn
  // hiện/ẩn sẽ làm khối này co giãn vài px, đẩy khung video phía trên theo —
  // đúng hiện tượng "giao diện lệch lên trên" khi zoom out.
  height: RULER_H + TRACK_H,
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

/** Thước thời gian phía trên track — `pointerEvents:none` (thuần hiển thị,
 * không chặn tương tác), cao `RULER_H`. */
const timeRuler: React.CSSProperties = {
  position: "relative",
  height: RULER_H,
  pointerEvents: "none",
  flexShrink: 0,
};

const tickWrap: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "flex-end",
};

const tickLabel: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-dim)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  marginBottom: 2,
};

const tickLine: React.CSSProperties = {
  width: 1,
  height: 5,
  background: "var(--border)",
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

// Che ĐỤC khoảng cách giữa 2 đoạn — `segmentBlock` chỉ tô translucent
// (rgba trắng 8%) nên không đủ che khung hình filmstrip phía dưới, phải
// dùng màu nền ĐẶC (không alpha) mới thấy tách bạch hẳn khỏi nội dung video.
// `var(--bg-elevated)` khớp màu track lúc chưa có filmstrip (xem `track`).
const segmentGapCover: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: SEGMENT_GAP_PX,
  background: "var(--bg)",
  pointerEvents: "none",
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

const saveOverwriteBtn: React.CSSProperties = {
  height: 26,
  padding: "0 16px",
  borderRadius: 7,
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
};

/** Bọc nút "Lưu thành video mới" + mũi tên "▾" thành 1 split button — cùng
 * pattern `splitGroup` ở `Toolbar.tsx` (chế độ ảnh), làm điểm neo cho popover
 * "Chọn nơi lưu…" bên dưới. */
const saveAsSplitGroup: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "stretch",
};

/** Nút "Lưu thành video mới" — cùng chiều cao/kiểu chữ với `saveOverwriteBtn`
 * nhưng viền/nền nhẹ hơn (không phải hành động phá huỷ, không cần nhấn mạnh
 * bằng màu accent) — cùng phân cấp thị giác với `resetBtn` cạnh nó. */
const saveAsBtn: React.CSSProperties = {
  height: 26,
  padding: "0 14px",
  borderRadius: "7px 0 0 7px",
  border: "1px solid var(--border)",
  borderRight: "none",
  background: "transparent",
  color: "var(--text)",
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
};

/** Mũi tên nhỏ mở popover "Chọn nơi lưu…" — cùng viền/nền với `saveAsBtn`,
 * tách biệt bằng viền mảnh, đúng hình dáng split button quen thuộc. */
const saveAsCaretBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 26,
  padding: "0 8px",
  borderRadius: "0 7px 7px 0",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 11,
  opacity: 0.85,
  whiteSpace: "nowrap",
};

const saveAsMenuPopover: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  background: "rgba(30,30,36,0.99)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
  zIndex: 100,
  whiteSpace: "nowrap",
};

const saveAsMenuItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "#fff",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};
