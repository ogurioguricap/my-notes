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
  const css = fs.readFileSync(path.join(DOCS, 'css', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');

  // 三个模块按顺序拼接为一个脚本（解析出来的所有顶层标识符都存在，运行时才求值）
  const parts = ['search.js', 'highlight.js', 'graph.js', 'app.js'].map((f) => ({
    f,
    code: fs.readFileSync(path.join(DOCS, 'js', f), 'utf8'),
  }));

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
        .replace(/boot\(\);\s*$/m, '')                                                  // 末尾统一启动一次
    )
    .join('\n\n');

  // 站点配置（可选）
  const siteCfg = path.join(DOCS, 'data', 'site.json');
  const siteJson = fs.existsSync(siteCfg) ? fs.readFileSync(siteCfg, 'utf8') : 'null';

  let out = html
    .replace(/<link rel="manifest"[^>]*>\s*/g, '')
    .replace(/<link rel="stylesheet" href="css\/style\.css">/, `<style>\n${css}\n</style>`)
    .replace(/<script type="module" src="js\/app\.js"><\/script>/, `<script>${escScript(bundle)}\n\n/* ---- 启动 ---- */\nboot();\n</script>`)
    .replace(/<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/katex[^>]*><\/script>/, '')
    .replace(/<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/katex[^>]*>/, '<!-- 离线版不含 KaTeX：公式会降级为等宽文本，内容不丢 -->')
    .replace(/<title>(.*?)<\/title>/, '<title>$1 · 离线版</title>');

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
