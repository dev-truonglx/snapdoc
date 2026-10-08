# Kế Hoạch Khắc Phục Lỗi Treo Màn Hình Khi Spam Phím Tắt & Tối Ưu Tốc Độ Overlay

## I. TỔNG QUAN VẤN ĐỀ & NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE)

1. **Hiện tượng "Treo cứng, không bấm được gì, chuột phải hiện Reload/Share":**
   * **Overlay trong suốt che kín màn hình:** Khi mở chế độ chụp, SnapDoc tạo các cửa sổ toàn màn hình `always_on_top: true` và `transparent: true`. Người dùng vẫn nhìn thấy Desktop và các ứng dụng bên dưới chuyển động bình thường, nhưng thực tế toàn bộ chuột và phím đã bị cửa sổ Overlay vô hình chặn lại ở phía trên.
   * **Context Menu mặc định của Edge WebView2:** Khi chưa chặn sự kiện `contextmenu`, người dùng click chuột phải làm bung menu mặc định của Chromium (*Back, Forward, Reload, Share...*). Menu này chiếm giữ quyền modal message loop của Windows, bắt giữ toàn bộ sự kiện bàn phím/chuột. Phím `Esc` khi đó chỉ đóng context menu chứ không thoát được overlay.
   * **Spam phím tắt làm nghẽn DWM & UI Thread:** Việc nhấn phím tắt dồn dập tạo ra hàng loạt thread chụp màn hình Direct3D/DWM đồng thời, làm nghẽn compositor của Windows. Hậu quả là `input_loop` bị lỗi/lệch thế hệ (`gen`), các overlay bị kẹt lại vĩnh viễn ở trạng thái trong suốt mà không nhận được lệnh đóng.

2. **Hiện tượng "Cả 2 màn hình đều trong suốt, màn hình phụ không có overlay mờ":**
   * **Màn hình phụ chưa kịp render ảnh freeze:** Khi spam phím tắt, quá trình capture ảnh màn hình phụ bị chậm hoặc lỗi. Frontend của màn hình phụ rơi vào trạng thái chờ `frozenReady = false` nên giữ `visibility: hidden` hoặc không render lớp phủ `rgba(0,0,0,0.45)`.
   * **Cửa sổ vốn có nền trong suốt (`transparent: true`):** Khi DOM chưa kịp vẽ lớp phủ mờ, cửa sổ WebView2 biến thành một tấm kính vô hình che toàn bộ màn hình phụ, gây cảm giác cả hai màn hình đều trong suốt nhưng đều bị khóa cứng chuột.

---

## II. CHI TIẾT KẾ HOẠCH SỬA ĐỔI

### 1. `src/main.tsx` (Frontend Toàn Cục)
* **Mục tiêu:** Chặn 100% Context Menu mặc định của Edge WebView2 trên toàn bộ ứng dụng (đặc biệt là Overlay).
* **Cách sửa:**
  * Thêm listener `contextmenu` ở mức `window` với chế độ `{ capture: true }`, chặn menu Chromium trừ khi người dùng click vào các ô nhập liệu văn bản (`INPUT`, `TEXTAREA`).
  ```ts
  window.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) {
      return;
    }
    e.preventDefault();
  }, true);
  ```
* **Mức độ ảnh hưởng:**
  * Rất an toàn, triệt tiêu hoàn toàn khả năng WebView2 mở modal menu làm kẹt chuột/phím của Windows.

---

### 2. `src-tauri/src/hotkey/mod.rs` (Backend Điều Phối Phím Tắt)
* **Mục tiêu:** Debounce/Throttle phím tắt ở tầng native; triệt tiêu hoàn toàn hiện tượng tạo bão thread làm nghẽn DWM khi người dùng spam phím liên tục.
* **Cách sửa:**
  * Thêm biến nguyên tử lưu mốc thời gian kích hoạt phím tắt gần nhất (`AtomicU64`).
  * Nếu khoảng cách giữa 2 lần bấm phím tắt nhỏ hơn **300ms**, hoặc nếu một phiên mở overlay đang trong quá trình chuẩn bị (`overlay_opening` đang `true`), bỏ qua ngay lập tức không spawn thread mới.
  ```rust
  static LAST_TRIGGER_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

  // Trong run_action():
  let now = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0);
  let prev = LAST_TRIGGER_MS.swap(now, std::sync::atomic::Ordering::SeqCst);
  if now.saturating_sub(prev) < 300 {
      return; // Bỏ qua nhịp spam phím
  }
  ```
* **Mức độ ảnh hưởng:**
  * Giảm tải hoàn toàn tài nguyên CPU/GPU/DWM khi spam phím tắt.
  * Lần bấm đầu tiên vẫn phản hồi tức thì (< 1ms).

