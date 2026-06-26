import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc, type Settings as S } from "../../lib/ipc";

const OUTPUTS = [
  { id: "editor",    label: "Mở editor" },
  { id: "clipboard", label: "Clipboard" },
  { id: "save",      label: "Lưu file" },
  { id: "save_copy", label: "Lưu + Copy" },
] as const;

const SHORTCUT_KEYS: { key: string; label: string }[] = [
  { key: "captureBar",  label: "Mở thanh chụp" },
  { key: "full",        label: "Chụp toàn màn hình" },
  { key: "region",      label: "Chụp vùng chọn" },
  { key: "window",      label: "Chụp cửa sổ" },
  { key: "all",         label: "Chụp tất cả màn hình" },
  { key: "captureCopy", label: "Chụp & copy nhanh" },
];

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [perm, setPerm] = useState<boolean | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "err">("idle");
  const [shortcutMsg, setShortcutMsg] = useState<"ok" | "err" | null>(null);

  const pendingRef = useRef<S | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shortcutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ipc.getSettings().then(async (loaded) => {
      const defaults: Record<string, string> = {
        captureBar:  "CmdOrCtrl+Shift+5",
        full:        "CmdOrCtrl+Shift+1",
        region:      "CmdOrCtrl+Shift+2",
        window:      "CmdOrCtrl+Shift+3",
        all:         "CmdOrCtrl+Shift+4",
        captureCopy: "CmdOrCtrl+Shift+C",
      };
      loaded.shortcuts = { ...defaults, ...(loaded.shortcuts ?? {}) };
      if (!loaded.saveDir) loaded.saveDir = await ipc.defaultSaveDir();
      setS(loaded);
    });
    ipc.checkPermission().then(setPerm);
  }, []);

  if (!s) return <div className="solid-bg" style={{ height: "100%", padding: 20 }}>Đang tải…</div>;

  // Lưu ngay (dùng cho select)
  const persist = async (next: S) => {
    setSaveStatus("saving");
    try {
      await ipc.setSettings(next);
      setSaveStatus("saved");
      window.setTimeout(() => setSaveStatus("idle"), 1200);
    } catch {
      setSaveStatus("err");
      window.setTimeout(() => setSaveStatus("idle"), 2500);
    }
  };

  // Lưu debounce (dùng cho text input)
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
        window.setTimeout(() => setSaveStatus("idle"), 1200);
      } catch {
        setSaveStatus("err");
        window.setTimeout(() => setSaveStatus("idle"), 2500);
      }
    }, delay);
  };

  // Lưu + reload shortcuts debounce (dùng cho shortcut input)
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
        window.setTimeout(() => setSaveStatus("idle"), 1200);
        await ipc.reloadShortcuts();
        setShortcutMsg("ok");
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

  return (
    <div className="solid-bg" style={page}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>Cài đặt</h2>
        <SaveIndicator status={saveStatus} />
      </div>

      {/* Thư mục lưu */}
      <section style={section}>
        <label style={labelStyle}>Thư mục lưu mặc định</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            value={s.saveDir}
            onChange={(e) => update({ saveDir: e.target.value }, { debounce: true })}
          />
          <button style={btn} onClick={pickDir}>Chọn…</button>
        </div>
      </section>

      {/* Hành vi sau khi chụp */}
      <section style={section}>
        <label style={labelStyle}>Hành vi mặc định sau khi chụp</label>
        <select
          value={s.defaultOutput}
          onChange={(e) => update({ defaultOutput: e.target.value as S["defaultOutput"] })}
        >
          {OUTPUTS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </section>

      {/* Hẹn giờ */}
      <section style={section}>
        <label style={labelStyle}>Hẹn giờ (giây)</label>
        <select
          value={s.timerSeconds}
          onChange={(e) => update({ timerSeconds: Number(e.target.value) })}
        >
          {[0, 3, 5].map((t) => (
            <option key={t} value={t}>{t === 0 ? "Không" : `${t}s`}</option>
          ))}
        </select>
      </section>

      {/* Phím tắt */}
      <section style={section}>
        <label style={labelStyle}>Phím tắt toàn cục</label>
        <p style={note}>
          Định dạng: <code>CmdOrCtrl</code>, <code>Alt</code>, <code>Shift</code> + phím.
          Ví dụ: <code>CmdOrCtrl+Shift+1</code>
        </p>

        {SHORTCUT_KEYS.map(({ key, label: lbl }) => (
          <div key={key} style={shortcutRow}>
            <span style={shortcutLabel}>{lbl}</span>
            <input
              style={shortcutInput}
              value={s.shortcuts?.[key] ?? ""}
              placeholder="Bỏ trống để tắt"
              onChange={(e) =>
                update({ shortcuts: { ...s.shortcuts, [key]: e.target.value } }, { shortcuts: true })
              }
            />
          </div>
        ))}

        {shortcutMsg === "ok" && (
          <span style={{ fontSize: 12, color: "#22c55e", marginTop: 4 }}>✓ Phím tắt đã cập nhật</span>
        )}
        {shortcutMsg === "err" && (
          <span style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
            ✕ Lỗi — kiểm tra xung đột phím tắt
          </span>
        )}
      </section>

      {/* Quyền chụp */}
      <section style={section}>
        <label style={labelStyle}>Quyền chụp màn hình</label>
        <div style={{ fontSize: 13, color: perm ? "#22c55e" : "var(--danger)" }}>
          {perm === null
            ? "Đang kiểm tra…"
            : perm
            ? "✓ Có quyền chụp"
            : "✕ Thiếu quyền (macOS: cấp Screen Recording)"}
        </div>
      </section>
    </div>
  );
}

/* ── Save indicator ── */

function SaveIndicator({ status }: { status: "idle" | "saving" | "saved" | "err" }) {
  if (status === "idle") return null;
  const map = {
    saving: { text: "Đang lưu…", color: "var(--text-dim, #94a3b8)" },
    saved:  { text: "✓ Đã lưu",  color: "#22c55e" },
    err:    { text: "✕ Lỗi lưu", color: "var(--danger, #ef4444)" },
  } as const;
  const { text, color } = map[status];
  return <span style={{ fontSize: 12, color }}>{text}</span>;
}

/* ── styles ── */

const page: React.CSSProperties = {
  height: "100%",
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  overflowY: "auto",
};
const section: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 500 };
const note: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginTop: 2 };
const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
};
const shortcutRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 4,
};
const shortcutLabel: React.CSSProperties = {
  flex: 1,
  color: "var(--text-dim)",
  fontSize: 13,
  minWidth: 180,
};
const shortcutInput: React.CSSProperties = {
  width: 200,
  fontFamily: "monospace",
  fontSize: 12,
};
