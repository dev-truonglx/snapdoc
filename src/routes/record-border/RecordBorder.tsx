/**
 * Cửa sổ RIÊNG, click-through + content-protected, chỉ vẽ khung viền đỏ bao
 * đúng vùng đang quay khi quay TOÀN màn hình hoặc quay 1 CỬA SỔ (xem
 * `windows::open_record_border`). Quay 1 VÙNG đã có khung riêng (chính overlay
 * chọn vùng biến thành click-through — xem `flow::finalize_region`) nên không
 * dùng cửa sổ này. Không có khung này, user quay đa màn hình dễ không biết
 * ScreenCaptureKit đang bắt đúng màn/cửa sổ nào.
 */
export default function RecordBorder() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        boxSizing: "border-box",
        border: "4px solid #ef4444",
        background: "transparent",
        pointerEvents: "none",
      }}
    />
  );
}
