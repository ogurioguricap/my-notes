/**
 * GoodNotes 模式 · 页面编辑引擎
 *
 * 在标注层（docs/js/ink.mjs）已经跑通的几何、撤销栈、套索、形状识别之上，补齐手账 App 的页面级能力：
 *   · 4 种笔型：圆珠笔 / 钢笔 / 毛笔 / 铅笔（笔宽随速度与压感变化，起收笔有笔锋）
 *   · 荧光笔：自动拉直、半透明压字不糊、可只擦荧光笔
 *   · 橡皮 3 模式：整笔 / 像素 / 仅荧光笔，尺寸可调
 *   · 套索：自由圈选 + 矩形选择，移动 / 缩放 / 旋转 / 改色 / 改透明度 / 层级 / 复制粘贴
 *   · 形状：自动识别 + 手选直线/箭头/矩形/椭圆/三角，可填充
 *   · 文本：字体 / 字号 / 粗斜 / 对齐 / 颜色，原位编辑
 *   · 图片、贴纸元素库、和纸胶带（掩蔽）、激光笔、尺子（吸附画直线）、缩放窗（写大写小）
 *   · 撤销 / 重做跨页可用（每一步记「哪一页 + 操作前内容」）
 *   · 视口缩放平移、只读渲染（导出 / 缩略图 / 打印用同一个绘制实现，保证所见即所得）
 *
 * 纯计算部分（笔宽曲线、胶带矩形、尺子吸附、缩放窗映射）都导出，便于无浏览器环境测试。
 */
import {
  InkHistory, PALETTE, WIDTHS, ERASER_SIZES, SHAPE_KINDS, TEXT_SIZES, TEXT_FONT,
  uid, clamp01, normalizeItems, estimateTextSize, itemBounds, boundsOfItems, itemPolyline,
  hitTestItem, polygonSelectsItem, pointInPolygon, transformItems, eraseAtPoint,
  recognizeShape, snapToShape, straightenHighlighter, countItems,
} from '../ink.mjs';
import { paperDims, renderPaper } from './paper.mjs';

/* ============================ 常量 ============================ */

export const PEN_TYPES = [
  { id: 'ball', label: '圆珠笔', glyph: '🖊', opacity: 1, base: 1, min: 0.62, max: 1.12, taper: 0.02, velocity: 0.35 },
  { id: 'fountain', label: '钢笔', glyph: '🖋', opacity: 0.96, base: 1, min: 0.35, max: 1.5, taper: 0.12, velocity: 0.9 },
  { id: 'brush', label: '毛笔', glyph: '🖌', opacity: 0.92, base: 1.5, min: 0.3, max: 1.9, taper: 0.18, velocity: 1.15 },
  { id: 'pencil', label: '铅笔', glyph: '✏️', opacity: 0.72, base: 0.85, min: 0.6, max: 1.05, taper: 0.05, velocity: 0.4 },
];

export const TOOLS = ['pen', 'highlighter', 'eraser', 'lasso', 'shape', 'text', 'image', 'sticker', 'tape', 'laser', 'ruler'];

export const ERASER_MODES = [
  { id: 'stroke', label: '整笔', hint: '碰到哪条线删哪条' },
  { id: 'pixel', label: '像素', hint: '只擦经过的一段' },
  { id: 'highlighter', label: '仅荧光笔', hint: '只擦掉荧光笔画的' },
];

export const HIGHLIGHTER_COLORS = [
  { id: 'yellow', pen: 'rgba(255,224,80,.42)', label: '黄' },
  { id: 'green', pen: 'rgba(120,231,150,.40)', label: '绿' },
  { id: 'blue', pen: 'rgba(120,190,255,.40)', label: '蓝' },
  { id: 'pink', pen: 'rgba(255,150,190,.38)', label: '粉' },
  { id: 'purple', pen: 'rgba(190,160,255,.38)', label: '紫' },
];

export const TAPE_COLORS = [
  { id: 'white', value: 'rgba(255,255,255,.92)', label: '白' },
  { id: 'cream', value: 'rgba(248,236,205,.94)', label: '米黄' },
  { id: 'pink', value: 'rgba(255,214,224,.92)', label: '粉' },
  { id: 'mint', value: 'rgba(205,242,224,.92)', label: '薄荷' },
  { id: 'sky', value: 'rgba(206,229,255,.92)', label: '天蓝' },
  { id: 'grey', value: 'rgba(226,226,230,.94)', label: '灰' },
];

/** 贴纸 / 图章元素库（对齐 GoodNotes 的 Elements，按分类给一组常用图形） */
export const ELEMENTS = [
  { group: '标记', items: ['⭐', '✅', '❗', '❓', '💡', '🔥', '📌', '🚩', '⚠️', '⏰', '📎', '🎯'] },
  { group: '学习', items: ['📖', '📝', '🧮', '🔬', '🧠', '🏆', '📅', '✏️', '📐', '🔖', '🧩', '🎓'] },
  { group: '生活', items: ['☕', '🍰', '🌸', '🌿', '🌙', '☀️', '🐱', '🐶', '🎵', '🎨', '✈️', '🏠'] },
  { group: '手账', items: ['💌', '🎀', '🧸', '🍓', '🌈', '🫧', '🕯', '🌻', '📷', '🪄', '💫', '🧷'] },
];

export const FONTS = [
  { id: 'sans', label: '黑体', css: '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
  { id: 'serif', label: '宋体', css: 'Georgia, "Songti SC", "SimSun", serif' },
  { id: 'hand', label: '手写', css: '"Kaiti SC", "KaiTi", "STKaiti", cursive' },
  { id: 'mono', label: '等宽', css: 'ui-monospace, "SFMono-Regular", Consolas, monospace' },
];

export const TEXT_SIZE_STEPS = [
  { id: 'xs', label: '极小', value: 0.014 },
  { id: 's', label: '小', value: 0.019 },
  { id: 'm', label: '中', value: 0.026 },
  { id: 'l', label: '大', value: 0.036 },
  { id: 'xl', label: '特大', value: 0.052 },
];

const prefersDark = () => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) { return false; }
};

/* ============================ 纯计算工具（可测） ============================ */

/**
 * 页面内容的规整：笔迹/形状/文本/图片沿用标注层的规范，
 * 贴纸与胶带是笔记本模式独有的类型，笔型、逐点笔宽、透明度、字体这些也要原样留住
 * （否则撤销一次就会把「毛笔」「自定义笔宽」这类信息抹掉）
 */
export function normalizePageItems(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = raw.kind || 'stroke';
    if (kind === 'sticker') {
      if (!raw.glyph) continue;
      out.push({
        kind: 'sticker', id: raw.id || uid('st'), glyph: String(raw.glyph),
        x: Number(raw.x) || 0, y: Number(raw.y) || 0,
        size: Number(raw.size) || 0.07, rot: Number(raw.rot) || 0,
        opacity: raw.opacity == null ? 1 : raw.opacity,
      });
      continue;
    }
    if (kind === 'tape') {
      out.push({
        kind: 'tape', id: raw.id || uid('tp'),
        x: Number(raw.x) || 0, y: Number(raw.y) || 0,
        w: Math.max(0.005, Number(raw.w) || 0.2), h: Math.max(0.005, Number(raw.h) || 0.05),
        angle: Number(raw.angle) || 0, color: raw.color || 'rgba(255,255,255,.92)',
        opacity: raw.opacity == null ? 0.95 : raw.opacity,
      });
      continue;
    }
    const [base] = normalizeItems([raw]);
    if (!base) continue;
    out.push({
      ...base,
      ...(raw.pen ? { pen: raw.pen } : {}),
      ...(raw.opacity != null ? { opacity: raw.opacity } : {}),
      ...(Array.isArray(raw.widths) ? { widths: raw.widths.slice() } : {}),
      ...(Array.isArray(raw.pressures) ? { pressures: raw.pressures.slice() } : {}),
      ...(raw.pressureStrength != null ? { pressureStrength: raw.pressureStrength } : {}),
      ...(raw.shape ? { shape: raw.shape } : {}),
      ...(raw.fill ? { fill: true } : {}),
      ...(base.kind === 'text' ? {
        ...(raw.font ? { font: raw.font } : {}),
        ...(raw.bold ? { bold: true } : {}),
        ...(raw.italic ? { italic: true } : {}),
        ...(raw.align ? { align: raw.align } : {}),
        ...(raw.rot ? { rot: raw.rot } : {}),
      } : {}),
    });
  }
  return out;
}

/** 速度 → 笔宽系数：写得快变细（手账 App 的「速度感应」；没有压感设备时靠它）
 * @param {number} pxPerMs 每秒移动多少像素（一般 0.3~2；>2 视为甩笔）
 */
export function velocityFactor(pxPerMs, strength = 0.5) {
  const s = Math.max(0, Number(pxPerMs) || 0);
  const fast = Math.min(1, s / 2.2);                    // 2.2 px/ms ≈ 很快
  return Math.max(0.5, 1 - fast * 0.5 * Math.min(2, Math.max(0, strength)));
}

