import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  type SpeedRegion,
  MIN_SPEED_ZONE_DURATION_MS,
  clamp,
} from "./types";
import {
  type Segment,
  sourceMsToTimeline,
  timelineMsToSource,
} from "./segments";

interface SpeedTimelineTrackProps {
  speedRegions: SpeedRegion[];
  effectiveSegments: Segment[];
  durationMs: number;
  totalMs: number;
  playheadMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeSpeedRegion: (item: SpeedRegion) => void;
  onDeleteSpeedRegion?: (id: string) => void;
  onApplyAll?: (speed: number) => void;
  onCommitSnapshot?: () => void;
  onSeek?: (ms: number) => void;
  snapPoints?: number[];
  onAddSpeedRegion?: (startMs: number) => void;
}

type DragAction = "move" | "resize-left" | "resize-right";

export default function SpeedTimelineTrack({
  speedRegions,
  effectiveSegments,
  durationMs,
  totalMs,
  playheadMs,
  selectedId,
  onSelect,
  onChangeSpeedRegion,
  onDeleteSpeedRegion,
  onApplyAll,
  onCommitSnapshot,
  onSeek,
  snapPoints = [],
  onAddSpeedRegion,
}: SpeedTimelineTrackProps) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const popoverRef = useRef<HTMLDivElement>(null);

  const [dragging, setDragging] = useState<{
    id: string;
    action: DragAction;
    startX: number;
    initialStartMs: number;
    initialEndMs: number;
  } | null>(null);

  const [popoverPos, setPopoverPos] = useState<{
    left: number;
    top: number;
    placement: "top" | "bottom";
    arrowOffset: number;
  } | null>(null);

  if (totalMs <= 0) return null;

  const pct = (ms: number) => (clamp(ms, 0, totalMs) / totalMs) * 100;

  const snapMs = (targetMs: number, snapThresholdMs: number = 200): number => {
    let bestMs = targetMs;
    let minDiff = snapThresholdMs;

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
    item: SpeedRegion,
    action: DragAction,
  ) => {
    e.stopPropagation();
    if (selectedId !== item.id) {
      onSelect(item.id);
    }
    const startTlMs = sourceMsToTimeline(effectiveSegments, item.startTimeMs) ?? item.startTimeMs;
    const endTlMs = sourceMsToTimeline(effectiveSegments, item.endTimeMs) ?? item.endTimeMs;
    if (onSeek && (playheadMs < startTlMs || playheadMs > endTlMs)) {
      onSeek(startTlMs);
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
    const dxTlMs = (dxPx / trackRect.width) * totalMs;
    const current = speedRegions.find((o) => o.id === dragging.id);
    if (!current) return;

    // Các vùng lân cận để chặn không cho đè nhau
    const otherRegions = speedRegions.filter((r) => r.id !== dragging.id);
    const prevRegion = otherRegions
      .filter((r) => r.endTimeMs <= dragging.initialStartMs)
      .sort((a, b) => b.endTimeMs - a.endTimeMs)[0];
    const nextRegion = otherRegions
      .filter((r) => r.startTimeMs >= dragging.initialEndMs)
      .sort((a, b) => a.startTimeMs - b.startTimeMs)[0];
    const minBoundSrc = prevRegion ? prevRegion.endTimeMs : 0;
    const maxBoundSrc = nextRegion ? nextRegion.startTimeMs : durationMs;

    const durSrc = dragging.initialEndMs - dragging.initialStartMs;

    if (dragging.action === "move") {
      const initStartTlMs = sourceMsToTimeline(effectiveSegments, dragging.initialStartMs) ?? 0;
      const targetStartTlMs = snapMs(initStartTlMs + dxTlMs);
      const pos = timelineMsToSource(effectiveSegments, targetStartTlMs);
      const newStartSrc = pos ? pos.srcMs : dragging.initialStartMs + dxTlMs;
      const safeStart = clamp(newStartSrc, minBoundSrc, maxBoundSrc - durSrc);
      onChangeSpeedRegion({
        ...current,
        startTimeMs: Math.round(safeStart),
        endTimeMs: Math.round(safeStart + durSrc),
      });
    } else if (dragging.action === "resize-left") {
      const initStartTlMs = sourceMsToTimeline(effectiveSegments, dragging.initialStartMs) ?? 0;
      const targetStartTlMs = snapMs(initStartTlMs + dxTlMs);
      const pos = timelineMsToSource(effectiveSegments, targetStartTlMs);
      const newStartSrc = pos ? pos.srcMs : dragging.initialStartMs + dxTlMs;
      const safeStart = clamp(
        newStartSrc,
        minBoundSrc,
        current.endTimeMs - MIN_SPEED_ZONE_DURATION_MS,
      );
      onChangeSpeedRegion({ ...current, startTimeMs: Math.round(safeStart) });
    } else if (dragging.action === "resize-right") {
      const initEndTlMs = sourceMsToTimeline(effectiveSegments, dragging.initialEndMs) ?? 0;
      const targetEndTlMs = snapMs(initEndTlMs + dxTlMs);
      const pos = timelineMsToSource(effectiveSegments, targetEndTlMs);
      const newEndSrc = pos ? pos.srcMs : dragging.initialEndMs + dxTlMs;
      const safeEnd = clamp(
        newEndSrc,
        current.startTimeMs + MIN_SPEED_ZONE_DURATION_MS,
        maxBoundSrc,
      );
      onChangeSpeedRegion({ ...current, endTimeMs: Math.round(safeEnd) });
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

  // Tính toán toạ độ hiển thị popover neo ngay tại khối tốc độ đang chọn
  const updatePopoverPos = () => {
    if (!selectedId || dragging) {
      setPopoverPos((prev) => (prev === null ? prev : null));
      return;
    }
    const el = itemRefs.current[selectedId];
    if (!el) {
      setPopoverPos((prev) => (prev === null ? prev : null));
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPopoverPos((prev) => (prev === null ? prev : null));
      return;
    }
    if (rect.right < 0 || rect.left > window.innerWidth) {
      setPopoverPos((prev) => (prev === null ? prev : null));
      return;
    }

    const popoverW = 280;
    const popoverH = 185;
    const blockCenterX = rect.left + rect.width / 2;
    const clampedCenter = clamp(blockCenterX, popoverW / 2 + 12, window.innerWidth - popoverW / 2 - 12);
    const arrowOffset = clamp(blockCenterX - clampedCenter, -popoverW / 2 + 24, popoverW / 2 - 24);

    let placement: "top" | "bottom" = "top";
    let top = rect.top - 10;
    if (top - popoverH < 40) {
      placement = "bottom";
      top = rect.bottom + 10;
    }

    setPopoverPos((prev) => {
      if (
        prev &&
        Math.abs(prev.left - clampedCenter) < 0.5 &&
        Math.abs(prev.top - top) < 0.5 &&
        prev.placement === placement &&
        Math.abs(prev.arrowOffset - arrowOffset) < 0.5
      ) {
        return prev;
      }
      return {
        left: clampedCenter,
        top,
        placement,
        arrowOffset,
      };
    });
  };

  const selectedItem = speedRegions.find((r) => r.id === selectedId) ?? null;

  useLayoutEffect(() => {
    updatePopoverPos();
  }, [selectedId, selectedItem?.startTimeMs, selectedItem?.endTimeMs, totalMs, dragging, effectiveSegments]);

  // Tự động neo theo khối khi scroll timeline hoặc resize cửa sổ
  useEffect(() => {
    if (!selectedId) return;
    const handleScrollOrResize = () => updatePopoverPos();
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [selectedId]);

  // Click ra ngoài (bao gồm timeline) để đóng popover điều chỉnh tốc độ
  useEffect(() => {
    if (!selectedId) return;
    const handleClickOutside = (e: Event) => {
      const target = e.target as Node;
      if (popoverRef.current && popoverRef.current.contains(target)) return;
      if (selectedId && itemRefs.current[selectedId]?.contains(target)) return;
      onSelect(null);
    };
    // Bắt ngay ở capture phase để đóng tức thì khi click timeline hoặc các vùng khác
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handleClickOutside, true);
      window.addEventListener("mousedown", handleClickOutside, true);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handleClickOutside, true);
      window.removeEventListener("mousedown", handleClickOutside, true);
    };
  }, [selectedId, onSelect]);

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
        onAddSpeedRegion?.(clickMs);
      }}
      title="Dải tốc độ (Speed Track) — Kéo tai để chỉnh mốc thời gian, nhấp đúp để tạo vùng tốc độ mới"
    >
      {/* Nhãn Track bên trái */}
      <div style={trackLabelStyle}>
        <span style={{ fontSize: 10, opacity: 0.95 }}>⚡ SPEED</span>
      </div>

      {speedRegions.map((item) => {
        const isSelected = item.id === selectedId;
        const startTlMs = sourceMsToTimeline(effectiveSegments, item.startTimeMs) ?? item.startTimeMs;
        const endTlMs = sourceMsToTimeline(effectiveSegments, item.endTimeMs) ?? item.endTimeMs;
        const leftPct = pct(startTlMs);
        const widthPct = Math.max(0.8, pct(endTlMs) - leftPct);

        return (
          <div
            key={item.id}
            ref={(el) => {
              itemRefs.current[item.id] = el;
            }}
            style={{
              ...speedItemStyle,
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              ...(isSelected ? speedItemSelectedStyle : null),
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
              title="Kéo để đổi mốc bắt đầu"
            />

            {/* Nội dung nhãn tốc độ */}
            <div style={itemContentStyle}>
              <span style={itemTextStyle}>
                ⚡ {item.speed}x
              </span>
            </div>

            {/* Handle kéo bên phải */}
            <div
              style={handleRightStyle}
              onPointerDown={(e) => onPointerDown(e, item, "resize-right")}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              title="Kéo để đổi mốc kết thúc"
            />
          </div>
        );
      })}

      {/* Floating Options Popover: Hiển thị ngay tại khối tốc độ được chọn */}
      {selectedItem && popoverPos && !dragging && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: "fixed",
            left: popoverPos.left,
            top: popoverPos.top,
            transform:
              popoverPos.placement === "top"
                ? "translate(-50%, -100%)"
                : "translate(-50%, 0)",
            width: 280,
            background: "rgba(22, 22, 26, 0.97)",
            border: "1px solid rgba(245, 158, 11, 0.4)",
            borderRadius: 10,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            boxShadow:
              "0 8px 32px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08)",
            zIndex: 99999,
            backdropFilter: "blur(16px)",
            pointerEvents: "auto",
            userSelect: "none",
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Mũi tên chỉ vào khối */}
          <div
            style={{
              position: "absolute",
              left: `calc(50% + ${popoverPos.arrowOffset}px)`,
              ...(popoverPos.placement === "top"
                ? {
                    bottom: -6,
                    borderTop: "6px solid rgba(22, 22, 26, 0.97)",
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                  }
                : {
                    top: -6,
                    borderBottom: "6px solid rgba(22, 22, 26, 0.97)",
                    borderLeft: "6px solid transparent",
                    borderRight: "6px solid transparent",
                  }),
              transform: "translateX(-50%)",
              width: 0,
              height: 0,
              pointerEvents: "none",
            }}
          />

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13 }}>⚡</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>
                {t("videoTrimmer.speedZoneThis", "Tốc độ đoạn này")}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#f59e0b",
                  background: "rgba(245, 158, 11, 0.15)",
                  padding: "1px 6px",
                  borderRadius: 4,
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                }}
              >
                {selectedItem.speed}x
              </span>
            </div>
            <button
              style={{
                background: "transparent",
                border: "none",
                color: "rgba(255, 255, 255, 0.5)",
                cursor: "pointer",
                padding: "2px 4px",
                fontSize: 14,
                lineHeight: 1,
              }}
              onClick={() => onSelect(null)}
              title={t("videoTrimmer.close", "Đóng")}
            >
              ✕
            </button>
          </div>

          {/* Presets */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
            {[0.5, 0.75, 1.0, 1.5, 2.0, 4.0].map((p) => {
              const isActive = Math.abs(selectedItem.speed - p) < 0.01;
              return (
                <button
                  key={p}
                  style={{
                    padding: "5px 0",
                    fontSize: 11,
                    fontWeight: isActive ? 700 : 500,
                    borderRadius: 5,
                    border: isActive
                      ? "1px solid #f59e0b"
                      : "1px solid rgba(255, 255, 255, 0.1)",
                    background: isActive
                      ? "#f59e0b"
                      : "rgba(255, 255, 255, 0.05)",
                    color: isActive ? "#000" : "#fff",
                    cursor: "pointer",
                    textAlign: "center",
                    transition: "all 0.12s ease",
                  }}
                  onClick={() => {
                    onChangeSpeedRegion({ ...selectedItem, speed: p });
                    onCommitSnapshot?.();
                  }}
                >
                  {p}x
                </button>
              );
            })}
          </div>

          {/* Slider */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10.5, color: "rgba(255, 255, 255, 0.5)" }}>
                {t("videoTrimmer.speedCustom", "Tuỳ chỉnh")}
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#f59e0b" }}>
                {selectedItem.speed.toFixed(2)}x
              </span>
            </div>
            <input
              type="range"
              min="0.25"
              max="8.0"
              step="0.05"
              value={selectedItem.speed}
              onChange={(e) => {
                const sp = parseFloat(e.target.value);
                onChangeSpeedRegion({ ...selectedItem, speed: sp });
              }}
              onMouseUp={() => onCommitSnapshot?.()}
              onTouchEnd={() => onCommitSnapshot?.()}
              style={{
                width: "100%",
                accentColor: "#f59e0b",
                cursor: "pointer",
              }}
            />
          </div>

          {/* Nút áp dụng cho toàn bộ video */}
          <button
            style={{
              width: "100%",
              padding: "7px 10px",
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 6,
              border: "1px solid rgba(245, 158, 11, 0.4)",
              background: "rgba(245, 158, 11, 0.12)",
              color: "#f59e0b",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              transition: "all 0.15s ease",
            }}
            onClick={() => onApplyAll?.(selectedItem.speed)}
            title={t("videoTrimmer.speedAll", "Áp dụng cho toàn bộ video")}
          >
            <span>🌐</span>
            <span>
              {t("videoTrimmer.speedAll", "Áp dụng cho toàn bộ video")} ({selectedItem.speed}x)
            </span>
          </button>

          {/* Footer Actions */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingTop: 6,
              borderTop: "1px solid rgba(255, 255, 255, 0.08)",
            }}
          >
            <button
              style={{
                flex: 1,
                padding: "5px 8px",
                fontSize: 11,
                fontWeight: 500,
                borderRadius: 5,
                border: "1px solid rgba(239, 68, 68, 0.35)",
                background: "rgba(239, 68, 68, 0.12)",
                color: "#fca5a5",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
              }}
              onClick={() => onDeleteSpeedRegion?.(selectedItem.id)}
              title={t("videoTrimmer.deleteSpeedZone", "Xoá vùng tốc độ này")}
            >
              <span>🗑️</span>
              <span>{t("videoTrimmer.deleteOverlay", "Xoá")}</span>
            </button>
            <button
              style={{
                flex: 1,
                padding: "5px 8px",
                fontSize: 11,
                fontWeight: 500,
                borderRadius: 5,
                border: "1px solid rgba(255, 255, 255, 0.1)",
                background: "rgba(255, 255, 255, 0.05)",
                color: "rgba(255, 255, 255, 0.75)",
                cursor: "pointer",
                textAlign: "center",
              }}
              onClick={() => {
                onChangeSpeedRegion({ ...selectedItem, speed: 1.0 });
                onCommitSnapshot?.();
              }}
              disabled={Math.abs(selectedItem.speed - 1.0) < 0.01}
            >
              {t("videoTrimmer.speedReset", "Đặt lại 1.0x")}
            </button>
          </div>
        </div>,
        document.body
      )}
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
  color: "rgba(245, 158, 11, 0.9)",
  letterSpacing: 0.5,
  pointerEvents: "none",
  zIndex: 1,
};

const speedItemStyle: React.CSSProperties = {
  position: "absolute",
  top: 2,
  height: 20,
  background:
    "linear-gradient(135deg, rgba(245, 158, 11, 0.88) 0%, rgba(217, 119, 6, 0.88) 100%)",
  border: "1px solid rgba(251, 191, 36, 0.7)",
  borderRadius: 4,
  boxSizing: "border-box",
  cursor: "grab",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 3,
  transition: "box-shadow 0.15s ease",
};

const speedItemSelectedStyle: React.CSSProperties = {
  border: "1.5px solid #ffffff",
  boxShadow:
    "0 0 0 2px rgba(245, 158, 11, 0.95), 0 2px 8px rgba(217, 119, 6, 0.6)",
  zIndex: 5,
};

const handleLeftStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 6,
  cursor: "ew-resize",
  background: "rgba(255, 255, 255, 0.3)",
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
  background: "rgba(255, 255, 255, 0.3)",
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
