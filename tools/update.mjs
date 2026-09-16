#!/usr/bin/env node
/**
 * 一键更新：附件文字提取 → 构建 → 自检 → 检索测试 → 提交 → 推送
 *
 * 用法：
 *   node tools/update.mjs                  全流程
 *   node tools/update.mjs -m "新增 xxx"     指定提交信息
 *   node tools/update.mjs --no-push        只提交不推送
 *   node tools/update.mjs --check-only     只跑检查，不改仓库
 *   node tools/update.mjs --print-git      不执行 git，只打印该执行的命令
 *
 * 实现说明：全部步骤在同一个 Node 进程内直接调用（不 spawn 子进程），
 * 因此在禁止子进程的环境里也能完成构建与检查；git 部分会自动探测，
 * 不可用时打印出可直接复制的命令。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const valueOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const CHECK_ONLY = flag('--check-only');
const NO_PUSH = flag('--no-push');
const PRINT_GIT = flag('--print-git');
const MESSAGE = valueOf('-m', '');

const t0 = Date.now();
const head = (n, t) => console.log(`\n──────── ${n}. ${t} ────────`);

/* ---------- git 能力探测（部分受限环境不允许起子进程） ---------- */
function gitAvailable() {
  if (PRINT_GIT) return false;
  try {
    const r = spawnSync('git', ['--version'], { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 && !r.error;
  } catch (e) {
    return false;
  }
}
function git(args, { quiet = false } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, out: (r.stdout || '') + (r.stderr || '') };
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  return { ok: true, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('📓 笔记站一键更新');
console.log(`   项目：${ROOT}`);

/* ---------- 1~4 进程内直跑 ---------- */
head(1, '附件文字提取（图片 OCR / PDF 文本）');
const { main: extractAttachments } = await import('./extract-attachments.mjs');
extractAttachments();

head(2, '构建站点');
const { main: buildSite } = await import('./build.mjs');
if (!buildSite()) {
  console.error('\n✗ 构建失败，已中止');
  process.exit(1);
}

head(3, '静态自检（DOM 契约 / 产物完整性 / 路径安全）');
const { main: selfcheck } = await import('./selfcheck.mjs');
const selfOk = selfcheck();

head(4, '检索功能实测');
const { main: testSearch } = await import('./test-search.mjs');
const searchOk = await testSearch();

head(5, '资料库界面数据契约（封面卡片 / 书架 / 速览）');
const { main: testUiLib } = await import('./test-ui-lib.mjs');
const uiOk = await testUiLib();

if (!selfOk || !searchOk || !uiOk) {
  console.log('\n✗ 检查未全部通过，已停止（不会提交有问题的版本）');
  console.log(`  自检：${selfOk ? '通过' : '失败'}   检索：${searchOk ? '通过' : '失败'}   界面契约：${uiOk ? '通过' : '失败'}`);
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log(`\n✅ 检查完成（未改动仓库），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

/* ---------- 5~6 提交与推送 ---------- */
const canGit = gitAvailable();

head(5, '提交改动');
if (!canGit) {
  console.log('  ℹ 当前环境不允许启动 git 子进程（沙箱限制），改为输出待执行命令：');
  console.log('\n  ┌─ 复制下面的命令执行 ─────────────────────────────');
  console.log('  │ node tools/update.mjs        # 或直接跑这行，它会做同样的检查');
  console.log(`  │ git add -A`);
  console.log(`  │ git commit -m "${MESSAGE || `notes: 更新 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`}"`);
  console.log('  │ git push');
  console.log('  └─────────────────────────────────────────────────');
  console.log(`\n✅ 构建与检查完成（未提交），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

const status = git(['status', '--porcelain'], { quiet: true });
if (!status.ok) {
  console.error('✗ 读取 git 状态失败：' + status.out.trim());
  process.exit(1);
}
if (!status.out.trim()) {
  console.log('  工作区干净，没有需要提交的改动');
  console.log(`\n✅ 完成（无改动），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}
const changed = status.out.trim().split(/\r?\n/).length;
git(['add', '-A']);
const msg = MESSAGE || `notes: 更新 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}（${changed} 个文件）`;
const commit = git(['commit', '-m', msg], { quiet: true });
if (!commit.ok) {
  console.error('✗ 提交失败：' + commit.out.trim());
  process.exit(1);
}
console.log(`  ✅ 已提交 ${changed} 个文件：${msg}`);

head(6, '推送');
if (NO_PUSH) {
  console.log('  已跳过（--no-push）');
} else {
  const remotes = git(['remote'], { quiet: true });
  const hasRemote = remotes.ok && remotes.out.trim().length > 0;
  if (!hasRemote) {
    console.log('  ⚠ 没有配置远程仓库，已本地提交。');
    console.log('    配置后执行： git remote add origin <你的仓库地址> ； git push -u origin main');
  } else {
    const push = git(['push'], { quiet: true });
    if (push.ok) {
      console.log('  ✅ 已推送');
    } else {
      console.log('\n  ⚠ 推送失败（通常是尚未认证）。本地提交已完成，任选一种方式后重试：');
      console.log('     · 浏览器登录弹窗：  git push');
      console.log('     · 令牌临时推送：    git remote set-url origin https://<用户名>:<PAT>@github.com/<用户名>/<仓库>.git');
      console.log('                         git push && git remote set-url origin https://github.com/<用户名>/<仓库>.git');
      console.log('     · 安装 gh 后：      winget install --id GitHub.cli -e ； gh auth login ； git push');
    }
  }
}

console.log(`\n✅ 全流程完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
