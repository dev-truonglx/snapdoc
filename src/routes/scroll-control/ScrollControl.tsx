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

function toSafeImageUrl(src: string): { url: string; revoke?: () => void } {
  if (!src) return { url: "" };
  if (src.startsWith("data:") && src.length > 200_000) {
    try {
      const commaIdx = src.indexOf(",");
      if (commaIdx !== -1) {
        const meta = src.slice(0, commaIdx);
        const rawBase64 = src.slice(commaIdx + 1);
        const mimeMatch = meta.match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : "image/png";
        const byteChars = atob(rawBase64);
        const byteNumbers = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteNumbers[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteNumbers], { type: mime });
        const blobUrl = URL.createObjectURL(blob);
        return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
      }
    } catch (e) {
      console.error("Lỗi chuyển đổi Blob URL:", e);
    }
  }
  return { url: src };
}

function loadImage(src: string, t: any): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const safe = toSafeImageUrl(src);
    const img = new Image();
    img.onload = () => {
      safe.revoke?.();
      resolve(img);
    };
    img.onerror = () => {
      safe.revoke?.();
      reject(new Error(t("scroll.imageLoadError")));
    };
    img.src = safe.url;
  });
}

const COLOR_TOL = 16; // sai khác màu cho phép mỗi kênh (hỗ trợ tốt hơn cho ClearType trên Windows)
const SCROLLBAR_MARGIN = 25; // bỏ lề phải tránh thanh cuộn
const SAMPLE_STEP = 2; // bước lấy mẫu pixel theo chiều ngang (dày để bắt chính xác từng điểm ảnh)
const BG_SAMPLE_STEP = 8; // bước lấy mẫu khi ước lượng màu nền của dòng
const BG_DEV = 16; // độ lệch sáng so với nền để coi 1 điểm là "có nội dung"
const SAME_RATIO = 0.9; // tỉ lệ khớp (trên điểm nội dung) để coi 2 dòng "y hệt" (vùng cố định)
const PROFILE_STEP = 3; // bước lấy mẫu x khi tính biên dạng cạnh ngang
const MIN_DY = 2; // bỏ qua dịch chuyển quá nhỏ (nhận diện được cả cuộn mượt 2px)
const MIN_OVERLAP = 36; // số dòng chồng lấn tối thiểu để NCC đáng tin (mở rộng khả năng bắt cuộn dài)
const MAX_SCROLL_FRAC = 0.88; // dy tối đa = 88% vùng cuộn (tương thích chuột lăn Windows & HiDPI)
const NBINS = 16; // số ô ngang của biên dạng cạnh (tăng độ mịn để nhận diện tốt lưới sản phẩm)
const NCC_ACCEPT = 0.52; // NCC tại đỉnh ≥ ngưỡng này thì đưa vào so khớp 2D tinh chỉnh
const CHANGE_TOL = 16; // độ lệch sáng để coi 1 điểm là "đã đổi" giữa 2 khung
const FIXED_FG_FRAC = 0.05; // mật độ nội dung tối thiểu để 1 ô được xét là cột cố định
const FIXED_CHANGE_MAX = 0.2; // tỉ lệ nội dung thay đổi tối đa để coi ô là CỐ ĐỊNH (sidebar dính)
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

// So 2 dòng theo mẫu, nhưng TÁCH RIÊNG điểm nội dung khỏi nền.
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

// Đánh giá tỉ lệ sai khác pixel nhanh giữa 2 frame liên tiếp (để phát hiện trạng thái đứng yên)
function computeDiffFrac(d1: ImageData, d2: ImageData): number {
  if (d1.width !== d2.width || d1.height !== d2.height) return 1.0;
  const p = d1.data;
  const c = d2.data;
  const w = d1.width;
  const h = d1.height;
  const stride = w * 4;
  let sampled = 0;
  let changed = 0;
  for (let y = 0; y < h; y += 6) {
    const row = y * stride;
    for (let x = 0; x < w; x += 12) {
      const i = row + x * 4;
      if (
        Math.abs(p[i] - c[i]) > COLOR_TOL ||
        Math.abs(p[i + 1] - c[i + 1]) > COLOR_TOL ||
        Math.abs(p[i + 2] - c[i + 2]) > COLOR_TOL
      ) {
        changed++;
      }
      sampled++;
    }
  }
  return sampled === 0 ? 0 : changed / sampled;
}

