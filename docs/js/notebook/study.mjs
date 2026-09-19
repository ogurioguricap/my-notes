/**
 * GoodNotes 模式 · 学习与输出
 *
 * 1. 导出 PDF：自己写一个极简 PDF 写出器（把每页渲染成 JPEG，按 DCTDecode 嵌进 PDF 容器）。
 *    —— 不引外部库，导出来的就是能在系统里打开、能打印、能发邮件的真 PDF。
 * 2. 导出 PNG：单页位图。
 * 3. 打印：交给浏览器（配合 @media print 样式）。
 * 4. 录音：MediaRecorder 封装（GoodNotes 的「录音与手写时间点同步」靠 store.audioAnchor 还原）。
 * 5. 摘要：本地抽取式摘要（AI 总结的替代方案：不联网、不上传，只按词频挑关键句）。
 *
 * 渲染依赖 canvas，所以把「怎么把一页变成 JPEG」做成可注入的（render 参数），
 * 这样在 Node 里也能对 PDF 字节流本身做断言（PDF 结构不依赖浏览器）。
 */

/* ============================ PDF 写出器 ============================ */

const enc = (s) => new TextEncoder().encode(s);

/** 把 Uint8Array 片段拼起来（PDF 需要精确的字节偏移，所以不能走字符串） */
class ByteBuf {
  constructor() { this.parts = []; this.length = 0; }
  push(chunk) {
    const u8 = chunk instanceof Uint8Array ? chunk : enc(String(chunk));
    this.parts.push(u8);
    this.length += u8.length;
    return this;
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

export function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node 兜底
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  return new Uint8Array(0);
}

/**
 * 用「每页一张 JPEG」拼出 PDF
 * @param {Array<{jpeg: Uint8Array, w: number, h: number}>} images
 * @param {object} o { title }
 * @returns {Uint8Array}
 */
export function pdfFromImages(images, o = {}) {
  const buf = new ByteBuf();
  const offsets = [0];
  const pages = images.filter((im) => im && im.jpeg && im.jpeg.length);
  const n = Math.max(1, pages.length);

  // 对象编号：1 目录 / 2 页树 / 之后每页 3 个对象（Page、Contents、Image）
  // 若有文本层，最后再补 3 个文档级对象：Type0 字体 / 后代 CIDFont / ToUnicode 映射
  const textPages = Array.isArray(o.textPages) ? o.textPages : [];
  const hasText = textPages.some((s) => s && String(s).trim());
  const baseCount = 2 + n * 3;
  const fontNum = baseCount + 1;
  const descNum = baseCount + 2;
  const uniNum = baseCount + 3;
  const objCount = hasText ? baseCount + 3 : baseCount;
  const push = (num, body) => {
    offsets[num] = buf.length;
    buf.push(`${num} 0 obj\n${body}\nendobj\n`);
  };

  buf.push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${3 + i * 3} 0 R`);
  push(1, '<< /Type /Catalog /Pages 2 0 R >>');
  push(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);

  for (let i = 0; i < n; i++) {
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    const im = pages[i] || { jpeg: new Uint8Array(0), w: 595, h: 842 };
    const w = Math.max(1, Math.round(im.w || 595));
    const h = Math.max(1, Math.round(im.h || 842));
    const text = textPages[i] && String(textPages[i]).trim() ? String(textPages[i]) : '';
    const res = text
      ? `/Resources << /XObject << /Im0 ${imageNum} 0 R >> /Font << /F1 ${fontNum} 0 R >> /ProcSet [/PDF /Text /ImageC] >>`
      : `/Resources << /XObject << /Im0 ${imageNum} 0 R >> /ProcSet [/PDF /ImageC] >>`;
    push(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ${res} /Contents ${contentNum} 0 R >>`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q` + (text ? `\n${text}` : '');
    push(contentNum, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[imageNum] = buf.length;
    buf.push(`${imageNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`);
    buf.push(im.jpeg);
    buf.push('\nendstream\nendobj\n');
  }

  if (hasText) {
    push(fontNum, `<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H /DescendantFonts [${descNum} 0 R] /ToUnicode ${uniNum} 0 R >>`);
    push(descNum, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor << /Type /FontDescriptor /FontName /Helvetica /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >> /CIDToGIDMap /Identity /DW 1000 >>');
    const cmap = o.toUnicode || '';
    push(uniNum, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  }

  const xrefAt = buf.length;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objCount; i++) {
    xref += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`;
  }
  buf.push(xref);
  const info = o.title ? ` /Info << /Title (${String(o.title).replace(/[()\\]/g, '')}) >>` : '';
  buf.push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R${info} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return buf.bytes();
}

/** 导出画质档位（对齐「打印出来能不能看」这个真实需求） */
export const PDF_QUALITY = [
  { id: 'standard', label: '标准（96dpi）', scale: 1, quality: 0.86, hint: '文件小，屏幕看/发微信够用' },
  { id: 'high', label: '高清（192dpi）', scale: 2, quality: 0.9, hint: '默认：打印清晰，体积约 4 倍' },
  { id: 'print', label: '打印级（288dpi）', scale: 3, quality: 0.92, hint: '放大看细节、正式打印用，体积约 9 倍' },
];

export function qualityOf(id) { return PDF_QUALITY.find((q) => q.id === id) || PDF_QUALITY[1]; }

/** 页面里用到的所有图片地址（去重） */
export function imageSources(pages) {
  const set = new Set();
  for (const p of pages || []) {
    for (const it of (p && p.items) || []) {
      if (it && it.kind === 'image' && it.src) set.add(it.src);
    }
  }
  return [...set];
}

/**
 * 预加载页面里的图片：导出前等它们就位，否则 PDF 里会出现「图片」占位框
 * @param {Array} pages
 * @param {object} o { ImageImpl, timeoutMs }
 */
export function preloadImages(pages, { ImageImpl, timeoutMs = 8000 } = {}) {
  const Impl = ImageImpl || (typeof Image === 'function' ? Image : null);
  const srcs = imageSources(pages);
  if (!Impl || !srcs.length) return Promise.resolve({ total: srcs.length, loaded: 0, failed: srcs.length ? srcs.length : 0, skipped: !Impl });
  return new Promise((resolve) => {
    let done = 0, loaded = 0, failed = 0;
    const finish = () => resolve({ total: srcs.length, loaded, failed, skipped: false });
    const tick = (ok) => {
      done++;
      if (ok) loaded++; else failed++;
      if (done >= srcs.length) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    for (const src of srcs) {
      try {
        const img = new Impl();
        img.onload = () => { tick(!!(img.naturalWidth || img.width)); };
        img.onerror = () => tick(false);
        img.src = src;
      } catch (e) { tick(false); }
    }
    if (!srcs.length) { clearTimeout(timer); finish(); }
  });
}

/** 在浏览器里把一页渲染成 JPEG（导出 PDF / PNG 都用它） */
export function defaultRenderJpeg(page, { scale = 1, quality = 0.86, renderPage } = {}) {
  if (typeof document === 'undefined' || typeof renderPage !== 'function') return null;
  const canvas = document.createElement('canvas');
  const info = renderPage(canvas, {
    paper: page.paper,
    items: page.items,
    scale,
    dpr: 1,
  });
  let url = '';
  try { url = canvas.toDataURL('image/jpeg', quality); } catch (e) { return null; }
  return { jpeg: base64ToBytes(url), w: info.w, h: info.h };
}

/**
 * 整本笔记本 → PDF Blob（打印级）
 * @param {Array} pages [{ paper, items }]
 * @param {object} o { title, quality|scale, quality 值, render, renderPageImpl, dropTape, onProgress, waitImages }
 *   · dropTape=true 时导出会跳过胶带（看答案用）
 *   · 导出前会先等图片加载完，避免 PDF 里出现占位框
 */
export async function buildPdf(pages, o = {}) {
  const q = qualityOf(o.qualityId);
  const scale = Number(o.scale) > 0 ? Number(o.scale) : q.scale;
  const jpegQuality = Number(o.quality) > 0 ? Number(o.quality) : q.quality;
  const list = (pages || []).map((p) => ({
    paper: p && p.paper,
    items: ((p && p.items) || []).filter((it) => !(o.dropTape && it && it.kind === 'tape')),
    ocr: (p && p.ocr) || null,
  }));

  if (o.waitImages !== false) {
    try { await preloadImages(list, { ImageImpl: o.ImageImpl, timeoutMs: o.imageTimeoutMs }); } catch (e) { /* 图挂了也照样导 */ }
  }

  const render = o.render || ((page) => defaultRenderJpeg(page, { scale, quality: jpegQuality, renderPage: o.renderPageImpl }));

  // 先把每页画出来（图片预加载已经等过），文本层的坐标要用「和 MediaBox 完全一致的页面尺寸」
  const rendered = [];
  for (let i = 0; i < list.length; i++) {
    const im = render(list[i], i);
    if (im && im.jpeg && im.jpeg.length) rendered.push({ im, page: list[i] });
    if (o.onProgress) { try { o.onProgress({ done: i + 1, total: list.length }); } catch (e) {} }
  }

  // 文本层：整本文档共用一张编码表，逐页生成隐形文字流（Ctrl+F 能搜、能选中复制）
  let textPages = [];
  let cmap = '';
  if (o.textLayer !== false) {
    const runsPerPage = rendered.map(({ im, page }) => {
      const dims = paperDims(page.paper);
      return textRunsForPage(
        { items: page.items, ocr: page.ocr },
        { pageW: im.w || dims.w, pageH: im.h || dims.h, includeOcr: o.includeOcrText !== false },
      );
    });
    const codeMap = textCodeMap(runsPerPage.map((r) => charsOfRuns(r)).join(''));
    textPages = runsPerPage.map((runs) => textContentStream(runs, codeMap));
    cmap = codeMap.size ? toUnicodeCMap(codeMap) : '';
  }

  const bytes = pdfFromImages(rendered.map((r) => r.im), {
    title: o.title,
    textPages,
    toUnicode: cmap,
  });
  return new Blob([bytes], { type: 'application/pdf' });
}

/* ============================ 批量导出（资料库多选用） ============================ */

/** 把若干本笔记本摊平成页面序列（保持顺序，带上书名，便于合并导出） */
export function collectNotebookPages(notebooks, { paperForPage } = {}) {
  const out = [];
  const paperOf = paperForPage || ((nb, p) => p.paper || nb.paper || { template: 'lined', size: 'a4' });
  for (const nb of notebooks || []) {
    (nb.pages || []).forEach((p, i) => {
      out.push({
        bookId: nb.id,
        bookTitle: nb.title,
        pageIndex: i,
        paper: paperOf(nb, p, i),
        items: p.items || [],
        ocr: p.ocr || null,
      });
    });
  }
  return out;
}

/**
 * 批量导出：合并成一个 PDF，或每本一个 PDF
 * @returns {Promise<{merged:boolean, blob:Blob|null, pages:number, files:Array<{title:string,blob:Blob,pages:number}>}>}
 */
export async function buildPdfFromNotebooks(notebooks, {
  qualityId = 'high', merge = true, title = '', onProgress, textLayer = true, dropTape = false,
  renderPageImpl, render, waitImages = true,
} = {}) {
  const books = (notebooks || []).filter(Boolean);
  const flat = collectNotebookPages(books);
  const common = { qualityId, textLayer, dropTape, renderPageImpl, render, waitImages };
  if (merge) {
    const blob = await buildPdf(flat, { ...common, title: title || '笔记本合集', onProgress });
    return { merged: true, blob, pages: flat.length, files: [] };
  }
  const files = [];
  for (let i = 0; i < books.length; i++) {
    const nb = books[i];
    const pages = collectNotebookPages([nb]);
    const blob = await buildPdf(pages, { ...common, title: nb.title });   // eslint-disable-line no-await-in-loop
    files.push({ title: nb.title, blob, pages: pages.length });
    if (onProgress) { try { onProgress({ done: i + 1, total: books.length, title: nb.title }); } catch (e) {} }
  }
  return { merged: false, blob: null, pages: flat.length, files };
}

/** 单页 → PNG Blob */
export function pageToPng(page, { scale = 1, renderPage, dpr = 1 } = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof renderPage !== 'function') return resolve(null);
    const canvas = document.createElement('canvas');
    renderPage(canvas, { paper: page.paper, items: page.items, scale, dpr });
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), 'image/png');
    else {
      try {
        const url = canvas.toDataURL('image/png');
        resolve(new Blob([base64ToBytes(url)], { type: 'image/png' }));
      } catch (e) { resolve(null); }
    }
  });
}

