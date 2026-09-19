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
  renderPage, fetchImpl, onProgress, signal, dryRun = false,
} = {}) {
  const nb = store.get(bookId);
  if (!nb) return { done: 0, failed: 0, skipped: 0, chars: 0, errors: ['找不到这本笔记本'] };
  const targets = Array.isArray(indices) ? indices : pickPagesToOcr(nb, { onlyMissing });
  const summary = { done: 0, failed: 0, skipped: nb.pages.length - targets.length, chars: 0, errors: [] };
  if (!targets.length) return summary;
  const scaleFor = (page) => ocrRenderScale(paperDims(page.paper || nb.paper));

  const { results } = await runPool(targets, async (idx) => {
    const page = store.get(bookId).pages[idx];
    const jpeg = pageToJpeg({ paper: page.paper || nb.paper, items: page.items }, { renderPage, scale: scaleFor(page), quality: 0.82 });
    if (dryRun) return { idx, text: '', dry: true };
    const text = await ocrImageDataUrl(jpeg, { apiKey, model, fetchImpl });
    if (!text || /^（?本页无文字）?$/.test(text.trim())) return { idx, text: '', empty: true };
    store.setPageOcr(bookId, page.id, { text, model });
    return { idx, text };
  }, { concurrency, onProgress, signal });

  results.forEach((r) => {
    if (!r) return;
    if (!r.ok) { summary.failed++; if (summary.errors.length < 5) summary.errors.push(r.error); return; }
    summary.done++;
    summary.chars += (r.value && r.value.text ? r.value.text.length : 0);
  });
  return summary;
}

/** 单页识别（界面上「识别这一页」用） */
export async function ocrOnePage(store, bookId, pageIndex, opts = {}) {
  return ocrNotebook(store, bookId, { ...opts, indices: [pageIndex], onlyMissing: false });
}
