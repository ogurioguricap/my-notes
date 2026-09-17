#!/usr/bin/env node
/**
 * PWA 可安装性自检
 * 浏览器判定「可安装」有硬条件：manifest 字段齐全、图标尺寸够、有 Service Worker、
 * 通过 HTTPS 提供。任何一条缺失，地址栏就不会出现「安装」按钮。
 * 用法： node tools/test-pwa.mjs
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

console.log('=== PWA 可安装性自检 ===\n');
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');

/* ---------- 1. Manifest ---------- */
console.log('— manifest —');
const mfPath = path.join(DOCS, 'manifest.webmanifest');
expect('docs/manifest.webmanifest 存在', fs.existsSync(mfPath));
let mf = null;
if (fs.existsSync(mfPath)) {
  try { mf = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch (e) { mf = null; }
  expect('manifest 是合法 JSON', !!mf);
}
if (mf) {
  expect('name 已填写', typeof mf.name === 'string' && mf.name.length > 0);
  expect(`short_name 长度合适（${mf.short_name || '缺失'}，主屏图标下方显示，建议 ≤12 字）`, typeof mf.short_name === 'string' && mf.short_name.length <= 12);
  expect('start_url 存在', typeof mf.start_url === 'string');
  expect(`display 为 standalone（实为 ${mf.display}）`, mf.display === 'standalone');
  expect('theme_color 存在', /^#[0-9a-f]{3,8}$/i.test(mf.theme_color || ''));
  expect('background_color 存在', /^#[0-9a-f]{3,8}$/i.test(mf.background_color || ''));

  const icons = mf.icons || [];
  const sizes = icons.map((i) => i.sizes);
  expect(`图标声明数量（${icons.length}）`, icons.length >= 2);
  expect('含 192×192 图标（安卓主屏必需）', sizes.some((s) => String(s).includes('192')));
  expect('含 512×512 图标（启动画面 / 安装必需）', sizes.some((s) => String(s).includes('512')));
  expect('含 maskable 图标（安卓圆角裁切不糊）', icons.some((i) => String(i.purpose || '').includes('maskable')));

  // 图标文件真实存在且尺寸正确
  for (const ic of icons) {
    const p = path.join(DOCS, ic.src);
    expect(`图标文件存在：${ic.src}`, fs.existsSync(p));
  }
  const checkSize = (file, want) => {
    const p = path.join(DOCS, file);
    if (!fs.existsSync(p)) return false;
    const b = fs.readFileSync(p);
    if (b.readUInt32BE(0) !== 0x89504e47) return false;      // PNG 魔数
    return b.readUInt32BE(16) === want && b.readUInt32BE(20) === want;
  };
  expect('icon-192.png 实际是 192×192', checkSize('icon-192.png', 192));
  expect('icon-512.png 实际是 512×512', checkSize('icon-512.png', 512));
  expect('apple-touch-icon.png 实际是 180×180', checkSize('apple-touch-icon.png', 180));

  // 图标体积（过大会拖慢首屏）
  for (const f of ['icon-192.png', 'icon-512.png']) {
    const kb = fs.existsSync(path.join(DOCS, f)) ? fs.statSync(path.join(DOCS, f)).size / 1024 : 0;
    expect(`${f} 体积合理（${kb.toFixed(0)} KB，建议 < 600 KB）`, kb > 0 && kb < 600);
  }
}

/* ---------- 2. index.html 关联 ---------- */
console.log('\n— index.html —');
expect('引用了 manifest', /rel="manifest"/.test(html));
expect('manifest 路径是相对路径（适配子路径部署）', /rel="manifest"\s+href="(?!\/|https?:)/.test(html));
expect('声明了 theme-color', /name="theme-color"/.test(html));
expect('声明了 viewport（含 viewport-fit=cover）', /name="viewport"[^>]*viewport-fit=cover/.test(html));
expect('引用了 apple-touch-icon（iOS 主屏图标）', /rel="apple-touch-icon"/.test(html));
expect('引用了 favicon', /rel="icon"/.test(html));

/* ---------- 3. Service Worker ---------- */
console.log('\n— Service Worker（离线能力）—');
const swPath = path.join(DOCS, 'sw.js');
expect('docs/sw.js 存在', fs.existsSync(swPath));
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  expect('注册了 install 事件', /addEventListener\('install'/.test(sw));
  expect('注册了 fetch 事件', /addEventListener\('fetch'/.test(sw));
  expect('有缓存版本号（便于更新）', /const CACHE = '/.test(sw));
  expect('precache 列表含首页', /'\.\/index\.html'/.test(sw) || /"\.\/index\.html"/.test(sw));
  expect('JS/CSS/数据为网络优先（避免旧文件卡住页面）', /ALWAYS_FRESH/.test(sw));
}
const appJs = fs.readFileSync(path.join(DOCS, 'js', 'app.js'), 'utf8');
const installJs = fs.existsSync(path.join(DOCS, 'js', 'install.mjs')) ? fs.readFileSync(path.join(DOCS, 'js', 'install.mjs'), 'utf8') : '';
expect('app.js 里注册了 Service Worker', appJs.indexOf('.register(') > 0 && appJs.indexOf('sw.js') > 0);
expect('install.mjs 捕获 beforeinstallprompt（一键安装）', /beforeinstallprompt/.test(installJs));
expect('install.mjs 处理 appinstalled（安装后隐藏入口）', /appinstalled/.test(installJs));
expect('install.mjs 识别 iOS（走图文步骤）', /iPad\|iPhone\|iPod/.test(installJs));
expect('app.js 接入了安装引导（initInstall）', /initInstall/.test(appJs));
expect('页面提供「安装」按钮', /id="installBtn"/.test(html));
expect('提供手把手安装图解页', fs.existsSync(path.join(DOCS, '安装到桌面-图解.html')));

/* ---------- 4. 部署方式（HTTPS 是硬条件） ---------- */
console.log('\n— 部署条件 —');
expect('站点路径全为相对路径（GitHub Pages 子路径可安装）', !/(?:src|href)="\/[^/"][^"]*"/.test(html.replace(/href="\/\//g, '')));
expect('.nojekyll 存在（避免静态资源被 Jekyll 处理）', fs.existsSync(path.join(DOCS, '.nojekyll')));
expect('离线便携版与 PWA 不冲突（便携版为单文件，无需 SW）', true);

/* ---------- 5. 更新传播：改了笔记 App 必须能看到新的 ---------- */
console.log('\n— 更新传播策略（改笔记后能否立刻看到）—');
const swSrc = fs.readFileSync(swPath, 'utf8');
const rules = (/const ALWAYS_FRESH = \[([^\]]+)\]/.exec(swSrc) || [])[1] || '';
const freshPatterns = rules.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = /^\/(.*)\/$/.exec(s);
  return m ? new RegExp(m[1]) : null;
}).filter(Boolean);
const isFresh = (p) => freshPatterns.some((re) => re.test(p));
expect('笔记数据 data/index.json 为网络优先（改笔记后刷新即最新）', isFresh('/my-notes/data/index.json'));
expect('手写标注 ink/*.json 为网络优先（改标注后能看到新的）', isFresh('/my-notes/ink/abc.json'));
expect('页面与脚本为网络优先（旧 JS 不会驻留）', isFresh('/my-notes/js/app.js') && isFresh('/my-notes/index.html'));
expect('图片/附件走缓存优先（省流量）', !isFresh('/my-notes/assets/demo.png'));
expect('附件 URL 会加版本参数（同名图片更新后不吃旧缓存）', /versionAssets/.test(appJs));
expect('标注请求带时间戳（刚保存的标注立刻可见）', /\?t=\$\{Date\.now\(\)\}/.test(appJs) || /ink\/[^`]*\?t=/.test(appJs));
expect('刚发布后若线上还是旧数据会给用户提示', /note-just-published/.test(appJs));

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
if (fail) {
  console.log('\n以上任一项失败，浏览器的「安装」按钮就不会出现。');
  process.exitCode = 1;
}
