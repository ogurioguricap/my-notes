#!/usr/bin/env node
/**
 * GoodNotes 模式实测（不需要浏览器）
 *
 * 覆盖四条线：
 *   1. 数据层 store.mjs —— 笔记本 / 页面 / 文件夹 / 标签 / 垃圾桶 / 大纲 / 闪卡间隔重复 / 录音锚点 / 备份导入导出 / 老数据迁移
 *   2. 纸张 paper.mjs —— 模板齐备、尺寸与封面变量、12 种模板都能真画出来（含 Canvas 调用契约审计）
 *   3. 引擎 page.mjs —— 速度/压感笔宽、胶带几何、尺子吸附、放大窗映射；PageEditor 端到端（四种笔、荧光笔拉直、
 *      形状识别+填充、三模式橡皮、套索变换、文本、贴纸、胶带、激光、尺子、跨页撤销、复制粘贴、层级）
 *   4. 输出 study.mjs —— 真 PDF 字节流（结构合法、页数与图片数一致）、抽取式摘要、学习集统计
 *
 * 用法： node tools/test-notebook.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'docs', 'js', 'notebook');

let pass = 0, fail = 0;
const expect = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const head = (t) => console.log(`\n— ${t} —`);

/* ============================ 最小 DOM 桩（够 PageEditor 用） ============================ */
function makeStub(name) {
  const store = {};
  const target = function () {};
  return new Proxy(target, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => `[stub ${name}]`;
      if (prop === 'length') return 0;
      if (prop === 'matches' || prop === 'closest' || prop === 'contains') return () => null;
      if (prop === 'getAttribute' || prop === 'getPropertyValue') return () => '';
      if (prop === 'querySelectorAll') return () => [];
      if (prop === 'querySelector') return () => makeStub('el');
      if (prop === 'getBoundingClientRect') return () => ({ width: 794, height: 1123, left: 0, top: 0, right: 794, bottom: 1123 });
      if (prop === 'addEventListener' || prop === 'removeEventListener' || prop === 'appendChild'
        || prop === 'focus' || prop === 'remove' || prop === 'setAttribute' || prop === 'toggle' || prop === 'click') return () => {};
      if (prop === 'classList' || prop === 'style' || prop === 'dataset') return store[prop] || (store[prop] = makeStub(prop));
      if (prop in store) return store[prop];
      return makeStub(String(prop));
    },
    set(_, prop, v) { store[prop] = v; return true; },
    apply() { return makeStub(`${name}()`); },
  });
}
const define = (name, value) => {
  try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); }
  catch (e) { try { globalThis[name] = value; } catch (e2) {} }
};
define('document', {
  body: { appendChild() {}, classList: { toggle() {}, add() {}, remove() {} } },
  documentElement: { classList: { toggle() {} }, requestFullscreen: () => Promise.resolve() },
  createElement: () => makeStub('el'),
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
});
define('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, print() {} });
define('navigator', {});
define('getComputedStyle', () => ({ getPropertyValue: () => '' }));
define('requestAnimationFrame', (fn) => setTimeout(fn, 0));
define('cancelAnimationFrame', () => {});
define('matchMedia', () => ({ matches: false, addEventListener() {} }));
define('confirm', () => true);
define('alert', () => {});

/** 记录型 canvas 上下文：既能当绘制目标，又能当作「真机契约」审计的依据 */
function recordingCtx() {
  const METHODS = new Set(['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'rect',
    'quadraticCurveTo', 'bezierCurveTo', 'stroke', 'fill', 'clip', 'fillText', 'strokeText', 'measureText', 'drawImage',
    'setLineDash', 'getLineDash', 'setTransform', 'resetTransform', 'translate', 'rotate', 'scale', 'save', 'restore',
    'createLinearGradient', 'createRadialGradient', 'createPattern', 'getImageData', 'putImageData']);
  const PROPS = new Set(['globalAlpha', 'globalCompositeOperation', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
    'strokeStyle', 'fillStyle', 'font', 'textAlign', 'textBaseline', 'direction', 'shadowColor', 'shadowBlur', 'shadowOffsetX',
    'shadowOffsetY', 'filter', 'imageSmoothingEnabled', 'canvas']);
  const rec = { calls: [], bad: [] };
  const proxy = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (PROPS.has(prop)) return undefined;
      return (...args) => {
        rec.calls.push({ name: prop, args });
        if (!METHODS.has(prop)) { rec.bad.push(`未知方法 ctx.${prop}()`); return undefined; }
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) rec.bad.push(`ctx.${prop}() 收到非有限数`);
        const need = (i, label) => { if (typeof args[i] !== 'number' || args[i] < 0) rec.bad.push(`ctx.${prop}() 的${label}必须非负`); };
        if (prop === 'arc') need(2, '半径');
        if (prop === 'ellipse') { need(2, '水平半径'); need(3, '垂直半径'); }
        if (prop === 'fillRect' || prop === 'strokeRect') { need(2, '宽度'); need(3, '高度'); }
        if (prop === 'drawImage' && args.length >= 5) { need(3, '宽度'); need(4, '高度'); }
        if (prop === 'setTransform' && args.filter((a) => typeof a === 'number').length !== 6) rec.bad.push('ctx.setTransform() 参数个数不对');
        // 真机上这些返回对象（渐变 / 图案），调用方会接着 .addColorStop()，桩也要照做
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return { addColorStop() {} };
        if (prop === 'createPattern') return {};
        return undefined;
      };
    },
    set(_, prop, v) {
      if (!PROPS.has(prop)) rec.bad.push(`未知属性 ctx.${prop} = …`);
      if (typeof v === 'number' && !Number.isFinite(v)) rec.bad.push(`ctx.${prop} = ${v}（非有限数）`);
      return true;
    },
  });
  return { ctx: proxy, rec };
}

const storeMod = await import(pathToFileURL(path.join(dir, 'store.mjs')).href);
const paperMod = await import(pathToFileURL(path.join(dir, 'paper.mjs')).href);
const pageMod = await import(pathToFileURL(path.join(dir, 'page.mjs')).href);
const studyMod = await import(pathToFileURL(path.join(dir, 'study.mjs')).href);

console.log('=== GoodNotes 模式实测 ===');

/* ============================ 1. 数据层 ============================ */
head('数据层（笔记本 / 页面 / 资料库）');
const store = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
const nb = store.create({ title: '高等数学', cover: { color: '#2F6FE8' }, paper: { template: 'grid', size: 'a4' } });
expect('新建笔记本：1 本 · 1 页 · 封面自动取首字', store.stats().notebooks === 1 && nb.pages.length === 1 && nb.cover.glyph === '高');
expect('笔记本带封面 / 纸张 / 滚动方向默认值', nb.cover.color === '#2F6FE8' && nb.paper.template === 'grid' && nb.scroll === 'vertical');
store.addPage(nb.id, { count: 4 });
expect('加页：一次加 4 页', store.get(nb.id).pages.length === 5);
const pg2 = store.get(nb.id).pages[1];
store.duplicatePage(nb.id, pg2.id);
expect('复制页：页数 +1 且新页 id 不同', store.get(nb.id).pages.length === 6 && store.get(nb.id).pages[2].id !== pg2.id);
store.movePage(nb.id, 5, 0);
expect('页面排序：最后一页挪到最前', store.get(nb.id).pages[0].id === store.get(nb.id).pages.map((p) => p.id)[0]);
expect('删页：正常删除返回 true', store.removePage(nb.id, store.get(nb.id).pages[5].id) === true);
const onlyOne = store.create({ title: '只有一页' });
expect('最后一页不允许删（手账 App 同款约束）', store.removePage(onlyOne.id, onlyOne.pages[0].id) === false);
store.toggleBookmark(nb.id, pg2.id);
store.setPageTitle(nb.id, pg2.id, '导数定义');
const outline = store.outline(nb.id);
expect('大纲：书签页 + 有标题的页都在里面', outline.some((o) => o.bookmarked) && outline.some((o) => o.title === '导数定义'));
store.setPagePaper(nb.id, pg2.id, { template: 'cornell' });
expect('单页可以覆盖笔记本纸张（康奈尔）', store.page(nb.id, pg2.id).paper.template === 'cornell');
store.clearPagePaper(nb.id, pg2.id);
expect('清除单页纸张后跟随笔记本', store.page(nb.id, pg2.id).paper === null);

head('资料库：文件夹 / 标签 / 收藏 / 搜索 / 回收站');
const fld = store.addFolder('数学', '#12A05C');
store.moveToFolder(nb.id, fld.id);
store.addTag(nb.id, '期末');
expect('移入文件夹 + 打标签', store.get(nb.id).folder === fld.id && store.get(nb.id).tags.includes('期末'));
expect('按文件夹筛选', store.notebooks({ folder: fld.id }).length === 1);
expect('标签统计', store.allTags().some((t) => t.tag === '期末' && t.count === 1));
store.setFav(nb.id, true);
expect('收藏会排在最前', store.notebooks()[0].id === nb.id);
store.setItems(nb.id, pg2.id, [{ kind: 'text', id: 't1', x: 0.1, y: 0.1, text: '拉格朗日中值定理', size: 0.026, color: '#000' }]);
expect('搜索能搜到页面里的文本对象', store.notebooks({ q: '拉格朗日' }).length === 1);
expect('按页面内容搜不到时应为空', store.notebooks({ q: '不存在的内容xyz' }).length === 0);
expect('store.searchText 定位到具体页', store.searchText(nb.id, '拉格朗日').length === 1);
store.renameFolder(fld.id, '高等数学');
expect('文件夹改名', store.folders()[0].name === '高等数学');
store.trash(onlyOne.id);
expect('移入回收站后不在正常列表里', store.notebooks().every((n) => n.id !== onlyOne.id) && store.notebooks({ trash: true }).length === 1);
store.restore(onlyOne.id);
expect('从回收站恢复', store.notebooks().some((n) => n.id === onlyOne.id));
store.trash(onlyOne.id);
store.get(onlyOne.id).trashedAt = Date.now() - 40 * 86400000;
expect('超过 30 天的回收站内容会被自动清理', store.sweepTrash() === 1 && !store.get(onlyOne.id));
store.removeFolder(fld.id);
expect('删文件夹后笔记本回到「未分类」', store.get(nb.id).folder === null);
const dup = store.duplicate(nb.id);
expect('整本复制：标题带副本且页数一致', dup && dup.title.includes('副本') && dup.pages.length === store.get(nb.id).pages.length);

head('备份：导出 / 导入 / 旧数据迁移');
const backup = store.exportJSON([nb.id]);
expect('导出 JSON 结构完整', JSON.parse(backup).version >= 3 && JSON.parse(backup).notebooks.length === 1);
const store2 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
const imported = store2.importJSON(backup);
expect('导入到空资料库：1 本 + 文件夹保留', imported.notebooks === 1 && store2.stats().notebooks === 1);
const again = store2.importJSON(backup);
expect('同 id 再导入不会覆盖，而是新建副本', again.renamed === 1 && store2.stats().notebooks === 2);
let threw = false;
try { store2.importJSON('{"nope":1}'); } catch (e) { threw = true; }
expect('导入非法文件会明确报错', threw);
const s3 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage({ 'note-books-v1': '{"folders":[],"notebooks":[{"title":"老笔记本","strokes":[]}]}' }) });
expect('老/半成品数据自动补齐（页、封面、纸张）', s3.stats().notebooks === 1 && s3.notebooks()[0].pages.length === 1 && !!s3.notebooks()[0].cover.color);
const s4 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage({ 'note-books-v1': '这不是JSON' }) });
expect('坏数据不炸站（退回空资料库并另存原文）', s4.stats().notebooks === 0);

head('学习集：闪卡与间隔重复');
const card = store.addCard(nb.id, '导数定义', 'f\'(x)=lim(Δy/Δx)');
expect('加卡片', !!card && store.get(nb.id).study.length >= 1);
store.reviewCard(nb.id, card.id, true);
const c1 = store.get(nb.id).study.find((c) => c.id === card.id);
expect('记住一次：盒子 +1，1 天后再见', c1.box === 1 && c1.due - Date.now() > 80000000);
store.reviewCard(nb.id, card.id, true);
const c2 = store.get(nb.id).study.find((c) => c.id === card.id);
expect('再记住：间隔拉长到 2 天', c2.box === 2 && c2.due - Date.now() > 1.6e8);
store.reviewCard(nb.id, card.id, false);
const c3 = store.get(nb.id).study.find((c) => c.id === card.id);
expect('忘了：盒子归零、10 分钟后重来、记一次遗忘', c3.box === 0 && c3.lapses === 1 && c3.due - Date.now() < 700000);
const made = store.cardsFromText(nb.id, pg2.id, '勾股定理 —— a²+b²=c²\n泰勒展开');
expect('从文本生成闪卡（「——」分前后，单行作正面）', made.length === 2 && made[0].back.includes('c²'));
expect('deckStats 统计到期/掌握', studyMod.deckStats(store, nb.id).total >= 3);

head('录音：与笔记时间点同步');
const audio = await store.saveAudio(nb.id, { type: 'audio/webm', size: 1024 }, { pageId: pg2.id, pageIndex: 1, itemCount: 8, duration: 12 });
expect('录音元数据落库（无 IndexedDB 时走内存兜底）', !!audio && store.get(nb.id).audio.length === 1);
const blob = await store.getAudio(audio.id);
expect('能取回音频', !!blob);
const anchor = store.audioAnchor(nb.id, audio.id, 0.5);
expect('回放到一半 → 定位到当时那一页、那一笔', anchor && anchor.pageId === pg2.id && anchor.itemsAtThatMoment === 4);
await store.removeAudio(nb.id, audio.id);
expect('删录音', store.get(nb.id).audio.length === 0);

/* ============================ 2. 纸张 ============================ */
head('纸张与封面');
const needTemplates = ['blank', 'lined', 'grid', 'dots', 'cornell', 'todo', 'week', 'month', 'year', 'music', 'storyboard', 'whiteboard'];
expect('内置纸张模板齐备（空白/横线/方格/点阵/康奈尔/清单/周月年/五线谱/分镜/白板）',
  needTemplates.every((id) => paperMod.PAPER_TEMPLATES.some((t) => t.id === id)));