export function downloadBlob(blob, filename) {
  if (!blob || typeof document === 'undefined') return false;
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (e) {}
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 0);
    return true;
  } catch (e) {
    return false;
  }
}

export async function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    try {
      const FR = typeof FileReader === 'function' ? FileReader : null;
      if (!FR) return resolve('');
      const fr = new FR();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    } catch (e) { resolve(''); }
  });
}

/* ============================ PDF 文本层（可搜索 / 可复制） ============================ */
import { estimateTextSize } from '../ink.mjs';
import { paperDims } from './paper.mjs';

/**
 * 文档级编码表：每个用到的字符分配一个 2 字节码（Identity-H），
 * 再配一张 ToUnicode CMap —— 这样隐形文字在阅读器里能搜、能选中、能复制。
 * 说明：字形本身不嵌入（文字是隐形绘制的），所以只靠 ToUnicode 就能被正确提取。
 */
export function textCodeMap(chars) {
  const map = new Map();
  let code = 1;
  for (const ch of String(chars || '')) {
    if (ch === '\n' || ch === '\r') continue;
    if (!map.has(ch)) map.set(ch, code++);
  }
  return map;
}

export function charsOfRuns(runs) {
  const set = new Set();
  for (const r of runs || []) for (const ch of String(r.text || '')) if (ch !== '\n') set.add(ch);
  return [...set].join('');
}