// Biên dạng cạnh ngang CHIA Ô (binned): với mỗi dòng y, năng lượng cạnh dọc
// (|Δsáng| so với dòng trên) được gom vào NBINS ô theo bề ngang.
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

// Mặt nạ ô "đang cuộn": phát hiện CỘT CỐ ĐỊNH (sidebar/panel dính) để loại khỏi NCC.
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
  if (active === 0) mask.fill(1);
  return mask;
}

// Tương quan chuẩn hoá (NCC) giữa biên dạng binned của prev và cur khi nội dung dịch LÊN dy px.
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
  if (nRows < MIN_OVERLAP || activeBins === 0) return -1;
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

// Xác thực 2D tinh chỉnh (Fine 2D Validation)
function validateCandidateDy(
  p: Uint8ClampedArray,
  c: Uint8ClampedArray,
  bgP: Float32Array,
  bgC: Float32Array,
  w: number,
  _h: number,
  scrollTop: number,
  scrollBottom: number,
  candidates: number[],
  stride: number,
  vEst: number,
  _span: number,
): number {
  if (candidates.length === 1) return candidates[0];

  const minDy = candidates[0];
  const sampleY0 = scrollTop + minDy;
  const sampleY1 = scrollBottom;
  const testRows: number[] = [];
  const step = Math.max(1, Math.floor((sampleY1 - sampleY0) / 32));

  for (let y = sampleY0; y < sampleY1; y += step) {
    testRows.push(y);
    if (testRows.length >= 32) break;
  }

  if (testRows.length === 0) return candidates[0];

  let bestCand = candidates[0];
  let bestScore = -1;

  for (const cand of candidates) {
    let totalContent = 0;
    let matchedContent = 0;

    for (const yp of testRows) {
      const yc = yp - cand;
      if (yc < scrollTop || yc >= scrollBottom) continue;
      const offP = yp * stride;
      const offC = yc * stride;
      const cmp = rowCompare(p, offP, bgP[yp], c, offC, bgC[yc], w);
      totalContent += cmp.content;
      matchedContent += cmp.contentRatio * cmp.content;
    }

    const matchRatio = totalContent > 0 ? matchedContent / totalContent : 0;
    // Điểm cộng quán tính cuộn (vEst): Ưu tiên ứng cử viên tiệm cận với tốc độ cuộn mượt hiện tại
    const velDiff = vEst > 0 ? Math.abs(cand - vEst) : 0;
    const velBonus = vEst > 0 ? (1 - Math.min(1, velDiff / Math.max(vEst * 1.5, 40))) * 0.15 : 0;
    const finalScore = matchRatio + velBonus;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestCand = cand;
    }
  }

  return bestCand;
}

