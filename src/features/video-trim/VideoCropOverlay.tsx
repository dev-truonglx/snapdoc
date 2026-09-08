import React, { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { VideoCrop } from "./types";

interface VideoCropOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  initialCrop: VideoCrop | null;
  onApply: (crop: VideoCrop) => void;
  onCancel: () => void;
  onReset: () => void;
}

type AspectRatioPreset = "free" | "16:9" | "9:16" | "1:1" | "4:3";

type HandleType = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

interface Rect01 {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export default function VideoCropOverlay({
  videoRef,
  initialCrop,
  onApply,
  onCancel,
  onReset,
}: VideoCropOverlayProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [videoRect, setVideoRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [preset, setPreset] = useState<AspectRatioPreset>("free");

  // Kích thước thật của file video (px)
  const [videoDim, setVideoDim] = useState({ w: 0, h: 0 });

  // Tọa độ crop chuẩn hoá [0..1]
  const [crop01, setCrop01] = useState<Rect01>(() => {
    return { x: 0, y: 0, w: 1, h: 1 };
  });

  // Khởi tạo toạ độ từ initialCrop nếu có
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const vw = video.videoWidth || (video as any).naturalWidth || 0;
    const vh = video.videoHeight || (video as any).naturalHeight || 0;
    if (vw > 0 && vh > 0) {
      setVideoDim({ w: vw, h: vh });
      if (initialCrop) {
        setCrop01({
          x: clamp01(initialCrop.x / vw),
          y: clamp01(initialCrop.y / vh),
          w: clamp01(initialCrop.width / vw),
          h: clamp01(initialCrop.height / vh),
        });
      } else {
        setCrop01({ x: 0, y: 0, w: 1, h: 1 });
      }
    }
  }, [videoRef, initialCrop]);

  // Cập nhật vị trí khung video trong container (tính cả letterboxing)
  const updateRect = useCallback(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vw = video.videoWidth || (video as any).naturalWidth || 0;
    const vh = video.videoHeight || (video as any).naturalHeight || 0;

    if (!cw || !ch) return;
    if (vw > 0 && vh > 0 && (videoDim.w !== vw || videoDim.h !== vh)) {
      setVideoDim({ w: vw, h: vh });
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
    setVideoRect({
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(w),
      height: Math.round(h),
    });
  }, [videoRef, videoDim.w, videoDim.h]);

  useEffect(() => {
    updateRect();
    const video = videoRef.current;
    if (!video) return;

    const ro = new ResizeObserver(updateRect);
    ro.observe(video);
    if (video.parentElement) ro.observe(video.parentElement);

    const events = ["loadedmetadata", "loadeddata", "canplay", "resize"];
    events.forEach((ev) => video.addEventListener(ev, updateRect));

    return () => {
      ro.disconnect();
      events.forEach((ev) => video.removeEventListener(ev, updateRect));
    };
  }, [updateRect, videoRef]);

  // Xử lý áp dụng Preset tỉ lệ khung hình
  const applyPreset = (p: AspectRatioPreset) => {
    setPreset(p);
    if (p === "free") return;

    let targetRatio = 16 / 9;
    if (p === "16:9") targetRatio = 16 / 9;
    else if (p === "9:16") targetRatio = 9 / 16;
    else if (p === "1:1") targetRatio = 1;
    else if (p === "4:3") targetRatio = 4 / 3;

    const vw = videoDim.w || 1920;
    const vh = videoDim.h || 1080;
    const currentVideoRatio = vw / vh;

    // targetRatio normalized = targetRatio / currentVideoRatio
    const normRatio = targetRatio / currentVideoRatio;

    setCrop01((cur) => {
      let w = cur.w;
      let h = cur.h;

      if (normRatio >= 1) {
        // Rộng hơn cao
        w = Math.min(1, cur.h * normRatio);
        h = w / normRatio;
        if (w > 1) {
          w = 1;
          h = 1 / normRatio;
        }
      } else {
        // Cao hơn rộng
        h = Math.min(1, cur.w / normRatio);
        w = h * normRatio;
        if (h > 1) {
          h = 1;
          w = normRatio;
        }
      }

      // Giữ tâm khung hình
      const centerX = cur.x + cur.w / 2;
      const centerY = cur.y + cur.h / 2;
      let x = centerX - w / 2;
      let y = centerY - h / 2;

      if (x < 0) x = 0;
      if (y < 0) y = 0;
      if (x + w > 1) x = 1 - w;
      if (y + h > 1) y = 1 - h;

      return { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };
    });
  };

