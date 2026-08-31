/* V4 经证知识图谱 v2 — lazy multilingual concept graph. */
(() => {
  'use strict';
  const legacyRoute = window.renderKnowledgeGraphRoute;
  const ROOT = `${(window.TIPITAKA_DATA_BASE || 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1').replace(/\/$/, '')}/concept-graph-v2`;
  const app = document.getElementById('app');
  const state = { manifest: null, concepts: [], adjacencyIndex: null, adjacency: new Map(), query: '', type: '', relation: '', selected: null, page: 0, showRaw: false, overview: null, view: 'overview', neighbourLimit: 120 };
  const OVERVIEW_URL = new URL('data/concept-graph-overview.json.gz', document.baseURI).href;
  let graph = null;
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ṁ/g, 'ṃ').replace(/[ā]/g, 'a').replace(/[ī]/g, 'i').replace(/[ū]/g, 'u').replace(/[ṅñṇ]/g, 'n').replace(/[ṭ]/g, 't').replace(/[ḍ]/g, 'd').replace(/[ḷ]/g, 'l').replace(/[ṃ]/g, 'm');
  const text = value => String(value ?? '').trim();
  const link = ev => ev?.deep_link || (ev?.work_id && ev?.row_id != null ? `#/tipitaka/read/${encodeURIComponent(ev.work_id)}?row=${encodeURIComponent(ev.row_id)}&hl=${encodeURIComponent(ev.anchor || ev.matched_term || '')}&hl_lang=pali` : '');
  const typeLabel = value => ({ concept: '法义', person: '人物', text: '文本', school: '修习体系', place: '地点', event: '事件', term: '术语', other: '其他' }[value] || value || '其他');
  const relationLabel = value => ({ cross_document_salience: '跨文档显著', local_context_cooccurrence: '局部语境共现', definition_alias: '定义/异名', classification_contains: '分类/包含', condition: '条件', arising: '引生', cessation: '止息', supports: '支持', obstacle: '障碍', dependence: '依止', object: '所缘', co_arising: '共起', correspondence: '相应', contrast: '对举', practice_direction: '修习导向', attainment: '证得', exclusion: '排除' }[value] || value || '关系');
  const aiAuditLabel = status => status === 'not_run' || status === 'not_ai_audited' || state.manifest?.ai?.status === 'not_run' ? '未完成 AI 审核（全量展示）' : '已完成 AI 审核';
  async function json(url) {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`数据请求失败（${response.status}）`);
    const encoding = response.headers.get('content-encoding') || '';
    if (encoding.includes('gzip')) return response.json();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 && new Uint8Array(bytes, 0, 2)[0] === 0x1f && 'DecompressionStream' in window) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function allTerms(concept) { return [concept.pali, concept.label_zh, concept.label_en, ...(concept.surface_forms || []), ...(concept.aliases || [])].filter(Boolean).join(' '); }
  function match(concept, q) { if (!q) return true; const exact = allTerms(concept).toLowerCase(); return exact.includes(q.toLowerCase()) || fold(exact).includes(fold(q)); }
  function sortedConcepts() {
    return state.concepts.filter(c => (!state.type || c.concept_type === state.type) && match(c, state.query)).sort((a, b) => (b.parent_work_count - a.parent_work_count) || (b.document_frequency - a.document_frequency) || a.concept_id.localeCompare(b.concept_id));
  }
  function statLine() {
    const c = state.manifest?.counts || {};
    return `V2 已载入 · ${Number(c.canonical_concepts || 0).toLocaleString()} 个规范概念 · ${Number(c.surface_concepts || 0).toLocaleString()} 个原始词形 · ${Number(c.surface_relations || 0).toLocaleString()} 条原始关系 · ${Number(c.canonical_relations || 0).toLocaleString()} 条规范统计关系 · ${aiAuditLabel()}`;
  }
  function renderShell() {
    app.innerHTML = `<div class="kg2-shell"><header class="kg2-header"><div><div class="kg2-kicker">V4 经证知识图谱 · concept-graph-v2</div><h2>规范化后的语义概念网络</h2><p>全量概念与关系按页加载；词形先归并，再展示跨文档显著性。统计关联不表示教义因果；每条经证可回到真实 V4 逐句。</p><div class="kg2-tabs"><button class="kg2-tab" id="kg2-formal">正式共创图</button><button class="kg2-tab is-active">V2 统计发现</button></div></div><div class="kg2-actions"><button class="kg2-button" id="kg2-refresh">刷新</button><button class="kg2-button" id="kg2-fit">适配全部可视节点</button></div></header><section class="kg2-toolbar"><input id="kg2-query" placeholder="搜索中文、English、巴利语或词形…" autocomplete="off"><select id="kg2-type"><option value="">全部概念类型</option>${Object.entries({ concept: '法义', person: '人物', text: '文本', school: '修习体系', place: '地点', event: '事件', term: '术语', other: '其他' }).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><span class="kg2-status" id="kg2-status">正在读取 V2…</span></section><div class="kg2-main"><section class="kg2-results" id="kg2-results"></section><section class="kg2-visual" id="kg2-visual"><details class="kg2-legend" id="kg2-legend" open><summary>图例</summary><div class="kg2-legend-body" id="kg2-legend-body"></div></details><div class="kg2-breadcrumb" id="kg2-breadcrumb" hidden></div><div class="kg2-zoom"><button type="button" id="kg2-zoom-out" aria-label="缩小">−</button><button type="button" id="kg2-zoom-fit">适配</button><button type="button" id="kg2-zoom-in" aria-label="放大">＋</button></div><div class="kg2-graph-note" id="kg2-graph-note">点击节点查看经证与原始指标。</div></section><aside class="kg2-detail" id="kg2-detail"><div class="kg2-empty">搜索或选择一个规范概念。</div></aside></div></div>`;
    document.getElementById('kg2-query').addEventListener('input', e => { state.query = e.target.value.trim(); state.page = 0; renderResults(); });
    document.getElementById('kg2-type').addEventListener('change', e => { state.type = e.target.value; state.page = 0; renderResults(); });
    document.getElementById('kg2-refresh').onclick = () => load(true);
    document.getElementById('kg2-fit').onclick = () => graph?.fit();
    document.getElementById('kg2-zoom-fit').onclick = () => graph?.fit();
    document.getElementById('kg2-zoom-in').onclick = () => graph?.zoomIn();
    document.getElementById('kg2-zoom-out').onclick = () => graph?.zoomOut();
    document.getElementById('kg2-breadcrumb').addEventListener('click', event => { if (event.target.closest('[data-kg2-home]')) showOverview(); });
    ensureGraph();
    document.getElementById('kg2-formal').onclick = () => { if (typeof legacyRoute === 'function') legacyRoute(); };
  }
  function renderResults() {
    const list = sortedConcepts(); const pageSize = 48; const start = state.page * pageSize; const shown = list.slice(start, start + pageSize);
    const result = document.getElementById('kg2-results'); if (!result) return;
    result.innerHTML = `<div class="kg2-result-head"><strong>规范概念目录</strong><span>${list.length.toLocaleString()} 个命中 · 第 ${list.length ? state.page + 1 : 0} 页</span></div>${shown.length ? shown.map(c => `<button class="kg2-concept-row ${state.selected?.concept_id === c.concept_id ? 'is-selected' : ''}" data-cid="${esc(c.concept_id)}"><span class="kg2-row-title"><b>${esc(c.label_zh || c.pali)}</b><i>${esc(c.pali)}</i></span><span class="kg2-row-meta">${esc(c.label_en || '—')} · ${esc(typeLabel(c.concept_type))} · DF ${Number(c.document_frequency || 0).toLocaleString()} · ${Number(c.relation_count || 0).toLocaleString()} 条关系 · ${esc(aiAuditLabel(c.ai_audit_status || state.manifest?.ai?.status))}</span></button>`).join('') : '<div class="kg2-empty">没有匹配概念。可尝试去掉巴利变音符、使用中文译名或查看全部概念。</div>'}<div class="kg2-pager"><button id="kg2-prev" ${state.page ? '' : 'disabled'}>上一页</button><button id="kg2-next" ${start + pageSize < list.length ? '' : 'disabled'}>下一页</button></div>`;
    const byId = new Map(shown.map(c => [c.concept_id, c]));
    result.querySelectorAll('[data-cid]').forEach(row => row.addEventListener('click', () => { const c = byId.get(row.dataset.cid); if (c) select(c); }));
    document.getElementById('kg2-prev')?.addEventListener('click', () => { state.page--; renderResults(); });
    document.getElementById('kg2-next')?.addEventListener('click', () => { state.page++; renderResults(); });
    document.getElementById('kg2-status').textContent = state.manifest ? statLine() : '';
  }
  async function loadAdjacencyIndex() { if (!state.adjacencyIndex) state.adjacencyIndex = await json(`${ROOT}/adjacency/index.json.gz`); return state.adjacencyIndex; }
  async function relationsFor(concept) {
    const index = await loadAdjacencyIndex(); const shard = index.shards?.[concept.concept_id];
    if (!shard) return [];
    if (!state.adjacency.has(shard)) state.adjacency.set(shard, await json(`${ROOT}/adjacency/${encodeURIComponent(shard)}.json.gz`));
    const payload = state.adjacency.get(shard);
    const rows = (payload?.[concept.concept_id] || []).map(row => {
      if (!row.evidence && row.evidence_concept_id) {
        const source = state.concepts.find(item => item.concept_id === row.evidence_concept_id);
        if (source?.evidence) row.evidence = source.evidence;
      }
      return row;
    });
    return rows.sort((a, b) => (Number(b.weight_score || 0) - Number(a.weight_score || 0)) || String(a.relation_id).localeCompare(String(b.relation_id)));
  }
  async function select(concept) {
    state.selected = concept; state.view = 'neighbourhood'; renderResults();
    const detail = document.getElementById('kg2-detail'); detail.innerHTML = '<div class="kg2-loading">正在读取邻接关系与经证…</div>';
    setStatus(`正在读取「${concept.label_zh || concept.pali}」的邻接分片（约 400KB）…`);
    const rows = await relationsFor(concept); concept.relation_count = rows.length;
    drawNeighbourhood(concept, rows); setStatus(statLine());
    let relationPage = 1;
    const renderDetail = () => {
      const pageSize = 160; const visible = rows.slice(0, relationPage * pageSize);
      detail.innerHTML = `<div class="kg2-detail-top"><span class="kg2-badge">${esc(concept.translation_status || 'candidate')}</span><span class="kg2-badge">${esc(typeLabel(concept.concept_type))}</span><span class="kg2-badge">${esc(aiAuditLabel(concept.ai_audit_status))}</span></div><h3>${esc(concept.label_zh || concept.pali)}</h3><div class="kg2-pali">${esc(concept.pali)}</div><p class="kg2-en">${esc(concept.label_en || '—')}</p><div class="kg2-metrics"><div><b>DF</b><strong>${Number(concept.document_frequency || 0).toLocaleString()}</strong></div><div><b>涉及作品</b><strong>${Number(concept.parent_work_count || 0).toLocaleString()}</strong></div><div><b>邻接</b><strong>${rows.length.toLocaleString()}</strong></div></div>${concept.evidence ? `<div class="kg2-evidence"><div class="kg2-section-title">V4 经证（静态行已核验）</div><div>${esc(concept.evidence.title || concept.evidence.work_id)} · ${esc(concept.evidence.paranum || concept.evidence.row_id)}</div><blockquote class="kg2-evidence-pali">${esc(concept.evidence.pali)}</blockquote><blockquote>${esc(concept.evidence.chinese || '—')}</blockquote><a href="${esc(link(concept.evidence))}">打开 V4 逐句位置 →</a></div>` : '<div class="kg2-empty">暂无可解析的概念经证。</div>'}<div class="kg2-section-title">按权重排序的语义邻接（显示 ${visible.length.toLocaleString()} / ${rows.length.toLocaleString()}）</div><div class="kg2-relation-list">${visible.map(r => { const other = r.source === concept.concept_id ? r.target : r.source; const oc = state.concepts.find(x => x.concept_id === other); return `<button class="kg2-relation-row" data-rid="${esc(r.relation_id)}"><span><b>${esc(oc?.label_zh || other)}</b> <i>${esc(oc?.pali || other)}</i></span><small>${esc(relationLabel(r.relation_type))} · weight ${Number(r.weight_score || 0).toFixed(3)} · cosine ${Number(r.cosine || 0).toFixed(3)} · NPMI ${Number(r.npmi || 0).toFixed(3)} · ${Number(r.document_count || 0).toLocaleString()} 文档 · ${esc(aiAuditLabel(r.ai_audit_status))}</small></button>`; }).join('')}${visible.length < rows.length ? `<button class="kg2-more kg2-load-more" type="button">加载更多关系（还剩 ${(rows.length - visible.length).toLocaleString()} 条）</button>` : '<div class="kg2-more">已显示该概念的全部关系。</div>'}</div>`;
      detail.querySelectorAll('[data-rid]').forEach(button => button.addEventListener('click', () => { const r = rows.find(x => x.relation_id === button.dataset.rid); if (r) showRelation(r); }));
      detail.querySelector('.kg2-load-more')?.addEventListener('click', () => { relationPage += 1; renderDetail(); });
    };
    renderDetail();
  }
  function showRelation(row) {
    const detail = document.getElementById('kg2-detail'); const ev = row.evidence; detail.insertAdjacentHTML('afterbegin', `<div class="kg2-relation-focus"><b>${esc(relationLabel(row.relation_type))}</b><span>统计关联不表示因果 · weight ${Number(row.weight_score || 0).toFixed(3)} · ${esc(aiAuditLabel(row.ai_audit_status))}</span>${ev ? `<blockquote>${esc(ev.pali)}<br>${esc(ev.chinese || '—')}</blockquote><a href="${esc(link(ev))}">打开关系经证 →</a>` : '<span>该统计关系暂无可解析的 V4 行证据。</span>'}</div>`);
  }
  function setStatus(message) { const el = document.getElementById('kg2-status'); if (el) el.textContent = message || ''; }

  function ensureGraph() {
    const host = document.getElementById('kg2-visual');
    if (!host || !window.GraphCanvas) return null;
    graph?.destroy();
    graph = window.GraphCanvas.create(host, {
      emptyText: '正在准备概念网络…',
      onSelect: node => { const concept = node && state.concepts.find(c => c.concept_id === node.concept_id); if (concept) select(concept); },
    });
    return graph;
  }

  const nodeFor = concept => ({
    id: concept.concept_id, data: concept,
    label: text(concept.label_zh) || text(concept.pali) || concept.concept_id,
    type: concept.concept_type,
    weight: Math.sqrt(Number(concept.document_frequency || concept.parent_work_count || 1)),
  });

  /* Every concept in the overview carries concept_type "term", so hue would be
     a wasted channel.  Label propagation over the backbone recovers the groups
     the co-occurrence structure actually contains - cheap at this size, and
     stable because ties break on the lower id rather than at random. */
  const CLUSTER_COLORS = ['#6a8f6f', '#4a70a8', '#b1743a', '#7f7aa8', '#5f9aa0', '#a35f7d', '#8b6914', '#6d8a5a', '#9a6b5c', '#54809a'];
  function clusterOf(nodes, edges) {
    const neighbours = new Map(nodes.map(node => [node.id, []]));
    for (const edge of edges) {
      neighbours.get(edge.source)?.push([edge.target, edge.weight || 0.5]);
      neighbours.get(edge.target)?.push([edge.source, edge.weight || 0.5]);
    }
    const label = new Map(nodes.map(node => [node.id, node.id]));
    const order = nodes.map(node => node.id).sort();
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const id of order) {
        const tally = new Map();
        for (const [other, weight] of neighbours.get(id) || []) {
          const key = label.get(other);
          tally.set(key, (tally.get(key) || 0) + weight);
        }
        if (!tally.size) continue;
        const best = [...tally.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))[0][0];
        if (best !== label.get(id)) { label.set(id, best); changed = true; }
      }
      if (!changed) break;
    }
    const sizes = new Map();
    for (const key of label.values()) sizes.set(key, (sizes.get(key) || 0) + 1);
    const ranked = [...sizes.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])));
    const colour = new Map(ranked.map(([key], index) => [key, CLUSTER_COLORS[index % CLUSTER_COLORS.length]]));
    return { colorFor: id => colour.get(label.get(id)) || '#8a938c', groups: ranked.filter(entry => entry[1] > 2).length };
  }

  /* The canvas is the landing view, so it has to show a whole graph before
     anyone has clicked anything.  The overview file is a pre-computed backbone
     over the busiest concepts - one 17KB request, not 180 adjacency shards. */
  async function loadOverview() {
    if (state.overview) return state.overview;
    state.overview = await json(OVERVIEW_URL);
    return state.overview;
  }

  async function showOverview() {
    state.view = 'overview';
    state.selected = null;
    renderBreadcrumb();
    renderResults();
    const canvas = graph || ensureGraph();
    if (!canvas) return;
    try {
      const data = await loadOverview();
      const known = new Map(state.concepts.map(c => [c.concept_id, c]));
      const nodes = data.nodes.map(raw => nodeFor(known.get(raw.concept_id) || raw));
      const ids = new Set(nodes.map(n => n.id));
      const edges = data.edges.filter(e => ids.has(e.source) && ids.has(e.target))
        .map(e => ({ source: e.source, target: e.target, type: e.relation_type, weight: e.weight_score, direction: 'undirected' }));
      const clusters = clusterOf(nodes, edges);
      nodes.forEach(node => { node.color = clusters.colorFor(node.id); });
      canvas.setData(nodes, edges, { label: `全局概览，${nodes.length} 个概念` });
      renderLegend('overview', `全局概览 · ${nodes.length} 个最活跃概念 · ${edges.length} 条统计关联 · ${clusters.groups} 个共现聚类`);
      note('点击任一节点，展开它的完整邻接与 V4 经证。');
    } catch (error) {
      // No overview file (offline, or not rebuilt yet): fall back to the busiest
      // single concept rather than the blank canvas this page used to show.
      const first = sortedConcepts()[0];
      if (first) { select(first); return; }
      renderLegend('overview', '概览数据暂不可用');
    }
  }

  function drawNeighbourhood(concept, rows) {
    const canvas = graph || ensureGraph();
    if (!canvas) return;
    const limit = state.neighbourLimit;
    const visible = rows.slice(0, limit);
    const known = new Map(state.concepts.map(c => [c.concept_id, c]));
    const centre = { ...nodeFor(concept), x: 0, y: 0, fixed: true, color: '#8b6914' };
    const seen = new Map([[centre.id, centre]]);
    const edges = [];
    for (const row of visible) {
      const otherId = row.source === concept.concept_id ? row.target : row.source;
      if (!seen.has(otherId)) seen.set(otherId, nodeFor(known.get(otherId) || { concept_id: otherId, pali: otherId }));
      edges.push({ id: row.relation_id, source: concept.concept_id, target: otherId, type: row.relation_type, weight: Number(row.weight_score || 0), direction: 'undirected' });
    }
    canvas.setData([...seen.values()], edges, { label: `${centre.label} 的邻接，${seen.size - 1} 个概念` });
    renderLegend('neighbourhood', rows.length > limit
      ? `显示权重最高的 ${visible.length} / ${rows.length.toLocaleString()} 条关系`
      : `全部 ${rows.length.toLocaleString()} 条关系`, rows.length > limit);
    renderBreadcrumb(centre.label);
    note('拖动平移 · 滚轮或双指缩放 · 点击邻接节点继续展开。');
  }

  function note(message) { const el = document.getElementById('kg2-graph-note'); if (el) el.textContent = message; }

  function renderBreadcrumb(label) {
    const el = document.getElementById('kg2-breadcrumb');
    if (!el) return;
    el.hidden = !label;
    if (label) el.innerHTML = `<button type="button" data-kg2-home>全局概览</button><span>›</span><span>${esc(label)}</span>`;
  }

  /* V2's published adjacency is entirely undirected statistical association, so
     hue carries concept type and the two signals differ only by line style.
     Drawing arrows here would misstate the data. */
  function renderLegend(mode, caption, expandable) {
    const body = document.getElementById('kg2-legend-body');
    if (!body) return;
    const rows = mode === 'overview'
      ? '<div>颜色＝统计共现聚类<br>大小＝跨文档出现频次</div>'
      : '<div>金色＝当前概念<br>大小＝该概念的出现频次</div>';
    body.innerHTML = `${rows}<div class="kg-legend-foot">连线粗细＝统计权重<br>实线 跨文档显著 · 虚线 局部共现<br><b>统计关联 · 无向 · 不表示教义因果</b>${caption ? `<br>${esc(caption)}` : ''}</div>${expandable ? '<button class="kg-legend-item" id="kg2-show-all" style="margin-top:6px;justify-content:center;border:1px dashed #cdb77d;color:#806116">显示全部关系</button>' : ''}`;
    document.getElementById('kg2-show-all')?.addEventListener('click', async () => {
      state.neighbourLimit = Infinity;
      if (state.selected) drawNeighbourhood(state.selected, await relationsFor(state.selected));
      state.neighbourLimit = 120;
    });
  }

  async function load(force = false) {
    try { if (force) { state.manifest = null; state.concepts = []; state.adjacencyIndex = null; state.adjacency.clear(); } if (!state.manifest) state.manifest = await json(`${ROOT}/manifest.json`); if (!state.concepts.length) state.concepts = await json(`${ROOT}/concepts.json.gz`); renderResults(); await showOverview(); } catch (error) { const status = document.getElementById('kg2-status'); if (status) status.textContent = `V2 暂时不可用：${error.message} · 可切换回旧版统计图`; status?.classList.add('is-error'); document.getElementById('kg2-results')?.insertAdjacentHTML('afterbegin', '<div class="kg2-error">V2 数据加载失败，旧版 TF-IDF 数据仍保持不变。请稍后刷新。</div>'); }
  }
  async function route() { renderShell(); await load(); }
  window.renderKnowledgeGraphRoute = route;
  window.KnowledgeGraphV2 = { reload: load, route, canvas: () => graph, showOverview };
  if (location.hash.split('?')[0] === '#/knowledge-graph') route();
})();
