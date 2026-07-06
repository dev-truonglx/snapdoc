# SnapDoc — Rủi ro hiệu năng & ổn định (audit toàn codebase)

> Tài liệu này ghi lại kết quả rà soát toàn bộ codebase (Rust backend + React frontend) để tìm các điểm có thể gây **hiệu năng không ổn định** hoặc **lỗi/crash app**. Không phải mọi điểm dưới đây đều là "bug" theo nghĩa chặt — nhiều điểm là **đánh đổi có chủ đích** (đã có comment giải thích trong code) nhưng vẫn đáng biết để không bị bất ngờ khi gặp trong thực tế. Mỗi mục có tham chiếu file:line cụ thể + kịch bản lỗi thật.
>
> Ngày audit: 2026-07-06. Phạm vi: toàn bộ `src-tauri/src/` và `src/`.

---

## A. Rủi ro Nghiêm trọng

### A.1. ~~`log::warn!`/`log::error!`/`log::info!` không có logger backend → lỗi thật bị nuốt hoàn toàn im lặng~~ — **Đã fix**
**File:** `src-tauri/src/update.rs` (từng ở dòng 69,76,92,96,100,103,147), `src-tauri/src/lib.rs` (từng ở dòng 232)

Toàn bộ hệ thống update (`check_update`, `silent_download_and_install`, `install_pending`) từng báo lỗi qua `log::` — nhưng **không có `env_logger`/`tauri-plugin-log`/logger nào được init ở bất kỳ đâu trong app**, nên các macro `log::` là no-op tuyệt đối, không in ra đâu cả.

- **Kịch bản lỗi (trước khi fix):** Update tải về thất bại (mạng lỗi, hết dung lượng đĩa) → `log::error!(...)` không in ra bất cứ đâu, user không biết vì sao update không bao giờ cài xong.
- **Đã fix:** đổi toàn bộ `log::warn!/error!/info!` còn lại trong `update.rs` và `lib.rs` sang `eprintln!("[SnapDoc][update] ...")`, đồng nhất với convention đã dùng cho History. Đã xoá luôn dependency `log = "0.4"` khỏi `Cargo.toml` vì không còn nơi nào gọi `log::` nữa.

### A.2. ~~Spawn thread không giới hạn trên mỗi lần chụp → nghẽn khi spam hotkey~~ — **Đã fix**
**File:** `src-tauri/src/history/mod.rs` (`ingest()`, `spawn_ingest_worker()`)

Trước đây mỗi lần chụp (kể cả khi user giữ/spam phím tắt) đều spawn **1 thread mới** để ghi asset+thumbnail nền, không giới hạn — tất cả tranh chung 1 `Mutex<rusqlite::Connection>`.

- **Kịch bản lỗi (trước khi fix):** User giữ phím tắt chụp 2-3 giây → hàng chục thread được tạo, mỗi thread giữ 1 bản sao base64 (vài MB/ảnh) chờ tới lượt lock DB. RAM tăng đột biến, độ trễ ghi History dồn ứ.
- **Đã fix:** thay bằng **1 worker thread cố định** (`spawn_ingest_worker`, spawn đúng 1 lần lúc khởi động) nhận job qua `mpsc::channel`. `ingest()` giờ chỉ `tx.send(job)` (rẻ) thay vì `std::thread::spawn` — dù spam bao nhiêu lần, chỉ 1 thread xử lý tuần tự, job xếp hàng trong channel thay vì tạo hàng chục OS thread.

### A.3. Race: DB row tồn tại trước khi file ghi xong (do thiết kế ingest 2 pha)
**File:** `src-tauri/src/history/mod.rs:49-97` (pha 1 INSERT nhanh, pha 2 `ingest_finish_bg` ghi file chạy nền)

Đây là đánh đổi **có chủ đích** tôi thêm vào để tăng tốc mở Editor/copy/save (xem phần fix hiệu năng đã làm trong phiên này) — nhưng cần ghi nhận rõ: giữa lúc pha 1 xong và pha 2 hoàn tất (thường vài–vài chục ms, có thể lâu hơn với ảnh rất lớn), record đã xuất hiện trong DB nhưng file `asset_path`/`thumb_path` **chưa tồn tại trên đĩa**.

