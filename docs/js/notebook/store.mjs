/**
 * GoodNotes 模式 · 数据层（笔记本 / 文件夹 / 页面 / 学习集 / 录音 / 备份）
 *
 * 设计要点：
 * 1. 不依赖 DOM 与浏览器全局：存储介质可注入（localStorage / 内存 / 测试桩），因此可以在 Node 里直接测
 * 2. 一座资料库 = 一份 JSON：{ version, folders, notebooks[], settings }
 *    · 笔记本里放「页面」，页面里放「对象」（笔迹 / 形状 / 文本 / 图片 / 贴纸 / 胶带）
 *    · 对象格式沿用标注层的 v2 规范（见 docs/js/ink.mjs），所以同一套渲染与编辑引擎能复用
 * 3. 删除是「移入垃圾桶」（可恢复），彻底删除要显式调用 purge —— 对齐手账 App 的习惯
 * 4. 录音的音频体积大，单独放 IndexedDB（拿不到 IndexedDB 时退化成内存表，不阻断其它功能）
 *
 * 与 GoodNotes 的对应关系（详见仓库根目录《文档-GoodNotes-功能对照与复现.md》）：
 *   资料库 / 文件夹 / 封面 / 模板 / 多选 / 垃圾桶 / 收藏  → 本文件 + library.mjs
 *   多页笔记本 / 页面管理 / 书签大纲                      → 本文件 + viewer.mjs
 *   学习集（闪卡 + 间隔重复）                              → 本文件 study 段 + study.mjs
 *   录音并与笔记时间点同步                                 → 本文件 audio 段 + study.mjs
 *   备份 / 导出 / 导入                                    → 本文件 export/import
 */

export const SCHEMA_VERSION = 3;
export const DEFAULT_STORAGE_KEY = 'note-books-v1';
export const TRASH_RETENTION_DAYS = 30;

/** 关键词在文本里出现了几次（大小写不敏感；用于「命中 N 处」） */
export function countHits(text, needle) {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return 0;
  const hay = String(text || '').toLowerCase();
  let n = 0, at = 0;
  for (;;) {
    const i = hay.indexOf(q, at);
    if (i < 0) break;
    n++;
    at = i + q.length;
  }
  return n;
}

/**
 * 取「命中位置前后一小段」当摘要（首页搜索里笔记本结果用）
 * @returns {{excerpt:string, hits:number, at:number}}
 */
export function excerptAround(text, needle, { radius = 70, max = 220 } = {}) {
  const src = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const hits = countHits(src, needle);
  if (!src) return { excerpt: '', hits: 0, at: -1 };
  const q = String(needle || '').trim();
  const i = q ? src.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return { excerpt: src.slice(0, max), hits: 0, at: -1 };
  const start = Math.max(0, i - radius);
  const end = Math.min(src.length, i + q.length + radius);
  const head = start > 0 ? '…' : '';
  const tail = end < src.length ? '…' : '';
  return { excerpt: `${head}${src.slice(start, end)}${tail}`.slice(0, max + 2), hits, at: i };
}

/* ============================ 小工具 ============================ */

let seq = 0;
export function nid(prefix = 'id') {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

const now = () => Date.now();

function clone(v) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch (e) { /* 含不可克隆对象 → 退回 JSON */ }
  }
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}

function asInt(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : d;
}

/** 卡片标签：允许 "a,b" 字符串或数组；去重、去空、最多 8 个 */
export function parseCardTags(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，、;；]/);
  const out = [];
  for (const it of list) {
    const t = String(it || '').trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** 内存存储（Node 测试 / 无 localStorage 环境） */
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
}

/* ============================ 默认值 ============================ */

export const DEFAULT_PAPER = {
  template: 'lined',        // 见 paper.mjs 的 PAPER_TEMPLATES
  size: 'a4',               // 见 paper.mjs 的 PAPER_SIZES
  width: 0, height: 0,      // size === 'custom' 时生效（CSS 像素）
  color: '#FFFFFF',         // 纸张颜色
  lineColor: '',            // 留空 = 按模板自动配色
};

export function makePage(patch = {}) {
  return {
    id: patch.id || nid('pg'),
    paper: null,                 // null = 跟随笔记本纸张
    items: Array.isArray(patch.items) ? patch.items : [],
    bookmarked: !!patch.bookmarked,
    title: patch.title || '',
    createdAt: patch.createdAt || now(),
  };
}

export function makeNotebook(patch = {}) {
  const t = now();
  const nb = {
    id: patch.id || nid('bk'),
    title: patch.title || '未命名笔记本',
    cover: {
      color: (patch.cover && patch.cover.color) || '#E8452F',
      pattern: (patch.cover && patch.cover.pattern) || 'plain',
      glyph: patch.cover && patch.cover.glyph ? patch.cover.glyph : String(patch.title || '笔').trim().slice(0, 1) || '笔',
      image: (patch.cover && patch.cover.image) || '',   // 自定义封面图（data URL，可选）
    },
    folder: patch.folder || null,
    tags: Array.isArray(patch.tags) ? patch.tags : [],
    fav: !!patch.fav,
    paper: { ...DEFAULT_PAPER, ...(patch.paper || {}) },
    scroll: patch.scroll === 'horizontal' ? 'horizontal' : 'vertical',
    createdAt: patch.createdAt || t,
    updatedAt: patch.updatedAt || t,
    openedAt: patch.openedAt || 0,
    trashedAt: patch.trashedAt || null,
    pages: Array.isArray(patch.pages) && patch.pages.length ? patch.pages.map(makePage) : [makePage()],
    audio: Array.isArray(patch.audio) ? patch.audio : [],
    study: Array.isArray(patch.study) ? patch.study.map(normalizeCard) : [],
    version: SCHEMA_VERSION,
  };
  return nb;
}

/* ---------- 复习热图的数据（按天记账，只留最近一段时间） ---------- */

export const REVIEW_LOG_DAYS = 400;

/** 当天 key（本地时区，和用户看的日历一致） */
export function dayKey(ts = Date.now()) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 旧数据兜底：只认合法形状，坏数据当空 */
export function parseReviewLog(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const o = v && typeof v === 'object' ? v : {};
    out[k] = { n: asInt(o.n, 0), ok: asInt(o.ok, 0), bad: asInt(o.bad, 0) };
  }
  return out;
}

/**
 * 卡片的来源页（纯函数，界面与队列共用同一套解析）
 * @returns {{ pageId:string, pageIndex:number, pageTitle:string, ok:boolean }}
 *   · pageIndex = -1 表示来源页已经不在了（页被删过）；ok 同义
 */
