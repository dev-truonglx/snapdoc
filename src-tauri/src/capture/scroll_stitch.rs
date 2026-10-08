//! Lõi chụp cuộn: so khớp các khung liên tiếp, nhận diện header/footer/sidebar
//! cố định và ghép thành 1 ảnh dài. Thuần Rust, không phụ thuộc Tauri → test
//! được bằng ảnh giả lập (xem `tests` cuối file).
//!
//! Bất biến cốt lõi: mỗi khung đã ghép nhớ `consumed_bottom` — dòng (theo toạ độ
//! của CHÍNH khung đó) mà ảnh ghép đang kết thúc. Lát mới từ khung `cur` khớp với
//! `ref` lệch `dy` luôn bắt đầu ở `ref.consumed_bottom - dy`, nên không thể trùng
//! hay hụt dòng dù chiều cao footer/header ước lượng thay đổi giữa các nhịp.
//! Nếu điểm bắt đầu rơi vào vùng header (cuộn quá nhanh, nội dung đã trôi qua
//! sau header) thì báo "mất dấu" chứ KHÔNG ghép thiếu.
//!
//! Độ dịch `dy` được tìm thô trên đặc trưng dòng gộp (pooled), tinh chỉnh trên
//! đặc trưng từng dòng, rồi BẮT BUỘC xác thực ở mức pixel (≥ `ACCEPT` ô nội
//! dung khớp) — ứng viên không đạt thì không ghép, tránh đường nối bị gãy.

use image::RgbaImage;
use std::collections::VecDeque;
use std::sync::Arc;

/// Số ô (band) chia theo bề ngang khi tính đặc trưng / xác thực.
const K: usize = 32;
/// Hệ số gộp dòng cho bước tìm thô.
const POOL: usize = 4;
/// Bước lấy mẫu x khi tính đặc trưng / so dòng.
const XSTEP: usize = 2;
/// Sai khác tối đa mỗi kênh để coi 2 pixel là trùng (chịu ClearType, scale 125–150%).
const PIX_TOL: i32 = 24;
/// Chênh sáng giữa 2 điểm cạnh nhau để coi là "cạnh" (điểm có nội dung).
const GRAD_TOL: i32 = 16;
/// 1 ô (dòng × band) coi là khớp nếu số pixel lệch ≤ tỉ lệ này.
const CELL_MISMATCH: f32 = 0.06;
/// Tỉ lệ ô nội dung khớp tối thiểu để chấp nhận 1 độ dịch.
const ACCEPT: f32 = 0.9;
/// Số ô nội dung tối thiểu để kết quả xác thực đáng tin.
const MIN_CELLS: u32 = 24;
/// Số dòng chồng lấn tối thiểu giữa 2 khung.
const MIN_OVERLAP: usize = 24;
const VERIFY_ROWS: usize = 128;
const FINE_ROWS: usize = 256;
const COARSE_ROWS: usize = 128;
const MAX_CANDIDATES: usize = 6;
/// Số khung đã ghép giữ lại để so khớp lùi (khi khung gần nhất bị lazy-load làm nhiễu).
const MAX_HISTORY: usize = 4;
/// Tỉ lệ điểm mẫu thay đổi dưới ngưỡng này so với nhịp trước → màn hình đứng yên.
const STILL_FRAC: f32 = 0.004;
/// Tỉ lệ dòng thay đổi dưới ngưỡng này → coi như không cuộn.
const IDLE_CHANGED: f32 = 0.01;
/// Không khớp được nhưng chỉ đổi cục bộ (hover, animation) dưới ngưỡng này → không báo mất dấu.
const LOCAL_CHANGE: f32 = 0.2;
const MAX_BAND_FRAC: f32 = 0.45;

type Mask = [bool; K];
const ALL: Mask = [true; K];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickStatus {
    /// Khung đầu tiên của phiên.
    First = 0,
    /// Đã khớp và ghép (có thể 0 dòng mới).
    Appended = 1,
    /// Đứng yên / chỉ đổi cục bộ.
    Idle = 2,
    /// Không khớp được (cuộn quá nhanh, nhảy trang...).
    Lost = 3,
    /// Chưa từng khớp: lấy khung hiện tại làm mốc mới (vd header tự bật khi bắt đầu cuộn).
    Reanchored = 4,
}

pub struct TickResult {
    pub status: TickStatus,
    pub dy: i32,
    /// Màn hình đang chuyển động mạnh nhưng không khớp được → cảnh báo cuộn quá nhanh.
    pub fast: bool,
    pub diag: String,
}

pub struct Preview {
    pub width: u32,
    /// Dòng (toạ độ preview) bắt đầu vẽ lại.
    pub from_row: u32,
    /// Tổng số dòng preview hiện tại.
    pub total_rows: u32,
    /// RGBA các dòng `[from_row, total_rows)`.
    pub rgba: Vec<u8>,
}

#[derive(Clone)]
struct Layout {
    w: usize,
    h: usize,
    /// Bỏ lề phải (thanh cuộn) khỏi phân tích.
    xend: usize,
    band_x: [usize; K + 1],
    scale: f32,
}

impl Layout {
    fn new(w: usize, h: usize, scale: f32) -> Self {
        let sb = ((16.0 * scale).round() as usize).min(w / 8);
        let xend = w - sb;
        let mut band_x = [0usize; K + 1];
        for (b, bx) in band_x.iter_mut().enumerate() {
            *bx = b * xend / K;
        }
        Self { w, h, xend, band_x, scale }
    }

    fn px(&self, v: f32) -> usize {
        (v * self.scale).round() as usize
    }
}

#[inline]
fn lum(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8) as u8
}

#[inline]
fn px_close(a: &[u8], i: usize, b: &[u8], j: usize) -> bool {
    (a[i] as i32 - b[j] as i32).abs() <= PIX_TOL
        && (a[i + 1] as i32 - b[j + 1] as i32).abs() <= PIX_TOL
        && (a[i + 2] as i32 - b[j + 2] as i32).abs() <= PIX_TOL
}

#[inline]
fn px_sad(a: &[u8], i: usize, b: &[u8], j: usize) -> u32 {
    (a[i] as i32 - b[j] as i32).unsigned_abs()
        + (a[i + 1] as i32 - b[j + 1] as i32).unsigned_abs()
        + (a[i + 2] as i32 - b[j + 2] as i32).unsigned_abs()
}

struct Frame {
    id: u64,
    img: Arc<RgbaImage>,
    luma: Vec<u8>,
    /// Luma trung bình theo (dòng, ô): `mean[y * K + b]`.
    mean: Vec<u8>,
    /// Số điểm cạnh theo (dòng, ô).
    edges: Vec<u16>,
    /// Như trên nhưng gộp `POOL` dòng (tổng).
    pmean: Vec<u16>,
    pedges: Vec<u16>,
}

impl Frame {
    fn new(id: u64, img: RgbaImage, lay: &Layout) -> Self {
        let (w, h) = (lay.w, lay.h);
        let raw = img.as_raw();
        let mut luma = vec![0u8; w * h];
        for (i, p) in raw.chunks_exact(4).enumerate() {
            luma[i] = lum(p[0], p[1], p[2]);
        }
        let mut mean = vec![0u8; h * K];
        let mut edges = vec![0u16; h * K];
        for y in 0..h {
            let row = &luma[y * w..(y + 1) * w];
            for b in 0..K {
                let (x0, x1) = (lay.band_x[b], lay.band_x[b + 1]);
                let (mut sum, mut n, mut e) = (0u32, 0u32, 0u16);
                let mut x = x0;
                while x < x1 {
                    sum += row[x] as u32;
                    n += 1;
                    if x + XSTEP < lay.xend && (row[x] as i32 - row[x + XSTEP] as i32).abs() > GRAD_TOL {
                        e += 1;
                    }
                    x += XSTEP;
                }
                mean[y * K + b] = sum.checked_div(n).unwrap_or(0) as u8;
                edges[y * K + b] = e;
            }
        }
        let ph = h / POOL;
        let mut pmean = vec![0u16; ph * K];
        let mut pedges = vec![0u16; ph * K];
        for yp in 0..ph {
            for i in 0..POOL {
                let y = yp * POOL + i;
                for b in 0..K {
                    pmean[yp * K + b] += mean[y * K + b] as u16;
                    pedges[yp * K + b] = pedges[yp * K + b].saturating_add(edges[y * K + b]);
                }
            }
        }
        Self { id, img: Arc::new(img), luma, mean, edges, pmean, pedges }
    }

    fn edges_masked(&self, y: usize, mask: &Mask) -> u32 {
        (0..K).filter(|&b| mask[b]).map(|b| self.edges[y * K + b] as u32).sum()
    }

    fn pedges_masked(&self, yp: usize, mask: &Mask) -> u32 {
        (0..K).filter(|&b| mask[b]).map(|b| self.pedges[yp * K + b] as u32).sum()
    }
}

