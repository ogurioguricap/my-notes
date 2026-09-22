#!/usr/bin/env node
/**
 * 精确推送：走 GitHub Git Data API，把本地那几条提交**原样**推上去（git push 连不上 github.com 时用）
 *
 * 用法：
 *   node tools/push-exact.mjs              （读取 github-token.txt 里的令牌）
 *   node tools/push-exact.mjs --dry-run    （只上传对象并校验 sha，不动远端 ref）
 *
 * 与 tools/push-api.mjs 的区别：那个是「按文件调 Contents API」的粗推（每个文件一条提交、不留历史）；
 * 这个保留**完全相同的提交**：
 *   Git 对象是内容寻址的 —— tree / parent / message / 作者与提交时间一致，sha 必然一致。
 *   脚本按 GitHub 实际存储的格式（时间戳规整为 UTC +0000、消息末尾不带换行）在本地重建提交对象
 *   写回 .git，于是本地与远端指向同一个 sha（推完可直接用 tools/verify-live.mjs 校验线上字节）。
 *
 * 远端已经前进时（例如有人从**网站编辑器**发布了笔记——那会走 GitHub API 直接提交，本地 git 看不到）：
 *   只要远端 HEAD 是本地 HEAD 的**祖先**，就属于「本地领先」→ 把中间缺的那几条依次推上去（快进，不覆盖任何人的提交）；
 *   否则直接中止并打印对齐步骤（绝不强推覆盖）。
 *
 * 前提：本地已经 commit 好、工作区干净。
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

/** 读 loose 对象；已经在 pack 里的返回 null（老对象远端本来就有，直接引用它的 sha 即可） */
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

/** 解析本地提交对象文本（git 格式：tree / parent* / author / committer / 空行 / message） */
function parseCommit(text) {
  return {
    tree: /^tree ([0-9a-f]{40})$/m.exec(text)[1],
    parent: (/^parent ([0-9a-f]{40})$/m.exec(text) || [])[1] || null,
    authorName: /^author (.*) </m.exec(text)[1],
    authorEmail: /^author .* <(.*)> /m.exec(text)[1],
    authorStamp: /^author .* (\d+ [+-]\d{4})$/m.exec(text)[1],
    committerName: /^committer (.*) </m.exec(text)[1],
    committerEmail: /^committer .* <(.*)> /m.exec(text)[1],
    committerStamp: /^committer .* (\d+ [+-]\d{4})$/m.exec(text)[1],
    message: text.slice(text.indexOf('\n\n') + 2).replace(/\n+$/, ''),
  };
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

const headText = readObj(localHead);
if (!headText || headText.type !== 'commit') {
  console.error('❌ 本地 HEAD 不在 loose 对象里（被 pack 了）：先 `git repack -a -d`，或直接用 git push');
  process.exit(1);
}
const head = parseCommit(headText.data.toString('utf8'));
console.log(`本地提交 ${localHead.slice(0, 12)} | tree ${head.tree.slice(0, 12)}`);

const remoteRef = await req(`${API}/git/ref/heads/${BRANCH}`);
const remoteHead = remoteRef.object.sha;
console.log(`远端 ${BRANCH} = ${remoteHead.slice(0, 12)}`);

/** 远端 HEAD 就是本地 HEAD（内容一致、只是时间戳被 GitHub 规整过）→ 直接对齐本地 ref，不重复推送 */
if (remoteHead === localHead) {
  console.log('✅ 远端与本地已经是同一条提交，无需推送');
  process.exit(0);
}
if (remoteHead !== head.parent) {
  const rc = await req(`${API}/git/commits/${remoteHead}`);
  const sameTree = rc.tree && rc.tree.sha === head.tree;
  const sameParent = Array.isArray(rc.parents) && rc.parents.length === 1 && rc.parents[0].sha === head.parent;
  const sameMsg = String(rc.message || '').replace(/\n+$/, '') === head.message;
  if (sameTree && sameParent && sameMsg) {
    console.log('ℹ️ 远端 HEAD 已经是「同一条提交」（tree / parent / message 全一致，只是时间戳被 GitHub 规整过）');
    console.log('   → 不重复推送，直接把这个提交在本地重建出来并对齐 ref');
    const rAuthorIso = String(rc.author.date).replace(/\.\d+Z$/, 'Z');
    const rCommitterIso = String(rc.committer.date).replace(/\.\d+Z$/, 'Z');
    const rObjText = `tree ${head.tree}\nparent ${head.parent}\nauthor ${rc.author.name} <${rc.author.email}> ${Math.floor(Date.parse(rAuthorIso) / 1000)} +0000\n`
      + `committer ${rc.committer.name} <${rc.committer.email}> ${Math.floor(Date.parse(rCommitterIso) / 1000)} +0000\n\n${String(rc.message).replace(/\n+$/, '')}`;
    const rPayload = Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(rObjText)}\0`, 'utf8'), Buffer.from(rObjText, 'utf8')]);
    const rSha = crypto.createHash('sha1').update(rPayload).digest('hex');
    if (rSha !== rc.sha) throw new Error(`远端提交在本地重建失败：${rSha.slice(0, 12)} ≠ ${rc.sha.slice(0, 12)}`);
    const rdir = path.join(GITDIR, 'objects', rSha.slice(0, 2));
    fs.mkdirSync(rdir, { recursive: true });
    if (!fs.existsSync(path.join(rdir, rSha.slice(2)))) fs.writeFileSync(path.join(rdir, rSha.slice(2)), zlib.deflateSync(rPayload));
    fs.writeFileSync(path.join(GITDIR, 'refs', 'heads', BRANCH), `${rSha}\n`);
    const rtracking = path.join(GITDIR, 'refs', 'remotes', 'origin', BRANCH);
    if (fs.existsSync(path.dirname(rtracking))) fs.writeFileSync(rtracking, `${rSha}\n`);
    console.log(`✅ 本地已对齐到远端同一条提交 ${rSha.slice(0, 12)}`);
    process.exit(0);
  }
}

/** 收集「远端没有、本地有」的提交链（从 HEAD 往回走到远端 HEAD 为止），最老的在前 */
const chain = [];
{
  let cur = localHead;
  let guard = 0;
  while (cur && cur !== remoteHead) {
    const obj = readObj(cur);
    if (!obj || obj.type !== 'commit') {
      console.error(`❌ 要推的提交 ${cur.slice(0, 12)} 不在 loose 对象里（被 pack 了），无法逐条重建。`);
      console.error('   两个办法：`git repack -a -d` 后重试；或先用 git push。');
      process.exit(1);
    }
    const text = obj.data.toString('utf8');
    chain.push({ local: cur, info: parseCommit(text) });
    cur = chain[chain.length - 1].info.parent;
    if (++guard > 30) { console.error('❌ 要推的提交超过 30 条，先 git push 一次再回来用这个工具'); process.exit(1); }
  }
  chain.reverse();
}
if (!chain.length) {
  console.error('❌ 远端 HEAD 既不是本地 HEAD、也不是它的祖先：需要在本地把远端合进来（别强推覆盖别人的提交）。');
  console.error('   这样对齐（两边改动都不丢）：');
  console.error('     git fetch origin main');
  console.error('     git branch -f tmp-local HEAD            # 保住本地这条提交');
  console.error('     git checkout -B main origin/main        # 站到远端最新');
  console.error('     git cherry-pick -n tmp-local            # 把本地改动放回来（-n 先不提交）');
  console.error('     node tools/build.mjs                    # 若 docs/data/index.json 冲突：按 content/ 重新生成');
  console.error('     git add -A && git commit -F <提交信息文件>');
  process.exit(1);
}
console.log(`要推 ${chain.length} 条提交：${chain.map((c) => c.info.message.split('\n')[0].slice(0, 24)).join(' → ')}`);

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

const utcIso = (stamp) => new Date(Number(String(stamp).split(' ')[0]) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const writeObj = (objText) => {
  const payload = Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(objText)}\0`, 'utf8'), Buffer.from(objText, 'utf8')]);
  const sha = crypto.createHash('sha1').update(payload).digest('hex');
  const dir = path.join(GITDIR, 'objects', sha.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, sha.slice(2)))) fs.writeFileSync(path.join(dir, sha.slice(2)), zlib.deflateSync(payload));
  return sha;
};