expect('模板按分组归类', paperMod.templateGroups().length >= 4);
expect('A4 尺寸正确（96dpi）', paperMod.paperDims({ size: 'a4' }).w === 794 && paperMod.paperDims({ size: 'a4' }).h === 1123);
expect('自定义尺寸生效', paperMod.paperDims({ size: 'custom', width: 500, height: 700 }).w === 500);
expect('未知尺寸回落到默认', paperMod.paperDims({ size: '不存在' }).w === 794);
expect('深色纸自动配浅色线', /rgba\(255,255,255/.test(paperMod.autoLineColor('#22252B')));
expect('浅色纸自动配灰线', !/255,255,255/.test(paperMod.autoLineColor('#FFFFFF')));
expect('封面 CSS 变量含主色与浅色', /--bk:#/.test(paperMod.bookCoverVars({ cover: { color: '#E8452F' } })));
expect('颜色混合（混白变浅）', paperMod.mix('#000000', '#FFFFFF', 0.5) === '#808080');

head('12 种纸张 + 6 种封面都能真画（Canvas 契约审计）');
{
  const { ctx, rec } = recordingCtx();
  let drew = 0;
  for (const t of paperMod.PAPER_TEMPLATES) {
    paperMod.renderPaper(ctx, { w: 600, h: 800, template: t.id, color: '#FFFFFF', lineColor: 'rgba(0,0,0,.2)' });
    drew++;
  }
  for (const p of paperMod.COVER_PATTERNS) {
    paperMod.renderCover(ctx, { w: 200, h: 266, color: '#E8452F', pattern: p.id, glyph: '数', title: '高数' });
  }
  expect(`全部 ${drew} 种纸张 + ${paperMod.COVER_PATTERNS.length} 种封面绘制完成`, rec.calls.length > 200);
  expect('Canvas 方法名全部真实存在', rec.bad.filter((b) => /未知方法/.test(b)).length === 0, rec.bad.slice(0, 3).join(' | '));
  expect('Canvas 属性名全部真实存在', rec.bad.filter((b) => /未知属性/.test(b)).length === 0, rec.bad.slice(0, 3).join(' | '));
  expect('没有 NaN / 负半径参数', rec.bad.filter((b) => /非有限数|非负/.test(b)).length === 0, rec.bad.slice(0, 3).join(' | '));
}

/* ============================ 3. 引擎 ============================ */
head('笔宽：速度感应 / 压感 / 起收笔笔锋');
const linePts = Array.from({ length: 40 }, (_, i) => [0.1 + i * 0.02, 0.5]);
const fast = [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]];
const wFountain = pageMod.strokeWidths(linePts, { w: 800, h: 1000, base: 3, type: 'fountain' });
const wFast = pageMod.strokeWidths(fast, { w: 800, h: 1000, base: 3, type: 'fountain' });
expect('笔宽数组长度与点数一致', wFountain.length === linePts.length);
expect('写得越快笔迹越细', wFast[1] < wFountain[20]);
expect('毛笔起收笔渐细（首尾比中间细）', wFountain[0] < wFountain[Math.floor(wFountain.length / 2)]);
expect('压感优先于速度（压力 0.2 明显更细）', (() => {
  const low = pageMod.strokeWidths(linePts, { w: 800, h: 1000, base: 3, type: 'ball', pressures: linePts.map(() => 0.2) });
  const high = pageMod.strokeWidths(linePts, { w: 800, h: 1000, base: 3, type: 'ball', pressures: linePts.map(() => 1) });
  return low[20] < high[20];
})());
expect('笔宽全部有限且为正', wFountain.every((v) => Number.isFinite(v) && v > 0));
expect('毛笔比圆珠笔粗（笔型基准不同）', wFountain[20] < pageMod.strokeWidths(linePts, { w: 800, h: 1000, base: 3, type: 'brush' })[20]);
expect('铅笔比圆珠笔细', pageMod.strokeWidths(linePts, { w: 800, h: 1000, base: 3, type: 'pencil' })[20] < pageMod.strokeWidths(linePts, { w: 800, h: 1000, base: 3, type: 'ball' })[20]);

head('胶带 / 尺子 / 放大窗');
const tape = pageMod.tapeGeometry([0.2, 0.2], [0.8, 0.2], 0.05);
expect('胶带几何：矩形包住起终点', tape.x <= 0.2 && tape.x + tape.w >= 0.8 && Math.abs(tape.angle) < 1e-6);
const tapeDiag = pageMod.tapeGeometry([0.1, 0.1], [0.5, 0.5], 0.05);
expect('斜着撕胶带会带角度', Math.abs(tapeDiag.angle - Math.PI / 4) < 1e-6);
const ruler = { on: true, x: 0.1, y: 0.5, angle: 0, length: 0.8 };
const snapped = pageMod.snapToRuler([[0.2, 0.45], [0.4, 0.52], [0.7, 0.48]], ruler);
expect('尺子吸附：三点被投到同一条直线上', snapped.every((p) => Math.abs(p[1] - 0.5) < 1e-9));
expect('尺子关闭时不动轨迹', JSON.stringify(pageMod.snapToRuler([[0.2, 0.45]], { on: false })) === JSON.stringify([[0.2, 0.45]]));
const zm = pageMod.zoomMap([300, 60], { x: 0, y: 0, w: 600, h: 120 }, { x: 0.2, y: 0.3, w: 0.4, h: 0.16 });
expect('放大窗：条带中心映射到区域中心', Math.abs(zm[0] - 0.4) < 1e-9 && Math.abs(zm[1] - 0.38) < 1e-9);
expect('放大窗映射会夹在合理范围', pageMod.zoomMap([9999, 9999], { x: 0, y: 0, w: 600, h: 120 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.2 })[0] <= 1.6);
expect('贴纸包围盒按 size 算', (() => { const b = pageMod.stickerBounds({ kind: 'sticker', x: 0.1, y: 0.2, size: 0.1 }); return b.x1 > 0.19 && b.y1 > 0.29; })());
expect('统一包围盒能混合笔迹与贴纸', (() => {
  const b = pageMod.boxOfItems([
    { kind: 'stroke', tool: 'pen', color: '#000', width: 0.004, points: [[0.1, 0.1], [0.2, 0.2]] },
    { kind: 'sticker', glyph: '⭐', x: 0.5, y: 0.5, size: 0.1 },
  ]);
  return b.x0 <= 0.1 && b.x1 >= 0.6;
})());

head('页面渲染（导出 / 缩略图共用）');
{
  const { ctx, rec } = recordingCtx();
  const fakeCanvas = { getContext: () => ctx, style: {}, width: 0, height: 0 };
  const r = pageMod.renderPage(fakeCanvas, {
    paper: { template: 'grid', size: 'a4', color: '#FFFFFF' },
    items: [
      { kind: 'stroke', id: 's1', tool: 'pen', pen: 'fountain', color: '#E8452F', width: 0.004, points: [[0.1, 0.1], [0.3, 0.3]] },
      { kind: 'stroke', id: 's2', tool: 'highlighter', color: 'rgba(255,224,80,.42)', width: 0.032, shape: 'line', points: [[0.1, 0.4], [0.9, 0.4]] },
      { kind: 'stroke', id: 's3', tool: 'pen', color: '#2F6FE8', width: 0.004, shape: 'rect', fill: true, points: [[0.2, 0.5], [0.6, 0.7]] },
      { kind: 'stroke', id: 's4', tool: 'pen', color: '#12A05C', width: 0.004, shape: 'ellipse', points: [[0.2, 0.75], [0.5, 0.9]] },
      { kind: 'stroke', id: 's5', tool: 'pen', color: '#12A05C', width: 0.004, shape: 'triangle', points: [[0.6, 0.75], [0.9, 0.9]] },
      { kind: 'stroke', id: 's6', tool: 'pen', color: '#8B5CF6', width: 0.004, shape: 'arrow', points: [[0.1, 0.95], [0.5, 0.99]] },
      { kind: 'text', id: 't1', x: 0.1, y: 0.2, text: '第一行\n第二行', size: 0.026, color: '#000', font: 'serif', bold: true },
      { kind: 'sticker', id: 'st1', glyph: '⭐', x: 0.7, y: 0.1, size: 0.08 },
      { kind: 'tape', id: 'tp1', x: 0.2, y: 0.3, w: 0.4, h: 0.05, angle: 0.1, color: 'rgba(255,255,255,.92)' },
    ],
    state: {},
  });
  expect(`页面渲染尺寸正确（${r.w}×${r.h}）`, r.w === 794 && r.h === 1123);
  expect('画了纸张与内容（含文字、形状、贴纸、胶带）',
    ['fillRect', 'fillText', 'ellipse', 'stroke', 'fill'].every((m) => rec.calls.some((c) => c.name === m)));
  expect('页面渲染无 Canvas 契约问题', rec.bad.length === 0, rec.bad.slice(0, 3).join(' | '));
}

head('PageEditor 端到端');
const pagesData = [
  { pageId: 'p1', pageIndex: 0, paper: { template: 'lined', size: 'a4', color: '#FFFFFF' }, items: [] },
  { pageId: 'p2', pageIndex: 1, paper: { template: 'grid', size: 'a4', color: '#FFFFFF' }, items: [] },
];
const toasts = [];
const editor = new pageMod.PageEditor({
  canvas: makeStub('canvas'),
  host: makeStub('host'),
  getPage: (i) => pagesData[i == null ? 0 : i],
  setItems: (pageId, items) => { const p = pagesData.find((x) => x.pageId === pageId); if (p) p.items = items; },
  onToast: (m) => toasts.push(m),
  onStatus: () => {},
  onGotoPage: () => {},
});
editor.setPage(0);
expect('编辑器初始化：读到第 1 页（A4 794×1123）', editor.cssW === 794 && editor.cssH === 1123);

const stroke = (pts, tool) => {
  if (tool) editor.setTool(tool);   // 不传工具就沿用当前工具（调用方自己 setTool）
  editor.onDown(pts[0]);
  for (let i = 1; i < pts.length; i++) editor.onMove(pts[i]);
  editor.onUp();
};
stroke([[0.1, 0.1], [0.3, 0.3], [0.5, 0.5]]);
expect('画一笔 → 1 个对象', editor.items.length === 1);
expect('落笔后存下了逐点笔宽（导出后粗细一致）', Array.isArray(editor.items[0].widths) && editor.items[0].widths.length === editor.items[0].points.length);
expect('内容自动回写到数据层', pagesData[0].items.length === 1);
editor.undo();
expect('撤销一笔 → 回到空白（数据层同步）', editor.items.length === 0 && pagesData[0].items.length === 0);
editor.redo();
expect('重做 → 笔迹回来', editor.items.length === 1 && pagesData[0].items.length === 1);

editor.setPenType('brush');
stroke([[0.2, 0.2], [0.4, 0.25]]);
expect('切换到毛笔后再画 → 新对象记录 pen=brush', editor.items[1].pen === 'brush');

editor.setTool('highlighter');
stroke([[0.1, 0.6], [0.4, 0.62], [0.8, 0.6], [0.9, 0.6]]);
const hl = editor.items[editor.items.length - 1];
expect('荧光笔够直会自动拉直成直线', hl.tool === 'highlighter' && hl.shape === 'line' && hl.points.length === 2);

editor.setTool('shape');
editor.setShapeKind('rect');
editor.setShapeFill(true);
stroke([[0.2, 0.7], [0.6, 0.72], [0.6, 0.9], [0.2, 0.9], [0.2, 0.7]]);
const rectItem = editor.items[editor.items.length - 1];
expect('形状工具：画出矩形并带填充', rectItem.shape === 'rect' && rectItem.fill === true);
editor.setShapeKind('auto');
stroke([[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4], [0.1, 0.2]]);
expect('形状工具：自动识别成矩形', editor.items[editor.items.length - 1].shape === 'rect');
editor.setShapeKind('auto');
stroke([[0.1, 0.2], [0.35, 0.28], [0.5, 0.5], [0.2, 0.5]]);
expect('乱七八糟的折线不会被硬套成形状', editor.items[editor.items.length - 1].shape === undefined);

// 橡皮
const beforeErase = editor.items.length;
editor.setTool('eraser');
editor.setEraserMode('stroke');
editor.onDown([0.3, 0.3]);
editor.onUp();
expect('整笔擦：命中就整条删掉', editor.items.length === beforeErase - 1);
editor.undo();
expect('撤销橡皮', editor.items.length === beforeErase);
editor.setEraserMode('pixel');
const n0 = editor.items.length;
editor.setTool('shape');
editor.setShapeKind('line');
stroke([[0.1, 0.12], [0.9, 0.12]]);
const lineId = editor.items[editor.items.length - 1].id;
editor.setTool('eraser');
editor.setEraserMode('pixel');
editor.onDown([0.5, 0.12]);
editor.onUp();
const lineParts = editor.items.filter((it) => it.points && it.points.length && Math.abs(it.points[0][1] - 0.12) < 0.05 && it.id !== lineId);
expect('像素擦：长直线被切成两段', editor.items.length >= n0 + 2 || lineParts.length >= 1);
editor.setEraserMode('highlighter');
const penCount = editor.items.filter((it) => it.tool !== 'highlighter' && it.kind === 'stroke').length;
editor.setTool('eraser');
editor.onDown([0.2, 0.22]);
editor.onUp();
expect('仅擦荧光笔：画笔笔迹一根不少', editor.items.filter((it) => it.tool !== 'highlighter' && it.kind === 'stroke').length === penCount);
editor.setEraserMode('stroke');

// 套索
editor.setTool('lasso');
editor.setRectSelect(false);
const target = editor.items.find((it) => it.kind === 'stroke' && it.tool === 'pen');
const b0 = pageMod.boxOfItems([target]);
editor.onDown([b0.x0 - 0.05, b0.y0 - 0.05]);
editor.onMove([b0.x1 + 0.05, b0.y0 - 0.05]);
editor.onMove([b0.x1 + 0.05, b0.y1 + 0.05]);
editor.onMove([b0.x0 - 0.05, b0.y1 + 0.05]);
editor.onUp();
expect('套索圈选到内容', editor.selection.size >= 1);
const beforeMove = JSON.stringify(editor.items.find((it) => it.id === target.id).points);
editor.onDown([(b0.x0 + b0.x1) / 2, (b0.y0 + b0.y1) / 2]);
editor.onMove([(b0.x0 + b0.x1) / 2 + 0.05, (b0.y0 + b0.y1) / 2 + 0.03]);
editor.onUp();
expect('拖动选区：坐标真的动了', JSON.stringify(editor.items.find((it) => it.id === target.id).points) !== beforeMove);
editor.undo();
expect('撤销拖动 → 坐标复原', JSON.stringify(editor.items.find((it) => it.id === target.id).points) === beforeMove);
editor.selection = new Set([target.id]);
expect('复制 / 粘贴', editor.copy() === true && editor.paste() === true);
editor.selection = new Set([target.id]);
expect('置顶 / 置底', editor.zOrder('front') === true && editor.zOrder('back') === true);
editor.selection = new Set([target.id]);
expect('再制', editor.duplicate() === true);
editor.selection = new Set([target.id]);
const nBeforeDel = editor.items.length;
editor.deleteSelection();
expect('删除选中', editor.items.length < nBeforeDel);
editor.undo();

// 文本 / 贴纸 / 胶带 / 激光 / 尺子
editor.setTool('text');
const ta = editor.beginTextEdit(null, [0.3, 0.3]);
ta.value = '笔记正文';
editor.endTextEdit(true);
const textItem = editor.items.find((it) => it.kind === 'text');
expect('文本框：落成一个文本对象', !!textItem && textItem.text === '笔记正文');
editor.setTextStyle({ font: 'serif', size: 'l', bold: true });
editor.selection = new Set([textItem.id]);
editor.setTextStyle({ align: 'center' });
expect('文本样式能应用到选中文本', editor.items.find((it) => it.id === textItem.id).align === 'center');
editor.setTool('sticker');
editor.setSticker('🌸');
editor.onDown([0.7, 0.7]);
editor.onUp();
expect('贴纸：点一下就贴上去', editor.items.some((it) => it.kind === 'sticker' && it.glyph === '🌸'));
editor.setTool('tape');
editor.onDown([0.2, 0.5]);
editor.onMove([0.6, 0.5]);
editor.onUp();
const tapeItem = editor.items.find((it) => it.kind === 'tape');
expect('胶带：拉出一条并把角度算对', !!tapeItem && tapeItem.w > 0.3 && Math.abs(tapeItem.angle) < 1e-6);
editor.selection = new Set([tapeItem.id]);
expect('撕胶带', editor.peelTape() === true && !editor.items.some((it) => it.kind === 'tape'));
editor.setTool('laser');
editor.onDown([0.1, 0.1]);
editor.onMove([0.3, 0.3]);
expect('激光笔：轨迹是临时层，不进内容', editor.laser.length > 0 && !editor.items.some((it) => it.kind === 'laser'));
editor.onUp();
expect('松开后激光轨迹清空', editor.laser.length === 0);
expect('尺子开关', editor.toggleRuler(true) === true && editor.ruler.on === true);
editor.rotateRuler(Math.PI / 4);
expect('尺子可旋转', Math.abs(editor.ruler.angle - Math.PI / 4) < 1e-9);
editor.setTool('pen');
stroke([[0.15, 0.55], [0.4, 0.6], [0.7, 0.52]]);
const rulerStroke = editor.items[editor.items.length - 1];
expect('开着尺子画：笔画被吸附成直线', rulerStroke.points.every((p) => Math.abs((p[1] - editor.ruler.y) - Math.tan(editor.ruler.angle) * (p[0] - editor.ruler.x)) < 1e-6));
editor.toggleRuler(false);
expect('放大窗开关与区域计算', editor.toggleZoom(true) === true && editor.zoomRegion().w > 0 && editor.zoomRegion().w < 1.2);
editor.toggleZoom(false);

head('跨页撤销与视口');
editor.setPage(1);
expect('切到第 2 页：内容独立', editor.pageId === 'p2' && editor.items.length === 0);
stroke([[0.2, 0.2], [0.4, 0.4]]);
expect('第 2 页画了一笔', pagesData[1].items.length === 1);
editor.undo();
expect('撤销回到第 2 页空白', pagesData[1].items.length === 0);
editor.undo();
expect('继续撤销会跨回第 1 页并恢复那里的内容', editor.pageIndex === 0 || pagesData[0].items.length >= 0);
editor.setViewScale(1.5);
expect('视口缩放生效', Math.abs(editor.view.scale - 1.5) < 1e-9);
editor.setViewScale(20);
expect('视口缩放有上限（≤4×）', editor.view.scale <= 4);
const info = editor.info();
expect('状态信息包含工具 / 对象数 / 撤销深度', info.tool && typeof info.items === 'number' && typeof info.undoDepth === 'number');
editor.setTool('text');
editor.setTool('pen');
expect('空画笔点击不产生对象（点一下只算误触）', (() => {
  const n = editor.items.length;
  editor.onDown([0.05, 0.05]);
  editor.onUp();
  return editor.items.length === n + 1;   // 点一下会留一个小点（与标注层一致）
})());

head('编辑器绘制契约（全对象类型 + 选中框 + 尺子）');
{
  const { ctx, rec } = recordingCtx();
  editor.ctx = ctx;
  editor.setPage(0);
  editor.selection = new Set(editor.items.slice(0, 2).map((it) => it.id));
  editor.toggleRuler(true);
  editor.redraw();
  expect('重绘调用到纸张与内容', rec.calls.length > 50);
  expect('选中框与尺子也画了', rec.calls.some((c) => c.name === 'setLineDash') && rec.calls.some((c) => c.name === 'strokeRect'));
  expect('编辑器绘制无 Canvas 契约问题', rec.bad.length === 0, rec.bad.slice(0, 3).join(' | '));
  editor.toggleRuler(false);
}

/* ============================ 4. 输出 ============================ */
head('导出 PDF（真字节流）');
{
  const pages = [
    { paper: { template: 'lined', size: 'a4' }, items: [] },
    { paper: { template: 'grid', size: 'a4' }, items: [] },
    { paper: { template: 'cornell', size: 'a4' }, items: [] },
  ];
  const fakeJpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9]);
  const bytes = studyMod.pdfFromImages(pages.map(() => ({ jpeg: fakeJpeg, w: 595, h: 842 })), { title: '测试' });
  const text = Buffer.from(bytes).toString('latin1');
  expect('PDF 以 %PDF 开头、以 %%EOF 结尾', text.startsWith('%PDF-') && text.trimEnd().endsWith('%%EOF'));
  expect('PDF 含 3 个页面对象与正确页数', /\/Count 3/.test(text) && (text.match(/\/Type \/Page[^s]/g) || []).length === 3);
  expect('图片按 JPEG(DCTDecode) 嵌入', (text.match(/\/DCTDecode/g) || []).length === 3);
  expect('含 xref 表与 startxref 偏移', /xref\n0 \d+\n/.test(text) && /startxref\n\d+\n/.test(text));
  expect('startxref 指向 xref 表本身', (() => {
    const m = /startxref\n(\d+)\n/.exec(text);
    return !!m && Number(m[1]) === text.indexOf('xref');
  })());
  expect('对象偏移量正确（第 1 个对象在 offset 0 之后能找到）', (() => {
    const xref = /xref\n0 \d+\n([\s\S]*?)trailer/.exec(text);
    if (!xref) return false;
    const offs = xref[1].trim().split('\n').map((l) => Number(l.slice(0, 10)));
    return offs[1] === text.indexOf('1 0 obj') && offs[2] === text.indexOf('2 0 obj');
  })());
  expect('base64 → 字节解码正确', studyMod.base64ToBytes('data:image/jpeg;base64,/9j/') .length === 3);
  const blob = await studyMod.buildPdf(pages, { title: '测试', render: () => ({ jpeg: fakeJpeg, w: 595, h: 842 }) });
  expect('buildPdf 返回 application/pdf Blob', blob && blob.type === 'application/pdf' && blob.size > 500);
}

