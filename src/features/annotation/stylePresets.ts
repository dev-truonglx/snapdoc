import type { StylePreset } from "./store";

/** Preset style người dùng tự lưu (màu + nét + cỡ chữ) — lưu ở localStorage,
 * dùng chung mọi cửa sổ editor trên máy này. Tối đa `MAX_PRESETS`. */
const KEY = "snapdoc:style-presets";
export const MAX_PRESETS = 8;

export function loadStylePresets(): StylePreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (p): p is StylePreset =>
          !!p && typeof p.color === "string" && typeof p.strokeWidth === "number" && typeof p.fontSize === "number",
      )
      .slice(0, MAX_PRESETS);
  } catch {
    return [];
  }
}

export function saveStylePresets(list: StylePreset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_PRESETS)));
  } catch {
    // Không lưu được (quota/chặn storage) — preset vẫn dùng được trong phiên này.
  }
}

/** Thêm preset (bỏ bản trùng, mới nhất lên đầu). */
export function addStylePreset(list: StylePreset[], p: StylePreset): StylePreset[] {
  const same = (a: StylePreset) => a.color === p.color && a.strokeWidth === p.strokeWidth && a.fontSize === p.fontSize;
  return [p, ...list.filter((a) => !same(a))].slice(0, MAX_PRESETS);
}
