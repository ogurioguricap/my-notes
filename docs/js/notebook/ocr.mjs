/**
 * GoodNotes 模式 · 手写识别（OCR）——补上「手写内容可搜索」这个最大缺口
 *
 * 做法：把页面渲染成 JPEG（就用导出 PDF 同一套渲染，所见即所得）→ 交给视觉模型识别 → 文字存回页面
 *   模型：SiliconFlow 的 Qwen3-VL（8B 快 / 32B 准），接口是 OpenAI 兼容的 /chat/completions
 *   密钥：只存在你这台设备的浏览器（localStorage），请求直接从浏览器发往 api.siliconflow.cn，不经过任何第三方
 *   识别结果：写在页面的 page.ocr 上，于是「资料库搜索」和「本笔记本内搜索」都能搜到手写
 *
 * 为什么不是自动的：识别要花钱、也要把页面图发出去，所以做成「你自己点一下才跑」，并且默认只跑没识别过的页。
 * 纯逻辑（请求体、响应解析、错误提示、抽页规则、并发池、文本清洗）全部导出，方便无浏览器环境测试。
 */
import { paperDims } from './paper.mjs';

export const OCR_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
export const OCR_KEY_STORAGE = 'note-ocr-key';
export const OCR_MODELS = [
  { id: 'Qwen/Qwen3-VL-8B-Instruct', label: '8B（快）', hint: '约 15~25 秒/页，适合整本批量' },
  { id: 'Qwen/Qwen3-VL-32B-Instruct', label: '32B（准）', hint: '约 50~90 秒/页，适合公式与表格页' },
];
export const OCR_PROMPT = [
  '你是一个专业的 OCR 引擎。请精确提取图片中的全部内容：',
  '- 文字：逐字转录，保留原始排版（段落、换行、缩进）',
  '- 表格：输出为 Markdown 表格，保留所有数值与表头',
  '- 图表：提取标题、坐标轴、图例、关键数据点',
  '- 数学公式：用 LaTeX 或可读符号表示',
  '- 若图片没有文字，只回一句「（本页无文字）」',
  '只输出提取结果本身，不要任何解释、不要代码块围栏。',
].join('\n');

export const MAX_OCR_CHARS = 12000;

/** 带位置版提示词：让模型顺手给出每一行的外接矩形（0~1 相对比例） */
export const OCR_BOX_PROMPT = [
  '你是一个精确的 OCR 引擎，并且要给出每一行文字的位置。',
  '只输出一个 JSON 对象，不要任何解释、不要代码块围栏，格式：',
  '{"lines":[{"text":"这一行的文字","box":[x0,y0,x1,y1]}]}',
  'box 是这一行文字在图片里的外接矩形，取值都是 0~1 的相对比例（左上角为 0,0，右下角为 1,1）。',
  '要求：逐行输出；表格按行输出；数学公式用 LaTeX 或可读符号；没有文字则返回 {"lines":[]}。',
].join('\n');

/**
 * 解析「带位置」的识别结果：模型偶尔会多说话或漏 box，这里一律兜住
 * @returns {{lines:Array<{text:string, box:number[]|null}>, ok:boolean, json:boolean}}
 */
export function parseOcrLines(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  let json = null;
  try { json = JSON.parse(text); } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);   // 容错：前后夹了说明文字
    if (m) { try { json = JSON.parse(m[0]); } catch (e2) { json = null; } }
  }
  const src = json && Array.isArray(json.lines) ? json.lines : [];
  const lines = [];
  for (const it of src) {
    if (!it) continue;
    const t = String(it.text != null ? it.text : (it.content != null ? it.content : '')).trim();
    if (!t) continue;
    const b = Array.isArray(it.box) ? it.box.map(Number) : null;
    if (!b || b.length < 4 || b.some((v) => !Number.isFinite(v))) { lines.push({ text: t, box: null }); continue; }
    const x0 = Math.max(0, Math.min(b[0], b[2]));
    const x1 = Math.min(1, Math.max(b[0], b[2]));
    const y0 = Math.max(0, Math.min(b[1], b[3]));
    const y1 = Math.min(1, Math.max(b[1], b[3]));
    if (x1 - x0 < 0.002 || y1 - y0 < 0.002) { lines.push({ text: t, box: null }); continue; }
    lines.push({ text: t, box: [x0, y0, x1, y1] });
  }
  return { lines, ok: lines.length > 0, json: !!json };
}

