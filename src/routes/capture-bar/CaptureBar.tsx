import { useEffect, useRef, useState } from "react";
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

// Khu vực 1: chế độ CHỤP ẢNH — All/Scroll không có khái niệm quay tương ứng
// nên chỉ xuất hiện ở nhóm này.
const PHOTO_MODES: { id: CaptureMode; label: string; icon: React.ReactNode }[] = [
  {
    id: "all", label: "All",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="1" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        <rect x="11" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      </svg>
    ),
  },
  { id: "full", label: "Full", icon: SCOPE_ICONS.full },
  { id: "window", label: "Window", icon: SCOPE_ICONS.window },
  { id: "region", label: "Region", icon: SCOPE_ICONS.region },
  {
    id: "scroll", label: "Scroll",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/>
        <path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
];

// Khu vực 2: chế độ QUAY MÀN HÌNH — đúng 3 phạm vi, dùng chung icon phạm vi
// với nhóm chụp ảnh nhưng gắn thêm chấm đỏ nhỏ (xem `recordDotBadge`) để phân
// biệt rõ đây là quay video, không phải chụp ảnh — cùng ngôn ngữ hình khối,
// khác nhóm hành động, giống cách thanh Cmd+Shift+5 của macOS chia 2 cụm.
const RECORD_MODES: { id: RecordMode; label: string }[] = [
  { id: "full", label: "Full" },
  { id: "window", label: "Window" },
  { id: "region", label: "Region" },
];

const OUTPUTS: { id: OutputMode; label: string }[] = [
  { id: "editor",    label: "Mở editor"  },
  { id: "clipboard", label: "Clipboard"  },
  { id: "save",      label: "Lưu file"   },
  { id: "save_copy", label: "Lưu + Copy" },
  { id: "copy_editor", label: "Copy + Mở editor" },
];

const AUDIO_OPTIONS: { id: AudioSource; label: string }[] = [
  { id: "off",    label: "Tắt (chỉ hình)" },
  { id: "mic",    label: "Microphone" },
  { id: "system", label: "Âm thanh hệ thống" },
];

export default function CaptureBar() {
  const [photoMode, setPhotoMode] = useState<CaptureMode>("region");
  const [videoMode, setVideoMode] = useState<RecordMode>("full");
  const [activeGroup, setActiveGroup] = useState<ActiveGroup>("photo");
  const [output, setOutput] = useState<OutputMode>("editor");
  const [audioSource, setAudioSource] = useState<AudioSource>("off");
  // Chỉ 1 trong 2 popover (output/audio) hiện tại 1 thời điểm — vì bản thân
  // 2 nút đó cũng không bao giờ cùng hiện (đổi theo activeGroup).
  const [showPopover, setShowPopover] = useState(false);
  const optionWrapRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    // Load settings lần đầu
    ipc.getSettings().then((s) => {
      if (s?.defaultOutput) setOutput(s.defaultOutput);
      if (s?.recordAudioSource) setAudioSource(s.recordAudioSource);
    }).catch(() => {});

    // Sync output/audio khi Settings thay đổi từ cửa sổ Settings. Output chỉ
    // áp dụng khi user KHÔNG đang chủ động chọn trong capture bar; audio thì
    // luôn áp dụng (không có input debounce nào tranh chấp ở đây).
    const unlistenSettings = listen<Record<string, unknown>>("settings-changed", (e) => {
      if (!userPickedRef.current && e.payload?.defaultOutput) {
        setOutput(e.payload.defaultOutput as OutputMode);
      }
      if (e.payload?.recordAudioSource) {
        setAudioSource(e.payload.recordAudioSource as AudioSource);
      }
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

  const currentOutput = OUTPUTS.find((o) => o.id === output);
  const currentAudio = AUDIO_OPTIONS.find((a) => a.id === audioSource);
  const isPhoto = activeGroup === "photo";

  return (
    // Wrap toàn bộ height, flex-end để bar nằm đáy — popover có không gian phía trên
    <div style={wrap}>
      <div style={container}>
        {/* Bar nằm đáy */}
        <div style={bar}>
          {/* Khu vực 1: chế độ CHỤP ẢNH */}
          <div style={modeGroup}>
            {/* Chụp nhanh — hành động chạy NGAY (không phải chế độ để chọn):
                kéo vùng rồi chú thích tại chỗ. Không đụng state nào khác. */}
            <button
              onClick={() => ipc.startQuick().catch((e) => alert(String(e)))}
              style={quickModeBtn}
              title="Chụp nhanh — chọn vùng rồi chú thích ngay tại chỗ"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path d="M11 2 3 12h6l-1 6 8-10h-6l1-6Z" fill="currentColor" />
              </svg>
              <span style={{ fontSize: 11, lineHeight: 1 }}>Nhanh</span>
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

          {/* Option — đổi giữa Output (ảnh) / Nguồn audio (video), CÙNG 1
              kiểu dáng nút+popover cho đồng nhất trải nghiệm. */}
          <div ref={optionWrapRef} style={{ position: "relative" }}>
            <button
              style={optBtn}
              onClick={(e) => { e.stopPropagation(); setShowPopover((v) => !v); }}
            >
              <span>{isPhoto ? (currentOutput?.label ?? "Hành vi") : (currentAudio?.label ?? "Âm thanh")}</span>
              <span style={{ fontSize: 10, opacity: 0.5 }}>{showPopover ? "▴" : "▾"}</span>
            </button>
            {showPopover && (
              <div style={popover} onClick={(e) => e.stopPropagation()}>
                {isPhoto
                  ? OUTPUTS.map((o) => (
                      <button key={o.id} style={popItem(output === o.id)} onClick={() => selectOutput(o.id)}>
                        <span style={{ flex: 1 }}>{o.label}</span>
                        {output === o.id && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
                      </button>
                    ))
                  : AUDIO_OPTIONS.map((a) => (
                      <button key={a.id} style={popItem(audioSource === a.id)} onClick={() => selectAudioSource(a.id)}>
                        <span style={{ flex: 1 }}>{a.label}</span>
                        {audioSource === a.id && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
                      </button>
                    ))}
              </div>
            )}
          </div>

          {/* Close */}
          <button aria-label="Đóng" style={closeBtn} onClick={() => ipc.closeSelf()}>
            ✕
          </button>
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
};

const modeGroup: React.CSSProperties = {
  display: "flex",
  gap: 2,
  background: "rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 2,
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
  bottom: "calc(100% + 6px)",  // ngay trên nút, cách 6px
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
