import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";

const params = new URLSearchParams(window.location.search);
const mx = Number(params.get("mx") ?? "0");
const my = Number(params.get("my") ?? "0");
const rx = Number(params.get("rx") ?? "0");
const ry = Number(params.get("ry") ?? "0");
const rw = Number(params.get("rw") ?? "0");
const rh = Number(params.get("rh") ?? "0");

function loadImage(src: string, t: any): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("scroll.imageLoadError")));
    img.src = src;
  });
}

const COLOR_TOL = 12; // sai khác màu cho phép mỗi kênh
const SCROLLBAR_MARGIN = 25; // bỏ lề phải tránh thanh cuộn
const SAMPLE_STEP = 4; // bước lấy mẫu pixel theo chiều ngang (dày hơn để bắt nội dung thưa)
const BG_SAMPLE_STEP = 8; // bước lấy mẫu khi ước lượng màu nền của dòng
const BG_DEV = 16; // độ lệch sáng so với nền để coi 1 điểm là "có nội dung"
const SAME_RATIO = 0.9; // tỉ lệ khớp (trên điểm nội dung) để coi 2 dòng "y hệt" (vùng cố định)
const PROFILE_STEP = 3; // bước lấy mẫu x khi tính biên dạng cạnh ngang
const MIN_DY = 3; // bỏ qua dịch chuyển quá nhỏ (nhiễu / con trỏ nhấp nháy)
const MIN_OVERLAP = 64; // số dòng chồng lấn tối thiểu để NCC đáng tin (chặn đỉnh giả ở dy lớn)
const MAX_SCROLL_FRAC = 0.5; // dy tối đa = nửa vùng cuộn (1 tick không cuộn quá nửa khung)
const NBINS = 8; // số ô ngang của biên dạng cạnh (mã hoá vị trí ngang để phân biệt mạnh)
const NCC_ACCEPT = 0.6; // NCC tại đỉnh ≥ ngưỡng này thì TIN dy (không cần so pixel chặt)
const CHANGE_TOL = 16; // độ lệch sáng để coi 1 điểm là "đã đổi" giữa 2 khung
const FIXED_FG_FRAC = 0.05; // mật độ nội dung tối thiểu để 1 ô được xét là cột cố định
const FIXED_CHANGE_MAX = 0.2; // tỉ lệ nội dung thay đổi tối đa để coi ô là CỐ ĐỊNH (sidebar dính)
const FAST_DIFF = 0.35; // dy=-1 mà tỉ lệ dòng đổi ≥ ngưỡng này ⇒ cuộn quá nhanh (không phải tới đáy)
const DEBUG = false; // bật true để hiện log chẩn đoán trên panel khi cần dò lỗi cuộn

// Độ sáng (luminance) gần đúng của 1 pixel — dùng phân biệt nền/nội dung.
function lumAt(d: Uint8ClampedArray, i: number): number {
  return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
}

// Ước lượng độ sáng NỀN của 1 dòng = trung vị các điểm mẫu. Với dòng thưa
// (table, dashboard) phần lớn là nền nên trung vị chính là màu nền; nhờ đó ta
// tách được pixel "nội dung" khỏi nền dù nội dung chỉ chiếm vài phần trăm.
function rowBgLum(d: Uint8ClampedArray, off: number, w: number): number {
  const lums: number[] = [];
  for (let x = 0; x < w - SCROLLBAR_MARGIN; x += BG_SAMPLE_STEP) {
    lums.push(lumAt(d, off + x * 4));
  }
  if (lums.length === 0) return 0;
  lums.sort((a, b) => a - b);
  return lums[lums.length >> 1];
}

interface RowCmp {
  ratio: number; // tỉ lệ khớp trên TẤT CẢ điểm mẫu (dùng cho dòng nền trơn)
  contentRatio: number; // tỉ lệ khớp chỉ trên điểm CÓ NỘI DUNG
  content: number; // số điểm có nội dung (độ mạnh của bằng chứng)
}

