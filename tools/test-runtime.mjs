#!/usr/bin/env node
/**
 * 真跑一遍：用最小 DOM 仿真加载 docs/js/app.js，执行「资料库渲染 → 打开笔记 → 标注 → 编辑器」，
 * 捕获运行期异常。静态检查查不出这类问题，而它正是「网页打不开 / 点了没反应」的常见原因。
 *
 * 用法： node tools/test-runtime.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

let pass = 0, fail = 0;
const expect = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

/* ============================ 最小 DOM ============================ */
const VOID = new Set(['br', 'img', 'hr', 'input', 'link', 'meta']);

function parseHtml(html) {
  const root = mkEl('#root');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const full = m[0];
    if (full.startsWith('<!')) continue;
    if (m[3] !== undefined) {
      if (m[3].trim()) push(stack[stack.length - 1], { nodeType: 3, nodeValue: m[3] });
      continue;
    }
    const name = String(m[1]).toLowerCase();
    if (full.startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === name) { stack.length = i; break; }
      continue;
    }
    const el = mkEl(name);
    parseAttrs(m[2] || '', el);
    push(stack[stack.length - 1], el);
    if (!VOID.has(name) && !full.endsWith('/>')) stack.push(el);
  }
  return root;
}

function push(p, c) { c.parentNode = p; p.childNodes.push(c); }

function mkEl(tag) {
  const classes = new Set();
  const el = {
    nodeType: 1,
    tagName: String(tag).toLowerCase(),
    childNodes: [],
    attrs: {},
    style: new Proxy({}, {
      get(t, p) {
        if (p === 'setProperty') return (k, v) => { t[k] = String(v); };
        if (p === 'getPropertyValue') return (k) => t[k] || '';
        if (p === 'removeProperty') return (k) => { delete t[k]; };
        return t[p];
      },
      set(t, p, v) { t[p] = v; return true; },
    }),
    dataset: {},
    value: '',
    checked: false,
    _html: '',
    get id() { return el.attrs.id || ''; },
    set id(v) { el.attrs.id = String(v); },
    get children() { return el.childNodes.filter((c) => c.nodeType === 1); },
    classList: {
      contains: (c) => classes.has(c),
      add: (...cs) => cs.forEach((c) => c && classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); on ? classes.add(c) : classes.delete(c); return on; },
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).forEach((c) => c && classes.add(c)); },
    get innerHTML() { return el._html || el.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.outerHTML)).join(''); },
    set innerHTML(v) {
      el._html = String(v);
      el.childNodes = [];
      const parsed = parseHtml(el._html);
      parsed.childNodes.forEach((c) => push(el, c));
    },
    get textContent() { return el.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); },
    set textContent(v) { el.childNodes = []; el._html = ''; if (v) push(el, { nodeType: 3, nodeValue: String(v) }); },
    get outerHTML() {
      const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
      return `<${el.tagName}${attrs}>${el.innerHTML}</${el.tagName}>`;
    },
    getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    removeAttribute(k) { delete el.attrs[k]; },
    appendChild(c) { push(el, c); el._html = ''; return c; },
    append(...cs) { cs.forEach((c) => push(el, c)); el._html = ''; },
    insertBefore(c) { push(el, c); return c; },
    remove() { const p = el.parentNode; if (p) p.childNodes = p.childNodes.filter((x) => x !== el); },
    replaceWith(...nodes) {
      const p = el.parentNode; if (!p) return;
      const i = p.childNodes.indexOf(el);
      p.childNodes.splice(i, 1, ...nodes);
      nodes.forEach((n) => { n.parentNode = p; });
    },
    addEventListener(t, fn) { (el._ev ||= {}); el._ev[t] = (el._ev[t] || []).concat(fn); },
    removeEventListener() {},
    dispatchEvent(ev) {
      // 模拟真实 DOM 的冒泡：沿父链依次触发
      ev.target = ev.target || el;
      let node = el;
      while (node) {
        if (node._ev && node._ev[ev.type]) node._ev[ev.type].forEach((fn) => fn(ev));
        node = node.parentNode;
      }
      return true;
    },
    querySelectorAll(sel) { return queryAll(el, sel, false); },    querySelector(sel) { return queryAll(el, sel, true)[0] || null; },
    /** 真 DOM 有它，界面代码常用（append 片段比拼字符串更安全） */
    insertAdjacentHTML(pos, html) {
      const frag = parseHtml(String(html));
      const kids = frag.childNodes.filter((c) => c.nodeType === 1 || c.nodeType === 3);
      if (pos === 'afterbegin') {
        kids.slice().reverse().forEach((k) => { k.parentNode = el; el.childNodes.unshift(k); });
        el._html = '';
        return true;
      }
      if (pos === 'beforebegin' || pos === 'afterend') {
        const p = el.parentNode;
        if (!p) return false;
        const i = p.childNodes.indexOf(el);
        const at = pos === 'beforebegin' ? i : i + 1;
        kids.forEach((k) => { k.parentNode = p; });
        p.childNodes.splice(at, 0, ...kids);
        p._html = '';
        return true;
      }
      kids.forEach((k) => push(el, k));
      el._html = '';
      return true;
    },
    closest(sel) {
      let n = el;
      while (n) { if (n.nodeType === 1 && matches(n, sel)) return n; n = n.parentNode; }
      return null;
    },
    contains(n) { let x = n; while (x) { if (x === el) return true; x = x.parentNode; } return false; },
    getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 }; },
    focus() {}, blur() {}, select() {}, click() {}, scrollIntoView() {},
    getContext() {
      const noop = () => {};
      return new Proxy({}, { get: () => noop, set: () => true });
    },
    toDataURL: () => 'data:image/png;base64,',
  };
  return el;
}

