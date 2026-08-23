import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ipc, type AudioSource, type OutputMode } from "../../lib/ipc";

export default function CaptureBarPopover() {
  const { t } = useTranslation();
  const [output, setOutput] = useState<OutputMode>("editor");
  const [audioSource, setAudioSource] = useState<AudioSource>("off");
  const [delaySeconds, setDelaySeconds] = useState<0 | 5 | 10>(0);
  const userPickedRef = useRef(false);

  const OUTPUTS: { id: OutputMode; label: string }[] = [
    { id: "editor",      label: t("outputs.editor")      },
    { id: "clipboard",   label: t("outputs.clipboard")   },
    { id: "save",        label: t("outputs.save")        },
    { id: "save_copy",   label: t("outputs.save_copy")   },
    { id: "copy_editor", label: t("outputs.copy_editor") },
  ];

  const AUDIO_OPTIONS: { id: AudioSource; label: string }[] = [
    { id: "off",    label: t("captureBar.audioOff")    },
    { id: "mic",    label: t("captureBar.audioMic")    },
    { id: "system", label: t("captureBar.audioSystem") },
    { id: "both",   label: t("captureBar.audioBoth")   },
  ];

  const CAPTURE_DELAYS: { id: 0 | 5 | 10; label: string }[] = [
    { id: 0,  label: t("captureBar.noDelay")  },
    { id: 5,  label: t("captureBar.delay5s")  },
    { id: 10, label: t("captureBar.delay10s") },
  ];

  const refreshSettings = () => {
    ipc.getSettings().then((s) => {
      if (s?.defaultOutput) setOutput(s.defaultOutput);
      if (s?.recordAudioSource) setAudioSource(s.recordAudioSource);
      if (s?.timerSeconds === 0 || s?.timerSeconds === 5 || s?.timerSeconds === 10) {
        setDelaySeconds(s.timerSeconds);
      }
    }).catch(() => {});
  };

  useEffect(() => {
    refreshSettings();

    // Sync settings khi settings thay đổi từ các cửa sổ khác
    const unlistenSettings = listen<Record<string, unknown>>("settings-changed", (e) => {
      if (!userPickedRef.current && e.payload?.defaultOutput) {
        setOutput(e.payload.defaultOutput as OutputMode);
      }
      if (e.payload?.recordAudioSource) {
        setAudioSource(e.payload.recordAudioSource as AudioSource);
      }
      const timer = e.payload?.timerSeconds;
      if (timer === 0 || timer === 5 || timer === 10) {
        setDelaySeconds(timer as 0 | 5 | 10);
      }
    });

    // Re-sync settings mỗi khi popover được focus / mở lại
    const unlistenFocus = listen("tauri://focus", () => {
      refreshSettings();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        ipc.hideCaptureBarPopover().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      unlistenSettings.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
    };
  }, []);

  const selectOutput = (o: OutputMode) => {
    userPickedRef.current = true;
    setOutput(o);
    ipc.getSettings().then((s) => {
      if (s) return ipc.setSettings({ ...s, defaultOutput: o });
    }).catch(() => {}).finally(() => {
      userPickedRef.current = false;
      ipc.hideCaptureBarPopover().catch(() => {});
    });
  };

  const selectAudioSource = (a: AudioSource) => {
    setAudioSource(a);
    ipc.getSettings().then((s) => {
      if (s) return ipc.setSettings({ ...s, recordAudioSource: a });
    }).catch(() => {}).finally(() => {
      ipc.hideCaptureBarPopover().catch(() => {});
    });
  };

  const selectDelay = (d: 0 | 5 | 10) => {
    setDelaySeconds(d);
    ipc.getSettings().then((s) => {
      if (s) return ipc.setSettings({ ...s, timerSeconds: d });
    }).catch(() => {}).finally(() => {
      ipc.hideCaptureBarPopover().catch(() => {});
    });
  };

  return (
    <div style={container}>
      <div style={popoverBox}>
        {/* Section 1: Output ảnh */}
        <div style={popSectionLabel}>{t("captureBar.photoSection")}</div>
        {OUTPUTS.map((o) => (
          <button
            key={o.id}
            style={popItem(output === o.id)}
            onClick={() => selectOutput(o.id)}
            className="popover-btn"
          >
            <span style={{ flex: 1, textAlign: "left" }}>{o.label}</span>
            {output === o.id && <span style={checkMark}>✓</span>}
          </button>
        ))}

        {/* Divider */}
        <div style={popDivider} />

        {/* Section 2: Nguồn audio quay */}
        <div style={popSectionLabel}>{t("captureBar.videoSection")}</div>
        {AUDIO_OPTIONS.map((a) => (
          <button
            key={a.id}
            style={popItem(audioSource === a.id)}
            onClick={() => selectAudioSource(a.id)}
            className="popover-btn"
          >
            <span style={{ flex: 1, textAlign: "left" }}>{a.label}</span>
            {audioSource === a.id && <span style={checkMark}>✓</span>}
          </button>
        ))}

        {/* Divider */}
        <div style={popDivider} />

        {/* Section 3: Hẹn giờ chụp */}
        <div style={popSectionLabel}>{t("captureBar.timerSection")}</div>
        {CAPTURE_DELAYS.map((d) => (
          <button
            key={d.id}
            style={popItem(delaySeconds === d.id)}
            onClick={() => selectDelay(d.id)}
            className="popover-btn"
          >
            <span style={{ flex: 1, textAlign: "left" }}>{d.label}</span>
            {delaySeconds === d.id && <span style={checkMark}>✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Styles ── */

const container: React.CSSProperties = {
  width: "100%",
  height: "100%",
  padding: "6px",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
};

const popoverBox: React.CSSProperties = {
  background: "rgba(30, 30, 36, 0.98)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 10,
  padding: "6px 4px",
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  whiteSpace: "nowrap",
};

const popSectionLabel: React.CSSProperties = {
  padding: "4px 10px 2px",
  fontSize: 10,
  fontWeight: 600,
  color: "rgba(255, 255, 255, 0.4)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const popItem = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 10px",
  borderRadius: 6,
  fontSize: 12,
  color: active ? "#ffffff" : "var(--text)",
  background: active ? "rgba(255, 255, 255, 0.1)" : "transparent",
  fontWeight: active ? 500 : 400,
  width: "100%",
  boxSizing: "border-box",
  cursor: "pointer",
  transition: "background 0.1s ease, color 0.1s ease",
});

const checkMark: React.CSSProperties = {
  opacity: 0.9,
  fontSize: 12,
  fontWeight: "bold",
  color: "var(--accent, #3b82f6)",
};

const popDivider: React.CSSProperties = {
  height: 1,
  background: "rgba(255, 255, 255, 0.08)",
  margin: "3px 4px",
};
