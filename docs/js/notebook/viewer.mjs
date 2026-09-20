/**
 * GoodNotes 模式 · 笔记本页面视图（viewer.mjs）
 *
 * 职责：把「一页页纸 + 手写内容」变成像手账 App 一样的整本阅读/编辑界面。
 *   · 页面栈：每一页一张静态画布（renderPage 渲染，与导出/打印所见即所得）
 *   · 编辑器：一个「活画布」覆盖在当前页上（PageEditor），滚到哪页就搬到哪页
 *   · 顶部工具条：返回 / 标题 / 页码 / 撤销重做 / 页面 / 大纲 / 学习集 / 录音 / 演示 / 导出 / 更多
 *   · 左侧缩略图栏：跳页 + 单页菜单（复制/删除/上下移/书签/纸张）+ 加页；手机上收成抽屉
 *   · 底部 GoodNotes 工具面板：11 个工具 + 各自的属性面板（笔/荧光笔/橡皮/套索/形状/文本/
 *     贴纸/胶带/尺子/缩放窗）+ 视口缩放 + 状态条
 *   · 覆盖层面板：页面管理 / 大纲 / 学习集（闪卡）/ 录音（与手写时间点同步）/ 纸张设置
 *   · 演示模式：全屏、只留页面与激光笔、方向键或滑动翻页
 *   · 导出：PDF / 当前页 PNG / 本本 JSON / 打印
 *
 * 约定：
 *   1. 模块加载期不碰 DOM（document / window / navigator 只在方法里用），Node 可直接 import
 *   2. 所有交互走 root 上的事件委托（data-act / data-tool / data-x / data-z）
 *   3. 所有可见文字为中文；不引外部库、不发网络请求（录音用 getUserMedia 除外）
 */
import { NotebookStore } from './store.mjs';
import {
  PageEditor, renderPage, PEN_TYPES, TOOLS, ERASER_MODES, HIGHLIGHTER_COLORS,
  TAPE_COLORS, ELEMENTS, FONTS, TEXT_SIZE_STEPS, findHitRects,
} from './page.mjs';
import {
  PAPER_TEMPLATES, templateGroups, PAPER_SIZES, paperDims, PAPER_COLORS, renderCover,
} from './paper.mjs';
import { PALETTE, WIDTHS, ERASER_SIZES, SHAPE_KINDS } from '../ink.mjs';
import { buildPdf, downloadBlob, pageToPng, summarizeText, qualityOf, PDF_QUALITY, notebookToMarkdown, markdownSlug, markdownTarget, outlinesFromNotebook, buildLongImage, tocEntries, pdfPageCount, buildEpub, buildSingleHtml } from './study.mjs';
import {
  ASR_MODELS, transcribeAudio, transcribeAudioFull, transcribeChunked, parseAsrSegments, anchorSegments, getAsrKey, setAsrKey,
} from './asr.mjs';
import { makeSpeaker, pageSpeakText, splitSpeakSentences } from './tts.mjs';
import { applyEdit } from '../../lib/site-build.mjs';
import {
  OCR_MODELS, getOcrKey, setOcrKey, hasOcrKey, ocrNotebook, ocrOnePage, ocrSummary, progressText, OCR_ENDPOINT, ocrImageDataUrl,
  pageOcrState, planOcrQueue,
} from './ocr.mjs';
import { pushNotebook, pullNotebook, pushAll, fetchPublicIndex, pullFromPublicSite, PUBLIC_INDEX } from './sync.mjs';
import { gh } from '../editor.mjs';

/* ============================ 小工具（纯函数，加载期不碰 DOM） ============================ */

const HAS_DOM = () => typeof document !== 'undefined';

const q = (el, sel) => (el && el.querySelector ? el.querySelector(sel) : null);
const qa = (el, sel) => (el && el.querySelectorAll ? Array.from(el.querySelectorAll(sel)) : []);

function nbEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 把命中的关键词标出来（先转义再包 <mark>，避免注入） */
function nbMark(text, query) {
  const t = nbEsc(text);
  const qq = String(query == null ? '' : query).trim();
  if (!qq) return t;
  const esc = nbEsc(qq).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return t.replace(new RegExp(esc, 'gi'), (m) => `<mark>${m}</mark>`); } catch (e) { return t; }
}

/** 文件名安全化（导出用） */
function safeName(s, fallback = '笔记本') {
  const t = String(s == null ? '' : s).replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim();
  return t || fallback;
}

/** 秒 → mm:ss */
function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 深拷贝（store 与编辑器都按普通对象工作，这里只要分离引用） */
function nbClone(v) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch (e) { /* 含不可克隆值 → 退回 JSON */ }
  }
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}

const TOOL_META = [
  { id: 'pen', label: '画笔', glyph: '🖊' },
  { id: 'highlighter', label: '荧光笔', glyph: '🖍' },
  { id: 'eraser', label: '橡皮', glyph: '🧽' },
  { id: 'lasso', label: '套索', glyph: '🔗' },
  { id: 'shape', label: '形状', glyph: '🔷' },
  { id: 'text', label: '文本', glyph: '🅣' },
  { id: 'image', label: '图片', glyph: '🖼' },
  { id: 'sticker', label: '贴纸', glyph: '⭐' },
  { id: 'tape', label: '胶带', glyph: '🎀' },
  { id: 'laser', label: '激光笔', glyph: '🔴' },
  { id: 'ruler', label: '尺子', glyph: '📏' },
];

/* ============================ 主类 ============================ */

export class NotebookView {
  /**
   * @param {object} o
   *   o.root      HTMLElement 渲染容器（app.js 传 #bookBody）
   *   o.store     NotebookStore
   *   o.toast     (msg) => void
   *   o.onExit    () => void
   *   o.onChanged () => void
   */
  constructor(o = {}) {
    this.root = o.root || null;
    this.store = o.store || new NotebookStore();
    this.toast = typeof o.toast === 'function' ? o.toast : () => {};
    this.onExit = typeof o.onExit === 'function' ? o.onExit : () => {};
    this.onChanged = typeof o.onChanged === 'function' ? o.onChanged : () => {};

    this.bookId = '';
    this.nb = null;
    this.cur = 0;
    this.opened = false;
    this.presenting = false;

    this.editor = null;
    this.editCanvas = null;
    this.tool = 'pen';
    this.status = {};
    this.toolsOpen = false;

    this.panelKind = '';       // pages / outline / study / audio / paper / ocr
    this.ocrModel = OCR_MODELS[0].id;
    this.ocrRunning = false;
    this.ocrStatusText = '';
    this.ocrBoxes = true;       // 识别时顺带要行位置（PDF 文字层更准）
    this.bookQuery = '';        // 本笔记本内搜索的关键词
    this.pdfQuality = 'high';   // standard / high / print
    this.dropTape = false;      // 导出时是否撕掉胶带
    this.textLayer = true;      // 导出 PDF 是否带可搜索文字层
    this.pdfToc = true;         // 导出 PDF 是否自动插一页目录
    this.plainPaper = false;    // 阅读版：导出时去格线
    this.searchIndex = 0;       // 笔记本内搜索当前高亮的命中
    this.speaker = null;        // 朗读器（浏览器 TTS）
    this.speak = { sentences: [], index: -1 };
    this.chunkAsr = true;       // 长录音是否分片转写
    this.asrChunkSeconds = 120;
    this.thumbMenu = -1;
    this.zoom = { on: false, fit: false };

    this.study = { queue: [], idx: 0, flipped: false, today: 0 };
    this.audio = { recording: false, startedAt: 0, timer: 0, audioEl: null, playingId: '', url: '' };

    this._io = null;
    this._onKey = (e) => this.handleKey(e);
    this._built = false;

    if (!HAS_DOM()) return;
    this._buildShell();
    // 刷新时保存当前页（离开页面/切后台也能落盘）
    this._onBeforeUnload = () => this.flush();
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('beforeunload', this._onBeforeUnload);
    if (document.addEventListener) document.addEventListener('keydown', this._onKey);
  }

  /* ====================================================================
     一、外壳与事件委托
     ==================================================================== */