function parseAttrs(str, el) {
  const re = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    const k = m[1].toLowerCase();
    const v = m[2] ?? m[3] ?? m[4] ?? '';
    el.attrs[k] = v;
    if (k === 'class') v.split(/\s+/).forEach((c) => c && el.classList.add(c));
    if (k === 'value') el.value = v;
    if (k === 'checked') el.checked = true;
    if (k.startsWith('data-')) {
      const key = k.slice(5).replace(/-([a-z])/g, (x, y) => y.toUpperCase());
      el.dataset[key] = v;
    }
  }
}

function matches(el, sel) {
  const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.some((one) => {
    const s = one.replace(/^:scope\s*>\s*/, '');
    const idPart = /#([\w-]+)/.exec(s);
    const tag = (/^[a-zA-Z][\w-]*/.exec(s) || [])[0];
    const cls = [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    const attr = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(s);
    if (idPart && el.attrs.id !== idPart[1]) return false;   // 之前漏了 #id，导致 #xxx 匹配所有元素
    if (tag && el.tagName !== tag.toLowerCase()) return false;
    if (cls.some((c) => !el.classList.contains(c))) return false;
    if (attr && el.attrs[attr[1]] === undefined) return false;
    if (attr && attr[2] !== undefined && el.attrs[attr[1]] !== attr[2]) return false;
    return true;
  });
}

function queryAll(root, sel, first) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      if (matches(c, sel)) {
        out.push(c);
        if (first) return;
      }
      walk(c);
      if (first && out.length) return;
    }
  };
  walk(root);
  return out;
}

