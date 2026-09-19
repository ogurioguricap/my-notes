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
  const objCount = 2 + n * 3;
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
    push(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageNum} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${contentNum} 0 R >>`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    push(contentNum, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[imageNum] = buf.length;
    buf.push(`${imageNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`);
    buf.push(im.jpeg);
    buf.push('\nendstream\nendobj\n');
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
 * 整本笔记本 → PDF Blob
 * @param {Array} pages [{ paper, items }]
 * @param {object} o { title, scale, render } render 可注入（测试用）
 */
export async function buildPdf(pages, o = {}) {
  const render = o.render || ((page) => {
    const mod = o.renderPageImpl;
    return defaultRenderJpeg(page, { scale: o.scale || 1, renderPage: mod });
  });
  const images = [];
  for (const p of pages || []) {
    const im = render(p);
    if (im) images.push(im);
  }
  const bytes = pdfFromImages(images, { title: o.title });
  return new Blob([bytes], { type: 'application/pdf' });
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
