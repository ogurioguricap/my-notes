#!/usr/bin/env node
/**
 * 检查 GitHub 令牌状态（为什么「总是失效」看这个）
 *
 * 用法： node tools/check-token.mjs
 *
 * 做三件事：
 *   1. 问 GitHub 这个令牌是否有效、什么身份、有哪些权限、**什么时候过期**
 *   2. 提醒快过期（<7 天）与已过期，并给出「怎么续」的步骤
 *   3. 顺手排查泄漏风险：令牌有没有被写进 .git/config / 仓库文件里（GitHub 的密钥扫描会自动吊销这类令牌）
 *
 * 为什么会有「老是失效」这件事：GitHub 现在**强制要求令牌带过期时间**
 * （经典令牌最长 1 年、默认 30 天；细粒度令牌也得设过期）。
 * 到点就失效是设计如此，不是你用错了——要么重新生成（把过期时间设长一点），要么改用免过期的凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (s = '') => console.log(s);

const tokenFile = ['github-token.txt', 'github-token.md'].find((f) => fs.existsSync(path.join(ROOT, f)));
const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const raw = tokenFile ? fs.readFileSync(path.join(ROOT, tokenFile), 'utf8') : '';
const fileToken = (/(gh[pous]_[A-Za-z0-9]{20,})/.exec(raw) || [])[1] || '';
const token = envToken || fileToken;

say('──────── 1. 找到的令牌 ────────');
if (!token) {
  say('❌ 没找到令牌：环境变量 GITHUB_TOKEN / GH_TOKEN 都没有，本地也没有 github-token.txt');
  process.exit(1);
}
say(`来源：${envToken ? '环境变量' : tokenFile}`);
say(`类型：${token.slice(0, 4)}…（长度 ${token.length}）${token.startsWith('github_pat_') ? ' · 细粒度令牌' : token.startsWith('ghp_') ? ' · 经典令牌' : ''}`);

say('\n──────── 2. 问一下 GitHub ────────');
const res = await fetch('https://api.github.com/user', {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'notes-site-check' },
});
if (!res.ok) {
  const body = await res.text().catch(() => '');
  say(`❌ 令牌无效（HTTP ${res.status}）${res.status === 401 ? '：多半是**已过期**或被吊销' : ''}`);
  say(`   GitHub 说：${body.slice(0, 200)}`);
  say('\n怎么续：');
  say('  1) 打开 https://github.com/settings/tokens/new（经典令牌）勾 repo，把 Expiration 设成 1 年');
  say('  2) 生成后把新令牌粘回 github-token.txt（这个文件已被 .gitignore 排除）');
  say('  3) 再跑一次本命令确认；线上编辑器里也要在 ⚙ 里重新粘一次（令牌存在浏览器 localStorage）');
  process.exit(1);
}
const user = await res.json();
const expires = res.headers.get('github-authentication-token-expiration');
const scopes = res.headers.get('x-oauth-scopes');
say(`✅ 有效 · 身份 ${user.login} · 权限 ${scopes || '（细粒度，按仓库授权）'}`);
if (expires) {
  const at = new Date(`${expires.replace(' UTC', '')}Z`);
  const days = Math.floor((at.getTime() - Date.now()) / 86400000);
  say(`过期时间：${expires}（还剩约 ${days} 天）`);
  if (days <= 0) say('❌ 已经过期了：按下面「怎么续」重新生成');
  else if (days <= 7) say('⚠️ 快到期了（≤7 天）：现在就换一个，不然过几天推送/在线发布就会突然失败');
  else say('✅ 还很宽裕');
} else {
  say('过期时间：GitHub 没返回（可能是细粒度令牌且已设置过期，或用了别的认证方式）——保险起见按「会过期」对待');
}

say('\n──────── 3. 泄漏风险自查 ────────');
// 3a. .git/config 的 remote 里有没有把令牌写进 URL（GitHub 密钥扫描会因此自动吊销）
const cfgPath = path.join(ROOT, '.git', 'config');
const cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
const inRemote = /https:\/\/[^/@\s]*:[^@\s]*@github\.com/.test(cfg);
say(inRemote ? '❌ .git/config 的 remote 里嵌了凭据（令牌明文躺在 .git/config）' : '✅ .git/config 的 remote 没有嵌凭据');
if (inRemote) {
  say('   修：git remote set-url origin https://github.com/ogurioguricap/my-notes.git');
  say('   然后把令牌交给凭据管理器，或直接用 node tools/push-exact.mjs 走 API 推送');
}
// 3b. 仓库里（tracked 文件）有没有明文令牌
const scanDirs = ['docs', 'content', 'tools'];
let hits = 0;
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!/node_modules|\.git$/.test(name)) walk(p); continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    if (!/\.(mjs|js|json|md|html|css|txt|yml|yaml|tex)$/i.test(name)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    if (/gh[pous]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(txt)) { hits++; say(`❌ 发现明文令牌：${path.relative(ROOT, p)}`); }
  }
};
for (const d of scanDirs) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
if (fs.existsSync(path.join(ROOT, 'README.md'))) {
  const r = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  if (/gh[pous]_[A-Za-z0-9]{20,}/.test(r)) { hits++; say('❌ README.md 里有明文令牌'); }
}
say(hits ? `❌ 共 ${hits} 处（GitHub 会对公开仓库里的令牌自动吊销，务必删掉并换新令牌）` : '✅ 仓库文件里没有明文令牌');

say('\n──────── 怎么续令牌（三步） ────────');
say('1) https://github.com/settings/tokens/new → 勾 repo → Expiration 选 1 年 → 生成');
say('2) 把新令牌粘进 github-token.txt（若还用了别的机器，也在那台机器的浏览器 ⚙ 里粘一次）');
say('3) node tools/check-token.mjs 复核；之后 git push 或 node tools/push-exact.mjs 都能用');
say('\n想彻底免维护：改用 SSH 推送（git@github.com:…）+ 让本地 git 用凭据管理器存密码，令牌只留给「在线编辑发布」用。');
