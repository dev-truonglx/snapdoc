import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ipc, type AudioSource, type CaptureMode, type OutputMode } from "../../lib/ipc";

type RecordMode = "full" | "window" | "region";
/** "photo" = đang thao tác nhóm chụp ảnh, "video" = đang thao tác nhóm quay
 * màn hình — quyết định popover option nào (Output ảnh / Nguồn audio) hiện ở
 * cuối thanh. Chỉ 1 trong 2 nhóm "active" tại 1 thời điểm, giống cách thanh
 * chụp màn hình gốc của macOS (Cmd+Shift+5) chỉ có 1 lựa chọn được bôi sáng
 * trong toàn bộ dải icon dù chia làm 2 cụm. */
type ActiveGroup = "photo" | "video";

// Icon dùng chung cho "phạm vi" (Full/Window/Region) — cả nhóm chụp ảnh lẫn
// nhóm quay màn hình đều biểu diễn cùng khái niệm này nên dùng chung 1 bộ.
const SCOPE_ICONS: Record<RecordMode, React.ReactNode> = {
  full: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="3" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
    </svg>
  ),
  window: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3" y="5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      <line x1="3" y1="8.5" x2="17" y2="8.5" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  ),
  region: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M12 3h3.5A1.5 1.5 0 0 1 17 4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M17 12v3.5A1.5 1.5 0 0 1 15.5 17H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M8 17H4.5A1.5 1.5 0 0 1 3 15.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  ),
};

// Icon dùng chung cho "phạm vi" (Full/Window/Region) — cả nhóm chụp ảnh lẫn
// nhóm quay màn hình đều biểu diễn cùng khái niệm này nên dùng chung 1 bộ.

const CAPTURE_BAR_BOTTOM_PADDING = 12;
const CAPTURE_BAR_POPOVER_GAP = 6;

