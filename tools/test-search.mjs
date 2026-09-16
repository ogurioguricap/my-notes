#!/usr/bin/env node
/**
 * 检索功能实测：直接加载 docs/js/search.js（浏览器同款代码），对真实索引跑断言。
 * 用法： node tools/test-search.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function main() {
const { buildIndex, search, tokenize } = await import(pathToFileURL(path.join(ROOT, 'docs/js/search.js')).href);

const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data/index.json'), 'utf8'));
const index = buildIndex(payload);

let pass = 0, fail = 0;
function expect(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
function top(q, key = 'slug') {
  const r = search(index, q);
  return r.map((x) => x[key]);
}
function hit(q, slug) {
  return top(q).includes(slug);
}

console.log('=== 检索功能实测 ===');
console.log(`索引：${index.docs.length} 篇，${index.docs.reduce((s, d) => s + d.nText.length, 0)} 字符\n`);

console.log('— 标题命中 —');
expect('“马尔可夫” → markov-chain 排第一', top('马尔可夫')[0] === 'markov-chain', JSON.stringify(top('马尔可夫')));
expect('单字“马” → 能找到 markov-chain（汉字按子串匹配）', hit('马', 'markov-chain'), JSON.stringify(top('马')));
expect('“马克” → 无结果（子串匹配，不猜词）', top('马克').length === 0, JSON.stringify(top('马克')));
expect('“GitHub Pages” → deploy 命中', hit('GitHub Pages', 'deploy'));
expect('“速查” 命中两篇（markdown-syntax / mm-methods）', (() => { const r = top('速查'); return r.includes('markdown-syntax') && r.includes('mm-methods'); })(), JSON.stringify(top('速查')));

console.log('\n— 正文命中 —');
expect('“拉普拉斯平滑” → markov-chain（只出现在正文）', top('拉普拉斯平滑')[0] === 'markov-chain', JSON.stringify(top('拉普拉斯平滑')));
expect('“Pareto” → mm-methods', hit('Pareto', 'mm-methods'));
expect('“Pages 目录选了” → deploy', hit('Pages 目录选了', 'deploy'));
expect('“转移矩阵” → markov-chain', hit('转移矩阵', 'markov-chain'));

console.log('\n— 标签 / 分类命中 —');
expect('“踩坑”（标签）→ deploy', hit('踩坑', 'deploy'));
expect('“关于本站”（分类）→ home', hit('关于本站', 'home'));

console.log('\n— 附件文字（图片 OCR）命中 —');
expect('“马尔可夫链演示图”（图片里的字）→ home', hit('马尔可夫链演示图', 'home'), JSON.stringify(top('马尔可夫链演示图')));
expect('“MARKOV CHAIN CONVERGENCE”（图片里的英文）→ 有结果', top('MARKOV CHAIN').length > 0);
expect('“0.3846”（图里的数字）→ 有结果', top('0.3846').length > 0);

console.log('\n— 英文大小写不敏感 —');
expect('“markov” 与 “MARKOV” 结果一致', JSON.stringify(top('markov')) === JSON.stringify(top('MARKOV')));
expect('“python” → 命中（代码高亮块正文）', top('python').length > 0);

console.log('\n— 多词 AND 语义 —');
expect('“马尔可夫 平稳” → markov-chain', hit('马尔可夫 平稳', 'markov-chain'));
expect('“马尔可夫 部署” → 无结果（两词不在同一篇）', top('马尔可夫 部署').length === 0, JSON.stringify(top('马尔可夫 部署')));

console.log('\n— 分类筛选 —');
const inMath = search(index, '模型', { category: '数学建模' }).map((r) => r.slug);
expect('分类=数学建模 搜“模型” 不含写作规范笔记', !inMath.includes('markdown-syntax'), JSON.stringify(inMath));

console.log('\n— 排序合理性 —');
const r1 = search(index, '马尔可夫链');
expect('“马尔可夫链” 首位是标题含该词的 markov-chain', r1[0].slug === 'markov-chain', JSON.stringify(r1.map((r) => r.slug)));

console.log('\n— 边界情况 —');
expect('空查询返回空数组', search(index, '').length === 0);
expect('纯空格返回空数组', search(index, '   ').length === 0);
expect('不存在的词返回空数组', search(index, 'zzzz不存在的关键词zzzz').length === 0);
expect('tokenize 支持引号短语', JSON.stringify(tokenize('"马尔可夫链 建模" 平稳')) === JSON.stringify(['马尔可夫链 建模', '平稳']));
expect('超长查询不崩溃', search(index, '啊'.repeat(500)).length >= 0);
expect('特殊字符不崩溃', search(index, '*** [[]] (((').length >= 0);
expect('结果带高亮片段', search(index, '拉普拉斯')[0].snippet.includes('<mark>'), search(index, '拉普拉斯')[0].snippet.slice(0, 80));

console.log('\n— 性能（实时搜索必须 < 50ms）—');
const t0 = Date.now();
for (let i = 0; i < 100; i++) search(index, '马尔可夫链 平稳分布 收敛');
const per = (Date.now() - t0) / 100;
expect(`单次检索 ${per.toFixed(1)}ms`, per < 50);

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
  return fail === 0;
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  const ok = await main();
  if (!ok) process.exitCode = 1;
}
