/**
 * 笔记站主应用 v2
 * 界面语言：资料库（网格笔记本 + 横向书架）+ 笔记本（正文）+ 速览浮层 + 上下文菜单
 */
import { buildIndex, search, hlMark as highlight } from './search.js';
import { highlightAll, escapeHtml } from './highlight.js';
import { createGraph } from './graph.js';
import { Editor, gh, ink as inkApi } from './editor.mjs';
import { InkLayer } from './ink.mjs';
import { InstallGuide, isStandalone } from './install.mjs';
import { NotebookStore, excerptAround } from './notebook/store.mjs';
import { renderPage as renderBookPage } from './notebook/page.mjs';
import { paperDims } from './notebook/paper.mjs';
import { LibraryUI } from './notebook/library.mjs';
import { NotebookView } from './notebook/viewer.mjs';
import { renderDocument as renderDoc } from '../lib/markdown.mjs';
import { applyEdit } from '../lib/site-build.mjs';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// 离线便携版：附件与图片需要指回项目里的 docs/ 目录
const portableAssets = (typeof window !== 'undefined' && window.__NOTES_ASSET_PREFIX__) || '';

/** 便携版专用：把正文里的 assets/... 引用改写成可双击打开的相对路径 */
function fixAssets(root) {
  if (!portableAssets || !root) return;
  root.querySelectorAll('img[src], a[href]').forEach((el) => {
    const attr = el.tagName === 'IMG' ? 'src' : 'href';
    const v = el.getAttribute(attr) || '';
    if (/^(https?:|data:|mailto:|#|\.\.\/)/.test(v)) return;
    el.setAttribute(attr, portableAssets + v.replace(/^\.?\//, ''));
    if (el.tagName === 'IMG') el.setAttribute('data-zoom-src', el.getAttribute('src'));
  });
}

const LAYOUTS = [
  { id: 'minimal', label: '极简' },
  { id: 'tech', label: '技术' },
  { id: 'magazine', label: '杂志' },
];
const THEMES = [
  { id: 'system', label: '跟随系统', icon: '🌗' },
  { id: 'light', label: '浅色', icon: '☀️' },
  { id: 'dark', label: '深色', icon: '🌙' },
];

const state = {
  payload: null,
  index: null,
  notes: [],
  bySlug: new Map(),
  layout: localStorage.getItem('note-layout') || 'minimal',
  theme: localStorage.getItem('note-theme') || 'system',
  list: localStorage.getItem('note-list') || 'grid',
  category: localStorage.getItem('note-cat') || '',
  view: 'home',
  query: '',
  currentSlug: '',
  graph: null,
  debounce: 0,
  ctxSlug: '',
};

/* ============================ 工具 ============================ */
function coverVars(note) {
  const c = note.cover || { ink: 'var(--accent)' };
  return `--nb:${c.ink}`;
}
function coverGlyphOf(note) {
  return (note.cover && note.cover.glyph) || String(note.title || '笔').slice(0, 1);
}
function catInk(cat) {
  const n = state.notes.find((x) => x.category === cat);
  return n && n.cover ? n.cover.ink : 'var(--accent)';
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${y}-${m}-${d}`;
}
function relDate(iso) {
  if (!iso) return '';
  const t = new Date(`${iso}T00:00:00`).getTime();
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}
function slugifyClient(text) {
  const s = String(text).trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{Script=Han}\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'sec';
}
function showToast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:var(--bg-elev);' +
      'border:1px solid var(--line-strong);border-radius:12px;padding:10px 18px;font-size:13.5px;' +
      'box-shadow:var(--shadow-lg);z-index:300;transition:opacity .2s;max-width:86vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 1900);
}
async function copyText(text, btn, label) {
  // 普通页面用 Clipboard API；file:// 下的便携版退回 execCommand
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error('fallback');
    }
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (err) {}
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = label || '已复制 ✓';
    setTimeout(() => { btn.textContent = old; }, 1300);
  }
}

/* ============================ 主题 / 排版 / 布局 ============================ */
function applyTheme() {
  const m = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const real = state.theme === 'system' ? (m ? 'dark' : 'light') : state.theme;
  document.documentElement.dataset.theme = real;
  document.documentElement.dataset.layout = state.layout;
  document.documentElement.dataset.list = state.list;
  const t = THEMES.find((x) => x.id === state.theme) || THEMES[0];
  const btn = $('#themeBtn');
  if (btn) { btn.textContent = t.icon; btn.title = `主题：${t.label}（点击切换）`; }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', real === 'dark' ? '#17150F' : '#FBFAF7');
  $$('#listToggle button').forEach((b) => b.classList.toggle('on', b.dataset.list === state.list));
  if (state.graph && state.view === 'graph') setTimeout(() => state.graph.redraw(), 60);
}
function cycleTheme() {
  const i = THEMES.findIndex((x) => x.id === state.theme);
  state.theme = THEMES[(i + 1) % THEMES.length].id;
  localStorage.setItem('note-theme', state.theme);
  applyTheme();
  showToast(`主题：${THEMES.find((x) => x.id === state.theme).label}`);
}
function cycleLayout() {
  const i = LAYOUTS.findIndex((x) => x.id === state.layout);
  state.layout = LAYOUTS[(i + 1) % LAYOUTS.length].id;
  localStorage.setItem('note-layout', state.layout);
  applyTheme();
  showToast(`排版：${LAYOUTS.find((x) => x.id === state.layout).label}`);
}
function setList(mode) {
  state.list = mode;
  localStorage.setItem('note-list', mode);
  applyTheme();
  showToast(mode === 'grid' ? '网格视图' : '列表视图');
}

/* ============================ 视图切换 ============================ */
function setView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${name}`));
  $$('#segs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (name === 'graph') ensureGraph();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ============================ 公式 ============================ */
function renderMath(root) {
  const els = root.querySelectorAll('[data-tex]');
  if (!els.length) return;
  const hasKatex = typeof window.katex !== 'undefined';
  els.forEach((el) => {
    const tex = el.getAttribute('data-tex') || '';
    if (!hasKatex) {
      el.innerHTML = `<code class="katex-fallback">${escapeHtml(tex)}</code>`;
      return;
    }
    try {
      window.katex.render(tex, el, { displayMode: el.classList.contains('md-math-block'), throwOnError: false, output: 'html' });
    } catch (e) {
      el.innerHTML = `<code class="katex-fallback">${escapeHtml(tex)}</code>`;
    }
  });
}

/* ============================ 书架（侧栏） ============================ */
function filteredNotes() {
  return state.category ? state.notes.filter((n) => n.category === state.category) : state.notes;
}
function notesByCategory() {
  const map = new Map();
  for (const n of state.notes) {
    if (!map.has(n.category)) map.set(n.category, []);
    map.get(n.category).push(n);
  }
  return map;
}

function renderSidebar() {
  const list = filteredNotes();
  const starred = state.notes.filter((n) => n.pinned);
  const byCat = notesByCategory();

  const itemHtml = (n) => `<a class="note-item${n.slug === state.currentSlug ? ' active' : ''}"
      href="#/note/${encodeURIComponent(n.slug)}" data-slug="${escapeHtml(n.slug)}" style="${coverVars(n)}">
      <span class="nb"></span>
      <span class="note-item-body">
        <span class="note-item-title">${escapeHtml(n.title)}</span>
        <span class="note-item-meta"><span>${fmtDate(n.date)}</span>${n.tags.length ? `<span>#${escapeHtml(n.tags[0])}</span>` : ''}</span>
      </span>
      ${n.pinned ? '<span class="star">⭐</span>' : ''}
    </a>`;

  let html = `<div class="shelf">
    <div class="shelf-title"><span>📚 全部笔记本</span><span class="shelf-count">${state.notes.length}</span></div>
    <a class="note-item${state.category === '' ? ' active' : ''}" href="#/" data-cat="">
      <span class="nb" style="--nb:var(--accent)"></span>
      <span class="note-item-body"><span class="note-item-title">全部笔记</span>
      <span class="note-item-meta"><span>${state.notes.length} 本</span></span></span>
    </a>
  </div>`;

  if (starred.length) {
    html += `<div class="shelf">
      <div class="shelf-title"><span>⭐ 收藏</span><span class="shelf-count">${starred.length}</span></div>
      ${starred.map(itemHtml).join('')}
    </div>`;
  }

  html += `<div class="shelf">
    <div class="shelf-title"><span>📂 我的笔记本</span><span class="shelf-count">${byCat.size}</span></div>
    ${[...byCat.entries()]
      .map(
        ([cat, arr]) => `<a class="note-item${state.category === cat ? ' active' : ''}" href="#/" data-cat="${escapeHtml(cat)}" style="--nb:${catInk(cat)}">
          <span class="nb"></span>
          <span class="note-item-body"><span class="note-item-title">${escapeHtml(cat)}</span>
          <span class="note-item-meta"><span>${arr.length} 本</span><span>${relDate(arr.reduce((a, b) => (a.date > b.date ? a : b)).date)}</span></span></span>
        </a>`
      )
      .join('')}
  </div>`;

  html += `<div class="shelf">
    <div class="shelf-title"><span>🕘 最近打开</span><span class="shelf-count">${Math.min(6, list.length)}</span></div>
    ${list.slice(0, 6).map(itemHtml).join('')}
  </div>`;

  $('#noteList').innerHTML = html;
  $('#footStats').textContent = `${list.length} / ${state.notes.length} 本`;
}

/* ============================ 资料库首页 ============================ */
function cardHtml(n) {
  return `<a class="nb-card" href="#/note/${encodeURIComponent(n.slug)}" data-slug="${escapeHtml(n.slug)}" style="${coverVars(n)}">
    ${n.pinned ? '<span class="nb-star">⭐</span>' : ''}
    <span class="nb-card-edit" data-edit="${escapeHtml(n.slug)}" role="button" tabindex="0" title="直接编辑这篇笔记">✎</span>
    <span class="nb-card-top">
      <span class="nb-thumb">${escapeHtml(coverGlyphOf(n))}</span>
      <span class="nb-card-meta">
        <span class="nb-card-cat"><span class="nb-dot"></span>${escapeHtml(n.category)}</span>
        <span class="nb-card-date">${fmtDate(n.date)} · ${relDate(n.date)}</span>
      </span>
    </span>
    <h3>${escapeHtml(n.title)}</h3>
    <p>${escapeHtml(n.excerpt)}</p>
    <span class="nb-card-foot">
      ${n.tags.slice(0, 3).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
      <span class="nb-badge">${n.headings.length ? `📑 ${n.headings.length}` : ''}${n.attachments.length ? ' 📎' : ''}</span>
    </span>
  </a>`;
}

function stripSection(title, notes, hint) {
  if (!notes.length) return '';
  return `<section class="shelf-strip">
    <div class="shelf-strip-head"><h2>${title}</h2><span class="hint">${hint || `横向滑动 · ${notes.length} 本`}</span></div>
    <div class="strip-scroll">${notes.map(cardHtml).join('')}</div>
  </section>`;
}

function renderHome() {
  const all = state.notes;
  const list = filteredNotes();
  const s = state.payload.stats;
  $('#stats').innerHTML = [
    `<span class="stat"><b>${s.notes}</b>本笔记</span>`,
    `<span class="stat"><b>${s.categories}</b>个分类</span>`,
    `<span class="stat"><b>${s.tags}</b>个标签</span>`,
    s.extracted ? `<span class="stat"><b>${s.extracted}</b>个附件已提取文字</span>` : '',
  ].join('');

  const byCat = notesByCategory();
  const withAttach = all.filter((n) => n.attachments.length);

  let html = '';
  html += stripSection('⭐ 收藏', all.filter((n) => n.pinned), '在笔记头部写 pinned: true 即可置顶');
  html += stripSection('🕘 最近更新', all.slice(0, 8), '按更新时间倒序');

  html += `<section class="shelf-strip">
    <div class="shelf-strip-head"><h2>📂 分类</h2><span class="hint">点一张卡片只看这一类</span></div>
    <div class="cats">
      ${[...byCat.entries()]
        .map(
          ([cat, arr]) => `<a class="cat-card" href="#/" data-cat="${escapeHtml(cat)}">
            <span class="cat-strip">${arr
              .slice(0, 4)
              .map((n) => `<i style="background:${(n.cover && n.cover.ink) || 'var(--accent)'}"></i>`)
              .join('')}</span>
            <b>${escapeHtml(cat)}</b>
            <span>${arr.length} 本 · 最近 ${relDate(arr.reduce((a, b) => (a.date > b.date ? a : b)).date)}</span>
          </a>`
        )
        .join('')}
    </div>
  </section>`;

  html += stripSection('📎 含图表文字（图片里的字也能搜到）', withAttach);

  html += `<section class="shelf-strip">
    <div class="shelf-strip-head">
      <h2>${state.category ? `📁 ${escapeHtml(state.category)}` : '🗂 全部笔记'}</h2>
      <span class="hint">${list.length} 本 · 右键笔记本可查看更多操作</span>
    </div>
    ${list.length ? `<div class="grid-notes">${list.map(cardHtml).join('')}</div>`
      : `<div class="empty"><div class="big">🍃</div>这个分类下还没有笔记</div>`}
  </section>`;

  const tagCloud = Object.entries(state.payload.tags).sort((a, b) => b[1] - a[1]).slice(0, 18);
  if (tagCloud.length) {
    html += `<section class="shelf-strip">
      <div class="shelf-strip-head"><h2>🏷 标签</h2><span class="hint">点击即搜索</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${tagCloud
          .map(([t, c]) => `<button class="chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)} <span style="color:var(--text-faint)">${c}</span></button>`)
          .join('')}
      </div>
    </section>`;
  }

  $('#homeBody').innerHTML = html;
  $('#heroTitle').textContent = state.category ? state.category : '资料库';
}

/* ============================ 笔记本（正文） ============================ */
function openNote(slug, opts = {}) {
  const note = state.bySlug.get(slug);
  if (!note) {
    $('#article').innerHTML = `<div class="empty"><div class="big">🔍</div>找不到这本笔记：${escapeHtml(slug)}<br><br><a href="#/">回到资料库</a></div>`;
    setView('note');
    return;
  }
  state.currentSlug = slug;

  const subs = note.headings.filter((h) => h.level >= 2);
  const tocHtml = subs.length
    ? `<div class="toc-title">本页目录</div>` +
      subs.map((h) => `<a class="lv${h.level}" href="#${encodeURIComponent(h.id)}" data-anchor="${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`).join('')
    : '<div class="toc-title">本页目录</div><div style="color:var(--text-faint);font-size:12.5px">（没有小标题）</div>';

  const backlinks = (note.backlinks || [])
    .map((s) => state.bySlug.get(s))
    .filter(Boolean)
    .map((n) => `<a class="chip" href="#/note/${encodeURIComponent(n.slug)}" style="${coverVars(n)}">${escapeHtml(n.title)}</a>`)
    .join('');

  $('#article').innerHTML = `
    <header class="article-head" style="${coverVars(note)}">
      <h1>${escapeHtml(note.title)}</h1>
      <div class="article-meta">
        <span class="nb-card-cat"><span class="nb-dot"></span>${escapeHtml(note.category)}</span>
        <span class="dot"></span><span>${fmtDate(note.date)}</span>
        <span class="dot"></span><span>${relDate(note.date)}</span>
        <span class="dot"></span><span>${note.headings.length} 个小标题</span>
        ${note.attachments.length ? `<span class="pill">📎 ${note.attachments.length} 个附件文字已进检索</span>` : ''}
        ${note.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
      </div>
      <div class="article-tools">
        <button class="ql-btn primary" data-edit="${escapeHtml(note.slug)}" type="button">✎ 编辑</button>
        <button class="ql-btn" data-ink="${escapeHtml(note.slug)}" type="button">✍ 标注</button>
        <button class="ql-btn" data-quick="${escapeHtml(note.slug)}" type="button">👁 速览</button>
      </div>
    </header>
    <div class="article-body" id="articleBody">${note.html}</div>
    ${backlinks ? `<div class="backlinks"><h4>被这些笔记引用</h4><div class="backlink-chips">${backlinks}</div></div>` : ''}
  `;
  $('#toc').innerHTML = tocHtml;

  const body = $('#articleBody');
  body.querySelectorAll('h1,h2,h3,h4').forEach((h) => {
    if (!h.id) h.id = slugifyClient(h.textContent.replace('#', ''));
  });
  versionAssets(body, note.date ? Date.parse(note.date) : Date.now());
  renderMath(body);
  highlightAll(body);
  fixWikilinks(body);
  fixAssets(body);

  setView('note');
  renderSidebar();
  $('#breadcrumb').innerHTML = `<a href="#/">资料库</a> / <span style="color:var(--text-soft)">${escapeHtml(note.category)}</span> / <b>${escapeHtml(note.title)}</b>`;

  if (opts.anchor) {
    requestAnimationFrame(() => {
      const el = document.getElementById(opts.anchor);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } else {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  setupScrollSpy();
}

/** 给附件加版本参数：图片/PDF 同名更新后，浏览器不会再用旧缓存 */
function versionAssets(root, stamp) {
  const v = String(Math.floor((stamp || Date.now()) / 1000));
  root.querySelectorAll('img[src], a[href]').forEach((el) => {
    const attr = el.tagName === 'IMG' ? 'src' : 'href';
    const raw = el.getAttribute(attr) || '';
    if (!raw || /^(https?:|data:|mailto:|#)/.test(raw)) return;
    if (!/\.(png|jpe?g|gif|webp|svg|pdf|zip|docx?|xlsx?|csv)$/i.test(raw)) return;
    if (raw.includes('?v=')) return;
    el.setAttribute(attr, `${raw}?v=${v}`);
    if (el.tagName === 'IMG') el.setAttribute('data-zoom-src', el.getAttribute('src'));
  });
}
function fixWikilinks(root) {
  root.querySelectorAll('[data-wikilink]').forEach((a) => {
    const raw = a.getAttribute('data-wikilink') || '';
    const hit =
      state.bySlug.get(raw) ||
      [...state.bySlug.values()].find((n) => n.title === raw) ||
      state.notes.find((n) => n.slug.toLowerCase() === raw.toLowerCase());
    if (hit) {
      a.setAttribute('href', `#/note/${encodeURIComponent(hit.slug)}`);
      a.title = hit.excerpt || hit.title;
    } else {
      a.style.borderBottomStyle = 'dotted';
      a.style.opacity = '.7';
      a.title = '还没有这本笔记';
    }
  });
}

let spyObserver = null;
function setupScrollSpy() {
  if (spyObserver) spyObserver.disconnect();
  const links = $$('#toc a');
  if (!links.length) return;
  const map = new Map();
  links.forEach((a) => {
    const el = document.getElementById(a.dataset.anchor);
    if (el) map.set(el, a);
  });
  spyObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((l) => l.classList.remove('on'));
        const a = map.get(en.target);
        if (a) a.classList.add('on');
      });
    },
    { rootMargin: '-70px 0px -70% 0px', threshold: [0, 1] }
  );
  map.forEach((_, el) => spyObserver.observe(el));
}

/* ============================ 速览浮层 ============================ */
function openQuickLook(slug) {
  const note = state.bySlug.get(slug);
  if (!note) return;
  const subs = note.headings.filter((h) => h.level >= 2).slice(0, 8);
  $('#qlBody').innerHTML = `
    <div class="ql-head" style="${coverVars(note)}">
      <span class="ql-thumb">${escapeHtml(coverGlyphOf(note))}</span>
      <span class="ql-titles">
        <h2>${escapeHtml(note.title)}</h2>
        <span class="ql-meta">
          <span class="nb-card-cat"><span class="nb-dot"></span>${escapeHtml(note.category)}</span>
          <span>·</span><span>${fmtDate(note.date)}</span>
          <span>·</span><span>${relDate(note.date)}</span>
          ${note.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
        </span>
      </span>
      <span class="ql-actions">
        <a class="ql-btn primary" href="#/note/${encodeURIComponent(note.slug)}" data-open="${escapeHtml(note.slug)}">打开阅读</a>
        <button class="ql-btn" data-edit="${escapeHtml(note.slug)}" type="button">✎ 编辑</button>
        <button class="ql-btn" data-close="1">关闭</button>
      </span>
    </div>
    <div class="ql-content" style="${coverVars(note)}">
      <p class="ql-excerpt">${escapeHtml(note.excerpt)}</p>
      ${subs.length ? `<div class="ql-sect-title">目录（共 ${note.headings.length} 个小标题）</div>
        <div class="ql-toc">${subs
          .map((h) => `<a href="#/note/${encodeURIComponent(note.slug)}?a=${encodeURIComponent(h.id)}" data-anchor-jump="${escapeHtml(note.slug)}|${escapeHtml(h.id)}">
            <span class="lv">H${h.level}</span>${escapeHtml(h.text)}</a>`)
          .join('')}</div>` : ''}
      <div class="ql-sect-title">数据</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span class="stat"><b>${note.search ? note.search.length : 0}</b>字符索引</span>
        <span class="stat"><b>${note.attachments.length}</b>个附件文字</span>
        <span class="stat"><b>${(note.resolvedLinks || []).length}</b>条出链</span>
        <span class="stat"><b>${(note.backlinks || []).length}</b>条入链</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button class="ql-btn" data-copy-link="${escapeHtml(note.slug)}">复制链接</button>
        <button class="ql-btn" data-cat-jump="${escapeHtml(note.category)}">只看「${escapeHtml(note.category)}」</button>
      </div>
    </div>`;
  $('#quicklook').classList.add('on');
}
function closeQuickLook() { $('#quicklook').classList.remove('on'); }

/* ============================ 上下文菜单 ============================ */
function openCtx(slug, x, y) {
  const note = state.bySlug.get(slug);
  if (!note) return;
  state.ctxSlug = slug;
  const menu = $('#ctxMenu');
  menu.innerHTML = `
    <button data-act="open">📖 打开阅读</button>
    <button data-act="edit">✎ 在线编辑</button>
    <button data-act="quick">👁 速览</button>
    <button data-act="copy">🔗 复制链接</button>
    <div class="sep"></div>
    <button data-act="cat">📂 只看「${escapeHtml(note.category)}」</button>
    <button data-act="tag">🏷 按标签搜索</button>
    <button data-act="md">📄 复制 Markdown 文件名</button>`;
  menu.classList.add('on');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 10))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 10))}px`;
}
function closeCtx() { $('#ctxMenu').classList.remove('on'); }

function handleCtxAction(act) {
  const note = state.bySlug.get(state.ctxSlug);
  closeCtx();
  if (!note) return;
  const url = `${location.origin}${location.pathname}#/note/${encodeURIComponent(note.slug)}`;
  switch (act) {
    case 'open': location.hash = `#/note/${encodeURIComponent(note.slug)}`; break;
    case 'edit': openEditor(note.slug); break;
    case 'quick': openQuickLook(note.slug); break;
    case 'copy': copyText(url, null, null); showToast('链接已复制'); break;
    case 'cat':
      state.category = note.category;
      localStorage.setItem('note-cat', state.category);
      renderSidebar(); renderHome(); setView('home');
      if (location.hash !== '#/') location.hash = '#/';
      showToast(`只看：${note.category}`);
      break;
    case 'tag': {
      const t = note.tags[0];
      if (!t) { showToast('这本笔记没有标签'); return; }
      $('#searchInput').value = `#${t}`;
      runSearch(`#${t}`);
      break;
    }
    case 'md':
      copyText(note.source || `${note.slug}.md`, null, null);
      showToast(`已复制：${note.source || note.slug + '.md'}`);
      break;
  }
}

/* ============================ 检索 ============================ */
/** 只读地看看笔记本资料库是否存在（避免第一次搜索就凭空建一份空资料库） */
function peekBookStore() {
  if (bookStore) return bookStore;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('note-books-v1')) return ensureBookStore();
  } catch (e) {}
  return null;
}