/** 采样点之间的像素距离 → 近似速度（假设采样间隔约 12ms，没有时间戳时的兜底） */
export function stepSpeeds(points, W, H, intervalMs = 12) {
  const out = [];
  for (let i = 0; i < (points || []).length; i++) {
    if (i === 0) {
      const d = points.length > 1 ? Math.hypot((points[1][0] - points[0][0]) * W, (points[1][1] - points[0][1]) * H) : 0;
      out.push(d / intervalMs);
    } else {
      const d = Math.hypot((points[i][0] - points[i - 1][0]) * W, (points[i][1] - points[i - 1][1]) * H);
      out.push(d / intervalMs);
    }
  }
  return out;
}

/**
 * 逐点笔宽（像素）
 * @param {Array<[number,number]>} points 归一化坐标
 * @param {object} o { w, h, base(px), type, pressures[], speeds[], times[], strength }
 */
export function strokeWidths(points, o = {}) {
  const W = Math.max(1, o.w || 1), H = Math.max(1, o.h || 1);
  const type = PEN_TYPES.find((t) => t.id === o.type) || PEN_TYPES[0];
  const base = Math.max(1, (o.base || W * 0.0038)) * type.base;
  const strength = o.strength == null ? type.velocity : o.strength;
  const pts = points || [];
  const n = pts.length;
  if (!n) return [];
  // 速度：优先用真实时间戳算出来的 px/ms，其次用采样间距估算
  let speeds = o.speeds;
  if (!Array.isArray(speeds) || speeds.length !== n) {
    if (Array.isArray(o.times) && o.times.length === n) {
      speeds = pts.map((p, i) => {
        const j = i === 0 ? Math.min(1, n - 1) : i - 1;
        const dt = Math.abs((o.times[i] || 0) - (o.times[j] || 0)) || 12;
        return (Math.hypot((p[0] - pts[j][0]) * W, (p[1] - pts[j][1]) * H)) / dt;
      });
    } else {
      speeds = stepSpeeds(pts, W, H);
    }
  }
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    let f = 1;
    if (o.pressures && Number.isFinite(o.pressures[i]) && o.pressures[i] > 0) {
      f = 0.45 + Math.min(1, Math.max(0, o.pressures[i])) * 0.85;   // 有压感就用压感
    } else {
      f = velocityFactor(speeds[i], strength);
    }
    raw[i] = Math.min(type.max, Math.max(type.min, f));
  }
  let out = raw.map((f) => f * base);
  // 起收笔渐细（毛笔更明显）
  const t = Math.max(0, Math.min(0.5, type.taper * 3));
  if (t > 0 && n >= 4) {
    const k = Math.max(1, Math.round(n * t));
    for (let i = 0; i < k; i++) {
      const r = 0.35 + 0.65 * (i / k);
      out[i] *= r;
      out[n - 1 - i] *= r;
    }
  }
  // 平滑一下，避免宽度跳变
  return out.map((v, i) => {
    const a = out[Math.max(0, i - 1)], b = out[Math.min(n - 1, i + 1)];
    return Math.max(0.4, (a + v * 2 + b) / 4);
  });
}

/** 两笔之间的「胶带」矩形（跟着手的方向走） */
export function tapeGeometry(p0, p1, thickness = 0.045) {
  const dx = (p1[0] - p0[0]), dy = (p1[1] - p0[1]);
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const half = Math.max(0.012, thickness / 2);
  const x0 = Math.min(p0[0], p1[0]) - half * Math.abs(Math.sin(ang));
  const x1 = Math.max(p0[0], p1[0]) + half * Math.abs(Math.sin(ang));
  const y0 = Math.min(p0[1], p1[1]) - half * Math.abs(Math.cos(ang));
  const y1 = Math.max(p0[1], p1[1]) + half * Math.abs(Math.cos(ang));
  return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.008, y1 - y0), angle: ang, length: len };
}

/** 尺子：把一笔吸附到尺子边缘（画直线用） */
export function snapToRuler(points, ruler) {
  if (!ruler || !ruler.on || !points || points.length < 2) return points;
  const a = [ruler.x, ruler.y];
  const b = [ruler.x + Math.cos(ruler.angle) * ruler.length, ruler.y + Math.sin(ruler.angle) * ruler.length];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-9;
  const first = points[0], last = points[points.length - 1];
  const proj = (p) => {
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return [a[0] + t * dx, a[1] + t * dy];
  };
  const p0 = proj(first), p1 = proj(last);
  // 中间点也投影，这样即使手抖，出来的也是一条笔直的线
  return points.map((p, i) => (i === 0 ? p0 : i === points.length - 1 ? p1 : proj(p)));
}

/** 尺子边缘最近点（拖动尺子时用） */
export function rulerEdge(ruler) {
  if (!ruler) return null;
  return {
    a: [ruler.x, ruler.y],
    b: [ruler.x + Math.cos(ruler.angle) * ruler.length, ruler.y + Math.sin(ruler.angle) * ruler.length],
  };
}

/** 缩放窗：把「放大条里的坐标」映射回「页面坐标」 */
export function zoomMap(bandPt, band, region) {
  const x = region.x + ((bandPt[0] - band.x) / Math.max(1, band.w)) * region.w;
  const y = region.y + ((bandPt[1] - band.y) / Math.max(1, band.h)) * region.h;
  return [Math.min(1.6, Math.max(-0.6, x)), Math.min(1.6, Math.max(-0.6, y))];
}

/** 贴纸对象的包围盒 */
export function stickerBounds(item) {
  const s = Number(item && item.size) || 0.06;
  return { x0: Number(item.x) || 0, y0: Number(item.y) || 0, x1: (Number(item.x) || 0) + s * 1.1, y1: (Number(item.y) || 0) + s * 1.1 };
}

/** 统一包围盒（把贴纸 / 胶带也算进来） */
export function itemBox(item) {
  if (!item) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  if (item.kind === 'sticker') return stickerBounds(item);
  if (item.kind === 'tape') {
    return { x0: Number(item.x) || 0, y0: Number(item.y) || 0, x1: (Number(item.x) || 0) + (Number(item.w) || 0), y1: (Number(item.y) || 0) + (Number(item.h) || 0) };
  }
  return itemBounds(item);
}

export function boxOfItems(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of list) {
    const b = itemBox(it);
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}

function itemHit(item, x, y, W, H, opts = {}) {
  if (!item) return false;
  if (item.kind === 'sticker') {
    const b = stickerBounds(item);
    const pad = 6 / Math.max(1, W);
    return x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;
  }
  if (item.kind === 'tape') {
    const b = itemBox(item);
    return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  }
  return hitTestItem(item, x, y, W, H, opts);
}

function noteLabel(item) {
  if (!item) return '编辑';
  if (item.kind === 'text') return '文字';
  if (item.kind === 'image') return '图片';
  if (item.kind === 'sticker') return '贴纸';
  if (item.kind === 'tape') return item.peeled ? '撕胶带' : '贴胶带';
  if (item.tool === 'highlighter') return '荧光笔';
  if (item.shape) return `画${(SHAPE_KINDS.find((s) => s.id === item.shape) || {}).label || '形状'}`;
  const p = PEN_TYPES.find((t) => t.id === item.pen);
  return p ? p.label : '画笔';
}

/* ============================ 只读渲染（导出 / 缩略图 / 打印共用） ============================ */

function imageCacheFor(state) {
  if (!state._imgs) state._imgs = new Map();
  return state._imgs;
}

function imageOf(src, state, onload) {
  if (!src) return null;
  const cache = imageCacheFor(state);
  if (cache.has(src)) return cache.get(src);
  if (typeof Image !== 'function') { cache.set(src, null); return null; }
  const img = new Image();
  img.onload = () => onload && onload();
  try { img.src = src; } catch (e) {}
  cache.set(src, img);
  return img;
}

