/**
 * HTML ⇄ Markdown：给「所见即所得编辑器」用
 * 用户在页面上改字号、加粗、列表、引用…编辑器内部是 DOM；
 * 保存时必须转回 Markdown —— 这个模块负责这件事，并且要求「转一圈内容不丢」。
 *
 * 浏览器里用真实 DOM（document.createElement），Node 里用内置的极简解析器，
 * 两条路径产出的 Markdown 必须一致（tools/test-wysiwyg.mjs 会验证）。
 */

/* ============================ 内联元素 → Markdown ============================ */
const NO_SPACE_RUN = /\s+/g;   // 复用正则，避免每次调用都重新编译（长文里这是热点）
const TRAILING_SPACES = /[ \t]+$/gm;

function inlineToMd(node) {
  let out = '';
  const kids = node.childNodes || node.children || [];
  for (const child of kids) {
    if (child.nodeType === 3) {
      out += String(child.nodeValue || '').replace(NO_SPACE_RUN, ' ');
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (child.classList && child.classList.contains('md-anchor')) continue; // 标题后的 # 锚点，不进正文
    if (child.classList && (child.classList.contains('md-code-copy') || child.classList.contains('md-code-bar'))) continue;
    // 公式：还原成 $...$ / $$...$$
    if (child.classList && (child.classList.contains('md-math-inline') || child.classList.contains('md-math-block'))) {
      const tex = child.getAttribute('data-tex');
      if (tex !== null && tex !== undefined && tex !== '') {
        out += child.classList.contains('md-math-block') ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
      } else {
        out += inlineToMd(child); // 没有原始 LaTeX 时至少保住渲染出的文本
      }
      continue;
    }
    const inner = inlineToMd(child);
    const text = inner.trim();
    switch (tag) {
      case 'strong': case 'b':
        out += `**${text}**`; break;                      // 元素内的文本一律加粗（空格留给外层）
      case 'em': case 'i':
        out += `*${text}*`; break;
      case 'del': case 's': case 'strike':
        out += `~~${text}~~`; break;
      case 'mark':
        out += `==${text}==`; break;
      case 'code': {
        // 行内代码：内容里若含反引号，围栏要加宽到「最长反引号游程 +1」并两侧补空格，
        // 否则回写后会丢掉那层反引号（例如 `` `x` `` 不能写成 ` `x` `）
        const codeText = String(child.textContent);
        const longest = (codeText.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
        const fence = '`'.repeat(longest + 1);
        const pad = longest > 0 ? ' ' : '';
        out += `${fence}${pad}${codeText}${pad}${fence}`;
        break;
      }
      case 'br':
        out += '  \n'; break;
      case 'img':
        out += `![${child.getAttribute('alt') || ''}](${child.getAttribute('src') || ''})`; break;
      case 'a': {
        const href = child.getAttribute('href') || '';
        const wiki = child.classList && child.classList.contains('md-wikilink');
        out += wiki ? `[[${child.getAttribute('data-wikilink') || child.textContent}]]` : `[${text || inner}](${href})`;
        break;
      }
      default:
        out += inner; // 含 span / div / 未知标签：只取文本，样式不进 Markdown
    }
  }
  return out;
}

/* ============================ 列表 / 表格 ============================ */
function listToMd(list, indent = 0) {
  const pad = '  '.repeat(indent);
  const ordered = list.tagName.toLowerCase() === 'ol';
  let out = '';
  let n = 1;
  for (const li of [...list.children]) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const box = li.querySelector(':scope > .md-todo');
    // 用「整段行内 Markdown」而不是手拼部分子节点，保证 <strong> 等行内标记不丢
    let text = inlineToMd(li).replace(/\s+/g, ' ').trim();
    if (box) text = `[${hasClass(box, 'done') ? 'x' : ' '}] ${text}`;
    out += `${pad}${ordered ? `${n++}. ` : '- '}${text}\n`;
    for (const sub of [...li.children]) {
      const t = sub.tagName.toLowerCase();
      if (t === 'ul' || t === 'ol') out += listToMd(sub, indent + 1);
    }
  }
  return out;
}

function tableToMd(table) {
  const rows = [...table.querySelectorAll('tr')];
  if (!rows.length) return '';
  const cellsOf = (tr) => [...tr.children].map((c) => inlineToMd(c).trim().replace(/\|/g, '\\|'));
  const head = cellsOf(rows[0]);
  const aligns = [...rows[0].children].map((c) => {
    const a = (c.style && c.style.textAlign) || '';
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
  });
  let out = `| ${head.join(' | ')} |\n| ${aligns.join(' | ')} |\n`;
  for (const tr of rows.slice(1)) out += `| ${cellsOf(tr).join(' | ')} |\n`;
  return out;
}

const CALLOUT_LABEL = { info: 'NOTE', tip: 'TIP', important: 'IMPORTANT', warn: 'WARNING', danger: 'CAUTION', todo: 'TODO' };

/** 一个元素是否包含块级子元素（用于判断 <p> 里是不是被包了块级结构） */
function hasBlockChild(el) {
  return [...el.children].some((c) => /^(p|div|section|figure|pre|table|ul|ol|blockquote|h[1-6]|hr)$/.test(c.tagName.toLowerCase()));
}

/* ============================ 块级 → Markdown ============================ */
export function htmlToMarkdown(root) {
  const el = typeof root === 'string' ? htmlToElement(root) : root;
  if (!el) return '';
  const blocks = [];

  /** 把一个块级节点转换成 Markdown 文本块 */
  const convert = (node) => {
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      blocks.push(`${'#'.repeat(Number(tag[1]))} ${inlineToMd(node).trim()}`);
    } else if (tag === 'p') {
      if (hasBlockChild(node)) { for (const c of [...node.children]) convert(c); return; }
      const t = inlineToMd(node).trim();
      if (t) blocks.push(t);
    } else if (tag === 'ul' || tag === 'ol') {
      if (hasClass(node, 'md-index-list')) {   // 自动目录块：还原成「## 目录 + 列表」
        const items = [...node.children].map((li) => `- ${inlineToMd(li).replace(/\s+/g, ' ').trim()}`);
        if (items.length) blocks.push(`## 目录\n\n${items.join('\n')}`);
      } else {
        blocks.push(listToMd(node).trimEnd());
      }
    } else if (tag === 'blockquote') {
      // 把整段行内内容按「> 前缀」写回（多段之间用空行分隔）
      const paras = [...node.children].filter((c) => /^(p|div|section)$/.test(c.tagName.toLowerCase()));
      const lines = [];
      if (paras.length > 1) {
        for (const p of paras) {
          const t = inlineToMd(p).replace(/\s+/g, ' ').trim();
          if (t) lines.push(t);
        }
        blocks.push(lines.map((l) => `> ${l}`).join('\n>\n'));
      } else {
        const t = inlineToMd(node).replace(/\s+/g, ' ').trim();
        if (t) blocks.push(`> ${t}`);
      }
    } else if (tag === 'pre') {
      const codeEl = node.querySelector('code') || node;
      const langMatch = String(codeEl.className || codeEl.getAttribute('class') || '').match(/language-([\w+-]+)/);
      const lang = (langMatch && langMatch[1]) || '';   // 注意：不能写 String(match)[1]（那取的是字符串下标）
      blocks.push('```' + lang + '\n' + String(codeEl.textContent).replace(/^\n+|\s+$/g, '') + '\n```');
    } else if (tag === 'hr') {
      blocks.push('---');
    } else if (tag === 'figure') {
      if (hasClass(node, 'md-code')) {
        // 代码块容器：从内层 pre/code 取语言与代码
        const pre = node.querySelector('pre');
        if (pre) convert(pre);
      } else {
        const img = node.querySelector('img');
        if (img) {
          const cap = node.querySelector('figcaption');
          blocks.push(`![${cap ? cap.textContent.trim() : img.getAttribute('alt') || ''}](${img.getAttribute('src') || ''})`);
        } else {
          const t = inlineToMd(node).trim();
          if (t) blocks.push(t);
        }
      }
    } else if (tag === 'img') {
      blocks.push(`![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`);
    } else if (tag === 'table') {
      blocks.push(tableToMd(node).trimEnd());
    } else if (tag === 'div' || tag === 'section') {
      if (hasClass(node, 'md-callout')) {
        const kind = [...(node.classList ? node.classList : [])].map((c) => String(c).match(/^md-callout-(\w+)$/)).filter(Boolean).map((m) => m[1])[0] || 'info';
        // 用渲染时记录的原始标签/标题，避免默认标题被重复写一遍（否则会得到 TIP技巧技巧）
        const rawLabel = node.getAttribute('data-callout') || CALLOUT_LABEL[kind] || 'NOTE';
        const rawTitle = node.getAttribute('data-callout-title');
        const titleEl = node.querySelector('.md-callout-title');
        const shownTitle = titleEl ? titleEl.textContent.trim() : '';
        const defaultLabel = CALLOUT_LABEL[kind] || 'NOTE';
        const title = rawTitle !== null && rawTitle !== undefined && rawTitle !== '' ? rawTitle : shownTitle;
        // 只在标题不是「默认标签」时才写到 > [!X] 后面，避免出现 TIP技巧技巧
        const needTitle = !!title && title !== defaultLabel && title !== rawLabel;
        const header = needTitle ? `> [!${rawLabel}] ${title}` : `> [!${rawLabel}]`;

        // 内部内容：整段转 Markdown，再按需剔除第一行的标题（若已写进 header）
        let innerMd = htmlToMarkdown(node).trim();
        const firstLine = innerMd.split('\n')[0] || '';
        if (needTitle && firstLine.trim() === title) {
          innerMd = innerMd.split('\n').slice(1).join('\n').replace(/^\s*\n+/, '').trim();
        }
        const quoted = innerMd
          .split('\n')
          .map((l) => (l.trim() ? (l.trimStart().startsWith('>') ? `>${l}` : `> ${l}`) : '>'))
          .join('\n');
        blocks.push(quoted ? `${header}\n${quoted}` : header);
        return;
      }
      if (hasClass(node, 'md-attach-text')) return;                       // 构建生成的附加区块，不写回
      if (hasClass(node, 'md-code')) {                                    // 代码块容器
        const pre = node.querySelector('pre');
        if (pre) convert(pre);
        return;
      }
      if (hasClass(node, 'md-table-wrap')) {
        const table = node.querySelector('table');
        if (table) blocks.push(tableToMd(table).trimEnd());
        return;
      }
      if (hasClass(node, 'md-math-block')) {                              // 公式：保留原始 LaTeX
        const tex = node.getAttribute('data-tex') || '';
        if (tex) blocks.push(`$$\n${tex}\n$$`);
        return;
      }
      if (hasClass(node, 'md-index-list')) {                              // 自动目录：恢复成「## 目录 + 列表」
        const items = [...node.children].map((li) => `- ${inlineToMd(li).replace(/\s+/g, ' ').trim()}`);
        if (items.length) blocks.push(`## 目录\n\n${items.join('\n')}`);
        return;
      }
      // 普通 div：下钻块级子元素，或当段落处理
      if (hasBlockChild(node)) { for (const c of [...node.children]) convert(c); return; }
      const t = inlineToMd(node).trim();
      if (t) blocks.push(t);
    } else if (tag === 'figcaption') {
      // 已在 figure 里处理
    } else if (tag === 'script' || tag === 'style' || tag === 'button') {
      // 编辑器控件等，不进正文
    } else {
      if (hasBlockChild(node)) { for (const c of [...node.children]) convert(c); return; }
      const t = inlineToMd(node).trim();
      if (t) blocks.push(t);
    }
  };

  for (const node of [...el.children]) convert(node);
  return blocks.join('\n\n') + '\n';
}

