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

/** Mở dialog chọn vị trí (mặc định thư mục cấu hình) rồi ghi file. */
export async function saveToFile(dataUrl: string, alsoCopy = false): Promise<string | null> {
  const dir = await ipc.defaultSaveDir();
  const path = await save({
    defaultPath: dir ? `${dir}/${stampName()}.png` : `${stampName()}.png`,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!path) return null;
  return alsoCopy ? await ipc.saveAndCopy(path, dataUrl) : await ipc.saveImage(path, dataUrl);
}