export function cardSourceOf(notebook, card) {
  const pageId = (card && card.pageId) || '';
  const pages = (notebook && notebook.pages) || [];
  if (!pageId) return { pageId: '', pageIndex: -1, pageTitle: '', ok: false };
  const idx = pages.findIndex((p) => p && p.id === pageId);
  if (idx < 0) return { pageId, pageIndex: -1, pageTitle: '', ok: false };
  return { pageId, pageIndex: idx, pageTitle: (pages[idx].title || '').trim(), ok: true };
}

/**
 * 全库「来源有问题的卡片」报告（纯函数）
 *   no-source    —— 从没记来源
 *   page-missing —— 记了来源但那页已经不在（页被删过 / 从别处导入）
 * @returns {{ items:Array, stats:{ total, noSource, pageMissing, books } }}
 */
export function orphanCardReport(notebooks) {
  const items = [];
  for (const nb of notebooks || []) {
    if (!nb) continue;
    const pageIds = new Set((nb.pages || []).map((p) => p.id));
    for (const c of nb.study || []) {
      const pageId = (c && c.pageId) || '';
      const missing = !!pageId && !pageIds.has(pageId);
      if (pageId && !missing) continue;
      items.push({
        bookId: nb.id,
        bookTitle: nb.title || '未命名',
        cardId: c.id,
        front: String(c.front || ''),
        back: String(c.back || ''),
        tags: c.tags || [],
        box: c.box || 0,
        pageId,
        reason: missing ? 'page-missing' : 'no-source',
      });
    }
  }
  return {
    items,
    stats: {
      total: items.length,
      noSource: items.filter((i) => i.reason === 'no-source').length,
      pageMissing: items.filter((i) => i.reason === 'page-missing').length,
      books: new Set(items.map((i) => i.bookId)).size,
    },
  };
}

/** 闪卡统一形状（老数据没有 tags / lapses 时补齐） */export function normalizeCard(c = {}) {
  return {
    id: c.id || nid('cd'),
    front: String(c.front || ''),
    back: String(c.back || ''),
    tags: Array.isArray(c.tags) ? c.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    box: asInt(c.box, 0),
    due: asInt(c.due, Date.now()),
    lapses: asInt(c.lapses, 0),
    reviews: asInt(c.reviews, 0),
    pageId: c.pageId || '',
    createdAt: asInt(c.createdAt, Date.now()),
    last: asInt(c.last, 0) || undefined,
  };
}

function emptyLibrary() {
  return {
    version: SCHEMA_VERSION,
    folders: [],
    notebooks: [],
    templates: [],
    settings: { sort: 'updated', view: 'grid' },
    reviewLog: {},       // 复习热图：{ 'YYYY-MM-DD': { n, ok, bad } }
  };
}

/** 内置模板：新建笔记本时可以直接套用（对齐 GoodNotes 的「可导入模板本」） */
export const BUILTIN_TEMPLATES = [
  {
    id: 'builtin-cornell',
    name: '康奈尔课堂笔记',
    builtin: true,
    cover: { color: '#2F6FE8', pattern: 'plain' },
    paper: { template: 'cornell', size: 'a4', color: '#FFFFFF' },
    pages: [{ paper: null }, { paper: null }, { paper: { template: 'cornell', size: 'a4', color: '#FFFFFF' } }],
  },
  {
    id: 'builtin-week',
    name: '周计划',
    builtin: true,
    cover: { color: '#12A05C', pattern: 'gradient' },
    paper: { template: 'week', size: 'a4l', color: '#FFFFFF' },
    pages: [{ paper: null }, { paper: { template: 'habit', size: 'a4l', color: '#FFFFFF' } }],
  },
  {
    id: 'builtin-mistake',
    name: '错题本',
    builtin: true,
    cover: { color: '#E8452F', pattern: 'stripes' },
    paper: { template: 'grid', size: 'a4', color: '#FBF7EF' },
    pages: [{ paper: null }, { paper: null }, { paper: null }],
  },
  {
    id: 'builtin-reading',
    name: '读书笔记',
    builtin: true,
    cover: { color: '#8B5CF6', pattern: 'kraft' },
    paper: { template: 'lined', size: 'a4', color: '#FBF7EF' },
    pages: [{ paper: null }, { paper: { template: 'cornell', size: 'a4', color: '#FBF7EF' } }],
  },
];

/* ============================ 主类 ============================ */

export class NotebookStore {
  constructor({ storage, storageKey = DEFAULT_STORAGE_KEY } = {}) {
    this.storageKey = storageKey;
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
    this.data = emptyLibrary();
    this.audio = new Map();      // 音频内存兜底（IndexedDB 不可用时）
    this._idb = null;
    this.load();
  }

  /* ---------- 读写 ---------- */

  load() {
    let raw = null;
    try { raw = this.storage.getItem(this.storageKey); } catch (e) { raw = null; }
    if (!raw) { this.data = emptyLibrary(); return this.data; }
    try {
      const j = JSON.parse(raw);
      this.data = this.migrate(j);
    } catch (e) {
      // 坏数据不炸站：保留原文另存一份，避免用户一刷新就全丢
      try { this.storage.setItem(`${this.storageKey}-broken`, raw); } catch (e2) {}
      this.data = emptyLibrary();
    }
    return this.data;
  }

  /** 旧版本 / 半成品数据补齐字段 */
  migrate(j) {
    const out = emptyLibrary();
    if (!j || typeof j !== 'object') return out;
    out.folders = (Array.isArray(j.folders) ? j.folders : []).map((f) => ({
      id: f.id || nid('fld'),
      name: String(f.name || '文件夹'),
      color: f.color || '#5A6B8C',
      createdAt: asInt(f.createdAt, now()),
    }));
    const folderIds = new Set(out.folders.map((f) => f.id));
    out.notebooks = (Array.isArray(j.notebooks) ? j.notebooks : []).map((n) => {
      const nb = makeNotebook(n);
      if (nb.folder && !folderIds.has(nb.folder)) nb.folder = null;
      nb.pages = (Array.isArray(n.pages) ? n.pages : []).map((p) => makePage(p));
      if (!nb.pages.length) nb.pages = [makePage()];
      nb.pages.forEach((p) => { p.items = Array.isArray(p.items) ? p.items : []; });
      return nb;
    });
    out.settings = { sort: (j.settings && j.settings.sort) || 'updated', view: (j.settings && j.settings.view) || 'grid' };
    out.reviewLog = parseReviewLog(j.reviewLog);
    out.templates = (Array.isArray(j.templates) ? j.templates : []).map((t) => ({
      id: t.id || nid('tpl'),
      name: String(t.name || '模板'),
      builtin: false,
      cover: t.cover && typeof t.cover === 'object' ? { ...t.cover } : null,
      paper: t.paper && typeof t.paper === 'object' ? { ...t.paper } : { ...DEFAULT_PAPER },
      scroll: t.scroll === 'horizontal' ? 'horizontal' : 'vertical',
      withContent: !!t.withContent,
      createdAt: asInt(t.createdAt, now()),
      pages: (Array.isArray(t.pages) ? t.pages : []).map((p) => ({
        paper: p && p.paper ? { ...p.paper } : null,
        items: Array.isArray(p && p.items) ? p.items : [],
      })),
    }));
    return out;
  }

