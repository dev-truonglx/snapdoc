import { save } from "@tauri-apps/plugin-dialog";
import { ipc } from "../../lib/ipc";

/** Tên file mặc định theo template Screenshot_YYYY-MM-DD_HHMMSS. */
export function stampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Screenshot_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Tên file mặc định cho video, cùng template `Recording_...` với video quay
 * màn hình bình thường (`record::new_output_path` bên Rust). */
export function stampVideoName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Recording_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Tên file mặc định cho ảnh động GIF: `Animation_YYYY-MM-DD_HHMMSS.gif`. */
export function stampGifName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Animation_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function copyToClipboard(dataUrl: string): Promise<void> {
  await ipc.copyImage(dataUrl);
}

/** Thư mục chứa file từ đường dẫn đầy đủ (hỗ trợ cả `/` và `\` — path Windows dùng `\`). */
export function dirnameOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

/**
 * Mở dialog lưu file với đường dẫn mặc định cụ thể.
 * Dùng chung cho Save As ở editor và các flow muốn đổi cả thư mục lẫn tên file.
 */
export async function promptSavePath(defaultPath: string): Promise<string | null> {
  return await save({
    defaultPath,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
}

/** Mở dialog lưu file cho video (.mp4) — dùng cho dropdown "Chọn nơi lưu…"
 * của nút "Lưu thành video mới" ở VideoTrimmer. */
export async function promptSaveVideoPath(defaultPath: string): Promise<string | null> {
  return await save({
    defaultPath,
    filters: [{ name: "MP4", extensions: ["mp4"] }],
  });
}

/** Mở dialog lưu file cho ảnh GIF (.gif). */
export async function promptSaveGifPath(defaultPath: string): Promise<string | null> {
  return await save({
    defaultPath,
    filters: [{ name: "GIF", extensions: ["gif"] }],
  });
}


/**
 * Tự động lưu vào saveDir từ settings (không mở dialog).
 * Dùng cho output mode "save" và "save_copy" từ editor toolbar.
 */
export async function saveToFileAuto(dataUrl: string, alsoCopy = false): Promise<string | null> {
  const settings = await ipc.getSettings().catch(() => null);
  const dir = settings?.saveDir || (await ipc.defaultSaveDir());
  const path = `${dir}/${stampName()}.png`;
  return alsoCopy
    ? await ipc.saveAndCopy(path, dataUrl)
    : await ipc.saveImage(path, dataUrl);
}

/**
 * Mở dialog chọn vị trí lưu (dùng cho nút Save thủ công từ editor).
 * alsoCopy = true → lưu và copy vào clipboard.
 */
export async function saveToFile(dataUrl: string, alsoCopy = false): Promise<string | null> {
  const settings = await ipc.getSettings().catch(() => null);
  const dir = settings?.saveDir || (await ipc.defaultSaveDir());
  const path = await promptSavePath(dir ? `${dir}/${stampName()}.png` : `${stampName()}.png`);
  if (!path) return null;
  return alsoCopy ? await ipc.saveAndCopy(path, dataUrl) : await ipc.saveImage(path, dataUrl);
}

/**
 * "Save As…" ảnh ở editor — LUÔN mở dialog, ưu tiên thư mục LẦN CUỐI user
 * từng chọn qua Save As (`lastImageSaveAsDir`) làm mặc định thay vì luôn quay
 * về `saveDir`, để lần Save As kế tiếp không phải tự điều hướng lại từ đầu.
 * Lưu xong ghi nhớ luôn thư mục vừa chọn cho lần sau.
 */
export async function saveAsToFile(dataUrl: string): Promise<string | null> {
  const settings = await ipc.getSettings().catch(() => null);
  const dir = settings?.lastImageSaveAsDir || settings?.saveDir || (await ipc.defaultSaveDir());
  const path = await promptSavePath(dir ? `${dir}/${stampName()}.png` : `${stampName()}.png`);
  if (!path) return null;
  if (settings) {
    ipc.setSettings({ ...settings, lastImageSaveAsDir: dirnameOf(path) }).catch(() => {});
  }
  return await ipc.saveImage(path, dataUrl);
}
