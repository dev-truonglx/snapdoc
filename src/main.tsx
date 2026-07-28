import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import "./i18n/config"; // Initialize i18next
import CaptureBar from "./routes/capture-bar/CaptureBar";
import Overlay from "./routes/overlay/Overlay";
import Editor from "./routes/editor/Editor";
import Thumbnail from "./routes/thumbnail/Thumbnail";
import Settings from "./routes/settings/Settings";
import UpdateWindow from "./routes/update/UpdateWindow";
import ScrollControl from "./routes/scroll-control/ScrollControl";
import HistoryWindow from "./routes/history/HistoryWindow";
import RecordingIndicator from "./routes/recording-indicator/RecordingIndicator";
import RecordStopControl from "./routes/record-stop-control/RecordStopControl";
import RecordBorder from "./routes/record-border/RecordBorder";
import WindowPickerDialog from "./routes/window-picker/WindowPickerDialog";
import CaptureTimer from "./routes/capture-timer/CaptureTimer";

const which = new URLSearchParams(window.location.search).get("win") ?? "capture-bar";

const routes: Record<string, React.ComponentType> = {
  "capture-bar": CaptureBar,
  overlay: Overlay,
  editor: Editor,
  thumbnail: Thumbnail,
  settings: Settings,
  update: UpdateWindow,
  "scroll-control": ScrollControl,
  history: HistoryWindow,
  "recording-indicator": RecordingIndicator,
  "record-stop-control": RecordStopControl,
  "record-border": RecordBorder,
  "window-picker": WindowPickerDialog,
  "capture-timer": CaptureTimer,
};

const Route = routes[which] ?? CaptureBar;

// Không dùng StrictMode: effects chạy 2 lần ở dev sẽ phá logic take_pending (xoá state).
ReactDOM.createRoot(document.getElementById("root")!).render(<Route />);
