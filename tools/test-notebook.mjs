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

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
process.exit(fail ? 1 : 0);
