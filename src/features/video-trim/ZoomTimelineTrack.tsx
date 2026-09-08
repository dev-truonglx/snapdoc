import React, { useRef, useState } from "react";
import {
  type ZoomSegment,
  MIN_ZOOM_DURATION_MS,
  ZOOM_SCALE_OPTIONS,
  clamp,
} from "./types";
import { FOCUS_ZONE_PRESETS, detectFocusZone } from "./mouseFocusEngine";

interface ZoomTimelineTrackProps {
  zoomSegments: ZoomSegment[];
  totalMs: number;
  playheadMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeZoomSegment: (item: ZoomSegment) => void;
  onDeleteZoomSegment: (id: string) => void;
  onCommitSnapshot?: () => void;
  onSeek?: (ms: number) => void;
  snapPoints?: number[];
  onAddZoomSegment?: (startMs: number) => void;
}

type DragAction = "move" | "resize-left" | "resize-right";

export default function ZoomTimelineTrack({
  zoomSegments,
  totalMs,
  playheadMs,
  selectedId,
  onSelect,
  onChangeZoomSegment,
  onDeleteZoomSegment,
  onCommitSnapshot,
  onSeek,
  snapPoints = [],
  onAddZoomSegment,
}: ZoomTimelineTrackProps) {
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

  const onPointerDown = (
    e: React.PointerEvent,
    item: ZoomSegment,
    action: DragAction,
  ) => {
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
    const current = zoomSegments.find((o) => o.id === dragging.id);
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
      onChangeZoomSegment({
        ...current,
        startTimeMs: Math.round(newStart),
        endTimeMs: Math.round(newEnd),
      });
    } else if (dragging.action === "resize-left") {
      let newStart = clamp(
        dragging.initialStartMs + dxMs,
        0,
        current.endTimeMs - MIN_ZOOM_DURATION_MS,
      );
      newStart = snapMs(newStart);
      onChangeZoomSegment({ ...current, startTimeMs: Math.round(newStart) });
    } else if (dragging.action === "resize-right") {
      let newEnd = clamp(
        dragging.initialEndMs + dxMs,
        current.startTimeMs + MIN_ZOOM_DURATION_MS,
        totalMs,
      );
      newEnd = snapMs(newEnd);
      onChangeZoomSegment({ ...current, endTimeMs: Math.round(newEnd) });
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

  const selectedItem = zoomSegments.find((z) => z.id === selectedId);

  return (
    <div
      ref={trackRef}
      style={trackContainerStyle}
      onPointerDown={() => onSelect(null)}
      onDoubleClick={(e) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const clickRatio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        const clickMs = Math.round(clickRatio * totalMs);
        onAddZoomSegment?.(clickMs);
      }}
      title="Dải thu phóng (Zoom Track) — Kéo để chỉnh mốc thời gian, nhấp đúp để tạo mốc mới"
    >
      {/* Nhãn Track bên trái */}
      <div style={trackLabelStyle}>
        <span style={{ fontSize: 10, opacity: 0.9 }}>🔍 ZOOM</span>
      </div>

      {zoomSegments.map((item) => {
        const isSelected = item.id === selectedId;
        const leftPct = pct(item.startTimeMs);
        const widthPct = Math.max(1, pct(item.endTimeMs) - leftPct);

        return (
          <div
            key={item.id}
            style={{
              ...zoomItemStyle,
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              ...(isSelected ? zoomItemSelectedStyle : null),
            }}
            onPointerDown={(e) => onPointerDown(e, item, "move")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {/* Handle kéo bên trái */}
            <div
              style={handleLeftStyle}
              onPointerDown={(e) => onPointerDown(e, item, "resize-left")}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />

            {/* Nội dung nhãn đoạn zoom */}
            <div style={itemContentStyle}>
              <span style={itemTextStyle}>
                {(() => {
                  const z = item.zone || detectFocusZone(item.focusX, item.focusY);
                  const p = FOCUS_ZONE_PRESETS.find((pre) => pre.zone === z);
                  return p ? `${p.icon} ${item.scale}x` : `🔍 ${item.scale}x`;
                })()}
              </span>
            </div>

            {/* Handle kéo bên phải */}
            <div
              style={handleRightStyle}
              onPointerDown={(e) => onPointerDown(e, item, "resize-right")}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          </div>
        );
      })}

      {/* Popover cấu hình cho zoom segment đang chọn */}
      {selectedItem && (() => {
        const currentZone =
          selectedItem.zone ||
          detectFocusZone(selectedItem.focusX, selectedItem.focusY);
        return (
          <div
            style={{
              ...popoverStyle,
              left: `${clamp(pct((selectedItem.startTimeMs + selectedItem.endTimeMs) / 2), 20, 80)}%`,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Mức zoom */}
            <span style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0" }}>
              Zoom:
            </span>
            <div style={{ display: "flex", gap: 3 }}>
              {ZOOM_SCALE_OPTIONS.map((sc) => {
                const isActive = Math.abs(selectedItem.scale - sc) < 0.05;
                return (
                  <button
                    key={sc}
                    type="button"
                    style={{
                      ...scaleBtnStyle,
                      ...(isActive ? scaleBtnActiveStyle : null),
                    }}
                    onClick={() => {
                      onChangeZoomSegment({ ...selectedItem, scale: sc });
                      onCommitSnapshot?.();
                    }}
                  >
                    {sc}x
                  </button>
                );
              })}
            </div>

            <div style={popoverSeparatorStyle} />

            {/* Vị trí zoom thông minh */}
            <span style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0" }}>
              Vị trí:
            </span>
            <div style={{ display: "flex", gap: 3 }}>
              {FOCUS_ZONE_PRESETS.map((preset) => {
                const isZoneActive = currentZone === preset.zone;
                return (
                  <button
                    key={preset.zone}
                    type="button"
                    style={{
                      ...scaleBtnStyle,
                      ...(isZoneActive ? zoneBtnActiveStyle : null),
                    }}
                    title={`Chuyển vị trí zoom về: ${preset.label}`}
                    onClick={() => {
                      onChangeZoomSegment({
                        ...selectedItem,
                        focusX: preset.focusX,
                        focusY: preset.focusY,
                        zone: preset.zone,
                      });
                      onCommitSnapshot?.();
                    }}
                  >
                    {preset.icon} {preset.label}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              style={deleteBtnStyle}
              title="Xóa mốc zoom này"
              onClick={() => {
                onDeleteZoomSegment(selectedItem.id);
                onCommitSnapshot?.();
              }}
            >
              🗑
            </button>
          </div>
        );
      })()}
    </div>
  );
}

const trackContainerStyle: React.CSSProperties = {
  position: "relative",
  height: 24,
  boxSizing: "border-box",
  flexShrink: 0,
  background: "rgba(24, 24, 27, 0.75)",
  borderTop: "1px solid rgba(255, 255, 255, 0.06)",
  borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
  userSelect: "none",
  overflow: "visible",
};

const trackLabelStyle: React.CSSProperties = {
  position: "absolute",
  left: 6,
  top: 4,
  fontSize: 10,
  fontWeight: 700,
  color: "rgba(192, 132, 252, 0.85)",
  letterSpacing: 0.5,
  pointerEvents: "none",
  zIndex: 1,
};

const zoomItemStyle: React.CSSProperties = {
  position: "absolute",
  top: 2,
  height: 20,
  background:
    "linear-gradient(135deg, rgba(147, 51, 234, 0.82) 0%, rgba(99, 102, 241, 0.82) 100%)",
  border: "1px solid rgba(192, 132, 252, 0.65)",
  borderRadius: 4,
  boxSizing: "border-box",
  cursor: "grab",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 3,
  transition: "box-shadow 0.15s ease",
};

const zoomItemSelectedStyle: React.CSSProperties = {
  border: "1.5px solid #ffffff",
  boxShadow:
    "0 0 0 2px rgba(168, 85, 247, 0.95), 0 2px 8px rgba(147, 51, 234, 0.5)",
  zIndex: 5,
};

const handleLeftStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 6,
  cursor: "ew-resize",
  background: "rgba(255, 255, 255, 0.25)",
  borderTopLeftRadius: 3,
  borderBottomLeftRadius: 3,
};

const handleRightStyle: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: 6,
  cursor: "ew-resize",
  background: "rgba(255, 255, 255, 0.25)",
  borderTopRightRadius: 3,
  borderBottomRightRadius: 3,
};

const itemContentStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  overflow: "hidden",
  whiteSpace: "nowrap",
  padding: "0 8px",
};

const itemTextStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "#ffffff",
  textShadow: "0 1px 2px rgba(0, 0, 0, 0.6)",
};

const popoverStyle: React.CSSProperties = {
  position: "absolute",
  top: 28,
  transform: "translateX(-50%)",
  background: "rgba(24, 24, 27, 0.96)",
  border: "1px solid rgba(168, 85, 247, 0.5)",
  borderRadius: 6,
  padding: "4px 8px",
  display: "flex",
  alignItems: "center",
  gap: 6,
  zIndex: 25,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.6)",
};

const scaleBtnStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  borderRadius: 3,
  color: "#e2e8f0",
  fontSize: 11,
  fontWeight: 600,
  padding: "2px 6px",
  cursor: "pointer",
};

const scaleBtnActiveStyle: React.CSSProperties = {
  background: "#9333ea",
  borderColor: "#c084fc",
  color: "#ffffff",
};

const deleteBtnStyle: React.CSSProperties = {
  background: "rgba(239, 68, 68, 0.15)",
  border: "1px solid rgba(239, 68, 68, 0.4)",
  borderRadius: 3,
  color: "#fca5a5",
  fontSize: 11,
  padding: "2px 6px",
  cursor: "pointer",
  marginLeft: 4,
};

const popoverSeparatorStyle: React.CSSProperties = {
  width: 1,
  height: 16,
  background: "rgba(255, 255, 255, 0.15)",
  margin: "0 4px",
};

const zoneBtnActiveStyle: React.CSSProperties = {
  background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
  borderColor: "#38bdf8",
  color: "#ffffff",
  fontWeight: 700,
};