function utf16beHex(str) {
  let out = '';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xFFFF) {
      const v = cp - 0x10000;
      out += (0xD800 + (v >> 10)).toString(16).padStart(4, '0');
      out += (0xDC00 + (v & 0x3FF)).toString(16).padStart(4, '0');
    } else {
      out += cp.toString(16).padStart(4, '0');
    }
  }
  return out.toUpperCase();
}

export function encodeTextHex(text, codeMap) {
  let hex = '';
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '\n' || ch === '\r') continue;
    const c = codeMap.get(ch);
    if (c) hex += c.toString(16).padStart(4, '0');
  }
  return hex;
}

/** 生成 ToUnicode CMap（bfchar 每块最多 100 条，规范要求） */
export function toUnicodeCMap(codeMap) {
  const entries = [...codeMap.entries()];
  const out = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    out.push(`${chunk.length} beginbfchar`);
    for (const [ch, code] of chunk) {
      out.push(`<${code.toString(16).padStart(4, '0').toUpperCase()}> <${utf16beHex(ch)}>`);
    }
    out.push('endbfchar');
  }
  out.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return out.join('\n');
}

/**
 * 把一页里「有文字的内容」变成 PDF 文本行（坐标用 PDF 用户空间：原点在左下角）
 *   · 文本对象：按它自己的位置/字号/对齐精确摆位（和画布上看到的一致）
 *   · OCR 结果：视觉模型不给坐标，所以按行铺在页面左侧（隐形文字，只为可搜索/可复制）
 */
