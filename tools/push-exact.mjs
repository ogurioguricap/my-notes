#!/usr/bin/env node
/**
 * 精确推送：走 GitHub Git Data API，把本地那条提交**原样**推上去（git push 连不上 github.com 时用）
 *
 * 用法：
 *   node tools/push-exact.mjs              （读取 github-token.txt 里的令牌）
 *   node tools/push-exact.mjs --dry-run    （只上传对象并校验 sha，不动远端 ref）
 *
 * 与 tools/push-api.mjs 的区别：那个是「按文件调 Contents API」的粗推（每个文件一条提交、不留历史）；
 * 这个保留**完全相同的提交**：
 *   Git 对象是内容寻址的 —— tree / parent / message / 作者与提交时间一致，sha 必然一致。
 *   脚本按 GitHub 实际存储的格式（时间戳规整为 UTC +0000、消息末尾不带换行）在本地重建该提交对象
 *   写回 .git，于是本地与远端指向同一个 sha（推完可直接用 tools/verify-live.mjs 校验线上字节）。
 *
 * 前提：本地已经 commit 好、工作区干净、refs/heads/main 指向要推的那条提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITDIR = path.join(ROOT, '.git');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const OWNER = (() => { const i = argv.indexOf('--owner'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'ogurioguricap'; })();
const REPO = (() => { const i = argv.indexOf('--repo'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'my-notes'; })();
const BRANCH = (() => { const i = argv.indexOf('--branch'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'main'; })();
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const tokenFile = ['github-token.txt', 'github-token.md'].find((f) => fs.existsSync(path.join(ROOT, f)));
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  || (tokenFile ? (/(gh[pous]_[A-Za-z0-9]{20,})/.exec(fs.readFileSync(path.join(ROOT, tokenFile), 'utf8')) || [])[1] : '');
if (!TOKEN) { console.error('❌ 没找到 GitHub 令牌（环境变量 GITHUB_TOKEN，或 github-token.txt 里的 ghp_…）'); process.exit(1); }

const localHead = fs.readFileSync(path.join(GITDIR, 'refs', 'heads', BRANCH), 'utf8').trim();

/** 读 loose 对象；已经在 pack 里的返回 null（= 远端本来就有，直接引用它的 sha 即可） */
function readObj(sha) {
  const p = path.join(GITDIR, 'objects', sha.slice(0, 2), sha.slice(2));
  if (!fs.existsSync(p)) return null;
  const raw = zlib.inflateSync(fs.readFileSync(p));
  const nul = raw.indexOf(0);
  return { type: raw.subarray(0, nul).toString('utf8').split(' ')[0], data: raw.subarray(nul + 1) };
}