/** 笔记本（含手写 OCR）的命中：笔记本级 + 页面级 */
function bookSearchHits(q) {
  const store = peekBookStore();
  if (!store) return { books: [], pages: [], total: 0 };
  const books = store.notebooks({ q });
  const pages = store.searchAll(q, { limit: 24 });
  const total = pages.length || books.length;
  return { books, pages, total };
}

function runSearch(q) {
  state.query = q;
  $('#searchClear').classList.toggle('on', !!q);
  if (!q.trim()) {
    if (state.view === 'search') setView('home');
    renderSidebar();
    return;
  }
  const hits = search(state.index, q, { category: state.category, limit: 60 });
  const books = bookSearchHits(q);
  $('#searchHead').textContent = `搜索「${q}」`;
  $('#searchSub').textContent =
    `${hits.length} 本笔记命中${books.total ? ` · 笔记本里还有 ${books.total} 处（含手写）` : ''}`
    + `${state.category ? ` · 限分类「${state.category}」` : ''} · 范围：标题 / 正文 / 代码 / 标签 / 图表文字 / 笔记本内容`;

  const noteHtml = hits.length
    ? hits
        .map((h) => {
          const note = state.bySlug.get(h.slug);
          return `<a class="result" href="#/note/${encodeURIComponent(h.slug)}" data-slug="${escapeHtml(h.slug)}" style="${note ? coverVars(note) : ''}">
            <span class="result-title">${highlight(h.title, [q])}<span class="where">${escapeHtml(h.category)} · ${fmtDate(h.date)}</span></span>
            <span class="result-snippet">${h.snippet}</span>
          </a>`;
        })
        .join('')
    : `<div class="empty"><div class="big">🫥</div>没有匹配「${escapeHtml(q)}」的 Markdown 笔记<br><span style="font-size:13px">试试更短的关键词，或换个说法</span></div>`;

  // 笔记本命中（含手写识别结果）：按页聚合，点一下直接跳到那一页
  let bookHtml = '';
  if (books.pages.length) {
    const byBook = new Map();
    for (const p of books.pages) {
      if (!byBook.has(p.bookId)) byBook.set(p.bookId, { title: p.title, pages: [] });
      byBook.get(p.bookId).pages.push(p);
    }
    bookHtml = `<div class="search-block"><div class="search-block-head">笔记本（含手写识别）· ${books.pages.length} 处命中</div>
      ${[...byBook.entries()].map(([id, g]) => {
        const nb = bookStore ? bookStore.get(id) : null;
        const cover = nb ? coverVarsForBook(nb) : '';
        const first = g.pages[0];
        const ex = excerptAround(first.excerpt || '', q);
        return `<a class="result result-book" href="#/book/${encodeURIComponent(id)}" style="${cover}">
          <canvas class="result-thumb" data-book="${escapeHtml(id)}" data-page="${first.pageIndex}" width="1" height="1" aria-hidden="true"></canvas>
          <span class="result-body">
            <span class="result-title">${escapeHtml(g.title)}<span class="where">${nb ? nb.pages.length : '?'} 页 · 命中 ${g.pages.length} 处 · ${escapeHtml(first.source)}</span></span>
            <span class="result-snippet">${highlight(ex.excerpt || '', [q])}</span>
          </span>
        </a>`;
      }).join('')}
    </div>`;
  }

  $('#searchResults').innerHTML = noteHtml + bookHtml;
  if (bookHtml) paintBookThumbs();
  setView('search');
  renderSidebar();
}