export function textRunsForPage(page, { pageW = 794, pageH = 1123, includeOcr = true, includeText = true } = {}) {
  const runs = [];
  const items = (page && page.items) || [];
  if (includeText) {
    for (const it of items) {
      if (!it || it.kind !== 'text' || !it.text) continue;
      const px = Math.max(4, (Number(it.size) || 0.026) * pageW);
      const block = estimateTextSize(it.text, it.size);
      const lines = String(it.text).split('\n');
      const align = it.align || 'left';
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        const lineW = estimateTextSize(line, it.size).w * pageW;
        let x = (Number(it.x) || 0) * pageW;
        if (align === 'center') x += (block.w * pageW - lineW) / 2;
        else if (align === 'right') x += block.w * pageW - lineW;
        const yTop = (Number(it.y) || 0) * pageH + i * px * 1.36;
        runs.push({ text: line, x, y: pageH - yTop - px, size: px, source: 'text' });
      });
    }
  }
  if (includeOcr && page && page.ocr && page.ocr.text) {
    const size = 10;
    const leading = 14;
    let y = 22;
    for (const line of String(page.ocr.text).split('\n')) {
      if (y > pageH - 16) break;
      if (line.trim()) runs.push({ text: line, x: 22, y: pageH - y - size, size, source: 'ocr' });
      y += leading;
    }
  }
  return runs;
}

/** 把文本行拼成 PDF 内容流片段（3 Tr = 隐形绘制） */
export function textContentStream(runs, codeMap, { fontName = 'F1' } = {}) {
  const parts = [];
  for (const r of runs || []) {
    const hex = encodeTextHex(r.text, codeMap);
    if (!hex) continue;
    parts.push(`BT 3 Tr /${fontName} ${Number(r.size).toFixed(2)} Tf 1 0 0 1 ${Number(r.x).toFixed(2)} ${Number(r.y).toFixed(2)} Tm <${hex}> Tj ET`);
  }
  return parts.join('\n');
}

