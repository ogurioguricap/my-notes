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

// Markdown 渲染内核与浏览器共用（在线编辑器实时预览走同一份代码）
import { esc, slugify as slugifyText, stripMd as stripMdText, parseFrontmatter, extractProtected, renderMarkdown, splitRow, renderDocument } from '../lib/markdown.mjs';


/* ---------- 笔记本「封面」：按分类取色 ---------- */
const COVER_PALETTE = [
  { ink: '#EA5A47', soft: '#FDEBE7' }, // 珊瑚红
  { ink: '#4C7DF0', soft: '#E9EFFE' }, // 蓝
  { ink: '#0E9F8C', soft: '#E3F6F3' }, // 青绿
  { ink: '#E0913A', soft: '#FBF0E0' }, // 琥珀
  { ink: '#8B5CF6', soft: '#F1EBFE' }, // 紫
  { ink: '#D94F8A', soft: '#FCE9F1' }, // 玫红
  { ink: '#3D8A5F', soft: '#E7F3EC' }, // 墨绿
  { ink: '#5A6B8C', soft: '#ECF0F6' }, // 石板蓝
];

/* ============================ 小工具 ============================ */
import { hashStr } from '../lib/site-build.mjs';

function coverFor(category, slug, title, categoryIndex) {
  const base = COVER_PALETTE[(categoryIndex >= 0 ? categoryIndex : hashStr(category)) % COVER_PALETTE.length];
  // 同分类统一色：个性由首字标记承担，视觉上更"成套"、更像一排笔记本
  return { ink: base.ink, soft: base.soft, glyph: coverGlyph(title) };
}

function coverGlyph(title) {
  const t = String(title).replace(/[\s·—\-_｜|]+/g, '');
  const latin = /[A-Za-z0-9]/.exec(t);
  if (latin && latin.index <= 1) return t.slice(0, 2).toUpperCase();
  return t.slice(0, 1) || '笔';
}



/** 中文友好的标题 slug：保留中英文数字，其余转连字符 */
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
    const title = data.title || (h1 ? stripMdText(h1[1]) : slug);

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
      raw: body,               // 原始 Markdown 正文（在线编辑器直接编辑它）
      rawFull: raw,            // 含 frontmatter 的完整原文
      search: searchBlob,
      attachments: attachTexts.map((a) => a.file),
    });
  }

  notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title, 'zh')));

  // 封面配色：分类决定基色（按笔记数排序后固定顺序，保证稳定），slug 做微调
  const catOrder = [...new Set(notes.map((n) => n.category))].sort(
    (a, b) => notes.filter((n) => n.category === b).length - notes.filter((n) => n.category === a).length || a.localeCompare(b, 'zh')
  );
  for (const n of notes) {
    n.cover = coverFor(n.category, n.slug, n.title, catOrder.indexOf(n.category));
  }

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
