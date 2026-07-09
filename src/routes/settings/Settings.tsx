import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc, type Settings as S, type UpdateInfo } from "../../lib/ipc";

const OUTPUTS = [
  { id: "editor",    label: "Mở editor" },
  { id: "clipboard", label: "Clipboard" },
  { id: "save",      label: "Lưu file" },
  { id: "save_copy", label: "Lưu + Copy" },
  { id: "copy_editor", label: "Copy + Mở editor" },
] as const;

const SHORTCUT_KEYS: { key: string; label: string; hint?: string }[] = [
  { key: "quick",       label: "Chụp nhanh",          hint: "Chọn vùng rồi chú thích ngay tại chỗ" },
  { key: "record",      label: "Quay màn hình",       hint: "Bắt đầu/dừng quay toàn màn hình — chọn màn hình nếu máy có nhiều màn hình" },
  { key: "captureBar",  label: "Mở thanh chụp",      hint: "Mở thanh công cụ chụp nổi" },
  { key: "full",        label: "Chụp toàn màn hình",  hint: "Chụp ngay không cần chọn vùng" },
  { key: "region",      label: "Chụp vùng chọn",      hint: "Kéo chọn vùng để chụp" },
  { key: "window",      label: "Chụp cửa sổ",         hint: "Chọn cửa sổ ứng dụng" },
  { key: "all",         label: "Chụp tất cả màn hình", hint: "Ghép ngang tất cả màn hình" },
  { key: "captureCopy", label: "Chụp & copy nhanh",   hint: "Chụp vùng và copy vào clipboard" },
  { key: "scroll",      label: "Chụp cuộn",          hint: "Chọn vùng rồi cuộn để ghép ảnh dài" },
];

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [perm, setPerm] = useState<boolean | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "err">("idle");
  const [shortcutMsg, setShortcutMsg] = useState<"ok" | "err" | null>(null);
  const [hotkeyWarning, setHotkeyWarning] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "installing" | "err">("idle");
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  const pendingRef = useRef<S | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shortcutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ipc.getSettings().then(async (loaded) => {
      const defaults: Record<string, string> = {
        quick:       "CmdOrCtrl+Shift+Q",
        record:      "CmdOrCtrl+Shift+7",
        captureBar:  "CmdOrCtrl+Shift+5",
        full:        "CmdOrCtrl+Shift+1",
        region:      "CmdOrCtrl+Shift+2",
        window:      "CmdOrCtrl+Shift+3",
        all:         "CmdOrCtrl+Shift+4",
        captureCopy: "CmdOrCtrl+Shift+C",
        scroll:      "CmdOrCtrl+Shift+6",
      };
      loaded.shortcuts = { ...defaults, ...(loaded.shortcuts ?? {}) };
      if (!loaded.saveDir) loaded.saveDir = await ipc.defaultSaveDir();
      setS(loaded);
    });
    ipc.checkPermission().then(setPerm);
    ipc.getHotkeyWarning().then(setHotkeyWarning).catch(() => {});
    ipc.getPendingUpdate().then((info) => {
      if (info?.available) setUpdateInfo(info);
    });
    // Query ngay lúc mount — xử lý trường hợp update đã cài xong trước khi Settings mở
    ipc.getUpdateReady().then((ready) => {
      if (ready) setUpdateReady(true);
    });
    // Lấy version thực từ Tauri app metadata
    if ("__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/app").then(({ getVersion }) =>
        getVersion().then(setAppVersion).catch(() => {})
      );
    }

    // Sync lại settings khi có window khác (vd: CaptureBar) thay đổi defaultOutput.
    // Chỉ áp dụng các field không đang được user chỉnh trong Settings để tránh
    // ghi đè thao tác đang diễn ra (debounce). Field quan trọng nhất: defaultOutput.
    const unlistenSettings = listen<Record<string, unknown>>("settings-changed", (e) => {
      setS((prev) => {
        if (!prev) return prev;
        // Chỉ cập nhật defaultOutput từ bên ngoài nếu pending debounce không đang chạy
        // (pendingRef.current null = không có thay đổi chưa lưu từ Settings UI).
        if (pendingRef.current !== null) return prev;
        const incoming = e.payload?.defaultOutput as S["defaultOutput"] | undefined;
        if (incoming && incoming !== prev.defaultOutput) {
          return { ...prev, defaultOutput: incoming };
        }
        return prev;
      });
    });

    // Lắng nghe khi background update đã cài xong → hiện banner khởi động lại
    const unlistenUpdateReady = listen<string>("update-ready-to-relaunch", () => {
      setUpdateReady(true);
    });

    return () => {
      unlistenSettings.then((fn) => fn());
      unlistenUpdateReady.then((fn) => fn());
    };
  }, []);

  if (!s) return <div className="solid-bg" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>Đang tải…</div>;

  const persist = async (next: S) => {
    setSaveStatus("saving");
    try {
      await ipc.setSettings(next);
      setSaveStatus("saved");
      window.setTimeout(() => setSaveStatus("idle"), 1500);
    } catch {
      setSaveStatus("err");
      window.setTimeout(() => setSaveStatus("idle"), 2500);
    }
  };

  const persistDebounced = (next: S, delay = 600) => {
    pendingRef.current = next;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setSaveStatus("saving");
    debounceTimer.current = setTimeout(async () => {
      const val = pendingRef.current;
      if (!val) return;
      try {
        await ipc.setSettings(val);
        setSaveStatus("saved");
        window.setTimeout(() => setSaveStatus("idle"), 1500);
      } catch {
        setSaveStatus("err");
        window.setTimeout(() => setSaveStatus("idle"), 2500);
      }
    }, delay);
  };

  const persistShortcutsDebounced = (next: S) => {
    pendingRef.current = next;
    if (shortcutTimer.current) clearTimeout(shortcutTimer.current);
    setSaveStatus("saving");
    shortcutTimer.current = setTimeout(async () => {
      const val = pendingRef.current;
      if (!val) return;
      try {
        await ipc.setSettings(val);
        setSaveStatus("saved");
        window.setTimeout(() => setSaveStatus("idle"), 1500);
        await ipc.reloadShortcuts();
        setShortcutMsg("ok");
        setHotkeyWarning(null); // user vừa đăng ký lại thành công — cảnh báo lúc khởi động hết hiệu lực
      } catch {
        setSaveStatus("err");
        setShortcutMsg("err");
      }
      window.setTimeout(() => setShortcutMsg(null), 2500);
    }, 800);
  };

  const update = (patch: Partial<S>, opts?: { debounce?: boolean; shortcuts?: boolean }) => {
    const next = { ...s, ...patch };
    setS(next);
    if (opts?.shortcuts) persistShortcutsDebounced(next);
    else if (opts?.debounce) persistDebounced(next);
    else persist(next);
  };

  const pickDir = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") update({ saveDir: dir });
  };

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateErr(null);
    try {
      const info = await ipc.checkUpdate();
      setUpdateInfo(info);
      setUpdateStatus("idle");
    } catch (e) {
      const msg = String(e);
      if (msg.includes("404") || msg.includes("No releases") || msg.includes("not found")) {
        setUpdateInfo({ available: false, version: "", currentVersion: "" });
        setUpdateStatus("idle");
      } else {
        setUpdateErr(msg);
        setUpdateStatus("err");
        window.setTimeout(() => setUpdateStatus("idle"), 4000);
      }
    }
  };

  const handleInstall = async () => {
    setUpdateStatus("installing");
    setUpdateErr(null);
    try {
      await ipc.installUpdate();
    } catch (e) {
      setUpdateErr(String(e));
      setUpdateStatus("err");
      window.setTimeout(() => setUpdateStatus("idle"), 4000);
    }
  };

  return (
    <div className="solid-bg" style={page}>

      {/* ── Header ── */}
      <div style={header}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={appName}>SnapDoc</span>
          <span style={versionBadge}>{appVersion ? `v${appVersion}` : "…"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {updateInfo?.available && (
            <span style={updateDot} title={`v${updateInfo.version} có sẵn`}>🆕</span>
          )}
          <button
            style={{
              ...updateBtn,
              ...(updateReady ? restartBtnStyle : {}),
            }}
            disabled={updateStatus === "checking" || updateStatus === "installing"}
            onClick={updateReady ? () => ipc.restartApp() : (updateInfo?.available ? handleInstall : handleCheckUpdate)}
          >
            {updateReady                           ? "↺ Khởi động lại để áp dụng" :
             updateStatus === "checking"           ? "Đang kiểm tra…"             :
             updateStatus === "installing"         ? "Đang cài đặt…"              :
             updateInfo?.available                 ? `Cài v${updateInfo.version}` :
             "Kiểm tra cập nhật"}
          </button>
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div style={body}>

        {/* Update banners — nằm trong scroll area */}
        {updateStatus === "err" && (
          <div style={errBanner}>⚠ {updateErr || "Không kiểm tra được — kiểm tra kết nối mạng"}</div>
        )}
        {updateReady && (
          <div style={restartBanner}>
            <span>✅ Bản cập nhật đã được cài đặt. Khởi động lại để áp dụng phiên bản mới.</span>
            <button style={restartBannerBtn} onClick={() => ipc.restartApp()}>
              Khởi động lại ngay
            </button>
          </div>
        )}
        {!updateReady && updateStatus === "idle" && updateInfo && !updateInfo.available && (
          <div style={successBanner}>✓ Đang dùng phiên bản mới nhất</div>
        )}
        {!updateReady && updateInfo?.available && (
          <div style={infoBanner}>
            Có bản cập nhật: <strong>v{updateInfo.version}</strong>. Nhấn "Cài v{updateInfo.version}" để cài và khởi động lại.
          </div>
        )}

        {/* LƯU FILE */}
        <Card title="LƯU FILE">
          <Field label="Thư mục lưu mặc định">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                style={{ flex: 1, minWidth: 0 }}
                value={s.saveDir}
                onChange={(e) => update({ saveDir: e.target.value }, { debounce: true })}
              />
              <button style={smallBtn} onClick={pickDir}>Chọn…</button>
            </div>
          </Field>
          <Field label="Hành vi mặc định sau khi chụp">
            <select
              value={s.defaultOutput}
              onChange={(e) => update({ defaultOutput: e.target.value as S["defaultOutput"] })}
            >
              {OUTPUTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </Field>
          {/* <Field label="Hẹn giờ trước khi chụp">
            <select
              value={s.timerSeconds}
              onChange={(e) => update({ timerSeconds: Number(e.target.value) })}
            >
              {[0, 3, 5].map((t) => <option key={t} value={t}>{t === 0 ? "Không hẹn giờ" : `${t} giây`}</option>)}
            </select>
          </Field> */}
        </Card>

        {/* QUAY MÀN HÌNH */}
        <Card title="QUAY MÀN HÌNH">
          <Field label="Ghi âm khi quay">
            <select
              value={s.recordAudioSource ?? "off"}
              onChange={(e) => update({ recordAudioSource: e.target.value as S["recordAudioSource"] })}
            >
              <option value="off">Tắt (chỉ hình, không tiếng)</option>
              <option value="mic">Microphone</option>
              <option value="system">Âm thanh hệ thống</option>
            </select>
          </Field>
          <p style={hint}>
            Chỉ chọn được 1 nguồn tại 1 thời điểm — mic cần cấp quyền Microphone,
            âm thanh hệ thống dùng chung quyền Screen Recording đã cấp.
          </p>
        </Card>

        {/* KHỞI ĐỘNG */}
        <Card title="KHỞI ĐỘNG">
          <div style={toggleRow}>
            <div>
              <div style={toggleLabel}>Khởi động cùng hệ thống</div>
              <div style={toggleDesc}>SnapDoc tự chạy nền khi bật máy</div>
            </div>
            <Toggle
              checked={s.launchAtLogin ?? true}
              onChange={async (v) => {
                update({ launchAtLogin: v });
                await ipc.setAutostart(v).catch(() => {});
              }}
            />
          </div>
        </Card>

        {/* PHÍM TẮT */}
        <Card title="PHÍM TẮT TOÀN CỤC">
          {hotkeyWarning && (
            <div style={hotkeyWarningBox}>
              ⚠ {hotkeyWarning} — hãy đổi sang tổ hợp khác bên dưới rồi lưu lại.
            </div>
          )}
          <p style={hint}>
            Nhấp vào ô bên phải và nhấn tổ hợp phím mong muốn. Nhấn <kbd style={kbdStyle}>Esc</kbd> để hủy, <kbd style={kbdStyle}>⌫</kbd> để xóa.
          </p>
          {SHORTCUT_KEYS.map(({ key, label: lbl, hint: h }) => (
            <ShortcutRow
              key={key}
              label={lbl}
              hint={h}
              value={s.shortcuts?.[key] ?? ""}
              onChange={(v) => update({ shortcuts: { ...s.shortcuts, [key]: v } }, { shortcuts: true })}
            />
          ))}
          {shortcutMsg === "ok" && <div style={successInline}>✓ Phím tắt đã cập nhật</div>}
          {shortcutMsg === "err" && <div style={errInline}>✕ Lỗi — kiểm tra xung đột phím tắt</div>}
        </Card>

        {/* QUYỀN HỆ THỐNG */}
        <Card title="QUYỀN HỆ THỐNG">
          <div style={permRow}>
            <div>
              <div style={permLabel}>Screen Recording</div>
              <div style={permDesc}>Cần thiết để chụp màn hình</div>
            </div>
            <PermBadge granted={perm} />
          </div>
        </Card>

      </div>

      {/* ── Footer ── */}
      <div style={footer}>
        <SaveStatus status={saveStatus} />
      </div>

    </div>
  );
}

/* ── Sub-components ── */

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={card}>
      <div style={cardTitle}>{title}</div>
      <div style={cardBody}>{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={fieldWrap}>
      <label style={fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

function ShortcutRow({ label, hint, value, onChange }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRecording = async () => {
    await ipc.suspendShortcuts().catch(() => {});
    setRecording(true);
    // focus input ẩn để nhận keyboard events
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const stopRecording = async () => {
    setRecording(false);
    inputRef.current?.blur();
    await ipc.resumeShortcuts().catch(() => {});
  };

  const keyEventToShortcut = (e: React.KeyboardEvent): string | null => {
    const mods: string[] = [];
    if (e.metaKey || e.ctrlKey) mods.push("CmdOrCtrl");
    if (e.altKey)               mods.push("Alt");
    if (e.shiftKey)             mods.push("Shift");

    const ignoredKeys = new Set([
      "Control", "Meta", "Alt", "Shift",
      "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock",
    ]);
    if (ignoredKeys.has(e.key)) return null;
    if (mods.length === 0) return null;

    let key = e.key;
    if (key.length === 1) key = key.toUpperCase();
    else {
      const map: Record<string, string> = {
        " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down",
        "ArrowLeft": "Left", "ArrowRight": "Right",
        "Escape": "Escape", "Enter": "Return", "Tab": "Tab",
        "Backspace": "Backspace", "Delete": "Delete",
        "Home": "Home", "End": "End", "PageUp": "PageUp", "PageDown": "PageDown",
        "F1":"F1","F2":"F2","F3":"F3","F4":"F4","F5":"F5","F6":"F6",
        "F7":"F7","F8":"F8","F9":"F9","F10":"F10","F11":"F11","F12":"F12",
      };
      key = map[e.key] ?? e.key;
    }
    return [...mods, key].join("+");
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      onChange("");
      await stopRecording();
      return;
    }
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      await stopRecording();
      return;
    }

    const combo = keyEventToShortcut(e);
    if (combo) {
      onChange(combo);
      await stopRecording();
    }
  };

  const display = (v: string) => {
    if (!v) return null;
    const parts = v.replace("CmdOrCtrl", "⌘/Ctrl").replace("Alt", "⌥").replace("Shift", "⇧").split("+");
    return parts.map((p, i) => (
      <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
        {i > 0 && <span style={{ color: "var(--text-dim)", fontSize: 10, margin: "0 1px" }}>+</span>}
        <kbd style={kbdStyle}>{p}</kbd>
      </span>
    ));
  };

  return (
    <div style={scRow}>
      <div style={scLeft}>
        <span style={scLabel}>{label}</span>
        {hint && <span style={scHint}>{hint}</span>}
      </div>

      {/* Hidden input nhận keyboard events thực sự */}
      <input
        ref={inputRef}
        style={scHiddenInput}
        readOnly
        onKeyDown={handleKeyDown}
        onBlur={() => { if (recording) stopRecording(); }}
      />

      {/* Visual recorder */}
      <div
        style={{
          ...scRecorder,
          ...(recording ? scRecorderActive : {}),
          ...(!value && !recording ? scRecorderEmpty : {}),
        }}
        onMouseDown={(e) => {
          e.preventDefault();
          if (!recording) startRecording();
        }}
      >
        {recording ? (
          <span style={{ color: "var(--accent)", fontSize: 11 }}>Nhấn tổ hợp phím…</span>
        ) : value ? (
          <span style={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", justifyContent: "center" }}>
            {display(value)}
          </span>
        ) : (
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>Nhấp để đặt phím tắt</span>
        )}
      </div>

      {value && !recording && (
        <button
          style={clearBtn}
          title="Xóa phím tắt"
          onMouseDown={async (e) => { e.preventDefault(); onChange(""); }}
        >×</button>
      )}
    </div>
  );
}

function PermBadge({ granted }: { granted: boolean | null }) {
  if (granted === null) return <span style={permPending}>Đang kiểm tra…</span>;
  return granted
    ? <span style={permGranted}>✓ Đã cấp</span>
    : <span style={permDenied}>✕ Chưa cấp</span>;
}

function SaveStatus({ status }: { status: "idle" | "saving" | "saved" | "err" }) {
  if (status === "idle") return <span style={footerText}>Thay đổi được lưu tự động.</span>;
  const map = {
    saving: { text: "Đang lưu…",  color: "var(--text-dim)" },
    saved:  { text: "✓ Đã lưu",   color: "#22c55e" },
    err:    { text: "✕ Lỗi lưu",  color: "var(--danger)" },
  } as const;
  return <span style={{ ...footerText, color: map[status].color }}>{map[status].text}</span>;
}

/* ── Styles ── */

const page: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",  // page itself clips, body inside scrolls
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 16px 10px",
  flexShrink: 0,
};

const appName: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: "-0.3px",
};

const versionBadge: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
  fontWeight: 400,
};

const updateBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const updateDot: React.CSSProperties = {
  fontSize: 16,
};

const body: React.CSSProperties = {
  flex: "1 1 0",
  minHeight: 0,
  overflowY: "auto",
  overflowX: "hidden",
  padding: "4px 12px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const footer: React.CSSProperties = {
  padding: "8px 16px",
  borderTop: "1px solid var(--border)",
  textAlign: "center",
  flexShrink: 0,
};

const footerText: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
};

// Cards
const card: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
  flexShrink: 0,   // không bị ép nhỏ khi body scroll
};

const cardTitle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "var(--text-dim)",
  padding: "8px 12px 6px",
  background: "var(--bg-elevated)",
  borderBottom: "1px solid var(--border)",
};

const cardBody: React.CSSProperties = {
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

// Fields
const fieldWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const fieldLabel: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
};

const hint: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
  lineHeight: 1.5,
  marginBottom: 2,
};

const scRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 0",
  borderBottom: "1px solid var(--border)",
  position: "relative",
};

const scLeft: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const scLabel: React.CSSProperties = {
  fontSize: 13,
  display: "block",
};

const scHint: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-dim)",
  display: "block",
  marginTop: 1,
};

const scRecorder: React.CSSProperties = {
  minWidth: 150,
  height: 30,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  outline: "none",
  userSelect: "none",
  WebkitUserSelect: "none",
};

