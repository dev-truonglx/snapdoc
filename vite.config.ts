import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

// React Compiler (tự memo hoá component) — bật DẦN theo thư mục. Đợt đầu: các
// cửa sổ nhỏ, tự chứa. CHƯA bật cho editor ảnh / VideoTrimmer / overlay chụp:
// nhiều chỗ đọc store (`useEditor.getState()`) và ref ngay trong render — compiler
// có thể memo hoá sai mà không báo. Muốn mở rộng: thêm thư mục vào danh sách
// rồi thử kỹ cửa sổ đó.
const reactCompiler = reactCompilerPreset();
reactCompiler.rolldown.filter.id = {
  include: [
    "**/src/routes/capture-bar/**",
    "**/src/routes/capture-timer/**",
    "**/src/routes/countdown-overlay/**",
    "**/src/routes/record-border/**",
    "**/src/routes/record-clicks/**",
    "**/src/routes/record-keystroke/**",
    "**/src/routes/record-stop-control/**",
    "**/src/routes/recording-indicator/**",
    "**/src/routes/thumbnail/**",
    "**/src/routes/update/**",
    "**/src/routes/window-picker/**",
  ],
};

// Tauri expects a fixed port and ignores the src-tauri folder for HMR.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompiler] })],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
