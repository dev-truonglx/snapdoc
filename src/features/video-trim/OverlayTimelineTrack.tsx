import React, { useRef, useState } from "react";
import { type VideoOverlayItem, MIN_OVERLAY_DURATION_MS, clamp } from "./types";

interface OverlayTimelineTrackProps {
  overlays: VideoOverlayItem[];
  totalMs: number;
  playheadMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeOverlay: (item: VideoOverlayItem) => void;
  onCommitSnapshot?: () => void;
  onSeek?: (ms: number) => void;
  snapPoints?: number[];
}

type DragAction = "move" | "resize-left" | "resize-right";

export default function OverlayTimelineTrack({
  overlays,
  totalMs,
  playheadMs,
  selectedId,
  onSelect,
  onChangeOverlay,
  onCommitSnapshot,
  onSeek,
  snapPoints = [],
}: OverlayTimelineTrackProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{
    id: string;
    action: DragAction;
    startX: number;
    initialStartMs: number;
    initialEndMs: number;
  } | null>(null);

  if (totalMs <= 0) return null;

  const pct = (ms: number) => (clamp(ms, 0, totalMs) / totalMs) * 100;

  const snapMs = (targetMs: number, snapThresholdMs: number = 200): number => {
    let bestMs = targetMs;
    let minDiff = snapThresholdMs;

    // Các điểm bắt dính: Playhead, 0, totalMs, và các mốc từ bên ngoài
    const allSnaps = [0, playheadMs, totalMs, ...snapPoints];
    for (const pt of allSnaps) {
      const diff = Math.abs(pt - targetMs);
      if (diff < minDiff) {
        minDiff = diff;
        bestMs = pt;
      }
    }
    return bestMs;
  };

  const didDragRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent, item: VideoOverlayItem, action: DragAction) => {
    e.stopPropagation();
    onSelect(item.id);
    if (onSeek && (playheadMs < item.startTimeMs || playheadMs > item.endTimeMs)) {
      onSeek(item.startTimeMs);
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    didDragRef.current = false;

    setDragging({
      id: item.id,
      action,
      startX: e.clientX,
      initialStartMs: item.startTimeMs,
      initialEndMs: item.endTimeMs,
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !trackRef.current) return;
    const trackRect = trackRef.current.getBoundingClientRect();
    if (trackRect.width <= 0) return;

    const dxPx = e.clientX - dragging.startX;
    if (Math.abs(dxPx) > 1) didDragRef.current = true;
    const dxMs = (dxPx / trackRect.width) * totalMs;
    const current = overlays.find((o) => o.id === dragging.id);
    if (!current) return;

    if (dragging.action === "move") {
      const dur = dragging.initialEndMs - dragging.initialStartMs;
      let newStart = clamp(dragging.initialStartMs + dxMs, 0, totalMs - dur);
      newStart = snapMs(newStart);
      let newEnd = newStart + dur;
      if (newEnd > totalMs) {
        newEnd = totalMs;
        newStart = Math.max(0, newEnd - dur);
      }
      onChangeOverlay({ ...current, startTimeMs: Math.round(newStart), endTimeMs: Math.round(newEnd) });
    } else if (dragging.action === "resize-left") {
      let newStart = clamp(dragging.initialStartMs + dxMs, 0, current.endTimeMs - MIN_OVERLAY_DURATION_MS);
      newStart = snapMs(newStart);
      onChangeOverlay({ ...current, startTimeMs: Math.round(newStart) });
    } else if (dragging.action === "resize-right") {
      let newEnd = clamp(dragging.initialEndMs + dxMs, current.startTimeMs + MIN_OVERLAY_DURATION_MS, totalMs);
      newEnd = snapMs(newEnd);
      onChangeOverlay({ ...current, endTimeMs: Math.round(newEnd) });
    }
  };

  const onPointerUp = () => {
    if (dragging) {
      if (didDragRef.current) {
        onCommitSnapshot?.();
        didDragRef.current = false;
      }
      setDragging(null);
    }
  };

  // Chiều cao track hiệu ứng
  const trackHeight = overlays.length > 0 ? 24 : 0;
  if (trackHeight === 0) return null;

  return (
    <div
      ref={trackRef}
      style={{
        position: "relative",
        height: trackHeight,
        background: "rgba(0, 0, 0, 0.35)",
        borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
        userSelect: "none",
        overflow: "hidden",
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={() => onSelect(null)}
    >
      {overlays.map((item) => {
        const isSelected = item.id === selectedId;
        const isActive = item.startTimeMs <= playheadMs && playheadMs <= item.endTimeMs;
        const leftPct = pct(item.startTimeMs);
        const rightPct = pct(item.endTimeMs);
        const widthPct = Math.max(0.4, rightPct - leftPct);
        const durSec = ((item.endTimeMs - item.startTimeMs) / 1000).toFixed(1);

        const meta = (() => {
          switch (item.type) {
            case "rect":
              return {
                icon: "🔲",
                label: "Khung",
                color: item.strokeColor || "#ef4444",
                bg: "rgba(239, 68, 68, 0.35)",
              };
            case "blur":
              return {
                icon: "░",
                label: item.isBlackout ? "Hộp đen" : "Che mờ",
                color: "#a855f7",
                bg: "rgba(168, 85, 247, 0.35)",
              };
            case "text":
              return {
                icon: "T",
                label: item.text ? (item.text.length > 8 ? item.text.slice(0, 8) + "…" : item.text) : "Chữ",
                color: item.textColor || item.strokeColor || "#3b82f6",
                bg: "rgba(59, 130, 246, 0.35)",
              };
            case "arrow":
              return {
                icon: "↗",
                label: "Mũi tên",
                color: item.strokeColor || "#f59e0b",
                bg: "rgba(245, 158, 11, 0.35)",
              };
          }
        })();

        return (
          <div
            key={item.id}
            data-overlay-chip="true"
            style={{
              position: "absolute",
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              top: 2,
              bottom: 2,
              borderRadius: 4,
              boxSizing: "border-box",
              background: meta.bg,
              border: isSelected
                ? `1.5px solid #ffffff`
                : `1px solid ${meta.color}`,
              boxShadow: isSelected
                ? `0 0 6px ${meta.color}`
                : isActive
                ? "0 0 4px rgba(255,255,255,0.4)"
                : "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              cursor: "grab",
              zIndex: isSelected ? 5 : 2,
              padding: "0 4px",
              opacity: isActive ? 1 : 0.8,
            }}
            onPointerDown={(e) => onPointerDown(e, item, "move")}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onSeek?.(item.startTimeMs);
            }}
            title={`${meta.label}: ${(item.startTimeMs / 1000).toFixed(1)}s - ${(item.endTimeMs / 1000).toFixed(1)}s (${durSec}s)`}
          >
            {/* Handle kéo bên trái */}
            <div
              style={{
                width: 6,
                height: "100%",
                cursor: "ew-resize",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: 0.7,
              }}
              onPointerDown={(e) => onPointerDown(e, item, "resize-left")}
            >
              <div style={{ width: 2, height: 10, background: "#ffffff", borderRadius: 1 }} />
            </div>

            {/* Nhãn icon & thời lượng / tiêu đề */}
            <div
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 10,
                color: "#ffffff",
                textAlign: "center",
                pointerEvents: "none",
                fontWeight: 600,
                padding: "0 2px",
              }}
            >
              {meta.icon} {meta.label}
            </div>

            {/* Handle kéo bên phải */}
            <div
              style={{
                width: 6,
                height: "100%",
                cursor: "ew-resize",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: 0.7,
              }}
              onPointerDown={(e) => onPointerDown(e, item, "resize-right")}
            >
              <div style={{ width: 2, height: 10, background: "#ffffff", borderRadius: 1 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
