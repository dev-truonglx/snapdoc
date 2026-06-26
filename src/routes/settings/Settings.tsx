import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc, type Settings as S } from "../../lib/ipc";

const OUTPUTS = [
  { id: "editor",    label: "Mở editor" },
  { id: "clipboard", label: "Clipboard" },
  { id: "save",      label: "Lưu file" },
  { id: "save_copy", label: "Lưu + Copy" },
] as const;

// Thứ tự hiển thị cố định cho phím tắt.
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
  const [saved, setSaved] = useState(false);
  const [shortcutMsg, setShortcutMsg] = useState<"ok" | "err" | null>(null);

  useEffect(() => {
    ipc.getSettings().then(async (loaded) => {
      // Đảm bảo mọi key phím tắt đều tồn tại (migrations).
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

  const update = (patch: Partial<S>) => setS({ ...s, ...patch });

  const pickDir = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") update({ saveDir: dir });
  };

  // Lưu settings + áp dụng phím tắt ngay lập tức.
  const persist = async () => {
    await ipc.setSettings(s);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
    // Reload shortcuts ngay sau khi lưu.
    try {
      await ipc.reloadShortcuts();
      setShortcutMsg("ok");
    } catch {
      setShortcutMsg("err");
    }
    window.setTimeout(() => setShortcutMsg(null), 2500);
  };

  // Áp dụng phím tắt mà không cần lưu lại toàn bộ settings.
  const applyShortcuts = async () => {
    await ipc.setSettings(s);
    try {
      await ipc.reloadShortcuts();
      setShortcutMsg("ok");
    } catch {
      setShortcutMsg("err");
    }
    window.setTimeout(() => setShortcutMsg(null), 2500);
  };

  return (
    <div className="solid-bg" style={page}>
      <h2 style={{ fontSize: 18, fontWeight: 500 }}>Cài đặt</h2>

      {/* Thư mục lưu */}
      <section style={section}>
        <label style={label}>Thư mục lưu mặc định</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            value={s.saveDir}
            onChange={(e) => update({ saveDir: e.target.value })}
          />
          <button style={btn} onClick={pickDir}>Chọn…</button>
        </div>
      </section>

      {/* Hành vi sau khi chụp */}
      <section style={section}>
        <label style={label}>Hành vi mặc định sau khi chụp</label>
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
        <label style={label}>Hẹn giờ (giây)</label>
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
        <label style={label}>Phím tắt toàn cục</label>
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
                update({ shortcuts: { ...s.shortcuts, [key]: e.target.value } })
              }
            />
          </div>
        ))}

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
          <button style={{ ...btn, fontSize: 12 }} onClick={applyShortcuts}>
            ⚡ Áp dụng ngay
          </button>
          {shortcutMsg === "ok" && (
            <span style={{ fontSize: 12, color: "#22c55e" }}>✓ Phím tắt đã cập nhật</span>
          )}
          {shortcutMsg === "err" && (
            <span style={{ fontSize: 12, color: "var(--danger)" }}>
              ✕ Lỗi — kiểm tra xung đột phím tắt
            </span>
          )}
        </div>
      </section>

      {/* Quyền chụp */}
      <section style={section}>
        <label style={label}>Quyền chụp màn hình</label>
        <div style={{ fontSize: 13, color: perm ? "#22c55e" : "var(--danger)" }}>
          {perm === null
            ? "Đang kiểm tra…"
            : perm
            ? "✓ Có quyền chụp"
            : "✕ Thiếu quyền (macOS: cấp Screen Recording)"}
        </div>
      </section>

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, marginTop: "auto" }}>
        <button
          style={{ ...btn, background: "var(--accent)", color: "#fff" }}
          onClick={persist}
        >
          {saved ? "Đã lưu ✓" : "Lưu cài đặt"}
        </button>
        <button style={btn} onClick={() => ipc.closeSelf()}>Đóng</button>
      </div>
    </div>
  );
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
const label: React.CSSProperties = { fontSize: 13, fontWeight: 500 };
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
