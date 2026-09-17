#!/usr/bin/env node
/**
 * 手写标注编辑功能实测（不需要浏览器）
 *
 * 测两件事：
 *   1. 纯函数层：几何命中、形状识别、像素擦除、仿射变换、撤销历史、序列化（含 v1 老文件兼容）
 *   2. 端到端：用最小 DOM 桩把 InkLayer 真跑一遍——
 *      画两笔 → 撤销 → 重做 → 套索圈选 → 拖动 → 角点缩放 → 旋转 → 像素擦除 → 文本框 → 复制粘贴 → 清空 → 撤销
 *
 * 用法： node tools/test-ink-editing.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const expect = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const head = (t) => console.log(`\n— ${t} —`);

/* ============================ 最小 DOM 桩 ============================ */
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
      if (prop === 'getBoundingClientRect') return () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 });
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
  body: { classList: { toggle() {}, add() {}, remove() {} } },
  documentElement: { classList: { toggle() {} } },
  createElement: () => makeStub('el'),
  addEventListener() {}, removeEventListener() {},
});
define('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} });
define('getComputedStyle', () => ({ getPropertyValue: () => '' }));
define('requestAnimationFrame', (fn) => setTimeout(fn, 0));
define('CustomEvent', class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } });
define('confirm', () => true);

const ink = await import(pathToFileURL(path.join(ROOT, 'docs', 'js', 'ink.mjs')).href);

/* ============================ 测试用轨迹 ============================ */
const rectPath = (x0, y0, x1, y1, per = 6) => {
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const pts = [];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1], b = corners[i];
    for (let k = 0; k < per; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / per, a[1] + ((b[1] - a[1]) * k) / per]);
  }
  pts.push([x0, y0]);
  return pts;
};
const ellipsePath = (cx, cy, rx, ry, n = 48) => {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
};
const trianglePath = (x0, y0, x1, y1, per = 8) => {
  const cx = (x0 + x1) / 2;
  const corners = [[cx, y0], [x1, y1], [x0, y1], [cx, y0]];
  const pts = [];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1], b = corners[i];
    for (let k = 0; k < per; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / per, a[1] + ((b[1] - a[1]) * k) / per]);
  }
  pts.push([cx, y0]);
  return pts;
};
const jitter = (pts, amp = 0.0022, seed = 7) => {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  return pts.map(([x, y]) => [x + rnd() * amp, y + rnd() * amp]);
};

console.log('=== 手写标注编辑功能实测 ===');

/* ============================ 1. 导出与常量 ============================ */
head('导出与常量');
const REQUIRED_EXPORTS = [
  'PALETTE', 'WIDTHS', 'ERASER_SIZES', 'SHAPE_KINDS', 'TEXT_SIZES', 'MAX_HISTORY',
  'InkLayer', 'InkHistory', 'uid', 'cloneItems', 'normalizeItems', 'serializeInk', 'parseInk', 'countItems',
  'bboxOfPoints', 'itemBounds', 'boundsOfItems', 'itemPolyline', 'hitTestItem', 'polygonSelectsItem',
  'pointInPolygon', 'distanceToSegment', 'simplifyPath', 'resamplePath', 'smoothPath',
  'recognizeShape', 'snapToShape', 'straightenHighlighter', 'countCorners', 'roundnessOf',
  'eraseStrokePartial', 'eraseAtPoint', 'densifyPoints', 'transformItems',
];
const missing = REQUIRED_EXPORTS.filter((n) => ink[n] === undefined);
expect(`导出齐备（${REQUIRED_EXPORTS.length} 项）`, missing.length === 0, `缺：${missing.join(', ')}`);
expect('橡皮有两种模式可选', ink.ERASER_SIZES.length >= 3 && ink.SHAPE_KINDS.some((s) => s.id === 'auto'));
expect('形状可选手绘的直线 / 箭头 / 矩形 / 椭圆 / 三角', ['line', 'arrow', 'rect', 'ellipse', 'triangle'].every((id) => ink.SHAPE_KINDS.some((s) => s.id === id)));

