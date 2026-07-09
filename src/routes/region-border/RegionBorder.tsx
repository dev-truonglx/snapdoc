import { useEffect, useState } from "react";

const params = new URLSearchParams(window.location.search);
const rx = Number(params.get("rx") ?? "0");
const ry = Number(params.get("ry") ?? "0");
const rw = Number(params.get("rw") ?? "0");
const rh = Number(params.get("rh") ?? "0");

/// Overlay hiển thị trong suốt quá trình quay 1 VÙNG màn hình — cửa sổ phủ
/// TOÀN BỘ màn hình (xem `windows::open_region_border`), làm mờ phần NGOÀI
/// vùng chọn bằng đúng kỹ thuật "spotlight" (`box-shadow` khổng lồ) mà
/// `Overlay.tsx` đã dùng lúc chọn vùng chụp ảnh, để người dùng thấy rõ chính
/// xác vùng đang ghi hình — độc lập với viền vàng hệ thống của Windows (WGC
/// quay nguyên màn hình rồi crop phần mềm nên viền hệ thống bao quanh cả màn
/// hình, không khớp vùng đã chọn).
export default function RegionBorder() {
  const [pulse, setPulse] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setPulse((p) => !p);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "transparent", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: rx,
          top: ry,
          width: rw,
          height: rh,
          boxSizing: "border-box",
          border: pulse ? "2.5px solid #ef4444" : "2.5px solid #f87171",
          // Kỹ thuật spotlight: box-shadow lan rộng 9999px phủ kín phần còn
          // lại của viewport, chỉ chừa đúng vùng chọn trong suốt — cùng cách
          // Overlay.tsx làm cho RegionSelect lúc chụp ảnh (cùng màu/độ mờ).
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)",
          transition: "border-color 0.5s ease-in-out",
        }}
      />
    </div>
  );
}