  // Kéo di chuyển hoặc co giãn
  const [dragging, setDragging] = useState<{
    handle: HandleType;
    startX: number;
    startY: number;
    initialCrop: Rect01;
  } | null>(null);

  const onPointerDownHandle = (e: React.PointerEvent, handle: HandleType) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging({
      handle,
      startX: e.clientX,
      startY: e.clientY,
      initialCrop: { ...crop01 },
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !videoRect.width || !videoRect.height) return;

    const dx = (e.clientX - dragging.startX) / videoRect.width;
    const dy = (e.clientY - dragging.startY) / videoRect.height;
    const init = dragging.initialCrop;

    if (dragging.handle === "move") {
      let newX = init.x + dx;
      let newY = init.y + dy;
      if (newX < 0) newX = 0;
      if (newY < 0) newY = 0;
      if (newX + init.w > 1) newX = 1 - init.w;
      if (newY + init.h > 1) newY = 1 - init.h;
      setCrop01((c) => ({ ...c, x: newX, y: newY }));
      return;
    }

    const vw = videoDim.w || 1920;
    const vh = videoDim.h || 1080;
    const currentVideoRatio = vw / vh;
    let targetRatio: number | null = null;
    if (preset === "16:9") targetRatio = 16 / 9;
    else if (preset === "9:16") targetRatio = 9 / 16;
    else if (preset === "1:1") targetRatio = 1;
    else if (preset === "4:3") targetRatio = 4 / 3;

    const normRatio = targetRatio !== null ? targetRatio / currentVideoRatio : null;

    let left = init.x;
    let top = init.y;
    let right = init.x + init.w;
    let bottom = init.y + init.h;

    const h = dragging.handle;

    if (h.includes("w")) left = Math.min(right - 0.05, Math.max(0, init.x + dx));
    if (h.includes("e")) right = Math.max(left + 0.05, Math.min(1, init.x + init.w + dx));
    if (h.includes("n")) top = Math.min(bottom - 0.05, Math.max(0, init.y + dy));
    if (h.includes("s")) bottom = Math.max(top + 0.05, Math.min(1, init.y + init.h + dy));

    let newW = right - left;
    let newH = bottom - top;

    // Nếu có preset cố định tỉ lệ
    if (normRatio !== null) {
      if (h === "e" || h === "w") {
        newH = newW / normRatio;
        if (top + newH > 1) {
          newH = 1 - top;
          newW = newH * normRatio;
          if (h === "w") left = right - newW;
        }
      } else if (h === "n" || h === "s") {
        newW = newH * normRatio;
        if (left + newW > 1) {
          newW = 1 - left;
          newH = newW / normRatio;
          if (h === "n") top = bottom - newH;
        }
      } else {
        // Góc (nw, ne, se, sw)
        const curRatio = newW / newH;
        if (curRatio > normRatio) {
          newW = newH * normRatio;
          if (h.includes("w")) left = right - newW;
        } else {
          newH = newW / normRatio;
          if (h.includes("n")) top = bottom - newH;
        }
      }
    }

    setCrop01({
      x: clamp01(left),
      y: clamp01(top),
      w: clamp01(newW),
      h: clamp01(newH),
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragging) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setDragging(null);
    }
  };

  // Tính toán toạ độ pixel thực tế và làm tròn chẵn (even dimensions)
  const vw = videoDim.w || 1920;
  const vh = videoDim.h || 1080;
  const pixelW = Math.max(2, Math.floor((crop01.w * vw) / 2) * 2);
  const pixelH = Math.max(2, Math.floor((crop01.h * vh) / 2) * 2);
  let pixelX = Math.max(0, Math.round(crop01.x * vw));
  let pixelY = Math.max(0, Math.round(crop01.y * vh));
  if (pixelX + pixelW > vw) pixelX = Math.max(0, vw - pixelW);
  if (pixelY + pixelH > vh) pixelY = Math.max(0, vh - pixelH);

  const handleApply = () => {
    // Nếu crop bao trọn 100% video
    if (pixelX === 0 && pixelY === 0 && pixelW >= vw - 2 && pixelH >= vh - 2) {
      onReset();
      return;
    }
    onApply({
      x: pixelX,
      y: pixelY,
      width: pixelW,
      height: pixelH,
    });
  };

  const handleResetToFull = () => {
    setPreset("free");
    setCrop01({ x: 0, y: 0, w: 1, h: 1 });
  };

