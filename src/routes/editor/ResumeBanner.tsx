import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";

interface Props {
  /** Key phiên sửa đang được giữ lại — `historyId`, hoặc `file:<uuid>` cho ảnh
   * mở từ đĩa (không có thumbnail để hiện). */
  sessionKey: string;
  onResume: () => void;
  onDismiss: () => void;
}

/** Thời gian tự ẩn. Đủ dài để đọc xong câu và bấm nút, đủ ngắn để không đứng
 * chắn giữa toolbar và canvas khi user đã sang việc khác. */
const AUTO_HIDE_MS = 7000;

/**
 * Banner "bản chỉnh sửa trước đã được giữ lại" — hiện khi một ảnh mới (vừa
 * chụp/quay) thay chỗ một tài liệu còn thay đổi chưa lưu.
 *
 * KHÔNG dùng slot `toast` sẵn có của `Editor` vì toast không có nút hành động,
 * mà chính nút "Quay lại" mới là giá trị của thông báo này — không có nó thì
 * user vẫn phải tự mò xem việc của mình đi đâu.
 *
 * Cố tình không chặn (không phải modal, không cướp focus): người dùng vừa từ
 * một luồng chụp toàn màn hình trở về, họ cần ĐỊNH HƯỚNG chứ không cần một cái
 * bẫy phải bấm mới đi tiếp được.
 */
export default function ResumeBanner({ sessionKey, onResume, onDismiss }: Props) {
  const { t } = useTranslation();
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(onDismiss, AUTO_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [sessionKey, onDismiss]);

  // Thumbnail của item đang được giữ lại — dùng `thumbPath` (JPEG thật) qua
  // asset protocol nên KHÔNG tốn round-trip base64 của cả ảnh gốc. Ảnh mở từ
  // file ngoài (`file:` key) không có record History nên bỏ qua, banner vẫn
  // hoạt động bình thường mà không có ảnh.
  useEffect(() => {
    setThumb(null);
    if (sessionKey.startsWith("file:")) return;
    if (!("__TAURI_INTERNALS__" in window)) return;
    let alive = true;
    ipc
      .getHistoryItem(sessionKey)
      .then((item) => {
        if (alive && item?.thumbPath) setThumb(convertFileSrc(item.thumbPath));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionKey]);

  return (
    <div style={bar} role="status">
      {thumb && <img src={thumb} alt="" style={thumbStyle} />}
      <span style={{ flex: 1, minWidth: 0 }}>{t("editorMain.previousEditKept")}</span>
      <button style={primaryBtn} onClick={onResume}>
        {t("editorMain.resumePreviousEdit")}
      </button>
      <button style={dismissBtn} onClick={onDismiss} aria-label={t("common.close")}>
        ✕
      </button>
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "7px 10px",
  background: "rgba(245,158,11,0.12)",
  borderBottom: "1px solid rgba(245,158,11,0.3)",
  color: "#fbbf24",
  fontSize: 12.5,
  flexShrink: 0,
};

const thumbStyle: React.CSSProperties = {
  width: 34,
  height: 24,
  objectFit: "cover",
  borderRadius: 3,
  border: "1px solid rgba(245,158,11,0.35)",
  flexShrink: 0,
};

const primaryBtn: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 6,
  border: "1px solid rgba(245,158,11,0.45)",
  background: "rgba(245,158,11,0.2)",
  color: "#fcd34d",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const dismissBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#fbbf24",
  fontSize: 13,
  cursor: "pointer",
  padding: "2px 4px",
  flexShrink: 0,
};
