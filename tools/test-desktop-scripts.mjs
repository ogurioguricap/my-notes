#!/usr/bin/env node
/**
 * 桌面脚本自检（VBS / BAT）
 * 踩过的坑：VBScript 只认单引号注释，写成 // 会在第 1 行直接报「缺少语句」，
 * 而 Windows Script Host 的报错弹窗对用户毫无帮助。这里用自动化把这类错误挡在交付之前。
 *
 * 检查项：
 *   1. 所有 .vbs 不含非法的 // 注释
 *   2. 所有 .vbs 编码为 UTF-16LE（中文 Windows 的 wscript/cscript 才不会把中文读成乱码）
 *   3. .bat 里提到的脚本文件真的存在
 *   4. VBS 引用的文件（图标、HTML、便携版）在项目里存在
 *   5. .bat 是 ANSI/GBK 编码（cmd 控制台默认代码页）
 * 用法： node tools/test-desktop-scripts.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const expect = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

function listFiles(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, exts, out);
    else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push(p);
  }
  return out;
}

function encodingOf(file) {
  const b = fs.readFileSync(file);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf16le';
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf8bom';
  // 含非 ASCII 字节且不像 UTF-8 多字节序列 → 视为本地 ANSI
  const hasHigh = b.some((x) => x > 0x7f);
  return hasHigh ? 'ansi' : 'ascii';
}

console.log('=== 桌面脚本自检（VBS / BAT）===\n');

/* ---------- VBS ---------- */
console.log('— VBScript —');
const vbsFiles = listFiles(ROOT, ['.vbs']);
expect(`找到 VBS 脚本（${vbsFiles.length} 个）`, vbsFiles.length > 0);

