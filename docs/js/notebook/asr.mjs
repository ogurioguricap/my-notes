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
