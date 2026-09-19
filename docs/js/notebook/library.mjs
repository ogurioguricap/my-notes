/**
 * GoodNotes 模式 · 资料库界面（LibraryUI）
 *
 * 一座「笔记本资料库」该有的东西都在这儿：
 *   顶栏（标题 + 统计 + 搜索 + 排序 + 网格/列表 + 多选 + 新建）
 *   导航（全部 / 收藏 / 回收站 / 文件夹增删改 / 标签筛选）
 *   网格卡片与列表行（封面 = 颜色 + 花纹 + 首字，相对时间，收藏星标，更多菜单）
 *   多选模式与底部批量操作条（移入文件夹 / 加标签 / 收藏 / 复制 / 移到回收站）
 *   新建笔记本 sheet（标题 / 封面颜色 / 封面花纹 / 纸张模板 / 纸张颜色 / 尺寸）
 *   回收站（恢复 / 彻底删除 / 清空，30 天自动清理提示）
 *   备份（导出 JSON 下载 / 导入 JSON 还原）
 *   空状态与「没找到」引导
 *
 * 设计要点：
 * 1. 模块加载期不碰 DOM：本文件顶层只有 import、常量、纯函数与类定义，
 *    document / window / localStorage 一律只在方法内部按需取用（Node 里能直接 import 做链接测试）
 * 2. 事件全部走委托：只在 root 上挂 click / input / change / keydown 各一个监听，
 *    重建 DOM 不会丢监听，render() 可以反复调用
 * 3. 界面状态（scope / folder / sort / viewMode）存 localStorage 的 note-books-lib
 * 4. 对外接口：render / setQuery / setFolder / setScope / setSort / setViewMode / onOpenHook / destroy
 */

import {
  bookCoverVars,
  paperSize,
  paperTemplate,
  PAPER_SIZES,
  PAPER_COLORS,
  COVER_COLORS,
  COVER_PATTERNS,
  templateGroups,
} from './paper.mjs';
import { pushNotebook, pushAll, pullNotebook, fetchPublicIndex, pullFromPublicSite } from './sync.mjs';
import { buildPdfFromNotebooks, downloadBlob, PDF_QUALITY, qualityOf, notebookToMarkdown, markdownSlug } from './study.mjs';
import { gh } from '../editor.mjs';

/* ============================ 常量 ============================ */

/** 界面状态落盘的 key（只存 scope / folder / sort / viewMode） */
export const LIB_STORAGE_KEY = 'note-books-lib';

const SORTS = [
  { id: 'updated', label: '最近打开' },
  { id: 'created', label: '创建时间' },
  { id: 'title', label: '标题' },
  { id: 'pages', label: '页数' },
];

/** 回收站保留期，与数据层 store.TRASH_RETENTION_DAYS 一致 */
const KEEP_DAYS = 30;

const SIZE_CYCLE = [
  { k: 1024, u: 'B' },
  { k: 1024 * 1024, u: 'KB' },
  { k: 1024 * 1024 * 1024, u: 'MB' },
];

const ICON = {
  grid: '▦',
  list: '☰',
  star: '★',
  starOff: '☆',
  more: '⋯',
  folder: '📁',
  folderOpen: '📂',
  tag: '🏷',
  close: '✕',
  check: '✓',
};

const PATTERN_IDS = COVER_PATTERNS.map((p) => p.id);

/* ============================ 小工具（纯函数） ============================ */

function bkEsc(s) {
  const d = typeof document !== 'undefined' ? document : null;
  if (d && d.createElement) {
    const el = d.createElement('div');
    el.textContent = String(s == null ? '' : s);
    return el.innerHTML;
  }
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function utf8Len(s) {
  const str = String(s || '');
  if (typeof TextEncoder !== 'undefined') {
    try { return new TextEncoder().encode(str).length; } catch (e) { /* 退回逐字符估算 */ }
  }
  let n = str.length;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 127) n++;
  return n;
}

