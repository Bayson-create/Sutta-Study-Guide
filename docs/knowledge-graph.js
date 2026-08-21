/* V4 经证共创知识图谱 — REST-backed nodes/relations with a vanilla infinite canvas. */
(() => {
  'use strict';

  const API_ROOT = typeof API_BASE !== 'undefined'
    ? API_BASE
    : 'https://sutta-api.agreeablemeadow-9da329ca.swedencentral.azurecontainerapps.io';
  const BASE = `${API_ROOT}/api/knowledge-graph/v1`;
  const RELATION_TYPES = [
    ['supports', '支持'], ['contradicts', '张力／矛盾'], ['qualifies', '限定'],
    ['depends_on', '依赖'], ['entails', '蕴含'], ['equivalent_to', '等同'], ['related_to', '相关'],
  ];
  const CONCEPT_TYPES = [['concept', '法义'], ['person', '人物'], ['text', '文本'], ['school', '修习体系'], ['place', '地点'], ['event', '事件'], ['term', '术语'], ['other', '其他']];
  const state = {
    graph: { nodes: [], edges: [] }, filters: { q: '', conceptType: '', relationType: '', verification: '', deleted: false },
    selectedNodeId: null, selectedEdgeId: null, positions: {}, zoom: 1, pan: { x: 40, y: 40 }, drag: null, requestId: 0,
    comments: new Map(), history: new Map(), relationTypes: RELATION_TYPES.slice(), loaded: false,
    sidebarOpen: false, fullscreen: false, fullscreenEventsBound: false,
  };
  const app = document.getElementById('app');
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const text = value => String(value ?? '').trim();
  const idOf = item => item?.id ?? item?.node_id ?? item?.relation_id ?? item?.concept_id ?? item?.assertion_id ?? item?.edge_id;
  const authHeaders = () => typeof communityAuthHeaders === 'function' ? communityAuthHeaders() : {};
  const requireLogin = () => typeof communityRequireLogin === 'function' ? communityRequireLogin() : Promise.resolve(!!localStorage.getItem('sutta_token'));
  const formatDate = value => value ? new Date(value).toLocaleString('zh-CN') : '—';

  class KGConflictError extends Error { constructor(message, payload) { super(message); this.name = 'KGConflictError'; this.status = 409; this.payload = payload; } }
  async function request(path = '', options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json', ...authHeaders(), ...(options.headers || {}) };
    let response;
    const url = `${BASE}${path}`;
    if (method !== 'GET' && typeof communityWriteFetch === 'function') response = await communityWriteFetch(url, { ...options, headers });
    else if (typeof communityFetchWithTimeout === 'function') response = await communityFetchWithTimeout(url, { ...options, headers });
    else response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => null);
    if (response.status === 409) throw new KGConflictError(payload?.detail || '这项内容已被其他人修改。', payload);
    if (!response.ok) { const error = new Error(payload?.detail || `知识图谱接口错误（${response.status}）`); error.status = response.status; error.payload = payload; throw error; }
    return payload;
  }
  const write = (path, method, body) => request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function evidenceDeepLink(evidence) {
    if (!evidence?.work_id || evidence.row_id == null) return '';
    const params = new URLSearchParams({ row: String(evidence.row_id) });
    if (evidence.quote) { params.set('hl', evidence.quote); params.set('hl_lang', evidence.language || 'zh'); params.set('hl_anchor', evidence.anchor || String(evidence.quote).slice(0, 64)); }
    return `#/tipitaka/read/${encodeURIComponent(evidence.work_id)}?${params}`;
  }
  function backendEvidenceList(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.evidence) ? raw.evidence : raw ? [raw] : [];
    return list.filter(item => item?.work_id && item.row_id != null).map(item => ({ work_id: item.work_id, row_id: Number(item.row_id), language: item.language || 'zh', quote: item.quote || item.text || item.raw_text || '' }));
  }
  function normalizeEvidence(raw) {
    const list = backendEvidenceList(raw?.evidence_payload || raw?.evidence || raw);
    const evidence = list[0] || raw?.evidence_payload || raw?.evidence || raw || {};
    return {
      version: 'v4-evidence/v1', work_id: evidence.work_id || evidence.workId || null, row_id: evidence.row_id == null ? null : Number(evidence.row_id),
      language: evidence.language || 'zh', anchor: evidence.anchor || evidence.hl_anchor || String(evidence.quote || '').slice(0, 64), deep_link: evidence.deep_link || evidence.reader_url || evidence._href || evidenceDeepLink(evidence),
      text: evidence.quote || evidence.text || evidence.raw_text || '', raw_text: evidence.raw_text || evidence.quote || '', quote: evidence.quote || evidence.text || '', title: evidence.heading || evidence.source || '',
      pali: evidence.pali || evidence.text_pali || '', chinese: evidence.chinese || evidence.text_zh || evidence.chinese_simplified || '', english: evidence.english || evidence.text_en || '',
      query: evidence.query || '', paranum: evidence.paranum || null, matched_terms: Array.isArray(evidence.matched_terms) ? evidence.matched_terms : [], verified: Boolean(evidence.work_id && evidence.row_id != null) && evidence.verified !== false, list,
    };
  }
  function relationEntries() { return state.relationTypes.length ? state.relationTypes : RELATION_TYPES; }
  function relationLabel(type) { return relationEntries().find(item => item[0] === type)?.[1] || type || '关系'; }
  function normalizeRelationTypes(payload) {
    const values = Array.isArray(payload) ? payload : payload?.relation_types || payload?.items || [];
    const entries = values.filter(item => Array.isArray(item) || !item.is_hidden).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(item => Array.isArray(item) ? item : [item.code || item.value || item.key || item.type || item.id, item.label_zh || item.label || item.name || item.title || item.code || item.value || item.key]).filter(item => item[0]);
    if (entries.length) state.relationTypes = entries;
  }
  function normalizeNode(item) {
    return { ...item, id: String(idOf(item)), title: item.label || item.title || item.name || '未命名概念', type: item.node_type || item.type || item.concept_type || 'other', description: item.description || item.description_markdown || '', description_markdown: item.description || item.description_markdown || '', deleted: Boolean(item.deleted || item.deleted_at), revision: item.revision ?? item.version ?? 0, version: item.revision ?? item.version ?? 0 };
  }
  function normalizeRelation(item) {
    return { ...item, id: String(idOf(item)), source_id: String(item.source_node_id ?? item.source_id ?? item.source ?? item.from_id ?? item.from), target_id: String(item.target_node_id ?? item.target_id ?? item.target ?? item.to_id ?? item.to), relation_type: item.relation_type || item.type || item.relation || 'related_to', explanation_markdown: item.description ?? item.explanation_markdown ?? item.explanation ?? '', description: item.description ?? item.explanation_markdown ?? item.explanation ?? '', evidence: normalizeEvidence(item.evidence), evidence_list: backendEvidenceList(item.evidence), deleted: Boolean(item.deleted || item.deleted_at), revision: item.revision ?? item.version ?? 0, version: item.revision ?? item.version ?? 0 };
  }
  function normalizeGraph(payload) {
    const source = payload?.graph || payload?.data || payload || {};
    const nodes = source.nodes || source.concepts || source.items || [];
    const edges = source.relations || source.edges || source.assertions || source.relationships || [];
    state.graph = {
      nodes: nodes.map(normalizeNode), edges: edges.map(normalizeRelation),
    };
    if (Array.isArray(source.comments)) for (const comment of source.comments) state.comments.set(String(idOf(comment)), comment);
    for (const edge of state.graph.edges) if (Array.isArray(edge.comments)) state.comments.set(String(edge.id), edge.comments);
    state.loaded = true;
  }
  function graphNodes() { return state.graph.nodes; }
  function nodeById(id) { return graphNodes().find(node => String(node.id) === String(id)); }
  function edgeById(id) { return state.graph.edges.find(edge => String(edge.id) === String(id)); }
  function visibleNodes() {
    const q = state.filters.q.toLowerCase();
    return graphNodes().filter(node => {
      if (!state.filters.deleted && node.deleted) return false;
      if (state.filters.conceptType && node.type !== state.filters.conceptType) return false;
      if (q && ![node.title, node.name, node.description_markdown, node.description, node.pali, node.slug].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
  }
  function visibleEdges() {
    const ids = new Set(visibleNodes().map(node => String(node.id)));
    return state.graph.edges.filter(edge => ids.has(String(edge.source_id)) && ids.has(String(edge.target_id)) && (state.filters.deleted || !edge.deleted) && (!state.filters.relationType || edge.relation_type === state.filters.relationType) && (!state.filters.verification || (state.filters.verification === 'verified' ? edge.evidence?.verified : !edge.evidence?.verified)));
  }
  function positionFor(node, index = 0) {
    if (!state.positions[node.id]) {
      const cols = 4, col = index % cols, row = Math.floor(index / cols);
      state.positions[node.id] = { x: 70 + col * 280, y: 70 + row * 180 };
    }
    return state.positions[node.id];
  }
  function loadPositions() { try { state.positions = JSON.parse(localStorage.getItem('knowledge-graph-positions') || '{}') || {}; } catch { state.positions = {}; } }
  function savePositions() { try { localStorage.setItem('knowledge-graph-positions', JSON.stringify(state.positions)); } catch {} }
  function setStatus(message, kind = '') { const el = document.getElementById('kg-status'); if (el) { el.textContent = message || ''; el.className = `kg-status ${kind}`; } }

  function markdownHtml(markdown) {
    try { if (typeof communityMarkdownToHtml === 'function') return communityMarkdownToHtml(markdown); } catch {}
    let value = esc(markdown || '');
    value = value.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>').replace(/^##\s+(.+)$/gm, '<h3>$1</h3>').replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');
    value = value.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');
    return value ? `<p>${value}</p>` : '';
  }
  function editorHtml(prefix, value = '', placeholder = '支持 Markdown：**加粗**、> 引用、- 列表…') {
    return `<div class="kg-markdown-editor"><textarea id="${prefix}" placeholder="${esc(placeholder)}">${esc(value)}</textarea><div class="kg-markdown-preview" id="${prefix}-preview"></div></div>`;
  }
  function bindEditor(prefix) {
    const input = document.getElementById(prefix), preview = document.getElementById(`${prefix}-preview`); if (!input || !preview) return;
    const update = () => { preview.innerHTML = input.value.trim() ? markdownHtml(input.value) : ''; };
    input.addEventListener('input', update); update();
  }
  function dialog(inner, className = '') {
    const element = document.createElement('dialog'); element.className = `kg-dialog ${className}`; element.innerHTML = `<div class="kg-dialog-inner">${inner}</div>`; document.body.appendChild(element); element.showModal(); element.addEventListener('close', () => element.remove(), { once: true }); return element;
  }
  function closeDialog(element) { if (element?.open) element.close(); else element?.remove(); }

  function renderFilters() {
    const concepts = CONCEPT_TYPES.map(([value, label]) => `<option value="${value}" ${state.filters.conceptType === value ? 'selected' : ''}>${label}</option>`).join('');
    const relations = relationEntries().map(([value, label]) => `<option value="${esc(value)}" ${state.filters.relationType === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
    return `<div class="kg-toolbar"><input id="kg-filter-q" value="${esc(state.filters.q)}" placeholder="搜索概念、描述或术语…"><select id="kg-filter-concept"><option value="">全部概念类型</option>${concepts}</select><select id="kg-filter-relation"><option value="">全部关系类型</option>${relations}</select><select id="kg-filter-verification"><option value="">证据状态</option><option value="verified" ${state.filters.verification === 'verified' ? 'selected' : ''}>已验证 V4</option><option value="unverified" ${state.filters.verification === 'unverified' ? 'selected' : ''}>待核验</option></select><label class="kg-check"><input id="kg-filter-deleted" type="checkbox" ${state.filters.deleted ? 'checked' : ''}> 显示软删除</label><span class="kg-status" id="kg-status"></span></div>`;
  }
  function refreshRelationFilter() {
    const select = document.getElementById('kg-filter-relation'); if (!select) return;
    const current = state.filters.relationType;
    select.innerHTML = `<option value="">全部关系类型</option>${relationEntries().map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}`;
    select.value = relationEntries().some(([value]) => value === current) ? current : '';
    state.filters.relationType = select.value;
  }
  function renderShell() {
    app.innerHTML = `<div class="kg-shell"><div class="kg-header"><div><h2>🕸 V4 经证共创知识图谱</h2><p>概念是节点，带有逐行 V4 证据的论断才是关系；讨论附着在论断上，不改变图结构。</p></div><div class="kg-header-actions"><button class="kg-button" id="kg-sidebar-toggle" aria-expanded="${state.sidebarOpen ? 'true' : 'false'}">${state.sidebarOpen ? '隐藏说明' : '显示说明'}</button><button class="kg-button" id="kg-fullscreen" aria-pressed="${state.fullscreen ? 'true' : 'false'}">${state.fullscreen ? '⤡ 退出全屏' : '⤢ 全屏编辑'}</button><button class="kg-button" id="kg-refresh">刷新</button><button class="kg-button" id="kg-new-edge">＋ 新建关系</button><button class="kg-button primary" id="kg-new-node">＋ 新建概念</button></div></div>${renderFilters()}<div class="kg-main ${state.sidebarOpen ? '' : 'sidebar-hidden'}"><section class="kg-canvas-shell"><div class="kg-canvas-viewport" id="kg-viewport"><div class="kg-world" id="kg-world"><svg class="kg-edge-layer" id="kg-edge-layer" viewBox="0 0 5000 4000" aria-label="概念关系"></svg><div class="kg-node-layer" id="kg-node-layer"></div></div></div><div class="kg-canvas-help">拖动画布 · 拖动节点 · 滚轮缩放 · 点击节点或关系查看详情</div><div class="kg-canvas-zoom"><button id="kg-zoom-out" aria-label="缩小">−</button><button id="kg-zoom-reset" aria-label="重置缩放">1×</button><button id="kg-zoom-in" aria-label="放大">＋</button></div></section><aside class="kg-sidebar" id="kg-sidebar"><div class="kg-loading">正在读取公开图谱…</div></aside></div></div>`;
    bindFilters(); bindCanvas();
    document.getElementById('kg-sidebar-toggle').onclick = () => setSidebarOpen(!state.sidebarOpen);
    document.getElementById('kg-fullscreen').onclick = toggleFullscreen;
    document.getElementById('kg-new-node').onclick = () => openConceptEditor();
    document.getElementById('kg-new-edge').onclick = () => openAssertionEditor();
    document.getElementById('kg-refresh').onclick = () => loadGraph();
    document.getElementById('kg-zoom-in').onclick = () => setZoom(state.zoom + .12);
    document.getElementById('kg-zoom-out').onclick = () => setZoom(state.zoom - .12);
    document.getElementById('kg-zoom-reset').onclick = () => { state.zoom = 1; state.pan = { x: 40, y: 40 }; updateWorldTransform(); };
    bindFullscreenEvents(); syncFullscreenUi();
  }
  function setSidebarOpen(open) {
    state.sidebarOpen = Boolean(open);
    const main = document.querySelector('.kg-main'), button = document.getElementById('kg-sidebar-toggle');
    main?.classList.toggle('sidebar-hidden', !state.sidebarOpen);
    if (button) { button.textContent = state.sidebarOpen ? '隐藏说明' : '显示说明'; button.setAttribute('aria-expanded', String(state.sidebarOpen)); }
  }
  function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function syncFullscreenUi() {
    const shell = document.querySelector('.kg-shell'), button = document.getElementById('kg-fullscreen');
    const active = Boolean(shell && (fullscreenElement() === shell || shell.classList.contains('is-fullscreen')));
    state.fullscreen = active; shell?.classList.toggle('is-fullscreen', active);
    if (button) { button.textContent = active ? '⤡ 退出全屏' : '⤢ 全屏编辑'; button.setAttribute('aria-pressed', String(active)); }
  }
  function bindFullscreenEvents() {
    if (state.fullscreenEventsBound) return;
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(eventName => document.addEventListener(eventName, syncFullscreenUi));
    state.fullscreenEventsBound = true;
  }
  async function toggleFullscreen() {
    const shell = document.querySelector('.kg-shell'); if (!shell) return;
    const active = fullscreenElement() === shell || shell.classList.contains('is-fullscreen');
    try {
      if (active) {
        const currentFullscreenElement = fullscreenElement();
        if (currentFullscreenElement && document.exitFullscreen) await document.exitFullscreen();
        else if (currentFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
        shell.classList.remove('is-fullscreen');
      } else if (shell.requestFullscreen) await shell.requestFullscreen();
      else if (shell.webkitRequestFullscreen) shell.webkitRequestFullscreen();
      else shell.classList.add('is-fullscreen');
    } catch {
      shell.classList.toggle('is-fullscreen', !active);
    }
    syncFullscreenUi();
  }
  function bindFilters() {
    const listen = (id, key, event = 'change') => document.getElementById(id)?.addEventListener(event, e => { state.filters[key] = event === 'input' ? e.target.value : e.target.value; renderGraph(); });
    listen('kg-filter-q', 'q', 'input'); listen('kg-filter-concept', 'conceptType'); listen('kg-filter-relation', 'relationType'); listen('kg-filter-verification', 'verification');
    document.getElementById('kg-filter-deleted')?.addEventListener('change', e => { state.filters.deleted = e.target.checked; renderGraph(); });
  }
  function updateWorldTransform() { const world = document.getElementById('kg-world'); if (world) world.style.transform = `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`; const reset = document.getElementById('kg-zoom-reset'); if (reset) reset.textContent = `${Math.round(state.zoom * 100)}%`; }
  function setZoom(value, center) {
    const viewport = document.getElementById('kg-viewport'); if (!viewport) return; const old = state.zoom, next = Math.max(.35, Math.min(2.4, value));
    if (center) { const rect = viewport.getBoundingClientRect(), cx = center.clientX - rect.left, cy = center.clientY - rect.top; state.pan.x = cx - (cx - state.pan.x) * next / old; state.pan.y = cy - (cy - state.pan.y) * next / old; }
    state.zoom = next; updateWorldTransform();
  }
  function bindCanvas() {
    const viewport = document.getElementById('kg-viewport'); if (!viewport) return;
    viewport.addEventListener('wheel', event => { event.preventDefault(); setZoom(state.zoom * (event.deltaY < 0 ? 1.08 : .92), event); }, { passive: false });
    viewport.addEventListener('pointerdown', event => { if (event.target.closest('.kg-node') || event.target.closest('path')) return; state.drag = { kind: 'pan', x: event.clientX, y: event.clientY, pan: { ...state.pan } }; viewport.classList.add('is-panning'); viewport.setPointerCapture(event.pointerId); });
    viewport.addEventListener('pointermove', event => { if (!state.drag) return; if (state.drag.kind === 'pan') { state.pan.x = state.drag.pan.x + event.clientX - state.drag.x; state.pan.y = state.drag.pan.y + event.clientY - state.drag.y; updateWorldTransform(); } else if (state.drag.kind === 'node') { const point = viewportPoint(event); const position = state.positions[state.drag.id]; position.x = point.x - state.drag.offsetX; position.y = point.y - state.drag.offsetY; const nodeEl = [...document.querySelectorAll('[data-kg-node]')].find(element => element.dataset.kgNode === String(state.drag.id)); if (nodeEl) { nodeEl.style.left = `${position.x}px`; nodeEl.style.top = `${position.y}px`; } renderEdges(); } });
    viewport.addEventListener('pointerup', event => { if (state.drag?.kind === 'node') savePositions(); state.drag = null; viewport.classList.remove('is-panning'); try { viewport.releasePointerCapture(event.pointerId); } catch {} });
    viewport.addEventListener('pointercancel', () => { state.drag = null; viewport.classList.remove('is-panning'); });
  }
  function viewportPoint(event) { const rect = document.getElementById('kg-viewport').getBoundingClientRect(); return { x: (event.clientX - rect.left - state.pan.x) / state.zoom, y: (event.clientY - rect.top - state.pan.y) / state.zoom }; }
  function renderGraph() {
    const nodes = visibleNodes(), edges = visibleEdges(), nodeLayer = document.getElementById('kg-node-layer'), edgeLayer = document.getElementById('kg-edge-layer'); if (!nodeLayer || !edgeLayer) return;
    nodeLayer.innerHTML = nodes.length ? nodes.map((node, index) => { const p = positionFor(node, index); return `<article class="kg-node ${node.deleted ? 'is-deleted' : ''} ${String(state.selectedNodeId) === String(node.id) ? 'is-selected' : ''}" data-kg-node="${esc(node.id)}" style="left:${p.x}px;top:${p.y}px"><div>${node.deleted ? '<span class="kg-node-badge deleted">软删除</span>' : ''}<span class="kg-node-badge">${esc(labelForConcept(node.type))}</span></div><div class="kg-node-title">${esc(node.title)}</div><div class="kg-node-meta">${esc(node.pali || node.slug || node.description || '点击查看概念与关系')}</div></article>`; }).join('') : '<div class="kg-empty">没有符合筛选条件的概念。</div>';
    nodeLayer.querySelectorAll('[data-kg-node]').forEach(nodeEl => { nodeEl.addEventListener('pointerdown', event => { event.stopPropagation(); const id = nodeEl.dataset.kgNode, point = viewportPoint(event), p = state.positions[id] || { x: 0, y: 0 }; state.drag = { kind: 'node', id, offsetX: point.x - p.x, offsetY: point.y - p.y }; nodeEl.setPointerCapture?.(event.pointerId); }); nodeEl.addEventListener('click', event => { if (state.drag) return; state.selectedNodeId = nodeEl.dataset.kgNode; state.selectedEdgeId = null; setSidebarOpen(true); renderGraph(); renderSidebar(); }); });
    renderEdges(); updateWorldTransform(); renderSidebar();
  }
  function renderEdges() {
    const edgeLayer = document.getElementById('kg-edge-layer'); if (!edgeLayer) return; const visible = visibleEdges(), pairCount = new Map(); edgeLayer.innerHTML = '';
    for (const edge of visible) { const source = nodeById(edge.source_id), target = nodeById(edge.target_id); if (!source || !target) continue; const a = positionFor(source), b = positionFor(target); const key = `${source.id}:${target.id}`; const offset = pairCount.get(key) || 0; pairCount.set(key, offset + 1); const sx = a.x + 105, sy = a.y + 48, tx = b.x + 105, ty = b.y + 48, dx = tx - sx, dy = ty - sy, length = Math.max(1, Math.hypot(dx, dy)), bend = ((offset % 2 ? -1 : 1) * (18 + Math.floor(offset / 2) * 18)); const cx = (sx + tx) / 2 - (dy / length) * bend, cy = (sy + ty) / 2 + (dx / length) * bend; const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`); path.dataset.kgEdge = edge.id; if (String(state.selectedEdgeId) === String(edge.id)) path.classList.add('is-selected'); path.addEventListener('click', event => { event.stopPropagation(); state.selectedEdgeId = edge.id; state.selectedNodeId = null; setSidebarOpen(true); renderGraph(); }); edgeLayer.appendChild(path); const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', cx); label.setAttribute('y', cy - 5); label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'kg-edge-label'); label.textContent = relationLabel(edge.relation_type); edgeLayer.appendChild(label); }
  }
  const labelForConcept = type => Object.fromEntries(CONCEPT_TYPES)[type] || type || '概念';

  const collection = payload => Array.isArray(payload) ? payload : payload?.items || payload?.nodes || payload?.relations || [];
  async function loadGraph() {
    setStatus('正在读取公开图谱…'); try { const [nodesPayload, relationsPayload, typesPayload] = await Promise.all([request('/nodes?include_deleted=true'), request('/relations?include_deleted=true'), request('/relation-types').catch(() => null)]); if (typesPayload) { normalizeRelationTypes(typesPayload); refreshRelationFilter(); } normalizeGraph({ nodes: collection(nodesPayload), relations: collection(relationsPayload) }); setStatus(`${visibleNodes().length} 个概念 · ${visibleEdges().length} 条关系`, 'success'); renderGraph(); } catch (error) { setStatus(error.message, 'error'); const sidebar = document.getElementById('kg-sidebar'); if (sidebar) sidebar.innerHTML = `<div class="kg-status error">${esc(error.message)}</div><p>图谱读取失败时仍可稍后点击“刷新”重试。</p>`; } }
  function evidenceHtml(evidence) { if (!evidence?.work_id || evidence.row_id == null) return '<div class="kg-evidence-card">缺少稳定 V4 行定位，不能作为已验证关系。</div>'; const quote = evidence.pali || evidence.chinese || evidence.english || evidence.text || '已选择 V4 行'; return `<div class="kg-evidence-card"><strong>V4 逐行证据 · ${esc(evidence.work_id)}:${esc(evidence.row_id)}</strong><blockquote class="pali">${esc(quote)}</blockquote><small>${esc(evidence.title || '')} · ${esc(evidence.language || 'zh')} · anchor ${esc(evidence.anchor || '—')}</small><br><a class="kg-detail-link" href="${esc(evidence.deep_link || '#/tipitaka/read/' + encodeURIComponent(evidence.work_id) + '?row=' + encodeURIComponent(evidence.row_id))}">在 V4 阅读器中打开并高亮 →</a></div>`; }
  function selectedNodeHtml(node) {
    const related = state.graph.edges.filter(edge => String(edge.source_id) === String(node.id) || String(edge.target_id) === String(node.id));
    return `<h3>${esc(node.title)}</h3>${node.deleted ? '<div class="kg-deleted-banner">此概念已软删除。它仍保留在历史中，可恢复。</div>' : ''}<p class="kg-node-meta"><span class="kg-pill">${esc(labelForConcept(node.type))}</span> · 版本 ${esc(node.version)}</p>${node.description_markdown || node.description ? `<div class="md-reader">${markdownHtml(node.description_markdown || node.description)}</div>` : '<p class="kg-sidebar-empty">暂无说明。</p>'}<div class="kg-detail-actions"><button class="kg-button small" data-kg-edit-node="${esc(node.id)}">编辑</button>${node.deleted ? `<button class="kg-button small" data-kg-restore-node="${esc(node.id)}">恢复</button>` : `<button class="kg-button small danger" data-kg-delete-node="${esc(node.id)}">软删除</button>`}<button class="kg-button small" data-kg-history-node="${esc(node.id)}">历史</button></div><h4>关联论断（${related.length}）</h4>${related.length ? related.map(edge => assertionCardHtml(edge)).join('') : '<p class="kg-sidebar-empty">还没有关系。</p>'}`;
  }
  function assertionCardHtml(edge) { const source = nodeById(edge.source_id), target = nodeById(edge.target_id); return `<div class="kg-assertion-card ${String(state.selectedEdgeId) === String(edge.id) ? 'is-selected' : ''}" data-kg-assertion="${esc(edge.id)}"><strong>${esc(source?.title || edge.source_id)} <span>→</span> ${esc(target?.title || edge.target_id)}</strong><small>${esc(relationLabel(edge.relation_type))} · ${edge.evidence?.verified ? '已验证 V4' : '待核验'} · ${esc(edge.evidence?.work_id || '无证据')}</small></div>`; }
  function selectedEdgeHtml(edge) { const source = nodeById(edge.source_id), target = nodeById(edge.target_id); return `<h3>论断详情</h3>${edge.deleted ? '<div class="kg-deleted-banner">此关系已软删除。它仍保留在历史中，可恢复。</div>' : ''}<p><strong>${esc(source?.title || edge.source_id)}</strong> <span>→</span> <strong>${esc(target?.title || edge.target_id)}</strong></p><p><span class="kg-pill">${esc(relationLabel(edge.relation_type))}</span> · 修订 ${esc(edge.revision)}</p>${edge.explanation_markdown ? `<div class="md-reader">${markdownHtml(edge.explanation_markdown)}</div>` : '<p class="kg-sidebar-empty">暂无解释。</p>'}${evidenceHtml(edge.evidence)}<div class="kg-detail-actions"><button class="kg-button small" data-kg-edit-edge="${esc(edge.id)}" ${edge.deleted ? 'disabled' : ''}>编辑论断</button>${edge.deleted ? `<button class="kg-button small" data-kg-restore-edge="${esc(edge.id)}">恢复</button>` : `<button class="kg-button small danger" data-kg-delete-edge="${esc(edge.id)}">软删除</button>`}<button class="kg-button small" data-kg-history-edge="${esc(edge.id)}">历史</button></div><h4>讨论</h4><div id="kg-comments">正在加载讨论…</div>${commentEditorHtml(edge.id)}`; }
  function commentEditorHtml(edgeId) { return `<div class="kg-comment-editor"><textarea id="kg-comment-input" data-kg-comment-for="${esc(edgeId)}" placeholder="以 Markdown 讨论这条论断；评论不是新的图边。"></textarea><div class="kg-markdown-preview" id="kg-comment-preview"></div><div class="kg-comment-actions"><button class="kg-button small" data-kg-comment-preview-toggle="${esc(edgeId)}">预览</button><button class="kg-button small primary" data-kg-comment-submit="${esc(edgeId)}">发表评论</button></div></div>`; }
  function selectedHtml() { if (state.selectedNodeId) { const node = nodeById(state.selectedNodeId); if (node) return selectedNodeHtml(node); } if (state.selectedEdgeId) { const edge = edgeById(state.selectedEdgeId); if (edge) return selectedEdgeHtml(edge); } return '<h3>图谱说明</h3><p class="kg-sidebar-empty">点击一个概念或关系查看详情。关系必须绑定稳定的 V4 work_id、row_id、language、anchor 和阅读器深链接；讨论会显示在关系详情下。</p><p class="kg-sidebar-empty">拖动节点只改变本地画布位置，不会改写知识数据。</p>'; }
  function renderSidebar() { const sidebar = document.getElementById('kg-sidebar'); if (!sidebar) return; sidebar.innerHTML = selectedHtml(); sidebar.querySelectorAll('[data-kg-assertion]').forEach(el => el.onclick = () => { state.selectedEdgeId = el.dataset.kgAssertion; state.selectedNodeId = null; renderGraph(); }); sidebar.querySelector('[data-kg-edit-node]')?.addEventListener('click', () => openConceptEditor(nodeById(state.selectedNodeId))); sidebar.querySelector('[data-kg-delete-node]')?.addEventListener('click', () => deleteNode(state.selectedNodeId)); sidebar.querySelector('[data-kg-restore-node]')?.addEventListener('click', () => restoreNode(state.selectedNodeId)); sidebar.querySelector('[data-kg-history-node]')?.addEventListener('click', () => showResourceHistory('node', state.selectedNodeId)); sidebar.querySelector('[data-kg-edit-edge]')?.addEventListener('click', () => openAssertionEditor(edgeById(state.selectedEdgeId))); sidebar.querySelector('[data-kg-delete-edge]')?.addEventListener('click', () => deleteRelation(state.selectedEdgeId)); sidebar.querySelector('[data-kg-restore-edge]')?.addEventListener('click', () => restoreRelation(state.selectedEdgeId)); sidebar.querySelector('[data-kg-history-edge]')?.addEventListener('click', () => showResourceHistory('relation', state.selectedEdgeId)); sidebar.querySelector('[data-kg-comment-submit]')?.addEventListener('click', () => submitComment(state.selectedEdgeId)); sidebar.querySelector('[data-kg-comment-preview-toggle]')?.addEventListener('click', () => { const input = document.getElementById('kg-comment-input'), preview = document.getElementById('kg-comment-preview'); if (input && preview) preview.innerHTML = markdownHtml(input.value); }); sidebar.querySelectorAll('[data-kg-reply]').forEach(button => button.addEventListener('click', () => openReplyEditor(button.dataset.kgReply))); sidebar.querySelectorAll('[data-kg-edit-comment]').forEach(button => button.addEventListener('click', () => editComment(button.dataset.kgEditComment))); sidebar.querySelectorAll('[data-kg-delete-comment]').forEach(button => button.addEventListener('click', () => deleteComment(button.dataset.kgDeleteComment))); sidebar.querySelectorAll('[data-kg-restore-comment]').forEach(button => button.addEventListener('click', () => restoreComment(button.dataset.kgRestoreComment))); sidebar.querySelectorAll('[data-kg-history-comment]').forEach(button => button.addEventListener('click', () => showCommentHistory(button.dataset.kgHistoryComment))); if (state.selectedEdgeId) loadComments(state.selectedEdgeId); }
  async function loadComments(edgeId) { const target = document.getElementById('kg-comments'); if (!target) return; if (!state.comments.has(String(edgeId))) { try { const data = await request(`/relations/${encodeURIComponent(edgeId)}/comments`); const rows = Array.isArray(data) ? data : data?.items || data?.comments || []; const roots = rows.filter(comment => !comment.parent_id).map(comment => ({ ...comment, replies: rows.filter(reply => String(reply.parent_id) === String(comment.id)) })); state.comments.set(String(edgeId), roots); } catch (error) { target.innerHTML = `<p class="kg-status error">${esc(error.message)}</p>`; return; } } const comments = state.comments.get(String(edgeId)) || []; target.innerHTML = comments.length ? comments.map(comment => `<div class="kg-comment ${comment.deleted ? 'is-deleted' : ''}"><div class="kg-comment-meta">${comment.deleted ? '<span class="kg-pill deleted">已删除</span> ' : ''}${esc(comment.author?.display_name || comment.author?.name || '协作者')} · ${esc(formatDate(comment.created_at))}</div><div class="kg-comment-body md-reader">${comment.deleted ? '<em>此评论已删除，但仍保留在讨论历史中。</em>' : markdownHtml(comment.body_markdown || comment.body || '')}</div>${Array.isArray(comment.replies) && comment.replies.length ? `<div class="kg-replies">${comment.replies.map(reply => `<div class="kg-comment ${reply.deleted ? 'is-deleted' : ''}"><div class="kg-comment-meta">${reply.deleted ? '<span class="kg-pill deleted">已删除</span> ' : ''}${esc(reply.author?.display_name || '协作者')} · ${esc(formatDate(reply.created_at))}</div><div class="kg-comment-body md-reader">${reply.deleted ? '<em>此回复已删除。</em>' : markdownHtml(reply.body_markdown || reply.body || '')}</div></div>`).join('')}</div>` : ''}<div class="kg-comment-actions"><button class="kg-button small" data-kg-reply="${esc(comment.id)}">回复</button>${comment.deleted ? `<button class="kg-button small" data-kg-restore-comment="${esc(comment.id)}">恢复</button>` : `<button class="kg-button small" data-kg-edit-comment="${esc(comment.id)}">编辑</button><button class="kg-button small danger" data-kg-delete-comment="${esc(comment.id)}">删除</button>`}<button class="kg-button small" data-kg-history-comment="${esc(comment.id)}">历史</button></div></div>`).join('') : '<p class="kg-sidebar-empty">还没有讨论。成为第一个留下核验说明的人。</p>'; target.querySelectorAll('[data-kg-reply]').forEach(button => button.onclick = () => openReplyEditor(button.dataset.kgReply)); target.querySelectorAll('[data-kg-edit-comment]').forEach(button => button.onclick = () => editComment(button.dataset.kgEditComment)); target.querySelectorAll('[data-kg-delete-comment]').forEach(button => button.onclick = () => deleteComment(button.dataset.kgDeleteComment)); target.querySelectorAll('[data-kg-restore-comment]').forEach(button => button.onclick = () => restoreComment(button.dataset.kgRestoreComment)); target.querySelectorAll('[data-kg-history-comment]').forEach(button => button.onclick = () => showCommentHistory(button.dataset.kgHistoryComment)); }
  function openReplyEditor(commentId) { const modal = dialog(`<button class="kg-dialog-close" aria-label="关闭">×</button><h3>回复讨论</h3>${editorHtml('kg-reply-input')}<div class="kg-form-actions"><button class="kg-button" data-kg-cancel>取消</button><button class="kg-button primary" data-kg-save>发布回复</button></div>`); bindEditor('kg-reply-input'); modal.querySelector('.kg-dialog-close').onclick = () => closeDialog(modal); modal.querySelector('[data-kg-cancel]').onclick = () => closeDialog(modal); modal.querySelector('[data-kg-save]').onclick = async () => { const body = text(document.getElementById('kg-reply-input')?.value); if (!body) return alert('请输入回复内容'); if (!(await requireLogin())) return; try { await write(`/relations/${encodeURIComponent(state.selectedEdgeId)}/comments`, 'POST', { body_markdown: body, body, parent_id: commentId }); closeDialog(modal); state.comments.delete(String(state.selectedEdgeId)); renderGraph(); } catch (error) { handleWriteError(error); } }; }
  async function submitComment(edgeId) { const input = document.getElementById('kg-comment-input'), body = text(input?.value); if (!body) return alert('请输入讨论内容'); if (!(await requireLogin())) return; try { await write(`/relations/${encodeURIComponent(edgeId)}/comments`, 'POST', { body_markdown: body, body, parent_id: null }); state.comments.delete(String(edgeId)); renderGraph(); setStatus('讨论已发布', 'success'); } catch (error) { handleWriteError(error); } }
  async function showResourceHistory(kind, id) { const resource = kind === 'node' ? 'nodes' : 'relations'; try { const data = await request(`/${resource}/${encodeURIComponent(id)}/history`); const rows = Array.isArray(data) ? data : data?.items || data?.history || []; const modal = dialog(`<button class="kg-dialog-close" aria-label="关闭">×</button><h3>${kind === 'node' ? '概念历史' : '关系历史'}</h3><div class="kg-history">${rows.length ? rows.map(item => `<div class="kg-history-item"><strong>${esc(item.action || item.event || '修订')}</strong><small>${esc(formatDate(item.created_at))} · ${esc(item.author?.display_name || '协作者')} · 修订 ${esc(item.revision ?? item.version ?? '—')}</small><div>${esc(item.label || item.description || item.summary || item.reason || '')}</div>${item.revision != null ? `<button class="kg-button small" data-kg-restore-resource="${esc(item.revision)}">恢复此修订</button>` : ''}</div>`).join('') : '<p class="kg-sidebar-empty">暂无历史记录。</p>'}</div>`); modal.querySelector('.kg-dialog-close').onclick = () => closeDialog(modal); modal.querySelectorAll('[data-kg-restore-resource]').forEach(button => button.onclick = async () => { if (!(await requireLogin())) return; try { await write(`/${resource}/${encodeURIComponent(id)}/restore`, 'POST', { revision: Number(button.dataset.kgRestoreResource) }); closeDialog(modal); await loadGraph(); } catch (error) { handleWriteError(error); } }); } catch (error) { alert(error.message); } }
  async function deleteNode(id) { const node = nodeById(id); if (!node || !confirm(`确定软删除“${node.title}”吗？它会保留在历史中，并可恢复。`)) return; if (!(await requireLogin())) return; try { const result = await write(`/nodes/${encodeURIComponent(id)}?revision=${encodeURIComponent(node.revision)}`, 'DELETE', {}); const saved = result?.node || result; if (saved && idOf(saved)) Object.assign(node, normalizeNode(saved), { id: node.id }); Object.assign(node, { deleted: true, deleted_at: new Date().toISOString() }); renderGraph(); setStatus('概念已软删除；可在详情中恢复或查看修订。', 'success'); } catch (error) { handleWriteError(error); } }
  async function restoreNode(id) { const node = nodeById(id); if (!node || !(await requireLogin())) return; try { const result = await write(`/nodes/${encodeURIComponent(id)}/restore`, 'POST', { revision: node.revision }); const saved = result?.node || result; if (saved && idOf(saved)) Object.assign(node, normalizeNode(saved), { id: node.id }); Object.assign(node, { deleted: false, deleted_at: null }); renderGraph(); setStatus('概念已恢复。', 'success'); } catch (error) { handleWriteError(error); } }
  async function deleteRelation(id) { const edge = edgeById(id); if (!edge || !confirm('确定软删除这条关系论断吗？它会保留在历史中，并可恢复。')) return; if (!(await requireLogin())) return; try { const result = await write(`/relations/${encodeURIComponent(id)}?revision=${encodeURIComponent(edge.revision)}`, 'DELETE', {}); const saved = result?.relation || result; if (saved && idOf(saved)) Object.assign(edge, normalizeRelation(saved), { id: edge.id }); Object.assign(edge, { deleted: true, deleted_at: new Date().toISOString() }); renderGraph(); setStatus('关系论断已软删除；可在详情中恢复或查看历史。', 'success'); } catch (error) { handleWriteError(error); } }
  async function restoreRelation(id) { const edge = edgeById(id); if (!edge || !(await requireLogin())) return; try { const result = await write(`/relations/${encodeURIComponent(id)}/restore`, 'POST', { revision: edge.revision }); const saved = result?.relation || result; if (saved && idOf(saved)) Object.assign(edge, normalizeRelation(saved), { id: edge.id }); Object.assign(edge, { deleted: false, deleted_at: null }); renderGraph(); setStatus('关系论断已恢复。', 'success'); } catch (error) { handleWriteError(error); } }
  async function editComment(commentId) { const comments = state.comments.get(String(state.selectedEdgeId)) || [], comment = comments.find(item => String(item.id) === String(commentId)); if (!comment) return; const current = comment.body_markdown || comment.body || ''; const modal = dialog(`<button class="kg-dialog-close" aria-label="关闭">×</button><h3>编辑讨论</h3>${editorHtml('kg-edit-comment-input', current)}<div class="kg-form-actions"><button class="kg-button" data-kg-cancel>取消</button><button class="kg-button primary" data-kg-save>保存</button></div>`); bindEditor('kg-edit-comment-input'); modal.querySelector('.kg-dialog-close').onclick = () => closeDialog(modal); modal.querySelector('[data-kg-cancel]').onclick = () => closeDialog(modal); modal.querySelector('[data-kg-save]').onclick = async () => { const body = text(document.getElementById('kg-edit-comment-input')?.value); if (!body || !(await requireLogin())) return; try { await write(`/comments/${encodeURIComponent(commentId)}`, 'PATCH', { body_markdown: body, body, revision: comment.revision }); closeDialog(modal); state.comments.delete(String(state.selectedEdgeId)); renderGraph(); } catch (error) { handleWriteError(error); } }; }
  function commentById(commentId) { const comments = state.comments.get(String(state.selectedEdgeId)) || []; return comments.find(comment => String(comment.id) === String(commentId)) || comments.flatMap(comment => comment.replies || []).find(comment => String(comment.id) === String(commentId)); }
  async function deleteComment(commentId) { const comment = commentById(commentId); if (!comment || comment.revision == null) return alert('缺少当前讨论修订号，请刷新后重试。'); if (!confirm('确定删除这条讨论吗？它会保留在历史中。')) return; if (!(await requireLogin())) return; try { await write(`/comments/${encodeURIComponent(commentId)}?revision=${encodeURIComponent(comment.revision)}`, 'DELETE', {}); state.comments.delete(String(state.selectedEdgeId)); renderGraph(); } catch (error) { handleWriteError(error); } }
  async function restoreComment(commentId) { const comment = commentById(commentId); if (!comment || comment.revision == null) return alert('缺少当前讨论修订号，请刷新后重试。'); if (!(await requireLogin())) return; try { await write(`/comments/${encodeURIComponent(commentId)}/restore`, 'POST', { revision: comment.revision }); state.comments.delete(String(state.selectedEdgeId)); renderGraph(); } catch (error) { handleWriteError(error); } }
  async function showCommentHistory(commentId) { try { const data = await request(`/comments/${encodeURIComponent(commentId)}/history`); const rows = Array.isArray(data) ? data : data?.items || data?.history || []; const modal = dialog(`<button class="kg-dialog-close" aria-label="关闭">×</button><h3>讨论历史</h3><div class="kg-history">${rows.length ? rows.map(item => `<div class="kg-history-item"><strong>${esc(item.action || item.event || '修订')}</strong><small>${esc(formatDate(item.created_at))} · ${esc(item.author?.display_name || '协作者')} · 修订 ${esc(item.revision ?? item.version ?? '—')}</small><div>${esc(item.body_markdown || item.body || item.summary || '')}</div></div>`).join('') : '<p class="kg-sidebar-empty">暂无历史记录。</p>'}</div>`); modal.querySelector('.kg-dialog-close').onclick = () => closeDialog(modal); } catch (error) { alert(error.message); } }
  function handleWriteError(error) { if (error instanceof KGConflictError) { loadGraph(); alert('服务器上已有更新。已刷新图谱；请检查你的编辑草稿后重新提交。'); } else alert(error.message || '保存失败'); }

  function openConceptEditor(node = null) { const isEdit = Boolean(node); const modal = dialog(`<button class="kg-dialog-close" aria-label="关闭">×</button><h3>${isEdit ? '编辑概念' : '新建概念'}</h3><form class="kg-form"><label>名称<input id="kg-concept-title" required value="${esc(node?.title || '')}"></label><label>类型<select id="kg-concept-type">${CONCEPT_TYPES.map(([value, label]) => `<option value="${value}" ${node?.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>说明（Markdown）${editorHtml('kg-concept-description', node?.description || node?.description_markdown || '')}</label><div class="kg-form-actions"><button type="button" class="kg-button" data-kg-cancel>取消</button><button type="submit" class="kg-button primary">${isEdit ? '保存修改' : '创建概念'}</button></div></form>`); bindEditor('kg-concept-description'); modal.querySelector('.kg-dialog-close').onclick = () => closeDialog(modal); modal.querySelector('[data-kg-cancel]').onclick = () => closeDialog(modal); modal.querySelector('form').onsubmit = async event => { event.preventDefault(); const label = text(document.getElementById('kg-concept-title')?.value), node_type = document.getElementById('kg-concept-type')?.value, description = document.getElementById('kg-concept-description')?.value || ''; if (!label) return; if (!(await requireLogin())) return; const body = { label, node_type, description, revision: node?.revision }; try { const result = await write(isEdit ? `/nodes/${encodeURIComponent(node.id)}` : '/nodes', isEdit ? 'PATCH' : 'POST', body); const saved = normalizeNode(result?.node || result); if (isEdit) Object.assign(node, saved, { id: node.id }); else state.graph.nodes.push(saved); closeDialog(modal); renderGraph(); setStatus(isEdit ? '概念已更新。' : '概念已创建。', 'success'); } catch (error) { handleWriteError(error); } }; }
  function openAssertionEditor(edge = null) { const isEdit = Boolean(edge); const modal = dialog(`<button class="kg-dialog-close" aria-label="关闭">×</button><h3>${isEdit ? '编辑关系论断' : '新建关系论断'}</h3><form class="kg-form"><label>来源概念<select id="kg-edge-source" required>${graphNodes().filter(node => !node.deleted).map(node => `<option value="${esc(node.id)}" ${String(edge?.source_id) === String(node.id) ? 'selected' : ''}>${esc(node.title)}</option>`).join('')}</select></label><label>目标概念<select id="kg-edge-target" required>${graphNodes().filter(node => !node.deleted).map(node => `<option value="${esc(node.id)}" ${String(edge?.target_id) === String(node.id) ? 'selected' : ''}>${esc(node.title)}</option>`).join('')}</select></label><label>关系类型<select id="kg-edge-relation" required>${relationEntries().map(([value, label]) => `<option value="${esc(value)}" ${edge?.relation_type === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label><label>已验证 V4 证据<span class="kg-evidence-picker-row"><small id="kg-edge-evidence-summary">${edge?.evidence?.work_id ? `${esc(edge.evidence.work_id)}:${esc(edge.evidence.row_id)} · ${esc(edge.evidence.language || 'zh')}` : '必须从 V4 语料检索并选择一行'}</small><button type="button" class="kg-button small" id="kg-pick-evidence">选择证据</button></span></label><label>解释（可选，Markdown）${editorHtml('kg-edge-explanation', edge?.explanation_markdown || '')}</label><div class="kg-form-actions"><button type="button" class="kg-button" data-kg-cancel>取消</button><button type="submit" class="kg-button primary">${isEdit ? '保存论断' : '创建论断'}</button></div></form>`); bindEditor('kg-edge-explanation'); let picked = edge?.evidence?.work_id ? normalizeEvidence(edge.evidence) : null; modal.querySelector('.kg-dialog-close').onclick = () => closeDialog(modal); modal.querySelector('[data-kg-cancel]').onclick = () => closeDialog(modal); modal.querySelector('#kg-pick-evidence').onclick = async () => { if (!window.TipitakaV4?.openEvidencePicker) return alert('V4 证据选择器尚未加载，请稍后再试。'); const result = await window.TipitakaV4.openEvidencePicker({ title: '为关系选择已验证 V4 证据' }); if (result) { picked = result; modal.querySelector('#kg-edge-evidence-summary').textContent = `${result.work_id}:${result.row_id} · ${result.language} · ${result.anchor ? '定位稳定' : '缺少 anchor'}`; } }; modal.querySelector('form').onsubmit = async event => { event.preventDefault(); const source_node_id = document.getElementById('kg-edge-source').value, target_node_id = document.getElementById('kg-edge-target').value, relation_type = document.getElementById('kg-edge-relation').value, description = document.getElementById('kg-edge-explanation').value || '', evidence = backendEvidenceList(picked); if (!picked?.work_id || picked.row_id == null || !picked.anchor || !picked.deep_link || picked.verified === false || !evidence.length) return alert('必须选择带有 work_id、row_id、language、anchor 和阅读器深链接的已验证 V4 证据。'); if (source_node_id === target_node_id) return alert('来源与目标不能是同一个概念。'); if (!(await requireLogin())) return; const body = { source_node_id, target_node_id, relation_type, description, evidence, revision: edge?.revision }; try { const result = await write(isEdit ? `/relations/${encodeURIComponent(edge.id)}` : '/relations', isEdit ? 'PATCH' : 'POST', body); const saved = normalizeRelation(result?.relation || result); if (isEdit) Object.assign(edge, saved, { id: edge.id }); else state.graph.edges.push(saved); closeDialog(modal); renderGraph(); setStatus(isEdit ? '关系论断已更新。' : '关系论断已创建。', 'success'); } catch (error) { handleWriteError(error); } }; }

  async function renderRoute() { loadPositions(); state.sidebarOpen = false; renderShell(); await loadGraph(); }
  window.renderKnowledgeGraphRoute = renderRoute;
  window.KnowledgeGraphV4 = { reload: loadGraph, openConceptEditor, openAssertionEditor, normalizeEvidence };
  if (location.hash.split('?')[0] === '#/knowledge-graph' && typeof route === 'function') renderRoute();
})();