export default function CaptureBar() {
  const { t } = useTranslation();
  const [photoMode, setPhotoMode] = useState<CaptureMode>("region");
  const [videoMode, setVideoMode] = useState<RecordMode>("full");
  const [activeGroup, setActiveGroup] = useState<ActiveGroup>("photo");
  const [output, setOutput] = useState<OutputMode>("editor");
  const [audioSource, setAudioSource] = useState<AudioSource>("off");
  const [delaySeconds, setDelaySeconds] = useState<0 | 5 | 10>(0);

  // Initialize modes with translations
  const PHOTO_MODES: { id: CaptureMode; label: string; icon: React.ReactNode }[] = [
    {
      id: "all", label: t("captureBar.all"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect x="1" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
          <rect x="11" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        </svg>
      ),
    },
    { id: "full", label: t("captureBar.full"), icon: SCOPE_ICONS.full },
    { id: "window", label: t("captureBar.window"), icon: SCOPE_ICONS.window },
    { id: "region", label: t("captureBar.region"), icon: SCOPE_ICONS.region },
    {
      id: "scroll", label: t("captureBar.scroll"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/>
          <path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
  ];

  const RECORD_MODES: { id: RecordMode; label: string }[] = [
    { id: "full", label: t("captureBar.full") },
    { id: "window", label: t("captureBar.window") },
    { id: "region", label: t("captureBar.region") },
  ];

  const OUTPUTS: { id: OutputMode; label: string }[] = [
    { id: "editor",    label: t("outputs.editor")    },
    { id: "clipboard", label: t("outputs.clipboard") },
    { id: "save",      label: t("outputs.save")      },
    { id: "save_copy", label: t("outputs.save_copy") },
    { id: "copy_editor", label: t("outputs.copy_editor") },
  ];

  const AUDIO_OPTIONS: { id: AudioSource; label: string }[] = [
    { id: "off",    label: t("captureBar.audioOff") },
    { id: "mic",    label: t("captureBar.audioMic") },
    { id: "system", label: t("captureBar.audioSystem") },
  ];

  const CAPTURE_DELAYS: { id: 0 | 5 | 10; label: string }[] = [
    { id: 0,  label: t("captureBar.noDelay") },
    { id: 5,  label: t("captureBar.delay5s") },
    { id: 10, label: t("captureBar.delay10s") },
  ];
  // Số giây còn lại đang đếm ngược ("hẹn giờ chụp") — `null` = không có phiên
  // đếm nào đang chạy. Nhận từ Rust qua event `capture-countdown-tick`, KHÔNG
  // tự đếm ở frontend (tránh lệch nhịp với sleep() thật ở Rust).
  const [countdown, setCountdown] = useState<number | null>(null);
  // Chỉ 1 trong 2 popover (output/audio) hiện tại 1 thời điểm — vì bản thân
  // 2 nút đó cũng không bao giờ cùng hiện (đổi theo activeGroup).
  const [showPopover, setShowPopover] = useState(false);
  const optionWrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const syncWindowFrameRef = useRef<(() => Promise<void>) | null>(null);
  // Dùng ref để tránh setOutput ghi đè khi user đang chủ động chọn output
  // trong cùng một session (selectOutput đã lưu settings rồi → event sẽ fire
  // lại đúng giá trị đó, không gây loop).
  const userPickedRef = useRef(false);

  // Lưu ref cho các state truy cập trong event listeners để tránh stale closures
  const photoModeRef = useRef(photoMode);
  photoModeRef.current = photoMode;
  const videoModeRef = useRef(videoMode);
  videoModeRef.current = videoMode;
  const activeGroupRef = useRef(activeGroup);
  activeGroupRef.current = activeGroup;
  const outputRef = useRef(output);
  outputRef.current = output;
  const showPopoverRef = useRef(showPopover);
  showPopoverRef.current = showPopover;
  const countdownRef = useRef(countdown);
  countdownRef.current = countdown;

  useEffect(() => {
    // Load settings lần đầu
    ipc.getSettings().then((s) => {
      if (s?.defaultOutput) setOutput(s.defaultOutput);
      if (s?.recordAudioSource) setAudioSource(s.recordAudioSource);
      if (s?.timerSeconds === 0 || s?.timerSeconds === 5 || s?.timerSeconds === 10) {
        setDelaySeconds(s.timerSeconds);
      }
    }).catch(() => {});

    // Sync output/audio/delay khi Settings thay đổi từ cửa sổ Settings. Output
    // chỉ áp dụng khi user KHÔNG đang chủ động chọn trong capture bar; audio +
    // delay thì luôn áp dụng (không có input debounce nào tranh chấp ở đây).
    const unlistenSettings = listen<Record<string, unknown>>("settings-changed", (e) => {
      if (!userPickedRef.current && e.payload?.defaultOutput) {
        setOutput(e.payload.defaultOutput as OutputMode);
      }
      if (e.payload?.recordAudioSource) {
        setAudioSource(e.payload.recordAudioSource as AudioSource);
      }
      const t = e.payload?.timerSeconds;
      if (t === 0 || t === 5 || t === 10) setDelaySeconds(t);
    });

    // Đếm ngược "hẹn giờ chụp" — Rust emit mỗi giây (kể cả giây đầu = tổng số
    // giây đã chọn), payload = số giây CÒN LẠI. Huỷ (Esc, hoặc phiên đếm khác
    // đè lên) thì Rust emit `capture-countdown-cancel`.
    const unlistenCountdownTick = listen<number>("capture-countdown-tick", (e) => {
      // payload=0 là nhịp cuối trước khi Rust chụp thật — ẩn overlay đếm ngược
      // ngay lúc đó (bar tự bị ẩn/minimize ngay sau bởi luồng chụp thật) thay
      // vì hiện "0" rồi mới biến mất, tránh khựng hình thừa.
      setCountdown(e.payload === 0 ? null : e.payload);
    });
    const unlistenCountdownCancel = listen("capture-countdown-cancel", () => {
      setCountdown(null);
    });

    // Nút "Quay lại" ở `record-review` (xem `record::redo_recording`) — mở
    // lại đúng phạm vi quay vừa xoá, y hệt hành vi bấm tay vào nút phạm vi đó
    // (xem `selectVideoMode`).
    const unlistenRecordMode = listen<{ mode: string }>("set-record-mode", (e) => {
      selectVideoMode(e.payload.mode as RecordMode);
    });

    // Listen to native Tauri blur event to close popover when clicking outside the window
    const unlistenBlur = listen("tauri://blur", () => {
      setShowPopover(false);
    });

    const unlistenHidePopover = listen("hide-popover", () => {
      setShowPopover(false);
    });

    // `run_record_picker`/`finalize_region`/`finalize_window` (flow.rs) emit
    // lỗi xảy ra TRONG lúc chạy nền (sau khi command IPC ban đầu đã trả về,
    // ví dụ mở overlay chọn vùng quay thất bại) qua event này — trước đây
    // KHÔNG có nơi nào lắng nghe, lỗi rơi vào hư không nên bấm "Quay" mà
    // lỗi ở bước này sẽ trông y hệt như không có gì xảy ra.
    const unlistenError = listen<string>("snapdoc-error", (e) => {
      alert(e.payload);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (countdownRef.current !== null) {
          ipc.cancelCaptureCountdown().catch(() => {});
          setCountdown(null);
          return;
        }
        if (showPopoverRef.current) { setShowPopover(false); return; }
        ipc.closeSelf();
      }
      if (e.key === "Enter") {
        if (activeGroupRef.current === "video") {
          // "Vùng chọn": khung chọn/chỉnh vùng đã mở sẵn từ lúc chọn mode
          // (xem `selectVideoMode`) — Enter ở đây tương đương bấm "Bắt đầu
          // quay" ngay tại khung, KHÔNG mở lại phiên chọn vùng mới.
          if (videoModeRef.current === "region") {
            ipc.confirmRegionRecordStart().catch((err) => alert(String(err)));
          } else {
            ipc.startRecordPicker(videoModeRef.current).catch((err) => alert(String(err)));
          }
        } else if (photoModeRef.current === "all") {
          ipc.captureAllScreens(outputRef.current).catch((err) => alert(String(err)));
        } else {
          ipc.captureNow(photoModeRef.current, outputRef.current).catch((err) => alert(String(err)));
        }
      }
    };
    window.addEventListener("keydown", onKey);

    const onClickOutside = (e: MouseEvent) => {
      if (optionWrapRef.current && !optionWrapRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    window.addEventListener("mousedown", onClickOutside);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClickOutside);
      unlistenRecordMode.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
      unlistenBlur.then((fn) => fn());
      unlistenHidePopover.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenCountdownTick.then((fn) => fn());
      unlistenCountdownCancel.then((fn) => fn());
    };
  }, []);

  /** Chọn output: cập nhật state + lưu settings ngay.
   * Khi lưu xong, Rust emit settings-changed → tất cả window sync lại.
   * userPickedRef tránh CaptureBar bị overwrite lại bởi chính event nó gây ra. */
  const selectOutput = (o: OutputMode) => {
    userPickedRef.current = true;
    setOutput(o);
    setShowPopover(false);
    ipc.getSettings().then((s) => {
      if (s) ipc.setSettings({ ...s, defaultOutput: o }).catch(() => {});
    }).catch(() => {}).finally(() => {
      // Reset sau khi lưu xong — các thay đổi tiếp theo từ Settings sẽ được áp dụng
      userPickedRef.current = false;
    });
  };

  /** Chọn nguồn audio quay kèm — chỉ 1 trong 3 (xem lib/ipc.ts AudioSource).
   * Cùng key settings với Settings.tsx nên đổi ở đâu cũng đồng bộ 2 chỗ. */
  const selectAudioSource = (a: AudioSource) => {
    setAudioSource(a);
    setShowPopover(false);
    ipc.getSettings().then((s) => {
      if (s) ipc.setSettings({ ...s, recordAudioSource: a }).catch(() => {});
    }).catch(() => {});
  };

  /** Chọn số giây hẹn giờ chụp (Tắt/5s/10s) — đọc bởi `flow::wait_capture_delay`
   * (Rust) ở MỌI lần chụp ảnh sau đó (bar/hotkey), không riêng gì lần chọn này. */
  const selectDelay = (d: 0 | 5 | 10) => {
    setDelaySeconds(d);
    setShowPopover(false);
    ipc.getSettings().then((s) => {
      if (s) ipc.setSettings({ ...s, timerSeconds: d }).catch(() => {});
    }).catch(() => {});
  };

  // Chọn mode = thực hiện NGAY (không còn nút "Chụp" riêng để bấm thêm 1 lần
  // nữa) — mọi mode ("all"/"full"/"window"/"region"/"scroll") đều chỉ MỞ một
  // luồng tương tác (overlay chọn màn hình/cửa sổ/vùng, hoặc phiên cuộn), việc
  // "chụp" thật sự luôn xảy ra ở bước sau đó (thả chuột trên overlay) nên bấm
  // là chạy luôn không mất đi bước xác nhận nào.
  const selectPhotoMode = (m: CaptureMode) => {
    setPhotoMode(m);
    setActiveGroup("photo");
    if (m === "all") {
      ipc.captureAllScreens(output).catch((e) => alert(String(e)));
    } else {
      ipc.captureNow(m, output).catch((e) => alert(String(e)));
    }
  };
  // Tương tự cho quay màn hình — "region" đã mở luôn khung chọn/chỉnh vùng từ
  // trước (không cần bấm "Quay" mới mở), giờ "full"/"window" cũng mở overlay
  // chọn màn hình/cửa sổ ngay khi chọn, đồng nhất với hành vi "chọn = chạy".
  const selectVideoMode = (m: RecordMode) => {
    setVideoMode(m);
    setActiveGroup("video");
    ipc.startRecordPicker(m).catch((e) => alert(String(e)));
  };

  // const currentOutput = OUTPUTS.find((o) => o.id === output);
  // const currentAudio = AUDIO_OPTIONS.find((a) => a.id === audioSource);

  syncWindowFrameRef.current = async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    const barHeight = barRef.current?.getBoundingClientRect().height ?? 0;
    const popoverHeight = showPopover ? (popoverRef.current?.getBoundingClientRect().height ?? 0) : 0;
    const nextHeight = Math.ceil(
      barHeight
      + CAPTURE_BAR_BOTTOM_PADDING
      + (showPopover ? popoverHeight + CAPTURE_BAR_POPOVER_GAP : 0),
    );

    if (nextHeight <= 0) return;

    // Gọi 1 command Rust atomic thay vì tự `setSize` + `setPosition` riêng
    // (2 lệnh OS tách rời, để lộ 1 khung hình trung gian sai kích thước/vị
    // trí giữa 2 bước → nháy mỗi khi mở/đóng popover). `resize_capture_bar`
    // đo, tính bù vị trí và set cả size+position trong 1 lệnh AppKit/Win32
    // atomic (xem `src-tauri/src/windows/mod.rs`), giữ nguyên cạnh đáy mà
    // không có khoảng hở nào lộ ra giữa các bước.
    await ipc.resizeCaptureBar(nextHeight);
  };

  useLayoutEffect(() => {
    void syncWindowFrameRef.current?.();
  }, [showPopover, output, audioSource, countdown]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let firstFrame = 0;
    let secondFrame = 0;
    const observer = new ResizeObserver(() => {
      void syncWindowFrameRef.current?.();
    });

    if (barRef.current) {
      observer.observe(barRef.current);
    }

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        void syncWindowFrameRef.current?.();
      });
    });

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  return (
    // Wrap toàn bộ height, flex-end để bar nằm đáy — popover có không gian phía trên
    <div style={wrap}>
      <div style={container}>
        {/* Bar nằm đáy */}
        <div ref={barRef} style={bar}>
          {countdown !== null ? (
            // Đang đếm ngược "hẹn giờ chụp" — thay hẳn nội dung thanh bằng số
            // đếm ngược, tránh user bấm nhầm mode khác trong lúc đếm (freeze
            // pixel thật chỉ diễn ra SAU khi đếm xong, xem `flow::run`).
            <div style={countdownWrap}>
              <span style={countdownNumber}>{countdown}</span>
              <span style={countdownLabel}>{t("captureBar.aboutToCapture")}</span>
            </div>
          ) : (
          <>
          {/* Khu vực 1: chế độ CHỤP ẢNH */}
          <div style={modeGroup}>
            {/* Chụp nhanh — hành động chạy NGAY (không phải chế độ để chọn):
                kéo vùng rồi chú thích tại chỗ. Không đụng state nào khác. */}
            <button
              onClick={() => ipc.startQuick().catch((e) => alert(String(e)))}
              style={quickModeBtn}
              title={t("captureBar.quickCaptureHint")}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path d="M11 2 3 12h6l-1 6 8-10h-6l1-6Z" fill="currentColor" />
              </svg>
              <span style={{ fontSize: 11, lineHeight: 1 }}>Quick</span>
            </button>
            {PHOTO_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => selectPhotoMode(m.id)}
                style={scopeBtn}
                title={m.label}
              >
                {m.icon}
                <span style={{ fontSize: 11, lineHeight: 1 }}>{m.label}</span>
              </button>
            ))}
          </div>

          <div style={divider} />

          {/* Khu vực 2: chế độ QUAY MÀN HÌNH — luôn hiện đủ 3 lựa chọn. */}
          <div style={modeGroup}>
            {RECORD_MODES.map((r) => (
              <button
                key={r.id}
                onClick={() => selectVideoMode(r.id)}
                style={scopeBtn}
                title={`Quay ${r.label.toLowerCase()}`}
              >
                <span style={recordIconWrap}>
                  {SCOPE_ICONS[r.id]}
                  <span style={recordDotBadge} aria-hidden />
                </span>
                <span style={{ fontSize: 11, lineHeight: 1 }}>{r.label}</span>
              </button>
            ))}
          </div>

          <div style={divider} />

          {/* Option — 1 nút mở popover gộp cả Output (chụp) + Nguồn audio (quay)
              thành 2 section riêng trong cùng 1 dropdown. */}
          <div ref={optionWrapRef} style={{ position: "relative" }}>
            <button
              style={optBtn}
              onClick={(e) => { e.stopPropagation(); setShowPopover((v) => !v); }}
            >
              <span style={optBtnSection}>
                Options
              </span>
              <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>{showPopover ? "▴" : "▾"}</span>
            </button>
            {showPopover && (
              <div ref={popoverRef} style={popover} onClick={(e) => e.stopPropagation()}>
                {/* Section 1: Output chụp ảnh */}
                <div style={popSectionLabel}>{t("captureBar.photoSection")}</div>
                {OUTPUTS.map((o) => (
                  <button key={o.id} style={popItem(output === o.id)} onClick={() => selectOutput(o.id)}>
                    <span style={{ flex: 1 }}>{o.label}</span>
                    {output === o.id && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
                  </button>
                ))}
                {/* Divider */}
                <div style={popDivider} />
                {/* Section 2: Nguồn audio quay */}
                <div style={popSectionLabel}>{t("captureBar.videoSection")}</div>
                {AUDIO_OPTIONS.map((a) => (
                  <button key={a.id} style={popItem(audioSource === a.id)} onClick={() => selectAudioSource(a.id)}>
                    <span style={{ flex: 1 }}>{a.label}</span>
                    {audioSource === a.id && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
                  </button>
                ))}
                {/* Divider */}
                <div style={popDivider} />
                {/* Section 3: Hẹn giờ chụp — áp dụng cho MỌI lần chụp ảnh sau
                    đó (bar lẫn phím tắt), xem `flow::wait_capture_delay`. */}
                <div style={popSectionLabel}>{t("captureBar.timerSection")}</div>
                {CAPTURE_DELAYS.map((d) => (
                  <button key={d.id} style={popItem(delaySeconds === d.id)} onClick={() => selectDelay(d.id)}>
                    <span style={{ flex: 1 }}>{d.label}</span>
                    {delaySeconds === d.id && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Close */}
          <button aria-label={t("captureBar.close")} style={closeBtn} onClick={() => ipc.closeSelf()}>
            ✕
          </button>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Styles ── */

const wrap: React.CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "flex-end",   // bar nằm đáy, popover mở lên trên
  justifyContent: "center",
  paddingBottom: 12,
};

// Container bao bar + popover, không có overflow hidden
const container: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 6,
};

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  background: "rgba(32,32,38,0.97)",
  borderRadius: 12,
  padding: "7px 10px",
  width: "max-content",  // tự giãn theo nội dung, không bị cap bởi window width
};

const modeGroup: React.CSSProperties = {
  display: "flex",
  gap: 2,
  background: "rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 2,
};

// Thay hẳn nội dung bar khi đang đếm ngược "hẹn giờ chụp" — width cố định vừa
// đủ chứa số + nhãn, tránh bar co giãn giật cục theo từng chữ số (1 vs 2 ký tự).
const countdownWrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "4px 14px",
  minWidth: 160,
};

const countdownNumber: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  color: "#fbbf24",
  minWidth: 28,
  textAlign: "center",
};

const countdownLabel: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
};

// Nút phạm vi (Full/Window/Region…) dùng chung cho cả 2 khu vực — mỗi bấm là
// 1 hành động chạy ngay nên không còn trạng thái "đang chọn" để tô màu; phân
// biệt chụp ảnh/quay màn hình qua icon + chấm đỏ (`recordDotBadge`), không
// qua màu nền nút nữa.
const scopeBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  width: 56,
  padding: "6px 4px",
  borderRadius: 6,
  color: "var(--text-dim)",
};