export function linesToText(lines) {
  return (lines || []).map((l) => l.text).filter(Boolean).join('\n');
}

export function lineCount(lines) { return (lines || []).filter((l) => l && l.text).length; }


/* ============================ 密钥 ============================ */

function store(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

export function getOcrKey(storage) {
  const s = store(storage);
  try { return (s && s.getItem(OCR_KEY_STORAGE)) || ''; } catch (e) { return ''; }
}

export function setOcrKey(storage, key) {
  const s = store(storage);
  const v = String(key || '').trim();
  try {
    if (!s) return false;
    if (v) s.setItem(OCR_KEY_STORAGE, v);
    else s.removeItem(OCR_KEY_STORAGE);
    return true;
  } catch (e) { return false; }
}

export function hasOcrKey(storage) { return !!getOcrKey(storage); }

/* ============================ 纯逻辑 ============================ */

export function modelOf(id) { return OCR_MODELS.find((m) => m.id === id) || OCR_MODELS[0]; }

/** 组装请求体（OpenAI 兼容） */
export function buildOcrBody(dataUrl, { model = OCR_MODELS[0].id, prompt = OCR_PROMPT, maxTokens = 4096 } = {}) {
  return {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: String(dataUrl || '') } },
      ],
    }],
    temperature: 0.1,
    max_tokens: maxTokens,
  };
}

/** 清洗识别结果：去围栏、压空行、限长 */
export function normalizeOcrText(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/^\s*```[a-zA-Z]*\s*/,'').replace(/\s*```\s*$/,'');
  t = t.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > MAX_OCR_CHARS) t = t.slice(0, MAX_OCR_CHARS) + '…';
  return t;
}

/** 从接口响应里取文字；失败时给出中文可读原因 */
export function parseOcrResponse(json) {
  if (!json) throw new Error('识别服务没有返回内容');
  if (json.error) throw new Error(ocrErrorHint(json.error.code || json.error.status, json));
  const choice = json.choices && json.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('识别服务返回了空结果');
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n') : '';
  return normalizeOcrText(text);
}

/** 错误码 → 人话（含常见坑：余额不足 / 限流 / key 无效） */
export function ocrErrorHint(status, json) {
  const s = Number(status) || 0;
  const msg = (json && json.error && (json.error.message || json.error.code)) || (json && json.message) || '';
  if (s === 401 || s === 403) return `密钥无效或没有权限（${s}）：去 cloud.siliconflow.cn 复制一个新的 API Key`;
  if (s === 402 || /30001|balance|insufficient/i.test(String(msg))) return '账户余额不足：先去 SiliconFlow 充值，再重试';
  if (s === 429) return '请求太频繁（429）：把并发调小一点，或等一分钟再试';
  if (s === 413) return '页面图太大（413）：先调小导出倍率再试';
  if (s >= 500) return `识别服务暂时故障（${s}）：稍后重试`;
  if (s === 400) return `请求被拒绝（400）：${String(msg).slice(0, 120)}`;
  return `识别失败${s ? `（${s}）` : ''}：${String(msg).slice(0, 160) || '未知原因'}`;
}

/** 哪些页需要识别（默认跳过已经识别过的） */
export function pickPagesToOcr(notebook, { onlyMissing = true, max = 0 } = {}) {
  const pages = (notebook && notebook.pages) || [];
  const out = [];
  pages.forEach((p, i) => {
    const has = !!(p.ocr && p.ocr.text);
    if (onlyMissing && has) return;
    if (!has && !(p.items || []).length && onlyMissing) return;   // 空白页不用花钱识别
    out.push(i);
  });
  return max > 0 ? out.slice(0, max) : out;
}

/** 页面图渲染倍率：太小认不清，太大上传慢 */
export function ocrRenderScale(paper, { minPx = 1100, maxPx = 1900 } = {}) {
  const w = Math.max(1, Number(paper && paper.w) || 794);
  const s = Math.min(maxPx, Math.max(minPx, w)) / w;
  return Math.max(1, Math.min(2.4, Number(s.toFixed(2))));
}

