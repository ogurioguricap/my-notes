#!/usr/bin/env node
/**
 * 所见即所得编辑器 往返测试
 * 保命逻辑：Markdown → HTML（编辑器里看到的样子）→ Markdown（保存回去）
 * 转一圈之后，可读内容与结构必须还在，否则用户保存一次就会毁掉自己的笔记。
 * 用法： node tools/test-wysiwyg.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function main() {
const md = await import(`file://${path.join(ROOT, 'lib/markdown.mjs').replace(/\\/g, '/')}`);
const h2m = await import(`file://${path.join(ROOT, 'lib/html-to-md.mjs').replace(/\\/g, '/')}`);

let pass = 0, fail = 0;
const expect = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

/* 往返一圈 */
function roundTrip(markdown, resolve = (h) => h) {
  const { html } = md.renderDocument(markdown, resolve);
  return { html, back: h2m.htmlToMarkdown(html) };
}

/** 抽取用于比对的「内容指纹」：正文文字（代码块折算成占位，公式保留 LaTeX） */
function fingerprint(markdown) {
  return String(markdown)
    .replace(/^\s*```[\s\S]*?^\s*```/gm, ' CODEBLOCK ')
    .replace(/[#*_>`~=|\[\]()!\\\-\s]/g, '')
    .trim();
}

/** 解析行内代码（反引号游程），返回 [{code, fence}] —— 围栏长度属表现形式，内容才是硬指标 */
function inlineCodes(markdown) {
  const out = [];
  const src = String(markdown);
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '`') { i++; continue; }
    let n = 0;
    while (src[i + n] === '`') n++;
    const fence = '`'.repeat(n);
    const end = src.indexOf(fence, i + n);
    if (end === -1) { i += n; continue; }
    out.push({ code: src.slice(i + n, end), fence: n });
    i = end + n;
  }
  return out;
}

/** 剔除围栏代码块（按围栏长度精确配对，避免误伤正文里的单反引号） */
function stripFences(markdown) {
  const lines = String(markdown).split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) { fence = m[1][0].repeat(m[1].length); out.push(''); continue; }
      if (m[1].length >= fence.length && m[1][0] === fence[0]) { fence = null; out.push(''); continue; }
    }
    out.push(fence ? '' : line);
  }
  return out.join('\n');
}