/** 画一条笔迹（圆珠笔/钢笔/毛笔/铅笔 —— 逐段变宽，起收笔有笔锋） */
export function drawStroke(ctx, item, W, H, state = {}) {
  const pts = item.points || [];
  if (!pts.length) return;
  const type = PEN_TYPES.find((t) => t.id === item.pen) || PEN_TYPES[0];
  const basePx = Math.max(1, (Number(item.width) || 0.0038) * W);
  // widths 存的是「相对页宽的笔宽」（这样换尺寸/导出 PDF 后粗细一致），这里换算成像素
  const widths = item.widths && item.widths.length === pts.length
    ? item.widths.map((w) => Math.max(0.5, Number(w) * W))
    : strokeWidths(pts, { w: W, h: H, base: basePx, type: type.id, pressures: item.pressures, strength: item.pressureStrength });

  ctx.save();
  ctx.globalCompositeOperation = item.tool === 'highlighter' ? 'multiply' : 'source-over';
  ctx.globalAlpha = item.opacity == null ? (item.tool === 'highlighter' ? 0.42 : type.opacity) : item.opacity;
  ctx.strokeStyle = item.color || '#2B2723';
  ctx.fillStyle = item.color || '#2B2723';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    const r = Math.max(0.6, (widths[0] || basePx) / 2);
    ctx.beginPath();
    ctx.arc(pts[0][0] * W, pts[0][1] * H, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (type.id === 'pencil') {
    // 铅笔：两层细线轻微错位，做出「石墨感」
    for (const off of [0, 0.6]) {
      ctx.beginPath();
      for (let i = 1; i < pts.length; i++) {
        ctx.lineWidth = Math.max(0.5, ((widths[i - 1] + widths[i]) / 2) * (off ? 0.7 : 1));
        ctx.beginPath();
        ctx.moveTo(pts[i - 1][0] * W, pts[i - 1][1] * H);
        ctx.lineTo(pts[i][0] * W + off, pts[i][1] * H + off);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }

  for (let i = 1; i < pts.length; i++) {
    ctx.lineWidth = Math.max(0.5, (widths[i - 1] + widths[i]) / 2);
    ctx.beginPath();
    ctx.moveTo(pts[i - 1][0] * W, pts[i - 1][1] * H);
    ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
    ctx.stroke();
  }
  ctx.restore();
}

/** 画一个对象（编辑与导出共用同一份实现，保证所见即所得） */
export function drawItem(ctx, item, W, H, state = {}) {
  if (!item) return;
  if (item.kind === 'text') {
    const s = estimateTextSize(item.text, item.size);
    const px = Math.max(10, (Number(item.size) || 0.026) * W);
    ctx.save();
    ctx.globalAlpha = item.opacity == null ? 1 : item.opacity;
    ctx.fillStyle = item.color || '#2B2723';
    const font = FONTS.find((f) => f.id === item.font) || FONTS[0];
    ctx.font = `${item.bold ? '700' : '400'} ${item.italic ? 'italic ' : ''}${px}px ${font.css}`;
    ctx.textBaseline = 'top';
    const cx = ((Number(item.x) || 0) + s.w / 2) * W;
    const cy = ((Number(item.y) || 0) + s.h / 2) * H;
    if (item.rot || item.angle) {
      ctx.translate(cx, cy);
      ctx.rotate(item.rot || item.angle || 0);
      ctx.translate(-cx, -cy);
    }
    const lines = String(item.text || '').split('\n');
    const align = item.align || 'left';
    lines.forEach((line, i) => {
      const lw = estimateTextSize(line, item.size).w * W;
      const ox = align === 'center' ? (s.w * W - lw) / 2 : align === 'right' ? s.w * W - lw : 0;
      ctx.fillText(line, (Number(item.x) || 0) * W + ox, (Number(item.y) || 0) * H + i * px * 1.36);
    });
    ctx.restore();
    return;
  }

  if (item.kind === 'sticker') {
    const s = Number(item.size) || 0.06;
    ctx.save();
    ctx.globalAlpha = item.opacity == null ? 1 : item.opacity;
    ctx.font = `${Math.max(10, s * W)}px ${TEXT_FONT}`;
    ctx.textBaseline = 'top';
    const cx = ((Number(item.x) || 0) + s / 2) * W;
    const cy = ((Number(item.y) || 0) + s / 2) * H;
    if (item.rot) {
      ctx.translate(cx, cy);
      ctx.rotate(item.rot);
      ctx.translate(-cx, -cy);
    }
    ctx.fillText(String(item.glyph || '⭐'), (Number(item.x) || 0) * W, (Number(item.y) || 0) * H);
    ctx.restore();
    return;
  }

  if (item.kind === 'tape') {
    const x = (Number(item.x) || 0) * W, y = (Number(item.y) || 0) * H;
    const w = Math.max(2, (Number(item.w) || 0) * W), h = Math.max(2, (Number(item.h) || 0) * H);
    ctx.save();
    ctx.globalAlpha = item.opacity == null ? 0.95 : item.opacity;
    ctx.fillStyle = item.color || 'rgba(255,255,255,.92)';
    if (item.angle) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(item.angle);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.10;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    for (let i = 0; i < w; i += 6) { ctx.beginPath(); ctx.moveTo(x + i, y); ctx.lineTo(x + i, y + h); ctx.stroke(); }
    ctx.restore();
    return;
  }

  if (item.kind === 'image') {
    const x = (Number(item.x) || 0) * W, y = (Number(item.y) || 0) * H;
    const w = Math.max(4, (Number(item.w) || 0) * W), h = Math.max(4, (Number(item.h) || 0) * H);
    const img = imageOf(item.src, state, state.onImageLoad);
    ctx.save();
    ctx.globalAlpha = item.opacity == null ? 1 : item.opacity;
    if (img && img.complete && img.naturalWidth) {
      if (item.rot) {
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(item.rot);
        ctx.translate(-(x + w / 2), -(y + h / 2));
      }
      ctx.drawImage(img, x, y, w, h);
    } else {
      ctx.fillStyle = 'rgba(127,127,127,.10)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(127,127,127,.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(90,90,90,.7)';
      ctx.font = `12px ${TEXT_FONT}`;
      ctx.fillText('图片', x + 8, y + 18);
    }
    ctx.restore();
    return;
  }

  // 笔迹 / 形状
  const shape = item.shape;
  if (shape && shape !== 'line' && shape !== 'arrow') {
    const line = itemPolyline(item);
    const px = line.map(([x, y]) => [x * W, y * H]);
    ctx.save();
    ctx.globalCompositeOperation = item.tool === 'highlighter' ? 'multiply' : 'source-over';
    ctx.globalAlpha = item.opacity == null ? 1 : item.opacity;
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = Math.max(1, (Number(item.width) || 0.0038) * W);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (shape === 'ellipse') {
      const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (ctx.ellipse) ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(1, (x1 - x0) / 2), Math.max(1, (y1 - y0) / 2), 0, 0, Math.PI * 2);
      else ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, Math.max(1, (x1 - x0) / 2), 0, Math.PI * 2);
      ctx.closePath();
    } else {
      px.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    }
    if (item.fill) { ctx.globalAlpha = (item.opacity == null ? 1 : item.opacity) * 0.22; ctx.fill(); ctx.globalAlpha = item.opacity == null ? 1 : item.opacity; }
    ctx.stroke();
    ctx.restore();
    return;
  }

  drawStroke(ctx, item, W, H, state);

  if (shape === 'arrow') {
    const pts = item.points || [];
    if (pts.length >= 2) {
      const a = pts[pts.length - 2], z = pts[pts.length - 1];
      const ang = Math.atan2((z[1] - a[1]) * H, (z[0] - a[0]) * W);
      const size = Math.max(10, (Number(item.width) || 0.0038) * W * 3.4);
      ctx.save();
      ctx.strokeStyle = item.color;
      ctx.lineWidth = Math.max(1, (Number(item.width) || 0.0038) * W);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(z[0] * W, z[1] * H);
      ctx.lineTo(z[0] * W - size * Math.cos(ang - 0.42), z[1] * H - size * Math.sin(ang - 0.42));
      ctx.moveTo(z[0] * W, z[1] * H);
      ctx.lineTo(z[0] * W - size * Math.cos(ang + 0.42), z[1] * H - size * Math.sin(ang + 0.42));
      ctx.stroke();
      ctx.restore();
    }
  }
}

/**
 * 把一整页画到 canvas（纸张 + 内容；只读，导出/缩略图/打印都用它）
 * @param {HTMLCanvasElement|CanvasRenderingContext2D} target
 */
export function renderPage(target, { paper, items = [], scale = 1, dpr = 1, dark = false, state = {} } = {}) {
  const canvas = target && target.getContext ? target : null;
  const ctx = canvas ? target.getContext('2d') : target;
  const dims = paperDims(paper);
  const w = Math.round(dims.w * scale);
  const h = Math.round(dims.h * scale);
  if (canvas) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (canvas.style) { canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
  }
  if (!ctx) return { w, h };
  if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  renderPaper(ctx, {
    w, h,
    template: (paper && paper.template) || 'lined',
    color: (paper && paper.color) || (dark && !paper ? '#22252B' : '#FFFFFF'),
    lineColor: paper && paper.lineColor,
  });
  // 荧光笔先画（压在手写与文字下面，和手账 App 一致）
  const hl = items.filter((it) => it && it.tool === 'highlighter');
  const rest = items.filter((it) => it && it.tool !== 'highlighter');
  for (const it of hl) drawItem(ctx, it, w, h, state);
  for (const it of rest) drawItem(ctx, it, w, h, state);
  return { w, h };
}

/* ============================ 交互式编辑器 ============================ */

export class PageEditor {
  /**
   * @param {object} o
   *   o.canvas    页面画布
   *   o.host      画布外层容器（缩放窗、尺子等浮层挂这里）
   *   o.getPage   () => { pageId, pageIndex, paper, items }
   *   o.setItems  (pageId, items) => void   内容变化时回写
   *   o.onStatus  (info) => void
   *   o.onToast   (msg) => void
   *   o.onDirty   () => void
   *   o.onGotoPage (pageIndex) => void     撤销跨页时用
   */
  constructor(o = {}) {
    this.canvas = o.canvas;
    this.host = o.host || (o.canvas && o.canvas.parentElement) || null;
    this.getPage = o.getPage || (() => null);
    this.setItemsCb = o.setItems || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.onToast = o.onToast || (() => {});
    this.onDirty = o.onDirty || (() => {});
    this.onGotoPage = o.onGotoPage || (() => {});
    this.ctx = this.canvas && this.canvas.getContext ? this.canvas.getContext('2d') : null;

    this.items = [];
    this.pageId = '';
    this.pageIndex = 0;
    this.paper = null;
    this.selection = new Set();
    this.clipboard = [];
    this.history = new InkHistory({ limit: 300 });

    this.tool = 'pen';
    this.penType = 'fountain';
    this.color = PALETTE[0].pen;
    this.highlightColor = HIGHLIGHTER_COLORS[0].pen;
    this.width = WIDTHS[1];
    this.opacity = 1;
    this.eraserMode = 'stroke';
    this.eraserSize = ERASER_SIZES[1];
    this.shapeKind = 'auto';
    this.shapeFill = false;
    this.textStyle = { font: 'sans', size: 'm', bold: false, italic: false, align: 'left' };
    this.tapeColor = TAPE_COLORS[0].value;
    this.stickerGlyph = '⭐';
    this.ruler = { on: false, x: 0.12, y: 0.5, angle: 0, length: 0.76 };
    this.zoom = { on: false, scale: 2, x: 0.1, y: 0.35, w: 0.4, h: 0.3 };
    this.view = { scale: 1, x: 0, y: 0 };

    this.drawing = null;
    this.gesture = null;
    this.lassoPoly = null;
    this.lassoRect = null;
    this.laser = [];
    this.laserRAF = 0;
    this.editing = null;
    this.suppressStore = false;

    this._pending = null;
    this._pendingPage = '';
    this.dpr = Math.min(2, (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1);
    this._buildOverlays();
    this._handlers = this._bindCanvas();
    this._keyHandler = (e) => this.onKey(e);
  }

  /* ---------- 尺寸 / 页面 ---------- */

  dims() {
    const d = paperDims(this.paper || this.getPage()?.paper || null);
    return d;
  }

  /** 切换当前页（内容从 getPage() 现取，保证与数据层一致） */
  setPage(index) {
    if (this.editing) this.endTextEdit(true);
    const info = this.getPage && this.getPage(index);
    if (!info) return false;
    this.pageIndex = index;
    this.pageId = info.pageId;
    this.paper = info.paper;
    this.items = normalizePageItems(info.items || []);
    this.selection.clear();
    this.drawing = null;
    this.gesture = null;
    this.lassoPoly = null;
    this.lassoRect = null;
    this.resize();
    this.refreshStatus();
    return true;
  }

  reload() {
    const info = this.getPage && this.getPage(this.pageIndex);
    if (!info || info.pageId !== this.pageId) return this.setPage(this.pageIndex);
    this.items = normalizePageItems(info.items || []);
    this.redraw();
    this.refreshStatus();
    return true;
  }

  resize() {
    if (!this.canvas) return;
    const d = this.dims();
    const s = Math.max(0.25, this.view.scale || 1);
    const scale = Math.min(2, this.dpr * (s > 1.5 ? s / 1.5 : 1));
    this.cssW = d.w;
    this.cssH = d.h;
    this.canvas.style.width = `${d.w}px`;
    this.canvas.style.height = `${d.h}px`;
    this.canvas.width = Math.round(d.w * scale);
    this.canvas.height = Math.round(d.h * scale);
    if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this._pxScale = scale;
    this.applyViewTransform();
    this.redraw();
  }

  applyViewTransform() {
    if (!this.canvas || !this.canvas.style) return;
    const { scale, x, y } = this.view;
    this.canvas.style.transformOrigin = '0 0';
    this.canvas.style.transform = scale === 1 && !x && !y ? '' : `translate(${x}px, ${y}px) scale(${scale})`;
  }

  setViewScale(scale) {
    this.view.scale = Math.max(0.4, Math.min(4, scale));
    this.applyViewTransform();
    this.resize();
    this.refreshStatus();
  }

  setViewPan(x, y) {
    this.view.x = x;
    this.view.y = y;
    this.applyViewTransform();
  }

  /* ---------- 浮层（缩放窗 / 尺子 / 文本编辑） ---------- */

  _buildOverlays() {
    if (!this.host || typeof document === 'undefined' || !this.host.appendChild) return;
    if (this.host.querySelector && this.host.querySelector('.pg-zoom')) { this.zoomBand = this.host.querySelector('.pg-zoom'); return; }
    const band = document.createElement('div');
    band.className = 'pg-zoom';
    band.innerHTML = `
      <div class="pg-zoom-bar">
        <button type="button" data-z="left" title="放大区域左移">◀</button>
        <span class="pg-zoom-label">放大窗</span>
        <button type="button" data-z="scale" title="切换倍率">2×</button>
        <button type="button" data-z="right" title="放大区域右移">▶</button>
        <button type="button" data-z="close" title="关闭放大窗">✕</button>
      </div>
      <canvas class="pg-zoom-canvas"></canvas>`;
    band.hidden = true;
    this.host.appendChild(band);
    this.zoomBand = band;
    this.zoomCanvas = band.querySelector('.pg-zoom-canvas');
    this.zoomCtx = this.zoomCanvas && this.zoomCanvas.getContext ? this.zoomCanvas.getContext('2d') : null;
    band.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      const act = b.dataset.z;
      if (act === 'close') return this.toggleZoom(false);
      if (act === 'scale') {
        this.zoom.scale = this.zoom.scale >= 3 ? 1.5 : this.zoom.scale + 0.5;
        b.textContent = `${this.zoom.scale}×`;
        return this.redraw();
      }
      const step = 0.12;
      this.zoom.x = Math.max(0, Math.min(0.98 - 0.05, this.zoom.x + (act === 'right' ? step : -step)));
      this.redraw();
    });
    if (this.zoomCanvas) {
      const c = this.zoomCanvas;
      c.addEventListener('pointerdown', (e) => { e.preventDefault && e.preventDefault(); this._zoomDown(e); });
      c.addEventListener('pointermove', (e) => this._zoomMove(e));
      c.addEventListener('pointerup', (e) => this._zoomUp(e));
      c.addEventListener('pointercancel', (e) => this._zoomUp(e));
    }
  }

  toggleZoom(on) {
    this.zoom.on = on == null ? !this.zoom.on : !!on;
    if (this.zoomBand) this.zoomBand.hidden = !this.zoom.on;
    if (this.zoom.on) this.redraw();
    this.refreshStatus();
    return this.zoom.on;
  }

  /** 放大条内的坐标 → 页面坐标 */
  _zoomPoint(e) {
    const c = this.zoomCanvas;
    const r = c && c.getBoundingClientRect ? c.getBoundingClientRect() : { left: 0, top: 0, width: 600, height: 120 };
    const band = { x: 0, y: 0, w: Math.max(1, r.width), h: Math.max(1, r.height) };
    const pt = [e.clientX - r.left, e.clientY - r.top];
    const region = this.zoomRegion();
    return zoomMap(pt, band, region);
  }

  /** 放大条当前对应的页面区域（宽高比和放大条一致） */
  zoomRegion() {
    const d = this.dims();
    const c = this.zoomCanvas;
    const r = c && c.getBoundingClientRect ? c.getBoundingClientRect() : { width: 600, height: 120 };
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    const regionW = Math.min(1.2, w / (d.w * this.zoom.scale));
    const regionH = regionW * (h / w) * (d.w / d.h);
    return { x: this.zoom.x, y: this.zoom.y, w: regionW, h: regionH };
  }

  _zoomDown(e) {
    const p = this._zoomPoint(e);
    this.onDown(p, { pointerType: (e.pointerType === 'touch' ? 'touch' : 'pen'), pressure: e.pressure, fromZoom: true });
    if (this.tool === 'pen' || this.tool === 'highlighter') {
      const region = this.zoomRegion();
      const rel = (p[0] - region.x) / Math.max(1e-6, region.w);
      if (rel > 0.72) {   // 写到右边沿自动往右推进（GoodNotes 的自动推进）
        this.zoom.x = Math.min(1 - region.w * 0.5, this.zoom.x + region.w * 0.45);
      } else if (rel < 0.06) {
        this.zoom.x = Math.max(0, this.zoom.x - region.w * 0.35);
      }
    }
  }

  _zoomMove(e) { this.onMove(this._zoomPoint(e), { pressure: e.pressure, fromZoom: true }); }
  _zoomUp(e) { this.onUp({ fromZoom: true }); }

  /* ---------- 工具与样式 ---------- */

  setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    if (this.editing) this.endTextEdit(true);
    this.abortGesture();
    this.tool = tool;
    this.selection.clear();
    if (this.canvas && this.canvas.style) {
      this.canvas.style.cursor = tool === 'text' ? 'text' : tool === 'eraser' ? 'cell' : tool === 'laser' ? 'crosshair' : 'crosshair';
    }
    this.redraw();
    this.refreshStatus();
  }

  setPenType(id) { if (PEN_TYPES.some((p) => p.id === id)) { this.penType = id; this.refreshStatus(); } }
  setColor(hex) {
    this.color = hex;
    if (this.selection.size) this.applyStyle({ color: hex });
  }
  setHighlightColor(v) { this.highlightColor = v; if (this.selection.size) this.applyStyle({ color: v }); }
  setWidth(id) {
    const w = WIDTHS.find((x) => x.id === id) || WIDTHS[1];
    this.width = w;
    if (this.selection.size) this.applyStyle({ width: this.tool === 'highlighter' ? w.highlighter : w.pen });
  }
  setOpacity(v) {
    this.opacity = Math.max(0.05, Math.min(1, Number(v) || 1));
    if (this.selection.size) this.applyStyle({ opacity: this.opacity });
  }
  setEraserMode(mode) {
    if (!ERASER_MODES.some((m) => m.id === mode)) return;
    this.eraserMode = mode;
    this.onToast(`橡皮：${ERASER_MODES.find((m) => m.id === mode).hint}`);
    this.refreshStatus();
  }
  setEraserSize(id) {
    this.eraserSize = ERASER_SIZES.find((x) => x.id === id) || ERASER_SIZES[1];
  }
  setShapeKind(id) { this.shapeKind = id; this.refreshStatus(); }
  setShapeFill(on) { this.shapeFill = !!on; }
  setTapeColor(v) { this.tapeColor = v; }
  setSticker(glyph) { this.stickerGlyph = glyph || '⭐'; }
  setTextStyle(patch) {
    this.textStyle = { ...this.textStyle, ...patch };
    if (this.selection.size) {
      const sel = this.selectedItems().filter((i) => i.kind === 'text');
      if (sel.length) this.applyStyle(patch);
    }
  }

  applyStyle(patch) {
    if (!this.selection.size) return;
    this.snapshot('改样式');
    this.items = this.items.map((it) => (this.selection.has(it.id) ? { ...it, ...patch } : it));
    this.commit('改样式');
    this.redraw();
  }

  /* ---------- 尺子 ---------- */

  toggleRuler(on) {
    this.ruler.on = on == null ? !this.ruler.on : !!on;
    if (this.ruler.on && !this.ruler.length) this.ruler.length = 0.76;
    this.redraw();
    this.refreshStatus();
    return this.ruler.on;
  }

  rotateRuler(delta) {
    this.ruler.angle = (this.ruler.angle + delta) % (Math.PI * 2);
    this.redraw();
  }

  /* ---------- 手势（指针事件与测试都走这里） ---------- */

  toNorm(e) {
    const r = this.canvas && this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 1000 };
    return [
      Math.min(2, Math.max(-1, (e.clientX - r.left) / Math.max(1, r.width))),
      Math.min(2, Math.max(-1, (e.clientY - r.top) / Math.max(1, r.height))),
    ];
  }

  _bindCanvas() {
    const c = this.canvas;
    if (!c || !c.addEventListener) return {};
    let activePen = false;
    const down = (e) => {
      if (e.pointerType === 'pen') activePen = true;
      // 防误触：笔在用时忽略手指（手账 App 的「手掌误触」）
      if (e.pointerType === 'touch' && activePen) return;
      e.preventDefault && e.preventDefault();
      try { c.setPointerCapture && c.setPointerCapture(e.pointerId); } catch (err) {}
      this.onDown(this.toNorm(e), e);
    };
    const move = (e) => {
      if (e.pointerType === 'touch' && activePen) return;
      this.onMove(this.toNorm(e), e);
    };
    const up = (e) => {
      if (e.pointerType === 'pen') activePen = false;
      if (e.pointerType === 'touch' && activePen) return;
      this.onUp(e);
    };
    const handlers = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up, dblclick: (e) => {
      const p = this.toNorm(e);
      const t = this.topItemAt(p, { kind: 'text' });
      if (t) this.beginTextEdit(t, p);
    } };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', handlers.dblclick);
    this._canvasHandlers = handlers;
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', this._keyHandler);
    return handlers;
  }

  onDown(p, meta = {}) {
    if (this.tool === 'pen' || this.tool === 'highlighter' || this.tool === 'shape' || this.tool === 'tape') {
      return this.startInk(p, meta);
    }
    if (this.tool === 'eraser') {
      this.snapshot(this.eraserMode === 'pixel' ? '像素擦除' : this.eraserMode === 'highlighter' ? '擦荧光笔' : '擦除');
      this.gesture = { type: 'erase' };
      this.applyErase(p);
      return;
    }
    if (this.tool === 'lasso') return this.startLasso(p, meta);
    if (this.tool === 'text') return this.startText(p);
    if (this.tool === 'sticker') return this.placeSticker(p);
    if (this.tool === 'laser') { this.laser = [[p[0], p[1], Date.now()]]; this.gesture = { type: 'laser' }; this.startLaser(); return; }
    if (this.tool === 'ruler') { this.rulerGrab = this.rulerHit(p); if (this.rulerGrab) this.snapshot('移动尺子'); return; }
  }

  onMove(p, meta = {}) {
    if (!this.gesture) return;
    if (this.gesture.type === 'erase') return this.applyErase(p);
    if (this.gesture.type === 'laser') {
      this.laser.push([p[0], p[1], Date.now()]);
      if (this.laser.length > 160) this.laser.shift();
      return;
    }
    if (this.gesture.type === 'ink') {
      const d = this.drawing;
      if (!d) return;
      const last = d.points[d.points.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.0014) return;
      d.points.push(p);
      d.times = d.times || [Date.now()];
      d.times.push(Date.now());
      if (meta && Number.isFinite(meta.pressure) && meta.pressure > 0) {
        d.pressures = d.pressures || [];
        d.pressures.push(meta.pressure);
      } else if (d.pressures) {
        d.pressures.push(d.pressures[d.pressures.length - 1] || 0.5);
      }
      return this.scheduleRedraw();
    }
    if (this.gesture.type === 'lasso' || this.gesture.type === 'rect') {
      if (this.gesture.type === 'lasso') { this.lassoPoly.push(p); }
      else { this.gesture.to = p; }
      return this.scheduleRedraw();
    }
    if (this.gesture.type === 'move' || this.gesture.type === 'scale' || this.gesture.type === 'rotate') {
      this.applyTransform(p, meta);
      return this.scheduleRedraw();
    }
    if (this.gesture.type === 'ruler') {
      const dx = p[0] - this.gesture.start[0], dy = p[1] - this.gesture.start[1];
      this.ruler.x = Math.max(-0.2, Math.min(1.2, this.gesture.base.x + dx));
      this.ruler.y = Math.max(-0.2, Math.min(1.2, this.gesture.base.y + dy));
      return this.scheduleRedraw();
    }
  }

  onUp() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) { this.commit(); return; }
    if (g.type === 'laser') {
      this.laser = [];
      this.redraw();
      return;
    }
    if (g.type === 'ink') {
      const d = this.drawing;
      this.drawing = null;
      const item = this.finalizeInk(d);
      if (item) this.items.push(item);
      this.redraw();
      this.commit(item ? noteLabel(item) : null);
      this.refreshStatus();
      return;
    }
    if (g.type === 'lasso') { this.finishLasso(this.lassoPoly); this.lassoPoly = null; return; }
    if (g.type === 'rect') {
      const a = g.from, b = g.to || g.from;
      const poly = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
      this.finishLasso(poly);
      this.lassoRect = null;
      return;
    }
    if (g.type === 'move' || g.type === 'scale' || g.type === 'rotate') {
      const label = g.type === 'move' ? '移动' : g.type === 'scale' ? '缩放' : '旋转';
      this.redraw();
      this.commit(label);
      this.refreshStatus();
      return;
    }
    if (g.type === 'ruler') { this.redraw(); this.commit('移动尺子'); return; }
    this.commit();
  }

  /* ---------- 写 ---------- */

  startInk(p, meta = {}) {
    const isTape = this.tool === 'tape';
    const isShape = this.tool === 'shape';
    const isHl = this.tool === 'highlighter';
    const basePx = (isHl ? this.width.highlighter : this.width.pen) * (this.cssW || 800);
    this.snapshot(isTape ? '贴胶带' : isShape ? '画形状' : isHl ? '荧光笔' : PEN_TYPES.find((t) => t.id === this.penType).label);
    this.selection.clear();
    const item = {
      kind: 'stroke',
      id: uid('s'),
      tool: isHl ? 'highlighter' : 'pen',
      pen: isHl ? 'ball' : this.penType,
      color: isHl ? this.highlightColor : this.color,
      width: isHl ? this.width.highlighter : this.width.pen,
      opacity: isHl ? 0.42 : this.opacity,
      points: [p],
      pressureStrength: PEN_TYPES.find((t) => t.id === (isHl ? 'ball' : this.penType)).velocity,
      _basePx: basePx,
      _shapeTool: isShape ? this.shapeKind : undefined,
      _tape: isTape || undefined,
      _fill: isShape ? this.shapeFill : undefined,
      pressures: Number.isFinite(meta.pressure) && meta.pressure > 0 ? [meta.pressure] : undefined,
    };
    this.drawing = item;
    this.gesture = { type: 'ink' };
    this.redraw();
  }

  finalizeInk(d) {
    if (!d || !d.points || !d.points.length) return null;
    const isTape = !!d._tape;
    const shapeTool = d._shapeTool;
    const fill = d._fill;
    delete d._basePx;
    delete d._shapeTool;
    delete d._tape;
    delete d._fill;
    const W = this.cssW || 800, H = this.cssH || 1000;

    if (isTape) {
      const a = d.points[0], b = d.points[d.points.length - 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.02) return null;
      const geo = tapeGeometry(a, b, 0.05);
      return { kind: 'tape', id: uid('tp'), x: geo.x, y: geo.y, w: geo.w, h: geo.h, angle: geo.angle, color: this.tapeColor, peeled: false };
    }

    // 尺子吸附（画直线神器）
    if (this.ruler.on && d.tool === 'pen') {
      d.points = snapToRuler(d.points, this.ruler);
    }

    if (d.points.length === 1) {
      if (shapeTool || d.tool === 'highlighter' || this.ruler.on) return null;
      const [x, y] = d.points[0];
      d.points = [[x, y], [x + 0.0006, y + 0.0006]];
    } else if (shapeTool) {
      const snap = snapToShape(d.points, shapeTool);
      if (snap) {
        d.shape = snap.shape;
        d.points = this.ruler.on ? snapToRuler(snap.points, this.ruler) : snap.points;
        if (fill) d.fill = true;
      }
      // 识别不出来就保留原手写（宁可多留一笔，也不要凭空丢掉用户写的东西）
    } else if (d.tool === 'highlighter') {
      const line = straightenHighlighter(d.points);
      if (line) { d.shape = 'line'; d.points = this.ruler.on ? snapToRuler(line, this.ruler) : line; }
    }
    // 逐点笔宽算一次存下来，重绘/导出时不用重算（也让「快写变细」在导出后保持一致）
    d.widths = strokeWidths(d.points, {
      w: W, h: H,
      base: Math.max(1, d.width * W),
      type: d.pen || 'ball',
      pressures: d.pressures,
      times: d.times,
      strength: d.pressureStrength,
    }).map((px) => px / W);
    delete d.times;
    return d;
  }

  /* ---------- 擦 ---------- */

  applyErase(p) {
    const W = this.cssW || 800, H = this.cssH || 1000;
    const radius = this.eraserSize.px / 2 + 2;
    const mode = this.eraserMode === 'highlighter' ? 'stroke' : this.eraserMode;
    // 「仅擦荧光笔」：把非荧光笔的笔迹临时标记成别的类型，让擦除逻辑看不见它们
    const pool = this.items.map((it) => {
      if (this.eraserMode !== 'highlighter') return it;
      if (it && it.kind === 'stroke' && it.tool !== 'highlighter') return { ...it, kind: 'locked', _locked: true };
      return it;
    });
    const res = eraseAtPoint(pool, p[0], p[1], W, H, { radius, mode });
    if (!res.changed) return;
    this.items = res.items.map((it) => {
      if (!it || !it._locked) return it;
      const { _locked, ...rest } = it;
      return { ...rest, kind: 'stroke' };
    });
    // 胶带也允许用橡皮「撕掉」
    const before = this.items.length;
    this.items = this.items.filter((it) => !(it && it.kind === 'tape' && itemHit(it, p[0], p[1], W, H)));
    this.selection.clear();
    this.redraw();
    if (this.items.length !== before) this.onToast('胶带已撕掉（可撤销）');
  }

  /* ---------- 套索 / 矩形选择 ---------- */

  startLasso(p, meta = {}) {
    const btn = meta && meta.rectSelect;   // 工具栏切换「自由 / 矩形」
    const handle = this.selection.size ? this.handleAt(p) : null;
    if (handle) {
      const b = boxOfItems(this.selectedItems());
      if (handle.id === 'rotate') {
        this.snapshot('旋转');
        this.gesture = { type: 'rotate', start: p, base: this.captureSelection(), origin: center(b) };
        return;
      }
      this.snapshot('缩放');
      const anchor = { tl: { x: b.x1, y: b.y1 }, tr: { x: b.x0, y: b.y1 }, br: { x: b.x0, y: b.y0 }, bl: { x: b.x1, y: b.y0 } }[handle.id];
      this.gesture = { type: 'scale', start: p, base: this.captureSelection(), origin: anchor };
      return;
    }
    const hit = this.topItemAt(p, { tolPx: 10, inside: true });
    if (hit) {
      if (!this.selection.has(hit.id)) this.selection = new Set([hit.id]);
      this.snapshot('移动');
      this.gesture = { type: 'move', start: p, base: this.captureSelection() };
      this.redraw();
      this.refreshStatus();
      return;
    }
    if (this.selection.size) { this.selection.clear(); this.refreshStatus(); }
    if (this.rectSelect) {
      this.gesture = { type: 'rect', from: p, to: p };
      this.lassoRect = { from: p, to: p };
    } else {
      this.gesture = { type: 'lasso' };
      this.lassoPoly = [p];
    }
    this.redraw();
  }

  finishLasso(poly) {
    const W = this.cssW || 800, H = this.cssH || 1000;
    if (poly && poly.length >= 3) {
      const hits = this.items.filter((it) => {
        if (!it) return false;
        if (it.kind === 'sticker' || it.kind === 'tape' || it.kind === 'text' || it.kind === 'image') {
          const b = itemBox(it);
          const c = center(b);
          return pointInPolygon(poly, c.x, c.y) || pointInPolygon(poly, b.x0, b.y0);
        }
        return polygonSelectsItem(poly, it, { W, H });
      });
      this.selection = new Set(hits.map((it) => it.id));
      this.onToast(hits.length ? `选中 ${hits.length} 个对象：拖动 / 角点缩放 / 圆点旋转` : '没圈到内容');
    }
    this.redraw();
    this.refreshStatus();
  }

  setRectSelect(on) { this.rectSelect = !!on; this.onToast(this.rectSelect ? '套索：矩形选择' : '套索：自由圈选'); }

  captureSelection() {
    const items = JSON.parse(JSON.stringify(this.selectedItems()));
    return { items, ids: items.map((i) => i.id) };
  }

  applyTransform(p, meta = {}) {
    const g = this.gesture;
    if (!g || !g.base) return;
    const idSet = new Set(g.base.ids);
    let t = null;
    if (g.type === 'move') t = { dx: p[0] - g.start[0], dy: p[1] - g.start[1] };
    else if (g.type === 'scale') {
      const o = g.origin;
      const dx0 = g.start[0] - o.x, dy0 = g.start[1] - o.y;
      let sx = Math.abs(dx0) < 1e-4 ? 1 : (p[0] - o.x) / dx0;
      let sy = Math.abs(dy0) < 1e-4 ? 1 : (p[1] - o.y) / dy0;
      const clamp = (v) => Math.max(0.05, Math.min(8, v));
      sx = clamp(sx); sy = clamp(sy);
      if (meta && meta.shiftKey) { const s = (Math.abs(sx) + Math.abs(sy)) / 2; sx = s; sy = s; }
      t = { sx, sy, origin: o };
    } else if (g.type === 'rotate') {
      const o = g.origin;
      let a = Math.atan2(p[1] - o.y, p[0] - o.x) - Math.atan2(g.start[1] - o.y, g.start[0] - o.x);
      if (meta && meta.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      t = { angle: a, origin: o };
    }
    if (!t) return;
    const moved = transformItems(g.base.items, idSet, t);
    const byId = new Map(moved.map((it) => [it.id, it]));
    this.items = this.items.map((it) => byId.get(it.id) || it);
  }

  selectedItems() { return this.items.filter((it) => this.selection.has(it.id)); }

  topItemAt(p, opts = {}) {
    const W = this.cssW || 800, H = this.cssH || 1000;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (opts.kind && it.kind !== opts.kind) continue;
      if (itemHit(it, p[0], p[1], W, H, { tolPx: opts.tolPx == null ? 8 : opts.tolPx, inside: opts.inside })) return it;
    }
    return null;
  }

  handlePoints() {
    const b = boxOfItems(this.selectedItems());
    if (!b) return [];
    const W = this.cssW || 800, H = this.cssH || 1000;
    const pad = 8;
    const px = { x0: b.x0 * W - pad, y0: b.y0 * H - pad, x1: b.x1 * W + pad, y1: b.y1 * H + pad };
    return [
      { id: 'tl', x: px.x0, y: px.y0 }, { id: 'tr', x: px.x1, y: px.y0 },
      { id: 'br', x: px.x1, y: px.y1 }, { id: 'bl', x: px.x0, y: px.y1 },
      { id: 'rotate', x: (px.x0 + px.x1) / 2, y: px.y0 - 26 },
    ];
  }

  handleAt(p) {
    const W = this.cssW || 800, H = this.cssH || 1000;
    const x = p[0] * W, y = p[1] * H;
    let best = null, bestD = 14;
    for (const h of this.handlePoints()) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= bestD) { bestD = d; best = h; }
    }
    return best;
  }

  /* ---------- 对象操作 ---------- */

  selectAll() {
    this.selection = new Set(this.items.filter((it) => it.kind !== 'tape').map((it) => it.id));
    this.redraw();
    this.refreshStatus();
    return this.selection.size;
  }

  copy() {
    const sel = this.selectedItems();
    if (!sel.length) { this.onToast('先圈选内容再复制'); return false; }
    this.clipboard = JSON.parse(JSON.stringify(sel));
    this.onToast(`已复制 ${sel.length} 个对象`);
    return true;
  }

  cut() { if (!this.copy()) return false; return this.deleteSelection(); }

  paste() {
    if (!this.clipboard.length) { this.onToast('剪贴板是空的'); return false; }
    this.snapshot('粘贴');
    const drops = JSON.parse(JSON.stringify(this.clipboard)).map((it) => ({ ...it, id: uid(it.kind === 'text' ? 't' : it.kind === 'sticker' ? 'st' : it.kind === 'tape' ? 'tp' : it.kind === 'image' ? 'img' : 's') }));
    const ids = new Set(drops.map((d) => d.id));
    const moved = transformItems(drops, ids, { dx: 0.024, dy: 0.024 });
    this.items.push(...moved);
    this.selection = new Set(moved.map((m) => m.id));
    this.commit('粘贴');
    this.redraw();
    this.refreshStatus();
    return true;
  }

  duplicate() {
    if (!this.selectedItems().length) { this.onToast('先圈选要复制的对象'); return false; }
    this.clipboard = JSON.parse(JSON.stringify(this.selectedItems()));
    return this.paste();
  }

  deleteSelection() {
    if (!this.selection.size) { this.onToast('先圈选要删除的对象'); return false; }
    const n = this.selection.size;
    this.snapshot('删除');
    this.items = this.items.filter((it) => !this.selection.has(it.id));
    this.selection.clear();
    this.commit('删除');
    this.redraw();
    this.refreshStatus();
    this.onToast(`已删除 ${n} 个对象（可撤销）`);
    return true;
  }

  /** 层级：置顶 / 置底（GoodNotes 的 Arrange） */
  zOrder(where) {
    if (!this.selection.size) return false;
    const sel = this.selectedItems();
    const rest = this.items.filter((it) => !this.selection.has(it.id));
    this.snapshot(where === 'front' ? '置顶' : '置底');
    this.items = where === 'front' ? [...rest, ...sel] : [...sel, ...rest];
    this.commit(where === 'front' ? '置顶' : '置底');
    this.redraw();
    return true;
  }

  peelTape() {
    const sel = this.selectedItems().filter((it) => it.kind === 'tape');
    if (!sel.length) { this.onToast('先用套索选中胶带'); return false; }
    this.snapshot('撕胶带');
    this.items = this.items.filter((it) => it.kind !== 'tape' || !this.selection.has(it.id));
    this.selection.clear();
    this.commit('撕胶带');
    this.redraw();
    return true;
  }

  /* ---------- 文本 ---------- */

  startText(p) {
    const hit = this.topItemAt(p, { kind: 'text', tolPx: 12, inside: true });
    if (hit) return this.beginTextEdit(hit, p);
    return this.beginTextEdit(null, p);
  }

  beginTextEdit(existing, p) {
    if (typeof document === 'undefined' || !this.host) return null;
    if (this.editing) this.endTextEdit(true);
    this.abortGesture();
    const W = this.cssW || 800, H = this.cssH || 1000;
    const ta = document.createElement('textarea');
    ta.className = 'pg-text-edit';
    const step = TEXT_SIZE_STEPS.find((s) => s.id === this.textStyle.size) || TEXT_SIZE_STEPS[2];
    const size = existing ? (Number(existing.size) || step.value) : step.value;
    const x = existing ? Number(existing.x) : p[0];
    const y = existing ? Number(existing.y) : p[1];
    ta.value = existing ? String(existing.text || '') : '';
    const px = Math.max(12, Math.round(size * W));
    if (ta.style) {
      ta.style.left = `${x * W}px`;
      ta.style.top = `${y * H - 4}px`;
      ta.style.width = `${Math.round(Math.max(160, 0.5 * W))}px`;
      ta.style.fontSize = `${px}px`;
      ta.style.lineHeight = '1.36';
      ta.style.color = (existing && existing.color) || this.color;
    }
    if (this.host.appendChild) this.host.appendChild(ta);
    this.editing = { ta, existing, point: [x, y], size };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault && e.preventDefault(); this.endTextEdit(false); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault && e.preventDefault(); this.endTextEdit(true); }
    });
    ta.addEventListener('blur', () => { if (this.editing && this.editing.ta === ta) this.endTextEdit(true); });
    try { ta.focus(); } catch (e) {}
    return ta;
  }

  endTextEdit(save) {
    const ed = this.editing;
    if (!ed) return false;
    this.editing = null;
    const text = String((ed.ta && ed.ta.value) || '').replace(/\s+$/, '');
    try { ed.ta.remove(); } catch (e) {}
    let ok = false;
    if (save) {
      if (!text.trim()) {
        if (ed.existing) {
          this.snapshot('删文字');
          this.items = this.items.filter((it) => it.id !== ed.existing.id);
          this.commit('删文字');
          ok = true;
        }
      } else if (ed.existing) {
        this.snapshot('改文字');
        this.items = this.items.map((it) => (it.id === ed.existing.id ? { ...it, text, size: ed.size } : it));
        this.commit('改文字');
        ok = true;
      } else {
        this.snapshot('加文字');
        const item = {
          kind: 'text', id: uid('t'),
          x: clamp01(ed.point[0]), y: clamp01(ed.point[1]),
          text, size: ed.size,
          color: this.color,
          font: this.textStyle.font,
          bold: this.textStyle.bold,
          italic: this.textStyle.italic,
          align: this.textStyle.align,
          rot: 0,
        };
        this.items.push(item);
        this.selection = new Set([item.id]);
        this.commit('加文字');
        ok = true;
      }
    }
    this.redraw();
    this.refreshStatus();
    return ok;
  }

  /* ---------- 贴纸 / 图片 ---------- */

  placeSticker(p) {
    const size = 0.07;
    this.snapshot('贴纸');
    const item = { kind: 'sticker', id: uid('st'), glyph: this.stickerGlyph, x: p[0] - size / 2, y: p[1] - size / 2, size, rot: 0, opacity: 1 };
    this.items.push(item);
    this.selection = new Set([item.id]);
    this.commit('贴纸');
    this.redraw();
    this.refreshStatus();
    return item;
  }

  insertSticker(glyph, at = null) {
    this.setSticker(glyph);
    return this.placeSticker(at || [0.5, 0.5]);
  }

  async insertImageFile(file) {
    if (!file) return false;
    if (file.size > 2.4 * 1024 * 1024) { this.onToast('图片太大（>2.4MB）：先压缩再插入'); return false; }
    const src = await new Promise((resolve) => {
      try {
        const FR = typeof FileReader === 'function' ? FileReader : null;
        if (!FR) return resolve('');
        const fr = new FR();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(file);
      } catch (e) { resolve(''); }
    });
    if (!src) { this.onToast('这张图片读不出来'); return false; }
    let ratio = 0.66;
    if (typeof Image === 'function') {
      ratio = await new Promise((resolve) => {
        try {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.66);
          img.onerror = () => resolve(0.66);
          img.src = src;
        } catch (e) { resolve(0.66); }
      });
    }
    const W = this.cssW || 800, H = this.cssH || 1000;
    const w = 0.44;
    const h = Math.min(1.4, (w * W * ratio) / Math.max(1, H));
    const item = { kind: 'image', id: uid('img'), x: 0.28, y: 0.18, w, h, src, rot: 0, opacity: 1 };
    this.snapshot('插入图片');
    this.items.push(item);
    this.selection = new Set([item.id]);
    this.commit('插入图片');
    this.redraw();
    this.refreshStatus();
    return true;
  }

  insertImageData(src, ratio = 0.66) {
    const W = this.cssW || 800, H = this.cssH || 1000;
    const w = 0.44;
    const h = Math.min(1.4, (w * W * ratio) / Math.max(1, H));
    const item = { kind: 'image', id: uid('img'), x: 0.28, y: 0.18, w, h, src, rot: 0, opacity: 1 };
    this.snapshot('插入图片');
    this.items.push(item);
    this.commit('插入图片');
    this.redraw();
    return item;
  }

  /* ---------- 撤销 / 重做（跨页） ---------- */

  snapshot(label) {
    if (this._pending) return;
    this._pending = { label: label || '编辑', pageId: this.pageId, pageIndex: this.pageIndex, before: JSON.parse(JSON.stringify(this.items)) };
  }

  commit(label) {
    const p = this._pending;
    this._pending = null;
    if (!p) return false;
    if (JSON.stringify(p.before) === JSON.stringify(this.items)) return false;
    // 历史里存的是「哪一页 + 操作前内容」，所以撤销能跨页
    this.history.push(p.label || label || '编辑', { pageId: p.pageId, pageIndex: p.pageIndex, items: p.before });
    this.persist();
    this.refreshStatus();
    this.onDirty();
    return true;
  }

  persist() {
    if (this.suppressStore || !this.pageId) return;
    this.setItemsCb(this.pageId, JSON.parse(JSON.stringify(this.items)));
  }

  abortGesture() {
    if (this.drawing) this.drawing = null;
    if (this._pending) { this.items = this._pending.before; this._pending = null; }
    this.lassoPoly = null;
    this.lassoRect = null;
    this.gesture = null;
    this.redraw();
  }

  undo() {
    const r = this.history.undo(this._historyState());
    if (!r) { this.onToast('没有可撤销的操作'); return null; }
    return this._applyHistoryState(r, '撤销');
  }

  redo() {
    const r = this.history.redo(this._historyState());
    if (!r) { this.onToast('没有可重做的操作'); return null; }
    return this._applyHistoryState(r, '重做');
  }

  _historyState() {
    return { pageId: this.pageId, pageIndex: this.pageIndex, items: JSON.parse(JSON.stringify(this.items)) };
  }

  _applyHistoryState(r, verb) {
    const state = r.state || {};
    const items = Array.isArray(state.items) ? state.items : (Array.isArray(state) ? state : []);
    const pageId = state.pageId || this.pageId;
    const pageIndex = state.pageIndex == null ? this.pageIndex : state.pageIndex;
    if (pageId && pageId !== this.pageId) {
      this.setPage(pageIndex);
      this.onGotoPage(pageIndex);
    }
    this.items = normalizePageItems(items);
    this.selection.clear();
    this.persist();
    this.redraw();
    this.refreshStatus();
    this.onToast(`${verb}：${r.label}`);
    return r.label;
  }

  get canUndo() { return this.history.canUndo; }
  get canRedo() { return this.history.canRedo; }

  /* ---------- 激光笔 ---------- */

  startLaser() {
    if (this.laserRAF) return;
    const tick = () => {
      const alive = this.laser.filter((p) => Date.now() - p[2] < 1400);
      this.laser = alive;
      this.drawLaser();
      if (alive.length) this.laserRAF = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tick) : setTimeout(tick, 60));
      else { this.laserRAF = 0; this.redraw(); }
    };
    this.laserRAF = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tick) : setTimeout(tick, 60));
  }

  rulerHit(p) {
    const edge = rulerEdge(this.ruler);
    if (!edge) return null;
    const W = this.cssW || 800, H = this.cssH || 1000;
    const d = distToSeg(p[0] * W, p[1] * H, edge.a[0] * W, edge.a[1] * H, edge.b[0] * W, edge.b[1] * H);
    if (d > 26) return null;
    return { base: { x: this.ruler.x, y: this.ruler.y }, start: p };
  }

  grabRuler(p) {
    const g = this.rulerHit(p);
    if (!g) return false;
    this.snapshot('移动尺子');
    this.gesture = { type: 'ruler', start: p, base: g.base };
    return true;
  }

  /* ---------- 绘制 ---------- */

  scheduleRedraw() {
    if (this._raf) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    this._raf = raf(() => { this._raf = 0; this.redraw(); });
  }

  redraw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.cssW || 800, H = this.cssH || 1000;
    const scale = this._pxScale || 1;
    ctx.save();
    if (ctx.setTransform) ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    renderPaper(ctx, {
      w: W, h: H,
      template: (this.paper && this.paper.template) || 'lined',
      color: (this.paper && this.paper.color) || '#FFFFFF',
      lineColor: this.paper && this.paper.lineColor,
    });
    const state = { onImageLoad: () => this.redraw() };
    const hl = this.items.filter((it) => it && it.tool === 'highlighter');
    const rest = this.items.filter((it) => it && it.tool !== 'highlighter');
    for (const it of hl) drawItem(ctx, it, W, H, state);
    for (const it of rest) drawItem(ctx, it, W, H, state);
    if (this.drawing) drawItem(ctx, this.drawing, W, H, state);
    if (this.ruler.on) this.drawRuler(ctx, W, H);
    if (this.selection.size) this.drawSelection(ctx, W, H);
    if (this.lassoPoly && this.lassoPoly.length > 1) this.drawPoly(ctx, W, H, this.lassoPoly);
    if (this.lassoRect) this.drawRectSelect(ctx, W, H, this.lassoRect);
    ctx.restore();
    if (this.zoom.on) this.drawZoom();
  }

  drawRuler(ctx, W, H) {
    const { x, y, angle, length } = this.ruler;
    const x0 = x * W, y0 = y * H;
    const x1 = (x + Math.cos(angle) * length) * W, y1 = (y + Math.sin(angle) * length) * H;
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(40,40,40,.85)';
    ctx.lineWidth = 26;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 1;
    const ticks = 24;
    for (let i = 0; i <= ticks; i++) {
      const t = i / ticks;
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      const nx = -Math.sin(angle) * 7, ny = Math.cos(angle) * 7;
      ctx.beginPath();
      ctx.moveTo(px - nx, py - ny);
      ctx.lineTo(px + nx, py + ny);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawSelection(ctx, W, H) {
    const b = boxOfItems(this.selectedItems());
    if (!b) return;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#2F6FE8';
    ctx.strokeRect(b.x0 * W - 8, b.y0 * H - 8, (b.x1 - b.x0) * W + 16, (b.y1 - b.y0) * H + 16);
    ctx.setLineDash([]);
    for (const h of this.handlePoints()) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#2F6FE8';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPoly(ctx, W, H, poly) {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#2F6FE8';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * W, y * H) : ctx.lineTo(x * W, y * H)));
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#2F6FE8';
    ctx.fill();
    ctx.restore();
  }

  drawRectSelect(ctx, W, H, sel) {
    const x0 = Math.min(sel.from[0], sel.to[0]) * W, y0 = Math.min(sel.from[1], sel.to[1]) * H;
    const x1 = Math.max(sel.from[0], sel.to[0]) * W, y1 = Math.max(sel.from[1], sel.to[1]) * H;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#2F6FE8';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#2F6FE8';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  /** 放大窗：把页面的一段区域放大画进底部的条里（写大写小） */
  drawZoom() {
    const ctx = this.zoomCtx;
    const c = this.zoomCanvas;
    if (!ctx || !c) return;
    const d = this.dims();
    const region = this.zoomRegion();
    const dpr = Math.min(2, (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1);
    if (c.style && !c.style.width) {
      const rectW = Math.round(this.host && this.host.clientWidth ? Math.max(320, Math.min(720, this.host.clientWidth - 40)) : 560);
      c.style.width = `${rectW}px`;
      c.style.height = `${Math.round(rectW * 0.22)}px`;
    }
    const w = c.clientWidth || 560, h = c.clientHeight || 124;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = (this.paper && this.paper.color) || '#fff';
    ctx.fillRect(0, 0, w, h);

    const kx = w / Math.max(1e-6, region.w * d.w);
    const ky = h / Math.max(1e-6, region.h * d.h);
    ctx.save();
    ctx.translate(-region.x * d.w * kx, -region.y * d.h * ky);
    ctx.scale(kx, ky);
    renderPaper(ctx, {
      w: d.w, h: d.h,
      template: (this.paper && this.paper.template) || 'lined',
      color: (this.paper && this.paper.color) || '#FFFFFF',
      lineColor: this.paper && this.paper.lineColor,
    });
    const state = { onImageLoad: () => this.drawZoom() };
    const hl = this.items.filter((it) => it && it.tool === 'highlighter');
    const rest = this.items.filter((it) => it && it.tool !== 'highlighter');
    for (const it of hl) drawItem(ctx, it, d.w, d.h, state);
    for (const it of rest) drawItem(ctx, it, d.w, d.h, state);
    if (this.drawing) drawItem(ctx, this.drawing, d.w, d.h, state);
    ctx.restore();
    // 区域指示
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#2F6FE8';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.restore();
  }

  drawLaser() {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.cssW || 800, H = this.cssH || 1000;
    this.redraw();
    ctx.save();
    const now = Date.now();
    for (let i = 1; i < this.laser.length; i++) {
      const [x0, y0, t0] = this.laser[i - 1];
      const [x1, y1, t1] = this.laser[i];
      const age = 1 - Math.min(1, (now - t1) / 1400);
      if (age <= 0) continue;
      ctx.globalAlpha = age * 0.85;
      ctx.strokeStyle = '#FF3B30';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0 * W, y0 * H);
      ctx.lineTo(x1 * W, y1 * H);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- 状态 / 信息 ---------- */

  info() {
    const c = countItems(this.items);
    return {
      tool: this.tool,
      pen: this.penType,
      color: this.color,
      width: this.width.id,
      opacity: this.opacity,
      eraserMode: this.eraserMode,
      shapeKind: this.shapeKind,
      shapeFill: this.shapeFill,
      ruler: this.ruler.on,
      zoom: this.zoom.on,
      pageIndex: this.pageIndex,
      items: c.total,
      strokes: c.stroke,
      texts: c.text,
      images: c.image,
      stickers: this.items.filter((i) => i.kind === 'sticker').length,
      tapes: this.items.filter((i) => i.kind === 'tape').length,
      selection: this.selection.size,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoDepth: this.history.undoDepth,
      viewScale: this.view.scale,
    };
  }

  refreshStatus() { this.onStatus(this.info()); }

  /* ---------- 键盘 ---------- */

  onKey(e) {
    if (!e) return;
    const t = e.target || {};
    const tag = String(t.tagName || '').toLowerCase();
    if (this.editing || tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    const mod = !!(e.ctrlKey || e.metaKey);
    const k = String(e.key || '').toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault && e.preventDefault(); return this.undo(); }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault && e.preventDefault(); return this.redo(); }
    if (mod && k === 'c') return this.copy();
    if (mod && k === 'x') return this.cut();
    if (mod && k === 'v') return this.paste();
    if (mod && k === 'd') { e.preventDefault && e.preventDefault(); return this.duplicate(); }
    if (mod && k === 'a') { e.preventDefault && e.preventDefault(); return this.selectAll(); }
    if (mod && k === ']') { e.preventDefault && e.preventDefault(); return this.zOrder('front'); }
    if (mod && k === '[') { e.preventDefault && e.preventDefault(); return this.zOrder('back'); }
    if (k === 'delete' || k === 'backspace') { if (this.selection.size) { e.preventDefault && e.preventDefault(); return this.deleteSelection(); } return; }
    if (k === 'escape') { this.selection.clear(); this.abortGesture(); this.refreshStatus(); return; }
    if (mod) return;
    const map = { b: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', s: 'shape', t: 'text', m: 'image', k: 'sticker', g: 'tape', r: 'ruler', p: 'laser' };
    if (map[k]) return this.setTool(map[k]);
    if (k === '1') return this.setPenType('ball');
    if (k === '2') return this.setPenType('fountain');
    if (k === '3') return this.setPenType('brush');
    if (k === '4') return this.setPenType('pencil');
  }

  destroy() {
    if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('keydown', this._keyHandler);
    if (this.laserRAF) {
      try { (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(this.laserRAF); } catch (e) {}
      this.laserRAF = 0;
    }
    if (this.zoomBand && this.zoomBand.remove) this.zoomBand.remove();
  }
}

/* 内部小工具 */
function center(b) {
  if (!b) return { x: 0.5, y: 0.5 };
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export { prefersDark };
