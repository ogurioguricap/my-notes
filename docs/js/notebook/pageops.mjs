/**
 * 页面级操作的撤销 / 重做（删页、复制页、移动页、加页都算）
 *
 * 为什么单独做一套：笔迹的撤销栈在 PageEditor 里（它只管「当前这一页的内容」），
 * 而删页/移页改的是**整本的页列表**——两件事的粒度不同。这里用「页列表操作」(op) 记录，
 * 与笔迹历史各自独立，界面上按时间先后决定 Ctrl+Z 先撤哪一个（见 viewer.undo）。
 *
 * 操作只有三种形状，全部可逆：
 *   insert   { kind:'insert',  entries:[{ index, page }] }   把页插回指定位置
 *   remove   { kind:'remove',  entries:[{ index, page }] }   按 id 删掉这些页（page 留着以便撤销）
 *   reorder  { kind:'reorder', before:[id...], after:[id...] }
 *
 * 纯逻辑（applyOp / invertOp）导出，方便无浏览器测试；PageHistory 只负责两个栈。
 */

export const PAGE_OP_LIMIT = 30;
// 名字带前缀：便携版是把所有模块拍平到同一作用域，顶层声明不能重名（store.mjs 里也有个 clone）
const pageOpClone = (v) => JSON.parse(JSON.stringify(v));

/** 一条操作的人话名字（toast / 状态栏用） */
export function opLabel(op) {
  if (!op) return '页面操作';
  if (op.label) return op.label;
  if (op.kind === 'insert') return `加 ${op.entries.length} 页`;
  if (op.kind === 'remove') return `删 ${op.entries.length} 页`;
  if (op.kind === 'reorder') return '调整页序';
  return '页面操作';
}

/**
 * 把一条操作应用到笔记本上（会改 nb.pages）
 * @returns {{ ok:boolean, ids:string[], reason?:string }}
 */
export function applyOp(nb, op) {
  if (!nb || !op) return { ok: false, ids: [], reason: '没有可应用的操作' };
  const pages = Array.isArray(nb.pages) ? nb.pages : (nb.pages = []);
  if (op.kind === 'insert') {
    const ids = [];
    // 按 index 从小到大插，避免前插把后插的位置顶偏
    const list = op.entries.slice().sort((a, b) => a.index - b.index);
    for (const e of list) {
      if (!e || !e.page) continue;
      const at = Math.max(0, Math.min(pages.length, Math.round(Number(e.index) || 0)));
      pages.splice(at, 0, pageOpClone(e.page));
      ids.push(e.page.id);
    }
    return { ok: ids.length > 0, ids };
  }
  if (op.kind === 'remove') {
    const want = new Set(op.entries.map((e) => e && e.page && e.page.id).filter(Boolean));
    const kept = pages.filter((p) => !want.has(p.id));
    if (!kept.length) return { ok: false, ids: [], reason: '至少得留一页' };
    const removed = pages.length - kept.length;
    nb.pages = kept;
    return { ok: removed > 0, ids: [...want] };
  }
  if (op.kind === 'reorder') {
    const byId = new Map(pages.map((p) => [p.id, p]));
    const out = [];
    for (const id of op.after || []) { if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); } }
    for (const p of pages) if (byId.has(p.id)) out.push(p);   // 兜底：没在 after 里出现的页挪到末尾，不丢
    if (out.length !== pages.length) return { ok: false, ids: [], reason: '页集合对不上' };
    nb.pages = out;
    return { ok: true, ids: (op.after || []).slice() };
  }
  return { ok: false, ids: [], reason: `不认识的操作：${op.kind}` };
}

/** 反向操作（撤销用）；再取一次反向就是重做 */
export function invertOp(op) {
  if (!op) return null;
  if (op.kind === 'insert') return { ...op, kind: 'remove' };
  if (op.kind === 'remove') return { ...op, kind: 'insert' };
  if (op.kind === 'reorder') return { ...op, kind: 'reorder', before: op.after.slice(), after: op.before.slice() };
  return null;
}

/** 从「操作前的 id 顺序」和「操作后的 id 顺序」造一条 reorder（顺序没变就返回 null） */
export function reorderOp(beforeIds, afterIds, extra = {}) {
  if (!Array.isArray(beforeIds) || !Array.isArray(afterIds)) return null;
  if (beforeIds.join(',') === afterIds.join(',')) return null;
  return { kind: 'reorder', before: beforeIds.slice(), after: afterIds.slice(), at: Date.now(), ...extra };
}

/** 双栈撤销历史（与 InkHistory 同款语义，只是记的是页列表操作） */
export class PageHistory {
  constructor({ limit = PAGE_OP_LIMIT } = {}) {
    this.limit = Math.max(1, limit);
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get depth() { return this.undoStack.length; }
  /** 最后一条操作的时间（界面用来和笔迹历史比谁更新） */
  get lastAt() { return this.undoStack.length ? (this.undoStack[this.undoStack.length - 1].at || 0) : 0; }
  get lastLabel() { return this.undoStack.length ? opLabel(this.undoStack[this.undoStack.length - 1]) : ''; }

  push(op) {
    if (!op) return null;
    const entry = { at: Date.now(), ...op };
    this.undoStack.push(entry);
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return entry;
  }

  /** 取出一条待撤销的操作（不改栈，宿主 apply 成功后再 confirm） */
  peekUndo() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null; }
  peekRedo() { return this.redoStack.length ? this.redoStack[this.redoStack.length - 1] : null; }

  /** 撤销成功：把它挪到重做栈 */
  confirmUndo() {
    const op = this.undoStack.pop();
    if (!op) return null;
    this.redoStack.push(op);
    return op;
  }

  /** 重做成功：把它挪回撤销栈 */
  confirmRedo() {
    const op = this.redoStack.pop();
    if (!op) return null;
    this.undoStack.push(op);
    return op;
  }

  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}
