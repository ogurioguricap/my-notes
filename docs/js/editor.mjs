/**
 * 在线编辑与发布（纯前端，无服务器）
 *
 * 工作原理：
 *   浏览器里写 Markdown → 用 lib/markdown.mjs（与构建脚本同一份代码）实时渲染预览
 *   → 保存时调用 GitHub API 把 .md 与重建后的 docs/data/index.json 一起提交
 *   → GitHub Pages 约 1 分钟后自动更新线上站点
 *
 * 令牌只存在本机浏览器的 localStorage，只发往 api.github.com，不经过任何第三方服务器。
 */
import { renderDocument, serializeFrontmatter, parseFrontmatter } from '../../lib/markdown.mjs';

const API = 'https://api.github.com';
const LS_TOKEN = 'note-gh-token';
const LS_OWNER = 'note-gh-owner';
const LS_REPO = 'note-gh-repo';
const LS_BRANCH = 'note-gh-branch';
const LS_DRAFT = 'note-draft:';

/* ============================ GitHub 客户端 ============================ */
export const gh = {
  token: () => localStorage.getItem(LS_TOKEN) || '',
  owner: () => localStorage.getItem(LS_OWNER) || 'ogurioguricap',
  repo: () => localStorage.getItem(LS_REPO) || 'my-notes',
  branch: () => localStorage.getItem(LS_BRANCH) || 'main',
  configured: () => !!localStorage.getItem(LS_TOKEN),

  save({ token, owner, repo, branch }) {
    if (token !== undefined) localStorage.setItem(LS_TOKEN, token.trim());
    if (owner) localStorage.setItem(LS_OWNER, owner.trim());
    if (repo) localStorage.setItem(LS_REPO, repo.trim());
    if (branch) localStorage.setItem(LS_BRANCH, branch.trim());
  },
  clear() {
    localStorage.removeItem(LS_TOKEN);
  },

  async call(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${gh.token()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'notes-site-editor',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || text.slice(0, 160);
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  },

  async verify() {
    const me = await gh.call('/user');
    return me.login;
  },

  async getFileSha(path) {
    try {
      const j = await gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${gh.branch()}`);
      return j.sha;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  async putFile(path, content, message, sha) {
    const body = {
      message,
      content: b64Encode(content),
      branch: gh.branch(),
      ...(sha ? { sha } : {}),
    };
    return gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, { method: 'PUT', body });
  },

  async putBinary(path, base64, message, sha) {
    return gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: { message, content: base64, branch: gh.branch(), ...(sha ? { sha } : {}) },
    });
  },
};

/** UTF-8 安全的 base64（不能用 btoa 直接处理中文） */
export function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
export function b64Decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ============================ 草稿（离线保命） ============================ */
export const draft = {
  save(slug, payload) {
    try { localStorage.setItem(LS_DRAFT + slug, JSON.stringify({ ...payload, at: Date.now() })); } catch (e) {}
  },
  load(slug) {
    try {
      const s = localStorage.getItem(LS_DRAFT + slug);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  },
  clear(slug) { localStorage.removeItem(LS_DRAFT + slug); },
  all() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_DRAFT)) out.push({ slug: k.slice(LS_DRAFT.length), ...JSON.parse(localStorage.getItem(k)) });
    }
    return out;
  },
};

/* ============================ 编辑器 ============================ */
const TOOLBAR = [
  { label: 'H2', title: '二级标题', wrap: ['\n## ', '\n'] },
  { label: 'H3', title: '三级标题', wrap: ['\n### ', '\n'] },
  { label: 'B', title: '粗体', wrap: ['**', '**'] },
  { label: 'I', title: '斜体', wrap: ['*', '*'] },
  { label: 'S', title: '删除线', wrap: ['~~', '~~'] },
  { label: '==', title: '高亮', wrap: ['==', '=='] },
  { label: '‹›', title: '行内代码', wrap: ['`', '`'] },
  { label: '🔗', title: '链接', wrap: ['[', '](https://)'] },
  { label: '🖼', title: '图片（本地图片请上传后引用）', wrap: ['![说明](assets/', ')'] },
  { label: '•', title: '列表', wrap: ['\n- ', ''] },
  { label: '☑', title: '待办', wrap: ['\n- [ ] ', ''] },
  { label: '❝', title: '引用', wrap: ['\n> ', ''] },
  { label: '💡', title: '提示框', wrap: ['\n> [!TIP] 技巧\n> ', ''] },
  { label: '∑', title: '行内公式', wrap: ['$', '$'] },
  { label: '∫', title: '块级公式', wrap: ['\n$$\n', '\n$$\n'] },
  { label: '▦', title: '表格', wrap: ['\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', ''] },
  { label: '</>', title: '代码块', wrap: ['\n```python\n', '\n```\n'] },
  { label: '🔗[[', title: '双链（链接到另一篇笔记）', wrap: ['[[', ']]'] },
];

export class Editor {
  /**
   * @param {object} opts
   *   opts.host        挂载容器（会创建一个面板）
   *   opts.site        { payload, notes, bySlug }
   *   opts.onSaved     (slug, result) => void
   *   opts.onToast     (msg, kind) => void
   *   opts.rebuildIndex (opts) => Promise<object>  重新生成 docs/data/index.json 的内容
   */
  constructor(opts) {
    this.o = opts;
    this.notes = opts.site.notes;
    this.bySlug = opts.site.bySlug;
    this.slug = '';
    this.mode = 'edit';          // edit | preview | split
    this.host = opts.host;
    this.built = false;
    this.busy = false;
  }

  /* ---------- 打开 ---------- */
  open(slug) {
    const note = slug ? this.bySlug.get(slug) : null;
    this.slug = slug || `new-${Date.now().toString(36)}`;
    this.isNew = !note;

    const today = new Date().toISOString().slice(0, 10);
    const meta = note
      ? {
          title: note.title,
          category: note.category,
          tags: (note.tags || []).join(', '),
          date: note.date,
          pinned: !!note.pinned,
          summary: note.summary || '',
        }
      : { title: '', category: '未分类', tags: '', date: today, pinned: false, summary: '' };

    this.meta = { ...meta };
    const saved = draft.load(this.slug);
    this.body = saved ? saved.body : note ? (note.raw || '') : '';

    this.render();
    this.host.classList.add('on');
    if (!gh.configured()) this.toast('首次发布需要填一个 GitHub 令牌（只存在你本机浏览器）', 'warn');
    setTimeout(() => {
      const t = this.host.querySelector('#edTitle');
      if (t && !this.meta.title) t.focus();
    }, 60);
  }

  close() {
    this.host.classList.remove('on');
    this.host.innerHTML = '';
    this.built = false;
    if (this._previewTimer) clearTimeout(this._previewTimer);
  }

  toast(msg, kind) { this.o.onToast && this.o.onToast(msg, kind); }

  /* ---------- 渲染面板 ---------- */
  render() {
    this.host.innerHTML = `
      <div class="ed-mask" data-ed-close="1"></div>
      <div class="ed-body">
        <div class="ed-head">
          <div class="ed-head-left">
            <b id="edHeadTitle">${this.isNew ? '新建笔记' : '编辑笔记'}</b>
            <span class="ed-dirty" id="edDirty">未改动</span>
          </div>
          <div class="ed-head-right">
            <div class="segmented tiny" id="edMode">
              <button type="button" data-mode="edit" class="on" title="只写">✎</button>
              <button type="button" data-mode="split" title="并排">▥</button>
              <button type="button" data-mode="preview" title="只看">👁</button>
            </div>
            <button class="ed-btn" id="edSettings" type="button" title="GitHub 设置">⚙</button>
            <button class="ed-btn" id="edClose" type="button" data-ed-close="1" title="关闭">✕</button>
          </div>
        </div>

        <div class="ed-meta">
          <label class="ed-field ed-field-wide">
            <span>标题</span>
            <input id="edTitle" type="text" placeholder="这篇笔记叫什么" value="${escAttr(this.meta.title)}">
          </label>
          <label class="ed-field">
            <span>分类</span>
            <input id="edCategory" type="text" list="edCats" placeholder="未分类" value="${escAttr(this.meta.category)}">
            <datalist id="edCats">${[...new Set(this.notes.map((n) => n.category))].map((c) => `<option value="${escAttr(c)}">`).join('')}</datalist>
          </label>
          <label class="ed-field">
            <span>标签（逗号分隔）</span>
            <input id="edTags" type="text" placeholder="标签一, 标签二" value="${escAttr(this.meta.tags)}">
          </label>
          <label class="ed-field">
            <span>日期</span>
            <input id="edDate" type="date" value="${escAttr(this.meta.date)}">
          </label>
          <label class="ed-field ed-check">
            <input id="edPinned" type="checkbox" ${this.meta.pinned ? 'checked' : ''}>
            <span>置顶到「收藏」书架</span>
          </label>
          <label class="ed-field ed-field-wide">
            <span>一句话摘要（显示在卡片上）</span>
            <input id="edSummary" type="text" placeholder="不填则自动截取正文开头" value="${escAttr(this.meta.summary)}">
          </label>
        </div>

        <div class="ed-tools">
          ${TOOLBAR.map((t, i) => `<button type="button" class="ed-tool" data-tool="${i}" title="${escAttr(t.title)}">${t.label}</button>`).join('')}
          <span class="ed-tools-gap"></span>
          <button type="button" class="ed-tool" id="edUpload" title="上传图片到 content/assets/">⬆ 传图</button>
          <input type="file" id="edFile" accept="image/*" hidden multiple>
        </div>

        <div class="ed-panes" data-mode="edit">
          <div class="ed-pane ed-pane-write">
            <textarea id="edBody" spellcheck="false" placeholder="在这里写正文，支持 Markdown：## 标题、**粗体**、表格、代码块、$公式$、> [!TIP] 提示框、[[双链]] ……"></textarea>
          </div>
          <div class="ed-pane ed-pane-preview">
            <div class="ed-preview-inner" id="edPreview"></div>
          </div>
        </div>

        <div class="ed-foot">
          <span class="ed-stat" id="edStat"></span>
          <span class="ed-foot-gap"></span>
          <button class="ed-btn" id="edRevert" type="button">放弃改动</button>
          ${this.isNew ? '' : '<button class="ed-btn danger" id="edDelete" type="button">删除这篇</button>'}
          <button class="ed-btn primary" id="edSave" type="button">保存并发布</button>
        </div>
      </div>
    `;

    this.body$ = this.host.querySelector('#edBody');
    this.body$.value = this.body;
    this.preview$ = this.host.querySelector('#edPreview');
    this.stat$ = this.host.querySelector('#edStat');
    this.dirty$ = this.host.querySelector('#edDirty');
    this.panes$ = this.host.querySelector('.ed-panes');
    this.settings = null;

    this.bindPanel();
    this.schedulePreview(true);
    this.built = true;
  }

  bindPanel() {
    const q = (sel) => this.host.querySelector(sel);

    q('#edClose').addEventListener('click', () => this.close());
    this.host.querySelector('.ed-mask').addEventListener('click', () => this.close());

    this.host.querySelectorAll('[data-ed-close]').forEach((el) => {
      if (el.id !== 'edClose') el.addEventListener('click', () => this.close());
    });

    // 模式切换
    this.host.querySelectorAll('#edMode button').forEach((b) =>
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode;
        this.host.querySelectorAll('#edMode button').forEach((x) => x.classList.toggle('on', x === b));
        if (this.panes$) this.panes$.dataset.mode = this.mode;
      })
    );

    // 元数据
    const map = { edTitle: 'title', edCategory: 'category', edTags: 'tags', edDate: 'date', edSummary: 'summary' };
    for (const [id, key] of Object.entries(map)) {
      q('#' + id).addEventListener('input', (e) => {
        this.meta[key] = e.target.value;
        this.markDirty();
      });
    }
    q('#edPinned').addEventListener('change', (e) => {
      this.meta.pinned = e.target.checked;
      this.markDirty();
    });

    // 正文
    this.body$.addEventListener('input', () => {
      this.body = this.body$.value;
      this.markDirty();
      this.schedulePreview();
    });
    this.body$.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = this.body$.selectionStart;
        const v = this.body$.value;
        this.body$.value = v.slice(0, s) + '  ' + v.slice(this.body$.selectionEnd);
        this.body$.selectionStart = this.body$.selectionEnd = s + 2;
        this.body = this.body$.value;
        this.markDirty();
        this.schedulePreview();
      }
    });

    // 工具栏
    this.host.querySelectorAll('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = TOOLBAR[Number(b.dataset.tool)];
        if (t) this.wrapSelection(t.wrap[0], t.wrap[1]);
      })
    );

    // 上传图片
    q('#edUpload').addEventListener('click', () => q('#edFile').click());
    q('#edFile').addEventListener('change', (e) => this.uploadImages(e.target.files));

    // 底部动作
    q('#edRevert').addEventListener('click', () => this.revert());
    q('#edSave').addEventListener('click', () => this.save());
    const del = q('#edDelete');
    if (del) del.addEventListener('click', () => this.remove());
    q('#edSettings').addEventListener('click', () => this.toggleSettings());

    // 快捷键
    this._keyHandler = (e) => {
      if (e.key === 'Escape' && this.host.classList.contains('on')) {
        if (this.settings) this.toggleSettings(false);
        else this.close();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && this.host.classList.contains('on')) {
        e.preventDefault();
        this.save();
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  /* ---------- 文本操作 ---------- */
  wrapSelection(before, after) {
    const ta = this.body$;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const v = ta.value;
    const sel = v.slice(s, e);
    const next = v.slice(0, s) + before + sel + after + v.slice(e);
    ta.value = next;
    const caret = sel ? s + before.length + sel.length + after.length : s + before.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    this.body = next;
    this.markDirty();
    this.schedulePreview();
  }

  markDirty() {
    this.dirty = true;
    if (this.dirty$) { this.dirty$.textContent = '有未保存改动'; this.dirty$.classList.add('on'); }
    this.autosave();
  }

  autosave() {
    clearTimeout(this._autoTimer);
    this._autoTimer = setTimeout(() => {
      draft.save(this.slug, { meta: this.meta, body: this.body, isNew: this.isNew });
    }, 800);
  }

  schedulePreview(immediate) {
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => this.updatePreview(), immediate ? 0 : 180);
  }

  updatePreview() {
    if (!this.preview$) return;
    const raw = serializeFrontmatter({ ...this.meta, slug: this.isNew ? undefined : undefined }) + this.body;
    let rendered;
    try {
      rendered = renderDocument(raw, (href) => href);
    } catch (e) {
      this.preview$.innerHTML = `<div class="ed-error">预览失败：${escHtmlEd(e.message)}</div>`;
      return;
    }
    this.preview$.innerHTML = rendered.html || '<p class="ed-hint">（正文还是空的）</p>';
    // 预览里的公式交给 app.js 的 renderMath（通过事件通知）
    document.dispatchEvent(new CustomEvent('note-editor-preview', { detail: { root: this.preview$ } }));
    const chars = this.body.length;
    const heads = rendered.headings.length;
    const words = (this.body.match(/[\u4e00-\u9fa5]/g) || []).length + (this.body.match(/[A-Za-z]+/g) || []).length;
    if (this.stat$) this.stat$.textContent = `${chars} 字符 · ${words} 字/词 · ${heads} 个小标题 · 预览与构建结果一致`;
  }

  toggleSettings(force) {
    const show = force === undefined ? !this.settings : force;
    const old = this.host.querySelector('.ed-settings');
    if (old) old.remove();
    this.settings = show;
    if (!show) return;
    const box = document.createElement('div');
    box.className = 'ed-settings';
    box.innerHTML = `
      <h4>发布到 GitHub</h4>
      <p>填写一次即可（保存在本机浏览器，只发往 api.github.com）。令牌需要 <code class="md-inline-code">repo</code> 权限，生成地址：github.com/settings/tokens/new</p>
      <label class="ed-field ed-field-wide"><span>Personal Access Token</span>
        <input id="stToken" type="password" placeholder="ghp_..." value="${gh.token() ? escAttr(gh.token()) : ''}"></label>
      <div class="ed-settings-row">
        <label class="ed-field"><span>用户名</span><input id="stOwner" type="text" value="${escAttr(gh.owner())}"></label>
        <label class="ed-field"><span>仓库</span><input id="stRepo" type="text" value="${escAttr(gh.repo())}"></label>
        <label class="ed-field"><span>分支</span><input id="stBranch" type="text" value="${escAttr(gh.branch())}"></label>
      </div>
      <div class="ed-settings-actions">
        <button class="ed-btn" id="stVerify" type="button">验证令牌</button>
        <button class="ed-btn" id="stSave" type="button">保存设置</button>
        <button class="ed-btn danger" id="stClear" type="button">清除令牌</button>
        <span id="stMsg" class="ed-stat"></span>
      </div>`;
    this.host.querySelector('.ed-body').appendChild(box);

    box.querySelector('#stSave').addEventListener('click', () => {
      gh.save({
        token: box.querySelector('#stToken').value,
        owner: box.querySelector('#stOwner').value,
        repo: box.querySelector('#stRepo').value,
        branch: box.querySelector('#stBranch').value,
      });
      box.querySelector('#stMsg').textContent = '已保存在本机浏览器 ✓';
    });
    box.querySelector('#stVerify').addEventListener('click', async () => {
      gh.save({
        token: box.querySelector('#stToken').value,
        owner: box.querySelector('#stOwner').value,
        repo: box.querySelector('#stRepo').value,
        branch: box.querySelector('#stBranch').value,
      });
      const msg = box.querySelector('#stMsg');
      msg.textContent = '验证中…';
      try {
        const login = await gh.verify();
        msg.textContent = `令牌有效 ✓ 身份：${login}`;
      } catch (e) {
        msg.textContent = `验证失败：${e.message}`;
      }
    });
    box.querySelector('#stClear').addEventListener('click', () => {
      gh.clear();
      box.querySelector('#stToken').value = '';
      box.querySelector('#stMsg').textContent = '已清除本机令牌';
    });
  }

  /* ---------- 图片上传 ---------- */
  async uploadImages(files) {
    if (!files || !files.length) return;
    if (!gh.configured()) { this.toast('先填 GitHub 令牌才能上传图片', 'warn'); this.toggleSettings(true); return; }
    for (const file of files) {
      if (!/^image\//.test(file.type)) continue;
      try {
        this.toast(`上传 ${file.name} …`);
        const dataUrl = await readAsDataURL(file);
        const base64 = String(dataUrl).split(',')[1];
        const safe = file.name.replace(/[^\w.\-]+/g, '_');
        const rel = `assets/${safe}`;
        const sha = await gh.getFileSha(`content/${rel}`);
        await gh.putBinary(`content/${rel}`, base64, `assets: 上传 ${safe}`, sha);
        // 顺带复制到 docs/assets/，让线上立即可见
        await gh.putBinary(`docs/${rel}`, base64, `assets: 同步 ${safe}`, await gh.getFileSha(`docs/${rel}`));
        this.body += `\n![${file.name.replace(/\.[^.]+$/, '')}](${rel})\n`;
        this.body$.value = this.body;
        this.markDirty();
        this.schedulePreview(true);
        this.toast(`已上传并插入：${rel}`, 'ok');
      } catch (e) {
        this.toast(`上传失败：${e.message}`, 'error');
      }
    }
    this.host.querySelector('#edFile').value = '';
  }

  /* ---------- 保存 ---------- */
  buildMarkdown(slug) {
    const fm = serializeFrontmatter({
      title: this.meta.title.trim() || '未命名笔记',
      slug: slug,
      category: this.meta.category.trim() || '未分类',
      tags: this.meta.tags,
      date: this.meta.date || new Date().toISOString().slice(0, 10),
      pinned: this.meta.pinned,
      summary: this.meta.summary,
    });
    let body = this.body;
    if (!/^#\s/.test(body.trim())) body = `# ${this.meta.title.trim() || '未命名笔记'}\n\n${body}`;
    return fm + body.trimEnd() + '\n';
  }

  async save() {
    if (this.busy) return;
    if (!gh.configured()) {
      this.toggleSettings(true);
      this.toast('先填写 GitHub 令牌，再保存发布', 'warn');
      return;
    }
    const isNew = this.isNew;
    // 新建：文件名由标题生成；slug 取自最终文件名，保证「文件 ↔ slug ↔ 链接」一致
    const known = isNew ? null : this.bySlug.get(this.slug);
    const fileName = isNew ? slugForFile(this.meta.title || `note-${Date.now()}`) : noteSourceOf(known);
    if (!fileName) { this.toast('文件名解析失败，取消保存', 'error'); return; }
    const slug = isNew ? fileName.replace(/\.md$/, '') : (known && known.slug) || fileName.replace(/\.md$/, '');

    const markdown = this.buildMarkdown(slug);
    const source = `content/${fileName}`;

    this.busy = true;
    const btn = this.host.querySelector('#edSave');
    const old = btn.textContent;
    btn.textContent = '发布中…';
    btn.disabled = true;

    try {
      // 1) 写入 Markdown
      const sha = await gh.getFileSha(source);
      if (!isNew && sha) {
        const remote = await gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${encodeURIComponent(source).replace(/%2F/g, '/')}?ref=${gh.branch()}`);
        const remoteText = b64Decode(remote.content || '');
        if (known && remoteText !== known.rawFull) {
          const go = confirm('远端这篇笔记已经变过（可能是你在别处改的）。\n\n点「确定」用当前内容覆盖，点「取消」先取消保存。');
          if (!go) throw new Error('已取消（远端有更新）');
        }
      }
      await gh.putFile(source, markdown, `${isNew ? 'notes: 新建' : 'notes: 编辑'} ${this.meta.title}`, sha);

      // 2) 用共享内核重建全站索引并提交，线上无需等本地构建
      this.toast('正在重建全站索引…');
      const rebuilt = this.o.rebuildIndex({ source, slug, raw: markdown, attachments: known ? known.attachments || [] : [] });
      const idxSha = await gh.getFileSha('docs/data/index.json');
      await gh.putFile('docs/data/index.json', rebuilt, `build: 重新生成索引（${this.meta.title}）`, idxSha);

      draft.clear(this.slug);
      this.toast(isNew ? '已发布！约 1 分钟后线上可见' : '已保存并发布 ✓', 'ok');
      this.dirty = false;
      if (this.dirty$) { this.dirty$.textContent = '已发布'; this.dirty$.classList.remove('on'); }
      this.o.onSaved && this.o.onSaved(slug, { isNew, fileName });
    } catch (e) {
      this.toast(`保存失败：${e.message}`, 'error');
      draft.save(this.slug, { meta: this.meta, body: this.body, isNew: this.isNew });
      this.toast('草稿已存本机浏览器，刷新也不会丢', 'warn');
    } finally {
      this.busy = false;
      btn.textContent = old;
      btn.disabled = false;
    }
  }

  revert() {
    const note = this.bySlug.get(this.slug);
    if (note) {
      this.body = note.raw || '';
      this.meta = {
        title: note.title,
        category: note.category,
        tags: (note.tags || []).join(', '),
        date: note.date,
        pinned: !!note.pinned,
        summary: note.summary || '',
      };
    } else {
      this.body = '';
    }
    draft.clear(this.slug);
    this.render();
    this.toast('已放弃改动');
  }

  async remove() {
    const note = this.bySlug.get(this.slug);
    if (!note) return;
    if (!gh.configured()) { this.toast('先填 GitHub 令牌', 'warn'); return; }
    if (!confirm(`确定删除《${note.title}》？\n\n会删除仓库里的 ${note.source}，并在下次推送后从站点消失。`)) return;
    try {
      const path = note.source;
      const sha = await gh.getFileSha(path);
      await gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
        method: 'DELETE',
        body: { message: `notes: 删除 ${note.title}`, sha, branch: gh.branch() },
      });
      this.toast('已删除，约 1 分钟后从线上消失', 'ok');
      this.close();
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      this.toast(`删除失败：${e.message}`, 'error');
    }
  }
}

/* ============================ 小工具 ============================ */
export function noteSourceOf(note) {
  if (!note) return '';
  if (note.source) return note.source.replace(/^content\//, '');
  return `${note.slug}.md`;
}

export function slugForFile(title) {
  const s = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${s || 'note-' + Date.now().toString(36)}.md`;
}

function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escHtmlEd(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}
