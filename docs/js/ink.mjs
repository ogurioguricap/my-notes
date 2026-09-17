/**
 * 手写标注与编辑层（对齐「手账 App / GoodNotes」的编辑手感）
 *
 * 能做什么（对照手账 App 的编辑功能）：
 *   1. 画笔 / 荧光笔：自由手写；荧光笔自动拉直；笔宽随书写速度微调
 *   2. 橡皮两种模式：整笔擦除（默认）/ 像素擦除（只擦路径经过的一段，会把一笔切成两笔）
 *   3. 套索选择：圈选或点选对象 → 整体拖动 / 角点缩放 / 旋转柄旋转 / 批量改色改粗细 / 复制 / 删除
 *   4. 形状工具：自动识别直线、箭头、矩形、椭圆、三角形，也可指定形状（下拉选择）
 *   5. 文本框：原位编辑、多行、可拖动缩放、字号与颜色
 *   6. 图片：本地选图插入（转成 data URL 存进标注文件，随仓库走）
 *   7. 撤销 / 重做：不限次的完整历史栈（默认保留 200 步）
 *      · 按钮：↶ / ↷（不可用时置灰）
 *      · 键盘：Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl+Y
 *      · 手势：双指轻点 = 撤销，三指轻点 = 重做（触屏，和手账 App 一致）
 *      · 每一步都有名字，撤销时提示「撤销：擦除 3 笔」
 *   8. 剪贴板：Ctrl+C / X / V / D（原地复制并偏移），Ctrl+A 全选，Delete 删除
 *   9. 清空这一页也能撤销（不会一点就没了）
 *
 * 设计要点：
 * 1. 坐标一律存成「相对正文宽/高的 0~1 比例」，手机、平板、电脑上都会正确缩放
 * 2. 数据落盘：content/ink/<slug>.json（并在 docs/ink/ 放一份，线上立即可用）
 *      v2：{ "version": 2, "updatedAt": "...", "items": [ 笔画 / 形状 / 文本 / 图片 ] }
 *      v1：{ "version": 1, "strokes": [...] }   ← 老文件照常读得进来（自动升级）
 * 3. 撤销基于「操作前快照」，所有编辑动作走同一条路径，不会漏掉某类操作
 * 4. 与渲染无关的几何 / 识别 / 擦除 / 变换都写成纯函数并导出，方便无浏览器环境下测试
 */

/* ============================ 常量 ============================ */

export const PALETTE = [
  { id: 'red', pen: '#E8452F', ink: 'rgba(232,69,47,.28)', label: '红' },
  { id: 'blue', pen: '#2F6FE8', ink: 'rgba(47,111,232,.26)', label: '蓝' },
  { id: 'green', pen: '#12A05C', ink: 'rgba(18,160,92,.26)', label: '绿' },
  { id: 'amber', pen: '#E8A33D', ink: 'rgba(232,163,61,.30)', label: '黄' },
  { id: 'purple', pen: '#8B5CF6', ink: 'rgba(139,92,246,.26)', label: '紫' },
  { id: 'ink', pen: '#2B2723', ink: 'rgba(43,39,35,.24)', label: '墨' },
];

export const WIDTHS = [
  { id: 'thin', label: '细', pen: 0.0022, highlighter: 0.020 },
  { id: 'medium', label: '中', pen: 0.0038, highlighter: 0.032 },
  { id: 'thick', label: '粗', pen: 0.0062, highlighter: 0.048 },
];

export const ERASER_SIZES = [
  { id: 's', label: '小', px: 12 },
  { id: 'm', label: '中', px: 22 },
  { id: 'l', label: '大', px: 36 },
];

export const SHAPE_KINDS = [
  { id: 'auto', label: '自动', glyph: '✨' },
  { id: 'line', label: '直线', glyph: '╱' },
  { id: 'arrow', label: '箭头', glyph: '➚' },
  { id: 'rect', label: '矩形', glyph: '▭' },
  { id: 'ellipse', label: '椭圆', glyph: '◯' },
  { id: 'triangle', label: '三角', glyph: '△' },
];

export const TEXT_SIZES = [
  { id: 's', label: '小', value: 0.016 },
  { id: 'm', label: '中', value: 0.023 },
  { id: 'l', label: '大', value: 0.032 },
];

export const TOOLS = ['pen', 'highlighter', 'eraser', 'lasso', 'shape', 'text'];
export const MAX_HISTORY = 200;
export const TEXT_FONT = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SELECT_ACCENT = '#2F6FE8';

const SHAPE_IDS = SHAPE_KINDS.map((s) => s.id);
const uid_counter = { n: 0 };

/* ============================ 小工具 ============================ */