// So 2 dòng theo mẫu, nhưng TÁCH RIÊNG điểm nội dung khỏi nền. Đây là chỗ then
// chốt: bản cũ đếm mọi pixel ngang nhau nên với khung thưa (nội dung ~10%, còn
// lại là nền) thì nền trùng làm tỉ lệ khớp luôn cao → nhận nhầm 2 dòng khác
// nhau là "giống". Nay nền không còn lấn át: quyết định dựa trên contentRatio.
function rowCompare(
  d1: Uint8ClampedArray,
  off1: number,
  bg1: number,
  d2: Uint8ClampedArray,
  off2: number,
  bg2: number,
  w: number,
): RowCmp {
  let total = 0;
  let ok = 0;
  let content = 0;
  let contentOk = 0;
  for (let x = 0; x < w - SCROLLBAR_MARGIN; x += SAMPLE_STEP) {
    const i1 = off1 + x * 4;
    const i2 = off2 + x * 4;
    const matched =
      Math.abs(d1[i1] - d2[i2]) <= COLOR_TOL &&
      Math.abs(d1[i1 + 1] - d2[i2 + 1]) <= COLOR_TOL &&
      Math.abs(d1[i1 + 2] - d2[i2 + 2]) <= COLOR_TOL;
    total++;
    if (matched) ok++;
    // Điểm "có nội dung" nếu lệch khỏi nền ở ÍT NHẤT một trong hai khung.
    if (Math.abs(lumAt(d1, i1) - bg1) > BG_DEV || Math.abs(lumAt(d2, i2) - bg2) > BG_DEV) {
      content++;
      if (matched) contentOk++;
    }
  }
  const ratio = total === 0 ? 1 : ok / total;
  return {
    ratio,
    contentRatio: content === 0 ? ratio : contentOk / content,
    content,
  };
}

// Biên dạng cạnh ngang CHIA Ô (binned): với mỗi dòng y, năng lượng cạnh dọc
// (|Δsáng| so với dòng trên) được gom vào NBINS ô theo bề ngang. Khác với phiên
// bản 1-số/dòng (mất thông tin vị trí ngang → đỉnh nhiễu dễ trùng), vector NBINS
// mã hoá CẠNH NẰM Ở ĐÂU theo chiều ngang nên phân biệt mạnh hơn hẳn: một dịch
// chuyển sai sẽ không khớp được phân bố ngang. Vẫn ≈0 ở nền trơn (bền nội dung
// thưa) và gom-tổng nên bao dung với răng cưa/subpixel khi cuộn mượt.
function edgeProfileBinned(d: Uint8ClampedArray, w: number, h: number, stride: number): Float32Array {
  const xEnd = w - SCROLLBAR_MARGIN;
  const binW = Math.max(1, Math.floor(xEnd / NBINS));
  const prof = new Float32Array(h * NBINS);
  for (let y = 1; y < h; y++) {
    const off = y * stride;
    const up = off - stride;
    const base = y * NBINS;
    for (let x = 0; x < xEnd; x += PROFILE_STEP) {
      const b = Math.min(NBINS - 1, Math.floor(x / binW));
      const i = off + x * 4;
      const j = up + x * 4;
      prof[base + b] += Math.abs(lumAt(d, i) - lumAt(d, j));
    }
  }
  return prof;
}

// Mặt nạ ô "đang cuộn": phát hiện CỘT CỐ ĐỊNH (sidebar/panel dính) để loại khỏi
// NCC. Một ô bị coi là CỐ ĐỊNH khi có MẬT ĐỘ NỘI DUNG cao nhưng nội dung GẦN NHƯ
// KHÔNG ĐỔI giữa 2 khung (foreground trùng tại chỗ). Khác hẳn cột nội-dung-thưa
// đang cuộn: cột đó mật độ thấp HOẶC nội dung có thay đổi (đã dịch) — nên không
// bị loại nhầm. Cột cố định nếu giữ lại sẽ thêm năng lượng cạnh lệch pha, kéo
// NCC ở dy thật xuống. Trả Uint8Array(NBINS): 1 = dùng, 0 = bỏ.
function activeBinMask(
  p: Uint8ClampedArray,
  c: Uint8ClampedArray,
  bgP: Float32Array,
  bgC: Float32Array,
  w: number,
  h: number,
  stride: number,
): Uint8Array {
  const xEnd = w - SCROLLBAR_MARGIN;
  const binW = Math.max(1, Math.floor(xEnd / NBINS));
  const cnt = new Float64Array(NBINS);
  const fg = new Float64Array(NBINS);
  const chg = new Float64Array(NBINS);
  for (let y = 0; y < h; y += 4) {
    const row = y * stride;
    const bp = bgP[y];
    const bc = bgC[y];
    for (let x = 0; x < xEnd; x += PROFILE_STEP) {
      const b = Math.min(NBINS - 1, Math.floor(x / binW));
      const i = row + x * 4;
      const lp = lumAt(p, i);
      const lc = lumAt(c, i);
      cnt[b]++;
      if (Math.abs(lp - bp) > BG_DEV || Math.abs(lc - bc) > BG_DEV) {
        fg[b]++;
        if (Math.abs(lp - lc) > CHANGE_TOL) chg[b]++;
      }
    }
  }
  const mask = new Uint8Array(NBINS);
  let active = 0;
  for (let b = 0; b < NBINS; b++) {
    const fgFrac = cnt[b] > 0 ? fg[b] / cnt[b] : 0;
    const chgOfContent = fg[b] > 0 ? chg[b] / fg[b] : 1;
    const isFixed = fgFrac >= FIXED_FG_FRAC && chgOfContent <= FIXED_CHANGE_MAX;
    mask[b] = isFixed ? 0 : 1;
    active += mask[b];
  }
  // Nếu (hiếm) mọi ô đều bị coi là cố định → không loại gì, dùng hết để có tín hiệu.
  if (active === 0) mask.fill(1);
  return mask;
}