/// 2 dòng (có thể khác khung, khác chỉ số) có trùng nhau không, chỉ xét các ô trong `mask`.
fn row_same(lay: &Layout, a: &Frame, ya: usize, b: &Frame, yb: usize, mask: &Mask) -> bool {
    let w = lay.w;
    let ra = &a.img.as_raw()[ya * w * 4..(ya + 1) * w * 4];
    let rb = &b.img.as_raw()[yb * w * 4..(yb + 1) * w * 4];
    let la = &a.luma[ya * w..(ya + 1) * w];
    let lb = &b.luma[yb * w..(yb + 1) * w];
    let (mut mism, mut inf) = (0u32, 0u32);
    for band in 0..K {
        if !mask[band] {
            continue;
        }
        let mut x = lay.band_x[band];
        while x < lay.band_x[band + 1] {
            if !px_close(ra, x * 4, rb, x * 4) {
                mism += 1;
            }
            if x + XSTEP < lay.xend
                && ((la[x] as i32 - la[x + XSTEP] as i32).abs() > GRAD_TOL
                    || (lb[x] as i32 - lb[x + XSTEP] as i32).abs() > GRAD_TOL)
            {
                inf += 1;
            }
            x += XSTEP;
        }
    }
    mism <= (inf / 25).max(1)
}

/// Tỉ lệ điểm mẫu khác nhau giữa 2 khung (phát hiện đứng yên nhanh).
fn diff_frac(a: &Frame, b: &Frame, lay: &Layout) -> f32 {
    let (ra, rb) = (a.img.as_raw(), b.img.as_raw());
    let (mut n, mut ch) = (0u32, 0u32);
    for y in (0..lay.h).step_by(6) {
        for x in (0..lay.w).step_by(12) {
            let i = (y * lay.w + x) * 4;
            n += 1;
            if !px_close(ra, i, rb, i) {
                ch += 1;
            }
        }
    }
    if n == 0 {
        0.0
    } else {
        ch as f32 / n as f32
    }
}

#[derive(Clone)]
struct Verify {
    score: f32,
    cells: u32,
    /// Sai khác trung bình mỗi kênh trên các ô nội dung — phân xử ứng viên lệch nhau 1px cùng điểm.
    mad: f32,
    band_inf: [u32; K],
    band_ok: [u32; K],
}

/// Xác thực mức pixel: dòng `y` của `c` so với dòng `y + dy` của `r`, với
/// `y ∈ [t, bot - dy)`. Chỉ đếm các ô có nội dung (cạnh) ở 1 trong 2 khung.
fn verify(lay: &Layout, r: &Frame, c: &Frame, dy: usize, t: usize, bot: usize, mask: &Mask) -> Verify {
    let w = lay.w;
    let mut v = Verify { score: 0.0, cells: 0, mad: 0.0, band_inf: [0; K], band_ok: [0; K] };
    let (mut sad, mut sad_n) = (0u64, 0u64);
    if bot <= t + dy {
        return v;
    }
    let n = bot - dy - t;
    let step = (n / VERIFY_ROWS).max(1);
    let (rr, cr) = (r.img.as_raw(), c.img.as_raw());
    let mut ok = 0u32;
    let mut y = t;
    while y < bot - dy {
        let yr = y + dy;
        let (lc, lr) = (&c.luma[y * w..(y + 1) * w], &r.luma[yr * w..(yr + 1) * w]);
        for b in 0..K {
            if !mask[b] {
                continue;
            }
            let (x0, x1) = (lay.band_x[b], lay.band_x[b + 1]);
            let (mut tot, mut mism, mut inf, mut cell_sad) = (0u32, 0u32, 0u32, 0u32);
            for x in x0..x1 {
                tot += 1;
                let (i, j) = ((y * w + x) * 4, (yr * w + x) * 4);
                cell_sad += px_sad(cr, i, rr, j);
                if !px_close(cr, i, rr, j) {
                    mism += 1;
                }
                if x + XSTEP < lay.xend
                    && ((lc[x] as i32 - lc[x + XSTEP] as i32).abs() > GRAD_TOL
                        || (lr[x] as i32 - lr[x + XSTEP] as i32).abs() > GRAD_TOL)
                {
                    inf += 1;
                }
            }
            if inf >= 2 {
                v.cells += 1;
                sad += cell_sad as u64;
                sad_n += tot as u64 * 3;
                v.band_inf[b] += 1;
                if (mism as f32) <= tot as f32 * CELL_MISMATCH {
                    ok += 1;
                    v.band_ok[b] += 1;
                }
            }
        }
        y += step;
    }
    v.score = if v.cells > 0 { ok as f32 / v.cells as f32 } else { 0.0 };
    v.mad = if sad_n > 0 { sad as f32 / sad_n as f32 } else { f32::INFINITY };
    v
}

/// Chọn tối đa `max` phần tử cách đều từ danh sách.
fn spread(rows: Vec<usize>, max: usize) -> Vec<usize> {
    if rows.len() <= max {
        return rows;
    }
    (0..max).map(|i| rows[i * rows.len() / max]).collect()
}

fn feat_cost(r: &Frame, c: &Frame, rows: &[usize], dy: usize, bot: usize, mask: &Mask) -> Option<f32> {
    let (mut sum, mut n) = (0u32, 0u32);
    for &y in rows {
        if y + dy >= bot {
            continue;
        }
        n += 1;
        let (ic, ir) = (y * K, (y + dy) * K);
        for b in 0..K {
            if mask[b] {
                sum += (c.mean[ic + b] as i32 - r.mean[ir + b] as i32).unsigned_abs()
                    + (c.edges[ic + b] as i32 - r.edges[ir + b] as i32).unsigned_abs();
            }
        }
    }
    (n >= 3).then(|| sum as f32 / n as f32)
}

/// Tìm các độ dịch ứng viên rồi xác thực pixel. Trả về (dy, kết quả xác thực).
#[allow(clippy::too_many_arguments)]
fn search(
    lay: &Layout,
    r: &Frame,
    c: &Frame,
    t: usize,
    bot: usize,
    mask: &Mask,
    max_dy: usize,
    velocity: f32,
) -> Vec<(usize, Verify)> {
    // 1) Tìm thô trên dòng gộp.
    let (tp, bp) = (t.div_ceil(POOL), bot / POOL);
    let mut coarse: Vec<usize> = Vec::new();
    if bp > tp + 2 {
        let rows: Vec<usize> = (tp..bp).filter(|&yp| c.pedges_masked(yp, mask) > 0).collect();
        let rows = spread(rows, COARSE_ROWS);
        let maxd = max_dy / POOL;
        let mut cost = vec![f32::INFINITY; maxd + 1];
        for (d, slot) in cost.iter_mut().enumerate() {
            let (mut sum, mut n) = (0u32, 0u32);
            for &yp in &rows {
                if yp + d >= bp {
                    continue;
                }
                n += 1;
                let (ic, ir) = (yp * K, (yp + d) * K);
                for b in 0..K {
                    if mask[b] {
                        sum += (c.pmean[ic + b] as i32 - r.pmean[ir + b] as i32).unsigned_abs()
                            + (c.pedges[ic + b] as i32 - r.pedges[ir + b] as i32).unsigned_abs();
                    }
                }
            }
            if n >= 3 {
                *slot = sum as f32 / n as f32;
            }
        }
        let mut minima: Vec<(usize, f32)> = (0..=maxd)
            .filter(|&d| {
                cost[d].is_finite()
                    && (d == 0 || cost[d] <= cost[d - 1])
                    && (d == maxd || cost[d] <= cost[d + 1])
            })
            .map(|d| (d, cost[d]))
            .collect();
        minima.sort_by(|a, b| a.1.total_cmp(&b.1));
        coarse.extend(minima.iter().take(MAX_CANDIDATES).map(|m| m.0));
        if velocity > 0.0 {
            let dv = (velocity / POOL as f32).round() as usize;
            let (lo, hi) = (dv / 2, (dv * 2 + 1).min(maxd));
            if let Some(best) = (lo..=hi).filter(|&d| cost[d].is_finite()).min_by(|&a, &b| cost[a].total_cmp(&cost[b])) {
                coarse.push(best);
            }
        }
    } else {
        coarse.extend((0..=max_dy / POOL).take(64));
    }

    // 2) Tinh chỉnh trên từng dòng quanh mỗi ứng viên thô.
    let rows: Vec<usize> = (t..bot).filter(|&y| c.edges_masked(y, mask) > 0).collect();
    let rows = spread(rows, FINE_ROWS);
    let mut fine: Vec<usize> = Vec::new();
    for d in coarse {
        let lo = (d * POOL).saturating_sub(POOL).max(1);
        let hi = (d * POOL + POOL).min(max_dy);
        let best = (lo..=hi)
            .filter_map(|dy| feat_cost(r, c, &rows, dy, bot, mask).map(|cst| (dy, cst)))
            .min_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((dy, _)) = best {
            for cand in [dy.saturating_sub(1), dy, dy + 1] {
                if cand >= 1 && cand <= max_dy && !fine.contains(&cand) {
                    fine.push(cand);
                }
            }
        }
    }

    // 3) Xác thực pixel.
    fine.into_iter().map(|dy| (dy, verify(lay, r, c, dy, t, bot, mask))).collect()
}

