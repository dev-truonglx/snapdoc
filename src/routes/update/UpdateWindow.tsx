/**
 * UpdateWindow — cửa sổ nhỏ nổi lên khi startup check phát hiện bản cập nhật.
 * Nhận thông tin qua event `update-available` (từ Rust notify_update_window)
 * hoặc từ get_pending_update khi load (để không bị race condition với event).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ipc, type UpdateInfo } from "../../lib/ipc";

export default function UpdateWindow() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [status, setStatus] = useState<"idle" | "installing" | "err">("idle");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // 1) Lấy ngay từ cache (không phụ thuộc timing event)
    ipc.getPendingUpdate().then((i) => {
      if (i?.available) setInfo(i);
    });

    // 2) Lắng nghe event từ Rust (trường hợp cửa sổ được mở sau event)
    const unlisten = listen<UpdateInfo>("update-available", (e) => {
      setInfo(e.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleInstall = async () => {
    setStatus("installing");
    setErr(null);
    try {
      await ipc.installUpdate();
      // Rust sẽ gọi app.restart() — dòng này không chạy
    } catch (e) {
      setErr(String(e));
      setStatus("err");
    }
  };

  const handleLater = () => {
    ipc.closeSelf();
  };

  if (!info) {
    return (
      <div style={container}>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div style={container}>
      <div style={iconWrap}>
        <img src="/app-icon.png" width={64} height={64} style={{ borderRadius: 14 }} alt="SnapDoc" />
      </div>

      <h2 style={title}>{t("updates.newUpdateTitle")}</h2>
      <p style={versionText}>
        <strong>v{info.version}</strong>
        <span style={{ color: "var(--text-dim)" }}> {t("updates.currentVersionText", { version: info.currentVersion })}</span>
      </p>
      <p style={desc}>
        {t("updates.updateDesc")}
      </p>

      {status === "err" && err && (
        <div style={errBox}>✕ {err}</div>
      )}

      <div style={actions}>
        <button
          style={{ ...actionBtn, ...primaryBtn }}
          disabled={status === "installing"}
          onClick={handleInstall}
        >
          {status === "installing" ? t("updates.installing") : t("updates.installAndRestart")}
        </button>
        <button
          style={{ ...actionBtn, ...secondaryBtn }}
          disabled={status === "installing"}
          onClick={handleLater}
        >
          {t("updates.later")}
        </button>
      </div>
    </div>
  );
}

/* ── Styles ── */

const container: React.CSSProperties = {
  height: "100%",
  padding: "28px 24px 20px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: 8,
  background: "var(--bg, #1e1e2e)",
  color: "var(--text, #cdd6f4)",
};

const iconWrap: React.CSSProperties = {
  marginBottom: 4,
};

const title: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  margin: 0,
};

const versionText: React.CSSProperties = {
  fontSize: 13,
  margin: 0,
};

const desc: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-dim, #94a3b8)",
  margin: "4px 0 8px",
  lineHeight: 1.5,
};

const errBox: React.CSSProperties = {
  fontSize: 12,
  color: "var(--danger, #ef4444)",
  background: "#ef444420",
  border: "1px solid #ef444440",
  borderRadius: 6,
  padding: "6px 10px",
  width: "100%",
  textAlign: "left",
};

const actions: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 4,
  width: "100%",
};

const actionBtn: React.CSSProperties = {
  flex: 1,
  padding: "9px 12px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  border: "none",
};

const primaryBtn: React.CSSProperties = {
  background: "#f59e0b",
  color: "#000",
};

const secondaryBtn: React.CSSProperties = {
  background: "var(--bg-elevated, #313244)",
  color: "var(--text, #cdd6f4)",
  border: "1px solid var(--border, #45475a)",
};
