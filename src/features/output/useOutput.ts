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

export async function copyToClipboard(dataUrl: string): Promise<void> {
  await ipc.copyImage(dataUrl);
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