// Tương quan chuẩn hoá (NCC) giữa biên dạng binned của prev và cur khi nội dung
// dịch LÊN dy px (prev[y] ≈ cur[y - dy]). Coi mỗi (dòng, ô ĐANG CUỘN) là một mẫu
// nên NCC nắm cả MẪU HÌNH DỌC lẫn PHÂN BỐ NGANG của cạnh → đỉnh thật tách bạch
// khỏi nhiễu. Bỏ qua các ô cố định (mask=0). Overlap toàn nền → trả 0.
function shiftNCC(
  profP: Float32Array,
  profC: Float32Array,
  scrollTop: number,
  scrollBottom: number,
  dy: number,
  mask: Uint8Array,
  activeBins: number,
): number {
  const y0 = scrollTop + dy;
  const nRows = scrollBottom - y0;
  if (nRows < MIN_OVERLAP || activeBins === 0) return -1; // overlap nhỏ / không có ô cuộn
  const n = nRows * activeBins;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = y0; y < scrollBottom; y++) {
    const ip = y * NBINS;
    const ic = (y - dy) * NBINS;
    for (let b = 0; b < NBINS; b++) {
      if (mask[b] === 0) continue;
      const a = profP[ip + b];
      const bb = profC[ic + b];
      sa += a;
      sb += bb;
      saa += a * a;
      sbb += bb * bb;
      sab += a * bb;
    }
  }
  const ma = sa / n;
  const mb = sb / n;
  const cov = sab / n - ma * mb;
  const va = saa / n - ma * ma;
  const vb = sbb / n - mb * mb;
  const denom = Math.sqrt(va * vb);
  return denom > 1e-6 ? cov / denom : 0;
}

interface ScrollAnalysis {
  dy: number; // số pixel nội dung mới (0 = không cuộn, -1 = không khớp được)
  topFixed: number; // chiều cao dải cố định trên (header dính)
  botFixed: number; // chiều cao dải cố định dưới (footer dính / nền trơn cuối)
  ncc?: number; // NCC cao nhất tìm được (chẩn đoán)
  bestDy?: number; // dy tại đỉnh NCC (chẩn đoán)
  span?: number; // chiều cao vùng cuộn = scrollBottom - scrollTop (chẩn đoán)
  changedFrac?: number; // tỉ lệ dòng thay đổi giữa 2 khung (chẩn đoán)
  activeBins?: number; // số ô ngang đang cuộn (đã loại cột cố định) (chẩn đoán)
}