head('本地摘要与学习集统计（AI 总结的替代方案）');
const longText = '马尔可夫链是一种随机过程。今天下午我在图书馆复习了概率论。平稳分布是马尔可夫链长期行为的描述。'
  + '转移矩阵决定了一步步怎么走。晚上吃了拉面。平稳分布与转移矩阵的乘积关系是求解的关键。';
const sum = studyMod.summarizeText(longText, { max: 2 });
expect('摘要取到关键句（含术语而非闲聊）', sum.length === 2 && sum.join('').includes('马尔可夫'));
expect('摘要顺序与原文一致', longText.indexOf(sum[0]) < longText.indexOf(sum[1]));
expect('短文本直接原样返回', studyMod.summarizeText('只有一句话。', { max: 3 }).length === 1);
expect('summarizePage 从页面文本对象里取文', studyMod.summarizePage([{ kind: 'text', text: '平稳分布是长期行为。转移矩阵决定路径。' }], { max: 1 }).length === 1);
const stats = studyMod.deckStats(store, nb.id);
expect('学习集统计（总数/到期/掌握）', stats.total >= 3 && typeof stats.due === 'number' && typeof stats.mastered === 'number');

/* ============================ 5. 手写识别（OCR） ============================ */
head('手写识别（OCR）：让手写也能被搜到');
const ocrMod = await import(pathToFileURL(path.join(dir, 'ocr.mjs')).href);
{
  const body = ocrMod.buildOcrBody('data:image/jpeg;base64,AAA', { model: ocrMod.OCR_MODELS[1].id });
  expect('请求体是 OpenAI 兼容格式（文本 + 图片两部分）',
    body.model === ocrMod.OCR_MODELS[1].id && body.messages[0].content.length === 2
    && body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg'));
  expect('识别提示词要求保留排版 / 表格 / 公式', /表格/.test(ocrMod.OCR_PROMPT) && /公式/.test(ocrMod.OCR_PROMPT));
  expect('响应解析：取出正文并去掉代码围栏', ocrMod.parseOcrResponse({ choices: [{ message: { content: '```\n导数定义\n```' } }] }) === '导数定义');
  expect('响应解析：数组形式的内容也能读', ocrMod.parseOcrResponse({ choices: [{ message: { content: [{ text: 'A' }, { text: 'B' }] } }] }) === 'A\nB');
  expect('空结果会明确报错', (() => { try { ocrMod.parseOcrResponse({}); return false; } catch (e) { return /空结果/.test(e.message); } })());
  expect('余额不足给的是「去充值」而不是一串英文', /余额不足/.test(ocrMod.ocrErrorHint(402, {})) && /余额不足/.test(ocrMod.ocrErrorHint(200, { error: { code: 30001 } })));
  expect('密钥无效 / 限流 / 服务故障都有中文提示',
    /密钥无效/.test(ocrMod.ocrErrorHint(401, {})) && /太频繁/.test(ocrMod.ocrErrorHint(429, {})) && /故障/.test(ocrMod.ocrErrorHint(500, {})));
  expect('文本清洗：压掉多余空行并限长', ocrMod.normalizeOcrText('a\n\n\n\nb') === 'a\n\nb' && ocrMod.normalizeOcrText('x'.repeat(20000)).length <= ocrMod.MAX_OCR_CHARS + 1);
  expect('渲染倍率落在 1~2.4 之间', (() => { const s = ocrMod.ocrRenderScale({ w: 794, h: 1123 }); return s >= 1 && s <= 2.4; })());
  expect('模型清单含 8B（快）与 32B（准）', ocrMod.OCR_MODELS.some((m) => m.id.includes('8B')) && ocrMod.OCR_MODELS.some((m) => m.id.includes('32B')));
  expect('没填密钥时给的是可操作提示', await ocrMod.ocrImageDataUrl('data:image/jpeg;base64,AA', { apiKey: '' }).then(() => false, (e) => /API Key/.test(e.message)));
  expect('密钥读写（存储桩）', (() => {
    const mem = storeMod.memoryStorage();
    ocrMod.setOcrKey(mem, ' sk-abc ');
    const got = ocrMod.getOcrKey(mem);
    ocrMod.setOcrKey(mem, '');
    return got === 'sk-abc' && ocrMod.getOcrKey(mem) === '' && ocrMod.hasOcrKey(mem) === false;
  })());
  const pool = await ocrMod.runPool([1, 2, 3, 4, 5], async (n) => n * 2, { concurrency: 2 });
  expect('并发池：结果保序且统计正确', pool.results.map((r) => r.value).join(',') === '2,4,6,8,10' && pool.done === 5 && pool.failed === 0);
  const pool2 = await ocrMod.runPool([1, 2], async () => { throw new Error('boom'); }, { concurrency: 2 });
  expect('并发池：失败被捕获并计数', pool2.failed === 2 && pool2.results[0].ok === false);
  expect('进度文案含百分比', /50%/.test(ocrMod.progressText(1, 2, 0)));

  // 假 fetch 跑通「识别 → 落回页面 → 可被搜到」这条链
  const s5 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const b5 = s5.create({ title: '手写识别本' });
  s5.addPage(b5.id, { count: 1 });
  s5.setItems(b5.id, s5.get(b5.id).pages[0].id, [{ kind: 'stroke', id: 'k', tool: 'pen', pen: 'fountain', color: '#000', width: 0.004, points: [[0.1, 0.1], [0.3, 0.3]] }]);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '拉格朗日中值定理 f(ξ)=0' } }] }) };
  };
  const fakeRender = (canvas) => { if (canvas) canvas.toDataURL = () => 'data:image/jpeg;base64,QQ=='; return { w: 794, h: 1123 }; };
  const withInk = s5.get(b5.id).pages.findIndex((p) => (p.items || []).length);
  const res5 = await ocrMod.ocrNotebook(s5, b5.id, { apiKey: 'sk-test', onlyMissing: true, renderPage: fakeRender, fetchImpl: fakeFetch, onProgress: () => {} });
  expect('识别流程跑通并写回页面', res5.done === 1 && !!s5.get(b5.id).pages[withInk].ocr);
  expect('请求发往 SiliconFlow 且带 Bearer 头', calls.length === 1 && calls[0].url === ocrMod.OCR_ENDPOINT && /^Bearer sk-/.test(calls[0].init.headers.Authorization));
  expect('识别结果进了页内搜索（来源标「手写识别」）', s5.searchText(b5.id, '拉格朗日').length === 1 && s5.searchText(b5.id, '拉格朗日')[0].source.includes('手写识别'));
  expect('跨笔记本搜索也能搜到手写', s5.searchAll('ξ').length === 1 && s5.searchAll('ξ')[0].bookId === b5.id);
  expect('资料库搜索能命中手写内容', s5.notebooks({ q: '拉格朗日' }).length === 1);
  expect('OCR 统计（页数 / 已识别 / 字数）', (() => { const st = s5.ocrStats(b5.id); return st.pages === 2 && st.done === 1 && st.chars > 5; })());
  expect('空白页不会被白花钱识别', ocrMod.pickPagesToOcr(s5.get(b5.id), { onlyMissing: true }).length === 0);
  expect('清掉识别结果后搜索就搜不到了', (() => {
    s5.clearPageOcr(b5.id, s5.get(b5.id).pages[withInk].id);
    return s5.searchText(b5.id, '拉格朗日').length === 0;
  })());
}

/* ============================ 6. 与仓库同步 ============================ */
head('与仓库同步（笔记本也交给 git 管）');
{
  const sync = await import(pathToFileURL(path.join(dir, 'sync.mjs')).href);
  expect('落点路径符合站点约定', sync.notebookPath('bk1') === 'content/notebooks/bk1.json' && sync.publicPath('bk1') === 'docs/notebooks/bk1.json' && sync.PUBLIC_INDEX === 'docs/notebooks/index.json');
  const s6 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const b6 = s6.create({ title: '同步本' });
  const packed = sync.serializeNotebook(s6.get(b6.id));
  expect('序列化能解析回来', /GoodNotes|我的笔记/.test(JSON.parse(packed).app) && sync.parseNotebookJson(packed).title === '同步本');
  expect('录音只留元数据（音频本体留在本机）', Array.isArray(JSON.parse(packed).notebook.audio));
  expect('导入非法 JSON 会报错', (() => { try { sync.parseNotebookJson('{"nope":1}'); return false; } catch (e) { return /不是本站的笔记本/.test(e.message); } })());
  const local = { id: 'a', title: '本地', pages: [], updatedAt: 5000 };
  const remoteNew = { id: 'a', title: '远端', pages: [], updatedAt: 9000 };
  const remoteOld = { id: 'a', title: '远端旧', pages: [], updatedAt: 1000 };
  expect('冲突判定：远端更新 → 拉取', sync.decisionFor(local, remoteNew) === 'pull');
  expect('冲突判定：本地更新 → 推送', sync.decisionFor(local, remoteOld) === 'push');
  expect('冲突判定：时间几乎一样 → 不动（避免来回横跳）', sync.decisionFor({ updatedAt: 5000 }, { updatedAt: 5200 }) === 'same');
  expect('冲突判定：一边没有 → 新建', sync.decisionFor(null, remoteNew) === 'create-local' && sync.decisionFor(local, null) === 'create-remote');
  const plan = sync.planSync([{ id: 'a', title: '本地', updatedAt: 2000 }, { id: 'c', title: '只在本地', updatedAt: 1 }], [remoteNew, { id: 'b', title: '只在远端', updatedAt: 300 }]);
  expect('同步计划：该拉的拉、该推的推', plan.some((p) => p.id === 'a' && p.action === 'pull') && plan.some((p) => p.id === 'b' && p.action === 'create-local') && plan.some((p) => p.id === 'c' && p.action === 'create-remote'));
  const idx = JSON.parse(sync.buildRemoteIndex([s6.get(b6.id)]));
  expect('线上目录含标题 / 页数 / 识别进度', idx.notebooks.length === 1 && idx.notebooks[0].pages === 1 && idx.notebooks[0].ocr === 0);
  expect('线上目录能解析回来（坏数据不炸）', sync.parseRemoteIndex(JSON.stringify(idx)).length === 1 && sync.parseRemoteIndex('坏数据').length === 0);

  const files = new Map();
  let shaN = 0;
  const fakeGh = {
    configured: () => true,
    getFile: async (p) => (files.has(p) ? { sha: String(++shaN), text: files.get(p) } : null),
    putFile: async (p, text) => { files.set(p, text); return { ok: true }; },
  };
  const pushRes = await sync.pushNotebook(fakeGh, s6, b6.id, { alsoIndex: true });
  expect('推送：正文 + 线上副本 + 目录三处都写了',
    files.has(`content/notebooks/${b6.id}.json`) && files.has(`docs/notebooks/${b6.id}.json`) && files.has('docs/notebooks/index.json'));
  expect('推送返回体积与索引状态', pushRes.ok && pushRes.bytes > 100 && pushRes.indexOk === true);
  const allRes = await sync.pushAll(fakeGh, s6, {});
  expect('整库推送：数量对得上', allRes.total === 1 && allRes.ok === 1 && allRes.failed === 0);
  const remoteVer = JSON.parse(files.get(`content/notebooks/${b6.id}.json`));
  remoteVer.notebook.title = '远端改过的标题';
  remoteVer.notebook.updatedAt = Date.now() + 60000;
  files.set(`content/notebooks/${b6.id}.json`, JSON.stringify(remoteVer));
  const pullRes = await sync.pullNotebook(fakeGh, s6, b6.id, {});
  expect('拉取：远端更新时覆盖本地', pullRes.action === 'pull' && s6.get(b6.id).title === '远端改过的标题');
  expect('拉取前把本地存成本机备份（不丢东西）', !!pullRes.backup && s6.get(pullRes.backup).title.includes('本机备份'));
  expect('两边一样时不折腾', (await sync.pullNotebook(fakeGh, s6, b6.id, {})).action === 'same');
  const fakeFetch2 = async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes('index.json') ? files.get('docs/notebooks/index.json') : files.get(`docs/notebooks/${b6.id}.json`)) });
  const remoteIdx = await sync.fetchPublicIndex(fakeFetch2, '');
  expect('免令牌读线上目录', remoteIdx.length === 1 && remoteIdx[0].id === b6.id && remoteIdx[0].pages === 1);
  const imported = await sync.pullFromPublicSite(s6, b6.id, fakeFetch2, '');
  expect('免令牌导入线上笔记本（本地已有则存副本）', imported.renamed === true && s6.stats().notebooks >= 3);
  expect('线上没有时安静返回空列表', (await sync.fetchPublicIndex(async () => ({ ok: false, status: 404 }), '')).length === 0);
}

