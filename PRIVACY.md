# SnapDoc — Privacy Policy (Chính sách quyền riêng tư)

*Last updated / Cập nhật lần cuối: November 2026*

[English](#english) | [Tiếng Việt](#tiếng-việt)

---

<a name="english"></a>
## English

SnapDoc ("the Application", "we", "us") is an open-source, local-first desktop application designed for fast screenshots, screen recordings, and multimedia annotations on Windows and macOS. We believe in absolute privacy: **your content belongs to you, and it never leaves your computer.**

### 1. Information We Access and How It Is Used

* **Screen Capture & Recording:**
  SnapDoc accesses your screen displays and application windows strictly when you explicitly trigger a capture or recording action (via hotkey, system tray, or the capture bar). Captured frames and pixels are processed entirely in your computer's local memory and saved to your local storage. **We do not upload, transmit, or inspect your screen content on any remote server.**

* **Microphone Access:**
  If you choose to enable audio recording during a screen recording session, SnapDoc accesses your selected microphone device through local system APIs (Windows WASAPI / macOS CoreAudio) and encodes audio locally using the bundled FFmpeg binary. Audio data is never streamed or uploaded to any third party.

* **Local Storage & File System:**
  SnapDoc stores your screenshots, recordings, annotation project files (`.snapdoc`), settings, and thumbnail cache locally on your machine (e.g., in `%LOCALAPPDATA%\SnapDoc` on Windows or `~/Library/Application Support/SnapDoc` on macOS). You have full control over where your files are saved and can delete them at any time.

* **Keystroke & Mouse HUD (Optional):**
  When screen recording with keystroke or mouse click visualization enabled, input events are displayed in a transient visual overlay solely for the purpose of being included in your local video recording. Keypresses are not logged to disk or transmitted anywhere.

### 2. Telemetry and Analytics

SnapDoc utilizes **Aptabase**, a privacy-first, privacy-respecting analytics service, to collect minimal, anonymous usage metrics:
* **What is collected:** Anonymous app launches, app version, operating system platform, and aggregate feature usage statistics.
* **What is NEVER collected:** No IP addresses, no unique hardware identifiers, no personal identifiable information (PII), no file paths, and no captured image or audio content.
* The collected metrics are used solely to fix crashes, identify stability issues, and improve app performance.

### 3. Application Updates

* **Microsoft Store Edition:** Application updates are managed entirely and securely by the Microsoft Store infrastructure in accordance with Microsoft Store policies.
* **Standalone / GitHub Edition:** The app checks the public GitHub repository releases API (`latest.json`) to notify you when a new version is available.

### 4. Third-Party Libraries

SnapDoc bundles open-source dependencies (including FFmpeg for video encoding and conversion). All third-party libraries run locally on your system without network communication beyond what is explicitly described in this policy.

### 5. Children's Privacy

SnapDoc does not address anyone under the age of 13. We do not knowingly collect personally identifiable information from children.

### 6. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be posted directly in this document within the public repository.

### 7. Contact Us

If you have any questions or feedback regarding this Privacy Policy, please open an issue on our GitHub repository:
👉 [https://github.com/dev-truonglx/snapdoc](https://github.com/dev-truonglx/snapdoc)

---

<a name="tiếng-việt"></a>
## Tiếng Việt

SnapDoc ("Ứng dụng", "chúng tôi") là ứng dụng máy tính nguồn mở hoạt động theo nguyên tắc **ưu tiên lưu trữ cục bộ (local-first)**, phục vụ nhu cầu chụp ảnh màn hình, quay video và chú thích hình ảnh trên Windows và macOS. Chúng tôi cam kết bảo vệ quyền riêng tư tuyệt đối của bạn: **toàn bộ nội dung của bạn chỉ nằm trên máy tính cá nhân của bạn.**

### 1. Dữ liệu và Quyền hạn Ứng dụng Sử dụng

* **Chụp & Quay màn hình:**
  SnapDoc chỉ truy cập màn hình hoặc cửa sổ khi bạn chủ động kích hoạt lệnh chụp hoặc quay (thông qua phím tắt, menu khay hệ thống hoặc thanh công cụ). Toàn bộ hình ảnh, video được xử lý trực tiếp trên RAM và lưu vào ổ cứng của bạn. **Chúng tôi tuyệt đối không tải lên, truyền tải hoặc xem trước nội dung màn hình của bạn trên bất kỳ máy chủ nào.**

* **Quyền truy cập Microphone (Ghi âm):**
  Nếu bạn bật tính năng thu âm khi quay video màn hình, SnapDoc sẽ sử dụng microphone bạn đã chọn thông qua API hệ thống nội bộ và mã hóa âm thanh cục bộ bằng công cụ FFmpeg đi kèm. Dữ liệu âm thanh không bao giờ được gửi ra ngoài.

* **Bộ nhớ & Hệ thống tập tin cục bộ:**
  SnapDoc lưu ảnh chụp, video, tệp dự án (`.snapdoc`), cấu hình cài đặt và bộ nhớ đệm (cache) hoàn toàn tại máy tính cá nhân của bạn (ví dụ: `%LOCALAPPDATA%\SnapDoc` trên Windows hoặc `~/Library/Application Support/SnapDoc` trên macOS). Bạn có toàn quyền chọn nơi lưu trữ, sao chép hoặc xóa dữ liệu bất kỳ lúc nào.

* **Hiển thị phím tắt & Chuột (Keystroke & Mouse HUD):**
  Khi bật tính năng hiển thị phím bấm lúc quay video, các phím tắt chỉ hiển thị tạm thời trên màn hình để đưa vào video quay tại chỗ. Ứng dụng không lưu nhật ký gõ phím (keylogger) và không gửi đi bất cứ đâu.

### 2. Thu thập Thông tin Ẩn danh (Telemetry)

SnapDoc sử dụng dịch vụ **Aptabase** (giải pháp phân tích ẩn danh tôn trọng quyền riêng tư) để thu thập một số chỉ số tối thiểu:
* **Dữ liệu thu thập:** Số lần mở app ẩn danh, phiên bản ứng dụng, hệ điều hành (Windows/macOS) và tần suất sử dụng các tính năng chung.
* **Tuyệt đối KHÔNG thu thập:** Địa chỉ IP, mã định danh cá nhân (PII), tên tệp, đường dẫn thư mục, nội dung hình ảnh hay âm thanh của bạn.
* Dữ liệu này chỉ phục vụ mục đích duy nhất là phát hiện lỗi sập app và cải thiện hiệu năng phần mềm.

### 3. Cập nhật Ứng dụng

* **Phiên bản Microsoft Store:** Các bản cập nhật được kiểm duyệt, phân phối và quản lý hoàn toàn tự động qua hạ tầng của Microsoft Store theo quy định của Microsoft.
* **Phiên bản tải trực tiếp (GitHub):** Ứng dụng gửi truy vấn kiểm tra phiên bản mới nhất qua API công khai của GitHub (`latest.json`).

### 4. Bản quyền và Thư viện Bên thứ ba

SnapDoc tích hợp thư viện nguồn mở FFmpeg để xử lý video và xuất ảnh động GIF. Tất cả các thư viện đều chạy offline trên thiết bị của bạn.

### 5. Liên hệ

Mọi thắc mắc hoặc yêu cầu liên quan đến Chính sách quyền riêng tư này, vui lòng gửi phản hồi tại GitHub repository chính thức:
👉 [https://github.com/dev-truonglx/snapdoc](https://github.com/dev-truonglx/snapdoc)