const scRecorderActive: React.CSSProperties = {
  border: "1px solid var(--accent)",
  boxShadow: "0 0 0 2px var(--accent)30",
  background: "var(--bg)",
};

const scRecorderEmpty: React.CSSProperties = {
  border: "1px dashed var(--border)",
};

const kbdStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 5px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  fontSize: 11,
  fontFamily: "ui-monospace, monospace",
  lineHeight: 1.5,
};

const clearBtn: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 10,
  border: "none",
  background: "var(--bg-elevated)",
  color: "var(--text-dim)",
  fontSize: 14,
  lineHeight: 1,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  padding: 0,
};

// Input thực để capture keyboard — ẩn hoàn toàn nhưng vẫn focusable
const scHiddenInput: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none",
  border: "none",
  padding: 0,
  margin: 0,
  overflow: "hidden",
};

// Permissions
const permRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const permLabel: React.CSSProperties = { fontSize: 13 };

const permDesc: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
  marginTop: 2,
};

const permGranted: React.CSSProperties = {
  fontSize: 12,
  color: "#22c55e",
  background: "#22c55e18",
  border: "1px solid #22c55e44",
  borderRadius: 4,
  padding: "3px 8px",
  whiteSpace: "nowrap",
};

const permDenied: React.CSSProperties = {
  fontSize: 12,
  color: "var(--danger)",
  background: "#ef444418",
  border: "1px solid #ef444440",
  borderRadius: 4,
  padding: "3px 8px",
  whiteSpace: "nowrap",
};