// Phân tích 2 khung liên tiếp: phát hiện dải cố định (header/footer dính) rồi
// tính khoảng cuộn dy CHỈ trong vùng thực sự cuộn. Nhờ đó:
//   - Không nhận nhầm "không cuộn" khi một phần khung (đáy/đỉnh) đứng yên.
//   - Không nhân đôi header/footer dính khi ghép.
function analyzeScroll(prev: ImageData, cur: ImageData): ScrollAnalysis {
  const w = prev.width;
  const h = prev.height;
  const stride = w * 4;
  const p = prev.data;
  const c = cur.data;
  const maxBand = Math.floor(h * 0.4);

  // Ước lượng nền của từng dòng MỘT LẦN cho cả 2 khung (dùng lại trong mọi phép
  // so sánh bên dưới) — tránh tính trung vị lặp đi lặp lại trong vòng quét dy.
  const bgP = new Float32Array(h);
  const bgC = new Float32Array(h);
  for (let yy = 0; yy < h; yy++) {
    bgP[yy] = rowBgLum(p, yy * stride, w);
    bgC[yy] = rowBgLum(c, yy * stride, w);
  }

  // "Giống nhau ở CÙNG vị trí?" — dùng contentRatio nếu dòng có ÍT NHẤT 2 điểm
  // nội dung (đủ để biết nội dung có đổi không); chỉ dòng gần như trắng mới xét
  // ratio tổng. Nhờ vậy 1 dòng nội dung THƯA bị đổi vẫn bị tính là "khác" — dải
  // cố định không còn phình nuốt sạch vùng cuộn (lỗi span≈1).
  const sameInPlace = (y: number): boolean => {
    const off = y * stride;
    const cmp = rowCompare(p, off, bgP[y], c, off, bgC[y], w);
    return cmp.content >= 2 ? cmp.contentRatio >= SAME_RATIO : cmp.ratio >= SAME_RATIO;
  };

  // Tỉ lệ dòng THAY ĐỔI giữa 2 khung (đo độc lập, ở cùng vị trí) — cho biết khung
  // có thật sự đổi không (loại trừ khả năng capture trả về khung trùng).
  let sampled = 0;
  let changed = 0;
  for (let y = 0; y < h; y += 4) {
    sampled++;
    if (!sameInPlace(y)) changed++;
  }
  const changedFrac = sampled ? changed / sampled : 0;

  // 1) Dải cố định trên/dưới: DỪNG ngay ở dòng đầu tiên khác (break-on-mismatch).
  let topFixed = 0;
  while (topFixed < maxBand && sameInPlace(topFixed)) topFixed++;
  let botFixed = 0;
  while (botFixed < maxBand && sameInPlace(h - 1 - botFixed)) botFixed++;

  // An toàn: nếu dải nuốt gần hết (vùng cuộn còn < 25% chiều cao) thì KHÔNG tin
  // vào dải — để NCC quét trên (gần) toàn khung thay vì trả "không cuộn" giả.
  if (h - topFixed - botFixed < h * 0.25) {
    topFixed = 0;
    botFixed = 0;
  }

  const scrollTop = topFixed;
  const scrollBottom = h - botFixed;
  const span = scrollBottom - scrollTop;

  // Hai khung gần như giống hệt → không cuộn (đây là trạng thái đúng, không lỗi).
  if (changedFrac < 0.02 || span < 24) {
    return { dy: 0, topFixed, botFixed, span, changedFrac };
  }

  // 3) Ước lượng dy bằng TƯƠNG QUAN BIÊN DẠNG CẠNH (thay cho dò vài dòng mốc).
  //    Mỗi khung được rút gọn thành tín hiệu 1 chiều (đỉnh ở chữ/viền, ≈0 ở nền)
  //    rồi tìm dịch chuyển dy cho NCC cao nhất. Cách này quét được TOÀN BỘ dy với
  //    chi phí thấp và bền với trang thưa (table, dashboard) — nơi cách so pixel
  //    2-D cũ bị nền trắng lấn át.
  const profP = edgeProfileBinned(p, w, h, stride);
  const profC = edgeProfileBinned(c, w, h, stride);

  // Loại các CỘT CỐ ĐỊNH (sidebar/panel dính) khỏi NCC: chúng không cuộn nên chỉ
  // thêm nhiễu lệch pha, kéo NCC ở dy thật xuống.
  const mask = activeBinMask(p, c, bgP, bgC, w, h, stride);
  let activeBins = 0;
  for (let b = 0; b < NBINS; b++) activeBins += mask[b];

  // Giới hạn dy để overlap không quá nhỏ: dy lớn ⇒ overlap bé ⇒ NCC nhiễu, cho
  // đỉnh GIẢ rất cao (đây chính là lỗi bestDy≈700). Một tick cuộn tay không vượt
  // quá nửa khung nên chặn ở span/2 và đảm bảo overlap ≥ MIN_OVERLAP dòng.
  const maxDy = Math.min(span - MIN_OVERLAP, Math.floor(span * MAX_SCROLL_FRAC));
  if (maxDy < MIN_DY) return { dy: 0, topFixed, botFixed, span, changedFrac };

  const scores = new Float32Array(maxDy + 1);
  let bestNcc = -1;
  let bestDy = 0;
  for (let dy = MIN_DY; dy <= maxDy; dy++) {
    const ncc = shiftNCC(profP, profC, scrollTop, scrollBottom, dy, mask, activeBins);
    scores[dy] = ncc;
    if (ncc > bestNcc) {
      bestNcc = ncc;
      bestDy = dy;
    }
  }
  // 4) Chọn dy. Biên dạng binned đã đủ phân biệt nên TIN vào đỉnh NCC thay vì so
  //    pixel chặt (vốn từ chối nhầm khi cuộn mượt/răng cưa). Trong số các dy có
  //    NCC sát đỉnh (≤ NEAR), ưu tiên dy NHỎ NHẤT: vừa chống đỉnh nhiễu ở dy lớn,
  //    vừa chọn chu kỳ cơ bản khi bảng có nhiều dòng cao đều nhau.
  if (bestNcc < NCC_ACCEPT) {
    return { dy: -1, topFixed, botFixed, ncc: bestNcc, bestDy, span, changedFrac, activeBins };
  }
  const NEAR = 0.03;
  let dy = bestDy;
  for (let d2 = MIN_DY; d2 < bestDy; d2++) {
    if (scores[d2] >= bestNcc - NEAR) {
      dy = d2;
      break;
    }
  }
  return { dy, topFixed, botFixed, ncc: bestNcc, bestDy, span, changedFrac, activeBins };
}