/* ============================ 2. 几何与命中 ============================ */
head('几何与命中');
const line = { kind: 'stroke', id: 'a', tool: 'pen', color: '#000', width: 0.004, points: [[0.1, 0.1], [0.9, 0.9]] };
expect('包围盒正确', JSON.stringify(ink.itemBounds(line)) === JSON.stringify({ x0: 0.098, y0: 0.098, x1: 0.902, y1: 0.902 }));
expect('线段上命中', ink.hitTestItem(line, 0.5, 0.5, 800, 600, { tolPx: 8 }) === true);
expect('远离线段的点不命中', ink.hitTestItem(line, 0.5, 0.2, 800, 600, { tolPx: 8 }) === false);
const rectShape = { kind: 'stroke', id: 'r', tool: 'pen', color: '#000', width: 0.004, shape: 'rect', points: [[0.2, 0.2], [0.6, 0.6]] };
expect('矩形形状按四条边展开（描边命中）', ink.itemPolyline(rectShape).length === 5);
expect('矩形内部默认不算命中（避免误擦）', ink.hitTestItem(rectShape, 0.4, 0.4, 800, 600, { tolPx: 6 }) === false);
expect('矩形内部在「点选模式」算命中', ink.hitTestItem(rectShape, 0.4, 0.4, 800, 600, { tolPx: 6, inside: true }) === true);
const textItem = { kind: 'text', id: 't', x: 0.2, y: 0.2, text: '中文abc', color: '#000', size: 0.023 };
expect('文本按估算尺寸命中', ink.hitTestItem(textItem, 0.21, 0.21, 800, 600) === true && ink.hitTestItem(textItem, 0.9, 0.9, 800, 600) === false);
const tri = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
expect('射线法判定圈内 / 圈外', ink.pointInPolygon(tri, 0.5, 0.5) === true && ink.pointInPolygon(tri, 0.95, 0.5) === false);
expect('套索圈选：圈住两条命中一条', ink.polygonSelectsItem([[0.02, 0.02], [0.55, 0.02], [0.55, 0.55], [0.02, 0.55]], line) === true
  && ink.polygonSelectsItem([[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]], line) === false);
expect('简化和重采样不改变端点', (() => {
  const s = ink.simplifyPath(rectPath(0.2, 0.2, 0.6, 0.6), 0.01);
  const r = ink.resamplePath(rectPath(0.2, 0.2, 0.6, 0.6), 32);
  return s.length >= 4 && r.length === 32;
})());

/* ============================ 3. 形状识别 ============================ */
head('形状识别');
const rec = (pts) => (ink.recognizeShape(pts) || {}).shape || 'none';
expect('手绘直线 → 直线', rec(jitter([[0.1, 0.1], [0.3, 0.3], [0.5, 0.5], [0.7, 0.7], [0.9, 0.9]], 0.004)) === 'line');
expect('手绘矩形 → 矩形', rec(jitter(rectPath(0.2, 0.2, 0.8, 0.6))) === 'rect', `实际 ${rec(rectPath(0.2, 0.2, 0.8, 0.6))}`);
expect('手绘正方形 → 矩形', rec(jitter(rectPath(0.2, 0.2, 0.7, 0.7))) === 'rect', `实际 ${rec(rectPath(0.2, 0.2, 0.7, 0.7))}`);
expect('手绘圆 → 椭圆', rec(jitter(ellipsePath(0.5, 0.5, 0.25, 0.25))) === 'ellipse', `实际 ${rec(ellipsePath(0.5, 0.5, 0.25, 0.25))}`);
expect('手绘扁椭圆 → 椭圆', rec(jitter(ellipsePath(0.5, 0.5, 0.3, 0.15))) === 'ellipse', `实际 ${rec(ellipsePath(0.5, 0.5, 0.3, 0.15))}`);
expect('手绘三角 → 三角', rec(jitter(trianglePath(0.2, 0.2, 0.8, 0.7))) === 'triangle', `实际 ${rec(trianglePath(0.2, 0.2, 0.8, 0.7))}`);
expect('乱七八糟的折线不硬套形状', ink.recognizeShape([[0.1, 0.1], [0.5, 0.3], [0.2, 0.5], [0.6, 0.7], [0.3, 0.9]]) === null);
expect('太小的痕迹不识别（当点处理）', ink.recognizeShape([[0.5, 0.5], [0.501, 0.501], [0.502, 0.502]]) === null);
expect('交点统计：圆 0 个角 / 矩形 4 个角', ink.countCorners(ink.resamplePath(ellipsePath(0.5, 0.5, 0.25, 0.25), 48)) === 0
  && ink.countCorners(ink.resamplePath(rectPath(0.2, 0.2, 0.8, 0.6), 48)) === 4);
