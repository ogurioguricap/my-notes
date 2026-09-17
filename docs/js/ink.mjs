/**
 * 手写标注层（画笔 / 荧光笔 / 橡皮）
 * 交互参照手账类 App：直接在正文上画，笔画跟着内容走，换设备换屏幕都对齐。
 *
 * 设计要点：
 * 1. 笔画坐标存成「相对正文宽度/高度的 0~1 比例」，因此手机、平板、电脑上都会正确缩放
 * 2. 覆盖层是绝对定位的 canvas + 一个用于画荧光笔的底色层；绘制时正文文字仍可选中
 * 3. 数据落盘：content/ink/<slug>.json，形如
 *    { "version": 1, "strokes": [ { "tool": "pen", "color": "#e8452f", "width": 0.004, "points": [[x,y],...] } ] }
 */

export const PALETTE = [
  { id: 'red', pen: '#E8452F', ink: 'rgba(232,69,47,.28)', label: '红' },
  { id: 'blue', pen: '#2F6FE8', ink: 'rgba(47,111,232,.26)', label: '蓝' },
  { id: 'green', pen: '#12A05C', ink: 'rgba(18,160,92,.26)', label: '绿' },
  { id: 'amber', pen: '#E8A33D', ink: 'rgba(232,163,61,.30)', label: '黄' },
  { id: 'purple', pen: '#8B5CF6', ink: 'rgba(139,92,246,.26)', label: '紫' },
  { id: 'ink', pen: '#2B2723', ink: 'rgba(43,39,35,.24)', label: '墨' },
];

export const WIDTHS = [
  { id: 'thin', label: '细', pen: 0.0022, highlighter: 0.020 },
  { id: 'medium', label: '中', pen: 0.0038, highlighter: 0.032 },
  { id: 'thick', label: '粗', pen: 0.0062, highlighter: 0.048 },
];

export class InkLayer {
  /**
   * @param {object} opts
   *   opts.host     承载文章的元素（画布会铺满它的内容高度）
   *   opts.onChange (strokes) => void  笔画变化时回调（用于标脏）
   */
  constructor({ host, onChange, onToolChange, canSave, onRequestSave, onClose }) {
    this.host = host;
    this.onChange = onChange;
    this.onToolChange = onToolChange;
    this.canSave = canSave;            // () => boolean
    this.onRequestSave = onRequestSave; // () => void
    this.onClose = onClose;            // () => void
    this.strokes = [];
    this.tool = 'pen';        // pen | highlighter | eraser
    this.color = PALETTE[0];
    this.width = WIDTHS[1];
    this.active = false;
    this.drawing = null;
    this.build();
  }