/* ============================ HTML → 元素树 ============================ */
/**
 * 浏览器：document.createElement + innerHTML（原生解析，绝对可靠）
 * Node（测试用）：DOMParser 若可用则使用；否则退回极简解析器并对嵌套标签做递归处理
 */
export function htmlToElement(html) {
  if (typeof document !== 'undefined' && document.createElement) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d;
  }
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    return doc.body;
  }
  return parseMini(html);
}

/** mkEl 的 children 只放元素节点，childNodes 放全部节点 */
const TEXT_NODE = 3;
const ELEM_NODE = 1;

function mkText(value, parent) {
  return { nodeType: TEXT_NODE, nodeValue: decodeEnt(value), parentNode: parent };
}

function parseMini(html) {
  const VOID = new Set(['br', 'img', 'hr', 'input', 'link', 'meta']);
  const root = mkEl('div');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const full = m[0];
    if (full.startsWith('<!')) continue;
    const tagName = m[1];
    const attrs = m[2] || '';
    const text = m[3];
    if (text !== undefined) {
      if (text.trim()) push(stack[stack.length - 1], { nodeType: 3, nodeValue: decodeEnt(text) });
      continue;
    }
    const name = String(tagName).toLowerCase();
    if (full.startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName.toLowerCase() === name) { stack.length = i; break; }
      continue;
    }
    const el = mkEl(name);
    parseAttrs(attrs, el);
    push(stack[stack.length - 1], el);
    if (!VOID.has(name) && !full.endsWith('/>')) stack.push(el);
  }
  return root;
}

