import type { Segment } from "./segments";
import type { VideoOverlayItem } from "./types";

export interface VideoSessionSnapshot {
  segments: Segment[];
  removeAudio: boolean;
  overlays: VideoOverlayItem[];
}

export interface VideoSessionState {
  segments: Segment[];
  removeAudio: boolean;
  overlays: VideoOverlayItem[];
  past: VideoSessionSnapshot[];
  future: VideoSessionSnapshot[];
  selectedSegmentId: string | null;
  selectedOverlayId: string | null;
  playheadMs?: number;
}

// Lưu trữ phiên sửa video trong RAM (tồn tại suốt thời gian app đang chạy)
const ramSessions = new Map<string, VideoSessionState>();

const STORAGE_PREFIX = "snapdoc:video_session:";

/**
 * Lấy phiên sửa video đã lưu (từ RAM hoặc localStorage).
 */
export function getVideoSession(key: string, currentDurationMs: number): VideoSessionState | null {
  // 1. Kiểm tra trong RAM trước
  let session = ramSessions.get(key);

  // 2. Nếu chưa có trong RAM, thử đọc từ localStorage
  if (!session) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      if (raw) {
        session = JSON.parse(raw);
        if (session) ramSessions.set(key, session);
      }
    } catch (e) {
      console.warn("[SnapDoc] Không đọc được session video từ localStorage:", e);
    }
  }

  if (!session) return null;

  // Kiểm tra tính hợp lệ cơ bản của dữ liệu
  if (!Array.isArray(session.segments) || session.segments.length === 0 || !Array.isArray(session.overlays)) {
    return null;
  }

  // Nếu thời lượng video bị lệch quá nhiều so với bản lưu (ví dụ video gốc bị thay thế bên ngoài)
  if (currentDurationMs > 0) {
    const totalSeg = session.segments.reduce((acc, s) => Math.max(acc, s.srcEnd), 0);
    if (totalSeg > currentDurationMs + 2000) {
      // Dữ liệu cũ không còn khớp với file hiện tại
      return null;
    }
  }

  return session;
}

/**
 * Kiểm tra xem phiên sửa video có thay đổi (so với video gốc ban đầu) hay không.
 */
export function hasVideoSessionChanges(state: VideoSessionState, originalDurationMs?: number): boolean {
  if (state.overlays && state.overlays.length > 0) return true;
  if (state.removeAudio) return true;
  if (state.past && state.past.length > 0) return true;
  if (state.segments && state.segments.length > 1) return true;
  if (state.segments && state.segments.length === 1) {
    const seg = state.segments[0];
    if (seg.srcStart > 0) return true;
    if (originalDurationMs && originalDurationMs > 0 && Math.abs(seg.srcEnd - originalDurationMs) > 200) {
      return true;
    }
  }
  return false;
}

/**
 * Lưu phiên sửa video (vào RAM và localStorage).
 */
export function saveVideoSession(key: string, state: VideoSessionState, originalDurationMs?: number): void {
  // Lưu vào RAM
  ramSessions.set(key, state);

  // Lưu vào localStorage nếu có thay đổi hoặc có overlays
  try {
    const hasChanges = hasVideoSessionChanges(state, originalDurationMs);
    if (hasChanges) {
      const lightweightState = {
        ...state,
        overlays: state.overlays.map(({ imageData: _, ...rest }) => rest),
      };
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(lightweightState));
    } else {
      localStorage.removeItem(STORAGE_PREFIX + key);
    }
  } catch (e) {
    console.warn("[SnapDoc] Không lưu được session video vào localStorage:", e);
  }
}

/**
 * Xoá phiên sửa video (khi đã Lưu đè thành công hoặc Đặt lại).
 */
export function dropVideoSession(key: string): void {
  ramSessions.delete(key);
  try {
    localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {}
}
