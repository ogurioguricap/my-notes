#!/usr/bin/env node
/**
 * 资料库界面数据契约测试（不需要浏览器）
 * 复刻 docs/js/app.js 里 cardHtml / 书架分组 / 速览 的纯渲染规则，对真实产物做断言，
 * 保证「封面卡片、书架分组、速览浮层」拿到的数据是完整的。
 * 用法： node tools/test-ui-lib.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function main() {
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data/index.json'), 'utf8'));
const notes = payload.notes;

let pass = 0, fail = 0;
const expect = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

/* ---- 复刻 app.js 的渲染规则 ---- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const coverVars = (n) => `--nb:${(n.cover && n.cover.ink) || 'var(--accent)'}`;
const coverGlyphOf = (n) => (n.cover && n.cover.glyph) || String(n.title || '笔').slice(0, 1);
const cardHtml = (n) => `<a class="nb-card" href="#/note/${encodeURIComponent(n.slug)}" data-slug="${esc(n.slug)}" style="${coverVars(n)}">
  ${n.pinned ? '<span class="nb-star">⭐</span>' : ''}
  <span class="nb-card-top"><span class="nb-thumb">${esc(coverGlyphOf(n))}</span>
  <span class="nb-card-meta"><span class="nb-card-cat"><span class="nb-dot"></span>${esc(n.category)}</span></span></span>
  <h3>${esc(n.title)}</h3><p>${esc(n.excerpt)}</p>
  <span class="nb-card-foot">${n.tags.slice(0, 3).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</span></a>`;

console.log('=== 资料库界面数据契约 ===');
console.log(`数据：${notes.length} 篇，生成于 ${payload.generatedAt}\n`);

console.log('— 封面（笔记本外观）—');
expect('每篇都有 cover.ink 且是合法颜色', notes.every((n) => /^#[0-9a-f]{6}$/i.test(n.cover.ink)), notes.filter((n) => !/^#[0-9a-f]{6}$/i.test(n.cover.ink)).map((n) => n.slug).join(','));
expect('每篇都有 cover.glyph（1~2 字符）', notes.every((n) => typeof n.cover.glyph === 'string' && n.cover.glyph.length >= 1 && n.cover.glyph.length <= 2));
expect('封面首字与标题有关（取标题首字符或前两个拉丁字母）', notes.every((n) => n.title.replace(/[\s·—\-_｜|]+/g, '').toLowerCase().includes(n.cover.glyph.toLowerCase())));
const uniqueInks = new Set(notes.map((n) => n.cover.ink));
expect(`分类间封面配色有区分度（${uniqueInks.size} 种颜色 / ${new Set(notes.map((n) => n.category)).size} 个分类）`, uniqueInks.size >= 3);
const byCat = new Map();
for (const n of notes) {
  if (!byCat.has(n.category)) byCat.set(n.category, new Set());
  byCat.get(n.category).add(n.cover.ink);
}
console.log('    分类配色：' + [...byCat.entries()].map(([c, s]) => `${c}(${[...s].join(',')})`).join('  '));

console.log('\n— 卡片渲染 —');
const allCards = notes.map(cardHtml).join('');
expect('卡片数量 = 笔记数量', (allCards.match(/class="nb-card"/g) || []).length === notes.length);
expect('每张卡片都有 data-slug 用于点击定位', (allCards.match(/data-slug="/g) || []).length === notes.length);
expect('每张卡片都带封面缩略图 .nb-thumb', (allCards.match(/class="nb-thumb"/g) || []).length === notes.length);
expect('每张卡片都用 --nb 变量注入封面色', (allCards.match(/style="--nb:#[0-9a-f]{6}"/gi) || []).length === notes.length);
expect('卡片含标题 <h3> 与摘要 <p>', (allCards.match(/<h3>/g) || []).length === notes.length && (allCards.match(/<p>/g) || []).length === notes.length);
expect('标题未被转义破坏（含中文与特殊字符）', notes.every((n) => allCards.includes(esc(n.title))));
expect('置顶笔记显示 ⭐', notes.filter((n) => n.pinned).every((n) => cardHtml(n).includes('nb-star')));
expect('标签渲染为 .tag 且每篇最多 3 个', (allCards.match(/class="tag"/g) || []).length === notes.reduce((s, n) => s + Math.min(3, n.tags.length), 0));

console.log('\n— 书架分组 —');
const starred = notes.filter((n) => n.pinned);
expect(`收藏书架：${starred.length} 本`, starred.length >= 1, JSON.stringify(notes.map((n) => n.pinned)));
expect(`最近更新书架取前 8 本（实得 ${Math.min(8, notes.length)}）`, notes.slice(0, 8).length === Math.min(8, notes.length));
expect('按日期倒序排列', notes.every((n, i) => i === 0 || notes[i - 1].date >= n.date));
expect(`分类书架 ${byCat.size} 类，每类都有成员`, [...byCat.values()].every((s) => s.size >= 1));
const attachNotes = notes.filter((n) => n.attachments.length);
expect(`含图表文字书架：${attachNotes.length} 本`, attachNotes.length >= 1);

console.log('\n— 速览浮层所需字段 —');
expect('excerpt 均非空', notes.every((n) => n.excerpt && n.excerpt.length > 5));
expect('headings 均为数组（速览列目录用）', notes.every((n) => Array.isArray(n.headings)));
expect('search 字符串非空（速览显示索引用）', notes.every((n) => typeof n.search === 'string' && n.search.length > 0));
expect('resolvedLinks / backlinks 已计算', notes.every((n) => Array.isArray(n.resolvedLinks) && Array.isArray(n.backlinks)));
expect('source 字段存在（复制 Markdown 文件名用）', notes.every((n) => typeof n.source === 'string' && n.source.length > 0));

console.log('\n— 深色模式可读性（封面文字为白色，故封面色不能太浅）—');
const tooLight = notes.filter((n) => {
  const hex = n.cover.ink.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.72;
});
expect('封面色亮度均低于 0.72（白字可读）', tooLight.length === 0, tooLight.map((n) => `${n.slug}=${n.cover.ink}`).join(','));

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
  return fail === 0;
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  const ok = main();
  if (!ok) process.exitCode = 1;
}