function push(parent, child) {
  child.parentNode = parent;
  parent.childNodes.push(child);
}

function mkEl(tag) {
  const classes = new Set();
  const children = [];
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: children,
    /** 只含元素节点（与 DOM 的 children 语义一致） */
    get children() { return children.filter((c) => c.nodeType === 1); },
    attrs: {},
    style: {},
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    get className() { return [...classes].join(' '); },
    get classes() { return classes; },
    get textContent() {
      return children.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent || '')).join('');
    },
    /** 序列化用：把子节点还原成 HTML 字符串 */
    get innerHTML() {
      return children
        .map((c) => (c.nodeType === 3 ? encodeEnt(c.nodeValue) : c.outerHTML))
        .join('');
    },
    get outerHTML() {
      const attrs = Object.entries(el.attrs)
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`))
        .join('');
      return `<${el.tagName.toLowerCase()}${attrs}>${el.innerHTML}</${el.tagName.toLowerCase()}>`;
    },
    getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
    setAttribute(k, v) { el.attrs[k] = v; },
    removeAttribute(k) { delete el.attrs[k]; },
    cloneNode() {
      const copy = mkEl(el.tagName.toLowerCase());
      for (const [k, v] of Object.entries(el.attrs)) copy.setAttribute(k, v);
      for (const c of children) {
        push(copy, c.nodeType === 3 ? { nodeType: 3, nodeValue: c.nodeValue } : c.cloneNode(true));
      }
      return copy;
    },
    querySelector(sel) { return queryAll(el, sel, true)[0] || null; },
    querySelectorAll(sel) { return queryAll(el, sel, false); },
  };
  return el;
}

function encodeEnt(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseAttrs(str, el) {
  // 支持 val="x" / val='x' / val=x / 只有属性名
  const re = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    const key = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    el.attrs[key] = decodeEnt(val);
    if (key === 'class') val.split(/\s+/).forEach((c) => c && el.classList.add(c));
    if (key === 'style') {
      for (const kv of val.split(';')) {
        const [k, v] = kv.split(':');
        if (k && v) el.style[k.trim().replace(/-([a-z])/g, (x, y) => y.toUpperCase())] = v.trim();
      }
    }
  }
}

/** 选择器只支持：'tag'、'.class'、'tag.class'、':scope > x'（够用即可） */
function matches(el, rawSel) {
  const sel = rawSel.trim();
  const tagPart = (/^[a-zA-Z][\w-]*/.exec(sel) || [])[0];
  const classParts = [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (tagPart && el.tagName.toLowerCase() !== tagPart.toLowerCase()) return false;
  for (const c of classParts) if (!el.classList.contains(c)) return false;
  return true;
}
function queryAll(root, sel, firstOnly) {
  const scopeChild = /^:scope\s*>\s*/.test(sel);
  const clean = sel.replace(/^:scope\s*>\s*/, '');
  const out = [];
  const walk = (node, isDirect) => {
    for (const c of node.children) {
      if (c.nodeType !== 1) continue;
      if (scopeChild) {
        if (isDirect && matches(c, clean)) out.push(c);
        if (!firstOnly || out.length === 0) walk(c, false);
      } else {
        if (matches(c, clean)) out.push(c);
        walk(c, false);
      }
      if (firstOnly && out.length) return;
    }
  };
  walk(root, true);
  return out;
}

function hasClass(el, c) {
  return !!(el.classList && el.classList.contains(c));
}
function decodeEnt(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/* ============================ 结构安全检查 ============================ */
/**
 * 判断一段 Markdown 是否只用了「所见即所得编辑器」能表达的结构。
 * 编辑时若发现用了表格/代码块/公式等复杂结构，编辑器会提示「用源码模式编辑更保险」。
 */
export function complexFeatures(md) {
  const s = String(md);
  return {
    code: /```/.test(s),
    math: /\$/.test(s),
    table: /^\s*\|.*\|\s*$/m.test(s),
    callout: /^>\s*\[!/m.test(s),
    toc: /^##\s*(目录|索引)\s*$/m.test(s),
    html: /<[a-zA-Z][^>]*>/.test(s),
    reference: /^\s*\[[^\]]+\]:\s*\S+/m.test(s),
  };
}
