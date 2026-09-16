/**
 * 笔记站主应用：路由 / 渲染 / 搜索 / 主题 / 排版切换 / 目录联动
 */
import { buildIndex, search, escapeHtml, highlight } from './search.js';
import { highlightAll } from './highlight.js';
import { createGraph } from './graph.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

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
  category: localStorage.getItem('note-cat') || '',
  view: 'home',
  query: '',
  currentSlug: '',
  graph: null,
  graphReady: false,
  debounce: 0,
};

/* ============================ 工具 ============================ */
function setView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${name}`));
  $$('.viewswitch button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (name === 'graph') ensureGraph();
  window.scrollTo({ top: 0, behavior: 'auto' });
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

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

function showToast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--bg-elev);border:1px solid var(--line-strong);border-radius:10px;padding:9px 16px;font-size:13px;box-shadow:var(--shadow);z-index:300;transition:opacity .2s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

/* ============================ 主题 / 排版 ============================ */
function applyTheme() {
  const m = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const real = state.theme === 'system' ? (m ? 'dark' : 'light') : state.theme;
  document.documentElement.dataset.theme = real;
  document.documentElement.dataset.layout = state.layout;
  const t = THEMES.find((x) => x.id === state.theme) || THEMES[0];
  const btn = $('#themeBtn');
  if (btn) { btn.textContent = t.icon; btn.title = `主题：${t.label}（点击切换）`; }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', real === 'dark' ? '#12151a' : '#ffffff');
  const l = LAYOUTS.find((x) => x.id === state.layout) || LAYOUTS[0];
  const lbl = $('#layoutLbl');
  if (lbl) lbl.textContent = l.label;
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

/* ============================ 公式 ============================ */
function renderMath(root) {
  const els = root.querySelectorAll('[data-tex]');
  if (!els.length) return;
  const hasKatex = typeof window.katex !== 'undefined';
  els.forEach((el) => {
    const tex = el.getAttribute('data-tex') || '';
    if (!hasKatex) {
      el.className = el.classList.contains('md-math-block') ? 'md-math-block' : 'md-math-inline';
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

/* ============================ 侧边栏 ============================ */
function renderSidebar() {
  const notes = filteredNotes();
  const list = $('#noteList');
  const cats = ['', ...state.payload.categories];

  $('#catFilters').innerHTML = cats
    .map((c) => {
      const label = c || '全部';
      const cnt = c ? notes.filter((n) => n.category === c).length : state.notes.length;
      return `<button class="chip${state.category === c ? ' on' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(label)}<span class="cnt">${cnt}</span></button>`;
    })
    .join('');

  if (!notes.length) {
    list.innerHTML = '<div class="side-empty">没有匹配的笔记<br>试试清空筛选</div>';
    return;
  }

  const groups = new Map();
  for (const n of notes) {
    if (!groups.has(n.category)) groups.set(n.category, []);
    groups.get(n.category).push(n);
  }

  list.innerHTML = [...groups.entries()]
    .map(([cat, arr]) => {
      const items = arr
        .map(
          (n) => `<a class="note-item${n.slug === state.currentSlug ? ' active' : ''}" href="#/note/${encodeURIComponent(n.slug)}" data-slug="${escapeHtml(n.slug)}">
            <span class="note-item-title">${n.pinned ? '<span class="pin">📌</span>' : ''}${escapeHtml(n.title)}</span>
            <span class="note-item-meta"><span>${fmtDate(n.date)}</span>${n.tags.length ? `<span>#${escapeHtml(n.tags[0])}</span>` : ''}</span>
          </a>`
        )
        .join('');
      return `<div class="side-group"><div class="side-group-title"><span>${escapeHtml(cat)}</span><span>${arr.length}</span></div>${items}</div>`;
    })
    .join('');

  $('#footStats').textContent = `${notes.length} / ${state.notes.length} 篇`;
}

function filteredNotes() {
  return state.category ? state.notes.filter((n) => n.category === state.category) : state.notes;
}

/* ============================ 首页 ============================ */
function renderHome() {
  const list = filteredNotes();
  const s = state.payload.stats;
  $('#stats').innerHTML = [
    `<span class="stat"><b>${s.notes}</b>篇笔记</span>`,
    `<span class="stat"><b>${s.categories}</b>个分类</span>`,
    `<span class="stat"><b>${s.tags}</b>个标签</span>`,
    s.extracted ? `<span class="stat"><b>${s.extracted}</b> 个附件已提取文字</span>` : '',
    `<span class="stat">更新于 <b>${fmtDate(state.payload.generatedAt.slice(0, 10))}</b></span>`,
  ].join('');

  const pinned = list.filter((n) => n.pinned);
  const pinnedHtml = pinned.length
    ? `<div class="section-head"><h2>📌 置顶</h2><span class="hint">frontmatter 里写 pinned: true</span></div>${cardGrid(pinned)}`
    : '';

  const recent = list.slice(0, 24);
  $('#homeBody').innerHTML =
    pinnedHtml +
    `<div class="section-head"><h2>${state.category ? '分类：' + escapeHtml(state.category) : '全部笔记'}</h2><span class="hint">${list.length} 篇 · 点击卡片打开</span></div>` +
    (recent.length ? cardGrid(recent) : '<div class="empty"><div class="big">🍃</div>还没有笔记</div>');

  $('#heroTitle').textContent = $('#siteTitle').textContent || '我的笔记';

  const tagCloud = Object.entries(state.payload.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16);
  if (tagCloud.length) {
    $('#homeBody').insertAdjacentHTML(
      'beforeend',
      `<div class="section-head"><h2>🏷 标签</h2><span class="hint">点击筛选</span></div>
       <div class="stats" style="margin-bottom:0">${tagCloud
         .map(([t, c]) => `<button class="chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<span class="cnt">${c}</span></button>`)
         .join('')}</div>`
    );
  }
}

function cardGrid(notes) {
  return `<div class="cards" id="cardGrid">${notes
    .map(
      (n) => `<a class="card" href="#/note/${encodeURIComponent(n.slug)}" data-slug="${escapeHtml(n.slug)}">
      <span class="card-top"><span class="cat-dot"></span>${escapeHtml(n.category)}<span>·</span><span>${fmtDate(n.date)}</span>${n.pinned ? '<span>· 📌</span>' : ''}</span>
      <h3>${escapeHtml(n.title)}</h3>
      <p>${escapeHtml(n.excerpt)}</p>
      <span class="card-foot">${n.tags.slice(0, 4).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</span>
    </a>`
    )
    .join('')}</div>`;
}

/* ============================ 文章 ============================ */
function openNote(slug, opts = {}) {
  const note = state.bySlug.get(slug);
  if (!note) {
    $('#article').innerHTML = `<div class="empty"><div class="big">🔍</div>找不到这篇笔记：${escapeHtml(slug)}<br><br><a href="#/">回到首页</a></div>`;
    setView('note');
    return;
  }
  state.currentSlug = slug;

  const tocHtml = note.headings.length
    ? `<div class="toc-title">本页目录</div>` +
      note.headings
        .filter((h) => h.level >= 2)
        .map((h) => `<a class="lv${h.level}" href="#${encodeURIComponent(h.id)}" data-anchor="${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`)
        .join('')
    : '<div class="toc-title">本页目录</div><div style="color:var(--text-faint);font-size:12.5px">（没有小标题）</div>';

  const backlinks = (note.backlinks || [])
    .map((s) => state.bySlug.get(s))
    .filter(Boolean)
    .map((n) => `<a class="chip" href="#/note/${encodeURIComponent(n.slug)}">${escapeHtml(n.title)}</a>`)
    .join('');

  $('#article').innerHTML = `
    <header class="article-head">
      <h1>${escapeHtml(note.title)}</h1>
      <div class="article-meta">
        <span>${escapeHtml(note.category)}</span>
        <span class="dot"></span><span>${fmtDate(note.date)}</span>
        <span class="dot"></span><span>${relDate(note.date)}</span>
        ${note.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}
        ${note.attachments && note.attachments.length ? `<span class="pill">📎 ${note.attachments.length} 个附件文字已进检索</span>` : ''}
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

  renderMath(body);
  highlightAll(body);
  fixWikilinks(body);

  setView('note');
  renderSidebar();
  $('#breadcrumb').innerHTML = `<a href="#/">首页</a> / ${escapeHtml(note.category)} / <b>${escapeHtml(note.title)}</b>`;

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
      a.classList.add('missing');
      a.style.borderBottomStyle = 'dotted';
      a.style.opacity = '.7';
      a.title = '还没有这篇笔记';
    }
  });
}

/* 滚动联动：目录高亮 + 进度条 */
let spyObserver = null;
function setupScrollSpy() {
  if (spyObserver) spyObserver.disconnect();
  const links = $$('#toc a');
  if (!links.length) return;
  const map = new Map();
  links.forEach((a) => {
    const id = a.dataset.anchor;
    const el = document.getElementById(id);
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

/* ============================ 搜索视图 ============================ */
function runSearch(q) {
  state.query = q;
  const clear = $('#searchClear');
  clear.classList.toggle('on', !!q);
  if (!q.trim()) {
    if (state.view === 'search') setView('home');
    renderSidebar();
    return;
  }
  const hits = search(state.index, q, { category: state.category, limit: 60 });
  const head = $('#searchHead');
  const sub = $('#searchSub');
  head.textContent = `搜索「${q}」`;
  sub.textContent = `${hits.length} 条结果${state.category ? ` · 限分类「${state.category}」` : ''} · 范围：标题 / 正文 / 标签 / 图表文字`;

  $('#searchResults').innerHTML = hits.length
    ? hits
        .map(
          (h) => `<a class="result" href="#/note/${encodeURIComponent(h.slug)}" data-slug="${escapeHtml(h.slug)}">
            <span class="result-title">${highlight(h.title, [q])}<span class="where">${escapeHtml(h.category)} · ${fmtDate(h.date)}</span></span>
            <span class="result-snippet">${h.snippet}</span>
          </a>`
        )
        .join('')
    : `<div class="empty"><div class="big">🫥</div>没有匹配「${escapeHtml(q)}」的内容<br><span style="font-size:13px">试试更短的关键词，或换个说法</span></div>`;

  setView('search');
  renderSidebar();
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
  const html = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(
      ([month, arr]) => `<div class="tl-group">
        <div class="tl-group-title">${month} · ${arr.length} 篇</div>
        ${arr
          .map(
            (n) => `<a class="tl-item" href="#/note/${encodeURIComponent(n.slug)}">
              <span class="tl-date">${fmtDate(n.date).slice(5)}</span>
              <span class="tl-title">${escapeHtml(n.title)}</span>
              <span class="tl-tags">${n.tags.slice(0, 3).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</span>
            </a>`
          )
          .join('')}
      </div>`
    )
    .join('');
  $('#timelineBody').innerHTML = html || '<div class="empty"><div class="big">🕒</div>还没有内容</div>';
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

/* ============================ 图片放大 / 复制 ============================ */
function bindContentInteractions() {
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.md-figure img');
    if (img) {
      $('#lightboxImg').src = img.dataset.zoomSrc || img.src;
      $('#lightbox').classList.add('on');
      return;
    }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const code = copyBtn.closest('.md-code')?.querySelector('code');
      if (code) copyText(code.textContent, copyBtn);
      return;
    }
    const chip = e.target.closest('.chip[data-cat]');
    if (chip) {
      state.category = chip.dataset.cat || '';
      localStorage.setItem('note-cat', state.category);
      renderSidebar();
      renderHome();
      if (state.view === 'graph') ensureGraph();
      if (state.view === 'timeline') renderTimeline();
      return;
    }
    const tagChip = e.target.closest('.chip[data-tag]');
    if (tagChip) {
      $('#searchInput').value = `#${tagChip.dataset.tag}`;
      runSearch(`#${tagChip.dataset.tag}`);
      closeDrawer();
      return;
    }
  });

  $('#lightboxClose').addEventListener('click', () => $('#lightbox').classList.remove('on'));
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') $('#lightbox').classList.remove('on');
  });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) {}
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = old === '已复制 ✓' ? '复制' : old; }, 1200);
  }
}