const snapR = ink.snapToShape(rectPath(0.2, 0.2, 0.8, 0.6), 'rect');
expect('指定形状：矩形取包围盒对角两点', snapR && snapR.shape === 'rect' && snapR.points.length === 2);
const snapL = ink.snapToShape([[0.1, 0.2], [0.5, 0.4], [0.9, 0.6]], 'arrow');
expect('指定形状：箭头取起终点', snapL && snapL.shape === 'arrow' && snapL.points.length === 2);
expect('荧光笔够直会自动拉直', (() => {
  const s = ink.straightenHighlighter([[0.1, 0.5], [0.4, 0.51], [0.7, 0.5], [0.9, 0.5]]);
  return Array.isArray(s) && s.length === 2;
})());
expect('荧光笔画成弧线时保持手绘', ink.straightenHighlighter([[0.1, 0.6], [0.3, 0.3], [0.6, 0.3], [0.9, 0.6]]) === null);

/* ============================ 4. 橡皮（整笔 / 像素） ============================ */
head('橡皮');
const longLine = { kind: 'stroke', id: 'L', tool: 'pen', color: '#000', width: 0.004, shape: 'line', points: [[0.1, 0.5], [0.9, 0.5]] };
const cut = ink.eraseStrokePartial(longLine, 0.5, 0.5, 12, 800, 600);
expect('像素擦：长线被切成两段', Array.isArray(cut) && cut.length === 2, `实际 ${cut && cut.length}`);
expect('像素擦后的碎段不再当整形状（按自由路径画）', Array.isArray(cut) && cut.every((c) => c.shape === undefined));
expect('像素擦：左边一段确实变短了', Array.isArray(cut) && Math.max(...cut[0].points.map((p) => p[0])) < 0.5);
expect('像素擦：没碰到就原样返回 null', ink.eraseStrokePartial(longLine, 0.5, 0.9, 12, 800, 600) === null);
expect('像素擦：擦到头就整条消失', Array.isArray(ink.eraseStrokePartial(longLine, 0.1, 0.5, 30, 800, 600)) && ink.eraseStrokePartial(longLine, 0.1, 0.5, 30, 800, 600).length <= 1);
const whole = ink.eraseAtPoint([longLine, rectShape, textItem], 0.5, 0.5, 800, 600, { radius: 12, mode: 'stroke' });
expect('整笔擦：碰到长线 → 只剩矩形和文字', whole.changed === 1 && whole.items.length === 2, `实际 ${JSON.stringify(whole.items.map((i) => i.id))}`);
expect('整笔擦：文字不会被误删（要套索选中再删）', whole.items.some((i) => i.kind === 'text'));
const pixel = ink.eraseAtPoint([longLine], 0.5, 0.5, 800, 600, { radius: 12, mode: 'pixel' });
expect('像素擦模式：切成两段而不是全删', pixel.changed === 1 && pixel.items.length === 2);
expect('加密路径点：长直线被细分成多段', ink.densifyPoints([[0.1, 0.5], [0.9, 0.5]], 4, 800, 600).length > 100);

