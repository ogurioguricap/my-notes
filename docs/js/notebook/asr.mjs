/**
 * GoodNotes 模式 · 录音转文字（ASR）
 *
 * 站点里「录音与手写时间点同步」已经能把录音挂到页面/笔迹上，这里再补最后一步：
 * 把录音交给语音模型转成文字，写回录音记录 → 之后**笔记内搜索 / 资料库搜索 / 首页搜索**都能搜到录的内容。
 * （对照文档里这一条原本是 ❌「无语音模型」，现在用外部 API 补上，边界：需要自备 Key、音频会上传第三方。）
 *
 * 接口与 OCR 同一家：SiliconFlow 的 OpenAI 兼容端点 /v1/audio/transcriptions（multipart 上传）。
 * 纯逻辑（表单构造、响应解析、错误提示）全部导出，便于无浏览器环境测试。
 */

export const ASR_ENDPOINT = 'https://api.siliconflow.cn/v1/audio/transcriptions';
export const ASR_MODELS = [
  { id: 'FunAudioLLM/SenseVoiceSmall', label: 'SenseVoice（快）', hint: '多语种、速度快，适合课堂录音' },
  { id: 'TeleAI/TeleSpeechASR', label: 'TeleSpeech（中文）', hint: '中文场景更稳' },
];
export const ASR_KEY_STORAGE = 'note-asr-key';
export const MAX_ASR_SECONDS = 600;

/** 表单构造（真机与测试都走这里；FormDataImpl 可注入） */
export function buildAsrForm(blob, { model = ASR_MODELS[0].id, language = 'zh', filename = 'audio.webm', FormDataImpl } = {}) {
  const FD = FormDataImpl || (typeof FormData === 'function' ? FormData : null);
  if (!FD) return null;
  const form = new FD();
  try {
    form.append('file', blob, filename);
    form.append('model', model);
    if (language) form.append('language', language);
  } catch (e) {
    try { form.append('file', blob); form.append('model', model); } catch (e2) { return null; }
  }
  return form;
}

/** 响应解析：兼容 {text} / {result} / {results:[…]} 几种写法 */
export function parseAsrResponse(json) {
  if (!json) throw new Error('转写服务没有返回内容');
  if (json.error) throw new Error(String((json.error && (json.error.message || json.error.code)) || '转写失败'));
  const pick = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.transcript)) || '')).join('\n') : '');
  // 完全认不出的结构要报错；「认得出但就是空的」（比如录音里没说话）返回空串，交给调用方提示
  const known = ['text', 'result', 'results', 'data', 'segments'].some((k) => k in json);
  if (!known) throw new Error('转写服务没有返回可用的文字字段');
  const text = pick(json.text) || pick(json.result) || pick(json.results) || pick(json.data) || (json.segments ? pick(json.segments) : '');
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}

/** 错误提示（与 OCR 同一套人话口径） */
export function asrErrorHint(status, json) {
  const s = Number(status) || 0;
  const msg = (json && json.error && (json.error.message || json.error.code)) || (json && json.message) || '';
  if (s === 401 || s === 403) return '密钥无效或没有权限：去 cloud.siliconflow.cn 复制一个新的 API Key';
  if (s === 402 || /30001|balance|insufficient/i.test(String(msg))) return '账户余额不足：先去 SiliconFlow 充值再试';
  if (s === 413) return '录音太大（413）：拆成几段再转，或先压缩';
  if (s === 429) return '请求太频繁（429）：等一分钟再试';
  if (s >= 500) return `转写服务暂时故障（${s}）：稍后重试`;
  return `转写失败${s ? `（${s}）` : ''}：${String(msg).slice(0, 160) || '未知原因'}`;
}

