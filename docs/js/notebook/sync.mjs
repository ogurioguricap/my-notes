/**
 * GoodNotes 模式 · 与仓库同步（把笔记本也交给 git 管）
 *
 * 思路和站点的 Markdown 笔记一致：笔记本 JSON 提交到仓库，于是
 *   · 换设备能拉回来（拉取）
 *   · 每次改动都有 git 历史、可 diff、可回滚
 *   · 别人打开 Pages 上的 docs/notebooks/index.json 就能只读浏览（不需要令牌）
 *
 * 落点：
 *   content/notebooks/<id>.json   笔记本本体（版本控制的真身）
 *   docs/notebooks/<id>.json      线上副本（Pages 直接托管，只读浏览/无令牌拉取）
 *   docs/notebooks/index.json     目录（标题/页数/封面/时间/识别进度），资料库「线上笔记本」用它
 *
 * 冲突规则（简单、可预期）：
 *   远端更新 → 拉取覆盖本地（覆盖前把本地存成「…（本机备份）」副本，不丢东西）
 *   本地更新 → 推送
 *   两边一样 → 什么都不做
 *   本地没有 → 直接导入
 *
 * 纯逻辑（路径、索引、冲突判定、合并）都导出；网络与 gh 客户端通过参数注入，方便测试。
 */
import { SCHEMA_VERSION, makeNotebook } from './store.mjs';

export const NOTEBOOK_DIR = 'content/notebooks';
export const PUBLIC_DIR = 'docs/notebooks';
export const PUBLIC_INDEX = `${PUBLIC_DIR}/index.json`;

export function notebookPath(id) { return `${NOTEBOOK_DIR}/${id}.json`; }
export function publicPath(id) { return `${PUBLIC_DIR}/${id}.json`; }

/** 笔记本 → 可提交的 JSON（音频本体在 IndexedDB，这里只留元数据并标注） */
export function serializeNotebook(nb) {
  const { audio, ...rest } = nb || {};
  return JSON.stringify({
    app: '我的笔记 · GoodNotes 模式',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    notebook: {
      ...rest,
      audio: (audio || []).map((a) => ({ ...a, localOnly: true })),
    },
  }, null, 1);
}

export function parseNotebookJson(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  const raw = j && j.notebook ? j.notebook : j;
  if (!raw || !Array.isArray(raw.pages)) throw new Error('这个文件不是本站的笔记本');
  return makeNotebook(raw);
}

/** 线上目录（只读浏览/列表用，不含内容，体积小） */
export function buildRemoteIndex(notebooks, { generatedAt = new Date().toISOString() } = {}) {
  return JSON.stringify({
    app: '我的笔记 · GoodNotes 模式',
    version: SCHEMA_VERSION,
    generatedAt,
    notebooks: (notebooks || []).map((nb) => ({
      id: nb.id,
      title: nb.title,
      cover: nb.cover,
      folder: nb.folder,
      tags: nb.tags,
      fav: !!nb.fav,
      pages: nb.pages.length,
      scroll: nb.scroll,
      createdAt: nb.createdAt,
      updatedAt: nb.updatedAt,
      openedAt: nb.openedAt || 0,
      study: (nb.study || []).length,
      ocr: (nb.pages || []).filter((p) => p.ocr && p.ocr.text).length,
    })),
  }, null, 1);
}

export function parseRemoteIndex(text) {
  try {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    return Array.isArray(j && j.notebooks) ? j.notebooks : [];
  } catch (e) { return []; }
}

/**
 * 决定这本笔记本该推还是该拉
 * @returns {'push'|'pull'|'same'|'create-local'|'create-remote'}
 */
export function decisionFor(local, remote) {
  if (!local && !remote) return 'same';
  if (!local) return 'create-local';
  if (!remote) return 'create-remote';
  const lt = Number(local.updatedAt) || 0;
  const rt = Number(remote.updatedAt) || 0;
  if (rt > lt + 1000) return 'pull';        // 远端明显更新（1 秒容差，避免时钟抖动反复横跳）
  if (lt > rt + 1000) return 'push';
  return 'same';
}

/** 从线上目录里挑出「本来没有 / 远端更新」的本子 */
export function planSync(localList, remoteList) {
  const byId = new Map((localList || []).map((n) => [n.id, n]));
  const plan = [];
  for (const r of remoteList || []) {
    const local = byId.get(r.id);
    const action = decisionFor(local, r);
    if (action === 'create-local' || action === 'pull') plan.push({ id: r.id, title: r.title, action });
  }
  for (const l of localList || []) {
    if (!(remoteList || []).some((r) => r.id === l.id)) plan.push({ id: l.id, title: l.title, action: 'create-remote' });
  }
  return plan;
}

/* ============================ 与 gh / 静态文件打交道 ============================ */