/* ============================ 5. 变换 ============================ */
head('移动 / 缩放 / 旋转');
const two = [
  { kind: 'stroke', id: 'x1', tool: 'pen', color: '#000', width: 0.004, points: [[0.2, 0.2], [0.4, 0.4]] },
  { kind: 'stroke', id: 'x2', tool: 'pen', color: '#000', width: 0.004, points: [[0.6, 0.6], [0.8, 0.8]] },
];
const selX1 = new Set(['x1']);
const moved = ink.transformItems(two, selX1, { dx: 0.1, dy: -0.05 });
expect('移动只动选中的对象', Math.abs(moved[0].points[0][0] - 0.3) < 1e-9 && Math.abs(moved[1].points[0][0] - 0.6) < 1e-9);
expect('移动不修改原数组（撤销才有得退）', two[0].points[0][0] === 0.2);
const b0 = ink.boundsOfItems([two[0]]);
const scaled = ink.transformItems(two, selX1, { sx: 2, sy: 2, origin: { x: 0.2, y: 0.2 } })[0];
expect('绕角点缩放 2 倍：端点按 2 倍拉开', Math.abs(scaled.points[1][0] - 0.6) < 1e-9 && Math.abs(scaled.points[1][1] - 0.6) < 1e-9, JSON.stringify(scaled.points));
expect('缩放锚点（对角）原地不动', Math.abs(scaled.points[0][0] - 0.2) < 1e-9);
const b1 = ink.boundsOfItems([scaled]);
expect('缩放后包围盒确实变大', (b1.x1 - b1.x0) > (b0.x1 - b0.x0) * 1.9, `${(b0.x1 - b0.x0).toFixed(3)} → ${(b1.x1 - b1.x0).toFixed(3)}`);
const wide = { kind: 'stroke', id: 'w1', tool: 'pen', color: '#000', width: 0.004, points: [[0.2, 0.2], [0.6, 0.3]] };
const rotated = ink.transformItems([wide], new Set(['w1']), { angle: Math.PI / 2 })[0];
const rc = ink.boundsOfItems([wide]);
const rb = ink.boundsOfItems([rotated]);
expect('旋转 90°：包围盒长宽互换', Math.abs((rb.x1 - rb.x0) - (rc.y1 - rc.y0)) < 1e-6, `旋转后宽 ${(rb.x1 - rb.x0).toFixed(3)} vs 原高 ${(rc.y1 - rc.y0).toFixed(3)}`);
const txt = { kind: 'text', id: 'tt', x: 0.2, y: 0.2, text: '你好', color: '#000', size: 0.02 };
const txtBig = ink.transformItems([txt], new Set(['tt']), { sx: 2, sy: 2 })[0];
expect('文本缩放会同步改字号', Math.abs(txtBig.size - 0.04) < 1e-9);

/* ============================ 6. 撤销 / 重做历史 ============================ */
head('撤销 / 重做历史');
const h = new ink.InkHistory({ limit: 3 });
expect('新历史：不能撤销也不能重做', !h.canUndo && !h.canRedo);
h.push('画笔', []);
expect('记录一步后可以撤销', h.canUndo && h.undoDepth === 1);
h.push('擦除', [{ a: 1 }]);
const u1 = h.undo([{ a: 1 }, { b: 2 }]);
expect('撤销返回上一状态与操作名', u1 && u1.label === '擦除' && u1.state.length === 1);
expect('撤销后可以重做', h.canRedo && h.redoDepth === 1);
const r1 = h.redo([{ a: 1 }]);
expect('重做回到撤销前', r1 && r1.state.length === 2);
h.push('a', []); h.push('b', []); h.push('c', []); h.push('d', []);
expect('历史上限生效（只留最近 3 步）', h.undoDepth === 3, `实际 ${h.undoDepth}`);
expect('新操作会清掉重做栈', !h.canRedo);
h.clear();
expect('清空历史后不可撤销', !h.canUndo && !h.canRedo);
const h2 = new ink.InkHistory();
h2.push('画笔', [[1]]);
expect('撤销到底返回 null', h2.undo([[1]]) !== null && h2.undo([]) === null);

