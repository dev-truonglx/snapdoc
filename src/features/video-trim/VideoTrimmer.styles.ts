/** Style inline của `VideoTrimmer`. */
import type React from "react";

/** Kích thước layout timeline — dùng chung cho style bên dưới và tính toán trong `VideoTrimmer`. */
/** Chiều cao dải khung hình filmstrip — giảm cùng tỉ lệ với `TRACK_H` (xem
 * bên dưới) để timeline gọn hơn, xem `track`/`filmstripLayer`. */
export const FILMSTRIP_BAND_H = 44;

/** Chiều cao khối timeline — CAO HƠN dải khung hình (`FILMSTRIP_BAND_H`) để
 * `playhead` tràn ra lề trên/dưới dải frame, dễ thấy đang chạy tới đâu (trước
 * đây playhead cao bằng đúng dải frame nên bị "chìm" khi clip có màu trắng
 * trùng màu vạch). Chênh lệch với `FILMSTRIP_BAND_H` (padding cho playhead
 * tràn ra, mỗi bên = (TRACK_H - FILMSTRIP_BAND_H)/2) CỐ Ý giữ đủ lớn (16px,
 * 8px mỗi bên) dù đã giảm tổng chiều cao — hụt xuống quá thấp (như lần thử
 * 72/64 trước, chỉ 4px mỗi bên) khiến phần playhead tràn ra gần như không
 * nhìn thấy được. */
export const TRACK_H = 60;

/** Chiều cao dải thước thời gian (ruler) phía trên track — hiện mốc giờ:phút
 * dọc theo timeline, mật độ tự đổi theo zoom (xem `NICE_TICK_INTERVALS_MS`). */
export const RULER_H = 22;

/** Khoảng cách nhỏ chèn giữa 2 đoạn giữ lại liền nhau (mỗi bên inset
 * `SEGMENT_GAP_PX / 2`) — để lộ nền track ở giữa, giúp ranh giới điểm cắt rõ
 * ràng hơn là chỉ dựa vào `borderRight` khi 2 khối chạm sát nhau. */
export const SEGMENT_GAP_PX = 4;

export const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 };

/** Merge thêm vào `wrap` khi `document.fullscreenElement === wrapRef.current`
 * — UA stylesheet mặc định của `:fullscreen` co giãn element theo viewport
 * nhưng không tự đặt nền, cần nền đen để tránh hở khoảng trống. */
export const fullscreenWrap: React.CSSProperties = { background: "#000", padding: 16, boxSizing: "border-box" };

export const videoWrap: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
  background: "#000",
  borderRadius: 8,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export const videoStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain", cursor: "pointer" };

/** Thanh điều khiển phát NỔI đè lên đáy video (kiểu YouTube/QuickTime/CapCut)
 * — gradient tối dần từ trong suốt lên đen để chữ/icon luôn đọc được dù nền
 * video sáng màu, không chiếm thêm chiều cao cố định như 1 hàng riêng bên
 * dưới (video có ít không gian chết hơn, giống trải nghiệm player chuyên
 * nghiệp). Grid 3 cột (`1fr auto 1fr`) — cột giữa (`overlayCenterGroup`) LUÔN
 * canh giữa TOÀN overlay bất kể `toolsGroup` (cột phải) rộng bao nhiêu, cột
 * trái chỉ để giữ cân bằng khoảng trống (xem JSX). `toolsGroup` (zoom/toàn
 * màn hình) luôn hiện — dùng thường xuyên lúc chỉnh sửa; `overlayCenterGroup`
 * (thời gian/play/âm lượng) tự ẩn/hiện theo hover, xem `showCenterControls`. */
export const playbackOverlay: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  display: "grid",
  gridTemplateColumns: "1fr auto 1fr",
  alignItems: "center",
  padding: "20px 10px 10px",
  background: "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.35) 65%, rgba(0,0,0,0) 100%)",
};

/** Nhóm Thời gian - Play - Âm lượng, canh giữa (cột "auto" của grid
 * `playbackOverlay`) — thứ tự này (không phải Play trước) để play button —
 * hành động chính — nằm ĐÚNG TÂM overlay, thời gian/âm lượng đối xứng 2 bên.
 * `transition` cho opacity khi ẩn/hiện theo hover mượt hơn là bật/tắt đột
 * ngột (xem `showCenterControls`). */
export const overlayCenterGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  transition: "opacity 0.15s ease",
};

