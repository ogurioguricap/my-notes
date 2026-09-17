#!/usr/bin/env node
/**
 * 用 GitHub API 推送（不需要 git 命令行）
 * 适用场景：环境禁止启动子进程（git 无法联网）、或没装 git / gh。
 *
 * 用法：
 *   $env:GITHUB_TOKEN="ghp_xxx"
 *   node tools/push-api.mjs --repo my-notes                 推送当前工作区
 *   node tools/push-api.mjs --repo my-notes --dry-run       只看会动哪些文件
 *   node tools/push-api.mjs --repo my-notes --message "..." 自定义提交信息
 *
 * 原理：读取仓库默认分支的 HEAD 树 → 逐文件调用 Contents API 写入 →
 *       GitHub 每个文件生成一次提交（首次推送约 30 个文件，1~3 分钟）。
 * 注意：这条路径不保留本地 git 历史。本机 git 可用时，优先用 git push。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const valueOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const DRY = flag('--dry-run');
const NO_SKIP_CI = flag('--no-skip-ci');
const REPO = valueOf('--repo', '');
const BRANCH = valueOf('--branch', 'main');
const MESSAGE = valueOf('--message', '');
const OWNER = valueOf('--owner', '');

const API = 'https://api.github.com';
const SKIP_DIRS = new Set(['.git', 'node_modules', '_shots', '.vscode', '.idea']);
const SKIP_EXT = new Set(['.log', '.tmp', '.bak']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const say = (s = '') => console.log(s);
const head = (n, t) => say(`\n──────── ${n}. ${t} ────────`);

async function api(pathname, { method = 'GET', body, token = TOKEN } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'notes-site-push',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 180);
    const err = new Error(`GitHub API ${method} ${pathname} → ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** 收集要推送的文件（跳过 .gitignore 里声明的类别 + 常见垃圾文件） */
function collectFiles() {
  const out = [];
  const walk = (dir, base = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_FILES.has(e.name)) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (rel.endsWith('.swp')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, rel); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (SKIP_EXT.has(ext) || e.name.startsWith('_')) continue;
      out.push(rel);
    }
  };
  walk(ROOT);
  return out.filter((f) => !isIgnored(f)).sort();
}

/* ============================ .gitignore 解析 ============================ */
/**
 * 真正读取 .gitignore，而不是硬编码几条规则。
 * 教训：之前硬编码的忽略列表漏了「本地令牌文件」，导致推送工具试图把密钥上传到 GitHub
 * （被 GitHub 的密钥扫描拦下，返回 409 Repository rule violations）。
 * 支持：注释、空行、目录规则、! 取反、* 通配、** 、/ 前缀与 / 后缀。
 */
function loadGitignore(root) {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return [];
  const rules = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    let pat = neg ? line.slice(1) : line;
    const dirOnly = pat.endsWith('/');
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.startsWith('/');
    if (anchored) pat = pat.slice(1);
    // 含 / 的模式按整条路径匹配，否则匹配任意层级的文件名
    const re = new RegExp(
      (anchored || pat.includes('/') ? '^' : '(^|/)') +
        pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*') +
        (dirOnly ? '(/.*)?$' : '$')
    );
    rules.push({ neg, re });
  }
  return rules;
}

const GITIGNORE = loadGitignore(ROOT);

function isIgnored(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('.git/')) return true;
  let ignored = false;
  for (const r of GITIGNORE) {
    if (r.re.test(p)) ignored = !r.neg;
  }
  return ignored;
}

async function main() {
  say('🚀 通过 GitHub API 推送笔记站');
  if (!TOKEN) {
    say('\n✗ 缺少令牌。请先设置： $env:GITHUB_TOKEN="ghp_你的令牌"');
    process.exit(1);
  }
  if (!REPO) {
    say('\n✗ 请指定仓库名： node tools/push-api.mjs --repo my-notes');
    process.exit(1);
  }

  head(1, '确认身份与仓库');
  const me = await api('/user');
  const owner = OWNER || me.login;
  say(`  ✅ 身份：${owner}`);
  const repoInfo = await api(`/repos/${owner}/${REPO}`);
  const branch = repoInfo.default_branch || BRANCH;
  say(`  ✅ 仓库：${repoInfo.full_name}（默认分支 ${branch}，${repoInfo.private ? '私有' : '公开'}）`);

  head(2, '对比本地与远端文件');
  const local = collectFiles();
  let remote = new Map();
  try {
    const ref = await api(`/repos/${owner}/${REPO}/git/ref/heads/${branch}`);
    const commit = await api(`/repos/${owner}/${REPO}/git/commits/${ref.object.sha}`);
    const tree = await api(`/repos/${owner}/${REPO}/git/trees/${commit.tree.sha}?recursive=1`);
    for (const t of tree.tree || []) if (t.type === 'blob') remote.set(t.path, t.sha);
  } catch (e) {
    say(`  ℹ 远端还没有 ${branch} 分支（首次推送）`);
  }
  const remotePaths = [...remote.keys()].filter((p) => !isIgnored(p));
  const toPush = local.filter((f) => {
    if (!remote.has(f)) return true;
    const localSha = sha1GitBlob(fs.readFileSync(path.join(ROOT, f)));
    return localSha !== remote.get(f);
  });
  const toDelete = remotePaths.filter((p) => !local.includes(p));

  say(`  本地文件：${local.length} 个`);
  say(`  远端文件：${remotePaths.length} 个`);
  say(`  需要写入：${toPush.length} 个${toPush.length ? '（' + toPush.slice(0, 3).join(', ') + (toPush.length > 3 ? ' …' : '') + '）' : ''}`);
  if (toDelete.length) say(`  远端多余（不自动删除）：${toDelete.join(', ')}`);

  if (!toPush.length) {
    say('\n✅ 远端已是最新，无需推送');
    return;
  }
  if (DRY) {
    say('\n（--dry-run，未写入）');
    return;
  }

  head(3, '写入文件');
  const base = MESSAGE || `notes: 同步笔记站（${toPush.length} 个文件）`;
  let done = 0;
  for (const rel of toPush) {
    const abs = path.join(ROOT, rel);
    const content = fs.readFileSync(abs).toString('base64');
    const existingSha = remote.get(rel);
    const body = {
      message: NO_SKIP_CI ? `${base} · ${rel}` : `${base} · ${rel} [skip ci]`,
      content,
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    };
    await api(`/repos/${owner}/${REPO}/contents/${encodeURIComponent(rel).replace(/%2F/g, '/')}`, { method: 'PUT', body });
    done++;
    const pct = Math.round((done / toPush.length) * 100);
    process.stdout.write(`\r  · ${done}/${toPush.length}（${pct}%）写入 ${rel}`.padEnd(70));
  }
  process.stdout.write('\n');
  say('  ✅ 全部写入完成');

  head(4, '结果');
  const url = `https://${owner.toLowerCase()}.github.io/${REPO}/`;
  say(`  仓库：${repoInfo.html_url}`);
  say(`  网址：${url}`);
  say('  GitHub Pages 由 Actions 自动发布，约 1~2 分钟后可访问。');
}

/** 计算 git blob 的 sha1（用于判断文件是否与远端一致） */
function sha1GitBlob(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

main().catch((e) => {
  say('\n✗ 推送中断：' + e.message);
  if (e.status === 401) say('  令牌无效或过期。');
  if (e.status === 403) say('  令牌权限不足（需要 repo 或 Contents: Read and write）。');
  if (e.status === 404) say('  仓库不存在，或令牌权限看不到它。');
  process.exit(1);
});