/** 给搜索结果里的笔记本条目画一张该页缩略图（最多 6 张，避免拖慢搜索） */
function paintBookThumbs() {
  if (!bookStore) return;
  const canvases = $$('.result-thumb').slice(0, 6);
  for (const c of canvases) {
    const nb = bookStore.get(c.dataset.book);
    const idx = Number(c.dataset.page) || 0;
    const page = nb && nb.pages && nb.pages[idx];
    if (!page) continue;
    const paper = page.paper || nb.paper;
    const dims = paperDims(paper);
    const scale = Math.max(0.08, Math.min(0.3, 76 / Math.max(1, dims.w)));
    try {
      renderBookPage(c, { paper, items: page.items || [], scale, dpr: Math.min(2, window.devicePixelRatio || 1) });
    } catch (e) { /* 缩略图失败不影响搜索 */ }
  }
}

/** 笔记本封面配色（列表里用 --bk 上色） */
function coverVarsForBook(nb) {
  const c = (nb && nb.cover) || {};
  return `--nb:${c.color || 'var(--accent)'}`;
}

/* ============================ 时间线 ============================ */
function renderTimeline() {
  const list = filteredNotes();
  const groups = new Map();
  for (const n of list) {
    const key = (n.date || '').slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  $('#timelineBody').innerHTML =
    [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(
        ([month, arr]) => `<div class="tl-group">
        <div class="tl-group-title">${month} · ${arr.length} 本</div>
        ${arr
          .map(
            (n) => `<a class="tl-item" href="#/note/${encodeURIComponent(n.slug)}" style="${coverVars(n)}">
              <span class="nb" style="width:6px;height:18px;border-radius:2px;background:var(--nb);flex:none"></span>
              <span class="tl-date">${fmtDate(n.date).slice(5)}</span>
              <span class="tl-title">${escapeHtml(n.title)}</span>
              <span class="tl-tags">${n.tags.slice(0, 3).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</span>
            </a>`
          )
          .join('')}
      </div>`
      )
      .join('') || '<div class="empty"><div class="big">🕒</div>还没有内容</div>';
}

/* ============================ 知识图谱 ============================ */
function ensureGraph() {
  if (!state.graph) {
    state.graph = createGraph({
      canvas: $('#graph'),
      tipEl: $('#graphTip'),
      legendEl: $('#graphLegend'),
      onOpen: (slug) => { location.hash = `#/note/${encodeURIComponent(slug)}`; },
    });
  }
  setTimeout(() => {
    state.graph.setData(filteredNotes());
    state.graph.redraw();
  }, 30);
}

/* ============================ 新建笔记面板 ============================ */
const TEMPLATES = [
  {
    name: '标准笔记',
    hint: '日常记录',
    body: `---
title: 标题写这里
category: 未分类
tags: [标签一, 标签二]
date: DATE_TODAY
---

# 标题写这里

一句话结论先写在最前面。

## 要点

- 第一点
- 第二点

## 详细记录

正文……
`,
  },
  {
    name: '模型 / 推导笔记',
    hint: '公式与推导',
    body: `---
title: 模型名 · 推导笔记
category: 数学建模
tags: [建模, 公式]
date: DATE_TODAY
---

# 模型名 · 推导笔记

## 问题与假设

- 假设 1（强假设）
- 假设 2（弱假设）

## 符号

| 符号 | 含义 | 单位 |
| --- | --- | --- |
| x | 决策变量 | — |

## 推导

目标函数：

$$
\\min_{x} f(x) = \\sum_{i=1}^{n} c_i x_i
$$

约束：

$$
Ax \\leq b,\\quad x \\geq 0
$$

## 求解与结果

\`\`\`python
import numpy as np
print("结果")
\`\`\`

## 灵敏度

参数 ±10% 扫描后结论是否稳定。

> [!WARNING] 局限
> 写清楚模型不适用的情形。
`,
  },
  {
    name: '会议 / 复盘笔记',
    hint: '结论 + 待办',
    body: `---
title: 会议记录 · 主题
category: 工作
tags: [会议, 复盘]
date: DATE_TODAY
---

# 会议记录 · 主题

## 结论

- 结论一
- 结论二

## 待办

- [ ] 事项一（负责人 · 截止日）
- [ ] 事项二

## 讨论要点

> [!NOTE] 背景
> 为什么开这个会。
`,
  },
  {
    name: '读书 / 文章笔记',
    hint: '摘录 + 想法',
    body: `---
title: 《书名》读书笔记
category: 阅读
tags: [读书]
date: DATE_TODAY
---

# 《书名》读书笔记

## 一句话总结

## 让我记下的句子

> 摘录原文。

## 我的想法

## 可以怎么用

- [ ] 落地一件事
`,
  },
];

function openNewSheet() {
  const today = new Date().toISOString().slice(0, 10);
  $('#templateList').innerHTML = TEMPLATES.map(
    (t, i) => `<div class="template-card">
      <div class="template-card-head">
        <b>${escapeHtml(t.name)}</b>
        <span class="chip" style="cursor:default">${escapeHtml(t.hint)}</span>
        <button class="template-copy" data-copy-tpl="${i}">复制模板</button>
      </div>
      <pre><code>${escapeHtml(t.body.replace(/DATE_TODAY/g, today))}</code></pre>
    </div>`
  ).join('');
  $('#newSheet').classList.add('on');
}
function closeNewSheet() { $('#newSheet').classList.remove('on'); }

/* ============================ 路由 ============================ */
function parseHash() {
  const h = decodeURIComponent(location.hash || '');
  const note = /^#\/note\/(.+?)(?:\?(.*))?$/.exec(h);
  if (note) {
    const params = new URLSearchParams(note[2] || '');
    return { route: 'note', slug: note[1].split('#')[0], anchor: params.get('a') || '' };
  }
  if (/^#\/(home)?$/.test(h)) return { route: 'home' };
  if (/^#\/books$/.test(h)) return { route: 'books' };
  const book = /^#\/book\/([^/?]+)/.exec(h);
  if (book) return { route: 'book', id: book[1] };
  if (/^#\/timeline$/.test(h)) return { route: 'timeline' };
  if (/^#\/graph$/.test(h)) return { route: 'graph' };
  if (/^#\/tag\/(.+)$/.test(h)) return { route: 'tag', tag: /^#\/tag\/(.+)$/.exec(h)[1] };
  if (/^#\/[^/]+$/.test(h)) return { route: 'note', slug: h.slice(2) };
  if (h.startsWith('#') && h.length > 1) return { route: 'anchor', id: h.slice(1) };
  return { route: 'home' };
}

function handleRoute() {
  const r = parseHash();
  if (r.route !== 'book') closeBook();   // 离开笔记本时先保存并收工
  closeDrawer();
  closeCtx();
  switch (r.route) {
    case 'note': openNote(r.slug, { anchor: r.anchor }); break;
    case 'books':
      renderBooks();
      setView('books');
      $('#breadcrumb').innerHTML = '<b>笔记本</b>';
      state.currentSlug = '';
      break;
    case 'book':
      openBook(r.id);
      break;
    case 'timeline':
      renderTimeline();
      setView('timeline');
      $('#breadcrumb').innerHTML = '<a href="#/">资料库</a> / <b>时间线</b>';
      break;
    case 'graph':
      setView('graph');
      ensureGraph();
      $('#breadcrumb').innerHTML = '<a href="#/">资料库</a> / <b>知识图谱</b>';
      break;
    case 'tag':
      $('#searchInput').value = `#${r.tag}`;
      runSearch(`#${r.tag}`);
      break;
    case 'anchor': {
      const el = document.getElementById(r.id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    default:
      renderHome();
      setView('home');
      $('#breadcrumb').innerHTML = '<b>资料库</b>';
      state.currentSlug = '';
      renderSidebar();
  }
}

/* ============================ 抽屉 / 滚动 ============================ */
function openDrawer() { $('#sidebar').classList.add('open'); $('#scrim').classList.add('on'); }
function closeDrawer() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('on'); }

function bindScroll() {
  const bar = $('#progress');
  const top = $('#toTop');
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      const p = h > 0 ? Math.min(1, window.scrollY / h) : 0;
      bar.style.width = `${p * 100}%`;
      top.classList.toggle('on', window.scrollY > 500);
      ticking = false;
    });
  }, { passive: true });
  top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

/* ============================ 交互绑定 ============================ */
function bindInteractions() {
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.md-figure img');
    if (img) {
      $('#lightboxImg').src = img.dataset.zoomSrc || img.src;
      $('#lightbox').classList.add('on');
      return;
    }
    // 离线便携版：把正文里的附件相对路径切到 docs/ 目录
    if (portableAssets) {
      const attach = e.target.closest('a.md-attachment, a[href*="assets/"]');
      if (attach) {
        const href = attach.getAttribute('href') || '';
        if (!/^(https?:|mailto:|#|data:)/.test(href) && !href.startsWith(portableAssets)) {
          attach.setAttribute('href', portableAssets + href.replace(/^\.?\//, ''));
        }
      }
    }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn && copyBtn.closest('.md-code')) {
      const code = copyBtn.closest('.md-code').querySelector('code');
      if (code) copyText(code.textContent, copyBtn);
      return;
    }
    const tplBtn = e.target.closest('[data-copy-tpl]');
    if (tplBtn) {
      const t = TEMPLATES[Number(tplBtn.dataset.copyTpl)];
      if (t) copyText(t.body.replace(/DATE_TODAY/g, new Date().toISOString().slice(0, 10)), tplBtn, '已复制 ✓');
      return;
    }
    if (e.target.closest('[data-close]')) {
      closeQuickLook();
      closeNewSheet();
      return;
    }
    const copyLink = e.target.closest('[data-copy-link]');
    if (copyLink) {
      const slug = copyLink.dataset.copyLink;
      copyText(`${location.origin}${location.pathname}#/note/${encodeURIComponent(slug)}`, copyLink, '已复制 ✓');
      return;
    }
    const catJump = e.target.closest('[data-cat-jump]');
    if (catJump) {
      state.category = catJump.dataset.catJump;
      localStorage.setItem('note-cat', state.category);
      closeQuickLook();
      renderSidebar();
      renderHome();
      setView('home');
      if (location.hash !== '#/') location.hash = '#/';
      showToast(`只看：${state.category}`);
      return;
    }
    const anchorJump = e.target.closest('[data-anchor-jump]');
    if (anchorJump) {
      const [slug, id] = anchorJump.dataset.anchorJump.split('|');
      closeQuickLook();
      location.hash = `#/note/${encodeURIComponent(slug)}?a=${encodeURIComponent(id)}`;
      return;
    }
    const ctxBtn = e.target.closest('#ctxMenu button');
    if (ctxBtn) { handleCtxAction(ctxBtn.dataset.act); return; }
    if (!e.target.closest('#ctxMenu')) closeCtx();

    // 在线编辑（资料库卡片上的铅笔按钮 / 文章页按钮 / 速览 / 右键菜单都走这里）
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      if (typeof e.preventDefault === 'function') e.preventDefault();       // 别让卡片的链接跳转
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      closeQuickLook();
      openEditor(editBtn.dataset.edit);
      return;
    }
    const inkBtn = e.target.closest('[data-ink]');
    if (inkBtn) {
      const slug = inkBtn.dataset.ink;
      if (inkLayer) { inkLayer.setActive(false); inkLayer = null; inkBtn.textContent = '✍ 标注'; }
      else openInk(slug);
      return;
    }
    const quickBtn = e.target.closest('[data-quick]');
    if (quickBtn) { openQuickLook(quickBtn.dataset.quick); return; }

    const catEl = e.target.closest('[data-cat]');
    if (catEl) {
      e.preventDefault();
      state.category = catEl.dataset.cat || '';
      localStorage.setItem('note-cat', state.category);
      renderSidebar();
      if (state.view === 'timeline') renderTimeline();
      if (state.view === 'graph') ensureGraph();
      if (state.view === 'search' && state.query) runSearch(state.query);
      if (state.view === 'home') renderHome();
      showToast(state.category ? `只看：${state.category}` : '显示全部笔记');
      return;
    }
    const tagChip = e.target.closest('.chip[data-tag]');
    if (tagChip) {
      const q = `#${tagChip.dataset.tag}`;
      $('#searchInput').value = q;
      runSearch(q);
      closeDrawer();
      return;
    }
    if (e.target.closest('[data-open]')) closeQuickLook();
  });

  document.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.nb-card[data-slug]');
    if (!card) return;
    e.preventDefault();
    openCtx(card.dataset.slug, e.clientX, e.clientY);
  });
  let pressTimer = 0;
  document.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.nb-card[data-slug]');
    if (!card) return;
    const t = e.touches[0];
    pressTimer = setTimeout(() => openCtx(card.dataset.slug, t.clientX, t.clientY), 480);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) =>
    document.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true })
  );

  $('#lightboxClose').addEventListener('click', () => $('#lightbox').classList.remove('on'));
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').classList.remove('on'); });
  $('#newBtn').addEventListener('click', () => openEditor(''));
  $$('#newSheet [data-close]').forEach((el) => el.addEventListener('click', closeNewSheet));
  $$('#quicklook [data-close]').forEach((el) => el.addEventListener('click', closeQuickLook));
  $('#quicklook').addEventListener('click', (e) => { if (e.target.classList.contains('ql-mask')) closeQuickLook(); });
  $('#newSheet').addEventListener('click', (e) => { if (e.target.classList.contains('sheet-mask')) closeNewSheet(); });
}

