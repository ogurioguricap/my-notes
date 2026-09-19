/**
 * GoodNotes 模式 · 纸张与封面（UI 的第一层观感）
 *
 * 1. 纸张模板：对齐 GoodNotes 内置的那一套（空白 / 横线 / 方格 / 点阵 / 康奈尔 / 清单 /
 *    周计划 / 月计划 / 年计划 / 五线谱 / 分镜 / 白板），并且「尺寸 + 底色 + 线色」都可改
 * 2. 封面：颜色 + 花纹 + 首字标记，用来在资料库网格里一眼分辨笔记本
 * 3. 画纸用 Canvas 画（这样导出 PDF / 打印时纸张会跟手写一起被拍进页面），
 *    同时给界面提供 CSS 变量版本用于缩略图
 *
 * 全部是纯函数 + 常量，不碰 DOM，方便在 Node 里断言。
 */

/* ============================ 尺寸 ============================ */

export const PAPER_SIZES = [
  { id: 'a4', label: 'A4 竖', w: 794, h: 1123 },          // 96dpi 下的 A4
  { id: 'a4l', label: 'A4 横', w: 1123, h: 794 },
  { id: 'letter', label: 'Letter', w: 816, h: 1056 },
  { id: 'ipad', label: 'iPad (4:3)', w: 810, h: 1080 },
  { id: 'square', label: '正方形', w: 900, h: 900 },
  { id: 'screen', label: '屏幕比例', w: 1080, h: 1440 },
  { id: 'whiteboard', label: '无限白板', w: 2400, h: 1600 },
  { id: 'custom', label: '自定义', w: 0, h: 0 },
];

export function paperSize(id) {
  return PAPER_SIZES.find((s) => s.id === id) || PAPER_SIZES[0];
}

/** 页面实际像素尺寸（自定义尺寸时用 paper.width/height） */
export function paperDims(paper) {
  const p = paper || {};
  if (p.size === 'custom' && Number(p.width) > 0 && Number(p.height) > 0) {
    return { w: Math.round(Number(p.width)), h: Math.round(Number(p.height)) };
  }
  const s = paperSize(p.size);
  return { w: s.w, h: s.h };
}

/* ============================ 颜色 ============================ */

export const PAPER_COLORS = [
  { id: 'white', label: '白', value: '#FFFFFF' },
  { id: 'cream', label: '米', value: '#FBF7EF' },
  { id: 'grey', label: '灰', value: '#F2F2F4' },
  { id: 'dotgrid', label: '点阵灰', value: '#F7F7F9' },
  { id: 'yellow', label: '淡黄', value: '#FFFBE6' },
  { id: 'green', label: '淡绿', value: '#F2FAF3' },
  { id: 'blue', label: '淡蓝', value: '#F1F6FD' },
  { id: 'dark', label: '深色', value: '#22252B' },
];

export const COVER_COLORS = [
  '#E8452F', '#F08A24', '#E8B33D', '#3F9B5C', '#12A0A0', '#2F6FE8',
  '#5B4BD6', '#8B5CF6', '#D94F8A', '#8C5A3B', '#5A6B8C', '#2B2723',
];

export const COVER_PATTERNS = [
  { id: 'plain', label: '纯色' },
  { id: 'gradient', label: '渐变' },
  { id: 'dots', label: '圆点' },
  { id: 'stripes', label: '条纹' },
  { id: 'grid', label: '细格' },
  { id: 'kraft', label: '牛皮纸' },
];

/* ============================ 纸张模板 ============================ */

const lineColorOf = (paper) => (paper && paper.lineColor) || autoLineColor(paper && paper.color);

/** 深色纸自动配浅线，浅色纸自动配灰线 —— 用户不用手动调 */
export function autoLineColor(paperColor) {
  const c = String(paperColor || '#FFFFFF');
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) return 'rgba(90,110,140,.28)';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.45 ? 'rgba(255,255,255,.22)' : 'rgba(90,110,140,.26)';
}

function grid(ctx, w, h, step, color, lw = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
  ctx.restore();
}

function ruled(ctx, w, h, gap, color, lw = 1, topGap = 0) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  for (let y = topGap + gap; y < h; y += gap) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
  ctx.restore();
}

