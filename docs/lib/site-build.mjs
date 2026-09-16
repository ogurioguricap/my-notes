/**
 * 站点数据构建内核（同构：构建脚本与浏览器共用）
 * 浏览器侧用于「在线编辑后立刻重建 index.json」，保证不依赖本地构建。
 */
import { renderDocument, parseFrontmatter } from './markdown.mjs';

const COVER_PALETTE = [
  { ink: '#EA5A47', soft: '#FDEBE7' },
  { ink: '#4C7DF0', soft: '#E9EFFE' },
  { ink: '#0E9F8C', soft: '#E3F6F3' },
  { ink: '#E0913A', soft: '#FBF0E0' },
  { ink: '#8B5CF6', soft: '#F1EBFE' },
  { ink: '#D94F8A', soft: '#FCE9F1' },
  { ink: '#3D8A5F', soft: '#E7F3EC' },
  { ink: '#5A6B8C', soft: '#ECF0F6' },
];

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function coverGlyph(title) {
  const t = String(title).replace(/[\s·—\-_｜|]+/g, '');
  const latin = /[A-Za-z0-9]/.exec(t);
  if (latin && latin.index <= 1) return t.slice(0, 2).toUpperCase();
  return t.slice(0, 1) || '笔';
}

/**
 * 由「原文 + 已有笔记」构造一条笔记记录（与 tools/build.mjs 的产出结构一致）
 */
export function buildNoteRecord({ raw, slug, source, date, attachments = [], resolve = (h) => h }) {
  const { data } = parseFrontmatter(raw);
  const rendered = renderDocument(raw, resolve);
  const title = data.title || (rendered.headings[0] && rendered.headings[0].text) || slug;
  const tags = Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [];
  const search = [title, rendered.excerpt, tags.join(' '), data.category || '', (rendered.codeText || '')]
    .join(' \u0001 ')
    .replace(/\s+/g, ' ')
    .slice(0, 60000);
  return {
    slug,
    title,
    date: (data.date || date || new Date().toISOString().slice(0, 10)).toString().slice(0, 10),
    category: data.category || '未分类',
    tags,
    related: Array.isArray(data.related) ? data.related : data.related ? [data.related] : [],
    links: rendered.links,
    pinned: data.pinned === true || data.pinned === 'true',
    status: data.status || '',
    source,
    summary: data.summary || '',
    excerpt: data.summary || rendered.excerpt,
    html: rendered.html.length > 200000 ? rendered.html.slice(0, 200000) : rendered.html,
    headings: rendered.headings,
    raw: rendered.body,
    rawFull: raw,
    search,
    attachments,
  };
}

/**
 * 把一条编辑结果应用到整个 payload（新增或更新），并重算排序 / 反链 / 分类 / 标签 / 统计
 * @param {object} payload 现有 docs/data/index.json 的内容
 * @param {{ source:string, slug:string, raw:string, attachments?:string[], resolve?:Function }} edit
 * @returns {object} 新的 payload（可直接 JSON.stringify 提交）
 */
export function applyEdit(payload, edit) {
  const notes = (payload.notes || []).map((n) => ({ ...n }));
  const rec = buildNoteRecord({
    raw: edit.raw,
    slug: edit.slug,
    source: edit.source,
    date: edit.date,
    attachments: edit.attachments || [],
    resolve: edit.resolve,
  });

  const i = notes.findIndex((n) => n.source === rec.source || n.slug === rec.slug);
  if (i >= 0) notes[i] = { ...notes[i], ...rec };
  else notes.push(rec);

  return finalizePayload(payload, notes);
}

/** 删除一条并重算 */
export function removeEdit(payload, source) {
  const notes = (payload.notes || []).filter((n) => n.source !== source).map((n) => ({ ...n }));
  return finalizePayload(payload, notes);
}

/** 重算排序、封面、反链、分类、标签、统计 */
export function finalizePayload(payload, notesIn) {
  const notes = notesIn.map((n) => ({ ...n }));
  notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : String(a.title).localeCompare(String(b.title), 'zh')));

  const catOrder = [...new Set(notes.map((n) => n.category))].sort(
    (a, b) =>
      notes.filter((n) => n.category === b).length - notes.filter((n) => n.category === a).length ||
      String(a).localeCompare(String(b), 'zh')
  );
  for (const n of notes) {
    const base = COVER_PALETTE[Math.max(0, catOrder.indexOf(n.category)) % COVER_PALETTE.length];
    n.cover = { ink: base.ink, soft: base.soft, glyph: coverGlyph(n.title) };
  }

  // 反向链接
  const byTitle = new Map();
  for (const n of notes) {
    byTitle.set(n.slug.toLowerCase(), n.slug);
    byTitle.set(String(n.title).toLowerCase(), n.slug);
  }
  for (const n of notes) {
    n.backlinks = [];
    n.missingLinks = [];
    n.resolvedLinks = (n.links || [])
      .map((l) => {
        const key = String(l).toLowerCase().replace(/\.md$/, '');
        const target = byTitle.get(key);
        if (target) return target;
        n.missingLinks.push(l);
        return null;
      })
      .filter(Boolean);
  }
  for (const n of notes) {
    for (const t of n.resolvedLinks) {
      const target = notes.find((x) => x.slug === t);
      if (target && !target.backlinks.includes(n.slug)) target.backlinks.push(n.slug);
    }
  }

  const tagCount = {};
  for (const n of notes) for (const t of n.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      notes: notes.length,
      words: notes.reduce((s, n) => s + (n.search ? n.search.length : 0), 0),
      tags: Object.keys(tagCount).length,
      categories: new Set(notes.map((n) => n.category)).size,
      assets: (payload.stats && payload.stats.assets) || 0,
      extracted: (payload.stats && payload.stats.extracted) || 0,
    },
    categories: [...new Set(notes.map((n) => n.category))],
    tags: tagCount,
    notes,
  };
}
