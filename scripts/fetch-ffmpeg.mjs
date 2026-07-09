#!/usr/bin/env node
// Tự động chuẩn bị sẵn binary ffmpeg cho src-tauri/binaries/ trước khi
// dev/build — máy nào CHƯA có (theo đúng target-triple Tauri cần) thì tự tải
// về, khỏi phải tự tay tải + đặt tên file thủ công (từng phải làm vậy cho
// Windows). Chạy tự động qua tauri.conf.json (beforeDevCommand/
// beforeBuildCommand) nên áp dụng cho MỌI cách khởi chạy `tauri dev`/
// `tauri build` (kể cả scripts/dev-mac.sh, scripts/build-mac.sh).
//
// - macOS: bản build release là UNIVERSAL BINARY (cần cả 2 kiến trúc cùng
//   lúc, không phải chỉ đúng kiến trúc máy đang chạy) — CẢ 2 kiến trúc đều
//   tải bản STATIC build (arm64 từ osxexperts.net, x86_64 Intel từ
//   evermeet.cx). Trước đây arm64 cài qua Homebrew (`brew install ffmpeg`)
//   rồi copy binary ra khỏi Cellar — ĐÃ BỎ vì binary đó liên kết ĐỘNG tới
//   hàng chục .dylib trong chính Cellar Homebrew (`/opt/homebrew/Cellar/
//   ffmpeg/<version>/lib/...` + libvmaf/x264/x265/dav1d/opus/lame/openssl...)
//   — chỉ chạy được trên đúng máy dev có Homebrew, và ĐÃ TỰ GẪY ngay trên máy
//   dev khi `brew upgrade` đổi version Cellar: binary cũ trong
//   `src-tauri/binaries/` (được cache, script không re-check) vẫn trỏ tới
//   path phiên bản cũ không còn tồn tại → app đóng gói báo "Library not
//   loaded" khi chạy ffmpeg, dù bản thân code không đổi gì. Static build
//   không có lớp rủi ro này (chỉ liên kết System framework/`/usr/lib`, luôn
//   có sẵn trên mọi máy macOS).
// - Windows (host Windows HOẶC container Linux của scripts/build-win-docker.sh
//   cross-build sang x86_64-pc-windows-msvc): tải bản dựng TĨNH (static) mới
//   nhất từ BtbN/FFmpeg-Builds trên GitHub Releases (tag "latest" luôn được
//   cập nhật, tên file cố định nên script được ổn định) — chỉ cần `fetch` +
//   `tar` (đều có sẵn trên Windows 10+ lẫn Debian/Ubuntu) nên không phụ thuộc
//   hệ điều hành đang CHẠY script, chỉ phụ thuộc kiến trúc ĐÍCH cần build.
//
// CỐ TÌNH KHÔNG BAO GIỜ LÀM FAIL `tauri dev`/`tauri build`: script này chỉ là
// tiện ích chuẩn bị trước — nếu tải thất bại (không mạng, đổi URL, thiếu
// Homebrew...) thì chỉ log cảnh báo rồi thoát BÌNH THƯỜNG — nếu binary vẫn
// thật sự thiếu, chính Tauri sẽ tự báo lỗi rõ ràng ở bước build/bundle như cũ.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES_DIR = join(ROOT, "src-tauri", "binaries");

function log(msg) {
  console.log(`[fetch-ffmpeg] ${msg}`);
}
function warn(msg) {
  console.warn(`[fetch-ffmpeg] ${msg}`);
}

// Windows KHÔNG có khái niệm universal binary — chỉ cần đúng 1 kiến trúc của
// máy đang build. Suy từ host hiện tại vì đây là build native (không cross-
// compile). Không xử lý host Linux (container cross-build cho Windows
// installer, xem scripts/build-win-docker.sh) — trường hợp đó binary Windows
// đã có sẵn qua rsync từ host, không cần script này đụng vào.
function windowsHostTriple() {
  if (process.platform !== "win32") return null;
  return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
}

function destPathFor(triple) {
  const ext = triple.includes("windows") ? ".exe" : "";
  return join(BINARIES_DIR, `ffmpeg-${triple}${ext}`);
}

