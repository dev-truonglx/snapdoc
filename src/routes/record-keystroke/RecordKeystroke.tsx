import React, { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

interface KeystrokeEvent {
  key: string;
  modifiers: string[];
  label: string;
}

export default function RecordKeystroke() {
  const [current, setCurrent] = useState<KeystrokeEvent | null>(null);
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unlisten = listen<KeystrokeEvent>("record-keystroke-press", (event) => {
      const payload = event.payload;
      if (!payload || !payload.key) return;

      setCurrent(payload);
      setActive(true);

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      // Giữ hiển thị 1.5 giây sau lần bấm phím cuối cùng
      timerRef.current = setTimeout(() => {
        setActive(false);
      }, 1500);
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unlisten.then((fn) => fn());
    };
  }, []);

  // Chuẩn hóa ký hiệu phím modifier chuẩn macOS
  const formatModifier = (mod: string) => {
    switch (mod.toLowerCase()) {
      case "cmd":
      case "command":
        return "⌘ Cmd";
      case "opt":
      case "option":
      case "alt":
        return "⌥ Opt";
      case "ctrl":
      case "control":
        return "⌃ Ctrl";
      case "shift":
        return "⇧ Shift";
      case "win":
        return "⊞ Win";
      default:
        return mod;
    }
  };

  // Chuẩn hóa phím chính (Esc, Enter, Space...) chuẩn Apple Style
  const formatMainKey = (key: string) => {
    switch (key.toLowerCase()) {
      case "esc":
      case "escape":
        return "⎋ Esc";
      case "return":
      case "enter":
        return "⏎ Return";
      case "space":
        return "␣ Space";
      case "tab":
        return "⇥ Tab";
      case "delete":
      case "backspace":
        return "⌫ Delete";
      case "forwarddelete":
        return "⌦ Del";
      case "clear":
        return "Clear";
      case "help":
        return "Help";
      case "home":
        return "Home";
      case "end":
        return "End";
      case "pageup":
        return "PageUp";
      case "pagedown":
        return "PageDown";
      default:
        return key.toUpperCase();
    }
  };

  if (!current) return null;

  const displayMainKey = formatMainKey(current.key);
  const isSingleChar = displayMainKey.length === 1;

  return (
    <div style={containerStyle}>
      <div
        style={{
          ...badgeStyle,
          opacity: active ? 1 : 0,
          transform: active ? "scale(1) translateY(0)" : "scale(0.95) translateY(6px)",
        }}
      >
        {current.modifiers.map((mod, i) => (
          <React.Fragment key={`mod-${i}`}>
            <span style={{ ...keycapBaseStyle, ...modifierKeycapStyle }}>
              {formatModifier(mod)}
            </span>
            <span style={separatorStyle}>+</span>
          </React.Fragment>
        ))}
        <span
          style={{
            ...keycapBaseStyle,
            ...mainKeycapStyle,
            ...(isSingleChar ? singleCharKeycapStyle : {}),
          }}
        >
          {displayMainKey}
        </span>
      </div>
    </div>
  );
}

/* ── Styles ── */

const containerStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  overflow: "hidden",
  userSelect: "none",
  pointerEvents: "none",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  background: "rgba(20, 22, 28, 0.92)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  borderRadius: 12,
  border: "1px solid rgba(255, 255, 255, 0.16)",
  boxShadow:
    "0 10px 28px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)",
  transition: "opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
};

const keycapBaseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  minWidth: 32,
  boxSizing: "border-box",
  borderRadius: 7,
  color: "#ffffff",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro", "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  WebkitFontSmoothing: "antialiased",
  lineHeight: 1,
  whiteSpace: "nowrap",
};

// Phím modifier (⌘ Cmd, ⇧ Shift, etc.)
const modifierKeycapStyle: React.CSSProperties = {
  padding: "0 10px",
  fontSize: 13,
  fontWeight: 600,
  background: "linear-gradient(180deg, rgba(255, 255, 255, 0.18) 0%, rgba(255, 255, 255, 0.1) 100%)",
  border: "1px solid rgba(255, 255, 255, 0.22)",
  boxShadow: "0 2px 0 rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.3)",
};

// Phím chính thông thường (Esc, Enter, Space...)
const mainKeycapStyle: React.CSSProperties = {
  padding: "0 10px",
  fontSize: 13,
  fontWeight: 600,
  background: "linear-gradient(180deg, rgba(255, 255, 255, 0.26) 0%, rgba(255, 255, 255, 0.16) 100%)",
  border: "1px solid rgba(255, 255, 255, 0.32)",
  boxShadow: "0 2px 0 rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.35)",
};

// Phím độc lập 1 ký tự (A, B, C, 1, 2...) vuông vức cân đối
const singleCharKeycapStyle: React.CSSProperties = {
  width: 32,
  minWidth: 32,
  padding: 0,
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: "0.02em",
};

const separatorStyle: React.CSSProperties = {
  color: "rgba(255, 255, 255, 0.45)",
  fontSize: 13,
  fontWeight: 600,
  margin: "0 1px",
};
