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
    study: Array.isArray(patch.study) ? patch.study : [],
    version: SCHEMA_VERSION,
  };
  return nb;
}

function emptyLibrary() {
  return { version: SCHEMA_VERSION, folders: [], notebooks: [], settings: { sort: 'updated', view: 'grid' } };
}

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

  /** 笔记本的文字摘要（文本对象 + 已识别的 OCR 手写），供搜索与卡片副标题用 */
  snippetOf(nb) {
    const bits = [];
    for (const p of nb.pages || []) {
      for (const it of p.items || []) {
        if (it && it.kind === 'text' && it.text) bits.push(it.text);
      }
      if (p.ocr && p.ocr.text) bits.push(p.ocr.text.slice(0, 600));   // 手写识别结果也进搜索
      if (bits.length > 40) break;
    }
    return bits.join(' ').slice(0, 900);
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

  /** 写入某页的识别文字（OCR 模块用它回填） */
  setPageOcr(bookId, pageId, { text, model } = {}) {
    const p = this.page(bookId, pageId);
    if (!p) return null;
    const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
    if (!clean) return p;
    p.ocr = { text: clean, model: model || '', chars: clean.length, at: Date.now() };
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
    this.save();
    return c;
  }

  dueCards(bookId, at = now()) {
    const nb = this.get(bookId);
    if (!nb) return [];
    return nb.study.filter((c) => (c.due || 0) <= at).sort((a, b) => (a.box || 0) - (b.box || 0));
  }

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

  /** 录音回放时：找到「录到这段时正在写的那一页 / 那一笔」 */
  audioAnchor(bookId, audioId, elapsedRatio = 0) {
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