/** 录音转文字 */
export async function transcribeAudio(blob, {
  apiKey, model = ASR_MODELS[0].id, language = 'zh', filename = 'audio.webm',
  fetchImpl, timeoutMs = 180000, FormDataImpl,
} = {}) {
  if (!blob) throw new Error('没有可转写的录音');
  if (!apiKey) throw new Error('还没填 API Key：去 cloud.siliconflow.cn 申请一个（和 OCR 共用同一个也行）');
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('当前环境不能发网络请求');
  const form = buildAsrForm(blob, { model, language, filename, FormDataImpl });
  if (!form) throw new Error('当前环境不支持 multipart 上传');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
  try {
    const res = await f(ASR_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },   // Content-Type 交给浏览器带 boundary
      body: form,
      signal: ctrl ? ctrl.signal : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) throw new Error(asrErrorHint(res.status, json));
    return parseAsrResponse(json);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`转写超时（>${Math.round(timeoutMs / 1000)} 秒）：录音太长时先拆段`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ============================ 分段与「每句挂到当时那一页」 ============================ */

/**
 * 把转写结果切成句段
 *   · 接口给了 segments（带 start/end）就直接用（exact=true）
 *   · 没给就按句/行切，再按录音时长**等分**（exact=false，界面上会说明是近似）
 */
export function parseAsrSegments(json, { duration = 0, text = '' } = {}) {
  const dur = Math.max(0, Number(duration) || 0);
  const raw = Array.isArray(json && json.segments) ? json.segments : [];
  const exact = [];
  for (const s of raw) {
    const t = String((s && (s.text || s.transcript)) || '').trim();
    if (!t) continue;
    const start = Math.max(0, Number(s.start) || 0);
    const end = Number(s.end) > start ? Number(s.end) : start + 1;
    exact.push({ start, end, text: t, exact: true });
  }
  if (exact.length) return exact;
  const body = String(text || (json && json.text) || '');
  const lines = body.split(/\n+/).flatMap((l) => l.split(/(?<=[。！？!?；;])/)).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return [];
  if (!(dur > 0)) return lines.map((t, i) => ({ start: i, end: i + 1, text: t, exact: false }));
  const step = dur / lines.length;
  return lines.map((t, i) => ({ start: Number((i * step).toFixed(2)), end: Number(((i + 1) * step).toFixed(2)), text: t, exact: false }));
}

/**
 * 给每句挂上「说这句时正在写的那一页 / 第几个对象」
 * 复用 store.audioAnchor 的锚定模型（录音时记下的 pageId + itemCount）
 */
export function anchorSegments(store, bookId, audioId, segments, { duration = 0 } = {}) {
  const nb = store && typeof store.get === 'function' ? store.get(bookId) : null;
  const rec = ((nb && nb.audio) || []).find((a) => a.id === audioId);
  const maxEnd = (segments || []).reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
  const dur = Math.max(1e-6, Number(duration) || Number(rec && rec.duration) || maxEnd || 1);
  return (segments || []).map((s) => {
    const mid = ((Number(s.start) || 0) + (Number(s.end) || 0)) / 2;
    const ratio = Math.min(1, Math.max(0, mid / dur));
    const anchor = store && typeof store.audioAnchor === 'function' ? store.audioAnchor(bookId, audioId, ratio) : null;
    return {
      ...s,
      ratio,
      pageId: (anchor && anchor.pageId) || '',
      pageIndex: anchor ? anchor.pageIndex : 0,
      itemIndex: anchor ? anchor.itemsAtThatMoment : 0,
    };
  });
}

/** 播放到某个时刻，当前是哪一句 */
export function segmentAtTime(segments, time) {
  const t = Number(time) || 0;
  const list = segments || [];
  for (let i = 0; i < list.length; i++) {
    if (t >= Number(list[i].start) && t < Number(list[i].end)) return { index: i, segment: list[i] };
  }
  return list.length ? { index: list.length - 1, segment: list[list.length - 1] } : null;
}

/** 转写并把分段一起返回（界面上要显示「每句对应哪一页」时用它） */
export async function transcribeAudioFull(blob, opts = {}) {
  const { duration = 0, ...rest } = opts;
  const f = rest.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  // 直接复用 transcribeAudio 的请求与错误处理，只是要把原始响应留下来切段
  const form = buildAsrForm(blob, { model: rest.model, language: rest.language, filename: rest.filename, FormDataImpl: rest.FormDataImpl });
  if (!form) throw new Error('当前环境不支持 multipart 上传');
  if (!rest.apiKey) throw new Error('还没填 API Key：去 cloud.siliconflow.cn 申请一个（和 OCR 共用同一个也行）');
  if (!f) throw new Error('当前环境不能发网络请求');
  const res = await f(ASR_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${rest.apiKey}` }, body: form });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (!res.ok) throw new Error(asrErrorHint(res.status, json));
  const text = parseAsrResponse(json);
  const segments = parseAsrSegments(json, { duration, text });
  return { text, segments, exact: segments.some((s) => s.exact) };
}

/** 录音键：与 OCR 分开存，但接口一样（填一次即可） */
export function getAsrKey(storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try { return (s && s.getItem(ASR_KEY_STORAGE)) || ''; } catch (e) { return ''; }
}

export function setAsrKey(storage, key) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    if (!s) return false;
    const v = String(key || '').trim();
    if (v) s.setItem(ASR_KEY_STORAGE, v); else s.removeItem(ASR_KEY_STORAGE);
    return true;
  } catch (e) { return false; }
}