/// Sai khác luma trung bình trên MỌI dòng có nội dung của vùng chồng lấn —
/// dày hơn `verify` (vốn lấy mẫu thưa) để phân biệt 2 độ dịch lệch nhau 1–2px.
fn dense_mad(lay: &Layout, r: &Frame, c: &Frame, dy: usize, t: usize, bot: usize, mask: &Mask) -> f32 {
    let w = lay.w;
    let (mut sum, mut n) = (0u64, 0u64);
    for y in t..bot.saturating_sub(dy) {
        if c.edges_masked(y, mask) == 0 && r.edges_masked(y + dy, mask) == 0 {
            continue;
        }
        let (lc, lr) = (&c.luma[y * w..(y + 1) * w], &r.luma[(y + dy) * w..(y + dy + 1) * w]);
        for b in 0..K {
            if !mask[b] {
                continue;
            }
            let mut x = lay.band_x[b];
            while x < lay.band_x[b + 1] {
                sum += (lc[x] as i32 - lr[x] as i32).unsigned_abs() as u64;
                n += 1;
                x += XSTEP;
            }
        }
    }
    if n == 0 {
        f32::INFINITY
    } else {
        sum as f32 / n as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Side {
    width: usize,
    color: [u8; 4],
}

#[derive(Clone, Copy, Default)]
struct ColStat {
    same: f32,
    diff: f32,
    strc: f32,
}

/// Nhận diện sidebar cố định ở 1 mép (trái hoặc phải). Cột sidebar đứng yên
/// tại chỗ trong khi nội dung bên cạnh cuộn; loại trường hợp lề trắng của tài
/// liệu căn giữa (không có icon/chữ và cùng màu nền với nội dung).
fn detect_side(lay: &Layout, r: &Frame, c: &Frame, dy: usize, t: usize, bot: usize, right: bool) -> Option<Side> {
    let (w, h) = (lay.w, lay.h);
    if dy < 4 {
        return None;
    }
    let y0 = t + 16;
    let y1 = bot.saturating_sub(16).min(h);
    if y1 <= y0 + 40 {
        return None;
    }
    let span = y1 - y0;
    let step_y = (span / 45).clamp(6, 12);
    let rows: Vec<usize> = (y0..y1).step_by(step_y).collect();
    let nrows = rows.len();
    if nrows < 6 {
        return None;
    }
    // Khoảng cách tính từ mép; mép phải bỏ qua thanh cuộn.
    let skip = if right { w - lay.xend } else { 0 };
    let max_w = (w as f32 * 0.45) as usize;
    let min_w = lay.px(40.0).max(24);
    if max_w <= min_w {
        return None;
    }
    let x_of = |d: usize| if right { w - 1 - d } else { d };
    let (rr, cr) = (r.img.as_raw(), c.img.as_raw());
    let limit = (max_w + 80).min(w * 65 / 100).min(w - 1);
    let dists: Vec<usize> = (skip..limit).step_by(2).collect();
    let stats: Vec<ColStat> = dists
        .iter()
        .map(|&d| {
            let x = x_of(d);
            let (mut same, mut diff, mut strc, mut tested) = (0u32, 0u32, 0u32, 0u32);
            for &y in &rows {
                let i = (y * w + x) * 4;
                let d0 = px_sad(rr, i, cr, i);
                if d0 <= 24 {
                    same += 1;
                } else if d0 > 30 {
                    diff += 1;
                }
                // Nội dung ở dòng y của ref đã dịch lên dòng y - dy của cur.
                if y >= t + dy {
                    tested += 1;
                    let j = ((y - dy) * w + x) * 4;
                    if d0 <= 24 && px_sad(rr, i, cr, j) > 30 {
                        strc += 1;
                    }
                }
            }
            ColStat {
                same: same as f32 / nrows as f32,
                diff: diff as f32 / nrows as f32,
                strc: if tested > 0 { strc as f32 / tested as f32 } else { 0.0 },
            }
        })
        .collect();

    // Cột đầu tiên (tính từ mép) bắt đầu cuộn rõ rệt.
    let first_move = (0..stats.len()).find(|&i| {
        let s = stats[i];
        if s.diff >= 0.12 || (s.same < 0.82 && s.diff >= 0.06) {
            let n1 = stats.get(i + 1).map(|s| s.diff >= 0.06).unwrap_or(false);
            let n2 = stats.get(i + 2).map(|s| s.diff >= 0.06).unwrap_or(false);
            s.diff >= 0.22 || n1 || n2
        } else {
            false
        }
    })?;
    let d_move = dists[first_move];
    if d_move < min_w || first_move == 0 {
        return None;
    }
    let stationary = stats[..first_move].iter().filter(|s| s.same >= 0.85).count();
    if (stationary as f32) < first_move as f32 * 0.82 {
        return None;
    }
    let struct_cols = stats[..first_move].iter().filter(|s| s.strc >= 0.03).count();
    let mid = (y0 + y1) / 2;
    let sb_x = x_of(((d_move as f32 * 0.4) as usize).max(skip + 8));
    let ct_x = x_of((d_move + 80).min(w - 1));
    let diff_bg = px_sad(cr, (mid * w + sb_x) * 4, cr, (mid * w + ct_x) * 4);
    if struct_cols < 2 && diff_bg < 15 {
        return None;
    }

    // Biên chính xác: ranh giới (đường kẻ hoặc đổi màu nền) ổn định trên nhiều
    // dòng, lấy ranh giới xa mép nhất trong cửa sổ quanh cột bắt đầu cuộn.
    let lum_at = |x: usize, y: usize| c.luma[y * w + x] as i32;
    let lo = d_move.saturating_sub(lay.px(60.0)).max(min_w.saturating_sub(1)).max(skip);
    let hi = (d_move + 4).min(max_w);
    let mut width = None;
    for d in lo..hi {
        let (xa, xb) = (x_of(d), x_of(d + 1));
        let score = rows.iter().filter(|&&y| (lum_at(xa, y) - lum_at(xb, y)).abs() >= 8).count();
        if score as f32 >= nrows as f32 * 0.55 {
            width = Some(d + 1);
        }
    }
    let width = width.unwrap_or_else(|| {
        // Dò lùi từ cột bắt đầu cuộn tới cột đứng yên hẳn.
        let mut wd = d_move;
        for d in (lo..=d_move).rev() {
            let x = x_of(d);
            let moving = rows.iter().filter(|&&y| px_sad(rr, (y * w + x) * 4, cr, (y * w + x) * 4) > 28).count();
            if moving as f32 / nrows as f32 <= 0.04 {
                wd = d + 1;
                break;
            }
        }
        wd
    });
    let width = width.clamp(min_w, max_w);

    // Màu nền chiếm đa số trong cột sidebar.
    let mut samples: Vec<[u8; 4]> = Vec::new();
    for f in [0.2f32, 0.4, 0.6, 0.8] {
        let d = ((width as f32 * f) as usize).max(skip + 2).min(width - 1);
        let x = x_of(d);
        for &y in &rows {
            let i = (y * w + x) * 4;
            samples.push([cr[i], cr[i + 1], cr[i + 2], 255]);
        }
    }
    let close = |a: &[u8; 4], b: &[u8; 4]| (0..3).all(|k| (a[k] as i32 - b[k] as i32).abs() <= 12);
    let color = *samples
        .iter()
        .max_by_key(|a| samples.iter().filter(|b| close(a, b)).count())?;
    Some(Side { width, color })
}

struct Match {
    dy: usize,
    score: f32,
    t: usize,
    bot: usize,
    excl: bool,
    /// Chiều cao header thật (dòng cố định có bằng chứng).
    header: usize,
    /// Số dòng đáy KHÔNG được lấy ở nhịp này (footer + dòng không kiểm chứng được).
    footer_stitch: usize,
    /// Footer thật (dòng cố định có bằng chứng) — dùng để khoá & ghim footer.
    footer_real: usize,
    mask: Mask,
    side_l: Option<Side>,
    side_r: Option<Side>,
}

enum Analysis {
    Idle,
    Match(Box<Match>),
    Fail { changed: f32, best: f32 },
}

/// Phân tích cặp khung (`r` cũ, `c` mới). `excl` = bỏ qua 25% trên + 20% dưới
/// khi tìm dy (header tự hiện, banner cookie/footer xuất hiện giữa chừng).
fn analyze(lay: &Layout, r: &Frame, c: &Frame, velocity: f32, excl: bool) -> Analysis {
    let h = lay.h;
    let same = |y: usize| row_same(lay, c, y, r, y, &ALL);
    let sampled: Vec<usize> = (0..h).step_by(4).collect();
    let changed = sampled.iter().filter(|&&y| !same(y)).count() as f32 / sampled.len() as f32;
    if changed < IDLE_CHANGED {
        return Analysis::Idle;
    }
    let fail = |best: f32| Analysis::Fail { changed, best };

    // Dải giống tại chỗ ở trên/dưới (header/footer hoặc vùng trơn) — dừng ở dòng khác đầu tiên.
    let max_band = (h as f32 * MAX_BAND_FRAC) as usize;
    let mut t_raw = 0;
    while t_raw < max_band && same(t_raw) {
        t_raw += 1;
    }
    let mut b_raw = 0;
    while b_raw < max_band && same(h - 1 - b_raw) {
        b_raw += 1;
    }
    if h - t_raw - b_raw < h / 4 {
        t_raw = 0;
        b_raw = 0;
    }
    let bot_raw = h - b_raw;
    let (mut t, mut bot) = (t_raw, bot_raw);
    if excl {
        t = t.max(h / 4);
        bot = bot.min(h * 4 / 5);
    }
    if bot <= t + MIN_OVERLAP * 2 {
        return fail(0.0);
    }

    // Ô đứng yên có nội dung (sidebar dính) → loại khỏi so khớp.
    let v0 = verify(lay, r, c, 0, t, bot, &ALL);
    let mut mask = ALL;
    for b in 0..K {
        let inf = v0.band_inf[b];
        mask[b] = !(inf >= 6 && v0.band_ok[b] as f32 >= 0.9 * inf as f32);
    }
    if !mask.iter().any(|m| *m) {
        return if excl { fail(0.0) } else { Analysis::Idle };
    }

    let max_dy = bot - t - MIN_OVERLAP;
    let results = search(lay, r, c, t, bot, &mask, max_dy, velocity);
    let best_any = results.iter().map(|r| r.1.score).fold(0.0f32, f32::max);
    let mut passing: Vec<(usize, Verify)> =
        results.into_iter().filter(|(_, v)| v.score >= ACCEPT && v.cells >= MIN_CELLS).collect();
    if passing.is_empty() {
        return fail(best_any);
    }
    passing.sort_by(|a, b| b.1.score.total_cmp(&a.1.score).then(a.1.mad.total_cmp(&b.1.mad)));
    // Gom ứng viên sát nhau (±2px) → đại diện điểm cao nhất; nội dung tuần hoàn
    // (bảng lặp dòng) cho nhiều cụm gần ngang điểm → chọn cụm gần vận tốc cuộn.
    let mut reps: Vec<(usize, f32)> = Vec::new();
    for (dy, v) in &passing {
        if !reps.iter().any(|(d, _)| d.abs_diff(*dy) <= 2) {
            reps.push((*dy, v.score));
        }
    }
    let top = reps[0].1;
    let near: Vec<(usize, f32)> = reps.into_iter().filter(|(_, s)| *s >= top - 0.02).collect();
    let (picked, mut score) = if velocity > 0.0 && near.len() > 1 {
        *near
            .iter()
            .min_by(|a, b| (a.0 as f32 - velocity).abs().total_cmp(&(b.0 as f32 - velocity).abs()))
            .unwrap()
    } else {
        near[0]
    };
    // Tinh chỉnh ±2px bằng sai số dày đặc; chỉ nhận khi ứng viên mới vẫn qua xác thực.
    let mut dy = picked;
    let best_fine = (picked.saturating_sub(2).max(1)..=(picked + 2).min(max_dy))
        .map(|d| (d, dense_mad(lay, r, c, d, t, bot, &mask)))
        .min_by(|a, b| a.1.total_cmp(&b.1));
    if let Some((d, _)) = best_fine {
        if d != picked {
            let v = verify(lay, r, c, d, t, bot, &mask);
            if v.score >= ACCEPT && v.cells >= MIN_CELLS {
                dy = d;
                score = v.score;
            }
        }
    }

    // Header thật: dòng giống tại chỗ nhưng KHÔNG khớp với phép dịch.
    let mut header = 0;
    for y in 0..t_raw {
        if y + dy >= h || !row_same(lay, c, y, r, y + dy, &mask) {
            header = y + 1;
        }
    }
    // Dòng KHÔNG lấy ở nhịp này: trong dải đáy mà không kiểm chứng được
    // (y + dy ≥ h) hoặc mâu thuẫn với phép dịch.
    let fs_top = (bot_raw..h)
        .find(|&y| y + dy >= h || !row_same(lay, c, y, r, y + dy, &mask))
        .unwrap_or(h);
    // Footer thật, quét từ đáy lên với `f` = đỉnh footer hiện tại: dòng mà
    // nguồn (y + dy) bị footer che/ra ngoài khung thì chỉ tính là footer khi
    // có nội dung (nội dung cuộn không thể đứng yên tại chỗ); dòng kiểm chứng
    // được thì là footer khi mâu thuẫn với phép dịch.
    let mut f = h;
    for y in (bot_raw..h).rev() {
        if y + dy >= f {
            // Dòng giống hệt dòng cách nó `dy` phía trên (vd chỉ có đường kẻ dọc
            // của bảng) cũng "đứng yên" khi cuộn → không phải bằng chứng footer.
            if c.edges_masked(y, &mask) > 0 && (y < dy || !row_same(lay, c, y, c, y - dy, &mask)) {
                f = y;
            }
        } else if !row_same(lay, c, y, r, y + dy, &mask) {
            f = y;
        }
    }
    if f < h {
        // Phần đệm trơn phía trên chữ của footer (cùng 1 màu): nhận khi dải
        // trơn kết thúc ở mép dải cố định hoặc ở 1 dòng khác màu, và không dài
        // quá `max_ext` (dải trắng dài hơn là nền trang, không phải footer).
        let max_ext = lay.px(48.0);
        let mut top = f;
        while top > bot_raw && f - top < max_ext && c.edges_masked(top - 1, &mask) == 0 {
            if top < f && !row_same(lay, c, top - 1, c, top, &ALL) {
                break;
            }
            top -= 1;
        }
        if top < f && f - top < max_ext && (top == bot_raw || !row_same(lay, c, top - 1, c, top, &ALL)) {
            f = top;
        }
    }
    let footer_real = h - f;
    let mut footer_stitch = h - fs_top;
    if footer_real > 0 {
        // Đệm loại dải bóng đổ (box-shadow) phía trên footer — chỉ ảnh hưởng
        // việc lấy ít dòng hơn, tính liên tục vẫn đảm bảo nhờ consumed_bottom.
        footer_stitch = footer_stitch.max((footer_real + lay.px(14.0)).min(max_band));
    }

    let side_l = detect_side(lay, r, c, dy, t_raw, bot_raw, false);
    let side_r = detect_side(lay, r, c, dy, t_raw, bot_raw, true);

    Analysis::Match(Box::new(Match {
        dy,
        score,
        t,
        bot,
        excl,
        header,
        footer_stitch,
        footer_real,
        mask,
        side_l,
        side_r,
    }))
}

struct Strip {
    img: RgbaImage,
    /// Số dòng đầu của `img` đang dùng (có thể bị cắt bớt khi chỉnh đường nối / footer).
    use_h: usize,
    frame_id: u64,
    /// Được tô màu nền sidebar khi kéo dài sidebar (mọi strip trừ khung đầu).
    fillable: bool,
}

struct Accepted {
    frame: Arc<Frame>,
    /// Dòng (toạ độ khung này) mà ảnh ghép đang kết thúc.
    consumed_bottom: usize,
    /// Số strip và chiều cao strip cuối ngay sau khi khung này được ghép — để rollback.
    strips_len: usize,
    last_use_h: usize,
}

/// Bỏ phiếu: giá trị chỉ được khoá khi 2 nhịp khớp liên tiếp đồng ý.
struct Vote<T> {
    cand: Option<T>,
    locked: Option<T>,
}

impl<T> Default for Vote<T> {
    fn default() -> Self {
        Self { cand: None, locked: None }
    }
}

impl<T: Copy> Vote<T> {
    /// `merge` gộp 2 quan sát đồng thuận thành giá trị khoá.
    fn observe(&mut self, v: Option<T>, agree: impl Fn(&T, &T) -> bool, merge: impl Fn(T, T) -> T) -> bool {
        if self.locked.is_some() {
            return false;
        }
        match (v, self.cand) {
            (Some(v), Some(c)) if agree(&v, &c) => {
                self.locked = Some(merge(v, c));
                true
            }
            (v, _) => {
                self.cand = v;
                false
            }
        }
    }
}

pub struct Session {
    lay: Option<Layout>,
    next_id: u64,
    strips: Vec<Strip>,
    history: VecDeque<Accepted>,
    matched_once: bool,
    last_raw: Option<Arc<Frame>>,
    velocity: f32,
    header_h: usize,
    footer: Vote<usize>,
    side_l: Vote<Side>,
    side_r: Vote<Side>,
    pin_footer: bool,
    extend_sidebar: bool,
    dirty_from: Option<usize>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            lay: None,
            next_id: 0,
            strips: Vec::new(),
            history: VecDeque::new(),
            matched_once: false,
            last_raw: None,
            velocity: 0.0,
            header_h: 0,
            footer: Vote::default(),
            side_l: Vote::default(),
            side_r: Vote::default(),
            pin_footer: true,
            extend_sidebar: true,
            dirty_from: None,
        }
    }
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn canvas_h(&self) -> usize {
        self.strips.iter().map(|s| s.use_h).sum()
    }

    pub fn strip_count(&self) -> usize {
        self.strips.len()
    }

    pub fn footer_locked(&self) -> usize {
        self.footer.locked.unwrap_or(0)
    }

    pub fn sidebar_locked(&self) -> bool {
        self.side_l.locked.is_some() || self.side_r.locked.is_some()
    }

    pub fn set_options(&mut self, pin_footer: bool, extend_sidebar: bool) {
        if extend_sidebar != self.extend_sidebar && self.sidebar_locked() {
            self.mark_dirty(self.strips.first().map(|s| s.use_h).unwrap_or(0));
        }
        self.pin_footer = pin_footer;
        self.extend_sidebar = extend_sidebar;
    }

    fn mark_dirty(&mut self, y: usize) {
        self.dirty_from = Some(self.dirty_from.map_or(y, |d| d.min(y)));
    }

    fn crop(frame: &Frame, y0: usize, y1: usize, fillable: bool) -> Strip {
        let w = frame.img.width();
        let bpr = w as usize * 4;
        let data = frame.img.as_raw()[y0 * bpr..y1 * bpr].to_vec();
        Strip {
            img: RgbaImage::from_raw(w, (y1 - y0) as u32, data).expect("kích thước strip hợp lệ"),
            use_h: y1 - y0,
            frame_id: frame.id,
            fillable,
        }
    }

    fn start_over(&mut self, frame: Arc<Frame>, h: usize) {
        self.strips = vec![Self::crop(&frame, 0, h, false)];
        self.history = VecDeque::from([Accepted { frame, consumed_bottom: h, strips_len: 1, last_use_h: h }]);
        self.footer = Vote::default();
        self.side_l = Vote::default();
        self.side_r = Vote::default();
        self.velocity = 0.0;
        self.header_h = 0;
        self.dirty_from = Some(0);
    }

    /// Xử lý 1 khung vừa chụp.
    pub fn tick(&mut self, img: RgbaImage, scale: f32) -> TickResult {
        let (w, h) = (img.width() as usize, img.height() as usize);
        let res = |status, dy, fast, diag: String| TickResult { status, dy, fast, diag };
        match &self.lay {
            Some(l) if l.w != w || l.h != h => {
                return res(TickStatus::Idle, 0, false, format!("bỏ khung khác kích thước {w}x{h}"));
            }
            None => {
                if w < 32 || h < 64 {
                    return res(TickStatus::Idle, 0, false, "vùng chụp quá nhỏ".into());
                }
                self.lay = Some(Layout::new(w, h, scale.max(1.0)));
            }
            _ => {}
        }
        let lay = self.lay.clone().unwrap();
        self.next_id += 1;
        let frame = Arc::new(Frame::new(self.next_id, img, &lay));

        if self.history.is_empty() {
            self.last_raw = Some(frame.clone());
            self.start_over(frame, h);
            return res(TickStatus::First, 0, false, "khung đầu".into());
        }

        // `moved` so với nhịp trước (đo tốc độ); đứng yên thì so với khung tham chiếu
        // đã ghép — cuộn chậm vài px mỗi nhịp vẫn cộng dồn tới lúc được phân tích.
        let moved = self.last_raw.as_ref().map(|p| diff_frac(p, &frame, &lay)).unwrap_or(1.0);
        self.last_raw = Some(frame.clone());
        let newest = self.history.back().map(|a| a.frame.clone()).unwrap();
        if diff_frac(&newest, &frame, &lay) < STILL_FRAC {
            return res(TickStatus::Idle, 0, false, "đứng yên".into());
        }

        // Thử khung gần nhất, rồi lùi dần các khung cũ hơn, cuối cùng thử bỏ vùng trên/dưới.
        let n = self.history.len();
        let mut changed = 0.0f32;
        let mut best = 0.0f32;
        let mut attempts: Vec<(usize, bool)> = (0..n).rev().map(|i| (i, false)).collect();
        attempts.push((n - 1, true));
        for (idx, excl) in attempts {
            match analyze(&lay, &self.history[idx].frame, &frame, self.velocity, excl) {
                Analysis::Idle => {
                    return res(TickStatus::Idle, 0, false, format!("không cuộn (ref={})", n - 1 - idx));
                }
                Analysis::Fail { changed: ch, best: b } => {
                    if idx == n - 1 && !excl {
                        changed = ch;
                    }
                    best = best.max(b);
                }
                Analysis::Match(m) => return self.accept(&lay, idx, frame.clone(), &m),
            }
        }

        if !self.matched_once && self.strips.len() == 1 {
            // Chưa từng khớp (vd trang tự bật header khi vừa cuộn): lấy khung này làm mốc mới.
            self.start_over(frame, h);
            return res(TickStatus::Reanchored, -1, false, format!("đổi mốc (best={best:.2})"));
        }
        if changed < LOCAL_CHANGE && moved < 0.08 {
            return res(TickStatus::Idle, 0, false, format!("đổi cục bộ {:.0}%", changed * 100.0));
        }
        res(TickStatus::Lost, -1, moved >= 0.08, format!("mất dấu (best={best:.2} đổi={:.0}%)", changed * 100.0))
    }

    /// Ghép khung `cur` khớp với `history[idx]`; báo `Lost` nếu thiếu dòng (cuộn quá nhanh).
    fn accept(&mut self, lay: &Layout, idx: usize, cur: Arc<Frame>, m: &Match) -> TickResult {
        let h = lay.h;
        let dy = m.dy;
        let entry = &self.history[idx];
        let r = entry.frame.clone();
        // Sau rollback, strip cuối là strip của `entry` nếu chính khung đó đã ghép strip.
        let last_is_ref = entry.strips_len > 0 && self.strips[entry.strips_len - 1].frame_id == r.id;
        let last_use_h = entry.last_use_h;

        let fs = m.footer_stitch.max(self.footer_locked() + if self.footer_locked() > 0 { lay.px(14.0) } else { 0 });
        let target = h.saturating_sub(fs);
        let mut cb = entry.consumed_bottom;
        let mut trim = 0;
        if last_is_ref && cb > target {
            // Đáy strip của ref lẫn dòng footer vừa phát hiện → cắt bớt, khung mới bù lại phần nội dung.
            trim = (cb - target).min(last_use_h - 1);
            cb -= trim;
        }
        let header_guard = if m.header > 0 { m.header + lay.px(8.0) } else { 0 };
        let guard = header_guard.max(if m.excl { m.t } else { 0 });
        if cb < dy + guard {
            return TickResult {
                status: TickStatus::Lost,
                dy: dy as i32,
                fast: true,
                diag: format!("thiếu dòng: cb={cb} dy={dy} header={}", m.header),
            };
        }
        let s = cb - dy;
        let mut e = target;
        if m.excl {
            e = e.min(m.bot);
        }

        // Đường nối: lùi về dòng trơn gần nhất trong vùng chồng lấn để không cắt ngang chữ.
        let mut start = s;
        if e > s && last_is_ref {
            let max_back = lay.px(48.0).min(last_use_h - trim - 1).min(s - guard);
            for k in 0..=max_back {
                let y = s - k;
                if y + dy < h && cur.edges_masked(y, &m.mask) == 0 && row_same(lay, &cur, y, &r, y + dy, &m.mask) {
                    start = y;
                    break;
                }
            }
        }
        let back = s - start;

        // Áp dụng: rollback → cắt strip của ref → thêm strip mới.
        let rolled_back = idx + 1 < self.history.len();
        self.history.truncate(idx + 1);
        let entry = self.history.back_mut().unwrap();
        self.strips.truncate(entry.strips_len);
        if let Some(last) = self.strips.last_mut() {
            last.use_h = if last_is_ref { last_use_h - trim - back } else { entry.last_use_h };
            entry.last_use_h = last.use_h;
        }
        entry.consumed_bottom = cb - back;
        let dirty = self.canvas_h();
        self.mark_dirty(dirty);

        let cur_cb = if e > start {
            self.strips.push(Self::crop(&cur, start, e, true));
            e
        } else {
            start
        };
        let strips_len = self.strips.len();
        let last_use_h = self.strips.last().map(|s| s.use_h).unwrap_or(0);
        self.history.push_back(Accepted { frame: cur, consumed_bottom: cur_cb, strips_len, last_use_h });
        while self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }

        self.matched_once = true;
        self.velocity = if self.velocity == 0.0 { dy as f32 } else { self.velocity * 0.6 + dy as f32 * 0.4 };
        self.header_h = m.header;
        let tol = lay.px(4.0);
        let min_footer = lay.px(10.0);
        let fr = (m.footer_real >= min_footer).then_some(m.footer_real);
        // Lấy giá trị nhỏ hơn: phần đệm footer cố định thì ổn định, dải nền trang lỡ bị gộp vào thì co dần.
        self.footer.observe(fr, |a, b| a.abs_diff(*b) <= tol, |a, b| a.min(b));
        let side_agree = |a: &Side, b: &Side| {
            a.width.abs_diff(b.width) <= tol && (0..3).all(|k| (a.color[k] as i32 - b.color[k] as i32).abs() <= 12)
        };
        let newly_l = self.side_l.observe(m.side_l, side_agree, |a, _| a);
        let newly_r = self.side_r.observe(m.side_r, side_agree, |a, _| a);
        if (newly_l || newly_r) && self.extend_sidebar {
            self.mark_dirty(self.strips.first().map(|s| s.use_h).unwrap_or(0));
        }

        TickResult {
            status: TickStatus::Appended,
            dy: dy as i32,
            fast: false,
            diag: format!(
                "ghép dy={dy} sc={:.2} ref={}{}{} rows={}..{} hdr={} fs={} fr={} trim={trim} seam={back} sb=({:?},{:?})",
                m.score,
                if rolled_back { "lùi" } else { "mới" },
                if m.excl { " bỏ-biên" } else { "" },
                if e > start { "" } else { " (không dòng mới)" },
                start,
                e,
                m.header,
                fs,
                m.footer_real,
                m.side_l.map(|s| s.width),
                m.side_r.map(|s| s.width),
            ),
        }
    }

    /// Ghép thẳng khung mới nhất (kể cả khi đang mất dấu) — nút "Nối tiếp".
    pub fn bridge(&mut self) -> bool {
        let Some(lay) = self.lay.clone() else { return false };
        let Some(f) = self.last_raw.clone() else { return false };
        if self.strips.is_empty() || self.history.back().map(|a| a.frame.id) == Some(f.id) {
            return false;
        }
        let start = self.header_h.min(lay.h - 1);
        let at = self.canvas_h();
        self.strips.push(Self::crop(&f, start, lay.h, true));
        self.history = VecDeque::from([Accepted {
            frame: f,
            consumed_bottom: lay.h,
            strips_len: self.strips.len(),
            last_use_h: lay.h - start,
        }]);
        self.velocity = 0.0;
        self.mark_dirty(at);
        true
    }

    fn side_fill(&self) -> (Option<Side>, Option<Side>) {
        if !self.extend_sidebar {
            return (None, None);
        }
        (self.side_l.locked, self.side_r.locked)
    }

    /// Các đoạn (ảnh, y0, y1, có tô sidebar) tạo nên ảnh ghép, kèm phần đuôi khi hoàn tất.
    fn segments(&self, with_tail: bool) -> Vec<(&RgbaImage, usize, usize, bool)> {
        let mut segs: Vec<(&RgbaImage, usize, usize, bool)> =
            self.strips.iter().map(|s| (&s.img, 0, s.use_h, s.fillable)).collect();
        if with_tail {
            if let (Some(last), Some(lay)) = (self.history.back(), &self.lay) {
                let h = lay.h;
                let footer = self.footer_locked();
                let mid = h - footer.min(h);
                let end = if self.pin_footer { h } else { mid };
                let a = last.consumed_bottom;
                if mid > a {
                    segs.push((&*last.frame.img, a, mid, true));
                }
                if end > mid.max(a) {
                    segs.push((&*last.frame.img, mid.max(a), end, false));
                }
            }
        }
        segs
    }

    fn write_row(img: &RgbaImage, y: usize, fill: (Option<Side>, Option<Side>), fillable: bool, out: &mut [u8]) {
        let bpr = img.width() as usize * 4;
        out.copy_from_slice(&img.as_raw()[y * bpr..(y + 1) * bpr]);
        if fillable {
            if let Some(s) = fill.0 {
                for px in out[..s.width * 4].chunks_exact_mut(4) {
                    px.copy_from_slice(&s.color);
                }
            }
            if let Some(s) = fill.1 {
                let from = bpr - s.width * 4;
                for px in out[from..].chunks_exact_mut(4) {
                    px.copy_from_slice(&s.color);
                }
            }
        }
    }

    /// Chiều cao ảnh cuối nếu hoàn tất ngay bây giờ.
    pub fn final_height(&self) -> usize {
        self.segments(true).iter().map(|s| s.2 - s.1).sum()
    }

    /// Dựng ảnh ghép cuối cùng.
    pub fn finalize(&self) -> Option<RgbaImage> {
        let lay = self.lay.as_ref()?;
        let segs = self.segments(true);
        let total: usize = segs.iter().map(|s| s.2 - s.1).sum();
        if total == 0 {
            return None;
        }
        let bpr = lay.w * 4;
        let mut out = vec![0u8; total * bpr];
        let fill = self.side_fill();
        let mut y = 0;
        for (img, y0, y1, fillable) in segs {
            for sy in y0..y1 {
                Self::write_row(img, sy, fill, fillable, &mut out[y * bpr..(y + 1) * bpr]);
                y += 1;
            }
        }
        RgbaImage::from_raw(lay.w as u32, total as u32, out)
    }

    /// Ảnh preview thu nhỏ về bề rộng `pw` cho phần đã đổi kể từ lần gọi trước.
    pub fn take_preview(&mut self, pw: usize) -> Preview {
        let Some(lay) = self.lay.clone() else {
            return Preview { width: pw.max(1) as u32, from_row: 0, total_rows: 0, rgba: Vec::new() };
        };
        let w = lay.w;
        let pw = pw.clamp(1, w);
        let total = self.canvas_h();
        let from = self.dirty_from.take().unwrap_or(total).min(total);
        let py = |y: usize| y * pw / w;
        let (pf, pt) = (py(from), py(total));
        let mut rgba = Vec::with_capacity((pt - pf) * pw * 4);
        if pt > pf {
            let fill = self.side_fill();
            let segs = self.segments(false);
            let xmap: Vec<usize> = (0..w).map(|x| x * pw / w).collect();
            let mut acc = vec![0u32; pw * 4];
            let mut cnt = vec![0u32; pw];
            let mut row = vec![0u8; w * 4];
            // Con trỏ tuần tự qua các đoạn.
            let mut seg_i = 0;
            let mut seg_start = 0;
            for oy in pf..pt {
                let sy0 = (oy * w).div_ceil(pw);
                let sy1 = ((oy + 1) * w).div_ceil(pw).min(total).max(sy0 + 1);
                acc.iter_mut().for_each(|v| *v = 0);
                cnt.iter_mut().for_each(|v| *v = 0);
                for y in sy0..sy1.min(total) {
                    while seg_i < segs.len() && y >= seg_start + (segs[seg_i].2 - segs[seg_i].1) {
                        seg_start += segs[seg_i].2 - segs[seg_i].1;
                        seg_i += 1;
                    }
                    if seg_i >= segs.len() {
                        break;
                    }
                    let (img, y0, _, fillable) = segs[seg_i];
                    Self::write_row(img, y0 + y - seg_start, fill, fillable, &mut row);
                    for x in 0..w {
                        let ox = xmap[x];
                        cnt[ox] += 1;
                        for k in 0..4 {
                            acc[ox * 4 + k] += row[x * 4 + k] as u32;
                        }
                    }
                }
                for ox in 0..pw {
                    let n = cnt[ox].max(1);
                    for k in 0..4 {
                        rgba.push((acc[ox * 4 + k] / n) as u8);
                    }
                }
            }
        }
        Preview { width: pw as u32, from_row: pf as u32, total_rows: pt as u32, rgba }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn range(&mut self, a: usize, b: usize) -> usize {
            a + (self.next() % (b - a) as u64) as usize
        }
    }

    const W: usize = 320;
    const VH: usize = 300;
    const WHITE: [u8; 4] = [255, 255, 255, 255];

    fn put(img: &mut RgbaImage, x: usize, y: usize, c: [u8; 4]) {
        img.put_pixel(x as u32, y as u32, image::Rgba(c));
    }

    /// Trang dài giả lập: dòng "chữ" (nét dọc ngẫu nhiên), khối ảnh, khoảng trắng dài.
    fn make_page(h: usize, seed: u64, blank_from: Option<(usize, usize)>) -> RgbaImage {
        let mut rng = Rng(seed);
        let mut img = RgbaImage::from_pixel(W as u32, h as u32, image::Rgba(WHITE));
        let mut y = 4;
        while y + 40 < h {
            if let Some((a, b)) = blank_from {
                if y >= a && y < b {
                    y = b;
                    continue;
                }
            }
            match rng.range(0, 10) {
                0 => {
                    // Khối ảnh có hoạ tiết.
                    let bh = rng.range(30, 90).min(h - y - 1);
                    let (x0, x1) = (rng.range(4, 60), rng.range(200, W - 4));
                    let base = rng.range(40, 200) as u8;
                    for yy in y..y + bh {
                        for x in x0..x1 {
                            let v = base.wrapping_add(((x * 7 + yy * 13) % 50) as u8);
                            put(&mut img, x, yy, [v, v / 2, 255 - v, 255]);
                        }
                    }
                    y += bh + rng.range(6, 20);
                }
                1 => y += rng.range(20, 60),
                _ => {
                    let lh = rng.range(14, 26);
                    let mut x = rng.range(4, 20);
                    while x + 10 < W - 4 {
                        let ww = rng.range(8, 50).min(W - 4 - x);
                        for xx in x..x + ww {
                            if rng.range(0, 3) == 0 {
                                let top = y + rng.range(2, 5);
                                let bot = y + lh - rng.range(2, 5);
                                for yy in top..bot {
                                    put(&mut img, xx, yy, [30, 30, 40, 255]);
                                }
                            }
                        }
                        x += ww + rng.range(4, 10);
                    }
                    y += lh;
                }
            }
        }
        img
    }

    #[derive(Clone, Copy, Default)]
    struct Fixed {
        header: usize,
        footer: usize,
        left: usize,
        right: usize,
    }

    const SIDE_BG: [u8; 4] = [236, 240, 246, 255];

    fn viewport(page: &RgbaImage, scroll: usize, fx: Fixed) -> RgbaImage {
        let mut img = RgbaImage::new(W as u32, VH as u32);
        for y in 0..VH {
            for x in 0..W {
                put(&mut img, x, y, page.get_pixel(x as u32, (scroll + y) as u32).0);
            }
        }
        let mut rng = Rng(99);
        for y in 0..fx.header {
            for x in 0..W {
                let ink = y > 6 && y + 6 < fx.header && (x * 31 + y * 17) % 11 < 3;
                put(&mut img, x, y, if ink { [250, 250, 250, 255] } else { [40, 60, 120, 255] });
            }
        }
        for y in VH - fx.footer..VH {
            for x in 0..W {
                let ink = y > VH - fx.footer + 6 && y + 4 < VH && (x * 13 + y * 7) % 9 < 2;
                put(&mut img, x, y, if ink { [20, 20, 20, 255] } else { [225, 228, 232, 255] });
            }
        }
        let side = |img: &mut RgbaImage, x0: usize, x1: usize, border: usize, rng: &mut Rng| {
            for y in fx.header..VH - fx.footer {
                for x in x0..x1 {
                    put(img, x, y, if x == border { [180, 185, 195, 255] } else { SIDE_BG });
                }
            }
            // Icon/chữ trong sidebar.
            let mut y = fx.header + 10;
            while y + 16 < VH - fx.footer {
                let ix = x0 + rng.range(6, 14);
                for yy in y..y + 10 {
                    for xx in ix..(ix + rng.range(12, 30)).min(x1 - 4) {
                        if (xx + yy) % 3 != 0 {
                            put(img, xx, yy, [60, 70, 90, 255]);
                        }
                    }
                }
                y += 28;
            }
        };
        if fx.left > 0 {
            side(&mut img, 0, fx.left, fx.left - 1, &mut rng);
        }
        if fx.right > 0 {
            side(&mut img, W - fx.right, W, W - fx.right, &mut rng);
        }
        img
    }

    fn run(page: &RgbaImage, scrolls: &[usize], fx: Fixed) -> Session {
        let mut s = Session::new();
        for &sc in scrolls {
            let r = s.tick(viewport(page, sc, fx), 1.0);
            println!("scroll={sc} {:?} {}", r.status, r.diag);
        }
        s
    }

    /// So các cột nội dung (ngoài sidebar) của ảnh ghép với trang gốc từ dòng `from`.
    fn assert_content(out: &RgbaImage, page: &RgbaImage, from: usize, to: usize, fx: Fixed) {
        for y in from..to {
            for x in fx.left..W - fx.right {
                let (a, b) = (out.get_pixel(x as u32, y as u32), page.get_pixel(x as u32, y as u32));
                assert_eq!(a, b, "lệch tại x={x} y={y}");
            }
        }
    }

    fn steps(seq: &[usize]) -> Vec<usize> {
        let mut v = vec![0];
        let mut acc = 0;
        for &d in seq {
            acc += d;
            v.push(acc);
        }
        v
    }

    #[test]
    fn plain_scroll_various_speeds() {
        let page = make_page(3000, 7, None);
        let scrolls = steps(&[2, 1, 7, 7, 0, 33, 120, 3, 200, 250, 0, 0, 60, 245, 18, 90]);
        let s = run(&page, &scrolls, Fixed::default());
        let out = s.finalize().unwrap();
        let last = *scrolls.last().unwrap();
        assert_eq!(out.height() as usize, last + VH);
        assert_content(&out, &page, 0, last + VH, Fixed::default());
    }

    #[test]
    fn header_and_footer_fixed() {
        let page = make_page(3000, 11, None);
        let fx = Fixed { header: 40, footer: 36, ..Default::default() };
        let scrolls = steps(&[10, 40, 80, 5, 150, 100, 30, 170]);
        let mut s = run(&page, &scrolls, fx);
        assert!(s.footer_locked().abs_diff(36) <= 4, "footer={}", s.footer_locked());
        let last = *scrolls.last().unwrap();

        s.set_options(false, true);
        let out = s.finalize().unwrap();
        assert_eq!(out.height() as usize, last + VH - s.footer_locked());
        assert_content(&out, &page, fx.header, last + VH - fx.footer, fx);
        // Header xuất hiện đúng 1 lần ở đầu.
        assert_eq!(out.get_pixel(0, 0).0, [40, 60, 120, 255]);

        s.set_options(true, true);
        let out = s.finalize().unwrap();
        assert_eq!(out.height() as usize, last + VH);
        assert_eq!(out.get_pixel(0, out.height() - 2).0, [225, 228, 232, 255]);
    }

    #[test]
    fn footer_appears_midway() {
        let page = make_page(3000, 5, None);
        let scrolls = steps(&[20, 30, 25, 40, 30, 35, 20, 50]);
        let mut s = Session::new();
        for (i, &sc) in scrolls.iter().enumerate() {
            let fx = Fixed { footer: if i >= 4 { 50 } else { 0 }, ..Default::default() };
            let r = s.tick(viewport(&page, sc, fx), 1.0);
            println!("{i} scroll={sc} {:?} {}", r.status, r.diag);
            assert_ne!(r.status, TickStatus::Lost);
        }
        assert_eq!(s.footer_locked(), 50);
        s.set_options(false, true);
        let out = s.finalize().unwrap();
        let last = *scrolls.last().unwrap();
        assert_eq!(out.height() as usize, last + VH - 50);
        assert_content(&out, &page, 0, last + VH - 50, Fixed::default());
    }

    #[test]
    fn header_appears_after_first_scroll() {
        let page = make_page(3000, 21, None);
        let scrolls = steps(&[20, 30, 40, 25, 60]);
        let mut s = Session::new();
        for (i, &sc) in scrolls.iter().enumerate() {
            let fx = Fixed { header: if i >= 1 { 44 } else { 0 }, ..Default::default() };
            let r = s.tick(viewport(&page, sc, fx), 1.0);
            println!("{i} scroll={sc} {:?} {}", r.status, r.diag);
        }
        let out = s.finalize().unwrap();
        let last = *scrolls.last().unwrap();
        assert_eq!(out.height() as usize, last + VH);
        assert_content(&out, &page, 0, last + VH, Fixed::default());
    }

    #[test]
    fn sidebars_left_and_right() {
        let page = make_page(3000, 3, None);
        let fx = Fixed { header: 30, left: 60, right: 70, ..Default::default() };
        let scrolls = steps(&[30, 40, 60, 20, 90, 50]);
        let s = run(&page, &scrolls, fx);
        assert_eq!(s.side_l.locked.map(|s| s.width), Some(60));
        assert_eq!(s.side_r.locked.map(|s| s.width), Some(70));
        let out = s.finalize().unwrap();
        let last = *scrolls.last().unwrap();
        assert_eq!(out.height() as usize, last + VH);
        assert_content(&out, &page, fx.header, last + VH, fx);
        let y = out.height() - 5;
        assert_eq!(out.get_pixel(10, y).0, SIDE_BG);
        assert_eq!(out.get_pixel(W as u32 - 10, y).0, SIDE_BG);
    }

    #[test]
    fn long_blank_area_is_not_footer() {
        let page = make_page(3000, 13, Some((400, 640)));
        let scrolls = steps(&[30, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
        let s = run(&page, &scrolls, Fixed::default());
        assert_eq!(s.footer_locked(), 0);
        let out = s.finalize().unwrap();
        let last = *scrolls.last().unwrap();
        assert_eq!(out.height() as usize, last + VH);
        assert_content(&out, &page, 0, last + VH, Fixed::default());
    }

    #[test]
    fn too_fast_is_lost_then_bridge() {
        let page = make_page(4000, 17, None);
        let mut s = Session::new();
        s.tick(viewport(&page, 0, Fixed::default()), 1.0);
        assert_eq!(s.tick(viewport(&page, 50, Fixed::default()), 1.0).status, TickStatus::Appended);
        let r = s.tick(viewport(&page, 50 + 2 * VH, Fixed::default()), 1.0);
        assert_eq!(r.status, TickStatus::Lost);
        assert_eq!(s.canvas_h(), 50 + VH);
        assert!(s.bridge());
        assert_eq!(s.canvas_h(), 50 + VH + VH);
        assert_eq!(s.tick(viewport(&page, 50 + 2 * VH + 40, Fixed::default()), 1.0).status, TickStatus::Appended);
    }

    #[test]
    fn unrelated_frame_is_rejected() {
        let p1 = make_page(1000, 1, None);
        let p2 = make_page(1000, 2, None);
        let mut s = Session::new();
        s.tick(viewport(&p1, 0, Fixed::default()), 1.0);
        s.tick(viewport(&p1, 30, Fixed::default()), 1.0);
        let r = s.tick(viewport(&p2, 0, Fixed::default()), 1.0);
        assert_eq!(r.status, TickStatus::Lost);
        assert_eq!(s.canvas_h(), 30 + VH);
    }

    #[test]
    fn lazy_load_rolls_back() {
        let page = make_page(3000, 29, None);
        let mut s = Session::new();
        for sc in [0, 40, 80] {
            s.tick(viewport(&page, sc, Fixed::default()), 1.0);
        }
        // Khung có placeholder xám ở phần nội dung mới (chưa tải xong ảnh).
        let mut ph = viewport(&page, 140, Fixed::default());
        for y in VH - 90..VH {
            for x in 0..W {
                put(&mut ph, x, y, [200, 200, 200, 255]);
            }
        }
        let r = s.tick(ph, 1.0);
        println!("{:?} {}", r.status, r.diag);
        for sc in [170, 210, 260] {
            let r = s.tick(viewport(&page, sc, Fixed::default()), 1.0);
            println!("{sc} {:?} {}", r.status, r.diag);
        }
        let out = s.finalize().unwrap();
        assert_eq!(out.height() as usize, 260 + VH);
        assert_content(&out, &page, 0, 260 + VH, Fixed::default());
    }

    #[test]
    fn vertical_table_lines_are_not_footer() {
        // Trang có bảng chỉ kẻ dọc ở nửa dưới: các dòng kẻ dọc giống tại chỗ khi cuộn.
        let mut page = make_page(3000, 41, Some((300, 1500)));
        for y in 300..1500 {
            for x in (20..W - 20).step_by(40) {
                put(&mut page, x, y, [120, 120, 120, 255]);
            }
            if y % 90 == 0 {
                for x in 20..W - 20 {
                    put(&mut page, x, y, [120, 120, 120, 255]);
                }
            }
        }
        // Chữ trong ô (bảng thật không tuần hoàn tuyệt đối); giữa các dòng chữ chỉ còn kẻ dọc.
        let mut rng = Rng(5);
        for row in (300..1500).step_by(90) {
            for cell in (20..W - 60).step_by(40) {
                let (x0, y0) = (cell + 6, row + rng.range(10, 60));
                for xx in x0..x0 + rng.range(8, 28) {
                    if rng.range(0, 2) == 0 {
                        for yy in y0..y0 + 10 {
                            put(&mut page, xx, yy, [30, 30, 40, 255]);
                        }
                    }
                }
            }
        }
        let scrolls = steps(&[20, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40]);
        let s = run(&page, &scrolls, Fixed::default());
        assert_eq!(s.footer_locked(), 0);
        let out = s.finalize().unwrap();
        let last = *scrolls.last().unwrap();
        assert_eq!(out.height() as usize, last + VH);
        assert_content(&out, &page, 0, last + VH, Fixed::default());
    }

    #[test]
    fn noise_and_floating_widget_still_track() {
        let page = make_page(3000, 37, None);
        let scrolls = steps(&[12, 30, 45, 8, 70, 110, 25, 90]);
        let mut s = Session::new();
        let mut rng = Rng(1234);
        for (i, &sc) in scrolls.iter().enumerate() {
            let mut f = viewport(&page, sc, Fixed::default());
            // Nhiễu ±6/kênh (sai khác nén/scale khi chụp) + nút chat nổi đổi màu mỗi khung.
            for p in f.pixels_mut() {
                for k in 0..3 {
                    p.0[k] = (p.0[k] as i32 + rng.range(0, 13) as i32 - 6).clamp(0, 255) as u8;
                }
            }
            let col = [rng.range(0, 255) as u8, 80, 200, 255];
            for y in 240..270 {
                for x in 260..290 {
                    put(&mut f, x, y, col);
                }
            }
            let r = s.tick(f, 1.0);
            println!("{i} scroll={sc} {:?} {}", r.status, r.diag);
            assert!(matches!(r.status, TickStatus::First | TickStatus::Appended), "{}", r.diag);
        }
        assert_eq!(s.finalize().unwrap().height() as usize, *scrolls.last().unwrap() + VH);
    }

    /// Đo thời gian 1 nhịp ở kích thước thật (Retina ~1800×1600): `cargo test --release perf -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_large_frames() {
        let (fw, fh) = (1800usize, 1600usize);
        let mut page = RgbaImage::from_pixel(fw as u32, 8000, image::Rgba(WHITE));
        let mut rng = Rng(77);
        for y in (0..7990).step_by(24) {
            let mut x = 20;
            while x + 60 < fw {
                let ww = rng.range(20, 120).min(fw - 20 - x);
                for xx in x..x + ww {
                    if rng.range(0, 3) == 0 {
                        for yy in y + 4..y + 18 {
                            put(&mut page, xx, yy, [30, 30, 40, 255]);
                        }
                    }
                }
                x += ww + rng.range(8, 20);
            }
        }
        let crop = |sc: usize| image::imageops::crop_imm(&page, 0, sc as u32, fw as u32, fh as u32).to_image();
        let mut s = Session::new();
        s.tick(crop(0), 2.0);
        let mut sc = 0;
        for d in [40, 120, 300, 700, 1100, 15, 2, 2, 2, 2, 2, 2] {
            sc += d;
            let f = crop(sc);
            let t0 = std::time::Instant::now();
            let r = s.tick(f, 2.0);
            let ms = t0.elapsed().as_millis();
            let t1 = std::time::Instant::now();
            let _ = s.take_preview(600);
            println!("dy={d} {:?} tick={ms}ms preview={}ms {}", r.status, t1.elapsed().as_millis(), r.diag);
            assert_ne!(r.status, TickStatus::Lost);
        }
        let out = s.finalize().unwrap();
        assert_eq!(out.height() as usize, sc + fh);
        assert_eq!(out.as_raw()[..], crop_full(&page, sc + fh)[..]);
    }

    fn crop_full(page: &RgbaImage, h: usize) -> Vec<u8> {
        image::imageops::crop_imm(page, 0, 0, page.width(), h as u32).to_image().into_raw()
    }

    #[test]
    fn preview_matches_canvas_height() {
        let page = make_page(2000, 31, None);
        let mut s = Session::new();
        for sc in [0, 50, 120] {
            s.tick(viewport(&page, sc, Fixed::default()), 1.0);
        }
        let p = s.take_preview(160);
        assert_eq!(p.width, 160);
        assert_eq!(p.from_row, 0);
        assert_eq!(p.total_rows as usize, (120 + VH) * 160 / W);
        assert_eq!(p.rgba.len(), p.total_rows as usize * 160 * 4);
        // Không có thay đổi → không trả dòng nào.
        let p2 = s.take_preview(160);
        assert!(p2.rgba.is_empty());
    }
}