/* ============================ 在线编辑 ============================ */
let editor = null;

function rebuildIndexJs({ source, slug, raw, attachments }) {
  const payload = applyEdit(state.payload, { source, slug, raw, attachments });
  return JSON.stringify(payload);
}

/** 保存成功后：刷新本地状态与界面（无需刷新页面即可读到新内容） */
function afterSaved(slug, info) {
  try {
    const markdown = editor ? editor.buildMarkdown(slug) : null;
    if (markdown) {
      state.payload = applyEdit(state.payload, {
        source: info.fileName ? `content/${info.fileName}` : `content/${slug}.md`,
        slug,
        raw: markdown,
        attachments: (state.bySlug.get(slug) || {}).attachments || [],
      });
      state.notes = state.payload.notes || [];
      state.bySlug = new Map(state.notes.map((n) => [n.slug, n]));
      state.index = buildIndex(state.payload);
      renderSidebar();
      renderHome();
      state.currentSlug = slug;
      openNote(slug);
    }
  } catch (e) {
    console.warn('本地刷新失败（线上已保存）', e);
  }
  // 记住「刚发布过」：下次加载时若线上数据还是旧的，就提示用户稍等
  try {
    localStorage.setItem('note-just-published', JSON.stringify({ slug, at: Date.now() }));
  } catch (e) {}
  setTimeout(() => {
    showToast('已发布。GitHub Pages 约 1 分钟后更新，刷新若还是旧内容属正常现象');
  }, 1600);
}

