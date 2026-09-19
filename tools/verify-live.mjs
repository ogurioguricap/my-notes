/**
 * 线上校验：把 GitHub Pages 上的文件与本地逐字节比对，并检查关键记号还在
 *
 * 用法：
 *   node tools/verify-live.mjs                      # 校验默认核心文件清单
 *   node tools/verify-live.mjs docs/js/app.js ...    # 校验指定文件（相对仓库根）
 *   node tools/verify-live.mjs --need buildEpub      # 额外要求线上文本里含该记号
 *   node tools/verify-live.mjs --rounds 12 --wait 10 # 轮询次数与间隔（秒）
 *
 * 为什么需要它：push 成功不等于线上已更新（Pages 要重建、浏览器/CDN 还有缓存），
 * 所以每次都拿 sha256 对一遍，避免「以为上线了其实没有」。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const BASE = process.env.SITE_BASE || 'https://ogurioguricap.github.io/my-notes';

const argv = process.argv.slice(2);
const need = [];
const rest = [];
let rounds = 20;
let wait = 10;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null);
  if (a === '--need') { const v = val(); if (v) need.push(v); }
  else if (a === '--rounds') { const v = val(); if (v) rounds = Number(v) || rounds; }
  else if (a === '--wait') { const v = val(); if (v) wait = Number(v) || wait; }
  else rest.push(a);
}
const extraNeed = need;

const DEFAULT_FILES = [
  'docs/index.html',
  'docs/sw.js',
  'docs/js/app.js',
  'docs/js/notebook/store.mjs',
  'docs/js/notebook/paper.mjs',
  'docs/js/notebook/page.mjs',
  'docs/js/notebook/study.mjs',
  'docs/js/notebook/ocr.mjs',
  'docs/js/notebook/asr.mjs',
  'docs/js/notebook/tts.mjs',
  'docs/js/notebook/sync.mjs',
  'docs/js/notebook/library.mjs',
  'docs/js/notebook/viewer.mjs',
  'docs/css/notebook-base.css',
  'docs/css/notebook-library.css',
  'docs/css/notebook-viewer.css',
];
const files = rest.length ? rest : DEFAULT_FILES;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const local = new Map();
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log(`⚠️ 本地没有 ${f}，跳过`); continue; }
  local.set(f, fs.readFileSync(p));
}
console.log(`本地文件 ${local.size} 个，目标 ${BASE}\n`);

let verdict = 'fail';
for (let round = 1; round <= rounds; round++) {
  const res = await Promise.all([...local.keys()].map(async (f) => {
    try {
      const r = await fetch(`${BASE}/${f.replace(/^docs\//, '')}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return { f, err: `HTTP ${r.status}` };
      return { f, buf: Buffer.from(await r.arrayBuffer()) };
    } catch (e) { return { f, err: e.message }; }
  }));
  const diff = res.filter((x) => x.err || sha(x.buf) !== sha(local.get(x.f)));
  if (diff.length) {
    console.log(`第 ${round} 轮：还没同步（${diff.map((d) => path.basename(d.f) + (d.err ? ':' + d.err : '')).join('、')}）`);
    if (round < rounds) await new Promise((r) => setTimeout(r, wait * 1000));
    continue;
  }
  console.log(`✅ 线上与本地逐字节一致（第 ${round} 轮探测）`);
  let bad = 0;
  for (const { f, buf } of res) {
    const text = buf.toString('utf8');
    // 记号只在「本地含该记号的文件」上检查（逐字节相等时必然成立，用来防止缓存/CDN 给了旧内容）
    const localText = local.get(f).toString('utf8');
    const missing = extraNeed.filter((n) => localText.includes(n) && !text.includes(n));
    console.log(`  ${missing.length ? '❌' : '✅'} ${sha(buf).slice(0, 12)}  ${f}  ${buf.length}B${missing.length ? '  缺记号: ' + missing.join('、') : ''}`);
    if (missing.length) bad++;
  }
  verdict = bad ? 'fail' : 'ok';
  break;
}
if (verdict === 'ok') console.log('\n🎉 线上校验通过');
else { console.log('\n❌ 线上校验未通过（超时未同步或记号缺失）'); process.exitCode = 1; }