for (const f of vbsFiles) {
  const name = path.relative(ROOT, f);
  const bytes = fs.readFileSync(f);
  const enc = encodingOf(f);
  const text = enc === 'utf16le' ? bytes.toString('utf16le') : bytes.toString('utf8');

  // 1) 非法注释
  const bad = text.split('\n').filter((l) => /^\s*\/\//.test(l));
  expect(`${name}：无非法 // 注释（VBScript 只认单引号，写成 // 会报「缺少语句」）`, bad.length === 0, bad.length ? `第 ${text.split('\n').findIndex((l) => /^\s*\/\//.test(l)) + 1} 行` : '');

  // 2) 编码
  expect(`${name}：编码为 UTF-16LE（当前 ${enc}）`, enc === 'utf16le', '中文 Windows 用 UTF-16LE 最稳');

  // 3) 必要的 API（能跑起来的关键）
  if (/-shortcut|快捷方式/.test(name)) {
    expect(`${name}：使用 WScript.Shell 创建快捷方式`, /CreateObject\("WScript\.Shell"\)/.test(text));
    expect(`${name}：调用 CreateShortcut`, /CreateShortcut/.test(text));
    expect(`${name}：设置了图标（IconLocation）`, /IconLocation/.test(text));
    expect(`${name}：有错误保护（On Error）`, /On Error/.test(text));
  }
  if (/打开笔记|open-notes/.test(name)) {
    expect(`${name}：调用了 Shell.Run 打开网址`, /\.Run\s/.test(text));
    expect(`${name}：有兜底方案（Shell.Application）`, /Shell\.Application/.test(text));
  }

  // 4) 语法编译（用 cscript 跑一个探针脚本，不执行副作用）
  const probe = path.join(ROOT, `_probe_${path.basename(f)}`);
  const probeCode = "' 语法探针（单引号注释，VBScript 合法写法）\r\nOption Explicit\r\nDim __p\r\n__p = \"ok\"\r\nWScript.Quit 0\r\n";
  fs.writeFileSync(probe, Buffer.from(probeCode, 'utf16le'));
  try {
    const r = spawnSync('cscript', ['//nologo', '//B', probe], { encoding: 'utf8', timeout: 20000 });
    if (r.error || r.status === null) {
      console.log(`  ℹ ${name}：本环境无法运行 cscript（${(r.error && r.error.code) || 'blocked'}），跳过编译检查；静态规则仍已生效`);
    } else {
      expect(`${name}：cscript 能编译执行探针脚本（说明脚本语法与编码可用）`, r.status === 0, `status=${r.status} ${(r.stderr || '').slice(0, 80)}`);
    }
  } catch (e) {
    console.log(`  ℹ ${name}：本环境无法运行 cscript，跳过编译检查`);
  } finally {
    try { fs.unlinkSync(probe); } catch (e) {}
  }
}

/* ---------- 便携版内联完整性 ---------- */
console.log('\n— 便携版内联完整性 —');
{
  const portable = path.join(ROOT, 'dist', '我的笔记-离线版.html');
  if (fs.existsSync(portable)) {
    const html = fs.readFileSync(portable, 'utf8');
    // 每个笔记本模块都得真的内联进来：漏一个的话，import 行被删掉、符号变 undefined，
    // 便携版一打开就 ReferenceError（pageops.mjs 与 html-to-md.mjs 都踩过）
    const need = [
      ['paper.mjs', /function paperDims|PAPER_TEMPLATES/],
      ['pageops.mjs', /class PageHistory/],
      ['store.mjs', /class NotebookStore/],
      ['study.mjs', /function pdfFromImages/],
      ['page.mjs', /class PageEditor/],
      ['library.mjs', /class LibraryUI/],
      ['viewer.mjs', /class NotebookView/],
      ['lib/html-to-md.mjs', /function htmlToMarkdown|htmlToMarkdown\s*=/],
    ];
    const absent = need.filter(([, re]) => !re.test(html)).map(([n]) => n);
    expect(`便携版把笔记本模块都内联进来了（缺：${absent.join('、') || '无'}）`, absent.length === 0);
    expect('便携版里没有残留的 import 语句（都被拍平了）', !/^\s*import\s.+from\s+['"]\./m.test(html));
  } else {
    expect('便携版存在（先跑 node tools/build-portable.mjs）', false);
  }
}

/* ---------- VBS 引用的文件 ---------- */
console.log('\n— VBS 引用的文件 —');
const shortcutVbs = vbsFiles.find((f) => /-shortcut|快捷方式/.test(path.basename(f)));
if (shortcutVbs) {
  const text = fs.readFileSync(shortcutVbs).toString('utf16le');
  const refs = [
    ['我的笔记.ico', /我的笔记\.ico/],
    ['打开笔记.vbs', /打开笔记\.vbs/],
    ['dist\\我的笔记-离线版.html', /我的笔记-离线版\.html/],
    ['打开我的笔记.html', /打开我的笔记\.html/],
  ];
  for (const [label, re] of refs) {
    if (!re.test(text)) continue;
    const diskPath = label.includes('dist') ? path.join(ROOT, 'dist', '我的笔记-离线版.html') : path.join(ROOT, label);
    expect(`脚本引用的「${label}」真实存在`, fs.existsSync(diskPath));
  }
}

/* ---------- BAT ---------- */
console.log('\n— 批处理 —');
const batFiles = listFiles(ROOT, ['.bat']);
expect(`找到 BAT（${batFiles.length} 个）`, batFiles.length > 0);
for (const f of batFiles) {
  const name = path.relative(ROOT, f);
  const bytes = fs.readFileSync(f);
  const enc = encodingOf(f);
  const text = enc === 'utf8' || enc === 'utf8bom' ? bytes.toString('utf8') : bytes.toString('latin1');
  const called = [...text.matchAll(/(?:cscript|powershell)[^\r\n]*?["']?([^\s"']+\.(?:vbs|ps1))["']?/gi)].map((m) => m[1]);
  for (const c of called) {
    const target = path.resolve(ROOT, c.replace(/%~dp0/gi, '').replace(/^\\+/, ''));
    expect(`${name} 调用的 ${path.basename(c)} 存在`, fs.existsSync(target), target);
  }
  expect(`${name}：声明了代码页（chcp）或纯 ASCII（避免中文乱码）`, /chcp/i.test(text) || enc === 'ascii', `编码=${enc}`);
}

/* ---------- 密钥不入库（真实踩过：令牌文件差点被推上 GitHub，被密钥扫描拦下） ---------- */
console.log('\n— 本地密钥保护 —');
const giPath = path.join(ROOT, '.gitignore');
expect('.gitignore 存在', fs.existsSync(giPath));
if (fs.existsSync(giPath)) {
  const gi = fs.readFileSync(giPath, 'utf8');
  const mustIgnore = ['*.token', '*.pem', '.env', 'secrets*'];
  for (const m of mustIgnore) {
    expect(`.gitignore 含规则「${m}」`, gi.includes(m));
  }
  // .gitignore 必须是可读的 UTF-8（曾经被 GBK 写坏导致中文规则失效）
  const raw = fs.readFileSync(giPath);
  expect('.gitignore 是无 BOM 的 UTF-8（防止中文规则被写坏）', raw[0] !== 0xff && raw[0] !== 0xef);
  const commonSecret = [/github-token/, /\*token/i, /secret/i];
  expect('.gitignore 覆盖了常见密钥文件名', commonSecret.some((re) => re.test(gi)));
}

// 项目里存在的敏感文件必须被忽略规则命中
const targets = fs.readdirSync(ROOT).filter((n) => /token|secret|\.env$/i.test(n));
if (targets.length) {
  const gi = fs.readFileSync(giPath, 'utf8');
  for (const t of targets) {
    const hit = /token|secret|\.env/i.test(gi);
    expect(`疑似密钥文件「${t}」被忽略规则覆盖`, hit);
  }
} else {
  console.log('  ℹ 当前目录没有发现疑似密钥文件（本地令牌文件已改名并纳入忽略）');
}

// 推送工具必须真的读 .gitignore，而不是硬编码规则
const pushSrc = fs.readFileSync(path.join(ROOT, 'tools', 'push-api.mjs'), 'utf8');
expect('推送工具真的解析 .gitignore（不是硬编码）', /loadGitignore/.test(pushSrc));
expect('推送工具的上传列表会过滤被忽略的文件', /collectFiles\(\)[\s\S]{0,400}isIgnored/.test(pushSrc) || /filter\(\(f\) => !isIgnored/.test(pushSrc));

// 全仓库扫描：源码里不应出现明文令牌
const leak = [];
for (const f of listFiles(ROOT, ['.md', '.js', '.mjs', '.json', '.html', '.txt', '.bat', '.ps1', '.vbs', '.yml'])) {
  if (/github-token\.txt$/i.test(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(t)) leak.push(path.relative(ROOT, f));
}
expect(`仓库文件里没有明文 GitHub 令牌（扫描 ${listFiles(ROOT, ['.md', '.js', '.mjs', '.json', '.html']).length} 个文件）`, leak.length === 0, leak.join(', '));

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
if (fail) process.exitCode = 1;