function dots(ctx, w, h, gap, color, r = 1.2) {
  ctx.save();
  ctx.fillStyle = color;
  for (let y = gap; y < h; y += gap) {
    for (let x = gap; x < w; x += gap) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/* ============================ 纸张模板 ============================ */

export const PAPER_TEMPLATES = [
  { id: 'blank', label: '空白', group: '基础' },
  { id: 'lined', label: '横线', group: '基础' },
  { id: 'grid', label: '方格', group: '基础' },
  { id: 'dots', label: '点阵', group: '基础' },
  { id: 'graph', label: '细格', group: '基础' },
  { id: 'cornell', label: '康奈尔', group: '学习' },
  { id: 'todo', label: '清单', group: '学习' },
  { id: 'music', label: '五线谱', group: '学习' },
  { id: 'storyboard', label: '分镜', group: '创作' },
  { id: 'week', label: '周计划', group: '计划' },
  { id: 'month', label: '月计划', group: '计划' },
  { id: 'year', label: '年计划', group: '计划' },
  { id: 'habit', label: '打卡表', group: '计划' },
  { id: 'whiteboard', label: '白板', group: '创作' },
];

export function paperTemplate(id) {
  return PAPER_TEMPLATES.find((t) => t.id === id) || PAPER_TEMPLATES[1];
}

export function templateGroups() {
  const out = new Map();
  for (const t of PAPER_TEMPLATES) {
    if (!out.has(t.group)) out.set(t.group, []);
    out.get(t.group).push(t);
  }
  return [...out.entries()].map(([group, list]) => ({ group, list }));
}

/**
 * 把纸张画到画布上（会先铺底色）
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o { w, h, template, color, lineColor, plain, flat }
 *   plain = 阅读版：不画格线/横线（省墨），只留底色
 *   flat  = 强制白底（最省墨）
 */
export function renderPaper(ctx, o) {
  const w = Math.max(1, Math.round(o.w));
  const h = Math.max(1, Math.round(o.h));
  const color = (o && (o.flat ? '#FFFFFF' : o.color)) || '#FFFFFF';
  const line = lineColorOf(o);
  const t = (o && o.template) || 'lined';
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  if (o && o.plain) { ctx.restore(); return { w, h }; }   // 阅读版：只要底色

  if (t === 'lined') ruled(ctx, w, h, 34, line);
  else if (t === 'grid') grid(ctx, w, h, 34, line);
  else if (t === 'dots') dots(ctx, w, h, 28, line);
  else if (t === 'graph') grid(ctx, w, h, 17, line, 0.8);
  else if (t === 'cornell') {
    // 康奈尔：左侧线索栏 + 下方总结栏 + 中间横线
    ruled(ctx, w, h * 0.78, 34, line);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0.28 * w, 0); ctx.lineTo(0.28 * w, h * 0.78);
    ctx.moveTo(0, h * 0.78); ctx.lineTo(w, h * 0.78);
    ctx.stroke();
  } else if (t === 'todo') {
    ruled(ctx, w, h, 44, line);
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.4;
    for (let y = 26; y < h; y += 44) {
      ctx.strokeRect(26, y, 14, 14);
      ctx.beginPath();
      ctx.moveTo(40, y); ctx.lineTo(w - 24, y);
      ctx.stroke();
    }
    ctx.restore();
  } else if (t === 'music') {
    // 五线谱：每组 5 线，组间距留白
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (let base = 60; base < h - 40; base += 90) {
      ctx.beginPath();
      for (let i = 0; i < 5; i++) { ctx.moveTo(48, base + i * 12 + 0.5); ctx.lineTo(w - 48, base + i * 12 + 0.5); }
      ctx.stroke();
    }
    ctx.restore();
  } else if (t === 'storyboard') {
    const cols = 2, rows = 3;
    const pw = (w - 48 - 24 * (cols - 1)) / cols;
    const ph = (h - 48 - 24 * (rows - 1)) / rows;
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.4;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) ctx.strokeRect(24 + c * (pw + 24), 24 + r * (ph + 24), pw, ph);
    }
    ctx.restore();
  } else if (t === 'week') {
    const top = 54;
    const colW = (w - 48) / 7;
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(24, top); ctx.lineTo(w - 24, top);
    for (let i = 0; i <= 7; i++) { ctx.moveTo(24 + i * colW, top - 26); ctx.lineTo(24 + i * colW, h - 24); }
    ctx.stroke();
    ctx.fillStyle = line;
    ctx.font = '600 15px sans-serif';
    ctx.textBaseline = 'middle';
    ['一', '二', '三', '四', '五', '六', '日'].forEach((d, i) => ctx.fillText(d, 24 + i * colW + colW / 2 - 6, top - 40));
    ctx.restore();
    ruled(ctx, w, h, 44, line, 0.6, top);
  } else if (t === 'month') {
    const cols = 7, rows = 6, top = 60;
    const cw = (w - 48) / cols, ch = (h - top - 24) / rows;
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.2;
    for (let r = 0; r <= rows; r++) { ctx.beginPath(); ctx.moveTo(24, top + r * ch); ctx.lineTo(w - 24, top + r * ch); ctx.stroke(); }
    for (let c = 0; c <= cols; c++) { ctx.beginPath(); ctx.moveTo(24 + c * cw, top); ctx.lineTo(24 + c * cw, h - 24); ctx.stroke(); }
    ctx.fillStyle = line;
    ctx.font = '600 16px sans-serif';
    ctx.fillText('MONTH', 24, top - 24);
    ctx.restore();
  } else if (t === 'year') {
    const cols = 4, rows = 3;
    const cw = (w - 48) / cols, ch = (h - 48) / rows;
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = 24 + c * cw, y = 24 + r * ch;
        ctx.strokeRect(x, y, cw - 12, ch - 12);
        ctx.beginPath();
        for (let i = 1; i <= 6; i++) { ctx.moveTo(x, y + (i * (ch - 12)) / 7); ctx.lineTo(x + cw - 12, y + (i * (ch - 12)) / 7); }
        ctx.stroke();
      }
    }
    ctx.restore();
  } else if (t === 'habit') {
    const cols = 31, top = 60;
    const cw = (w - 48) / cols;
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    let y = top;
    for (let row = 0; row < 18; row++) {
      ctx.beginPath();
      ctx.moveTo(24, y); ctx.lineTo(w - 24, y);
      ctx.stroke();
      for (let c = 0; c <= cols; c++) { ctx.beginPath(); ctx.moveTo(24 + c * cw, y); ctx.lineTo(24 + c * cw, y + 26); ctx.stroke(); }
      y += 26;
      if (y > h - 24) break;
    }
    ctx.restore();
  } else if (t === 'whiteboard') {
    dots(ctx, w, h, 46, line, 1.4);
  }
  ctx.restore();
  return { w, h };
}

