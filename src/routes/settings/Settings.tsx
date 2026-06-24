import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc, type Settings as S } from "../../lib/ipc";

const OUTPUTS = [
  { id: "editor", label: "Mở editor" },
  { id: "clipboard", label: "Clipboard" },
  { id: "save", label: "Lưu file" },
  { id: "save_copy", label: "Lưu + Copy" },
] as const;

const SHORTCUT_LABELS: Record<string, string> = {
  captureBar: "Mở thanh chụp",
  full: "Chụp toàn màn hình",
  region: "Chụp vùng chọn",
  window: "Chụp cửa sổ",
  captureCopy: "Chụp & copy",
};

export default function Settings() {
  const [s, setS] = useState<S | null>(null);
  const [perm, setPerm] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc.getSettings().then(async (loaded) => {
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

  const persist = async () => {
    await ipc.setSettings(s);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="solid-bg" style={page}>
      <h2 style={{ fontSize: 18, fontWeight: 500 }}>Cài đặt</h2>

      <section style={section}>
        <label style={label}>Thư mục lưu mặc định</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={s.saveDir} onChange={(e) => update({ saveDir: e.target.value })} />
          <button style={btn} onClick={pickDir}>
            Chọn…
          </button>
        </div>
      </section>

      <section style={section}>
        <label style={label}>Hành vi mặc định sau khi chụp</label>
        <select value={s.defaultOutput} onChange={(e) => update({ defaultOutput: e.target.value as S["defaultOutput"] })}>
          {OUTPUTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </section>

      <section style={section}>
        <label style={label}>Hẹn giờ (giây)</label>
        <select value={s.timerSeconds} onChange={(e) => update({ timerSeconds: Number(e.target.value) })}>
          {[0, 3, 5].map((t) => (
            <option key={t} value={t}>
              {t === 0 ? "Không" : `${t}s`}
            </option>
          ))}
        </select>
      </section>

      <section style={section}>
        <label style={label}>Phím tắt</label>
        {Object.entries(s.shortcuts).map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ flex: 1, color: "var(--text-dim)", fontSize: 13 }}>{SHORTCUT_LABELS[k] ?? k}</span>
            <input
              style={{ width: 180 }}
              value={v}
              onChange={(e) => update({ shortcuts: { ...s.shortcuts, [k]: e.target.value } })}
            />
          </div>
        ))}
        <p style={note}>Lưu ý: phím tắt áp dụng sau khi khởi động lại app (v0.1).</p>
      </section>

      <section style={section}>
        <label style={label}>Quyền chụp màn hình</label>
        <div style={{ fontSize: 13, color: perm ? "#22c55e" : "var(--danger)" }}>
          {perm === null ? "Đang kiểm tra…" : perm ? "✓ Có quyền chụp" : "✕ Thiếu quyền (macOS: cấp Screen Recording)"}
        </div>
      </section>

      <div style={{ display: "flex", gap: 10, marginTop: "auto" }}>
        <button style={{ ...btn, background: "var(--accent)", color: "#fff" }} onClick={persist}>
          {saved ? "Đã lưu ✓" : "Lưu cài đặt"}
        </button>
        <button style={btn} onClick={() => ipc.closeSelf()}>
          Đóng
        </button>
      </div>
    </div>
  );
}

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
const note: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginTop: 4 };
const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
};
