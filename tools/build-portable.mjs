#!/usr/bin/env node
/**
 * 生成离线便携版单文件： dist/我的笔记-离线版.html
 * 双击即可阅读（file:// 协议也能跑）：样式、数据、脚本全部内联，不依赖网络与本地服务器。
 * 用法： node tools/build-portable.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, '我的笔记-离线版.html');
// 便携版放在 dist/，附件按 ../docs/assets/... 引用，双击 HTML 时浏览器能按相对路径读到
const ASSET_PREFIX = '../docs/';

export function main() {
  const idxPath = path.join(DOCS, 'data', 'index.json');
  if (!fs.existsSync(idxPath)) {
    console.error('✗ 缺少 docs/data/index.json，请先运行 node tools/build.mjs');
    return false;
  }

  const payload = fs.readFileSync(idxPath, 'utf8');
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');

  // 内联顺序即依赖顺序（被依赖的在前），全部拍平到同一作用域
  const parts = [
    'lib/markdown.mjs',
    'lib/site-build.mjs',
    'docs/js/search.js',
    'docs/js/highlight.js',
    'docs/js/graph.js',
    'docs/js/ink.mjs',
    'docs/js/rte.mjs',
    'docs/js/install.mjs',
    'docs/js/notebook/paper.mjs',
    'docs/js/notebook/store.mjs',
    'docs/js/notebook/study.mjs',
    'docs/js/notebook/ocr.mjs',
    'docs/js/notebook/asr.mjs',
    'docs/js/notebook/sync.mjs',
    'docs/js/notebook/page.mjs',
    'docs/js/notebook/library.mjs',
    'docs/js/notebook/viewer.mjs',
    'docs/js/editor.mjs',
    'docs/js/app.js',
  ].map((f) => ({ f, code: fs.readFileSync(path.join(ROOT, f), 'utf8') }));

  // 打包后同一作用域内不得有重复的顶层声明
  const declRe = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  const owners = new Map();
  const clashes = [];
  for (const { f, code } of parts) {
    for (const m of code.matchAll(declRe)) {
      const name = m[1];
      if (owners.has(name)) clashes.push(`${name}（${owners.get(name)} × ${f}）`);
      else owners.set(name, f);
    }
  }
  if (clashes.length) {
    console.error('✗ 无法内联：模块间存在同名顶层声明，请改名后重试：');
    for (const c of clashes.slice(0, 10)) console.error('   - ' + c);
    return false;
  }

  const bundle = parts
    .map(({ f, code }) =>
      `/* ===== ${f} ===== */\n` +
      code
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')          // 去掉 import（已在同一作用域）
        .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, '') // 去掉 export
        .replace(/^const isDirect = process\.argv[\s\S]*?^\}\s*$/gm, '')               // 去掉 Node 专用入口守卫
        .replace(/^\s*boot\(\)\.catch[\s\S]*?;\s*$/gm, '')                             // 启动改为末尾统一执行
        .replace(/^\s*boot\(\);\s*$/gm, '')
    )
    .join('\n\n');

  // 站点配置（可选）
  const siteCfg = path.join(DOCS, 'data', 'site.json');
  const siteJson = fs.existsSync(siteCfg) ? fs.readFileSync(siteCfg, 'utf8') : 'null';

  let out = html.replace(/<link rel="manifest"[^>]*>\s*/g, '');
  // 所有样式表逐个内联（含 GoodNotes 模式的三份）
  for (const f of ['style.css', 'notebook-base.css', 'notebook-library.css', 'notebook-viewer.css']) {
    const css = fs.readFileSync(path.join(DOCS, 'css', f), 'utf8');
    const re = new RegExp(`<link rel="stylesheet" href="css/${f.replace(/\./g, '\\.')}"[^>]*>`);
    if (!re.test(out)) {
      console.error(`✗ 内联失败：index.html 里找不到 css/${f} 的样式表引用`);
      return false;
    }
    out = out.replace(re, `<style>\n/* ${f} */\n${css}\n</style>`);
  }
  out = out
    .replace(
      /<script[^>]*src="js\/app\.js[^"]*"[^>]*><\/script>/,
      `<script>${escScript(bundle)}\n\n/* ---- 启动 ---- */\nboot().catch(function (e) { showFatal(e); });\n</script>`
    )
    .replace(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/katex[^>]*><\/script>/, '')
    .replace(/<link[^>]*href="https:\/\/cdn\.jsdelivr\.net\/npm\/katex[^>]*>/, '<!-- 离线便携版不含 KaTeX：公式会降级为等宽文本，内容不丢 -->')
    .replace(/<title>(.*?)<\/title>/, '<title>$1 · 离线版</title>');

  // 校验：脚本真的内联进去了（标注层与笔记本模式的类也要在，否则离线版点了没反应）
  const missing = ['class Editor', 'function renderDocument', 'class InkLayer', 'class LibraryUI', 'class NotebookView', 'class PageEditor']
    .filter((needle) => !out.includes(needle));
  if (missing.length) {
    console.error('✗ 内联失败：便携版里缺少这些定义 → ' + missing.join(' / '));
    return false;
  }

  // 注入数据 + 附件路径前缀
  const inject = `
<script>
window.__NOTES_DATA__ = ${escScript(payload)};
window.__NOTES_SITE__ = ${escScript(siteJson)};
window.__NOTES_PORTABLE__ = true;
window.__NOTES_ASSET_PREFIX__ = ${JSON.stringify(ASSET_PREFIX)};
</script>`;
  out = out.replace('</head>', `${inject}\n</head>`);

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`✓ 便携版已生成：${path.relative(ROOT, OUT)}（${kb} KB，含 ${JSON.parse(payload).notes.length} 篇笔记）`);
  console.log('  双击该文件即可离线阅读；把它发到手机/别人的电脑也能直接打开。');
  return true;
}

/** 安全嵌入 <script>：把可能提前闭合脚本的序列转义掉 */
function escScript(s) {
  return String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  const ok = main();
  if (!ok) process.exitCode = 1;
}