// Tinh chỉnh vi mô ±2px dựa trên tổng sai số tuyệt đối (SAD) của tất cả các dòng pixel thực tế
function refineDyLocal(
  p: Uint8ClampedArray,
  c: Uint8ClampedArray,
  w: number,
  scrollTop: number,
  scrollBottom: number,
  initialDy: number,
  maxDy: number,
  stride: number,
): number {
  if (initialDy < MIN_DY) return initialDy;

  const rMin = Math.max(MIN_DY, initialDy - 2);
  const rMax = Math.min(maxDy, initialDy + 2);
  if (rMin >= rMax) return initialDy;

  let bestDy = initialDy;
  let minSad = Infinity;

  const sampleY0 = scrollTop + rMax;
  const sampleY1 = scrollBottom;
  const step = Math.max(1, Math.floor((sampleY1 - sampleY0) / 64));

  for (let cand = rMin; cand <= rMax; cand++) {
    let sad = 0;
    let count = 0;
    for (let yp = sampleY0; yp < sampleY1; yp += step) {
      const yc = yp - cand;
      if (yc < scrollTop || yc >= scrollBottom) continue;
      const offP = yp * stride;
      const offC = yc * stride;
      for (let x = 0; x < w - SCROLLBAR_MARGIN; x += SAMPLE_STEP) {
        const iP = offP + x * 4;
        const iC = offC + x * 4;
        const diff = Math.abs(p[iP] - c[iC]) + Math.abs(p[iP + 1] - c[iC + 1]) + Math.abs(p[iP + 2] - c[iC + 2]);
        // Tăng trọng số x3 cho các pixel cạnh/chữ/số (đặc trưng cấu trúc cố định) để khoá vị trí chính xác
        const edgeP = x + SAMPLE_STEP < w - SCROLLBAR_MARGIN ? Math.abs(lumAt(p, iP) - lumAt(p, iP + SAMPLE_STEP * 4)) : 0;
        const weight = edgeP > 15 ? 3 : 1;
        sad += diff * weight;
        count += weight;
      }
    }
    const avgSad = count > 0 ? sad / count : Infinity;
    if (avgSad < minSad) {
      minSad = avgSad;
      bestDy = cand;
    }
  }

  return bestDy;
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

// Phân tích 2 khung liên tiếp
function analyzeScroll(prev: ImageData, cur: ImageData, vEst: number = 0, forceTopFixed: number = 0): ScrollAnalysis {
  const w = prev.width;
  const h = prev.height;
  const stride = w * 4;
  const p = prev.data;
  const c = cur.data;
  const maxBand = Math.floor(h * 0.4);

  const bgP = new Float32Array(h);
  const bgC = new Float32Array(h);
  for (let yy = 0; yy < h; yy++) {
    bgP[yy] = rowBgLum(p, yy * stride, w);
    bgC[yy] = rowBgLum(c, yy * stride, w);
  }

  const sameInPlace = (y: number): boolean => {
    const off = y * stride;
    const cmp = rowCompare(p, off, bgP[y], c, off, bgC[y], w);
    return cmp.content >= 2 ? cmp.contentRatio >= SAME_RATIO : cmp.ratio >= SAME_RATIO;
  };

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
  if (forceTopFixed > 0) {
    topFixed = Math.max(topFixed, forceTopFixed);
  }
  let botFixed = 0;
  while (botFixed < maxBand && sameInPlace(h - 1 - botFixed)) botFixed++;

  if (h - topFixed - botFixed < h * 0.25) {
    topFixed = 0;
    botFixed = 0;
  }

  const scrollTop = topFixed;
  const scrollBottom = h - botFixed;
  const span = scrollBottom - scrollTop;

  if (changedFrac < 0.02 || span < 24) {
    return { dy: 0, topFixed, botFixed, span, changedFrac };
  }

  // 3) Ước lượng dy bằng TƯƠNG QUAN BIÊN DẠNG CẠNH (Edge Profile Correlation)
  const profP = edgeProfileBinned(p, w, h, stride);
  const profC = edgeProfileBinned(c, w, h, stride);

  const mask = activeBinMask(p, c, bgP, bgC, w, h, stride);
  let activeBins = 0;
  for (let b = 0; b < NBINS; b++) activeBins += mask[b];

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

  if (bestNcc < NCC_ACCEPT) {
    return { dy: -1, topFixed, botFixed, ncc: bestNcc, bestDy, span, changedFrac, activeBins };
  }

  const NEAR = 0.06;
  const candidates: number[] = [];
  for (let d2 = MIN_DY; d2 <= maxDy; d2++) {
    if (scores[d2] >= bestNcc - NEAR) {
      candidates.push(d2);
    }
  }

  // Luôn gọi xác thực 2D pixel (validateCandidateDy) nếu có nhiều hơn 1 ứng cử viên
  const finalDy =
    candidates.length <= 1
      ? bestDy
      : validateCandidateDy(
          p,
          c,
          bgP,
          bgC,
          w,
          h,
          scrollTop,
          scrollBottom,
          candidates,
          stride,
          vEst,
          span,
        );

  // Tinh chỉnh vi mô ±2px dựa trên tổng sai số tuyệt đối (SAD) để triệt tiêu vệt gạch ngang 1-2px
  const refinedDy = refineDyLocal(
    p,
    c,
    w,
    scrollTop,
    scrollBottom,
    finalDy,
    maxDy,
    stride,
  );

  return { dy: refinedDy, topFixed, botFixed, ncc: bestNcc, bestDy, span, changedFrac, activeBins };
}

interface FrameHistoryItem {
  imgData: ImageData;
  img: HTMLImageElement;
  sliceIdx: number;
  botFixed: number;
  usedHeightAtFrame: number;
}

export default function ScrollControl() {
  const { t } = useTranslation();
  // Bắt đầu thẳng ở trạng thái "capturing": vẽ xong khung là tự động chụp
  const [status, setStatus] = useState<"ready" | "capturing" | "processing">("capturing");
  const [frameCount, setFrameCount] = useState(0);
  const [stitchedHeight, setStitchedHeight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Cảnh báo cuộn quá nhanh
  const [fastWarn, setFastWarn] = useState(false);
  const fastWarnRef = useRef(false);
  // Mất dấu nối (để hỗ trợ nút nối tiếp nếu muốn bỏ qua khoảng trống)
  const [lostTracking, setLostTracking] = useState(false);
  const lostTrackingRef = useRef(false);
  const lastRawImgDataRef = useRef<ImageData | null>(null);
  const latestRawFrameRef = useRef<{ img: HTMLImageElement; imgData: ImageData; sliceIdx: number } | null>(null);

  // Chẩn đoán hiển thị ngay trên panel
  const [dbg, setDbg] = useState<string>("");
  const [logText, setLogText] = useState<string>("");
  const logRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const [copied, setCopied] = useState(false);

  // Master canvas dùng "capacity doubling"
  const masterRef = useRef<HTMLCanvasElement | null>(null);
  const masterCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const usedHeightRef = useRef(0);
  const frameWidthRef = useRef(0);

  // Bộ đệm lịch sử tham chiếu đa khung hình (Multi-Frame Reference History)
  const recentFramesRef = useRef<FrameHistoryItem[]>([]);
  // Vận tốc cuộn ước tính (px/tick) để hỗ trợ phân biệt chu kỳ bảng biểu
  const velocityRef = useRef(0);

  const instructionsRef = useRef<{ sliceIndex: number; srcY: number; srcH: number }[]>([]);
  const totalSlicesRef = useRef(0);

  const isCapturingRef = useRef(false);
  const tickBusyRef = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const startedRef = useRef(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const cropWrapperRef = useRef<HTMLDivElement | null>(null);

  const cleanupMemory = () => {
    stopLoop();
    if (masterRef.current) {
      masterRef.current.width = 0;
      masterRef.current.height = 0;
      masterRef.current = null;
      masterCtxRef.current = null;
    }
    if (cropWrapperRef.current) {
      cropWrapperRef.current.replaceChildren();
    }
    recentFramesRef.current = [];
    lastRawImgDataRef.current = null;
    latestRawFrameRef.current = null;
    instructionsRef.current = [];
  };

  // Phím tắt bắt đầu / hoàn thành / huỷ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cleanupMemory();
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

  // Bảo đảm master canvas đủ chỗ cho `neededHeight` dòng
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

    // Gắn canvas vào DOM để hiển thị trực tiếp
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

  // Cắt vùng hiển thị theo nội dung thực
  const updatePreview = () => {
    const host = cropWrapperRef.current;
    const cont = scrollContainerRef.current;
    const fw = frameWidthRef.current;

    const stickToBottom = cont
      ? cont.scrollHeight - cont.scrollTop - cont.clientHeight < 48
      : true;

    if (host && fw > 0) {
      const contentWidth = host.clientWidth || cont?.clientWidth || fw;
      const scale = contentWidth / fw;
      host.style.height = `${Math.round(usedHeightRef.current * scale)}px`;
    }
    if (cont && stickToBottom) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
      });
    }
  };

  // Nối tiếp từ vị trí hiện tại nếu người dùng chủ động bỏ qua khoảng nhảy
  const handleBridgeCurrentFrame = async () => {
    const raw = latestRawFrameRef.current;
    if (!raw || !masterRef.current) return;
    const { img, imgData, sliceIdx } = raw;
    const fw = img.naturalWidth;
    const fh = img.naturalHeight;

    const at = usedHeightRef.current;
    ensureCapacity(at + fh, fw);
    masterCtxRef.current?.drawImage(img, 0, 0, fw, fh, 0, at, fw, fh);
    usedHeightRef.current = at + fh;

    instructionsRef.current.push({
      sliceIndex: sliceIdx,
      srcY: 0,
      srcH: fh,
    });

    await ipc.commitScrollSlice(sliceIdx).catch(console.error);

    recentFramesRef.current = [
      {
        imgData,
        img,
        sliceIdx,
        botFixed: 0,
        usedHeightAtFrame: usedHeightRef.current,
      }
    ];

    setFastWarn(false);
    fastWarnRef.current = false;
    setLostTracking(false);
    lostTrackingRef.current = false;
    velocityRef.current = 0;

    setStitchedHeight(usedHeightRef.current);
    setFrameCount((prev) => prev + 1);
    updatePreview();
  };

  const captureTick = async () => {
    // tickBusyRef chống xếp chồng: nếu 1 tick xử lý lâu thì tick kế tiếp bị bỏ qua
    if (!isCapturingRef.current || tickBusyRef.current) return;
    tickBusyRef.current = true;
    try {
      const res = await ipc.captureScrollSlice(mx, my, rx, ry, rw, rh);
      if (!res || !res.base64 || !isCapturingRef.current) return;

      const { sliceIndex, base64 } = res;
      totalSlicesRef.current++;

      const img = await loadImage(`data:image/png;base64,${base64}`, t);
      const fw = img.naturalWidth;
      const fh = img.naturalHeight;

      // Lấy ImageData của frame mới để so khớp
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = fw;
      tempCanvas.height = fh;
      const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
      if (!tempCtx) return;
      tempCtx.drawImage(img, 0, 0);
      const newImgData = tempCtx.getImageData(0, 0, fw, fh);

      latestRawFrameRef.current = { img, imgData: newImgData, sliceIdx: sliceIndex };

      // Đánh giá chuyển động giữa 2 nhịp chụp liên tiếp (120ms)
      const tickDiff = lastRawImgDataRef.current
        ? computeDiffFrac(lastRawImgDataRef.current, newImgData)
        : 1.0;
      lastRawImgDataRef.current = newImgData;

      const isStationary = tickDiff < 0.015;

      const history = recentFramesRef.current;

      if (!masterRef.current || history.length === 0) {
        // Frame đầu tiên của phiên chụp
        frameWidthRef.current = fw;
        ensureCapacity(fh, fw);
        masterCtxRef.current?.drawImage(img, 0, 0);
        usedHeightRef.current = fh;

        instructionsRef.current = [
          { sliceIndex, srcY: 0, srcH: fh }
        ];

        // Xác nhận lát cắt đầu tiên vào backend
        await ipc.commitScrollSlice(sliceIndex).catch(console.error);

        recentFramesRef.current = [
          {
            imgData: newImgData,
            img,
            sliceIdx: sliceIndex,
            botFixed: 0,
            usedHeightAtFrame: fh,
          }
        ];

        setStitchedHeight(fh);
        setFrameCount(1);
        updatePreview();
        return;
      }

      // So khớp đa khung hình: Thử với frame gần nhất (k-1), nếu không khớp thì thử với k-2, k-3...
      let matchedIdx = -1;
      let matchedAn: ScrollAnalysis | null = null;

      // 1. Thử so khớp với frame mới nhất (k-1)
      const lastItem = history[history.length - 1];
      let anLast = analyzeScroll(lastItem.imgData, newImgData, velocityRef.current);

      // Nếu không khớp được ở đợt cuộn đầu tiên (do trang web tự bật Header fixed/đổi padding), thử bỏ qua dải header động (180px)
      if (anLast.dy < 0 && (history.length <= 2 || lastItem.usedHeightAtFrame <= fh * 1.5)) {
        const anHeaderEx = analyzeScroll(lastItem.imgData, newImgData, velocityRef.current, 180);
        if (anHeaderEx.dy >= 0) {
          anLast = anHeaderEx;
        }
      }

      // Xử lý đặc biệt nhịp đầu tiên (history.length === 1): Nếu trang web tự bật Header fixed ở nhịp cuộn đầu,
      // tự động re-anchor Frame 1 làm mốc mốc tham chiếu chuẩn mới (sau khi Header đã ổn định)
      if (history.length === 1 && anLast.dy < 0) {
        recentFramesRef.current = [
          {
            imgData: newImgData,
            img,
            sliceIdx: sliceIndex,
            botFixed: 0,
            usedHeightAtFrame: fh,
          }
        ];
        masterCtxRef.current?.drawImage(img, 0, 0);
        usedHeightRef.current = fh;
        setStitchedHeight(fh);
        fastWarnRef.current = false;
        setFastWarn(false);
        lostTrackingRef.current = false;
        setLostTracking(false);
        updatePreview();
        return;
      }

      let bestNccScore = anLast.dy >= 0 ? (anLast.ncc ?? 0) : -1;
      if (anLast.dy >= 0) {
        matchedIdx = history.length - 1;
        matchedAn = anLast;
      }

      // 2. Nếu frame k-1 bị nhiễu do Lazy-Loading (NCC < 0.65), kiểm tra các frame cũ hơn k-2, k-3 để Rollback thay thế
      if (history.length > 1 && (anLast.dy < 0 || bestNccScore < 0.65)) {
        for (let i = history.length - 2; i >= 0; i--) {
          const anMulti = analyzeScroll(
            history[i].imgData,
            newImgData,
            velocityRef.current,
          );
          if (anMulti.dy >= 0 && (anMulti.ncc ?? 0) > bestNccScore + 0.05) {
            bestNccScore = anMulti.ncc ?? 0;
            matchedIdx = i;
            matchedAn = anMulti;
          }
        }
      }

      const an = matchedAn ?? anLast;
      const { dy, botFixed, topFixed = 0 } = an;

      if (DEBUG) {
        const ncc = an.ncc === undefined ? "—" : an.ncc.toFixed(2);
        const diff = an.changedFrac === undefined ? "—" : `${Math.round(an.changedFrac * 100)}%`;
        const act = dy > 0 ? `APPEND(m=${matchedIdx})` : dy === 0 ? "skip0" : "skip-1";
        seqRef.current++;
        const line = `#${seqRef.current} ${act} dy=${dy} tDiff=${Math.round(tickDiff * 100)}% diff=${diff} ncc=${ncc} bestDy=${an.bestDy ?? "—"} bins=${an.activeBins ?? "—"} top=${an.topFixed} bot=${an.botFixed} span=${an.span ?? "—"} fh=${fh}`;
        setDbg(line);
        const buf = logRef.current;
        buf.push(line);
        if (buf.length > 400) buf.splice(0, buf.length - 400);
        setLogText(buf.join("\n"));
      }

      if (dy > 0 && matchedIdx >= 0) {
        // Ghép thành công! Xoá mọi cảnh báo
        if (fastWarnRef.current) {
          fastWarnRef.current = false;
          setFastWarn(false);
        }
        if (lostTrackingRef.current) {
          lostTrackingRef.current = false;
          setLostTracking(false);
        }

        const matchedItem = history[matchedIdx];

        // Nếu khớp với frame cũ hơn trong buffer, rollback usedHeight và instructions
        if (matchedIdx < history.length - 1) {
          usedHeightRef.current = matchedItem.usedHeightAtFrame;
          while (
            instructionsRef.current.length > 0 &&
            instructionsRef.current[instructionsRef.current.length - 1].sliceIndex > matchedItem.sliceIdx
          ) {
            instructionsRef.current.pop();
          }
        }

        const srcY = Math.max(topFixed, fh - botFixed - dy);
        const at = usedHeightRef.current;
        ensureCapacity(at + dy, fw);
        masterCtxRef.current?.drawImage(img, 0, srcY, fw, dy, 0, at, fw, dy);
        usedHeightRef.current = at + dy;

        instructionsRef.current.push({
          sliceIndex,
          srcY,
          srcH: dy,
        });

        // Xác nhận lát cắt vào backend Rust
        await ipc.commitScrollSlice(sliceIndex).catch(console.error);

        // Cập nhật vận tốc cuộn ước tính mượt theo EMA
        velocityRef.current = velocityRef.current === 0 ? dy : velocityRef.current * 0.6 + dy * 0.4;

        // Cập nhật buffer lịch sử: giữ tối đa 8 frame gần nhất
        const updatedHistory = history.slice(0, matchedIdx + 1);
        updatedHistory.push({
          imgData: newImgData,
          img,
          sliceIdx: sliceIndex,
          botFixed,
          usedHeightAtFrame: usedHeightRef.current,
        });
        if (updatedHistory.length > 8) {
          updatedHistory.shift();
        }
        recentFramesRef.current = updatedHistory;

        setStitchedHeight(usedHeightRef.current);
        setFrameCount((prev) => prev + 1);
        updatePreview();
      } else if (dy === 0 || isStationary) {
        // Màn hình đứng yên: giảm dần vận tốc cuộn và luôn gỡ bỏ cảnh báo cuộn nhanh
        velocityRef.current = 0;
        if (fastWarnRef.current) {
          fastWarnRef.current = false;
          setFastWarn(false);
        }
        // Nếu không khớp (dy === -1) nhưng màn hình đã đứng yên, hiển thị trạng thái mất dấu nối
        if (dy === -1 && !lostTrackingRef.current) {
          lostTrackingRef.current = true;
          setLostTracking(true);
        }
      } else {
        // dy === -1 và màn hình đang di chuyển nhanh
        if (tickDiff >= 0.08) {
          if (!fastWarnRef.current) {
            fastWarnRef.current = true;
            setFastWarn(true);
          }
        }
        if (!lostTrackingRef.current) {
          lostTrackingRef.current = true;
          setLostTracking(true);
        }
      }
    } catch (err) {
      console.error(t("scroll.captureSliceError"), err);
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
    setFastWarn(false);
    fastWarnRef.current = false;
    setLostTracking(false);
    lostTrackingRef.current = false;
    lastRawImgDataRef.current = null;
    latestRawFrameRef.current = null;
    instructionsRef.current = [];
    totalSlicesRef.current = 0;
    recentFramesRef.current = [];
    velocityRef.current = 0;
    await ipc.startScrollSession().catch(console.error);

    // Chụp lát cắt đầu tiên ngay lập tức.
    await captureTick();

    // Vòng lặp chụp tần số 120ms
    intervalRef.current = window.setInterval(() => {
      if (!isCapturingRef.current) {
        stopLoop();
        return;
      }
      void captureTick();
    }, 120);
  };

  // Tự động bắt đầu chụp ngay khi cửa sổ mở
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      void startCapture();
    }
    return () => cleanupMemory();
  }, []);

  const finishCapture = async () => {
    stopLoop();

    if (usedHeightRef.current === 0) {
      cleanupMemory();
      ipc.closeSelf();
      return;
    }

    setStatus("processing");
    try {
      const w = frameWidthRef.current;
      await ipc.finalizeScrollStitch(w, instructionsRef.current, mx, my);
      cleanupMemory();
      ipc.closeSelf();
    } catch (err) {
      setError(String(err));
      setStatus("capturing");
    }
  };

  return (
    <div style={panel} data-tauri-drag-region>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      {/* Header */}
      <div style={header} data-tauri-drag-region>
        <div style={status === "capturing" ? pulseDot : inactiveDot} />
        <span style={title} data-tauri-drag-region>{t("scroll.title")}</span>
      </div>

      {/* Slices Counter / Status */}
      <div style={statusRow} data-tauri-drag-region>
        {status === "ready" && <span style={statusText}>{t("scroll.readyCapture")}</span>}
        {status === "capturing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={fastWarn || lostTracking ? statusWarn : statusText}>
              {fastWarn
                ? t("scroll.scrollWarning")
                : lostTracking
                ? t("scroll.lostTracking")
                : t("scroll.recording")}
            </span>
            {lostTracking && (
              <button
                onClick={handleBridgeCurrentFrame}
                style={bridgeBtn}
                onMouseOver={(e) => Object.assign(e.currentTarget.style, bridgeBtnHover)}
                onMouseOut={(e) => Object.assign(e.currentTarget.style, bridgeBtn)}
              >
                {t("scroll.bridgeButton")}
              </button>
            )}
          </div>
        )}
        {status === "processing" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                display: "inline-block",
                width: 14,
                height: 14,
                border: "2px solid rgba(255,255,255,0.3)",
                borderTopColor: "var(--accent, #6366f1)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <span style={{ ...statusText, color: "var(--accent, #6366f1)", fontWeight: 600 }}>
              {t("scroll.rendering", "Đang kết xuất ảnh...")}
            </span>
          </div>
        )}
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
      <style>{`
        .preview-scroll-container {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        .preview-scroll-container::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `}</style>
      <div style={{ ...previewBox, position: "relative" }}>
        <div ref={scrollContainerRef} className="preview-scroll-container" style={scrollList}>
          <div ref={cropWrapperRef} style={cropWrapper} />
        </div>
        {status === "ready" && (
          <div style={emptyOverlay} data-tauri-drag-region>
            {t("scroll.startMessage")}
          </div>
        )}
        {status === "processing" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              background: "rgba(15, 23, 42, 0.75)",
              backdropFilter: "blur(4px)",
              color: "#fff",
              zIndex: 10,
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                border: "3px solid rgba(255, 255, 255, 0.2)",
                borderTopColor: "var(--accent, #6366f1)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <span>{t("scroll.rendering", "Đang kết xuất ảnh...")}</span>
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
            cleanupMemory();
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
  scrollbarWidth: "none",
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
  transform: "translateZ(0)",
  backfaceVisibility: "hidden",
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

const bridgeBtn: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid rgba(251, 191, 36, 0.4)",
  background: "rgba(251, 191, 36, 0.15)",
  color: "#fef08a",
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.15s ease",
  alignSelf: "flex-start",
  marginTop: 2,
};

const bridgeBtnHover: React.CSSProperties = {
  background: "rgba(251, 191, 36, 0.25)",
  color: "#ffffff",
  borderColor: "rgba(251, 191, 36, 0.6)",
};