  save() {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.data));
      return true;
    } catch (e) {
      // 配额爆了：把错误抛给界面去提示用户导出备份
      const err = new Error('保存失败：浏览器存储空间不足，请先「导出备份」再删掉一些笔记本');
      err.cause = e;
      throw err;
    }
  }

  bytes() {
    try { return (this.storage.getItem(this.storageKey) || '').length; } catch (e) { return 0; }
  }

  /* ---------- 资料库查询 ---------- */

  notebooks({ folder, trash = false, fav = false, q = '', sort = (this.data.settings && this.data.settings.sort) || 'updated', tags = [] } = {}) {
    let list = this.data.notebooks.slice();
    list = list.filter((n) => (trash ? !!n.trashedAt : !n.trashedAt));
    if (fav) list = list.filter((n) => n.fav);
    if (folder) list = list.filter((n) => n.folder === folder);
    if (tags.length) list = list.filter((n) => tags.every((t) => (n.tags || []).includes(t)));
    if (q) {
      const needle = String(q).trim().toLowerCase();
      list = list.filter((n) => {
        const hay = [n.title, (n.tags || []).join(' '), this.snippetOf(n)].join(' ').toLowerCase();
        return hay.includes(needle);
      });
    }
    const cmp = {
      updated: (a, b) => (b.openedAt || b.updatedAt) - (a.openedAt || a.updatedAt),
      created: (a, b) => b.createdAt - a.createdAt,
      title: (a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'),
      pages: (a, b) => b.pages.length - a.pages.length,
    }[sort] || ((a, b) => b.updatedAt - a.updatedAt);
    list.sort((a, b) => (a.fav === b.fav ? 0 : a.fav ? -1 : 1) || cmp(a, b));
    return list;
  }

  /** 笔记本的文字摘要（文本对象 + 已识别的 OCR 手写 + 录音转写），供搜索与卡片副标题用 */
  snippetOf(nb) {
    const bits = [];
    for (const p of nb.pages || []) {
      for (const it of p.items || []) {
        if (it && it.kind === 'text' && it.text) bits.push(it.text);
      }
      if (p.ocr && p.ocr.text) bits.push(p.ocr.text.slice(0, 600));   // 手写识别结果也进搜索
      if (bits.length > 40) break;
    }
    for (const a of nb.audio || []) {
      if (a && a.text) bits.push(a.text.slice(0, 600));               // 录音转写也进搜索
      if (bits.length > 60) break;
    }
    return bits.join(' ').slice(0, 1200);
  }

  stats() {
    const live = this.data.notebooks.filter((n) => !n.trashedAt);
    const pages = live.reduce((s, n) => s + n.pages.length, 0);
    const items = live.reduce((s, n) => s + n.pages.reduce((t, p) => t + (p.items ? p.items.length : 0), 0), 0);
    const strokes = live.reduce((s, n) => s + n.pages.reduce((t, p) => t + (p.items || []).filter((i) => i && i.kind === 'stroke').length, 0), 0);
    return {
      notebooks: live.length,
      trash: this.data.notebooks.length - live.length,
      folders: this.data.folders.length,
      pages,
      items,
      strokes,
      cards: live.reduce((s, n) => s + (n.study || []).length, 0),
      bytes: this.bytes(),
    };
  }

  get(id) { return this.data.notebooks.find((n) => n.id === id) || null; }

  page(bookId, pageId) {
    const nb = this.get(bookId);
    if (!nb) return null;
    return nb.pages.find((p) => p.id === pageId) || null;
  }

  /* ---------- 模板：把一本笔记本存成模板 / 从模板新建 ---------- */

  /** 全部模板（内置在前，自存在后） */
  templates() {
    return [...BUILTIN_TEMPLATES, ...(this.data.templates || [])].map((t) => ({ ...t, builtin: !!t.builtin }));
  }

  template(id) {
    return this.templates().find((t) => t.id === id) || null;
  }

  /** 把某本笔记本另存为模板（默认只存结构与纸张，不带内容） */
  saveAsTemplate(bookId, { name, withContent = false } = {}) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const t = {
      id: nid('tpl'),
      name: String(name || nb.title || '未命名模板').trim().slice(0, 40) || '未命名模板',
      builtin: false,
      cover: { ...nb.cover },
      paper: { ...nb.paper },
      scroll: nb.scroll,
      withContent: !!withContent,
      createdAt: now(),
      pages: nb.pages.map((p) => ({
        paper: p.paper ? { ...p.paper } : null,
        items: withContent ? clone(p.items || []) : [],
      })),
    };
    this.data.templates.push(t);
    this.save();
    return t;
  }

  removeTemplate(id) {
    const before = this.data.templates.length;
    this.data.templates = this.data.templates.filter((t) => t.id !== id);
    if (this.data.templates.length !== before) this.save();
    return this.data.templates.length < before;
  }

  /** 从模板新建一本（内置模板也能用） */
  createFromTemplate(templateId, patch = {}) {
    const t = this.template(templateId);
    if (!t) return null;
    const pages = (t.pages && t.pages.length ? t.pages : [{ paper: null }]).map((p) => makePage({
      paper: p.paper ? { ...p.paper } : null,
      items: t.withContent ? clone(p.items || []) : [],
    }));
    return this.create({
      title: patch.title || t.name || '新笔记本',
      cover: t.cover ? { ...t.cover } : undefined,
      paper: t.paper ? { ...t.paper } : undefined,
      scroll: t.scroll || 'vertical',
      folder: patch.folder || null,
      pages,
    });
  }

  /* ---------- 笔记本增删改 ---------- */

  create(patch = {}) {
    const nb = makeNotebook(patch);
    this.data.notebooks.unshift(nb);
    this.save();
    return nb;
  }

  update(id, patch = {}) {
    const nb = this.get(id);
    if (!nb) return null;
    Object.assign(nb, patch, { updatedAt: now() });
    if (patch.cover) nb.cover = { ...nb.cover, ...patch.cover };
    if (patch.paper) nb.paper = { ...nb.paper, ...patch.paper };
    if (patch.title && !patch.cover) nb.cover.glyph = String(patch.title).trim().slice(0, 1) || nb.cover.glyph;
    this.save();
    return nb;
  }

  touch(id) {
    const nb = this.get(id);
    if (!nb) return null;
    nb.updatedAt = now();
    this.save();
    return nb;
  }

  open(id) {
    const nb = this.get(id);
    if (!nb) return null;
    nb.openedAt = now();
    this.save();
    return nb;
  }

  trash(id) {
    const nb = this.get(id);
    if (!nb) return null;
    nb.trashedAt = now();
    this.save();
    return nb;
  }

  restore(id) {
    const nb = this.get(id);
    if (!nb) return null;
    nb.trashedAt = null;
    this.save();
    return nb;
  }

  purge(id) {
    const before = this.data.notebooks.length;
    this.data.notebooks = this.data.notebooks.filter((n) => n.id !== id);
    this.save();
    return this.data.notebooks.length < before;
  }

  emptyTrash() {
    const n = this.data.notebooks.filter((x) => x.trashedAt).length;
    this.data.notebooks = this.data.notebooks.filter((x) => !x.trashedAt);
    this.save();
    return n;
  }

  /** 垃圾桶里超过保留期的自动清理（GoodNotes 也是 30 天） */
  sweepTrash(days = TRASH_RETENTION_DAYS) {
    const cut = now() - days * 86400000;
    const before = this.data.notebooks.length;
    this.data.notebooks = this.data.notebooks.filter((n) => !n.trashedAt || n.trashedAt > cut);
    const removed = before - this.data.notebooks.length;
    if (removed) this.save();
    return removed;
  }

  duplicate(id) {
    const nb = this.get(id);
    if (!nb) return null;
    const copy = makeNotebook({
      ...clone(nb),
      id: nid('bk'),
      title: `${nb.title} 副本`,
      createdAt: now(),
      updatedAt: now(),
      openedAt: 0,
      trashedAt: null,
      pages: nb.pages.map((p) => ({ ...clone(p), id: nid('pg') })),
    });
    this.data.notebooks.unshift(copy);
    this.save();
    return copy;
  }

  setCoverImage(bookId, dataUrl) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const src = String(dataUrl || '');
    if (src && !/^data:image\//.test(src)) return null;
    nb.cover.image = src.slice(0, 3_000_000);
    this.touch(bookId);
    return nb;
  }

  clearCoverImage(bookId) {
    const nb = this.get(bookId);
    if (!nb) return null;
    nb.cover.image = '';
    this.touch(bookId);
    return nb;
  }

  setFav(id, fav) {
    const nb = this.get(id);
    if (!nb) return null;
    nb.fav = fav == null ? !nb.fav : !!fav;
    this.save();
    return nb;
  }

  moveToFolder(id, folderId) {
    const nb = this.get(id);
    if (!nb) return null;
    nb.folder = folderId || null;
    this.save();
    return nb;
  }

  addTag(id, tag) {
    const nb = this.get(id);
    if (!nb) return null;
    const t = String(tag || '').trim();
    if (t && !nb.tags.includes(t)) nb.tags.push(t);
    this.save();
    return nb;
  }

  removeTag(id, tag) {
    const nb = this.get(id);
    if (!nb) return null;
    nb.tags = nb.tags.filter((t) => t !== tag);
    this.save();
    return nb;
  }

  allTags() {
    const set = new Map();
    for (const n of this.data.notebooks) {
      if (n.trashedAt) continue;
      for (const t of n.tags || []) set.set(t, (set.get(t) || 0) + 1);
    }
    return [...set.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }

  /* ---------- 文件夹 ---------- */

  folders() { return this.data.folders.slice().sort((a, b) => a.createdAt - b.createdAt); }

  addFolder(name, color = '#5A6B8C') {
    const f = { id: nid('fld'), name: String(name || '新建文件夹').trim() || '新建文件夹', color, createdAt: now() };
    this.data.folders.push(f);
    this.save();
    return f;
  }

  renameFolder(id, name) {
    const f = this.data.folders.find((x) => x.id === id);
    if (!f) return null;
    f.name = String(name || f.name).trim() || f.name;
    this.save();
    return f;
  }

  removeFolder(id) {
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    for (const n of this.data.notebooks) if (n.folder === id) n.folder = null;
    this.save();
    return true;
  }

  /* ---------- 页面 ---------- */

  addPage(bookId, { afterPageId = '', template = '', count = 1 } = {}) {
    const nb = this.get(bookId);
    if (!nb) return [];
    const made = [];
    for (let i = 0; i < Math.max(1, asInt(count, 1)); i++) made.push(makePage(template ? { paper: { ...nb.paper, template } } : {}));
    const at = afterPageId ? nb.pages.findIndex((p) => p.id === afterPageId) : nb.pages.length - 1;
    nb.pages.splice((at < 0 ? nb.pages.length - 1 : at) + 1, 0, ...made);
    nb.updatedAt = now();
    this.save();
    return made;
  }

  duplicatePage(bookId, pageId) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const i = nb.pages.findIndex((p) => p.id === pageId);
    if (i < 0) return null;
    const copy = { ...clone(nb.pages[i]), id: nid('pg'), createdAt: now() };
    nb.pages.splice(i + 1, 0, copy);
    nb.updatedAt = now();
    this.save();
    return copy;
  }

  removePage(bookId, pageId) {
    const nb = this.get(bookId);
    if (!nb) return false;
    if (nb.pages.length <= 1) return false;   // 最后一页不允许删（手账 App 也是这样）
    nb.pages = nb.pages.filter((p) => p.id !== pageId);
    nb.updatedAt = now();
    this.save();
    return true;
  }

  movePage(bookId, from, to) {
    const nb = this.get(bookId);
    if (!nb) return false;
    if (from < 0 || from >= nb.pages.length || to < 0 || to >= nb.pages.length) return false;
    const [p] = nb.pages.splice(from, 1);
    nb.pages.splice(to, 0, p);
    nb.updatedAt = now();
    this.save();
    return true;
  }

  setPagePaper(bookId, pageId, paperPatch) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    p.paper = { ...(p.paper || this.get(bookId).paper), ...paperPatch };
    this.touch(bookId);
    return p;
  }

  clearPagePaper(bookId, pageId) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    p.paper = null;
    this.touch(bookId);
    return p;
  }

  toggleBookmark(bookId, pageId) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    p.bookmarked = !p.bookmarked;
    this.touch(bookId);
    return p;
  }

  setPageTitle(bookId, pageId, title) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    p.title = String(title || '').slice(0, 60);
    this.touch(bookId);
    return p;
  }

  /** 大纲：书签页 + 有标题的页（对齐 GoodNotes 的「大纲 / 书签」） */
  outline(bookId) {
    const nb = this.get(bookId);
    if (!nb) return [];
    return nb.pages
      .map((p, i) => ({ pageId: p.id, index: i, title: p.title || (p.bookmarked ? `第 ${i + 1} 页（书签）` : ''), bookmarked: !!p.bookmarked }))
      .filter((x) => x.bookmarked || x.title);
  }

  /** 页面里所有文字（打字的 + 手写识别出来的）拼起来，用于页内搜索 */
  searchText(bookId, needle) {
    const nb = this.get(bookId);
    if (!nb) return [];
    const q = String(needle || '').trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    nb.pages.forEach((p, i) => {
      const texts = (p.items || []).filter((it) => it.kind === 'text').map((it) => it.text || '').join('\n');
      const ocr = (p.ocr && p.ocr.text) || '';
      const where = [];
      if (texts.toLowerCase().includes(q)) where.push('文字');
      if (ocr.toLowerCase().includes(q)) where.push('手写识别');
      if (where.length) hits.push({ pageId: p.id, index: i, source: where.join('+'), excerpt: (texts + '\n' + ocr).slice(0, 120) });
    });
    // 录音转写命中的，挂到它当时所在的那一页
    for (const a of nb.audio || []) {
      const t = (a && a.text) || '';
      if (!t || !t.toLowerCase().includes(q)) continue;
      const idx = Math.max(0, nb.pages.findIndex((p) => p.id === a.pageId));
      const page = nb.pages[idx];
      if (!page) continue;
      const exist = hits.find((h) => h.index === idx);
      if (exist) {
        if (!exist.source.includes('录音转写')) exist.source += '+录音转写';
        exist.excerpt = `${exist.excerpt}\n${t}`.slice(0, 200);
      } else {
        hits.push({ pageId: page.id, index: idx, source: '录音转写', excerpt: t.slice(0, 160) });
      }
    }
    hits.sort((a, b) => a.index - b.index);
    return hits;
  }

  /** 跨笔记本搜索（含手写 OCR 结果）→ 直接给出可跳转的命中 */
  searchAll(needle, { limit = 40 } = {}) {
    const q = String(needle || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const nb of this.data.notebooks) {
      if (nb.trashedAt) continue;
      for (const hit of this.searchText(nb.id, q)) {
        out.push({ bookId: nb.id, title: nb.title, pageIndex: hit.index, pageId: hit.pageId, source: hit.source, excerpt: hit.excerpt });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /* ---------- 手写识别（OCR）结果 ---------- */
  /** 写入某页的识别文字（OCR 模块用它回填）；带位置时同时存 lines，PDF 文字层就能原位对齐 */
  setPageOcr(bookId, pageId, { text, model, lines } = {}) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
    const safeLines = Array.isArray(lines)
      ? lines
        .filter((l) => l && String(l.text || '').trim())
        .slice(0, 400)
        .map((l) => {
          const box = Array.isArray(l.box) && l.box.length >= 4 && l.box.every((v) => Number.isFinite(Number(v)))
            ? l.box.slice(0, 4).map((v) => Math.min(1, Math.max(0, Number(v))))
            : null;
          return { text: String(l.text).slice(0, 600), box };
        })
      : [];
    if (!clean && !safeLines.length) return p;
    p.ocr = {
      text: clean || safeLines.map((l) => l.text).join('\n'),
      model: model || '',
      chars: (clean || '').length,
      lines: safeLines,
      boxes: safeLines.filter((l) => l.box).length,
      at: Date.now(),
    };
    this.touch(bookId);
    return p;
  }

  clearPageOcr(bookId, pageId) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    delete p.ocr;
    this.touch(bookId);
    return p;
  }

  ocrStats(bookId) {
    const nb = this.get(bookId);
    if (!nb) return { pages: 0, done: 0, pending: 0, chars: 0 };
    const done = nb.pages.filter((p) => p.ocr && p.ocr.text).length;
    return {
      pages: nb.pages.length,
      done,
      pending: nb.pages.length - done,
      chars: nb.pages.reduce((s, p) => s + ((p.ocr && p.ocr.chars) || 0), 0),
    };
  }

  /** 记下「这一页识别失败」：批量队列据此重试，也让界面能告诉你是哪几页、为什么 */
  setPageOcrError(bookId, pageId, { message, model } = {}) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    const prev = p.ocrError && Number(p.ocrError.count) || 0;
    p.ocrError = {
      message: String(message == null ? '' : message).slice(0, 300),
      model: model || '',
      count: prev + 1,
      at: Date.now(),
    };
    this.touch(bookId);
    return p;
  }

  clearPageOcrError(bookId, pageId) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    delete p.ocrError;
    this.touch(bookId);
    return p;
  }

  /**
   * 标记「这一页确实没有文字」：不写 text，但记成已处理
   * 意义：没有它的话，每次批量识别都会把空白页再烧一遍 token（并且永远显示「待识别」）
   */
  markPageBlank(bookId, pageId, { model } = {}) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    p.ocr = { text: '', blank: true, model: model || '', chars: 0, lines: [], boxes: 0, at: Date.now() };
    delete p.ocrError;
    this.touch(bookId);
    return p;
  }

  /* ---------- 批量识别队列（跨本，关掉页面也能接着跑） ---------- */

  /** 把这几本加入识别队列（队列状态存在笔记本本体上，所以备份/同步都带着） */
  enqueueOcr(bookIds) {
    const ids = (Array.isArray(bookIds) ? bookIds : [bookIds]).filter(Boolean);
    let n = 0;
    for (const id of ids) {
      const nb = this.get(id);
      if (!nb) continue;
      nb.ocrQueued = true;
      this.touch(id);
      n++;
    }
    return n;
  }

  dequeueOcr(bookIds) {
    const ids = (Array.isArray(bookIds) ? bookIds : [bookIds]).filter(Boolean);
    for (const id of ids) {
      const nb = this.get(id);
      if (!nb) continue;
      delete nb.ocrQueued;
      this.touch(id);
    }
  }

  queuedOcrBooks() {
    return this.notebooks({}).filter((nb) => nb.ocrQueued).map((nb) => this.get(nb.id)).filter(Boolean);
  }

  /** 记录队列进度（done/failed 由队列每页回写后汇总），finished=true 表示这一本跑完了 */
  recordOcrJob(bookId, { total = 0, done = 0, failed = 0, blank = 0, model = '', finished = false, reason = '' } = {}) {
    const nb = this.get(bookId);
    if (!nb) return null;
    nb.ocrJob = {
      total: Number(total) || 0,
      done: Number(done) || 0,
      failed: Number(failed) || 0,
      blank: Number(blank) || 0,
      model: model || '',
      finished: !!finished,
      reason: String(reason || '').slice(0, 200),
      at: Date.now(),
    };
    this.touch(bookId);
    return nb.ocrJob;
  }

  /* ---------- 对象（页内内容） ---------- */

  setItems(bookId, pageId, items) {
    const p = this.page(bookId, pageId);
    if (!p) return false;
    p.items = Array.isArray(items) ? items : [];
    this.touch(bookId);
    return true;
  }

  items(bookId, pageId) {
    const p = this.page(bookId, pageId);
    return p ? clone(p.items || []) : [];
  }

  /* ---------- 学习集（闪卡 + 间隔重复） ---------- */

  addCard(bookId, front, back, opts = {}) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const card = {
      id: nid('cd'),
      front: String(front || '').trim(),
      back: String(back || '').trim(),
      tags: parseCardTags(opts.tags),
      box: 0,
      due: now(),
      lapses: 0,
      reviews: 0,
      pageId: opts.pageId || '',
      createdAt: now(),
    };
    if (!card.front) return null;
    nb.study.push(card);
    this.save();
    return card;
  }

  setCardTags(bookId, cardId, tags) {
    const nb = this.get(bookId);
    const c = nb && nb.study.find((x) => x.id === cardId);
    if (!c) return null;
    c.tags = parseCardTags(tags);
    this.touch(bookId);
    return c;
  }

  /** 改「这张卡来自哪一页」（传空 = 清掉来源） */
  setCardPage(bookId, cardId, pageId) {
    const nb = this.get(bookId);
    const c = nb && nb.study.find((x) => x.id === cardId);
    if (!c) return null;
    c.pageId = pageId && nb.pages.some((p) => p.id === pageId) ? pageId : '';
    this.touch(bookId);
    return c;
  }

  /** 来源页没了的卡片（页被删了 / 从别处导入的）——界面可以标出来让你重新挂或清掉 */
  orphanCards(bookId) {
    const nb = this.get(bookId);
    if (!nb) return [];
    const ids = new Set(nb.pages.map((p) => p.id));
    return nb.study.filter((c) => !c.pageId || !ids.has(c.pageId));
  }

  /** 批量：把这几张卡的来源清掉（只动来源，不删卡） */
  clearCardsPage(bookId, cardIds) {
    const nb = this.get(bookId);
    if (!nb) return 0;
    const want = new Set((Array.isArray(cardIds) ? cardIds : [cardIds]).filter(Boolean));
    let n = 0;
    for (const c of nb.study || []) {
      if (want.has(c.id) && c.pageId) { c.pageId = ''; n++; }
    }
    if (n) this.touch(bookId);
    return n;
  }

  /** 批量：把这几张卡的来源改挂到某一页 */
  setCardsPage(bookId, cardIds, pageId) {
    const nb = this.get(bookId);
    if (!nb || !nb.pages.some((p) => p.id === pageId)) return 0;
    const want = new Set((Array.isArray(cardIds) ? cardIds : [cardIds]).filter(Boolean));
    let n = 0;
    for (const c of nb.study || []) {
      if (want.has(c.id)) { c.pageId = pageId; n++; }
    }
    if (n) this.touch(bookId);
    return n;
  }

  /**
   * 按卡面文字把丢失的「来源页」找回来（纯靠本子内已有的文本与手写识别）
   *   · 只在**唯一命中**时才挂（命中多页说明不可靠，宁可不挂也不挂错）
   * @returns {{ pageId:string, pageIndex:number, matches:number }|null}
   */
  findCardPageByText(bookId, card, { minLen = 4, maxCheck = 240 } = {}) {
    const nb = this.get(bookId);
    if (!nb || !card) return null;
    const needle = String(card.front || '').trim().slice(0, maxCheck);
    if (needle.length < Math.max(2, minLen)) return null;
    const hits = this.searchText(bookId, needle, { limit: 8 }) || [];
    const pages = [...new Set(hits.map((h) => h.pageId))];
    if (pages.length !== 1) return null;
    const idx = nb.pages.findIndex((p) => p.id === pages[0]);
    if (idx < 0) return null;
    return { pageId: pages[0], pageIndex: idx, matches: hits.length };
  }

  removeCard(bookId, cardId) {
    const nb = this.get(bookId);
    if (!nb) return false;
    nb.study = nb.study.filter((c) => c.id !== cardId);
    this.save();
    return true;
  }

  /**
   * 闪卡的间隔重复（Leitner 盒子的简化版）：
   *   记住 → 盒子 +1，下次间隔按 1/2/4/8/16/32 天递进
   *   忘记 → 盒子归零并在 10 分钟后重来
   */
  reviewCard(bookId, cardId, remembered) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const c = nb.study.find((x) => x.id === cardId);
    if (!c) return null;
    const DAY = 86400000;
    if (remembered) {
      c.box = Math.min(5, (c.box || 0) + 1);
      c.due = now() + [1, 2, 4, 8, 16, 32][c.box - 1] * DAY;
    } else {
      c.box = 0;
      c.lapses = (c.lapses || 0) + 1;
      c.due = now() + 10 * 60000;
    }
    c.reviews = (c.reviews || 0) + 1;
    c.last = now();
    this.logReview(remembered);
    this.save();
    return c;
  }

  /** 记一次复习（热图用）：按天累计，超过 REVIEW_LOG_DAYS 天的自动清掉 */
  logReview(remembered, at = now()) {
    const log = this.data.reviewLog || (this.data.reviewLog = {});
    const key = dayKey(at);
    const row = log[key] || (log[key] = { n: 0, ok: 0, bad: 0 });
    row.n++;
    if (remembered) row.ok++; else row.bad++;
    const cut = dayKey(at - REVIEW_LOG_DAYS * 86400000);
    for (const k of Object.keys(log)) if (k < cut) delete log[k];
    this.save();
    return row;
  }

  /**
   * 复习热图数据：最近 days 天，每天一格（含今天）
   * @returns {{days:Array<{date:string, n:number, ok:number, bad:number, level:number}>, total:number,
   *            active:number, streak:number, best:number, today:number, max:number}}
   */
  reviewHeat({ days = 182, at = now() } = {}) {
    const log = this.data.reviewLog || {};
    const out = [];
    let total = 0, active = 0, max = 0, streak = 0, best = 0, run = 0;
    const start = at - (Math.max(7, Math.min(730, days)) - 1) * 86400000;
    for (let i = 0; i < Math.max(7, Math.min(730, days)); i++) {
      const ts = start + i * 86400000;
      const key = dayKey(ts);
      const row = log[key] || { n: 0, ok: 0, bad: 0 };
      const n = Number(row.n) || 0;
      total += n;
      if (n > 0) { active++; run++; if (run > best) best = run; } else run = 0;
      if (n > max) max = n;
      out.push({ date: key, n, ok: Number(row.ok) || 0, bad: Number(row.bad) || 0, level: n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 30 ? 3 : 4 });
    }
    // 当前连续天数：从今天往回数（今天没复习就数到昨天为止）
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].n > 0) streak++;
      else if (i === out.length - 1) continue;   // 今天还没复习不算断
      else break;
    }
    return { days: out, total, active, streak, best, today: out[out.length - 1] ? out[out.length - 1].n : 0, max };
  }

  dueCards(bookId, at = now()) {
    const nb = this.get(bookId);
    if (!nb) return [];
    return nb.study.filter((c) => (c.due || 0) <= at).sort((a, b) => (a.box || 0) - (b.box || 0));
  }

  /**
   * 带筛选的到期队列（跨本复习用）
   * @param {object} o { tag 卡片标签, bookTag 笔记本标签, bookId, folder, at, limit, includeNotDue }
   * @returns {Array<{bookId,bookTitle,cardId,front,back,tags,box,pageId,pageIndex,pageTitle,sourceOk,bookTags}>}
   *   · 按盒子层数从小到大（先复习最生的）
   *   · pageIndex / pageTitle / sourceOk 用来在卡面上显示「来自第几页」并跳过去看
   */
  dueQueue({ tag = '', bookTag = '', bookId = '', folder = '', at = now(), limit = 0, includeNotDue = false } = {}) {
    const live = this.data.notebooks.filter((n) => !n.trashedAt);
    const wantTag = String(tag || '').trim();
    const wantBookTag = String(bookTag || '').trim();
    const out = [];
    for (const nb of live) {
      if (bookId && nb.id !== bookId) continue;
      if (folder && nb.folder !== folder) continue;
      if (wantBookTag && !(nb.tags || []).includes(wantBookTag)) continue;
      for (const c of nb.study || []) {
        if (wantTag && !(c.tags || []).includes(wantTag)) continue;
        if (!includeNotDue && (c.due || 0) > at) continue;
        const src = cardSourceOf(nb, c);
        out.push({
          bookId: nb.id,
          bookTitle: nb.title,
          bookTags: nb.tags || [],
          cardId: c.id,
          front: c.front || '',
          back: c.back || '',
          tags: c.tags || [],
          box: c.box || 0,
          lapses: c.lapses || 0,
          pageId: c.pageId || '',
          pageIndex: src.pageIndex,
          pageTitle: src.pageTitle,
          sourceOk: src.ok,
          due: c.due || 0,
        });
      }
    }
    out.sort((a, b) => (a.box - b.box) || (a.due - b.due));
    return limit > 0 ? out.slice(0, limit) : out;
  }

  /** 复习中心的筛选项：标签 / 笔记本各有多少到期卡（界面直接渲染按钮） */
  dueFacets({ at = now() } = {}) {
    const live = this.data.notebooks.filter((n) => !n.trashedAt);
    const tagMap = new Map();
    const bookTagMap = new Map();
    const books = [];
    let due = 0, total = 0;
    for (const nb of live) {
      const cards = nb.study || [];
      if (!cards.length) continue;
      const d = cards.filter((c) => (c.due || 0) <= at).length;
      due += d;
      total += cards.length;
      if (d) books.push({ bookId: nb.id, title: nb.title, due: d, total: cards.length });
      for (const c of cards) {
        const isDue = (c.due || 0) <= at;
        for (const t of c.tags || []) {
          const row = tagMap.get(t) || { tag: t, due: 0, total: 0 };
          row.total++; if (isDue) row.due++;
          tagMap.set(t, row);
        }
        for (const t of nb.tags || []) {
          const row = bookTagMap.get(t) || { tag: t, due: 0, total: 0 };
          row.total++; if (isDue) row.due++;
          bookTagMap.set(t, row);
        }
      }
    }
    const byDue = (a, b) => (b.due - a.due) || a.tag.localeCompare(b.tag);
    books.sort((a, b) => b.due - a.due);
    return {
      due,
      total,
      books,
      tags: [...tagMap.values()].sort(byDue),
      bookTags: [...bookTagMap.values()].sort(byDue),
    };
  }

  /** 全部闪卡（导出 Anki / 备份用） */
  allCards() {
    const live = this.data.notebooks.filter((n) => !n.trashedAt);
    return live.flatMap((nb) => (nb.study || []).map((c) => ({ ...c, bookId: nb.id, bookTitle: nb.title, bookTags: nb.tags || [] })));
  }

  /** 全库「今天该复习」：总数 + 分布在哪些本子上（资料库首页入口用） */
  dueStats(at = now()) {
    const live = this.data.notebooks.filter((n) => !n.trashedAt);
    const per = [];
    let due = 0, total = 0, mastered = 0, todayReviews = 0;
    for (const nb of live) {
      const cards = nb.study || [];
      if (!cards.length) continue;
      const d = cards.filter((c) => (c.due || 0) <= at).length;
      due += d;
      total += cards.length;
      mastered += cards.filter((c) => (c.box || 0) >= 5).length;
      todayReviews += cards.filter((c) => c.last && at - c.last < 86400000).length;
      if (d) per.push({ bookId: nb.id, title: nb.title, due: d, total: cards.length });
    }
    per.sort((a, b) => b.due - a.due);
    return { due, total, mastered, todayReviews, notebooks: per.length, list: per };
  }

  /** 有到期卡片的本子（按到期数量排序） */
  dueNotebooks(at = now()) { return this.dueStats(at).list; }

  /** 从页面里的文本对象自动生成闪卡（每行「前 —— 后」或整段作正面） */
  cardsFromText(bookId, pageId, text) {
    const src = String(text || '');
    const lines = src.split('\n').map((s) => s.trim()).filter(Boolean);
    const made = [];
    for (const line of lines) {
      const m = /^(.+?)\s*(?:——|--|=>|:|：)\s*(.+)$/.exec(line);
      if (m) made.push(this.addCard(bookId, m[1].trim(), m[2].trim(), { pageId }));
      else if (line.length <= 60) made.push(this.addCard(bookId, line, '', { pageId }));
    }
    return made.filter(Boolean);
  }

  /* ---------- 录音（与笔记时间点同步） ---------- */

  async _db() {
    if (this._idb !== null) return this._idb;
    try {
      if (typeof indexedDB === 'undefined') { this._idb = false; return false; }
      this._idb = await new Promise((resolve) => {
        const req = indexedDB.open('note-books-media', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      this._idb = false;
    }
    return this._idb;
  }

  /** 存一段录音（blob 进 IndexedDB，元数据进笔记本） */
  async saveAudio(bookId, blob, meta = {}) {
    const nb = this.get(bookId);
    if (!nb || !blob) return null;
    const id = nid('au');
    const rec = {
      id,
      pageId: meta.pageId || '',
      pageIndex: asInt(meta.pageIndex, 0),
      itemCount: asInt(meta.itemCount, 0),
      duration: Number(meta.duration) || 0,
      mime: blob.type || 'audio/webm',
      size: blob.size || 0,
      createdAt: now(),
    };
    const db = await this._db();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction('audio', 'readwrite');
          tx.objectStore('audio').put({ id, blob });
          tx.oncomplete = resolve;
          tx.onerror = resolve;
          tx.onabort = resolve;
        } catch (e) { resolve(); }
      });
    } else {
      this.audio.set(id, blob);
    }
    nb.audio.push(rec);
    this.save();
    return rec;
  }

  async getAudio(id) {
    if (this.audio.has(id)) return this.audio.get(id);
    const db = await this._db();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('audio', 'readonly');
        const req = tx.objectStore('audio').get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  async removeAudio(bookId, id) {
    const nb = this.get(bookId);
    if (nb) {
      nb.audio = nb.audio.filter((a) => a.id !== id);
      this.save();
    }
    this.audio.delete(id);
    const db = await this._db();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction('audio', 'readwrite');
          tx.objectStore('audio').delete(id);
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        } catch (e) { resolve(); }
      });
    }
    return true;
  }

  /** 录音转写结果（ASR）：写回录音记录，于是音频内容也能被搜到 */
  setAudioText(bookId, audioId, text, model = '') {
    const nb = this.get(bookId);
    if (!nb) return null;
    const rec = (nb.audio || []).find((a) => a.id === audioId);
    if (!rec) return null;
    const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
    if (!clean) return rec;
    rec.text = clean;
    rec.asrModel = model || '';
    rec.asrAt = Date.now();
    this.touch(bookId);
    return rec;
  }

  clearAudioText(bookId, audioId) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const rec = (nb.audio || []).find((a) => a.id === audioId);
    if (!rec) return null;
    delete rec.text;
    delete rec.asrModel;
    delete rec.asrAt;
    this.touch(bookId);
    return rec;
  }

  /** 录音的分段（句级）：每句带上它对应的页码/对象序号，播放时能跟着高亮 */
  setAudioSegments(bookId, audioId, segments) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const rec = (nb.audio || []).find((a) => a.id === audioId);
    if (!rec) return null;
    rec.segments = (Array.isArray(segments) ? segments : [])
      .filter((s) => s && String(s.text || '').trim())
      .slice(0, 400)
      .map((s) => ({
        start: Math.max(0, Number(s.start) || 0),
        end: Math.max(0, Number(s.end) || 0) || (Number(s.start) || 0) + 1,
        text: String(s.text).slice(0, 600),
        exact: !!s.exact,
        pageIndex: Math.max(0, asInt(s.pageIndex, 0)),
        pageId: s.pageId || '',
        itemIndex: Math.max(0, asInt(s.itemIndex, 0)),
      }));
    this.touch(bookId);
    return rec;
  }

  /** 播放到 t 秒时，当前是哪一句（含它对应的页） */
  audioSegmentAt(bookId, audioId, time) {
    const nb = this.get(bookId);
    const rec = nb && (nb.audio || []).find((a) => a.id === audioId);
    if (!rec || !Array.isArray(rec.segments) || !rec.segments.length) return null;
    const t = Number(time) || 0;
    const segs = rec.segments;
    for (let i = 0; i < segs.length; i++) {
      if (t >= segs[i].start && t < segs[i].end) return { index: i, segment: segs[i] };
    }
    return { index: segs.length - 1, segment: segs[segs.length - 1] };
  }

  /** 录音转写统计 */
  audioStats(bookId) {
    const nb = this.get(bookId);
    const list = (nb && nb.audio) || [];
    const done = list.filter((a) => a.text).length;
    return { total: list.length, done, pending: list.length - done, chars: list.reduce((s, a) => s + ((a.text || '').length), 0) };
  }

  /** 录音回放时：找到「录到这段时正在写的那一页 / 那一笔」 */  audioAnchor(bookId, audioId, elapsedRatio = 0) {
    const nb = this.get(bookId);
    if (!nb) return null;
    const rec = nb.audio.find((a) => a.id === audioId);
    if (!rec) return null;
    const idx = Math.max(0, nb.pages.findIndex((p) => p.id === rec.pageId));
    const page = nb.pages[idx] || nb.pages[rec.pageIndex] || nb.pages[0];
    if (!page) return null;
    const total = Math.max(0, rec.itemCount || 0);
    const ratio = Math.min(1, Math.max(0, Number(elapsedRatio) || 0));
    const at = Math.min(total, Math.round(total * ratio));   // 当时写到第几个对象
    return {
      pageId: page.id,
      pageIndex: nb.pages.findIndex((p) => p.id === page.id),
      itemsAtThatMoment: at,
      itemsRecorded: total,
      itemsNow: (page.items || []).length,
    };
  }

  /* ---------- 备份 / 导入导出 ---------- */

  exportJSON(ids = null) {
    const pick = ids && ids.length ? this.data.notebooks.filter((n) => ids.includes(n.id)) : this.data.notebooks;
    return JSON.stringify({
      app: '我的笔记 · GoodNotes 模式',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      folders: this.data.folders,
      notebooks: pick.map((n) => clone(n)),
      reviewLog: this.data.reviewLog || {},     // 复习热图（导入时按天合并取较大值，不会重复累加）
    }, null, 1);
  }

  /** 导入备份：同 id 的笔记本按「新副本」并入，绝不覆盖现有内容 */
  importJSON(text, { merge = true } = {}) {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    if (!j || !Array.isArray(j.notebooks)) throw new Error('这个文件不是本站的笔记本备份');
    const result = { folders: 0, notebooks: 0, renamed: 0 };
    const folderMap = new Map();
    for (const f of j.folders || []) {
      let exist = this.data.folders.find((x) => x.id === f.id);
      if (!exist) {
        exist = { id: f.id || nid('fld'), name: f.name || '导入的文件夹', color: f.color || '#5A6B8C', createdAt: asInt(f.createdAt, now()) };
        this.data.folders.push(exist);
        result.folders++;
      }
      folderMap.set(f.id, exist.id);
    }
    for (const raw of j.notebooks) {
      const nb = makeNotebook(raw);
      const clash = this.data.notebooks.some((n) => n.id === nb.id);
      if (clash) { nb.id = nid('bk'); nb.title = `${nb.title}（导入）`; result.renamed++; }
      nb.folder = nb.folder && folderMap.has(nb.folder) ? folderMap.get(nb.folder) : nb.folder;
      if (nb.folder && !this.data.folders.some((f) => f.id === nb.folder)) nb.folder = null;
      if (!merge) this.data.notebooks = [];
      this.data.notebooks.unshift(nb);
      result.notebooks++;
    }
    // 热图数据按天取较大值合并（两边各自记过同一天时，不会累加成双倍）
    const incoming = parseReviewLog(j.reviewLog);
    const log = this.data.reviewLog || (this.data.reviewLog = {});
    for (const [k, v] of Object.entries(incoming)) {
      const cur = log[k] || { n: 0, ok: 0, bad: 0 };
      log[k] = {
        n: Math.max(Number(cur.n) || 0, v.n),
        ok: Math.max(Number(cur.ok) || 0, v.ok),
        bad: Math.max(Number(cur.bad) || 0, v.bad),
      };
    }
    this.save();
    return result;
  }

  /** 把整座资料库清空（危险操作，界面上会二次确认） */
  reset() {
    this.data = emptyLibrary();
    this.save();
    return true;
  }
}