export default function ScrollControl() {
  const { t } = useTranslation();
  // Bắt đầu thẳng ở trạng thái "capturing": vẽ xong khung là tự động chụp, nút
  // "Hoàn thành" hiện ngay (không cần nhấn "Bắt đầu").
  const [status, setStatus] = useState<"ready" | "capturing" | "processing">("capturing");
  const [frameCount, setFrameCount] = useState(0);
  const [stitchedHeight, setStitchedHeight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Cảnh báo cuộn quá nhanh: khi không khớp được (dy=-1) mà nội dung lại đổi
  // nhiều (đang cuộn thật) → đã vượt tầm chồng lấn → có thể bỏ sót nội dung.
  const [fastWarn, setFastWarn] = useState(false);
  const fastWarnRef = useRef(false);
  // Chẩn đoán hiển thị ngay trên panel (không cần devtools): cho biết vì sao
  // 1 frame bị bỏ. Tắt bằng cách đặt DEBUG = false.
  const [dbg, setDbg] = useState<string>("");
  // Log tích luỹ mọi tick để người dùng copy gửi lại (giữ tối đa MAX_LOG dòng).
  const [logText, setLogText] = useState<string>("");
  const logRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const [copied, setCopied] = useState(false);

  // Master canvas dùng "capacity doubling": vùng nhớ (capacity) cao hơn nội
  // dung thực (usedHeight) để KHÔNG phải tạo canvas mới + copy lại toàn bộ ảnh
  // mỗi khung hình (tránh O(n²) copy). Canvas được gắn thẳng vào DOM để xem
  // trước, nên KHÔNG cần encode PNG (toDataURL) mỗi tick nữa — đây là điểm tốn
  // kém nhất của bản cũ.
  const masterRef = useRef<HTMLCanvasElement | null>(null);
  const masterCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const usedHeightRef = useRef(0);
  const frameWidthRef = useRef(0);
  const prevImageDataRef = useRef<ImageData | null>(null);
  const instructionsRef = useRef<{ sliceIndex: number; srcY: number; srcH: number }[]>([]);
  const totalSlicesRef = useRef(0);

  const isCapturingRef = useRef(false);
  const tickBusyRef = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const startedRef = useRef(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const cropWrapperRef = useRef<HTMLDivElement | null>(null);

  // Phím tắt bắt đầu / hoàn thành / huỷ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        ipc.closeSelf();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (status === "ready") {
          startCapture();
        } else if (status === "capturing") {
          finishCapture();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  // Bảo đảm master canvas đủ chỗ cho `neededHeight` dòng. Chỉ tạo canvas mới +
  // copy lại khi thật sự hết chỗ (nhân đôi dung lượng) → amortized O(n) thay vì
  // tạo + copy toàn bộ mỗi frame như bản cũ (O(n²)).
  const ensureCapacity = (neededHeight: number, width: number) => {
    const current = masterRef.current;
    if (current && current.width === width && current.height >= neededHeight) {
      return;
    }
    const newCapacity = Math.max(
      neededHeight,
      current ? current.height * 2 : neededHeight,
    );
    const next = document.createElement("canvas");
    next.width = width;
    next.height = newCapacity;
    const ctx = next.getContext("2d");
    if (!ctx) return;
    if (current) ctx.drawImage(current, 0, 0);

    masterRef.current = next;
    masterCtxRef.current = ctx;

    // Gắn (hoặc thay) canvas vào DOM để hiển thị trực tiếp, không encode PNG.
    const host = cropWrapperRef.current;
    if (host) {
      next.style.position = "absolute";
      next.style.top = "0";
      next.style.left = "0";
      next.style.width = "100%";
      next.style.display = "block";
      host.replaceChildren(next);
    }
  };

  // Cắt vùng hiển thị theo nội dung thực (ẩn phần capacity dư) và tự cuộn theo
  // ảnh ghép để tiện theo dõi. Chỉ bám đáy khi người dùng ĐANG ở gần đáy — nếu
  // họ chủ động cuộn lên xem lại thì không bị kéo xuống.
  const updatePreview = () => {
    const host = cropWrapperRef.current;
    const cont = scrollContainerRef.current;
    const fw = frameWidthRef.current;

    // Đo trạng thái cuộn TRƯỚC khi đổi chiều cao (dựa trên nội dung cũ).
    const stickToBottom = cont
      ? cont.scrollHeight - cont.scrollTop - cont.clientHeight < 48
      : true;

    if (host && fw > 0) {
      const contentWidth = host.clientWidth || cont?.clientWidth || fw;
      const scale = contentWidth / fw;
      host.style.height = `${Math.round(usedHeightRef.current * scale)}px`;
    }
    if (cont && stickToBottom) cont.scrollTop = cont.scrollHeight;
  };

  const captureTick = async () => {
    // tickBusyRef chống chồng lấn: nếu 1 tick xử lý lâu hơn 220ms thì tick kế
    // tiếp bị bỏ qua thay vì xếp chồng (gây giật + trùng frame).
    if (!isCapturingRef.current || tickBusyRef.current) return;
    tickBusyRef.current = true;
    try {
      const base64 = await ipc.captureScrollSlice(mx, my, rx, ry, rw, rh);
      if (!base64 || !isCapturingRef.current) return;

      const sliceIdx = totalSlicesRef.current;
      totalSlicesRef.current++;

      const img = await loadImage(`data:image/png;base64,${base64}`, t);
      const fw = img.naturalWidth;
      const fh = img.naturalHeight;

      // Lấy ImageData của frame mới để so khớp.
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = fw;
      tempCanvas.height = fh;
      const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
      if (!tempCtx) return;
      tempCtx.drawImage(img, 0, 0);
      const newImgData = tempCtx.getImageData(0, 0, fw, fh);

      if (!masterRef.current || !prevImageDataRef.current) {
        // Frame đầu tiên.
        frameWidthRef.current = fw;
        ensureCapacity(fh, fw);
        masterCtxRef.current?.drawImage(img, 0, 0);
        usedHeightRef.current = fh;
        prevImageDataRef.current = newImgData;
        instructionsRef.current = [
          { sliceIndex: sliceIdx, srcY: 0, srcH: fh }
        ];
        setStitchedHeight(fh);
        setFrameCount(1);
        updatePreview();
        return;
      }

      // Các frame tiếp theo: phân tích cuộn + dải cố định.
      const an = analyzeScroll(prevImageDataRef.current, newImgData);
      const { dy, botFixed } = an;

      // Cảnh báo cuộn quá nhanh: dy=-1 (không khớp được) + nội dung đổi nhiều
      // (đang cuộn thật, không phải tới đáy trang) ⇒ đã vượt tầm chồng lấn, có thể
      // bỏ sót. Tắt cảnh báo ngay khi nối được hoặc dừng cuộn.
      const fast = dy === -1 && (an.changedFrac ?? 0) >= FAST_DIFF;
      if (fast !== fastWarnRef.current) {
        fastWarnRef.current = fast;
        setFastWarn(fast);
      }

      if (DEBUG) {
        const ncc = an.ncc === undefined ? "—" : an.ncc.toFixed(2);
        const diff = an.changedFrac === undefined ? "—" : `${Math.round(an.changedFrac * 100)}%`;
        const act = dy > 0 ? "APPEND" : dy === 0 ? "skip0" : "skip-1";
        seqRef.current++;
        const line = `#${seqRef.current} ${act} dy=${dy} diff=${diff} ncc=${ncc} bestDy=${an.bestDy ?? "—"} bins=${an.activeBins ?? "—"} top=${an.topFixed} bot=${an.botFixed} span=${an.span ?? "—"} fh=${fh}`;
        setDbg(line);
        const buf = logRef.current;
        buf.push(line);
        if (buf.length > 400) buf.splice(0, buf.length - 400);
        setLogText(buf.join("\n"));
      }

      if (dy > 0) {
        // Có cuộn THẬT. Chỉ NỐI đúng dy dòng nội dung mới vừa lộ ra ở đáy vùng
        // cuộn (ngay trên footer dính nếu có) — KHÔNG vẽ lại header/footer dính
        // nên không bị lặp/chồng chéo.
        const srcY = fh - botFixed - dy; // đáy vùng cuộn, lùi lên dy dòng
        const at = usedHeightRef.current;
        ensureCapacity(at + dy, fw);
        masterCtxRef.current?.drawImage(img, 0, srcY, fw, dy, 0, at, fw, dy);
        usedHeightRef.current = at + dy;
        prevImageDataRef.current = newImgData;
        instructionsRef.current.push({
          sliceIndex: sliceIdx,
          srcY,
          srcH: dy
        });
        setStitchedHeight(usedHeightRef.current);
        setFrameCount((prev) => prev + 1);
        updatePreview();
      } else {
        // dy === 0 (không cuộn / trang đứng yên) hoặc dy === -1 (không khớp được,
        // ví dụ cuộn > 1 màn hình mỗi tick): KHÔNG nối để tránh lặp/đứt đoạn,
        // chỉ cập nhật khung tham chiếu cho lần sau.
        prevImageDataRef.current = newImgData;
      }
    } catch (err) {
      console.error(t("scroll.captureSliceError"), err);
      // Lỗi thật (vd chạm giới hạn số lát) phải dừng vòng lặp + hiện cho user
      // thấy — trước đây chỉ log console, user thấy "đang ghi..." mãi không rõ vì sao.
      isCapturingRef.current = false;
      setError(String(err));
    } finally {
      tickBusyRef.current = false;
    }
  };

  const stopLoop = () => {
    isCapturingRef.current = false;
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const startCapture = async () => {
    setStatus("capturing");
    isCapturingRef.current = true;
    setError(null);
    instructionsRef.current = [];
    totalSlicesRef.current = 0;
    await ipc.startScrollSession().catch(console.error);

    // Chụp lát cắt đầu tiên ngay lập tức.
    await captureTick();

    // Vòng lặp chụp mỗi 220ms.
    intervalRef.current = window.setInterval(() => {
      if (!isCapturingRef.current) {
        stopLoop();
        return;
      }
      void captureTick();
    }, 220);
  };

  // Tự động bắt đầu chụp ngay khi cửa sổ mở (vẽ xong khung). startedRef chống
  // gọi 2 lần do StrictMode double-invoke effect ở chế độ dev. Cleanup gọi
  // stopLoop: unmount giữa chừng (cửa sổ bị đóng ngoài các đường
  // finish/cancel) không được để interval sống tiếp — timer rò + setState
  // sau unmount.
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      void startCapture();
    }
    return () => stopLoop();
  }, []);

  const finishCapture = async () => {
    stopLoop();

    // Dùng ref (luôn cập nhật) thay vì state frameCount — tránh stale closure
    // khi gọi từ handler bàn phím (effect bắt phím chỉ re-subscribe theo status).
    if (usedHeightRef.current === 0) {
      ipc.closeSelf();
      return;
    }

    setStatus("processing");
    try {
      const w = frameWidthRef.current;
      await ipc.finalizeScrollStitch(w, instructionsRef.current);
      ipc.closeSelf();
    } catch (err) {
      setError(String(err));
      setStatus("capturing");
    }
  };

  return (
    <div style={panel} data-tauri-drag-region>
      {/* Header */}
      <div style={header} data-tauri-drag-region>
        <div style={status === "capturing" ? pulseDot : inactiveDot} />
        <span style={title} data-tauri-drag-region>{t("scroll.title")}</span>
      </div>

      {/* Slices Counter / Status */}
      <div style={statusRow} data-tauri-drag-region>
        {status === "ready" && <span style={statusText}>{t("scroll.readyCapture")}</span>}
        {status === "capturing" && (
          <span style={fastWarn ? statusWarn : statusText}>
            {fastWarn
              ? t("scroll.scrollWarning")
              : t("scroll.recording")}
          </span>
        )}
        {status === "processing" && <span style={statusText}>{t("scroll.rendering")}</span>}
      </div>

      {/* Info Stats */}
      {status !== "ready" && (
        <div style={statsRow} data-tauri-drag-region>
          <span>{t("scroll.frameCount")} {frameCount}</span>
          <span>·</span>
          <span>{t("scroll.height")} {stitchedHeight}px</span>
        </div>
      )}

      {DEBUG && status !== "ready" && dbg && (
        <div style={debugRow}>{dbg}</div>
      )}

      {DEBUG && status !== "ready" && (
        <div style={logBox}>
          <div style={logHeader}>
            <span>{t("scroll.diagnosticLog")} ({logRef.current.length})</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                style={logBtn}
                onClick={async () => {
                  const text = logRef.current.join("\n");
                  try {
                    await navigator.clipboard.writeText(text);
                  } catch {
                    /* fallback: bôi đen ô bên dưới rồi Ctrl/Cmd+C */
                  }
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? t("scroll.copied") : t("scroll.copy")}
              </button>
              <button
                style={logBtn}
                onClick={() => {
                  logRef.current = [];
                  seqRef.current = 0;
                  setLogText("");
                }}
              >
                {t("scroll.clear")}
              </button>
            </div>
          </div>
          <textarea readOnly style={logArea} value={logText} />
        </div>
      )}

      {/* Preview: canvas gắn thẳng vào DOM, cắt theo usedHeight — không encode PNG mỗi frame.
          LUÔN mount scrollContainer/cropWrapper để ref sẵn sàng trước khi chụp
          (startCapture gọi captureTick ngay, trước khi React kịp mount). */}
      <div style={previewBox}>
        <div ref={scrollContainerRef} style={scrollList}>
          <div ref={cropWrapperRef} style={cropWrapper} />
        </div>
        {status === "ready" && (
          <div style={emptyOverlay} data-tauri-drag-region>
            {t("scroll.startMessage")}
          </div>
        )}
      </div>

      {error && <div style={errorBox}>{error}</div>}

      {/* Actions */}
      <div style={actionRow}>
        {status === "ready" && (
          <button
            onClick={startCapture}
            style={startBtn}
            onMouseOver={(e) => Object.assign(e.currentTarget.style, startBtnHover)}
            onMouseOut={(e) => Object.assign(e.currentTarget.style, startBtn)}
          >
            {t("scroll.startButton")}
          </button>
        )}

        {status === "capturing" && (
          <button
            onClick={finishCapture}
            style={finishBtn}
            onMouseOver={(e) => Object.assign(e.currentTarget.style, finishBtnHover)}
            onMouseOut={(e) => Object.assign(e.currentTarget.style, finishBtn)}
          >
            {t("scroll.finishButton")}
          </button>
        )}

        {status === "processing" && (
          <button disabled style={processingBtn}>
            {t("scroll.processingButton")}
          </button>
        )}

        <button
          onClick={() => {
            stopLoop();
            ipc.closeSelf();
          }}
          disabled={status === "processing"}
          style={cancelBtn}
          onMouseOver={(e) => Object.assign(e.currentTarget.style, cancelBtnHover)}
          onMouseOut={(e) => Object.assign(e.currentTarget.style, cancelBtn)}
        >
          {t("scroll.cancelButton")}
        </button>
      </div>
    </div>
  );
}

/* ── Panel Styles ── */
const panel: React.CSSProperties = {
  height: "100%",
  boxSizing: "border-box",
  background: "rgba(22, 22, 28, 0.88)",
  backdropFilter: "blur(20px)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 16,
  padding: "16px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  color: "#f8fafc",
  fontFamily: "Inter, system-ui, sans-serif",
  boxShadow: "0 24px 48px rgba(0,0,0,0.5)",
  overflow: "hidden",
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const pulseDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#ef4444",
  boxShadow: "0 0 12px #ef4444",
  animation: "pulse 1.8s infinite alternate",
};

const inactiveDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#64748b",
};

