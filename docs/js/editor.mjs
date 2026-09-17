/**
 * 在线编辑与发布（纯前端，无服务器）
 *
 * 两种编辑方式：
 *   · 可视化（默认）：像手账 App 那样点按钮改字号、加粗、列表、对齐，全程看不见 Markdown 符号
 *   · 源码：直接编辑 Markdown（适合精细调整表格 / 公式 / 代码块）
 *
 * 保存链路：GitHub API 提交 content/xxx.md → 浏览器重建 docs/data/index.json → Pages 自动更新
 * 令牌只存在本机浏览器 localStorage，只发往 api.github.com。
 */
import { parseFrontmatter } from '../lib/markdown.mjs';
import { editorToMarkdown, applyFontSize, toggleHighlight, execCommand, currentBlock, isInTag, handlePaste, normalizeEditorHtml, FONT_SIZES } from './rte.mjs';

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
  clear() { localStorage.removeItem(LS_TOKEN); },

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

  async verify() { return (await gh.call('/user')).login; },

  /** 仓库路径：只对特殊字符编码，斜杠必须保留 */
  path(p) { return encodeURIComponent(p).replace(/%2F/g, '/'); },

  async getFile(path) {
    try {
      const j = await gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${gh.path(path)}?ref=${gh.branch()}`);
      return { sha: j.sha, text: b64Decode(j.content || '') };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  async putFile(path, content, message, sha) {
    return gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${gh.path(path)}`, {
      method: 'PUT',
      body: { message, content: b64Encode(content), branch: gh.branch(), ...(sha ? { sha } : {}) },
    });
  },

  async putBinary(path, base64, message, sha) {
    return gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${gh.path(path)}`, {
      method: 'PUT',
      body: { message, content: base64, branch: gh.branch(), ...(sha ? { sha } : {}) },
    });
  },
};

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

/* ============================ 草稿 ============================ */
export const draft = {
  save(slug, payload) {
    try { localStorage.setItem(LS_DRAFT + slug, JSON.stringify({ ...payload, at: Date.now() })); } catch (e) {}
  },
  load(slug) {
    try { const s = localStorage.getItem(LS_DRAFT + slug); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  },
  clear(slug) { localStorage.removeItem(LS_DRAFT + slug); },
};

/* ============================ 工具栏定义 ============================ */
const INLINE_TOOLS = [
  { id: 'bold', label: 'B', title: '加粗（Ctrl+B）', cmd: 'bold', style: 'font-weight:800' },
  { id: 'italic', label: 'I', title: '斜体（Ctrl+I）', cmd: 'italic', style: 'font-style:italic' },
  { id: 'strike', label: 'S', title: '删除线', cmd: 'strikeThrough', style: 'text-decoration:line-through' },
  { id: 'code', label: '</>', title: '行内代码', act: 'inlineCode' },
  { id: 'link', label: '🔗', title: '插入链接', act: 'link' },
  { id: 'highlight', label: '🖍', title: '荧光笔高亮', act: 'highlight' },
];

const BLOCK_TOOLS = [
  { id: 'p', label: '正文', cmd: 'formatBlock', arg: 'p' },
  { id: 'h2', label: '大标题', cmd: 'formatBlock', arg: 'h2' },
  { id: 'h3', label: '小标题', cmd: 'formatBlock', arg: 'h3' },
  { id: 'ul', label: '• 列表', cmd: 'insertUnorderedList' },
  { id: 'ol', label: '1. 列表', cmd: 'insertOrderedList' },
  { id: 'quote', label: '❝ 引用', cmd: 'formatBlock', arg: 'blockquote' },
  { id: 'pre', label: '代码块', cmd: 'formatBlock', arg: 'pre' },
  { id: 'hr', label: '— 分隔线', cmd: 'insertHorizontalRule' },
];

const ALIGN_TOOLS = [
  { id: 'left', label: '⬅', title: '左对齐', cmd: 'justifyLeft' },
  { id: 'center', label: '↔', title: '居中', cmd: 'justifyCenter' },
  { id: 'right', label: '➡', title: '右对齐', cmd: 'justifyRight' },
];

/* ============================ 编辑器 ============================ */
export class Editor {
  constructor(opts) {
    this.o = opts;                       // { host, site, renderMarkdown, rebuildIndex, onToast, onSaved }
    this.notes = opts.site.notes;
    this.bySlug = opts.site.bySlug;
    this.slug = '';
    this.mode = 'rich';
    this.host = opts.host;
    this.busy = false;
  }

  toast(msg, kind) { this.o.onToast && this.o.onToast(msg, kind); }

  /* ---------- 打开 ---------- */
  open(slug) {
    const note = slug ? this.bySlug.get(slug) : null;
    this.slug = slug || `new-${Date.now().toString(36)}`;
    this.isNew = !note;
    const today = new Date().toISOString().slice(0, 10);

    this.meta = note
      ? {
          title: note.title, category: note.category,
          tags: (note.tags || []).join(', '),
          date: note.date, pinned: !!note.pinned, summary: note.summary || '',
        }
      : { title: '', category: '未分类', tags: '', date: today, pinned: false, summary: '' };

    const saved = draft.load(this.slug);
    this.body = saved ? saved.body : note ? (note.raw || '') : '';
    if (saved && saved.meta) this.meta = { ...this.meta, ...saved.meta };

    this.render();
    this.host.classList.add('on');
    if (!gh.configured()) this.toast('首次发布需要填一个 GitHub 令牌（只存在你本机浏览器）', 'warn');
    if (saved) this.toast('已恢复上次未发布的草稿', 'warn');
  }

  close() {
    this.syncFromRich();
    this.host.classList.remove('on');
    this.host.innerHTML = '';
    if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
    if (this._previewTimer) clearTimeout(this._previewTimer);
  }

  /* ---------- 渲染 ---------- */
  render() {
    const richInit = this.bodyToHtml(this.body);
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
              <button type="button" data-mode="rich" class="on" title="可视化编辑：点按钮改排版">🖱 可视化</button>
              <button type="button" data-mode="source" title="源码编辑：直接写 Markdown">⌨ 源码</button>
            </div>
            <button class="ed-btn" id="edHelp" type="button" title="怎么用">?</button>
            <button class="ed-btn" id="edSettings" type="button" title="GitHub 设置">⚙</button>
            <button class="ed-btn" id="edClose" type="button" data-ed-close="1" title="关闭">✕</button>
          </div>
        </div>

        <div class="ed-meta">
          <label class="ed-field ed-field-wide"><span>标题</span>
            <input id="edTitle" type="text" placeholder="这篇笔记叫什么" value="${escAttr(this.meta.title)}"></label>
          <label class="ed-field"><span>分类</span>
            <input id="edCategory" type="text" list="edCats" placeholder="未分类" value="${escAttr(this.meta.category)}">
            <datalist id="edCats">${[...new Set(this.notes.map((n) => n.category))].map((c) => `<option value="${escAttr(c)}">`).join('')}</datalist></label>
          <label class="ed-field"><span>标签（逗号分隔）</span>
            <input id="edTags" type="text" placeholder="标签一, 标签二" value="${escAttr(this.meta.tags)}"></label>
          <label class="ed-field"><span>日期</span>
            <input id="edDate" type="date" value="${escAttr(this.meta.date)}"></label>
          <label class="ed-field ed-check">
            <input id="edPinned" type="checkbox" ${this.meta.pinned ? 'checked' : ''}><span>置顶到「收藏」书架</span></label>
          <label class="ed-field ed-field-wide"><span>一句话摘要（显示在卡片上）</span>
            <input id="edSummary" type="text" placeholder="不填则自动截取正文开头" value="${escAttr(this.meta.summary)}"></label>
        </div>

        <div class="ed-tools" id="edRichTools">
          <div class="ed-toolgroup">
            <span class="ed-toolgroup-label">字号</span>
            ${FONT_SIZES.map((f, i) => `<button type="button" class="ed-tool${f.em === 1 ? ' on' : ''}" data-size="${i}" title="字号：${f.label}">${f.label}</button>`).join('')}
          </div>
          <div class="ed-toolgroup">
            <span class="ed-toolgroup-label">样式</span>
            ${INLINE_TOOLS.map((t) => `<button type="button" class="ed-tool" data-inline="${t.id}" title="${t.title}" style="${t.style || ''}">${t.label}</button>`).join('')}
          </div>
          <div class="ed-toolgroup">
            <span class="ed-toolgroup-label">段落</span>
            ${BLOCK_TOOLS.map((t) => `<button type="button" class="ed-tool" data-block="${t.id}" title="${t.label}">${t.label}</button>`).join('')}
          </div>
          <div class="ed-toolgroup">
            <span class="ed-toolgroup-label">对齐</span>
            ${ALIGN_TOOLS.map((t) => `<button type="button" class="ed-tool" data-align="${t.id}" title="${t.title}">${t.label}</button>`).join('')}
          </div>
          <div class="ed-toolgroup">
            <span class="ed-toolgroup-label">插入</span>
            <button type="button" class="ed-tool" id="edUpload" title="上传图片到仓库">🖼 图片</button>
            <button type="button" class="ed-tool" data-insert="math" title="行内公式">∑</button>
            <button type="button" class="ed-tool" data-insert="mathblock" title="独立公式">∫</button>
            <button type="button" class="ed-tool" data-insert="table" title="插入表格">▦ 表格</button>
            <button type="button" class="ed-tool" data-insert="callout" title="插入提示框">💡 提示框</button>
            <button type="button" class="ed-tool" data-insert="toc" title="插入自动目录">📑 目录</button>
            <button type="button" class="ed-tool" data-insert="wikilink" title="链接到另一篇笔记">🔗[[ ]]</button>
          </div>
          <input type="file" id="edFile" accept="image/*" hidden multiple>
        </div>

        <div class="ed-panes" id="edPanes">
          <div class="ed-pane ed-pane-write">
            <div class="ed-rich" id="edRich" contenteditable="true" spellcheck="false">${richInit}</div>
            <textarea id="edBody" spellcheck="false" style="display:none" placeholder="在这里写 Markdown……"></textarea>
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
      </div>`;

    this.rich$ = this.host.querySelector('#edRich');
    this.body$ = this.host.querySelector('#edBody');
    this.preview$ = this.host.querySelector('#edPreview');
    this.stat$ = this.host.querySelector('#edStat');
    this.dirty$ = this.host.querySelector('#edDirty');
    this.body$.value = this.body;
    this.bind();
    this.updatePreview();
  }

  /** Markdown 正文 → 编辑器 HTML（与阅读页同款渲染，编辑面所见即阅读面） */
  bodyToHtml(markdown) {
    try { return normalizeEditorHtml(this.o.renderMarkdown(markdown).html); }
    catch (e) { return normalizeEditorHtml(`<p>${escHtml(markdown)}</p>`); }
  }

  /** 编辑器 HTML → Markdown */
  htmlToBody() {
    try { return editorToMarkdown(this.rich$); }
    catch (e) { this.toast('转换失败，已切到源码模式：' + e.message, 'error'); return this.body || ''; }
  }

  syncFromRich() {
    if (this.mode === 'rich' && this.rich$) this.body = this.htmlToBody();
    else if (this.body$) this.body = this.body$.value;
    return this.body;
  }

  /* ---------- 事件 ---------- */
  bind() {
    const q = (s) => this.host.querySelector(s);
    q('#edClose').addEventListener('click', () => this.close());
    this.host.querySelector('.ed-mask').addEventListener('click', () => this.close());

    this.host.querySelectorAll('#edMode button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));

    const map = { edTitle: 'title', edCategory: 'category', edTags: 'tags', edDate: 'date', edSummary: 'summary' };
    for (const [id, key] of Object.entries(map)) q('#' + id).addEventListener('input', (e) => { this.meta[key] = e.target.value; this.markDirty(); });
    q('#edPinned').addEventListener('change', (e) => { this.meta.pinned = e.target.checked; this.markDirty(); });

    this.rich$.addEventListener('input', () => { this.markDirty(); this.schedulePreview(); });
    this.rich$.addEventListener('paste', (e) => { handlePaste(this.rich$, e); this.markDirty(); this.schedulePreview(); });
    this.rich$.addEventListener('keyup', () => this.refreshToolbarState());
    this.rich$.addEventListener('mouseup', () => this.refreshToolbarState());
    this.rich$.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
      if (e.key === 'Tab') { e.preventDefault(); execCommand('insertText', '  '); }
    });

    this.host.querySelectorAll('[data-size]').forEach((b) =>
      b.addEventListener('click', () => {
        const f = FONT_SIZES[Number(b.dataset.size)];
        this.rich$.focus();
        if (!applyFontSize(this.rich$, f.em)) this.toast('先选中要改字号的文字', 'warn');
        else { this.markDirty(); this.schedulePreview(); }
        this.host.querySelectorAll('[data-size]').forEach((x) => x.classList.toggle('on', x === b));
      })
    );

    this.host.querySelectorAll('[data-inline]').forEach((b) =>
      b.addEventListener('click', () => {
        this.rich$.focus();
        const id = b.dataset.inline;
        const t = INLINE_TOOLS.find((x) => x.id === id);
        if (id === 'highlight') toggleHighlight(this.rich$);
        else if (id === 'link') this.insertLink();
        else if (id === 'code') this.wrapInlineCode();
        else if (t && t.cmd) execCommand(t.cmd);
        this.markDirty();
        this.schedulePreview();
        this.refreshToolbarState();
      })
    );

    this.host.querySelectorAll('[data-block]').forEach((b) =>
      b.addEventListener('click', () => {
        this.rich$.focus();
        const t = BLOCK_TOOLS.find((x) => x.id === b.dataset.block);
        if (t) execCommand(t.cmd, t.arg);
        this.markDirty();
        this.schedulePreview();
        this.refreshToolbarState();
      })
    );

    this.host.querySelectorAll('[data-align]').forEach((b) =>
      b.addEventListener('click', () => {
        this.rich$.focus();
        const t = ALIGN_TOOLS.find((x) => x.id === b.dataset.align);
        if (t) execCommand(t.cmd);
        this.markDirty();
      })
    );

    this.host.querySelectorAll('[data-insert]').forEach((b) => b.addEventListener('click', () => this.insertSnippet(b.dataset.insert)));
    q('#edUpload').addEventListener('click', () => q('#edFile').click());
    q('#edFile').addEventListener('change', (e) => this.uploadImages(e.target.files));

    this.body$.addEventListener('input', () => { this.markDirty(); this.schedulePreview(); });
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

    q('#edRevert').addEventListener('click', () => this.revert());
    q('#edSave').addEventListener('click', () => this.save());
    q('#edSettings').addEventListener('click', () => this.toggleSettings());
    q('#edHelp').addEventListener('click', () => this.toggleHelp());
    const del = q('#edDelete');
    if (del) del.addEventListener('click', () => this.remove());

    this._keyHandler = (e) => {
      if (!this.host.classList.contains('on')) return;
      if (e.key === 'Escape') {
        const panel = this.host.querySelector('.ed-settings, .ed-help');
        if (panel) panel.remove();
        else this.close();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
      if (this.mode === 'rich' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); execCommand('bold'); this.schedulePreview(); }
      if (this.mode === 'rich' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); execCommand('italic'); this.schedulePreview(); }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'source') {
      this.syncFromRich();
      this.body$.value = this.body;
      this.body$.style.display = 'block';
      this.rich$.style.display = 'none';
      this.host.querySelector('#edRichTools').style.display = 'none';
    } else {
      this.body = this.body$.value;
      this.rich$.innerHTML = this.bodyToHtml(this.body);
      this.body$.style.display = 'none';
      this.rich$.style.display = 'block';
      this.host.querySelector('#edRichTools').style.display = 'flex';
    }
    this.mode = mode;
    this.host.querySelectorAll('#edMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    this.updatePreview();
  }

  refreshToolbarState() {
    const block = currentBlock(this.rich$);
    this.host.querySelectorAll('[data-block]').forEach((b) => b.classList.toggle('on', b.dataset.block === block));
    this.host.querySelectorAll('[data-inline]').forEach((b) => {
      const id = b.dataset.inline;
      const on = (id === 'bold' && isInTag(this.rich$, 'strong')) ||
        (id === 'italic' && isInTag(this.rich$, 'em')) ||
        (id === 'strike' && isInTag(this.rich$, 'del')) ||
        (id === 'highlight' && isInTag(this.rich$, 'mark')) ||
        (id === 'code' && isInTag(this.rich$, 'code'));
      b.classList.toggle('on', !!on);
    });
  }

  insertLink() {
    const url = prompt('链接地址（https:// 开头，或站内 #/note/xxx）');
    if (!url) return;
    const sel = window.getSelection();
    const hadText = sel && !sel.isCollapsed;
    execCommand('createLink', url);
    if (!hadText) execCommand('insertText', url);
  }

  wrapInlineCode() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { this.toast('先选中要变成代码的文字', 'warn'); return; }
    const code = document.createElement('code');
    code.className = 'md-inline-code';
    try { sel.getRangeAt(0).surroundContents(code); } catch (e) {}
  }

  insertSnippet(kind) {
    const html = {
      math: '<span class="md-math-inline" data-tex="E = mc^2"></span>',
      mathblock: '<div class="md-math-block" data-tex="\\sum_{i=1}^{n} x_i"></div><p><br></p>',
      table: '<table><thead><tr><th>列 1</th><th>列 2</th></tr></thead><tbody><tr><td> </td><td> </td></tr><tr><td> </td><td> </td></tr></tbody></table><p><br></p>',
      callout: '<div class="md-callout md-callout-tip" data-callout="TIP" data-callout-title="技巧"><p class="md-callout-title">技巧</p><p>在这里写提示内容。</p></div><p><br></p>',
      toc: '<h2>目录</h2><ul class="md-index-list"><li><span>小节一</span></li><li><span>小节二</span></li></ul><p><br></p>',
      wikilink: '[[另一篇笔记的标题]]',
    }[kind];
    const mdText = {
      math: '$E = mc^2$',
      mathblock: '\n$$\n\\sum_{i=1}^{n} x_i\n$$\n',
      table: '\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n',
      callout: '\n> [!TIP] 技巧\n> 在这里写提示内容。\n',
      toc: '\n## 目录\n\n- 小节一\n- 小节二\n',
      wikilink: '[[另一篇笔记的标题]]',
    }[kind];
    if (!html) return;
    if (this.mode !== 'rich') {
      const ta = this.body$;
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + mdText + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + mdText.length;
      this.body = ta.value;
    } else {
      this.rich$.focus();
      execCommand('insertHTML', html);
    }
    this.markDirty();
    this.schedulePreview();
  }

  markDirty() {
    this.dirty = true;
    if (this.dirty$) { this.dirty$.textContent = '有未保存改动'; this.dirty$.classList.add('on'); }
    clearTimeout(this._autoTimer);
    this._autoTimer = setTimeout(() => draft.save(this.slug, { meta: this.meta, body: this.syncFromRich(), isNew: this.isNew }), 800);
  }

  schedulePreview() {
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => this.updatePreview(), 200);
  }

  updatePreview() {
    if (!this.preview$) return;
    const md = this.mode === 'rich' ? this.htmlToBody() : this.body$.value;
    this.body = md;
    let html = '';
    try { html = this.o.renderMarkdown(md).html; }
    catch (e) { this.preview$.innerHTML = `<div class="ed-error">预览失败：${escHtml(e.message)}</div>`; return; }
    this.preview$.innerHTML = html || '<p class="ed-hint">（正文还是空的）</p>';
    document.dispatchEvent(new CustomEvent('note-editor-preview', { detail: { root: this.preview$ } }));
    const heads = (md.match(/^#{1,6}\s/gm) || []).length;
    const words = (md.match(/[\u4e00-\u9fa5]/g) || []).length + (md.match(/[A-Za-z]+/g) || []).length;
    if (this.stat$) this.stat$.textContent = `${md.length} 字符 · ${words} 字/词 · ${heads} 个标题 · 预览＝线上效果`;
  }

  toggleHelp() {
    const old = this.host.querySelector('.ed-help');
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.className = 'ed-help';
    box.innerHTML = `
      <h4>怎么用（不用懂 Markdown）</h4>
      <ul>
        <li><b>改字号</b>：选中文字 → 点「字号」里的小 / 正常 / 大 / 特大 / 超大</li>
        <li><b>加粗斜体高亮</b>：选中文字 → B / I / S / 🖍</li>
        <li><b>段落类型</b>：光标放在某一行 → 正文 / 大标题 / 小标题 / 列表 / 引用 / 代码块</li>
        <li><b>对齐</b>：⬅ ↔ ➡</li>
        <li><b>插图与结构</b>：🖼 图片（自动上传到仓库）、∑ 公式、▦ 表格、💡 提示框、📑 自动目录</li>
        <li><b>保存</b>：Ctrl / Cmd + S，或右下「保存并发布」；约 1 分钟后线上生效</li>
        <li><b>手写批注</b>：关掉编辑器，在笔记页点「✍ 标注」，用画笔直接在正文上勾画</li>
      </ul>
      <p class="ed-hint">表格 / 公式 / 代码块这类精细结构，随时可以切到「⌨ 源码」直接改；两种模式内容等价。</p>`;
    this.host.querySelector('.ed-body').appendChild(box);
  }

  toggleSettings() {
    const old = this.host.querySelector('.ed-settings');
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.className = 'ed-settings';
    box.innerHTML = `
      <h4>发布到 GitHub</h4>
      <p>填一次即可（存在本机浏览器，只发往 api.github.com）。令牌需要 <code class="md-inline-code">repo</code> 权限：github.com/settings/tokens/new</p>
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
      try { msg.textContent = `令牌有效 ✓ 身份：${await gh.verify()}`; }
      catch (e) { msg.textContent = `验证失败：${e.message}`; }
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
    if (!gh.configured()) { this.toast('先填 GitHub 令牌才能上传图片', 'warn'); this.toggleSettings(); return; }
    for (const file of files) {
      if (!/^image\//.test(file.type)) continue;
      try {
        this.toast(`上传 ${file.name} …`);
        const dataUrl = await readAsDataURL(file);
        const base64 = String(dataUrl).split(',')[1];
        const safe = file.name.replace(/[^\w.\-]+/g, '_');
        const rel = `assets/${safe}`;
        const a = await gh.getFile(`content/${rel}`);
        await gh.putBinary(`content/${rel}`, base64, `assets: 上传 ${safe}`, a ? a.sha : null);
        const b = await gh.getFile(`docs/${rel}`);
        await gh.putBinary(`docs/${rel}`, base64, `assets: 同步 ${safe}`, b ? b.sha : null);
        if (this.mode === 'rich') {
          this.rich$.focus();
          execCommand('insertHTML', `<figure class="md-figure"><img src="${rel}" alt="${file.name.replace(/\.[^.]+$/, '')}"></figure><p><br></p>`);
        } else {
          const md = `\n![${file.name.replace(/\.[^.]+$/, '')}](${rel})\n`;
          const ta = this.body$;
          const s = ta.selectionStart;
          ta.value = ta.value.slice(0, s) + md + ta.value.slice(ta.selectionEnd);
          this.body = ta.value;
        }
        this.markDirty();
        this.schedulePreview();
        this.toast(`已插入：${rel}`, 'ok');
      } catch (e) {
        this.toast(`上传失败：${e.message}`, 'error');
      }
    }
    this.host.querySelector('#edFile').value = '';
  }

  /* ---------- 保存 ---------- */
  renderFullMarkdown(slug) {
    const fm = serializeMeta({
      title: this.meta.title.trim() || '未命名笔记',
      slug,
      category: this.meta.category.trim() || '未分类',
      tags: this.meta.tags,
      date: this.meta.date || new Date().toISOString().slice(0, 10),
      pinned: this.meta.pinned,
      summary: this.meta.summary,
    });
    let bodyMd = this.syncFromRich();
    if (!/^#\s/.test(bodyMd.trim())) bodyMd = `# ${this.meta.title.trim() || '未命名笔记'}\n\n${bodyMd}`;
    return fm + bodyMd.trimEnd() + '\n';
  }

  async save() {
    if (this.busy) return;
    this.syncFromRich();
    if (!gh.configured()) { this.toggleSettings(); this.toast('先填写 GitHub 令牌，再保存发布', 'warn'); return; }

    const isNew = this.isNew;
    const known = isNew ? null : this.bySlug.get(this.slug);
    const fileName = isNew ? slugForFile(this.meta.title || `note-${Date.now()}`) : noteSourceOf(known);
    if (!fileName) { this.toast('文件名解析失败，取消保存', 'error'); return; }
    const slug = isNew ? fileName.replace(/\.md$/, '') : (known && known.slug) || fileName.replace(/\.md$/, '');
    const markdown = this.renderFullMarkdown(slug);
    const source = `content/${fileName}`;

    this.busy = true;
    const btn = this.host.querySelector('#edSave');
    const oldLabel = btn.textContent;
    btn.textContent = '发布中…';
    btn.disabled = true;
    try {
      const exist = await gh.getFile(source);
      if (!isNew && exist && known && exist.text !== known.rawFull) {
        const go = confirm('远端这篇笔记已经变过（可能你在别处改过）。\n\n点「确定」用当前内容覆盖，点「取消」先取消保存。');
        if (!go) throw new Error('已取消（远端有更新）');
      }
      await gh.putFile(source, markdown, `${isNew ? 'notes: 新建' : 'notes: 编辑'} ${this.meta.title}`, exist ? exist.sha : null);

      this.toast('正在重建全站索引…');
      const rebuilt = this.o.rebuildIndex({ source, slug, raw: markdown, attachments: known ? known.attachments || [] : [] });
      const idx = await gh.getFile('docs/data/index.json');
      await gh.putFile('docs/data/index.json', rebuilt, `build: 重新生成索引（${this.meta.title}）`, idx ? idx.sha : null);

      draft.clear(this.slug);
      this.toast(isNew ? '已发布！约 1 分钟后线上可见' : '已保存并发布 ✓', 'ok');
      this.dirty = false;
      if (this.dirty$) { this.dirty$.textContent = '已发布'; this.dirty$.classList.remove('on'); }
      this.o.onSaved && this.o.onSaved(slug, { isNew, fileName });
    } catch (e) {
      this.toast(`保存失败：${e.message}`, 'error');
      draft.save(this.slug, { meta: this.meta, body: this.syncFromRich(), isNew: this.isNew });
      this.toast('草稿已存本机浏览器，刷新也不会丢', 'warn');
    } finally {
      this.busy = false;
      btn.textContent = oldLabel;
      btn.disabled = false;
    }
  }

  revert() {
    const note = this.bySlug.get(this.slug);
    if (note) {
      this.body = note.raw || '';
      this.meta = {
        title: note.title, category: note.category, tags: (note.tags || []).join(', '),
        date: note.date, pinned: !!note.pinned, summary: note.summary || '',
      };
    } else this.body = '';
    draft.clear(this.slug);
    this.render();
    this.toast('已放弃改动');
  }

  async remove() {
    const note = this.bySlug.get(this.slug);
    if (!note) return;
    if (!gh.configured()) { this.toast('先填 GitHub 令牌', 'warn'); return; }
    if (!confirm(`确定删除《${note.title}》？\n\n会删除仓库里的 ${note.source}。`)) return;
    try {
      const f = await gh.getFile(note.source);
      await gh.call(`/repos/${gh.owner()}/${gh.repo()}/contents/${gh.path(note.source)}`, {
        method: 'DELETE',
        body: { message: `notes: 删除 ${note.title}`, sha: f ? f.sha : undefined, branch: gh.branch() },
      });
      this.toast('已删除，约 1 分钟后从线上消失', 'ok');
      this.close();
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      this.toast(`删除失败：${e.message}`, 'error');
    }
  }
}

/* ============================ 标注（手写）保存 ============================ */
export const ink = {
  pathFor(slug) { return `content/ink/${slug}.json`; },

  async load(slug) {
    const f = await gh.getFile(ink.pathFor(slug));
    if (!f) return { strokes: [], sha: null };
    try {
      const j = JSON.parse(f.text);
      return { strokes: Array.isArray(j.strokes) ? j.strokes : [], sha: f.sha };
    } catch (e) {
      return { strokes: [], sha: f.sha };
    }
  },

  async save(slug, strokes) {
    const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), strokes }, null, 1);
    const exist = await gh.getFile(ink.pathFor(slug));
    await gh.putFile(ink.pathFor(slug), payload, `ink: 更新「${slug}」的手写标注（${strokes.length} 笔）`, exist ? exist.sha : null);
    // 同时写一份到 docs/ink/，让线上立刻可用
    const docExist = await gh.getFile(`docs/ink/${slug}.json`);
    await gh.putFile(`docs/ink/${slug}.json`, payload, `ink: 同步「${slug}」标注`, docExist ? docExist.sha : null);
  },
};

/* ============================ 工具函数 ============================ */
export function noteSourceOf(note) {
  if (!note) return '';
  if (note.source) return note.source.replace(/^content\//, '');
  return `${note.slug}.md`;
}

export function slugForFile(title) {
  const s = String(title).trim().toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${s || 'note-' + Date.now().toString(36)}.md`;
}

export function serializeMeta(fields) {
  const lines = ['---'];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) { if (v.length) lines.push(`${k}: [${v.map((x) => String(x).trim()).filter(Boolean).join(', ')}]`); }
    else lines.push(`${k}: ${v}`);
  };
  push('title', fields.title);
  if (fields.slug) push('slug', fields.slug);
  push('category', fields.category || '未分类');
  push('tags', Array.isArray(fields.tags) ? fields.tags : String(fields.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean));
  push('date', fields.date);
  if (fields.pinned === true || fields.pinned === 'true') push('pinned', 'true');
  push('summary', fields.summary);
  lines.push('---', '');
  return lines.join('\n');
}

function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escHtml(s) {
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
