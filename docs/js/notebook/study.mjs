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
  const clean = String(b64 == null ? '' : b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  try {
    if (typeof atob === 'function') {
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // Node 兜底
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  } catch (e) {
    // 不是合法的 base64（例如测试桩里的假 toDataURL）→ 当空处理，交给调用方决定
    return new Uint8Array(0);
  }
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
  // 有文本层再补 3 个文档级对象（Type0 字体 / 后代 CIDFont / ToUnicode），有书签再补 1+N 个
  const textPages = Array.isArray(o.textPages) ? o.textPages : [];
  const hasText = textPages.some((s) => s && String(s).trim());
  const outlineList = (Array.isArray(o.outlines) ? o.outlines : [])
    .filter((x) => x && x.title && Number.isFinite(Number(x.pageIndex)))
    .slice(0, 200);
  const hasOutlines = outlineList.length > 0;
  const baseCount = 2 + n * 3;
  const fontNum = baseCount + 1;
  const descNum = baseCount + 2;
  const uniNum = baseCount + 3;
  const textCount = hasText ? 3 : 0;
  const outlineCount = hasOutlines ? 1 + outlineList.length : 0;
  const outlineRootNum = baseCount + textCount + 1;
  const outlineFirstNum = outlineRootNum + 1;
  // 页内链接：每页一组，对象编号接在目录后面
  const linkPages = (Array.isArray(o.linkPages) ? o.linkPages : []).map((arr) => (Array.isArray(arr) ? arr : []));
  const linksFlat = [];
  for (let i = 0; i < n; i++) {
    (linkPages[i] || []).forEach((l) => {
      if (!l || !Array.isArray(l.rect) || !(Number(l.target) >= 1)) return;
      linksFlat.push({ ...l, fromPage: i });
    });
  }
  const linkStartNum = baseCount + textCount + outlineCount + 1;
  linksFlat.forEach((x, idx) => { x.objNum = linkStartNum + idx; });
  const objCount = baseCount + textCount + outlineCount + linksFlat.length;
  const push = (num, body) => {
    offsets[num] = buf.length;
    buf.push(`${num} 0 obj\n${body}\nendobj\n`);
  };

  buf.push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${3 + i * 3} 0 R`);
  push(1, `<< /Type /Catalog /Pages 2 0 R${hasOutlines ? ` /Outlines ${outlineRootNum} 0 R /PageMode /UseOutlines` : ''} >>`);
  push(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);

  for (let i = 0; i < n; i++) {
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    const im = pages[i] || { jpeg: new Uint8Array(0), w: 595, h: 842 };
    const w = Math.max(1, Math.round(im.w || 595));
    const h = Math.max(1, Math.round(im.h || 842));
    const text = textPages[i] && String(textPages[i]).trim() ? String(textPages[i]) : '';
    const myLinks = linksFlat.filter((x) => x.fromPage === i).map((x) => x.objNum);
    const annots = myLinks.length ? ` /Annots [${myLinks.map((num) => `${num} 0 R`).join(' ')}]` : '';
    const res = text
      ? `/Resources << /XObject << /Im0 ${imageNum} 0 R >> /Font << /F1 ${fontNum} 0 R >> /ProcSet [/PDF /Text /ImageC] >>`
      : `/Resources << /XObject << /Im0 ${imageNum} 0 R >> /ProcSet [/PDF /ImageC] >>`;
    push(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ${res}${annots} /Contents ${contentNum} 0 R >>`);
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

  if (hasOutlines) {
    // 层级大纲：先摊平成对象号，再按 Parent / First / Last / Next / Prev 串起来
    const tree = outlineTree(outlineList);
    const flat = outlineFlat(tree, outlineFirstNum, outlineRootNum);
    const rootCount = flat.length;
    push(outlineRootNum, `<< /Type /Outlines${flat.length ? ` /First ${flat[0].num} 0 R /Last ${flat.filter((x) => x.parent === outlineRootNum).slice(-1)[0].num} 0 R` : ''} /Count ${rootCount} >>`);
    for (const node of flat) {
      const pageNum = 3 + Math.min(n - 1, Math.max(0, node.pageIndex)) * 3;
      const parts = [
        `/Title ${pdfTitleHex(node.title)}`,
        `/Parent ${node.parent || outlineRootNum} 0 R`,
        `/Dest [${pageNum} 0 R /Fit]`,
      ];
      if (node.children.length) {
        const kids = flat.filter((x) => x.parent === node.num);
        parts.push(`/First ${kids[0].num} 0 R`, `/Last ${kids[kids.length - 1].num} 0 R`, `/Count ${kids.length}`);
      }
      const sibs = flat.filter((x) => x.parent === node.parent);
      const pos = sibs.findIndex((x) => x.num === node.num);
      if (pos > 0) parts.push(`/Prev ${sibs[pos - 1].num} 0 R`);
      if (pos >= 0 && pos < sibs.length - 1) parts.push(`/Next ${sibs[pos + 1].num} 0 R`);
      push(node.num, `<< ${parts.join(' ')} >>`);
    }
  }

  if (linksFlat.length) {
    for (const l of linksFlat) {
      const targetPageNum = 3 + Math.min(n - 1, Math.max(0, Math.round(Number(l.target)) - 1)) * 3;
      const r = l.rect.slice(0, 4).map((v) => Number(v).toFixed(2));
      push(l.objNum, `<< /Type /Annot /Subtype /Link /Rect [${r.join(' ')}] /Border [0 0 0] /Dest [${targetPageNum} 0 R /Fit] >>`);
    }
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
export function defaultRenderJpeg(page, { scale = 1, quality = 0.86, renderPage, plain = false, flat = false } = {}) {
  if (typeof document === 'undefined' || typeof renderPage !== 'function') return null;
  const canvas = document.createElement('canvas');
  const info = renderPage(canvas, {
    paper: page.paper,
    items: page.items,
    scale,
    dpr: 1,
    plain,
    flat,
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

  const render = o.render || ((page) => defaultRenderJpeg(page, { scale, quality: jpegQuality, renderPage: o.renderPageImpl, plain: !!o.plain, flat: !!o.flat }));

  // 先把每页画出来（图片预加载已经等过），文本层的坐标要用「和 MediaBox 完全一致的页面尺寸」
  const rendered = [];
  for (let i = 0; i < list.length; i++) {
    const im = render(list[i], i);
    if (im && im.jpeg && im.jpeg.length) rendered.push({ im, page: list[i] });
    if (o.onProgress) { try { o.onProgress({ done: i + 1, total: list.length }); } catch (e) {} }
  }

  // 自动目录页（可选）：插在最前面，条目自带隐形文字层与可点链接
  let tocInfo = null;
  if (o.toc && Array.isArray(o.toc.entries) && o.toc.entries.length && !o.render) {
    const firstPaper = (list[0] && list[0].paper) || { template: 'lined', size: 'a4' };
    const toc = renderTocPage(o.toc.entries, { paper: firstPaper, title: o.toc.title || '目录', scale, quality: jpegQuality });
    if (toc) {
      tocInfo = { entries: toc.entries };      rendered.unshift({
        im: { jpeg: toc.jpeg, w: toc.w, h: toc.h },
        page: { paper: firstPaper, items: [], ocr: null, extraRuns: toc.runs, extraLinks: toc.links },
      });
    }
  }

  // 文本层：整本文档共用一张编码表，逐页生成隐形文字流（Ctrl+F 能搜、能选中复制）
  let textPages = [];
  let cmap = '';
  if (o.textLayer !== false) {
    const runsPerPage = rendered.map(({ im, page }) => {
      const dims = paperDims(page.paper);
      const own = textRunsForPage(
        { items: page.items, ocr: page.ocr },
        { pageW: im.w || dims.w, pageH: im.h || dims.h, includeOcr: o.includeOcrText !== false },
      );
      return [...(page.extraRuns || []), ...own];
    });
    const codeMap = textCodeMap(runsPerPage.map((r) => charsOfRuns(r)).join(''));
    textPages = runsPerPage.map((runs) => textContentStream(runs, codeMap));
    cmap = codeMap.size ? toUnicodeCMap(codeMap) : '';
  }

  const bytes = pdfFromImages(rendered.map((r) => r.im), {
    title: o.title,
    textPages,
    toUnicode: cmap,
    outlines: o.outlines || [],
    linkPages: o.linkPages || (o.links === false ? [] : rendered.map(({ im, page }) => [
      ...(page.extraLinks || []),
      ...pageRefLinks(
        { items: page.items, ocr: page.ocr },
        { pageW: im.w || 794, pageH: im.h || 1123, pageCount: rendered.length },
      ),
    ])),
  });
  return new Blob([bytes], { type: 'application/pdf' });
}

/** 目录页会额外占一页，导出前想知道最终页数用这个 */
export function pdfPageCount(pages, o = {}) {
  const n = (pages || []).filter((p) => p).length;
  return n + (o.toc && Array.isArray(o.toc.entries) && o.toc.entries.length ? 1 : 0);
}

/* ============================ 导出 Markdown（进全站检索） ============================ */

/** 文件名 slug（与站点笔记一致的中文友好规则） */
export function markdownSlug(title) {
  const s = String(title == null ? '' : title).trim().toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || `notebook-${Date.now().toString(36)}`;
}

function mdText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
}

/**
 * 笔记本 → Markdown（文本对象 + 手写识别结果 + 学习集闪卡）
 * 导出的 .md 丢进 content/ 就能进站点的全文检索与知识图谱
 */
export function notebookToMarkdown(nb, {
  includeText = true, includeOcr = true, includeCards = true, includeMeta = true, date = '',
} = {}) {
  const pages = (nb && nb.pages) || [];
  const ocrDone = pages.filter((p) => p.ocr && (p.ocr.text || (p.ocr.lines || []).length)).length;
  const day = date || new Date().toISOString().slice(0, 10);
  const tags = ['手写笔记本', ...((nb && nb.tags) || [])];
  const lines = [];
  if (includeMeta) {
    lines.push('---');
    lines.push(`title: ${(nb && nb.title) || '未命名笔记本'}`);
    lines.push('category: 笔记本');
    lines.push(`tags: [${tags.join(', ')}]`);
    lines.push(`date: ${day}`);
    lines.push(`summary: 由「笔记本」模式导出：${pages.length} 页${ocrDone ? ` · 手写识别 ${ocrDone} 页` : ''}`);
    lines.push('---', '');
  }
  lines.push(`# ${(nb && nb.title) || '未命名笔记本'}`, '');
  lines.push(`> 由「笔记本」模式导出（${pages.length} 页${ocrDone ? `，其中 ${ocrDone} 页含手写识别结果` : ''}）`, '');

  pages.forEach((p, i) => {
    const texts = includeText
      ? (p.items || []).filter((it) => it && it.kind === 'text' && mdText(it.text)).map((it) => mdText(it.text))
      : [];
    const ocr = includeOcr && p.ocr && p.ocr.text ? mdText(p.ocr.text) : '';
    if (!texts.length && !ocr) return;
    lines.push(`## 第 ${i + 1} 页${p.title ? ` · ${p.title}` : ''}`, '');
    if (texts.length) {
      lines.push(texts.join('\n\n'), '');
    }
    if (ocr) {
      lines.push('### 手写识别', '', ocr, '');
    }
  });

  if (includeCards && (nb.study || []).length) {
    lines.push('## 学习集（闪卡）', '');
    lines.push('| 正面 | 背面 |', '| --- | --- |');
    for (const c of nb.study) {
      lines.push(`| ${mdText(c.front).replace(/\|/g, '\\|')} | ${mdText(c.back).replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** 笔记本 → 「可提交到 content/ 的 Markdown」元信息 */
export function markdownTarget(nb) {
  const slug = markdownSlug((nb && nb.title) || 'notebook');
  return { slug, source: `content/${slug}.md` };
}

/* ============================ 多页长图（发聊天用） ============================ */

/** 竖排拼接的尺寸计算（纯函数，便于测试） */
export function longImageLayout(pages, { scale = 1, gap = 12 } = {}) {
  const dims = (pages || []).map((p) => paperDims(p && p.paper));
  if (!dims.length) return { width: 1, height: 1, offsets: [], pages: [], gap };
  const s = Math.max(0.2, Math.min(4, Number(scale) || 1));
  const pageSizes = dims.map((d) => ({ w: Math.max(1, Math.round(d.w * s)), h: Math.max(1, Math.round(d.h * s)) }));
  const width = Math.max(...pageSizes.map((d) => d.w));
  const offsets = [];
  let y = 0;
  pageSizes.forEach((d, i) => {
    offsets.push(y);
    y += d.h + (i < pageSizes.length - 1 ? gap : 0);
  });
  return { width, height: Math.max(1, y), offsets, pages: pageSizes, gap, scale: s };
}

/** 画布有尺寸上限：太高就把倍率降下来（保住「能生成」这件事） */
export function fitLongImage(layout, { maxDim = 12000 } = {}) {
  const h = Math.max(1, layout.height);
  if (h <= maxDim) return { ...layout, adjusted: false };
  const n = layout.pages.length;
  const gap = Math.max(2, Math.round(layout.gap * 0.5));
  const totalGap = gap * Math.max(0, n - 1);
  const contentH = layout.pages.reduce((s, p) => s + p.h, 0) || 1;
  const k = Math.max(0.05, (maxDim - totalGap) / contentH);   // 把间距也算进去，结果一定不超上限
  const scaled = longImageLayout(
    layout.pages.map((p) => ({ paper: { size: 'custom', width: Math.round(p.w * k), height: Math.round(p.h * k) } })),
    { scale: 1, gap },
  );
  return { ...scaled, adjusted: true, shrink: k };
}

/** 整本笔记本 → 一张竖排长图（PNG Blob） */
export async function buildLongImage(nb, { scale = 1, gap = 12, background = '#ffffff', renderPage, maxDim = 12000 } = {}) {
  if (typeof document === 'undefined' || typeof renderPage !== 'function' || !nb) return null;
  const pages = nb.pages || [];
  if (!pages.length) return null;
  const paperFor = (p) => p.paper || nb.paper || { template: 'lined', size: 'a4' };
  const full = longImageLayout(pages.map((p) => ({ paper: paperFor(p) })), { scale, gap });
  const layout = fitLongImage(full, { maxDim });
  const k = layout.adjusted && full.height ? layout.height / full.height : 1;
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < pages.length; i++) {
    const off = document.createElement('canvas');
    renderPage(off, { paper: paperFor(pages[i]), items: pages[i].items || [], scale: layout.scale, dpr: 1 });
    try { ctx.drawImage(off, 0, layout.offsets[i]); } catch (e) { /* 单页失败不影响其它页 */ }
  }
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), 'image/png');
    else {
      try {
        const url = canvas.toDataURL('image/png');
        resolve(new Blob([base64ToBytes(url)], { type: 'image/png' }));
      } catch (e) { resolve(null); }
    }
  });
}

/* ============================ 自动目录页（导出 PDF 时插在最前） ============================ */

/** 目录条目：书签页 + 有标题的页（没有就每页一条）；number = 在 PDF 里的实际页码（目录页占第 1 页） */
export function tocEntries(nb, { everyPageIfEmpty = true, offset = 1 } = {}) {
  const pages = (nb && nb.pages) || [];
  const out = [];
  pages.forEach((p, i) => {
    const title = String((p && p.title) || '').trim();
    const marked = !!(p && p.bookmarked) || !!title;
    if (!marked && !everyPageIfEmpty) return;
    out.push({
      title: title || ((p && p.bookmarked) ? `第 ${i + 1} 页（书签）` : `第 ${i + 1} 页`),
      pageIndex: i,
      number: i + 1 + Math.max(0, Math.round(Number(offset) || 0)),
    });
  });
  return out;
}

/** 估算一段文字的宽度（不依赖 ctx.measureText，方便无浏览器测试与导出用） */
export function estimateWidth(text, size) {
  let w = 0;
  for (const ch of String(text == null ? '' : text)) {
    w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : (ch === ' ' ? 0.32 : 0.56);
  }
  return w * Math.max(1, Number(size) || 1);
}

/**
 * 用 canvas 画一页目录（含虚线引导、页码），同时给出隐形文本层与可点链接
 * @returns {{jpeg:Uint8Array,w:number,h:number,runs:Array,links:Array}|null}
 */
export function renderTocPage(entries, { paper, title = '目录', scale = 2, quality = 0.9, font = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' } = {}) {
  if (typeof document === 'undefined') return null;
  const list = (entries || []).filter(Boolean);
  const dims = paperDims(paper);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(dims.w * Math.max(1, scale));
  canvas.height = Math.round(dims.h * Math.max(1, scale));
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return null;
  const W = canvas.width, H = canvas.height;
  const pad = Math.round(W * 0.1);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#2B2723';
  const titleSize = Math.round(W * 0.05);
  ctx.font = `700 ${titleSize}px ${font}`;
  ctx.fillText(String(title), pad, Math.round(H * 0.075));
  ctx.fillStyle = 'rgba(43,39,35,.45)';
  ctx.font = `400 ${Math.round(W * 0.017)}px ${font}`;
  ctx.fillText(`${list.length} 项 · 点标题可跳页`, pad, Math.round(H * 0.075 + titleSize * 1.5));

  const lineH = Math.round(W * 0.052);
  const size = Math.round(W * 0.028);
  const runs = [];
  const links = [];
  let y = Math.round(H * 0.16);
  for (const e of list) {
    if (y + size > H - pad) break;          // 一页放不下就停（不硬挤）
    const label = String(e.title).slice(0, 32);
    const numText = String(e.number);
    ctx.fillStyle = '#2B2723';
    ctx.font = `400 ${size}px ${font}`;
    ctx.fillText(label, pad, y);
    const labelW = estimateWidth(label, size);
    const numW = estimateWidth(numText, size);
    const numX = W - pad - numW;
    ctx.fillText(numText, numX, y);
    ctx.save();
    ctx.strokeStyle = 'rgba(90,100,120,.35)';
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.moveTo(pad + labelW + size, y + size * 0.8);
    ctx.lineTo(numX - size, y + size * 0.8);
    ctx.stroke();
    ctx.restore();
    // 隐形文本层（Ctrl+F 能搜到目录）+ 整行可点
    runs.push({ text: `${label}  ${numText}`, x: pad, y: H - y - size, size, source: 'toc' });
    links.push({ target: e.number, label, rect: [pad, H - y - size, W - pad, H - y + size * 0.35], source: 'toc' });
    y += lineH;
  }
  let jpeg = new Uint8Array(0);
  try { jpeg = base64ToBytes(canvas.toDataURL('image/jpeg', quality)); } catch (e) { jpeg = new Uint8Array(0); }
  // 即使图没编码成功（例如测试桩），也把文字层与链接返回，便于校验排版结果
  return { jpeg, w: W, h: H, runs, links, entries: runs.length };
}

/* ============================ EPUB / 单文件 HTML ============================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 极简 ZIP 写出器（只做「存储」不压缩：EPUB 的 mimetype 必须不压缩，其余条目也一视同仁） */
export function zipStore(entries, { date = new Date() } = {}) {
  const list = (entries || []).filter((e) => e && e.name);
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xFFFF;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  for (const e of list) {
    const name = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data == null ? '' : e.data));
    const crc = crc32(data);
    const head = new Uint8Array(30 + name.length);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);          // 不压缩
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    head.set(name, 30);
    parts.push(head, data);
    central.push({ name, crc, size: data.length, offset });
    offset += head.length + data.length;
  }
  const cdParts = [];
  let cdSize = 0;
  for (const c of central) {
    const buf = new Uint8Array(46 + c.name.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, dosTime, true);
    dv.setUint16(14, dosDate, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.name.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, c.offset, true);
    buf.set(c.name, 46);
    cdParts.push(buf);
    cdSize += buf.length;
  }
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true);
  const all = [...parts, ...cdParts, eocd];
  const total = all.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}

/** 一页 → 每页的 JPEG 与文字（EPUB / 单文件 HTML 共用） */
export function collectRenderablePages(nb, { renderPage, scale = 1.5, quality = 0.85, dropTape = false, plain = false } = {}) {
  const pages = (nb && nb.pages) || [];
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const paper = p.paper || nb.paper || { template: 'lined', size: 'a4' };
    const im = defaultRenderJpeg(
      { paper, items: (p.items || []).filter((it) => !(dropTape && it && it.kind === 'tape')) },
      { scale, quality, renderPage, plain },
    );
    const texts = (p.items || []).filter((it) => it && it.kind === 'text' && String(it.text || '').trim()).map((it) => String(it.text).trim());
    const ocr = p.ocr && p.ocr.text ? String(p.ocr.text).trim() : '';
    out.push({
      index: i,
      title: String(p.title || '').trim(),
      jpeg: (im && im.jpeg) || new Uint8Array(0),
      w: im ? im.w : 0,
      h: im ? im.h : 0,
      text: [...texts, ocr].join('\n'),
      ocr,
    });
  }
  return out;
}

function xmlEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 笔记本 → 单文件 HTML（图片内联 data URL + 文本，双击即可看，也能直接打印） */
export function buildSingleHtml(nb, { renderPage, scale = 1.5, quality = 0.85, plain = false, dropTape = false } = {}) {
  const pages = collectRenderablePages(nb, { renderPage, scale, quality, plain, dropTape });
  const title = (nb && nb.title) || '笔记本';
  const toc = pages.filter((p) => p.title).map((p) => `<li><a href="#p${p.index + 1}">${xmlEsc(p.title)}</a></li>`).join('');
  const body = pages.map((p) => {
    const img = p.jpeg && p.jpeg.length ? `<img src="data:image/jpeg;base64,${bytesToBase64(p.jpeg)}" alt="第 ${p.index + 1} 页">` : '<p>（这一页没渲染出来）</p>';
    return `<section id="p${p.index + 1}"><h2>第 ${p.index + 1} 页${p.title ? ` · ${xmlEsc(p.title)}` : ''}</h2>${img}${p.text ? `<pre class="notes">${xmlEsc(p.text)}</pre>` : ''}</section>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEsc(title)}</title>
<style>
 body{margin:0;padding:24px;background:#F4F2ED;color:#2B2723;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
 h1{font-size:22px;margin:0 0 4px} .sub{color:#6B635A;font-size:13px;margin-bottom:18px}
 nav{background:#fff;border:1px solid #E9E5DE;border-radius:12px;padding:12px 16px;margin-bottom:20px}
 nav ul{margin:6px 0 0;padding-left:20px;font-size:13px}
 section{background:#fff;border:1px solid #E9E5DE;border-radius:12px;padding:14px;margin-bottom:18px;max-width:900px}
 section h2{font-size:15px;margin:0 0 10px;color:#6B635A;font-weight:600}
 img{width:100%;height:auto;border:1px solid #E9E5DE;border-radius:8px;display:block}
 pre.notes{margin:12px 0 0;padding:10px;background:#F7F6F3;border-radius:8px;white-space:pre-wrap;font:13px/1.7 ui-monospace,Consolas,monospace}
 @media print{body{background:#fff;padding:0}nav{display:none}section{border:0;padding:0;margin:0 0 8px;page-break-after:always}}
</style></head>
<body>
<h1>${xmlEsc(title)}</h1>
<div class="sub">共 ${pages.length} 页 · 由「笔记本」模式导出 · ${new Date().toLocaleString('zh-CN')}</div>
${toc ? `<nav><b>目录</b><ul>${toc}</ul></nav>` : ''}
${body}
</body></html>`;
}

function bytesToBase64(bytes) {
  if (!bytes || !bytes.length) return '';
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === 'function') return btoa(bin);
  if (typeof Buffer !== 'undefined') return Buffer.from(bin, 'binary').toString('base64');
  return '';
}

/** 笔记本 → EPUB（电子书，任意阅读器可打开；正文是可搜索文本 + 每页图片） */
export function buildEpub(nb, { renderPage, scale = 1.5, quality = 0.85, plain = false, dropTape = false, author = '我的笔记' } = {}) {
  const pages = collectRenderablePages(nb, { renderPage, scale, quality, plain, dropTape });
  const title = (nb && nb.title) || '笔记本';
  const uuid = `urn:uuid:${String((nb && nb.id) || 'nb')}-${Date.now().toString(36)}`;
  const entries = [];
  entries.push({ name: 'mimetype', data: 'application/epub+zip' });
  entries.push({
    name: 'META-INF/container.xml',
    data: '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>',
  });
  const manifest = [];
  const spine = ['<itemref idref="nav"/>'];
  pages.forEach((p, i) => {
    const id = `p${i + 1}`;
    const text = p.text ? `<div class="notes">${xmlEsc(p.text).replace(/\n/g, '<br>')}</div>` : '';
    const img = p.jpeg && p.jpeg.length ? `<img src="${id}.jpg" alt="第 ${i + 1} 页"/>` : '';
    entries.push({
      name: `OEBPS/${id}.xhtml`,
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN"><head><title>第 ${i + 1} 页</title>
<style>body{margin:0;padding:12px;font-family:sans-serif}img{width:100%;height:auto;display:block}.notes{margin-top:10px;font-size:13px;line-height:1.7;color:#333}</style>
</head><body><h2>第 ${i + 1} 页${p.title ? ` · ${xmlEsc(p.title)}` : ''}</h2>${img}${text}</body></html>`,
    });
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    if (p.jpeg && p.jpeg.length) {
      entries.push({ name: `OEBPS/${id}.jpg`, data: p.jpeg });
      manifest.push(`<item id="${id}img" href="${id}.jpg" media-type="image/jpeg"/>`);
    }
    spine.push(`<itemref idref="${id}"/>`);
  });
  const navList = pages.map((p) => `<li><a href="p${p.index + 1}.xhtml">第 ${p.index + 1} 页${p.title ? ` · ${xmlEsc(p.title)}` : ''}</a></li>`).join('');
  entries.push({
    name: 'OEBPS/nav.xhtml',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN"><head><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>${navList}</ol></nav></body></html>`,
  });
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  entries.push({
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uuid}</dc:identifier>
<dc:title>${xmlEsc(title)}</dc:title>
<dc:creator>${xmlEsc(author)}</dc:creator>
<dc:language>zh-CN</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>${manifest.join('')}</manifest>
<spine>${spine.join('')}</spine>
</package>`,
  });
  return new Blob([zipStore(entries)], { type: 'application/epub+zip' });
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
export function pageToPng(page, { scale = 1, renderPage, dpr = 1, plain = false, flat = false } = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof renderPage !== 'function') return resolve(null);
    const canvas = document.createElement('canvas');
    renderPage(canvas, { paper: page.paper, items: page.items, scale, dpr, plain, flat });
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

/** PDF 书签用的标题字符串：中文要走 UTF-16BE + BOM，否则阅读器里会乱码 */
export function pdfTitleHex(title) {
  const t = String(title == null ? '' : title).replace(/[()\\]/g, ' ').trim().slice(0, 120);
  if (!t) return '';
  return `<FEFF${utf16beHex(t)}>`;
}

/** 笔记本 → PDF 书签项（有标题的页为一级、只设了书签的页挂在它下面当二级） */
export function outlinesFromNotebook(nb, { everyPageIfEmpty = false } = {}) {
  const pages = (nb && nb.pages) || [];
  const items = [];
  let lastTop = -1;
  pages.forEach((p, i) => {
    const title = String((p && p.title) || '').trim();
    if (title) {
      items.push({ title, pageIndex: i, level: 0 });
      lastTop = items.length - 1;
      return;
    }
    if (p && p.bookmarked) {
      items.push({ title: `第 ${i + 1} 页（书签）`, pageIndex: i, level: lastTop >= 0 ? 1 : 0 });
      if (lastTop < 0) lastTop = items.length - 1;
    }
  });
  if (!items.length && everyPageIfEmpty) {
    pages.forEach((p, i) => items.push({ title: `第 ${i + 1} 页`, pageIndex: i, level: 0 }));
  }
  return items;
}

/** 扁平条目 → 树（level 0 为根，往后每级挂到上一个更浅的条目下） */
export function outlineTree(items) {
  const roots = [];
  const stack = [];
  for (const it of items || []) {
    const level = Math.max(0, Math.min(4, Math.round(Number(it && it.level) || 0)));
    const node = { title: String((it && it.title) || ''), pageIndex: Math.max(0, Math.round(Number(it && it.pageIndex) || 0)), level, children: [] };
    if (!node.title) continue;
    while (stack.length > level) stack.pop();
    if (level === 0 || !stack.length) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack[level] = node;
    stack.length = level + 1;
  }
  return roots;
}

/** 把树按先序摊平，并给每个节点编号（编号 = 对象号，用于 Parent/First/Last/Next/Prev） */
export function outlineFlat(tree, firstNum = 1, parentNum = 0) {
  const out = [];
  const walk = (nodes, parent) => {
    nodes.forEach((n, i) => {
      const num = firstNum + out.length;
      const firstChild = () => firstNum + out.length + 1;
      out.push({ ...n, num, parent, index: i, isFirst: i === 0, isLast: i === nodes.length - 1, childCount: n.children.length });
      if (n.children.length) walk(n.children, num);
    });
  };
  walk(tree, parentNum);
  return out;
}

/* ============================ PDF 页内链接（「见 P12」点得动） ============================ */

/** 从一段文字里找出「第 N 页」「P12」这类页引用 */
export function findPageRefs(text, { pageCount = 0 } = {}) {
  const src = String(text == null ? '' : text);
  const out = [];
  const seen = new Set();
  const patterns = [/第\s*(\d{1,3})\s*页/g, /[Pp]\.?\s*(\d{1,3})(?!\d)/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      const page = Number(m[1]);
      if (!(page >= 1)) continue;
      if (pageCount && page > pageCount) continue;   // 指到本子外面的不算
      const key = `${m.index}:${page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ at: m.index, label: m[0].trim(), page });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 一页里所有可点的页引用 → PDF 链接注解（矩形用 PDF 用户空间：原点左下角）
 *   · 文本框里的引用：按字符前缀宽度算矩形（和文字层同一套字体宽度估算）
 *   · 手写识别出来的行：按行框内的字符比例切一段
 */
export function pageRefLinks(page, { pageW = 794, pageH = 1123, pageCount = 1 } = {}) {
  const out = [];
  const items = (page && page.items) || [];
  for (const it of items) {
    if (!it || it.kind !== 'text' || !it.text) continue;
    const size = Number(it.size) || 0.026;
    const px = Math.max(4, size * pageW);
    const blockW = estimateTextSize(it.text, size).w * pageW;
    const align = it.align || 'left';
    const lines = String(it.text).split('\n');
    lines.forEach((line, i) => {
      const refs = findPageRefs(line, { pageCount });
      if (!refs.length) return;
      const lineW = estimateTextSize(line, size).w * pageW;
      const baseX = (Number(it.x) || 0) * pageW
        + (align === 'center' ? (blockW - lineW) / 2 : align === 'right' ? blockW - lineW : 0);
      const yTop = (Number(it.y) || 0) * pageH + i * px * 1.36;
      for (const ref of refs) {
        const preW = estimateTextSize(line.slice(0, ref.at), size).w * pageW;
        const midW = Math.max(6, estimateTextSize(ref.label, size).w * pageW);
        out.push({
          target: ref.page,
          label: ref.label,
          source: 'text',
          rect: [baseX + preW, pageH - yTop - px, baseX + preW + midW, pageH - yTop + px * 0.25],
        });
      }
    });
  }
  for (const l of ((page && page.ocr && page.ocr.lines) || [])) {
    if (!l || !l.text || !Array.isArray(l.box)) continue;
    const refs = findPageRefs(l.text, { pageCount });
    if (!refs.length) continue;
    const [x0, y0, x1, y1] = l.box;
    const lineW = Math.max(1e-6, x1 - x0);
    const total = Math.max(1e-6, estimateTextSize(l.text, 1).w);
    for (const ref of refs) {
      const preFrac = estimateTextSize(l.text.slice(0, ref.at), 1).w / total;
      const midFrac = Math.max(0.02, estimateTextSize(ref.label, 1).w / total);
      out.push({
        target: ref.page,
        label: ref.label,
        source: 'ocr',
        rect: [(x0 + preFrac * lineW) * pageW, (1 - y1) * pageH, (x0 + (preFrac + midFrac) * lineW) * pageW, (1 - y0) * pageH],
      });
    }
  }
  return out;
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
  if (includeOcr && page && page.ocr && (page.ocr.text || (page.ocr.lines || []).length)) {
    const boxed = (page.ocr.lines || []).filter((l) => l && l.text && l.box);
    if (boxed.length) {
      // 有位置：按识别出来的行框原位摆放（选中/复制就会落在那一行上）
      for (const l of boxed) {
        const [x0, y0, x1, y1] = l.box;
        const w = Math.max(4, (x1 - x0) * pageW);
        const h = Math.max(6, (y1 - y0) * pageH);
        const size = Math.max(6, h * 0.86);
        const textW = estimateTextSize(l.text, size / pageW).w * pageW;
        const tz = textW > 1 ? Math.max(40, Math.min(400, Math.round((w / textW) * 100))) : 100;
        runs.push({ text: l.text, x: x0 * pageW, y: pageH - y1 * pageH + h * 0.14, size, tz, source: 'ocr' });
      }
      const unboxed = (page.ocr.lines || []).filter((l) => l && l.text && !l.box);
      let ny = 22;
      for (const l of unboxed) {
        if (ny > pageH - 16) break;
        runs.push({ text: l.text, x: 22, y: pageH - ny - 10, size: 10, source: 'ocr' });
        ny += 14;
      }
    } else if (page.ocr.text) {
      // 老数据（只有纯文本）：按行铺在左侧，保证「可搜索」这件事不丢
      const size = 10;
      const leading = 14;
      let y = 22;
      for (const line of String(page.ocr.text).split('\n')) {
        if (y > pageH - 16) break;
        if (line.trim()) runs.push({ text: line, x: 22, y: pageH - y - size, size, source: 'ocr' });
        y += leading;
      }
    }
  }
  return runs;
}

/** 把文本行拼成 PDF 内容流片段（3 Tr = 隐形绘制；带 tz 的行会做水平缩放，让选中的宽度贴近真实文字） */
export function textContentStream(runs, codeMap, { fontName = 'F1' } = {}) {
  const parts = [];
  for (const r of runs || []) {
    const hex = encodeTextHex(r.text, codeMap);
    if (!hex) continue;
    const tz = Number(r.tz) > 0 && Math.abs(Number(r.tz) - 100) > 1 ? ` ${Number(r.tz).toFixed(0)} Tz` : '';
    parts.push(`BT 3 Tr /${fontName} ${Number(r.size).toFixed(2)} Tf${tz} 1 0 0 1 ${Number(r.x).toFixed(2)} ${Number(r.y).toFixed(2)} Tm <${hex}> Tj ET`);
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

/* ============================ 导出到 Anki（CSV） ============================ */

/** Anki 的文本导入头：逗号分隔、按 HTML 解析（换行才能变成 <br>）、标签在第 3 列 */
export const ANKI_HEADER = ['#separator:Comma', '#html:true', '#tags column:3'];

/** 字段转义：包含逗号 / 引号 / 换行时加引号，内部引号翻倍 */
export function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 卡面/卡背里换行改 <br>（Anki 开了 html:true 才认），同时去掉会打断导入的裸换行 */
export function ankiHtml(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * 闪卡 → Anki 可导入的 CSV（字段：正面, 背面, 标签）
 * @param {Array} cards 卡片（带 bookTitle / bookTags / tags）
 * @param {object} o { withBookTag=true 把笔记本名当标签, extraTags 额外标签, deckName }
 */
export function cardsToAnkiCsv(cards, { withBookTag = true, extraTags = [], deckName = '' } = {}) {
  const lines = [...ANKI_HEADER];
  if (deckName) lines.push(`#deck:${String(deckName).replace(/[,:\n]/g, ' ')}`);
  lines.push('正面,背面,标签');
  for (const c of cards || []) {
    if (!c || !String(c.front || '').trim()) continue;
    const tags = [];
    for (const t of c.tags || []) tags.push(String(t).replace(/\s+/g, '_'));
    if (withBookTag && c.bookTitle) tags.push(`本_${String(c.bookTitle).replace(/[\s,]+/g, '_')}`);
    for (const t of extraTags || []) tags.push(String(t).replace(/\s+/g, '_'));
    const uniq = [...new Set(tags.filter(Boolean))];
    lines.push([csvField(ankiHtml(c.front)), csvField(ankiHtml(c.back)), csvField(uniq.join(' '))].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** 从 store 直接导出（资料库「导出 Anki CSV」用）：可带筛选 */
export function ankiCsvFromStore(store, { tag = '', bookTag = '', bookId = '', folder = '', includeNotDue = true, deckName = '', extraTags = [] } = {}) {
  const cards = typeof store.allCards === 'function'
    ? store.allCards().filter((c) => {
      if (bookId && c.bookId !== bookId) return false;
      if (tag && !(c.tags || []).includes(tag)) return false;
      if (bookTag && !(c.bookTags || []).includes(bookTag)) return false;
      if (folder) { const nb = store.get(c.bookId); if (!nb || nb.folder !== folder) return false; }
      if (!includeNotDue && (c.due || 0) > Date.now()) return false;
      return true;
    })
    : [];
  return { csv: cardsToAnkiCsv(cards, { deckName, extraTags }), count: cards.length };
}
