import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ipc, type CaptureMode, type OutputMode } from "../../lib/ipc";

const MODES: { id: CaptureMode; label: string; icon: React.ReactNode }[] = [
  {
    id: "all", label: "All",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="1" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        <rect x="11" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      </svg>
    ),
  },
  {
    id: "full", label: "Full",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="2" y="3" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      </svg>
    ),
  },
  {
    id: "window", label: "Window",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect x="3" y="5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        <line x1="3" y1="8.5" x2="17" y2="8.5" stroke="currentColor" strokeWidth="1.4"/>
      </svg>
    ),
  },
  {
    id: "region", label: "Region",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M12 3h3.5A1.5 1.5 0 0 1 17 4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M17 12v3.5A1.5 1.5 0 0 1 15.5 17H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        <path d="M8 17H4.5A1.5 1.5 0 0 1 3 15.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    ),
  },
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

const OUTPUTS: { id: OutputMode; label: string }[] = [
  { id: "editor",    label: "Mở editor"  },
  { id: "clipboard", label: "Clipboard"  },
  { id: "save",      label: "Lưu file"   },
  { id: "save_copy", label: "Lưu + Copy" },
  { id: "copy_editor", label: "Copy + Mở editor" },
];

export default function CaptureBar() {
  const [mode, setMode] = useState<CaptureMode>("region");
  const [output, setOutput] = useState<OutputMode>("editor");
  const [showOptions, setShowOptions] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Dùng ref để tránh setOutput ghi đè khi user đang chủ động chọn output
  // trong cùng một session (selectOutput đã lưu settings rồi → event sẽ fire
  // lại đúng giá trị đó, không gây loop).
  const userPickedRef = useRef(false);

  // Lưu ref cho các state truy cập trong event listeners để tránh stale closures
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const outputRef = useRef(output);
  outputRef.current = output;
  const showOptionsRef = useRef(showOptions);
  showOptionsRef.current = showOptions;

  useEffect(() => {
    // Load settings lần đầu
    ipc.getSettings().then((s) => {
      if (s?.defaultOutput) setOutput(s.defaultOutput);
    }).catch(() => {});

    ipc.getLastCaptureMode().then(([m]) => {
      if (m) setMode(m as CaptureMode);
    }).catch(() => {});

    // Sync output khi Settings thay đổi defaultOutput từ cửa sổ Settings.
    // Chỉ áp dụng khi user KHÔNG đang chủ động chọn trong capture bar.
    const unlistenSettings = listen<Record<string, unknown>>("settings-changed", (e) => {
      if (!userPickedRef.current && e.payload?.defaultOutput) {
        setOutput(e.payload.defaultOutput as OutputMode);
      }
    });

    const unlisten = listen<{ mode: string; output: string | null }>("set-capture-mode", (e) => {
      setMode(e.payload.mode as CaptureMode);
      // set-capture-mode từ editor "New" truyền output=null để chỉ sync mode,
      // giữ nguyên defaultOutput từ settings. Chỉ override output khi có giá trị thực.
      if (e.payload.output) {
        setOutput(e.payload.output as OutputMode);
      }
    });

    const onFocus = () => {
      ipc.getLastCaptureMode().then(([m]) => {
        if (m) setMode(m as CaptureMode);
      }).catch(() => {});
    };
    window.addEventListener("focus", onFocus);

    // Listen to native Tauri blur event to close popover when clicking outside the window
    const unlistenBlur = listen("tauri://blur", () => {
      setShowOptions(false);
    });

    const unlistenHidePopover = listen("hide-popover", () => {
      setShowOptions(false);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showOptionsRef.current) { setShowOptions(false); return; }
        ipc.closeSelf();
      }
      if (e.key === "Enter") {
        if (modeRef.current === "all") {
          ipc.captureAllScreens(outputRef.current).catch((err) => alert(String(err)));
        } else {
          ipc.captureNow(modeRef.current, outputRef.current).catch((err) => alert(String(err)));
        }
      }
    };
    window.addEventListener("keydown", onKey);

    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowOptions(false);
      }
    };
    window.addEventListener("mousedown", onClickOutside);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("mousedown", onClickOutside);
      unlisten.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
      unlistenBlur.then((fn) => fn());
      unlistenHidePopover.then((fn) => fn());
    };
  }, []);

  /** Chọn output: cập nhật state + lưu settings ngay.
   * Khi lưu xong, Rust emit settings-changed → tất cả window sync lại.
   * userPickedRef tránh CaptureBar bị overwrite lại bởi chính event nó gây ra. */
  const selectOutput = (o: OutputMode) => {
    userPickedRef.current = true;
    setOutput(o);
    setShowOptions(false);
    ipc.getSettings().then((s) => {
      if (s) ipc.setSettings({ ...s, defaultOutput: o }).catch(() => {});
    }).catch(() => {}).finally(() => {
      // Reset sau khi lưu xong — các thay đổi tiếp theo từ Settings sẽ được áp dụng
      userPickedRef.current = false;
    });
  };

  const doCapture = () => {
    if (mode === "all") {
      ipc.captureAllScreens(output).catch((e) => alert(String(e)));
    } else {
      ipc.captureNow(mode, output).catch((e) => alert(String(e)));
    }
  };

  // Quay video dùng CHUNG mode đang chọn với "Chụp" — Full/Window/Region đều
  // mở đúng overlay chọn phạm vi (Full cũng qua overlay chọn màn hình, giống
  // hệt hành vi chụp ảnh Full). All/Scroll không có khái niệm video tương ứng
  // (ghép nhiều màn hình / cuộn trang) nên ẩn hẳn nút "Quay" ở 2 mode này.
  const canRecord = mode === "full" || mode === "window" || mode === "region";
  const doRecord = () => {
    ipc.startRecordPicker(mode as "full" | "window" | "region").catch((e) => alert(String(e)));
  };

  const currentOutput = OUTPUTS.find((o) => o.id === output);

  return (
    // Wrap toàn bộ height, flex-end để bar nằm đáy — popover có không gian phía trên
    <div style={wrap}>
      <div style={container}>
        {/* Bar nằm đáy */}
        <div style={bar}>
          {/* Mode buttons */}
          <div style={modeGroup}>
            {/* Chụp nhanh — hành động chạy NGAY (không phải chế độ để chọn):
                kéo vùng rồi chú thích tại chỗ. Không đụng state mode/output. */}
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
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                style={modeBtn(mode === m.id)}
                title={m.label}
              >
                {m.icon}
                <span style={{ fontSize: 11, lineHeight: 1 }}>{m.label}</span>
              </button>
            ))}
          </div>

          <div style={divider} />

          {/* Output selector — popover absolute ngay trên nút */}
          <div ref={wrapRef} style={{ position: "relative" }}>
            <button
              style={optBtn}
              onClick={(e) => { e.stopPropagation(); setShowOptions((v) => !v); }}
            >
              <span>{currentOutput?.label ?? "Hành vi"}</span>
              <span style={{ fontSize: 10, opacity: 0.5 }}>{showOptions ? "▴" : "▾"}</span>
            </button>
            {showOptions && (
              <div style={popover} onClick={(e) => e.stopPropagation()}>
                {OUTPUTS.map((o) => (
                  <button
                    key={o.id}
                    style={popItem(output === o.id)}
                    onClick={() => selectOutput(o.id)}
                  >
                    <span style={{ flex: 1 }}>{o.label}</span>
                    {output === o.id && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Capture button */}
          <button style={shootBtn} onClick={doCapture}>
            Chụp
          </button>

          {/* Quay video — dùng chung mode với "Chụp" (xem doRecord). Ẩn khi
              mode = All/Scroll (video không hỗ trợ 2 kiểu này). Chỉ báo đang
              quay hiện trên tray icon riêng (menu bar), không phải ở đây. */}
          {canRecord && (
            <button style={recordBtn} onClick={doRecord} title="Quay video đúng phạm vi đang chọn">
              <span style={recordDot} aria-hidden />
              Quay
            </button>
          )}

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

function modeBtn(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    width: 56,
    padding: "6px 4px",
    borderRadius: 6,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text-dim)",
    transition: "background 0.12s",
  };
}

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

// Nút "Chụp nhanh" trong cụm chế độ: cùng khối với mode buttons nhưng nhấn
// nhấn accent (vàng) để phân biệt đây là hành động chạy ngay, không phải chế độ.
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

// Nút "Quay" đứng cạnh "Chụp" — cùng hình dạng (pill) nhưng tông đỏ để phân
// biệt hành động quay video khỏi chụp ảnh. Dùng chung `mode` đang chọn với
// "Chụp" (xem `doRecord`), không còn popover chọn phạm vi riêng.
const recordBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 16px",
  borderRadius: 8,
  background: "rgba(239,68,68,0.16)",
  color: "var(--danger)",
  fontWeight: 600,
  fontSize: 13,
  border: "none",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const recordDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--danger)",
  display: "inline-block",
};

const shootBtn: React.CSSProperties = {
  padding: "7px 18px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
  border: "none",
  cursor: "pointer",
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
  left: 0,
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
