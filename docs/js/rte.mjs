/**
 * 富文本编辑内核（所见即所得）
 * 目标：用户永远不需要看见 ## 或 ** 这类符号，直接点按钮改字号、加粗、列表、对齐。
 *
 * 实现要点：
 * 1. 编辑面是一个 contenteditable 的块容器，子节点为 <p>/<h2>/<ul>/...（浏览器原生结构）
 * 2. 工具栏命令优先用 document.execCommand（现代浏览器仍然可用且行为一致），
 *    字号用 inline style（em 单位）表达，保存时由 lib/html-to-md.mjs 转回 Markdown
 * 3. 粘贴时清洗 HTML，只留允许的标签与样式，避免把外部样式带进笔记
 */
import { htmlToMarkdown } from '../lib/html-to-md.mjs';

/* 允许出现在编辑内容里的标签（其余一律降级为纯文本） */
const ALLOWED = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'H4', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'MARK', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'A', 'IMG', 'SPAN', 'DIV', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUP', 'SUB']);
const ALLOWED_STYLE = /^(font-size|font-weight|font-style|text-decoration|text-align|color|background-color|line-height)$/i;

/** 清洗粘贴/输入的 HTML */
export function sanitizeHtml(html) {
  if (typeof document === 'undefined') return String(html || '');
  const box = document.createElement('div');
  box.innerHTML = String(html || '');
  const clean = (node, depth) => {
    if (depth > 20) return;
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === 8) { child.remove(); return; }           // 注释
      if (child.nodeType !== 1) return;
      const tag = child.tagName;
      if (!ALLOWED.has(tag)) {
        const frag = document.createDocumentFragment();
        while (child.firstChild) frag.appendChild(child.firstChild);
        child.replaceWith(frag);
        clean(node, depth + 1);
        return;
      }
      // 只保留白名单样式
      if (child.style && child.style.length) {
        [...child.style].forEach((prop) => {
          if (!ALLOWED_STYLE.test(prop)) child.style.removeProperty(prop);
        });
        if (!child.getAttribute('style')) child.removeAttribute('style');
      }
      [...child.attributes].forEach((a) => {
        const n = a.name.toLowerCase();
        const ok = n === 'style' || n === 'href' || n === 'src' || n === 'alt' || n === 'title'
          || n === 'class' || n === 'data-tex' || n === 'data-wikilink' || n === 'colspan' || n === 'rowspan';
        if (!ok) child.removeAttribute(a.name);
      });
      clean(child, depth + 1);
    });
  };
  clean(box, 0);
  return box.innerHTML;
}

/** 把编辑器里的 DOM 转成 Markdown（保存用） */
export function editorToMarkdown(root) {
  return htmlToMarkdown(root);
}

/* ============================ 字号阶梯 ============================ */
export const FONT_SIZES = [
  { label: '小', em: 0.9 },
  { label: '正常', em: 1 },
  { label: '大', em: 1.15 },
  { label: '特大', em: 1.3 },
  { label: '超大', em: 1.5 },
  { label: '标题级', em: 1.8 },
];

/** 对当前选区套用字号（em，随主题缩放） */
export function applyFontSize(editor, em) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return false;

  // 用 span 包住选区（保留原有的加粗等行内标签）
  const span = document.createElement('span');
  span.style.fontSize = `${em}em`;
  try {
    range.surroundContents(span);
  } catch (e) {
    // 跨多个块时 surroundContents 会失败：退化为逐段加样式
    const frag = range.extractContents();
    frag.querySelectorAll('p, h1, h2, h3, h4, li, blockquote').forEach((el) => {
      el.style.fontSize = `${em}em`;
    });
    if (!frag.querySelector('p, h1, h2, h3, h4, li, blockquote')) {
      const holder = document.createElement('span');
      holder.style.fontSize = `${em}em`;
      holder.appendChild(frag);
      range.insertNode(holder);
    } else {
      range.insertNode(frag);
    }
  }
  // 把纯空样式的 span 清理掉
  editor.querySelectorAll('span[style]').forEach((s) => {
    if (!s.getAttribute('style') || !s.style.fontSize) {
      if (!s.attributes.length) s.replaceWith(...s.childNodes);
    }
    if (s.style.fontSize === '1em') { s.style.removeProperty('font-size'); if (!s.getAttribute('style')) s.replaceWith(...s.childNodes); }
  });
  return true;
}

/** 给选区加/去高亮（对应 Markdown 的 ==高亮==） */
export function toggleHighlight(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return false;

  // 已在 mark 内 → 取消
  let node = range.commonAncestorContainer;
  let mark = null;
  while (node && node !== editor) {
    if (node.nodeType === 1 && node.tagName === 'MARK') { mark = node; break; }
    node = node.parentNode;
  }
  if (mark) {
    mark.replaceWith(...mark.childNodes);
    return true;
  }
  if (sel.isCollapsed) return false;
  const el = document.createElement('mark');
  try {
    range.surroundContents(el);
  } catch (e) {
    const frag = range.extractContents();
    el.appendChild(frag);
    range.insertNode(el);
  }
  return true;
}

/* ============================ 块类型 ============================ */
export const BLOCKS = [
  { id: 'p', label: '正文', cmd: 'formatBlock', arg: 'p' },
  { id: 'h2', label: '大标题', cmd: 'formatBlock', arg: 'h2' },
  { id: 'h3', label: '小标题', cmd: 'formatBlock', arg: 'h3' },
  { id: 'blockquote', label: '引用块', cmd: 'formatBlock', arg: 'blockquote' },
  { id: 'pre', label: '代码块', cmd: 'formatBlock', arg: 'pre' },
];

export function execCommand(name, arg) {
  try {
    document.execCommand('styleWithCSS', false, true);
  } catch (e) {}
  try {
    return document.execCommand(name, false, arg);
  } catch (e) {
    return false;
  }
}

/** 当前选区所在的块标签（用于工具栏高亮状态） */
export function currentBlock(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return '';
  let node = sel.getRangeAt(0).startContainer;
  while (node && node !== editor) {
    if (node.nodeType === 1 && /^(P|H1|H2|H3|H4|LI|BLOCKQUOTE|PRE)$/.test(node.tagName)) return node.tagName.toLowerCase();
    node = node.parentNode;
  }
  return '';
}

/** 当前选区是否处于某标签内 */
export function isInTag(editor, tag) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  let node = sel.getRangeAt(0).startContainer;
  while (node && node !== editor) {
    if (node.nodeType === 1 && node.tagName === tag.toUpperCase()) return true;
    node = node.parentNode;
  }
  return false;
}

/** 粘贴清洗：插入纯净化后的 HTML，避免外部样式污染 */
export function handlePaste(editor, event) {
  const dt = event.clipboardData;
  if (!dt) return;
  event.preventDefault();
  const html = dt.getData('text/html');
  const text = dt.getData('text/plain');
  if (html) execCommand('insertHTML', sanitizeHtml(html));
  else execCommand('insertText', text.replace(/\r/g, ''));
}

/** 在光标处插入一段 HTML（图片、公式、表格等） */
export function insertAtCaret(editor, html) {
  editor.focus();
  return execCommand('insertHTML', html);
}

/** 为编辑面补齐结构：确保内容是块级子节点（否则浏览器会把整段塞进一个 div） */
export function normalizeEditorHtml(html) {
  const src = String(html || '').trim();
  if (!src) return '<p><br></p>';
  if (/^\s*<(p|h[1-6]|ul|ol|blockquote|pre|figure|div|table|hr)[\s>]/i.test(src)) return src;
  return `<p>${src}</p>`;
}