---

### 3. `src/routes/overlay/Overlay.tsx` (Giao Diện Overlay)
* **Mục tiêu:** Tăng tốc render DOM, đảm bảo màn hình phụ luôn có lớp phủ mờ tức thì, hỗ trợ thoát nhanh bằng chuột phải.
* **Cách sửa:**
  * **Fallback Background thông minh trên màn hình phụ:**
    * Không bắt màn hình phụ phải đợi `frozenReady = true` mới hiện. Nếu là màn hình phụ (`!cursorHere`), hiển thị ngay lớp phủ xám mờ `rgba(0,0,0,0.45)`. Khi ảnh freeze tải xong sẽ tự động áp nền mượt mà.
  * **Chặn chuột phải & thoát an toàn trực tiếp:**
    * Thêm `onContextMenu={(e) => { e.preventDefault(); doCancel(); }}` trên các container của `RegionSelect`, `QuickAnnotate`, `RecordRegionSelect`. Click chuột phải ở bất kỳ đâu trên overlay sẽ kích hoạt lệnh hủy và đóng overlay ngay lập tức.
  * **Lazy-load AnnotationStage:**
    * Tách module vẽ chú thích nặng sang `React.lazy`, chỉ tải khi người dùng vào pha chú thích ở Quick Capture. Giảm kích thước bundle tải lần đầu của overlay hơn 60%, giúp DOM mount trong vài mili-giây.
* **Mức độ ảnh hưởng:**
  * Màn hình phụ không bao giờ bị trong suốt bất thường.
  * Trải nghiệm mở overlay nhẹ và mượt mà hơn rất nhiều.

---

### 4. `src-tauri/src/windows/mod.rs` (Vòng Đời Overlay & Input Loop)
* **Mục tiêu:** Rút ngắn thời gian đồng bộ chờ overlay giữa các màn hình và tăng độ tin cậy của luồng thoát khẩn cấp.
* **Cách sửa:**
  * **Rút ngắn Timeout đồng bộ (`wait_for_overlays_ready`):**
    * Giảm deadline từ 350ms xuống **120ms**. Màn hình chính có con trỏ chuột không bao giờ bị giữ lại chờ màn hình phụ quá lâu.
  * **Failsafe trong `input_loop`:**
    * Đảm bảo khi phát hiện `VK_ESCAPE` hoặc `VK_RBUTTON` (nhấn chuột phải) trong pha chưa kéo vùng, backend gọi dứt điểm `close_overlays(&app)` và giải phóng activation policy ngay lập tức.
* **Mức độ ảnh hưởng:**
  * Tránh hoàn toàn tình trạng cửa sổ overlay "ma" bị sót lại trên màn hình.

---

## III. BẢNG TỔNG HỢP MỨC ĐỘ ẢNH HƯỞNG & ĐÁNH GIÁ RỦI RO

| File cần sửa | Phạm vi | Mục đích chính | Mức độ rủi ro |
| :--- | :--- | :--- | :--- |
| `src/main.tsx` | Frontend | Chặn context menu Edge WebView2 toàn cục | Thấp (loại trừ input/textarea) |
| `src-tauri/src/hotkey/mod.rs` | Backend | Debounce phím tắt 300ms, chống nghẽn DWM | Thấp (chỉ áp dụng cho phím tắt) |
| `src/routes/overlay/Overlay.tsx` | Frontend | Fallback nền mờ màn hình phụ, lazy canvas | Thấp (tối ưu UI/UX) |
| `src-tauri/src/windows/mod.rs` | Backend | Giảm timeout chờ (120ms), củng cố input loop | Thấp (tăng tốc độ hiển thị) |

---

## IV. TIÊU CHÍ NGHIỆM THU (ACCEPTANCE CRITERIA)

1. **Khả năng chịu spam:** Người dùng bấm phím tắt chụp liên tục 10-20 lần thật nhanh $\rightarrow$ app không bị crash, không bị treo đơ màn hình, không phải restart máy.
2. **Hiển thị đúng đa màn hình:** Màn hình có chuột trong suốt để chọn vùng; màn hình còn lại luôn có lớp phủ mờ rõ ràng ngay lập tức.
3. **Thoát an toàn 100%:** Nhấn chuột phải hoặc phím `Esc` ở bất kỳ thời điểm nào đều đóng sạch toàn bộ overlay và trả lại chuột bình thường cho Desktop.
4. **Kiểm tra biên dịch:** Chạy `npm run build` thành công, không phát sinh lỗi TypeScript hay Rust compiler.
