#!/usr/bin/env node
/**
 * 前端模块链接测试（不需要浏览器）
 * 浏览器加载 ES 模块时，只要 import 的名字在目标模块里不存在，整段脚本就不会执行，
 * 页面会永远停在「正在载入…」。这类错误语法检查（node --check）查不出来。
 * 本测试做两件事：
 *   1) 静态对账：每个 import 的名字必须在目标模块里 export
 *   2) 真跑一遍：补齐最小 DOM 桩后真的 import docs/js/*.js，捕获链接期与启动期异常
 * 用法： node tools/test-modules.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'docs', 'js');
const MODULES = ['search.js', 'highlight.js', 'graph.js', 'rte.mjs', 'ink.mjs', 'install.mjs', 'editor.mjs', 'app.js'];
const LIB_MODULES = ['lib/markdown.mjs', 'lib/site-build.mjs'];

export async function main() {
let pass = 0, fail = 0;
const expect = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('=== 前端模块链接测试 ===');

/* ---------- 1. 静态对账（自动跟随 import 目标，含 lib/ 共享模块） ---------- */
console.log('\n— 导入 / 导出对账 —');

function exportsOf(code) {
  const out = new Set();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      if (bits.length) out.add((bits[1] || bits[0]).trim());
    }
  }
  return out;
}

/** 读取一个文件；相对路径按「以 docs/ 为 Web 根」解析（浏览器里 href 就是这么找文件的） */
const cache = new Map();
function readModule(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const abs = path.resolve(ROOT, 'docs', relPath);
  const code = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  cache.set(relPath, code);
  return code;
}

/** 把 import 里的相对说明符解析成「相对 docs/」的路径 */
function resolveSpecifier(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromRel);
  return path.posix.normalize(path.posix.join(fromDir, spec));
}

const queue = MODULES.map((m) => `js/${m}`);
const visited = new Set();
let importCount = 0;

while (queue.length) {
  const from = queue.shift();
  if (visited.has(from)) continue;
  visited.add(from);
  const code = readModule(from);
  if (code == null) { expect(`${from} 存在`, false, '文件不存在'); continue; }

  const re = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(code))) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    importCount += names.length;
    const target = resolveSpecifier(from, m[2]);
    if (!target || !/\.(m?js)$/.test(target)) continue; // 非 JS 或无扩展名，跳过
    const targetCode = readModule(target);
    if (targetCode == null) {
      expect(`${from} → ${target}`, false, '目标模块在 docs/ 下不存在（线上会 404，整站脚本不执行）');
      continue;
    }
    queue.push(target);
    const exp = exportsOf(targetCode);
    const missing = names.filter((n) => !exp.has(n));
    expect(
      `${from} ← ${target} 导入 ${names.length} 个（${names.join(', ')}）`,
      missing.length === 0,
      missing.length ? `缺失导出：${missing.join(', ')}` : ''
    );
  }
}

/* ---------- 1.5 浏览器解析路径检查（import 的目标必须在 docs/ 下真实存在） ---------- */
console.log('\n— 浏览器实际请求路径检查 —');
const servedFiles = [];
function walkDocs(dir, base = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walkDocs(path.join(dir, e.name), rel);
    else servedFiles.push(rel);
  }
}
walkDocs(path.join(ROOT, 'docs'));
for (const from of visited) {
  const code = readModule(from);
  if (!code) continue;
  for (const m of code.matchAll(/from\s*'([^']+)'/g)) {
    const target = resolveSpecifier(from, m[1]);
    if (!target || !/\.(m?js)$/.test(target)) continue;
    expect(`${from} 引用的 ${target} 已发布（docs/ 下存在）`, servedFiles.includes(target), '线上会 404 → 整站脚本不执行');
  }
}

/* ---------- 2. 在 Node 里真的 import 一遍（DOM 桩） ---------- */
console.log('\n— 真实加载（含启动流程）—');
function makeStub(name) {
  const store = {};
  const target = function () {};
  return new Proxy(target, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => `[stub ${name}]`;
      if (prop === 'length') return 0;
      if (prop === 'matches' || prop === 'closest' || prop === 'contains') return () => null;
      if (prop === 'getAttribute' || prop === 'getPropertyValue') return () => '';
      if (prop === 'querySelectorAll') return () => [];
      if (prop === 'querySelector') return () => makeStub('el'); // 模拟真实 DOM：找不到也返回元素对象，让 null 解引用暴露出来
      if (prop === 'getBoundingClientRect') return () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 });
      if (prop === 'addEventListener' || prop === 'removeEventListener' || prop === 'appendChild' || prop === 'focus' || prop === 'select' || prop === 'setAttribute' || prop === 'removeAttribute' || prop === 'remove' || prop === 'toggle') return () => {};
      if (prop === 'classList' || prop === 'style' || prop === 'dataset') return store[prop] || (store[prop] = makeStub(prop));
      if (prop in store) return store[prop];
      return makeStub(String(prop));
    },
    set(_, prop, v) { store[prop] = v; return true; },
    apply() { return makeStub(`${name}()`); },
  });
}

const domStub = makeStub('dom');
const define = (name, value) => {
  try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); }
  catch (e) { try { globalThis[name] = value; } catch (e2) {} }
};
define('document', domStub);
define('window', makeStub('window'));
define('navigator', makeStub('navigator'));
define('location', { hash: '', origin: 'http://localhost', pathname: '/', protocol: 'http:', host: 'localhost' });
define('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
define('matchMedia', () => ({ matches: false, addEventListener: () => {} }));
define('requestAnimationFrame', (fn) => setTimeout(fn, 0));
define('IntersectionObserver', class { observe() {} disconnect() {} });
define('ResizeObserver', class { observe() {} disconnect() {} });
define('getComputedStyle', () => ({ getPropertyValue: () => '#000' }));
define('fetch', async (url) => {
  const p = path.join(ROOT, 'docs', String(url).replace(/^https?:\/\/[^/]+\//, ''));
  if (fs.existsSync(p)) {
    const body = fs.readFileSync(p, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
});

for (const mod of ['search.js', 'highlight.js', 'graph.js']) {
  try {
    const ns = await import(`file://${path.join(JS, mod).replace(/\\/g, '/')}`);
    expect(`${mod} 可被正常加载（导出 ${Object.keys(ns).length} 项）`, Object.keys(ns).length > 0);
  } catch (e) {
    expect(`${mod} 可被正常加载`, false, '→ ' + e.message);
  }
}

try {
  await import(`file://${path.join(JS, 'app.js').replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 300)); // 让 boot() 的异步流程跑完
  expect('app.js 可被正常加载并完成启动流程（无链接期/启动期异常）', true);
} catch (e) {
  expect('app.js 可被正常加载并完成启动流程', false, '→ ' + (e && e.message));
}

/* ---------- 3. index.html 的引用完整性 ---------- */
console.log('\n— index.html 引用 —');
const html = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
for (const [m, re] of [['css/style.css', /href="css\/style\.css"/], ['js/app.js', /src="js\/app\.js(\?v=\d+)?"/], ['manifest', /rel="manifest"/]]) {
  expect(`引用了 ${m}`, re.test(html));
}
const domIds = ['segs', 'listToggle', 'newBtn', 'newSheet', 'templateList', 'quicklook', 'qlBody', 'ctxMenu', 'noteList', 'homeBody', 'editor'];
const missIds = domIds.filter((id) => !html.includes(`id="${id}"`));
expect(`关键容器齐备（${domIds.length} 个）`, missIds.length === 0, missIds.join(','));

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
  return fail === 0;
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  const ok = await main();
  if (!ok) process.exitCode = 1;
}