/** 稳定唯一的对象 id（笔画 / 文本 / 图片都用它，撤销栈靠它认对象） */
export function uid(prefix = 'i') {
  uid_counter.n = (uid_counter.n + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${uid_counter.n.toString(36)}`;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 比例坐标夹到 0~1（容一点溢出，避免贴边时点被反复挤压） */
export function clamp01(v, pad = 0) {
  const n = num(v, 0);
  return Math.min(1 + pad, Math.max(-pad, n));
}

/** 深拷贝对象列表（优先 structuredClone，退回 JSON 往返） */
export function cloneItems(items) {
  const arr = Array.isArray(items) ? items : [];
  if (typeof structuredClone === 'function') {
    try { return structuredClone(arr); } catch (e) { /* 含不可克隆值 → 退回 JSON */ }
  }
  try { return JSON.parse(JSON.stringify(arr)); } catch (e) { return arr.slice(); }
}

/* ============================ 几何（纯函数） ============================ */

export function bboxOfPoints(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points || []) {
    const x = num(p && p[0]), y = num(p && p[1]);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < (points || []).length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return len;
}

/** 点到线段的距离（像素空间） */
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer–Douglas–Peucker 简化：用来数「这条线拐了几个弯」 */
export function simplifyPath(points, eps) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length <= 2) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bestD = eps;
    for (let k = i + 1; k < j; k++) {
      const d = distanceToSegment(pts[k][0], pts[k][1], pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
      if (d > bestD) { bestD = d; best = k; }
    }
    if (best > 0) { keep[best] = true; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 射线法：点是否在多边形内（套索圈选靠它） */
export function pointInPolygon(poly, x, y) {
  const pts = poly || [];
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** 估算文本占位（中文字宽≈1em、西文≈0.55em），不依赖 canvas 量文字，纯函数可测 */
export function estimateTextSize(text, size) {
  const s = num(size, 0.023);
  const lines = String(text == null ? '' : text).split('\n');
  let widest = 1;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) {
      if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) w += 1;
      else if (ch === ' ') w += 0.32;
      else w += 0.56;
    }
    widest = Math.max(widest, w);
  }
  return { w: widest * s, h: Math.max(1, lines.length) * s * 1.36 + s * 0.24 };
}

/** 对象的比例包围盒 */
export function itemBounds(item) {
  if (!item) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  if (item.kind === 'text') {
    const s = estimateTextSize(item.text, item.size);
    return { x0: num(item.x), y0: num(item.y), x1: num(item.x) + s.w, y1: num(item.y) + s.h };
  }
  if (item.kind === 'image') {
    return { x0: num(item.x), y0: num(item.y), x1: num(item.x) + num(item.w), y1: num(item.y) + num(item.h) };
  }
  const b = bboxOfPoints(item.points);
  const pad = num(item.width, 0) / 2;
  return { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
}

export function boundsOfItems(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of list) {
    const b = itemBounds(it);
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}

/** 把对象转成折线（形状按几何展开），命中检测 / 圈选 / 绘制共用同一份几何 */
export function itemPolyline(item) {
  const pts = (item && item.points ? item.points : []).map((p) => [num(p && p[0]), num(p && p[1])]);
  if (!item || item.kind !== 'stroke' || !item.shape || item.shape === 'line' || item.shape === 'arrow') return pts;
  const b = bboxOfPoints(pts);
  if (item.shape === 'rect') {
    return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x0, b.y0]];
  }
  if (item.shape === 'triangle') {
    const cx = (b.x0 + b.x1) / 2;
    return [[cx, b.y0], [b.x1, b.y1], [b.x0, b.y1], [cx, b.y0]];
  }
  if (item.shape === 'ellipse') {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const rx = (b.x1 - b.x0) / 2, ry = (b.y1 - b.y0) / 2;
    const out = [];
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    return out;
  }
  return pts;
}

/** 采样点（圈选判定用）：笔画取路径点，文本 / 图片取包围盒 9 点 */
export function itemSamplePoints(item, max = 24) {
  if (!item) return [];
  if (item.kind === 'text' || item.kind === 'image') {
    const b = itemBounds(item);
    const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
    return [[b.x0, b.y0], [mx, b.y0], [b.x1, b.y0], [b.x0, my], [mx, my], [b.x1, my], [b.x0, b.y1], [mx, b.y1], [b.x1, b.y1]];
  }
  const line = itemPolyline(item);
  if (line.length <= max) return line;
  const step = Math.ceil(line.length / max);
  const out = [];
  for (let i = 0; i < line.length; i += step) out.push(line[i]);
  if (out[out.length - 1] !== line[line.length - 1]) out.push(line[line.length - 1]);
  return out;
}

function polylineHit(line, x, y, W, H, tolPx) {
  if (!line || !line.length) return false;
  if (line.length === 1) return Math.hypot((line[0][0] - x) * W, (line[0][1] - y) * H) <= tolPx;
  for (let i = 1; i < line.length; i++) {
    const d = distanceToSegment(x * W, y * H, line[i - 1][0] * W, line[i - 1][1] * H, line[i][0] * W, line[i][1] * H);
    if (d <= tolPx) return true;
  }
  return false;
}

/**
 * 命中检测：点是否落在某个对象上
 * opts.tolPx 容差像素；opts.inside 闭合形状「点在内部」也算命中（点选时用）
 */
export function hitTestItem(item, x, y, W, H, opts = {}) {
  const o = typeof opts === 'number' ? { tolPx: opts } : (opts || {});
  if (!item) return false;
  const tol = o.tolPx == null ? 8 : o.tolPx;
  const b = itemBounds(item);
  const padX = 8 / Math.max(1, W), padY = 8 / Math.max(1, H);
  if (x < b.x0 - padX || x > b.x1 + padX || y < b.y0 - padY || y > b.y1 + padY) return false;
  if (item.kind === 'text' || item.kind === 'image') return true; // 落在框里即算选中
  const line = itemPolyline(item);
  const lineW = num(item.width, 0) * Math.max(1, W);
  if (polylineHit(line, x, y, W, H, tol + lineW / 2)) return true;
  if (o.inside && (item.shape === 'rect' || item.shape === 'ellipse' || item.shape === 'triangle')) {
    return pointInPolygon(line, x, y);
  }
  return false;
}

/** 套索圈选：多数采样点落在圈内即算选中 */
export function polygonSelectsItem(poly, item, opts = {}) {
  const pts = itemSamplePoints(item);
  if (!pts.length) return false;
  const inside = pts.filter((p) => pointInPolygon(poly, p[0], p[1])).length;
  if (inside / pts.length >= (opts.threshold == null ? 0.55 : opts.threshold)) return true;
  const b = itemBounds(item);
  return pointInPolygon(poly, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) && inside > 0;
}

/* ============================ 形状识别 ============================ */

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 按弧长均匀重采样（手写点疏密不一，先拉齐再判断） */
export function resamplePath(points, n = 48) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length < 2) return pts.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return pts.slice();
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total;
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1e-9;
    const t = Math.min(1, Math.max(0, (target - cum[j]) / seg));
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t]);
  }
  return out;
}

/** 轻微平滑（去掉手抖造成的小尖刺，免得数出假拐角） */
export function smoothPath(points, passes = 1) {
  let pts = (points || []).slice();
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 3) break;
    const next = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      next.push([(pts[i - 1][0] + pts[i][0] * 2 + pts[i + 1][0]) / 4, (pts[i - 1][1] + pts[i][1] * 2 + pts[i + 1][1]) / 4]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/**
 * 数「这条闭合路径拐了几个明显的弯」——转角法：
 * 圆 / 椭圆每步转角都很小 → 0 个角；矩形 4 个；三角形 3 个。
 */
export function countCorners(points, minAngle = 0.62) {
  const pts = points || [];
  const n = pts.length;
  if (n < 4) return 0;
  const hit = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const d = angleDiff(Math.atan2(c[1] - b[1], c[0] - b[0]), Math.atan2(b[1] - a[1], b[0] - a[0]));
    hit.push(Math.abs(d) >= minAngle);
  }
  let runs = 0;
  for (let i = 0; i < n; i++) if (hit[i] && !hit[(i - 1 + n) % n]) runs++;
  return runs;
}

/** 归一化半径的离散度：越接近 0 越像个圆 */
export function roundnessOf(points, b) {
  const box = b || bboxOfPoints(points);
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const rx = Math.max(1e-6, (box.x1 - box.x0) / 2), ry = Math.max(1e-6, (box.y1 - box.y0) / 2);
  let sum = 0, sum2 = 0, n = 0;
  for (const p of points || []) {
    const r = Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry);
    sum += r; sum2 += r * r; n++;
  }
  if (!n) return 1;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return std / Math.max(1e-6, mean);
}

/**
 * 手绘轨迹 → 规整形状
 * 返回 { shape, points } 或 null（没识别出 / 太小 / 本来就是自由手写）
 *   line / arrow  → points = [起点, 终点]
 *   rect / ellipse / triangle → points = [包围盒对角两点]
 */
export function recognizeShape(points, opts = {}) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [num(p[0]), num(p[1])]);
  if (pts.length < 3) return null;
  const b = bboxOfPoints(pts);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const diag = Math.hypot(bw, bh);
  if (diag < (opts.minSize == null ? 0.02 : opts.minSize)) return null;

  const first = pts[0], last = pts[pts.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
  const closed = gap < Math.max(diag * 0.22, 0.012);

  if (!closed) {
    const pathLen = polylineLength(pts);
    const straightness = pathLen / Math.max(1e-6, gap);
    if (straightness <= (opts.lineTolerance == null ? 1.12 : opts.lineTolerance)) {
      return { shape: opts.shape === 'arrow' ? 'arrow' : 'line', points: [first, last] };
    }
    return null;
  }

  const clean = smoothPath(resamplePath(pts, 48), 1);
  const corners = countCorners(clean, opts.cornerAngle == null ? 0.62 : opts.cornerAngle);
  const roundness = roundnessOf(clean, b);
  const roundMax = opts.ellipseTolerance == null ? 0.22 : opts.ellipseTolerance;

  let shape;
  if (corners === 3) shape = 'triangle';
  else if (corners >= 4) shape = roundness < 0.075 ? 'ellipse' : 'rect'; // 圆被手抖误判出角时，用「够不够圆」救回来
  else shape = roundness < roundMax ? 'ellipse' : 'rect';
  return { shape, points: [[b.x0, b.y0], [b.x1, b.y1]] };
}

/** 按用户指定的形状规整（auto 走识别） */
export function snapToShape(points, kind = 'auto', opts = {}) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length < 2) return null;
  if (!kind || kind === 'auto') return recognizeShape(pts, opts);
  const b = bboxOfPoints(pts);
  if (kind === 'line' || kind === 'arrow') {
    return { shape: kind, points: [pts[0], pts[pts.length - 1]] };
  }
  if (!SHAPE_IDS.includes(kind)) return null;
  if (Math.hypot(b.x1 - b.x0, b.y1 - b.y0) < (opts.minSize == null ? 0.015 : opts.minSize)) return null;
  return { shape: kind, points: [[b.x0, b.y0], [b.x1, b.y1]] };
}

/** 荧光笔：够直就拉成一条直线（手账 App 里荧光笔基本都是直尺效果） */
export function straightenHighlighter(points, tolerance = 1.22) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length < 3) return null;
  const a = pts[0], z = pts[pts.length - 1];
  const gap = Math.hypot(z[0] - a[0], z[1] - a[1]);
  if (gap < 0.02) return null;
  const straightness = polylineLength(pts) / gap;
  if (straightness > tolerance) return null;
  return [a, z];
}

/** 形状的角点（缩放 / 旋转柄用） */
export function shapeHandlePoints(bounds, kind = 'corner') {
  if (!bounds) return [];
  const { x0, y0, x1, y1 } = bounds;
  if (kind === 'rotate') {
    const cx = (x0 + x1) / 2;
    return [{ id: 'rotate', x: cx, y: y0 }];
  }
  return [
    { id: 'tl', x: x0, y: y0 }, { id: 'tr', x: x1, y: y0 },
    { id: 'br', x: x1, y: y1 }, { id: 'bl', x: x0, y: y1 },
  ];
}

/* ============================ 擦除 ============================ */

/** 按最大步长加密路径点：像素橡皮才能把长直线切成两段 */
export function densifyPoints(points, maxStepPx, W, H) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  const out = [];
  const step = Math.max(1, num(maxStepPx, 3));
  const w = Math.max(1, W), h = Math.max(1, H);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    out.push([a[0], a[1]]);
    const b = pts[i + 1];
    if (!b) continue;
    const d = Math.hypot((b[0] - a[0]) * w, (b[1] - a[1]) * h);
    const n = Math.min(400, Math.floor(d / step));
    for (let k = 1; k < n; k++) {
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
  }
  return out;
}

/**
 * 像素橡皮：擦掉半径内的一段路径，剩下的碎段各自成为新对象
 * 返回 null 表示没擦到任何东西；返回 [] 表示整笔被擦掉
 */
export function eraseStrokePartial(item, x, y, radius, W, H) {
  if (!item || item.kind !== 'stroke') return null;
  const pts = densifyPoints(item.points, 3, W, H);
  if (pts.length < 2) return null;
  const keep = [];
  let touched = false;
  for (const [px, py] of pts) {
    const hit = Math.hypot((px - x) * W, (py - y) * H) <= radius;
    if (hit) touched = true;
    keep.push(!hit);
  }
  if (!touched) return null;
  const runs = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) cur.push(pts[i]);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  const { shape, ...rest } = item; // 切开后的碎段按自由路径画，不再当整形状（否则会把 bbox 也放大）
  void shape;
  return runs
    .filter((r) => r.length >= 2)
    .map((r) => ({
      ...rest,
      id: uid('s'),
      points: r.map(([a, b]) => [clamp01(a), clamp01(b)]),
    }));
}

/**
 * 擦除入口（工具层调用）
 * mode: 'stroke' 整笔擦除（碰到就整条删）| 'pixel' 像素擦除（只擦经过的一段）
 * 文本 / 图片不会被橡皮擦掉（要先用套索选中再删除，避免误删）
 */
export function eraseAtPoint(items, x, y, W, H, opts = {}) {
  const radius = opts.radius == null ? 12 : opts.radius;
  const mode = opts.mode === 'pixel' ? 'pixel' : 'stroke';
  const out = [];
  let changed = 0;
  let removedStrokes = 0;
  for (const it of items || []) {
    if (!it || it.kind !== 'stroke') { out.push(it); continue; }
    if (mode === 'stroke') {
      if (hitTestItem(it, x, y, W, H, { tolPx: radius })) { changed++; removedStrokes++; continue; }
      out.push(it);
      continue;
    }
    const parts = eraseStrokePartial(it, x, y, radius, W, H);
    if (parts == null) { out.push(it); continue; }
    changed++;
    if (!parts.length) removedStrokes++;
    for (const p of parts) out.push(p);
  }
  return { items: out, changed, removedStrokes };
}

/* ============================ 变换（移动 / 缩放 / 旋转） ============================ */

/**
 * 对选中对象做仿射变换：绕 origin 缩放 sx/sy → 绕同一 origin 旋转 angle → 平移 dx/dy
 * origin 缺省取选中集合的包围盒中心
 */
export function transformItems(items, ids, t = {}) {
  const list = items || [];
  const idSet = ids instanceof Set ? ids : new Set(ids || []);
  const sel = list.filter((i) => i && idSet.has(i.id));
  if (!sel.length) return cloneItems(list);

  const b = boundsOfItems(sel);
  const origin = t.origin || { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  const dx = num(t.dx, 0), dy = num(t.dy, 0);
  const sx = t.sx == null ? 1 : num(t.sx, 1);
  const sy = t.sy == null ? 1 : num(t.sy, 1);
  const angle = num(t.angle, 0);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const k = Math.sqrt(Math.abs(sx * sy)) || 1;

  const map = ([x, y]) => {
    const lx = (x - origin.x) * sx, ly = (y - origin.y) * sy;
    return [origin.x + lx * cos - ly * sin + dx, origin.y + lx * sin + ly * cos + dy];
  };

  return list.map((it) => {
    if (!it || !idSet.has(it.id)) return it;
    if (it.kind === 'text') {
      const s = estimateTextSize(it.text, it.size);
      const [cx, cy] = map([num(it.x) + s.w / 2, num(it.y) + s.h / 2]);
      const w = s.w * Math.abs(sx), h = s.h * Math.abs(sy);
      return {
        ...it,
        x: cx - w / 2,
        y: cy - h / 2,
        size: num(it.size, 0.023) * k,
        rot: num(it.rot, 0) + angle,
      };
    }
    if (it.kind === 'image') {
      const w0 = num(it.w, 0.3), h0 = num(it.h, 0.2);
      const [cx, cy] = map([num(it.x) + w0 / 2, num(it.y) + h0 / 2]);
      const w = w0 * Math.abs(sx), h = h0 * Math.abs(sy);
      return { ...it, x: cx - w / 2, y: cy - h / 2, w, h, rot: num(it.rot, 0) + angle };
    }
    return { ...it, points: (it.points || []).map((p) => map([num(p && p[0]), num(p && p[1])])) };
  });
}

/* ============================ 撤销 / 重做历史 ============================ */

/** 操作前快照式的历史栈：任何编辑都走同一条路，不会漏 */
export class InkHistory {
  constructor({ limit = MAX_HISTORY } = {}) {
    this.limit = Math.max(1, limit);
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoDepth() { return this.undoStack.length; }
  get redoDepth() { return this.redoStack.length; }

  /** 记一次操作：label 是操作名，before 是操作前的对象列表快照 */
  push(label, before) {
    this.undoStack.push({ label: label || '编辑', before: cloneItems(before) });
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return this;
  }

  /** 撤销：传入当前状态，返回 { state, label }；没得撤销返回 null */
  undo(current) {
    if (!this.undoStack.length) return null;
    const entry = this.undoStack.pop();
    this.redoStack.push({ label: entry.label, before: cloneItems(current) });
    return { state: cloneItems(entry.before), label: entry.label };
  }

  /** 重做：传入当前状态，返回 { state, label }；没得重做返回 null */
  redo(current) {
    if (!this.redoStack.length) return null;
    const entry = this.redoStack.pop();
    this.undoStack.push({ label: entry.label, before: cloneItems(current) });
    return { state: cloneItems(entry.before), label: entry.label };
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    return this;
  }
}

/* ============================ 序列化 ============================ */

/** 读写兼容层：v1 的 strokes 数组升级成 v2 的 items（缺 id 的补上） */
export function normalizeItems(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = raw.kind || (raw.type === 'text' ? 'text' : raw.type === 'image' ? 'image' : 'stroke');
    if (kind === 'text') {
      const text = String(raw.text == null ? '' : raw.text);
      if (!text.trim()) continue;
      out.push({
        kind: 'text',
        id: raw.id || uid('t'),
        x: num(raw.x), y: num(raw.y),
        text,
        color: raw.color || PALETTE[5].pen,
        size: num(raw.size, TEXT_SIZES[1].value),
        rot: num(raw.rot, 0),
      });
      continue;
    }
    if (kind === 'image') {
      if (!raw.src) continue;
      out.push({
        kind: 'image',
        id: raw.id || uid('img'),
        x: num(raw.x), y: num(raw.y),
        w: num(raw.w, 0.3), h: num(raw.h, 0.2),
        src: String(raw.src),
        rot: num(raw.rot, 0),
      });
      continue;
    }
    const points = (Array.isArray(raw.points) ? raw.points : [])
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [clamp01(p[0]), clamp01(p[1])]);
    if (!points.length) continue;
    out.push({
      kind: 'stroke',
      id: raw.id || uid('s'),
      tool: raw.tool === 'highlighter' ? 'highlighter' : 'pen',
      color: raw.color || PALETTE[5].pen,
      width: num(raw.width, WIDTHS[1].pen),
      points,
      ...(SHAPE_IDS.includes(raw.shape) && raw.shape !== 'auto' ? { shape: raw.shape } : {}),
    });
  }
  return out;
}

/** 序列化成可提交的 JSON 文本（v2） */
export function serializeInk(items) {
  return JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), items: normalizeItems(items) }, null, 1);
}

/** 解析仓库里的标注文件：v2 读 items，v1 读 strokes，坏文件返回空数组 */
export function parseInk(text) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.items)) return normalizeItems(j.items);
    if (Array.isArray(j.strokes)) return normalizeItems(j.strokes);
    return [];
  } catch (e) {
    return [];
  }
}

/** 统计各类对象数量（界面状态条 / 保存提示用） */
export function countItems(items) {
  const c = { stroke: 0, text: 0, image: 0, total: 0 };
  for (const it of items || []) {
    if (it && c[it.kind] != null) c[it.kind]++;
    c.total++;
  }
  return c;
}

/* ============================ 标注层 ============================ */

export class InkLayer {
  /**
   * @param {object} opts
   *   opts.host            承载文章的元素（画布会铺满它的内容高度）
   *   opts.onChange        (items, info) => void  内容变化（用于标脏 / 存草稿）
   *   opts.onToolChange    (tool) => void
   *   opts.onRequestSave   () => void
   *   opts.canSave         () => boolean
   *   opts.onClose         () => void
   *   opts.toast           (msg, kind) => void     可选：轻提示
   */
  constructor({ host, onChange, onToolChange, canSave, onRequestSave, onClose, toast }) {
    this.host = host;
    this.onChange = onChange;
    this.onToolChange = onToolChange;
    this.canSave = canSave;
    this.onRequestSave = onRequestSave;
    this.onClose = onClose;
    this.onToast = toast;

    this.items = [];
    this.history = new InkHistory({ limit: MAX_HISTORY });
    this.selection = new Set();
    this.clipboard = [];

    this.tool = 'pen';
    this.color = PALETTE[0];
    this.width = WIDTHS[1];
    this.eraserMode = 'stroke';   // stroke 整笔 / pixel 像素
    this.eraserSize = ERASER_SIZES[1];
    this.shapeKind = 'auto';
    this.textSize = TEXT_SIZES[1];

    this.active = false;
    this.drawing = null;      // 正在画的预览对象
    this.gesture = null;      // 当前手势状态
    this.lasso = null;        // 正在画的套索多边形
    this.editing = null;      // 正在编辑的文本框
    this.touches = new Map(); // 触屏手指
    this._tap = null;
    this._pending = null;     // 本次手势的操作前快照
    this._rAF = 0;
    this._imgs = new Map();

    this.build();
  }

  /* ---------- DOM ---------- */

  build() {
    const wrap = document.createElement('div');
    wrap.className = 'ink-layer';
    wrap.innerHTML = `
      <canvas class="ink-canvas" aria-label="手写标注层"></canvas>
      <div class="ink-bar" role="toolbar" aria-label="标注与编辑工具">
        <div class="ink-group ink-tools">
          <button type="button" class="ink-btn on" data-tool="pen" title="画笔（自由手写）· P">✏️</button>
          <button type="button" class="ink-btn" data-tool="highlighter" title="荧光笔（半透明勾画，够直会自动拉直）· H">🖍</button>
          <button type="button" class="ink-btn" data-tool="eraser" title="橡皮：整笔擦 / 像素擦 · E">🧽</button>
          <button type="button" class="ink-btn" data-tool="lasso" title="套索：圈选后可拖动、缩放、旋转、改色 · L">⭕</button>
          <button type="button" class="ink-btn" data-tool="shape" title="形状：自动识别直线 / 箭头 / 矩形 / 椭圆 / 三角 · S">▭</button>
          <button type="button" class="ink-btn" data-tool="text" title="文本框：点一下写文字，双击可再编辑 · T">🅣</button>
          <button type="button" class="ink-btn" data-act="image" title="插入图片（存进标注文件，随仓库走）">🖼</button>
        </div>
        <div class="ink-sep"></div>
        <div class="ink-group ink-colors">
          ${PALETTE.map((c, i) => `<button type="button" class="ink-color${i === 0 ? ' on' : ''}" data-color="${c.id}" title="${c.label}" style="--c:${c.pen}"></button>`).join('')}
          <label class="ink-custom" title="自定义颜色"><input type="color" class="ink-color-input" value="${PALETTE[0].pen}" aria-label="自定义颜色"></label>
        </div>
        <div class="ink-group ink-widths">
          ${WIDTHS.map((w, i) => `<button type="button" class="ink-w${i === 1 ? ' on' : ''}" data-width="${w.id}" title="笔粗：${w.label}">${w.label}</button>`).join('')}
        </div>
        <div class="ink-group ink-context ink-ctx-erase" data-context="eraser">
          <span class="ink-group-label">橡皮</span>
          <button type="button" class="ink-mode on" data-erase="stroke" title="整笔擦除：碰到哪条线就删哪条">整笔</button>
          <button type="button" class="ink-mode" data-erase="pixel" title="像素擦除：只擦经过的一段">像素</button>
          ${ERASER_SIZES.map((s, i) => `<button type="button" class="ink-w${i === 1 ? ' on' : ''}" data-eraser="${s.id}" title="橡皮大小：${s.label}">${s.label}</button>`).join('')}
        </div>
        <div class="ink-group ink-context ink-ctx-shape" data-context="shape">
          <span class="ink-group-label">形状</span>
          ${SHAPE_KINDS.map((s, i) => `<button type="button" class="ink-shape${i === 0 ? ' on' : ''}" data-shape="${s.id}" title="${s.label}">${s.glyph}</button>`).join('')}
        </div>
        <div class="ink-group ink-context ink-ctx-text" data-context="text">
          <span class="ink-group-label">字号</span>
          ${TEXT_SIZES.map((s, i) => `<button type="button" class="ink-w${i === 1 ? ' on' : ''}" data-textsize="${s.id}" title="字号：${s.label}">${s.label}</button>`).join('')}
        </div>
        <div class="ink-sep"></div>
        <button type="button" class="ink-btn ink-undo" data-act="undo" title="撤销（Ctrl/Cmd+Z，触屏双指轻点）">↶</button>
        <button type="button" class="ink-btn ink-redo" data-act="redo" title="重做（Ctrl/Cmd+Shift+Z 或 Ctrl+Y，触屏三指轻点）">↷</button>
        <button type="button" class="ink-btn" data-act="duplicate" title="复制选中的对象（Ctrl+D）">⧉</button>
        <button type="button" class="ink-btn" data-act="delete" title="删除选中的对象（Delete）">🗑</button>
        <button type="button" class="ink-btn" data-act="clear" title="清空这一页（可撤销）">清空</button>
        <button type="button" class="ink-btn" data-act="help" title="用法与快捷键">?</button>
        <button type="button" class="ink-btn ink-save" data-act="save" title="保存标注（写回仓库）">保存标注</button>
        <button type="button" class="ink-btn" data-act="close" title="退出标注（退出前请先保存）">完成</button>
        <span class="ink-status" aria-live="polite">空白页</span>
      </div>
      <div class="ink-help" hidden>
        <b>编辑方式（对齐手账 App 的习惯）</b>
        <ul>
          <li><b>画笔 / 荧光笔</b>：直接写；荧光笔够直会自动拉直。</li>
          <li><b>橡皮</b>：切「整笔」碰到就整条删；切「像素」只擦经过的一段（长线会切成两条）。</li>
          <li><b>套索</b>：圈一圈或点一下选中对象，然后<b>拖动</b>移动、<b>拖角点</b>缩放、<b>拖上面的圆点</b>旋转；选中时点颜色 / 粗细可直接改。</li>
          <li><b>形状</b>：随便画，松手自动规整；也可在下拉里指定直线 / 箭头 / 矩形 / 椭圆 / 三角。</li>
          <li><b>文本</b>：点一下出现输入框，Ctrl/Cmd+Enter 或点别处完成；双击已有文字可再编辑。</li>
          <li><b>撤销</b>：↶ 按钮、Ctrl/Cmd+Z，触屏<b>双指轻点</b>；重做是 ↷、Ctrl/Cmd+Shift+Z、<b>三指轻点</b>。清空、擦除、缩放都能撤销。</li>
          <li>快捷键：P 画笔 / H 荧光笔 / E 橡皮 / L 套索 / S 形状 / T 文本；Ctrl+A 全选、Ctrl+C/X/V/D 复制剪切粘贴再制、Delete 删除、Esc 取消选择、[ ] 调笔粗。</li>
          <li>文本和图片不会被橡皮误删——用套索选中后按 Delete。</li>
        </ul>
      </div>
      <input type="file" class="ink-file" accept="image/*" hidden>`;
    this.wrap = wrap;
    this.canvas = wrap.querySelector('.ink-canvas');
    this.bar = wrap.querySelector('.ink-bar');
    this.help = wrap.querySelector('.ink-help');
    this.status = wrap.querySelector('.ink-status');
    this.fileInput = wrap.querySelector('.ink-file');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    wrap.style.display = 'none';
    this.host.appendChild(wrap);

    this.bindCanvas();
    this.bindBar();
    // 面板内的点击不要再冒泡给正文（避免触发笔记页自己的交互）
    wrap.addEventListener('pointerdown', (e) => e.stopPropagation());
    wrap.addEventListener('click', (e) => e.stopPropagation());
    this._keyHandler = (e) => this.onKey(e);
    this.refreshBar();
  }

  /* ---------- 工具栏 ---------- */

  bindBar() {
    if (!this.bar) return;
    this.bar.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      e.preventDefault && e.preventDefault();
      if (t.dataset.tool) return this.setTool(t.dataset.tool);
      if (t.dataset.color) return this.setColor(t.dataset.color);
      if (t.dataset.width) return this.setWidth(t.dataset.width);
      if (t.dataset.eraser) return this.setEraserSize(t.dataset.eraser);
      if (t.dataset.erase) return this.setEraserMode(t.dataset.erase);
      if (t.dataset.shape) return this.setShapeKind(t.dataset.shape);
      if (t.dataset.textsize) return this.setTextSize(t.dataset.textsize);
      const act = t.dataset.act;
      if (act === 'undo') return this.undo();
      if (act === 'redo') return this.redo();
      if (act === 'duplicate') return this.duplicateSelection();
      if (act === 'delete') return this.deleteSelection();
      if (act === 'clear') return this.clearAll();
      if (act === 'help') return this.toggleHelp();
      if (act === 'image') return this.pickImage();
      if (act === 'save') {
        if (this.canSave && !this.canSave()) {
          this.host.dispatchEvent(new CustomEvent('ink-need-token', { bubbles: true }));
          this.flash('先在「✎ 编辑」里填一次 GitHub 令牌，才能保存标注', 'warn');
          return;
        }
        this.onRequestSave && this.onRequestSave();
        return;
      }
      if (act === 'close') {
        this.setActive(false);
        this.onClose && this.onClose();
      }
    });

    const colorInput = this.wrap.querySelector('.ink-color-input');
    if (colorInput) {
      colorInput.addEventListener('input', (e) => {
        const v = String((e.target && e.target.value) || '').trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) this.setCustomColor(v);
      });
    }
    if (this.fileInput) {
      this.fileInput.addEventListener('change', (e) => {
        const f = e.target && e.target.files && e.target.files[0];
        if (this.fileInput) this.fileInput.value = '';
        if (f) this.insertImageFile(f);
      });
    }
  }

  setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    this.abortGesture();
    this.tool = tool;
    this.selection.clear();
    if (this.bar) {
      this.bar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    }
    this.updateCursor();
    this.refreshBar();
    this.redraw();
    this.onToolChange && this.onToolChange(tool);
  }

  setColor(id) {
    const c = PALETTE.find((x) => x.id === id) || PALETTE[0];
    this.color = c;
    if (this.bar) this.bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === c.id));
    this.applyStyleToSelection({ color: c.pen });
    this.updateCursor();
  }

  setCustomColor(hex) {
    const c = PALETTE.find((x) => x.pen.toLowerCase() === hex.toLowerCase());
    if (c) return this.setColor(c.id);
    this.color = { id: 'custom', pen: hex, ink: hexToRgba(hex, 0.28), label: '自定义' };
    if (this.bar) this.bar.querySelectorAll('[data-color]').forEach((b) => b.classList.remove('on'));
    this.applyStyleToSelection({ color: hex });
    this.updateCursor();
  }

  setWidth(id) {
    const w = WIDTHS.find((x) => x.id === id) || WIDTHS[1];
    this.width = w;
    if (this.bar) this.bar.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('on', b.dataset.width === w.id));
    this.applyStyleToSelection({ width: this.tool === 'highlighter' ? w.highlighter : w.pen });
    this.updateCursor();
  }

  setEraserSize(id) {
    const s = ERASER_SIZES.find((x) => x.id === id) || ERASER_SIZES[1];
    this.eraserSize = s;
    if (this.bar) this.bar.querySelectorAll('[data-eraser]').forEach((b) => b.classList.toggle('on', b.dataset.eraser === s.id));
  }

  setEraserMode(mode) {
    this.eraserMode = mode === 'pixel' ? 'pixel' : 'stroke';
    if (this.bar) this.bar.querySelectorAll('[data-erase]').forEach((b) => b.classList.toggle('on', b.dataset.erase === this.eraserMode));
    this.flash(this.eraserMode === 'pixel' ? '像素橡皮：只擦经过的一段' : '整笔橡皮：碰到哪条删哪条');
  }

  setShapeKind(id) {
    const k = SHAPE_KINDS.find((x) => x.id === id) || SHAPE_KINDS[0];
    this.shapeKind = k.id;
    if (this.bar) this.bar.querySelectorAll('[data-shape]').forEach((b) => b.classList.toggle('on', b.dataset.shape === k.id));
  }

  setTextSize(id) {
    const s = TEXT_SIZES.find((x) => x.id === id) || TEXT_SIZES[1];
    this.textSize = s;
    if (this.bar) this.bar.querySelectorAll('[data-textsize]').forEach((b) => b.classList.toggle('on', b.dataset.textsize === s.id));
  }

  /** 选中的对象批量改样式（手账 App：改颜色会改选中的墨迹） */
  applyStyleToSelection(patch) {
    if (!this.selection.size) return;
    const label = patch.color ? '改颜色' : '改粗细';
    this.snapshot(label);
    this.items = this.items.map((it) => {
      if (!this.selection.has(it.id) || it.kind !== 'stroke') return it;
      return { ...it, ...patch };
    });
    this.commit(label);
    this.redraw();
  }

  toggleHelp() {
    if (!this.help) return;
    this.help.hidden = !this.help.hidden;
  }

  /* ---------- 画布事件 ---------- */

  bindCanvas() {
    const c = this.canvas;
    if (!c) return;
    let pid = null;

    const onPointerDown = (e) => {
      if (!this.active) return;
      e.preventDefault && e.preventDefault();
      if (e.pointerType === 'touch') {
        const isFirst = this.touches.size === 0;
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (isFirst) this._tap = { max: 1, t0: Date.now(), moved: false };
        else { this._tap = this._tap || { max: 1, t0: Date.now(), moved: false }; this._tap.max = Math.max(this._tap.max, this.touches.size); }
        if (this.touches.size > 1) { this.abortGesture(); return; } // 多指按下：本次笔画作废（留给撤销 / 重做手势）
      }
      try { c.setPointerCapture && c.setPointerCapture(e.pointerId); } catch (err) {}
      pid = e.pointerId;
      this.onDown(this.toNorm(e), e);
    };

    const onPointerMove = (e) => {
      if (!this.active) return;
      if (e.pointerType === 'touch') {
        const t = this.touches.get(e.pointerId);
        if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10 && this._tap) this._tap.moved = true;
        if (t) { t.x = e.clientX; t.y = e.clientY; }
        if (this.touches.size > 1) return; // 多指时不动笔画
      }
      if (pid !== null && e.pointerId !== pid) return;
      this.onMove(this.toNorm(e), e);
    };

    const onPointerUp = (e) => {
      if (e && e.pointerType === 'touch') {
        this.touches.delete(e.pointerId);
        const tap = this._tap;
        if (this.touches.size === 0) {
          this._tap = null;
          if (tap && !tap.moved && Date.now() - tap.t0 < 420 && tap.max >= 2) {
            this.abortGesture();
            if (tap.max >= 3) { this.flash('三指轻点 → 重做'); this.redo(); }
            else { this.flash('双指轻点 → 撤销'); this.undo(); }
            pid = null;
            return;
          }
        }
      }
      if (pid !== null && e && e.pointerId !== pid) return;
      pid = null;
      this.onUp(e);
    };

    const onPointerLeave = (e) => { if (this.drawing && e.buttons === 0) onPointerUp(e); };

    // 双击已有文字 → 再编辑
    const onDblClick = (e) => {
      if (!this.active) return;
      const p = this.toNorm(e);
      const t = this.topItemAt(p, { tolPx: 12, inside: true, kind: 'text' });
      if (t) this.beginTextEdit(t, p);
    };

    // 存一份句柄：触屏多指手势这类没法在浏览器里自动跑的逻辑，靠它做无头测试
    this._canvasHandlers = { pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: onPointerUp, pointercancel: onPointerUp, pointerleave: onPointerLeave, dblclick: onDblClick };
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerUp);
    c.addEventListener('pointerleave', onPointerLeave);
    c.addEventListener('dblclick', onDblClick);
  }

  /* ---------- 手势（供指针事件与测试直接调用） ---------- */

  /** 起笔：记录操作前快照，建立预览对象 */
  startInk(p, meta = {}) {
    const label = this.tool === 'highlighter' ? '荧光笔' : this.tool === 'shape' ? '画形状' : '画笔';
    this.snapshot(label);
    this.selection.clear();
    this.drawing = {
      kind: 'stroke',
      id: uid('s'),
      tool: this.tool === 'highlighter' ? 'highlighter' : 'pen',
      color: this.tool === 'highlighter' ? this.color.ink : this.color.pen,
      width: this.tool === 'highlighter' ? this.width.highlighter : this.width.pen,
      points: [p],
      ...(this.tool === 'shape' ? { shapeTool: this.shapeKind } : {}),
    };
    this.gesture = { type: 'ink' };
    this.redraw();
    this.refreshBar();
  }

  onDown(p, meta = {}) {
    if (!this.active) return;
    if (this.tool === 'pen' || this.tool === 'highlighter' || this.tool === 'shape') return this.startInk(p, meta);
    if (this.tool === 'eraser') {
      this.snapshot(this.eraserMode === 'pixel' ? '像素擦除' : '擦除');
      this.gesture = { type: 'erase' };
      this.applyErase(p);
      return;
    }
    if (this.tool === 'lasso') return this.startLassoOrDrag(p, meta);
    if (this.tool === 'text') return this.startText(p);
  }

  onMove(p, meta = {}) {
    if (!this.gesture) return;
    if (this.gesture.type === 'erase') return this.applyErase(p);
    if (this.gesture.type === 'ink') {
      const d = this.drawing;
      if (!d) return;
      const last = d.points[d.points.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.0016) return; // 采样：太密的点丢掉
      d.points.push(p);
      return this.scheduleRedraw();
    }
    if (this.gesture.type === 'lasso') {
      this.lasso = this.lasso || [];
      this.lasso.push(p);
      return this.scheduleRedraw();
    }
    if (this.gesture.type === 'move' || this.gesture.type === 'scale' || this.gesture.type === 'rotate') {
      this.applyTransform(p, meta);
      return this.scheduleRedraw();
    }
  }

  onUp(meta = {}) {
    const g = this.gesture;
    if (!g) { this.commit(); return; }
    this.gesture = null;

    if (g.type === 'ink') {
      const d = this.drawing;
      this.drawing = null;
      const item = this.finalizeDrawing(d);
      if (item) this.items.push(item);
      this.redraw();
      this.commit(item ? itemLabel(item) : null);
      this.refreshBar();
      return;
    }
    if (g.type === 'lasso') {
      this.finishLasso();
      return;
    }
    if (g.type === 'move' || g.type === 'scale' || g.type === 'rotate') {
      const label = g.type === 'move' ? '移动' : g.type === 'scale' ? '缩放' : '旋转';
      this.redraw();
      this.commit(label);
      this.refreshBar();
      return;
    }
    this.commit();
  }

  /** 松手时把预览轨迹定稿：形状识别 / 荧光笔拉直 / 单点 */
  finalizeDrawing(d) {
    if (!d || !d.points || !d.points.length) return null;
    const base = { ...d };
    delete base.shapeTool;
    if (d.points.length === 1) {
      if (d.shapeTool || d.tool === 'highlighter') return null;
      const [x, y] = d.points[0];
      return { ...base, points: [[x, y], [x + 0.0008, y + 0.0008]] };
    }
    if (d.shapeTool) {
      const snap = snapToShape(d.points, d.shapeTool);
      if (!snap) return null;
      return { ...base, shape: snap.shape, points: snap.points };
    }
    if (d.tool === 'highlighter') {
      const line = straightenHighlighter(d.points);
      if (line) return { ...base, shape: 'line', points: line };
    }
    return base;
  }

  /** 触摸多指 / 切工具时放弃正在进行的手势 */
  abortGesture() {
    if (this.drawing) this.drawing = null;
    if (this._pending) { this.items = cloneItems(this._pending.before); this._pending = null; }
    if (this.lasso) this.lasso = null;
    this.gesture = null;
    this.redraw();
    this.refreshBar();
  }

  scheduleRedraw() {
    if (this._rAF) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    this._rAF = raf(() => { this._rAF = 0; this.redraw(); });
  }

  /* ---------- 撤销 / 重做 ---------- */

  snapshot(label) {
    if (this._pending) return; // 一次手势只记一次
    this._pending = { label: label || '编辑', before: cloneItems(this.items) };
  }

  commit(label) {
    const p = this._pending;
    this._pending = null;
    if (!p) return false;
    const before = JSON.stringify(p.before);
    const after = JSON.stringify(this.items);
    if (before === after) return false; // 没变化就不占历史
    this.history.push(p.label || label || '编辑', p.before);
    this.refreshBar();
    this.notify();
    return true;
  }

  undo() {
    const r = this.history.undo(this.items);
    if (!r) { this.flash('没有可撤销的操作'); return null; }
    this.items = r.state;
    this.selection.clear();
    this.drawing = null;
    this.lasso = null;
    this.redraw();
    this.refreshBar();
    this.notify();
    this.flash(`撤销：${r.label}`);
    return r.label;
  }

  redo() {
    const r = this.history.redo(this.items);
    if (!r) { this.flash('没有可重做的操作'); return null; }
    this.items = r.state;
    this.selection.clear();
    this.redraw();
    this.refreshBar();
    this.notify();
    this.flash(`重做：${r.label}`);
    return r.label;
  }

  clearAll() {
    if (!this.items.length) return;
    const n = countItems(this.items);
    const msg = `清空这一页的 ${n.total} 个对象？（可用 ↶ 撤销）`;
    if (typeof confirm === 'function' && !confirm(msg)) return;
    this.snapshot('清空');
    this.items = [];
    this.selection.clear();
    this.commit('清空');
    this.redraw();
    this.notify();
  }

  /* ---------- 选择 / 剪贴板 ---------- */

  selectedItems() {
    return this.items.filter((it) => this.selection.has(it.id));
  }

  selectAll() {
    this.selection = new Set(this.items.map((it) => it.id));
    this.redraw();
    this.refreshBar();
    this.flash(`已全选 ${this.selection.size} 个对象`);
  }

  copySelection() {
    const sel = this.selectedItems();
    if (!sel.length) { this.flash('先圈选内容再复制'); return false; }
    this.clipboard = cloneItems(sel);
    this.flash(`已复制 ${sel.length} 个对象`);
    return true;
  }

  cutSelection() {
    if (!this.copySelection()) return false;
    this.deleteSelection('剪切');
    return true;
  }

  pasteClipboard() {
    if (!this.clipboard.length) { this.flash('剪贴板是空的'); return false; }
    this.snapshot('粘贴');
    const drops = cloneItems(this.clipboard).map((it) => ({ ...it, id: uid(it.kind === 'text' ? 't' : it.kind === 'image' ? 'img' : 's') }));
    const ids = new Set(drops.map((d) => d.id));
    const moved = transformItems(drops, ids, { dx: 0.02, dy: 0.02 });
    this.items.push(...moved);
    this.selection = new Set(moved.map((m) => m.id));
    this.commit('粘贴');
    this.redraw();
    this.refreshBar();
    this.notify();
    this.flash(`已粘贴 ${moved.length} 个对象`);
    return true;
  }

  duplicateSelection() {
    if (!this.selectedItems().length) { this.flash('先圈选要复制的对象'); return false; }
    this.clipboard = cloneItems(this.selectedItems());
    return this.pasteClipboard();
  }

  deleteSelection() {
    if (!this.selection.size) { this.flash('先圈选要删除的对象'); return false; }
    const n = this.selection.size;
    this.snapshot('删除');
    this.items = this.items.filter((it) => !this.selection.has(it.id));
    this.selection.clear();
    this.commit('删除');
    this.redraw();
    this.refreshBar();
    this.notify();
    this.flash(`已删除 ${n} 个对象（可撤销）`);
    return true;
  }

  /* ---------- 套索 / 拖动 / 缩放 / 旋转 ---------- */

  startLassoOrDrag(p, meta = {}) {
    const handle = this.selection.size ? this.handleAt(p) : null;
    if (handle && handle.id === 'rotate') {
      this.snapshot('旋转');
      this.gesture = { type: 'rotate', start: p, base: this.captureSelection(), origin: boundsCenter(boundsOfItems(this.selectedItems())) };
      return;
    }
    if (handle) {
      this.snapshot('缩放');
      const b = boundsOfItems(this.selectedItems());
      const anchor = { tl: { x: b.x1, y: b.y1 }, tr: { x: b.x0, y: b.y1 }, br: { x: b.x0, y: b.y0 }, bl: { x: b.x1, y: b.y0 } }[handle.id];
      this.gesture = { type: 'scale', handle: handle.id, start: p, base: this.captureSelection(), origin: anchor };
      return;
    }
    const hit = this.topItemAt(p, { tolPx: 10, inside: true });
    if (hit) {
      if (!this.selection.has(hit.id)) this.selection = new Set([hit.id]);
      this.snapshot('移动');
      this.gesture = { type: 'move', start: p, base: this.captureSelection() };
      this.redraw();
      this.refreshBar();
      return;
    }
    if (this.selection.size) { this.selection.clear(); this.refreshBar(); }
    this.gesture = { type: 'lasso' };
    this.lasso = [p];
    this.redraw();
  }

  finishLasso() {
    const poly = this.lasso;
    this.lasso = null;
    this.gesture = null;
    const W = this.cssW || 1, H = this.cssH || 1;
    if (poly && poly.length >= 3) {
      const hits = this.items.filter((it) => polygonSelectsItem(poly, it, { W, H }));
      this.selection = new Set(hits.map((it) => it.id));
      this.flash(hits.length ? `圈选了 ${hits.length} 个对象：可拖动 / 拖角点缩放 / 拖圆点旋转` : '没圈到内容：换个范围再试');
    }
    this.redraw();
    this.refreshBar();
  }

  captureSelection() {
    const items = cloneItems(this.selectedItems());
    return { items, ids: items.map((i) => i.id) };
  }

  applyTransform(p, meta = {}) {
    const g = this.gesture;
    if (!g || !g.base) return;
    const idSet = new Set(g.base.ids);
    let t = null;
    if (g.type === 'move') {
      t = { dx: p[0] - g.start[0], dy: p[1] - g.start[1] };
    } else if (g.type === 'scale') {
      const o = g.origin;
      const denomX = g.start[0] - o.x, denomY = g.start[1] - o.y;
      let sx = Math.abs(denomX) < 1e-4 ? 1 : (p[0] - o.x) / denomX;
      let sy = Math.abs(denomY) < 1e-4 ? 1 : (p[1] - o.y) / denomY;
      const min = 0.05, max = 8;
      sx = Math.min(max, Math.max(-max, sx));
      sy = Math.min(max, Math.max(-max, sy));
      if (Math.abs(sx) < min) sx = sx < 0 ? -min : min;
      if (Math.abs(sy) < min) sy = sy < 0 ? -min : min;
      if (meta.shiftKey) { const s = (Math.abs(sx) + Math.abs(sy)) / 2; sx = sx < 0 ? -s : s; sy = sy < 0 ? -s : s; }
      t = { sx, sy, origin: o };
    } else if (g.type === 'rotate') {
      const o = g.origin;
      let a = Math.atan2(p[1] - o.y, p[0] - o.x) - Math.atan2(g.start[1] - o.y, g.start[0] - o.x);
      if (meta.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); // Shift → 15° 对齐
      t = { angle: a, origin: o };
    }
    if (!t) return;
    const moved = transformItems(g.base.items, idSet, t);
    const byId = new Map(moved.map((it) => [it.id, it]));
    this.items = this.items.map((it) => byId.get(it.id) || it);
  }

  /** 控制点（像素坐标） */
  handlePoints() {
    const sel = this.selectedItems();
    if (!sel.length) return [];
    const b = boundsOfItems(sel);
    const W = this.cssW || 1, H = this.cssH || 1;
    const pad = 8;
    const px = { x0: b.x0 * W - pad, y0: b.y0 * H - pad, x1: b.x1 * W + pad, y1: b.y1 * H + pad };
    return [
      { id: 'tl', x: px.x0, y: px.y0 }, { id: 'tr', x: px.x1, y: px.y0 },
      { id: 'br', x: px.x1, y: px.y1 }, { id: 'bl', x: px.x0, y: px.y1 },
      { id: 'rotate', x: (px.x0 + px.x1) / 2, y: px.y0 - 24 },
    ];
  }

  handleAt(p) {
    const W = this.cssW || 1, H = this.cssH || 1;
    const x = p[0] * W, y = p[1] * H;
    let best = null, bestD = 14;
    for (const h of this.handlePoints()) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= bestD) { bestD = d; best = h; }
    }
    return best;
  }

  topItemAt(p, opts = {}) {
    const W = this.cssW || 1, H = this.cssH || 1;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (opts.kind && it.kind !== opts.kind) continue;
      if (hitTestItem(it, p[0], p[1], W, H, opts)) return it;
    }
    return null;
  }

  /* ---------- 橡皮 ---------- */

  applyErase(p) {
    const W = this.cssW || 1, H = this.cssH || 1;
    const radius = this.eraserSize.px / 2 + 2;
    const res = eraseAtPoint(this.items, p[0], p[1], W, H, { radius, mode: this.eraserMode });
    if (!res.changed) return;
    this.items = res.items;
    this.selection.clear();
    this.redraw();
  }

  /** 兼容旧接口：按点擦一笔 */
  eraseAt(p) { this.applyErase(p); }

  /* ---------- 文本框 ---------- */

  startText(p) {
    const hit = this.topItemAt(p, { tolPx: 12, inside: true, kind: 'text' });
    if (hit) return this.beginTextEdit(hit, p);
    return this.beginTextEdit(null, p);
  }

  beginTextEdit(existing, p) {
    if (!this.wrap) return null;
    if (this.editing) this.endTextEdit(true);
    this.abortGesture();
    const W = this.cssW || 1, H = this.cssH || 1;
    const ta = document.createElement('textarea');
    ta.className = 'ink-text-edit';
    ta.value = existing ? String(existing.text || '') : '';
    const size = existing ? num(existing.size, this.textSize.value) : this.textSize.value;
    const x = existing ? num(existing.x) : p[0];
    const y = existing ? num(existing.y) : p[1];
    const px = Math.max(14, Math.round(size * W));
    if (ta.style) {
      ta.style.left = `${x * W}px`;
      ta.style.top = `${y * H - 6}px`;
      ta.style.width = `${Math.round(Math.max(140, 0.46 * W))}px`;
      ta.style.fontSize = `${px}px`;
      ta.style.lineHeight = '1.36';
      ta.style.color = existing ? existing.color : this.color.pen;
    }
    this.wrap.appendChild(ta);
    this.editing = { ta, existing, point: [x, y], size };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault && e.preventDefault(); this.endTextEdit(false); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault && e.preventDefault(); this.endTextEdit(true); }
    });
    ta.addEventListener('blur', () => { if (this.editing && this.editing.ta === ta) this.endTextEdit(true); });
    try { ta.focus(); } catch (e) {}
    this.flash('输入文字：Ctrl/Cmd+Enter 或点空白处完成，Esc 取消');
    return ta;
  }

  endTextEdit(save) {
    const ed = this.editing;
    if (!ed) return false;
    this.editing = null;
    const text = String((ed.ta && ed.ta.value) || '').replace(/\s+$/, '');
    try { ed.ta.remove(); } catch (e) {}
    let ok = false;
    if (save) ok = this.commitTextEdit(ed.existing, text, ed.point, ed.size);
    this.redraw();
    this.refreshBar();
    return ok;
  }

  commitTextEdit(existing, text, point, size) {
    if (!String(text || '').trim()) {
      if (existing) {
        this.snapshot('删文字');
        this.items = this.items.filter((it) => it.id !== existing.id);
        this.commit('删文字');
        this.notify();
        return true;
      }
      return false;
    }
    if (existing) {
      this.snapshot('改文字');
      this.items = this.items.map((it) => (it.id === existing.id ? { ...it, text, size: num(size, it.size) } : it));
      this.commit('改文字');
    } else {
      this.snapshot('加文字');
      const item = {
        kind: 'text',
        id: uid('t'),
        x: clamp01(point[0]), y: clamp01(point[1]),
        text,
        color: this.color.pen,
        size: num(size, this.textSize.value),
        rot: 0,
      };
      this.items.push(item);
      this.selection = new Set([item.id]);
      this.commit('加文字');
    }
    this.notify();
    return true;
  }

  /* ---------- 图片 ---------- */

  pickImage() {
    if (!this.fileInput) return;
    if (this.fileInput.click) this.fileInput.click();
  }

  async insertImageFile(file) {
    if (!file) return false;
    if (file.size > 1.6 * 1024 * 1024) { this.flash('图片太大（>1.6MB）：先压缩再插入', 'warn'); return false; }
    const src = await readFileAsDataURL(file);
    if (!src) { this.flash('这张图片读不出来', 'error'); return false; }
    let ratio = 0.66;
    if (typeof Image === 'function') {
      try { ratio = await loadImageRatio(src); } catch (e) {}
    }
    const W = this.cssW || 800, H = this.cssH || 600;
    const w = 0.42;
    const h = Math.min(1.2, (w * W * ratio) / Math.max(1, H));
    const item = { kind: 'image', id: uid('img'), x: 0.3, y: 0.2, w, h, src, rot: 0 };
    this.snapshot('插入图片');
    this.items.push(item);
    this.selection = new Set([item.id]);
    this.commit('插入图片');
    this.redraw();
    this.refreshBar();
    this.notify();
    this.flash('图片已插入：拖动可以移动，拖角点可以缩放');
    return true;
  }

  imageElement(src) {
    if (!src) return null;
    if (this._imgs.has(src)) return this._imgs.get(src);
    if (typeof Image !== 'function') { this._imgs.set(src, null); return null; }
    const img = new Image();
    img.onload = () => this.redraw();
    try { img.src = src; } catch (e) {}
    this._imgs.set(src, img);
    return img;
  }

  /* ---------- 键盘 ---------- */

  onKey(e) {
    if (!this.active || !e) return;
    const t = e.target || {};
    const tag = String(t.tagName || '').toLowerCase();
    if (this.editing || tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    const mod = !!(e.ctrlKey || e.metaKey);
    const k = String(e.key || '').toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault && e.preventDefault(); return this.undo(); }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault && e.preventDefault(); return this.redo(); }
    if (mod && k === 'c') return this.copySelection();
    if (mod && k === 'x') return this.cutSelection();
    if (mod && k === 'v') return this.pasteClipboard();
    if (mod && k === 'd') { e.preventDefault && e.preventDefault(); return this.duplicateSelection(); }
    if (mod && k === 'a') { e.preventDefault && e.preventDefault(); return this.selectAll(); }
    if (k === 'delete' || k === 'backspace') {
      if (this.selection.size) { e.preventDefault && e.preventDefault(); return this.deleteSelection(); }
      return;
    }
    if (k === 'escape') {
      this.selection.clear(); this.lasso = null; this.abortGesture(); this.redraw(); this.refreshBar();
      return;
    }
    if (mod) return;
    if (k === 'p') return this.setTool('pen');
    if (k === 'h') return this.setTool('highlighter');
    if (k === 'e') return this.setTool('eraser');
    if (k === 'l') return this.setTool('lasso');
    if (k === 's') return this.setTool('shape');
    if (k === 't') return this.setTool('text');
    if (k === '[') return this.stepWidth(-1);
    if (k === ']') return this.stepWidth(1);
  }

  stepWidth(dir) {
    const i = WIDTHS.findIndex((w) => w.id === this.width.id);
    const next = WIDTHS[Math.min(WIDTHS.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))];
    this.setWidth(next.id);
    this.flash(`笔粗：${next.label}`);
  }

  /* ---------- 坐标 / 尺寸 ---------- */

  toNorm(e) {
    const r = this.canvas && this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))),
      Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height))),
    ];
  }

  resize() {
    if (!this.host || !this.canvas) return;
    const rect = this.host.getBoundingClientRect ? this.host.getBoundingClientRect() : { width: 800 };
    const h = Math.max(this.host.scrollHeight || 0, this.host.offsetHeight || 0, rect.height || 0);
    const rawDpr = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1;
    const dpr = Math.min(Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1, 2);
    this.cssW = Math.max(1, Math.round(rect.width || 800));
    this.cssH = Math.max(1, Math.round(h || 600));
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  updateCursor() {
    if (!this.canvas || !this.canvas.style) return;
    const map = { pen: 'crosshair', highlighter: 'crosshair', eraser: 'cell', lasso: 'crosshair', shape: 'crosshair', text: 'text' };
    this.canvas.style.cursor = map[this.tool] || 'crosshair';
  }

  /* ---------- 绘制 ---------- */

  redraw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.cssW || 1, H = this.cssH || 1;
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const it of this.items) this.drawItem(ctx, it, { W, H });
    if (this.drawing) this.drawItem(ctx, this.drawing, { W, H });
    if (this.selection.size) this.drawSelection(ctx, W, H);
    if (this.lasso && this.lasso.length > 1) this.drawLasso(ctx, W, H);
  }

  drawItem(ctx, item, opts) {
    if (!item) return;
    const W = opts && opts.W ? opts.W : this.cssW || 1;
    const H = opts && opts.H ? opts.H : this.cssH || 1;
    if (item.kind === 'text') return this.drawText(ctx, item, W, H);
    if (item.kind === 'image') return this.drawImage(ctx, item, W, H);

    const w = Math.max(1, num(item.width, 0.003) * W);
    ctx.save();
    ctx.globalCompositeOperation = item.tool === 'highlighter' ? 'multiply' : 'source-over';
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = w;
    const line = itemPolyline(item);
    if (item.shape === 'rect' && line.length >= 5) {
      ctx.beginPath();
      ctx.moveTo(line[0][0] * W, line[0][1] * H);
      for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0] * W, line[i][1] * H);
      ctx.closePath();
      ctx.stroke();
    } else if (item.shape === 'ellipse' && line.length > 2) {
      const b = bboxOfPoints(line);
      ctx.beginPath();
      if (ctx.ellipse) ctx.ellipse(((b.x0 + b.x1) / 2) * W, ((b.y0 + b.y1) / 2) * H, Math.max(1, ((b.x1 - b.x0) / 2) * W), Math.max(1, ((b.y1 - b.y0) / 2) * H), 0, 0, Math.PI * 2);
      else ctx.arc(((b.x0 + b.x1) / 2) * W, ((b.y0 + b.y1) / 2) * H, Math.max(1, ((b.x1 - b.x0) / 2) * W), 0, Math.PI * 2);
      ctx.stroke();
    } else if (line.length === 1) {
      ctx.beginPath();
      ctx.arc(line[0][0] * W, line[0][1] * H, w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * W, y * H) : ctx.lineTo(x * W, y * H)));
      ctx.stroke();
      if (item.shape === 'arrow' && line.length >= 2) {
        const a = line[line.length - 2], z = line[line.length - 1];
        const ang = Math.atan2((z[1] - a[1]) * H, (z[0] - a[0]) * W);
        const size = Math.max(10, w * 3.2);
        ctx.beginPath();
        ctx.moveTo(z[0] * W, z[1] * H);
        ctx.lineTo(z[0] * W - size * Math.cos(ang - 0.42), z[1] * H - size * Math.sin(ang - 0.42));
        ctx.moveTo(z[0] * W, z[1] * H);
        ctx.lineTo(z[0] * W - size * Math.cos(ang + 0.42), z[1] * H - size * Math.sin(ang + 0.42));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawText(ctx, item, W, H) {
    const px = Math.max(11, num(item.size, 0.023) * W);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = item.color || PALETTE[5].pen;
    ctx.font = `600 ${px}px ${TEXT_FONT}`;
    ctx.textBaseline = 'top';
    const cx = (num(item.x) + estimateTextSize(item.text, item.size).w / 2) * W;
    const cy = (num(item.y) + estimateTextSize(item.text, item.size).h / 2) * H;
    if (item.rot) {
      ctx.translate(cx, cy);
      ctx.rotate(num(item.rot, 0));
      ctx.translate(-cx, -cy);
    }
    const lines = String(item.text || '').split('\n');
    lines.forEach((line, i) => ctx.fillText(line, num(item.x) * W, num(item.y) * H + i * px * 1.36));
    ctx.restore();
  }

  drawImage(ctx, item, W, H) {
    const x = num(item.x) * W, y = num(item.y) * H;
    const w = Math.max(4, num(item.w) * W), h = Math.max(4, num(item.h) * H);
    const img = this.imageElement(item.src);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    if (img && img.complete && img.naturalWidth) {
      if (item.rot) {
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(num(item.rot, 0));
        ctx.translate(-(x + w / 2), -(y + h / 2));
      }
      ctx.drawImage(img, x, y, w, h);
    } else {
      ctx.fillStyle = 'rgba(127,127,127,.12)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(127,127,127,.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  }

  drawSelection(ctx, W, H) {
    const sel = this.selectedItems();
    const b = boundsOfItems(sel);
    if (!b) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = selectAccent();
    ctx.strokeRect(b.x0 * W - 8, b.y0 * H - 8, (b.x1 - b.x0) * W + 16, (b.y1 - b.y0) * H + 16);
    ctx.setLineDash([]);
    for (const h of this.handlePoints()) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = selectAccent();
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLasso(ctx, W, H) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = selectAccent();
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    this.lasso.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * W, y * H) : ctx.lineTo(x * W, y * H)));
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = selectAccent();
    ctx.fill();
    ctx.restore();
  }

  /* ---------- 状态 / 提示 ---------- */

  refreshBar() {
    if (!this.bar) return;
    const undoBtn = this.bar.querySelector('[data-act="undo"]');
    const redoBtn = this.bar.querySelector('[data-act="redo"]');
    const delBtn = this.bar.querySelector('[data-act="delete"]');
    const dupBtn = this.bar.querySelector('[data-act="duplicate"]');
    if (undoBtn) {
      undoBtn.disabled = !this.history.canUndo;
      undoBtn.title = this.history.canUndo ? `撤销（Ctrl/Cmd+Z，还能退 ${this.history.undoDepth} 步）` : '没有可撤销的操作';
    }
    if (redoBtn) {
      redoBtn.disabled = !this.history.canRedo;
      redoBtn.title = this.history.canRedo ? `重做（Ctrl/Cmd+Shift+Z，还能进 ${this.history.redoDepth} 步）` : '没有可重做的操作';
    }
    if (delBtn) delBtn.disabled = !this.selection.size;
    if (dupBtn) dupBtn.disabled = !this.selection.size;
    this.bar.querySelectorAll('[data-context]').forEach((el) => el.classList.toggle('on', el.dataset.context === this.tool));
    if (this.status) {
      const c = countItems(this.items);
      const bits = [`笔迹 ${c.stroke}`];
      if (c.text) bits.push(`文字 ${c.text}`);
      if (c.image) bits.push(`图片 ${c.image}`);
      if (this.selection.size) bits.push(`选中 ${this.selection.size}`);
      if (this.history.undoDepth) bits.push(`可撤销 ${this.history.undoDepth} 步`);
      this.status.textContent = this.items.length ? bits.join(' · ') : '空白页';
    }
  }

  info() {
    const c = countItems(this.items);
    return {
      ...c,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoDepth: this.history.undoDepth,
      selection: this.selection.size,
      tool: this.tool,
    };
  }

  notify() {
    this.onChange && this.onChange(this.items, this.info());
  }

  flash(msg, kind) {
    this.onToast && this.onToast(msg, kind);
  }

  /* ---------- 对外 ---------- */

  setActive(on) {
    this.active = !!on;
    if (this.wrap) this.wrap.style.display = this.active ? 'block' : 'none';
    if (typeof document !== 'undefined' && document.body && document.body.classList) document.body.classList.toggle('inking', this.active);
    if (this.active) {
      this.resize();
      this.updateCursor();
      this.refreshBar();
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', this._keyHandler);
      this.onToolChange && this.onToolChange(this.tool);
    } else {
      if (this.editing) this.endTextEdit(true);
      this.abortGesture();
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('keydown', this._keyHandler);
      this.redraw();
    }
  }

  /** 载入内容（v2 items / v1 strokes 都能吃） */
  setItems(list) {
    this.items = normalizeItems(list);
    this.selection.clear();
    this.history.clear();
    this.resize();
    this.refreshBar();
    // 注意：载入不算「改动」，这里不触发 onChange（否则刚打开就显示未保存）
  }

  /** 兼容旧接口名 */
  setStrokes(list) { return this.setItems(list); }

  getItems() { return this.items; }

  /** 兼容旧接口：返回所有对象（老调用点只需要一个可序列化数组） */
  getStrokes() { return this.items; }

  destroy() {
    if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('keydown', this._keyHandler);
    if (this.wrap) this.wrap.remove();
    this.active = false;
    this._imgs.clear();
  }
}

/* ============================ 内部小工具 ============================ */

function boundsCenter(b) {
  if (!b) return { x: 0.5, y: 0.5 };
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

function itemLabel(item) {
  if (!item) return null;
  if (item.kind === 'text') return '加文字';
  if (item.kind === 'image') return '插入图片';
  if (item.tool === 'highlighter') return '荧光笔';
  if (item.shape) return `画${(SHAPE_KINDS.find((s) => s.id === item.shape) || {}).label || '形状'}`;
  return '画笔';
}

function hexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(47,111,232,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function selectAccent() {
  try {
    if (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.documentElement) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent');
      if (v && /^#|rgb/.test(String(v).trim())) return String(v).trim();
    }
  } catch (e) {}
  return SELECT_ACCENT;
}

function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    try {
      const FR = typeof FileReader === 'function' ? FileReader : null;
      if (!FR) return resolve('');
      const fr = new FR();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(file);
    } catch (e) { resolve(''); }
  });
}

function loadImageRatio(src) {
  return new Promise((resolve, reject) => {
    try {
      const img = new Image();
      img.onload = () => resolve(img.naturalHeight && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.66);
      img.onerror = () => reject(new Error('load fail'));
      img.src = src;
    } catch (e) { reject(e); }
  });
}