- **Kịch bản lỗi:** User mở cửa sổ History gần như ngay lập tức sau khi chụp và click ngay vào item vừa tạo → `open_history_item_in_editor` cố `std::fs::read(&rec.asset_path)` → lỗi "Không đọc được asset" vì file chưa kịp ghi.
- **Mức độ:** Thấp trong thực tế (cửa sổ vài chục ms), nhưng cần biết để không hoảng khi thấy lỗi thoáng qua. UI (`HistoryItemCard`) đã có fallback ảnh vỡ, nhưng lỗi mở Editor thì **chưa** có retry/thông báo rõ ràng.
- **Fix đề xuất:** ở `open_history_item_in_editor_sync`, nếu đọc file lỗi mà record vừa tạo trong vài trăm ms gần đây, thử lại 1 lần sau ~200ms trước khi trả lỗi.

### A.4. Mutex `HistoryState.conn` bị poison → record "mồ côi" bị bỏ qua âm thầm
**File:** `src-tauri/src/history/mod.rs:113,122` (`if let Ok(conn) = state.conn.lock() { ... }` — nhánh `Err` bị bỏ qua hoàn toàn, không log)

Nếu 1 thread nào đó panic trong lúc đang giữ lock này (ví dụ do bug tương lai), mutex bị "poisoned" vĩnh viễn cho tới khi app restart. Từ đó, **mọi lần `ingest_finish_bg` sau đó đều lặng lẽ bỏ qua bước UPDATE `file_size`/soft-delete**, để lại record với `file_size = NULL` mãi mãi mà không ai biết.

- **Fix đề xuất:** log rõ (`eprintln!`) khi nhánh `Err` xảy ra thay vì bỏ qua hoàn toàn.

### A.5. ScreenCaptureKit (macOS): callback có thể bắn trễ sau khi Rust đã timeout
**File:** `src-tauri/src/capture/mac_sck.rs` (hàm `capture_window`/`capture_rect`, `rx.recv_timeout(TIMEOUT)`)

Block Objective-C (`RcBlock`) giữ `tx` (đầu gửi của channel). Nếu `rx.recv_timeout(TIMEOUT)` hết giờ và Rust return lỗi trước, nhưng ScreenCaptureKit sau đó (do máy chậm/dispatch queue nghẽn) mới gọi callback thật sự → `tx.send(r)` gọi trên 1 channel mà phía nhận đã bị drop từ lâu. Bản thân `mpsc::Sender::send` trên receiver đã drop chỉ trả `Err` (không panic) nên **không crash trực tiếp**, nhưng đây là code **không phải do tôi viết/sửa** (pre-existing) — chỉ nêu ra vì nó nằm cùng nhóm rủi ro timing với các phần khác trong tài liệu này.
- **Mức độ thực tế:** Thấp (an toàn về mặt Rust vì `send` trên receiver đã drop không panic), nhưng đáng chú ý nếu sau này ai đó đổi `mpsc` sang loại channel khác có thể panic khi gửi vào receiver đã đóng.

---

## B. Rủi ro Đáng chú ý

### B.1. ~~Frontend: hàng loạt `ipc.xxx()` gọi KHÔNG có `.catch()` — lỗi Rust bị nuốt im lặng~~ — **Đã fix**
Đây là **đúng loại bug** vừa tìm và fix ở `WindowPicker` (`Overlay.tsx:459`, đã thêm `.catch((e) => alert(String(e)))`). Rà lại toàn bộ codebase, các chỗ từng **còn thiếu** y hệt (đã fix tất cả, xem mục D):