function initEditor() {
  const host = document.getElementById('editor');
  if (!host) return;
  editor = new Editor({
    host,
    site: { payload: state.payload, notes: state.notes, bySlug: state.bySlug },
    renderMarkdown: (markdown) => renderDoc(markdown, (href) => href),
    rebuildIndex: rebuildIndexJs,
    onToast: (msg, kind) => {
      showToast(msg);
      if (kind === 'error') console.warn('[editor]', msg);
    },
    onSaved: afterSaved,
  });

  document.addEventListener('note-editor-preview', (ev) => {
    if (ev.detail && ev.detail.root) renderMath(ev.detail.root);
  });
}

/* ============================ PWA 安装引导 ============================ */
let installGuide = null;

function initInstall() {
  installGuide = new InstallGuide({
    onStateChange: (canInstall, installed) => {
      const btn = document.getElementById('installBtn');
      if (!btn) return;
      btn.style.display = installed || isStandalone() ? 'none' : '';
      btn.classList.toggle('ready', !!canInstall);
      btn.title = canInstall
        ? '一键安装到桌面 / 主屏，像 App 一样用'
        : '查看安装到桌面 / 主屏的方法';
    },
  });
  installGuide.watch();
  const btn = document.getElementById('installBtn');
  if (btn) {
    if (isStandalone()) btn.style.display = 'none';
    btn.addEventListener('click', () => installGuide.install());
  }
}