const title: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const statusRow: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: "#f1f5f9",
};

const statusText: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.3,
};

const statusWarn: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.3,
  color: "#fbbf24",
};

const statsRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  fontSize: 11,
  color: "#94a3b8",
};

const debugRow: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "ui-monospace, Menlo, monospace",
  color: "#fbbf24",
  background: "rgba(0,0,0,0.35)",
  borderRadius: 6,
  padding: "4px 6px",
  wordBreak: "break-all",
};

const logBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const logHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 10,
  color: "#94a3b8",
};

const logBtn: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.08)",
  color: "#e2e8f0",
  cursor: "pointer",
};

const logArea: React.CSSProperties = {
  width: "100%",
  height: 90,
  resize: "vertical",
  fontSize: 10,
  lineHeight: 1.35,
  fontFamily: "ui-monospace, Menlo, monospace",
  color: "#cbd5e1",
  background: "rgba(0,0,0,0.45)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 6,
  padding: 6,
  boxSizing: "border-box",
  whiteSpace: "pre",
};

const previewBox: React.CSSProperties = {
  flex: 1,
  position: "relative",
  background: "rgba(0, 0, 0, 0.25)",
  border: "1px solid rgba(255, 255, 255, 0.05)",
  borderRadius: 10,
  minHeight: 120,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const emptyOverlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  color: "#64748b",
  textAlign: "center",
  padding: 12,
  lineHeight: 1.4,
};

