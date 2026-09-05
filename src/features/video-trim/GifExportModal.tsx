import { useEffect, useRef, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ipc, type GifExportOptions } from "../../lib/ipc";
import { promptSaveGifPath, stampGifName, dirnameOf } from "../output/useOutput";
import type { Segment } from "./segments";

export interface GifExportModalProps {
  open: boolean;
  onClose: () => void;
  filePath: string;
  videoSrc: string;
  durationMs: number;
  selectedSegment: Segment | null;
  sourceHistoryId?: string;
  onFlash?: (msg: string) => void;
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, "0")}.${ms}`;
}

export default function GifExportModal({
  open,
  onClose,
  filePath,
  videoSrc,
  durationMs,
  selectedSegment,
  sourceHistoryId,
  onFlash,
}: GifExportModalProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);

  // Scope: 'selected' | 'all' | 'custom'
  const [scope, setScope] = useState<"selected" | "all" | "custom">(() =>
    selectedSegment ? "selected" : "all",
  );

  // Range in seconds
  const totalSec = Math.max(0.1, durationMs / 1000);
  const [startSec, setStartSec] = useState<number>(0);
  const [endSec, setEndSec] = useState<number>(totalSec);

  // Settings
  const [fps, setFps] = useState<number>(15);
  const [resolution, setResolution] = useState<number | null>(1280); // null = original, or max width
  const [speed, setSpeed] = useState<number>(1.0);
  const [loopForever, setLoopForever] = useState<boolean>(true);

  // Progress & busy
  const [busy, setBusy] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [statusMsg, setStatusMsg] = useState<string>("");

  // Timeline dragging & playback
  const [previewCurSec, setPreviewCurSec] = useState<number>(0);
  const [dragMode, setDragMode] = useState<"start" | "end" | "move" | null>(null);
  const dragOriginRef = useRef<{
    clientX: number;
    startSec: number;
    endSec: number;
  }>({ clientX: 0, startSec: 0, endSec: 0 });
  const trackBarRef = useRef<HTMLDivElement>(null);

  // Initialize start/end when modal opens or selected segment changes
  useEffect(() => {
    if (!open) return;
    if (selectedSegment) {
      setScope("selected");
      setStartSec(selectedSegment.srcStart / 1000);
      setEndSec(selectedSegment.srcEnd / 1000);
    } else {
      setScope("all");
      setStartSec(0);
      setEndSec(totalSec);
    }
    setProgress(0);
    setBusy(false);
  }, [open, selectedSegment, totalSec]);

  // Handle scope switch
  const handleScopeChange = (newScope: "selected" | "all" | "custom") => {
    setScope(newScope);
    if (newScope === "selected" && selectedSegment) {
      setStartSec(selectedSegment.srcStart / 1000);
      setEndSec(selectedSegment.srcEnd / 1000);
    } else if (newScope === "all") {
      setStartSec(0);
      setEndSec(totalSec);
    }
  };

  // Listen to Tauri progress event
  useEffect(() => {
    if (!open) return;
    const unlistenPromise = listen<number>("gif-export-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [open]);

  // Video looping preview logic
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    v.playbackRate = speed;
    v.currentTime = startSec;
    v.play().catch(() => {});

    const onTimeUpdate = () => {
      if (v.currentTime >= endSec || v.currentTime < startSec) {
        v.currentTime = startSec;
        v.play().catch(() => {});
      }
      setPreviewCurSec(v.currentTime);
    };

    v.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      v.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [startSec, endSec, speed, open]);

  // Range math & percentages (0% -> 100%)
  const startPct = Math.max(0, Math.min(100, (startSec / totalSec) * 100));
  const endPct = Math.max(0, Math.min(100, (endSec / totalSec) * 100));
  const playheadPct = Math.max(0, Math.min(100, (previewCurSec / totalSec) * 100));

  const handlePointerDown = (
    mode: "start" | "end" | "move",
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (busy) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragMode(mode);
    dragOriginRef.current = {
      clientX: e.clientX,
      startSec,
      endSec,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragMode || !trackBarRef.current) return;
    const rect = trackBarRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;

    const { clientX: origX, startSec: origStart, endSec: origEnd } = dragOriginRef.current;
    const deltaSec = ((e.clientX - origX) / rect.width) * totalSec;

    if (dragMode === "start") {
      const raw = origStart + deltaSec;
      const clamped = Math.max(0, Math.min(raw, origEnd - 0.2));
      setStartSec(Number(clamped.toFixed(2)));
      setScope("custom");
    } else if (dragMode === "end") {
      const raw = origEnd + deltaSec;
      const clamped = Math.min(totalSec, Math.max(raw, origStart + 0.2));
      setEndSec(Number(clamped.toFixed(2)));
      setScope("custom");
    } else if (dragMode === "move") {
      const dur = origEnd - origStart;
      let newStart = origStart + deltaSec;
      newStart = Math.max(0, Math.min(newStart, totalSec - dur));
      const newEnd = newStart + dur;
      setStartSec(Number(newStart.toFixed(2)));
      setEndSec(Number(newEnd.toFixed(2)));
      setScope("custom");
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setDragMode(null);
    }
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (busy || dragMode || !trackBarRef.current) return;
    const rect = trackBarRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const clickPct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickSec = clickPct * totalSec;

    const distToStart = Math.abs(clickSec - startSec);
    const distToEnd = Math.abs(clickSec - endSec);
    if (distToStart < distToEnd) {
      const clamped = Math.max(0, Math.min(clickSec, endSec - 0.2));
      setStartSec(Number(clamped.toFixed(2)));
    } else {
      const clamped = Math.min(totalSec, Math.max(clickSec, startSec + 0.2));
      setEndSec(Number(clamped.toFixed(2)));
    }
    setScope("custom");
  };


  // Calculated duration
  const clipDurationSec = Math.max(0.1, endSec - startSec);
  const isLongWarning = clipDurationSec > 20;

  // Estimated size in MB: approx (durSec / speed) * fps * (pixelCount / 1M) * ~0.15 MB
  const estSizeMb = useMemo(() => {
    const playDur = clipDurationSec / speed;
    const frames = playDur * fps;
    const w = resolution ?? 1280;
    const h = (w * 9) / 16; // approximate 16:9 ratio
    const mb = (frames * w * h * 0.00000028).toFixed(1);
    return Math.max(0.2, Number(mb));
  }, [clipDurationSec, speed, fps, resolution]);

  if (!open) return null;

  const buildOptions = (): GifExportOptions => ({
    startMs: Math.round(startSec * 1000),
    durationMs: Math.round(clipDurationSec * 1000),
    fps,
    maxWidth: resolution,
    speed,
    loopCount: loopForever ? 0 : -1,
  });

  // Action: Save As .gif
  const handleSaveAs = async () => {
    const settings = await ipc.getSettings().catch(() => null);
    const dir = settings?.lastGifSaveAsDir || settings?.saveDir || (await ipc.defaultSaveDir());
    const defaultPath = dir ? `${dir}/${stampGifName()}.gif` : `${stampGifName()}.gif`;

    const savePath = await promptSaveGifPath(defaultPath);
    if (!savePath) return;

    setBusy(true);
    setProgress(0);
    setStatusMsg(t("gifExport.exporting"));

    try {
      await ipc.exportVideoGif(filePath, savePath, buildOptions());
      if (settings) {
        ipc.setSettings({ ...settings, lastGifSaveAsDir: dirnameOf(savePath) }).catch(() => {});
      }
      onFlash?.(t("gifExport.savedToast"));
      onClose();
    } catch (e) {
      console.error("Export GIF error:", e);
      onFlash?.(`${t("gifExport.exportFailed")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Action: Copy GIF to clipboard
  const handleCopy = async () => {
    setBusy(true);
    setProgress(0);
    setStatusMsg(t("gifExport.exporting"));

    try {
      const settings = await ipc.getSettings().catch(() => null);
      const dir = settings?.saveDir || (await ipc.defaultSaveDir());
      const tempOut = `${dir}/.clip_${stampGifName()}.gif`;

      await ipc.exportVideoGif(filePath, tempOut, buildOptions());
      await ipc.copyGifToClipboard(tempOut);

      // Webview dual-clipboard fallback if supported
      try {
        const res = await fetch(convertFileSrc(tempOut));
        const blob = await res.blob();
        if (navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        }
      } catch {
        // native copyGifToClipboard already handled it
      }

      onFlash?.(t("gifExport.copiedToast"));
      onClose();
    } catch (e) {
      console.error("Copy GIF error:", e);
      onFlash?.(`${t("gifExport.exportFailed")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Action: Save to Library
  const handleSaveToLibrary = async () => {
    setBusy(true);
    setProgress(0);
    setStatusMsg(t("gifExport.exporting"));

    try {
      const settings = await ipc.getSettings().catch(() => null);
      const dir = settings?.saveDir || (await ipc.defaultSaveDir());
      const outPath = `${dir}/${stampGifName()}.gif`;

      await ipc.exportVideoGif(filePath, outPath, buildOptions());
      await ipc.saveGifToHistory(
        sourceHistoryId ?? null,
        outPath,
        Math.round(clipDurationSec * 1000),
      );

      onFlash?.(t("gifExport.savedLibraryToast"));
      onClose();
    } catch (e) {
      console.error("Save GIF to Library error:", e);
      onFlash?.(`${t("gifExport.exportFailed")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={busy ? undefined : onClose}>
      <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={titleWrapStyle}>
            <span style={badgeStyle}>GIF</span>
            <h3 style={titleStyle}>{t("gifExport.title")}</h3>
          </div>
          <button
            style={closeBtnStyle}
            disabled={busy}
            onClick={onClose}
            title={t("gifExport.cancel")}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {/* Looping video preview */}
          <div style={previewWrapStyle}>
            <video
              ref={videoRef}
              src={videoSrc}
              muted
              playsInline
              style={videoElementStyle}
            />
            <div style={previewBadgeStyle}>
              ▶ {fmtSec(startSec)} – {fmtSec(endSec)} ({clipDurationSec.toFixed(1)}s) • {speed}x
            </div>
          </div>

          {/* Scope selection */}
          <div style={sectionStyle}>
            <div style={labelStyle}>{t("gifExport.scopeTitle")}</div>
            <div style={segmentedGroupStyle}>
              {selectedSegment && (
                <button
                  type="button"
                  style={{
                    ...segmentBtnStyle,
                    ...(scope === "selected" ? segmentBtnActiveStyle : null),
                  }}
                  onClick={() => handleScopeChange("selected")}
                  disabled={busy}
                >
                  {t("gifExport.scopeSelected")} (
                  {((selectedSegment.srcEnd - selectedSegment.srcStart) / 1000).toFixed(1)}s)
                </button>
              )}
              <button
                type="button"
                style={{
                  ...segmentBtnStyle,
                  ...(scope === "all" ? segmentBtnActiveStyle : null),
                }}
                onClick={() => handleScopeChange("all")}
                disabled={busy}
              >
                {t("gifExport.scopeAll")} ({totalSec.toFixed(1)}s)
              </button>
              <button
                type="button"
                style={{
                  ...segmentBtnStyle,
                  ...(scope === "custom" ? segmentBtnActiveStyle : null),
                }}
                onClick={() => handleScopeChange("custom")}
                disabled={busy}
              >
                {t("gifExport.scopeCustom")}
              </button>
            </div>
          </div>

          {/* Range Slider / Controls */}
          <div style={sectionStyle}>
            <div style={timeRowStyle}>
              <div style={timeInputWrapStyle}>
                <span style={timeLabelStyle}>{t("gifExport.startTime")}</span>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={Math.max(0, endSec - 0.2)}
                  value={Number(startSec.toFixed(1))}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(Number(e.target.value), endSec - 0.2));
                    setStartSec(v);
                    setScope("custom");
                  }}
                  disabled={busy}
                  style={timeInputStyle}
                />
                <span style={timeUnitStyle}>s ({fmtSec(startSec)})</span>
              </div>

              <div style={timeInputWrapStyle}>
                <span style={timeLabelStyle}>{t("gifExport.endTime")}</span>
                <input
                  type="number"
                  step="0.1"
                  min={startSec + 0.2}
                  max={totalSec}
                  value={Number(endSec.toFixed(1))}
                  onChange={(e) => {
                    const v = Math.min(totalSec, Math.max(startSec + 0.2, Number(e.target.value)));
                    setEndSec(v);
                    setScope("custom");
                  }}
                  disabled={busy}
                  style={timeInputStyle}
                />
                <span style={timeUnitStyle}>s ({fmtSec(endSec)})</span>
              </div>
            </div>

            {/* Unified Single Timeline Track (sát 2 mép) */}
            <div
              ref={trackBarRef}
              style={unifiedTrackStyle}
              onClick={handleTrackClick}
            >
              {/* Background ruler ticks */}
              <div style={trackTicksStyle}>
                <div style={{ ...tickMarkStyle, left: "25%" }} />
                <div style={{ ...tickMarkStyle, left: "50%" }} />
                <div style={{ ...tickMarkStyle, left: "75%" }} />
              </div>

              {/* Dimmed Left Overlay (Before Start) */}
              <div
                style={{
                  ...dimmedAreaStyle,
                  left: 0,
                  width: `${startPct}%`,
                }}
              />

              {/* Dimmed Right Overlay (After End) */}
              <div
                style={{
                  ...dimmedAreaStyle,
                  left: `${endPct}%`,
                  right: 0,
                }}
              />

              {/* Selected Range Band */}
              <div
                style={{
                  ...selectedRangeStyle,
                  left: `${startPct}%`,
                  width: `${endPct - startPct}%`,
                  cursor: dragMode === "move" ? "grabbing" : "grab",
                }}
                onPointerDown={(e) => handlePointerDown("move", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                {/* Left Handle (sát mép trái của vùng chọn) */}
                <div
                  style={leftHandleStyle}
                  onPointerDown={(e) => handlePointerDown("start", e)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  title={t("gifExport.startTime")}
                >
                  <div style={handleGripLineStyle} />
                </div>

                {/* Duration Badge / Center label */}
                <div style={rangeDurationBadgeStyle}>
                  {clipDurationSec.toFixed(1)}s
                </div>

                {/* Right Handle (sát mép phải của vùng chọn) */}
                <div
                  style={rightHandleStyle}
                  onPointerDown={(e) => handlePointerDown("end", e)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  title={t("gifExport.endTime")}
                >
                  <div style={handleGripLineStyle} />
                </div>
              </div>

              {/* Moving Playhead Needle */}
              <div
                style={{
                  ...playheadNeedleStyle,
                  left: `${playheadPct}%`,
                }}
              />
            </div>

            {/* Time labels below the timeline */}
            <div style={trackLabelsRowStyle}>
              <span>0:00</span>
              <span style={{ color: "#3b82f6", fontWeight: 600 }}>
                {fmtSec(startSec)} – {fmtSec(endSec)}
              </span>
              <span>{fmtSec(totalSec)}</span>
            </div>

            {isLongWarning && (
              <div style={warningStyle}>
                ⚠️ {t("gifExport.durationWarning")}
              </div>
            )}
          </div>

          {/* Settings Grid */}
          <div style={settingsGridStyle}>
            {/* FPS */}
            <div style={fieldStyle}>
              <label style={labelStyle}>{t("gifExport.fps")}</label>
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                disabled={busy}
                style={selectStyle}
              >
                <option value={10}>{t("gifExport.fpsLow")}</option>
                <option value={15}>{t("gifExport.fpsMedium")}</option>
                <option value={24}>{t("gifExport.fpsHigh")}</option>
              </select>
            </div>

            {/* Resolution */}
            <div style={fieldStyle}>
              <label style={labelStyle}>{t("gifExport.resolution")}</label>
              <select
                value={resolution ?? "orig"}
                onChange={(e) =>
                  setResolution(e.target.value === "orig" ? null : Number(e.target.value))
                }
                disabled={busy}
                style={selectStyle}
              >
                <option value={1280}>{t("gifExport.res720")}</option>
                <option value={854}>{t("gifExport.res480")}</option>
                <option value={640}>{t("gifExport.res360")}</option>
                <option value="orig">{t("gifExport.resOriginal")}</option>
              </select>
            </div>

            {/* Speed */}
            <div style={fieldStyle}>
              <label style={labelStyle}>{t("gifExport.speed")}</label>
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                disabled={busy}
                style={selectStyle}
              >
                <option value={1.0}>1.0x (Bình thường)</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x (Nhanh)</option>
                <option value={2.0}>2.0x (Gấp đôi)</option>
              </select>
            </div>

            {/* Loop */}
            <div style={fieldStyle}>
              <label style={labelStyle}>{t("gifExport.loop")}</label>
              <select
                value={loopForever ? "forever" : "once"}
                onChange={(e) => setLoopForever(e.target.value === "forever")}
                disabled={busy}
                style={selectStyle}
              >
                <option value="forever">{t("gifExport.loopForever")}</option>
                <option value="once">{t("gifExport.loopOnce")}</option>
              </select>
            </div>
          </div>

          {/* Metadata summary */}
          <div style={summaryRowStyle}>
            <span>
              ⏱️ {clipDurationSec.toFixed(1)}s • {fps} fps • ~{Math.round((clipDurationSec / speed) * fps)} frames
            </span>
            <span style={sizeEstimateStyle}>
              💾 {t("gifExport.estimatedSize")}: ~{estSizeMb} MB
            </span>
          </div>

          {/* Progress bar during export */}
          {busy && (
            <div style={progressContainerStyle}>
              <div style={progressLabelStyle}>
                <span>{statusMsg}</span>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <div style={progressTrackStyle}>
                <div
                  style={{
                    ...progressBarFillStyle,
                    width: `${Math.max(5, Math.round(progress * 100))}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div style={footerStyle}>
          <button
            type="button"
            style={cancelBtnStyle}
            disabled={busy}
            onClick={onClose}
          >
            {t("gifExport.cancel")}
          </button>

          <div style={actionButtonGroupStyle}>
            <button
              type="button"
              style={secondaryBtnStyle}
              disabled={busy}
              onClick={handleCopy}
              title={t("gifExport.btnCopy")}
            >
              📋 {t("gifExport.btnCopy")}
            </button>

            {sourceHistoryId && (
              <button
                type="button"
                style={secondaryBtnStyle}
                disabled={busy}
                onClick={handleSaveToLibrary}
                title={t("gifExport.btnSaveLibrary")}
              >
                📂 {t("gifExport.btnSaveLibrary")}
              </button>
            )}

            <button
              type="button"
              style={primaryBtnStyle}
              disabled={busy}
              onClick={handleSaveAs}
              title={t("gifExport.btnSave")}
            >
              💾 {t("gifExport.btnSave")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1100,
  background: "rgba(0, 0, 0, 0.72)",
  backdropFilter: "blur(6px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};

const modalCardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 560,
  maxHeight: "92vh",
  background: "#18181c",
  border: "1px solid #32323a",
  borderRadius: 14,
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 24px 64px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.4)",
  overflow: "hidden",
  color: "#f0f0f3",
  fontFamily: "inherit",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px",
  borderBottom: "1px solid #282830",
  background: "#1e1e24",
};

const titleWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 0.5,
  background: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
  color: "#fff",
  padding: "2px 6px",
  borderRadius: 4,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
};

const closeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#a0a0ab",
  cursor: "pointer",
  fontSize: 15,
  padding: "4px 8px",
  borderRadius: 6,
};

const bodyStyle: React.CSSProperties = {
  padding: "16px 18px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const previewWrapStyle: React.CSSProperties = {
  width: "100%",
  height: 180,
  background: "#0c0c0e",
  borderRadius: 8,
  overflow: "hidden",
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid #282830",
};

const videoElementStyle: React.CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
};

const previewBadgeStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: 8,
  background: "rgba(0, 0, 0, 0.75)",
  backdropFilter: "blur(4px)",
  color: "#e2e2ea",
  fontSize: 11,
  padding: "3px 8px",
  borderRadius: 4,
  border: "1px solid rgba(255, 255, 255, 0.1)",
};

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#a0a0ab",
};

const segmentedGroupStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  background: "#121215",
  padding: 3,
  borderRadius: 8,
  border: "1px solid #282830",
};

const segmentBtnStyle: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  color: "#90909c",
  fontSize: 12,
  padding: "6px 10px",
  borderRadius: 6,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const segmentBtnActiveStyle: React.CSSProperties = {
  background: "#2a2a34",
  color: "#ffffff",
  fontWeight: 600,
  boxShadow: "0 1px 4px rgba(0, 0, 0, 0.3)",
};

const timeRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
};

const timeInputWrapStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "#121215",
  border: "1px solid #282830",
  borderRadius: 6,
  padding: "4px 8px",
};

const timeLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#80808c",
};

const timeInputStyle: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  outline: "none",
  width: "100%",
};

const timeUnitStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#6c6c78",
};

const unifiedTrackStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: 38,
  background: "#0e0e12",
  border: "1px solid #2d2d38",
  borderRadius: 8,
  overflow: "hidden",
  userSelect: "none",
  touchAction: "none",
  boxSizing: "border-box",
  marginTop: 4,
};

const trackTicksStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
};

const tickMarkStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 1,
  background: "rgba(255, 255, 255, 0.06)",
};

const dimmedAreaStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "rgba(0, 0, 0, 0.55)",
  backdropFilter: "grayscale(60%)",
  pointerEvents: "none",
  zIndex: 1,
};

const selectedRangeStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "rgba(37, 99, 235, 0.22)",
  borderTop: "2px solid #3b82f6",
  borderBottom: "2px solid #3b82f6",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 3,
};

const leftHandleStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 14,
  background: "#2563eb",
  borderRadius: "6px 0 0 6px",
  cursor: "ew-resize",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 4,
  touchAction: "none",
  boxShadow: "1px 0 4px rgba(0, 0, 0, 0.3)",
};

const rightHandleStyle: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: 14,
  background: "#2563eb",
  borderRadius: "0 6px 6px 0",
  cursor: "ew-resize",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 4,
  touchAction: "none",
  boxShadow: "-1px 0 4px rgba(0, 0, 0, 0.3)",
};

const handleGripLineStyle: React.CSSProperties = {
  width: 2,
  height: 14,
  background: "#ffffff",
  borderRadius: 1,
  opacity: 0.9,
};

const rangeDurationBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#dbeafe",
  background: "rgba(15, 23, 42, 0.65)",
  backdropFilter: "blur(4px)",
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid rgba(59, 130, 246, 0.3)",
  pointerEvents: "none",
  letterSpacing: 0.3,
};

const playheadNeedleStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 2,
  background: "#ffffff",
  boxShadow: "0 0 5px rgba(255, 255, 255, 0.9), 0 0 8px rgba(59, 130, 246, 0.6)",
  pointerEvents: "none",
  zIndex: 5,
  transform: "translateX(-1px)",
};

const trackLabelsRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 11,
  color: "#71717a",
  marginTop: 3,
  paddingLeft: 2,
  paddingRight: 2,
};


const warningStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#f59e0b",
  background: "rgba(245, 158, 11, 0.1)",
  border: "1px solid rgba(245, 158, 11, 0.2)",
  padding: "6px 10px",
  borderRadius: 6,
  marginTop: 4,
};

const settingsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const selectStyle: React.CSSProperties = {
  background: "#121215",
  border: "1px solid #282830",
  borderRadius: 6,
  color: "#f0f0f3",
  fontSize: 12,
  padding: "6px 8px",
  outline: "none",
  cursor: "pointer",
};

const summaryRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 11,
  color: "#8a8a98",
  padding: "6px 8px",
  background: "#131317",
  borderRadius: 6,
  border: "1px solid #22222a",
};

const sizeEstimateStyle: React.CSSProperties = {
  color: "#3b82f6",
  fontWeight: 600,
};

const progressContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 10,
  background: "#121216",
  borderRadius: 8,
  border: "1px solid #2a2a35",
};

const progressLabelStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 12,
  color: "#93c5fd",
  fontWeight: 500,
};

const progressTrackStyle: React.CSSProperties = {
  height: 6,
  background: "#22222c",
  borderRadius: 3,
  overflow: "hidden",
};

const progressBarFillStyle: React.CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg, #3b82f6, #60a5fa)",
  borderRadius: 3,
  transition: "width 0.15s ease",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 18px",
  borderTop: "1px solid #282830",
  background: "#1e1e24",
};

const cancelBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #383844",
  color: "#b0b0bc",
  padding: "7px 14px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
};

const actionButtonGroupStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "#2a2a34",
  border: "1px solid #3a3a46",
  color: "#e2e2ea",
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const primaryBtnStyle: React.CSSProperties = {
  background: "#2563eb",
  border: "none",
  color: "#ffffff",
  padding: "7px 14px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 2px 6px rgba(37, 99, 235, 0.4)",
  display: "flex",
  alignItems: "center",
  gap: 4,
};
