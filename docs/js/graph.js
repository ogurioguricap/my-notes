/**
 * 知识图谱：Canvas + 自写力导向布局（零依赖）
 * 节点＝笔记（颜色＝分类，半径＝连接数），连线＝互链/同标签关系
 * 支持：拖动节点重新布局、滚轮/按钮缩放、平移、悬停高亮、点击打开
 */

export function createGraph({ canvas, tipEl, legendEl, onOpen }) {
  const ctx = canvas.getContext('2d');
  let nodes = [];
  let edges = [];
  let dpr = 1;
  let W = 800;
  let H = 600;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let running = false;
  let raf = 0;
  let ticks = 0;
  let hover = null;
  let dragNode = null;
  let panning = false;
  let last = { x: 0, y: 0 };
  let alpha = 1;
  const palette = ['#EA5A47', '#4C7DF0', '#0E9F8C', '#E0913A', '#8B5CF6', '#D94F8A', '#3D8A5F', '#5A6B8C', '#C2410C', '#0EA5E9'];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(320, rect.width);
    H = Math.max(300, rect.height);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function layoutNodes(notes) {
    const list = notes.filter((n) => n);
    const idx = new Map(list.map((n, i) => [n.slug, i]));    const cats = [...new Set(list.map((n) => n.category || '未分类'))];
    const catColor = new Map(cats.map((c, i) => [c, palette[i % palette.length]]));

    nodes = list.map((n, i) => {
      const a = (i / Math.max(1, list.length)) * Math.PI * 2;
      const r = Math.min(W, H) * 0.32;
      return {
        i,
        slug: n.slug,
        title: n.title,
        category: n.category || '未分类',
        tags: n.tags || [],
        color: catColor.get(n.category || '未分类'),
        x: W / 2 + Math.cos(a) * r * (0.6 + Math.random() * 0.5),
        y: H / 2 + Math.sin(a) * r * (0.6 + Math.random() * 0.5),
        vx: 0,
        vy: 0,
        deg: 0,
        r: 7,
      };
    });

    const seen = new Set();
    edges = [];
    for (const n of list) {
      const a = idx.get(n.slug);
      const targets = [...(n.resolvedLinks || [])];
      for (const t of targets) {
        const b = idx.get(t);
        if (a === undefined || b === undefined || a === b) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a, b, kind: 'link', w: 1 });
      }
      // 同标签弱连接（每篇最多连 4 条，避免毛线球）
      let linked = 0;
      const tags = n.tags || [];
      for (const m of list) {
        if (m.slug === n.slug || linked >= 4) continue;
        const b = idx.get(m.slug);
        const share = tags.filter((t) => (m.tags || []).includes(t));
        if (share.length) {
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ a, b, kind: 'tag', w: 0.5 });
          linked++;
        }
      }
    }

    for (const e of edges) { nodes[e.a].deg++; nodes[e.b].deg++; }
    for (const nd of nodes) nd.r = 6 + Math.min(16, nd.deg * 2.2);
    alpha = 1;
    ticks = 0;
    if (legendEl) {
      legendEl.innerHTML =
        `<div><b>${list.length}</b> 篇 · <b>${edges.length}</b> 条关系</div>` +
        cats.slice(0, 8).map((c) => `<div class="legend-row"><span class="legend-dot" style="background:${catColor.get(c)}"></span>${escGraph(c)}</div>`).join('');
    }
    fit();
  }

  function simulate() {
    const cx = W / 2;
    const cy = H / 2;
    const k = Math.sqrt((W * H) / Math.max(1, nodes.length)) * 0.42;

    // 斥力（节点间）
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(d2);
        const force = (k * k * 1.15) / d2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // 弹簧（边）
    for (const e of edges) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const rest = e.kind === 'link' ? k * 0.75 : k * 1.25;
      const f = ((d - rest) / d) * 0.5 * e.w;
      a.vx += dx * f * 0.5; a.vy += dy * f * 0.5;
      b.vx -= dx * f * 0.5; b.vy -= dy * f * 0.5;
    }

    // 向心 + 同分类聚合 + 阻尼
    const catCenters = new Map();
    for (const nd of nodes) {
      if (!catCenters.has(nd.category)) catCenters.set(nd.category, { x: 0, y: 0, n: 0 });
      const c = catCenters.get(nd.category);
      c.x += nd.x; c.y += nd.y; c.n++;
    }
    for (const c of catCenters.values()) { c.x /= c.n; c.y /= c.n; }

    for (const nd of nodes) {
      if (nd === dragNode) { nd.vx = nd.vy = 0; continue; }
      const c = catCenters.get(nd.category);
      nd.vx += (c.x - nd.x) * 0.012;
      nd.vy += (c.y - nd.y) * 0.012;
      nd.vx += (cx - nd.x) * 0.006;
      nd.vy += (cy - nd.y) * 0.006;
      nd.vx *= 0.86;
      nd.vy *= 0.86;
      const speed = Math.hypot(nd.vx, nd.vy);
      const cap = 14;
      if (speed > cap) { nd.vx = (nd.vx / speed) * cap; nd.vy = (nd.vy / speed) * cap; }
      nd.x += nd.vx * alpha;
      nd.y += nd.vy * alpha;
      nd.x = Math.max(28, Math.min(W - 28, nd.x));
      nd.y = Math.max(28, Math.min(H - 28, nd.y));
    }
    ticks++;
    if (ticks > 260) alpha = Math.max(0.04, alpha * 0.96);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    // 边
    for (const e of edges) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      const active = !hover || hover === a || hover === b;
      ctx.strokeStyle = e.kind === 'link'
        ? (active ? 'rgba(120,140,180,0.55)' : 'rgba(120,140,180,0.12)')
        : (active ? 'rgba(120,140,180,0.22)' : 'rgba(120,140,180,0.06)');
      ctx.lineWidth = e.kind === 'link' ? 1.3 : 0.8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // 节点
    for (const nd of nodes) {
      const dim = hover && hover !== nd && !isNeighbor(nd);
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
      ctx.fillStyle = nd.color;
      ctx.fill();
      if (hover === nd) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
      // 标签：悬停、邻居、或连接数高的节点才显示，避免拥挤
      if (!dim && (hover === nd || (hover && isNeighbor(nd)) || nd.deg >= 3 || nodes.length <= 14)) {
        ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#333';
        ctx.textAlign = 'center';
        const label = nd.title.length > 14 ? nd.title.slice(0, 13) + '…' : nd.title;
        ctx.fillText(label, nd.x, nd.y - nd.r - 6);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function isNeighbor(nd) {
    if (!hover) return false;
    return edges.some((e) => (nodes[e.a] === hover && nodes[e.b] === nd) || (nodes[e.b] === hover && nodes[e.a] === nd));
  }

  function loop() {
    if (!running) return;
    if (alpha > 0.012 || dragNode) simulate();
    draw();
    if (alpha <= 0.012 && !dragNode && ticks > 120) { running = false; return; }
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function fit() {
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - 40;
    const maxX = Math.max(...xs) + 40;
    const minY = Math.min(...ys) - 40;
    const maxY = Math.max(...ys) + 40;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    scale = Math.min(1.4, Math.max(0.25, Math.min(W / w, H / h)));
    tx = (W - w * scale) / 2 - minX * scale;
    ty = (H - h * scale) / 2 - minY * scale;
  }

  function toWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - tx) / scale, y: (clientY - rect.top - ty) / scale };
  }

  function pick(world) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const nd = nodes[i];
      if (Math.hypot(nd.x - world.x, nd.y - world.y) <= nd.r + 6 / scale) return nd;
    }
    return null;
  }

  function bind() {
    let downAt = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      downAt = { x: e.clientX, y: e.clientY };
      const world = toWorld(e.clientX, e.clientY);
      const nd = pick(world);
      if (nd) { dragNode = nd; } else { panning = true; last = { x: e.clientX, y: e.clientY }; }
      start();
    });
    canvas.addEventListener('pointermove', (e) => {
      const world = toWorld(e.clientX, e.clientY);
      if (dragNode) {
        dragNode.x = world.x;
        dragNode.y = world.y;
        alpha = Math.max(alpha, 0.5);
        draw();
        return;
      }
      if (panning) {
        tx += e.clientX - last.x;
        ty += e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        draw();
        return;
      }
      const nd = pick(world);
      if (nd !== hover) {
        hover = nd;
        canvas.style.cursor = nd ? 'pointer' : 'grab';
        if (tipEl) {
          if (nd) {
            tipEl.innerHTML = `<b>${escGraph(nd.title)}</b><br><span style="color:var(--text-faint)">${escGraph(nd.category)}${nd.tags.length ? ' · ' + escGraph(nd.tags.slice(0, 3).join(' ')) : ''}</span>`;
            tipEl.classList.add('on');
          } else tipEl.classList.remove('on');
        }
        if (!running) draw();
      }
      if (nd && tipEl) {
        const rect = canvas.getBoundingClientRect();
        tipEl.style.left = Math.min(rect.width - 190, e.clientX - rect.left + 14) + 'px';
        tipEl.style.top = Math.max(8, e.clientY - rect.top - 10) + 'px';
      }
    });
    const end = (e) => {
      if (dragNode) { dragNode = null; alpha = Math.max(alpha, 0.3); }
      panning = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    canvas.addEventListener('pointerup', (e) => {
      const nd = dragNode;
      const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 99;
      end(e);
      if (nd && moved < 6 && onOpen) onOpen(nd.slug);
    });
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      hover = null;
      if (tipEl) tipEl.classList.remove('on');
      if (!running) draw();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = Math.max(0.2, Math.min(4, scale * factor));
      tx = mx - ((mx - tx) * ns) / scale;
      ty = my - ((my - ty) * ns) / scale;
      scale = ns;
      draw();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { fit(); draw(); });
  }

  bind();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      resize();
      if (running) draw();
    });
    ro.observe(canvas);
  }
  window.addEventListener('resize', () => { resize(); draw(); });

  return {
    setData(notes) {
      resize();
      layoutNodes(notes);
      draw();
      start();
    },
    redraw() { resize(); draw(); },
    fit() { fit(); draw(); },
    start,
    stop,
  };
}

function escGraph(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