export const overlayTimeText: React.CSSProperties = {
  fontSize: 12,
  color: "#fff",
  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/** Nút icon trên `playbackOverlay` — trong suốt, chỉ nổi khi hover (kiểu
 * YouTube/QuickTime: chrome player không có "chip" nền cố định, chỉ icon
 * trắng trên nền gradient), khác `iconToolBtn` (chip nền xám dùng cho
 * `editToolbar` — nơi KHÔNG có video làm nền nên cần viền/nền để phân định
 * nút với xung quanh). */
export const overlayIconBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  flexShrink: 0,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

/** Nút Play/Pause chính — TO hẳn (không chỉ nhỉnh hơn 1 chút như trước) để dễ
 * bấm trúng, đúng vai trò hành động CHÍNH của thanh phát, cùng mức nhấn mạnh
 * với play button to giữa màn hình của YouTube/QuickTime; nền trắng mờ + viền
 * để vẫn rõ hình dạng nút dù icon/nền video cùng tông màu tối. */
export const overlayPlayBtn: React.CSSProperties = {
  ...overlayIconBtn,
  width: 46,
  height: 46,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.16)",
  border: "1px solid rgba(255,255,255,0.3)",
};

/** Nút text (zoom −/100%/+) trên overlay — viền/nền mờ nhẹ để vẫn phân biệt
 * được là 1 nút bấm được (khác `overlayIconBtn` thuần icon, không cần viền
 * vì hình dạng icon đã đủ gợi ý "có thể bấm"). */
export const overlayToolBtn: React.CSSProperties = {
  height: 26,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)",
  color: "#fff",
  fontSize: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export const toolsGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  // Cột phải ("1fr") của grid `playbackOverlay` — ép sát rìa phải trong cột
  // đó (khác bản flex cũ dùng `marginLeft: auto` để tự đẩy sang phải).
  justifySelf: "end",
};

export const volumeGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  position: "relative",
};

/** Neo NGANG HÀNG bên PHẢI icon loa (cùng chiều cao — `top` = tâm icon,
 * `transform: translateY(-50%)` tự canh giữa theo chiều dọc) qua toạ độ
 * viewport đo được (`volumeAnchor`, xem JSX) — `position: fixed` (không phải
 * `absolute`) để thoát khỏi `overflow: hidden` của `videoWrap` chứa icon.
 * `paddingLeft` (KHÔNG phải gap/margin) chừa khoảng cách nhìn thấy với card
 * bên phải, đồng thời vẫn giữ popover là CON DOM của `volumeGroup` (không
 * phải sibling) — cả 2 điểm này đảm bảo di chuột từ icon sang card không hề
 * bị trình duyệt hiểu nhầm là đã rời `volumeGroup` (xem giải thích dài hơn ở
 * JSX).
 * LƯU Ý: đặt ngang hàng nghĩa là popover đè lên `<video>` (khác bản cũ đặt
 * XUỐNG DƯỚI hẳn ra ngoài `videoWrap` để né đúng vùng này) — từng có bug kéo
 * thanh âm lượng bị "nuốt" mất giữa chừng khi popover chồng lên `<video>` ở 1
 * số WebView (nghi lớp video tăng tốc phần cứng giành sự kiện con trỏ bất kể
 * z-index). Nếu tái hiện lại bug đó sau thay đổi này, cân nhắc quay về đặt
 * dưới `videoWrap`. */
export const volumePopoverAnchor: React.CSSProperties = {
  position: "fixed",
  transform: "translateY(-50%)",
  paddingLeft: 8,
  zIndex: 20,
};

export const volumePopoverCard: React.CSSProperties = {
  display: "flex",
  justifyContent: "center",
  padding: "9px 10px",
  borderRadius: 8,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
};

/** Vùng BẮT chuột của track âm lượng — CAO HƠN NHIỀU dải hiện (`volumeTrackBar`
 * chỉ 4px) để dễ trúng/kéo, đặc biệt ở 2 đầu mút (đúng chỗ user báo không kéo
 * hết được). `touchAction:"none"` cùng lý do với timeline track (`track` bên
 * dưới) — chặn cuộn/pinch mặc định của trình duyệt đè lên thao tác kéo. */
export const volumeTrackHit: React.CSSProperties = {
  width: 84,
  height: 28,
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  touchAction: "none",
};

export const volumeTrackBar: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: 4,
  borderRadius: 2,
  background: "var(--border)",
};

/** Phần đã "đổ đầy" tính từ TRÁI sang — kéo sang phải = tăng âm, đúng thứ tự
 * trái→phải quen thuộc của thanh trượt ngang (xem `applyVolumeFromClientX`). */
export const volumeTrackFill: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  height: "100%",
  borderRadius: 2,
  background: "var(--accent)",
};

export const volumeThumb: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  width: 12,
  height: 12,
  borderRadius: "50%",
  background: "var(--accent)",
  transform: "translate(-50%, -50%)",
  boxShadow: "0 0 0 2px var(--bg-elevated)",
  pointerEvents: "none",
};