/** 从自己生成的 PDF 里把文本层读回来（自检与「能不能搜」的验证工具） */
export function readTextLayer(bytes) {
  const latin = Buffer.from(bytes).toString('latin1');
  // 1) 解析 ToUnicode 表
  const map = new Map();
  const cmapBlocks = latin.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
  for (const blk of cmapBlocks) {
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const code = parseInt(m[1], 16);
      const hex = m[2];
      let str = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        const unit = parseInt(hex.slice(i, i + 4), 16);
        if (unit >= 0xD800 && unit <= 0xDBFF && i + 8 <= hex.length) {
          const low = parseInt(hex.slice(i + 4, i + 8), 16);
          str += String.fromCodePoint(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00));
          i += 4;
        } else {
          str += String.fromCharCode(unit);
        }
      }
      map.set(code, str);
    }
  }
  // 2) 逐页把 BT…ET 里的 <hex> Tj 还原成文字
  const pages = [];
  for (const blk of latin.match(/BT[\s\S]*?ET/g) || []) {
    let text = '';
    for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const hex = m[1];
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        const code = parseInt(hex.slice(i, i + 4), 16);
        text += map.get(code) || '';
      }
    }
    if (text) pages.push(text);
  }
  return { text: pages.join('\n'), pages, chars: map.size };
}


/* ============================ 录音 ============================ */

/**
 * 录音器封装（GoodNotes「录音与笔记同步」的采集端）
 * @returns {{supported:boolean, start:Function, stop:Function, state:Function}}
 */
export function makeRecorder() {
  const supported = typeof navigator !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && typeof MediaRecorder !== 'undefined';
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  return {
    supported,
    async start() {
      if (!supported) throw new Error('这个浏览器不支持录音');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start();
      startedAt = Date.now();
      return true;
    },
    stop() {
      return new Promise((resolve) => {
        if (!recorder) return resolve(null);
        const rec = recorder;
        rec.onstop = () => {
          try { rec.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
          const duration = (Date.now() - startedAt) / 1000;
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
          recorder = null;
          resolve({ blob, duration });
        };
        try { rec.stop(); } catch (e) { resolve(null); }
      });
    },
    state: () => (recorder && recorder.state) || 'inactive',
  };
}

/* ============================ 本地摘要（AI 总结的替代） ============================ */

const STOP = new Set(['的', '了', '和', '是', '在', '我', '有', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', 'the', 'a', 'an', 'of', 'to', 'and', 'is', 'are', 'in', 'it', 'for', 'on', 'with']);

function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function terms(s) {
  const out = [];
  const zh = s.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  out.push(...zh);
  const en = s.toLowerCase().match(/[a-z]{3,}/g) || [];
  out.push(...en.filter((w) => !STOP.has(w)));
  return out.filter((w) => !STOP.has(w));
}

/**
 * 抽取式摘要：按词频给句子打分，挑最关键的几句（不联网、不上传）
 * @returns {string[]} 摘要句列表（按原文顺序）
 */
export function summarizeText(text, { max = 3 } = {}) {
  const sents = splitSentences(text);
  if (sents.length <= max) return sents;
  const freq = new Map();
  for (const s of sents) for (const t of terms(s)) freq.set(t, (freq.get(t) || 0) + 1);
  const scored = sents.map((s, i) => {
    const ts = terms(s);
    const score = ts.reduce((acc, t) => acc + (freq.get(t) || 0), 0) / Math.max(1, Math.sqrt(ts.length));
    return { s, i, score: score + (i === 0 ? 0.6 : 0) };   // 首句通常是主题句，权重略高
  });
  return scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, max))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

/** 把摘要拼成一段（页面上「总结这一页」用） */
export function summarizePage(items, { max = 3 } = {}) {
  const text = (items || []).filter((it) => it && it.kind === 'text').map((it) => it.text || '').join('。');
  return summarizeText(text, { max });
}

/* ============================ 学习集统计 ============================ */

export function deckStats(store, bookId) {
  const deck = store.dueCards(bookId);
  const all = (store.get(bookId) || {}).study || [];
  const now = Date.now();
  return {
    total: all.length,
    due: deck.length,
    learning: all.filter((c) => (c.box || 0) > 0 && (c.box || 0) < 5).length,
    mastered: all.filter((c) => (c.box || 0) >= 5).length,
    todayReviews: all.filter((c) => c.last && now - c.last < 86400000).length,
    lapses: all.reduce((s, c) => s + (c.lapses || 0), 0),
  };
}

/** 给闪卡排个学习队列：先到期的、盒子低的优先 */
export function deckQueue(store, bookId, limit = 20) {
  return store.dueCards(bookId).slice(0, limit);
}