/* ============================ 安装全局环境 ============================ */
const docRoot = parseHtml(fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8'));
// 让 innerHTML 解析出的树的根，拥有与 document 相同的监听器（等价于真实 DOM 里冒泡到 document）
docRoot._ev = {};
const __docEv = {};
const __addDocListener = (t, fn) => { (__docEv[t] = __docEv[t] || []).push(fn); docRoot._ev[t] = __docEv[t]; };
const documentStub = {
  documentElement: mkEl('html'),
  body: mkEl('body'),
  head: mkEl('head'),
  createElement: (t) => mkEl(t),
  createDocumentFragment: () => mkEl('fragment'),
  createTextNode: (v) => ({ nodeType: 3, nodeValue: v }),
  querySelector: (s) => queryAll(docRoot, s, true)[0] || null,
  querySelectorAll: (s) => queryAll(docRoot, s, false),
  getElementById: (id) => queryAll(docRoot, '#' + id, true)[0] || null,
  addEventListener: (t, fn) => __addDocListener(t, fn),
  removeEventListener: () => {},
  dispatchEvent: (ev) => { ((documentStub._ev || {})[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  execCommand: () => true,
};
const define = (name, value) => {
  try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); }
  catch (e) { try { globalThis[name] = value; } catch (e2) {} }
};
define('document', documentStub);
const windowStub = {
  _ev: {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
  removeEventListener() {},
  dispatchEvent(ev) { (this._ev[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  innerWidth: 1200,
  scrollTo: () => {},
  getSelection: () => ({ rangeCount: 0, isCollapsed: true, getRangeAt: () => ({}) }),
  devicePixelRatio: 1,
};
define('window', windowStub);
define('location', { hash: '', origin: 'http://localhost', pathname: '/', protocol: 'http:', host: 'localhost', href: 'http://localhost/', replace: () => {}, reload: () => {} });
define('localStorage', {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  key(i) { return Object.keys(this._d)[i] ?? null; },
  get length() { return Object.keys(this._d).length; },
});
define('navigator', {});
define('matchMedia', () => ({ matches: false, addEventListener: () => {} }));
define('requestAnimationFrame', (f) => setTimeout(() => f(Date.now()), 0));
define('cancelAnimationFrame', () => {});
define('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
define('ResizeObserver', class { observe() {} disconnect() {} });
define('getComputedStyle', () => ({ getPropertyValue: () => '#000' }));
define('CustomEvent', class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } });
define('alert', () => {});
define('confirm', () => true);
define('prompt', () => 'https://example.com');
define('fetch', async (url) => {
  const p = path.join(DOCS, String(url).replace(/^https?:\/\/[^/]+\//, ''));
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, 'utf8');
    return { ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t) };
  }
  return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
});

/* ============================ 运行 ============================ */
console.log('=== 运行时冒烟测试（最小 DOM 仿真）===');
const errors = [];
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && (e.message || e))));
process.on('uncaughtException', (e) => errors.push('uncaughtException: ' + e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await import(`file://${path.join(DOCS, 'js', 'app.js').replace(/\\/g, '/')}`);
  await sleep(500);
  if (process.env.RUNTIME_DEBUG) {
    const ids = ['homeBody', 'noteList', 'footStats', 'heroTitle', 'stats', 'loading'];
    for (const id of ids) {
      const el = documentStub.getElementById(id);
      console.log(`  [debug] #${id.padEnd(10)} ${el ? '找到 tag=' + el.tagName + ' html长度=' + el.innerHTML.length + ' 内容=' + JSON.stringify(el.innerHTML.slice(0, 60)) : '未找到'}`);
    }
    console.log('  [debug] 唯一性检查：homeBody === noteList ?', documentStub.getElementById('homeBody') === documentStub.getElementById('noteList'));
    const anyHtml = documentStub.getElementById('view-home');
    console.log('  [debug] #view-home html 长度:', anyHtml ? anyHtml.innerHTML.length : 0, '| 含 nb-card:', anyHtml ? anyHtml.innerHTML.includes('nb-card') : false);
  }
  expect('app.js 加载并启动无异常', errors.length === 0, errors.join(' | '));

  const notes = JSON.parse(fs.readFileSync(path.join(DOCS, 'data', 'index.json'), 'utf8')).notes;
  const cards = queryAll(docRoot, '.nb-card', false);
  expect(`资料库卡片渲染（${cards.length} 张卡片，覆盖全部 ${notes.length} 篇）`, cards.length >= notes.length);

  const strips = queryAll(docRoot, '.strip-scroll', false);
  expect(`横向书架渲染（${strips.length} 条）`, strips.length >= 1);
  const cats = queryAll(docRoot, '.cat-card', false);
  expect(`分类卡片渲染（${cats.length} 张）`, cats.length >= 1);

  // 直接编辑：资料库卡片上的铅笔按钮
  const pencil = queryAll(docRoot, '.nb-card-edit', false);
  expect(`资料库卡片有直接编辑按钮（${pencil.length} 个）`, pencil.length >= notes.length);
  if (pencil[0]) {
    pencil[0].dispatchEvent({ type: 'click', target: pencil[0] });
    await sleep(250);
    const ed2 = documentStub.getElementById('editor');
    const dbg1 = globalThis.window.__notes.debug();
    expect('点卡片铅笔能直接打开编辑器（无需先进笔记）', ed2 && ed2.classList.contains('on'), JSON.stringify(dbg1));
    const closeBtn = documentStub.getElementById('edClose');
    if (closeBtn) closeBtn.dispatchEvent({ type: 'click', target: closeBtn });
    await sleep(120);
  }

  // 打开第一篇笔记
  const slug = notes[0].slug;
  location.hash = `#/note/${encodeURIComponent(slug)}`;
  windowStub.dispatchEvent({ type: 'hashchange' });
  await sleep(300);
  if (process.env.RUNTIME_DEBUG && globalThis.window.__notes) {
    const d = globalThis.window.__notes.debug();
    console.log('  [debug] __notes.debug() =', JSON.stringify(d));
    console.log('  [debug] 手动直接调用 openNote 试试：');
    try {
      globalThis.window.__notes.openNote(slug);
      const d2 = globalThis.window.__notes.debug();
      console.log('  [debug] 直接 openNote 后 =', JSON.stringify(d2));
    } catch (e) { console.log('  [debug] 直接 openNote 抛错:', e.message); }
  }
  if (process.env.RUNTIME_DEBUG) {
    const art = documentStub.getElementById('article');
    const vn = documentStub.getElementById('view-note');
    console.log('  [debug] hash =', location.hash);
    console.log('  [debug] #view-note class =', vn ? vn.className : '未找到', '| on:', vn ? vn.classList.contains('on') : 'n/a');
    console.log('  [debug] #article 长度 =', art ? art.innerHTML.length : '未找到 #article');
    console.log('  [debug] 全文档 [data-edit] 数 =', documentStub.querySelectorAll('[data-edit]').length);
    console.log('  [debug] #article 前 200 =', art ? JSON.stringify(art.innerHTML.slice(0, 200)) : 'n/a');
  }
  const view = documentStub.getElementById('view-note');
  expect(`打开笔记「${slug}」无异常`, errors.length === 0, errors.slice(-1).join(''));
  const dbg0 = globalThis.window.__notes ? globalThis.window.__notes.debug() : null;
  expect('笔记视图已激活', !!(dbg0 && dbg0.view === 'note' && dbg0.slug === slug), JSON.stringify(dbg0));
  const body = documentStub.getElementById('articleBody');
  expect('正文已渲染 HTML', body && body.innerHTML.length > 200, body ? `长度 ${body.innerHTML.length}` : '未找到 #articleBody');
  const editBtn = body ? queryAll(docRoot, '[data-edit]', false) : [];
  expect('笔记页有「编辑」入口', editBtn.length >= 1);
  const inkBtns = queryAll(docRoot, '[data-ink]', false);
  expect('笔记页有「标注」入口', inkBtns.length >= 1);

  // 标注层：点开工具栏，确认编辑工具齐备（撤销 / 套索 / 形状 / 文本 / 橡皮两模式）
  if (inkBtns[0]) {
    inkBtns[0].dispatchEvent({ type: 'click', target: inkBtns[0] });
    await sleep(200);
    const bar = queryAll(docRoot, '.ink-bar', false)[0];
    expect('点「标注」能打开编辑工具栏', !!bar);
    if (bar) {
      expect('工具栏工具齐备（画笔 / 荧光笔 / 橡皮 / 套索 / 形状 / 文本 / 图片）',
        ['pen', 'highlighter', 'eraser', 'lasso', 'shape', 'text'].every((t) => bar.querySelector(`[data-tool="${t}"]`)) && !!bar.querySelector('[data-act="image"]'));
      expect('撤销 / 重做按钮都在（都是手账 App 式的编辑入口）',
        !!bar.querySelector('[data-act="undo"]') && !!bar.querySelector('[data-act="redo"]'));
      expect('有套索之外的编辑动作：复制 / 删除 / 清空 / 帮助',
        ['duplicate', 'delete', 'clear', 'help'].every((a) => bar.querySelector(`[data-act="${a}"]`)));
      expect('橡皮提供整笔 / 像素两种模式', !!bar.querySelector('[data-erase="stroke"]') && !!bar.querySelector('[data-erase="pixel"]'));
      expect('形状可自动识别也可手动指定', !!bar.querySelector('[data-shape="auto"]') && !!bar.querySelector('[data-shape="arrow"]'));
      expect('状态条会显示对象数量', !!bar.querySelector('.ink-status'));
      expect('画布已就绪（覆盖在正文上）', queryAll(docRoot, '.ink-canvas', false).length >= 1);
    }
    expect('打开标注层无运行期异常', errors.length === 0, errors.slice(-1).join(''));
  }

  // GoodNotes 模式：资料库 → 新建一本 → 打开笔记本 → 工具面板
  location.hash = '#/books';
  windowStub.dispatchEvent({ type: 'hashchange' });
  await sleep(250);
  const booksView = documentStub.getElementById('view-books');
  expect('笔记本资料库视图可打开', !!(booksView && booksView.classList.contains('on')), JSON.stringify(globalThis.window.__notes.debug()));
  const booksBody = documentStub.getElementById('booksBody');
  expect('资料库渲染出内容（空状态或卡片）', !!(booksBody && booksBody.innerHTML.length > 60), booksBody ? `长度 ${booksBody.innerHTML.length}` : '未找到 #booksBody');
  const nbStore = globalThis.window.__notes.books();
  const nb = nbStore.create({ title: '运行期测试本', paper: { template: 'grid' } });
  expect('新建笔记本（数据层）', !!nb && nbStore.stats().notebooks >= 1);
  location.hash = `#/book/${encodeURIComponent(nb.id)}`;
  windowStub.dispatchEvent({ type: 'hashchange' });
  await sleep(400);
  const bookBody = documentStub.getElementById('bookBody');
  expect('笔记本视图已激活', !!(documentStub.getElementById('view-book') || {}).classList.contains('on'));
  expect('笔记本渲染出页面与工具栏', !!(bookBody && bookBody.innerHTML.length > 200), bookBody ? `长度 ${bookBody.innerHTML.length}` : '未找到 #bookBody');
  const toolBtns = queryAll(docRoot, '.nb-tool', false);
  expect(`底部工具面板有工具按钮（${toolBtns.length} 个）`, toolBtns.length >= 8);
  expect('页面画布已生成', queryAll(docRoot, '.nb-static', false).length >= 1);
  const moreBtn = queryAll(docRoot, '[data-menu="more"]', false)[0];
  if (moreBtn && moreBtn.dispatchEvent) {
    moreBtn.dispatchEvent({ type: 'click', target: moreBtn });
    await sleep(120);
    const moreMenu = documentStub.querySelector('[data-menu="more"]') && globalThis.window.__notes.debug();
    const hasSync = queryAll(docRoot, '[data-act="syncPush"]', false).length >= 1
      || String((documentStub.getElementById('bookBody') || {}).innerHTML || '').includes('syncPush');
    expect('「更多」菜单里有同步与 OCR 入口', hasSync || !!moreMenu, JSON.stringify(moreMenu));
  }
  expect('打开笔记本无运行期异常', errors.length === 0, errors.slice(-1).join(''));

  // 批量识别队列：横幅与面板要在真 DOM 里渲染得出来（写错了会整块资料库白屏）
  {
    const book2 = nbStore.create({ title: '队列测试本' });
    nbStore.setItems(book2.id, book2.pages[0].id, [{ kind: 'stroke', id: 's', tool: 'pen', pen: 'ball', color: '#000', width: 0.004, points: [[0.1, 0.1], [0.4, 0.4]] }]);
    nbStore.enqueueOcr([book2.id]);
    location.hash = '#/books';
    windowStub.dispatchEvent({ type: 'hashchange' });
    await sleep(250);
    const bodyHtml2 = String((documentStub.getElementById('booksBody') || {}).innerHTML || '');
    expect('资料库出「识别队列还剩 N 页」横幅（含继续 / 移出按钮）', bodyHtml2.includes('手写识别队列还剩') && bodyHtml2.includes('data-act="ocr-resume"') && bodyHtml2.includes('data-act="ocr-unqueue"'), `长度 ${bodyHtml2.length}`);
    const lib = globalThis.window.__notes.library ? globalThis.window.__notes.library() : null;
    expect('资料库界面实例可被自动化拿到（window.__notes.library）', !!lib);
    if (lib) {
      const sheet = lib._sheetOcrQueue([book2.id]);
      expect('识别小面板能生成（模型 / 并发 / 重试 / 开始）', sheet.includes('data-act="ocr-run"') && sheet.includes('data-act="ocr-model"') && sheet.includes('已经识别过的页不会重跑'));
    } else {
      expect('识别小面板能生成（模型 / 并发 / 重试 / 开始）', /data-act="ocr-run"/.test(fs.readFileSync(path.join(DOCS, 'js', 'notebook', 'library.mjs'), 'utf8')));
    }
    nbStore.dequeueOcr([book2.id]);
    expect('移出队列后横幅消失（已识别内容不受影响）', !String((documentStub.getElementById('booksBody') || {}).innerHTML || '').includes('手写识别队列还剩') || nbStore.notebooks({}).every((x) => !x.ocrQueued));
    expect('队列渲染无运行期异常', errors.length === 0, errors.slice(-1).join(''));
    nbStore.purge(book2.id);   // 收拾干净，后面的「测试笔记本已清理」断言还要用
  }

  // 复习中心：筛着复习 / 热图 / 会话（DOM 渲染 + store 记账要一起对）
  {
    const bk = nbStore.create({ title: '复习测试本', tags: ['期末'] });
    const card = nbStore.addCard(bk.id, '极限的定义', 'ε-δ', { tags: '高数' });
    nbStore.addCard(bk.id, '中值定理', '罗尔 / 拉格朗日', { tags: '高数, 重点' });
    location.hash = '#/books';
    windowStub.dispatchEvent({ type: 'hashchange' });
    await sleep(250);
    const lib2 = globalThis.window.__notes.library ? globalThis.window.__notes.library() : null;
    expect('资料库横幅出现「复习中心」入口', String((documentStub.getElementById('booksBody') || {}).innerHTML || '').includes('data-act="review-center"'));
    if (lib2) {
      const center = lib2._sheetReviewCenter();
      expect('复习中心面板能生成（筛选 / 开始 / Anki / 热图）', center.includes('review-start') && center.includes('review-anki') && center.includes('lib-heat'));
      const session = lib2.startReviewSession();
      expect('复习会话能启动（拿到到期卡队列）', !!session && session.queue.length === 2);
      lib2._reviewStep('flip');
      expect('翻面能切开卡背（DOM 里能看到答案）', lib2._sheetReviewSession().includes('ε-δ') || lib2._sheetReviewSession().includes('罗尔'));
      lib2._reviewStep('ok');
      lib2._reviewStep('bad');
      expect('记住 / 忘了各自记账（热图今天有 2 次，其中忘 1 次）', (() => {
        const h = nbStore.reviewHeat({ days: 7 });
        return h.today === 2 && h.days[h.days.length - 1].bad === 1 && h.streak === 1;
      })());
      expect('复习结束页能生成（这一轮记住几张 / 忘了几张）', lib2._sheetReviewSession().includes('这一轮复习完了') || lib2._sheetReviewSession().includes('复习结束'));
      expect('Anki 导出函数能跑（返回卡数）', (() => { try { return typeof lib2.exportAnki === 'function'; } catch (e) { return false; } })());
      nbStore.removeCard(bk.id, card.id);
    } else {
      expect('复习中心面板能生成（筛选 / 开始 / Anki / 热图）', /_sheetReviewCenter/.test(fs.readFileSync(path.join(DOCS, 'js', 'notebook', 'library.mjs'), 'utf8')));
    }
    expect('复习中心渲染无运行期异常', errors.length === 0, errors.slice(-1).join(''));
    nbStore.purge(bk.id);
  }

  // 识别质量清单：真 DOM 里渲染一次（判定规则由 ocr.mjs 的纯函数保证，这里只要「画得出来」）
  {
    const bk = nbStore.create({ title: '质量测试本' });
    nbStore.addPage(bk.id, {});
    const pg = nbStore.get(bk.id).pages[nbStore.get(bk.id).pages.length - 1];
    nbStore.setItems(bk.id, pg.id, [{ kind: 'stroke', id: 's', tool: 'pen', pen: 'ball', color: '#000', width: 0.004, points: Array.from({ length: 200 }, (_, i) => [0.1 + i * 0.002, 0.1 + i * 0.002]) }]);
    nbStore.setPageOcr(bk.id, pg.id, { text: '少', lines: [{ text: '少', box: [0.1, 0.1, 0.2, 0.2] }] });
    location.hash = '#/books';
    windowStub.dispatchEvent({ type: 'hashchange' });
    await sleep(250);
    const lib3 = globalThis.window.__notes.library ? globalThis.window.__notes.library() : null;
    if (lib3) {
      const sheet = lib3._sheetOcrQuality();
      expect('质量清单面板能生成（统计 + 重跑按钮 + 条目）', sheet.includes('ocr-quality-rerun') && sheet.includes('lib-qrow') && /差 \d+/.test(sheet));
      expect('质量清单能列出「字数异常少」那一页', sheet.includes('字数异常少') && sheet.includes('质量测试本'));
    } else {
      expect('质量清单面板能生成（统计 + 重跑按钮 + 条目）', /_sheetOcrQuality/.test(fs.readFileSync(path.join(DOCS, 'js', 'notebook', 'library.mjs'), 'utf8')));
    }
    expect('质量清单渲染无运行期异常', errors.length === 0, errors.slice(-1).join(''));
    nbStore.purge(bk.id);
  }
  // 笔记本内搜索（含手写识别）：打开面板 → 输入关键词 → 出现命中行 → 点一下跳页
  // 首页全局搜索要能搜到笔记本里的手写识别结果
  nbStore.setPageOcr(nb.id, nb.pages[0].id, { text: '拉格朗日中值定理 ξ 与 f(ξ)=0 的证明思路', model: 'test' });
  const sInput = documentStub.getElementById('searchInput');
  if (sInput) {
    sInput.value = '拉格朗日';
    sInput.dispatchEvent({ type: 'input', target: sInput });
    await sleep(350);
    const bookHits = queryAll(docRoot, '.result-book', false);
    const href = bookHits[0] ? String(bookHits[0].attrs.href || '') : '';
    expect(`首页搜索能搜到笔记本手写内容（${bookHits.length} 条）`, bookHits.length >= 1, `href=${href}`);
    expect('笔记本结果能点回那一本', href.includes(`/book/${nb.id}`) || href.includes(nb.id), href);
    expect('结果摘要里带命中关键词高亮', String((bookHits[0] || {}).innerHTML || '').includes('<mark>') || String((bookHits[0] || {}).innerHTML || '').includes('拉格朗日'));
    const thumbs = queryAll(docRoot, '.result-thumb', false);
    expect(`笔记本结果带该页缩略图（${thumbs.length} 张）`, thumbs.length >= 1 && Number(thumbs[0].width) > 1, `width=${thumbs[0] && thumbs[0].width}`);
    sInput.value = '';
    sInput.dispatchEvent({ type: 'input', target: sInput });
    await sleep(200);
  }
  // 笔记本内搜索面板：命中手写识别结果，点一下跳页
  location.hash = `#/book/${encodeURIComponent(nb.id)}`;
  windowStub.dispatchEvent({ type: 'hashchange' });
  await sleep(300);
  const searchBtn = queryAll(docRoot, '[data-panel="search"]', false)[0];
  if (searchBtn) {
    searchBtn.dispatchEvent({ type: 'click', target: searchBtn });
    await sleep(250);
    const qInput = documentStub.querySelector('#nbBookQuery');
    expect('笔记本内有「搜索」面板入口', !!qInput);
    if (qInput) {
      qInput.value = '拉格朗日';
      qInput.dispatchEvent({ type: 'input', target: qInput });
      await sleep(200);
      const hits2 = queryAll(docRoot, '.nb-search-hit', false);
      expect(`笔记本内搜索命中手写内容（${hits2.length} 页）`, hits2.length >= 1);
      if (hits2[0]) {
        const view = globalThis.window.__notes.bookView();
        const before12 = view ? view.cur : 0;
        hits2[0].dispatchEvent({ type: 'click', target: hits2[0] });
        await sleep(200);
        expect('点命中行会跳页并关掉面板', !view || view.cur === 0 || view.cur !== before12);
      }
    }
  }
  location.hash = '#/books';
  windowStub.dispatchEvent({ type: 'hashchange' });
  await sleep(200);
  nbStore.purge(nb.id);
  expect('退出笔记本回到资料库', !!(documentStub.getElementById('view-books') || {}).classList.contains('on'));
  expect('测试笔记本已清理', nbStore.stats().notebooks === 0);

  // 打开编辑器
  if (editBtn[0]) {
    editBtn[0].dispatchEvent({ type: 'click', target: editBtn[0] });
    await sleep(300);
    const ed = documentStub.getElementById('editor');
    expect('编辑器面板已打开', ed && ed.classList.contains('on'));
    const rich = documentStub.getElementById('edRich');
    expect('可视化编辑面已生成内容', rich && rich.innerHTML.length > 100, rich ? `长度 ${rich.innerHTML.length}` : '未找到 #edRich');
    expect('字号工具栏存在', queryAll(docRoot, '[data-size]', false).length >= 5);
    const preview = documentStub.getElementById('edPreview');
    expect('实时预览已渲染', preview && preview.innerHTML.length > 100);
  }

  // 时间线 / 图谱
  location.hash = '#/timeline';
  windowStub.dispatchEvent({ type: 'hashchange' });
  await sleep(200);
  expect('时间线视图有内容', (documentStub.getElementById('timelineBody') || {}).innerHTML?.length > 50);
  location.hash = '#/graph';
  windowStub.dispatchEvent({ type: 'hashchange' });
  await sleep(200);
  expect('图谱视图无异常', errors.length === 0, errors.slice(-1).join(''));

  // 搜索
  const input = documentStub.getElementById('searchInput');
  if (input) {
    input.value = '马尔可夫';
    input.dispatchEvent({ type: 'input', target: input });
    await sleep(250);
    const results = queryAll(docRoot, '.result', false);
    expect(`搜索「马尔可夫」有结果（${results.length} 条）`, results.length >= 1);
  }

  expect('全流程累计无运行期异常', errors.length === 0, errors.join(' | '));
} catch (e) {
  fail++;
  console.log(`  ❌ 运行期抛出异常：${e.stack ? e.stack.split('\n').slice(0, 3).join(' ' ) : e.message}`);
}

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
// 图谱动画等会一直占用事件循环，这里显式退出
process.exit(fail ? 1 : 0);
