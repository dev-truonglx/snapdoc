import React, { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  type VideoOverlayItem,
  type VideoOverlayType,
  OVERLAY_COLORS,
  OVERLAY_STROKE_WIDTHS,
  DEFAULT_OVERLAY_DURATION_MS,
  clamp,
  makeOverlayUid,
} from "./types";

export type VideoOverlayTool = "select" | "rect" | "blur" | "text" | "arrow";

interface VideoCanvasOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playheadMs: number;
  durationMs: number;
  tool: VideoOverlayTool;
  onToolChange: (tool: VideoOverlayTool) => void;
  overlays: VideoOverlayItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeOverlay: (item: VideoOverlayItem) => void;
  onCommitSnapshot?: () => void;
  onAddOverlay: (item: VideoOverlayItem) => void;
  onDeleteOverlay: (id: string) => void;
  isPlaying: boolean;
}

type HandleType = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "arrow-start" | "arrow-end";

function OverlayFontSizeInput({
  value,
  onChange,
  onCommit,
}: {
  value: number;
  onChange: (n: number) => void;
  onCommit?: () => void;
}) {
  const [draft, setDraft] = useState(String(value || 18));
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setDraft(String(value || 18));
    }
  }, [value]);

  const clampSize = (n: number) => Math.max(8, Math.min(120, Math.round(n)));

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <button
        type="button"
        style={{
          width: 18,
          height: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,255,255,0.08)",
          border: "none",
          borderRadius: 3,
          color: "rgba(255,255,255,0.8)",
          fontSize: 12,
          cursor: "pointer",
          padding: 0,
        }}
        onClick={(e) => {
          e.stopPropagation();
          const next = clampSize((value || 18) - 2);
          onChange(next);
          onCommit?.();
        }}
        title="Giảm cỡ chữ"
      >
        −
      </button>

      <input
        type="text"
        inputMode="numeric"
        value={draft}
        style={{
          width: 34,
          height: 20,
          background: "rgba(0, 0, 0, 0.4)",
          border: "1px solid rgba(255, 255, 255, 0.25)",
          borderRadius: 3,
          color: "#ffffff",
          fontSize: 11,
          fontWeight: 600,
          textAlign: "center",
          outline: "none",
          padding: "0 2px",
          boxSizing: "border-box",
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onFocus={(e) => {
          isFocusedRef.current = true;
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d]/g, "");
          setDraft(raw);
          if (raw !== "") {
            const num = Number(raw);
            if (num > 0) {
              onChange(clampSize(num));
            }
          }
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          if (draft === "" || Number(draft) < 8) {
            const fallback = value || 18;
            setDraft(String(fallback));
            onChange(fallback);
          }
          onCommit?.();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        title="Cỡ chữ (px)"
      />

      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", userSelect: "none" }}>px</span>

      <button
        type="button"
        style={{
          width: 18,
          height: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,255,255,0.08)",
          border: "none",
          borderRadius: 3,
          color: "rgba(255,255,255,0.8)",
          fontSize: 12,
          cursor: "pointer",
          padding: 0,
        }}
        onClick={(e) => {
          e.stopPropagation();
          const next = clampSize((value || 18) + 2);
          onChange(next);
          onCommit?.();
        }}
        title="Tăng cỡ chữ"
      >
        +
      </button>
    </div>
  );
}