| File:line | Lệnh gọi | Hậu quả khi Rust lỗi (trước khi fix) |
|---|---|---|
| `Overlay.tsx:93` | `ipc.finalizeRegion(...)` | Kéo chọn vùng xong, thả chuột — im lặng, không mở gì |
| `Overlay.tsx:495` | `ipc.finalizeMonitor()` | Click chọn màn hình — im lặng |
| `CaptureBar.tsx:130,173` | `ipc.captureAllScreens(...)` | Bấm "Chụp" ở mode All — im lặng |
| `CaptureBar.tsx:132,175` | `ipc.captureNow(...)` | Bấm "Chụp" ở mode region/window/full — im lặng |
| `CaptureBar.tsx:192` | `ipc.startQuick()` | Bấm "Nhanh" — im lặng |

**Đây rất có thể chính là nguyên nhân gốc của các lần "chụp cửa sổ không hoạt động" đã gặp trong phiên này** — không riêng window mode, mà **mọi mode chụp khác cũng có cùng lỗ hổng**, chỉ là chưa ai gặp phải lúc đó.

### B.2. ~~Race điều kiện lọc trong History window (`setFilter` + `loadMore` chạy chồng)~~ — **Đã fix**
**File:** `src/routes/history/useHistoryStore.ts`

`setFilter` reset `items` rồi gọi `loadMore()`; nếu user đổi filter lần 2 **trong lúc** request đầu còn đang chạy, `loadMore()` lần 2 bị chặn bởi guard `if (get().loading ...) return;` (vì `loading` vẫn `true` từ lần gọi trước) — nên request cho filter mới **không được gửi**. Khi request cũ (filter cũ) trả về, nó append kết quả **của filter cũ** vào state trong khi ô filter trên UI đã hiển thị giá trị mới.
- **Kịch bản lỗi (trước khi fix):** Đổi filter "Region" → đổi ngay sang "Window" trước khi trang đầu tải xong → danh sách hiển thị lẫn kết quả của "Region" dù UI đang chọn "Window".
- **Đã fix:** thêm `generation` counter — mỗi `setFilter`/`reload` tăng `generation` và ép `loading: false` (để `loadMore()` mới không bị chặn bởi request cũ còn bay), `loadMore()` chỉ áp dụng kết quả nếu `generation` lúc trả về vẫn khớp lúc gọi.

### B.3. ~~Buffer chụp cuộn không giới hạn dung lượng RAM~~ — **Đã fix**
**File:** `src-tauri/src/commands.rs` (`capture_scroll_slice`, hằng số `MAX_SCROLL_SLICES`)

Mỗi lát cắt chụp cuộn được giữ nguyên trong RAM (không nén) tới khi `finalize_scroll_stitch`. Với ảnh ~1920×1440, mỗi lát ~11MB. Trang cuộn dài (vài trăm lát) có thể dễ dàng lên tới hàng GB RAM — không có cảnh báo hay giới hạn số lát.
- **Đã fix:** thêm `MAX_SCROLL_SLICES = 300` (≈3.3GB ở độ phân giải trên — đủ rộng cho hầu hết trang dài), `capture_scroll_slice` kiểm tra trước khi chụp thêm lát mới, trả lỗi rõ ràng khi chạm ngưỡng. Đồng thời sửa `ScrollControl.tsx` để lỗi này (và mọi lỗi chụp lát khác) hiện lên UI qua `setError` + dừng vòng lặp, thay vì chỉ `console.error` khiến user thấy "đang ghi..." mãi.

### B.4. ~~Đăng ký hotkey trùng với hệ thống/app khác thất bại âm thầm~~ — **Đã fix**
**File:** `src-tauri/src/hotkey/mod.rs` (`register_all`), `src-tauri/src/state.rs` (`AppState.hotkey_warning`), `src/routes/settings/Settings.tsx`