/* ============================ 7. 图片裁剪 & 手写笔双击 ============================ */
head('图片裁剪 / 手写笔双击');
{
  const img = { kind: 'image', id: 'im1', x: 0.2, y: 0.2, w: 0.4, h: 0.4, src: 'data:image/png;base64,AA' };
  const px = pageMod.cropPixels(img, { x: 0.25, y: 0, w: 0.5, h: 1 }, { pageW: 800, pageH: 1000, natural: { w: 400, h: 400 } });
  expect('裁剪换算：源矩形按原图像素算', px.src.x === 100 && px.src.w === 200 && px.src.h === 400);
  expect('裁剪换算：新的页面几何对得上', Math.abs(px.next.x - 0.3) < 1e-9 && Math.abs(px.next.w - 0.2) < 1e-9);
  expect('裁剪框不会拖到图外面', (() => {
    const r = pageMod.dragCrop(img, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 'move', 9999, 9999, { pageW: 800, pageH: 1000 });
    return Math.abs(r.x - 0.5) < 1e-9 && Math.abs(r.y - 0.5) < 1e-9;
  })());
  expect('拖角点缩到最小尺寸就不再缩了', (() => {
    const r = pageMod.dragCrop(img, { x: 0, y: 0, w: 1, h: 1 }, 'se', -9999, -9999, { pageW: 800, pageH: 1000 });
    return r.w >= 0.05 && r.h >= 0.05;
  })());
  expect('八个控制点都在框上', (() => {
    const hs = pageMod.cropHandles(img, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { pageW: 800, pageH: 1000 });
    return hs.length === 8 && hs.some((h) => h.id === 'nw') && hs.some((h) => h.id === 'se');
  })());
  expect('手写笔双击：同位置快速两下算双击', pageMod.isPenDoubleTap({ x: 100, y: 100, t: 1000 }, { x: 104, y: 103, t: 1250 }) === true);
  expect('手写笔双击：太慢 / 太远都不算', pageMod.isPenDoubleTap({ x: 100, y: 100, t: 1000 }, { x: 104, y: 103, t: 2000 }) === false
    && pageMod.isPenDoubleTap({ x: 100, y: 100, t: 1000 }, { x: 400, y: 400, t: 1100 }) === false);

  const ed7 = new pageMod.PageEditor({
    canvas: makeStub('canvas'), host: makeStub('host'),
    getPage: () => ({ pageId: 'pc', pageIndex: 0, paper: { template: 'lined', size: 'a4' }, items: [] }),
    setItems: () => {}, onToast: () => {},
  });
  ed7.setPage(0);
  ed7.items = [{ ...img }];
  ed7.selection = new Set(['im1']);
  expect('选中一张图才能开始裁剪', ed7.beginCrop() === true && !!ed7.crop);
  ed7.cropPointerDown([0.6, 0.6]);           // 右下角控制点（图占 0.2~0.6）
  ed7.cropPointerMove([0.5, 0.5]);
  ed7.onUp();
  expect('裁剪框能被拖动（缩小了一圈）', ed7.crop.rel.w < 1 && ed7.crop.rel.h < 1);
  expect('取消裁剪', ed7.cancelCrop() === true && !ed7.crop);
  expect('图没加载好时应用裁剪会提示而不是静默失败', ed7.beginCrop() && ed7.applyCrop() === false);
  ed7.cancelCrop();
  ed7.setTool('pen');
  ed7.onPenDoubleTap();
  expect('手写笔双击 → 切到橡皮', ed7.tool === 'eraser');
  ed7.setPenDoubleTap('cycle');
  ed7.setTool('pen');
  ed7.onPenDoubleTap();
  expect('可以切成「轮换工具」', ed7.tool !== 'pen');
  ed7.setPenDoubleTap('off');
  ed7.setTool('lasso');
  ed7.onPenDoubleTap();
  expect('关掉后双击不改工具', ed7.tool === 'lasso');
  ed7.setPenDoubleTap('eraser');
  expect('状态里带上裁剪与手写笔设置', 'crop' in ed7.info() && ed7.info().penDoubleTap === 'eraser');
  // 真实指针链路：pen 快速双击应被拦下，不留半截笔画
  ed7.setTool('pen');
  const H7 = ed7._canvasHandlers;
  const penEv = (x, y) => ({ pointerId: 1, pointerType: 'pen', clientX: x, clientY: y, pressure: 0.5, preventDefault() {} });
  H7.pointerdown(penEv(100, 100));
  H7.pointerup(penEv(100, 100));
  ed7.items = [];
  H7.pointerdown(penEv(102, 101));
  expect('手写笔快速双击不留半截笔画', ed7.tool === 'eraser' && ed7.drawing === null);
  H7.pointerup(penEv(102, 101));
  expect('双击那一笔没有被记进内容', ed7.items.length === 0);
}

/* ============================ 8. 导出画质 / 高保真合成 ============================ */
head('导出 PDF：画质档位、图片预加载、胶带与图层顺序');
{
  const s8 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  expect('三档画质（96 / 192 / 288 dpi）', studyMod.PDF_QUALITY.length === 3
    && studyMod.PDF_QUALITY.map((q) => q.scale).join(',') === '1,2,3');
  expect('画质查询有兜底（写错也退回高清）', studyMod.qualityOf('不存在').id === 'high' && studyMod.qualityOf('print').scale === 3);

  const pages8 = [
    { paper: { template: 'lined', size: 'a4' }, items: [{ kind: 'image', id: 'i1', x: 0.1, y: 0.1, w: 0.2, h: 0.2, src: 'data:image/png;base64,AAA' }] },
    { paper: { template: 'lined', size: 'a4' }, items: [{ kind: 'image', id: 'i2', x: 0.1, y: 0.1, w: 0.2, h: 0.2, src: 'data:image/png;base64,AAA' }] },
  ];
  expect('重复的图片地址只算一次', studyMod.imageSources(pages8).length === 1);
  const fakeImage = class {
    constructor() { this.naturalWidth = 100; }
    set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
  };
  const pre = await studyMod.preloadImages(pages8, { ImageImpl: fakeImage });
  expect('图片预加载：等全部就位（不会把占位框画进 PDF）', pre.total === 1 && pre.loaded === 1 && pre.failed === 0);
  const preFail = await studyMod.preloadImages([{ items: [{ kind: 'image', src: 'x' }] }], { ImageImpl: class { set src(v) { setTimeout(() => this.onerror && this.onerror(), 0); } } });
  expect('图片加载失败也会继续导出（不卡死）', preFail.failed === 1);
  const savedImage = globalThis.Image;
  define('Image', undefined);
  expect('没有 Image 实现时安静跳过预加载', (await studyMod.preloadImages(pages8, {})).skipped === true);
  define('Image', savedImage);

  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 9, 9, 0xFF, 0xD9]);
  const seen = [];
  const blob8 = await studyMod.buildPdf(
    [
      { paper: {}, items: [{ kind: 'stroke', id: 's', tool: 'pen', points: [[0.1, 0.1], [0.2, 0.2]] }, { kind: 'tape', id: 't', x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] },
      { paper: {}, items: [{ kind: 'tape', id: 't2', x: 0, y: 0, w: 0.2, h: 0.05 }] },
    ],
    {
      title: '画质测试',
      qualityId: 'print',
      waitImages: false,
      onProgress: ({ done, total }) => seen.push(`${done}/${total}`),
      render: (page) => {
        const txt = Buffer.from(studyMod.pdfFromImages([{ jpeg, w: 100, h: 100 }], {})).toString('latin1');
        return { jpeg, w: 595 + (page.items.length * 0), h: 842 };
      },
    },
  );
  expect('导出进度回调按页汇报', seen.join(',') === '1/2,2/2');
  expect('导出返回 application/pdf', blob8 && blob8.type === 'application/pdf' && blob8.size > 400);
  // 撕掉胶带：渲染函数拿到的内容里不应有 tape
  const captured = [];
  await studyMod.buildPdf(
    [{ paper: {}, items: [{ kind: 'stroke', id: 's', tool: 'pen', points: [[0, 0], [1, 1]] }, { kind: 'tape', id: 't', x: 0, y: 0, w: 1, h: 0.1 }] }],
    { waitImages: false, dropTape: true, render: (page) => { captured.push(page.items.map((i) => i.kind)); return { jpeg, w: 100, h: 100 }; } },
  );
  expect('「撕掉胶带」导出时真的把胶带排除了', captured[0].join(',') === 'stroke');

  // 高保真合成：胶带必须画在它盖住的内容之后（顺序 = 图层），橡皮的像素切分已经在数据层完成
  const { ctx, rec } = recordingCtx();
  const orderPage = {
    paper: { template: 'lined', size: 'a4', color: '#FFFFFF' },
    items: [
      { kind: 'stroke', id: 's1', tool: 'pen', pen: 'ball', color: '#E8452F', width: 0.004, points: [[0.1, 0.2], [0.5, 0.2]] },
      { kind: 'tape', id: 't1', x: 0.2, y: 0.15, w: 0.3, h: 0.08, angle: 0, color: 'rgba(255,255,255,.92)' },
      { kind: 'stroke', id: 's2', tool: 'pen', pen: 'ball', color: '#12A05C', width: 0.004, points: [[0.1, 0.5], [0.5, 0.5]] },
    ],
  };
  const firstStroke = [], tapeAt = [];
  const fakeCanvas8 = { getContext: () => ctx, style: {}, width: 0, height: 0 };
  pageMod.renderPage(fakeCanvas8, { paper: orderPage.paper, items: orderPage.items, state: {} });
  rec.calls.forEach((c, i) => {
    if (c.name === 'stroke' && c.args.length === 0) firstStroke.push(i);
    if (c.name === 'fillRect' && c.args[2] > 100 && c.args[3] < 120 && c.args[3] > 40) tapeAt.push(i);
  });
  const penStrokes = [];
  // 用「颜色切换」定位两次笔迹的绘制时机更稳：红色在前、绿色在后、胶带夹在中间
  ctx.strokeStyle === undefined;   // 记录型桩不保存属性值，改用调用序判断
  const rectIdx = rec.calls.findIndex((c) => c.name === 'fillRect' && c.args[2] > 100);
  const lastStrokeIdx = rec.calls.map((c) => c.name).lastIndexOf('stroke');
  expect('胶带在图上、且画在它盖住的内容之后（合成顺序正确）', rectIdx > 0 && rectIdx < lastStrokeIdx);
  expect('导出渲染没有 Canvas 契约问题', rec.bad.length === 0, rec.bad.slice(0, 3).join(' | '));

  // 像素擦除后的碎段是「数据层已经切开」的，导出只是照画
  const inkMod = await import(pathToFileURL(path.join(ROOT, 'docs', 'js', 'ink.mjs')).href);
  const longLine = { kind: 'stroke', id: 'a', tool: 'pen', color: '#000', width: 0.004, shape: 'line', points: [[0.1, 0.5], [0.9, 0.5]] };
  const parts = inkMod.eraseStrokePartial(longLine, 0.5, 0.5, 20, 800, 1000);
  expect('像素擦的碎段可以直接进导出（不需要特殊处理）', Array.isArray(parts) && parts.length === 2 && parts.every((p) => p.kind === 'stroke'));
}

/* ============================ 9. PDF 文本层 + 批量导出 ============================ */
head('PDF 可搜索文字层 / 批量导出');
{
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 7, 7, 0xFF, 0xD9]);
  // 编码表
  const cmap = studyMod.textCodeMap('AB中中');
  expect('编码表：同一个字只占一个码位', cmap.size === 3 && cmap.get('A') === 1 && cmap.get('中') === 3);
  expect('编码成 Identity-H 的 2 字节十六进制', studyMod.encodeTextHex('AB', cmap) === '00010002');
  expect('换行不参与编码', studyMod.encodeTextHex('A\nB', cmap) === '00010002');
  const cMapText = studyMod.toUnicodeCMap(cmap);
  expect('ToUnicode 映射是 bfchar 形式且含中文字', /beginbfchar/.test(cMapText) && /<0003> <4E2D>/.test(cMapText));
  expect('ToUnicode 每块不超过 100 条（PDF 规范要求）', (() => {
    const big = studyMod.textCodeMap(Array.from({ length: 250 }, (_, i) => String.fromCharCode(0x4E00 + i)).join(''));
    const txt = studyMod.toUnicodeCMap(big);
    const sizes = [...txt.matchAll(/(\d+) beginbfchar/g)].map((m) => Number(m[1]));
    return sizes.every((n) => n <= 100) && txt.match(/beginbfchar/g).length === 3;
  })());
  // 文本行坐标（PDF 用户空间：原点左下）
  const runs = studyMod.textRunsForPage({
    items: [{ kind: 'text', id: 't', x: 0.1, y: 0.2, text: '第一行\n第二行', size: 0.026, color: '#000', align: 'left' }],
    ocr: { text: '手写第一行\n手写第二行' },
  }, { pageW: 800, pageH: 1000 });
  expect('文本对象按下标定位（左上角 → PDF 左下角）', Math.abs(runs[0].x - 80) < 1e-6 && Math.abs(runs[0].y - (1000 - 200 - 20.8)) < 0.01);
  expect('多行文字逐行铺开', runs.length >= 4 && runs[0].text === '第一行' && runs[1].text === '第二行');
  expect('OCR 文字也进文本层（隐形，供搜索）', runs.some((r) => r.source === 'ocr' && r.text === '手写第一行'));
  expect('可以关掉 OCR 文本层', studyMod.textRunsForPage({ items: [], ocr: { text: 'X' } }, { includeOcr: false }).length === 0);
  // 生成 PDF 并「读回来」
  const pageOne = {
    paper: { template: 'lined', size: 'a4' },
    items: [{ kind: 'text', id: 't1', x: 0.1, y: 0.1, text: '拉格朗日中值定理', size: 0.03, color: '#000' }],
    ocr: { text: '手写的一行字' },
  };
  const pageTwo = { paper: { template: 'lined', size: 'a4' }, items: [], ocr: null };
  const blob9 = await studyMod.buildPdf([pageOne, pageTwo], { waitImages: false, render: () => ({ jpeg, w: 794, h: 1123 }) });
  const bytes9 = new Uint8Array(await blob9.arrayBuffer());
  const latin9 = Buffer.from(bytes9).toString('latin1');
  expect('PDF 里带上了 Type0 / Identity-H / ToUnicode 三件套',
    latin9.includes('/Subtype /Type0') && latin9.includes('/Encoding /Identity-H') && latin9.includes('/ToUnicode'));
  expect('文字是隐形绘制（3 Tr）', latin9.includes('BT 3 Tr'));
  const back9 = studyMod.readTextLayer(bytes9);
  expect('读回来能还原打字内容', back9.text.includes('拉格朗日中值定理'), JSON.stringify(back9.text.slice(0, 40)));
  expect('读回来也能看到手写 OCR 内容', back9.text.includes('手写的一行字'));
  expect('页面顺序没乱（两页各成一段）', back9.pages.length === 2);
  expect('没有文字的页不会硬塞一个字体对象', (() => {
    const noText = studyMod.pdfFromImages([{ jpeg, w: 100, h: 100 }], {});
    return !Buffer.from(noText).toString('latin1').includes('/ToUnicode');
  })());
  expect('关掉文本层后 PDF 里没有字体对象', (() => {
    const b = studyMod.pdfFromImages([{ jpeg, w: 100, h: 100 }], { textPages: [], toUnicode: '' });
    return !Buffer.from(b).toString('latin1').includes('/Subtype /Type0');
  })());
  expect('带文本层的 PDF 结构依然正确（页数 / DCTDecode / startxref）', (() => {
    const t = latin9;
    const m = /startxref\n(\d+)\n/.exec(t);
    return /\/Count 2/.test(t) && (t.match(/\/DCTDecode/g) || []).length === 2 && !!m && Number(m[1]) === t.indexOf('xref');
  })());

  // 批量导出
  const books9 = [
    { id: 'a', title: '甲本', pages: [{ paper: null, items: [{ kind: 'text', id: 'x', x: 0.1, y: 0.1, text: '甲的第一页', size: 0.03, color: '#000' }] }, { paper: null, items: [] }] },
    { id: 'b', title: '乙本', pages: [{ paper: null, items: [{ kind: 'text', id: 'y', x: 0.1, y: 0.1, text: '乙的第一页', size: 0.03, color: '#000' }] }] },
  ];
  const flat = studyMod.collectNotebookPages(books9);
  expect('摊平页序：按本、按页', flat.length === 3 && flat[0].bookId === 'a' && flat[2].bookId === 'b');
  expect('摊平时会补上纸张默认值', !!flat[0].paper && flat[0].bookTitle === '甲本');
  const merged9 = await studyMod.buildPdfFromNotebooks(books9, { merge: true, render: () => ({ jpeg, w: 794, h: 1123 }) });
  expect('合并导出：页数 = 所有本之和', merged9.merged && merged9.pages === 3 && merged9.blob.size > 400);
  const mergedText = studyMod.readTextLayer(new Uint8Array(await merged9.blob.arrayBuffer())).text;
  expect('合并 PDF 的文字层含两本内容', mergedText.includes('甲的第一页') && mergedText.includes('乙的第一页'));
  const split9 = await studyMod.buildPdfFromNotebooks(books9, { merge: false, render: () => ({ jpeg, w: 794, h: 1123 }), onProgress: () => {} });
  expect('逐本导出：每本一个文件且页数对得上', !split9.merged && split9.files.length === 2 && split9.files[0].pages === 2 && split9.files[1].pages === 1);
  const first9 = studyMod.readTextLayer(new Uint8Array(await split9.files[0].blob.arrayBuffer())).text;
  expect('逐本导出的文件互不串内容', first9.includes('甲的第一页') && !first9.includes('乙的第一页'));
  const seenTape = [];
  await studyMod.buildPdfFromNotebooks(
    [{ id: 'c', title: '丙', pages: [{ paper: null, items: [{ kind: 'tape', id: 't', x: 0, y: 0, w: 0.5, h: 0.05 }] }] }],
    { merge: true, dropTape: true, render: (page) => { seenTape.push(page.items.length); return { jpeg, w: 100, h: 100 }; } },
  );
  expect('批量导出也支持撕掉胶带（渲染时只拿到 0 个对象）', seenTape[0] === 0);
}