/** 结构计数：往返前后每一项都必须一致（这是「不毁笔记」的硬指标） */
function structure(markdown) {
  const s = String(markdown)
    // 多段引用在 Markdown 里有两种等价写法（空行 vs 单独一个 >），统一折叠
    .split('\n')
    .filter((l) => !/^\s*>\s*$/.test(l))
    .join('\n')
    .replace(/(?:^\s*>.*\n)(?=\s*>)/gm, '')
    .replace(/(\n\s*>.*)$/gm, (m) => m.replace(/\n\s*>/g, ' '));
  const count = (re) => (s.match(re) || []).length;
  // 行内代码只在「围栏代码块之外」统计，否则 ```lang 的语言标记会被误当成行内代码
  const outsideFences = stripFences(s);
  const codes = inlineCodes(outsideFences).filter((c) => c.code.trim() !== '');
  return {
    代码块: count(/^\s*```/gm),
    标题: count(/^#{2,6}\s/gm),          // 只数 2~6 级：正文里缩进代码注释的 # 不算标题
    无序列表项: count(/^\s*[-*+]\s/gm),
    有序列表项: count(/^\s*\d+[.)]\s/gm),
    表格行: count(/^\s*\|/gm),
    引用行: count(/^\s*>\s/gm),
    图片: count(/!\[[^\]]*\]\(/g),
    链接: count(/(?<!!)\[[^\]]+\]\(/g),
    双链: count(/\[\[[^\]]+\]\]/g),
    粗体: count(/\*\*[^*]+\*\*/g),
    行内代码: codes.length,
    行内代码内容: codes.map((c) => c.code).sort().join('|'),
    分隔线: count(/^\s*---\s*$/gm),
  };
}

console.log('=== 所见即所得 往返测试 ===\n');

/* ---------- 1. 手工用例 ---------- */
console.log('— 基础结构 —');
const cases = [
  ['一级标题', '# 标题\n\n正文一段。'],
  ['多级标题', '## 二级\n\n正文\n\n### 三级\n\n更多正文'],
  ['粗体斜体删除线高亮', '这里有 **粗体**、*斜体*、~~删除线~~、==高亮== 和 `行内代码`。'],
  ['无序列表', '- 第一项\n- 第二项\n- 第三项'],
  ['有序列表', '1. 一\n2. 二\n3. 三'],
  ['嵌套列表', '- 外层\n  - 内层一\n  - 内层二\n- 外层二'],
  ['任务清单', '- [x] 已做\n- [ ] 未做'],
  ['引用', '> 一句引用\n> 第二行'],
  ['提示框', '> [!TIP] 技巧\n> 这里是提示内容。\n>\n> 还有第二段。'],  ['分隔线', '上面\n\n---\n\n下面'],
  ['链接', '见 [GitHub](https://github.com/foo/bar) 页面。'],
  ['图片', '![说明文字](assets/demo.png)'],
  ['双链', '参考 [[数模方法速查卡]] 这篇。'],
  ['代码块', '```python\nimport numpy as np\nprint(np.pi)\n```'],
  ['表格', '| 名称 | 数值 |\n| --- | ---: |\n| A | 1 |\n| B | 2 |'],
  ['混合长文', '## 小节\n\n一段话带 **重点**。\n\n- 列表一\n- 列表二\n\n> [!NOTE] 注意\n> 别踩坑\n\n最后再来一段，含 [链接](https://example.com)。'],
];

for (const [name, src] of cases) {
  const { back } = roundTrip(src);
  const a = fingerprint(src);
  const b = fingerprint(back);
  const same = a === b;
  // 结构标记检查
  const checks = {
    粗体斜体删除线高亮: ['**粗体**', '*斜体*', '~~删除线~~', '==高亮=='],
    无序列表: ['- 第一项'],
    有序列表: ['1. 一'],
    任务清单: ['- [x] 已做', '- [ ] 未做'],
    引用: ['> 一句引用'],
    提示框: ['> [!TIP] 技巧'],
    分隔线: ['---'],
    链接: ['[GitHub](https://github.com/foo/bar)'],
    图片: ['![说明文字](assets/demo.png)'],
    双链: ['[[数模方法速查卡]]'],
    代码块: ['```python'],
    表格: ['| --- | ---: |'],
  }[name];
  let structOk = true;
  let missing = '';
  if (checks) {
    missing = checks.filter((c) => !back.includes(c)).join(' / ');
    structOk = !missing;
  }
  expect(`${name}：内容不丢${checks ? '且结构保留' : ''}`, same && structOk, missing ? `缺失结构：${missing}` : `\n      原：${a}\n      后：${b}`);
}

/* ---------- 2. 真实笔记往返（最关键的回归） ---------- */
console.log('\n— 真实笔记往返（content/*.md）—');
const dir = path.join(ROOT, 'content');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const { body } = md.parseFrontmatter(raw);
  const { back } = roundTrip(body, (href) => href);
  const a = fingerprint(body);
  const b = fingerprint(back);
  const ok = a === b;
  expect(`${f}：正文内容往返无损`, ok, ok ? '' : `\n      原：${a.slice(0, 150)}\n      后：${b.slice(0, 150)}`);

  const sa = structure(body);
  const sb = structure(back);
  // 硬指标 1：正文文字往返无损
  // 硬指标 2：原文里出现过的行内代码内容，回写后必须仍然在（围栏宽度归一属表现形式，允许新增）
  const codesA = new Set(sa.行内代码内容.split('|').filter(Boolean));
  const codesB = new Set(sb.行内代码内容.split('|').filter(Boolean));
  const lostCodes = [...codesA].filter((c) => !codesB.has(c));
  expect(`  ${f}：行内代码内容无丢失（${codesA.size} 段）`, lostCodes.length === 0, '丢失：' + JSON.stringify(lostCodes));

  // 软指标：其余结构计数（排除围栏归一带来的噪声）
  const ignore = new Set(['行内代码', '行内代码内容']);
  const diffs = Object.keys(sa).filter((k) => !ignore.has(k) && sa[k] !== sb[k]).map((k) => `${k} ${sa[k]}→${sb[k]}`);
  expect(`  ${f}：标题/列表/表格/公式等结构计数一致`, diffs.length === 0, diffs.join('；'));
}

/* ---------- 3. 复杂结构识别 ---------- */
console.log('\n— 复杂结构识别（决定是否提示用户切源码模式）—');
const c1 = h2m.complexFeatures('普通段落 **加粗**\n\n- 列表');
expect('纯文本/列表：不触发复杂提示', !c1.code && !c1.math && !c1.table);
const c2 = h2m.complexFeatures('| a | b |\n| --- | --- |\n\n```js\nx\n```\n\n$$\\int_0^1 x dx$$');
expect('表格/代码/公式：正确识别为复杂结构', c2.code && c2.math && c2.table);

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
  return fail === 0;
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  const ok = await main();
  if (!ok) process.exitCode = 1;
}