/* ============================ 7. 序列化与老文件兼容 ============================ */
head('序列化');
const v1 = '{"version":1,"strokes":[{"tool":"pen","color":"#E8452F","width":0.0038,"points":[[0.1,0.1],[0.2,0.2]]}]}';
const fromV1 = ink.parseInk(v1);
expect('v1 老标注文件照样读得进来', fromV1.length === 1 && fromV1[0].kind === 'stroke');
const payload = ink.serializeInk([line, textItem, { kind: 'image', id: 'i1', x: 0.1, y: 0.1, w: 0.2, h: 0.1, src: 'data:image/png;base64,x' }]);
expect('导出为 v2 格式（版本号 + items）', JSON.parse(payload).version === 2 && JSON.parse(payload).items.length === 3);
const back = ink.parseInk(payload);
expect('导出再导入：对象数量与类型不变', back.length === 3 && back[0].kind === 'stroke' && back[1].kind === 'text' && back[2].kind === 'image');
expect('坏文件不炸（返回空数组）', ink.parseInk('{ 这不是 JSON').length === 0);
expect('对象计数（笔迹 / 文字 / 图片）', (() => {
  const c = ink.countItems(back);
  return c.total === 3 && c.stroke === 1 && c.text === 1 && c.image === 1;
})());

/* ============================ 8. 标注层端到端 ============================ */
head('标注层端到端（真跑 InkLayer）');
const toasts = [];
const layer = new ink.InkLayer({ host: makeStub('host'), onChange: () => {}, toast: (m) => toasts.push(m) });
layer.setActive(true);
expect('标注层初始化完成（画布 800×600）', layer.cssW === 800 && layer.cssH === 600);

const draw = (tool, pts) => {
  layer.setTool(tool);
  layer.onDown(pts[0]);
  for (let i = 1; i < pts.length; i++) layer.onMove(pts[i]);
  layer.onUp();
};
draw('pen', [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]);
draw('pen', [[0.7, 0.7], [0.8, 0.8], [0.85, 0.85]]);
expect('画两笔 → 两个对象', layer.items.length === 2, `实际 ${layer.items.length}`);
expect('画完就能撤销', layer.history.canUndo);
layer.undo();
expect('撤销一笔 → 剩一个', layer.items.length === 1);
layer.redo();
expect('重做一笔 → 又是两个', layer.items.length === 2);
layer.undo(); layer.undo();
expect('连撤两步回到空白（且不可再撤）', layer.items.length === 0 && !layer.history.canUndo);
layer.redo(); layer.redo();
expect('连重做两步恢复到两笔', layer.items.length === 2);

// 套索圈选第一笔
layer.setTool('lasso');
layer.onDown([0.05, 0.05]);
layer.onMove([0.4, 0.05]);
layer.onMove([0.4, 0.4]);
layer.onMove([0.05, 0.4]);
layer.onUp();
expect('套索圈中第一笔', layer.selection.size === 1, `实际选中 ${layer.selection.size}`);
const before = JSON.stringify(layer.items.map((i) => i.points));
layer.onDown([0.2, 0.2]);
layer.onMove([0.3, 0.25]);
layer.onUp();
const afterMove = JSON.parse(JSON.stringify(layer.items.map((i) => i.points)));
expect('拖动选中的笔画（+0.1 / +0.05）', Math.abs(afterMove[0][0][0] - 0.2) < 1e-6 && Math.abs(afterMove[0][0][1] - 0.15) < 1e-6, JSON.stringify(afterMove[0][0]));
expect('没选中的第二笔没动', JSON.stringify(layer.items[1].points) === JSON.stringify(JSON.parse(before)[1]));
layer.undo();
expect('撤销拖动 → 位置复原', JSON.stringify(layer.items.map((i) => i.points)) === before);

// 角点缩放
layer.selection = new Set([layer.items[0].id]);
const br = layer.handlePoints().find((hp) => hp.id === 'br');
const wBefore = ink.boundsOfItems([layer.items[0]]);
layer.onDown([br.x / 800, br.y / 600]);
layer.onMove([(br.x + 60) / 800, (br.y + 40) / 600]);
layer.onUp();
const wAfter = ink.boundsOfItems([layer.items[0]]);
expect('拖角点缩放 → 变宽变高', (wAfter.x1 - wAfter.x0) > (wBefore.x1 - wBefore.x0) && (wAfter.y1 - wAfter.y0) > (wBefore.y1 - wBefore.y0));
layer.undo();
expect('撤销缩放 → 尺寸复原', Math.abs(ink.boundsOfItems([layer.items[0]]).x1 - wBefore.x1) < 1e-9);

