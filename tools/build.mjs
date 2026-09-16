#!/usr/bin/env node
/**
 * 静态笔记站构建脚本（零依赖，仅需 Node 18+）
 * ---------------------------------------------------------------
 * 输入： content/*.md            笔记正文（Markdown + YAML frontmatter）
 *        content/assets/**       笔记里的图片 / PDF / 附件
 *        content/_extracted.json 附件文字提取结果（图片 OCR / PDF 文本），可选
 * 输出： docs/data/index.json    全站数据（渲染好的 HTML + 目录 + 搜索索引）
 *        docs/assets/**         附件副本
 *
 * 用法： node tools/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');
// 产物放 docs/：GitHub Pages 的「Deploy from a branch」只支持 / 或 /docs 作为发布目录
const SITE = path.join(ROOT, 'docs');
const ASSETS_SRC = path.join(CONTENT, 'assets');
const ASSETS_DST = path.join(SITE, 'assets');

const SENT = '\u0000'; // 占位符哨兵

/* ============================ 小工具 ============================ */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 中文友好的标题 slug：保留中英文数字，其余转连字符 */
function slugify(text, fallback = 'sec') {
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

function stripMd(text) {
  return String(text)
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (m, a, b) => (b || a))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ========================= YAML frontmatter ========================= */
function parseFrontmatter(raw) {
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
    if (val === '') {
      data[key] = [];
    } else if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val
        .slice(1, -1)
        .split(',')
        .map((x) => scalar(x))
        .filter((x) => x !== '');
    } else {
      data[key] = scalar(val);
    }
  }
  return { data, body: raw.slice(m[0].length) };
}

function scalar(v) {
  let s = String(v).trim();
  if (/^"(.*)"$/.test(s) || /^'(.*)'$/.test(s)) s = s.slice(1, -1);
  return s;
}