function findFileRecursive(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Tải thất bại (HTTP ${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dest, buf);
}

// `tar` trên Windows (bsdtar, có sẵn từ 10 1803+) và macOS (cũng bsdtar) tự
// nhận diện và giải nén được cả .zip — nhưng `tar` mặc định trên Debian/Ubuntu
// (container Linux cross-build) là GNU tar, KHÔNG hỗ trợ .zip, cần `unzip`
// riêng (đã thêm vào scripts/win-cross.Dockerfile).
function extractZip(zipPath, destDir) {
  if (process.platform === "linux") {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir]);
  } else {
    execFileSync("tar", ["-xf", zipPath, "-C", destDir]);
  }
}

async function fetchWindows(dest, triple) {
  const arch = triple.startsWith("aarch64") ? "winarm64" : "win64";
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.zip`;
  log(`Đang tải ffmpeg (Windows, ${arch}) từ BtbN/FFmpeg-Builds...`);
  const tmp = mkdtempSync(join(tmpdir(), "snapdoc-ffmpeg-"));
  try {
    const zipPath = join(tmp, "ffmpeg.zip");
    await downloadFile(url, zipPath);
    extractZip(zipPath, tmp);
    const found = findFileRecursive(tmp, "ffmpeg.exe");
    if (!found) throw new Error("Không tìm thấy ffmpeg.exe sau khi giải nén");
    mkdirSync(BINARIES_DIR, { recursive: true });
    copyFileSync(found, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Kiến trúc arm64 (Apple Silicon) — tải bản static build từ osxexperts.net
// (cùng nguồn cấp cả arm64 lẫn Intel, xem `fetchMacIntelViaEvermeet` bên
// dưới dùng evermeet.cx cho Intel — giữ nguyên vì đã chạy ổn, chỉ đổi nguồn
// cho arm64 vì Homebrew không cho static build). Tên file trên server ghim
// theo version cụ thể (ví dụ "ffmpeg81arm.zip" = ffmpeg 8.1) nên định kỳ cần
// cập nhật `OSXEXPERTS_ARM_FILE` khi có major version mới — không tự dò được
// "latest" như evermeet.cx (không có endpoint JSON tương đương).
const OSXEXPERTS_ARM_FILE = "ffmpeg81arm.zip";

async function fetchMacArmViaOsxExperts(dest) {
  const url = `https://www.osxexperts.net/${OSXEXPERTS_ARM_FILE}`;
  log(`Đang tải ffmpeg (macOS arm64) từ osxexperts.net (${OSXEXPERTS_ARM_FILE})...`);
  const tmp = mkdtempSync(join(tmpdir(), "snapdoc-ffmpeg-"));
  try {
    const zipPath = join(tmp, "ffmpeg.zip");
    await downloadFile(url, zipPath);
    execFileSync("tar", ["-xf", zipPath, "-C", tmp]);
    const found = findFileRecursive(tmp, "ffmpeg");
    if (!found) throw new Error("Không tìm thấy binary ffmpeg sau khi giải nén");
    mkdirSync(BINARIES_DIR, { recursive: true });
    copyFileSync(found, dest);
    chmodSync(dest, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Kiến trúc x86_64 Intel — CẦN cho universal binary dù máy đang chạy là Apple
// Silicon hay Intel (Homebrew chỉ cho ra đúng 1 kiến trúc native của máy,
// không tự build cross-arch) — tải bản static build có sẵn từ evermeet.cx,
// nguồn ffmpeg macOS Intel lâu đời, được nhiều dự án mã nguồn mở dùng.
async function fetchMacIntelViaEvermeet(dest) {
  log("Đang tải ffmpeg (macOS Intel x86_64) từ evermeet.cx...");
  const infoRes = await fetch("https://evermeet.cx/ffmpeg/info/ffmpeg/release");
  if (!infoRes.ok) {
    throw new Error(`Không lấy được thông tin bản ffmpeg mới nhất từ evermeet.cx (HTTP ${infoRes.status})`);
  }
  const info = await infoRes.json();
  const url = info?.download?.zip?.url;
  if (!url) {
    throw new Error("Không đọc được URL tải từ evermeet.cx (cấu trúc JSON có thể đã đổi)");
  }
  const tmp = mkdtempSync(join(tmpdir(), "snapdoc-ffmpeg-"));
  try {
    const zipPath = join(tmp, "ffmpeg.zip");
    await downloadFile(url, zipPath);
    execFileSync("tar", ["-xf", zipPath, "-C", tmp]);
    const found = findFileRecursive(tmp, "ffmpeg");
    if (!found) throw new Error("Không tìm thấy binary ffmpeg sau khi giải nén");
    mkdirSync(BINARIES_DIR, { recursive: true });
    copyFileSync(found, dest);
    chmodSync(dest, 0o755);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Lúc BUNDLE (đóng gói .app cuối cùng), Tauri cần 1 file DUY NHẤT
// `ffmpeg-universal-apple-darwin` (khác lúc COMPILE, mỗi kiến trúc build
// riêng chỉ cần đúng `ffmpeg-<arch>-apple-darwin` của nó) — đây là universal
// (fat) Mach-O gộp cả 2 kiến trúc bằng `lipo`, có sẵn trên mọi máy macOS
// (Xcode Command Line Tools).
function ensureMacUniversal() {
  const dest = destPathFor("universal-apple-darwin");
  if (existsSync(dest)) {
    log(`Đã có sẵn: ${dest}`);
    return;
  }
  const arm = destPathFor("aarch64-apple-darwin");
  const intel = destPathFor("x86_64-apple-darwin");
  if (!existsSync(arm) || !existsSync(intel)) {
    warn(`Chưa đủ cả 2 kiến trúc để gộp universal binary (thiếu ${existsSync(arm) ? intel : arm})`);
    return;
  }
  log("Đang gộp ffmpeg universal binary (lipo)...");
  try {
    execFileSync("lipo", ["-create", "-output", dest, arm, intel]);
    chmodSync(dest, 0o755);
    log(`Đã sẵn sàng: ${dest}`);
  } catch (e) {
    warn(`Không gộp được universal binary: ${e.message}`);
    warn(`Có thể tự chạy thủ công: lipo -create -output ${dest} ${arm} ${intel}`);
  }
}

async function ensureOne(triple, fetcher) {
  const dest = destPathFor(triple);
  if (existsSync(dest)) {
    log(`Đã có sẵn: ${dest}`);
    return;
  }
  log(`Chưa có ffmpeg cho ${triple} — đang chuẩn bị (chỉ chạy 1 lần)...`);
  try {
    await fetcher(dest);
    log(`Đã sẵn sàng: ${dest}`);
  } catch (e) {
    warn(`Không tự chuẩn bị được ffmpeg cho ${triple}: ${e.message}`);
    warn(`Có thể tự tải thủ công và đặt tại: ${dest}`);
    // KHÔNG process.exit(1) — xem doc-comment đầu file: không làm fail
    // dev/build vì lý do này, để Tauri tự báo lỗi rõ ràng nếu binary thật sự
    // thiếu lúc bundle.
  }
}

async function main() {
  if (process.platform === "darwin") {
    await ensureOne("aarch64-apple-darwin", fetchMacArmViaOsxExperts);
    await ensureOne("x86_64-apple-darwin", fetchMacIntelViaEvermeet);
    ensureMacUniversal();
    return;
  }

  const winTriple = windowsHostTriple();
  if (winTriple) {
    await ensureOne(winTriple, (dest) => fetchWindows(dest, winTriple));
    return;
  }

  if (process.platform === "linux") {
    // Container cross-build NSIS installer cho Windows chạy trên host Linux
    // (scripts/build-win-docker.sh + win-cross.Dockerfile) — project này chỉ
    // dùng host Linux cho ĐÚNG mục đích này, luôn cross-compile sang
    // x86_64-pc-windows-msvc (khớp cờ --target trong script đó). Tải/giải nén
    // (fetch + tar) không phụ thuộc hệ điều hành đang chạy nên dùng lại được
    // nguyên hàm `fetchWindows`.
    const triple = "x86_64-pc-windows-msvc";
    await ensureOne(triple, (dest) => fetchWindows(dest, triple));
    return;
  }

  log(`Bỏ qua — host hiện tại (${process.platform}) không xác định được cách chuẩn bị ffmpeg.`);
}

// An toàn tuyệt đối: dù có lỗi bất ngờ nào lọt qua try/catch trong main(),
// vẫn không được làm fail beforeDevCommand/beforeBuildCommand (xem doc-comment
// đầu file) — chỉ log rồi thoát bình thường.
main().catch((e) => {
  warn(`Lỗi không mong đợi, bỏ qua: ${e.message}`);
});