/** 首页横幅：可安装时提示一次（可关闭，不再打扰） */
function maybeInstallBanner() {
  if (!installGuide || isStandalone()) return;
  const host = document.querySelector('#homeBody');
  if (!host) return;
  installGuide.banner(host);
}
/* ============================ 手写标注与编辑（画笔 / 荧光笔 / 橡皮 / 套索 / 形状 / 文本） ============================ */
let inkLayer = null;

const INK_TOOL_TIPS = {
  pen: '画笔：自由手写',
  highlighter: '荧光笔：半透明勾画，够直会自动拉直',
  eraser: '橡皮：整笔擦 / 像素擦；像素擦会把长线切成两段',
  lasso: '套索：圈选或点选后拖动移动、拖角点缩放、拖圆点旋转',
  shape: '形状：松手自动规整成直线 / 矩形 / 椭圆 / 三角（可在下拉里指定）',
  text: '文本框：点一下写文字，点别处完成；双击已有文字可再编辑',
};

async function openInk(slug) {
  const note = state.bySlug.get(slug);
  if (!note) return;
  const host = document.getElementById('articleBody');
  if (!host) return;
  const layerHost = host.parentElement || host;

  // 换了一篇文章（或页面重绘过）就重建一层，避免画到已经不在页面上的旧画布
  if (inkLayer && (inkLayer.host !== layerHost || inkLayer.slug !== slug)) {
    inkLayer.destroy();
    inkLayer = null;
  }

  if (!inkLayer) {
    inkLayer = new InkLayer({
      host: layerHost,
      canSave: () => gh.configured(),
      toast: (msg) => showToast(msg),
      onRequestSave: () => {
        if (!inkLayer) return;
        saveInk(inkLayer.slug || slug, inkLayer.getItems());
      },
      onChange: () => {
        // 脏标记：有未保存改动时提示
        const bar = document.querySelector('.ink-save');
        if (bar) bar.classList.add('dirty');
      },
      onClose: () => {
        if (inkLayer) { inkLayer.destroy(); inkLayer = null; }
        document.body.classList.remove('inking');
        const btn = document.querySelector('[data-ink]');
        if (btn) btn.textContent = '✍ 标注';
      },
      onToolChange: (tool) => showToast(INK_TOOL_TIPS[tool] || ''),
    });
    inkLayer.slug = slug;
  }

  // 载入已有标注（先试线上静态文件，再试仓库 API）
  let items = [];
  try {
    // 加时间戳绕开缓存：刚保存过的标注要能立刻看到新的
    const r = await fetch(`ink/${encodeURIComponent(slug)}.json?t=${Date.now()}`, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.items)) items = j.items;
      else if (Array.isArray(j.strokes)) items = j.strokes; // v1 老文件
    }
  } catch (e) {}
  if (!items.length && gh.configured()) {
    try { items = (await inkApi.load(slug)).items; } catch (e) {}
  }
  inkLayer.setItems(items);
  inkLayer.setActive(true);
  const btn = document.querySelector('[data-ink]');
  if (btn) btn.textContent = '✓ 完成标注';
  if (!gh.configured()) showToast('可以画，但要保存标注需要先在「✎ 编辑」里填 GitHub 令牌');
  else showToast('Ctrl/Cmd+Z 撤销 · 双指轻点撤销 / 三指轻点重做 · 点「?」看全部编辑用法');
}