/* ====================== 先把代码块/公式抽出来 ====================== */
function extractProtected(src) {
  const store = [];
  const keep = (html) => `${SENT}${store.push(html) - 1}${SENT}`;

  let s = src;

  // 围栏代码块（``` 或 ~~~）
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

  // 行内代码
  s = s.replace(/(`+)([^\n]*?)\1/g, (m, t, code) => keep(`<code class="md-inline-code">${esc(code.trim())}</code>`));

  // 块级公式 $$...$$
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => keep(`<div class="md-math-block" data-tex="${esc(tex.trim())}"></div>`));

  // 行内公式 $...$
  s = s.replace(/(?<!\\)\$(?!\s)([^\n$]+?)(?<!\s)\$/g, (m, tex) => keep(`<span class="md-math-inline" data-tex="${esc(tex.trim())}"></span>`));

  return { text: s, store, restore: (html) => html.replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (m, i) => store[Number(i)]) };
}

/* ============================ 行内解析 ============================ */
function inline(text, ctx) {
  let s = text;

  // 图片 ![alt](src "title")
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, alt, src, title) => {
    const url = ctx.resolve(src);
    const isRemote = /^https?:\/\//i.test(src);
    return (
      `<figure class="md-figure">` +
      `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async"${title ? ` title="${esc(title)}"` : ''}` +
      ` data-zoom-src="${esc(url)}">` +
      (alt ? `<figcaption>${esc(alt)}</figcaption>` : '') +
      `</figure>`
    );
  });

  // 链接 [text](href)
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, (m, label, href, title) => {
    const out = ctx.resolve(href);
    const external = /^https?:\/\//i.test(out);
    let extra = title ? ` title="${esc(title)}"` : '';
    if (external) extra += ' target="_blank" rel="noopener noreferrer"';
    if (!external && /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt)$/i.test(out)) extra += ' class="md-attachment"';
    return `<a href="${esc(out)}"${extra}>${label}</a>`;
  });

  // 双链 [[note]]
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
function renderMarkdown(src, ctx) {
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

    // 空行
    if (!line.trim()) { flushPara(); i++; continue; }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      const text = h[2].trim();
      const title = stripMd(text);
      if (level === 1 && !h1Seen) { h1Seen = true; }

      // 条目索引段：## 目录 / ## 索引 / ## Index → 自动生成
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

    // 引用块 / callout
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
        const rest = buf.slice(1).join('\n');
        const inner = renderMarkdown(rest || '', ctx);
        out.push(
          `<div class="md-callout md-callout-${kind}"><p class="md-callout-title">${esc(titleText)}</p>${inner}</div>`
        );
      } else {
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'), ctx)}</blockquote>`);
      }
      continue;
    }

    // 表格
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
      const th = header
        .map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c, ctx)}</th>`)
        .join('');
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

    // 列表（含 checkbox）
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
        } else if (/^\s{2,}\S/.test(l) && cur) {
          cur.sub.push(l.trim());
        } else break;
        i++;
      }
      if (cur) items.push(cur);

      const ordered = ordered0 || /^\s*\d+[.)]\s+/.test(line);
      const render = (list, depth) => {
        const tag = ordered && depth === 0 ? 'ol' : 'ul';
        // 表格型列表（| 分隔的紧凑表）→ 跳过，交给表格分支
        const lis = list
          .map((it) => {
            const box = /^\[([ xX])\]\s*(.*)$/.exec(it.text);
            const body = box
              ? `<span class="md-todo ${/x/i.test(box[1]) ? 'done' : ''}"></span>${inline(box[2], ctx)}`
              : inline(it.text, ctx);
            const sub = it.sub.length ? renderMarkdown(it.sub.join('\n'), ctx) : '';
            return `<li>${body}${sub}</li>`;
          })
          .join('');
        return `<${tag} class="md-list${depth ? ' md-list-sub' : ''}">${lis}</${tag}>`;
      };
      out.push(render(items, 0));
      continue;
    }

    // 段落
    para.push(line);
    i++;
  }
  flushPara();

  let html = out.join('\n');
  html = ctx.restore(html);
  collectWikilinks(html);
  return { html, headings, links };
}

function splitRow(line) {
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

/* ============================ 主流程 ============================ */
function walk(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const rel of walk(src)) {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    n++;
  }
  return n;
}

export function main() {
  if (!fs.existsSync(CONTENT)) {
    console.error(`✗ 没找到内容目录：${CONTENT}`);
    return false;
  }

  const extractedPath = path.join(CONTENT, '_extracted.json');
  const extracted = fs.existsSync(extractedPath) ? JSON.parse(fs.readFileSync(extractedPath, 'utf8')) : {};

  const mdFiles = walk(CONTENT).filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('_'));
  fs.mkdirSync(path.join(SITE, 'data'), { recursive: true });
  const assetCount = copyDir(ASSETS_SRC, ASSETS_DST);

  const notes = [];
  const warnings = [];

  for (const rel of mdFiles) {
    const raw = fs.readFileSync(path.join(CONTENT, rel), 'utf8');
    const { data, body } = parseFrontmatter(raw);

    const folder = path.dirname(rel);
    const selfDir = folder === '.' ? '' : folder;
    const resolve = (href) => {
      if (/^(https?:|mailto:|tel:|#|data:)/i.test(href)) return href;
      const clean = href.replace(/^\.\//, '');
      if (clean.startsWith('/')) return clean;
      const candidates = [clean];
      if (clean.startsWith('assets/')) candidates.push(clean.slice('assets/'.length));
      if (selfDir) candidates.push(`${selfDir}/${clean}`);
      for (const cand of candidates) {
        if (!/\.md$/i.test(cand) && fs.existsSync(path.join(ASSETS_SRC, cand))) return `assets/${cand}`;
        if (/\.md$/i.test(cand) && fs.existsSync(path.join(CONTENT, cand))) {
          return `#/note/${encodeURIComponent(path.basename(cand, '.md'))}`;
        }
      }
      if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(clean)) warnings.push(`${rel}: 附件缺失 → ${href}`);
      return `assets/${clean.replace(/^assets\//, '')}`;
    };

    const { text: protectedText, restore } = extractProtected(body);
    const ctx = { resolve, restore };
    const { html: rawHtml, headings, links } = renderMarkdown(protectedText, ctx);
    let html = rawHtml;

    const slug = data.slug || path.basename(rel, '.md');
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    const title = data.title || (h1 ? stripMd(h1[1]) : slug);

    // 取第一段纯文本做摘要（代码块内容剔除，摘要不显示代码）
    const plain = html
      .replace(/<figure class="md-code"[\s\S]*?<\/figure>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const excerpt = data.summary || plain.slice(0, 120);

    // 搜索正文：正文 + 代码块内容（代码块里的函数名/命令也要能搜到）
    const codeText = [...html.matchAll(/<figure class="md-code"[\s\S]*?<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)]
      .map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'))
      .join('\n');
    const bodyText = codeText ? `${plain} ${codeText}` : plain;

    // 附件文字（图片 OCR / PDF 文本）注入搜索与展示
    const attachTexts = [];
    const seenAttach = new Set();
    const re = /(?:assets\/)?([^"'\s)>]+\.(?:png|jpe?g|gif|webp|svg|pdf|txt|csv|md))/gi;
    let m;
    while ((m = re.exec(html))) {
      const key = m[1];
      if (seenAttach.has(key)) continue;
      const hit = extracted[key] || extracted[decodeURIComponent(key)] || extracted[`assets/${key}`];
      const t = hit ? (typeof hit === 'string' ? hit : hit.text || '') : '';
      if (t && t.trim()) {
        seenAttach.add(key);
        attachTexts.push({ file: key, text: String(t).trim(), source: (hit.source || 'text') });
      }
    }
    for (const a of attachTexts) {
      const block = `\n<section class="md-attach-text" data-file="${esc(a.file)}"><h4>附件文字 · ${esc(path.basename(a.file))}</h4><pre>${esc(a.text.slice(0, 4000))}</pre></section>`;
      html += block;
    }

    // 日期：frontmatter 优先，其次文件 mtime
    const mtime = fs.statSync(path.join(CONTENT, rel)).mtime;
    const date = (data.date || mtime.toISOString().slice(0, 10)).toString().slice(0, 10);

    const tags = Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [];
    const category = data.category || (selfDir ? selfDir.split('/')[0] : '未分类');
    const related = Array.isArray(data.related) ? data.related : data.related ? [data.related] : [];

    const searchBlob = [title, bodyText, tags.join(' '), category, attachTexts.map((a) => a.text).join(' ')]
      .join(' \u0001 ')
      .replace(/\s+/g, ' ')
      .slice(0, 60000);

    notes.push({
      slug,
      title,
      date,
      category,
      tags,
      related,
      links,
      pinned: !!(data.pinned === true || data.pinned === 'true'),
      status: data.status || '',
      source: rel,
      excerpt,
      html,
      headings,
      search: searchBlob,
      attachments: attachTexts.map((a) => a.file),
    });
  }

  notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title, 'zh')));

  // 反向链接
  const byTitle = new Map();
  for (const n of notes) { byTitle.set(n.slug.toLowerCase(), n.slug); byTitle.set(n.title.toLowerCase(), n.slug); }
  for (const n of notes) {
    n.backlinks = [];
    n.missingLinks = [];
    n.resolvedLinks = n.links.map((l) => {
      const key = String(l).toLowerCase().replace(/\.md$/, '');
      const target = byTitle.get(key);
      if (target) return target;
      n.missingLinks.push(l);
      return null;
    }).filter(Boolean);
  }
  for (const n of notes) {
    for (const t of n.resolvedLinks) {
      const target = notes.find((x) => x.slug === t);
      if (target && !target.backlinks.includes(n.slug)) target.backlinks.push(n.slug);
    }
  }

  const categories = [...new Set(notes.map((n) => n.category))];
  const tagCount = {};
  for (const n of notes) for (const t of n.tags) tagCount[t] = (tagCount[t] || 0) + 1;

  const payload = {
    generatedAt: new Date().toISOString(),
    stats: {
      notes: notes.length,
      words: notes.reduce((s, n) => s + n.search.length, 0),
      tags: Object.keys(tagCount).length,
      categories: categories.length,
      assets: assetCount,
      extracted: Object.keys(extracted).length,
    },
    categories,
    tags: tagCount,
    notes,
  };

  const outFile = path.join(SITE, 'data', 'index.json');
  fs.writeFileSync(outFile, JSON.stringify(payload), 'utf8');

  const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`✓ 构建完成：${notes.length} 篇笔记 / ${assetCount} 个附件 / 索引 ${kb} KB`);
  console.log(`  ${path.relative(ROOT, outFile)}`);
  if (warnings.length) {
    console.log(`  ⚠ ${warnings.length} 条提醒：`);
    for (const w of warnings.slice(0, 10)) console.log(`    - ${w}`);
  }
  return true;
}

// 直接运行本文件时执行；被 tools/update.mjs 导入时不自动跑
const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  const ok = main();
  if (!ok) process.exitCode = 1;
}
