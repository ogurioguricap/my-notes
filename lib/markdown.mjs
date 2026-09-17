/**
 * Markdown 渲染内核（同构模块：构建脚本与浏览器共用）
 * 零依赖，只用标准 JS，因此 Node 与浏览器都能直接加载。
 * 浏览器侧用于在线编辑器的实时预览；构建侧用于生成 docs/data/index.json。
 */

const SENT = '\u0000'; // 占位符哨兵：先把代码块/公式抽出来，最后再还原

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 中文友好的标题 slug：保留中英文数字，其余转连字符 */
export function slugify(text, fallback = 'sec') {
  const s = String(text)
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{Script=Han}\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || fallback;
}

export function stripMd(text) {
  return String(text)
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (m, a, b) => b || a)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ============================ frontmatter ============================ */
export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(scalar(listItem[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_\-\u4e00-\u9fa5]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];
    currentKey = key;
    if (val === '') data[key] = [];
    else if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '');
    } else data[key] = scalar(val);
  }
  return { data, body: raw.slice(m[0].length) };
}

function scalar(v) {
  let s = String(v).trim();
  if (/^"(.*)"$/.test(s) || /^'(.*)'$/.test(s)) s = s.slice(1, -1);
  return s;
}

/** 把表单字段序列化成 frontmatter 文本（在线编辑器保存时用） */
export function serializeFrontmatter(fields) {
  const lines = ['---'];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      lines.push(`${k}: [${v.map((x) => String(x).trim()).filter(Boolean).join(', ')}]`);
    } else lines.push(`${k}: ${v}`);
  };
  push('title', fields.title);
  if (fields.slug) push('slug', fields.slug);
  push('category', fields.category || '未分类');
  push('tags', Array.isArray(fields.tags) ? fields.tags : String(fields.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean));
  push('date', fields.date);
  if (fields.pinned === true || fields.pinned === 'true') push('pinned', 'true');
  push('summary', fields.summary);
  push('related', fields.related);
  lines.push('---', '');
  return lines.join('\n');
}

/* ============================ 保护代码块与公式 ============================ */
export function extractProtected(src) {
  const store = [];
  const keep = (html) => `${SENT}${store.push(html) - 1}${SENT}`;
  let s = src;

  s = s.replace(/(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?\2[ \t]*(?=\n|$)/g, (m, pre, fence, info, code) => {
    const lang = String(info || '').trim().split(/\s+/)[0] || 'text';
    const meta = String(info || '').trim().slice(lang.length).trim();
    return (
      pre +
      keep(
        `<figure class="md-code" data-lang="${esc(lang)}"${meta ? ` data-meta="${esc(meta)}"` : ''}>` +
          `<figcaption class="md-code-bar"><span class="md-code-lang">${esc(lang)}</span>` +
          `<button class="md-code-copy" type="button" data-copy>复制</button></figcaption>` +
          `<pre><code class="language-${esc(lang)}">${esc(code.replace(/^\n+|\s+$/g, ''))}</code></pre>` +
          `</figure>`
      )
    );
  });

  s = s.replace(/(`+)([^\n]*?)\1/g, (m, t, code) => keep(`<code class="md-inline-code">${esc(code.trim())}</code>`));
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => keep(`<div class="md-math-block" data-tex="${esc(tex.trim())}"></div>`));
  s = s.replace(/(?<!\\)\$(?!\s)([^\n$]+?)(?<!\s)\$/g, (m, tex) => keep(`<span class="md-math-inline" data-tex="${esc(tex.trim())}"></span>`));

  return { text: s, store, restore: restorePlaceholders };

  /** 还原占位符：函数式 replace，保证还原进来的是元素本身而不是被转成字符串 */
  function restorePlaceholders(html) {
    return html.replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (m, i) => store[Number(i)] ?? '');
  }
}

/* ============================ 行内解析 ============================ */
export function inline(text, ctx) {
  let s = text;

  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, alt, src, title) => {
    const url = ctx.resolve(src);
    return (
      `<figure class="md-figure">` +
      `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async"${title ? ` title="${esc(title)}"` : ''}` +
      ` data-zoom-src="${esc(url)}">` +
      (alt ? `<figcaption>${esc(alt)}</figcaption>` : '') +
      `</figure>`
    );
  });

  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, label, href, title) => {
    const out = ctx.resolve(href);
    const external = /^https?:\/\//i.test(out);
    let extra = title ? ` title="${esc(title)}"` : '';
    if (external) extra += ' target="_blank" rel="noopener noreferrer"';
    if (!external && /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt)$/i.test(out)) extra += ' class="md-attachment"';
    return `<a href="${esc(out)}"${extra}>${label}</a>`;
  });

  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (m, target, label) =>
    `<a class="md-wikilink" data-wikilink="${esc(String(target).trim())}" href="#/note/${encodeURIComponent(String(target).trim())}">${esc(label || target)}</a>`
  );

  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/(?<![_\w])_(?=\S)([^_\n]*?\S)_(?!_)/g, '<em>$1</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');
  s = s.replace(/ {2,}$/gm, '<br>');

  return s;
}

