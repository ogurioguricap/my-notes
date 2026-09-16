/**
 * 站内检索：标题 / 正文 / 标签 / 分类 / 附件文字（图片 OCR、PDF 文本）
 * 纯前端、零依赖；对中文用「字符级子串」匹配，对英文用「词前缀」匹配，
 * 保证「实时输入即时出结果」，无需分词词典。
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ');
}

/** 把查询拆成若干「必须同时满足」的项；引号内视为整体 */
export function tokenize(q) {
  const out = [];
  const src = String(q || '').trim();
  if (!src) return out;
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(src))) out.push((m[1] || m[2]).trim());
  return out.filter(Boolean);
}

export function buildIndex(payload) {
  const notes = payload.notes || [];
  const docs = notes.map((n) => {
    const attParts = (n.attachments || []).map((f) => `${f}`);
    return {
      slug: n.slug,
      title: n.title,
      date: n.date,
      category: n.category,
      tags: n.tags || [],
      excerpt: n.excerpt || '',
      pinned: !!n.pinned,
      nTitle: normalizeText(n.title),
      nText: normalizeText(n.search || ''),
      nTags: normalizeText((n.tags || []).join(' ')),
      nCat: normalizeText(n.category || ''),
      words: [],
    };
  });
  for (const d of docs) d.words = splitIndexWords(d.nText);
  return { docs, categories: payload.categories || [], tags: payload.tags || {}, stats: payload.stats || {} };
}

function splitIndexWords(text) {
  // 供英文词前缀匹配使用（限制数量，避免长文本爆内存）
  const words = new Set();
  const re = /[a-z0-9_+#.-]{2,}/g;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 6000) words.add(m[0]);
  return [...words];
}

/** 单条打分：0 表示不匹配 */
function scoreDoc(doc, terms) {
  let total = 0;
  const detail = [];
  for (const raw of terms) {
    const t = normalizeText(raw);
    if (!t) continue;
    let s = 0;
    const isCjk = CJK.test(t);
    const isShortCjk = isCjk && t.length <= 2;

    if (doc.nTitle.includes(t)) s += 60 + (doc.nTitle.startsWith(t) ? 25 : 0);
    if (doc.nTags.includes(t)) s += 34;
    if (doc.nCat.includes(t)) s += 24;

    const occurrences = countOccurrences(doc.nText, t);
    if (occurrences > 0) s += Math.min(28, 10 + Math.log2(occurrences + 1) * 5);
    else if (!isCjk) {
      const hit = doc.words.some((w) => w.startsWith(t) || (t.length >= 4 && w.includes(t)));
      if (hit) s += 6;
    }
    if (s === 0) return { score: 0 };
    // 单字查询容易误命中，降权
    if (isShortCjk) s *= 0.55;
    total += s;
    detail.push({ term: raw, score: s });
  }
  if (doc.pinned) total *= 1.08;
  return { score: total, detail };
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1 && n < 400) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function isAttachmentHit(term, labels) {
  const t = normalizeText(term);
  return labels.some((l) => l.includes(t));
}

/**
 * @param {object} index buildIndex 的产物
 * @param {string} query 查询串
 * @param {object} opts { category, limit }
 * @returns {{slug,title,score,snippet,where}[]}
 */
export function search(index, query, opts = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const { category = '', limit = 40 } = opts;
  const results = [];

  for (const doc of index.docs) {
    if (category && doc.category !== category) continue;
    const { score } = scoreDoc(doc, terms);
    if (score <= 0) continue;
    results.push({
      slug: doc.slug,
      title: doc.title,
      date: doc.date,
      category: doc.category,
      tags: doc.tags,
      score,
      snippet: makeSnippet(doc, terms),
    });
  }
  results.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  return results.slice(0, limit);
}

function makeSnippet(doc, terms) {
  const source = doc.nText;
  const labels = doc.__attachLabels || [];
  let pos = -1;
  let matched = '';
  for (const raw of terms) {
    const t = normalizeText(raw);
    const p = source.indexOf(t);
    if (p !== -1 && (pos === -1 || p < pos)) {
      pos = p;
      matched = t;
    }
  }
  if (pos === -1) return hlMark(doc.excerpt || '', terms);
  const start = Math.max(0, pos - 60);
  const end = Math.min(source.length, pos + 160);
  let s = (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '');
  return hlMark(s, terms);
}

export function hlMark(text, terms) {
  let out = escSearch(text);
  const sorted = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    const safe = escSearch(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!safe) continue;
    const re = new RegExp(safe, CJK.test(t) ? 'g' : 'gi');
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

export function escSearch(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