  // Toạ độ hiển thị trên màn hình
  const boxLeft = videoRect.left + crop01.x * videoRect.width;
  const boxTop = videoRect.top + crop01.y * videoRect.height;
  const boxWidth = crop01.w * videoRect.width;
  const boxHeight = crop01.h * videoRect.height;

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* 4 vùng mờ (Scrim) xung quanh vùng crop */}
      {videoRect.width > 0 && (
        <>
          {/* Trên */}
          <div
            style={{
              ...scrimStyle,
              left: videoRect.left,
              top: videoRect.top,
              width: videoRect.width,
              height: Math.max(0, boxTop - videoRect.top),
            }}
          />
          {/* Dưới */}
          <div
            style={{
              ...scrimStyle,
              left: videoRect.left,
              top: boxTop + boxHeight,
              width: videoRect.width,
              height: Math.max(0, videoRect.top + videoRect.height - (boxTop + boxHeight)),
            }}
          />
          {/* Trái */}
          <div
            style={{
              ...scrimStyle,
              left: videoRect.left,
              top: boxTop,
              width: Math.max(0, boxLeft - videoRect.left),
              height: boxHeight,
            }}
          />
          {/* Phải */}
          <div
            style={{
              ...scrimStyle,
              left: boxLeft + boxWidth,
              top: boxTop,
              width: Math.max(0, videoRect.left + videoRect.width - (boxLeft + boxWidth)),
              height: boxHeight,
            }}
          />
        </>
      )}

      {/* Hộp chữ nhật Crop Box */}
      {videoRect.width > 0 && (
        <div
          style={{
            position: "absolute",
            left: boxLeft,
            top: boxTop,
            width: boxWidth,
            height: boxHeight,
            boxSizing: "border-box",
            border: "1.5px solid #3b82f6",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.2)",
            cursor: dragging?.handle === "move" ? "grabbing" : "grab",
          }}
          onPointerDown={(e) => onPointerDownHandle(e, "move")}
        >
          {/* Đường lưới 3x3 (Rule of Thirds) */}
          <div style={gridH1} />
          <div style={gridH2} />
          <div style={gridV1} />
          <div style={gridV2} />

          {/* 8 chốt kéo handles */}
          {/* 4 góc */}
          <div style={{ ...handleCorner, left: -6, top: -6, cursor: "nwse-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "nw")} />
          <div style={{ ...handleCorner, right: -6, top: -6, cursor: "nesw-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "ne")} />
          <div style={{ ...handleCorner, right: -6, bottom: -6, cursor: "nwse-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "se")} />
          <div style={{ ...handleCorner, left: -6, bottom: -6, cursor: "nesw-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "sw")} />

          {/* 4 cạnh */}
          <div style={{ ...handleEdgeH, left: "50%", top: -4, transform: "translateX(-50%)", cursor: "ns-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "n")} />
          <div style={{ ...handleEdgeH, left: "50%", bottom: -4, transform: "translateX(-50%)", cursor: "ns-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "s")} />
          <div style={{ ...handleEdgeV, top: "50%", left: -4, transform: "translateY(-50%)", cursor: "ew-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "w")} />
          <div style={{ ...handleEdgeV, top: "50%", right: -4, transform: "translateY(-50%)", cursor: "ew-resize" }} onPointerDown={(e) => onPointerDownHandle(e, "e")} />

          {/* Badge độ phân giải thời gian thực */}
          <div style={dimBadge}>
            {pixelW} × {pixelH} px
          </div>
        </div>
      )}

      {/* Floating Toolbar ở phía dưới hoặc trên khung nhìn */}
      <div style={toolbarCard}>
        {/* Nhóm tỉ lệ Presets */}
        <div style={presetGroup}>
          <span style={toolbarLabel}>{t("videoTrimmer.cropRatio", "Tỉ lệ")}:</span>
          <button
            type="button"
            style={preset === "free" ? presetBtnActive : presetBtn}
            onClick={() => applyPreset("free")}
          >
            {t("videoTrimmer.cropFree", "Tự do")}
          </button>
          <button
            type="button"
            style={preset === "16:9" ? presetBtnActive : presetBtn}
            onClick={() => applyPreset("16:9")}
          >
            16:9
          </button>
          <button
            type="button"
            style={preset === "9:16" ? presetBtnActive : presetBtn}
            onClick={() => applyPreset("9:16")}
          >
            9:16
          </button>
          <button
            type="button"
            style={preset === "1:1" ? presetBtnActive : presetBtn}
            onClick={() => applyPreset("1:1")}
          >
            1:1
          </button>
          <button
            type="button"
            style={preset === "4:3" ? presetBtnActive : presetBtn}
            onClick={() => applyPreset("4:3")}
          >
            4:3
          </button>
        </div>

        <div style={divider} />

        {/* Nút Đặt lại về 100% */}
        <button
          type="button"
          style={actionBtnGhost}
          onClick={handleResetToFull}
          title={t("videoTrimmer.resetCrop", "Đặt lại toàn khung hình")}
        >
          {t("videoTrimmer.resetButton", "Đặt lại")}
        </button>

        {/* Nút Huỷ */}
        <button
          type="button"
          style={actionBtnSecondary}
          onClick={onCancel}
        >
          {t("common.cancel", "Huỷ")}
        </button>

        {/* Nút Áp dụng */}
        <button
          type="button"
          style={actionBtnPrimary}
          onClick={handleApply}
        >
          {t("videoTrimmer.applyCrop", "Áp dụng")}
        </button>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 40,
  pointerEvents: "auto",
  userSelect: "none",
  touchAction: "none",
};

const scrimStyle: React.CSSProperties = {
  position: "absolute",
  background: "rgba(0, 0, 0, 0.65)",
  pointerEvents: "auto",
};

const gridLineBase: React.CSSProperties = {
  position: "absolute",
  pointerEvents: "none",
  borderStyle: "dashed",
  borderColor: "rgba(255, 255, 255, 0.3)",
};

const gridH1: React.CSSProperties = {
  ...gridLineBase,
  left: 0,
  right: 0,
  top: "33.333%",
  borderTopWidth: 1,
};

const gridH2: React.CSSProperties = {
  ...gridLineBase,
  left: 0,
  right: 0,
  top: "66.666%",
  borderTopWidth: 1,
};

const gridV1: React.CSSProperties = {
  ...gridLineBase,
  top: 0,
  bottom: 0,
  left: "33.333%",
  borderLeftWidth: 1,
};

const gridV2: React.CSSProperties = {
  ...gridLineBase,
  top: 0,
  bottom: 0,
  left: "66.666%",
  borderLeftWidth: 1,
};

const handleCorner: React.CSSProperties = {
  position: "absolute",
  width: 12,
  height: 12,
  background: "#ffffff",
  border: "2px solid #2563eb",
  borderRadius: 2,
  boxSizing: "border-box",
  zIndex: 2,
};

const handleEdgeH: React.CSSProperties = {
  position: "absolute",
  width: 24,
  height: 8,
  background: "#ffffff",
  border: "1.5px solid #2563eb",
  borderRadius: 3,
  boxSizing: "border-box",
  zIndex: 2,
};

const handleEdgeV: React.CSSProperties = {
  position: "absolute",
  width: 8,
  height: 24,
  background: "#ffffff",
  border: "1.5px solid #2563eb",
  borderRadius: 3,
  boxSizing: "border-box",
  zIndex: 2,
};

const dimBadge: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(0, 0, 0, 0.75)",
  color: "#f8fafc",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  whiteSpace: "nowrap",
  pointerEvents: "none",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
};

const toolbarCard: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  background: "#1e1e24",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  borderRadius: 8,
  padding: "6px 12px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
  zIndex: 50,
};

const presetGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const toolbarLabel: React.CSSProperties = {
  fontSize: 12,
  color: "#94a3b8",
  marginRight: 4,
  fontWeight: 500,
};

const presetBtn: React.CSSProperties = {
  padding: "4px 8px",
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 4,
  color: "#cbd5e1",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const presetBtnActive: React.CSSProperties = {
  ...presetBtn,
  background: "#2563eb",
  borderColor: "#3b82f6",
  color: "#ffffff",
};

const divider: React.CSSProperties = {
  width: 1,
  height: 18,
  background: "rgba(255, 255, 255, 0.15)",
  margin: "0 4px",
};

const actionBtnGhost: React.CSSProperties = {
  padding: "4px 10px",
  background: "transparent",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  borderRadius: 5,
  color: "#cbd5e1",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const actionBtnSecondary: React.CSSProperties = {
  padding: "4px 12px",
  background: "rgba(255, 255, 255, 0.1)",
  border: "none",
  borderRadius: 5,
  color: "#e2e8f0",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const actionBtnPrimary: React.CSSProperties = {
  padding: "4px 14px",
  background: "#2563eb",
  border: "none",
  borderRadius: 5,
  color: "#ffffff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 2px 4px rgba(37, 99, 235, 0.3)",
};