const scrollList: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 6,
  display: "flex",
  flexDirection: "column",
  background: "repeating-conic-gradient(#1e1e24 0% 25%, #16161c 0% 50%) 50%/12px 12px",
};

const cropWrapper: React.CSSProperties = {
  position: "relative",
  width: "100%",
  // KHÔNG để flexbox của scrollList co lại — nếu co, chiều cao đặt động bị bóp
  // vừa khung nên container không tràn để cuộn được.
  flexShrink: 0,
  overflow: "hidden",
  borderRadius: 4,
};

const errorBox: React.CSSProperties = {
  fontSize: 11,
  color: "#fca5a5",
  background: "rgba(239, 68, 68, 0.1)",
  border: "1px solid rgba(239, 68, 68, 0.2)",
  borderRadius: 6,
  padding: 8,
};

const actionRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const startBtn: React.CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: "none",
  background: "linear-gradient(135deg, #10b981, #059669)",
  color: "#ffffff",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  boxShadow: "0 4px 12px rgba(16, 185, 129, 0.25)",
  transition: "all 0.15s ease",
};

const startBtnHover: React.CSSProperties = {
  background: "linear-gradient(135deg, #34d399, #059669)",
  transform: "translateY(-1px)",
  boxShadow: "0 6px 16px rgba(16, 185, 129, 0.35)",
};

const finishBtn: React.CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: "none",
  background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
  color: "#ffffff",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  boxShadow: "0 4px 12px rgba(59, 130, 246, 0.3)",
  transition: "all 0.15s ease",
};

const finishBtnHover: React.CSSProperties = {
  background: "linear-gradient(135deg, #60a5fa, #2563eb)",
  transform: "translateY(-1px)",
  boxShadow: "0 6px 16px rgba(59, 130, 246, 0.4)",
};

const processingBtn: React.CSSProperties = {
  width: "100%",
  height: 38,
  borderRadius: 8,
  border: "none",
  background: "rgba(255, 255, 255, 0.1)",
  color: "#64748b",
  fontWeight: 600,
  fontSize: 13,
  cursor: "not-allowed",
};

const cancelBtn: React.CSSProperties = {
  width: "100%",
  height: 32,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.06)",
  background: "rgba(255, 255, 255, 0.05)",
  color: "#94a3b8",
  fontWeight: 600,
  fontSize: 12,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const cancelBtnHover: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.1)",
  color: "#cbd5e1",
};