/** 简易并发池：按顺序取任务，最多 concurrency 个同时在跑 */
export async function runPool(items, worker, { concurrency = 3, onProgress, signal } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length).fill(null);
  let next = 0, done = 0, failed = 0;
  const n = Math.max(1, Math.min(8, concurrency || 1));
  const runner = async () => {
    for (;;) {
      if (signal && signal.aborted) return;
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (e) {
        failed++;
        results[i] = { ok: false, error: (e && e.message) || String(e) };
      }
      done++;
      if (onProgress) { try { onProgress({ done, total: list.length, failed }); } catch (e) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length || 1) }, runner));
  return { results, done, failed };
}

export function progressText(done, total, failed = 0) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `识别中 ${done}/${total}（${pct}%）${failed ? ` · 失败 ${failed}` : ''}`;
}

/** 把识别结果并进页面对象（不改原对象） */
export function mergePageOcr(page, { text, model }, at = Date.now()) {
  const clean = normalizeOcrText(text);
  if (!clean) return page;
  return { ...page, ocr: { text: clean, model: model || '', chars: clean.length, at } };
}

/** 笔记本的识别概况（界面提示用） */
export function ocrSummary(notebook) {
  const pages = (notebook && notebook.pages) || [];
  const done = pages.filter((p) => p.ocr && p.ocr.text).length;
  const chars = pages.reduce((s, p) => s + ((p.ocr && p.ocr.chars) || 0), 0);
  return { pages: pages.length, done, pending: pages.length - done, chars };
}

/* ============================ 浏览器侧调用 ============================ */

/** 把一页渲染成 JPEG data URL（走导出 PDF 同一套渲染） */
export function pageToJpeg(page, { renderPage, scale = 1.4, quality = 0.82 } = {}) {
  if (typeof document === 'undefined' || typeof renderPage !== 'function') return '';
  const canvas = document.createElement('canvas');
  renderPage(canvas, { paper: page.paper, items: page.items, scale, dpr: 1 });
  try { return canvas.toDataURL('image/jpeg', quality); } catch (e) { return ''; }
}