Nếu tổ hợp phím user đặt đã bị OS/app khác chiếm, đăng ký lỗi chỉ in ra `eprintln!` (không có console khi chạy bản build release) — **user không hề biết phím tắt của mình không hoạt động**. Ngoài ra, `register_all` cũ dùng `?` nên dừng NGAY ở combo lỗi đầu tiên — mọi phím tắt **sau nó** trong danh sách cũng không được đăng ký luôn, dù bản thân chúng không có gì sai.
- **Đã fix:** `register_all` giờ thử đăng ký HẾT mọi phím tắt, gộp lỗi của các combo thất bại thay vì dừng giữa chừng. Lỗi gộp được lưu vào `AppState.hotkey_warning`, Settings query lúc mount qua command mới `get_hotkey_warning` và hiện banner đỏ ngay trên mục "PHÍM TẮT TOÀN CỤC"; banner tự xoá khi user lưu lại phím tắt thành công.

### B.5. History: không có giới hạn/dọn dẹp dung lượng đĩa tự động
**File:** `src-tauri/src/history/commands.rs` (`empty_trash` chỉ chạy khi user tự bấm)

Thư mục `library/assets/` + `library/thumbs/` **lớn dần vô hạn** — không TTL, không cảnh báo dung lượng, không tự dọn. Đây là hạn chế **đã biết từ lúc thiết kế** (đã ghi trong kế hoạch v2: "Auto-purge Trash sau N ngày", "Storage quota / auto-cleanup") — nêu lại ở đây để không quên triển khai trước khi phát hành rộng.

### B.6. `permanently_delete_history_item`: lỗi xoá file bị bỏ qua âm thầm
**File:** `src-tauri/src/history/commands.rs:101-102`
```rust
let _ = std::fs::remove_file(&rec.asset_path);
let _ = std::fs::remove_file(&rec.thumb_path);
```
Nếu xoá file thất bại (bị khoá bởi antivirus, quyền truy cập...), row DB vẫn bị xoá — để lại file rác vĩnh viễn trên đĩa mà user tưởng đã xoá xong.

### B.7. Các `sleep()` cố định để né race điều kiện timing (Windows/Linux)
**File:** `src-tauri/src/flow.rs:218,242,258` (200ms sau `close_overlays`), `src-tauri/src/windows/mod.rs:631-633,811` (50-100ms chờ WebView2 resume)

Đây là các hack **có chủ đích, đã ghi rõ lý do trong comment gốc** (né deadlock khi poll window đóng). Rủi ro: trên máy đang chịu tải CPU cao (nhiều tab trình duyệt, game nền...), khoảng sleep cố định có thể không đủ → ảnh chụp dính artefact overlay, hoặc event `refresh-capture` tới trước khi WebView2 sẵn sàng khiến Editor không nhận được ảnh mới (phải focus lại cửa sổ mới thấy).
- **Mức độ:** Chấp nhận được như đánh đổi hiện tại, nhưng đáng để mắt nếu người dùng report "thỉnh thoảng ảnh có vệt lạ" hoặc "Editor mở lên trống".

---

## C. Rủi ro Nhẹ / Cần theo dõi

- **`state.rs:50-59` (`LastCaptureMode::get/set`)** — dùng `.unwrap()` trên `Mutex::lock()`. *(Đã kiểm chứng: 2 lock `mode`/`output` được lock và nhả tuần tự trong từng dòng riêng, KHÔNG giữ đồng thời — nên không có nguy cơ deadlock giữa 2 lock này như nghi ngờ ban đầu.)* Rủi ro thật duy nhất: nếu 1 trong 2 mutex từng bị poison do panic ở nơi khác, mọi lần gọi `get()/set()` sau đó sẽ panic dây chuyền. Nên đổi `.unwrap()` thành xử lý lỗi mềm.
- **`update.rs:53,87,139`** — cùng pattern `.lock().unwrap()` trên `PendingUpdate` — cùng rủi ro poison-cascade như trên, mức độ thấp hơn vì đường gọi đều nằm trong async command có thể phục hồi qua restart.
- **`windows/mod.rs:488` (`input_loop`)** — lock `overlay_monitors` mỗi 8ms trong vòng lặp polling; nếu user mở/đóng overlay liên tục tạo nhiều `input_loop` thread cùng lúc (trước khi `overlay_gen` kịp vô hiệu hoá thread cũ), có thể tranh lock nhẹ — không nguy hiểm nhưng có thể gây giật input trong khoảnh khắc ngắn.
- **`HistoryGrid.tsx:54`** — dependency array của `useEffect` dùng `virtualRows.map(r=>r.index).join(",")` — tạo string mới mỗi render, hơi lãng phí nhưng không gây vòng lặp vô hạn thực sự (vẫn có `hasMore`/`loading` chặn).
- **`ScrollControl.tsx`** — lỗi chụp từng lát chỉ `console.error`, không hiện lên UI — user thấy "đang ghi..." mãi nếu 1 lát lỗi.
- **`Editor.tsx` (`doOpen`)** — `img.onerror` chưa được gắn khi load file mở từ dialog — file ảnh hỏng sẽ khiến thao tác "Open" không phản hồi gì.
- ~~**Trùng tên file khi chụp 2 lần trong cùng 1 giây**~~ — **Đã kiểm tra: KHÔNG phải lỗi.** `storage/save.rs::write_png()` đã gọi `dedupe()` tự động thêm hậu tố `_1`, `_2`... nếu file trùng tên, nên không có chuyện ghi đè.