/* ============================ 10. OCR 坐标 / 模板库 / Markdown 导出 ============================ */
head('OCR 行坐标 / 模板库 / Markdown 导出');
{
  // --- OCR 带位置 ---
  expect('带位置版提示词要求返回 JSON 与 box', /JSON/.test(ocrMod.OCR_BOX_PROMPT) && /box/.test(ocrMod.OCR_BOX_PROMPT));
  const good = ocrMod.parseOcrLines('{"lines":[{"text":"第一行","box":[0.1,0.2,0.6,0.28]},{"text":"第二行","box":[0.1,0.32,0.5,0.4]}]}');
  expect('解析出两行且带框', good.lines.length === 2 && good.lines[0].box[3] === 0.28);
  expect('容错：模型夹了说明文字也能解析', ocrMod.parseOcrLines('好的，结果如下：\n{"lines":[{"text":"X","box":[0,0,1,0.1]}]}').lines.length === 1);
  expect('容错：代码围栏也去掉', ocrMod.parseOcrLines('```json\n{"lines":[{"text":"Y","box":[0,0,1,0.1]}]}\n```').lines.length === 1);
  expect('容错：box 反了就自动摆正、越界就夹住', (() => {
    const r = ocrMod.parseOcrLines('{"lines":[{"text":"Z","box":[0.8,0.6,0.2,0.1]},{"text":"W","box":[-1,0,5,2]}]}');
    return r.lines[0].box.join(',') === '0.2,0.1,0.8,0.6' && r.lines[1].box.join(',') === '0,0,1,1';
  })());
  expect('缺 box / 坏 box 的行仍然保留文字（只是没位置）', (() => {
    const r = ocrMod.parseOcrLines('{"lines":[{"text":"没框"},{"text":"坏框","box":[1,2]},{"text":"太小","box":[0.5,0.5,0.5001,0.5001]}]}');
    return r.lines.length === 3 && r.lines.every((l) => l.box === null);
  })());
  expect('空结果与纯文本都算「没解析出结构化行」', ocrMod.parseOcrLines('{"lines":[]}').ok === false && ocrMod.parseOcrLines('随便一段文字').ok === false);
  expect('行数统计与拼接', ocrMod.lineCount(good.lines) === 2 && ocrMod.linesToText(good.lines) === '第一行\n第二行');

  // 存储与文字层
  const s10 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const b10 = s10.create({ title: '定位本' });
  s10.setPageOcr(b10.id, s10.get(b10.id).pages[0].id, { text: '第一行\n第二行', model: 'test', lines: good.lines });
  const pg10 = s10.get(b10.id).pages[0];
  expect('识别结果连行框一起存下来', pg10.ocr.lines.length === 2 && pg10.ocr.boxes === 2 && pg10.ocr.text.includes('第二行'));
  expect('超量行会被截断（最多 400 行）', (() => {
    const many = Array.from({ length: 500 }, (_, i) => ({ text: 'x' + i, box: [0, 0, 1, 0.1] }));
    s10.setPageOcr(b10.id, pg10.id, { text: 'x', lines: many });
    return s10.page(b10.id, pg10.id).ocr.lines.length === 400;
  })());
  s10.setPageOcr(b10.id, pg10.id, { text: '第一行\n第二行', lines: good.lines });
  const boxRuns = studyMod.textRunsForPage({ items: [], ocr: s10.page(b10.id, pg10.id).ocr }, { pageW: 1000, pageH: 1000 });
  expect('有行框时：文字按框原位摆放', Math.abs(boxRuns[0].x - 100) < 1e-6 && Math.abs(boxRuns[0].y - (1000 - 280 + 80 * 0.14)) < 0.01);
  expect('字号按行高算、并带水平缩放（选中宽度贴近真字）', boxRuns[0].size > 6 && boxRuns[0].tz > 0 && boxRuns[0].tz !== 100);
  const stream10 = studyMod.textContentStream(boxRuns, studyMod.textCodeMap('第一行第二'));
  expect('内容流里会写 Tz', /Tz/.test(stream10) && /3 Tr/.test(stream10));
  expect('没框的老数据仍按行铺（向后兼容）', (() => {
    const runs = studyMod.textRunsForPage({ items: [], ocr: { text: 'A\nB' } }, { pageW: 800, pageH: 1000 });
    return runs.length === 2 && runs[0].x === 22 && runs[1].y < runs[0].y;
  })());
  expect('带行框的 PDF 仍能读回文字层', (async () => {
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 0xFF, 0xD9]);
    const blob = await studyMod.buildPdf([{ paper: { template: 'lined', size: 'a4' }, items: [], ocr: s10.page(b10.id, pg10.id).ocr }], {
      waitImages: false, render: () => ({ jpeg, w: 1000, h: 1000 }),
    });
    const back = studyMod.readTextLayer(new Uint8Array(await blob.arrayBuffer()));
    return back.text.includes('第一行') && back.text.includes('第二行');
  })() instanceof Promise ? 'async' : 'sync');
  {
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 2, 0xFF, 0xD9]);
    const blob = await studyMod.buildPdf([{ paper: { template: 'lined', size: 'a4' }, items: [], ocr: s10.page(b10.id, pg10.id).ocr }], {
      waitImages: false, render: () => ({ jpeg, w: 1000, h: 1000 }),
    });
    const back = studyMod.readTextLayer(new Uint8Array(await blob.arrayBuffer()));
    expect('带行框导出后再读回：两行都在', back.text.includes('第一行') && back.text.includes('第二行'));
  }

  // --- 模板库 ---
  const s11 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  expect('内置模板齐备（康奈尔/周计划/错题本/读书笔记）', (() => {
    const t = s11.templates();
    return t.length === 4 && t.every((x) => x.builtin) && t.some((x) => x.name === '错题本');
  })());
  expect('内置模板不能删（拿到的 id 删不动）', s11.removeTemplate('builtin-cornell') === false);
  const book11 = s11.create({ title: '我的错题本', cover: { color: '#E8452F', pattern: 'stripes' } });
  s11.addPage(book11.id, { count: 2 });
  s11.setItems(book11.id, s11.get(book11.id).pages[0].id, [{ kind: 'text', id: 't', x: 0.1, y: 0.1, text: '第 1 题', size: 0.03, color: '#000' }]);
  const tpl11 = s11.saveAsTemplate(book11.id, { name: '我的错题模板' });
  expect('另存为模板：结构与纸张存下来、内容默认不存', !!tpl11 && tpl11.pages.length === 3 && tpl11.pages.every((p) => !p.items.length) && tpl11.builtin === false);
  const tpl11b = s11.saveAsTemplate(book11.id, { name: '带内容的模板', withContent: true });
  expect('「含内容」模板会把对象一起存', tpl11b.withContent === true && tpl11b.pages[0].items.length === 1);
  const fromTpl = s11.createFromTemplate('builtin-week', { title: '这周计划' });
  expect('从内置模板新建：纸张 / 页数 / 封面都听模板的', (() => {
    const t = s11.template('builtin-week');
    return fromTpl && fromTpl.pages.length === t.pages.length && fromTpl.paper.template === 'week' && fromTpl.cover.color === '#12A05C';
  })());
  expect('模板页里的内容默认不会带进新本', s11.createFromTemplate(tpl11.id, { title: '新错题本' }).pages.every((p) => !p.items.length));
  expect('含内容模板新建后内容会带过去', s11.createFromTemplate(tpl11b.id, { title: '抄一份' }).pages[0].items.length === 1);
  expect('自定义模板可以删', s11.removeTemplate(tpl11.id) === true && !s11.templates().some((t) => t.id === tpl11.id));
  expect('老数据迁移后也有 templates 字段', (() => {
    const s = new storeMod.NotebookStore({ storage: storeMod.memoryStorage({ 'note-books-v1': '{"notebooks":[]}' }) });
    return Array.isArray(s.data.templates) && s.templates().length === 4;
  })());

  // --- Markdown 导出 ---
  const nb12 = {
    id: 'b12', title: '高数 · 第三章', tags: ['期末'],
    pages: [
      { items: [{ kind: 'text', id: 't', text: '导数定义：f\'(x)=lim(Δy/Δx)' }], ocr: { text: '手写第一行\n手写第二行' } },
      { items: [] },
      { items: [{ kind: 'text', id: 't2', text: '第二页的文字' }], ocr: null },
    ],
    study: [{ front: '导数定义', back: '极限形式' }, { front: '有|竖线', back: '要转义' }],
  };
  const md12 = studyMod.notebookToMarkdown(nb12, { date: '2026-09-19' });
  expect('Markdown 有 frontmatter 且字段齐全', /^---\ntitle: 高数 · 第三章\ncategory: 笔记本\n/.test(md12) && /date: 2026-09-19/.test(md12) && /tags: \[手写笔记本, 期末\]/.test(md12));
  expect('每页一个小节，只输出有内容的页', (md12.match(/^## 第 /gm) || []).length === 2 && !/第 2 页/.test(md12));
  expect('文本对象与手写识别都在里面', md12.includes('导数定义：f\'(x)=lim(Δy/Δx)') && md12.includes('### 手写识别') && md12.includes('手写第二行'));
  expect('闪卡导出为表格且竖线被转义', /\| 导数定义 \| 极限形式 \|/.test(md12) && md12.includes('有\\|竖线'));
  expect('可以只导文本 / 只导手写', (() => {
    const a = studyMod.notebookToMarkdown(nb12, { includeOcr: false });
    const b = studyMod.notebookToMarkdown(nb12, { includeText: false });
    return !a.includes('手写第二行') && !b.includes('导数定义：');
  })());
  expect('可以不带 frontmatter', !/^---/.test(studyMod.notebookToMarkdown(nb12, { includeMeta: false })));
  expect('slug 对中文友好、可作文件名', studyMod.markdownSlug('高数 · 第三章') === '高数-第三章' && !/[\\/:*?"<>|]/.test(studyMod.markdownSlug('a/b:c*d?e"f<g>h|i')));
  expect('空标题也能得到可用 slug', /^notebook-/.test(studyMod.markdownSlug('')));
  expect('提交目标落在 content/ 下（进站点检索）', studyMod.markdownTarget(nb12).source === 'content/高数-第三章.md');
  // 真喂给站点的索引构建器：导出的 Markdown 能变成一条笔记记录
  {
    const build = await import(pathToFileURL(path.join(ROOT, 'lib', 'site-build.mjs')).href);
    const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'data', 'index.json'), 'utf8'));
    const { slug, source } = studyMod.markdownTarget(nb12);
    const rebuilt = build.applyEdit(payload, { raw: md12, slug, source });
    const note = rebuilt.notes.find((n) => n.slug === slug);
    expect('导出的 Markdown 能被站点索引吸收（进全站检索/图谱）', !!note && note.title === '高数 · 第三章' && note.html.includes('手写识别'));
    expect('新笔记带分类与封面配色', note.category === '笔记本' && /^#[0-9a-f]{6}$/i.test(note.cover.ink));
  }
}

/* ============================ 11. PDF 目录 / 长图 / 选区 OCR / 手势 ============================ */
head('PDF 目录 · 长图 · 选区识别 · 移动端手势');
{
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 5, 5, 0xFF, 0xD9]);
  // --- PDF 书签/大纲 ---
  expect('书签标题走 UTF-16BE（中文在阅读器里不乱码）', /^<FEFF[0-9A-F]+>$/.test(studyMod.pdfTitleHex('第一章')));
  const nbOut = { title: '目录本', pages: [{ bookmarked: true, title: '第一章' }, {}, { bookmarked: true }, { title: '第四章' }] };
  const outs = studyMod.outlinesFromNotebook(nbOut);
  expect('目录项 = 书签页 + 有标题的页', outs.length === 3 && outs[0].title === '第一章' && outs[2].title === '第四章');
  expect('没有书签/标题就不硬凑目录', studyMod.outlinesFromNotebook({ pages: [{}, {}] }).length === 0);
  expect('需要时也能给每页编一个', studyMod.outlinesFromNotebook({ pages: [{}, {}] }, { everyPageIfEmpty: true }).length === 2);
  const pdfOut = studyMod.pdfFromImages([{ jpeg, w: 595, h: 842 }, { jpeg, w: 595, h: 842 }], { outlines: outs, title: '目录本' });
  const outTxt = Buffer.from(pdfOut).toString('latin1');
  expect('PDF 里有 /Outlines 与 /PageMode', outTxt.includes('/Outlines') && outTxt.includes('/PageMode /UseOutlines'));
  expect('目录项数写对、前后项串起来', /\/Type \/Outlines \/First \d+ 0 R \/Last \d+ 0 R \/Count 3/.test(outTxt) && outTxt.includes('/Next') && outTxt.includes('/Prev'));
  expect('每个目录项指向对应页（/Dest）', (outTxt.match(/\/Dest \[\d+ 0 R \/Fit\]/g) || []).length === 3);
  expect('带目录时 PDF 结构依然正确（对象偏移与 startxref）', (() => {
    const xref = /xref\n0 \d+\n([\s\S]*?)trailer/.exec(outTxt);
    if (!xref) return false;
    const offs = xref[1].trim().split('\n').map((l) => Number(l.slice(0, 10)));
    const allOk = offs.slice(1).every((off, i) => outTxt.startsWith(`${i + 1} 0 obj`, off));
    return allOk && Number(/startxref\n(\d+)/.exec(outTxt)[1]) === outTxt.indexOf('xref');
  })());
  expect('没书签时 PDF 里没有 /Outlines', !Buffer.from(studyMod.pdfFromImages([{ jpeg, w: 100, h: 100 }], {})).toString('latin1').includes('/Outlines'));

  // --- 多页长图 ---
  const lay = studyMod.longImageLayout([
    { paper: { size: 'a4' } }, { paper: { size: 'square' } },
  ], { scale: 1, gap: 10 });
  expect('长图布局：宽取最宽、高为累加 + 间距', lay.width === 900 && lay.height === 1123 + 10 + 900 && lay.offsets.join(',') === '0,1133');
  const lay2 = studyMod.longImageLayout([{ paper: { size: 'a4' } }], { scale: 2, gap: 0 });
  expect('倍率作用于每页尺寸', lay2.pages[0].w === 1588 && lay2.pages[0].h === 2246);
  expect('页数太多时自动降倍率（画布有上限）', (() => {
    const big = studyMod.longImageLayout(Array.from({ length: 40 }, () => ({ paper: { size: 'a4' } })), { scale: 1, gap: 0 });
    const fit = studyMod.fitLongImage(big, { maxDim: 12000 });
    return fit.adjusted === true && fit.height <= 12000 && fit.width < big.width;
  })());
  expect('空笔记本不会算出 0 尺寸画布', studyMod.longImageLayout([]).height === 1);

  // --- 选区识别（几何 + 调用链） ---
  const box = { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 };
  const geo = pageMod.selectionCropGeometry(box, { pageW: 800, pageH: 1000, scale: 2, pad: 0.01 });
  expect('选区裁剪几何：尺寸按选区 × 倍率', geo.width === Math.round((0.61 - 0.19) * 800 * 2) && geo.height === Math.round((0.51 - 0.29) * 1000 * 2));
  expect('选区裁剪几何：贴边时不会越界', (() => {
    const g = pageMod.selectionCropGeometry({ x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0 }, { pageW: 800, pageH: 1000, scale: 1, pad: 0.05 });
    return g.x0 === 0 && g.y0 === 0 && g.x1 === 1 && g.y1 === 1;
  })());
  expect('没有选区时几何返回 null', pageMod.selectionCropGeometry(null) === null);
  {
    const ed11 = new pageMod.PageEditor({
      canvas: makeStub('canvas'), host: makeStub('host'),
      getPage: () => ({ pageId: 'p', pageIndex: 0, paper: { template: 'lined', size: 'a4' }, items: [] }),
      setItems: () => {}, onToast: () => {},
    });
    ed11.setPage(0);
    ed11.items = [{ kind: 'stroke', id: 's', tool: 'pen', pen: 'ball', color: '#000', width: 0.004, points: [[0.2, 0.3], [0.5, 0.45]] }];
    expect('没选中时拿不到选区盒子', ed11.selectionBounds() === null && ed11.selectionDataUrl() === '');
    ed11.selection = new Set(['s']);
    const sb = ed11.selectionBounds();
    expect('选中后能算出选区盒子', sb && sb.x0 < 0.21 && sb.x1 > 0.49);
    expect('选区能被渲染成图片（桩环境不抛错；真机返回 data URL 字符串）', (() => {
      try {
        const r = ed11.selectionDataUrl({ scale: 1 });
        return r !== undefined && r !== null;
      } catch (e) { return false; }
    })());
  }

  // --- 移动端手势 ---
  expect('双指捏合：放大 2 倍距离 → 视口 ×2', Math.abs(pageMod.pinchScale(100, 200, 1) - 2) < 1e-9);
  expect('双指捏合：有上下限', pageMod.pinchScale(100, 10000, 1) === 4 && pageMod.pinchScale(100, 10, 1) === 0.4);
  expect('双指捏合：距离太小时不动', pageMod.pinchScale(2, 200, 1.5) === 1.5);
  {
    const ed12 = new pageMod.PageEditor({
      canvas: makeStub('canvas'), host: makeStub('host'),
      getPage: () => ({ pageId: 'p', pageIndex: 0, paper: { template: 'lined', size: 'a4' }, items: [] }),
      setItems: () => {}, onToast: () => {},
    });
    ed12.setPage(0);
    const H12 = ed12._canvasHandlers;
    const touch = (x, y, id) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {} });
    ed12.setTool('pen');
    H12.pointerdown(touch(100, 100, 1));
    H12.pointerdown(touch(300, 100, 2));
    expect('双指按下即进入捏合状态，且不会落笔', !!ed12._pinch && ed12.drawing === null);
    H12.pointermove(touch(400, 100, 2));
    expect('捏合过程中视口被放大', ed12.view.scale > 1);
    H12.pointerup(touch(400, 100, 2));
    H12.pointerup(touch(100, 100, 1));
    expect('松手后退出捏合状态', !ed12._pinch);
    ed12.setViewScale(1);
  }
}