/** 识别一张图（data URL）→ 文字 */
export async function ocrImageDataUrl(dataUrl, { apiKey, model = OCR_MODELS[0].id, fetchImpl, timeoutMs = 150000, prompt } = {}) {
  if (!dataUrl) throw new Error('没有可识别的图片');
  if (!apiKey) throw new Error('还没填 API Key：去 cloud.siliconflow.cn 申请一个（站点里只需填一次）');
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('当前环境不能发网络请求');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
  try {
    const res = await f(OCR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildOcrBody(dataUrl, { model, prompt })),
      signal: ctrl ? ctrl.signal : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) throw new Error(ocrErrorHint(res.status, json));
    return parseOcrResponse(json);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`识别超时（>${Math.round(timeoutMs / 1000)}秒）：换 8B 模型或先把页面图调小`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 整本（或指定几页）识别，结果逐页写回 store
 * @returns {Promise<{done:number, failed:number, skipped:number, chars:number, errors:string[]}>}
 */
export async function ocrNotebook(store, bookId, {
  apiKey, model = OCR_MODELS[0].id, onlyMissing = true, indices = null, concurrency = 3,
  renderPage, fetchImpl, onProgress, signal, dryRun = false, withBoxes = true,
} = {}) {
  const nb = store.get(bookId);
  if (!nb) return { done: 0, failed: 0, skipped: 0, chars: 0, errors: ['找不到这本笔记本'] };
  const targets = Array.isArray(indices) ? indices : pickPagesToOcr(nb, { onlyMissing });
  const summary = { done: 0, failed: 0, skipped: nb.pages.length - targets.length, chars: 0, withBoxes: 0, errors: [] };
  if (!targets.length) return summary;
  const scaleFor = (page) => ocrRenderScale(paperDims(page.paper || nb.paper));

  const { results } = await runPool(targets, async (idx) => {
    const page = store.get(bookId).pages[idx];
    try {
      const jpeg = pageToJpeg({ paper: page.paper || nb.paper, items: page.items }, { renderPage, scale: scaleFor(page), quality: 0.82 });
      if (dryRun) return { idx, text: '', dry: true };
      const raw = await ocrImageDataUrl(jpeg, { apiKey, model, fetchImpl, prompt: withBoxes ? OCR_BOX_PROMPT : undefined });
      if (withBoxes) {
        const parsed = parseOcrLines(raw);
        if (parsed.lines.length) {
          const text = linesToText(parsed.lines);
          if (!text.trim()) { store.markPageBlank(bookId, page.id, { model }); return { idx, text: '', empty: true }; }
          store.setPageOcr(bookId, page.id, { text, model, lines: parsed.lines });
          return { idx, text, boxes: parsed.lines.filter((l) => l.box).length };
        }
        // 模型没按格式回 → 退回纯文本（不丢结果）
        const fallback = normalizeOcrText(raw);
        if (!fallback) { store.markPageBlank(bookId, page.id, { model }); return { idx, text: '', empty: true }; }
        store.setPageOcr(bookId, page.id, { text: fallback, model, lines: [] });
        return { idx, text: fallback, boxes: 0, degraded: true };
      }
      const text = raw;
      if (!text || /^（?本页无文字）?$/.test(String(text).trim())) { store.markPageBlank(bookId, page.id, { model }); return { idx, text: '', empty: true }; }
      store.setPageOcr(bookId, page.id, { text, model, lines: [] });
      return { idx, text };
    } catch (e) {
      // 失败也要留痕：批量队列据此「只重试失败页」，界面也能说清是哪些页、为什么
      if (!dryRun) {
        try { store.setPageOcrError(bookId, page.id, { message: (e && e.message) || String(e), model }); } catch (e2) { /* store 不支持就算了 */ }
      }
      throw e;
    }
  }, { concurrency, onProgress, signal });

  results.forEach((r) => {
    if (!r) return;
    if (!r.ok) { summary.failed++; if (summary.errors.length < 5) summary.errors.push(r.error); return; }
    summary.done++;
    summary.chars += (r.value && r.value.text ? r.value.text.length : 0);
    if (r.value && r.value.boxes) summary.withBoxes += r.value.boxes;
  });
  return summary;
}

/** 单页识别（界面上「识别这一页」用） */
export async function ocrOnePage(store, bookId, pageIndex, opts = {}) {
  return ocrNotebook(store, bookId, { ...opts, indices: [pageIndex], onlyMissing: false });
}

/* ============================ 识别质量回看（哪几页值得重跑） ============================ */

/** 页面上「有多少手写内容」的粗略度量：笔迹点数 + 文字字数 + 图片/贴纸个数 */
export function inkUnits(page) {
  let units = 0;
  for (const it of (page && page.items) || []) {
    if (!it || it.kind === 'tape') continue;
    if (it.kind === 'stroke' || it.kind === 'shape') units += Math.max(1, Math.round(((it.points || []).length) / 3));
    else if (it.kind === 'text') units += Math.round(String(it.text || '').length / 4);
    else if (it.kind === 'image' || it.kind === 'sticker') units += 6;
    else units += 1;
  }
  return units;
}

/** 一行是不是「几乎全是符号/噪声」（模型胡说的典型长相） */
export function lineGarbageRatio(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let bad = 0;
  for (const ch of s) {
    if (/[\p{L}\p{N}]/u.test(ch)) continue;      // 字母 / 数字 / 汉字都算正常
    if (/[\s，。、；：？！“”‘’（）《》【】…—·,.;:?!()"'\-+*/=%<>[\]{}#@&|~^$]/.test(ch)) continue;  // 常见标点算正常
    bad++;
  }
  return bad / s.length;
}

/** 重复行比例（同一个模型幻觉会把一行抄好几遍） */
export function duplicateLineRatio(lines) {
  const list = (lines || []).map((l) => String((l && l.text) || '').trim()).filter((t) => t.length >= 2);
  if (list.length < 3) return 0;
  return 1 - new Set(list).size / list.length;
}

/** 质量规则（界面上的说明也从这里取，避免两处口径不一致） */
export const OCR_QUALITY_RULES = [
  { code: 'few-chars', level: 'bad', label: '字数异常少', hint: '这一页手写不少，却几乎没识别出字：多半是字迹太淡 / 图太小 / 模型没看清' },
  { code: 'garbage', level: 'bad', label: '疑似乱码', hint: '识别结果里大半是不认识的符号：换个模型（32B）重跑通常能好' },
  { code: 'duplicate', level: 'bad', label: '内容重复', hint: '同一行被抄了好几遍：模型幻觉，重跑一次即可' },
  { code: 'no-boxes', level: 'warn', label: '缺少行位置', hint: '有文字但没给行框：PDF 里选中/复制不会贴原位（可开「同时识别行位置」重跑）' },
  { code: 'short-lines', level: 'warn', label: '行太碎', hint: '识别结果被切得很碎（每行一两个字）：可以整页重跑一次看看' },
];

/**
 * 一页的识别质量（纯函数）
 * @returns {{ state:string, level:'ok'|'warn'|'bad'|'info', reasons:Array<{code,label,hint,level}>,
 *             metrics:{chars,lines,boxes,boxRatio,ink,density,dupRatio,garbage,maxGarbage} }}
 */
export function ocrQualityOf(page) {
  const ocr = (page && page.ocr) || null;
  const chars = (ocr && ocr.text ? String(ocr.text).length : 0) || 0;
  const lines = (ocr && Array.isArray(ocr.lines) ? ocr.lines : []).filter((l) => l && String(l.text || '').trim());
  const boxed = lines.filter((l) => Array.isArray(l.box) && l.box.length >= 4).length;
  const ink = inkUnits(page);
  const state = pageOcrState(page);
  const metrics = {
    chars,
    lines: lines.length,
    boxes: boxed,
    boxRatio: lines.length ? boxed / lines.length : 0,
    ink,
    density: Math.round((chars / Math.max(1, ink)) * 100) / 100,
    dupRatio: duplicateLineRatio(lines),
    garbage: lines.length ? Math.round((lines.map((l) => lineGarbageRatio(l.text)).reduce((a, b) => a + b, 0) / lines.length) * 100) / 100 : 0,
    maxGarbage: lines.length ? Math.round(Math.max(...lines.map((l) => lineGarbageRatio(l.text))) * 100) / 100 : 0,
  };
  const reasons = [];
  if (state === 'failed') reasons.push({ code: 'failed', level: 'bad', label: '上次识别失败', hint: '失败原因记在那一页上，点「重跑这些页」再试' });
  if (state === 'done' || state === 'blank') {
    if (chars > 0) {
      if (chars < 12 && ink >= 30) reasons.push({ ...OCR_QUALITY_RULES[0], level: 'bad' });
      if (metrics.garbage >= 0.5 && chars >= 6) reasons.push({ ...OCR_QUALITY_RULES[1], level: 'bad' });
      if (metrics.dupRatio >= 0.4) reasons.push({ ...OCR_QUALITY_RULES[2], level: 'bad' });
      if (lines.length >= 3 && metrics.boxRatio < 0.3) reasons.push({ ...OCR_QUALITY_RULES[3], level: 'warn' });
      if (lines.length >= 6 && chars / lines.length < 2.5) reasons.push({ ...OCR_QUALITY_RULES[4], level: 'warn' });
    } else if (!(ocr && ocr.blank)) {
      reasons.push({ code: 'short-lines', level: 'warn', label: '识别结果为空', hint: '这一页记成了「已识别」但没文字，可以重跑一次' });
    }
  }
  const level = reasons.some((r) => r.level === 'bad') ? 'bad'
    : reasons.some((r) => r.level === 'warn') ? 'warn'
      : state === 'blank' ? 'info'
        : state === 'pending' ? 'info' : 'ok';
  return { state, level, reasons, metrics };
}

/**
 * 全库识别质量清单：只列值得看的页（默认 bad + warn）
 * @param {Array} notebooks
 * @param {object} o { onlySuspicious=true, minLevel='warn', includePending=false }
 */
export function ocrQualityReport(notebooks, { onlySuspicious = true, includePending = false } = {}) {
  const items = [];
  const stats = { pages: 0, bad: 0, warn: 0, ok: 0, blank: 0, pending: 0, books: 0, chars: 0, boxes: 0, boxed: 0 };
  const byReason = {};
  for (const nb of notebooks || []) {
    if (!nb) continue;
    let had = false;
    (nb.pages || []).forEach((p, i) => {
      const q = ocrQualityOf(p);
      if (!pageHasInk(p) && q.state === 'pending') return;         // 空白页不用管
      stats.pages++;
      stats.chars += q.metrics.chars;
      if (q.state === 'blank') stats.blank++;
      else if (q.state === 'pending') stats.pending++;
      if (q.level === 'bad') stats.bad++;
      else if (q.level === 'warn') stats.warn++;
      else if (q.level === 'ok') stats.ok++;
      if (q.state === 'done') { stats.boxes++; stats.boxed += q.metrics.boxes; }
      for (const r of q.reasons) byReason[r.code] = (byReason[r.code] || 0) + 1;
      const interesting = q.level === 'bad' || q.level === 'warn' || (includePending && q.state === 'pending');
      if ((onlySuspicious && !interesting) || q.state === 'blank') return;
      if (!interesting) return;
      had = true;
      items.push({
        bookId: nb.id,
        bookTitle: nb.title || '未命名',
        pageId: p.id,
        pageIndex: i,
        pageTitle: p.title || '',
        level: q.level,
        state: q.state,
        reasons: q.reasons.map((r) => r.code),
        labels: q.reasons.map((r) => r.label),
        metrics: q.metrics,
      });
    });
    if (had) stats.books++;
  }
  items.sort((a, b) => (a.level === b.level ? a.metrics.chars - b.metrics.chars : a.level === 'bad' ? -1 : 1));
  return { items, stats, byReason };
}

/** 质量清单 → 要重跑的页 id（界面「重跑这些页」直接用） */
export function qualityPageIds(report) {
  return [...new Set(((report && report.items) || []).map((it) => it.pageId).filter(Boolean))];
}

/* ============================ 批量队列（跨本 · 可续跑） ============================ */

/**
 * 一页的识别状态
 *   done    —— 有文字
 *   blank   —— 识别过了，这一页真的没字（不再重复花钱）
 *   failed  —— 上次失败（记了原因，可以只重试这些）
 *   pending —— 还没识别过
 */
export function pageOcrState(page) {
  if (!page) return 'pending';
  if (page.ocr && page.ocr.text) return 'done';
  if (page.ocr && page.ocr.blank) return page.ocrError ? 'failed' : 'blank';
  return page.ocrError ? 'failed' : 'pending';
}

/** 一页有没有可识别的内容（标题也算，纯空白页不值得花钱） */
export function pageHasInk(page) {
  return !!((page && page.items) || []).filter((it) => it && it.kind !== 'tape').length;
}

/**
 * 跨本排队：把「还需要识别」的页挑出来（纯函数，方便测）
 * @param {Array} notebooks 笔记本数组
 * @param {object} o { retryFailed=true 失败页要不要重试, includeBlank=false 要不要连没字的页也再跑一次,
 *                     includeEmptyPages=false 纯空白页（一个对象都没有）要不要跑, bookIds 限定这几本,
 *                     max 上限, force=[] 强制重跑的页 id（质量清单里点「重跑这些页」用） }
 */
export function planOcrQueue(notebooks, {
  retryFailed = true, includeBlank = false, includeEmptyPages = false, bookIds = null, max = 0, force = null,
} = {}) {
  const wanted = Array.isArray(bookIds) && bookIds.length ? new Set(bookIds) : null;
  const forced = new Set((Array.isArray(force) ? force : []).filter(Boolean));
  const items = [];
  const stats = { books: 0, pages: 0, pending: 0, failed: 0, blank: 0, done: 0, chars: 0, booksWithWork: 0, redo: 0 };
  for (const nb of notebooks || []) {
    if (!nb) continue;
    if (wanted && !wanted.has(nb.id)) continue;
    stats.books++;
    let work = 0;
    (nb.pages || []).forEach((p, i) => {
      const state = pageOcrState(p);
      const isForced = forced.has(p.id);
      if (!isForced) {
        if (state === 'done') { stats.done++; stats.chars += (p.ocr && p.ocr.chars) || 0; return; }
        if (state === 'blank') { stats.blank++; if (!includeBlank) return; }
        if (state === 'failed' && !retryFailed) { stats.failed++; return; }
        if (!includeEmptyPages && !pageHasInk(p)) return;
      }
      if (isForced) stats.redo++;
      else if (state === 'failed') stats.failed++;
      else stats.pending++;
      items.push({
        bookId: nb.id,
        bookTitle: nb.title || '未命名',
        pageId: p.id,
        pageIndex: i,
        pageTitle: p.title || '',
        state: isForced ? 'redo' : state,
      });
      work++;
    });
    if (work) stats.booksWithWork++;
  }
  stats.pages = items.length;
  return { items: max > 0 ? items.slice(0, max) : items, stats };
}

/** 队列总览（资料库用：哪些本还有活、失败几页、跳过几页） */
export function queueStats(notebooks, opts = {}) {
  return planOcrQueue(notebooks, opts).stats;
}

/** 判断错误是否属于「再试也没用」（密钥错 / 余额不足）——遇到这种要立刻停，别把钱和时间烧在必败的请求上 */
export function isFatalOcrError(message) {
  const m = String(message || '');
  return /密钥无效|没有权限|余额不足|401|402|403|30001|invalid.*key/i.test(m);
}

/** 进度文案（队列版） */
export function queueProgressText(done, total, { failed = 0, bookTitle = '' } = {}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `${done}/${total}（${pct}%）${bookTitle ? ` · ${bookTitle}` : ''}${failed ? ` · 失败 ${failed}` : ''}`;
}

/**
 * 跑队列：逐页渲染 → 识别 → 就地写回 store（所以**关掉页面/刷新后能接着跑**，不用额外保存进度）
 *
 * 恢复语义：每页完成就落盘（成功写文字、没字写 blank 标记、失败写原因），
 * 所以「继续」= 重新排一次队（已完成与已标记没字的页自然不会再进来）。
 *
 * @returns {Promise<{done:number, blank:number, failed:number, skipped:number, chars:number, total:number,
 *                    withBoxes:number, stopped:boolean, reason:string, errors:string[]}>}
 *   · done = 处理完成的页数（**含**判定为「这页没文字」的页），blank 是其中没文字的那些
 *   · force = 要强制重跑的页 id 列表（质量清单里点「重跑这些页」用：这些页即使已识别也会再跑一遍）
 */
export async function ocrQueue(store, {
  apiKey, model = OCR_MODELS[0].id, concurrency = 3, retryFailed = true, includeBlank = false,
  includeEmptyPages = false, bookIds = null, max = 0, force = null, renderPage, fetchImpl, onProgress, signal,
  withBoxes = true, fatalStreak = 3, dryRun = false,
} = {}) {
  const all = (typeof store.notebooks === 'function' ? store.notebooks({}) : []).map((b) => store.get(b.id)).filter(Boolean);   // 不含回收站
  const books = bookIds && bookIds.length ? bookIds.map((id) => store.get(id)).filter(Boolean) : all;
  const plan = planOcrQueue(books, { retryFailed, includeBlank, includeEmptyPages, bookIds, max, force });
  const summary = { done: 0, blank: 0, failed: 0, skipped: 0, chars: 0, stopped: false, reason: '', errors: [], total: plan.items.length, withBoxes: 0 };

  // 每本记一条任务记录：界面据此显示「上次跑到哪、失败几页」
  const perBook = new Map();
  for (const it of plan.items) {
    if (!perBook.has(it.bookId)) perBook.set(it.bookId, { total: 0, done: 0, failed: 0, blank: 0 });
    perBook.get(it.bookId).total++;
  }
  const flushJob = (bookId, finished, reason = '') => {
    const j = perBook.get(bookId);
    if (!j) return;
    store.recordOcrJob(bookId, { ...j, model, finished, reason });
  };
  for (const id of perBook.keys()) flushJob(id, false);

  if (!plan.items.length) {
    for (const id of perBook.keys()) flushJob(id, true);
    return summary;
  }

  let streak = 0, fatal = '';
  const before = new Map();
  for (const [id] of perBook) before.set(id, { done: 0, failed: 0, chars: 0 });

  await runPool(plan.items, async (item) => {
    if (fatal) return { skipped: true };
    const nb = store.get(item.bookId);
    const page = nb && nb.pages[item.pageIndex];
    if (!page) return { skipped: true };
    // 别人（或另一次点）已经识别过 → 跳过，不重复花钱；但 item.state === 'redo' 是「明确要求重跑」
    if (pageOcrState(page) === 'done' && item.state !== 'done' && item.state !== 'redo') return { skipped: true };
    const jpeg = pageToJpeg(
      { paper: page.paper || nb.paper, items: page.items },
      { renderPage, scale: ocrRenderScale(paperDims(page.paper || nb.paper)), quality: 0.82 },
    );
    if (dryRun) return { dry: true };
    try {
      const raw = await ocrImageDataUrl(jpeg, { apiKey, model, fetchImpl, prompt: withBoxes ? OCR_BOX_PROMPT : undefined });
      if (withBoxes) {
        const parsed = parseOcrLines(raw);
        if (parsed.lines.length) {
          const text = linesToText(parsed.lines);
          if (!text.trim()) { store.markPageBlank(item.bookId, page.id, { model }); return { blank: true, bookId: item.bookId }; }
          store.setPageOcr(item.bookId, page.id, { text, model, lines: parsed.lines });
          streak = 0;
          return { text, boxes: parsed.lines.filter((l) => l.box).length, bookId: item.bookId };
        }
        const fallback = normalizeOcrText(raw);
        if (!fallback) { store.markPageBlank(item.bookId, page.id, { model }); return { blank: true, bookId: item.bookId }; }
        store.setPageOcr(item.bookId, page.id, { text: fallback, model, lines: [] });
        streak = 0;
        return { text: fallback, boxes: 0, bookId: item.bookId };
      }
      const text = normalizeOcrText(raw);
      if (!text || /^（?本页无文字）?$/.test(text)) { store.markPageBlank(item.bookId, page.id, { model }); return { blank: true, bookId: item.bookId }; }
      store.setPageOcr(item.bookId, page.id, { text, model, lines: [] });
      streak = 0;
      return { text, bookId: item.bookId };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      store.setPageOcrError(item.bookId, page.id, { message: msg, model });
      if (isFatalOcrError(msg)) {
        fatal = msg;                        // 密钥错 / 余额不足：立刻停，剩余的统一记为「跳过的」
        throw new Error(msg);
      }
      if (++streak >= Math.max(1, fatalStreak)) { fatal = `连续 ${streak} 页失败：${msg}`; throw new Error(msg); }
      throw e;
    }
  }, {
    concurrency,
    signal,
    onProgress: (p) => { if (onProgress) { try { onProgress({ ...p, total: plan.items.length }); } catch (e) {} } },
  });

  // 从 store 的真实状态汇总（不靠 worker 的返回值，因为失败/跳过都要算准）
  for (const item of plan.items) {
    const nb = store.get(item.bookId);
    const page = nb && nb.pages[item.pageIndex];
    const j = perBook.get(item.bookId);
    if (!page) continue;
    const state = pageOcrState(page);
    if (state === 'done' || state === 'blank') {
      if (page.ocrError) store.clearPageOcrError(item.bookId, page.id);
      summary.done++;
      summary.chars += (page.ocr && page.ocr.chars) || 0;
      summary.withBoxes += (page.ocr && page.ocr.boxes) || 0;
      if (page.ocr && page.ocr.blank) { summary.blank++; if (j) j.blank++; }
      if (j) j.done++;
    } else if (state === 'failed') {
      summary.failed++;
      if (summary.errors.length < 5) summary.errors.push((page.ocrError && page.ocrError.message) || '识别失败');
      if (j) j.failed++;
    } else {
      summary.skipped++;
    }
  }
  if (fatal) { summary.stopped = true; summary.reason = fatal; }
  for (const [id] of perBook) flushJob(id, !fatal, fatal);
  return summary;
}

/** 还有活要干的队列（资料库「继续识别」入口用）：已入队 + 还有待识别/失败的页 */
export function resumeQueue(notebooks, opts = {}) {
  const queued = (notebooks || []).filter((nb) => nb && nb.ocrQueued);
  const plan = planOcrQueue(queued, { ...opts, retryFailed: opts.retryFailed !== false });
  return { items: plan.items, stats: plan.stats, books: [...new Set(plan.items.map((i) => i.bookId))] };
}