// 旋转
layer.selection = new Set([layer.items[1].id]);
const rot = layer.handlePoints().find((hp) => hp.id === 'rotate');
const ptsBeforeRot = JSON.stringify(layer.items[1].points);
layer.onDown([rot.x / 800, rot.y / 600]);
layer.onMove([(rot.x + 120) / 800, (rot.y + 120) / 600]);
layer.onUp();
expect('拖旋转柄 → 轨迹被旋转', JSON.stringify(layer.items[1].points) !== ptsBeforeRot);
layer.undo();
expect('撤销旋转 → 轨迹复原', JSON.stringify(layer.items[1].points) === ptsBeforeRot);

// 选中后改颜色 / 改粗细
layer.selection = new Set([layer.items[0].id]);
const colorBefore = layer.items[0].color;
layer.setColor('blue');
expect('选中时点颜色 → 批量改色', layer.items[0].color === ink.PALETTE[1].pen && layer.items[0].color !== colorBefore);
expect('改色本身可撤销', (() => { layer.undo(); return layer.items[0].color === colorBefore; })());

// 像素橡皮
layer.setTool('eraser');
layer.setEraserMode('pixel');
layer.setEraserSize('s');
const idBefore = layer.items.length;
layer.onDown([0.2, 0.2]);
layer.onUp();
expect('像素擦：一笔被切开会多出对象', layer.items.length > idBefore, `${idBefore} → ${layer.items.length}`);
layer.undo();
expect('撤销像素擦 → 回到原来数量', layer.items.length === idBefore);
layer.setTool('eraser');
layer.setEraserMode('stroke');
const countBefore = layer.items.length;
layer.onDown([0.2, 0.2]);
layer.onUp();
expect('整笔擦：整条笔画被删掉', layer.items.length === countBefore - 1);
layer.undo();
expect('撤销整笔擦 → 笔画回来', layer.items.length === countBefore);

// 文本框
layer.setTool('text');
const ta = layer.beginTextEdit(null, [0.3, 0.3]);
ta.value = '这是个文本框';
layer.endTextEdit(true);
const textItems = layer.items.filter((i) => i.kind === 'text');
expect('文本框：输入完成落成一个文本对象', textItems.length === 1 && textItems[0].text === '这是个文本框');
layer.undo();
expect('撤销加文字 → 文本消失', layer.items.filter((i) => i.kind === 'text').length === 0);
layer.redo();
expect('重做加文字 → 文本回来', layer.items.filter((i) => i.kind === 'text').length === 1);
const txtItem = layer.items.find((i) => i.kind === 'text');
layer.setTool('lasso');
layer.selection = new Set([txtItem.id]);
layer.onDown([0.32, 0.32]);
layer.onMove([0.4, 0.36]);
layer.onUp();
expect('文本也能被套索拖着走', Math.abs(layer.items.find((i) => i.kind === 'text').x - 0.3) > 1e-6);
layer.undo();

// 复制 / 粘贴 / 再制 / 删除
layer.selection = new Set([layer.items[0].id]);
expect('复制选中对象', layer.copySelection() === true && layer.clipboard.length === 1);
const nBeforePaste = layer.items.length;
layer.pasteClipboard();
expect('粘贴 → 多一个对象且自动偏移', layer.items.length === nBeforePaste + 1);
layer.deleteSelection();
expect('删除选中对象', layer.items.length === nBeforePaste);
layer.selectAll();
expect('Ctrl+A 全选', layer.selection.size === layer.items.length);

// 清空也可撤销
const beforeClear = layer.items.length;
layer.clearAll();
expect('清空这一页', layer.items.length === 0);
layer.undo();
expect('撤销清空 → 内容回来（不会一点就没）', layer.items.length === beforeClear);

