#!/usr/bin/env node
/**
 * 静态契约检查（无需浏览器）：把「JS 依赖的 DOM 元素」与「HTML 实际提供的元素」对账，
 * 再检查构建产物的标签配平、标题层级、占位符残留、路径安全性。
 * 用法： node tools/selfcheck.mjs      （也可被 tools/update.mjs 以模块方式调用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'docs');

export function main() {
  let pass = 0;
  let fail = 0;
  const problems = [];

  const ok = (msg) => { pass++; console.log(`  ✅ ${msg}`); };
  const bad = (msg) => { fail++; problems.push(msg); console.log(`  ❌ ${msg}`); };
  const head = (t) => console.log(`\n=== ${t} ===`);
  const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');

  /* ---------------- 1. JS ↔ HTML 的 DOM 契约 ---------------- */
  head('1. DOM 契约（JS 用到的 id / class 必须存在于 HTML）');
  const html = read('index.html');
  const jsFiles = ['js/app.js', 'js/graph.js', 'js/search.js', 'js/highlight.js'].map((f) => ({ f, code: read(f) }));

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const htmlClasses = new Set();
  for (const m of html.matchAll(/\bclass="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => htmlClasses.add(c));

  const runtimeIds = new Set(['toast', 'articleBody', 'fixCacheBtn']); // 运行时动态创建/赋值的元素（fixCacheBtn 只在页面报错时生成）
  const usedIds = new Set();
  for (const { code } of jsFiles) {
    for (const m of code.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'/g)) usedIds.add(m[1]);
    for (const m of code.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'/g)) usedIds.add(m[1]);
  }
  for (const id of runtimeIds) usedIds.delete(id);
  const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
  missingIds.length
    ? bad(`HTML 缺少被 JS 引用的 id：${missingIds.join(', ')}`)
    : ok(`JS 引用的 ${usedIds.size} 个 id 全部存在于 HTML（另有 ${runtimeIds.size} 个运行时生成）`);

  for (const { code } of jsFiles) {
    for (const m of code.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'/g)) {
      const id = m[1];
      if (htmlIds.has(id) || runtimeIds.has(id)) continue;
      bad(`getElementById('${id}') 在 HTML 里不存在，也没有被 JS 创建`);
    }
  }

  const views = [];
  for (const { code } of jsFiles) for (const m of code.matchAll(/setView\(\s*'([a-z]+)'/g)) views.push(m[1]);
  const missingViews = [...new Set(views)].filter((v) => !htmlIds.has(`view-${v}`));
  missingViews.length ? bad(`setView 缺少容器：${missingViews.join(', ')}`) : ok(`setView 的 ${new Set(views).size} 个视图容器齐备`);

  const dataViews = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  const badDataViews = dataViews.filter((v) => !views.includes(v) && v !== 'home');
  badDataViews.length
    ? bad(`顶栏按钮 data-view 与 setView 不匹配：${badDataViews.join(', ')}`)
    : ok(`顶栏视图按钮与 setView 对应：${dataViews.join(', ')}`);

  const jsClasses = new Set();
  for (const { code } of jsFiles) for (const m of code.matchAll(/\$\$?\(\s*'\.([A-Za-z0-9_-]+)/g)) jsClasses.add(m[1]);
  const css = read('css/style.css');
  const missingCss = [...jsClasses].filter((c) => !css.includes(`.${c}`) && !htmlClasses.has(c));
  missingCss.length
    ? bad(`JS 操作的 class 在 HTML/CSS 中都不存在：${missingCss.join(', ')}`)
    : ok(`JS 操作的 ${jsClasses.size} 个 class 均有样式或标记`);

  // 动态生成标记里的 class 也必须有样式（右侧是 CSS 必须覆盖的关键结构）
  const cssTokens = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
  const KEY_CLASSES = [
    'nb-card', 'nb-thumb', 'nb-card-top', 'nb-card-meta', 'nb-card-cat', 'nb-card-date', 'nb-card-foot',
    'nb-dot', 'nb-star', 'nb-badge', 'grid-notes', 'strip-scroll', 'shelf-strip', 'shelf-strip-head',
    'cats', 'cat-card', 'cat-strip', 'note-item', 'note-item-body', 'note-item-title', 'note-item-meta',
    'nb', 'shelf', 'shelf-title', 'shelf-count', 'side-empty', 'app-mark', 'btn-new',
    'segmented', 'lib', 'lib-head', 'lib-head-main', 'lib-sub', 'lib-stats', 'stat',
    'ql-body', 'ql-head', 'ql-thumb', 'ql-titles', 'ql-meta', 'ql-actions', 'ql-btn', 'ql-content',
    'ql-excerpt', 'ql-sect-title', 'ql-toc', 'ql-mask', 'sheet-body', 'sheet-mask', 'sheet-head', 'sheet-desc',
    'template-list', 'template-card', 'template-card-head', 'template-copy',
    'ctxmenu', 'result', 'result-title', 'result-snippet', 'chip', 'tag', 'pill', 'kbd',
  ];
  const missKey = KEY_CLASSES.filter((c) => !cssTokens.has(c));
  missKey.length
    ? bad(`关键界面 class 缺少 CSS 定义：${missKey.join(', ')}`)
    : ok(`关键界面 class 全部有样式（${KEY_CLASSES.length} 个：封面卡片 / 书架 / 速览 / 模板 / 分段控件）`);

  // 构建脚本必须为每篇笔记产出封面配色，前端必须真正用到
  const appCode = jsFiles.map((f) => f.code).join('\n');
  const coverUsed = /coverVars\s*\(/.test(appCode) && /coverGlyphOf\s*\(/.test(appCode);
  coverUsed
    ? ok('前端已接入封面配色（coverVars / coverGlyphOf 已被调用）')
    : bad('前端没有使用封面数据 note.cover（coverVars / coverGlyphOf 未被调用）');

  // 新版界面必备的结构性标记
  const NEEDED = ['nb-card', 'nb-thumb', 'strip-scroll', 'cat-card', 'ql-body', 'ctxMenu', 'newSheet', 'listToggle'];
  const missNeeded = NEEDED.filter((t) => !appCode.includes(t) && !html.includes(t));
  missNeeded.length
    ? bad(`新版界面缺少结构标记：${missNeeded.join(', ')}`)
    : ok(`新版界面结构齐备：${NEEDED.join(' / ')}`);

  /* ---------------- 2. 构建产物完整性 ---------------- */
  head('2. 构建产物 data/index.json');
  const dataPath = path.join(SITE, 'data', 'index.json');
  if (!fs.existsSync(dataPath)) {
    bad('缺少 data/index.json，先运行 node tools/build.mjs');
  } else {
    const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    ok(`读取成功：${d.notes.length} 篇笔记，生成于 ${d.generatedAt}`);
    d.notes.length ? ok('字段齐全：每篇含 slug/title/html/headings/search') : bad('没有任何笔记');

    const noCover = d.notes.filter((n) => !n.cover || !n.cover.ink || !n.cover.glyph);
    noCover.length
      ? bad(`缺少封面数据（cover.ink / cover.glyph）：${noCover.map((n) => n.slug).join(', ')}`)
      : ok(`封面数据齐备：${d.notes.length} 篇各有配色与首字标记（例：${d.notes[0].cover.glyph} / ${d.notes[0].cover.ink}）`);
    const catColors = new Map();
    for (const n of d.notes) if (!catColors.has(n.category)) catColors.set(n.category, n.cover.ink);
    ok(`分类配色：${[...catColors.entries()].map(([c, k]) => `${c}=${k}`).join('，')}`);

    let jump = 0;
    for (const n of d.notes) {
      let prev = 1;
      for (const h of n.headings) {
        if (h.level > prev + 1) jump++;
        prev = h.level;
      }
    }
    jump ? bad(`有 ${jump} 处标题层级跳跃（h2 → h4）`) : ok('所有笔记标题层级连续，无跳跃');

    const sentinel = d.notes.filter((n) => n.html.includes('\u0000'));
    sentinel.length
      ? bad(`有 ${sentinel.length} 篇残留内部占位符：${sentinel.map((n) => n.slug).join(', ')}`)
      : ok('无内部占位符残留');

    const leftovers = [];
    const stripCode = (h) =>
      h.replace(/<figcaption[\s\S]*?<\/figcaption>/g, ' ')
        .replace(/<pre>[\s\S]*?<\/pre>/g, ' ')
        .replace(/<code[^>]*>[\s\S]*?<\/code>/g, ' ');
    for (const n of d.notes) {
      const body = stripCode(n.html);
      const checks = [
        [/\*\*[^*\n]{2,}\*\*/, '粗体未渲染'],
        [/^\s*#{2,6}\s/m, '标题未渲染'],
        [/\[[^\]\n]+\]\([^)\n]+\)/, '链接未渲染'],
        [/^\s*\|.*\|/m, '表格未渲染'],
        [/^>\s*\[!/m, '提示框未渲染'],
      ];
      for (const [re, label] of checks) if (re.test(body)) leftovers.push(`${n.slug}: ${label}`);
    }
    leftovers.length
      ? bad(`Markdown 残留：${leftovers.join('；')}`)
      : ok('未发现未渲染的 Markdown 记号（标题/粗体/链接/表格/提示框）');

    const unclosed = [];
    for (const n of d.notes) {
      for (const tag of ['div', 'section', 'figure', 'table', 'ul', 'ol', 'blockquote', 'p']) {
        const open = (n.html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
        const close = (n.html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
        if (open !== close) unclosed.push(`${n.slug}: <${tag}> ${open} 开 / ${close} 闭`);
      }
    }
    unclosed.length
      ? bad(`标签未配平：${unclosed.slice(0, 6).join('；')}`)
      : ok('标签开闭配平（div/section/figure/table/ul/ol/blockquote/p）');

    const brokenAnchors = [];
    for (const n of d.notes) for (const h of n.headings) if (!n.html.includes(`id="${h.id}"`)) brokenAnchors.push(`${n.slug}#${h.id}`);
    brokenAnchors.length ? bad(`目录锚点找不到目标：${brokenAnchors.join(', ')}`) : ok('目录锚点全部可达');

    const dead = [];
    for (const n of d.notes) {
      for (const l of n.links) {
        const hit = d.notes.some((x) => x.slug.toLowerCase() === l.toLowerCase() || x.title === l);
        if (!hit) dead.push(`${n.slug} → ${l}`);
      }
    }
    dead.length ? bad(`双链指向不存在的笔记：${dead.join(', ')}`) : ok('所有 [[双链]] 都能解析到笔记');

    const withAttach = d.notes.filter((n) => n.attachments.length);
    ok(`附件文字已并入检索的笔记：${withAttach.length ? withAttach.map((n) => n.slug).join(', ') : '（无）'}`);
    ok(`搜索索引总字符数：${d.notes.reduce((s, n) => s + n.search.length, 0)}`);

    const absPaths = [];
    for (const n of d.notes) for (const m of n.html.matchAll(/(?:src|href)="(\/[^/"][^"]*)"/g)) absPaths.push(`${n.slug} → ${m[1]}`);
    absPaths.length
      ? bad(`存在站内绝对路径（Pages 子路径下会 404）：${absPaths.slice(0, 5).join(', ')}`)
      : ok('站内资源全部使用相对路径（适配 GitHub Pages 子路径）');
  }

  /* ---------------- 3. 资源存在性 ---------------- */
  head('3. 资源文件存在性');
  const htmlRefs = [...html.matchAll(/(?:src|href)="([^"#:]+?)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('data:') && !u.startsWith('http'));
  const missFiles = htmlRefs.filter((u) => !fs.existsSync(path.join(SITE, u.split('?')[0])));
  missFiles.length ? bad(`HTML 引用的文件不存在：${missFiles.join(', ')}`) : ok(`HTML 引用的 ${htmlRefs.length} 个本地文件都存在`);

  if (fs.existsSync(dataPath)) {
    const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const assetRefs = new Set();
    for (const n of d.notes) for (const m of n.html.matchAll(/src="(assets\/[^"]+)"/g)) assetRefs.add(m[1]);
    const missAssets = [...assetRefs].filter((u) => !fs.existsSync(path.join(SITE, u)));
    missAssets.length
      ? bad(`笔记引用的附件不存在：${missAssets.join(', ')}`)
      : ok(`笔记引用的 ${assetRefs.size} 个附件都已复制到 docs/`);
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 汇总 ================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('\n需要修复：');
    for (const p of problems) console.log(`  · ${p}`);
    return false;
  }
  console.log('静态检查全部通过 ✅（视觉细节请在浏览器里过一遍）');
  return true;
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  const ok = main();
  if (!ok) process.exitCode = 1;
}