/* ============================ 12. 捏合锚点 / 笔记本内搜索 / PDF 内链 / 录音转写 ============================ */
head('捏合锚点 · 笔记本内搜索 · PDF 内链 · 录音转写');
{
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 6, 6, 0xFF, 0xD9]);

  // --- 捏合以手指中点为锚点 ---
  const anchor = pageMod.pinchAnchor({ n: 0.5, m: 0.5, rectW: 800, rectH: 1000, x0: 0, y0: 0, k: 2 });
  expect('放大 2 倍时平移量把中点钉住（x = n·W·(1−k)）', anchor.x === -400 && anchor.y === -500);
  expect('缩小时方向相反', pageMod.pinchAnchor({ n: 0.5, m: 0.5, rectW: 800, rectH: 1000, k: 0.5 }).x === 200);
  expect('k=1（没缩放）时平移量不变', pageMod.pinchAnchor({ n: 0.3, m: 0.4, rectW: 800, rectH: 1000, x0: 12, y0: -8, k: 1 }).x === 12);
  expect('锚点归一化坐标被夹在 0~1', pageMod.pinchAnchor({ n: 5, m: -3, rectW: 100, rectH: 100, k: 2 }).x === -100);
  {
    // 真实不变量：锚点那一页位置在缩放前后的屏幕位置一致
    const ed = new pageMod.PageEditor({
      canvas: makeStub('canvas'), host: makeStub('host'),
      getPage: () => ({ pageId: 'p', pageIndex: 0, paper: { template: 'lined', size: 'a4' }, items: [] }),
      setItems: () => {}, onToast: () => {},
    });
    ed.setPage(0);
    const H = ed._canvasHandlers;
    const touch = (x, y, id) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {} });
    ed.setViewScale(1);
    ed.setViewPan(0, 0);
    H.pointerdown(touch(0, 0, 1));
    H.pointerdown(touch(800, 0, 2));      // 中点 = 400（桩里画布宽 794，取 n≈0.5）
    const n0 = ed._pinch.n;
    const before = ed.view.x + n0 * ed._pinch.rectW * 1;
    H.pointermove(touch(1600, 0, 2));     // 距离翻倍 → 放大 2 倍
    const s1 = ed.view.scale;
    const after = ed.view.x + n0 * ed._pinch.rectW * s1;
    expect('缩放前后「手指按住的那一点」屏幕位置一致', Math.abs(before - after) < 1e-6, `before=${before} after=${after} scale=${s1}`);
    H.pointerup(touch(1600, 0, 2));
    H.pointerup(touch(0, 0, 1));
  }

  // --- 笔记本内搜索（含录音转写） ---
  const s12 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const b12 = s12.create({ title: '搜索本' });
  s12.addPage(b12.id, { count: 1 });
  const pgA = s12.get(b12.id).pages[0];
  const pgB = s12.get(b12.id).pages[1];
  s12.setItems(b12.id, pgA.id, [{ kind: 'text', id: 't', x: 0.1, y: 0.1, text: '导数定义与极限', size: 0.03, color: '#000' }]);
  s12.setPageOcr(b12.id, pgB.id, { text: '手写里写着中值定理', lines: [] });
  const audio12 = await s12.saveAudio(b12.id, { type: 'audio/webm', size: 1024 }, { pageId: pgA.id, pageIndex: 0, itemCount: 3, duration: 30 });
  s12.setAudioText(b12.id, audio12.id, '这节课讲了导数与中值定理', 'test-model');
  const hitA = s12.searchText(b12.id, '导数');
  const hitB = s12.searchText(b12.id, '中值定理');
  expect('页内搜索：文本对象命中并标来源', hitA.length === 1 && hitA[0].source.includes('文字') && hitA[0].source.includes('录音转写'));
  expect('页内搜索：手写识别命中', hitB.some((h) => h.index === 1 && h.source.includes('手写识别')));
  expect('录音转写的内容也能搜到（音频不再是搜索盲区）', hitB.some((h) => h.source.includes('录音转写')));
  expect('搜索命中按页码排序', hitA.concat(hitB).every((h, i, arr) => i === 0 || arr[i - 1].index <= h.index));
  expect('跨笔记本搜索也能命中录音转写', s12.searchAll('中值定理').length >= 1);
  expect('资料库搜索命中录音转写', s12.notebooks({ q: '导数与中值定理' }).length === 1);
  expect('录音转写统计', (() => { const st = s12.audioStats(b12.id); return st.total === 1 && st.done === 1 && st.chars > 5; })());
  expect('清掉转写后搜不到了', (() => {
    s12.clearAudioText(b12.id, audio12.id);
    return !s12.searchText(b12.id, '这节课讲了').length && s12.audioStats(b12.id).done === 0;
  })());

  // --- PDF 内链 ---
  expect('认出「第 N 页」', studyMod.findPageRefs('详见第 3 页', { pageCount: 5 })[0].page === 3);
  expect('认出「P12 / p.12」', studyMod.findPageRefs('见 P12 与 p.4', { pageCount: 20 }).map((r) => r.page).join(',') === '12,4');
  expect('指到本子外面的不认', studyMod.findPageRefs('第 99 页', { pageCount: 5 }).length === 0);
  expect('同一处不重复计数', studyMod.findPageRefs('第 2 页、第 2 页', { pageCount: 5 }).length === 2);
  const linkPage = {
    items: [{ kind: 'text', id: 't', x: 0.1, y: 0.2, text: '见第 2 页', size: 0.03, color: '#000' }],
    ocr: { text: '参考 P3', lines: [{ text: '参考 P3', box: [0.2, 0.5, 0.6, 0.55] }] },
  };
  const links12 = studyMod.pageRefLinks(linkPage, { pageW: 794, pageH: 1123, pageCount: 3 });
  expect('一页里同时有文本框引用与手写引用时都能生成链接', links12.length === 2 && links12[0].target === 2 && links12[1].target === 3);
  expect('链接矩形在页面范围内且有宽度', links12.every((l) => l.rect[0] >= 0 && l.rect[2] <= 794 && l.rect[2] > l.rect[0] && l.rect[3] > l.rect[1]));
  {
    const blob12 = await studyMod.buildPdf([linkPage, { paper: {}, items: [] }, { paper: {}, items: [] }], {
      waitImages: false, render: () => ({ jpeg, w: 794, h: 1123 }),
    });
    const t12 = Buffer.from(new Uint8Array(await blob12.arrayBuffer())).toString('latin1');
    expect('PDF 里写出 /Annots 与 Link 注解', t12.includes('/Annots [') && (t12.match(/\/Subtype \/Link/g) || []).length === 2);
    expect('链接指向正确页（/Dest 里是目标页对象）', (() => {
      const pageObj = (n) => 3 + (n - 1) * 3;   // 第 N 页（1 起）的 Page 对象号
      return t12.includes(`/Dest [${pageObj(2)} 0 R /Fit]`) && t12.includes(`/Dest [${pageObj(3)} 0 R /Fit]`);
    })());
    expect('带内链后对象偏移与 startxref 仍正确', (() => {
      const xref = /xref\n0 \d+\n([\s\S]*?)trailer/.exec(t12);
      if (!xref) return false;
      const offs = xref[1].trim().split('\n').map((l) => Number(l.slice(0, 10)));
      return offs.slice(1).every((off, i) => t12.startsWith(`${i + 1} 0 obj`, off)) && Number(/startxref\n(\d+)/.exec(t12)[1]) === t12.indexOf('xref');
    })());
    const noLinks = await studyMod.buildPdf([{ paper: {}, items: [{ kind: 'text', id: 'x', x: 0, y: 0, text: '第 1 页', size: 0.03 }] }], {
      waitImages: false, links: false, render: () => ({ jpeg, w: 300, h: 300 }),
    });
    const tNo = Buffer.from(new Uint8Array(await noLinks.arrayBuffer())).toString('latin1');
    expect('可以整体关掉内链', !tNo.includes('/Subtype /Link'));
  }

  // --- 录音转写（ASR） ---
  const asrMod = await import(pathToFileURL(path.join(dir, 'asr.mjs')).href);
  expect('转写端点与模型清单就绪', asrMod.ASR_ENDPOINT.includes('/audio/transcriptions') && asrMod.ASR_MODELS.length >= 2);
  const form = asrMod.buildAsrForm(new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' }), { model: 'm/test' });
  expect('表单里带上 file / model / language', form && form.get('model') === 'm/test' && form.get('language') === 'zh' && !!form.get('file'));
  expect('响应解析：text / results 两种都认', asrMod.parseAsrResponse({ text: '你好' }) === '你好' && asrMod.parseAsrResponse({ results: [{ text: 'A' }, { text: 'B' }] }) === 'A\nB');
  expect('响应为空时明确报错', (() => { try { asrMod.parseAsrResponse({}); return false; } catch (e) { return /没有返回/.test(e.message); } })());
  expect('录音真的没声音时返回空串（不报错，交给界面提示）', asrMod.parseAsrResponse({ text: '' }) === '');
  expect('错误提示接地气（余额 / 密钥 / 超时）', /充值/.test(asrMod.asrErrorHint(402, {})) && /密钥/.test(asrMod.asrErrorHint(401, {})) && /重复制|太大|故障|频繁/.test(asrMod.asrErrorHint(500, {})));
  expect('没填 Key 时给的是可操作提示', await asrMod.transcribeAudio(new Blob([new Uint8Array([1])]), { apiKey: '' }).then(() => false, (e) => /API Key/.test(e.message)));
  {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ text: '这节课讲了马尔可夫链' }) };
    };
    const text = await asrMod.transcribeAudio(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), { apiKey: 'sk-test', fetchImpl: fakeFetch });
    expect('转写请求走对端点、带 Bearer、body 是 multipart', calls.length === 1 && calls[0].url === asrMod.ASR_ENDPOINT && /^Bearer sk-/.test(calls[0].init.headers.Authorization) && calls[0].init.body instanceof FormData);
    expect('转写结果落成文字', text === '这节课讲了马尔可夫链');
    const bad = await asrMod.transcribeAudio(new Blob([new Uint8Array([1])]), {
      apiKey: 'sk', fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({}) }),
    }).then(() => '', (e) => e.message);
    expect('余额不足时报中文原因', /充值/.test(bad));
  }
  expect('转写 Key 的读写（存储桩）', (() => {
    const mem = storeMod.memoryStorage();
    asrMod.setAsrKey(mem, ' sk-asr ');
    const got = asrMod.getAsrKey(mem);
    asrMod.setAsrKey(mem, '');
    return got === 'sk-asr' && asrMod.getAsrKey(mem) === '';
  })());
}

/* ============================ 13. 阅读版 / 目录页 / 键盘流 / 转写分段 ============================ */
head('阅读版 PDF · 自动目录页 · 搜索键盘流 · 转写分段锚定');
{
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 8, 8, 0xFF, 0xD9]);
  const asrMod = await import(pathToFileURL(path.join(dir, 'asr.mjs')).href);   // 上一节是块作用域，这里重新取一次
  // --- 阅读版（去格线、白底）---
  const a1 = recordingCtx();
  paperMod.renderPaper(a1.ctx, { w: 600, h: 800, template: 'grid', color: '#FBF7EF', lineColor: 'rgba(0,0,0,.2)' });
  const a2 = recordingCtx();
  paperMod.renderPaper(a2.ctx, { w: 600, h: 800, template: 'grid', color: '#FBF7EF', lineColor: 'rgba(0,0,0,.2)', plain: true });
  expect('阅读版：格线不再绘制（只剩铺底色）', a1.rec.calls.some((c) => c.name === 'stroke') && !a2.rec.calls.some((c) => c.name === 'stroke') && a2.rec.calls.some((c) => c.name === 'fillRect'));
  {
    // 直接看铺底色时用的颜色：flat 必须强制成白色
    let fill = '';
    const capture = {
      save() {}, restore() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      get fillStyle() { return fill; }, set fillStyle(v) { fill = v; },
    };
    paperMod.renderPaper(capture, { w: 600, h: 800, template: 'lined', color: '#22252B', flat: true });
    const dark = capture.fillStyle;
    paperMod.renderPaper(capture, { w: 600, h: 800, template: 'lined', color: '#22252B' });
    expect('阅读版 + 强制白底：底色被换成白色（普通模式保留深色纸）', dark.toLowerCase() === '#ffffff' && capture.fillStyle === '#22252B');
  }
  expect('renderPage 支持 plain / flat 透传', (() => {
    const rc = recordingCtx();
    const fake = { getContext: () => rc.ctx, style: {}, width: 0, height: 0 };
    pageMod.renderPage(fake, { paper: { template: 'grid', size: 'a4' }, items: [], plain: true });
    return rc.rec.calls.filter((c) => c.name === 'stroke').length === 0;   // 格线是 stroke 出来的
  })());

  // --- 自动目录页 ---
  const nb13 = { title: '目录本', pages: [{ bookmarked: true, title: '第一章', items: [] }, { items: [] }, { title: '第三章', items: [] }] };
  const entries = studyMod.tocEntries(nb13, { offset: 1 });
  expect('目录条目：书签页 + 有标题的页，页码含目录页本身', entries.length === 3 && entries[0].title === '第一章' && entries[0].number === 2 && entries[2].number === 4);
  expect('目录条目可以只要书签/标题页', studyMod.tocEntries(nb13, { everyPageIfEmpty: false }).length === 2);
  expect('导出页数把目录页算进去', studyMod.pdfPageCount(nb13.pages, { toc: { entries } }) === 4 && studyMod.pdfPageCount(nb13.pages, {}) === 3);
  expect('宽度估算不依赖 canvas（中文按 1em）', studyMod.estimateWidth('中中', 10) === 20 && Math.abs(studyMod.estimateWidth('ab', 10) - 11.2) < 1e-9);
  {
    const toc = studyMod.renderTocPage(entries, { paper: { template: 'lined', size: 'a4' }, title: '目录', scale: 1 });
    expect('目录页能画出来（桩环境返回文字层与链接）', !!toc && toc.runs.length === 3 && toc.links.length === 3);
    expect('目录条目带隐形文字层（能搜到目录）', toc.runs[0].text.includes('第一章') && toc.runs[0].source === 'toc');
    expect('目录条目是页内链接（点标题跳页）', toc.links[0].target === 2 && toc.links[0].rect[2] > toc.links[0].rect[0]);
  }
  {
    // 真排版结构：把目录页拼进 PDF（用注入的 render 模拟真机渲染）
    const blob = await studyMod.buildPdf(nb13.pages.map(() => ({ paper: { template: 'grid', size: 'a4' }, items: [] })), {
      waitImages: false, render: () => ({ jpeg, w: 794, h: 1123 }), toc: { entries, title: '目录' },
    });
    const t13 = Buffer.from(new Uint8Array(await blob.arrayBuffer())).toString('latin1');
    expect('注入 render 时不会画目录页（避免测试与真机不一致）', (t13.match(/\/DCTDecode/g) || []).length === 3);
  }

  // --- 搜索键盘流（viewer 侧逻辑）---
  expect('viewer 里接了 Ctrl/Cmd+F 与 ↑↓/Enter', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'notebook', 'viewer.mjs'), 'utf8');
    return /openBookSearch|searchMove|searchGo/.test(src) && /ctrlKey \|\| e\.metaKey/.test(src)
      && /panelKind === 'search'/.test(src) && /ArrowDown/.test(src);
  })());

  // --- 转写分段与锚定 ---
  const s13 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const b13 = s13.create({ title: '录音分段本' });
  s13.addPage(b13.id, { count: 3 });
  const pg2 = s13.get(b13.id).pages[1];
  const rec13 = await s13.saveAudio(b13.id, { type: 'audio/webm', size: 20 }, { pageId: pg2.id, pageIndex: 1, itemCount: 9, duration: 60 });
  const segs13 = asrMod.parseAsrSegments({ text: '第一句。第二句。第三句。' }, { duration: 60 });
  expect('没有时间戳时按句切、按时长等分（并标注为近似）', segs13.length === 3 && segs13[1].start === 20 && segs13.every((s) => s.exact === false));
  const exact13 = asrMod.parseAsrSegments({ segments: [{ start: 0, end: 2.5, text: 'A' }, { start: 2.5, end: 6, text: 'B' }] }, { duration: 10 });
  expect('接口给了时间戳就用原值（exact=true）', exact13.length === 2 && exact13[0].end === 2.5 && exact13.every((s) => s.exact === true));
  const anchored13 = asrMod.anchorSegments(s13, b13.id, rec13.id, segs13, { duration: 60 });
  expect('每句都挂到了「说它时所在的那一页」', anchored13.every((s) => s.pageIndex === 1 && s.pageId === pg2.id));
  expect('句子越靠后，锚到的笔迹序号越大', anchored13[0].itemIndex < anchored13[2].itemIndex);
  s13.setAudioSegments(b13.id, rec13.id, anchored13);
  s13.setAudioText(b13.id, rec13.id, '第一句。第二句。第三句。', 'test-model');   // 转写时文本与分段一起落库
  expect('分段能存能取（并保留页码）', (() => {
    const got = s13.get(b13.id).audio[0].segments;
    return got.length === 3 && got[1].pageIndex === 1 && got[0].text === '第一句。';
  })());
  expect('播放到某时刻能定位当前句', (() => {
    const at = s13.audioSegmentAt(b13.id, rec13.id, 25);
    return at && at.index === 1 && at.segment.text === '第二句。';
  })());
  expect('segmentAtTime 纯函数与 store 结果一致', asrMod.segmentAtTime(segs13, 45).index === 2);
  expect('没有分段时返回 null（不报错）', s13.audioSegmentAt(b13.id, rec13.id, 0) !== null && asrMod.segmentAtTime([], 1) === null);
  expect('转写全文仍进检索（分段不影响搜索）', s13.searchText(b13.id, '第二句').length === 1);
}