// Nền/viền/bo góc nhẹ — đọc thành 1 "thanh công cụ cắt" tách bạch khỏi
// video phía trên (giờ không còn playbackRow ngăn cách, xem `playbackOverlay`)
// và timeline phía dưới, giống thanh tool ngay trên timeline của Premiere/CapCut.
export const editToolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  flexWrap: "wrap",
  padding: "6px 8px",
  borderRadius: 8,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
};

/** Đẩy Đặt lại/Áp dụng cắt sát phải trong `editToolbar` — cùng kỹ thuật
 * `marginLeft:auto` như `toolsGroup` ở `playbackRow`. */
export const trimCommitGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginLeft: "auto",
};

export const toolDivider: React.CSSProperties = {
  width: 1,
  height: 18,
  background: "var(--border)",
  margin: "0 2px",
};

export const toolBtn: React.CSSProperties = {
  height: 26,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text)",
  fontSize: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

/** Nút icon vuông (undo/redo/chia/xoá/cắt đầu-cuối) — cùng chất liệu với
 * `toolBtn` nhưng vuông + không padding ngang, vì nội dung giờ là icon/glyph
 * cố định thay vì text dài ngắn khác nhau. */
export const iconToolBtn: React.CSSProperties = {
  ...toolBtn,
  width: 30,
  padding: 0,
};

/** Merge thêm vào `iconToolBtn` khi nút đang ở trạng thái BẬT (toggle) — hiện
 * chỉ dùng cho "Tách nhạc nền" (`removeAudio`), khác các icon còn lại vốn là
 * hành động một lần chứ không phải toggle bật/tắt. */
export const iconToolBtnActive: React.CSSProperties = {
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "var(--accent-text)",
};

export const bracketGlyph: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  lineHeight: 1,
};

/** Preview hover-scrub — `position:fixed` theo toạ độ viewport, neo tại
 * (`left`,`top`) rồi tự đẩy lên trên + căn giữa theo con trỏ bằng
 * `transform` (tránh phải tính trước `clientX - popupWidth/2`). */
export const hoverPreview: React.CSSProperties = {
  position: "fixed",
  transform: "translate(-50%, calc(-100% - 14px))",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  pointerEvents: "none",
  zIndex: 50,
};

export const hoverPreviewImgBox: React.CSSProperties = {
  width: 340,
  height: 200,
  background: "#000",
  borderRadius: 10,
  overflow: "hidden",
  border: "2px solid rgba(255,255,255,0.35)",
  boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
};

export const hoverPreviewImg: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
};

export const hoverPreviewTime: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  color: "#fff",
  background: "rgba(0,0,0,0.75)",
  padding: "3px 10px",
  borderRadius: 6,
};

/** Container cuộn ngang chứa các track — co giãn động theo tổng chiều cao
 * của các track đang hoạt động (ruler, video track, overlay track, zoom track)
 * để luôn hiển thị trọn vẹn 100% nội dung mà không bị che khuất hay đè mất. */
export const trackScroll: React.CSSProperties = {
  position: "relative",
  overflowX: "auto",
  overflowY: "hidden",
  borderRadius: 8,
  flexShrink: 0,
  background: "rgba(0, 0, 0, 0.25)",
};

/** Lớp filmstrip nằm dưới cùng trong `track` — `pointerEvents:none` để không
 * chặn kéo/bấm (segment/playhead vẫn xử lý pointer riêng ở track cha).
 * Chỉ cao `FILMSTRIP_BAND_H` (giữ đúng chiều cao frame cũ), CANH GIỮA trong
 * `track` (nay cao hơn, xem `track`) — phần lề trên/dưới còn lại là để
 * `playhead` tràn ra ngoài dải khung hình, dễ nhìn thấy đang chạy tới đâu. */
export const filmstripLayer: React.CSSProperties = {
  position: "absolute",
  top: (TRACK_H - FILMSTRIP_BAND_H) / 2,
  height: FILMSTRIP_BAND_H,
  left: 0,
  right: 0,
  overflow: "hidden",
  borderRadius: 8,
  pointerEvents: "none",
};

export const filmstripTile: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  overflow: "hidden",
  background: "rgba(255,255,255,0.04)",
  boxSizing: "border-box",
  borderRight: "1px solid rgba(0,0,0,0.35)",
};

export const filmstripImg: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

export const track: React.CSSProperties = {
  position: "relative",
  // Cao hơn dải khung hình thật (`FILMSTRIP_BAND_H`, xem `filmstripLayer`) —
  // phần lề trên/dưới dư ra là để `playhead` tràn ra ngoài, xem `TRACK_H`.
  height: TRACK_H,
  borderRadius: 8,
  background: "rgba(255,255,255,0.08)",
  cursor: "pointer",
  userSelect: "none",
};

