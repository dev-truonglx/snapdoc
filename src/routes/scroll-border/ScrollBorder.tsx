import { useEffect, useState } from "react";

export default function ScrollBorder() {
  const [pulse, setPulse] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setPulse((p) => !p);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        boxSizing: "border-box",
        border: pulse ? "2.5px dashed #3b82f6" : "2.5px dashed #60a5fa",
        boxShadow: "inset 0 0 12px rgba(59, 130, 246, 0.25)",
        background: "transparent",
        transition: "all 0.5s ease-in-out",
        overflow: "hidden",
      }}
    />
  );
}