---

## D. Đã fix (tham khảo — 2 đợt)

### Đợt 1 — fix hiệu năng mở Editor (trước khi audit toàn bộ)

| Vấn đề | Fix |
|---|---|
| `history::ingest()` chạy đồng bộ, chặn mở Editor/copy/save mỗi lần chụp | Tách 2 pha: INSERT nhanh đồng bộ + ghi file/thumbnail chạy nền |
| SQLite mặc định `synchronous=FULL`, fsync mỗi transaction | Thêm `PRAGMA synchronous=NORMAL` cạnh `WAL` |
| Các command History đọc/ghi đĩa chạy `fn` đồng bộ, có thể chặn Tokio runtime | Chuyển sang `async fn` + `spawn_blocking`, đồng nhất với convention có sẵn |
| `ipc.finalizeWindow(w.id)` không có `.catch()` → lỗi chụp cửa sổ bị nuốt im lặng | Thêm `.catch((e) => alert(String(e)))` |

### Đợt 2 — fix toàn bộ danh sách ưu tiên mục E (sau khi audit)

| # | Vấn đề | Fix |
|---|---|---|
| 1 | 5 lệnh `ipc.xxx()` khác thiếu `.catch()` (mục B.1) | Thêm `.catch((e) => alert(String(e)))` cho `finalizeRegion`, `finalizeMonitor`, `captureAllScreens` ×2, `captureNow` ×2, `startQuick` |
| 2 | `log::` trong `update.rs`/`lib.rs` vô hình (mục A.1) | Đổi hết sang `eprintln!("[SnapDoc][update] ...")`, xoá dependency `log` khỏi `Cargo.toml` |
| 3 | Race filter trong History window (mục B.2) | Thêm `generation` counter trong `useHistoryStore.ts` |
| 4 | Spawn thread không giới hạn mỗi lần chụp (mục A.2) | 1 worker thread cố định + `mpsc::channel` (`spawn_ingest_worker`) thay cho `std::thread::spawn` mỗi lần |
| 5 | Buffer chụp cuộn không giới hạn RAM (mục B.3) | `MAX_SCROLL_SLICES = 300` + surface lỗi lên UI qua `setError` trong `ScrollControl.tsx` |
| 6 | Hotkey trùng thất bại âm thầm (mục B.4) | `register_all` thử hết mọi combo thay vì dừng giữa chừng; lỗi gộp hiện banner ở Settings |

---

## E. Danh sách hành động ưu tiên

✅ Mục 1–6 đã fix xong (xem bảng "Đợt 2" ở mục D).

7. **(Còn lại, v2 — không gấp)** Thêm retention/quota cho History — tự xoá Trash cũ, cảnh báo dung lượng đĩa. Đây là hạn chế đã biết từ lúc thiết kế (mục B.5), chưa cấp thiết cho bản dùng cá nhân/nhóm nhỏ nhưng nên làm trước khi phát hành rộng.