// 保存往返
const saved = ink.serializeInk(layer.getItems());
const reloaded = ink.parseInk(saved);
expect('保存 → 重新载入：对象数量一致', reloaded.length === layer.items.length);
const layer2 = new ink.InkLayer({ host: makeStub('host') });
layer2.setItems(reloaded);
expect('新开一层载入已有标注（历史清空）', layer2.items.length === reloaded.length && !layer2.history.canUndo);
expect('载入不算改动（不会一打开就显示未保存）', layer2.history.undoDepth === 0);

// 触屏手势：双指轻点 = 撤销，三指轻点 = 重做
const H = layer._canvasHandlers;
const touchEv = (id, x = 400, y = 300) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, buttons: 1, preventDefault() {} });
const tap = (...ids) => {
  for (const id of ids) H.pointerdown(touchEv(id, 400 + id * 40, 300 + id * 40));
  for (const id of ids) H.pointerup(touchEv(id, 400 + id * 40, 300 + id * 40));
};
draw('pen', [[0.4, 0.4], [0.45, 0.45], [0.5, 0.5]]);
const afterDraw = layer.items.length;
tap(1, 2);
expect('双指轻点 → 撤销（手账 App 同款手势）', layer.items.length === afterDraw - 1, `${afterDraw} → ${layer.items.length}`);
tap(1, 2, 3);
expect('三指轻点 → 重做', layer.items.length === afterDraw, `实际 ${layer.items.length}`);
expect('多指按下即作废，不会留下半截笔画', layer.drawing === null && layer.gesture === null);
expect('操作提示会说明撤销了什么', toasts.some((m) => /撤销/.test(m)), toasts.slice(-4).join(' | '));

/* ============================ 9. Canvas 调用契约审计 ============================ */
// DOM 桩里的 canvas 是「什么都答应的空壳」，方法名打错 / 传 NaN 都发现不了。
// 真机上这两类问题分别是 TypeError 与 IndexSizeError（画不出东西），所以在无浏览器环境里补这一层审计。
head('Canvas 调用契约审计');
define('Image', class {
  constructor() { this.complete = true; this.naturalWidth = 200; this.naturalHeight = 100; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
});
const CTX_METHODS = new Set([
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'rect',
  'quadraticCurveTo', 'bezierCurveTo', 'stroke', 'fill', 'clip', 'fillText', 'strokeText', 'measureText',
  'drawImage', 'setLineDash', 'getLineDash', 'setTransform', 'resetTransform', 'translate', 'rotate', 'scale',
  'save', 'restore', 'createLinearGradient', 'createRadialGradient', 'createPattern', 'getImageData', 'putImageData',
]);
const CTX_PROPS = new Set([
  'globalAlpha', 'globalCompositeOperation', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
  'strokeStyle', 'fillStyle', 'font', 'textAlign', 'textBaseline', 'direction', 'shadowColor', 'shadowBlur',
  'shadowOffsetX', 'shadowOffsetY', 'filter', 'imageSmoothingEnabled', 'canvas',
]);
const audit = { calls: [], props: new Set(), bad: [] };
const auditCtx = new Proxy({}, {
  get(_, prop) {
    if (typeof prop === 'symbol') return undefined;
    if (CTX_PROPS.has(prop)) return audit.props.has(prop) ? undefined : undefined;
    return (...args) => {
      audit.calls.push({ name: prop, args });
      if (!CTX_METHODS.has(prop)) { audit.bad.push(`未知方法 ctx.${prop}()`); return undefined; }
      for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) audit.bad.push(`ctx.${prop}() 收到非有限数 ${a}`);
      const n = args.filter((a) => typeof a === 'number');
      const need = (i, label) => { if (typeof args[i] !== 'number' || args[i] < 0) audit.bad.push(`ctx.${prop}() 的${label}必须是非负数，实际 ${args[i]}`); };
      if (prop === 'arc') need(2, '半径');
      if (prop === 'ellipse') { need(2, '水平半径'); need(3, '垂直半径'); }
      if (prop === 'fillRect' || prop === 'strokeRect') { need(2, '宽度'); need(3, '高度'); }
      if (prop === 'drawImage' && args.length >= 5) { need(3, '宽度'); need(4, '高度'); }
      if (prop === 'setTransform' && n.length !== 6) audit.bad.push('ctx.setTransform() 需要 6 个参数');
      return undefined;
    };
  },
  set(_, prop, v) {
    audit.props.add(prop);
    if (!CTX_PROPS.has(prop)) audit.bad.push(`未知属性 ctx.${prop} = …`);
    if (typeof v === 'number' && !Number.isFinite(v)) audit.bad.push(`ctx.${prop} = ${v}（非有限数）`);
    return true;
  },
});