function parseTree(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const mode = buf.subarray(i, sp).toString('utf8');
    const nul = buf.indexOf(0, sp);
    out.push({ mode, name: buf.subarray(sp + 1, nul).toString('utf8'), sha: buf.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

async function req(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'notes-site-push',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) {
    const hint = res.status === 401
      ? '\n   → 令牌无效或已过期：跑 `node tools/check-token.mjs` 看过期时间并换新令牌'
      : res.status === 403 ? '\n   → 权限不足：令牌需要 repo 权限（经典）或本仓库写权限（细粒度）' : '';
    throw new Error(`${init.method || 'GET'} ${url} → ${res.status} ${text.slice(0, 300)}${hint}`);
  }
  return json;
}

const commitObj = readObj(localHead);
if (!commitObj || commitObj.type !== 'commit') {
  console.error('❌ 本地 HEAD 不在 loose 对象里（被 pack 了）：先 `git repack -a -d`，或直接用 git push');
  process.exit(1);
}
const text = commitObj.data.toString('utf8');
const treeSha = /^tree ([0-9a-f]{40})$/m.exec(text)[1];
const parent = /^parent ([0-9a-f]{40})$/m.exec(text)[1];
const authorName = /^author (.*) </m.exec(text)[1];
const authorEmail = /^author .* <(.*)> /m.exec(text)[1];
const authorStamp = /^author .* (\d+ [+-]\d{4})$/m.exec(text)[1];
const committerName = /^committer (.*) </m.exec(text)[1];
const committerEmail = /^committer .* <(.*)> /m.exec(text)[1];
const committerStamp = /^committer .* (\d+ [+-]\d{4})$/m.exec(text)[1];
const message = text.slice(text.indexOf('\n\n') + 2).replace(/\n+$/, '');
const utcIso = (stamp) => new Date(Number(String(stamp).split(' ')[0]) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

console.log(`本地提交 ${localHead.slice(0, 12)} | tree ${treeSha.slice(0, 12)} | parent ${parent.slice(0, 12)}`);
const remoteRef = await req(`${API}/git/ref/heads/${BRANCH}`);
console.log(`远端 ${BRANCH} = ${remoteRef.object.sha.slice(0, 12)}`);
if (remoteRef.object.sha !== parent) {
  console.error('❌ 远端 HEAD 不是本地父提交：先 `git fetch` 对齐再推（避免把别人的提交顶掉）');
  process.exit(1);
}

const stats = { blobs: 0, reused: 0, trees: 0 };
async function buildTree(sha) {
  const obj = readObj(sha);
  if (!obj || obj.type !== 'tree') { stats.reused++; return sha; }   // 老树：远端已有
  const entries = [];
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') { entries.push({ path: e.name, mode: '040000', type: 'tree', sha: await buildTree(e.sha) }); continue; }
    const bo = readObj(e.sha);
    if (!bo) { stats.reused++; entries.push({ path: e.name, mode: e.mode, type: 'blob', sha: e.sha }); continue; }
    const b = await req(`${API}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: bo.data.toString('base64'), encoding: 'base64' }) });
    stats.blobs++;
    entries.push({ path: e.name, mode: e.mode, type: 'blob', sha: b.sha });
  }
  const t = await req(`${API}/git/trees`, { method: 'POST', body: JSON.stringify({ tree: entries }) });
  stats.trees++;
  if (t.sha !== sha) throw new Error(`重建出来的树与本地不一致：${t.sha} ≠ ${sha}`);
  return t.sha;
}

const root = await buildTree(treeSha);
if (root !== treeSha) throw new Error('根树不一致，已中止');
console.log(`对象上传完成：新 blob ${stats.blobs} · 复用远端 ${stats.reused} · 新建树 ${stats.trees}`);

const authorIso = utcIso(authorStamp);
const committerIso = utcIso(committerStamp);
const commit = await req(`${API}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message,
    tree: treeSha,
    parents: [parent],
    author: { name: authorName, email: authorEmail, date: authorIso },
    committer: { name: committerName, email: committerEmail, date: committerIso },
  }),
});
console.log(`远端新提交 = ${commit.sha.slice(0, 12)}`);

// 按 GitHub 实际存储的格式在本地重建提交对象（UTC +0000 + 消息末尾不带换行），写回 .git 让两边同 sha
const objText = `tree ${treeSha}\nparent ${parent}\nauthor ${authorName} <${authorEmail}> ${Math.floor(Date.parse(authorIso) / 1000)} +0000\n`
  + `committer ${committerName} <${committerEmail}> ${Math.floor(Date.parse(committerIso) / 1000)} +0000\n\n${message}`;
const payload = Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(objText)}\0`, 'utf8'), Buffer.from(objText, 'utf8')]);
const rebuilt = crypto.createHash('sha1').update(payload).digest('hex');
if (rebuilt !== commit.sha) throw new Error(`本地重建的提交与远端不一致：${rebuilt.slice(0, 12)} ≠ ${commit.sha.slice(0, 12)}（远端 ref 未动）`);

const dir = path.join(GITDIR, 'objects', rebuilt.slice(0, 2));
fs.mkdirSync(dir, { recursive: true });
const objPath = path.join(dir, rebuilt.slice(2));
if (!fs.existsSync(objPath)) fs.writeFileSync(objPath, zlib.deflateSync(payload));

if (DRY) {
  console.log('（--dry-run：对象与 sha 都对上了，但没有改远端 ref）');
} else {
  await req(`${API}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) });
  fs.writeFileSync(path.join(GITDIR, 'refs', 'heads', BRANCH), `${commit.sha}\n`);
  const tracking = path.join(GITDIR, 'refs', 'remotes', 'origin', BRANCH);
  if (fs.existsSync(path.dirname(tracking))) fs.writeFileSync(tracking, `${commit.sha}\n`);
  const after = await req(`${API}/git/ref/heads/${BRANCH}`);
  console.log(`远端 ${BRANCH} = ${after.object.sha.slice(0, 12)} | 本地已指向同一提交`);
  console.log(after.object.sha === commit.sha
    ? '🎉 推送完成：本地与远端同一个 sha（GitHub 把时间戳规整成 UTC，所以时区显示 +0000，内容一致）'
    : '❌ 远端 sha 与预期不符');
}