  _buildShell() {
    const root = this.root;
    if (!root) return;
    const paper = this.themePaper;
    root.innerHTML = `
<div class="nb-wrap" id="nbWrap">
  <header class="nb-top">
    <button class="nb-btn ghost nb-back" type="button" data-act="back" title="返回资料库">← 返回</button>
    <div class="nb-titlewrap">
      <h2 class="nb-title" data-act="title" title="点击改标题">笔记本</h2>
      <input class="nb-title-input" type="text" maxlength="60" hidden>
    </div>
    <span class="nb-count">- / -</span>
    <span class="nb-spacer"></span>
    <button class="nb-btn icon" type="button" data-act="undo" title="撤销（Ctrl+Z）" disabled>↶</button>
    <button class="nb-btn icon" type="button" data-act="redo" title="重做（Ctrl+Shift+Z）" disabled>↷</button>
    <button class="nb-btn" type="button" data-act="thumbs" title="页面缩略图栏">☰</button>
    <button class="nb-btn" type="button" data-act="panel" data-panel="pages">页面</button>
    <button class="nb-btn" type="button" data-act="panel" data-panel="outline">大纲</button>
    <button class="nb-btn" type="button" data-act="panel" data-panel="study">学习集</button>
    <button class="nb-btn icon" type="button" data-act="panel" data-panel="search" title="本笔记本内搜索（含手写识别）">🔎</button>
    <button class="nb-btn icon" type="button" data-act="panel" data-panel="audio" title="录音">🎙</button>
    <button class="nb-btn" type="button" data-act="present">演示</button>
    <div class="nb-drop">
      <button class="nb-btn" type="button" data-act="menu" data-menu="export">导出 ▾</button>
      <div class="nb-menu" data-menu="export" hidden>
        <button type="button" data-act="exportPdf" data-note="standard" title="文件小，屏幕看够用">导出 PDF · 标准（96dpi）</button>
        <button type="button" data-act="exportPdf" data-note="high" title="打印清晰，体积约 4 倍">导出 PDF · 高清（192dpi）</button>
        <button type="button" data-act="exportPdf" data-note="print" title="放大看细节、正式打印，体积约 9 倍">导出 PDF · 打印级（288dpi）</button>
        <hr>
        <button type="button" data-act="exportPng">导出当前页 PNG（2×）</button>
        <button type="button" data-act="exportLong">导出长图（整本拼一张 PNG）</button>
        <button type="button" data-act="exportMd">导出 Markdown（.md）</button>
        <button type="button" data-act="exportEpub">导出 EPUB（电子书）</button>
        <button type="button" data-act="exportHtml">导出单文件 HTML</button>
        <button type="button" data-act="exportJson">导出此笔记本 JSON</button>
        <button type="button" data-act="toggleDropTape">导出时撕掉胶带</button>
        <button type="button" data-act="toggleTextLayer">PDF 可搜索文字层</button>
        <button type="button" data-act="toggleToc">PDF 自动目录页</button>
        <button type="button" data-act="togglePlain">阅读版（去格线，省墨）</button>
        <hr>
        <button type="button" data-act="print">打印</button>
      </div>
    </div>
    <div class="nb-drop">
      <button class="nb-btn" type="button" data-act="menu" data-menu="more">更多 ▾</button>
      <div class="nb-menu" data-menu="more" hidden>
        <button type="button" data-act="panel" data-panel="paper">改纸张 / 尺寸</button>
        <button type="button" data-act="panel" data-panel="ocr">识别手写文字（OCR）…</button>
        <button type="button" data-act="syncPush">同步到仓库（推送）</button>
        <button type="button" data-act="syncPull">从仓库拉取这本</button>
        <hr>
        <button type="button" data-act="scrollToggle">切换竖排 / 横排滚动</button>
        <button type="button" data-act="saveTemplate">另存为模板</button>
        <button type="button" data-act="publishMd">把 Markdown 发到仓库（进全站检索）</button>
        <button type="button" data-act="penDoubleTapCycle">手写笔双击：切换动作</button>
        <button type="button" data-act="summary">总结当前页文字</button>
        <hr>
        <button type="button" data-act="clearPage">清空此页</button>
        <button type="button" data-act="deleteBook">删除这本笔记本</button>
      </div>
    </div>
  </header>

  <div class="nb-main">
    <aside class="nb-thumbs" id="nbThumbs">
      <div class="nb-thumbs-head">
        <b>页面</b>
        <span class="nb-thumb-total">0</span>
        <button class="nb-btn ghost icon" type="button" data-act="thumbsClose" title="收起">✕</button>
      </div>
      <div class="nb-thumblist" id="nbThumbList"></div>
      <div class="nb-thumbs-foot">
        <button class="nb-btn" type="button" data-act="addPage">＋ 加一页</button>
        <button class="nb-btn" type="button" data-act="addPages5">＋ 加 5 页</button>
      </div>
    </aside>

    <section class="nb-body" id="nbBody">
      <div class="nb-column${paper.horizontal ? ' nb-hz' : ''}" id="nbColumn">
        <div class="nb-lane" id="nbLane"></div>
      </div>
      <button class="nb-nav prev" type="button" data-act="prev" title="上一页">‹</button>
      <button class="nb-nav next" type="button" data-act="next" title="下一页">›</button>
    </section>

    <div class="nb-mask" id="nbMask" hidden>
      <div class="nb-panel" id="nbPanel" role="dialog" aria-modal="true"></div>
    </div>

    <div class="nb-toolbar" id="nbToolbar">
      <div class="nb-props" id="nbProps" hidden></div>
      <div class="nb-tools" id="nbTools">
        <div class="nb-tools-row" data-role="tools">
          ${TOOL_META.map((t) => `<button class="nb-tool" type="button" data-tool="${t.id}"${['sticker', 'tape', 'laser', 'ruler'].includes(t.id) ? ' data-more="1"' : ''} title="${nbEsc(t.label)}">
            <span class="nb-tool-glyph">${t.glyph}</span><span class="nb-tool-label">${nbEsc(t.label)}</span>
          </button>`).join('')}
          <button class="nb-tool nb-tool-more" type="button" data-act="toolsMore" title="更多工具">⋯</button>
        </div>
        <div class="nb-tools-row nb-tools-side">
          <button class="nb-btn icon" type="button" data-act="zoomToggle" title="放大窗">🔍</button>
          <span class="nb-zoom">
            <button class="nb-btn icon" type="button" data-act="fitWidth" title="适应宽度">↔</button>
            <button class="nb-btn" type="button" data-act="zoom100" title="100%">100%</button>
            <button class="nb-btn icon" type="button" data-act="zoomOut" title="缩小">－</button>
            <button class="nb-btn icon" type="button" data-act="zoomIn" title="放大">＋</button>
          </span>
          <span class="nb-status" id="nbStatus">对象 0 · 选中 0 · 可撤销 0 步</span>
        </div>
      </div>
    </div>
    <div class="nb-hint" id="nbHint" hidden><span>← →</span> 翻页 · <span>Esc</span> 退出演示</div>
    <input class="nb-file" type="file" accept="image/*" hidden>
  </div>
</div>`;

    this.wrap = q(root, '.nb-wrap') || root;
    this.column = q(root, '#nbColumn');
    this.lane = q(root, '#nbLane');
    this.titleEl = q(root, '.nb-title');
    this.titleInput = q(root, '.nb-title-input');
    this.countEl = q(root, '.nb-count');
    this.statusEl = q(root, '#nbStatus');
    this.thumbsEl = q(root, '.nb-thumbs');
    this.thumbList = q(root, '#nbThumbList');
    this.propsEl = q(root, '#nbProps');
    this.toolsEl = q(root, '#nbTools');
    this.maskEl = q(root, '#nbMask');
    this.panelEl = q(root, '#nbPanel');
    this.hintEl = q(root, '#nbHint');
    this._built = true;

    // 一次委托：点击 / 输入 / 拖动，全部走这里（render/refresh 可重复调用而不重挂监听）
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onInput(e));
    root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.bindLongPressTools();   // 长按画笔/荧光笔 → 循环笔型
    if (this.titleInput) {
      this.titleInput.addEventListener('blur', () => this.commitTitle());
      this.titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault && e.preventDefault(); this.commitTitle(); }
        if (e.key === 'Escape') this.cancelTitle();
      });
    }
    const file = q(root, '.nb-file');
    if (file) {
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        file.value = '';
        if (!f || !this.editor) return;
        try {
          await this.editor.insertImageFile(f);
          this.setStatus(this.editor.info());
          this.scheduleThumbUpdate();
          try { this.onChanged(); } catch (e) {}
        } catch (err) {
          this.toast('插入图片失败：' + ((err && err.message) || '未知错误'));
        }
      });
    }
    const col = this.column;
    if (col && col.addEventListener) col.addEventListener('scroll', () => this.onScroll(), { passive: true });
  }

  /** 委托入口：按钮/菜单 */
  onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const insideProps = t.closest('.nb-props');

    // 顶部菜单
    const menuBtn = t.closest('[data-act="menu"]');
    if (menuBtn) { this.toggleMenu(menuBtn.dataset.menu); return; }

    // 面板内与工具条内的动作
    const actEl = t.closest('[data-act]');
    const act = actEl ? actEl.dataset.act : '';

    // 工具选择
    const toolBtn = t.closest('[data-tool]');
    if (toolBtn) {
      this.setTool(toolBtn.dataset.tool);
      this.closeMenus();
      return;
    }

    if (act) {
      // 属性面板里除了「工具选择」以外的动作都带回属性（data-x / data-z）
      const x = actEl.dataset.x;
      const z = actEl.dataset.z;
      const note = actEl.dataset.note;
      const handled = this.handleAction(act, { actEl, x, z, note, insideProps });
      if (handled) { if (!insideProps) this.closeMenus(); return; }
    }

    // 页面空白处 → 切换当前页
    const pane = t.closest('.nb-page');
    if (pane && t.closest('.nb-column')) {
      const idx = Number(pane.dataset.page);
      if (Number.isFinite(idx)) { if (idx !== this.cur) this.gotoPage(idx, false); else this.closeMenus(); }
    }
  }

  /** 委托入口：滑块 / 下拉 / 颜色 / 勾选 */
  onInput(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    // OCR 密钥：失焦或回车时存下来
    const ocrKeyEl = t.closest('[data-act="ocrKey"]');
    if (ocrKeyEl) { setOcrKey(null, ocrKeyEl.value); return; }
    const el = t.closest('[data-x]');
    if (!el) return;
    const key = el.dataset.x;
    const v = el.type === 'checkbox' ? !!el.checked : el.value;

    if (key === 'title') { return; }
    if (key === 'customColor') {
      const ed0 = this.editor;
      if (ed0 && String(v || '').trim()) { this.applyColor(String(v)); this.lightProps(); this.setStatus(ed0.info()); }
      return;
    }
    if (key === 'audioTitle') { this.audioTitle = v; return; }
    if (key === 'cardFront' || key === 'cardBack') { this.cardDraft = this.cardDraft || {}; this.cardDraft[key === 'cardFront' ? 'front' : 'back'] = v; return; }

    if (key === 'panelTemplate') { this._pendingPaper = { ...(this._pendingPaper || {}), template: v }; return; }
    if (key === 'panelColor') { this._pendingPaper = { ...(this._pendingPaper || {}), color: v }; return; }
    if (key === 'panelSize') {
      this._pendingPaper = { ...(this._pendingPaper || {}), size: v };
      const box = q(this.panelEl, '.nb-paper-custom');
      if (box) box.hidden = v !== 'custom';
      return;
    }
    if (key === 'panelW' || key === 'panelH') {
      this._pendingPaper = { ...(this._pendingPaper || {}), [key === 'panelW' ? 'width' : 'height']: Number(v) || 0 };
      return;
    }
    if (key === 'pagePaper') {
      const idx = Number(el.dataset.page);
      this.applyPagePaper(idx, { template: v });
      return;
    }
    if (key === 'stroke') {
      const arr = this.strokeData;
      this._strokeOverlay = { arr, n: Math.max(0, Math.min(arr.length, Math.round(Number(v) || 0))) };
      return;
    }
    if (key === 'trim') { this._trimN = Math.max(0, Math.min(12, Math.round(Number(v) || 0))); return; }
    if (key === 'bookQuery') {
      this.bookQuery = String(v || '');
      this.renderBookSearch();
      return;
    }

    if (!this.editor) return;
    const ed = this.editor;
    if (key === 'opacity') { ed.setOpacity(Number(v) / 100); this.setStatus(ed.info()); return; }
    if (key === 'eraserSize') { ed.setEraserSize(v); this.setStatus(ed.info()); return; }
    if (key === 'textSize') { ed.setTextStyle({ size: v }); this.setStatus(ed.info()); return; }
    if (key === 'shapeFill') { ed.setShapeFill(!!v); this.setStatus(ed.info()); return; }
    if (key === 'strokeW') { this.strokeW = Math.max(0.6, Math.min(3.5, Number(v) || 1)); this.strokeText(); return; }
  }

  /** 委托入口：点页面空白处就切当前页 */
  onPointerDown(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.nb-edit') || t.closest('.nb-panel') || t.closest('.nb-tools')) return;
    const pane = t.closest('.nb-page');
    if (!pane) return;
    const idx = Number(pane.dataset.page);
    if (Number.isFinite(idx) && idx !== this.cur) this.gotoPage(idx, false);
  }

  /** 所有 data-act 的落点 */
  handleAction(act, ctx = {}) {
    const { actEl, x, z, note, insideProps } = ctx;
    const ed = () => this.editor;

    // ---- 顶部 / 通用 ----
    if (act === 'back') { this.flush(); this.onExit(); return true; }
    if (act === 'title') { this.beginTitle(); return true; }
    if (act === 'undo') { const e = ed(); if (e) { e.undo(); this.setStatus(e.info()); } return true; }
    if (act === 'redo') { const e = ed(); if (e) { e.redo(); this.setStatus(e.info()); } return true; }
    if (act === 'present') { this.present(true); return true; }
    if (act === 'panel') { this.openPanel(actEl.dataset.panel); return true; }
    if (act === 'thumbs') { if (this.thumbsEl) this.thumbsEl.classList.toggle('open'); return true; }
    if (act === 'thumbsClose') { if (this.thumbsEl) this.thumbsEl.classList.remove('open'); return true; }
    if (act === 'prev') { this.gotoPage(this.cur - 1); return true; }
    if (act === 'next') { this.gotoPage(this.cur + 1); return true; }
    if (act === 'scrollToggle') {
      this.store.update(this.bookId, { scroll: this.nb.scroll === 'horizontal' ? 'vertical' : 'horizontal' });
      this.renderShellMode();
      this.toast(this.nb.scroll === 'horizontal' ? '已切换为横排翻页' : '已切换为竖排滚动');
      return true;
    }
    if (act === 'summary') { this.summaryToPage(); return true; }
    if (act === 'cropImage') {
      const e = ed();
      if (e) { e.setTool('lasso'); e.beginCrop(); this.setStatus(e.info()); }
      return true;
    }
    if (act === 'penDoubleTapCycle') {
      const e = ed();
      if (!e) return true;
      const order = ['eraser', 'pen', 'highlighter', 'cycle', 'off'];
      const next = order[(order.indexOf(e.penDoubleTap || 'eraser') + 1) % order.length];
      e.setPenDoubleTap(next);
      return true;
    }
    if (act === 'toolsMore') {
      this.toolsMore = !this.toolsMore;
      const row = q(this.root, '[data-role="tools"]');
      if (row) row.classList.toggle('more-open', !!this.toolsMore);
      this.toast(this.toolsMore ? '已展开更多工具（贴纸 / 胶带 / 激光笔 / 尺子）' : '收起更多工具');
      return true;
    }
    if (act === 'exportLong') { this.exportLongImage(); return true; }
    if (act === 'ocrSelection') { this.recognizeSelection(); return true; }
    if (act === 'gotoHit') {
      const idx = Number(actEl.dataset.page);
      const query = String(this.bookQuery || '').trim();
      if (Number.isFinite(idx)) {
        this.gotoPage(idx);
        this.closePanel();
        const page = (this.nb.pages || [])[idx];
        const rects = page ? findHitRects(page, query) : [];
        if (rects.length && this.editor) this.editor.flashRects(rects);
        if (rects.length) this.toast(`已定位到第 ${idx + 1} 页的 ${rects.length} 处命中（黄框标出）`);
      }
      return true;
    }
    if (act === 'syncPush') { this.syncPush(); return true; }
    if (act === 'syncPull') { this.syncPull(); return true; }
    if (act === 'exportMd') { this.exportMarkdown(); return true; }
    if (act === 'exportEpub') { this.exportEpub(); return true; }
    if (act === 'exportHtml') { this.exportHtml(); return true; }
    if (act === 'publishMd') { this.publishMarkdown(); return true; }
    if (act === 'saveTemplate') { this.saveAsTemplate(); return true; }
    if (act === 'ocrModel') { this.ocrModel = note; this.renderPanel(); return true; }
    if (act === 'ocrBoxes') {
      this.ocrBoxes = this.ocrBoxes === false;
      this.toast(this.ocrBoxes ? '识别时会给出行位置（PDF 里选中更准）' : '只识别文字，不要位置（更快、更省）');
      this.renderPanel();
      return true;
    }
    if (act === 'ocrRun') { this.runOcr({}); return true; }
    if (act === 'ocrRunPage') { this.runOcr({ indices: [this.cur] }); return true; }
    if (act === 'ocrRunAll') { this.runOcr({ all: true, indices: (this.nb.pages || []).map((_, i) => i) }); return true; }
    if (act === 'ocrRunFailed') {
      const plan = planOcrQueue([this.nb], { retryFailed: true });
      const idx = plan.items.filter((i) => i.state === 'failed').map((i) => i.pageIndex);
      if (!idx.length) { this.toast('没有失败的页'); return true; }
      this.runOcr({ indices: idx });
      return true;
    }
    if (act === 'ocrClearPage') {
      this.store.clearPageOcr(this.bookId, this.nb.pages[this.cur].id);
      this.toast('已清掉本页的识别结果');
      this.renderPanel();
      return true;
    }
    if (act === 'ocrToText') { this.ocrToText(); return true; }
    if (act === 'ocrReplace') {
      const ed = this.editor;
      if (ed) {
        const res = ed.replaceInkWithText();
        if (res) { this.setStatus(ed.info()); this.refresh(); }
      }
      return true;
    }
    if (act === 'clearPage') {
      const e = ed();
      if (!e) return true;
      if (typeof window !== 'undefined' && !window.confirm('清空当前页的所有内容？（可撤销）')) return true;
      e.snapshot('清空此页');
      e.items = [];
      e.selection.clear();
      e.commit('清空此页');
      e.redraw();
      this.setStatus(e.info());
      this.refresh();
      return true;
    }
    if (act === 'deleteBook') { this.deleteBook(); return true; }

    // ---- 导出 ----
    if (act === 'exportPdf') { this.exportPdf(note || 'high'); return true; }
    if (act === 'exportPng') { this.exportPng(); return true; }
    if (act === 'toggleDropTape') {
      this.dropTape = !this.dropTape;
      this.toast(this.dropTape ? '导出 PDF 时会撕掉胶带（看答案用）' : '导出 PDF 时保留胶带');
      return true;
    }
    if (act === 'toggleTextLayer') {
      this.textLayer = this.textLayer === false ? true : false;
      this.toast(this.textLayer === false
        ? '导出 PDF 不带文字层（体积更小，但不能搜、不能选）'
        : '导出 PDF 带可搜索文字层（打字内容 + 已 OCR 的手写，Ctrl+F 能搜）');
      return true;
    }
    if (act === 'toggleToc') {
      this.pdfToc = this.pdfToc === false ? true : false;
      this.toast(this.pdfToc === false ? '导出 PDF 不再自动加目录页' : '导出 PDF 会在最前面插一页自动目录（条目可点）');
      return true;
    }
    if (act === 'togglePlain') {
      this.plainPaper = !this.plainPaper;
      this.toast(this.plainPaper ? '阅读版：导出 PDF 时去掉格线/横线（省墨）' : '恢复正常纸张：导出 PDF 带格线');
      return true;
    }
    if (act === 'exportJson') {
      try {
        const json = this.store.exportJSON([this.bookId]);
        downloadBlob(new Blob([json], { type: 'application/json' }), `${safeName(this.nb.title)}.json`);
        this.toast('已导出笔记本 JSON');
      } catch (err) { this.toast('导出失败：' + (err && err.message ? err.message : '未知错误')); }
      return true;
    }
    if (act === 'print') { this.doPrint(); return true; }

    // ---- 缩略图栏 ----
    if (act === 'addPage') { this.addPages(1); return true; }
    if (act === 'addPages5') { this.addPages(5); return true; }
    if (act === 'thumb') {
      const idx = Number(actEl.dataset.page);
      this.closeThumbMenu();
      this.gotoPage(idx);
      if (this.thumbsEl && typeof window !== 'undefined' && window.innerWidth <= 860) this.thumbsEl.classList.remove('open');
      return true;
    }
    if (act === 'thumbMenu') {
      this.toggleThumbMenu(Number(actEl.dataset.page), actEl);
      return true;
    }
    if (act === 'thumbAct') {
      const idx = Number(actEl.dataset.page);
      this.closeThumbMenu();
      this.pageAction(note, idx);
      return true;
    }

    // ---- 面板 ----
    if (act === 'panelClose') { this.closePanel(); return true; }
    if (act === 'panelAddPage') { this.addPages(1); this.openPanel('pages'); return true; }
    if (act === 'panelAddPages5') { this.addPages(5); this.openPanel('pages'); return true; }
    if (act === 'panelPageAct') { this.pageAction(note, Number(actEl.dataset.page)); this.openPanel('pages'); return true; }
    if (act === 'applyPaper') { this.applyNotebookPaper(); return true; }

    // ---- 大纲 ----
    if (act === 'outlineGo') { this.gotoPage(Number(actEl.dataset.page)); return true; }
    if (act === 'setPageTitle') {
      const v = (q(this.panelEl, '[data-x="pageTitle"]') || {}).value || '';
      this.store.setPageTitle(this.bookId, this.nb.pages[this.cur].id, v);
      this.touchChanged();
      this.openPanel('outline');
      this.toast('本页标题已保存');
      return true;
    }
    if (act === 'clearPageTitle') {
      this.store.setPageTitle(this.bookId, this.nb.pages[this.cur].id, '');
      this.touchChanged();
      this.openPanel('outline');
      return true;
    }

    // ---- 学习集 ----
    if (act === 'studyFlip') { this.study.flipped = !this.study.flipped; this.renderStudyCard(); return true; }
    if (act === 'studyRemember') { this.answerCard(true); return true; }
    if (act === 'studyForget') { this.answerCard(false); return true; }
    if (act === 'cardsFromText') { this.cardsFromText(); return true; }
    if (act === 'cardsFromSummary') { this.cardsFromSummary(); return true; }
    if (act === 'cardAdd') { this.addCardManual(); return true; }
    if (act === 'cardDelete') {
      this.store.removeCard(this.bookId, actEl.dataset.id);
      this.refresh();
      this.openPanel('study');
      return true;
    }

    // ---- 录音 ----
    if (act === 'audioRecord') { this.recordToggle(); return true; }
    if (act === 'audioPlay') { this.audioPlay(actEl.dataset.id); return true; }
    if (act === 'audioStop') { this.audioStop(); return true; }
    if (act === 'audioDelete') { this.audioDelete(actEl.dataset.id); return true; }
    if (act === 'audioTranscribe') { this.audioTranscribe(actEl.dataset.id); return true; }
    if (act === 'speakPage') { this.speakPage(); return true; }
    if (act === 'stopSpeak') { if (this.speaker) this.speaker.stop(); this.speak = { sentences: [], index: -1 }; this.renderPanel(); return true; }
    if (act === 'speakJump') { this.speakFrom(Number(actEl.dataset.seg) || 0); return true; }
    if (act === 'audioSegGo') {
      const idx = Number(actEl.dataset.page);
      if (Number.isFinite(idx)) this.gotoPage(idx);
      return true;
    }
    if (act === 'audioTextClear') {
      this.store.clearAudioText(this.bookId, actEl.dataset.id);
      this.toast('已清掉这段录音的转写');
      this.renderPanel();
      return true;
    }
    if (act === 'audioGoPage') { this.gotoPage(Number(actEl.dataset.page)); this.closePanel(); return true; }

    // ---- 纸张设置 ----
    if (act === 'presetPaper') { this.presetPaper(actEl.dataset.id); return true; }

    // ---- 工具属性：笔 ----
    if (act === 'penType') { const e = ed(); if (e) { e.setPenType(note); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'color') { const e = ed(); if (e) { this.applyColor(note); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'width') { const e = ed(); if (e) { e.setWidth(note); this.lightProps(); this.setStatus(e.info()); } return true; }

    // ---- 橡皮 ----
    if (act === 'eraserMode') { const e = ed(); if (e) { e.setEraserMode(note); this.lightProps(); this.setStatus(e.info()); } return true; }

    // ---- 套索 ----
    if (act === 'lassoMode') {
      const e = ed();
      if (e) { e.setRectSelect(note === 'rect'); this.lightProps(); }
      return true;
    }
    if (act === 'lassoOp') {
      const e = ed();
      if (!e) return true;
      if (note === 'copy') e.copy();
      else if (note === 'paste') e.paste();
      else if (note === 'duplicate') e.duplicate();
      else if (note === 'delete') e.deleteSelection();
      else if (note === 'front') e.zOrder('front');
      else if (note === 'back') e.zOrder('back');
      else if (note === 'peel') e.peelTape();
      this.setStatus(e.info());
      this.refreshThumbs();
      return true;
    }
    if (act === 'selColor') {
      const e = ed();
      if (e) { e.applyStyle({ color: note }); this.setStatus(e.info()); }
      return true;
    }

    // ---- 形状 ----
    if (act === 'shapeKind') { const e = ed(); if (e) { e.setShapeKind(note); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'shapeFill') { const e = ed(); if (e) { e.setShapeFill(!e.shapeFill); this.lightProps(); this.setStatus(e.info()); } return true; }

    // ---- 文本 ----
    if (act === 'textFont') { const e = ed(); if (e) { e.setTextStyle({ font: note }); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'textBold') { const e = ed(); if (e) { e.setTextStyle({ bold: !e.textStyle.bold }); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'textItalic') { const e = ed(); if (e) { e.setTextStyle({ italic: !e.textStyle.italic }); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'textAlign') { const e = ed(); if (e) { e.setTextStyle({ align: note }); this.lightProps(); this.setStatus(e.info()); } return true; }

    // ---- 贴纸 / 图片 ----
    if (act === 'insertSticker') {
      const e = ed();
      if (e) { e.insertSticker(note); this.setStatus(e.info()); this.refreshThumbs(); }
      return true;
    }
    if (act === 'pickImage') {
      const f = q(this.root, '.nb-file');
      if (f) f.click();
      return true;
    }

    // ---- 胶带 ----
    if (act === 'tapeColor') {
      const e = ed();
      if (e) { e.setTapeColor(note); this.lightProps(); this.setStatus(e.info()); }
      return true;
    }

    // ---- 尺子 ----
    if (act === 'rulerToggle') { const e = ed(); if (e) { e.toggleRuler(); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'rulerRotate') {
      const e = ed();
      if (e) {
        if (z === 'reset') e.ruler.angle = 0;
        else e.rotateRuler(z === '45' ? Math.PI / 4 : (z === 'l' ? -15 : 15) * Math.PI / 180);
        e.redraw();
        this.setStatus(e.info());
      }
      return true;
    }

    // ---- 缩放窗 / 视口 ----
    if (act === 'zoomToggle') { const e = ed(); if (e) { e.toggleZoom(); this.lightProps(); this.setStatus(e.info()); } return true; }
    if (act === 'fitWidth') { this.fitWidth(); return true; }
    if (act === 'zoom100') { this.setViewScale(1); return true; }
    if (act === 'zoomIn') { const e = ed(); if (e) { e.setViewScale((e.view.scale || 1) * 1.15); this.setStatus(e.info()); } return true; }
    if (act === 'zoomOut') { const e = ed(); if (e) { e.setViewScale((e.view.scale || 1) / 1.15); this.setStatus(e.info()); } return true; }

    // ---- 演示模式条 ----
    if (act === 'presentExit') { this.present(false); return true; }
    if (act === 'presentLaser') {
      const e = ed();
      if (!e) return true;
      const on = e.tool !== 'laser';
      e.setTool(on ? 'laser' : 'pen');
      this.tool = e.tool;
      this.lightTools();
      if (actEl && actEl.classList) actEl.classList.toggle('on', on);
      return true;
    }
    return false;
  }

  /* ====================================================================
     二、打开 / 关闭 / 刷新
     ==================================================================== */

  open(bookId) {
    if (!HAS_DOM() || !this.root) return false;
    const nb = this.store.get(bookId);
    if (!nb) { this.toast('这本笔记本不存在'); return false; }
    if (this.opened && this.bookId !== bookId) this.close();

    this.bookId = bookId;
    this.nb = nb;
    this.cur = 0;
    this.opened = true;
    if (!this._built) this._buildShell();
    if (this.wrap) this.wrap.hidden = false;

    try { this.store.open(bookId); } catch (e) {}
    this.renderShellMode();
    this.renderAll();
    this.buildEditor();
    this.observePages();
    this.onScroll();
    return true;
  }

  /** 退出前把当前页写回 store，销毁编辑器与监听 */
  close() {
    this.flush();
    this.disposeEditor();
    this.disconnectObserver();
    this.audioStop();
    this.stopPresent();
    if (this.wrap) this.wrap.hidden = true;
    this.closePanel();
    this.opened = false;
    return true;
  }

  /** 重绘缩略图 / 大纲 / 状态（不重建编辑器） */
  refresh() {
    if (!this.opened) return;
    const fresh = this.store.get(this.bookId);
    if (fresh) this.nb = fresh;
    this.renderTop();
    this.renderThumbs();
    if (this.panelKind) this.renderPanel();
    if (this.editor) this.setStatus(this.editor.info());
  }

  /** 只重绘缩略图（内容变了之后） */
  refreshThumbs() {
    if (!this.opened) return;
    const fresh = this.store.get(this.bookId);
    if (fresh) this.nb = fresh;
    this.renderThumbs();
    this.renderTop();
  }

  /** 统一的内容变化出口：落盘失败要提示备份 */
  touchChanged() {
    try {
      this.store.save();
    } catch (err) {
      this.toast((err && err.message) || '保存失败：存储空间不足，建议先「导出此笔记本 JSON」备份');
    }
    try { this.onChanged(); } catch (e) {}
    this.renderTop();
    this.renderThumbs();
  }

  destroy() {
    this.flush();
    this.disposeEditor();
    this.disconnectObserver();
    this.audioStop();
    this.stopPresent();
    if (HAS_DOM() && typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('beforeunload', this._onBeforeUnload);
    if (HAS_DOM() && document.removeEventListener) document.removeEventListener('keydown', this._onKey);
    if (this.root) this.root.innerHTML = '';
    this._built = false;
    this.opened = false;
  }

  /* ====================================================================
     三、页面栈
     ==================================================================== */

  paperOf(i) {
    const nb = this.nb;
    if (!nb) return null;
    const p = nb.pages[i];
    return (p && p.paper) || nb.paper || null;
  }

  /** 探测站点主题（深色模式下白纸要渲染成深色纸，免得白得刺眼） */
  get themePaper() {
    let dark = false;
    try {
      if (typeof window !== 'undefined' && window.matchMedia) dark = !!window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset) {
        const t = String(document.documentElement.dataset.theme || '');
        if (t === 'dark' || t === 'night') dark = true;
        if (t === 'light' || t === 'day') dark = false;
      }
    } catch (e) { dark = false; }
    const horizontal = !!(this.nb && this.nb.scroll === 'horizontal');
    return { dark, horizontal, bodyDark: dark && this.darkBody() };
  }

  /** 页面容器背景是否跟随深色（浅色站点仍然用浅底衬纸张） */
  darkBody() {
    try {
      if (typeof getComputedStyle !== 'function' || !this.root) return false;
      const v = getComputedStyle(this.root).getPropertyValue('--bg');
      const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '').trim());
      if (!m) return false;
      const n = parseInt(m[1], 16);
      const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      return lum < 0.5;
    } catch (e) { return false; }
  }

  /** 实际用于渲染/编辑的纸张（深色主题下把纯白纸换成深色纸） */
  paperFor(i) {
    const p = this.paperOf(i) || {};
    const meta = this.themePaper;
    const color = String(p.color || '#FFFFFF').toUpperCase();
    const out = { ...p };
    if (meta.dark && (!p.color || color === '#FFFFFF')) out.color = '#22252B';
    return out;
  }

  renderShellMode() {
    const meta = this.themePaper;
    if (this.column) this.column.classList.toggle('nb-hz', meta.horizontal);
    if (this.wrap) {
      this.wrap.classList.toggle('nb-horizontal', meta.horizontal);
      this.wrap.classList.toggle('nb-dark', meta.bodyDark);
    }
    const ink = meta.bodyDark ? '#F2EDE6' : '#2B2723';
    if (this.wrap && this.wrap.style) this.wrap.style.setProperty('--nb-paper-ink', ink);
  }

  /** 重建整条页面栈（只在打开 / 增删页之后调用） */
  renderAll() {
    if (!this.lane || !this.nb) return;
    this.renderShellMode();
    this.lane.innerHTML = '';
    const pages = this.nb.pages || [];
    for (let i = 0; i < pages.length; i++) {
      const d = paperDims(this.paperFor(i));
      const pane = document.createElement('div');
      pane.className = 'nb-page';
      pane.dataset.page = String(i);
      pane.dataset.pageId = pages[i].id;
      pane.style.width = `${d.w}px`;
      pane.style.height = `${d.h}px`;
      const st = document.createElement('canvas');
      st.className = 'nb-static';
      pane.appendChild(st);
      this.lane.appendChild(pane);
    }
    this.drawStatics();
    this.renderTop();
    this.renderThumbs();
  }

  /** 画所有静态页面（滚到哪画到哪；其余留占位，省内存） */
  drawStatics(force = false) {
    const panes = qa(this.lane, '.nb-page');
    if (!panes.length) return;
    const win = this.scrollViewport();
    panes.forEach((pane, i) => {
      const st = q(pane, '.nb-static');
      if (!st) return;
      if (!force) {
        if (Math.abs(i - this.cur) > 3) return;
        if (!this.nearViewport(pane, win, 3)) return;
        if (st.dataset.drawn === '1') return;
      }
      this.drawStaticPane(i, st);
    });
  }

  drawStaticPane(i, canvas) {
    const page = this.nb && this.nb.pages[i];
    if (!page || !canvas) return;
    try {
      renderPage(canvas, { paper: this.paperFor(i), items: page.items || [], scale: 1, dpr: 1 });
      canvas.dataset.drawn = '1';
    } catch (e) {
      this.toast('这一页画不出来：' + ((e && e.message) || '未知错误'));
    }
  }

  /** 滚动视口（竖排 = 页面列；横排 = 横排轨道） */
  scrollViewport() {
    if (this.column && this.column.clientHeight) {
      const r = this.column.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
    }
    return { top: -1e7, bottom: 1e7, left: -1e7, right: 1e7, height: 2e7, width: 2e7 };
  }

  nearViewport(pane, win, spans = 2) {
    const r = pane.getBoundingClientRect();
    const margin = ((win.height || 800) * spans) / 2;
    return r.bottom > win.top - margin && r.top < win.bottom + margin;
  }

  ensureLoaded(i) {
    const pane = qa(this.lane, '.nb-page')[i];
    if (!pane) return;
    const st = q(pane, '.nb-static');
    if (st && st.dataset.drawn !== '1') this.drawStaticPane(i, st);
  }

  /** 跳到第 i 页（滚动到位 + 把编辑器搬过去） */
  gotoPage(i, scroll = true) {
    if (!this.opened || !this.nb) return false;
    const n = this.nb.pages.length;
    const idx = Math.max(0, Math.min(n - 1, Math.round(Number(i) || 0)));
    if (idx === this.cur && this.editor && this.editor.pageId === this.nb.pages[idx].id) {
      if (scroll) this.scrollToPage(idx);
      this.setStatus(this.editor.info());
      return true;
    }
    // 先把上一页写回 store，再切页（编辑器 setPage 会重新取内容）
    if (this.editor) { try { this.editor.persist(); } catch (e) {} }
    this.cur = idx;
    if (this.editor) {
      this.moveEditor(idx);
      this.editor.setPage(idx);
      this.setStatus(this.editor.info());
    }
    this.markCurPage();
    if (scroll) this.scrollToPage(idx);
    this.ensureLoaded(idx);
    if (this.thumbList) qa(this.thumbList, '.nb-thumb').forEach((el, k) => el.classList.toggle('on', k === idx));
    this.updatePresentCount();
    return true;
  }

  scrollToPage(i) {
    const pane = qa(this.lane, '.nb-page')[i];
    if (!pane || !this.column) return;
    const cont = this.column;
    const pr = pane.getBoundingClientRect();
    const cr = cont.getBoundingClientRect();
    if (this.nb && this.nb.scroll === 'horizontal') {
      const left = cont.scrollLeft + (pr.left - cr.left) - (cr.width - pr.width) / 2;
      this.smoothScrollTo(cont, left, cont.scrollTop);
    } else {
      const top = cont.scrollTop + (pr.top - cr.top) - 12;
      this.smoothScrollTo(cont, cont.scrollLeft, top);
    }
  }

  smoothScrollTo(el, left, top) {
    if (!el) return;
    const scrollMethod = typeof el.scrollTo === 'function' ? el.scrollTo : null;
    const reduce = (() => {
      try { return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    })();
    const smooth = reduce || typeof scrollMethod !== 'function' ? 'auto' : 'smooth';
    try {
      if (scrollMethod) el.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: smooth });
      else { el.scrollLeft = Math.max(0, left); el.scrollTop = Math.max(0, top); }
    } catch (e) {
      el.scrollLeft = Math.max(0, left);
      el.scrollTop = Math.max(0, top);
    }
  }

  onScroll() {
    if (!this.opened || this._scrollLock) return;
    const panes = qa(this.lane, '.nb-page');
    if (!panes.length || !this.column) return;
    const cr = this.column.getBoundingClientRect();
    const horizontal = !!(this.nb && this.nb.scroll === 'horizontal');
    let best = this.cur, bestD = Infinity;
    panes.forEach((pane, i) => {
      const r = pane.getBoundingClientRect();
      const d = horizontal
        ? Math.abs((r.left + r.width / 2) - (cr.left + cr.width / 2))
        : (Math.abs(r.top - (cr.top + 12)) * 0.9);
      if (d < bestD) { bestD = d; best = i; }
    });
    // 只有滚了差不多半页才切，免得来回跳
    const cur = panes[this.cur];
    if (best !== this.cur && cur) {
      const r = cur.getBoundingClientRect();
      const moved = horizontal ? Math.abs(r.left - cr.left) : Math.abs(r.top - cr.top);
      const span = horizontal ? (r.width || 1) : (r.height || 1);
      if (moved < span * 0.5) { this.drawStatics(); return; }
    }
    this.drawStatics();
    if (best !== this.cur) this.gotoPage(best, false);
  }

  markCurPage() {
    const panes = qa(this.lane, '.nb-page');
    panes.forEach((p, i) => p.classList.toggle('on', i === this.cur));
  }

  /* ====================================================================
     四、编辑器（一个活画布，跟着当前页走）
     ==================================================================== */

  buildEditor() {
    this.disposeEditor();
    if (!this.lane || !this.nb) return;
    const pane = qa(this.lane, '.nb-page')[this.cur];
    if (!pane) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'nb-edit';
    pane.appendChild(canvas);
    this.editCanvas = canvas;
    this._pointerTool = '';
    canvas.addEventListener('pointerdown', () => {
      if (!this.editor) return;
      this._pointerTool = this.editor.tool;
      canvas.dataset.drawing = '1';
    });
    const clearFlag = () => { canvas.dataset.drawing = '0'; };
    canvas.addEventListener('pointerup', clearFlag);
    canvas.addEventListener('pointercancel', clearFlag);
    canvas.addEventListener('pointerleave', clearFlag);

    this.editor = new PageEditor({
      canvas,
      host: pane,
      getPage: (i) => this.pageInfo(i),
      setItems: (pageId, items) => {
        try { this.store.setItems(this.bookId, pageId, items); } catch (e) { this.toast('内容写入失败：' + ((e && e.message) || '未知错误')); }
        try { this.onChanged(); } catch (e) {}
        this.scheduleThumbUpdate();
      },
      onStatus: (info) => {
        this.setStatus(info);
        if (this._pointerTool && info.tool !== this._pointerTool) this.propsFor(info.tool);
      },
      onToast: (m) => this.toast(m),
      onDirty: () => { try { this.onChanged(); } catch (e) {} this.scheduleThumbUpdate(); },
      onGotoPage: (i) => this.gotoPage(i),
    });
    this.moveEditor(this.cur);
    this.editor.setPage(this.cur);
    this.tool = this.editor.tool;
    this.lightTools();
    this.propsFor(this.tool);
    this.setStatus(this.editor.info());
    this.fitWidth(true);
  }

  /** 编辑器页面信息（paper 用主题修正后的，保证画布与静态页一致） */
  pageInfo(i) {
    const idx = Number.isFinite(i) ? i : this.cur;
    const nb = this.nb || { pages: [] };
    const p = nb.pages[idx] || { id: '', items: [] };
    return { pageId: p.id, pageIndex: idx, paper: this.paperFor(idx), items: p.items || [], ocr: p.ocr || null };
  }

  /** 把活画布（含放大窗）搬到第 i 页容器里 */
  moveEditor(i) {
    const c = this.editCanvas;
    if (!c) return;
    const pane = qa(this.lane, '.nb-page')[i];
    if (!pane) return;
    if (c.parentElement !== pane) {
      try { pane.appendChild(c); } catch (e) { return; }
    }
    if (this.editor) {
      const band = this.editor.zoomBand;
      if (band && band.parentElement !== pane) {
        try { pane.appendChild(band); } catch (e) {}
      }
      this.editor.host = pane;
    }
    this.markCurPage();
    this.scheduleFit();
  }

  disposeEditor() {
    if (this.editor) { try { this.editor.destroy(); } catch (e) {} this.editor = null; }
    if (this.editCanvas && this.editCanvas.parentElement) {
      try { this.editCanvas.parentElement.removeChild(this.editCanvas); } catch (e) {}
    }
    this.editCanvas = null;
    this._pointerTool = '';
  }

  /** 当前页写回（退出/切换前调用） */
  flush() {
    if (!this.editor) return false;
    try {
      if (this.editor.editing) this.editor.endTextEdit(true);
      return this.editor.persist();
    } catch (e) { return false; }
  }

  scheduleThumbUpdate() {
    if (this._thumbT) return;
    const fn = () => { this._thumbT = 0; this.updateThumbCanvas(this.cur); };
    this._thumbT = (typeof setTimeout === 'function' ? setTimeout(fn, 220) : 0);
  }

  /* ====================================================================
     五、顶部工具条
     ==================================================================== */

  renderTop() {
    const nb = this.nb;
    if (!nb) return;
    if (this.titleEl) this.titleEl.textContent = nb.title || '未命名笔记本';
    if (this.countEl) this.countEl.textContent = `${this.cur + 1} / ${nb.pages.length}`;
    const undo = q(this.root, '[data-act="undo"]');
    const redo = q(this.root, '[data-act="redo"]');
    const info = this.editor ? this.editor.info() : { canUndo: false, canRedo: false };
    if (undo) undo.disabled = !info.canUndo;
    if (redo) redo.disabled = !info.canRedo;
    const total = q(this.root, '.nb-thumb-total');
    if (total) total.textContent = String(nb.pages.length);
  }

  beginTitle() {
    if (!this.titleInput || !this.titleEl) return;
    this.titleInput.value = (this.nb && this.nb.title) || '';
    this.titleEl.hidden = true;
    this.titleInput.hidden = false;
    try { this.titleInput.focus(); this.titleInput.select(); } catch (e) {}
  }

  commitTitle(revert = true) {
    if (!this.titleInput || this.titleInput.hidden) return false;
    const v = String(this.titleInput.value || '').trim();
    this.titleInput.hidden = true;
    if (this.titleEl) this.titleEl.hidden = false;
    if (!v && revert) return false;
    try {
      this.store.update(this.bookId, { title: v });
      this.toast('标题已保存');
    } catch (e) { this.toast('标题保存失败：' + ((e && e.message) || '未知错误')); }
    this.renderTop();
    try { this.onChanged(); } catch (e) {}
    return true;
  }

  cancelTitle() {
    if (!this.titleInput) return;
    this.titleInput.hidden = true;
    if (this.titleEl) this.titleEl.hidden = false;
  }

  toggleMenu(name) {
    if (!name) return;
    qa(this.root, '.nb-menu').forEach((m) => { m.hidden = m.dataset.menu !== name || !m.hidden; });
  }

  closeMenus() { qa(this.root, '.nb-menu').forEach((m) => { m.hidden = true; }); }

  /* ====================================================================
     六、左侧缩略图栏
     ==================================================================== */

  renderThumbs() {
    if (!this.thumbList || !this.nb) return;
    const pages = this.nb.pages || [];
    const bits = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      bits.push(`<div class="nb-thumb${i === this.cur ? ' on' : ''}" data-act="thumb" data-page="${i}" title="第 ${i + 1} 页">
        <canvas class="nb-thumb-canvas" width="1" height="1"></canvas>
        <span class="nb-thumb-no">${i + 1}</span>
        ${p.bookmarked ? '<span class="nb-thumb-mark">🔖</span>' : ''}
        ${p.title ? '<span class="nb-thumb-title">' + nbEsc(p.title) + '</span>' : ''}
        <button class="nb-thumb-more" type="button" data-act="thumbMenu" data-page="${i}" title="这一页的菜单">⋯</button>
      </div>`);
    }
    if (!pages.length) bits.push('<div class="nb-empty"><div class="big">📄</div>还没有页面</div>');
    this.thumbList.innerHTML = bits.join('');
    this.repaintThumbs();
  }

  repaintThumbs() {
    const pages = (this.nb && this.nb.pages) || [];
    qa(this.thumbList, '.nb-thumb').forEach((el, i) => {
      const c = q(el, '.nb-thumb-canvas');
      if (c) this.paintThumb(c, i);
    });
    if (!pages.length) return;
  }

  paintThumb(canvas, i) {
    const page = this.nb && this.nb.pages[i];
    if (!canvas || !page) return;
    const d = paperDims(this.paperFor(i));
    const scale = 0.16;
    try {
      renderPage(canvas, { paper: this.paperFor(i), items: page.items || [], scale, dpr: 1 });
      canvas.style.width = `${Math.round(d.w * scale)}px`;
      canvas.style.height = `${Math.round(d.h * scale)}px`;
    } catch (e) { /* 缩略图失败不影响主流程 */ }
  }

  updateThumbCanvas(i) {
    const el = qa(this.thumbList, '.nb-thumb')[i];
    if (!el) return;
    // 当前页的内容以编辑器为准（store 里可能刚写回，也可能还没写）
    const c = q(el, '.nb-thumb-canvas');
    if (!c) return;
    const page = this.nb.pages[i];
    const items = (this.editor && this.editor.pageIndex === i) ? this.editor.items : (page ? page.items : []);
    try {
      renderPage(c, { paper: this.paperFor(i), items: items || [], scale: 0.16, dpr: 1 });
    } catch (e) {}
  }

  toggleThumbMenu(i, anchor) {
    this.closeThumbMenu();
    const el = anchor || qa(this.thumbList, '.nb-thumb-more')[i];
    if (!el || !el.parentElement) return;
    this.thumbMenu = i;
    const page = this.nb.pages[i];
    const menu = document.createElement('div');
    menu.className = 'nb-menu nb-thumb-menu';
    menu.innerHTML = `
      <button type="button" data-act="thumbAct" data-note="dup" data-page="${i}">复制此页</button>
      <button type="button" data-act="thumbAct" data-note="up" data-page="${i}">上移</button>
      <button type="button" data-act="thumbAct" data-note="down" data-page="${i}">下移</button>
      <button type="button" data-act="thumbAct" data-note="bookmark" data-page="${i}">${page && page.bookmarked ? '取消书签' : '设书签'}</button>
      <hr>
      <label class="nb-thumb-paper">这一页纸张
        <select data-x="pagePaper" data-page="${i}">
          ${PAPER_TEMPLATES.map((t) => `<option value="${t.id}"${page && page.paper && page.paper.template === t.id ? ' selected' : ''}>${nbEsc(t.label)}</option>`).join('')}
        </select>
      </label>
      <button type="button" data-act="thumbAct" data-note="follow" data-page="${i}">恢复跟随笔记本纸张</button>
      <hr>
      <button type="button" class="danger" data-act="thumbAct" data-note="del" data-page="${i}">删除此页</button>`;
    el.parentElement.appendChild(menu);
  }

  closeThumbMenu() {
    this.thumbMenu = -1;
    qa(this.thumbList, '.nb-thumb-menu').forEach((m) => { try { m.remove(); } catch (e) {} });
  }

  pageAction(note, i) {
    const nb = this.nb;
    if (!nb || !Number.isFinite(i) || !nb.pages[i]) return;
    const p = nb.pages[i];
    try {
      if (note === 'dup') {
        this.store.duplicatePage(this.bookId, p.id);
        this.toast(`已复制第 ${i + 1} 页`);
        this.afterPageListChange(i + 1);
      } else if (note === 'del') {
        if (nb.pages.length <= 1) { this.toast('最后一页不能删'); return; }
        if (typeof window !== 'undefined' && !window.confirm(`删除第 ${i + 1} 页？`)) return;
        this.store.removePage(this.bookId, p.id);
        this.toast(`已删除第 ${i + 1} 页`);
        this.afterPageListChange(Math.max(0, i - 1));
      } else if (note === 'up') {
        if (i <= 0) { this.toast('已经是第一页了'); return; }
        this.store.movePage(this.bookId, i, i - 1);
        this.afterPageListChange(i - 1);
      } else if (note === 'down') {
        if (i >= nb.pages.length - 1) { this.toast('已经是最后一页了'); return; }
        this.store.movePage(this.bookId, i, i + 1);
        this.afterPageListChange(i + 1);
      } else if (note === 'bookmark') {
        this.store.toggleBookmark(this.bookId, p.id);
        this.toast(p.bookmarked ? `已取消第 ${i + 1} 页书签` : `第 ${i + 1} 页已加书签`);
        this.touchChanged();
      } else if (note === 'follow') {
        this.store.clearPagePaper(this.bookId, p.id);
        this.touchChanged();
        this.rebuildAll();
      }
    } catch (err) {
      this.toast('操作失败：' + ((err && err.message) || '未知错误'));
    }
  }

  applyPagePaper(i, patch) {
    const p = this.nb && this.nb.pages[i];
    if (!p) return;
    try {
      this.store.setPagePaper(this.bookId, p.id, patch);
      this.touchChanged();
      this.rebuildAll();
      this.toast(`第 ${i + 1} 页纸张已改`);
    } catch (e) { this.toast('改纸张失败：' + ((e && e.message) || '未知错误')); }
  }

  addPages(count) {
    if (!this.nb) return;
    try {
      // 在「当前页」之后插入（store 默认插在最后一页之后，count>1 时再统一挪到当前页后面）
      const made = this.store.addPage(this.bookId, { afterPageId: this.nb.pages[this.cur] ? this.nb.pages[this.cur].id : '', count });
      this.toast(`已加 ${made.length} 页`);
      this.afterPageListChange(this.cur + 1);
    } catch (e) { this.toast('加页失败：' + ((e && e.message) || '未知错误')); }
  }

  /** 页面增删/排序之后：重建页面栈并跳到目标页 */
  afterPageListChange(target) {
    this.touchChanged();
    const from = this.cur;
    this.flush();
    this.disposeEditor();
    this.renderAll();
    this.cur = Math.max(0, Math.min(this.nb.pages.length - 1, Number(target) || 0));
    this.buildEditor();
    this.observePages();
    this.gotoPage(this.cur, true);
    if (this.panelKind === 'pages') this.renderPanel();
    void from;
  }

  rebuildAll() {
    this.flush();
    this.disposeEditor();
    this.renderAll();
    this.buildEditor();
    this.observePages();
    this.gotoPage(this.cur, false);
  }

  /* ====================================================================
     七、工具条与属性面板
     ==================================================================== */

  setTool(tool) {
    if (!this.editor || !TOOLS.includes(tool)) return;
    this.editor.setTool(tool);
    this.tool = tool;
    this.lightTools();
    this.propsFor(tool);
    if (tool === 'image') {
      const f = q(this.root, '.nb-file');
      if (f) f.click();
    }
    this.setStatus(this.editor.info());
  }

  lightTools() {
    const cur = this.editor ? this.editor.tool : this.tool;
    qa(this.root, '[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === cur));
  }

  /** 按当前工具渲染工具条上方的属性面板 */
  propsFor(tool) {
    if (!this.propsEl) return;
    const ed = this.editor;
    if (ed) this.tool = ed.tool;
    const t = ed ? ed.tool : tool;
    let html = '';
    if (t === 'pen' || t === 'highlighter') html = this.markupPen(t);
    else if (t === 'eraser') html = this.markupEraser();
    else if (t === 'lasso') html = this.markupLasso();
    else if (t === 'shape') html = this.markupShape();
    else if (t === 'text') html = this.markupText();
    else if (t === 'sticker') html = this.markupSticker();
    else if (t === 'tape') html = this.markupTape();
    else if (t === 'ruler') html = this.markupRuler();
    else if (t === 'image') html = this.markupImage();
    else html = `<div class="nb-prop-empty">${nbEsc((TOOL_META.find((m) => m.id === t) || {}).label || '工具')}：直接在上方页面上操作</div>`;
    this.propsEl.innerHTML = html;
    this.propsEl.hidden = !html;
    this.lightProps();
  }

  lightProps() {
    const ed = this.editor;
    if (!ed || !this.propsEl) return;
    const on = (sel, cond) => qa(this.propsEl, sel).forEach((b) => b.classList.toggle('on', !!cond(b.dataset)));
    on('[data-act="penType"]', (d) => d.note === ed.penType);
    on('[data-act="width"]', (d) => d.note === ed.width.id);
    on('[data-act="eraserMode"]', (d) => d.note === ed.eraserMode);
    on('[data-act="shapeKind"]', (d) => d.note === ed.shapeKind);
    on('[data-act="textFont"]', (d) => d.note === ed.textStyle.font);
    on('[data-act="textSize"]', (d) => d.note === ed.textStyle.size);
    on('[data-act="textAlign"]', (d) => d.note === ed.textStyle.align);
    on('[data-act="textBold"]', () => ed.textStyle.bold);
    on('[data-act="textItalic"]', () => ed.textStyle.italic);
    on('[data-act="lassoMode"]', (d) => (d.note === 'rect') === !!ed.rectSelect);
    on('[data-act="rulerToggle"]', () => ed.ruler.on);
    on('[data-act="zoomToggle"]', () => ed.zoom.on);
    on('[data-act="shapeFill"]', () => ed.shapeFill);
    // 颜色选中态
    const colors = qa(this.propsEl, '[data-act="color"]');
    colors.forEach((b) => {
      const v = b.dataset.note;
      const isHl = ed.tool === 'highlighter';
      const same = isHl ? String(ed.highlightColor) === String(v) : String(ed.color) === String(v);
      b.classList.toggle('on', same);
    });
    const tapes = qa(this.propsEl, '[data-act="tapeColor"]');
    tapes.forEach((b) => b.classList.toggle('on', String(ed.tapeColor) === String(b.dataset.note)));
  }

  applyColor(v) {
    const ed = this.editor;
    if (!ed || !v) return;
    if (ed.tool === 'highlighter') ed.setHighlightColor(v);
    else ed.setColor(v);
  }

  markupPen(tool) {
    const ed = this.editor;
    const isHl = tool === 'highlighter';
    const colors = isHl ? HIGHLIGHTER_COLORS : PALETTE;
    const curVal = isHl ? ed.highlightColor : ed.color;
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">笔型</span>
        <div class="nb-prop-row">
          ${PEN_TYPES.map((p) => `<button class="nb-chip" type="button" data-act="penType" data-note="${p.id}" title="${nbEsc(p.label)}">
            <span class="nb-chip-glyph">${p.glyph}</span>${nbEsc(p.label)}</button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">颜色</span>
        <div class="nb-colors">
          ${colors.map((c) => `<button class="nb-swatch" type="button" data-act="color" data-note="${nbEsc(c.pen)}" title="${nbEsc(c.label)}" style="--c:${nbEsc(c.pen)}"></button>`).join('')}
          <input class="nb-swatch-input" type="color" data-x="customColor" value="${nbEsc(curVal && curVal[0] === '#' ? curVal : (isHl ? '#FFE050' : '#2B2723'))}" title="自定义颜色">
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">粗细</span>
        <div class="nb-widths">
          ${WIDTHS.map((w) => `<button class="nb-width" type="button" data-act="width" data-note="${w.id}" title="${nbEsc(w.label)}">
            <span class="nb-width-dot" style="width:${Math.max(3, Math.round(w.pen * 1400))}px;height:${Math.max(3, Math.round(w.pen * 1400))}px"></span>
            ${nbEsc(w.label)}</button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group grow">
        <span class="nb-prop-label">不透明度 <b class="nb-op-val">${Math.round((ed.opacity == null ? 1 : ed.opacity) * 100)}%</b></span>
        <input class="nb-range" type="range" min="5" max="100" step="1" value="${Math.round((ed.opacity == null ? 1 : ed.opacity) * 100)}" data-x="opacity">
      </div>`;
  }

  markupEraser() {
    const ed = this.editor;
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">擦除方式</span>
        <div class="nb-prop-row">
          ${ERASER_MODES.map((m) => `<button class="nb-chip" type="button" data-act="eraserMode" data-note="${m.id}" title="${nbEsc(m.hint)}">${nbEsc(m.label)}</button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">橡皮大小</span>
        <div class="nb-seg">
          ${ERASER_SIZES.map((s) => `<button type="button" data-act="eraserSize" data-note="${s.id}" class="${ed.eraserSize && ed.eraserSize.id === s.id ? 'on' : ''}">${nbEsc(s.label)}</button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group grow"><span class="nb-hint">「仅荧光笔」只擦掉荧光笔画的，字迹留着</span></div>`;
  }

  markupLasso() {
    const ed = this.editor;
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">选择方式</span>
        <div class="nb-prop-row">
          <button class="nb-chip" type="button" data-act="lassoMode" data-note="free">自由圈选</button>
          <button class="nb-chip" type="button" data-act="lassoMode" data-note="rect">矩形选择</button>
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">选中后</span>
        <div class="nb-prop-row">
          <button class="nb-btn" type="button" data-act="lassoOp" data-note="copy">复制</button>
          <button class="nb-btn" type="button" data-act="lassoOp" data-note="paste">粘贴</button>
          <button class="nb-btn" type="button" data-act="lassoOp" data-note="duplicate">再制</button>
          <button class="nb-btn danger" type="button" data-act="lassoOp" data-note="delete">删除</button>
          <button class="nb-btn" type="button" data-act="lassoOp" data-note="front">置顶</button>
          <button class="nb-btn" type="button" data-act="lassoOp" data-note="back">置底</button>
          <button class="nb-btn" type="button" data-act="cropImage">裁剪图片</button>
          <button class="nb-btn" type="button" data-act="ocrSelection" title="只识别圈中的这一块手写，并落成文本框">识别选区</button>
          <button class="nb-btn" type="button" data-act="lassoOp" data-note="peel">撕胶带</button>
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">改色</span>
        <div class="nb-colors">
          ${PALETTE.map((c) => `<button class="nb-swatch" type="button" data-act="selColor" data-note="${nbEsc(c.pen)}" title="${nbEsc(c.label)}" style="--c:${nbEsc(c.pen)}"></button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group grow"><span class="nb-hint">选中 ${ed.selection.size} 个对象 · 拖动移动 / 角点缩放 / 圆点旋转</span></div>`;
  }

  markupShape() {
    const ed = this.editor;
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">形状</span>
        <div class="nb-prop-row">
          <select class="nb-select nb-shape-select" data-x="shapeKind">
            ${SHAPE_KINDS.map((s) => `<option value="${s.id}"${ed.shapeKind === s.id ? ' selected' : ''}>${nbEsc(s.glyph)} ${nbEsc(s.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">填充</span>
        <button class="nb-chip" type="button" data-act="shapeFill">${ed.shapeFill ? '已填充' : '不填充'}</button>
      </div>
      <div class="nb-prop-group grow"><span class="nb-hint">「自动」会把你画的图形识别成直线 / 矩形 / 椭圆 / 三角</span></div>`;
  }

  markupText() {
    const ed = this.editor;
    const st = ed.textStyle;
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">字体</span>
        <div class="nb-prop-row">
          ${FONTS.map((f) => `<button class="nb-chip" type="button" data-act="textFont" data-note="${f.id}" style="font-family:${nbEsc(f.css)}">${nbEsc(f.label)}</button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">字号</span>
        <div class="nb-prop-row">
          ${TEXT_SIZE_STEPS.map((s) => `<button class="nb-chip" type="button" data-act="textSize" data-note="${s.id}">${nbEsc(s.label)}</button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">样式</span>
        <div class="nb-prop-row">
          <button class="nb-chip nb-bold" type="button" data-act="textBold">粗体</button>
          <button class="nb-chip nb-italic" type="button" data-act="textItalic">斜体</button>
        </div>
      </div>
      <div class="nb-prop-group">
        <span class="nb-prop-label">对齐</span>
        <div class="nb-seg">
          <button type="button" data-act="textAlign" data-note="left">左</button>
          <button type="button" data-act="textAlign" data-note="center">中</button>
          <button type="button" data-act="textAlign" data-note="right">右</button>
        </div>
      </div>
      <div class="nb-prop-group grow">
        <span class="nb-prop-label">颜色</span>
        <div class="nb-colors">
          ${PALETTE.map((c) => `<button class="nb-swatch" type="button" data-act="color" data-note="${nbEsc(c.pen)}" title="${nbEsc(c.label)}" style="--c:${nbEsc(c.pen)}"></button>`).join('')}
        </div>
      </div>`;
  }

  markupSticker() {
    return `
      <div class="nb-stickers">
        ${ELEMENTS.map((g) => `<div class="nb-sticker-group">
          <span class="nb-prop-label">${nbEsc(g.group)}</span>
          <div class="nb-sticker-grid">
            ${g.items.map((it) => `<button class="nb-sticker" type="button" data-act="insertSticker" data-note="${nbEsc(it)}" title="插入 ${nbEsc(it)}">${it}</button>`).join('')}
          </div>
        </div>`).join('')}
      </div>`;
  }

  markupTape() {
    const ed = this.editor;
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">胶带颜色</span>
        <div class="nb-colors">
          ${TAPE_COLORS.map((c) => `<button class="nb-swatch" type="button" data-act="tapeColor" data-note="${nbEsc(c.value)}" title="${nbEsc(c.label)}" style="--c:${nbEsc(c.value)}"></button>`).join('')}
        </div>
      </div>
      <div class="nb-prop-group grow"><span class="nb-hint">在页面上拖一条 → 贴出一条胶带（可以盖住内容，也能用套索撕掉）</span></div>`;
  }

  markupRuler() {
    const ed = this.editor;
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">尺子</span>
        <div class="nb-prop-row">
          <button class="nb-chip" type="button" data-act="rulerToggle">${ed.ruler.on ? '已打开' : '打开尺子'}</button>
          <button class="nb-btn" type="button" data-act="rulerRotate" data-z="-">◀ 15°</button>
          <button class="nb-btn" type="button" data-act="rulerRotate" data-z="+">15° ▶</button>
          <button class="nb-btn" type="button" data-act="rulerRotate" data-z="45">45°</button>
          <button class="nb-btn" type="button" data-act="rulerRotate" data-z="reset">摆正</button>
        </div>
      </div>
      <div class="nb-prop-group grow"><span class="nb-hint">尺子打开时，画笔会吸附到尺子边缘 —— 画直线神器</span></div>`;
  }

  markupImage() {
    return `
      <div class="nb-prop-group">
        <span class="nb-prop-label">图片</span>
        <div class="nb-prop-row">
          <button class="nb-btn primary" type="button" data-act="pickImage">选择本地图片</button>
        </div>
      </div>
      <div class="nb-prop-group grow"><span class="nb-hint">图片会转成 data URL 存在这一页里（建议小于 2.4MB）</span></div>`;
  }

  setStatus(info) {
    this.status = info || {};
    if (this.statusEl) {
      const s = this.status;
      this.statusEl.textContent = `对象 ${s.items || 0} · 选中 ${s.selection || 0} · 可撤销 ${s.undoDepth || 0} 步`;
    }
    const undo = q(this.root, '[data-act="undo"]');
    const redo = q(this.root, '[data-act="redo"]');
    if (undo) undo.disabled = !this.status.canUndo;
    if (redo) redo.disabled = !this.status.canRedo;
    if (this.toolsOpen) this.lightTools();
  }

  /* ====================================================================
     八、视口缩放
     ==================================================================== */

  fitWidth(force = false) {
    if (!this.column || !this.nb) return;
    const d = paperDims(this.paperFor(this.cur));
    const avail = Math.max(220, this.column.clientWidth - 28);
    let scale = avail / d.w;
    scale = Math.max(0.4, Math.min(1.6, scale));
    this.zoom.fit = true;
    this.zoom.on = false;
    this.setViewScale(scale, force);
  }

  setViewScale(scale, force = false) {
    if (!this.editor) return;
    try {
      this.editor.setViewScale(scale);
      this.editor.applyViewTransform();
    } catch (e) {}
    this.scheduleFit(force);
  }

  /** 视口变化时重新贴合宽度（只在「适应宽度」状态下自动跟随） */
  scheduleFit(force = false) {
    if (!this.zoom.fit && !force) return;
    if (this._fitT) return;
    const fn = () => {
      this._fitT = 0;
      if (!this.column || !this.nb || !this.editor) return;
      const d = paperDims(this.paperFor(this.cur));
      const avail = Math.max(220, this.column.clientWidth - 28);
      let scale = avail / d.w;
      scale = Math.max(0.4, Math.min(1.6, scale));
      if (Math.abs((this.editor.view.scale || 1) - scale) < 0.01) return;
      try {
        this.editor.setViewScale(scale);
        this.editor.applyViewTransform();
      } catch (e) {}
    };
    this._fitT = (typeof setTimeout === 'function' ? setTimeout(fn, 160) : 0);
  }

  /* ====================================================================
     九、覆盖层面板
     ==================================================================== */

  openPanel(kind) {
    if (!this.maskEl || !this.panelEl || !this.nb) return;
    this.panelKind = kind || 'pages';
    if (this.panelKind === 'study') this.resetStudyQueue();
    if (this.panelKind === 'audio') { this.audioTab = this.audioTab || 'audio'; }
    this.renderPanel();
    this.maskEl.hidden = false;
    this.closeMenus();
  }

  closePanel() {
    this.panelKind = '';
    if (this.maskEl) this.maskEl.hidden = true;
    if (this.panelEl) this.panelEl.innerHTML = '';
  }

  renderPanel() {
    if (!this.panelEl || !this.panelKind) return;
    const k = this.panelKind;
    if (k === 'pages') this.panelEl.innerHTML = this.markupPagesPanel();
    else if (k === 'outline') this.panelEl.innerHTML = this.markupOutlinePanel();
    else if (k === 'study') this.panelEl.innerHTML = this.markupStudyPanel();
    else if (k === 'audio') this.panelEl.innerHTML = this.markupAudioPanel();
    else if (k === 'paper') this.panelEl.innerHTML = this.markupPaperPanel();
    else if (k === 'ocr') this.panelEl.innerHTML = this.markupOcrPanel();
    else if (k === 'search') this.panelEl.innerHTML = this.markupSearchPanel();
    if (k === 'study') { this.paintStudy(); this.renderStudyCard(); }
    if (k === 'audio') this.renderAudioLists();
    if (k === 'pages') this.paintPanelThumbs();
    if (k === 'ocr') this.renderOcrStatus();
    if (k === 'search') this.renderBookSearch();
    if (k === 'search') this.renderBookSearch();
  }

  /* ---------- 本笔记本内搜索（含手写识别结果） ---------- */

  markupSearchPanel() {
    const q = this.bookQuery || '';
    const st = this.store.ocrStats(this.bookId);
    return `${this.panelHead('本笔记本内搜索')}
      <div class="nb-panel-body">
        <input class="nb-input" id="nbBookQuery" data-x="bookQuery" type="search" value="${nbEsc(q)}"
               placeholder="搜这一本里的文字与手写（手写要先跑一次 OCR）" autocomplete="off">
        <div class="nb-hint">已识别 ${st.done}/${st.pages} 页手写；命中行会标出来源（文字 / 手写识别）。</div>
        <div class="nb-search-hits" id="nbBookHits"></div>
      </div>`;
  }

  renderBookSearch() {
    const host = q(this.panelEl, '#nbBookHits');
    if (!host) return;
    const query = String(this.bookQuery || '').trim();
    if (!query) {
      host.innerHTML = '<div class="nb-hint">输入关键词开始搜索；结果点一下直接跳到那一页。</div>';
      return;
    }
    const hits = this.store.searchText(this.bookId, query);
    if (!hits.length) {
      host.innerHTML = `<div class="nb-hint">没找到「${nbEsc(query)}」。<br>如果这页是手写，先去「更多 → 识别手写文字（OCR）」跑一次。</div>`;
      return;
    }
    const active = Math.max(0, Math.min(hits.length - 1, Number(this.searchIndex) || 0));
    this.searchIndex = active;
    host.innerHTML = `<div class="nb-search-count">命中 ${hits.length} 页 · ↑↓ 切换 · Enter 跳页</div>` + hits.map((h, i) => `<button class="nb-search-hit${i === active ? ' on' : ''}" type="button" data-act="gotoHit" data-page="${h.index}" data-hit="${i}">
        <span class="nb-search-page">第 ${h.index + 1} 页</span>
        <span class="nb-search-src">${nbEsc(h.source)}</span>
        <span class="nb-search-text">${nbMark(h.excerpt || '', query)}</span>
      </button>`).join('');
    return hits;
  }

  /** 键盘流：↑↓ 在命中间移动、Enter 跳页 */
  searchMove(delta) {
    const hits = this.store.searchText(this.bookId, this.bookQuery || '');
    if (!hits.length) return;
    this.searchIndex = (Math.max(0, this.searchIndex || 0) + delta + hits.length) % hits.length;
    this.renderBookSearch();
  }

  searchGo() {
    const hits = this.store.searchText(this.bookId, this.bookQuery || '');
    const hit = hits[Math.max(0, Math.min(hits.length - 1, this.searchIndex || 0))];
    if (!hit) return;
    this.gotoPage(hit.index);
    this.closePanel();
  }

  /** Ctrl/Cmd+F：打开内搜面板并聚焦输入框 */
  openBookSearch() {
    this.openPanel('search');
    const input = q(this.panelEl, '#nbBookQuery');
    if (input && input.focus) { try { input.focus(); } catch (e) {} }
    if (input && input.select) { try { input.select(); } catch (e) {} }
    return true;
  }

  /* ---------- 手写识别（OCR）面板 ---------- */

  markupOcrPanel() {
    const nb = this.nb;
    const st = this.store.ocrStats(nb.id);
    const key = getOcrKey();
    const model = this.ocrModel || OCR_MODELS[0].id;
    const plan = planOcrQueue([nb], { retryFailed: true });
    const failedIdx = plan.items.filter((i) => i.state === 'failed').map((i) => i.pageIndex);
    const blankCount = (nb.pages || []).filter((p) => p.ocr && p.ocr.blank).length;
    return `${this.panelHead('识别手写文字（OCR）')}
      <div class="nb-panel-body">
        <div class="nb-hint">
          把页面图交给视觉模型识别，结果存进这一页；之后<b>资料库搜索</b>和「本笔记本搜索」都能搜到手写内容。<br>
          密钥只存在你这台设备的浏览器，请求直接从浏览器发往 api.siliconflow.cn（本站之外的第三方服务）——介意的话就别开。
        </div>
        <div class="nb-field">
          <span>SiliconFlow API Key（cloud.siliconflow.cn 免费申请，填一次即可）</span>
          <input class="nb-input" type="password" data-act="ocrKey" value="${nbEsc(key)}" placeholder="sk-...">
        </div>
        <div class="nb-field">
          <span>模型</span>
          <div class="nb-row">
            ${OCR_MODELS.map((m) => `<button class="nb-chip${model === m.id ? ' on' : ''}" type="button" data-act="ocrModel" data-note="${nbEsc(m.id)}" title="${nbEsc(m.hint)}">${nbEsc(m.label)}</button>`).join('')}
            <button class="nb-chip${this.ocrBoxes !== false ? ' on' : ''}" type="button" data-act="ocrBoxes" title="让模型同时给出每行的位置：导出的 PDF 里选中/复制会贴着原来的文字位置">同时识别行位置</button>
          </div>
        </div>
        <div class="nb-row">
          <button class="nb-btn primary" type="button" data-act="ocrRun" ${key ? '' : 'disabled'}>识别未识别的页（${st.pending} 页）</button>
          <button class="nb-btn" type="button" data-act="ocrRunPage" ${key ? '' : 'disabled'}>只识别当前页</button>
          <button class="nb-btn" type="button" data-act="ocrRunAll" ${key ? '' : 'disabled'}>全部重识别</button>
          ${failedIdx.length ? `<button class="nb-btn" type="button" data-act="ocrRunFailed" ${key ? '' : 'disabled'} title="只重跑上次失败的那几页">重试失败的 ${failedIdx.length} 页</button>` : ''}
          <button class="nb-btn danger" type="button" data-act="ocrClearPage">清掉本页识别结果</button>
          <button class="nb-btn" type="button" data-act="ocrToText" ${(nb.pages[this.cur] && nb.pages[this.cur].ocr) ? '' : 'disabled'} title="把手写识别结果变成可编辑的文本框">识别结果转成文本框</button>
          <button class="nb-btn danger" type="button" data-act="ocrReplace" ${(nb.pages[this.cur] && nb.pages[this.cur].ocr && (nb.pages[this.cur].ocr.lines || []).length) ? '' : 'disabled'} title="删掉被识别到的笔迹，并在原位放文本（一次撤销可退回）">识别并替换手写</button>
        </div>
        <div class="nb-field">
          <span>进度</span>
          <div class="nb-ocr-status" id="nbOcrStatus">共 ${st.pages} 页 · 已识别 ${st.done} 页${blankCount ? ` · ${blankCount} 页确认没字（不再重跑）` : ''} · 已入库 ${st.chars} 字</div>
        </div>        ${failedIdx.length ? `<div class="nb-field">
          <span>失败的页（资料库里点「继续识别」也会自动重试这些页）</span>
          <div class="nb-hint">${failedIdx.map((i) => `第 ${i + 1} 页：${nbEsc(((nb.pages[i] && nb.pages[i].ocrError && nb.pages[i].ocrError.message) || '识别失败').slice(0, 80))}`).join('<br>')}</div>
        </div>` : ''}
        ${nb.pages && nb.pages[this.cur] && nb.pages[this.cur].ocr ? `
        <div class="nb-field">
          <span>本页识别结果（${(nb.pages[this.cur].ocr.text || '').length} 字）</span>
          <textarea class="nb-textarea" readonly>${nbEsc((nb.pages[this.cur].ocr.text || '').slice(0, 4000))}</textarea>
        </div>` : ''}
        <div class="nb-hint">提示：8B 模型快（约 15~25 秒/页），公式与表格多的页建议切 32B 复核。识别要花钱，所以默认只跑没识别过的页；想一次跑好几本、中途还能停，用资料库多选条里的「识别手写」（带队列续跑）。</div>
      </div>`;
  }

  renderOcrStatus() {
    const el = q(this.panelEl, '#nbOcrStatus');
    if (el) el.textContent = this.ocrStatusText || (() => {
      const st = this.store.ocrStats(this.bookId);
      return `共 ${st.pages} 页 · 已识别 ${st.done} 页 · 已入库 ${st.chars} 字`;
    })();
  }

  async runOcr(opts = {}) {
    const key = getOcrKey();
    if (!key) { this.toast('先把 API Key 填上'); return; }
    const model = this.ocrModel || OCR_MODELS[0].id;
    this.ocrRunning = true;
    const total = opts.indices ? opts.indices.length : this.store.ocrStats(this.bookId).pending;
    this.ocrStatusText = progressText(0, total || 1, 0);
    this.renderOcrStatus();
    try {
      const res = await ocrNotebook(this.store, this.bookId, {
        apiKey: key,
        model,
        onlyMissing: !opts.all,
        indices: opts.indices || null,
        concurrency: opts.concurrency || 3,
        withBoxes: this.ocrBoxes !== false,
        renderPage,
        onProgress: ({ done, total: tt, failed }) => {
          this.ocrStatusText = progressText(done, tt, failed);
          this.renderOcrStatus();
        },
      });
      const st = this.store.ocrStats(this.bookId);
      this.ocrStatusText = `识别完成：${res.done} 页成功${res.failed ? ` · ${res.failed} 页失败` : ''}${res.withBoxes ? ` · ${res.withBoxes} 行带位置` : ''} · 已入库 ${st.chars} 字`;
      this.toast(`OCR：${res.done} 页成功${res.failed ? `，${res.failed} 页失败` : ''}`);
      if (res.errors && res.errors.length) this.toast('第一处错误：' + res.errors[0]);
      this.refresh();
      this.renderOcrStatus();
    } catch (e) {
      this.ocrStatusText = '识别失败：' + ((e && e.message) || '未知错误');
      this.toast(this.ocrStatusText);
      this.renderOcrStatus();
    } finally {
      this.ocrRunning = false;
    }
  }

  /** 把识别结果变成文本框（手写 → 可编辑文本：Scribble 的等效实现） */
  ocrToText() {
    const page = this.nb.pages[this.cur];
    const ed = this.editor;
    if (!page || !page.ocr || !page.ocr.text) { this.toast('这一页还没识别过'); return; }
    if (!ed) return;
    ed.snapshot('识别结果转文本');
    ed.items.push({
      kind: 'text',
      id: 'ocr' + Date.now().toString(36),
      x: 0.06, y: 0.06,
      text: page.ocr.text.slice(0, 1200),
      size: 0.018,
      color: '#2B2723',
      font: 'sans',
      bold: false, italic: false, align: 'left', rot: 0,
    });
    ed.commit('识别结果转文本');
    ed.redraw();
    this.setStatus(ed.info());
    this.toast('已把识别结果放成文本框（可拖动、可改样式，也可撤销）');
  }

  /** 导出 EPUB（电子书）：封面（自己的图或配色封面）+ 每页图片 + 可搜索文本 + 层级目录 + 内链 */
  async exportEpub() {
    if (!this.nb) return;
    this.flush();
    this.toast('正在生成 EPUB…');
    try {
      const blob = buildEpub(this.nb, {
        renderPage,
        renderCoverImpl: renderCover,     // 没有自定义封面图时，用配色封面画一张当书封
        scale: 1.5,
        quality: 0.85,
        plain: !!this.plainPaper,
        dropTape: !!this.dropTape,
        cover: true,
        toc: true,
        links: this.textLayer !== false,  // 「见第 3 页」变书内链接
      });
      if (!blob) { this.toast('EPUB 生成失败（当前环境不支持 canvas）'); return; }
      downloadBlob(blob, `${safeName(this.nb.title)}.epub`);
      this.toast(`EPUB 已导出（${this.nb.pages.length} 页 · 含封面与层级目录 · ${(blob.size / 1048576).toFixed(1)} MB）`);
    } catch (e) {
      this.toast('导出 EPUB 失败：' + ((e && e.message) || '未知错误'));
    }
  }

  /** 导出单文件 HTML：双击就能看、能打印、能直接发人 */
  async exportHtml() {
    if (!this.nb) return;
    this.flush();
    this.toast('正在生成单文件 HTML…');
    try {
      const html = buildSingleHtml(this.nb, { renderPage, scale: 1.5, quality: 0.85, plain: !!this.plainPaper, dropTape: !!this.dropTape });
      downloadBlob(new Blob([html], { type: 'text/html' }), `${safeName(this.nb.title)}.html`);
      this.toast(`单文件 HTML 已导出（${this.nb.pages.length} 页 · ${(html.length / 1048576).toFixed(1)} MB）`);
    } catch (e) {
      this.toast('导出 HTML 失败：' + ((e && e.message) || '未知错误'));
    }
  }

  /* ---------- 长图导出 / 选区 OCR / 移动端小工具 ---------- */

  async exportLongImage() {
    if (!this.nb) return;
    this.flush();
    this.toast('正在拼接长图…');
    try {
      const blob = await buildLongImage(this.nb, { scale: 1, gap: 14, renderPage });
      if (!blob) { this.toast('长图生成失败（当前环境不支持 canvas）'); return; }
      downloadBlob(blob, `${safeName(this.nb.title)}-长图.png`);
      this.toast(`长图已导出（${this.nb.pages.length} 页拼一张 · ${(blob.size / 1048576).toFixed(1)} MB）`);
    } catch (e) {
      this.toast('导出长图失败：' + ((e && e.message) || '未知错误'));
    }
  }

  /** 只识别套索圈中的那一块（结果直接落成文本框，贴在选区上方） */
  async recognizeSelection() {
    const ed = this.editor;
    if (!ed) return;
    if (!ed.selection.size) { this.toast('先用套索圈住要识别的手写内容'); return; }
    const key = getOcrKey();
    if (!key) { this.toast('先在「识别手写文字（OCR）」里填一次 API Key'); return; }
    const dataUrl = ed.selectionDataUrl({ scale: 2 });
    if (!dataUrl) { this.toast('这块内容没法渲染成图片（可能只有胶带或图片）'); return; }
    this.toast('正在识别选区…');
    try {
      const raw = await ocrImageDataUrl(dataUrl, { apiKey: key, model: this.ocrModel });
      const text = String(raw || '').trim();
      if (!text) { this.toast('这一块没识别出文字'); return; }
      const box = ed.selectionBounds() || { x0: 0.06, y0: 0.06 };
      ed.snapshot('选区识别');
      ed.items.push({
        kind: 'text',
        id: 'ocr' + Date.now().toString(36),
        x: Math.max(0, Math.min(0.9, box.x0)),
        y: Math.max(0, box.y0 - 0.035),
        text,
        size: 0.02,
        color: '#2B2723',
        font: 'sans', bold: false, italic: false, align: 'left', rot: 0,
      });
      ed.commit('选区识别');
      ed.redraw();
      this.setStatus(ed.info());
      this.toast(`已识别为文本框：${text.slice(0, 24)}${text.length > 24 ? '…' : ''}（可拖动、可撤销）`);
    } catch (e) {
      this.toast('选区识别失败：' + ((e && e.message) || '未知错误'));
    }
  }

  /** 长按画笔/荧光笔：在笔型之间循环（移动端省一步进属性面板） */
  bindLongPressTools() {
    const row = q(this.root, '[data-role="tools"]');
    if (!row || !row.addEventListener) return;
    let timer = 0;
    const start = (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-tool]') : null;
      if (!btn) return;
      const id = btn.dataset.tool;
      if (id !== 'pen' && id !== 'highlighter') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        const ed = this.editor;
        if (!ed) return;
        const order = PEN_TYPES.map((p) => p.id);
        const next = order[(order.indexOf(ed.penType) + 1) % order.length];
        ed.setPenType(next);
        this.setStatus(ed.info());
        this.renderProps();
        this.toast(`笔型：${(PEN_TYPES.find((p) => p.id === next) || {}).label}`);
      }, 450);
    };
    const stop = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    row.addEventListener('pointerdown', start);
    row.addEventListener('pointerup', stop);
    row.addEventListener('pointercancel', stop);
    row.addEventListener('pointerleave', stop);
  }

  /* ---------- Markdown 导出 / 发到仓库 / 存模板 ---------- */

  exportMarkdown() {
    if (!this.nb) return;
    this.flush();
    try {
      const md = notebookToMarkdown(this.nb);
      downloadBlob(new Blob([md], { type: 'text/markdown' }), `${markdownSlug(this.nb.title)}.md`);
      this.toast('已导出 Markdown（文本 + 手写识别 + 闪卡）');
    } catch (e) { this.toast('导出 Markdown 失败：' + ((e && e.message) || '未知错误')); }
  }

  /** 把笔记本导出成 Markdown 提交到 content/，于是它进全站检索与知识图谱 */
  async publishMarkdown() {
    if (!gh.configured()) { this.toast('还没配 GitHub 令牌：进任意笔记点「✎ 编辑」→ ⚙ 填一次'); return; }
    this.flush();
    try {
      const md = notebookToMarkdown(this.nb);
      const { slug, source } = markdownTarget(this.nb);
      this.toast('正在把 Markdown 发到仓库…');
      const exist = await gh.getFile(source);
      await gh.putFile(source, md, `notes: 从手写笔记本导出「${this.nb.title}」`, exist ? exist.sha : null);
      const idx = await gh.getFile('docs/data/index.json');
      if (idx) {
        // applyEdit 返回的是对象，写回仓库前要序列化（与编辑器的 rebuildIndex 同一套路）
        const rebuilt = JSON.stringify(applyEdit(JSON.parse(idx.text), { raw: md, slug, source }));
        await gh.putFile('docs/data/index.json', rebuilt, `build: 重新生成索引（${this.nb.title}）`, idx.sha);
      }
      this.toast('已发到仓库：约 1 分钟后可在资料库/搜索里看到这篇笔记');
      try { this.onChanged(); } catch (e) {}
    } catch (e) {
      this.toast('发送失败：' + ((e && e.message) || '未知错误'));
    }
  }

  saveAsTemplate({ withContent = false } = {}) {
    if (!this.nb) return null;
    let name = this.nb.title;
    try {
      if (typeof prompt === 'function') name = prompt('模板叫什么名字？（只存纸张与页面结构，不存内容）', this.nb.title) || this.nb.title;
    } catch (e) { /* prompt 不可用就用笔记本标题 */ }
    const t = this.store.saveAsTemplate(this.bookId, { name, withContent });
    if (t) this.toast(`已存为模板「${t.name}」：新建笔记本时可以套用`);
    return t;
  }

  /* ---------- 与仓库同步（笔记本也交给 git 管） ---------- */
  async syncPush() {
    if (!gh.configured()) { this.toast('还没配 GitHub 令牌：进任意笔记点「✎ 编辑」→ ⚙ 填一次，再来同步'); return; }
    try {
      this.toast('正在推送到仓库…');
      const res = await pushNotebook(gh, this.store, this.bookId, { alsoIndex: true });
      this.toast(`已推送（${Math.max(1, Math.round(res.bytes / 1024))} KB，含线上目录）`);
      try { this.onChanged(); } catch (e) {}
    } catch (e) {
      this.toast('推送失败：' + ((e && e.message) || '未知错误'));
    }
  }

  async syncPull() {
    if (!gh.configured()) { this.toast('拉取需要 GitHub 令牌（只想看线上内容：资料库里有「线上笔记本」入口）'); return; }
    try {
      const res = await pullNotebook(gh, this.store, this.bookId, { force: false });
      if (res.action === 'pull') {
        this.toast(`已用仓库版本覆盖本地${res.backup ? '（旧版本存成了本机备份副本）' : ''}`);
        this.open(this.bookId);
        try { this.onChanged(); } catch (e) {}
      } else {
        this.toast('两边一样，或本地更新：先「同步到仓库」再拉');
      }
    } catch (e) {
      this.toast('拉取失败：' + ((e && e.message) || '未知错误'));
    }
  }

  panelHead(title) {
    return `<div class="nb-panel-head"><h3>${nbEsc(title)}</h3><button class="nb-btn ghost icon" type="button" data-act="panelClose" title="关闭">✕</button></div>`;
  }

  markupPagesPanel() {
    const pages = this.nb.pages || [];
    return `${this.panelHead('页面管理')}
      <div class="nb-panel-body">
        <div class="nb-row">
          <button class="nb-btn primary" type="button" data-act="panelAddPage">＋ 加一页</button>
          <button class="nb-btn" type="button" data-act="panelAddPages5">＋ 加 5 页</button>
          <span class="nb-hint">共 ${pages.length} 页</span>
        </div>
        <div class="nb-pages-grid">
          ${pages.map((p, i) => `<div class="nb-pages-item${i === this.cur ? ' on' : ''}" data-page="${i}">
            <div class="nb-pages-thumbwrap">
              <canvas class="nb-pages-thumb" data-page="${i}" width="1" height="1"></canvas>
              <span class="nb-pages-no">${i + 1}</span>
              ${p.bookmarked ? '<span class="nb-pages-mark">🔖</span>' : ''}
            </div>
            <div class="nb-pages-ops">
              <button class="nb-btn ghost icon" type="button" data-act="panelPageAct" data-note="up" data-page="${i}" title="上移">↑</button>
              <button class="nb-btn ghost icon" type="button" data-act="panelPageAct" data-note="down" data-page="${i}" title="下移">↓</button>
              <button class="nb-btn ghost icon" type="button" data-act="panelPageAct" data-note="dup" data-page="${i}" title="复制此页">⧉</button>
              <button class="nb-btn ghost icon" type="button" data-act="panelPageAct" data-note="bookmark" data-page="${i}" title="书签">${p.bookmarked ? '🔖' : '☆'}</button>
              <button class="nb-btn ghost icon" type="button" data-act="panelPageAct" data-note="del" data-page="${i}" title="删除此页">🗑</button>
            </div>
          </div>`).join('')}
        </div>
      </div>
      <div class="nb-panel-foot">
        <span class="nb-hint">本笔记本纸张</span>
        <button class="nb-btn" type="button" data-act="panel" data-panel="paper">纸张 / 颜色 / 尺寸设置</button>
      </div>`;
  }

  paintPanelThumbs() {
    const pages = this.nb.pages || [];
    qa(this.panelEl, '.nb-pages-thumb').forEach((c) => {
      const i = Number(c.dataset.page);
      if (!Number.isFinite(i) || !pages[i]) return;
      this.paintThumb(c, i);
    });
  }

  markupOutlinePanel() {
    const list = this.store.outline(this.bookId) || [];
    const curPage = this.nb.pages[this.cur] || {};
    return `${this.panelHead('大纲与书签')}
      <div class="nb-panel-body">
        <div class="nb-field">
          <span>当前页（第 ${this.cur + 1} 页）标题</span>
          <div class="nb-row">
            <input class="nb-input" type="text" maxlength="60" data-x="pageTitle" value="${nbEsc(curPage.title || '')}" placeholder="给这一页起个名字">
            <button class="nb-btn primary" type="button" data-act="setPageTitle">保存</button>
            <button class="nb-btn" type="button" data-act="clearPageTitle">清空</button>
          </div>
        </div>
        ${list.length ? `<div class="nb-outline">
          ${list.map((x) => `<button class="nb-outline-item" type="button" data-act="outlineGo" data-page="${x.index}">
            <span class="nb-outline-no">${x.index + 1}</span>
            <span class="nb-outline-title">${nbEsc(x.title || '（无标题）')}</span>
            ${x.bookmarked ? '<span class="nb-outline-mark">🔖</span>' : ''}
          </button>`).join('')}
        </div>` : '<div class="nb-empty"><div class="big">🔖</div>还没有书签或标题<br><span class="nb-hint">在缩略图菜单里点「设书签」，或给页面起个标题</span></div>'}
      </div>`;
  }

  markupStudyPanel() {
    const deck = this.study.queue || [];
    const card = deck[this.study.idx] || null;
    const all = (this.nb.study || []);
    return `${this.panelHead('学习集（闪卡）')}
      <div class="nb-panel-body">
        <div class="nb-row">
          <span class="nb-chip">到期 ${deck.length} 张</span>
          <span class="nb-chip">全部 ${all.length} 张</span>
          <span class="nb-chip">今日已复习 ${this.study.today || 0} 张</span>
        </div>
        <div class="nb-study">
          <div class="nb-card-box" data-act="studyFlip" title="点一下翻面">
            <div class="nb-face front${card && card.front ? '' : ' empty'}">
              ${card ? nbEsc(card.front || '（只写了背面）') : '没有到期的卡片'}
            </div>
            <div class="nb-face back${this.study.flipped ? ' show' : ''}">
              ${card ? nbEsc(card.back || '（这张卡没有背面）') : '点「从当前页的文本对象生成卡片」开始'}
            </div>
          </div>
          <div class="nb-study-ops">
            <button class="nb-btn nb-good" type="button" data-act="studyRemember" ${card ? '' : 'disabled'}>记住了</button>
            <button class="nb-btn nb-bad" type="button" data-act="studyForget" ${card ? '' : 'disabled'}>忘了</button>
            <button class="nb-btn" type="button" data-act="studyFlip" ${card ? '' : 'disabled'}>翻面</button>
          </div>
          <div class="nb-hint">第 ${Math.min(this.study.idx + 1, Math.max(1, deck.length))} / ${deck.length} 张</div>
        </div>

        <div class="nb-divider"></div>
        <div class="nb-row">
          <button class="nb-btn primary" type="button" data-act="cardsFromText">从当前页的文本对象生成卡片</button>
          <button class="nb-btn" type="button" data-act="cardsFromSummary">用本页内容做摘要卡</button>
        </div>
        <div class="nb-row nb-card-add">
          <input class="nb-input" type="text" data-x="cardFront" placeholder="正面（问题）">
          <input class="nb-input" type="text" data-x="cardBack" placeholder="背面（答案）">
          <input class="nb-input" type="text" data-x="cardTags" placeholder="标签（逗号分隔，可选）">
          <button class="nb-btn" type="button" data-act="cardAdd">加卡片</button>
        </div>

        ${all.length ? `<div class="nb-divider"></div>
        <div class="nb-cards-list">
          ${all.slice(-40).reverse().map((c) => `<div class="nb-cards-item">
            <span class="nb-cards-text">${nbEsc(c.front)}${c.back ? ' —— ' + nbEsc(c.back) : ''}${(c.tags || []).length ? ` <i class="nb-card-tags">${c.tags.map((t) => '#' + nbEsc(t)).join(' ')}</i>` : ''}</span>
            <span class="nb-chip">盒 ${c.box || 0}</span>
            <button class="nb-btn ghost icon" type="button" data-act="cardDelete" data-id="${nbEsc(c.id)}" title="删掉这张卡">🗑</button>
          </div>`).join('')}
        </div>` : ''}
        <div class="nb-hint">想按标签筛着复习、看复习热图、或把闪卡导出到 Anki：回资料库点「复习中心」。</div>
      </div>`;
  }

  resetStudyQueue() {
    const fresh = this.store.get(this.bookId) || this.nb;
    this.nb = fresh || this.nb;
    const due = this.store.dueCards(this.bookId) || [];
    const all = (this.nb && this.nb.study) || [];
    const dayAgo = Date.now() - 86400000;
    this.study.queue = due;
    this.study.idx = 0;
    this.study.flipped = false;
    this.study.dueCount = due.length;
    this.study.total = all.length;
    this.study.today = all.filter((c) => c.last && c.last > dayAgo).length;
  }

  paintStudy() {
    const box = q(this.panelEl, '.nb-card-box');
    if (!box) return;
    const front = q(box, '.nb-face.front');
    const back = q(box, '.nb-face.back');
    const card = (this.study.queue || [])[this.study.idx] || null;
    if (front) {
      front.textContent = card ? (card.front || '（只写了背面）') : '没有到期的卡片';
      front.classList.toggle('empty', !card);
    }
    if (back) {
      back.textContent = card ? (card.back || '（这张卡没有背面）') : '点「从当前页的文本对象生成卡片」开始';
    }
    box.classList.toggle('flipped', !!this.study.flipped);
    const ops = qa(this.panelEl, '[data-act="studyRemember"], [data-act="studyForget"], [data-act="studyFlip"]');
    ops.forEach((b) => { b.disabled = !card; });
    const hint = q(this.panelEl, '.nb-study .nb-hint');
    if (hint) hint.textContent = `第 ${Math.min(this.study.idx + 1, Math.max(1, (this.study.queue || []).length))} / ${(this.study.queue || []).length} 张`;
  }

  renderStudyCard() { this.paintStudy(); }

  answerCard(remembered) {
    const card = (this.study.queue || [])[this.study.idx];
    if (!card) return;
    try {
      this.store.reviewCard(this.bookId, card.id, !!remembered);
    } catch (e) { this.toast('记录失败：' + ((e && e.message) || '未知错误')); }
    this.study.today++;
    this.study.idx++;
    this.study.flipped = false;
    this.renderPanel();
    this.touchChanged();
  }

  /** 当前页的「文字对象」拼起来 */
  pageText() {
    const ed = this.editor;
    const items = ed ? ed.items : ((this.nb.pages[this.cur] || {}).items || []);
    return items.filter((it) => it && it.kind === 'text' && it.text).map((it) => String(it.text)).join('\n').trim();
  }

  cardsFromText() {
    const text = this.pageText();
    if (!text) { this.toast('这一页没有文字对象：先用「文本」工具写点东西'); return; }
    let made = [];
    try { made = this.store.cardsFromText(this.bookId, (this.nb.pages[this.cur] || {}).id, text) || []; } catch (e) { made = []; }
    this.toast(made.length ? `已生成 ${made.length} 张卡片` : '没能从这段文字里切出卡片（试试「问题：答案」这样写）');
    this.resetStudyQueue();
    this.renderPanel();
    this.touchChanged();
  }

  cardsFromSummary() {
    const text = this.pageText();
    if (!text) { this.toast('这一页没有文字对象，先写点东西再总结'); return; }
    const lines = summarizeText(text, { max: 6 });
    if (!lines.length) { this.toast('这段文字太短，摘不出要点'); return; }
    let n = 0;
    for (const line of lines) {
      try { if (this.store.addCard(this.bookId, line, '', { pageId: (this.nb.pages[this.cur] || {}).id })) n++; } catch (e) {}
    }
    this.toast(`摘出 ${n} 条要点做成了卡片`);
    this.resetStudyQueue();
    this.renderPanel();
    this.touchChanged();
  }

  addCardManual() {
    const f = (q(this.panelEl, '[data-x="cardFront"]') || {}).value || '';
    const b = (q(this.panelEl, '[data-x="cardBack"]') || {}).value || '';
    const tg = (q(this.panelEl, '[data-x="cardTags"]') || {}).value || '';
    if (!String(f).trim()) { this.toast('正面至少要写点东西'); return; }
    try { this.store.addCard(this.bookId, f, b, { pageId: (this.nb.pages[this.cur] || {}).id, tags: tg }); } catch (e) {}
    this.toast(tg.trim() ? `卡片已加入（标签：${String(tg).trim()}）` : '卡片已加入');
    this.cardDraft = {};
    this.resetStudyQueue();
    this.renderPanel();
    this.touchChanged();
  }

  /** 把当前页的文字总结成一段文字对象贴回页面 */
  summaryToPage() {
    const text = this.pageText();
    if (!text) { this.toast('这一页没有文字对象，先写点东西再总结'); return; }
    const lines = summarizeText(text, { max: 4 });
    if (!lines.length) { this.toast('这段文字太短，摘不出要点'); return; }
    const ed = this.editor;
    if (!ed) return;
    const body = lines.map((s) => `· ${s}`).slice(0, 12).join('\n').slice(0, 560);
    const step = TEXT_SIZE_STEPS.find((s) => s.id === ed.textStyle.size) || TEXT_SIZE_STEPS[2];
    ed.snapshot('总结这一页');
    ed.items.push({
      kind: 'text',
      id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      x: 0.06, y: 0.06, text: body,
      size: step.value,
      color: ed.color,
      font: ed.textStyle.font,
      bold: false, italic: false, align: 'left', rot: 0,
    });
    ed.commit('总结这一页');
    ed.redraw();
    ed.refreshStatus();
    this.toast('已把要点贴到这一页顶部（可拖动 / 可撤销）');
    this.scheduleThumbUpdate();
    try { this.onChanged(); } catch (e) {}
  }

  markupPaperPanel() {
    const nb = this.nb;
    const paper = { ...(nb.paper || {}) };
    return `${this.panelHead('本笔记本纸张')}
      <div class="nb-panel-body">
        <div class="nb-field">
          <span>模板</span>
          <div class="nb-paper-grid">
            ${templateGroups().map((g) => `<div class="nb-paper-group">
              <span class="nb-prop-label">${nbEsc(g.group)}</span>
              <div class="nb-prop-row">
                ${g.list.map((t) => `<button class="nb-chip${paper.template === t.id ? ' on' : ''}" type="button" data-act="presetPaper" data-id="${t.id}">${nbEsc(t.label)}</button>`).join('')}
              </div>
            </div>`).join('')}
          </div>
        </div>
        <div class="nb-field">
          <span>纸张颜色</span>
          <div class="nb-colors">
            ${PAPER_COLORS.map((c) => `<button class="nb-swatch" type="button" data-act="presetPaper" data-id="color:${nbEsc(c.value)}" title="${nbEsc(c.label)}" style="--c:${nbEsc(c.value)}"></button>`).join('')}
          </div>
        </div>
        <div class="nb-field">
          <span>尺寸</span>
          <select class="nb-select" data-x="panelSize">
            ${PAPER_SIZES.map((s) => `<option value="${s.id}"${paper.size === s.id ? ' selected' : ''}>${nbEsc(s.label)}${s.id === 'custom' ? '' : `（${s.w}×${s.h}）`}</option>`).join('')}
          </select>
        </div>
        <div class="nb-row nb-paper-custom" hidden>
          <label class="nb-field"><span>宽（px）</span><input class="nb-input" type="number" min="200" max="4000" data-x="panelW" value="${Math.round(Number(paper.width) || 794)}"></label>
          <label class="nb-field"><span>高（px）</span><input class="nb-input" type="number" min="200" max="4000" data-x="panelH" value="${Math.round(Number(paper.height) || 1123)}"></label>
        </div>
        <div class="nb-row">
          <button class="nb-btn primary" type="button" data-act="applyPaper">应用到全部页面</button>
          <span class="nb-hint">改动会写到每一页（每页仍可单独覆盖纸张）</span>
        </div>
      </div>`;
  }

  presetPaper(id) {
    if (!id) return;
    const nb = this.nb;
    if (String(id).startsWith('color:')) {
      this.store.update(this.bookId, { paper: { ...(nb.paper || {}), color: String(id).slice(6) } });
    } else {
      this.store.update(this.bookId, { paper: { ...(nb.paper || {}), template: id } });
    }
    this.touchChanged();
    this.renderPanel();
    this.rebuildAll();
  }

  applyNotebookPaper() {
    const p = { ...(this._pendingPaper || {}) };
    const sizeSel = q(this.panelEl, '[data-x="panelSize"]');
    if (sizeSel) p.size = sizeSel.value;
    if (p.size === 'custom') {
      const w = q(this.panelEl, '[data-x="panelW"]');
      const h = q(this.panelEl, '[data-x="panelH"]');
      p.width = Math.max(200, Math.min(4000, Number(w && w.value) || 794));
      p.height = Math.max(200, Math.min(4000, Number(h && h.value) || 1123));
    }
    try {
      this.store.update(this.bookId, { paper: { ...(this.nb.paper || {}), ...p } });
      // 应用到全部页：清掉每页的单独覆盖
      for (const pg of this.nb.pages) this.store.clearPagePaper(this.bookId, pg.id);
      this.touchChanged();
      this.toast('纸张已应用到全部页面');
    } catch (e) { this.toast('设置失败：' + ((e && e.message) || '未知错误')); }
    this._pendingPaper = null;
    this.closePanel();
    this.rebuildAll();
  }

  /* ====================================================================
     十、录音（与手写时间点同步）
     ==================================================================== */

  audioSupported() {
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      return typeof MediaRecorder !== 'undefined';
    } catch (e) { return false; }
  }

  markupAudioPanel() {
    const ok = this.audioSupported();
    const list = (this.nb.audio || []);
    const rec = this.audio;
    return `${this.panelHead('录音')}
      <div class="nb-panel-body">
        <div class="nb-row">
          <button class="nb-btn ${rec.recording ? 'danger' : 'primary'}" type="button" data-act="audioRecord" ${ok ? '' : 'disabled'}>
            ${rec.recording ? '停止录音' : '开始录音'}
          </button>
          <span class="nb-audio-dot${rec.recording ? ' on' : ''}"></span>
          <span class="nb-audio-time" id="nbAudioTime">${rec.recording ? '录音中…' : '未在录音'}</span>
          <button class="nb-btn" type="button" data-act="audioStop">停止播放</button>
        </div>
        ${ok ? '' : '<div class="nb-hint">这个浏览器不支持录音（需要 https 或 localhost，且浏览器支持 MediaRecorder）：可以先看已有的录音。</div>'}
        <div class="nb-hint">录音会记下开始时的页码与手写对象数；播放时按进度自动跳回那一页 —— 这就是「录音与手写时间点同步」。</div>
        <div class="nb-divider"></div>
        <div class="nb-row">
          <button class="nb-btn" type="button" data-act="speakPage" title="用浏览器自带的语音把这一页读出来（文字 + 手写识别）">🔊 朗读本页</button>
          <button class="nb-btn" type="button" data-act="stopSpeak">停止朗读</button>
          <span class="nb-hint">${this.speaker && this.speaker.supported ? '逐句朗读，当前句会高亮' : '这个浏览器不支持语音合成（可以先看转写文字）'}</span>
        </div>
        ${this.speak && this.speak.sentences.length ? `<div class="nb-audio-segs" id="nbSpeakSegs">
          <div class="nb-audio-segs-head">朗读中 · 点一句从那里接着读</div>
          ${this.speak.sentences.map((s, i) => `<button class="nb-audio-seg${i === this.speak.index ? ' on' : ''}" type="button" data-act="speakJump" data-seg="${i}">
            <span class="nb-audio-seg-time">${i + 1}</span>
            <span class="nb-audio-seg-page">朗读</span>
            <span class="nb-audio-seg-text">${nbEsc(s)}</span>
          </button>`).join('')}
        </div>` : ''}
        <div class="nb-divider"></div>
        <div class="nb-audio-list" id="nbAudioList">${this.markupAudioItems()}</div>
        ${list.length ? '' : '<div class="nb-empty"><div class="big">🎙</div>还没有录音</div>'}
      </div>`;
  }

  markupAudioItems() {
    const list = (this.nb.audio || []).slice().reverse();
    return list.map((a) => `<div class="nb-audio-item" data-id="${nbEsc(a.id)}">
      <span class="nb-audio-glyph">🎙</span>
      <span class="nb-audio-meta">
        <b>第 ${(a.pageIndex || 0) + 1} 页 · 第 ${a.itemCount || 0} 个对象</b>
        <span class="nb-hint">${fmtTime(a.duration)} · ${new Date(a.createdAt || Date.now()).toLocaleString('zh-CN')} · ${Math.round((a.size || 0) / 1024)} KB</span>
      </span>
      <progress class="nb-audio-bar" max="100" value="0"></progress>
      <button class="nb-btn" type="button" data-act="audioPlay" data-id="${nbEsc(a.id)}">▶ 播放</button>
      <button class="nb-btn" type="button" data-act="audioTranscribe" data-id="${nbEsc(a.id)}" title="把这段录音转成文字，之后就能被搜索到">${a.text ? '重新转文字' : '转文字'}</button>
      <button class="nb-btn ghost icon" type="button" data-act="audioGoPage" data-page="${a.pageIndex || 0}" title="跳到这一页">↗</button>
      <button class="nb-btn ghost icon" type="button" data-act="audioDelete" data-id="${nbEsc(a.id)}" title="删除">🗑</button>
      ${a.text ? `<div class="nb-audio-text">${nbEsc(a.text.slice(0, 600))}${a.text.length > 600 ? '…' : ''}
        <button class="nb-btn ghost" type="button" data-act="audioTextClear" data-id="${nbEsc(a.id)}">清掉转写</button></div>` : ''}
      ${(a.segments && a.segments.length) ? `<div class="nb-audio-segs">
        <div class="nb-audio-segs-head">按句分段（${a.segments[0].exact ? '接口时间戳' : '按时长等分近似'}）· 点一句跳到它对应的页</div>
        ${a.segments.map((sg, i) => `<button class="nb-audio-seg" type="button" data-act="audioSegGo" data-id="${nbEsc(a.id)}" data-page="${sg.pageIndex || 0}" data-seg="${i}">
          <span class="nb-audio-seg-time">${fmtTime(sg.start)}</span>
          <span class="nb-audio-seg-page">P${(sg.pageIndex || 0) + 1}</span>
          <span class="nb-audio-seg-text">${nbEsc(sg.text)}</span>
        </button>`).join('')}
      </div>` : ''}
    </div>`).join('');
  }

  renderAudioLists() {
    const box = q(this.panelEl, '#nbAudioList');
    if (box) box.innerHTML = this.markupAudioItems();
  }

  async recordToggle() {
    if (!this.audioSupported()) { this.toast('这个浏览器不支持录音'); return; }
    if (this.audio.recording) { await this.stopRecording(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      let mime = '';
      try { mime = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''; } catch (e) { mime = ''; }
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => { this.saveRecording(chunks, rec.mimeType || 'audio/webm'); };
      rec.start();
      this.audio.recorder = rec;
      this.audio.chunks = chunks;
      this.audio.stream = stream;
      this.audio.recording = true;
      this.audio.startedAt = Date.now();
      this.audio.pageIndex = this.cur;
      this.audio.pageId = (this.nb.pages[this.cur] || {}).id || '';
      this.audio.itemCount = this.editor ? this.editor.items.length : 0;
      this.audio.timer = (typeof setInterval === 'function' ? setInterval(() => this.tickAudio(), 500) : 0);
      this.toast('开始录音…（录音会记在这一页的手写时间点上）');
      this.renderPanel();
    } catch (err) {
      this.toast('拿不到麦克风权限：' + ((err && err.message) || '可能被浏览器拦了'));
    }
  }

  tickAudio() {
    const el = q(this.panelEl, '#nbAudioTime');
    if (!el || !this.audio.recording) return;
    const s = (Date.now() - this.audio.startedAt) / 1000;
    el.textContent = `录音中 ${fmtTime(s)}`;
  }

  async stopRecording() {
    const rec = this.audio.recorder;
    this.audio.recording = false;
    if (this.audio.timer && typeof clearInterval === 'function') clearInterval(this.audio.timer);
    this.audio.timer = 0;
    if (this.audio.stream) { try { this.audio.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
    this.toast('录音已保存');
    try { if (rec && rec.state !== 'inactive') rec.stop(); else this.saveRecording(this.audio.chunks || [], ''); } catch (e) { this.saveRecording(this.audio.chunks || [], ''); }
  }

  async saveRecording(chunks, mime) {
    try {
      const blob = new Blob(chunks && chunks.length ? chunks : [], { type: mime || 'audio/webm' });
      if (!blob.size) { this.toast('这段录音是空的，先检查麦克风'); return; }
      const duration = this.audio.startedAt ? (Date.now() - this.audio.startedAt) / 1000 : 0;
      await this.store.saveAudio(this.bookId, blob, {
        pageId: this.audio.pageId || '',
        pageIndex: this.audio.pageIndex || 0,
        itemCount: this.audio.itemCount || 0,
        duration,
      });
      this.toast(`录音已存（${fmtTime(duration)}）`);
      this.touchChanged();
      if (this.panelKind === 'audio') this.renderPanel();
    } catch (e) {
      this.toast('录音保存失败：' + ((e && e.message) || '存储空间可能不够'));
    }
    this.audio.recorder = null;
    this.audio.chunks = null;
  }

  /** 播放时高亮当前那一句（面板里每句都标了它对应的页） */
  markAudioSegment(audioId, segIndex, time) {
    if (!this.panelEl || this.panelKind !== 'audio') return;
    const box = q(this.panelEl, `[data-id="${audioId}"] .nb-audio-segs`);
    if (!box) return;
    const rows = qa(box, '.nb-audio-seg');
    rows.forEach((row, i) => row.classList.toggle('on', i === segIndex));
    const active = rows[segIndex];
    if (active && active.scrollIntoView) { try { active.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    const clock = q(this.panelEl, '#nbAudioTime');
    if (clock && time != null) clock.textContent = `${fmtTime(time)}`;
  }

  async audioPlay(id) {
    if (!id) return;
    if (this.audio.playingId === id && this.audio.audioEl) { this.audioStop(); return; }
    this.audioStop();
    try {
      const blob = await this.store.getAudio(id);
      if (!blob) { this.toast('这段录音取不出来了（可能被浏览器清掉了）'); return; }
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      this.audio.audioEl = el;
      this.audio.url = url;
      this.audio.playingId = id;
      const rec = (this.nb.audio || []).find((a) => a.id === id);
      el.ontimeupdate = () => {
        const dur = Number(el.duration) || Number(rec && rec.duration) || 0;
        const ratio = dur > 0 ? el.currentTime / dur : 0;
        const bar = q(this.panelEl, `[data-id="${id}"] .nb-audio-bar`);
        if (bar) bar.value = Math.round(ratio * 100);
        const anchor = this.store.audioAnchor(this.bookId, id, ratio);
        // 有分段就按「当前说到哪一句」翻页（比整段比例更准），没有就退回整段比例
        const seg = this.store.audioSegmentAt(this.bookId, id, el.currentTime);
        const target = seg && seg.segment ? seg.segment.pageIndex : (anchor ? anchor.pageIndex : null);
        if (target != null && target !== this.cur) this.gotoPage(target);
        this.markAudioSegment(id, seg ? seg.index : -1, el.currentTime);
      };
      el.onended = () => this.audioStop();
      el.onerror = () => { this.toast('这段录音播不出来'); this.audioStop(); };
      await el.play();
      this.toast('播放中：会跟着录音进度自动翻页');
      if (this.panelKind === 'audio') this.renderPanel();
      el.ontimeupdate && el.ontimeupdate();
    } catch (e) {
      this.toast('播放失败：' + ((e && e.message) || '未知错误'));
    }
  }

  audioStop() {
    const el = this.audio.audioEl;
    this.audio.audioEl = null;
    this.audio.playingId = '';
    if (el) {
      try { el.pause(); } catch (e) {}
      el.ontimeupdate = null; el.onended = null; el.onerror = null;
    }
    if (this.audio.url) {
      try { URL.revokeObjectURL(this.audio.url); } catch (e) {}
      this.audio.url = '';
    }
  }

  /** 把一段录音转成文字（用 SiliconFlow 的 ASR；与 OCR 共用同一家的 Key） */
  async audioTranscribe(id) {
    const key = getAsrKey() || getOcrKey();
    if (!key) { this.toast('先在「识别手写文字（OCR）」里填一次 SiliconFlow Key（录音转写用的是同一家）'); return; }
    const rec = (this.nb.audio || []).find((a) => a.id === id);
    if (!rec) return;
    this.toast('正在取录音并转写…');
    try {
      const blob = await this.store.getAudio(id);
      if (!blob) { this.toast('这段录音的本体不在这台设备上（录音只存本机，不同步）'); return; }
      const model = this.asrModel || ASR_MODELS[0].id;
      // 长录音走分片：既能避免超时，又能拿到逐片精确的时间区间
      if ((Number(rec.duration) || 0) > 150 && this.chunkAsr !== false) {
        try {
          this.toast('这段录音较长，正在分片转写…');
          const res = await transcribeChunked(blob, {
            apiKey: key, model, chunkSeconds: this.asrChunkSeconds || 120,
            onProgress: ({ done, total }) => this.toast(`分片转写 ${done}/${total}…`),
          });
          if (res.text) {
            this.store.setAudioText(this.bookId, id, res.text, model);
            const segs = anchorSegments(this.store, this.bookId, id, res.segments, { duration: rec.duration || 0 });
            if (segs.length) this.store.setAudioSegments(this.bookId, id, segs);
            this.toast(`分片转写完成（${res.chunks} 片 · ${res.text.length} 字 · ${res.segments.length} 句带时间）`);
            this.renderPanel();
            try { this.onChanged(); } catch (e) {}
            return;
          }
        } catch (e) {
          this.toast('分片转写没成功，改用整段转写：' + ((e && e.message) || '未知原因'));
        }
      }
      const text = await transcribeAudio(blob, { apiKey: key, model, filename: `nb-${id}.webm` });
      if (!text) { this.toast('这段录音没转出文字（可能是纯音乐或太吵）'); return; }
      this.store.setAudioText(this.bookId, id, text, this.asrModel || ASR_MODELS[0].id);
      // 再把每一句挂到「说它时正在写的那一页 / 第几个对象」
      try {
        const detail = await transcribeAudioFull(blob, { apiKey: key, model: this.asrModel || ASR_MODELS[0].id, filename: `nb-${id}.webm`, duration: rec.duration || 0 });
        const segs = anchorSegments(this.store, this.bookId, id, detail.segments.length ? detail.segments : parseAsrSegments({ text }, { duration: rec.duration || 0 }), { duration: rec.duration || 0 });
        if (segs.length) this.store.setAudioSegments(this.bookId, id, segs);
      } catch (e) { /* 分段失败不影响已有转写 */ }
      this.toast(`转写完成（${text.length} 字）：现在这段录音的内容也能被搜到了`);
      this.renderPanel();
      try { this.onChanged(); } catch (e) {}
    } catch (e) {
      this.toast('转写失败：' + ((e && e.message) || '未知错误'));
    }
  }

  async audioDelete(id) {    if (!id) return;
    if (this.audio.playingId === id) this.audioStop();
    try { await this.store.removeAudio(this.bookId, id); } catch (e) {}
    this.toast('录音已删除');
    this.touchChanged();
    if (this.panelKind === 'audio') this.renderPanel();
  }

  /* ====================================================================
     十一、演示模式
     ==================================================================== */

  present(on) {
    const want = on == null ? !this.presenting : !!on;
    if (want === this.presenting) return this.presenting;
    this.presenting = want;
    if (this.wrap) this.wrap.classList.toggle('nb-present', want);
    if (this.root) this.root.classList.toggle('nb-present-on', want);
    if (this.hintEl) this.hintEl.hidden = !want;
    if (document && document.documentElement && document.documentElement.classList) {
      document.documentElement.classList.toggle('nb-present', want);
    }
    if (want) {
      this.closePanel();
      this.closeMenus();
      this.zoom.fit = false;
      if (this.column) this.column.classList.add('nb-hz');
      if (!this.presentBar && this.wrap) {
        const bar = document.createElement('div');
        bar.className = 'nb-present-bar';
        bar.innerHTML = `
          <button class="nb-btn icon" type="button" data-act="prev" title="上一页">‹</button>
          <button class="nb-btn" type="button" data-act="presentLaser" title="激光笔">激光笔</button>
          <span class="nb-present-count"></span>
          <button class="nb-btn icon" type="button" data-act="next" title="下一页">›</button>
          <button class="nb-btn" type="button" data-act="presentExit">退出</button>`;
        this.wrap.appendChild(bar);
        this.presentBar = bar;
      }
      if (this.presentBar) this.presentBar.hidden = false;
      try {
        if (document.documentElement.requestFullscreen) {
          const r = document.documentElement.requestFullscreen();
          if (r && r.catch) r.catch(() => {});
        }
      } catch (e) {}
      if (this.editor) this.editor.setViewScale(1);
      if (this.column) { try { this.column.scrollTop = 0; this.column.scrollLeft = 0; } catch (e) {} }
      this.scrollToPage(this.cur);
      this.bindSwipe();
    } else {
      this.stopPresent();
    }
    this.updatePresentCount();
    return this.presenting;
  }

  stopPresent() {
    if (!this.wrap) return;
    this.wrap.classList.remove('nb-present');
    if (this.root) this.root.classList.remove('nb-present-on');
    if (document && document.documentElement && document.documentElement.classList) document.documentElement.classList.remove('nb-present');
    if (this.hintEl) this.hintEl.hidden = true;
    if (this.presentBar) this.presentBar.hidden = true;
    if (this.nb && this.nb.scroll !== 'horizontal' && this.column) this.column.classList.remove('nb-hz');
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        const r = document.exitFullscreen();
        if (r && r.catch) r.catch(() => {});
      }
    } catch (e) {}
    this.unbindSwipe();
    if (this.editor) this.scheduleFit(true);
    this.presenting = false;
  }

  updatePresentCount() {
    if (!this.presentBar) return;
    const el = q(this.presentBar, '.nb-present-count');
    if (el) el.textContent = `${this.cur + 1} / ${(this.nb && this.nb.pages.length) || 1}`;
  }

  bindSwipe() {
    if (!this.wrap || this._swipe) return;
    let x0 = 0, y0 = 0, t0 = 0;
    const down = (e) => { if (!this.presenting) return; const p = e.touches ? e.touches[0] : e; x0 = p.clientX; y0 = p.clientY; t0 = Date.now(); };
    const up = (e) => {
      if (!this.presenting) return;
      const p = (e.changedTouches && e.changedTouches[0]) || e;
      const dx = p.clientX - x0, dy = p.clientY - y0;
      if (Date.now() - t0 > 800) return;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) this.gotoPage(this.cur + (dx < 0 ? 1 : -1));
      else if (Math.abs(dy) > 64 && Math.abs(dy) > Math.abs(dx)) this.gotoPage(this.cur + (dy < 0 ? 1 : -1));
    };
    this.wrap.addEventListener('touchstart', down, { passive: true });
    this.wrap.addEventListener('touchend', up, { passive: true });
    this.wrap.addEventListener('pointerdown', down);
    this.wrap.addEventListener('pointerup', up);
    this._swipe = { down, up };
  }

  unbindSwipe() {
    if (!this._swipe || !this.wrap) return;
    const s = this._swipe;
    this.wrap.removeEventListener('touchstart', s.down);
    this.wrap.removeEventListener('touchend', s.up);
    this.wrap.removeEventListener('pointerdown', s.down);
    this.wrap.removeEventListener('pointerup', s.up);
    this._swipe = null;
  }

  /* ====================================================================
     十二、导出
     ==================================================================== */

  async exportPdf(qualityId = 'high') {
    if (!this.nb) return;
    this.flush();
    const q = qualityOf(qualityId);
    this.pdfQuality = q.id;
    const total = (this.nb.pages || []).length;
    this.toast(`正在生成 PDF（${q.label}，${total} 页）…`);
    try {
      const pages = (this.nb.pages || []).map((p, i) => ({ paper: this.paperFor(i), items: p.items || [], ocr: p.ocr || null }));
      const outlines = outlinesFromNotebook(this.nb);
      const toc = this.pdfToc === false ? null : { entries: tocEntries(this.nb, { offset: 1 }), title: '目录' };
      const blob = await buildPdf(pages, {
        title: this.nb.title || '笔记本',
        qualityId: q.id,
        dropTape: !!this.dropTape,
        textLayer: this.textLayer !== false,
        plain: !!this.plainPaper,
        toc,
        outlines,
        renderPageImpl: renderPage,
        onProgress: ({ done, total: tt }) => this.toast(`生成 PDF ${done}/${tt}…`),
      });
      if (!blob) { this.toast('PDF 生成失败'); return; }
      const mb = (blob.size / 1048576).toFixed(1);
      downloadBlob(blob, `${safeName(this.nb.title)}-${q.label.replace(/[（）]/g, '')}${this.plainPaper ? '-阅读版' : ''}.pdf`);
      const extras = `${this.dropTape ? ' · 已撕掉胶带' : ''}${this.textLayer === false ? '' : ' · 含可搜索文字层'}`
        + `${toc ? ` · 目录 ${toc.entries.length} 项` : ''}${this.plainPaper ? ' · 阅读版' : ''}`;
      this.toast(`PDF 已导出（${pdfPageCount(pages, { toc })} 页 · ${q.label} · ${mb} MB${extras}）`);
    } catch (e) {
      this.toast('导出 PDF 失败：' + ((e && e.message) || '未知错误'));
    }
  }

  async exportPng() {
    this.flush();
    const page = { paper: this.paperFor(this.cur), items: ((this.nb.pages[this.cur] || {}).items || []).filter((it) => !(this.dropTape && it && it.kind === 'tape')) };
    const scale = 2;
    this.toast('正在导出 PNG…');
    try {
      const blob = await pageToPng(page, { scale, renderPage, plain: !!this.plainPaper });
      if (!blob) { this.toast('PNG 生成失败'); return; }
      downloadBlob(blob, `${safeName(this.nb.title)}-第${this.cur + 1}页.png`);
      this.toast(`当前页 PNG 已导出（${scale}×${this.plainPaper ? ' · 阅读版' : ''}）`);
    } catch (e) {
      this.toast('导出 PNG 失败：' + ((e && e.message) || '未知错误'));
    }
  }

  doPrint() {
    this.flush();
    this.toast('打印：只输出页面（可用系统打印里的「另存为 PDF」）');
    try {
      if (typeof window !== 'undefined' && window.print) window.print();
    } catch (e) { this.toast('这个环境不能直接打印'); }
  }

  deleteBook() {
    if (!this.nb) return;
    if (typeof window !== 'undefined' && !window.confirm('把整本笔记本移入垃圾桶？（可在资料库里恢复）')) return;
    try {
      this.flush();
      this.store.trash(this.bookId);
      this.toast('已移入垃圾桶');
      try { this.onChanged(); } catch (e) {}
      this.close();
      this.onExit();
    } catch (e) { this.toast('删除失败：' + ((e && e.message) || '未知错误')); }
  }

  /* ====================================================================
     十三、滚动观察与键盘
     ==================================================================== */

  observePages() {
    this.disconnectObserver();
    if (typeof IntersectionObserver !== 'function' || !this.lane) return;
    try {
      this._io = new IntersectionObserver((entries) => {
        if (!this.opened) return;
        let best = -1, bestRatio = 0.55;
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const i = Number(en.target.dataset.page);
          if (Number.isFinite(i) && en.intersectionRatio > bestRatio) { bestRatio = en.intersectionRatio; best = i; }
        }
        if (best >= 0 && best !== this.cur) this.gotoPage(best, false);
      }, { root: this.column || null, threshold: [0, 0.35, 0.6, 0.9] });
      qa(this.lane, '.nb-page').forEach((p) => this._io.observe(p));
    } catch (e) { this._io = null; }
  }

  /** 朗读本页（浏览器自带 TTS）：文字 + 手写识别，逐句高亮 */
  speakPage() {
    if (!this.speaker) this.speaker = makeSpeaker();
    if (!this.speaker.supported) { this.toast('这个浏览器没有语音合成（TTS），可以先看转写文字'); return false; }
    const page = (this.nb.pages || [])[this.cur] || {};
    const text = pageSpeakText(page, { includeOcr: this.textLayer !== false, includeText: true });
    if (!String(text).trim()) { this.toast('这一页还没有可读的文字：先打字或用 OCR 识别手写'); return false; }
    this.speaker.stop();
    this.speaker = makeSpeaker({
      onSentence: (i, s) => {
        this.speak = { sentences: this.speaker.sentences, index: i };
        this.markSpeakRow(i);
      },
      onEnd: () => { this.speak = { sentences: this.speak ? this.speak.sentences : [], index: -1 }; this.markSpeakRow(-1); },
    });
    const ok = this.speaker.speak(text);
    if (!ok) { this.toast('没切出可读的句子'); return false; }
    this.speak = { sentences: this.speaker.sentences, index: -1 };
    if (this.panelKind === 'audio') this.renderPanel();
    this.toast(`朗读中：共 ${this.speaker.sentences.length} 句（点句可从那句接着读）`);
    return true;
  }

  speakFrom(i) {
    if (!this.speaker) { this.speakPage(); return; }
    const list = (this.speak && this.speak.sentences) || this.speaker.sentences;
    if (!list.length) return;
    this.speaker.stop();
    this.speaker = makeSpeaker({
      onSentence: (idx) => { this.speak = { sentences: this.speaker.sentences, index: idx }; this.markSpeakRow(idx); },
      onEnd: () => { this.markSpeakRow(-1); },
    });
    this.speaker.speak(list.join('\n'), { from: i });
    this.speak = { sentences: this.speaker.sentences, index: i };
    if (this.panelKind === 'audio') this.renderPanel();
  }

  markSpeakRow(i) {
    const box = q(this.panelEl, '#nbSpeakSegs');
    if (!box) return;
    qa(box, '.nb-audio-seg').forEach((row, k) => row.classList.toggle('on', k === i));
  }

  disconnectObserver() {
    if (this._io) { try { this._io.disconnect(); } catch (e) {} this._io = null; }
  }

  handleKey(e) {
    if (!this.opened || !e) return;
    const t = e.target || {};
    const tag = String(t.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
    const k = String(e.key || '');
    const mod = !!(e.ctrlKey || e.metaKey);

    // Ctrl/Cmd+F：直接打开本笔记本内搜索（含手写与录音转写）
    if (mod && k.toLowerCase() === 'f') {
      e.preventDefault && e.preventDefault();
      return this.openBookSearch();
    }
    if (this.panelKind === 'search' && (k === 'ArrowDown' || k === 'ArrowUp')) {
      e.preventDefault && e.preventDefault();
      return this.searchMove(k === 'ArrowDown' ? 1 : -1);
    }
    if (this.panelKind === 'search' && k === 'Enter') {
      e.preventDefault && e.preventDefault();
      return this.searchGo();
    }

    if (k === 'Escape') {
      if (this.panelKind) { this.closePanel(); return; }
      if (this.presenting) { this.present(false); return; }
    }
    if (this.presenting && !typing) {
      if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault && e.preventDefault(); return this.gotoPage(this.cur + 1); }
      if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault && e.preventDefault(); return this.gotoPage(this.cur - 1); }
      return;
    }
    if (typing) return;
    if (this.panelKind && k === 'ArrowDown' && !qa(this.panelEl, 'input, textarea, select').length) return;
    if (k === 'PageDown') return this.gotoPage(this.cur + 1);
    if (k === 'PageUp') return this.gotoPage(this.cur - 1);
  }
}

export default NotebookView;