/* ============================ 路由 ============================ */
function parseHash() {
  const h = decodeURIComponent(location.hash || '');
  const note = /^#\/note\/(.+?)(?:\?(.*))?$/.exec(h);
  if (note) {
    const params = new URLSearchParams(note[2] || '');
    return { route: 'note', slug: note[1].split('#')[0], anchor: params.get('a') || '' };
  }
  if (/^#\/(home)?$/.test(h)) return { route: 'home' };
  if (/^#\/timeline$/.test(h)) return { route: 'timeline' };
  if (/^#\/graph$/.test(h)) return { route: 'graph' };
  if (/^#\/search/.test(h)) return { route: 'search' };
  if (/^#\/tag\/(.+)$/.test(h)) return { route: 'tag', tag: /^#\/tag\/(.+)$/.exec(h)[1] };
  if (/^#\/[^/]+$/.test(h)) return { route: 'note', slug: h.slice(2) };
  // 纯锚点（标题跳转）
  if (h.startsWith('#') && h.length > 1) return { route: 'anchor', id: h.slice(1) };
  return { route: 'home' };
}

function handleRoute() {
  const r = parseHash();
  closeDrawer();
  switch (r.route) {
    case 'note':
      openNote(r.slug, { anchor: r.anchor });
      break;
    case 'timeline':
      renderTimeline();
      setView('timeline');
      $('#breadcrumb').innerHTML = '<a href="#/">首页</a> / <b>时间线</b>';
      break;
    case 'graph':
      setView('graph');
      ensureGraph();
      $('#breadcrumb').innerHTML = '<a href="#/">首页</a> / <b>知识图谱</b>';
      break;
    case 'tag':
      $('#searchInput').value = `#${r.tag}`;
      runSearch(r.tag);
      break;
    case 'anchor': {
      // 页内跳转：不重建文章，只滚动
      const el = document.getElementById(r.id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    default:
      renderHome();
      setView('home');
      $('#breadcrumb').innerHTML = '<b>首页</b>';
      state.currentSlug = '';
      renderSidebar();
  }
}

/* ============================ 移动端抽屉 ============================ */
function openDrawer() {
  $('#sidebar').classList.add('open');
  $('#scrim').classList.add('on');
}
function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('on');
}

/* ============================ 进度条 / 回到顶部 ============================ */
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

/* ============================ 启动 ============================ */
async function boot() {
  applyTheme();
  try {
    const res = await fetch('data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.payload = await res.json();
  } catch (e) {
    $('#loading').innerHTML = `<div class="empty"><div class="big">⚠️</div>没能加载 data/index.json<br>
      <span style="font-size:13px">先在项目根目录执行一次构建：<code class="md-inline-code">node tools/build.mjs</code>，然后刷新页面。<br>（本地直接双击打开 index.html 也会因为浏览器限制读不到数据，请用本地服务器或线上地址）</span></div>`;
    return;
  }

  state.notes = state.payload.notes || [];
  state.bySlug = new Map(state.notes.map((n) => [n.slug, n]));
  state.index = buildIndex(state.payload);

  // 站点名（可选：content/_site.json 覆盖）
  try {
    const s = await fetch('data/site.json', { cache: 'no-cache' });
    if (s.ok) {
      const cfg = await s.json();
      if (cfg.title) { document.title = cfg.title; $('#siteTitle').textContent = cfg.title; }
      if (cfg.subtitle) $('#siteSub').textContent = cfg.subtitle;
      if (cfg.description) $('#heroDesc').textContent = cfg.description;
    } else {
      document.title = '我的笔记';
    }
  } catch (e) {}

  $('#loading').style.display = 'none';
  $$('.view').forEach((v) => v.classList.remove('on'));

  renderSidebar();
  bindContentInteractions();
  bindScroll();

  // 事件绑定
  $('#themeBtn').addEventListener('click', cycleTheme);
  $('#layoutBtn').addEventListener('click', cycleLayout);
  $('#menuBtn').addEventListener('click', openDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#graphCenter').addEventListener('click', () => state.graph && state.graph.fit());
  $$('.viewswitch button').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      if (v === 'home') location.hash = '#/';
      else location.hash = `#/${v}`;
    })
  );

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
    if (e.key === 'Escape') { $('#lightbox').classList.remove('on'); closeDrawer(); }
  });

  // 系统主题变化
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme();
  });

  window.addEventListener('hashchange', handleRoute);
  handleRoute();

  // PWA 离线缓存
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