async function saveInk(slug, items) {
  try {
    showToast('保存标注中…');
    const c = countInkItems(items);
    await inkApi.save(slug, items);
    const bar = document.querySelector('.ink-save');
    if (bar) bar.classList.remove('dirty');
    const parts = [`${c.stroke} 笔笔迹`];
    if (c.text) parts.push(`${c.text} 个文本`);
    if (c.image) parts.push(`${c.image} 张图片`);
    showToast(`已保存 ${parts.join(' · ')}，约 1 分钟后线上可见`);
  } catch (e) {
    showToast(`标注保存失败：${e.message}`);
  }
}

function countInkItems(items) {
  const c = { stroke: 0, text: 0, image: 0 };
  for (const it of items || []) if (it && c[it.kind] != null) c[it.kind]++;
  return c;
}

function openEditor(slug) {
  if (!editor) initEditor();
  if (!editor) { showToast('编辑器没能初始化，请刷新页面重试'); return; }
  if (editor._keyHandler) document.removeEventListener('keydown', editor._keyHandler);
  editor.open(slug || '');
}

/* ============================ GoodNotes 模式（笔记本资料库 + 页面编辑） ============================ */
let bookStore = null;
let bookLib = null;
let bookView = null;
let pendingBookPanel = '';   // 资料库点「开始复习」时，进本子后自动弹出的面板

/** 数据层：整座笔记本资料库存在浏览器本地（可导出备份；不依赖后端） */
function ensureBookStore() {
  if (!bookStore) {
    bookStore = new NotebookStore();
    try { bookStore.sweepTrash(); } catch (e) {}
  }
  return bookStore;
}

function renderBooks() {
  const host = document.getElementById('booksBody');
  if (!host) return;
  const store = ensureBookStore();
  if (!bookLib) {
    bookLib = new LibraryUI({
      root: host,
      store,
      toast: (m) => showToast(m),
      onOpen: (id, opts) => {
        pendingBookPanel = (opts && opts.panel) || '';
        location.hash = `#/book/${encodeURIComponent(id)}`;
      },
      onGoMarkdown: () => { location.hash = '#/'; },
    });
  }
  bookLib.render();
  const st = store.stats();
  const el = document.getElementById('bookStats');
  if (el) {
    el.innerHTML = `<span class="stat"><b>${st.notebooks}</b> 本笔记本</span>` +
      `<span class="stat"><b>${st.pages}</b> 页</span>` +
      `<span class="stat"><b>${st.strokes}</b> 笔手写</span>` +
      `<span class="stat"><b>${(st.bytes / 1024).toFixed(0)}</b> KB 本地数据</span>`;
  }
}

function openBook(id) {
  const host = document.getElementById('bookBody');
  if (!host) return;
  const store = ensureBookStore();
  if (!store.get(id)) { showToast('这本笔记本不在了，可能刚被删除'); location.hash = '#/books'; return; }
  if (!bookView) {
    bookView = new NotebookView({
      root: host,
      store,
      toast: (m) => showToast(m),
      onExit: () => { location.hash = '#/books'; },
      onChanged: () => { if (bookLib) bookLib.render(); },
    });
  }
  bookView.open(id);
  setView('book');
  if (pendingBookPanel) {
    const panel = pendingBookPanel;
    pendingBookPanel = '';
    try { bookView.openPanel(panel); } catch (e) {}
  }
  const nb = store.get(id);
  $('#breadcrumb').innerHTML = `<a href="#/books">笔记本</a> / <b>${escapeHtml(nb ? nb.title : '')}</b>`;
}

