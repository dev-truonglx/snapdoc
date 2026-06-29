import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import CaptureBar from "./routes/capture-bar/CaptureBar";
import Overlay from "./routes/overlay/Overlay";
import Editor from "./routes/editor/Editor";
import Thumbnail from "./routes/thumbnail/Thumbnail";
import Settings from "./routes/settings/Settings";
import UpdateWindow from "./routes/update/UpdateWindow";
import ScrollControl from "./routes/scroll-control/ScrollControl";
import ScrollBorder from "./routes/scroll-border/ScrollBorder";

const which = new URLSearchParams(window.location.search).get("win") ?? "capture-bar";

const routes: Record<string, React.ComponentType> = {
  "capture-bar": CaptureBar,
  overlay: Overlay,
  editor: Editor,
  thumbnail: Thumbnail,
  settings: Settings,
  update: UpdateWindow,
  "scroll-control": ScrollControl,
  "scroll-border": ScrollBorder,
};

const Route = routes[which] ?? CaptureBar;

// Không dùng StrictMode: effects chạy 2 lần ở dev sẽ phá logic take_pending (xoá state).
ReactDOM.createRoot(document.getElementById("root")!).render(<Route />);