/**
 * 推一本到仓库（正文 + 线上副本 + 刷新目录）
 * @param {object} gh   editor.mjs 导出的 gh（getFile / putFile）
 */
export async function pushNotebook(gh, store, bookId, { alsoIndex = true } = {}) {
  const nb = store.get(bookId);
  if (!nb) throw new Error('找不到这本笔记本');
  const body = serializeNotebook(nb);
  const msg = `notebook: 更新「${nb.title}」（${nb.pages.length} 页）`;

  const exist = await gh.getFile(notebookPath(bookId));
  await gh.putFile(notebookPath(bookId), body, msg, exist ? exist.sha : null);

  const pubExist = await gh.getFile(publicPath(bookId));
  await gh.putFile(publicPath(bookId), body, `notebook: 同步「${nb.title}」到线上`, pubExist ? pubExist.sha : null);

  let indexOk = false;
  if (alsoIndex) {
    const all = store.notebooks({ sort: 'updated' });
    const idxExist = await gh.getFile(PUBLIC_INDEX);
    await gh.putFile(PUBLIC_INDEX, buildRemoteIndex(all), `notebook: 刷新线上目录（${all.length} 本）`, idxExist ? idxExist.sha : null);
    indexOk = true;
  }
  return { ok: true, bytes: body.length, sha: exist ? exist.sha : null, indexOk, path: notebookPath(bookId) };
}

/** 把本地所有笔记本推上去（第一次用最省事） */
export async function pushAll(gh, store, { onProgress, alsoIndex = true } = {}) {
  const list = store.notebooks();
  const out = { total: list.length, ok: 0, failed: 0, errors: [] };
  for (let i = 0; i < list.length; i++) {
    try {
      await pushNotebook(gh, store, list[i].id, { alsoIndex: false });
      out.ok++;
    } catch (e) {
      out.failed++;
      if (out.errors.length < 5) out.errors.push(`${list[i].title}: ${(e && e.message) || e}`);
    }
    if (onProgress) { try { onProgress({ done: i + 1, total: list.length, title: list[i].title }); } catch (e) {} }
  }
  if (alsoIndex && out.ok) {
    const idxExist = await gh.getFile(PUBLIC_INDEX);
    await gh.putFile(PUBLIC_INDEX, buildRemoteIndex(store.notebooks({ sort: 'updated' })), `notebook: 刷新线上目录（${store.stats().notebooks} 本）`, idxExist ? idxExist.sha : null);
  }
  return out;
}

/**
 * 拉一本下来（远端更新的覆盖本地，覆盖前留一份本机备份副本）
 * @returns {{action:'pull'|'same', notebook?:object, backup?:string}}
 */
export async function pullNotebook(gh, store, bookId, { force = false } = {}) {
  const f = await gh.getFile(notebookPath(bookId));
  if (!f) return { action: 'same' };
  const remote = parseNotebookJson(f.text);
  const local = store.get(bookId);
  let action = decisionFor(local, { ...remote, updatedAt: remote.updatedAt });
  if (force) action = 'pull';
  if (action !== 'pull') return { action: 'same', notebook: remote };

  let backup = '';
  if (local) {
    const copy = store.duplicate(bookId);
    if (copy) {
      store.update(copy.id, { title: `${copy.title}（本机备份 ${new Date().toISOString().slice(0, 10)}）` });
      backup = copy.id;
    }
    store.purge(bookId);
  }
  const imported = store.importJSON(JSON.stringify({ notebooks: [{ ...remote, id: bookId }] }));
  return { action: 'pull', notebook: store.get(bookId), backup, imported: imported.notebooks };
}

/** 从静态站点读线上目录（不需要令牌，只读浏览用） */
export async function fetchPublicIndex(fetchImpl, base = '') {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return [];
  try {
    const res = await f(`${base}notebooks/index.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return parseRemoteIndex(await res.text());
  } catch (e) { return []; }
}

/** 从静态站点拉一本（不需要令牌；用于「线上笔记本」只读导入） */
export async function pullFromPublicSite(store, id, fetchImpl, base = '') {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('当前环境不能发网络请求');
  const res = await f(`${base}notebooks/${encodeURIComponent(id)}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`线上没有这本笔记本（HTTP ${res.status}）`);
  const nb = parseNotebookJson(await res.text());
  const clash = !!store.get(nb.id);
  if (clash) nb.id = nb.id + '-' + Date.now().toString(36);
  store.data.notebooks.unshift(nb);
  store.save();
  return { notebook: nb, renamed: clash };
}

export function syncText(res) {
  if (!res) return '';
  if (res.action === 'pull') return `已从仓库拉取${res.backup ? '（旧的存成了本机备份副本）' : ''}`;
  if (res.action === 'same') return '两边一样，不用动';
  return '';
}
