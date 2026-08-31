/* Shared canvas graph renderer for both knowledge-graph modes.

   Both modes previously drew themselves: V1 as absolutely-positioned DOM cards
   on a fixed 4-column grid with an SVG edge layer, V2 as a single ring painted
   into a canvas that inherited its height from a sibling panel.  Neither could
   pan, zoom, or fit.  This module owns geometry once so the two modes differ
   only in where their data comes from and whether it can be edited. */
(() => {
  'use strict';

  /* The canonical 15 editorial relations plus the 2 statistical signals, in the
     order scripts/build_v4_concept_graph_v2.py defines them.  Grouping them into
     five semantic families keeps the palette readable - fifteen hues on one
     canvas cannot all stay distinguishable, so hue carries the family and the
     dash pattern separates members inside it. */
  const FAMILIES = {
    structure: { label: '定义与结构', color: '#4a5fa5' },
    causation: { label: '缘起', color: '#a8672c' },
    support: { label: '助与障', color: '#2f7d78' },
    correspondence: { label: '对应与对举', color: '#7a4f8f' },
    practice: { label: '修与证', color: '#8b6914' },
    statistical: { label: '统计信号', color: '#7d8a80' },
  };

  const DASHES = [[], [7, 4], [2, 3], [10, 3, 2, 3]];
  const RELATION_META = {};
  const define = (family, names) => names.forEach((entry, index) => {
    RELATION_META[entry[0]] = {
      key: entry[0], label: entry[1], family,
      color: FAMILIES[family].color, dash: DASHES[index % DASHES.length],
    };
  });
  define('structure', [['definition_alias', '定义/异名'], ['classification_contains', '分类/包含'], ['equivalent_to', '等同']]);
  define('causation', [['condition', '条件'], ['arising', '引生'], ['cessation', '止息'], ['co_arising', '共起']]);
  define('support', [['supports', '支持'], ['obstacle', '障碍'], ['dependence', '依止'], ['depends_on', '依赖']]);
  define('correspondence', [['object', '所缘'], ['correspondence', '相应'], ['contrast', '对举'], ['exclusion', '排除']]);
  define('practice', [['practice_direction', '修习导向'], ['attainment', '证得'], ['qualifies', '限定'], ['entails', '蕴含']]);
  define('statistical', [['cross_document_salience', '跨文档显著'], ['local_context_cooccurrence', '局部语境共现'], ['related_to', '相关'], ['contradicts', '张力／矛盾']]);

  const relationMeta = type => RELATION_META[type] ||
    { key: type, label: type || '关系', family: 'statistical', color: FAMILIES.statistical.color, dash: [] };

  /* Concept types get their own scale: in V2 the edges are all undirected
     statistical association, so the only structure worth colouring is what kind
     of thing each node is. */
  const CONCEPT_TYPE_META = {
    concept: { label: '法义', color: '#6a8f6f' },
    person: { label: '人物', color: '#b1743a' },
    text: { label: '文本', color: '#4a70a8' },
    school: { label: '修习体系', color: '#8b6914' },
    place: { label: '地点', color: '#5f9aa0' },
    event: { label: '事件', color: '#a35f7d' },
    term: { label: '术语', color: '#7f7aa8' },
    other: { label: '其他', color: '#8a938c' },
  };
  const conceptMeta = type => CONCEPT_TYPE_META[type] || CONCEPT_TYPE_META.other;

  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  /* Browsers silently drop a canvas whose backing store is too large; staying
     under the smallest common cap matters more than pixel-perfect DPR. */
  const MAX_BUFFER = 8192;

  function create(container, options = {}) {
    const opts = {
      directed: false, arrows: false, minZoom: 0.05, maxZoom: 4,
      background: 'transparent', ...options,
    };

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const canvas = document.createElement('canvas');
    canvas.className = 'gc-canvas';
    canvas.setAttribute('role', 'img');
    const a11y = document.createElement('ul');
    a11y.className = 'gc-a11y';
    container.append(canvas, a11y);
    const ctx = canvas.getContext('2d');

    let nodes = [], edges = [], adjacency = new Map();
    let view = { k: 1, x: 0, y: 0 };
    let width = 0, height = 0, dpr = 1;
    let hover = null, selected = null, drag = null, frame = 0;
    let coolSteps = 0, grid = null, cell = 80, autoFit = false;
    let familyFilter = null, labelsOn = true;
    let destroyed = false;

    /* ---- sizing -------------------------------------------------------- */
    function resize() {
      const rect = container.getBoundingClientRect();
      const nextW = Math.max(1, Math.round(rect.width));
      const nextH = Math.max(1, Math.round(rect.height));
      const ratio = Math.min(window.devicePixelRatio || 1,
        MAX_BUFFER / Math.max(nextW, nextH, 1));
      if (nextW === width && nextH === height && ratio === dpr) return;
      width = nextW; height = nextH; dpr = Math.max(1, ratio);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      schedule();
    }
    const observer = new ResizeObserver(() => { if (!destroyed) resize(); });
    observer.observe(container);
    // The observer alone is not enough on a cold load: the graph can be created
    // in the same task that inserted the markup, before the stylesheet has given
    // the panel its height, and a first measurement of 2px would stick.
    const onWindowResize = () => { if (!destroyed) resize(); };
    window.addEventListener('resize', onWindowResize);

    /* ---- layout -------------------------------------------------------- */
    /* Fruchterman-Reingold with a cooling schedule, stepped from the animation
       frame so a 180-node warm-up never blocks the first paint. */
    function layoutStep(steps = 1) {
      if (!nodes.length) return;
      const area = Math.max(1, nodes.length) * 9000;
      const ideal = Math.sqrt(area / Math.max(1, nodes.length));
      const bound = ideal * Math.sqrt(nodes.length) * 1.6;
      for (let pass = 0; pass < steps; pass++) {
        const temperature = ideal * 0.1 * (coolSteps / 300);
        const cutoff = ideal * 4;
        for (const node of nodes) { node.dx = 0; node.dy = 0; }
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            let ox = a.x - b.x, oy = a.y - b.y;
            let distance = Math.hypot(ox, oy);
            if (distance < 0.01) { ox = (i % 7) - 3; oy = (j % 7) - 3; distance = Math.hypot(ox, oy) || 1; }
            if (distance > cutoff) continue;
            const force = (ideal * ideal) / distance;
            const fx = (ox / distance) * force, fy = (oy / distance) * force;
            a.dx += fx; a.dy += fy; b.dx -= fx; b.dy -= fy;
          }
        }
        for (const edge of edges) {
          const a = edge.a, b = edge.b;
          if (!a || !b) continue;
          const ox = a.x - b.x, oy = a.y - b.y;
          const distance = Math.max(0.01, Math.hypot(ox, oy));
          const force = (distance * distance) / ideal * (0.3 + 0.7 * (edge.weight || 0.5));
          const fx = (ox / distance) * force, fy = (oy / distance) * force;
          a.dx -= fx; a.dy -= fy; b.dx += fx; b.dy += fy;
        }
        for (const node of nodes) {
          // Gravity scaled by degree: well-connected nodes are already held by
          // their edges, while an isolated one has nothing but repulsion pushing
          // it, and would otherwise drift far enough to wreck every fit().
          const pull = 0.01 + 0.09 / (1 + (adjacency.get(node.id)?.size || 0));
          node.dx -= node.x * pull; node.dy -= node.y * pull;
          if (node.fixed) continue;
          const magnitude = Math.max(0.01, Math.hypot(node.dx, node.dy));
          const limit = Math.min(magnitude, temperature);
          node.x += (node.dx / magnitude) * limit;
          node.y += (node.dy / magnitude) * limit;
          // Hard bound as a backstop, so no arrangement can push fit() past its
          // zoom floor and leave nodes stranded outside the viewport.
          const radius = Math.hypot(node.x, node.y);
          if (radius > bound) { node.x *= bound / radius; node.y *= bound / radius; }
        }
        coolSteps = Math.max(0, coolSteps - 1);
        if (!coolSteps) break;
      }
    }

    function buildGrid() {
      cell = Math.max(40, ...nodes.map(n => n.r * 2 + 6));
      grid = new Map();
      for (const node of nodes) {
        const key = `${Math.floor(node.x / cell)}:${Math.floor(node.y / cell)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(node);
      }
    }

    /* ---- painting ------------------------------------------------------ */
    function schedule() {
      if (frame || destroyed) return;
      frame = requestAnimationFrame(() => { frame = 0; draw(); });
    }

    /* Several assertions can connect the same pair; spread them symmetrically
       about the chord, in a fixed orientation so direction does not flip the
       side an edge lands on. */
    function worldBow(edge) {
      if (!(edge.parallelCount > 1)) return 0;
      const orient = String(edge.a.id) <= String(edge.b.id) ? 1 : -1;
      return (edge.parallel - (edge.parallelCount - 1) / 2) * 22 * orient;
    }

    const toScreenX = x => x * view.k + view.x;
    const toScreenY = y => y * view.k + view.y;

    function edgeVisible(edge) {
      if (familyFilter && relationMeta(edge.type).family !== familyFilter) return false;
      return true;
    }

    function draw() {
      if (!ctx) return;
      if (coolSteps) { layoutStep(3); buildGrid(); if (autoFit) applyFit(); schedule(); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!nodes.length) { drawEmpty(); return; }

      const focus = (hover && !hover.__edge && hover) || (selected && !selected.__edge && selected) || null;
      const near = focus ? adjacency.get(focus.id) || null : null;
      const dim = id => near && id !== focus.id && !near.has(id);

      /* Edges, batched by (colour, dash) so a 900-edge overview is a handful of
         stroke() calls rather than nine hundred. */
      const batches = new Map();
      // Several assertions can connect the same pair; bow each one a little
      // further out so they stay individually visible and clickable.
      const controlOf = edge => {
        const ax = toScreenX(edge.a.x), ay = toScreenY(edge.a.y);
        const bx = toScreenX(edge.b.x), by = toScreenY(edge.b.y);
        const bow = worldBow(edge) * view.k;
        if (!bow) return { ax, ay, bx, by, cx: (ax + bx) / 2, cy: (ay + by) / 2 };
        const dx = bx - ax, dy = by - ay, length = Math.max(1, Math.hypot(dx, dy));
        return { ax, ay, bx, by, cx: (ax + bx) / 2 - (dy / length) * bow, cy: (ay + by) / 2 + (dx / length) * bow };
      };
      for (const edge of edges) {
        if (!edge.a || !edge.b || !edgeVisible(edge)) continue;
        const meta = relationMeta(edge.type);
        const faded = near && dim(edge.a.id) && dim(edge.b.id);
        const alpha = faded ? 0.06 : (near ? 0.75 : 0.16 + 0.6 * (edge.weight || 0.4));
        const bucket = `${meta.color}|${meta.dash.join(',')}|${alpha.toFixed(2)}`;
        if (!batches.has(bucket)) batches.set(bucket, { meta, alpha, list: [] });
        batches.get(bucket).list.push(edge);
      }
      for (const batch of batches.values()) {
        ctx.globalAlpha = batch.alpha;
        ctx.strokeStyle = batch.meta.color;
        ctx.setLineDash(batch.meta.dash.map(v => v * view.k));
        for (const edge of batch.list) {
          ctx.lineWidth = Math.max(0.6, (0.8 + 3.2 * (edge.weight || 0.3)) * Math.min(1, view.k));
          const { ax, ay, bx, by, cx, cy } = controlOf(edge);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          if (edge.parallelCount > 1) ctx.quadraticCurveTo(cx, cy, bx, by); else ctx.lineTo(bx, by);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      if (opts.arrows) drawArrows(near, dim, controlOf);

      // Nodes.
      for (const node of nodes) {
        const radius = Math.max(2.5, node.r * Math.min(1.4, Math.max(0.45, view.k)));
        ctx.globalAlpha = near && dim(node.id) ? 0.18 : 1;
        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(toScreenX(node.x), toScreenY(node.y), radius, 0, Math.PI * 2);
        ctx.fill();
        if (node === selected || node === hover) {
          ctx.strokeStyle = '#2f3c35'; ctx.lineWidth = 2; ctx.stroke();
        } else if (view.k > 0.5) {
          ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2; ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      drawLabels(near, dim);
      if (opts.arrows) drawEdgeLabel();
    }

    function drawArrows(near, dim, controlOf) {
      ctx.globalAlpha = 0.9;
      for (const edge of edges) {
        if (!edge.a || !edge.b || !edgeVisible(edge)) continue;
        if (edge.direction === 'undirected') continue;
        if (near && dim(edge.a.id) && dim(edge.b.id)) continue;
        const meta = relationMeta(edge.type);
        const { ax, ay, bx, by, cx, cy } = controlOf(edge);
        // 70% along, not at the endpoint: the target node's disc would cover it.
        const t = 0.7, u = 1 - t;
        const px = u * u * ax + 2 * u * t * cx + t * t * bx;
        const py = u * u * ay + 2 * u * t * cy + t * t * by;
        const angle = Math.atan2(2 * (u * (cy - ay) + t * (by - cy)), 2 * (u * (cx - ax) + t * (bx - cx)));
        const size = clamp(7 * view.k, 4, 11);
        ctx.fillStyle = meta.color;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - size * Math.cos(angle - 0.42), py - size * Math.sin(angle - 0.42));
        ctx.lineTo(px - size * Math.cos(angle + 0.42), py - size * Math.sin(angle + 0.42));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* Labels are the thing that turned 217 neighbours into a grey smear: draw
       them in importance order and skip any that would land on one already
       placed. */
    function drawLabels(near, dim) {
      if (!labelsOn && !near) return;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const placed = [];
      const budget = nodes.length > 400 && view.k < 1.2 ? 0 : 220;
      const ordered = [...nodes].sort((a, b) => (b.weight || 0) - (a.weight || 0));
      let drawn = 0;
      for (const node of ordered) {
        const focused = node === hover || node === selected ||
          (near && (near.has(node.id) || node.id === (hover || selected).id));
        if (!focused) {
          if (drawn >= budget) continue;
          if (near && dim(node.id)) continue;
        }
        const x = toScreenX(node.x), y = toScreenY(node.y);
        const radius = Math.max(2.5, node.r * Math.min(1.4, Math.max(0.45, view.k)));
        if (x < -120 || x > width + 120 || y < -60 || y > height + 60) continue;
        ctx.font = `${focused ? '600 ' : ''}12px system-ui,-apple-system,"PingFang SC",sans-serif`;
        const label = node.label.length > 12 ? `${node.label.slice(0, 12)}…` : node.label;
        const half = ctx.measureText(label).width / 2 + 2;
        const box = { l: x - half, r: x + half, t: y + radius + 3, b: y + radius + 17 };
        if (!focused && placed.some(p => !(box.r < p.l || box.l > p.r || box.b < p.t || box.t > p.b))) continue;
        placed.push(box);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(250,252,249,.92)';
        ctx.lineJoin = 'round';
        ctx.strokeText(label, x, box.t);
        ctx.fillStyle = focused ? '#1f2b25' : '#3c4a41';
        ctx.fillText(label, x, box.t);
        drawn++;
      }
    }

    /* In the editorial graph the relation label is the assertion, so it shows on
       demand instead of permanently littering the canvas. */
    function drawEdgeLabel() {
      const edge = hover?.__edge || selected?.__edge;
      if (!edge || !edge.a || !edge.b) return;
      const meta = relationMeta(edge.type);
      const bow = worldBow(edge) * view.k;
      const ax = toScreenX(edge.a.x), ay = toScreenY(edge.a.y);
      const bx = toScreenX(edge.b.x), by = toScreenY(edge.b.y);
      const span = Math.max(1, Math.hypot(bx - ax, by - ay));
      const x = (ax + bx) / 2 - ((by - ay) / span) * bow / 2;
      const y = (ay + by) / 2 + ((bx - ax) / span) * bow / 2;
      ctx.font = '600 12px system-ui,-apple-system,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const width2 = ctx.measureText(meta.label).width + 14;
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x - width2 / 2, y - 11, width2, 22, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = meta.color;
      ctx.fillText(meta.label, x, y);
    }

    function drawEmpty() {
      ctx.fillStyle = '#8a948c';
      ctx.font = '13px system-ui,-apple-system,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opts.emptyText || '选择一个概念以展开它的关系网络。', width / 2, height / 2);
    }

    /* ---- view ---------------------------------------------------------- */
    function bounds() {
      if (!nodes.length) return null;
      let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
      for (const node of nodes) {
        l = Math.min(l, node.x - node.r - 30); r = Math.max(r, node.x + node.r + 30);
        t = Math.min(t, node.y - node.r - 12); b = Math.max(b, node.y + node.r + 24);
      }
      return { l, r, t, b };
    }

    /* While the layout is still cooling the graph keeps spreading, so a
       one-shot fit at setData time frames a picture that no longer exists two
       hundred steps later.  Keep re-framing until the reader takes over. */
    function applyFit(padding = 0.9) {
      const box = bounds();
      if (!box || !width || !height) return;
      const k = clamp(Math.min(width / Math.max(1, box.r - box.l),
        height / Math.max(1, box.b - box.t)) * padding, opts.minZoom, opts.maxZoom);
      view = {
        k,
        x: width / 2 - ((box.l + box.r) / 2) * k,
        y: height / 2 - ((box.t + box.b) / 2) * k,
      };
    }

    function fit(padding = 0.9) { resize(); autoFit = true; applyFit(padding); schedule(); }
    const releaseView = () => { autoFit = false; };

    function zoomAt(factor, clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const px = (clientX ?? rect.width / 2 + rect.left) - rect.left;
      const py = (clientY ?? rect.height / 2 + rect.top) - rect.top;
      const next = clamp(view.k * factor, opts.minZoom, opts.maxZoom);
      releaseView();
      view.x = px - (px - view.x) * (next / view.k);
      view.y = py - (py - view.y) * (next / view.k);
      view.k = next;
      schedule();
    }

    /* ---- interaction --------------------------------------------------- */
    function pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left - view.x) / view.k;
      const y = (clientY - rect.top - view.y) / view.k;
      if (!grid) buildGrid();
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      let best = null, bestDistance = Infinity;
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iy = cy - 1; iy <= cy + 1; iy++) {
          for (const node of grid.get(`${ix}:${iy}`) || []) {
            const distance = Math.hypot(node.x - x, node.y - y);
            const reach = Math.max(node.r + 4, 10 / view.k);
            if (distance < reach && distance < bestDistance) { best = node; bestDistance = distance; }
          }
        }
      }
      if (best) return best;
      // Fall back to edges so an assertion can be clicked in the editorial graph.
      let bestEdge = null, edgeDistance = 8 / view.k;
      for (const edge of edges) {
        if (!edge.a || !edge.b || !edgeVisible(edge)) continue;
        const { a, b } = edge;
        const vx = b.x - a.x, vy = b.y - a.y;
        const length = vx * vx + vy * vy;
        if (!length) continue;
        const t = clamp(((x - a.x) * vx + (y - a.y) * vy) / length, 0, 1);
        const span = Math.sqrt(length);
        // Signed perpendicular distance from the chord, compared against where
        // the bowed curve actually sits at this t, so a curve is grabbed where
        // it is drawn rather than along the straight line it was drawn from.
        const side = ((x - a.x) * -vy + (y - a.y) * vx) / span;
        const bow = worldBow(edge);
        const along = Math.hypot(x - (a.x + vx * t), y - (a.y + vy * t));
        const measured = bow ? Math.abs(side - 2 * t * (1 - t) * bow) : along;
        if (measured < edgeDistance) { edgeDistance = measured; bestEdge = edge; }
      }
      return bestEdge ? { id: `edge:${bestEdge.id}`, __edge: bestEdge } : null;
    }

    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      zoomAt(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY);
    }, { passive: false });

    const pointers = new Map();
    let pinch = 0;

    canvas.addEventListener('pointerdown', event => {
      // Capture is an optimisation, not a precondition - it throws for pointer
      // ids the element does not own, and an unguarded throw here would abort
      // the handler and leave the graph unresponsive to that gesture.
      try { canvas.setPointerCapture(event.pointerId); } catch {}
      pointers.set(event.pointerId, event);
      if (pointers.size === 2) {
        const [p1, p2] = [...pointers.values()];
        pinch = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
        drag = null;
        return;
      }
      const hit = pick(event.clientX, event.clientY);
      drag = hit && !hit.__edge && opts.draggableNodes
        ? { kind: 'node', node: hit, moved: false, x: event.clientX, y: event.clientY }
        : { kind: 'pan', moved: false, x: event.clientX, y: event.clientY, view: { ...view } };
    });

    canvas.addEventListener('pointermove', event => {
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, event);
      if (pointers.size === 2 && pinch) {
        const [p1, p2] = [...pointers.values()];
        const distance = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
        if (distance > 4) {
          zoomAt(distance / pinch, (p1.clientX + p2.clientX) / 2, (p1.clientY + p2.clientY) / 2);
          pinch = distance;
        }
        return;
      }
      if (!drag) {
        const hit = pick(event.clientX, event.clientY);
        if (hit !== hover) {
          hover = hit;
          canvas.style.cursor = hit ? 'pointer' : 'grab';
          opts.onHover?.(hit && !hit.__edge ? hit.data : null, hit?.__edge?.data || null);
          schedule();
        }
        return;
      }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { drag.moved = true; releaseView(); }
      if (drag.kind === 'pan') {
        view.x = drag.view.x + dx; view.y = drag.view.y + dy;
      } else {
        const rect = canvas.getBoundingClientRect();
        drag.node.x = (event.clientX - rect.left - view.x) / view.k;
        drag.node.y = (event.clientY - rect.top - view.y) / view.k;
        drag.node.fixed = true;
        grid = null;
      }
      schedule();
    });

    function endPointer(event) {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = 0;
      try { canvas.releasePointerCapture(event.pointerId); } catch {}
      if (!drag) return;
      const finished = drag;
      drag = null;
      if (finished.kind === 'node') {
        if (finished.moved) opts.onNodeMoved?.(finished.node.data, { x: finished.node.x, y: finished.node.y });
        else { selected = finished.node; opts.onSelect?.(finished.node.data, null); schedule(); }
        return;
      }
      if (finished.moved) return;
      const hit = pick(event.clientX, event.clientY);
      selected = hit || null;
      opts.onSelect?.(hit && !hit.__edge ? hit.data : null, hit?.__edge?.data || null);
      schedule();
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', () => {
      if (hover) { hover = null; canvas.style.cursor = 'grab'; opts.onHover?.(null, null); schedule(); }
    });

    /* ---- data ---------------------------------------------------------- */
    function setData(rawNodes = [], rawEdges = [], settings = {}) {
      resize();
      const previous = new Map(nodes.map(node => [node.id, node]));
      const weights = rawNodes.map(n => Number(n.weight) || 0);
      const maxWeight = Math.max(1, ...weights);
      const ring = Math.max(120, Math.sqrt(rawNodes.length) * 90);
      nodes = rawNodes.map((raw, index) => {
        const id = String(raw.id);
        const carried = settings.keepPositions !== false ? previous.get(id) : null;
        const angle = index * 2.399963;            // golden-angle seed, not a ring
        const spread = ring * Math.sqrt((index + 0.5) / rawNodes.length);
        return {
          id,
          data: raw.data ?? raw,
          label: String(raw.label ?? id),
          color: raw.color || conceptMeta(raw.type).color,
          weight: Number(raw.weight) || 0,
          r: clamp(5 + 16 * Math.sqrt((Number(raw.weight) || 0) / maxWeight), 4, 26),
          x: raw.x ?? carried?.x ?? Math.cos(angle) * spread,
          y: raw.y ?? carried?.y ?? Math.sin(angle) * spread,
          fixed: Boolean(raw.fixed),
          dx: 0, dy: 0,
        };
      });
      const byId = new Map(nodes.map(node => [node.id, node]));
      adjacency = new Map(nodes.map(node => [node.id, new Set()]));
      edges = rawEdges.map((raw, index) => {
        const a = byId.get(String(raw.source)), b = byId.get(String(raw.target));
        if (a && b) { adjacency.get(a.id).add(b.id); adjacency.get(b.id).add(a.id); }
        return {
          id: String(raw.id ?? index), a, b, data: raw.data ?? raw,
          type: raw.type, weight: Number(raw.weight) || 0,
          parallel: raw.parallel || 0, parallelCount: raw.parallelCount || 1,
          direction: raw.direction || (opts.directed ? 'directed' : 'undirected'),
        };
      }).filter(edge => edge.a && edge.b);
      hover = null; selected = null; grid = null;
      coolSteps = settings.warm === false ? 0 : Math.min(300, 120 + nodes.length);
      autoFit = settings.fit !== false;
      if (coolSteps) layoutStep(40);                 // enough to look sane at once
      buildGrid();
      a11y.innerHTML = nodes.slice(0, 200)
        .map(node => `<li><button type="button" data-gc-node="${node.id.replace(/"/g, '&quot;')}">${node.label}</button></li>`).join('');
      canvas.setAttribute('aria-label', settings.label ||
        `关系图，${nodes.length} 个节点，${edges.length} 条关系`);
      if (autoFit) { resize(); applyFit(); }
      schedule();
    }

    a11y.addEventListener('click', event => {
      const id = event.target.closest('[data-gc-node]')?.dataset.gcNode;
      const node = id && nodes.find(item => item.id === id);
      if (node) { selected = node; opts.onSelect?.(node.data, null); schedule(); }
    });

    resize();
    requestAnimationFrame(() => { if (!destroyed) resize(); });

    return {
      setData, fit,
      zoomIn: () => zoomAt(1.25), zoomOut: () => zoomAt(0.8),
      setFamilyFilter(family) { familyFilter = family || null; schedule(); },
      setLabelsVisible(value) { labelsOn = Boolean(value); schedule(); },
      select(id) {
        const node = nodes.find(item => item.id === String(id));
        if (node !== selected) { selected = node || null; schedule(); }
      },
      focus(id) {
        const node = nodes.find(item => item.id === String(id));
        if (!node) return;
        releaseView();
        selected = node;
        view.x = width / 2 - node.x * view.k;
        view.y = height / 2 - node.y * view.k;
        schedule();
      },
      get nodeCount() { return nodes.length; },
      get edgeCount() { return edges.length; },
      screenPositions: () => nodes.map(node => ({ id: node.id, x: toScreenX(node.x), y: toScreenY(node.y) })),
      destroy() {
        destroyed = true;
        observer.disconnect();
        window.removeEventListener('resize', onWindowResize);
        if (frame) cancelAnimationFrame(frame);
        canvas.remove(); a11y.remove();
      },
    };
  }

  window.GraphCanvas = { create, RELATION_META, CONCEPT_TYPE_META, FAMILIES, relationMeta, conceptMeta };
})();