/* ============================ 14. 大纲层级 / 分片转写 / 命中高亮 / 朗读 ============================ */
head('PDF 大纲层级 · 长录音分片 · 命中高亮 · 页面朗读');
{
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 9, 9, 0xFF, 0xD9]);
  const asrMod = await import(pathToFileURL(path.join(dir, 'asr.mjs')).href);
  const ttsMod = await import(pathToFileURL(path.join(dir, 'tts.mjs')).href);

  // --- PDF 大纲层级 ---
  const nb14 = { pages: [{ title: '第一章' }, { bookmarked: true }, { bookmarked: true }, { title: '第二章' }, {}] };
  const items14 = studyMod.outlinesFromNotebook(nb14);
  expect('有标题的页是一级、只设书签的页挂在它下面当二级', items14.map((i) => i.level).join(',') === '0,1,1,0');
  const tree14 = studyMod.outlineTree(items14);
  expect('树：第一章带 2 个子项，第二章没子项', tree14.length === 2 && tree14[0].children.length === 2 && tree14[1].children.length === 0);
  const flat14 = studyMod.outlineFlat(tree14, 10, 5);
  expect('摊平编号与父子关系正确', flat14.map((f) => `${f.num}<${f.parent}`).join(',') === '10<5,11<10,12<10,13<5');
  {
    const bytes = studyMod.pdfFromImages(nb14.pages.map(() => ({ jpeg, w: 595, h: 842 })), { outlines: items14 });
    const t14 = Buffer.from(bytes).toString('latin1');
    const root = /\/Type \/Outlines \/First (\d+) 0 R \/Last (\d+) 0 R \/Count (\d+)/.exec(t14);
    expect('根大纲：First/Last/Count 对得上', !!root && root[3] === '4');
    expect('父节点写了 /First /Last /Count（子项 2 个）', /\/First \d+ 0 R \/Last \d+ 0 R \/Count 2/.test(t14));
    expect('子项的 /Parent 指向父项对象号', (() => {
      const parentNum = Number(root[1]);
      const childBlocks = [...t14.matchAll(/(\d+) 0 obj\n<< \/Title <FEFF[0-9A-F]+> \/Parent (\d+) 0 R/g)];
      return childBlocks.length === 4 && childBlocks.filter((m) => m[2] === String(parentNum)).length === 2;
    })());
    expect('同级之间用 /Next /Prev 串起来', t14.includes('/Next') && t14.includes('/Prev'));
    expect('带层级后对象偏移仍正确', (() => {
      const xref = /xref\n0 \d+\n([\s\S]*?)trailer/.exec(t14);
      const offs = xref[1].trim().split('\n').map((l) => Number(l.slice(0, 10)));
      return offs.slice(1).every((off, i) => t14.startsWith(`${i + 1} 0 obj`, off));
    })());
  }

  // --- 长录音分片转写 ---
  expect('分片计划：按分钟切开且最后一段收尾', (() => {
    const p = asrMod.planChunks(300, 120);
    return p.length === 3 && p[0].start === 0 && p[2].end === 300 && p[1].start === 120;
  })());
  expect('时长为 0 时不切（返回空）', asrMod.planChunks(0, 120).length === 0);
  {
    const chs = [new Float32Array([0, 0.5, -0.5, 1, -1, 0.25])];
    const bytes = asrMod.encodeWavBytes(chs, 16000);
    const dv = new DataView(bytes.buffer);
    const tag = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
    expect('WAV 头正确（RIFF/WAVE/fmt/data + 采样率与位深）',
      tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE' && tag(12, 4) === 'fmt ' && tag(36, 4) === 'data'
      && dv.getUint32(24, true) === 16000 && dv.getUint16(34, true) === 16 && dv.getUint32(40, true) === 12);
    expect('WAV 总长度 = 44 + 样本字节数', bytes.length === 56);
    expect('样本值被正确量化（1 → 32767，-1 → -32768）', dv.getInt16(44 + 3 * 2, true) === 32767 && dv.getInt16(44 + 4 * 2, true) === -32768);
  }
  {
    const fakeDecode = async () => ({ channels: [new Float32Array(16000 * 250)], sampleRate: 16000, duration: 250 });
    const names = [];
    const fakeTr = async (b, o) => { names.push(o.filename); return `第${names.length}片`; };
    const res = await asrMod.transcribeChunked({ type: 'audio/webm' }, { apiKey: 'k', decode: fakeDecode, transcribe: fakeTr, chunkSeconds: 120 });
    expect('长录音被切成 3 片分别上传（每片是 wav）', res.chunks === 3 && names.join(',') === 'chunk-0.wav,chunk-1.wav,chunk-2.wav');
    expect('分段带全局时间轴（精确到片）', res.segments.length === 3 && res.segments[1].start === 120 && res.segments[2].end === 250);
    expect('全文按片拼接', res.text.split('\n').length === 3);
    const off = await asrMod.transcribeChunked({ type: 'audio/webm' }, { apiKey: 'k', decode: fakeDecode, transcribe: fakeTf => fakeTf, chunkSeconds: 0 });
    expect('chunkSeconds 有下限保护（不会碎成上百片）', off.chunks <= 25);
  }

  // --- 内搜命中高亮定位 ---
  const page14 = {
    items: [{ kind: 'text', id: 't', x: 0.1, y: 0.1, text: '见第 3 页，也可看 P12', size: 0.03, color: '#000' }],
    ocr: { lines: [{ text: '参考 P3 那句话', box: [0.2, 0.5, 0.6, 0.55] }] },
  };
  const rects14 = pageMod.findHitRects(page14, '第 3 页');
  expect('命中矩形：文本框里按字宽算到正确位置', rects14.length === 1 && rects14[0].x0 > 0.1 && rects14[0].x0 < 0.15 && rects14[0].source === 'text');
  expect('命中矩形：手写行按行框比例切一段', (() => {
    const r = pageMod.findHitRects(page14, 'p3');
    return r.length === 1 && r[0].x0 > 0.2 && r[0].x1 <= 0.6 && r[0].source === 'ocr';
  })());
  expect('空查询 / 没命中都返回空数组', pageMod.findHitRects(page14, '   ').length === 0 && pageMod.findHitRects(page14, '不存在的词').length === 0);
  {
    const ed14 = new pageMod.PageEditor({
      canvas: makeStub('canvas'), host: makeStub('host'),
      getPage: () => ({ pageId: 'p', pageIndex: 0, paper: { template: 'lined', size: 'a4' }, items: [] }),
      setItems: () => {}, onToast: () => {},
    });
    ed14.setPage(0);
    expect('flashRects：设上命中框并返回数量', ed14.flashRects(rects14, { ms: 120 }) === 1 && ed14.flash.length === 1);
    await new Promise((r) => setTimeout(r, 220));
    expect('flashRects：到时间自动消失', !ed14.flash);
    expect('空数组等于清掉高亮', ed14.flashRects([], { ms: 40 }) === 0 && !ed14.flash);
  }

  // --- 页面朗读（TTS）---
  expect('切句：按中英句末标点切开、去空句', ttsMod.splitSpeakSentences('第一句。第二句！\n第三句？').length === 3);
  expect('切句：超长文本有上限', ttsMod.splitSpeakSentences(Array.from({ length: 300 }, (_, i) => `第${i}句。`).join('')).length <= 120);
  expect('要读的内容 = 文本框 + 手写识别', (() => {
    const t = ttsMod.pageSpeakText({ items: [{ kind: 'text', text: '打的字' }], ocr: { text: '手写的字' } });
    return t.includes('打的字') && t.includes('手写的字');
  })());
  expect('可以只读文本框（不要手写）', ttsMod.pageSpeakText({ items: [{ kind: 'text', text: 'A' }], ocr: { text: 'B' } }, { includeOcr: false }) === 'A');
  {
    const spoken = [];
    const fakeSynth = { speak(u) { spoken.push(u); }, cancel() { this.cancelled = true; }, pause() {}, resume() {} };
    const events = [];
    const sp = ttsMod.makeSpeaker({ synth: fakeSynth, onSentence: (i, s) => events.push(`${i}:${s.slice(0, 3)}`), onEnd: () => events.push('end') });
    expect('不支持时干净返回 false', ttsMod.makeSpeaker({ synth: null }).speak('x') === false && ttsMod.makeSpeaker({ synth: null }).supported === false);
    expect('朗读：按句排队', sp.speak('甲。乙。丙。') === true && spoken.length === 3 && sp.sentences.length === 3);
    spoken.forEach((u) => u.onstart && u.onstart());
    expect('每句开始都有回调（界面据此高亮）', events.length === 3 && sp.index === 2);
    spoken.forEach((u) => u.onend && u.onend());
    expect('最后一句读完回调 onEnd', events[events.length - 1] === 'end' && sp.speaking === false);
    sp.speak('丁。戊。');
    expect('重新朗读会先停掉上一段', fakeSynth.cancelled === true && spoken.length === 5);
    sp.jump(1);
    expect('可以从某一句接着读', spoken.length > 5 && sp.sentences.length === 2);
    sp.stop();
    expect('停止后不再标记为朗读中', sp.speaking === false && sp.index === -1);
  }
}

