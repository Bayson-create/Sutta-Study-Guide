/* V4 经证知识图谱 v2 — lazy multilingual concept graph. */
(() => {
  'use strict';
  const legacyRoute = window.renderKnowledgeGraphRoute;
  const ROOT = `${(window.TIPITAKA_DATA_BASE || 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1').replace(/\/$/, '')}/concept-graph-v2`;
  const app = document.getElementById('app');
  const state = { manifest: null, concepts: [], adjacencyIndex: null, adjacency: new Map(), query: '', type: '', relation: '', selected: null, page: 0, showRaw: false };
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
    app.innerHTML = `<div class="kg2-shell"><header class="kg2-header"><div><div class="kg2-kicker">V4 经证知识图谱 · concept-graph-v2</div><h2>规范化后的语义概念网络</h2><p>全量概念与关系按页加载；词形先归并，再展示跨文档显著性。统计关联不表示教义因果；每条经证可回到真实 V4 逐句。</p><div class="kg2-tabs"><button class="kg2-tab" id="kg2-formal">正式共创图</button><button class="kg2-tab is-active">V2 统计发现</button></div></div><div class="kg2-actions"><button class="kg2-button" id="kg2-refresh">刷新</button><button class="kg2-button" id="kg2-fit">适配全部可视节点</button></div></header><section class="kg2-toolbar"><input id="kg2-query" placeholder="搜索中文、English、巴利语或词形…" autocomplete="off"><select id="kg2-type"><option value="">全部概念类型</option>${Object.entries({ concept: '法义', person: '人物', text: '文本', school: '修习体系', place: '地点', event: '事件', term: '术语', other: '其他' }).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><span class="kg2-status" id="kg2-status">正在读取 V2…</span></section><div class="kg2-main"><section class="kg2-results" id="kg2-results"></section><section class="kg2-visual"><canvas id="kg2-canvas" aria-label="规范概念关系图"></canvas><div class="kg2-graph-note">节点大小＝邻接度与显著性；连线粗细＝统计权重。点击节点查看经证与原始指标。</div></section><aside class="kg2-detail" id="kg2-detail"><div class="kg2-empty">搜索或选择一个规范概念。</div></aside></div></div>`;
    document.getElementById('kg2-query').addEventListener('input', e => { state.query = e.target.value.trim(); state.page = 0; renderResults(); });
    document.getElementById('kg2-type').addEventListener('change', e => { state.type = e.target.value; state.page = 0; renderResults(); });
    document.getElementById('kg2-refresh').onclick = () => load(true);
    document.getElementById('kg2-fit').onclick = () => drawGraph();
    document.getElementById('kg2-formal').onclick = () => { if (typeof legacyRoute === 'function') legacyRoute(); };
  }
  function renderResults() {
    const list = sortedConcepts(); const pageSize = 48; const start = state.page * pageSize; const shown = list.slice(start, start + pageSize);
    const result = document.getElementById('kg2-results'); if (!result) return;
    result.innerHTML = `<div class="kg2-result-head"><strong>规范概念目录</strong><span>${list.length.toLocaleString()} 个命中 · 第 ${list.length ? state.page + 1 : 0} 页</span></div>${shown.length ? shown.map(c => `<button class="kg2-concept-row ${state.selected?.concept_id === c.concept_id ? 'is-selected' : ''}" data-cid="${esc(c.concept_id)}"><span class="kg2-row-title"><b>${esc(c.label_zh || c.pali)}</b><i>${esc(c.pali)}</i></span><span class="kg2-row-meta">${esc(c.label_en || '—')} · ${esc(typeLabel(c.concept_type))} · DF ${Number(c.document_frequency || 0).toLocaleString()} · ${Number(c.relation_count || 0).toLocaleString()} 条关系 · ${esc(aiAuditLabel(c.ai_audit_status || state.manifest?.ai?.status))}</span></button>`).join('') : '<div class="kg2-empty">没有匹配概念。可尝试去掉巴利变音符、使用中文译名或查看全部概念。</div>'}<div class="kg2-pager"><button id="kg2-prev" ${state.page ? '' : 'disabled'}>上一页</button><button id="kg2-next" ${start + pageSize < list.length ? '' : 'disabled'}>下一页</button></div>`;
    shown.forEach(c => document.querySelector(`[data-cid="${CSS.escape(c.concept_id)}"]`)?.addEventListener('click', () => select(c)));
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
    state.selected = concept; renderResults(); const detail = document.getElementById('kg2-detail'); detail.innerHTML = '<div class="kg2-loading">正在读取邻接关系与经证…</div>'; const rows = await relationsFor(concept); concept.relation_count = rows.length; drawGraph(rows);
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
  function drawGraph(rows = []) {
    const canvas = document.getElementById('kg2-canvas'); if (!canvas) return; const rect = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; canvas.width = Math.max(1, rect.width * ratio); canvas.height = Math.max(1, rect.height * ratio); const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); const w = rect.width, h = rect.height; ctx.clearRect(0, 0, w, h); const center = state.selected || sortedConcepts()[0]; if (!center) return; const neighbors = rows.slice(0, 90).map(r => ({ r, id: r.source === center.concept_id ? r.target : r.source })).map((x, i) => ({ ...x, c: state.concepts.find(c => c.concept_id === x.id), x: w / 2 + Math.cos(i * Math.PI * 2 / Math.max(1, rows.length)) * Math.min(w, h) * .34, y: h / 2 + Math.sin(i * Math.PI * 2 / Math.max(1, rows.length)) * Math.min(w, h) * .34 })); ctx.strokeStyle = '#b5c4b8'; neighbors.forEach(n => { ctx.lineWidth = 1 + 5 * Number(n.r.weight_score || 0); ctx.globalAlpha = .22 + .7 * Number(n.r.weight_score || 0); ctx.beginPath(); ctx.moveTo(w / 2, h / 2); ctx.lineTo(n.x, n.y); ctx.stroke(); }); ctx.globalAlpha = 1; neighbors.forEach(n => { const radius = 7 + 22 * Math.sqrt(Math.max(.01, Number(n.r.weight_score || 0))); ctx.fillStyle = '#7e9b86'; ctx.beginPath(); ctx.arc(n.x, n.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#2f3c35'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(text(n.c?.label_zh || n.c?.pali || n.id).slice(0, 12), n.x, n.y + radius + 16); }); ctx.fillStyle = '#8b6914'; ctx.beginPath(); ctx.arc(w / 2, h / 2, 24, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'; ctx.fillText(text(center.label_zh || center.pali).slice(0, 12), w / 2, h / 2 + 4); canvas.onclick = event => { const x = event.offsetX, y = event.offsetY; const hit = neighbors.find(n => Math.hypot(n.x - x, n.y - y) < 28); if (hit?.c) select(hit.c); };
  }
  async function load(force = false) {
    try { if (force) { state.manifest = null; state.concepts = []; state.adjacencyIndex = null; state.adjacency.clear(); } if (!state.manifest) state.manifest = await json(`${ROOT}/manifest.json`); if (!state.concepts.length) state.concepts = await json(`${ROOT}/concepts.json.gz`); renderResults(); drawGraph(); } catch (error) { const status = document.getElementById('kg2-status'); if (status) status.textContent = `V2 暂时不可用：${error.message} · 可切换回旧版统计图`; status?.classList.add('is-error'); document.getElementById('kg2-results')?.insertAdjacentHTML('afterbegin', '<div class="kg2-error">V2 数据加载失败，旧版 TF-IDF 数据仍保持不变。请稍后刷新。</div>'); }
  }
  async function route() { renderShell(); await load(); }
  window.renderKnowledgeGraphRoute = route;
  window.KnowledgeGraphV2 = { reload: load, route };
  if (location.hash.split('?')[0] === '#/knowledge-graph') route();
})();