function humanBytes(n) {
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < SIZE_CYCLE.length - 1) { v /= 1024; i++; }
  const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(digits)}${SIZE_CYCLE[i].u}`;
}

/** 相对时间：刚刚 / N 分钟前 / 昨天 / M月D日 */
function relTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '未打开';
  const now = Date.now();
  const diff = Math.max(0, now - t);
  const min = 60000, hour = 3600000, day = 86400000;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  const d = new Date(t);
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (t >= start) return `${Math.floor(diff / hour)} 小时前`;
  if (t >= start - day) return '昨天';
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function dayStamp(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function orderOf(list, sort) {
  const l = list.slice();
  const cmp = {
    updated: (a, b) => (b.openedAt || b.updatedAt) - (a.openedAt || a.updatedAt),
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'),
    pages: (a, b) => b.pages.length - a.pages.length,
  }[sort] || ((a, b) => b.updatedAt - a.updatedAt);
  l.sort((a, b) => (a.fav === b.fav ? 0 : a.fav ? -1 : 1) || cmp(a, b));
  return l;
}

function safeStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (e) { /* 隐私模式 / 沙箱 → 不持久化 */ }
  return null;
}

function loadPrefs() {
  const st = safeStorage();
  if (!st) return {};
  try {
    const j = JSON.parse(st.getItem(LIB_STORAGE_KEY) || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

/* ============================ 主类 ============================ */

export class LibraryUI {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root       渲染容器
   * @param {NotebookStore} o.store    数据层
   * @param {(msg:string)=>void} [o.toast] 轻提示
   * @param {(bookId:string)=>void} [o.onOpen] 打开某本笔记本
   * @param {()=>void} [o.onGoMarkdown] 切回 Markdown 资料库视图
   */
  constructor({ root, store, toast, onOpen, onGoMarkdown } = {}) {
    this.root = root || null;
    this.store = store;
    this.toast = typeof toast === 'function' ? toast : () => {};
    this.onOpen = typeof onOpen === 'function' ? onOpen : () => {};
    this.onGoMarkdown = typeof onGoMarkdown === 'function' ? onGoMarkdown : null;

    const prefs = loadPrefs();
    this.state = {
      scope: ['all', 'fav', 'trash'].includes(prefs.scope) ? prefs.scope : 'all',
      folder: prefs.folder || null,
      query: '',
      sort: SORTS.some((s) => s.id === prefs.sort) ? prefs.sort : 'updated',
      viewMode: prefs.viewMode === 'list' ? 'list' : 'grid',
      tags: Array.isArray(prefs.tags) ? prefs.tags.slice(0, 12) : [],
    };
    this.sel = new Set();
    this.selecting = false;
    this.openMenuId = null;
    this.sheet = null;
    this._hooks = [];
    this._menu = null;
    this._destroyed = false;

    this.el = {};
    this._bind();
    if (this.root) {
      this._skeleton();
      this.render();
    }
  }

  /* ---------- DOM 骨架与事件（一律在方法里碰 DOM） ---------- */

  _skeleton() {
    const root = this.root;
    if (typeof root.querySelector !== 'function') return;
    if (root.dataset.libReady === '1') return;
    root.dataset.libReady = '1';
    root.classList.add('lib-root');
    root.insertAdjacentHTML('beforeend', `
      <div class="lib-wrap">
        <header class="lib-head">
          <div class="lib-head-main">
            <div class="lib-titles">
              <h2 class="lib-title">笔记本</h2>
              <p class="lib-sub" data-el="sub"></p>
            </div>
            <div class="lib-tools" data-el="tools"></div>
          </div>
        </header>
        <div data-el="head2"></div>
        <nav class="lib-nav" data-el="nav" aria-label="资料库导航"></nav>
        <main class="lib-body" data-el="body"></main>
        <div class="lib-layer" data-el="layer"></div>
      </div>
    `);
    this.el.wrap = root.querySelector('.lib-wrap');
    this.el.sub = root.querySelector('[data-el="sub"]');
    this.el.tools = root.querySelector('[data-el="tools"]');
    this.el.head2 = root.querySelector('[data-el="head2"]');
    this.el.nav = root.querySelector('[data-el="nav"]');
    this.el.body = root.querySelector('[data-el="body"]');
    this.el.layer = root.querySelector('[data-el="layer"]');
  }

  _handlers() {
    if (this._h) return this._h;
    this._h = {
      click: (e) => this._onClick(e),
      input: (e) => this._onInput(e),
      change: (e) => this._onChange(e),
      keydown: (e) => this._onKeydown(e),
    };
    return this._h;
  }

  _bind() {
    const root = this.root;
    if (!root || typeof root.addEventListener !== 'function') return;
    const h = this._handlers();
    root.addEventListener('click', h.click);
    root.addEventListener('input', h.input);
    root.addEventListener('change', h.change);
    if (typeof window !== 'undefined') window.addEventListener('keydown', h.keydown);
  }

  /**
   * 可选：注册一个「打开笔记本」的旁路钩子（app.js 不会用，留着给测试 / 埋点）
   * @returns {() => void} 取消注册
   */
  onOpenHook(fn) {
    if (typeof fn !== 'function') return () => {};
    this._hooks.push(fn);
    return () => { this._hooks = this._hooks.filter((f) => f !== fn); };
  }

  destroy() {
    this._destroyed = true;
    const root = this.root;
    if (root && typeof root.removeEventListener === 'function') {
      const h = this._handlers();
      root.removeEventListener('click', h.click);
      root.removeEventListener('input', h.input);
      root.removeEventListener('change', h.change);
    }
    if (typeof window !== 'undefined' && this._h) window.removeEventListener('keydown', this._h.keydown);
    if (root) {
      if (typeof root.innerHTML === 'string') root.innerHTML = '';
      if (root.classList) root.classList.remove('lib-root');
      if (root.dataset) delete root.dataset.libReady;
    }
    this.el = {};
    this.sel.clear();
    this._hooks = [];
    this.sheet = null;
    this.openMenuId = null;
  }

  /* ---------- 状态与偏好 ---------- */

  _save() {
    const st = safeStorage();
    if (!st) return;
    const s = this.state;
    try {
      st.setItem(LIB_STORAGE_KEY, JSON.stringify({
        scope: s.scope,
        folder: s.folder,
        sort: s.sort,
        viewMode: s.viewMode,
        tags: s.tags,
      }));
    } catch (e) { /* 空间不足就不存偏好，不影响主流程 */ }
  }

  /* ---------- 对外接口 ---------- */

  render() {
    if (this._destroyed || !this.root || !this.el.body) return;
    if (this.sel.size) this._pruneSelection();
    this._renderHead();
    this._renderNav();
    this._renderBody();
    this._renderLayer();
  }

  setQuery(q) {
    const next = String(q == null ? '' : q);
    if (next === this.state.query) return this;
    this.state.query = next;
    return this._afterFilterChange();
  }

  setFolder(id) {
    const next = id || null;
    if (next === this.state.folder) return this;
    this.state.folder = next;
    if (next) this.state.scope = 'all';
    this._save();
    return this._afterFilterChange();
  }

  setScope(scope) {
    const next = ['all', 'fav', 'trash'].includes(scope) ? scope : 'all';
    if (next === this.state.scope) return this;
    this.state.scope = next;
    if (next === 'trash') this._exitSelect();
    this._save();
    return this._afterFilterChange();
  }

  setSort(sort) {
    if (!SORTS.some((s) => s.id === sort) || sort === this.state.sort) return this;
    this.state.sort = sort;
    this._save();
    return this._afterFilterChange();
  }

  setViewMode(mode) {
    const next = mode === 'list' ? 'list' : 'grid';
    if (next === this.state.viewMode) return this;
    this.state.viewMode = next;
    this._save();
    return this.render();
  }

  /* ---------- 取数 ---------- */

  get scope() { return this.state.scope; }
  get query() { return this.state.query; }
  get folder() { return this.state.folder; }
  get sort() { return this.state.sort; }
  get viewMode() { return this.state.viewMode; }
  get tags() { return this.state.tags.slice(); }

  getList() {
    const s = this.state;
    if (!this.store || typeof this.store.notebooks !== 'function') return [];
    const list = this.store.notebooks({
      trash: s.scope === 'trash',
      fav: s.scope === 'fav',
      folder: s.folder,
      q: s.query,
      tags: s.tags,
    }) || [];
    return s.scope === 'trash' ? orderOf(list, s.sort) : list;
  }

  getStats() {
    const base = this.store && typeof this.store.stats === 'function'
      ? this.store.stats()
      : { notebooks: 0, pages: 0, bytes: 0 };
    const bytes = (Number(base.bytes) || 0) > 0
      ? Number(base.bytes)
      : utf8Len(this.store && typeof this.store.exportJSON === 'function' ? this.store.exportJSON() : '');
    return { ...base, bytes };
  }

  getFolders() {
    return this.store && typeof this.store.folders === 'function' ? (this.store.folders() || []) : [];
  }

  getTags() {
    return this.store && typeof this.store.allTags === 'function' ? (this.store.allTags() || []) : [];
  }

  /* ---------- 顶栏 ---------- */

  _renderHead() {
    if (this.el.sub) this.el.sub.textContent = this._subtitle();
    if (!this.el.tools) return;
    const st = this.getStats();
    this.el.tools.innerHTML = `
      <label class="lib-search">
        <span class="lib-search-icon">⌕</span>
        <input type="search" data-act="query" placeholder="搜索标题、标签、文字摘要（含已 OCR 的手写）" value="${bkEsc(this.state.query)}" aria-label="搜索笔记本">
      </label>
      <select class="lib-select" data-act="sort" aria-label="排序方式">
        ${SORTS.map((o) => `<option value="${o.id}"${o.id === this.state.sort ? ' selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <div class="lib-seg" role="group" aria-label="视图切换">
        <button type="button" class="${this.state.viewMode === 'grid' ? 'on' : ''}" data-act="view" data-mode="grid" title="网格视图">${ICON.grid}</button>
        <button type="button" class="${this.state.viewMode === 'list' ? 'on' : ''}" data-act="view" data-mode="list" title="列表视图">${ICON.list}</button>
      </div>
      <button type="button" class="lib-btn${this.selecting ? ' on' : ''}" data-act="select-mode">多选${this.sel.size ? ` ${this.sel.size}` : ''}</button>
      <button type="button" class="lib-btn primary" data-act="new">＋ 新建笔记本</button>
      <button type="button" class="lib-btn icon" data-act="menu-top" title="备份与更多">${ICON.more}</button>
    `;
    if (this.el.head2) {
      this.el.head2.innerHTML = `
        <div class="lib-head-bar">
          <span class="lib-hint">${bkEsc(this._hint())}</span>
          <span class="lib-hint">共 ${st.pages} 页 · ${humanBytes(st.bytes)}</span>
        </div>
      `;
    }
  }

  _subtitle() {
    const st = this.getStats();
    const bits = [`${st.notebooks} 本`, `${st.pages} 页`, humanBytes(st.bytes)];
    if (st.trash) bits.push(`回收站 ${st.trash} 本`);
    const extra = this._isFiltering() ? [`筛选出 ${this.getList().length} 本`] : [];
    return [...bits, ...extra].join(' · ');
  }

  _hint() {
    const s = this.state;
    if (s.scope === 'trash') return '回收站里的笔记本 30 天后自动清理，删掉就找不回来了。';
    if (s.scope === 'fav') return '收藏的笔记本都在这儿，点封面右上角的星标取消收藏。';
    if (s.folder) {
      const f = this.getFolders().find((x) => x.id === s.folder);
      return `正在看文件夹「${f ? f.name : '已删除的文件夹'}」。`;
    }
    return '点封面打开笔记本，长按或点 ⋯ 可以改封面、复制、移入文件夹。';
  }

  _isFiltering() {
    return !!(this.state.query || this.state.folder || this.state.tags.length || this.state.scope !== 'all');
  }

  /* ---------- 导航 ---------- */

  _renderNav() {
    const nav = this.el.nav;
    if (!nav) return;
    const st = this.getStats();
    const s = this.state;
    const folders = this.getFolders();
    const tags = this.getTags();
    const tab = (id, label, extra = '') => `
      <button type="button" class="lib-tab${s.scope === id ? ' on' : ''}" data-act="scope" data-scope="${id}">
        <span class="lib-tab-name">${label}</span>${extra ? `<span class="lib-tab-count">${extra}</span>` : ''}
      </button>`;

    nav.innerHTML = `
      <div class="lib-nav-block">
        ${tab('all', '全部笔记本', String(st.notebooks))}
        ${tab('fav', `${ICON.star} 收藏`, '')}
        ${tab('trash', `${ICON.close} 回收站`, st.trash ? String(st.trash) : '')}
      </div>
      <div class="lib-nav-block">
        <div class="lib-nav-head"><span>文件夹</span><button type="button" class="lib-mini" data-act="folder-new">＋ 新建</button></div>
        <div class="lib-folders">
          <div class="lib-folder${!s.folder ? ' on' : ''}" data-act="folder" data-id="">
            <span class="lib-folder-name">${s.folder ? ICON.folderOpen : ICON.folder} 全部文件夹</span>
          </div>
          ${folders.map((f) => `
            <div class="lib-folder${s.folder === f.id ? ' on' : ''}" data-act="folder" data-id="${bkEsc(f.id)}">
              <span class="lib-dot" style="background:${bkEsc(f.color || '#5A6B8C')}"></span>
              <span class="lib-folder-name">${bkEsc(f.name)}</span>
              <span class="lib-folder-acts">
                <button type="button" class="lib-mini" data-act="folder-rename" data-id="${bkEsc(f.id)}" title="重命名">✎</button>
                <button type="button" class="lib-mini" data-act="folder-del" data-id="${bkEsc(f.id)}" title="删除">${ICON.close}</button>
              </span>
            </div>`).join('')}
        </div>
      </div>
      ${tags.length ? `
      <div class="lib-nav-block">
        <div class="lib-nav-head">
          <span>标签</span>
          ${s.tags.length ? `<button type="button" class="lib-mini" data-act="tags-clear">清空</button>` : ''}
        </div>
        <div class="lib-tags">
          ${tags.map((t) => `<button type="button" class="lib-tag${s.tags.includes(t.tag) ? ' on' : ''}" data-act="tag" data-tag="${bkEsc(t.tag)}">${ICON.tag} ${bkEsc(t.tag)} <i>${t.count}</i></button>`).join('')}
        </div>
      </div>` : ''}
      <div class="lib-nav-foot">
        <button type="button" class="lib-btn ghost" data-act="export">导出备份</button>
        <button type="button" class="lib-btn ghost" data-act="import">导入备份</button>
        ${this.onGoMarkdown ? '<button type="button" class="lib-btn ghost" data-act="go-md">Markdown 资料库</button>' : ''}
      </div>
    `;
  }

  /* ---------- 主区 ---------- */

  _renderBody() {
    const body = this.el.body;
    if (!body) return;
    body.dataset.view = this.state.viewMode;
    if (this.state.scope === 'trash') this._renderTrash(body);
    else this._renderLibrary(body);
  }

  _renderLibrary(body) {
    const list = this.getList();
    const filtering = this._isFiltering();
    if (!list.length) {
      body.innerHTML = filtering ? this._emptyHTML('search') : this._emptyHTML('new');
      return;
    }
    body.innerHTML = this.state.viewMode === 'list'
      ? `<div class="bk-list">${list.map((nb) => this._rowHTML(nb)).join('')}</div>`
      : `<div class="bk-grid">${list.map((nb) => this._cardHTML(nb)).join('')}</div>`;
  }

  _renderTrash(body) {
    const list = this.getList();
    if (!list.length) {
      body.innerHTML = this._emptyHTML('trash');
      return;
    }
    body.innerHTML = `
      <div class="lib-trash-head">
        <span class="lib-hint">回收站里的笔记本 ${KEEP_DAYS} 天后自动清理，删掉就找不回来了。</span>
        <button type="button" class="lib-btn danger" data-act="trash-empty">清空回收站</button>
      </div>
      <div class="bk-list">
        ${list.map((nb) => `
          <div class="bk-row trash" data-id="${bkEsc(nb.id)}" data-act="open">
            <span class="bk-row-cover" style="${bookCoverVars(nb)}" data-pattern="${bkEsc((nb.cover && nb.cover.pattern) || 'plain')}" aria-hidden="true"></span>
            <div class="bk-row-main">
              <div class="bk-title">${bkEsc(nb.title)}</div>
              <div class="bk-meta">
                <span>${nb.pages.length} 页</span>
                <span>${dayStamp(nb.trashedAt)} 移入</span>
              </div>
            </div>
            <div class="bk-row-acts">
              <button type="button" class="lib-btn" data-act="restore" data-id="${bkEsc(nb.id)}">恢复</button>
              <button type="button" class="lib-btn danger" data-act="purge" data-id="${bkEsc(nb.id)}">彻底删除</button>
            </div>
          </div>`).join('')}
      </div>
    `;
  }

  /** 网格卡片 */
  _cardHTML(nb) {
    const on = this.sel.has(nb.id);
    const tags = (nb.tags || []).slice(0, 3);
    return `
      <article class="bk-card${on ? ' on' : ''}${nb.fav ? ' fav' : ''}" data-id="${bkEsc(nb.id)}" data-act="open" title="${bkEsc(nb.title)}">
        ${this.selecting ? `<button type="button" class="bk-pick ${on ? 'on' : ''}" data-act="pick" data-id="${bkEsc(nb.id)}" aria-label="选择 ${bkEsc(nb.title)}">${on ? ICON.check : ''}</button>` : ''}
        <button type="button" class="bk-star ${nb.fav ? 'on' : ''}" data-act="fav" data-id="${bkEsc(nb.id)}" title="${nb.fav ? '取消收藏' : '收藏'}" aria-label="${nb.fav ? '取消收藏' : '收藏'}">${nb.fav ? ICON.star : ICON.starOff}</button>
        <div class="bk-cover" data-pattern="${bkEsc((nb.cover && nb.cover.pattern) || 'plain')}" style="${bookCoverVars(nb)}">
          <span class="bk-glyph">${bkEsc((nb.cover && nb.cover.glyph) || '笔')}</span>
          <span class="bk-spine" aria-hidden="true"></span>
        </div>
        <div class="bk-title">${bkEsc(nb.title)}</div>
        <div class="bk-meta">
          <span class="bk-meta-pages">${nb.pages.length} 页</span>
          <span class="bk-dot" aria-hidden="true">·</span>
          <span class="bk-meta-time">${bkEsc(relTime(nb.openedAt || nb.updatedAt))}</span>
          <button type="button" class="bk-more" data-act="menu" data-id="${bkEsc(nb.id)}" title="更多操作" aria-label="更多操作">${ICON.more}</button>
        </div>
        ${tags.length ? `<div class="bk-tags">${tags.map((t) => `<span class="bk-tag">${bkEsc(t)}</span>`).join('')}</div>` : ''}
      </article>
    `;
  }

  /** 列表行 */
  _rowHTML(nb) {
    const on = this.sel.has(nb.id);
    return `
      <div class="bk-row${on ? ' on' : ''}${nb.fav ? ' fav' : ''}" data-id="${bkEsc(nb.id)}" data-act="open">
        ${this.selecting ? `<button type="button" class="bk-pick ${on ? 'on' : ''}" data-act="pick" data-id="${bkEsc(nb.id)}" aria-label="选择 ${bkEsc(nb.title)}">${on ? ICON.check : ''}</button>` : ''}
        <span class="bk-row-cover" style="${bookCoverVars(nb)}" data-pattern="${bkEsc((nb.cover && nb.cover.pattern) || 'plain')}" aria-hidden="true"></span>
        <div class="bk-row-main">
          <div class="bk-title">${bkEsc(nb.title)}</div>
          <div class="bk-meta">
            <span class="bk-meta-pages">${nb.pages.length} 页</span>
            <span class="bk-dot" aria-hidden="true">·</span>
            <span class="bk-meta-time">${bkEsc(relTime(nb.openedAt || nb.updatedAt))}</span>
          </div>
        </div>
        <div class="bk-row-tags">${(nb.tags || []).map((t) => `<span class="bk-tag">${bkEsc(t)}</span>`).join('')}</div>
        <div class="bk-row-acts">
          <button type="button" class="bk-star ${nb.fav ? 'on' : ''}" data-act="fav" data-id="${bkEsc(nb.id)}" title="${nb.fav ? '取消收藏' : '收藏'}" aria-label="${nb.fav ? '取消收藏' : '收藏'}">${nb.fav ? ICON.star : ICON.starOff}</button>
          <button type="button" class="bk-more" data-act="menu" data-id="${bkEsc(nb.id)}" title="更多操作" aria-label="更多操作">${ICON.more}</button>
        </div>
      </div>
    `;
  }

  _emptyHTML(kind) {
    if (kind === 'search') {
      return `<div class="bk-empty">
        <div class="bk-empty-face">🔍</div>
        <h3>没找到</h3>
        <p>试试别的关键词，或者换个文件夹 / 标签看看。</p>
        <button type="button" class="lib-btn" data-act="reset-filter">清空筛选条件</button>
      </div>`;
    }
    if (kind === 'trash') {
      return `<div class="bk-empty">
        <div class="bk-empty-face">🧺</div>
        <h3>回收站是空的</h3>
        <p>删掉的笔记本会先来这儿待 30 天，随时能恢复。</p>
      </div>`;
    }
    return `<div class="bk-empty">
      <div class="bk-empty-face">📓</div>
      <h3>还没有笔记本</h3>
      <p>新建一本，挑好封面与纸张就能开始写——笔迹、形状、文字都存得住。</p>
      <button type="button" class="lib-btn primary" data-act="new">＋ 新建第一本</button>
    </div>`;
  }

  /* ---------- 弹层（sheet / 菜单 / 批量条） ---------- */

  _renderLayer() {
    const layer = this.el.layer;
    if (!layer) return;
    layer.innerHTML = `${this._sheetHTML()}${this._panelHTML()}${this._menuHTML()}${this._selectbarHTML()}`;
  }

  /** 附加面板（线上笔记本 / 模板库） */
  _panelHTML() {
    if (!this._panel) return '';
    if (this._panel.kind === 'remote') return this.remoteHTML();
    if (this._panel.kind === 'templates') {
      return `<div class="lib-sheet-mask" data-act="panel-close"><div class="lib-sheet" data-stop="1">${this._sheetTemplates()}</div></div>`;
    }
    return '';
  }

  _sheetHTML() {
    const sh = this.sheet;
    if (!sh) return '';
    const builder = {
      new: () => this._sheetNewBook(),
      cover: () => this._sheetCover(),
      move: () => this._sheetFolderPick(sh.data),
      tag: () => this._sheetTagPick(sh.data),
      folder: () => this._sheetFolderName(sh.data),
      prompt: () => this._sheetConfirm(sh.data),
      exportPdf: () => this._sheetExportPdf(),
    }[sh.type];
    if (!builder) return '';
    return `<div class="lib-sheet-mask" data-act="sheet-close">
      <div class="lib-sheet" data-role="sheet">${builder()}</div>
    </div>`;
  }

  _menuHTML() {
    const m = this._menu;
    if (!m) return '';
    const items = this._menuItems(m.id);
    if (!items.length) return '';
    return `<div class="lib-menu" style="left:${Math.round(m.x)}px;top:${Math.round(m.y)}px" data-role="menu">
      ${items.map((it) => (it === '-' ? '<hr>' : `<button type="button" class="${it.danger ? 'danger' : ''}" data-act="menu-run" data-run="${it.run}" data-id="${bkEsc(m.id)}">${it.label}</button>`)).join('')}
    </div>`;
  }

  _menuItems(id) {
    const nb = this.store && typeof this.store.get === 'function' ? this.store.get(id) : null;
    if (!nb) return [];
    if (nb.trashedAt) {
      return [
        { run: 'restore', label: '恢复' },
        '-',
        { run: 'purge', label: '彻底删除', danger: true },
      ];
    }
    return [
      { run: 'open', label: '打开' },
      { run: 'fav', label: nb.fav ? '取消收藏' : '收藏' },
      '-',
      { run: 'rename', label: '重命名' },
      { run: 'cover', label: '改封面' },
      { run: 'tag', label: '加标签' },
      { run: 'folder', label: '移入文件夹' },
      { run: 'duplicate', label: '复制一本' },
      { run: 'sync-push', label: '同步到仓库' },
      { run: 'sync-pull', label: '从仓库拉取' },
      { run: 'save-template', label: '另存为模板' },
      { run: 'export-md', label: '导出 Markdown（下载）' },
      '-',
      { run: 'trash', label: '移到回收站', danger: true },
    ];
  }

  _selectbarHTML() {
    if (!this.selecting || !this.sel.size || this.state.scope === 'trash') return '';
    return `<div class="bk-select-bar" data-role="selbar">
      <span class="bk-select-count">已选 ${this.sel.size} 本</span>
      <button type="button" class="lib-btn" data-act="sel-folder">移入文件夹</button>
      <button type="button" class="lib-btn" data-act="sel-tag">加标签</button>
      <button type="button" class="lib-btn" data-act="sel-fav">收藏</button>
      <button type="button" class="lib-btn" data-act="sel-duplicate">复制</button>
      <button type="button" class="lib-btn" data-act="sel-export">导出 PDF</button>
      <button type="button" class="lib-btn danger" data-act="sel-trash">移到回收站</button>
      <button type="button" class="lib-btn ghost" data-act="sel-cancel">取消</button>
    </div>`;
  }

  /** 批量导出 PDF 的小面板（画质 + 合并 / 逐本） */
  _sheetExportPdf() {
    const n = this.sel.size;
    const q = this._exportQ || 'high';
    return `<div class="lib-sheet-head"><h3>导出 ${n} 本笔记本为 PDF</h3><button class="lib-btn ghost" type="button" data-act="sheet-close">✕</button></div>
      <div class="lib-sheet-body">
        <div class="lib-field"><span>画质</span>
          <div class="lib-row">
            ${PDF_QUALITY.map((x) => `<button type="button" class="lib-chip${q === x.id ? ' on' : ''}" data-act="export-quality" data-v="${x.id}" title="${bkEsc(x.hint)}">${bkEsc(x.label)}</button>`).join('')}
          </div>
        </div>
        <div class="lib-field"><span>输出方式</span>
          <div class="lib-row">
            <button type="button" class="lib-chip${this._exportMerge !== false ? ' on' : ''}" data-act="export-merge" data-v="1">合并成一个 PDF</button>
            <button type="button" class="lib-chip${this._exportMerge === false ? ' on' : ''}" data-act="export-merge" data-v="0">每本一个 PDF</button>
          </div>
        </div>
        <p class="lib-hint">
          导出的 PDF 会带上<b>可搜索文字层</b>：页面里的文本框按下
          ${this._exportMerge === false ? '（逐本导出时也会）' : ''}，以及已经 OCR 过的手写内容——在阅读器里 Ctrl+F 能搜到、能选中复制。
        </p>
        <div class="lib-row">
          <button type="button" class="lib-btn primary" data-act="export-run">开始导出</button>
          <span class="lib-hint" id="libExportStatus"></span>
        </div>
      </div>`;
  }

  /** 局部重绘：只更新主区与弹层，不动顶栏（避免搜索框失焦） */
  _renderLite() {
    if (this._destroyed || !this.root) return;
    this._renderBody();
    this._renderLayer();
  }

  _afterFilterChange() {
    this._renderHead();
    this._renderNav();
    if (this.state.scope === 'trash') this._exitSelect();
    return this._renderLite();
  }

  /* ---------- 新建笔记本 sheet ---------- */

  _sheetNewBook() {
    const f = this.sheet.fields;
    const tpl = paperTemplate(f.template);
    const size = paperSize(f.size);
    const groups = templateGroups();
    return `
      <div class="lib-sheet-head">
        <button type="button" class="lib-btn ghost" data-act="sheet-close">取消</button>
        <h3>新建笔记本</h3>
        <button type="button" class="lib-btn primary" data-act="nb-create">创建并打开</button>
      </div>
      <div class="lib-sheet-body">
        <div class="lib-new">
          <div class="lib-new-preview">
            <div class="bk-cover big" data-pattern="${bkEsc(f.pattern)}" style="--bk:${bkEsc(f.color)};--bk-soft:${bkEsc(f.color)}">
              <span class="bk-glyph">${bkEsc(String(f.title || '笔').trim().slice(0, 1) || '笔')}</span>
              <span class="bk-spine" aria-hidden="true"></span>
            </div>
            <div class="lib-paper-preview" data-tpl="${bkEsc(f.template)}">
              <div class="lib-paper-watermark">${bkEsc(tpl.label)}</div>
            </div>
            <div class="lib-hint">${bkEsc(size.label)} · ${size.w || 0}×${size.h || 0}</div>
          </div>
          <div class="lib-new-form">
            <label class="lib-field">
              <span>标题</span>
              <input class="lib-input" data-act="nb-title" value="${bkEsc(f.title)}" placeholder="比如：线性代数 · 第三章">
            </label>
            <div class="lib-field">
              <span>从模板开始（选模板会用它自带的纸张 / 封面 / 页数）</span>
              <div class="lib-chips">
                <button type="button" class="lib-chip${f.templateId ? '' : ' on'}" data-act="nb-tpl" data-v="">空白笔记本</button>
                ${this.store.templates().map((t) => `<button type="button" class="lib-chip${f.templateId === t.id ? ' on' : ''}" data-act="nb-tpl" data-v="${bkEsc(t.id)}" title="${t.pages.length} 页 · ${bkEsc(paperTemplate((t.paper || {}).template || 'lined').label)}${t.builtin ? ' · 内置' : ''}">${bkEsc(t.name)}${t.builtin ? '' : ' · 我的'}</button>`).join('')}
              </div>
            </div>
            <div class="lib-field">
              <span>封面颜色</span>
              <div class="lib-swatches">
                ${COVER_COLORS.map((c) => `<button type="button" class="lib-swatch${f.color === c ? ' on' : ''}" data-act="nb-color" data-v="${bkEsc(c)}" style="--bk:${bkEsc(c)}" title="${bkEsc(c)}" aria-label="封面颜色 ${bkEsc(c)}"></button>`).join('')}
              </div>
            </div>
            <div class="lib-field">
              <span>封面花纹</span>
              <div class="lib-chips">
                ${COVER_PATTERNS.map((p) => `<button type="button" class="lib-chip${f.pattern === p.id ? ' on' : ''}" data-act="nb-pattern" data-v="${bkEsc(p.id)}">${bkEsc(p.label)}</button>`).join('')}
              </div>
            </div>
            <div class="lib-field">
              <span>纸张模板</span>
              <div class="lib-template-groups">
                ${groups.map((g) => `
                  <div class="lib-template-group">
                    <div class="lib-template-group-name">${bkEsc(g.group)}</div>
                    <div class="lib-template-grid">
                      ${g.list.map((t) => `<button type="button" class="lib-template-card${f.template === t.id ? ' on' : ''}" data-act="nb-template" data-v="${bkEsc(t.id)}" title="${bkEsc(t.label)}">
                        <span class="lib-paper-mini" data-tpl="${bkEsc(t.id)}"></span>
                        <span class="lib-template-name">${bkEsc(t.label)}</span>
                      </button>`).join('')}
                    </div>
                  </div>`).join('')}
              </div>
            </div>
            <div class="lib-field">
              <span>纸张颜色</span>
              <div class="lib-swatches">
                ${PAPER_COLORS.map((c) => `<button type="button" class="lib-swatch paper${f.paperColor === c.value ? ' on' : ''}" data-act="nb-paper-color" data-v="${bkEsc(c.value)}" style="--bk:${bkEsc(c.value)}" title="${bkEsc(c.label)}" aria-label="纸张颜色 ${bkEsc(c.label)}"></button>`).join('')}
              </div>
            </div>
            <div class="lib-field">
              <span>尺寸</span>
              <div class="lib-chips">
                ${PAPER_SIZES.map((z) => `<button type="button" class="lib-chip${f.size === z.id ? ' on' : ''}" data-act="nb-size" data-v="${bkEsc(z.id)}">${bkEsc(z.label)}</button>`).join('')}
              </div>
            </div>
            <div class="lib-hint">标题首字会自动成为封面上的那个大字，之后也能改。</div>
          </div>
        </div>
      </div>
    `;
  }

  /* ---------- 改封面 sheet ---------- */

  _sheetCover() {
    const f = this.sheet.fields;
    return `
      <div class="lib-sheet-head">
        <button type="button" class="lib-btn ghost" data-act="sheet-close">取消</button>
        <h3>改封面</h3>
        <button type="button" class="lib-btn primary" data-act="cover-save">保存</button>
      </div>
      <div class="lib-sheet-body">
        <div class="lib-new">
          <div class="lib-new-preview">
            <div class="bk-cover big" data-pattern="${bkEsc(f.pattern)}" style="--bk:${bkEsc(f.color)};--bk-soft:${bkEsc(f.color)}">
              <span class="bk-glyph">${bkEsc(f.glyph || '笔')}</span>
              <span class="bk-spine" aria-hidden="true"></span>
            </div>
          </div>
          <div class="lib-new-form">
            <label class="lib-field">
              <span>封面字</span>
              <input class="lib-input" data-act="cover-glyph" maxlength="1" value="${bkEsc(f.glyph || '')}" placeholder="一个字">
            </label>
            <div class="lib-field">
              <span>封面颜色</span>
              <div class="lib-swatches">
                ${COVER_COLORS.map((c) => `<button type="button" class="lib-swatch${f.color === c ? ' on' : ''}" data-act="cover-color" data-v="${bkEsc(c)}" style="--bk:${bkEsc(c)}" title="${bkEsc(c)}" aria-label="封面颜色 ${bkEsc(c)}"></button>`).join('')}
              </div>
            </div>
            <div class="lib-field">
              <span>封面花纹</span>
              <div class="lib-chips">
                ${COVER_PATTERNS.map((p) => `<button type="button" class="lib-chip${f.pattern === p.id ? ' on' : ''}" data-act="cover-pattern" data-v="${bkEsc(p.id)}">${bkEsc(p.label)}</button>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /* ---------- 选择类 sheet ---------- */

  _sheetFolderPick(data) {
    const ids = (data && data.ids) || [];
    const folders = this.getFolders();
    return `
      <div class="lib-sheet-head">
        <button type="button" class="lib-btn ghost" data-act="sheet-close">取消</button>
        <h3>移入文件夹（${ids.length} 本）</h3>
        <span></span>
      </div>
      <div class="lib-sheet-body">
        <div class="lib-picker">
          <button type="button" class="lib-pick-row" data-act="move-apply" data-folder="">
            <span class="lib-folder-name">${ICON.folderOpen} 移出文件夹（不归属）</span>
          </button>
          ${folders.map((f) => `
            <button type="button" class="lib-pick-row" data-act="move-apply" data-folder="${bkEsc(f.id)}">
              <span class="lib-dot" style="background:${bkEsc(f.color || '#5A6B8C')}"></span>
              <span class="lib-folder-name">${bkEsc(f.name)}</span>
            </button>`).join('')}
          <div class="lib-pick-new">
            <input class="lib-input" data-act="folder-new-name" placeholder="新文件夹名字">
            <button type="button" class="lib-btn" data-act="move-new-folder">新建并移入</button>
          </div>
        </div>
      </div>
    `;
  }

  _sheetTagPick(data) {
    const ids = (data && data.ids) || [];
    const tags = this.getTags();
    return `
      <div class="lib-sheet-head">
        <button type="button" class="lib-btn ghost" data-act="sheet-close">取消</button>
        <h3>加标签（${ids.length} 本）</h3>
        <span></span>
      </div>
      <div class="lib-sheet-body">
        <div class="lib-picker">
          <div class="lib-pick-new">
            <input class="lib-input" data-act="tag-new-name" placeholder="标签名字，比如：期末复习">
            <button type="button" class="lib-btn primary" data-act="tag-apply">加标签</button>
          </div>
          ${tags.length ? `
            <div class="lib-hint">已有标签（点一下直接用）</div>
            <div class="lib-tags">
              ${tags.map((t) => `<button type="button" class="lib-tag" data-act="tag-quick" data-tag="${bkEsc(t.tag)}">${ICON.tag} ${bkEsc(t.tag)} <i>${t.count}</i></button>`).join('')}
            </div>` : '<div class="lib-hint">还没有标签，在上面输入一个就行。</div>'}
        </div>
      </div>
    `;
  }

  _sheetFolderName(data) {
    const d = data || {};
    return `
      <div class="lib-sheet-head">
        <button type="button" class="lib-btn ghost" data-act="sheet-close">取消</button>
        <h3>${d.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}</h3>
        <button type="button" class="lib-btn primary" data-act="folder-save">${d.mode === 'rename' ? '保存' : '创建'}</button>
      </div>
      <div class="lib-sheet-body">
        <label class="lib-field">
          <span>文件夹名字</span>
          <input class="lib-input" data-act="folder-name" value="${bkEsc(d.value || '')}" placeholder="比如：高等数学">
        </label>
      </div>
    `;
  }

  _sheetConfirm(data) {
    const d = data || {};
    return `
      <div class="lib-sheet-head">
        <button type="button" class="lib-btn ghost" data-act="sheet-close">取消</button>
        <h3>${bkEsc(d.title || '确认')}</h3>
        <button type="button" class="lib-btn danger" data-act="confirm-yes">${bkEsc(d.yes || '确认')}</button>
      </div>
      <div class="lib-sheet-body">
        <p class="lib-hint">${bkEsc(d.text || '')}</p>
      </div>
    `;
  }

  /* ============================ 事件 ============================ */

  _onClick(e) {
    if (this._destroyed) return;
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (!this.root || !this.root.contains(t)) return;
    const hit = t.closest('[data-act]');
    if (!hit) return;
    const act = hit.dataset.act;
    const id = hit.dataset.id || '';
    const row = typeof hit.closest === 'function' ? hit.closest('[data-id]') : null;
    const rowId = id || (row ? row.dataset.id : '');
    const stop = ['fav', 'menu', 'pick', 'star', 'restore', 'purge', 'trash-empty'];
    if (stop.includes(act)) e.stopPropagation();

    switch (act) {
      /* 顶栏 */
      case 'query': break;                       // 输入框交给 input 事件
      case 'view': this.setViewMode(hit.dataset.mode); break;
      case 'select-mode':
        this.selecting = !this.selecting;
        if (!this.selecting) this.sel.clear();
        this.render();
        break;
      case 'new': this.openNewSheet(); break;
      case 'menu-top': this._toggleMenu('', hit); break;
      case 'menu': this._toggleMenu(rowId, hit); break;
      case 'menu-run': this._runMenu(hit.dataset.run, rowId); break;

      /* 导航 */
      case 'scope': this.setScope(hit.dataset.scope); break;
      case 'folder': this.setFolder(hit.dataset.id || null); break;
      case 'folder-new': this.openFolderSheet('new'); break;
      case 'folder-rename': e.stopPropagation(); this.openFolderSheet('rename', hit.dataset.id); break;
      case 'folder-del': e.stopPropagation(); this._deleteFolder(hit.dataset.id); break;
      case 'tag': this._toggleTag(hit.dataset.tag); break;
      case 'tags-clear': this.state.tags = []; this._save(); this._afterFilterChange(); break;
      case 'reset-filter':
        this.state.query = '';
        this.state.folder = null;
        this.state.tags = [];
        this.state.scope = 'all';
        this._save();
        this.render();
        break;
      case 'go-md': if (this.onGoMarkdown) this.onGoMarkdown(); break;
      case 'export': this.exportBackup(); break;
      case 'import': this.importBackup(); break;
      case 'panel-close': this._panel = null; this._renderLayer(); break;
      case 'tpl-del':
        e.stopPropagation();
        if (this.store.removeTemplate(rowId)) { this.toast('模板已删除'); this._renderLayer(); }
        break;
      case 'remote-import': e.stopPropagation(); this.importRemote(rowId); break;
      case 'sel-export':
        if (!this.sel.size) { this.toast('先勾选要导出的笔记本'); break; }
        this.sheet = { type: 'exportPdf', data: {} };
        this._renderLayer();
        break;
      case 'export-quality': this._exportQ = hit.dataset.v || 'high'; this._renderLayer(); break;
      case 'export-merge': this._exportMerge = hit.dataset.v !== '0'; this._renderLayer(); break;
      case 'export-run': this.runBulkExport(); break;

      /* 卡片与行 */
      case 'open': if (!this.selecting && this.state.scope !== 'trash') this.openBook(rowId); break;
      case 'pick': this._pick(rowId); break;
      case 'fav': this._toggleFav(rowId); break;
      case 'restore': this._restore([rowId]); break;
      case 'purge': this._purgeConfirm(rowId); break;
      case 'trash-empty': this._emptyTrashConfirm(); break;

      /* 批量操作条 */
      case 'sel-cancel': this._exitSelect(); break;
      case 'sel-folder': this.openMoveSheet([...this.sel]); break;
      case 'sel-tag': this.openTagSheet([...this.sel]); break;
      case 'sel-fav': this._selFav(); break;
      case 'sel-duplicate': this._selDuplicate(); break;
      case 'sel-trash': this._selTrash(); break;

      /* sheet */
      case 'sheet-close': if (t === hit) this.closeSheet(); break;
      case 'nb-color': this._sheetField('color', hit.dataset.v); break;
      case 'nb-tpl': this._sheetField('templateId', hit.dataset.v || ''); break;
      case 'nb-pattern': this._sheetField('pattern', hit.dataset.v); break;
      case 'nb-template': this._sheetField('template', hit.dataset.v); break;
      case 'nb-paper-color': this._sheetField('paperColor', hit.dataset.v); break;
      case 'nb-size': this._sheetField('size', hit.dataset.v); break;
      case 'nb-create': this._createBook(); break;
      case 'cover-color': this._sheetField('color', hit.dataset.v); break;
      case 'cover-pattern': this._sheetField('pattern', hit.dataset.v); break;
      case 'cover-save': this._saveCover(); break;
      case 'move-apply': this._applyMove([...(this.sheet && this.sheet.data ? this.sheet.data.ids : [])], hit.dataset.folder || null); break;
      case 'move-new-folder': this._moveToNewFolder(); break;
      case 'tag-apply': this._applyTag(this._tagInputValue(), [...(this.sheet && this.sheet.data ? this.sheet.data.ids : [])]); break;
      case 'tag-quick': this._applyTag(hit.dataset.tag, [...(this.sheet && this.sheet.data ? this.sheet.data.ids : [])]); break;
      case 'folder-save': this._saveFolderSheet(); break;
      case 'confirm-yes': {
        const fn = this.sheet && this.sheet.data ? this.sheet.data.onYes : null;
        this.closeSheet();
        if (typeof fn === 'function') { try { fn(); } catch (err) { this._fail(err); } }
        break;
      }
      default: break;
    }
  }

  _onInput(e) {
    if (this._destroyed) return;
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.act === 'query') {
      this.state.query = t.value;
      // 记住光标位置：只重绘主区，不重建搜索框
      const pos = t.selectionStart;
      this._renderBody();
      this._renderLayer();
      if (document.activeElement !== t) {
        try { t.focus(); t.setSelectionRange(pos, pos); } catch (err) { /* 某些浏览器不允许 */ }
      }
      if (this.el.sub) this.el.sub.textContent = this._subtitle();
    }
  }

  _onChange(e) {
    if (this._destroyed) return;
    const t = e.target;
    if (t && t.dataset && t.dataset.act === 'sort') this.setSort(t.value);
  }

  _onKeydown(e) {
    if (this._destroyed) return;
    if (e.key !== 'Escape') return;
    if (this._menu) { this._menu = null; this._renderLayer(); }
    else if (this.sheet) this.closeSheet();
    else if (this.selecting) this._exitSelect();
  }

  /* ---------- 动作实现 ---------- */

  openBook(id) {
    if (!id) return;
    const nb = this.store && typeof this.store.get === 'function' ? this.store.get(id) : null;
    if (!nb) return;
    if (typeof this.store.open === 'function') {
      try { this.store.open(id); } catch (err) { this._fail(err); }
    }
    for (const fn of this._hooks.slice()) {
      try { fn(id); } catch (err) { this._fail(err); }
    }
    this.onOpen(id);
  }

  openNewSheet() {
    this._menu = null;
    const idx = this.getStats().notebooks % COVER_COLORS.length;
    this.sheet = {
      type: 'new',
      fields: {
        title: '',
        color: COVER_COLORS[idx],
        pattern: 'plain',
        template: 'lined',
        paperColor: '#FFFFFF',
        size: 'a4',
        templateId: '',
      },
    };
    this._renderLayer();
  }

  openFolderSheet(mode, id) {
    this._menu = null;
    const f = mode === 'rename' ? this.getFolders().find((x) => x.id === id) : null;
    this.sheet = {
      type: 'folder',
      data: { mode, id: id || '', value: f ? f.name : '' },
    };
    this._renderLayer();
    this._focusSheetInput('folder-name');
  }

  openMoveSheet(ids = []) {
    if (!ids.length) return;
    this._menu = null;
    this.sheet = { type: 'move', data: { ids } };
    this._renderLayer();
  }

  openTagSheet(ids = []) {
    if (!ids.length) return;
    this._menu = null;
    this.sheet = { type: 'tag', data: { ids } };
    this._renderLayer();
    this._focusSheetInput('tag-new-name');
  }

  openCoverSheet(id) {
    const nb = this.store && typeof this.store.get === 'function' ? this.store.get(id) : null;
    if (!nb) return;
    this._menu = null;
    this.sheet = {
      type: 'cover',
      data: { id },
      fields: {
        color: (nb.cover && nb.cover.color) || COVER_COLORS[0],
        pattern: (nb.cover && nb.cover.pattern) || 'plain',
        glyph: (nb.cover && nb.cover.glyph) || String(nb.title || '笔').slice(0, 1),
      },
    };
    this._renderLayer();
  }

  openConfirm(title, text, yes, onYes) {
    this._menu = null;
    this.sheet = { type: 'prompt', data: { title, text, yes, onYes } };
    this._renderLayer();
  }

  closeSheet() {
    if (!this.sheet) return;
    this.sheet = null;
    this._renderLayer();
  }

  _reopenSheet() {
    if (!this.sheet) return;
    this._renderLayer();
  }

  _focusSheetInput(act) {
    const layer = this.el.layer;
    if (!layer || typeof layer.querySelector !== 'function') return;
    const inp = layer.querySelector(`[data-act="${act}"]`);
    if (inp && inp.focus) {
      try { inp.focus(); } catch (e) { /* 忽略 */ }
    }
  }

  _sheetField(key, value) {
    if (!this.sheet || !this.sheet.fields) return;
    this.sheet.fields[key] = value;
    this._reopenSheet();
  }

  _toggleMenu(id, anchor) {
    if (this._menu && this._menu.id === id) {
      this._menu = null;
      this._renderLayer();
      return;
    }
    let x = 8;
    let y = 8;
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const r = anchor.getBoundingClientRect();
      const vw = typeof window !== 'undefined' ? (window.innerWidth || 1024) : 1024;
      const vh = typeof window !== 'undefined' ? (window.innerHeight || 768) : 768;
      const w = 200;
      const h = Math.max(140, this._menuItems(id || 'top').length * 36 + 16);
      x = Math.min(Math.max(8, r.right - w), Math.max(8, vw - w - 12));
      y = r.bottom + h + 12 > vh ? Math.max(8, r.top - h - 8) : r.bottom + 8;
    }
    this._menu = { id, x, y };
    // 「⋯」在顶栏时挂一个虚拟菜单（备份 / 切回 Markdown）
    if (!id) this._menu = { id: '__top', x, y };
    this._renderLayer();
  }

  _menuItemsTop() {
    const items = [
      { run: 'export', label: '导出备份（下载 JSON）' },
      { run: 'import', label: '导入备份（选择文件）' },
      { run: 'sync-all', label: '全部同步到仓库' },
      { run: 'sync-pull-all', label: '从仓库拉取线上更新' },
      { run: 'remote', label: '看线上笔记本（免令牌）' },
      { run: 'templates', label: '模板库…' },
    ];
    if (this.onGoMarkdown) items.push('-', { run: 'go-md', label: '切回 Markdown 资料库' });
    return items;
  }

  _runMenu(run, id) {
    this._menu = null;
    this._renderLayer();
    if (id === '__top') {
      if (run === 'export') this.exportBackup();
      else if (run === 'import') this.importBackup();
      else if (run === 'sync-all') this.syncAll();
      else if (run === 'sync-pull-all') this.syncPullAll();
      else if (run === 'remote') this.openRemote();
      else if (run === 'templates') { this._panel = { kind: 'templates' }; this._renderLayer(); }
      else if (run === 'go-md' && this.onGoMarkdown) this.onGoMarkdown();
      return;
    }
    if (!id) return;
    if (run === 'open') this.openBook(id);
    if (run === 'sync-push') this.syncOne(id);
    if (run === 'sync-pull') this.syncPullOne(id);
    if (run === 'save-template') this.saveTemplateFrom(id);
    if (run === 'export-md') this.exportMarkdown(id);
    else if (run === 'fav') this._toggleFav(id);
    else if (run === 'rename') this._renameBook(id);
    else if (run === 'cover') this.openCoverSheet(id);
    else if (run === 'tag') this.openTagSheet([id]);
    else if (run === 'folder') this.openMoveSheet([id]);
    else if (run === 'duplicate') this._duplicate([id]);
    else if (run === 'trash') this._trash([id]);
    else if (run === 'restore') this._restore([id]);
    else if (run === 'purge') this._purgeConfirm(id);
  }

  _fail(err) {
    this.toast(err && err.message ? err.message : '操作没成功，再试一次');
  }

  /* ---------- 选中态 ---------- */

  _pick(id) {
    if (!id) return;
    if (this.sel.has(id)) this.sel.delete(id);
    else this.sel.add(id);
    if (!this.sel.size) this.selecting = false;
    this._renderHead();
    this._renderLite();
  }

  _pruneSelection() {
    const live = new Set((this.store && this.store.data ? this.store.data.notebooks : []).map((n) => n.id));
    for (const id of [...this.sel]) if (!live.has(id)) this.sel.delete(id);
    if (!this.sel.size) this.selecting = false;
  }

  _exitSelect() {
    this.selecting = false;
    this.sel.clear();
    this._renderHead();
    this._renderLite();
  }

  /* ---------- 单本操作 ---------- */

  _toggleFav(id) {
    const nb = this.store && typeof this.store.get === 'function' ? this.store.get(id) : null;
    if (!nb) return;
    try {
      const out = this.store.setFav(id);
      const on = out ? out.fav : !nb.fav;
      this.toast(on ? '已收藏' : '已取消收藏');
      this.render();
    } catch (err) { this._fail(err); }
  }

  _renameBook(id) {
    const nb = this.store.get(id);
    if (!nb) return;
    let name = null;
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
      name = window.prompt('笔记本标题', nb.title);
    }
    if (name == null) name = nb.title;
    const clean = String(name).trim();
    if (!clean) return;
    try {
      this.store.update(id, { title: clean });
      this.toast('标题已改');
      this.render();
    } catch (err) { this._fail(err); }
  }

  _saveCover() {
    const sh = this.sheet;
    if (!sh || !sh.data || !sh.fields) return;
    try {
      this.store.update(sh.data.id, {
        cover: { color: sh.fields.color, pattern: sh.fields.pattern, glyph: String(sh.fields.glyph || '笔').slice(0, 1) || '笔' },
      });
      this.closeSheet();
      this.toast('封面已更新');
      this.render();
    } catch (err) { this._fail(err); }
  }

  _duplicate(ids) {
    const made = [];
    for (const id of ids) {
      try { const c = this.store.duplicate(id); if (c) made.push(c); } catch (err) { this._fail(err); }
    }
    if (made.length) this.toast(made.length === 1 ? `已复制：${made[0].title}` : `已复制 ${made.length} 本`);
    this.render();
  }

  _trash(ids) {
    let n = 0;
    for (const id of ids) {
      try { if (this.store.trash(id)) n++; } catch (err) { this._fail(err); }
    }
    if (n) this.toast(n === 1 ? '已移到回收站' : `已把 ${n} 本移到回收站`);
    this.sel.clear();
    this.selecting = false;
    this.render();
  }

  _restore(ids) {
    let n = 0;
    for (const id of ids) {
      try { if (this.store.restore(id)) n++; } catch (err) { this._fail(err); }
    }
    if (n) this.toast(n === 1 ? '已恢复' : `已恢复 ${n} 本`);
    this.render();
  }

  _purgeConfirm(id) {
    const nb = this.store.get(id);
    if (!nb) return;
    this.openConfirm('彻底删除', `「${nb.title}」会被永久删除，笔迹与页面一起没了，无法恢复。`, '彻底删除', () => {
      try {
        this.store.purge(id);
        this.toast('已彻底删除');
        this.render();
      } catch (err) { this._fail(err); }
    });
  }

  _emptyTrashConfirm() {
    const n = this.getStats().trash;
    if (!n) return;
    this.openConfirm('清空回收站', `回收站里的 ${n} 本笔记本会被永久删除，无法恢复。`, '清空', () => {
      try {
        const removed = this.store.emptyTrash();
        this.toast(`已清空回收站（${removed} 本）`);
        this.render();
      } catch (err) { this._fail(err); }
    });
  }

  /* ---------- 批量操作 ---------- */

  _selFav() {
    const ids = [...this.sel];
    if (!ids.length) return;
    for (const id of ids) {
      try { this.store.setFav(id, true); } catch (err) { this._fail(err); }
    }
    this.toast(`已收藏 ${ids.length} 本`);
    this.render();
  }

  _selDuplicate() {
    const ids = [...this.sel];
    if (!ids.length) return;
    let n = 0;
    for (const id of ids) {
      try { if (this.store.duplicate(id)) n++; } catch (err) { this._fail(err); }
    }
    this.toast(`已复制 ${n} 本`);
    this.render();
  }

  _selTrash() {
    const ids = [...this.sel];
    if (!ids.length) return;
    this.openConfirm('移到回收站', `把选中的 ${ids.length} 本移到回收站？30 天内都能恢复。`, '移到回收站', () => this._trash(ids));
  }

  _applyMove(ids, folderId) {
    let n = 0;
    for (const id of ids) {
      try { if (this.store.moveToFolder(id, folderId)) n++; } catch (err) { this._fail(err); }
    }
    const f = folderId ? this.getFolders().find((x) => x.id === folderId) : null;
    this.toast(folderId ? `已移入「${f ? f.name : '文件夹'}」` : '已移出文件夹');
    this.sel.clear();
    this.selecting = false;
    this.closeSheet();
    this.render();
    return n;
  }

  _moveToNewFolder() {
    const inp = this.el.layer && this.el.layer.querySelector ? this.el.layer.querySelector('[data-act="folder-new-name"]') : null;
    const name = inp ? String(inp.value || '').trim() : '';
    if (!name) { this.toast('先给文件夹起个名字'); return; }
    let f = null;
    try { f = this.store.addFolder(name); } catch (err) { this._fail(err); return; }
    this._applyMove([...(this.sheet && this.sheet.data ? this.sheet.data.ids : [])], f ? f.id : null);
  }

  _tagInputValue() {
    const layer = this.el.layer;
    if (layer && typeof layer.querySelector === 'function') {
      const inp = layer.querySelector('[data-act="tag-new-name"]');
      if (inp && inp.value) return inp.value;
    }
    if (this.sheet && this.sheet.type === 'tag') return '';
    return '';
  }

  _applyTag(tag, ids) {
    const t = String(tag || '').trim();
    if (!t) { this.toast('先输入一个标签'); return; }
    let n = 0;
    for (const id of ids) {
      try { if (this.store.addTag(id, t)) n++; } catch (err) { this._fail(err); }
    }
    this.toast(`已给 ${n} 本加上「${t}」`);
    this.sel.clear();
    this.selecting = false;
    this.closeSheet();
    this.render();
  }

  _toggleTag(tag) {
    const t = String(tag || '').trim();
    if (!t) return;
    const i = this.state.tags.indexOf(t);
    if (i >= 0) this.state.tags.splice(i, 1);
    else this.state.tags.push(t);
    this._save();
    this._afterFilterChange();
  }

  /* ---------- 文件夹 ---------- */

  _saveFolderSheet() {
    const sh = this.sheet;
    if (!sh || !sh.data) return;
    const layer = this.el.layer;
    const inp = layer && typeof layer.querySelector === 'function' ? layer.querySelector('[data-act="folder-name"]') : null;
    const name = inp ? String(inp.value || '').trim() : '';
    if (!name) { this.toast('名字不能是空的'); return; }
    try {
      if (sh.data.mode === 'rename') {
        this.store.renameFolder(sh.data.id, name);
        this.toast('文件夹名已改');
      } else {
        const f = this.store.addFolder(name);
        this.state.folder = f ? f.id : this.state.folder;
        this.state.scope = 'all';
        this._save();
        this.toast('文件夹已建好');
      }
      this.closeSheet();
      this.render();
    } catch (err) { this._fail(err); }
  }

  _deleteFolder(id) {
    const f = this.getFolders().find((x) => x.id === id);
    if (!f) return;
    const n = (this.store.data.notebooks || []).filter((x) => x.folder === id).length;
    this.openConfirm(
      '删除文件夹',
      n ? `「${f.name}」里的 ${n} 本笔记本会变成「不归属文件夹」，不会丢内容。` : `「${f.name}」是空的，删掉不影响笔记本。`,
      '删除',
      () => {
        try {
          this.store.removeFolder(id);
          if (this.state.folder === id) { this.state.folder = null; this._save(); }
          this.toast('文件夹已删除');
          this.render();
        } catch (err) { this._fail(err); }
      },
    );
  }

  /* ---------- 新建笔记本 ---------- */

  _createBook() {
    const sh = this.sheet;
    if (!sh || sh.type !== 'new') return;
    const f = sh.fields;
    const title = String(f.title || '').trim();
    if (!title) { this.toast('先给笔记本起个名字'); this._focusSheetInput('nb-title'); return; }
    let nb = null;
    try {
      if (f.templateId) {
        // 从模板新建：纸张 / 封面 / 页数 / 滚动方向都听模板的
        nb = this.store.createFromTemplate(f.templateId, {
          title,
          folder: this.state.scope === 'all' ? (this.state.folder || null) : null,
        });
        if (nb) {
          nb.cover = { ...nb.cover, glyph: title.slice(0, 1) || nb.cover.glyph };
          if (f.color) nb.cover.color = f.color;
          if (f.pattern) nb.cover.pattern = f.pattern;
          this.store.save();
        }
      } else {
        nb = this.store.create({
          title,
          cover: { color: f.color, pattern: f.pattern, glyph: title.slice(0, 1) || '笔' },
          folder: this.state.scope === 'all' ? (this.state.folder || null) : null,
          paper: { template: f.template, size: f.size, color: f.paperColor },
        });
      }
    } catch (err) { this._fail(err); return; }
    this.closeSheet();
    if (!nb) return;
    // 新本子必然不匹配当前筛选：把筛选让开，让它立刻可见
    this.state.query = '';
    this.state.tags = [];
    this.state.scope = 'all';
    this._save();
    this.render();
    this.toast(`已创建：${nb.title}`);
    this.openBook(nb.id);
  }

  /* ---------- 批量导出 PDF ---------- */

  async runBulkExport() {
    const ids = [...this.sel];
    const books = ids.map((id) => this.store.get(id)).filter(Boolean);
    if (!books.length) { this.toast('没有可导出的笔记本'); return; }
    const qualityId = this._exportQ || 'high';
    const merge = this._exportMerge !== false;
    const status = () => {
      const el = this.el && this.el.layer ? this.el.layer.querySelector('#libExportStatus') : null;
      return el;
    };
    try {
      const total = books.reduce((s, b) => s + (b.pages || []).length, 0);
      this.toast(`开始导出 ${books.length} 本（共 ${total} 页）…`);
      const res = await buildPdfFromNotebooks(books, {
        qualityId,
        merge,
        title: books.length === 1 ? books[0].title : `笔记本合集-${books.length}本`,
        onProgress: ({ done, total: tt, title }) => {
          const msg = merge ? `生成中 ${done}/${tt}…` : `导出 ${done}/${tt}：${title}`;
          this.toast(msg);
          const el = status();
          if (el) el.textContent = msg;
        },
      });
      if (res.merged) {
        downloadBlob(res.blob, `笔记本合集-${books.length}本-${qualityOf(qualityId).label.replace(/[（）]/g, '')}.pdf`);
        this.toast(`已导出合并 PDF（${res.pages} 页 · ${(res.blob.size / 1048576).toFixed(1)} MB）`);
      } else {
        for (const f of res.files) {
          downloadBlob(f.blob, `${String(f.title).replace(/[\\/:*?"<>|]+/g, '_')}.pdf`);
          await new Promise((r) => setTimeout(r, 350));   // 给浏览器一点时间逐个下载
        }
        this.toast(`已逐本导出 ${res.files.length} 个 PDF（共 ${res.pages} 页）`);
      }
      this.sheet = null;
      this.selecting = false;
      this.sel.clear();
      this.render();
    } catch (err) {
      this._fail(err);
    }
  }

  /* ---------- 模板与 Markdown 导出 ---------- */

  saveTemplateFrom(id, { withContent = false } = {}) {
    const nb = this.store.get(id);
    if (!nb) return null;
    let name = nb.title;
    try {
      if (typeof prompt === 'function') name = prompt('模板叫什么名字？（只存纸张与页面结构，不存内容）', nb.title) || nb.title;
    } catch (e) { /* prompt 被禁用也无所谓 */ }
    const t = this.store.saveAsTemplate(id, { name, withContent });
    if (t) this.toast(`已存为模板「${t.name}」：新建笔记本时可以套用`);
    return t;
  }

  exportMarkdown(id) {
    const nb = this.store.get(id);
    if (!nb) return;
    try {
      const md = notebookToMarkdown(nb);
      downloadBlob(new Blob([md], { type: 'text/markdown' }), `${markdownSlug(nb.title)}.md`);
      this.toast('已导出 Markdown（丢进 content/ 就能进全站检索）');
    } catch (err) { this._fail(err); }
  }

  /** 从选中的那本顺手存模板（批量导出面板里也能用） */
  _sheetTemplates() {
    const list = this.store.templates();
    return `<div class="lib-sheet-head"><h3>模板库</h3><button class="lib-btn ghost" type="button" data-act="panel-close">✕</button></div>
      <div class="lib-sheet-body">
        <p class="lib-hint">新建笔记本时可以选这些模板（纸张 / 封面 / 页数一起套用）。把某本笔记本「另存为模板」就会出现在这里；内置模板不能删。</p>
        ${list.map((t) => `<div class="lib-pick-row" data-id="${bkEsc(t.id)}">
          <span class="bk-row-cover" style="--bk:${bkEsc((t.cover && t.cover.color) || '#5A6B8C')}" data-pattern="${bkEsc((t.cover && t.cover.pattern) || 'plain')}" aria-hidden="true"></span>
          <span class="lib-pick-name">${bkEsc(t.name)}<i class="lib-pick-meta">${t.pages.length} 页 · ${bkEsc(paperTemplate((t.paper || {}).template || 'lined').label)}${t.builtin ? ' · 内置' : ' · 我的'}${t.withContent ? ' · 含内容' : ''}</i></span>
          ${t.builtin ? '' : `<button class="lib-btn danger" type="button" data-act="tpl-del" data-id="${bkEsc(t.id)}">删除</button>`}
        </div>`).join('')}
      </div>`;
  }

  /* ---------- 与仓库同步（笔记本也交给 git 管） ---------- */

  async syncOne(id) {
    if (!gh.configured()) { this.toast('还没配 GitHub 令牌：进任意笔记点「✎ 编辑」→ ⚙ 填一次'); return; }
    try {
      this.toast('正在推送…');
      const res = await pushNotebook(gh, this.store, id, { alsoIndex: true });
      this.toast(`已推送（${Math.max(1, Math.round(res.bytes / 1024))} KB）`);
    } catch (e) { this._fail(e); }
  }

  async syncAll() {
    if (!gh.configured()) { this.toast('还没配 GitHub 令牌：进任意笔记点「✎ 编辑」→ ⚙ 填一次'); return; }
    try {
      const total = this.getStats().notebooks;
      if (!total) { this.toast('还没有笔记本可以同步'); return; }
      this.toast(`开始推送 ${total} 本…`);
      const res = await pushAll(gh, this.store, {
        onProgress: ({ done, total: tt }) => this.toast(`推送中 ${done}/${tt}…`),
      });
      this.toast(`完成：${res.ok} 本成功${res.failed ? ` · ${res.failed} 本失败` : ''}（含线上目录）`);
      if (res.errors && res.errors.length) this.toast('第一处错误：' + res.errors[0]);
    } catch (e) { this._fail(e); }
  }

  async syncPullOne(id) {
    if (!gh.configured()) { this.toast('拉取需要 GitHub 令牌'); return; }
    try {
      const res = await pullNotebook(gh, this.store, id, {});
      if (res.action === 'pull') { this.toast(`已用仓库版本覆盖本地${res.backup ? '（旧的存成本机备份）' : ''}`); this.render(); }
      else this.toast('两边一样，或本地更新：先同步到仓库');
    } catch (e) { this._fail(e); }
  }

  async syncPullAll() {
    try {
      const remote = await fetchPublicIndex(null, this._base());
      if (!remote.length) { this.toast('线上目录是空的：先在笔记本里点「同步到仓库」'); return; }
      let pulled = 0, skipped = 0;
      for (const r of remote) {
        const local = this.store.get(r.id);
        if (!gh.configured() || !local) { skipped++; continue; }
        try {
          const res = await pullNotebook(gh, this.store, r.id, {});
          if (res.action === 'pull') pulled++;
          else skipped++;
        } catch (e) { skipped++; }
      }
      this.toast(`拉取完成：更新 ${pulled} 本${skipped ? ` · 跳过 ${skipped} 本` : ''}`);
      if (!gh.configured()) this.toast('线上目录已读到，但要真正拉取需要令牌；也可以用「看线上笔记本」只读导入');
      this.render();
    } catch (e) { this._fail(e); }
  }

  /** 免令牌：列出线上笔记本（读 docs/notebooks/index.json），可一键导入到本地 */
  async openRemote() {
    const remote = await fetchPublicIndex(null, this._base());
    if (!remote.length) { this.toast('线上还没有笔记本（先在笔记本里点「同步到仓库」，约 1 分钟后线上可见）'); return; }
    this._remote = remote;
    this._panel = { kind: 'remote' };
    this._renderLayer();
  }

  async importRemote(id) {
    try {
      const res = await pullFromPublicSite(this.store, id, null, this._base());
      this._panel = null;
      this._renderLayer();
      this.render();
      this.toast(`已导入「${res.notebook.title}」${res.renamed ? '（本地已有同名，存成副本）' : ''}`);
    } catch (e) { this._fail(e); }
  }

  remoteHTML() {
    const list = this._remote || [];
    return `<div class="lib-sheet-mask" data-act="panel-close">
      <div class="lib-sheet" data-stop="1">
        <div class="lib-sheet-head"><h3>线上笔记本（免令牌只读）</h3><button class="lib-btn ghost" type="button" data-act="panel-close">✕</button></div>
        <div class="lib-sheet-body">
          <p class="lib-hint">这些是仓库 docs/notebooks/ 里已发布的笔记本，任何设备打开这个网页都能看到。点「导入到本地」会复制一份到这台设备（不会覆盖本地已有的）。</p>
          ${list.map((r) => `<div class="lib-pick-row" data-id="${bkEsc(r.id)}">
            <span class="bk-row-cover" style="--bk:${bkEsc((r.cover && r.cover.color) || '#5A6B8C')}" data-pattern="${bkEsc((r.cover && r.cover.pattern) || 'plain')}" aria-hidden="true"></span>
            <span class="lib-pick-name">${bkEsc(r.title)}<i class="lib-pick-meta">${r.pages} 页 · ${r.ocr || 0} 页已识别 · ${relTime(r.updatedAt)}</i></span>
            <button class="lib-btn primary" type="button" data-act="remote-import" data-id="${bkEsc(r.id)}">导入到本地</button>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  /** 线上资源基地址（Pages 下 docs/ 就是站点根） */
  _base() {
    try {
      if (typeof location === 'undefined') return '';
      const p = location.pathname || '/';
      return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1);
    } catch (e) { return ''; }
  }

  /* ---------- 备份 ---------- */

  exportBackup() {
    let text = '';
    try {
      text = this.store.exportJSON();
    } catch (err) { this._fail(err); return; }
    const n = this.getStats().notebooks;
    if (typeof document === 'undefined') return;
    let url = '';
    try {
      const blob = new Blob([text], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `笔记本备份-${dayStamp(Date.now())}.json`;
      if (document.body) document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
      this.toast(`已导出备份（${n} 本）`);
    } catch (err) {
      this._fail(err);
    } finally {
      if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } }, 2000);
    }
  }

  importBackup() {
    if (typeof document === 'undefined') return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const r = this.store.importJSON(String(reader.result || ''));
          this.render();
          this.toast(`已导入 ${r.notebooks} 本${r.folders ? ` · ${r.folders} 个文件夹` : ''}${r.renamed ? `（${r.renamed} 本重名已另存）` : ''}`);
        } catch (err) {
          this.toast(err && err.message ? err.message : '导入失败：文件读不懂');
        }
      };
      reader.onerror = () => this.toast('导入失败：文件没读出来');
      reader.readAsText(file);
    }, { once: true });
    if (document.body) document.body.appendChild(inp);
    inp.click();
    setTimeout(() => { if (inp.parentNode) inp.parentNode.removeChild(inp); }, 0);
  }
}

export default LibraryUI;
