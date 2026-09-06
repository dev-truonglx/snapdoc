import React, { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

interface MouseClickEvent {
  x: number;
  y: number;
  button: "left" | "right" | "middle";
  count: number;
}

interface ActiveClickItem {
  id: number;
  x: number;
  y: number;
  button: "left" | "right" | "middle";
  isDouble: boolean;
}

const ANIMATION_DURATION = 450; // ms

export default function RecordClicks() {
  const [clicks, setClicks] = useState<ActiveClickItem[]>([]);
  const idCounter = useRef(0);

  useEffect(() => {
    const unlisten = listen<MouseClickEvent>("record-mouse-click", (event) => {
      const payload = event.payload;
      if (!payload) return;

      const newId = ++idCounter.current;
      const isDouble = (payload.count ?? 1) >= 2;

      setClicks((prev) => [
        ...prev,
        {
          id: newId,
          x: payload.x,
          y: payload.y,
          button: payload.button || "left",
          isDouble,
        },
      ]);

      // Tự động giải phóng phần tử sau khi animation kết thúc
      setTimeout(() => {
        setClicks((prev) => prev.filter((c) => c.id !== newId));
      }, ANIMATION_DURATION + 100);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div style={containerStyle}>
      <style>{`
        @keyframes snapdoc-click-ripple {
          0% {
            transform: translate(-50%, -50%) scale(0.2);
            opacity: 0.95;
          }
          60% {
            opacity: 0.65;
          }
          100% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 0;
          }
        }

        @keyframes snapdoc-click-ripple-second {
          0% {
            transform: translate(-50%, -50%) scale(0.2);
            opacity: 0;
          }
          20% {
            transform: translate(-50%, -50%) scale(0.3);
            opacity: 0.9;
          }
          100% {
            transform: translate(-50%, -50%) scale(1.3);
            opacity: 0;
          }
        }

        @keyframes snapdoc-click-dot {
          0% {
            transform: translate(-50%, -50%) scale(0.4);
            opacity: 1;
          }
          50% {
            transform: translate(-50%, -50%) scale(1.2);
            opacity: 0.9;
          }
          100% {
            transform: translate(-50%, -50%) scale(0.8);
            opacity: 0;
          }
        }

        .snapdoc-ripple-base {
          position: absolute;
          border-radius: 50%;
          pointer-events: none;
          box-sizing: border-box;
          will-change: transform, opacity;
        }

        .snapdoc-ripple-left {
          border: 2.5px solid #3b82f6;
          box-shadow: 0 0 10px rgba(59, 130, 246, 0.6), inset 0 0 6px rgba(59, 130, 246, 0.4);
          background: radial-gradient(circle, rgba(59, 130, 246, 0.25) 0%, rgba(59, 130, 246, 0.05) 70%, transparent 100%);
        }

        .snapdoc-dot-left {
          background-color: #60a5fa;
          box-shadow: 0 0 8px #3b82f6, 0 0 2px #ffffff;
        }

        .snapdoc-ripple-right {
          border: 2.5px solid #f59e0b;
          box-shadow: 0 0 10px rgba(245, 158, 11, 0.6), inset 0 0 6px rgba(245, 158, 11, 0.4);
          background: radial-gradient(circle, rgba(245, 158, 11, 0.25) 0%, rgba(245, 158, 11, 0.05) 70%, transparent 100%);
        }

        .snapdoc-dot-right {
          background-color: #fbbf24;
          box-shadow: 0 0 8px #f59e0b, 0 0 2px #ffffff;
        }

        .snapdoc-ripple-middle {
          border: 2.5px solid #10b981;
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.6), inset 0 0 6px rgba(16, 185, 129, 0.4);
          background: radial-gradient(circle, rgba(16, 185, 129, 0.25) 0%, rgba(16, 185, 129, 0.05) 70%, transparent 100%);
        }

        .snapdoc-dot-middle {
          background-color: #34d399;
          box-shadow: 0 0 8px #10b981, 0 0 2px #ffffff;
        }
      `}</style>

      {clicks.map((item) => {
        const colorClass =
          item.button === "right"
            ? "snapdoc-ripple-right"
            : item.button === "middle"
            ? "snapdoc-ripple-middle"
            : "snapdoc-ripple-left";

        const dotClass =
          item.button === "right"
            ? "snapdoc-dot-right"
            : item.button === "middle"
            ? "snapdoc-dot-middle"
            : "snapdoc-dot-left";

        return (
          <React.Fragment key={item.id}>
            {/* Vòng sóng chính (Wave 1) */}
            <div
              className={`snapdoc-ripple-base ${colorClass}`}
              style={{
                left: item.x,
                top: item.y,
                width: 52,
                height: 52,
                animation: `snapdoc-click-ripple ${ANIMATION_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1) forwards`,
              }}
            />

            {/* Vòng sóng phụ khi nhấp đúp (Double click wave) */}
            {item.isDouble && (
              <div
                className={`snapdoc-ripple-base ${colorClass}`}
                style={{
                  left: item.x,
                  top: item.y,
                  width: 56,
                  height: 56,
                  animation: `snapdoc-click-ripple-second ${ANIMATION_DURATION + 80}ms cubic-bezier(0.16, 1, 0.3, 1) 70ms forwards`,
                }}
              />
            )}

            {/* Tâm điểm click (Center Dot) */}
            <div
              className={`snapdoc-ripple-base ${dotClass}`}
              style={{
                left: item.x,
                top: item.y,
                width: 8,
                height: 8,
                animation: `snapdoc-click-dot 220ms ease-out forwards`,
              }}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  width: "100vw",
  height: "100vh",
  pointerEvents: "none",
  background: "transparent",
  overflow: "hidden",
  userSelect: "none",
};