/** Thước thời gian phía trên track — `pointerEvents:none` (thuần hiển thị,
 * không chặn tương tác), cao `RULER_H`. */
export const timeRuler: React.CSSProperties = {
  position: "relative",
  height: RULER_H,
  pointerEvents: "none",
  flexShrink: 0,
};

export const tickWrap: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "flex-end",
};

export const tickLabel: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-dim)",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  marginBottom: 2,
};

export const tickLine: React.CSSProperties = {
  width: 1,
  height: 5,
  background: "var(--border)",
};

export const segmentBlock: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "rgba(255,255,255,0.08)",
  borderRadius: 4,
  boxSizing: "border-box",
  pointerEvents: "none",
};

export const segmentSelected: React.CSSProperties = {
  outline: "2px solid var(--accent)",
  outlineOffset: -2,
  background: "rgba(255,255,255,0.16)",
};

// Che ĐỤC khoảng cách giữa 2 đoạn — `segmentBlock` chỉ tô translucent
// (rgba trắng 8%) nên không đủ che khung hình filmstrip phía dưới, phải
// dùng màu nền ĐẶC (không alpha) mới thấy tách bạch hẳn khỏi nội dung video.
// `var(--bg-elevated)` khớp màu track lúc chưa có filmstrip (xem `track`).
export const segmentGapCover: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: SEGMENT_GAP_PX,
  background: "var(--bg)",
  pointerEvents: "none",
};

// Đỏ cam — vạch phát hiện tại (playhead) bao trùm toàn bộ chiều cao các track
// (Overlay, Focus, Speed, Ruler, Video filmstrip) để người dùng luôn biết rõ
// vị trí đang phát trên tất cả các dải hiệu ứng.
export const playhead: React.CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 2,
  background: "#ff5252",
  boxShadow: "0 0 0 1px rgba(0,0,0,0.7), 0 0 4px rgba(255,82,82,0.5)",
  borderRadius: 1,
  pointerEvents: "none",
  zIndex: 50,
};

export const playheadCap: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: "50%",
  transform: "translateX(-50%)",
  width: 8,
  height: 8,
  backgroundColor: "#ff5252",
  clipPath: "polygon(0 0, 100% 0, 100% 45%, 50% 100%, 0 45%)",
};

// Cao 26px khớp `iconToolBtn` cùng hàng — to hơn bản cũ (padding "6px 10px",
// font 12px) để không bị lép vế cạnh các icon, đúng mức 1 nút hành động thật
// thay vì trông như phụ chú.
export const resetBtn: React.CSSProperties = {
  height: 26,
  padding: "0 12px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 13,
};

export const saveOverwriteBtn: React.CSSProperties = {
  height: 26,
  padding: "0 16px",
  borderRadius: 7,
  background: "var(--accent)",
  color: "var(--accent-text)",
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
};

/** Bọc nút "Lưu thành video mới" + mũi tên "▾" thành 1 split button — cùng
 * pattern `splitGroup` ở `Toolbar.tsx` (chế độ ảnh), làm điểm neo cho popover
 * "Chọn nơi lưu…" bên dưới. */
export const saveAsSplitGroup: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "stretch",
};

/** Nút "Lưu thành video mới" — cùng chiều cao/kiểu chữ với `saveOverwriteBtn`
 * nhưng viền/nền nhẹ hơn (không phải hành động phá huỷ, không cần nhấn mạnh
 * bằng màu accent) — cùng phân cấp thị giác với `resetBtn` cạnh nó. */
export const saveAsBtn: React.CSSProperties = {
  height: 26,
  padding: "0 14px",
  borderRadius: "7px 0 0 7px",
  border: "1px solid var(--border)",
  borderRight: "none",
  background: "transparent",
  color: "var(--text)",
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
};

/** Mũi tên nhỏ mở popover "Chọn nơi lưu…" — cùng viền/nền với `saveAsBtn`,
 * tách biệt bằng viền mảnh, đúng hình dáng split button quen thuộc. */
export const saveAsCaretBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 26,
  padding: "0 8px",
  borderRadius: "0 7px 7px 0",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 11,
  opacity: 0.85,
  whiteSpace: "nowrap",
};

export const saveAsMenuPopover: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  background: "rgba(30,30,36,0.99)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
  zIndex: 100,
  whiteSpace: "nowrap",
};

export const saveAsMenuItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "7px 12px",
  borderRadius: 6,
  fontSize: 12,
  color: "#fff",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
};