  /* ---------- DOM ---------- */
  build() {
    const wrap = document.createElement('div');
    wrap.className = 'ink-layer';
    wrap.innerHTML = `
      <canvas class="ink-canvas" aria-label="手写标注层"></canvas>
      <div class="ink-bar" role="toolbar" aria-label="标注工具">
        <div class="ink-tools">
          <button type="button" class="ink-btn on" data-tool="pen" title="画笔（自由手写）">✏️</button>
          <button type="button" class="ink-btn" data-tool="highlighter" title="荧光笔（半透明勾画）">🖍</button>
          <button type="button" class="ink-btn" data-tool="eraser" title="橡皮（擦掉笔画）">🧽</button>
        </div>
        <div class="ink-sep"></div>
        <div class="ink-colors">
          ${PALETTE.map((c, i) => `<button type="button" class="ink-color${i === 0 ? ' on' : ''}" data-color="${c.id}" title="${c.label}" style="--c:${c.pen}"></button>`).join('')}
        </div>
        <div class="ink-sep"></div>
        <div class="ink-widths">
          ${WIDTHS.map((w, i) => `<button type="button" class="ink-w${i === 1 ? ' on' : ''}" data-width="${w.id}" title="${w.label}">${w.label}</button>`).join('')}
        </div>
        <div class="ink-sep"></div>
        <button type="button" class="ink-btn" data-act="undo" title="撤销上一笔">↶</button>
        <button type="button" class="ink-btn" data-act="clear" title="清空全部笔画">🗑</button>
        <button type="button" class="ink-btn ink-save" data-act="save" title="保存标注（写回仓库）">保存标注</button>
        <button type="button" class="ink-btn" data-act="close" title="退出标注（退出前请先保存）">完成</button>
      </div>`;
    this.wrap = wrap;
    this.canvas = wrap.querySelector('.ink-canvas');
    this.bar = wrap.querySelector('.ink-bar');
    this.ctx = this.canvas.getContext('2d');
    this.wrap.style.display = 'none';
    this.host.appendChild(this.wrap);

    this.bindCanvas();
    this.bindBar();
    this.wrap.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /* ---------- 事件 ---------- */
  bindBar() {
    this.bar.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.tool) {
        this.tool = t.dataset.tool;
        this.bar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b === t));
        this.updateCursor();
        this.onToolChange && this.onToolChange(this.tool);
      } else if (t.dataset.color) {
        this.color = PALETTE.find((c) => c.id === t.dataset.color) || PALETTE[0];
        this.bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b === t));
        this.updateCursor();
      } else if (t.dataset.width) {
        this.width = WIDTHS.find((w) => w.id === t.dataset.width) || WIDTHS[1];
        this.bar.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('on', b === t));
        this.updateCursor();
      } else if (t.dataset.act === 'undo') {
        this.strokes.pop();
        this.redraw();
        this.onChange && this.onChange(this.strokes);
      } else if (t.dataset.act === 'clear') {
        if (this.strokes.length && !confirm(`清空这一页的 ${this.strokes.length} 条笔画？`)) return;
        this.strokes = [];
        this.redraw();
        this.onChange && this.onChange(this.strokes);
      } else if (t.dataset.act === 'save') {
        if (this.canSave && !this.canSave()) {
          this.host.dispatchEvent(new CustomEvent('ink-need-token', { bubbles: true }));
          return;
        }
        this.onRequestSave && this.onRequestSave();
      } else if (t.dataset.act === 'close') {
        this.setActive(false);
        this.onClose && this.onClose();
      }
    });
  }

  bindCanvas() {
    const c = this.canvas;
    let pid = null;

    c.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      pid = e.pointerId;
      const p = this.toNorm(e);
      if (this.tool === 'eraser') {
        this.eraseAt(p);
        return;
      }
      this.drawing = {
        tool: this.tool,
        color: this.tool === 'highlighter' ? this.color.ink : this.color.pen,
        width: this.tool === 'highlighter' ? this.width.highlighter : this.width.pen,
        points: [p],
      };
      this.redraw();
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      if (this.tool === 'eraser' && pid === e.pointerId && e.buttons) {
        this.eraseAt(this.toNorm(e));
        return;
      }
      if (!this.drawing || pid !== e.pointerId) return;
      const p = this.toNorm(e);
      const last = this.drawing.points[this.drawing.points.length - 1];
      // 采样：太密的点丢掉，减小存储体积
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.0016) return;
      this.drawing.points.push(p);
      this.redraw();
    });

    const finish = (e) => {
      if (pid !== null && e.pointerId !== pid) return;
      pid = null;
      if (this.drawing) {
        if (this.drawing.points.length === 1) {
          // 点一下 → 画个小点
          const [x, y] = this.drawing.points[0];
          this.drawing.points.push([x + 0.0008, y + 0.0008]);
        }
        this.strokes.push(this.drawing);
        this.drawing = null;
        this.redraw();
        this.onChange && this.onChange(this.strokes);
      }
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
    c.addEventListener('pointerleave', (e) => { if (this.drawing && e.buttons === 0) finish(e); });
  }

  /* ---------- 坐标换算 ---------- */
  toNorm(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))),
      Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height))),
    ];
  }

  /* ---------- 绘制 ---------- */
  resize() {
    const rect = this.host.getBoundingClientRect();
    const h = Math.max(this.host.scrollHeight, this.host.offsetHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = Math.max(1, Math.round(rect.width));
    this.cssH = Math.max(1, Math.round(h));
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  redraw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.cssW || 1, this.cssH || 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const all = this.drawing ? [...this.strokes, this.drawing] : this.strokes;
    for (const s of all) this.drawStroke(ctx, s);
  }

  drawStroke(ctx, s) {
    const W = this.cssW || 1;
    const H = this.cssH || 1;
    const w = Math.max(1, s.width * W);
    ctx.globalCompositeOperation = s.tool === 'highlighter' ? 'multiply' : 'source-over';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = w;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => {
      const px = x * W;
      const py = y * H;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (s.points.length === 1) {
      const [x, y] = s.points[0];
      ctx.arc(x * W, y * H, w / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    } else {
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** 橡皮：命中笔画即删除（点到哪条线，删哪条） */
  eraseAt([x, y]) {
    const W = this.cssW || 1;
    const H = this.cssH || 1;
    const tol = 0.012;
    let removed = 0;
    this.strokes = this.strokes.filter((s) => {
      for (const [px, py] of s.points) {
        const dx = (px - x) * W;
        const dy = (py - y) * H;
        if (Math.hypot(dx, dy) < Math.max(10, tol * W)) { removed++; return false; }
      }
      return true;
    });
    if (removed) {
      this.redraw();
      this.onChange && this.onChange(this.strokes);
    }
  }

  updateCursor() {
    this.canvas.style.cursor = this.tool === 'eraser' ? 'cell' : 'crosshair';
  }

  /* ---------- 对外 ---------- */
  setActive(on) {
    this.active = !!on;
    this.wrap.style.display = this.active ? 'block' : 'none';
    document.body.classList.toggle('inking', this.active);
    if (this.active) {
      this.resize();
      this.updateCursor();
      this.onToolChange && this.onToolChange(this.tool);
    } else {
      this.drawing = null;
      this.redraw();
    }
  }

  setStrokes(list) {
    this.strokes = Array.isArray(list) ? list.filter((s) => s && Array.isArray(s.points)) : [];
    this.resize();
  }

  getStrokes() { return this.strokes; }

  destroy() {
    this.wrap.remove();
    this.active = false;
  }
}

/** 把笔画序列化成可提交的 JSON 文本 */
export function serializeInk(strokes) {
  return JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), strokes }, null, 1);
}

/** 解析仓库里的标注文件 */
export function parseInk(text) {
  try {
    const j = JSON.parse(text);
    return Array.isArray(j.strokes) ? j.strokes : [];
  } catch (e) {
    return [];
  }
}