/* ============================ 封面 ============================ */

export function coverPalette(index = 0) {
  return COVER_COLORS[index % COVER_COLORS.length];
}

/** 封面的 CSS 变量（资料库网格卡片直接用它上色） */
export function bookCoverVars(nb) {
  const c = (nb && nb.cover) || {};
  const color = c.color || COVER_COLORS[0];
  return `--bk:${color};--bk-soft:${mix(color, '#FFFFFF', 0.82)}`;
}

export function mix(hex, other, ratio = 0.5) {
  const parse = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(hex), b = parse(other);
  if (!a || !b) return hex;
  const t = Math.min(1, Math.max(0, ratio));
  const out = a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 在给定的 canvas 上画一张封面（导出 / 缩略图 / 预览用） */
export function renderCover(ctx, { w, h, color = COVER_COLORS[0], pattern = 'plain', glyph = '笔', title = '' }) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  const soft = mix(color, '#FFFFFF', 0.86);
  if (pattern === 'gradient') {
    const g = ctx.createLinearGradient ? ctx.createLinearGradient(0, 0, w, h) : null;
    if (g && g.addColorStop) {
      g.addColorStop(0, color);
      g.addColorStop(1, mix(color, '#000000', 0.35));
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = mix(color, '#000000', 0.18);
    }
    ctx.fillRect(0, 0, w, h);
  } else if (pattern === 'dots') {
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    for (let y = 14; y < h; y += 22) for (let x = 14; x < w; x += 22) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  } else if (pattern === 'stripes') {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 8;
    ctx.beginPath();
    for (let x = -h; x < w + h; x += 26) { ctx.moveTo(x, 0); ctx.lineTo(x + h, h); }
    ctx.stroke();
    ctx.restore();
  } else if (pattern === 'grid') {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 12; x < w; x += 18) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = 12; y < h; y += 18) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    ctx.restore();
  } else if (pattern === 'kraft') {
    ctx.save();
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 240; i++) {
      ctx.fillStyle = i % 2 ? '#000' : '#fff';
      ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    ctx.restore();
  }
  // 书脊 + 首字标记
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fillRect(0, 0, Math.max(6, w * 0.045), h);
  ctx.fillStyle = soft;
  ctx.font = `700 ${Math.round(Math.min(w, h) * 0.34)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(glyph || '笔').slice(0, 1), w / 2, h * 0.44);
  if (title) {
    ctx.font = `600 ${Math.round(Math.min(w, h) * 0.085)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(String(title).slice(0, 12), w / 2, h * 0.74);
  }
  ctx.restore();
}