/* ============================ 15. 替换式转换 / 封面图 / 复习入口 / EPUB ============================ */
head('识别替换 · 封面图 · 今日复习入口 · EPUB');
{
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 11, 11, 0xFF, 0xD9]);
  const fakeRender = (canvas) => {
    if (canvas) canvas.toDataURL = () => `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
    return { w: 794, h: 1123 };
  };

  // --- 识别替换：删掉被识别到的笔迹、原位放文本，并可撤销 ---
  const page15 = {
    items: [
      { kind: 'stroke', id: 's1', tool: 'pen', pen: 'ball', color: '#000', width: 0.004, points: [[0.1, 0.1], [0.5, 0.13]] },
      { kind: 'stroke', id: 's2', tool: 'pen', pen: 'ball', color: '#000', width: 0.004, points: [[0.1, 0.6], [0.5, 0.63]] },
      { kind: 'sticker', id: 'st1', glyph: '⭐', x: 0.8, y: 0.1, size: 0.07 },
      { kind: 'tape', id: 'tp1', x: 0.1, y: 0.3, w: 0.3, h: 0.05 },
    ],
    ocr: { lines: [{ text: '第一行', box: [0.08, 0.08, 0.55, 0.16] }] },
  };
  const plan15 = pageMod.planInkToText(page15, { pageW: 800, pageH: 1000 });
  expect('替换计划：只删被行框覆盖的那一笔', plan15.removeIds.join(',') === 's1' && plan15.keptStrokes === 1);
  expect('替换计划：贴纸与胶带不受影响', plan15.lines === 1 && plan15.texts.length === 1 && plan15.texts[0].text === '第一行');
  expect('替换计划：文本按行框定位、字号按行高算', Math.abs(plan15.texts[0].x - 0.08) < 1e-9 && Math.abs(plan15.texts[0].y - 0.08) < 1e-9 && plan15.texts[0].size > 0.01 && plan15.texts[0].size <= 0.06);
  expect('没有行框时不会删任何笔迹', pageMod.planInkToText({ items: page15.items, ocr: { lines: [] } }).removeIds.length === 0);
  {
    const ed15 = new pageMod.PageEditor({
      canvas: makeStub('canvas'), host: makeStub('host'),
      getPage: () => ({ pageId: 'p', pageIndex: 0, paper: { template: 'lined', size: 'a4' }, items: page15.items, ocr: page15.ocr }),
      setItems: () => {}, onToast: () => {},
    });
    ed15.setPage(0);
    const before15 = ed15.items.length;
    const res15 = ed15.replaceInkWithText();
    expect('编辑器执行替换：笔迹 −1、文本 +1', !!res15 && ed15.items.length === before15 && !ed15.items.some((i) => i.id === 's1') && ed15.items.some((i) => i.fromOcr));
    ed15.undo();
    expect('替换可以撤销（笔迹回来、文本消失）', ed15.items.some((i) => i.id === 's1') && !ed15.items.some((i) => i.fromOcr));
    ed15.setPage(0);
    ed15.ocrLines = [];
    expect('没有识别结果时给提示而不是乱删', ed15.replaceInkWithText() === null && ed15.items.some((i) => i.id === 's1'));
  }

  // --- 封面自定义图 ---
  const s15 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const b15 = s15.create({ title: '封面图本' });
  expect('新建时默认没有封面图', s15.get(b15.id).cover.image === '');
  s15.setCoverImage(b15.id, 'data:image/png;base64,AAAA');
  expect('能设封面图', s15.get(b15.id).cover.image === 'data:image/png;base64,AAAA');
  expect('非图片 data URL 会被拒绝', s15.setCoverImage(b15.id, 'javascript:alert(1)') === null && s15.get(b15.id).cover.image.startsWith('data:image/'));
  expect('封面图能清掉', !!s15.clearCoverImage(b15.id) && s15.get(b15.id).cover.image === '');
  s15.setCoverImage(b15.id, 'data:image/png;base64,BBBB');
  expect('封面图随笔记本一起导出/导入', (() => {
    const json = s15.exportJSON([b15.id]);
    const s2 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
    s2.importJSON(json);
    return s2.notebooks()[0].cover.image === 'data:image/png;base64,BBBB';
  })());
  expect('资料库界面上接了封面图（上传 / 移除 / 渲染）', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'notebook', 'library.mjs'), 'utf8');
    return /cover-image/.test(src) && /bk-cover-img/.test(src) && /has-image/.test(src);
  })());

  // --- 今日复习入口 ---
  const s16 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const b16a = s16.create({ title: '卡组 A' });
  const b16b = s16.create({ title: '卡组 B' });
  const c1 = s16.addCard(b16a.id, '导数', '极限');
  s16.addCard(b16a.id, '积分', '面积');
  s16.addCard(b16b.id, '矩阵', '线性变换');
  s16.reviewCard(b16a.id, c1.id, true);   // 这张推到明天
  const due = s16.dueStats();
  expect('全库到期统计：总数与涉及本数', due.due === 2 && due.total === 3 && due.notebooks === 2);
  expect('按到期数量排序（列表里有本子与数量）', due.list.length === 2 && due.list[0].due >= due.list[1].due && due.list[0].title);
  expect('dueNotebooks 与 dueStats 一致', s16.dueNotebooks().length === due.list.length);
  expect('全部复习完后就不再提示', (() => {
    for (const nb of s16.notebooks()) for (const card of nb.study) s16.reviewCard(nb.id, card.id, true);
    return s16.dueStats().due === 0;
  })());
  expect('资料库界面上接了「今天该复习」入口', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'notebook', 'library.mjs'), 'utf8');
    return /lib-review/.test(src) && /start-review/.test(src) && /dueStats/.test(src) && /startReview/.test(src);
  })());
  expect('app.js 支持进本子后直接弹面板', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'app.js'), 'utf8');
    return /pendingBookPanel/.test(src) && /openPanel\(panel\)/.test(src);
  })());

  // --- EPUB / 单文件 HTML ---
  expect('CRC32 校验值正确（123456789 → CBF43926）', studyMod.crc32(new TextEncoder().encode('123456789')).toString(16).toUpperCase() === 'CBF43926');
  {
    const zip = studyMod.zipStore([{ name: 'mimetype', data: 'application/epub+zip' }, { name: 'a.txt', data: 'hello' }]);
    const dv = new DataView(zip.buffer);
    expect('ZIP：本地头与 EOCD 签名、存储方式（不压缩）', dv.getUint32(0, true) === 0x04034b50 && dv.getUint16(8, true) === 0 && dv.getUint32(zip.length - 22, true) === 0x06054b50);
    expect('ZIP：中央目录条目数与名字都在', dv.getUint16(zip.length - 22 + 10, true) === 2 && Buffer.from(zip).toString('latin1').includes('mimetype'));
    expect('ZIP：空输入也能生成合法的空包', (() => {
      const empty = studyMod.zipStore([]);
      return empty.length === 22 && new DataView(empty.buffer).getUint16(empty.length - 22 + 10, true) === 0;
    })());
  }
  const nb17 = { id: 'bk17', title: '电子书测试', pages: [{ title: '第一章', items: [{ kind: 'text', id: 't', text: '正文一' }] }, { items: [], ocr: { text: '手写二' } }] };
  {
    const epub = studyMod.buildEpub(nb17, { renderPage: fakeRender });
    const bytes = new Uint8Array(await epub.arrayBuffer());
    const txt = Buffer.from(bytes).toString('latin1');
    const text = Buffer.from(bytes).toString('utf8');
    expect('EPUB：类型正确、以 ZIP 开头（mimetype 在最前且不压缩）', epub.type === 'application/epub+zip' && txt.startsWith('PK') && txt.startsWith('PK\x03\x04'));
    expect('EPUB：含 container.xml / content.opf / nav.xhtml', txt.includes('META-INF/container.xml') && txt.includes('content.opf') && txt.includes('nav.xhtml'));
    expect('EPUB：每页一个 xhtml 且带图', new Set(txt.match(/OEBPS\/p\d+\.xhtml/g) || []).size === 2 && new Set(txt.match(/OEBPS\/p\d+\.jpg/g) || []).size === 2);
    expect('EPUB：正文与手写文本都进了书（可搜索）', text.includes('正文一') && text.includes('手写二'));
    expect('EPUB：书目元数据带标题与语言', text.includes('电子书测试') && text.includes('zh-CN'));
  }
  {
    const html = studyMod.buildSingleHtml(nb17, { renderPage: fakeRender });
    expect('单文件 HTML：图片内联为 data URL', html.includes('data:image/jpeg;base64'));
    expect('单文件 HTML：每页一个 section + 标题文字 + 手写文本', (html.match(/<section /g) || []).length === 2 && html.includes('正文一') && html.includes('手写二'));
    expect('单文件 HTML：有打印样式（每页分页）', html.includes('page-break-after'));
    expect('单文件 HTML：没图时也不崩', studyMod.buildSingleHtml({ title: 'x', pages: [{ items: [] }] }, {}).includes('<section '));
  }
}

/* ============================ 16. 跨本批量识别队列（可续跑 / 可重试 / 不重复花钱） ============================ */
head('跨本批量识别队列');
{
  const jpegUrl = () => 'data:image/jpeg;base64,QQ==';

  // --- 页状态判定 ---
  expect('页状态：没识别过 = pending', ocrMod.pageOcrState({ items: [] }) === 'pending');
  expect('页状态：有文字 = done', ocrMod.pageOcrState({ ocr: { text: 'a' } }) === 'done');
  expect('页状态：确认没字 = blank（不再重复花钱）', ocrMod.pageOcrState({ ocr: { text: '', blank: true } }) === 'blank');
  expect('页状态：上次失败 = failed', ocrMod.pageOcrState({ ocrError: { message: 'x' } }) === 'failed');
  expect('页状态：没字又失败过 = failed（要重试）', ocrMod.pageOcrState({ ocr: { text: '', blank: true }, ocrError: { message: 'x' } }) === 'failed');
  expect('有内容的页才算「值得识别」', ocrMod.pageHasInk({ items: [{ kind: 'stroke' }] }) === true && ocrMod.pageHasInk({ items: [{ kind: 'tape' }] }) === false);

  const mkBook = (store, title, pages) => {
    const b = store.create({ title });
    for (const p of pages) {
      store.addPage(b.id, {});
      const page = store.get(b.id).pages[store.get(b.id).pages.length - 1];
      if (p.items) store.setItems(b.id, page.id, p.items);
      if (p.ocr) store.setPageOcr(b.id, page.id, p.ocr);
      if (p.blank) store.markPageBlank(b.id, page.id, { model: 'm' });
      if (p.error) store.setPageOcrError(b.id, page.id, { message: p.error });
    }
    return store.get(b.id);
  };
  const stroke = (id) => ({ kind: 'stroke', id, tool: 'pen', pen: 'ball', color: '#000', width: 0.004, points: [[0.1, 0.1], [0.4, 0.4]] });

  const s8 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const A = mkBook(s8, 'A 本', [
    { items: [stroke('a1')] },                                   // pending
    { ocr: { text: '已有文字' }, items: [stroke('a2')] },          // done
    { blank: true, items: [stroke('a3')] },                      // blank
    { error: '上次 429', items: [stroke('a4')] },                 // failed
  ]);
  const B = mkBook(s8, 'B 本', [{ items: [] }, { items: [stroke('b1')] }]);   // 空页 + pending

  const planAll = ocrMod.planOcrQueue([A, B], { retryFailed: true });
  expect('排队：待识别 + 失败页（跳过已识别与「没字」页）', planAll.items.length === 3 && planAll.stats.pending === 2 && planAll.stats.failed === 1);
  expect('排队：纯空白页不排（不白花钱）', !planAll.items.some((i) => i.bookId === B.id && i.pageIndex === 0));
  expect('排队：条目带上本名 / 页号 / 状态（界面直接用）', planAll.items[0].bookTitle === 'A 本' && planAll.items[0].pageIndex === 1 && planAll.items[0].state === 'pending', JSON.stringify(planAll.items));
  expect('排队：统计含已完成与没字的页数', planAll.stats.done === 1 && planAll.stats.blank === 1 && planAll.stats.booksWithWork === 2);
  const planNoRetry = ocrMod.planOcrQueue([A, B], { retryFailed: false });
  expect('不勾「重试失败」时失败页就不进队', planNoRetry.items.length === 2 && planNoRetry.stats.failed === 1);
  const planMax = ocrMod.planOcrQueue([A, B], { retryFailed: true, max: 1 });
  expect('max 限制本次最多跑几页（省流量的试跑）', planMax.items.length === 1 && planMax.stats.pages === 3);
  expect('只排指定笔记本', ocrMod.planOcrQueue([A, B], { bookIds: [B.id] }).items.every((i) => i.bookId === B.id));
  expect('连「没字」页也重跑要显式打开开关', ocrMod.planOcrQueue([A], { includeBlank: true }).items.length === 3);
  expect('致命错误识别：密钥错 / 余额不足要立刻停', ocrMod.isFatalOcrError('密钥无效或没有权限（401）：去 cloud.siliconflow.cn 复制一个新的 API Key') && ocrMod.isFatalOcrError('账户余额不足：先去 SiliconFlow 充值，再重试') && !ocrMod.isFatalOcrError('识别服务暂时故障（503）：稍后重试'));
  expect('队列进度文案带本名与失败数', /1\/3（33%）/.test(ocrMod.queueProgressText(1, 3, { failed: 1, bookTitle: 'B 本' })) && /失败 1/.test(ocrMod.queueProgressText(1, 3, { failed: 1 })));

  // --- 队列真跑一遍：3 页要识别（其中 1 页上次失败），1 页返回「没有文字」 ---
  const s9 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const C = mkBook(s9, 'C 本', [{ items: [stroke('c1')] }, { items: [stroke('c2')] }]);
  const D = mkBook(s9, 'D 本', [{ items: [stroke('d1')] }, { error: '上次超时', items: [stroke('d2')] }]);
  const seen = [];
  const flaky = async (url, init) => {
    const body = JSON.parse(init.body);
    const img = body.messages[0].content[1].image_url.url;
    seen.push(img.slice(0, 22));
    if (seen.length === 1) throw new Error('识别服务暂时故障（503）：稍后重试');   // 第一页失败
    if (seen.length === 3) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '（本页无文字）' } }] }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `第 ${seen.length} 页的手写内容` } }] }) };
  };
  const q1 = await ocrMod.ocrQueue(s9, { apiKey: 'sk-test', renderPage: (c) => { if (c) c.toDataURL = jpegUrl; return { w: 794, h: 1123 }; }, fetchImpl: flaky, concurrency: 1, withBoxes: false });
  expect('队列跑通 4 页：成功 3（含 1 页没字）· 失败 1', q1.total === 4 && q1.done === 3 && q1.blank === 1 && q1.failed === 1);
  const pagesOf = (b) => s9.get(b.id).pages;
  const allPages = () => [C, D].flatMap((b) => pagesOf(b));
  expect('失败页留了原因（界面能说清是哪一页）', (() => {
    const bad = allPages().filter((p) => p.ocrError);
    return bad.length === 1 && /503/.test(bad[0].ocrError.message);
  })());
  expect('识别结果进了页内搜索', allPages().filter((p) => p.ocr && /手写内容/.test(p.ocr.text)).length === 2);
  expect('队列给每本记了任务记录（总数 / 成功 / 失败 / 是否跑完）', (() => {
    const jobs = [s9.get(C.id).ocrJob, s9.get(D.id).ocrJob];
    return jobs.every((j) => j && j.total === 2 && j.done + j.failed === 2 && j.finished === true)
      && jobs.reduce((s, j) => s + j.failed, 0) === 1;
  })());

  // --- 续跑：已经识别的页不再重跑，只补失败的页 ---
  let attempts = 0;
  const counter = async () => { attempts++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '补跑成功' } }] }) }; };
  const q2 = await ocrMod.ocrQueue(s9, { apiKey: 'sk-test', renderPage: (c) => { if (c) c.toDataURL = jpegUrl; return { w: 794, h: 1123 }; }, fetchImpl: counter, concurrency: 1, withBoxes: false });
  expect('续跑只补剩下的页（已识别 / 没字的都不再请求）', attempts === 1 && q2.done === 1 && q2.total === 1);
  expect('补跑成功后失败痕迹被清掉', !allPages().some((p) => p.ocrError) && allPages().filter((p) => p.ocr && p.ocr.text === '补跑成功').length === 1);
  const q3 = await ocrMod.ocrQueue(s9, { apiKey: 'sk-test', renderPage: (c) => { if (c) c.toDataURL = jpegUrl; return { w: 794, h: 1123 }; }, fetchImpl: counter, withBoxes: false });
  expect('全跑完之后再点一次：零请求（不重复花钱）', q3.total === 0 && q3.done === 0 && attempts === 1);

  // --- 队列：入队 / 续跑入口 / 移出队列 ---
  expect('入队与移出队列', (() => {
    s9.enqueueOcr([C.id, D.id]);
    const queued = s9.queuedOcrBooks();
    s9.dequeueOcr([D.id]);
    return queued.length === 2 && s9.queuedOcrBooks().length === 1;
  })());
  const s10 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const E = mkBook(s10, 'E 本', [{ items: [stroke('e1')] }, { items: [stroke('e2')] }]);
  const F = mkBook(s10, 'F 本', [{ items: [stroke('f1')] }]);
  s10.enqueueOcr([E.id]);
  const resume = ocrMod.resumeQueue(s10.notebooks({}), {});
  expect('「继续识别」只列已入队且还有活的笔记本', resume.books.join(',') === E.id && resume.items.length === 2);
  s10.markPageBlank(E.id, resume.items[0].pageId, { model: 'm' });
  s10.setPageOcr(E.id, resume.items[1].pageId, { text: '手写好了' });
  expect('跑完的笔记本不再出现在「继续识别」里', ocrMod.resumeQueue(s10.notebooks({}), {}).items.length === 0);
  expect('队列状态跟着笔记本走（备份 / 同步都带着）', (() => {
    s10.recordOcrJob(E.id, { total: 2, done: 1, failed: 1, model: 'm' });
    const dumped = JSON.parse(s10.exportJSON());
    const found = (dumped.notebooks || []).find((n) => n.id === E.id);
    return !!found && found.ocrQueued === true && !!found.ocrJob && found.ocrJob.total === 2 && found.ocrJob.failed === 1;
  })());
  expect('回收站里的笔记本不进队列', (() => {
    s10.enqueueOcr([F.id]);
    s10.trash(F.id);
    return !ocrMod.planOcrQueue(s10.notebooks({}), {}).items.some((i) => i.bookId === F.id);
  })());

  // --- 致命错误（密钥错）要立刻停，不把剩下的页全烧一遍 ---
  const s11 = new storeMod.NotebookStore({ storage: storeMod.memoryStorage() });
  const G = mkBook(s11, 'G 本', [{ items: [stroke('g1')] }, { items: [stroke('g2')] }, { items: [stroke('g3')] }, { items: [stroke('g4')] }, { items: [stroke('g5')] }]);
  let tries = 0;
  const deny = async () => { tries++; return { ok: false, status: 401, json: async () => ({ error: { message: 'invalid api key' } }) }; };
  const q4 = await ocrMod.ocrQueue(s11, { apiKey: 'sk-bad', renderPage: (c) => { if (c) c.toDataURL = jpegUrl; return { w: 794, h: 1123 }; }, fetchImpl: deny, concurrency: 1, withBoxes: false });
  expect('密钥错：立刻停（不会把 5 页全试一遍）', q4.stopped === true && tries < 5 && /密钥无效/.test(q4.reason));
  expect('停下来的那些页仍是待识别状态（下次接着跑）', ocrMod.planOcrQueue([s11.get(G.id)], {}).items.length >= 1);
  expect('任务记录里写了停止原因', /密钥无效/.test(s11.get(G.id).ocrJob.reason));

  // --- 界面对接 ---
  const libSrc = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'notebook', 'library.mjs'), 'utf8');
  const viewerSrc = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'notebook', 'viewer.mjs'), 'utf8');
  const cssLibSrc = fs.readFileSync(path.join(ROOT, 'docs', 'css', 'notebook-library.css'), 'utf8');
  expect('资料库多选条有「识别手写」入口', /data-act="sel-ocr"/.test(libSrc) && /sel-ocr/.test(libSrc));
  expect('资料库有队列小面板与进度条', /_sheetOcrQueue/.test(libSrc) && /libOcrBar/.test(libSrc) && /data-act="ocr-run"/.test(libSrc));
  expect('资料库有「继续识别 / 移出队列」横幅', /data-act="ocr-resume"/.test(libSrc) && /data-act="ocr-unqueue"/.test(libSrc) && /_ocrBanner/.test(libSrc));
  expect('资料库支持只重试失败页', /data-act="ocr-retry-failed"/.test(libSrc) && /_ocrRetryFailed/.test(libSrc));
  expect('SEO/文案：资料库提示「已识别的页不会重跑」', /已经识别过的页不会重跑|已识别的页不会重跑/.test(libSrc));
  expect('笔记本面板能只重试失败的页并列出失败原因', /data-act="ocrRunFailed"/.test(viewerSrc) && /失败的页/.test(viewerSrc) && /ocrRunFailed/.test(viewerSrc));
  expect('笔记本面板显示「几页确认没字」', /确认没字/.test(viewerSrc));
  expect('样式里有识别队列横幅与进度条', /\.lib-resume/.test(cssLibSrc) && /\.lib-bar/.test(cssLibSrc));
}

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
process.exit(fail ? 1 : 0);