const divider: React.CSSProperties = {
  width: 1,
  height: 36,
  background: "rgba(255,255,255,0.08)",
  flexShrink: 0,
};

const optBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 11px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  fontSize: 12,
  color: "var(--text)",
  background: "transparent",
  whiteSpace: "nowrap",
  cursor: "pointer",
};

// Nút "Chụp nhanh" trong cụm chế độ: cùng khối với mode buttons nhưng tô vàng
// để phân biệt — nó không thuộc `photoMode`/`activeGroup` (không có trạng
// thái "đang chọn" để nhớ lại như các mode khác), chỉ là 1 hành động rời.
const quickModeBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  width: 56,
  padding: "6px 4px",
  borderRadius: 6,
  background: "rgba(245,158,11,0.16)",
  color: "#fbbf24",
  transition: "background 0.12s",
};

// Bọc icon phạm vi ở nhóm QUAY để gắn thêm chấm đỏ nhỏ góc trên-phải — báo
// hiệu "đây là quay video" ngay cả khi chưa active (chưa tô nền đỏ).
const recordIconWrap: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
};

const recordDotBadge: React.CSSProperties = {
  position: "absolute",
  top: -1,
  right: -2,
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--danger)",
};

const closeBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  color: "var(--text-dim)",
  fontSize: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
};

const popover: React.CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 6px)",
  right: 0,
  background: "rgba(30,30,36,0.99)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 -4px 20px rgba(0,0,0,0.4)",
  zIndex: 100,
  whiteSpace: "nowrap",
};

const popSectionLabel: React.CSSProperties = {
  padding: "5px 12px 3px",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  opacity: 0.6,
  userSelect: "none",
};

const popDivider: React.CSSProperties = {
  height: 1,
  background: "rgba(255,255,255,0.08)",
  margin: "4px 4px",
};

// Nút trigger: mỗi section (chụp / quay) hiện label riêng ngăn cách bằng dấu ·
const optBtnSection: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

// const optBtnIcon: React.CSSProperties = {
//   fontSize: 12,
//   lineHeight: 1,
// };

// const optBtnSep: React.CSSProperties = {
//   opacity: 0.3,
//   fontSize: 14,
//   margin: "0 2px",
// };

function popItem(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 12,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text, #cdd6f4)",
    border: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
    textAlign: "left",
  };
}
