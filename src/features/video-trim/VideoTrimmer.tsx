import { useEffect, useRef, useState } from "react";

export interface VideoTrimmerProps {
  src: string;
  durationMs: number;
  busy?: boolean;
  onApply: (keepRangesMs: [number, number][]) => void;
}

interface CutRange {
  start: number;
  end: number;
}

type DragMode = "start" | "end" | "select" | "seek";

/** Chỉ giữ cạnh dài nhất chưa gộp, dùng lặp lại cho track/handle drag math. */
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

function mergeCuts(cuts: CutRange[]): CutRange[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const merged: CutRange[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/** Đoạn GIỮ LẠI = phần bù của `middleCuts` (đã clamp vào [trimStart,trimEnd])
 * bên trong [trimStart, trimEnd] — cùng model dữ liệu gửi cho
 * `record::encoder::trim` (xem plan cắt video). */
function computeKeepRanges(trimStart: number, trimEnd: number, middleCuts: CutRange[]): [number, number][] {
  const cuts = middleCuts
    .map((c) => ({ start: Math.max(c.start, trimStart), end: Math.min(c.end, trimEnd) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);

  const ranges: [number, number][] = [];
  let cursor = trimStart;
  for (const cut of cuts) {
    if (cut.start > cursor) ranges.push([cursor, cut.start]);
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < trimEnd) ranges.push([cursor, trimEnd]);
  return ranges;
}

const MIN_SEG_MS = 300;
const HANDLE_WIDTH = 10;

/** Timeline cắt video dùng chung cho RecordReview (trước khi Lưu) và
 * HistoryPreviewPanel (video đã lưu) — 2 handle kéo trim đầu/cuối + kéo-chọn
 * 1 đoạn ở giữa để đánh dấu xoá. Component tự sở hữu `<video>` (cần `ref` để
 * seek/theo dõi `timeupdate`) nên chỗ gọi chỉ cần truyền `src`/`durationMs`,
 * không cần tự render `<video>` riêng nữa. Kéo handle/kéo-chọn dùng Pointer
 * Capture đặt trên chính element bắt đầu kéo (giống pattern resize-handle của
 * `Overlay.tsx`), move/up lắng trên track cha nhờ event bubbling. */
export default function VideoTrimmer({ src, durationMs, busy, onApply }: VideoTrimmerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: DragMode; anchorMs?: number } | null>(null);

  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(durationMs);
  const [middleCuts, setMiddleCuts] = useState<CutRange[]>([]);
  const [pendingSelection, setPendingSelection] = useState<CutRange | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTimeMs(v.currentTime * 1000);
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
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const seekTo = (ms: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = clamp(ms, 0, durationMs) / 1000;
  };

  const posToMs = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * durationMs;
  };

  const onHandleDown = (mode: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    videoRef.current?.pause();
    dragRef.current = { mode };
  };

  const onTrackDown = (e: React.PointerEvent) => {
    trackRef.current?.setPointerCapture?.(e.pointerId);
    // Bấm vào thanh thời gian luôn dừng video ở đúng vị trí bấm — kể cả khi
    // đang phát, thay vì tua tiếp trong lúc phát.
    videoRef.current?.pause();
    const ms = posToMs(e.clientX);
    if (ms >= trimStart && ms <= trimEnd) {
      dragRef.current = { mode: "select", anchorMs: ms };
      setPendingSelection({ start: ms, end: ms });
    } else {
      dragRef.current = { mode: "seek" };
      seekTo(ms);
    }
  };

  const onTrackMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const ms = posToMs(e.clientX);
    if (drag.mode === "start") {
      setTrimStart(clamp(ms, 0, trimEnd - MIN_SEG_MS));
    } else if (drag.mode === "end") {
      setTrimEnd(clamp(ms, trimStart + MIN_SEG_MS, durationMs));
    } else if (drag.mode === "select" && drag.anchorMs != null) {
      setPendingSelection({ start: Math.min(drag.anchorMs, ms), end: Math.max(drag.anchorMs, ms) });
    } else if (drag.mode === "seek") {
      seekTo(ms);
    }
  };

  const onTrackUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === "start") {
      seekTo(trimStart);
    } else if (drag.mode === "end") {
      seekTo(trimEnd);
    } else if (drag.mode === "select") {
      const sel = pendingSelection;
      setPendingSelection(null);
      if (sel && sel.end - sel.start >= MIN_SEG_MS) {
        setMiddleCuts((prev) => mergeCuts([...prev, sel]));
      } else if (drag.anchorMs != null) {
        seekTo(drag.anchorMs);
      }
    }
  };

  const reset = () => {
    setTrimStart(0);
    setTrimEnd(durationMs);
    setMiddleCuts([]);
  };

  const keepRanges = computeKeepRanges(trimStart, trimEnd, middleCuts);
  const keptMs = keepRanges.reduce((sum, [s, e]) => sum + (e - s), 0);
  const hasChanges = trimStart > 0 || trimEnd < durationMs || middleCuts.length > 0;
  const canApply = hasChanges && keptMs >= MIN_SEG_MS && !busy;

  const pct = (ms: number) => (durationMs <= 0 ? 0 : (clamp(ms, 0, durationMs) / durationMs) * 100);

  return (
    <div style={wrap}>
      <div style={videoWrap}>
        <video ref={videoRef} key={src} src={src} style={videoStyle} autoPlay />
      </div>

      <div style={playbackRow}>
        <button style={playBtn} onClick={togglePlay} title={isPlaying ? "Tạm dừng" : "Phát"}>
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <span style={timeText}>{fmtDuration(currentTimeMs)} / {fmtDuration(durationMs)}</span>
      </div>

      <div
        ref={trackRef}
        style={{ ...track, touchAction: "none" }}
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
        onPointerUp={onTrackUp}
      >
        {/* Vùng bị trim đầu/cuối — làm mờ để phân biệt với đoạn giữ lại. */}
        <div style={{ ...dimmed, left: 0, width: `${pct(trimStart)}%` }} />
        <div style={{ ...dimmed, left: `${pct(trimEnd)}%`, right: 0 }} />

        {/* Các đoạn giữa đã đánh dấu xoá. */}
        {middleCuts.map((c, i) => (
          <div
            key={i}
            style={{ ...cutChip, left: `${pct(c.start)}%`, width: `${pct(c.end) - pct(c.start)}%` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              style={cutRemoveBtn}
              onClick={() => setMiddleCuts((prev) => prev.filter((_, idx) => idx !== i))}
              title="Bỏ đánh dấu xoá đoạn này"
            >
              ×
            </button>
          </div>
        ))}

        {/* Đoạn đang kéo-chọn (chưa thả tay) — xem trước trước khi commit. */}
        {pendingSelection && (
          <div
            style={{
              ...cutChip,
              left: `${pct(pendingSelection.start)}%`,
              width: `${pct(pendingSelection.end) - pct(pendingSelection.start)}%`,
              borderStyle: "dashed",
            }}
          />
        )}

        {/* Vạch phát hiện tại. */}
        <div style={{ ...playhead, left: `${pct(currentTimeMs)}%` }} />

        {/* 2 handle trim đầu/cuối. */}
        <div style={{ ...handle, left: `calc(${pct(trimStart)}% - ${HANDLE_WIDTH / 2}px)` }} onPointerDown={onHandleDown("start")} />
        <div style={{ ...handle, left: `calc(${pct(trimEnd)}% - ${HANDLE_WIDTH / 2}px)` }} onPointerDown={onHandleDown("end")} />
      </div>

      <div style={infoRow}>
        <span style={{ color: "var(--text-dim)" }}>
          Giữ lại: {fmtDuration(keptMs)} / {fmtDuration(durationMs)}
          {middleCuts.length > 0 && ` · Đã xoá ${middleCuts.length} đoạn`}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={resetBtn} disabled={!hasChanges || busy} onClick={reset}>Đặt lại</button>
          <button style={applyBtn} disabled={!canApply} onClick={() => onApply(keepRanges)}>
            {busy ? "Đang cắt…" : "Áp dụng cắt"}
          </button>
        </div>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 };

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

const track: React.CSSProperties = {
  position: "relative",
  height: 44,
  flexShrink: 0,
  borderRadius: 8,
  background: "rgba(255,255,255,0.08)",
  cursor: "pointer",
  userSelect: "none",
};

const dimmed: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "rgba(0,0,0,0.55)",
  borderRadius: 8,
  pointerEvents: "none",
};

const cutChip: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "rgba(239,68,68,0.35)",
  border: "1px solid rgba(239,68,68,0.7)",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const cutRemoveBtn: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  background: "rgba(239,68,68,0.9)",
  color: "#fff",
  fontSize: 12,
  lineHeight: "18px",
  padding: 0,
};

const playhead: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 2,
  background: "#fff",
  opacity: 0.8,
  pointerEvents: "none",
};

const handle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: HANDLE_WIDTH,
  borderRadius: 4,
  background: "var(--accent)",
  cursor: "ew-resize",
  touchAction: "none",
};

const infoRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 12,
  flexShrink: 0,
};

const resetBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 12,
};

const applyBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 7,
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontWeight: 600,
  fontSize: 12,
};
