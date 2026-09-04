import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import "./i18n/config"; // Initialize i18next

const which = new URLSearchParams(window.location.search).get("win") ?? "capture-bar";

const routeLoaders: Record<string, () => Promise<{ default: React.ComponentType<any> }>> = {
  "capture-bar": () => import("./routes/capture-bar/CaptureBar"),
  "capture-bar-popover": () => import("./routes/capture-bar/CaptureBarPopover"),
  overlay: () => import("./routes/overlay/Overlay"),
  editor: () => import("./routes/editor/Editor"),
  thumbnail: () => import("./routes/thumbnail/Thumbnail"),
  settings: () => import("./routes/settings/Settings"),
  update: () => import("./routes/update/UpdateWindow"),
  "scroll-control": () => import("./routes/scroll-control/ScrollControl"),
  history: () => import("./routes/history/HistoryWindow"),
  "recording-indicator": () => import("./routes/recording-indicator/RecordingIndicator"),
  "record-stop-control": () => import("./routes/record-stop-control/RecordStopControl"),
  "record-border": () => import("./routes/record-border/RecordBorder"),
  "window-picker": () => import("./routes/window-picker/WindowPickerDialog"),
  "capture-timer": () => import("./routes/capture-timer/CaptureTimer"),
};

const loader = routeLoaders[which] ?? routeLoaders["capture-bar"];
const Route = React.lazy(loader);

// Không dùng StrictMode: effects chạy 2 lần ở dev sẽ phá logic take_pending (xoá state).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <Suspense fallback={null}>
    <Route />
  </Suspense>
);