/* ============================ 块级解析 ============================ */
export function renderMarkdown(src, ctx) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const links = [];
  let i = 0;
  let h1Seen = false;
  const para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join('\n'), ctx).replace(/\n/g, '<br>')}</p>`);
    para.length = 0;
  };

  const calloutKind = (label) => {
    const t = label.replace(/^!/, '').trim();
    if (/^(NOTE|信息|说明)$/i.test(t)) return 'info';
    if (/^(TIP|HINT|技巧|提示)$/i.test(t)) return 'tip';
    if (/^(IMPORTANT|重要)$/i.test(t)) return 'important';
    if (/^(WARNING|注意|警告)$/i.test(t)) return 'warn';
    if (/^(CAUTION|危险|坑)$/i.test(t)) return 'danger';
    if (/^(TODO|待办)$/i.test(t)) return 'todo';
    return null;
  };

  const collectWikilinks = (html) => {
    const re = /data-wikilink="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) if (!links.includes(m[1])) links.push(m[1]);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flushPara(); i++; continue; }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      const text = h[2].trim();
      const title = stripMd(text);
      if (level === 1 && !h1Seen) h1Seen = true;

      if (level >= 2 && /^(目录|索引|Index|Contents)$/i.test(title)) {
        const collected = [];
        let j = i + 1;
        while (j < lines.length && !/^#{1,6}\s+/.test(lines[j])) {
          const it = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/.exec(lines[j]);
          if (it) collected.push({ checked: it[1], label: stripMd(it[2]) });
          j++;
        }
        if (collected.length) {
          const items = collected
            .map((c) => {
              const mark = c.checked === undefined ? '' : `<span class="md-todo ${/x/i.test(c.checked) ? 'done' : ''}"></span>`;
              return `<li>${mark}<span>${esc(c.label)}</span></li>`;
            })
            .join('');
          out.push(`<ul class="md-index-list">${items}</ul>`);
          i = j;
          continue;
        }
      }

      const id = slugify(title, `h${level}-${headings.length + 1}`);
      const uid = headings.some((x) => x.id === id) ? `${id}-${headings.length + 1}` : id;
      if (level >= 1 && level <= 4) headings.push({ level, text: title, id: uid });
      out.push(`<h${level} id="${esc(uid)}">${inline(text, ctx)}<a class="md-anchor" href="#${esc(uid)}" aria-label="锚点">#</a></h${level}>`);
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (buf.length && /^\s*$/.test(lines[i]) && /^\s*>/.test(lines[i + 1] || '')))) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const first = buf[0] || '';
      const tag = /^\[!([^\]]+)\]\s*(.*)$/.exec(first);
      const kind = tag ? calloutKind(tag[1]) : null;
      if (kind) {
        const titleText = tag[2] || tag[1].replace(/^!/, '');
        // data-callout 记录原始标签，供「所见即所得」编辑器回写 Markdown 时原样还原
        out.push(
          `<div class="md-callout md-callout-${kind}" data-callout="${esc(tag[1].replace(/^!/, ''))}"` +
            ` data-callout-title="${esc(titleText)}">` +
            `<p class="md-callout-title">${esc(titleText)}</p>` +
            `${renderMarkdown(buf.slice(1).join('\n'), ctx).html}</div>`
        );
      } else {
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'), ctx).html}</blockquote>`);
      }
      continue;
    }

    if (/\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
      flushPara();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      const th = header.map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c, ctx)}</th>`).join('');
      const tb = rows
        .map(
          (r) =>
            `<tr>${header
              .map((_, k) => {
                let cell = r[k] ?? '';
                const mark = /^\s*\[([ xX])\]\s*(.*)$/.exec(cell);
                if (mark) cell = `<span class="md-todo ${/x/i.test(mark[1]) ? 'done' : ''}"></span>${inline(mark[2], ctx)}`;
                else cell = inline(cell, ctx);
                return `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${cell}</td>`;
              })
              .join('')}</tr>`
        )
        .join('');
      out.push(`<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushPara();
      const ordered0 = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      let cur = null;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1] || '')) { i++; continue; }
          break;
        }
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (m) {
          if (cur) items.push(cur);
          cur = { indent: m[1].length, text: m[3], sub: [] };
        } else if (/^\s{2,}\S/.test(l) && cur) cur.sub.push(l.trim());
        else break;
        i++;
      }
      if (cur) items.push(cur);
      const ordered = ordered0 || /^\s*\d+[.)]\s+/.test(line);
      const render = (list, depth) => {
        const tag = ordered && depth === 0 ? 'ol' : 'ul';
        const lis = list
          .map((it) => {
            const box = /^\[([ xX])\]\s*(.*)$/.exec(it.text);
            const body = box
              ? `<span class="md-todo ${/x/i.test(box[1]) ? 'done' : ''}"></span>${inline(box[2], ctx)}`
              : inline(it.text, ctx);
            const sub = it.sub.length ? renderMarkdown(it.sub.join('\n'), ctx).html : '';
            return `<li>${body}${sub}</li>`;
          })
          .join('');
        return `<${tag} class="md-list${depth ? ' md-list-sub' : ''}">${lis}</${tag}>`;
      };
      out.push(render(items, 0));
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();

  let html = out.join('\n');
  html = ctx.restore(html);
  collectWikilinks(html);
  return { html, headings, links };
}

