#!/usr/bin/env node
/**
 * 授权后自动部署到 GitHub（创建仓库 → 推送 → 开启 Pages）
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxxxxxxx        （Windows PowerShell: $env:GITHUB_TOKEN="ghp_..."）
 *   node tools/deploy-github.mjs [--repo 仓库名] [--private] [--skip-pages] [--dry-run]
 *
 * 需要的令牌权限（fine-grained）：Administration: Read and write（建仓库）+ Contents: Read and write（推送）
 * 经典令牌（classic）：勾选 repo 即可。
 *
 * 说明：全程只用 Node 内置 fetch 调 GitHub API，不依赖 git/gh 命令行，
 * 因此在禁止子进程的环境里也能完成建仓与开 Pages；代码推送用 git 命令（若不可用会给出可复制命令）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const valueOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const DRY = flag('--dry-run');
const SKIP_PAGES = flag('--skip-pages');
const PRIVATE = flag('--private');
const REPO_NAME = valueOf('--repo', '');

const API = 'https://api.github.com';
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'notes-site-deploy',
};

const say = (s = '') => console.log(s);
const step = (n, t) => say(`\n──────── ${n}. ${t} ────────`);

async function api(pathname, { method = 'GET', body, okCodes = [] } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok && !okCodes.includes(res.status)) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 200);
    const err = new Error(`GitHub API ${method} ${pathname} → ${res.status} ${msg}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return { status: res.status, json };
}

function git(args, { quiet = true } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0 && !r.error, out: (r.stdout || '') + (r.stderr || '') };
}

function gitWorks() {
  const r = git(['--version']);
  return r.ok;
}

async function main() {
  say('🚀 部署到 GitHub');
  say(`   本地目录：${ROOT}`);

  if (!TOKEN) {
    say('\n✗ 没有拿到令牌。请先设置环境变量再运行：');
    say('  PowerShell:  $env:GITHUB_TOKEN="ghp_你的令牌"');
    say('  CMD:         set GITHUB_TOKEN=ghp_你的令牌');
    say('  然后:        node tools/deploy-github.mjs --repo my-notes');
    process.exit(1);
  }

  /* ---------- 1. 校验令牌 ---------- */
  step(1, '校验令牌');
  const me = await api('/user');
  const login = me.json.login;
  say(`  ✅ 身份：${login}（${me.json.name || '未设置昵称'}）`);
  const scopes = (await fetch(`${API}/user`, { headers: H })).headers.get('x-oauth-scopes');
  if (scopes) say(`  令牌 scopes：${scopes}`);
  say(`  可见性：${PRIVATE ? '私有（注意：私有仓库的 Pages 需付费账号）' : '公开'}`);

  /* ---------- 2. 确定并创建仓库 ---------- */
  const repoName = REPO_NAME || 'my-notes';
  step(2, `准备仓库 ${login}/${repoName}`);
  let exists = true;
  try {
    await api(`/repos/${login}/${repoName}`);
    say('  ℹ 仓库已存在，将直接使用');
  } catch (e) {
    if (e.status === 404) exists = false;
    else throw e;
  }

  if (!exists) {
    if (DRY) {
      say('  （--dry-run 跳过创建）');
    } else {
      const created = await api('/user/repos', {
        method: 'POST',
        body: {
          name: repoName,
          description: '纯前端个人笔记站：Markdown 构建 + 全文检索 + 知识图谱 + 三套排版',
          private: PRIVATE,
          has_issues: false,
          has_wiki: false,
          has_projects: false,
          auto_init: false,
        },
      });
      say(`  ✅ 已创建：${created.json.html_url}`);
    }
  }

  /* ---------- 3. 配置远程并推送 ---------- */
  step(3, '推送代码');
  const key = `https://${login}:${TOKEN}@github.com/${login}/${repoName}.git`;
  const clean = `https://github.com/${login}/${repoName}.git`;

  if (!gitWorks()) {
    say('  ⚠ 当前环境不允许启动 git 子进程，请手动执行下面三条命令完成推送：');
    say('');
    say('  ┌─ 复制执行 ────────────────────────────────────────────');
    say(`  │ cd ${ROOT}`);
    say(`  │ git remote add origin ${clean}`);
    say(`  │ git push -u origin main`);
    say('  └───────────────────────────────────────────────────────');
    say('');
    say('  第一次推送会弹窗要求登录 GitHub（或用令牌作为密码）。');
  } else {
    git(['remote', 'remove', 'origin']);
    if (!git(['remote', 'add', 'origin', key]).ok) {
      say('  ✗ 配置 remote 失败');
      process.exit(1);
    }
    say('  · 已配置 remote（令牌只用于本次推送，稍后恢复为不带令牌的地址）');
    if (DRY) {
      say('  （--dry-run 跳过推送）');
    } else {
      const push = git(['push', '-u', 'origin', 'main'], { quiet: false });
      if (!push.ok) {
        git(['remote', 'set-url', 'origin', clean]);
        say('\n  ✗ 推送失败。令牌缺少 Contents 写权限，或仓库名/用户名不匹配。');
        say('    再试： git push -u origin main（会再次弹窗登录）');
        process.exit(1);
      }
      git(['remote', 'set-url', 'origin', clean]);
      say('  ✅ 推送成功，remote 已恢复为不含令牌的安全地址');
    }
  }

  /* ---------- 4. 开启 Pages ---------- */
  step(4, '开启 GitHub Pages（分支 main / 目录 /docs）');
  if (SKIP_PAGES || DRY) {
    say('  （已跳过）');
  } else {
    try {
      const r = await api(`/repos/${login}/${repoName}/pages`, {
        method: 'POST',
        body: { source: { branch: 'main', path: '/docs' } },
        okCodes: [409, 422],
      });
      if (r.status === 409) say('  ℹ Pages 已经开启过，跳过');
      else if (r.status === 422) say('  ⚠ Pages 配置被拒绝（私有仓库或权限不足）：' + JSON.stringify(r.json));
      else say(`  ✅ Pages 已开启：${r.json.html_url || clean.replace('.git', '/')}`);
    } catch (e) {
      if (e.status === 403) say('  ⚠ 令牌没有 Pages 写权限，请在仓库 Settings → Pages 手动选择：分支 main、目录 /docs');
      else say('  ⚠ 开启 Pages 失败：' + e.message);
    }
  }

  /* ---------- 5. 结果 ---------- */
  step(5, '完成');
  const url = repoName.toLowerCase() === `${login.toLowerCase()}.github.io`
    ? `https://${login.toLowerCase()}.github.io/`
    : `https://${login.toLowerCase()}.github.io/${repoName}/`;
  say(`  仓库：${clean}`);
  say(`  网址：${url}`);
  say('  提示：首次发布约需 1 分钟，之后每次 node tools/update.mjs 推送即自动更新。');
}

main().catch((e) => {
  say('\n✗ 部署中断：' + e.message);
  if (e.status === 401) say('  令牌无效或已过期，请重新生成。');
  if (e.status === 403) say('  令牌权限不足：经典令牌需勾选 repo；细粒度令牌需 Contents + Administration 写权限。');
  process.exit(1);
});
