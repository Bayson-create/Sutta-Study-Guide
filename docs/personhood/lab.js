(function (global) {
  'use strict';
  var P = global.PaliPersonhood = global.PaliPersonhood || {};
  var currentTrace = null;
  var currentFixture = (P.FIXTURES || [])[1] || null;
  var currentModel = P.MODEL_VERSIONS ? P.MODEL_VERSIONS.CANONICAL : 'pali-canonical/v1';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]; });
  }
  function modelLabel(version) { return version === P.MODEL_VERSIONS.SYNTHESIS ? '上座部整合版' : '经律核心版'; }
  function coverageFor(id) {
    var claims = global.PaliPersonhood && global.PaliPersonhood.EVIDENCE_INDEX && global.PaliPersonhood.EVIDENCE_INDEX.claims || [];
    var claim = claims.filter(function (item) { return item.id === id; })[0];
    if (!claim) return [];
    var records = [];
    (claim.queries || []).forEach(function (query) { (query.records || []).forEach(function (record) { if (records.length < 3) records.push(record); }); });
    return records;
  }
  function coverageHtml(id) {
    return coverageFor(id).map(function (record) {
      var href = record.source_url;
      if (!href && record.work_id && record.row_id != null) href = '#/tipitaka/read/' + encodeURIComponent(record.work_id) + '?row=' + encodeURIComponent(record.row_id) + '&semantic=1';
      return '<div class="pp-small">V4 候选 locator: <code>' + esc(record.locator || '') + '</code>' + (href ? ' · <a href="' + esc(href) + '" target="_blank" rel="noopener">跳转</a>' : '') + '</div>';
    }).join('');
  }
  function fixtureOptions() {
    return (P.FIXTURES || []).map(function (item) { return '<option value="' + esc(item.id) + '">' + esc(item.title) + '</option>'; }).join('');
  }
  function profileForFixture(fixture) {
    return fixture && fixture.agents && fixture.agents.length ? fixture.agents : P.defaultAgents();
  }
  function requestFor(fixture, model) {
    return { modelVersion: model, scenario: fixture, agents: profileForFixture(fixture), interventions: fixture.interventions || {}, seed: fixture.seed || fixture.id };
  }
  function evidenceCard(ids) {
    var unique = [];
    (ids || []).forEach(function (id) { if (unique.indexOf(id) < 0) unique.push(id); });
    return unique.map(function (id) {
      var item = P.getEvidence(id);
      if (!item) return '<div class="pp-evidence-item">未解析证据：' + esc(id) + '</div>';
      return '<div class="pp-evidence-item"><strong>' + esc(item.citation) + '</strong> <span class="pp-badge">' + esc(item.layer) + '</span><br><span>' + esc(item.translation) + '</span><br><a href="' + esc(item.url) + '" target="_blank" rel="noopener">打开原典/研究</a><br><span class="pp-small">' + esc(item.note) + '</span>' + coverageHtml(id) + '</div>';
    }).join('');
  }
  function renderEvent(item) {
    var classes = 'pp-event ' + (item.phase === 'interpretive' ? 'interpretive' : '') + ' ' + (item.phase === 'cessation' ? 'cessation' : '');
    var badges = '';
    if (item.phase === 'interpretive') badges += '<span class="pp-badge later">后期系统化</span>';
    if (item.branch) badges += '<span class="pp-badge branch">' + esc(item.branch) + '</span>';
    return '<div class="' + classes + '"><div class="meta">Step ' + item.step + ' · ' + esc(item.kind) + ' · ' + esc(item.phase) + badges + '</div><div class="statement">' + esc(item.statement || '') + '</div><div class="pp-small">五蕴聚合：' + esc(JSON.stringify(item.aggregates)) + '</div><button data-evidence="' + esc(item.evidence_ids.join(',')) + '">查看证据</button><div class="pp-evidence" data-evidence-panel=""></div></div>';
  }
  function renderStream(stream) {
    return '<section class="pp-lane"><div class="pp-lane-title"><strong>' + esc(stream.agent_label) + '</strong><span class="pp-badge branch">' + esc(stream.branch) + '</span></div><div class="pp-small">倾向（本情境）：' + esc(stream.tendency_used) + ' · 训练条件：' + esc(stream.training_available) + '</div>' + stream.events.map(renderEvent).join('') + (stream.caveats || []).map(function (c) { return '<div class="pp-notice">' + esc(c) + '</div>'; }).join('') + '</section>';
  }
  function renderTrace(trace, compared) {
    var app = document.getElementById('app');
    if (!app) return;
    currentTrace = trace;
    var edges = (trace.observable_edges || []).map(function (edge) { return '<div class="pp-edge"><strong>' + esc(edge.from_agent_id) + ' → ' + esc(edge.to_agent_id) + '</strong><br>' + esc(edge.value) + '<br><span class="pp-small">仅可访问：' + esc(edge.accessible_state) + '</span></div>'; }).join('');
    var compareHtml = compared ? '<div class="pp-card"><h3>双版本差异</h3><p class="pp-small">两次运行使用同一情境、配置和 seed；新增的解释性事件必须显式标记为后期系统化。</p><div class="pp-models"><div><strong>经律核心版事件数</strong><div>' + esc(compared.canonical.validation.checked_events) + '</div></div><div><strong>整合版事件数</strong><div>' + esc(compared.synthesis.validation.checked_events) + '</div></div></div></div>' : '';
    app.querySelector('[data-trace]').innerHTML = '<div class="pp-card"><div class="pp-lane-title"><h3>' + esc(modelLabel(trace.model_version)) + '</h3><span class="pp-badge">seed: ' + esc(trace.seed) + '</span><span class="pp-badge">轮次: ' + esc(trace.interaction_limits && trace.interaction_limits.rounds_completed || 1) + '</span></div><div class="pp-lanes">' + trace.streams.map(renderStream).join('') + '</div><h3 style="margin-top:18px">中央可观察交换</h3>' + (edges || '<div class="pp-small">当前没有跨代理的外化边。</div>') + '<div class="pp-notice" style="margin-top:14px">“灭”只表示当前局部爱取/反应循环的止息。系统不会模拟、评分或认证涅槃、灭尽定、圣果或真实证悟。</div><div class="pp-buttons"><button data-action="export">导出可复现案例包</button><button data-action="evidence-manifest">显示证据清单</button></div><pre class="pp-export" data-export hidden></pre></div>' + '<div class="pp-card pp-dialogue"><h3>审计讲解与追问</h3><p class="pp-small">AI 只能解释已验证 trace 和 evidence IDs；它不能读取私有心念，也不能替你认证人格、动物经验或证悟状态。</p><form data-dialogue-form><textarea data-dialogue-question placeholder="例如：为什么这里出现了‘受 → 爱’的分岔？"></textarea><div class="pp-buttons"><button class="primary" type="submit">请求讲解</button></div></form><div class="pp-dialogue-status" data-dialogue-status>尚未请求 AI；可先使用本地确定性 trace。</div><div class="pp-dialogue-answer" data-dialogue-answer hidden></div></div>' + compareHtml;
    wireTraceActions(app, trace);
  }
  function wireTraceActions(app, trace) {
    app.querySelectorAll('[data-evidence]').forEach(function (button) {
      button.addEventListener('click', function () {
        var panel = button.parentElement.querySelector('[data-evidence-panel]');
        panel.innerHTML = evidenceCard(button.getAttribute('data-evidence').split(','));
        panel.classList.toggle('open');
      });
    });
    var exportButton = app.querySelector('[data-action="export"]');
    if (exportButton) exportButton.addEventListener('click', function () {
      var out = app.querySelector('[data-export]'); out.hidden = !out.hidden;
      out.textContent = JSON.stringify({ scenario: trace.scenario, agents: trace.agents, modelVersion: trace.model_version, seed: trace.seed, trace: trace, evidence_manifest: P.evidenceManifest() }, null, 2);
    });
    var manifestButton = app.querySelector('[data-action="evidence-manifest"]');
    if (manifestButton) manifestButton.addEventListener('click', function () { alert(JSON.stringify(P.evidenceManifest().map(function (item) { return item.id + ' [' + item.layer + ']'; }), null, 2)); });
    var dialogueForm = app.querySelector('[data-dialogue-form]');
    if (dialogueForm) dialogueForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var question = (app.querySelector('[data-dialogue-question]') || {}).value || '';
      var status = app.querySelector('[data-dialogue-status]');
      var answer = app.querySelector('[data-dialogue-answer]');
      if (!question.trim()) { status.textContent = '请先输入一个围绕当前 trace 的问题。'; return; }
      var base = global.SUTTA_PERSONHOOD_API_BASE || (typeof API_BASE !== 'undefined' ? API_BASE : '');
      if (!base || !global.fetch) { status.textContent = '未配置后端；保留本地确定性 trace，暂不调用 AI。'; return; }
      status.textContent = '正在验证 trace 并请求受限讲解…';
      var headers = { 'Content-Type': 'application/json' };
      try { if (typeof communityAuthHeaders === 'function') Object.assign(headers, communityAuthHeaders()); } catch (ignore) {}
      var body = { modelVersion: trace.model_version, scenario: trace.scenario, agents: trace.agents, interventions: {}, seed: trace.seed, maxRounds: trace.interaction_limits && trace.interaction_limits.rounds_completed || 1, question: question.trim() };
      global.fetch(base.replace(/\/$/, '') + '/api/personhood/explain', { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (response) {
        return response.json().then(function (data) { return { ok: response.ok, data: data }; });
      }).then(function (result) {
        if (!result.ok || !result.data.explanation) throw new Error(result.data.detail || 'AI 服务不可用');
        answer.hidden = false;
        answer.textContent = result.data.explanation.answer || '未返回讲解。';
        status.textContent = result.data.explanation.ai && result.data.explanation.ai.degraded ? 'AI 不可用，已使用确定性讲解。' : '讲解已返回；请结合事件证据卡片审阅。';
      }).catch(function (error) {
        answer.hidden = false;
        answer.textContent = '当前后端讲解不可用。确定性模型仍有效；请先查看事件证据。\n\n原因：' + error.message;
        status.textContent = '已安全降级，没有保存案例或对话。';
      });
    });
  }
  function run(model, fixture) {
    try { return P.runEpisode(requestFor(fixture, model)); }
    catch (error) { var app = document.getElementById('app'); if (app) app.querySelector('[data-error]').textContent = error.message; return null; }
  }
  function renderLab() {
    var app = document.getElementById('app');
    if (!app) return;
    var selected = currentFixture || (P.FIXTURES || [])[0];
    if (!selected) { app.innerHTML = '<div class="error-msg">personhood fixtures unavailable</div>'; return; }
    currentFixture = selected;
    app.innerHTML = '<div class="personhood-lab"><button class="back-btn" onclick="location.hash=\'#/research\'">← 返回研究</button><div class="pp-hero"><div class="pp-kicker">Pali Personhood Process Lab</div><h2>巴利人格过程实验室</h2><p class="pp-subtitle">这是一个条件过程模型：人格不是固定测评分数，而是门、所缘、识、触、受、想、行与训练条件共同形成的可审计轨迹。确定性引擎先决定状态，语言模型只能解释已生成的 trace，不能创造状态或引文。</p><div class="pp-notice">本地预览实验室 · 不收集心理健康资料 · 不输出临床、道德或宗教资格判断</div></div><div class="pp-grid"><aside><div class="pp-card"><h3>情境与版本</h3><label>确定性情境</label><select data-fixture>' + fixtureOptions() + '</select><label>所缘值（可观察输入）</label><textarea data-value></textarea><label>最大互动轮次（1–6）</label><input type="number" min="1" max="6" value="1" data-max-rounds><div class="pp-models"><div class="pp-model active" data-model="pali-canonical/v1"><strong>经律核心版</strong><small>canonical / vinaya</small></div><div class="pp-model" data-model="theravada-synthesis/v1"><strong>上座部整合版</strong><small>含后期系统化标签</small></div></div><div class="pp-buttons"><button class="primary" data-run>运行当前版本</button><button data-compare>并列比较两个版本</button></div><div class="pp-small" data-error></div></div><div class="pp-card"><h3>分岔干预</h3><label><input type="checkbox" data-intervention="mindfulness"> 正念 / 明觉</label><label><input type="checkbox" data-intervention="restraint"> 根门守护 / 戒护</label><label><input type="checkbox" data-intervention="metta"> 善意向 / 慈心</label><label><input type="checkbox" data-intervention="pause"> 暂停反应</label><p class="pp-small">干预只改写当前情境的条件输入；不代表固定人格被测量或改变。</p></div><div class="pp-card"><h3>证据规则</h3><p class="pp-small">每个事件都必须解析到 EvidenceLink。经文、律藏、阿毗达磨、注释、现代开示和学术研究分层；V4 row_id 缺失时明确显示待解析，不伪造定位。</p><div class="pp-small" data-coverage>证据审计清单加载中…</div><button data-audit style="margin-top:10px">显示三源审计清单</button><pre class="pp-export" data-audit-output hidden></pre></div></aside><main data-trace><div class="pp-card"><div class="pp-small">尚未运行</div></div></main></div></div>';
    app.querySelector('[data-fixture]').value = selected.id;
    app.querySelector('[data-value]').value = selected.primary_object.value;
    app.querySelectorAll('[data-model]').forEach(function (node) { node.classList.toggle('active', node.getAttribute('data-model') === currentModel); node.addEventListener('click', function () { currentModel = node.getAttribute('data-model'); app.querySelectorAll('[data-model]').forEach(function (other) { other.classList.toggle('active', other.getAttribute('data-model') === currentModel); }); }); });
    app.querySelector('[data-fixture]').addEventListener('change', function (event) { currentFixture = (P.FIXTURES || []).filter(function (item) { return item.id === event.target.value; })[0] || selected; app.querySelector('[data-value]').value = currentFixture.primary_object.value; });
    function currentRequest(fixture, model) {
      var rounds = Number((app.querySelector('[data-max-rounds]') || {}).value || 1);
      fixture.maxRounds = Number.isFinite(rounds) ? Math.max(1, Math.min(6, Math.floor(rounds))) : 1;
      return { modelVersion: model, scenario: fixture, agents: profileForFixture(fixture), interventions: fixture.interventions || {}, seed: fixture.seed || fixture.id, maxRounds: fixture.maxRounds };
    }
    app.querySelector('[data-run]').addEventListener('click', function () { var fixture = P.clone(currentFixture); fixture.primary_object.value = app.querySelector('[data-value]').value; fixture.interventions = { 'agent-a': {} }; app.querySelectorAll('[data-intervention]:checked').forEach(function (input) { fixture.interventions['agent-a'][input.getAttribute('data-intervention')] = true; }); try { var trace = P.runInteraction(currentRequest(fixture, currentModel)); renderTrace(trace); } catch (error) { app.querySelector('[data-error]').textContent = error.message; } });
    app.querySelector('[data-compare]').addEventListener('click', function () { var fixture = P.clone(currentFixture); fixture.primary_object.value = app.querySelector('[data-value]').value; fixture.interventions = { 'agent-a': {} }; app.querySelectorAll('[data-intervention]:checked').forEach(function (input) { fixture.interventions['agent-a'][input.getAttribute('data-intervention')] = true; }); try { var c = P.runInteraction(currentRequest(fixture, P.MODEL_VERSIONS.CANONICAL)); var s = P.runInteraction(currentRequest(fixture, P.MODEL_VERSIONS.SYNTHESIS)); renderTrace(s, { canonical: c, synthesis: s }); } catch (error) { app.querySelector('[data-error]').textContent = error.message; } });
    if (global.fetch) {
      global.fetch('personhood/evidence-index.json').then(function (response) { return response.ok ? response.json() : null; }).then(function (data) {
        if (!data) return;
        P.EVIDENCE_INDEX = data;
        var coverage = app.querySelector('[data-coverage]');
        if (coverage) coverage.textContent = '旧版 V4 候选：' + data.claims.length + ' 个主张；请以下方三源审计状态为准。';
      }).catch(function () {});
      global.fetch('personhood/evidence-audit-summary.json').then(function (response) { return response.ok ? response.json() : null; }).then(function (data) {
        if (!data || P.EVIDENCE_AUDIT) return;
        P.EVIDENCE_AUDIT = data;
        var coverage = app.querySelector('[data-coverage]');
        var summary = data.summary || {};
        if (coverage) coverage.textContent = '三源审计（静态快照）：' + (summary.confirmed || 0) + ' 已确认 · ' + (summary.candidate || 0) + ' 候选 · ' + (summary.review_required || 0) + ' 待人工复核。';
      }).catch(function () {});
      var base = global.SUTTA_PERSONHOOD_API_BASE || (typeof API_BASE !== 'undefined' ? API_BASE : '');
      if (base) global.fetch(base.replace(/\/$/, '') + '/api/personhood/evidence').then(function (response) { return response.ok ? response.json() : null; }).then(function (data) {
        if (!data) return;
        P.EVIDENCE_AUDIT = data;
        var coverage = app.querySelector('[data-coverage]');
        var summary = data.summary || {};
        if (coverage) coverage.textContent = '三源审计：' + (summary.confirmed || 0) + ' 已确认 · ' + (summary.candidate || 0) + ' 候选 · ' + (summary.review_required || 0) + ' 待人工复核（总计 ' + (summary.total || 0) + '）。';
      }).catch(function () {});
      var auditButton = app.querySelector('[data-audit]');
      if (auditButton) auditButton.addEventListener('click', function () {
        var output = app.querySelector('[data-audit-output]');
        var audit = P.EVIDENCE_AUDIT;
        if (!audit) { output.hidden = false; output.textContent = '审计清单尚未从后端加载；当前只能查看事件级静态证据。'; return; }
        output.hidden = false;
        output.textContent = JSON.stringify({ registry_version: audit.registry_version, coverage_scope: audit.coverage_scope, summary: audit.summary, claims: (audit.claims || []).map(function (claim) { var sources = claim.sources || {}; return { id: claim.id, layer: claim.layer, status: claim.status, v4: (claim.v4 || sources.v4 || {}).status, early_buddhist: (claim.early_buddhist || sources.early_buddhist || {}).status, suttacentral: (claim.suttacentral || sources.suttacentral || {}).status }; }) }, null, 2);
      });
    }
  }
  global.renderPersonhoodLab = renderLab;
})(window);