function closeBook() {
  if (bookView) bookView.close();
}

/* ============================ 启动 ============================ */
/** 出问题时不再让页面停在「载入中」：显示可操作的提示 */
function showFatal(err) {
  const detail = (err && (err.message || (err.reason && err.reason.message))) || String(err || '未知错误');
  const box = document.getElementById('loading');
  const tip = document.createElement('div');
  tip.className = 'empty';
  tip.innerHTML = '<div class="big">🛠</div><b>页面没能启动</b><br>' +
    '<span style="font-size:13px">通常是浏览器缓存里还留着旧版本的文件，清理后重新打开即可。</span><br><br>' +
    '<span style="font-size:12px;color:var(--text-faint);word-break:break-all">' + escapeHtml(String(detail).slice(0, 220)) + '</span><br><br>' +
    '<button class="ql-btn primary" id="fixCacheBtn" type="button">清理缓存并重新打开</button>';
  if (box) { box.style.display = 'block'; box.innerHTML = ''; box.appendChild(tip); }
  else if (document.body) document.body.appendChild(tip);

  const btn = document.getElementById('fixCacheBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch (e) {}
      location.replace(location.href.split('#')[0] + '?fresh=' + Date.now());
    });
  }
}

window.addEventListener('error', (e) => {
  if (document.querySelector('.view.on')) return; // 已经渲染出来了就不打扰
  showFatal(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (document.querySelector('.view.on')) return;
  showFatal(e.reason);
});

async function boot() {
  applyTheme();
  const portable = !!window.__NOTES_PORTABLE__;
  try {
    if (window.__NOTES_DATA__) {
      state.payload = window.__NOTES_DATA__;           // 离线便携版：数据已内联
    } else {
      const res = await fetch('data/index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.payload = await res.json();
      // 如果上次刚发布过，而线上数据看起来还是旧的，给一句明确提示（避免以为「更新没生效」）
      try {
        const mark = JSON.parse(localStorage.getItem('note-just-published') || 'null');
        if (mark && Date.now() - mark.at < 8 * 60 * 1000) {
          const hasNote = (state.payload.notes || []).some((n) => n.slug === mark.slug);
          if (!hasNote) {
            setTimeout(() => showToast('刚发布的笔记还在等 GitHub 部署（约 1 分钟），稍后刷新即可'), 900);
          } else {
            localStorage.removeItem('note-just-published');
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    $('#loading').innerHTML = `<div class="empty"><div class="big">⚠️</div>没能加载 data/index.json<br>
      <span style="font-size:13px">先在项目根目录执行 <code class="md-inline-code">node tools/build.mjs</code> 然后刷新；<br>
      直接双击打开 index.html 会因浏览器限制读不到数据，请用本地服务器或线上地址。</span></div>`;
    return;
  }

  state.notes = state.payload.notes || [];
  state.bySlug = new Map(state.notes.map((n) => [n.slug, n]));
  state.index = buildIndex(state.payload);

  try {
    if (window.__NOTES_SITE__) {
      const cfg = window.__NOTES_SITE__;
      if (cfg) {
        if (cfg.title) { document.title = cfg.title; $('#siteTitle').textContent = cfg.title; }
        if (cfg.subtitle) $('#siteSub').textContent = cfg.subtitle;
        if (cfg.description) $('#heroDesc').textContent = cfg.description;
      }
    } else {
      const s = await fetch('data/site.json', { cache: 'no-cache' });
      if (s.ok) {
        const cfg = await s.json();
        if (cfg.title) { document.title = cfg.title; $('#siteTitle').textContent = cfg.title; }
        if (cfg.subtitle) $('#siteSub').textContent = cfg.subtitle;
        if (cfg.description) $('#heroDesc').textContent = cfg.description;
      }
    }
  } catch (e) {}

  if (portable) {
    document.title = `${document.title} · 离线版`;
    const sub = $('#siteSub');
    if (sub) sub.textContent = '离线便携版 · 双击即开';
  }

  $('#loading').style.display = 'none';
  $$('.view').forEach((v) => v.classList.remove('on'));

  renderSidebar();
  initEditor();
  initInstall();
  bindInteractions();
  bindScroll();

  $('#themeBtn').addEventListener('click', cycleTheme);
  $('#layoutBtn').addEventListener('click', cycleLayout);
  $('#menuBtn').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#graphCenter').addEventListener('click', () => state.graph && state.graph.fit());
  $$('#segs button').forEach((b) =>
    b.addEventListener('click', () => {
      location.hash = b.dataset.view === 'home' ? '#/' : `#/${b.dataset.view}`;
    })
  );
  $$('#listToggle button').forEach((b) => b.addEventListener('click', () => setList(b.dataset.list)));

  const input = $('#searchInput');
  input.addEventListener('input', () => {
    clearTimeout(state.debounce);
    state.debounce = setTimeout(() => runSearch(input.value), 90);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; runSearch(''); input.blur(); }
  });
  $('#searchClear').addEventListener('click', () => { input.value = ''; input.focus(); runSearch(''); });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (window.innerWidth <= 1000) openDrawer();
      input.focus();
      input.select();
    }
    if (e.key === 'Escape') {
      $('#lightbox').classList.remove('on');
      closeQuickLook();
      closeNewSheet();
      closeCtx();
      closeDrawer();
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme();
  });

  window.addEventListener('hashchange', handleRoute);
  handleRoute();

  // 调试接口：自动化测试与线上排查都用它（不影响正常使用）
  window.__notes = {
    state,
    openNote,
    handleRoute,
    renderBooks,
    openBook,
    books: () => ensureBookStore(),
    bookView: () => bookView,
    library: () => bookLib,
    debug: () => {
      const q = (s) => document.querySelector(s);
      const st = bookStore ? bookStore.stats() : null;
      return {
        slug: state.currentSlug,
        view: state.view,
        notes: state.notes.length,
        viewNoteOn: !!(q('#view-note') && q('#view-note').classList.contains('on')),
        articleLen: q('#article') ? q('#article').innerHTML.length : -1,
        listLen: q('#noteList') ? q('#noteList').innerHTML.length : -1,
        homeLen: q('#homeBody') ? q('#homeBody').innerHTML.length : -1,
        books: st ? st.notebooks : 0,
        bookPages: st ? st.pages : 0,
        bookViewOn: !!(q('#view-book') && q('#view-book').classList.contains('on')),
        bookBodyLen: q('#bookBody') ? q('#bookBody').innerHTML.length : -1,
      };
    },
  };

  // Service Worker 只用于「已经访问过之后」的离线兜底；
  // 发现新版本时自动 reload 一次，避免旧缓存与新页面混用。
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !portable) {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'offline-cache') showToast('离线缓存版本 · 联网后刷新即为最新');
      });
    }
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => {
        if (reg.waiting) reg.waiting.postMessage({ type: 'clear-cache' });
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              const key = 'note-sw-reloaded';
              if (sessionStorage.getItem(key) !== '1') {
                sessionStorage.setItem(key, '1');
                location.reload();
              }
            }
          });
        });
      })
      .catch(() => {});
  }
}

boot().catch((e) => showFatal(e));