export default function VideoCanvasOverlay({
  videoRef,
  playheadMs,
  durationMs,
  tool,
  onToolChange,
  overlays,
  selectedId,
  onSelect,
  onChangeOverlay,
  onCommitSnapshot,
  onAddOverlay,
  onDeleteOverlay,
  isPlaying,
}: VideoCanvasOverlayProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [videoRect, setVideoRect] = useState<{ left: number; top: number; width: number; height: number }>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  // Đo đạc kích thước và vị trí chính xác của video bên trong container
  const updateRect = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const cw = video.clientWidth;
    const ch = video.clientHeight;
    const vw = video.videoWidth || (video as any).naturalWidth || 0;
    const vh = video.videoHeight || (video as any).naturalHeight || 0;

    if (!cw || !ch) {
      return;
    }

    if (!vw || !vh) {
      setVideoRect({ left: 0, top: 0, width: cw, height: ch });
      return;
    }

    const containerRatio = cw / ch;
    const videoRatio = vw / vh;
    let w = cw;
    let h = ch;
    let left = 0;
    let top = 0;
    if (containerRatio > videoRatio) {
      w = ch * videoRatio;
      left = (cw - w) / 2;
    } else {
      h = cw / videoRatio;
      top = (ch - h) / 2;
    }
    setVideoRect({ left: Math.round(left), top: Math.round(top), width: Math.round(w), height: Math.round(h) });
  }, [videoRef]);

  useEffect(() => {
    updateRect();
    const video = videoRef.current;
    if (!video) return;

    const ro = new ResizeObserver(updateRect);
    ro.observe(video);
    if (video.parentElement) {
      ro.observe(video.parentElement);
    }

    const events = ["loadedmetadata", "loadeddata", "canplay", "canplaythrough", "playing", "timeupdate", "resize"];
    events.forEach((ev) => video.addEventListener(ev, updateRect));

    // Polling ngắn (mỗi 100ms trong 2s đầu) để đảm bảo layout khớp ngay khi mount
    const interval = setInterval(updateRect, 100);
    const stopTimer = setTimeout(() => clearInterval(interval), 2000);

    return () => {
      ro.disconnect();
      events.forEach((ev) => video.removeEventListener(ev, updateRect));
      clearInterval(interval);
      clearTimeout(stopTimer);
    };
  }, [updateRect, videoRef]);

  // Vẽ mới khung / vùng mờ / mũi tên / chữ
  const [drawing, setDrawing] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(
    null,
  );

  // Kéo di chuyển / co giãn box hoặc endpoint mũi tên
  const [transforming, setTransforming] = useState<{
    id: string;
    handle: HandleType | "move";
    startX: number;
    startY: number;
    initialRel: { relX: number; relY: number; relW: number; relH: number };
    initialArrow?: { sx: number; sy: number; ex: number; ey: number };
  } | null>(null);

  const pendingFocusTextIdRef = useRef<string | null>(null);
  const justFinishedDrawingRef = useRef(false);

  const isDrawingMode = tool !== "select";

  const onPointerDown = (e: React.PointerEvent) => {
    if (!isDrawingMode || e.button !== 0 || !videoRect.width || !videoRect.height) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = clamp(e.clientX - rect.left, 0, videoRect.width);
    const y = clamp(e.clientY - rect.top, 0, videoRect.height);

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrawing({ startX: x, startY: y, currentX: x, currentY: y });
  };

  const transformChangedRef = useRef(false);

  const onPointerMove = (e: React.PointerEvent) => {
    if (!containerRef.current || !videoRect.width || !videoRect.height) return;
    const rect = containerRef.current.getBoundingClientRect();

    if (drawing) {
      const x = clamp(e.clientX - rect.left, 0, videoRect.width);
      const y = clamp(e.clientY - rect.top, 0, videoRect.height);
      setDrawing((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null));
      return;
    }

    if (transforming) {
      transformChangedRef.current = true;
      const dx = (e.clientX - transforming.startX) / videoRect.width;
      const dy = (e.clientY - transforming.startY) / videoRect.height;
      const init = transforming.initialRel;
      const current = overlays.find((o) => o.id === transforming.id);
      if (!current) return;

      if (transforming.handle === "arrow-start" || transforming.handle === "arrow-end") {
        const initArrow = transforming.initialArrow || {
          sx: current.arrowStartX ?? 0.1,
          sy: current.arrowStartY ?? 0.1,
          ex: current.arrowEndX ?? 0.9,
          ey: current.arrowEndY ?? 0.9,
        };

        const origAbsStartX = init.relX + initArrow.sx * init.relW;
        const origAbsStartY = init.relY + initArrow.sy * init.relH;
        const origAbsEndX = init.relX + initArrow.ex * init.relW;
        const origAbsEndY = init.relY + initArrow.ey * init.relH;

        let absStartX = origAbsStartX;
        let absStartY = origAbsStartY;
        let absEndX = origAbsEndX;
        let absEndY = origAbsEndY;

        if (transforming.handle === "arrow-start") {
          absStartX = clamp(origAbsStartX + dx, 0, 1);
          absStartY = clamp(origAbsStartY + dy, 0, 1);
        } else {
          absEndX = clamp(origAbsEndX + dx, 0, 1);
          absEndY = clamp(origAbsEndY + dy, 0, 1);
        }

        const minX = Math.min(absStartX, absEndX);
        const minY = Math.min(absStartY, absEndY);
        const w = Math.max(0.015, Math.abs(absEndX - absStartX));
        const h = Math.max(0.015, Math.abs(absEndY - absStartY));

        onChangeOverlay({
          ...current,
          relX: minX,
          relY: minY,
          relW: w,
          relH: h,
          arrowStartX: (absStartX - minX) / w,
          arrowStartY: (absStartY - minY) / h,
          arrowEndX: (absEndX - minX) / w,
          arrowEndY: (absEndY - minY) / h,
        });
        return;
      }

      let newRelX = init.relX;
      let newRelY = init.relY;
      let newRelW = init.relW;
      let newRelH = init.relH;

      if (transforming.handle === "move") {
        newRelX = clamp(init.relX + dx, 0, 1 - init.relW);
        newRelY = clamp(init.relY + dy, 0, 1 - init.relH);
      } else {
        const handle = transforming.handle;
        if (handle.includes("e")) {
          newRelW = clamp(init.relW + dx, 0.02, 1 - init.relX);
        }
        if (handle.includes("s")) {
          newRelH = clamp(init.relH + dy, 0.02, 1 - init.relY);
        }
        if (handle.includes("w")) {
          const maxDx = init.relW - 0.02;
          const actualDx = clamp(dx, -init.relX, maxDx);
          newRelX = init.relX + actualDx;
          newRelW = init.relW - actualDx;
        }
        if (handle.includes("n")) {
          const maxDy = init.relH - 0.02;
          const actualDy = clamp(dy, -init.relY, maxDy);
          newRelY = init.relY + actualDy;
          newRelH = init.relH - actualDy;
        }
      }

      onChangeOverlay({
        ...current,
        relX: newRelX,
        relY: newRelY,
        relW: newRelW,
        relH: newRelH,
      });
    }
  };

  const onPointerUp = () => {
    if (drawing && videoRect.width > 0 && videoRect.height > 0) {
      const endMs = Math.min(durationMs, playheadMs + DEFAULT_OVERLAY_DURATION_MS);
      const safeDurationMs = Math.max(playheadMs + 500, endMs);

      if (tool === "arrow") {
        const dist = Math.hypot(drawing.currentX - drawing.startX, drawing.currentY - drawing.startY);
        if (dist >= 15) {
          const minX = Math.min(drawing.startX, drawing.currentX);
          const minY = Math.min(drawing.startY, drawing.currentY);
          const wPx = Math.max(20, Math.abs(drawing.currentX - drawing.startX));
          const hPx = Math.max(20, Math.abs(drawing.currentY - drawing.startY));

          const relX = minX / videoRect.width;
          const relY = minY / videoRect.height;
          const relW = wPx / videoRect.width;
          const relH = hPx / videoRect.height;

          const arrowStartX = (drawing.startX - minX) / wPx;
          const arrowStartY = (drawing.startY - minY) / hPx;
          const arrowEndX = (drawing.currentX - minX) / wPx;
          const arrowEndY = (drawing.currentY - minY) / hPx;

          const newItem: VideoOverlayItem = {
            id: makeOverlayUid(),
            type: "arrow",
            relX,
            relY,
            relW,
            relH,
            startTimeMs: playheadMs,
            endTimeMs: safeDurationMs,
            strokeColor: "#ef4444",
            strokeWidth: 3,
            arrowStartX,
            arrowStartY,
            arrowEndX,
            arrowEndY,
          };

          onAddOverlay(newItem);
          onSelect(newItem.id);
          onToolChange("select");
        }
      } else if (tool === "text") {
        const wPx = Math.max(150, Math.abs(drawing.currentX - drawing.startX));
        const hPx = Math.max(44, Math.abs(drawing.currentY - drawing.startY));
        let minX = Math.min(drawing.startX, drawing.currentX);
        let minY = Math.min(drawing.startY, drawing.currentY);

        if (minX + wPx > videoRect.width) minX = Math.max(0, videoRect.width - wPx);
        if (minY + hPx > videoRect.height) minY = Math.max(0, videoRect.height - hPx);

        const relX = minX / videoRect.width;
        const relY = minY / videoRect.height;
        const relW = wPx / videoRect.width;
        const relH = hPx / videoRect.height;

        const newItem: VideoOverlayItem = {
          id: makeOverlayUid(),
          type: "text",
          relX,
          relY,
          relW,
          relH,
          startTimeMs: playheadMs,
          endTimeMs: safeDurationMs,
          text: "",
          fontSize: 18,
          textColor: "#ffffff",
          hasBackground: true,
        };

        justFinishedDrawingRef.current = true;
        setTimeout(() => { justFinishedDrawingRef.current = false; }, 150);
        pendingFocusTextIdRef.current = newItem.id;
        onAddOverlay(newItem);
        onSelect(newItem.id);
        onToolChange("select");
      } else {
        const wPx = Math.abs(drawing.currentX - drawing.startX);
        const hPx = Math.abs(drawing.currentY - drawing.startY);

        if (wPx >= 15 && hPx >= 15) {
          const minX = Math.min(drawing.startX, drawing.currentX);
          const minY = Math.min(drawing.startY, drawing.currentY);
          const relX = minX / videoRect.width;
          const relY = minY / videoRect.height;
          const relW = wPx / videoRect.width;
          const relH = hPx / videoRect.height;

          const newItem: VideoOverlayItem = {
            id: makeOverlayUid(),
            type: tool as VideoOverlayType,
            relX,
            relY,
            relW,
            relH,
            startTimeMs: playheadMs,
            endTimeMs: safeDurationMs,
            strokeColor: "#ef4444",
            strokeWidth: 3,
            isBlackout: false,
          };

          justFinishedDrawingRef.current = true;
          setTimeout(() => { justFinishedDrawingRef.current = false; }, 150);
          onAddOverlay(newItem);
          onSelect(newItem.id);
          onToolChange("select");
        }
      }
      setDrawing(null);
    }

    if (transforming) {
      if (transformChangedRef.current) {
        onCommitSnapshot?.();
        transformChangedRef.current = false;
      }
      setTransforming(null);
    }
  };

  // Lắng nghe phím Delete / Backspace để xoá overlay đang chọn
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!selectedId) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onDeleteOverlay(selectedId);
      } else if (e.key === "Escape") {
        onSelect(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, onDeleteOverlay, onSelect]);

  // Khi click ra bất kỳ đâu bên ngoài (ngoài video, trên timeline, ngoài thanh công cụ): bỏ chọn ngay lập tức
  useEffect(() => {
    if (!selectedId) return;

    const onPointerDownOutside = (e: PointerEvent) => {
      if (justFinishedDrawingRef.current) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Nếu click vào chính overlay đang chọn, thanh công cụ mini, hoặc chip timeline: giữ nguyên
      if (
        target.closest(`[data-overlay-id="${selectedId}"]`) ||
        target.closest("[data-overlay-toolbar]") ||
        target.closest("[data-overlay-chip]")
      ) {
        return;
      }

      onSelect(null);
    };

    window.addEventListener("pointerdown", onPointerDownOutside);
    return () => window.removeEventListener("pointerdown", onPointerDownOutside);
  }, [selectedId, onSelect]);

  // Lọc overlay đang xuất hiện tại mốc phát hiện tại HOẶC đang được người dùng chọn
  const visibleOverlays = overlays.filter(
    (item) => (item.startTimeMs <= playheadMs && playheadMs <= item.endTimeMs) || item.id === selectedId,
  );

  const finalWidth = videoRect.width > 0 ? videoRect.width : (videoRef.current?.clientWidth || 0);
  const finalHeight = videoRect.height > 0 ? videoRect.height : (videoRef.current?.clientHeight || 0);
  const finalLeft = videoRect.width > 0 ? videoRect.left : 0;
  const finalTop = videoRect.height > 0 ? videoRect.top : 0;

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        left: finalLeft,
        top: finalTop,
        width: finalWidth > 0 ? finalWidth : "100%",
        height: finalHeight > 0 ? finalHeight : "100%",
        pointerEvents: isDrawingMode || selectedId !== null ? "auto" : "none",
        cursor: isDrawingMode ? "crosshair" : "default",
        userSelect: "none",
        zIndex: 5,
      }}
      onPointerDown={(e) => {
        if (e.target === containerRef.current) {
          if (isDrawingMode) {
            onPointerDown(e);
          } else if (selectedId) {
            e.stopPropagation();
            onSelect(null);
          }
        }
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => {
        if (justFinishedDrawingRef.current) {
          justFinishedDrawingRef.current = false;
          return;
        }
        if (e.target === containerRef.current && !isDrawingMode) {
          onSelect(null);
        }
      }}
    >
      {/* Các overlay hiển thị */}
      {visibleOverlays.map((item) => {
        const isSelected = item.id === selectedId;
        const left = `${item.relX * 100}%`;
        const top = `${item.relY * 100}%`;
        const width = `${item.relW * 100}%`;
        const height = `${item.relH * 100}%`;

        const boxW = Math.max(16, item.relW * finalWidth);
        const boxH = Math.max(16, item.relH * finalHeight);

        return (
          <div
            key={item.id}
            data-overlay-id={item.id}
            style={{
              position: "absolute",
              left,
              top,
              width,
              height,
              pointerEvents: isPlaying ? "none" : "auto",
              cursor: isDrawingMode ? "crosshair" : "move",
              boxSizing: "border-box",
              zIndex: isSelected ? 10 : 6,
              ...(item.type === "rect"
                ? {
                    border: `${item.strokeWidth || 3}px solid ${item.strokeColor || "#ef4444"}`,
                    borderRadius: 4,
                    boxShadow: "0 0 6px rgba(0,0,0,0.5)",
                    ...(isSelected
                      ? {
                          outline: "1px dashed rgba(255,255,255,0.9)",
                          outlineOffset: 2,
                        }
                      : null),
                  }
                : item.type === "blur"
                ? {
                    borderRadius: 4,
                    ...(item.isBlackout
                      ? { background: "#000000" }
                      : {
                          backdropFilter: "blur(16px)",
                          WebkitBackdropFilter: "blur(16px)",
                          background: "rgba(255, 255, 255, 0.08)",
                          border: isSelected ? "1px solid #3b82f6" : "1px dashed rgba(255,255,255,0.7)",
                        }),
                  }
                : item.type === "arrow"
                ? {
                    border: isSelected ? "1px dashed rgba(59, 130, 246, 0.5)" : "none",
                  }
                : {
                    // text
                    borderRadius: 6,
                    ...(item.hasBackground !== false
                      ? {
                          background: "rgba(18, 18, 22, 0.85)",
                          backdropFilter: "blur(8px)",
                          WebkitBackdropFilter: "blur(8px)",
                          border: isSelected ? "1.5px solid #3b82f6" : "1px solid rgba(255,255,255,0.2)",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                        }
                      : {
                          background: "transparent",
                          border: isSelected ? "1.5px dashed #3b82f6" : "none",
                        }),
                  }),
            }}
            onPointerDown={(e) => {
              if (isDrawingMode) return;
              e.stopPropagation();
              onSelect(item.id);
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              setTransforming({
                id: item.id,
                handle: "move",
                startX: e.clientX,
                startY: e.clientY,
                initialRel: {
                  relX: item.relX,
                  relY: item.relY,
                  relW: item.relW,
                  relH: item.relH,
                },
                initialArrow: {
                  sx: item.arrowStartX ?? 0.1,
                  sy: item.arrowStartY ?? 0.1,
                  ex: item.arrowEndX ?? 0.9,
                  ey: item.arrowEndY ?? 0.9,
                },
              });
            }}
          >
            {/* Nội dung Mũi tên (SVG) */}
            {item.type === "arrow" && (
              <svg
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  height: "100%",
                  overflow: "visible",
                  pointerEvents: "none",
                  filter: "drop-shadow(0 2px 5px rgba(0,0,0,0.65))",
                }}
              >
                {(() => {
                  const sx = (item.arrowStartX ?? 0.1) * boxW;
                  const sy = (item.arrowStartY ?? 0.1) * boxH;
                  const ex = (item.arrowEndX ?? 0.9) * boxW;
                  const ey = (item.arrowEndY ?? 0.9) * boxH;
                  const dx = ex - sx;
                  const dy = ey - sy;
                  const angle = Math.atan2(dy, dx);
                  const strokeW = item.strokeWidth || 3;
                  const headLen = Math.max(12, strokeW * 4.5);
                  const color = item.strokeColor || "#ef4444";

                  const pTip = `${ex},${ey}`;
                  const pLeft = `${ex - headLen * Math.cos(angle - Math.PI / 6)},${ey - headLen * Math.sin(angle - Math.PI / 6)}`;
                  const pNotch = `${ex - headLen * 0.5 * Math.cos(angle)},${ey - headLen * 0.5 * Math.sin(angle)}`;
                  const pRight = `${ex - headLen * Math.cos(angle + Math.PI / 6)},${ey - headLen * Math.sin(angle + Math.PI / 6)}`;

                  const endLineX = ex - headLen * 0.6 * Math.cos(angle);
                  const endLineY = ey - headLen * 0.6 * Math.sin(angle);

                  return (
                    <g>
                      {isSelected && (
                        <line
                          x1={sx}
                          y1={sy}
                          x2={ex}
                          y2={ey}
                          stroke="rgba(59, 130, 246, 0.4)"
                          strokeWidth={strokeW + 6}
                          strokeLinecap="round"
                        />
                      )}
                      <line
                        x1={sx}
                        y1={sy}
                        x2={endLineX}
                        y2={endLineY}
                        stroke={color}
                        strokeWidth={strokeW}
                        strokeLinecap="round"
                      />
                      <polygon points={`${pTip} ${pLeft} ${pNotch} ${pRight}`} fill={color} />
                    </g>
                  );
                })()}
              </svg>
            )}

            {/* Nội dung Chữ (Textarea) */}
            {item.type === "text" && (
              <textarea
                ref={(el) => {
                  if (el && pendingFocusTextIdRef.current === item.id) {
                    pendingFocusTextIdRef.current = null;
                    requestAnimationFrame(() => {
                      el.focus();
                    });
                  }
                }}
                value={item.text ?? ""}
                placeholder={t("videoTrimmer.enterNote", "Nhập ghi chú...")}
                onChange={(e) => onChangeOverlay({ ...item, text: e.target.value })}
                onBlur={() => onCommitSnapshot?.()}
                onFocus={() => {
                  if (selectedId !== item.id) {
                    onSelect(item.id);
                  }
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(item.id);

                  // Nếu chưa chọn, cho phép vừa chọn vừa kéo rê chuột để di chuyển box ngay lập tức
                  if (!isSelected) {
                    const startX = e.clientX;
                    const startY = e.clientY;
                    const initialRel = {
                      relX: item.relX,
                      relY: item.relY,
                      relW: item.relW,
                      relH: item.relH,
                    };
                    const onMove = (moveEvent: PointerEvent) => {
                      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 4) {
                        window.removeEventListener("pointermove", onMove);
                        window.removeEventListener("pointerup", onUp);
                        setTransforming({
                          id: item.id,
                          handle: "move",
                          startX,
                          startY,
                          initialRel,
                        });
                      }
                    };
                    const onUp = () => {
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                    };
                    window.addEventListener("pointermove", onMove);
                    window.addEventListener("pointerup", onUp);
                  }
                }}
                disabled={isPlaying}
                style={{
                  width: "100%",
                  height: "100%",
                  boxSizing: "border-box",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  color: item.textColor || item.strokeColor || "#ffffff",
                  fontSize: item.fontSize || 18,
                  fontWeight: 600,
                  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  lineHeight: 1.35,
                  textShadow: "0 1px 3px rgba(0,0,0,0.85)",
                  overflow: "hidden",
                  padding: "4px 8px",
                  cursor: isSelected ? "text" : "move",
                }}
              />
            )}

            {/* Các điểm neo khi được chọn */}
            {isSelected && !isPlaying && (
              <>
                {/* Với Arrow: 2 điểm neo Start và End */}
                {item.type === "arrow" ? (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        left: `${(item.arrowStartX ?? 0.1) * 100}%`,
                        top: `${(item.arrowStartY ?? 0.1) * 100}%`,
                        transform: "translate(-50%, -50%)",
                        width: 12,
                        height: 12,
                        background: "#10b981",
                        border: "2px solid #ffffff",
                        borderRadius: "50%",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.6)",
                        pointerEvents: "auto",
                        cursor: "crosshair",
                        zIndex: 25,
                      }}
                      title={t("videoTrimmer.arrowStartPoint", "Điểm gốc mũi tên")}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                        setTransforming({
                          id: item.id,
                          handle: "arrow-start",
                          startX: e.clientX,
                          startY: e.clientY,
                          initialRel: {
                            relX: item.relX,
                            relY: item.relY,
                            relW: item.relW,
                            relH: item.relH,
                          },
                          initialArrow: {
                            sx: item.arrowStartX ?? 0.1,
                            sy: item.arrowStartY ?? 0.1,
                            ex: item.arrowEndX ?? 0.9,
                            ey: item.arrowEndY ?? 0.9,
                          },
                        });
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: `${(item.arrowEndX ?? 0.9) * 100}%`,
                        top: `${(item.arrowEndY ?? 0.9) * 100}%`,
                        transform: "translate(-50%, -50%)",
                        width: 12,
                        height: 12,
                        background: "#3b82f6",
                        border: "2px solid #ffffff",
                        borderRadius: "50%",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.6)",
                        pointerEvents: "auto",
                        cursor: "crosshair",
                        zIndex: 25,
                      }}
                      title={t("videoTrimmer.arrowEndPoint", "Điểm ngọn mũi tên")}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                        setTransforming({
                          id: item.id,
                          handle: "arrow-end",
                          startX: e.clientX,
                          startY: e.clientY,
                          initialRel: {
                            relX: item.relX,
                            relY: item.relY,
                            relW: item.relW,
                            relH: item.relH,
                          },
                          initialArrow: {
                            sx: item.arrowStartX ?? 0.1,
                            sy: item.arrowStartY ?? 0.1,
                            ex: item.arrowEndX ?? 0.9,
                            ey: item.arrowEndY ?? 0.9,
                          },
                        });
                      }}
                    />
                  </>
                ) : (
                  /* 8 Điểm neo co giãn kích thước hình chữ nhật (rect, blur, text) */
                  (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as HandleType[]).map((handle) => (
                    <div
                      key={handle}
                      style={{
                        position: "absolute",
                        width: 8,
                        height: 8,
                        background: "#3b82f6",
                        border: "1.5px solid #ffffff",
                        borderRadius: "50%",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                        pointerEvents: "auto",
                        cursor: getHandleCursor(handle),
                        zIndex: 20,
                        ...getHandlePosition(handle),
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                        setTransforming({
                          id: item.id,
                          handle,
                          startX: e.clientX,
                          startY: e.clientY,
                          initialRel: {
                            relX: item.relX,
                            relY: item.relY,
                            relW: item.relW,
                            relH: item.relH,
                          },
                        });
                      }}
                    />
                  ))
                )}

                {/* Grip di chuyển gắn trên viền đỉnh Text box khi được chọn */}
                {item.type === "text" && (
                  <div
                    style={{
                      position: "absolute",
                      top: -11,
                      left: 6,
                      background: "#3b82f6",
                      color: "#ffffff",
                      borderRadius: 3,
                      padding: "0 4px",
                      fontSize: 10,
                      cursor: "grab",
                      display: "flex",
                      alignItems: "center",
                      zIndex: 25,
                      boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
                      pointerEvents: "auto",
                      userSelect: "none",
                      height: 14,
                      lineHeight: "14px",
                    }}
                    title={t("videoTrimmer.dragToMove", "Kéo để di chuyển")}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      setTransforming({
                        id: item.id,
                        handle: "move",
                        startX: e.clientX,
                        startY: e.clientY,
                        initialRel: {
                          relX: item.relX,
                          relY: item.relY,
                          relW: item.relW,
                          relH: item.relH,
                        },
                      });
                    }}
                  >
                    ⠿
                  </div>
                )}

                {/* Thanh công cụ mini nổi trên đầu hoặc chân box */}
                <div
                  data-overlay-toolbar="true"
                  style={{
                    position: "absolute",
                    ...(item.relY < 0.12
                      ? { top: "calc(100% + 8px)" }
                      : { bottom: "calc(100% + 8px)" }),
                    ...(item.relX > 0.65 ? { right: 0 } : { left: 0 }),
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 8px",
                    background: "rgba(20, 20, 24, 0.95)",
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    borderRadius: 6,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                    pointerEvents: "auto",
                    zIndex: 30,
                    whiteSpace: "nowrap",
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {/* Grip kéo di chuyển toàn bộ box */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "grab",
                      padding: "2px 4px",
                      color: "rgba(255, 255, 255, 0.7)",
                      fontSize: 14,
                      lineHeight: 1,
                      userSelect: "none",
                    }}
                    title={t("videoTrimmer.dragToMove", "Kéo để di chuyển")}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      setTransforming({
                        id: item.id,
                        handle: "move",
                        startX: e.clientX,
                        startY: e.clientY,
                        initialRel: {
                          relX: item.relX,
                          relY: item.relY,
                          relW: item.relW,
                          relH: item.relH,
                        },
                      });
                    }}
                  >
                    ⠿
                  </div>
                  <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.2)" }} />

                  {/* Màu sắc chung (cho rect, arrow, text) */}
                  {(item.type === "rect" || item.type === "arrow" || item.type === "text") && (
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {OVERLAY_COLORS.map((c) => {
                        const isCurrentColor =
                          item.type === "text"
                            ? (item.textColor || item.strokeColor) === c
                            : item.strokeColor === c;
                        return (
                          <button
                            key={c}
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: "50%",
                              background: c,
                              border: isCurrentColor ? "2px solid #ffffff" : "1px solid rgba(0,0,0,0.3)",
                              padding: 0,
                              cursor: "pointer",
                              outline: "none",
                              boxShadow: isCurrentColor ? "0 0 0 1px #3b82f6" : "none",
                            }}
                            onClick={() => {
                              onCommitSnapshot?.();
                              if (item.type === "text") {
                                onChangeOverlay({ ...item, textColor: c, strokeColor: c });
                              } else {
                                onChangeOverlay({ ...item, strokeColor: c });
                              }
                            }}
                            title={c}
                          />
                        );
                      })}
                    </div>
                  )}

                  {/* Độ dày nét vẽ cho rect và arrow */}
                  {(item.type === "rect" || item.type === "arrow") && (
                    <>
                      <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.2)" }} />
                      <div style={{ display: "flex", gap: 3 }}>
                        {OVERLAY_STROKE_WIDTHS.map((w) => (
                          <button
                            key={w}
                            style={{
                              padding: "2px 5px",
                              fontSize: 11,
                              borderRadius: 3,
                              border: "none",
                              background: item.strokeWidth === w ? "rgba(59,130,246,0.5)" : "transparent",
                              color: item.strokeWidth === w ? "#ffffff" : "rgba(255,255,255,0.7)",
                              cursor: "pointer",
                              fontWeight: item.strokeWidth === w ? 600 : 400,
                            }}
                            onClick={() => {
                              onCommitSnapshot?.();
                              onChangeOverlay({ ...item, strokeWidth: w });
                            }}
                            title={`${w}px`}
                          >
                            {w}px
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* Cỡ chữ và Nền cho Text */}
                  {item.type === "text" && (
                    <>
                      <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.2)" }} />
                      <OverlayFontSizeInput
                        value={item.fontSize || 18}
                        onChange={(sz) => onChangeOverlay({ ...item, fontSize: sz })}
                        onCommit={onCommitSnapshot}
                      />
                      <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.2)" }} />
                      <button
                        style={{
                          padding: "3px 7px",
                          fontSize: 11,
                          borderRadius: 4,
                          border: "none",
                          background: item.hasBackground !== false ? "rgba(59,130,246,0.6)" : "rgba(255,255,255,0.1)",
                          color: "#ffffff",
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                        onClick={() => {
                          onCommitSnapshot?.();
                          onChangeOverlay({ ...item, hasBackground: item.hasBackground === false });
                        }}
                        title={t("videoTrimmer.toggleBackground", "Bật/Tắt nền mờ")}
                      >
                        {item.hasBackground !== false ? t("videoTrimmer.badgeOn", "Nền: Bật") : t("videoTrimmer.badgeOff", "Nền: Tắt")}
                      </button>
                    </>
                  )}

                  {/* Chế độ Che mờ (Blur) vs Hộp đen (Blackout) */}
                  {item.type === "blur" && (
                    <>
                      <button
                        style={{
                          padding: "3px 8px",
                          fontSize: 11,
                          borderRadius: 4,
                          border: "none",
                          background: !item.isBlackout ? "rgba(59,130,246,0.6)" : "rgba(255,255,255,0.1)",
                          color: "#ffffff",
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                        onClick={() => {
                          onCommitSnapshot?.();
                          onChangeOverlay({ ...item, isBlackout: false });
                        }}
                      >
                        {t("videoTrimmer.blurSoft", "Mờ sương")}
                      </button>
                      <button
                        style={{
                          padding: "3px 8px",
                          fontSize: 11,
                          borderRadius: 4,
                          border: "none",
                          background: item.isBlackout ? "rgba(59,130,246,0.6)" : "rgba(255,255,255,0.1)",
                          color: "#ffffff",
                          cursor: "pointer",
                          fontWeight: 500,
                        }}
                        onClick={() => {
                          onCommitSnapshot?.();
                          onChangeOverlay({ ...item, isBlackout: true });
                        }}
                      >
                        {t("videoTrimmer.blurBlackout", "Hộp đen")}
                      </button>
                    </>
                  )}

                  <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.2)" }} />

                  {/* Nút xoá nhanh */}
                  <button
                    style={{
                      padding: "2px 5px",
                      fontSize: 12,
                      borderRadius: 3,
                      border: "none",
                      background: "transparent",
                      color: "#f87171",
                      cursor: "pointer",
                    }}
                    onClick={() => onDeleteOverlay(item.id)}
                    title={t("videoTrimmer.deleteOverlay", "Xoá")}
                  >
                    🗑️
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}

      {/* Khung / Mũi tên đang vẽ dở (Draft) */}
      {drawing && (
        <>
          {tool === "arrow" ? (
            <svg
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                filter: "drop-shadow(0 2px 5px rgba(0,0,0,0.65))",
              }}
            >
              {(() => {
                const sx = drawing.startX;
                const sy = drawing.startY;
                const ex = drawing.currentX;
                const ey = drawing.currentY;
                const dx = ex - sx;
                const dy = ey - sy;
                const angle = Math.atan2(dy, dx);
                const strokeW = 3;
                const headLen = strokeW * 4.5;
                const color = "#ef4444";

                const pTip = `${ex},${ey}`;
                const pLeft = `${ex - headLen * Math.cos(angle - Math.PI / 6)},${ey - headLen * Math.sin(angle - Math.PI / 6)}`;
                const pNotch = `${ex - headLen * 0.5 * Math.cos(angle)},${ey - headLen * 0.5 * Math.sin(angle)}`;
                const pRight = `${ex - headLen * Math.cos(angle + Math.PI / 6)},${ey - headLen * Math.sin(angle + Math.PI / 6)}`;

                const endLineX = ex - headLen * 0.6 * Math.cos(angle);
                const endLineY = ey - headLen * 0.6 * Math.sin(angle);

                return (
                  <g>
                    <line
                      x1={sx}
                      y1={sy}
                      x2={endLineX}
                      y2={endLineY}
                      stroke={color}
                      strokeWidth={strokeW}
                      strokeLinecap="round"
                    />
                    <polygon points={`${pTip} ${pLeft} ${pNotch} ${pRight}`} fill={color} />
                  </g>
                );
              })()}
            </svg>
          ) : tool === "text" ? (
            <div
              style={{
                position: "absolute",
                left: Math.min(drawing.startX, drawing.currentX),
                top: Math.min(drawing.startY, drawing.currentY),
                width: Math.max(150, Math.abs(drawing.currentX - drawing.startX)),
                height: Math.max(44, Math.abs(drawing.currentY - drawing.startY)),
                pointerEvents: "none",
                borderRadius: 6,
                background: "rgba(18, 18, 22, 0.85)",
                border: "1.5px dashed #3b82f6",
                display: "flex",
                alignItems: "center",
                padding: "4px 8px",
                color: "rgba(255, 255, 255, 0.6)",
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              {t("videoTrimmer.enterNote", "Nhập ghi chú...")}
            </div>
          ) : (
            <div
              style={{
                position: "absolute",
                left: Math.min(drawing.startX, drawing.currentX),
                top: Math.min(drawing.startY, drawing.currentY),
                width: Math.abs(drawing.currentX - drawing.startX),
                height: Math.abs(drawing.currentY - drawing.startY),
                pointerEvents: "none",
                borderRadius: 4,
                ...(tool === "rect"
                  ? {
                      border: "2px solid #ef4444",
                      background: "rgba(239, 68, 68, 0.15)",
                    }
                  : {
                      backdropFilter: "blur(12px)",
                      WebkitBackdropFilter: "blur(12px)",
                      border: "1.5px dashed rgba(255,255,255,0.8)",
                      background: "rgba(255, 255, 255, 0.1)",
                    }),
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function getHandleCursor(handle: HandleType): string {
  switch (handle) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "crosshair";
  }
}

function getHandlePosition(handle: HandleType): React.CSSProperties {
  const half = -4;
  switch (handle) {
    case "nw":
      return { top: half, left: half };
    case "n":
      return { top: half, left: "50%", transform: "translateX(-50%)" };
    case "ne":
      return { top: half, right: half };
    case "e":
      return { top: "50%", right: half, transform: "translateY(-50%)" };
    case "se":
      return { bottom: half, right: half };
    case "s":
      return { bottom: half, left: "50%", transform: "translateX(-50%)" };
    case "sw":
      return { bottom: half, left: half };
    case "w":
      return { top: "50%", left: half, transform: "translateY(-50%)" };
    default:
      return {};
  }
}