export function splitRow(line) {
  let s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * 把「块级元素被包在 <p> 里」的情况拆开：<p><figure…></figure></p> → <figure…></figure>
 * 这样产出的 HTML 更干净，所见即所得编辑器保存回来时也不会把代码块/图片弄丢。
 */
export function unwrapBlockInParagraph(html) {
  const BLOCK_INLINE = 'figure|div|table|ul|ol|blockquote|section|pre|hr';
  return String(html).replace(new RegExp(`<p>((?:<(?:(?:${BLOCK_INLINE})[\\s\\S]*?<\\/(?:${BLOCK_INLINE})>|br\\s*\\/?>))*)\\s*<\\/p>`, 'g'), (m, inner) => {
    // 只有整段都是块级元素时才拆（避免误伤普通段落里的 <br>）
    if (!new RegExp(`^\\s*<(?:${BLOCK_INLINE})[\\s>]`).test(inner)) return m;
    return inner.replace(/<br\s*\/?>/g, '').trim();
  });
}

/**
 * 一步到位：Markdown 全文 → { data, body, html, headings, links, excerpt }
 * @param {string} raw 含 frontmatter 的原文
 * @param {(href:string)=>string} resolve 链接解析函数（构建时指向 assets/，浏览器里原样返回）
 */
export function renderDocument(raw, resolve = (href) => href) {
  const { data, body } = parseFrontmatter(raw);
  const { text, restore } = extractProtected(body);
  const { html: rawHtml, headings, links } = renderMarkdown(text, { resolve, restore });
  const html = unwrapBlockInParagraph(rawHtml);
  const plain = html
    .replace(/<figure class="md-code"[\s\S]*?<\/figure>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const codeText = [...html.matchAll(/<figure class="md-code"[\s\S]*?<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)]
    .map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'))
    .join('\n');
  return { data, body, html, headings, links, excerpt: (plain || '').slice(0, 120), codeText };
}
