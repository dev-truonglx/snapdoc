/** Icon SVG dùng trong `VideoTrimmer`. */

export function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M6.5 4.8v14.4a1 1 0 0 0 1.53.85l11.3-7.2a1 1 0 0 0 0-1.7l-11.3-7.2a1 1 0 0 0-1.53.85Z" />
    </svg>
  );
}

export function PauseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <rect x="6" y="4.5" width="4.2" height="15" rx="1" />
      <rect x="13.8" y="4.5" width="4.2" height="15" rx="1" />
    </svg>
  );
}

export function FullscreenEnterIcon() {
  return (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 3H4v5M15 3h5v5M9 21H4v-5M15 21h5v-5" />
    </svg>
  );
}

export function FullscreenExitIcon() {
  return (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
    </svg>
  );
}

export function ScissorsIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <line x1="8.2" y1="7.6" x2="20" y2="19" />
      <line x1="8.2" y1="16.4" x2="20" y2="5" />
    </svg>
  );
}

export function RectIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
    </svg>
  );
}

export function BlurIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" opacity="0.9" />
      <circle cx="16" cy="8" r="1.3" fill="currentColor" opacity="0.5" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" opacity="0.7" />
      <circle cx="8" cy="16" r="1.3" fill="currentColor" opacity="0.4" />
      <circle cx="16" cy="16" r="1.3" fill="currentColor" opacity="0.8" />
    </svg>
  );
}

export function TextIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="9" y1="20" x2="15" y2="20" />
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="19" x2="19" y2="5" />
      <polyline points="10 5 19 5 19 14" />
    </svg>
  );
}

export function CropIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}

export function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13.5" r="3.2" />
    </svg>
  );
}

export function GifIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="4" />
      <path d="M8 9.5H6.2A1.2 1.2 0 0 0 5 10.7v2.6a1.2 1.2 0 0 0 1.2 1.2H8v-2H6.8" />
      <path d="M12 9.5v5" />
      <path d="M16 14.5v-5h3" />
      <path d="M16 12h2.2" />
    </svg>
  );
}


export function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h4l5 5V4L8 9H4z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 6a8 8 0 0 1 0 12" />
    </svg>
  );
}

export function SpeakerMutedIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h4l5 5V4L8 9H4z" />
      <line x1="16" y1="9" x2="21" y2="14" />
      <line x1="21" y1="9" x2="16" y2="14" />
    </svg>
  );
}

/** Nốt nhạc gạch chéo — dùng riêng cho nút "Tách nhạc nền" (xoá track âm
 * thanh khỏi FILE khi Áp dụng cắt), phân biệt với `SpeakerIcon`/
 * `SpeakerMutedIcon` (chỉ tắt tiếng lúc XEM TRƯỚC, không đụng vào file). */
export function NoAudioIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 16.5V5.5l9-2v11" />
      <circle cx="7.5" cy="16.5" r="2.5" />
      <circle cx="16.5" cy="14.5" r="2.5" />
      <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="7" x2="20" y2="7" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7L7.5 20h9l1-13" />
      <line x1="10" y1="10.5" x2="10.5" y2="17" />
      <line x1="14" y1="10.5" x2="13.5" y2="17" />
    </svg>
  );
}


export function ZoomFocusIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <circle cx="11" cy="11" r="2.5" fill="currentColor" opacity="0.75" />
    </svg>
  );
}

export function PlusZoomIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

export function SpeedIcon() {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 14l3.5-3.5" />
      <circle cx="12" cy="14" r="1.5" fill="currentColor" />
      <path d="M3.34 17a10 10 0 1 1 17.32 0" />
    </svg>
  );
}