const permPending: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim)",
};

// Banners
const errBanner: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--danger)",
  background: "#ef444415",
  border: "1px solid #ef444430",
};

const successBanner: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "#22c55e",
  background: "#22c55e15",
  border: "1px solid #22c55e30",
};

const infoBanner: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "#f59e0b",
  background: "#f59e0b15",
  border: "1px solid #f59e0b30",
};

const restartBanner: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "#22c55e",
  background: "#22c55e15",
  border: "1px solid #22c55e30",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const restartBannerBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: "1px solid #22c55e60",
  background: "#22c55e25",
  color: "#22c55e",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const restartBtnStyle: React.CSSProperties = {
  background: "#22c55e25",
  borderColor: "#22c55e60",
  color: "#22c55e",
  fontWeight: 600,
};

const successInline: React.CSSProperties = {
  fontSize: 11,
  color: "#22c55e",
  marginTop: 2,
};

const errInline: React.CSSProperties = {
  fontSize: 11,
  color: "var(--danger)",
  marginTop: 2,
};

const hotkeyWarningBox: React.CSSProperties = {
  fontSize: 12,
  color: "#fca5a5",
  background: "rgba(239,68,68,0.12)",
  border: "1px solid rgba(239,68,68,0.35)",
  borderRadius: 8,
  padding: "8px 10px",
  marginBottom: 10,
  lineHeight: 1.5,
};

const smallBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// Toggle switch component
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        background: checked ? "var(--accent, #6366f1)" : "var(--border, rgba(255,255,255,0.15))",
        cursor: "pointer",
        position: "relative",
        flexShrink: 0,
        transition: "background 0.2s",
        padding: 0,
      }}
    >
      <span style={{
        position: "absolute",
        top: 3,
        left: checked ? 21 : 3,
        width: 16,
        height: 16,
        borderRadius: 8,
        background: "#fff",
        transition: "left 0.2s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
      }} />
    </button>
  );
}

const toggleRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const toggleLabel: React.CSSProperties = { fontSize: 13 };

const toggleDesc: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
  marginTop: 2,
};