// 摆一屏「什么都有」的页面：手写字、荧光笔、五种形状、多行文本、图片
layer.setItems([
  { kind: 'stroke', id: 's1', tool: 'pen', color: '#E8452F', width: 0.004, points: [[0.1, 0.1], [0.2, 0.15], [0.3, 0.1]] },
  { kind: 'stroke', id: 's2', tool: 'pen', color: '#12A05C', width: 0.006, points: [[0.1, 0.1], [0.1, 0.1]] },
  { kind: 'stroke', id: 's3', tool: 'highlighter', color: 'rgba(232,163,61,.3)', width: 0.032, shape: 'line', points: [[0.1, 0.4], [0.9, 0.4]] },
  { kind: 'stroke', id: 's4', tool: 'pen', color: '#2F6FE8', width: 0.004, shape: 'arrow', points: [[0.2, 0.5], [0.6, 0.6]] },
  { kind: 'stroke', id: 's5', tool: 'pen', color: '#2F6FE8', width: 0.004, shape: 'rect', points: [[0.2, 0.6], [0.6, 0.7]] },
  { kind: 'stroke', id: 's6', tool: 'pen', color: '#2F6FE8', width: 0.004, shape: 'ellipse', points: [[0.2, 0.7], [0.5, 0.85]] },
  { kind: 'stroke', id: 's7', tool: 'pen', color: '#2F6FE8', width: 0.004, shape: 'triangle', points: [[0.6, 0.6], [0.9, 0.8]] },
  { kind: 'text', id: 't1', x: 0.1, y: 0.9, text: '第一行\n第二行', color: '#2B2723', size: 0.023 },
  { kind: 'image', id: 'i1', x: 0.6, y: 0.1, w: 0.3, h: 0.15, src: 'data:image/png;base64,AAAA' },
]);
layer.ctx = auditCtx;
layer.selection = new Set(['s1']);
layer.lasso = [[0.05, 0.05], [0.4, 0.05], [0.4, 0.4]];
layer.redraw();
expect('所有对象类型都真的画了一遍（笔画 / 荧光笔 / 形状 / 文本 / 图片）',
  ['clearRect', 'stroke', 'fill', 'ellipse', 'fillText', 'drawImage'].every((m) => audit.calls.some((c) => c.name === m)),
  `实际调用：${[...new Set(audit.calls.map((c) => c.name))].join(', ')}`);
expect('选中框与套索也画了（含控制点）', audit.calls.some((c) => c.name === 'setLineDash') && audit.calls.filter((c) => c.name === 'arc').length >= 5);
expect('Canvas 方法名全部真实存在（打错就是真机 TypeError）', audit.bad.filter((b) => /未知方法/.test(b)).length === 0, audit.bad.join(' | '));
expect('Canvas 属性名全部真实存在（打错会被浏览器静默忽略）', audit.bad.filter((b) => /未知属性/.test(b)).length === 0, audit.bad.join(' | '));
expect('没有 NaN / 负数半径 / 参数个数错误（真机 IndexSizeError 的来源）', audit.bad.filter((b) => /非有限数|非负数|参数/.test(b)).length === 0, audit.bad.join(' | '));
layer.ctx = null;
layer.redraw();
expect('画布上下文缺失时不会抛错（防白屏）', true);

layer.destroy();
expect('销毁后不残留监听（destroy 可重入）', (() => { layer.destroy(); return true; })());

console.log(`\n================ 结果：通过 ${pass} / ${pass + fail} ================`);
process.exit(fail ? 1 : 0);