let parentSha = remoteHead;
let lastSha = '';
for (const c of chain) {
  const info = c.info;
  const tree = await buildTree(info.tree);
  if (tree !== info.tree) throw new Error(`根树不一致：${tree} ≠ ${info.tree}`);
  const authorIso = utcIso(info.authorStamp);
  const committerIso = utcIso(info.committerStamp);
  const made = await req(`${API}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: info.message,
      tree: info.tree,
      parents: [parentSha],
      author: { name: info.authorName, email: info.authorEmail, date: authorIso },
      committer: { name: info.committerName, email: info.committerEmail, date: committerIso },
    }),
  });
  // 按 GitHub 存储格式在本地重建这条提交（UTC +0000 + 消息末尾不带换行），父指向「远端那一条」
  const objText = `tree ${info.tree}\nparent ${parentSha}\nauthor ${info.authorName} <${info.authorEmail}> ${Math.floor(Date.parse(authorIso) / 1000)} +0000\n`
    + `committer ${info.committerName} <${info.committerEmail}> ${Math.floor(Date.parse(committerIso) / 1000)} +0000\n\n${info.message}`;
  const rebuilt = writeObj(objText);
  if (rebuilt !== made.sha) throw new Error(`本地重建的提交与远端不一致：${rebuilt.slice(0, 12)} ≠ ${made.sha.slice(0, 12)}（远端 ref 未动）`);
  console.log(`  ✓ ${info.message.split('\n')[0].slice(0, 34)} → ${made.sha.slice(0, 12)}`);
  parentSha = made.sha;
  lastSha = made.sha;
}
console.log(`对象上传完成：新 blob ${stats.blobs} · 复用远端 ${stats.reused} · 新建树 ${stats.trees}`);

if (DRY) {
  console.log('（--dry-run：对象与 sha 都对上了，但没有改远端 ref）');
  console.log(`（本地 ref 现在指向 ${lastSha.slice(0, 12)}，与远端会变成的状态一致）`);
} else {
  await req(`${API}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: lastSha, force: false }) });
  fs.writeFileSync(path.join(GITDIR, 'refs', 'heads', BRANCH), `${lastSha}\n`);
  const tracking = path.join(GITDIR, 'refs', 'remotes', 'origin', BRANCH);
  if (fs.existsSync(path.dirname(tracking))) fs.writeFileSync(tracking, `${lastSha}\n`);
  const after = await req(`${API}/git/ref/heads/${BRANCH}`);
  console.log(`远端 ${BRANCH} = ${after.object.sha.slice(0, 12)} | 本地已指向同一提交`);
  console.log(after.object.sha === lastSha
    ? `🎉 推送完成：${chain.length} 条提交，本地与远端同一个 sha（时间戳按 UTC 规整，内容一致）`
    : '❌ 远端 sha 与预期不符');
}
