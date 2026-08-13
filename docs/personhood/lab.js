(function (global) {
  'use strict';
  var P = global.PaliPersonhood = global.PaliPersonhood || {};
  var STORE_KEY = 'pali-personhood-lab/session/v1';
  var state = { model: 'pali-canonical/v1', mode: 'user-model', turns: [], savedCaseId: null };
  var DOORS = { eye: '眼门（景象、形色）', ear: '耳门（声音、语言）', nose: '鼻门（气味）', tongue: '舌门（味道）', body: '身门（触碰、疼痛、温度）', mind: '意门（记忆、想法、意象）' };
  var VALENCES = { pleasant: '乐受', painful: '苦受', neutral: '不苦不乐受' };
  var KINDS = { 'visual form': '景象', speech: '说话或声音', odor: '气味', taste: '味道', touch: '触碰', pressure: '压力或疼痛', thought: '想法', memory: '记忆', gesture: '姿态或动作', ambiguous: '含义不明的对象', unspecified: '尚未明确的对象' };
  var EVENTS = { contact: '门、所缘与识的接触条件', 'coarising-aggregates': '五蕴条件聚合', feeling: '受', 'perception-and-thought': '想与寻思的展开', craving: '爱', 'clinging-and-becoming': '取与有的局部反应模式', 'mindfulness-and-clear-comprehension': '正念与明觉', 'non-clinging': '不取著／局部止息', 'observable-action': '可观察行动', 'citta-vithi-view': '后期心路解释' };

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]; }); }
  function clone(value) { return P.clone(value); }
  function modelLabel(value) { return value === 'theravada-synthesis/v1' ? '上座部整合版' : '经律核心版'; }
  function eventLabel(value) { return EVENTS[value] || value; }
  function kindLabel(value) { return KINDS[value] || value || '所缘'; }
  function apiBase() { return global.SUTTA_PERSONHOOD_API_BASE || ''; }
  function authHeaders() { var headers = { 'Content-Type': 'application/json' }; try { if (typeof global.communityAuthHeaders === 'function') Object.assign(headers, global.communityAuthHeaders()); } catch (ignore) {} return headers; }
  function saveLocal() { try { global.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (ignore) {} }
  function restoreLocal() { try { var data = JSON.parse(global.localStorage.getItem(STORE_KEY) || 'null'); if (data && Array.isArray(data.turns)) state = Object.assign(state, data); } catch (ignore) {} }
  function profile(id, label, trained) {
    return { id: id, label: label, species: 'human', tendencies: { lobha: trained ? .30 : .72, dosa: trained ? .30 : .72, moha: trained ? .30 : .66 }, training: { sati: trained ? .75 : .18, sampajanna: trained ? .70 : .18, sila: trained ? .70 : .30, metta: trained ? .72 : .28, panna: trained ? .65 : .18 }, notes: '这是情境中的条件设定，不是人格分数、诊断或资格判断。' };
  }
  function agentsFor(mode) { return mode === 'two-models' ? [profile('agent-a', '人格模型 A', false), profile('agent-b', '人格模型 B', true)] : [profile('agent-model', '人格模型', false)]; }
  function interventions(app, agents) {
    var item = {}; agents.forEach(function (agent) { item[agent.id] = {}; });
    app.querySelectorAll('[data-intervention]:checked').forEach(function (node) { agents.forEach(function (agent) { item[agent.id][node.getAttribute('data-intervention')] = true; }); });
    return item;
  }
  function selectedFixture(app) { return (P.FIXTURES || []).concat(P.SPECIAL_FIXTURES || []).filter(function (item) { return item.id === app.querySelector('[data-fixture]').value; })[0]; }
  function scenarioFromForm(app) {
    var fixture = selectedFixture(app) || (P.FIXTURES || [])[0];
    var door = app.querySelector('[data-door]').value;
    var valence = app.querySelector('[data-valence]').value;
    var value = app.querySelector('[data-value]').value.trim();
    return {
      id: 'interactive-' + Date.now(), title: app.querySelector('[data-title]').value.trim() || '连续互动案例',
      description: '用户提供可观察所缘；模型不从文字臆测隐藏心理状态。',
      primary_object: { id: 'user-object-' + Date.now(), kind: app.querySelector('[data-kind]').value || (fixture.primary_object && fixture.primary_object.kind) || 'speech', door: door, value: value || '尚未描述的可观察所缘', valence: valence, observable: true, source_agent_id: state.mode === 'two-models' ? 'shared-environment' : 'user' },
      context: { language: 'zh-CN', interaction_mode: state.mode, user_confirmed_observable_input: true }, observable_events: [{ id: 'user-input-' + Date.now(), actor_id: 'user', type: 'observable-input', value: value }]
    };
  }
  function runTurn(app, compare) {
    var scenario = scenarioFromForm(app); var agents = agentsFor(state.mode); var request = { modelVersion: state.model, scenario: scenario, agents: agents, interventions: interventions(app, agents), seed: 'interactive-' + (state.turns.length + 1), maxRounds: 1 };
    var result = P.runInteraction(request); var turn = { input: clone(scenario.primary_object), request: request, trace: result, created_at: new Date().toISOString() };
    state.turns.push(turn); saveLocal();
    renderTimeline(app);
    if (compare) { var other = clone(request); other.modelVersion = state.model === 'pali-canonical/v1' ? 'theravada-synthesis/v1' : 'pali-canonical/v1'; renderTrace(app, result, P.runInteraction(other)); }
    else renderTrace(app, result);
  }
  function evidenceCard(ids) { return (ids || []).map(function (id) { var ev = P.getEvidence(id); return ev ? '<div class="pp-evidence-item"><strong>' + esc(ev.citation) + '</strong><span class="pp-badge">' + esc(ev.layer) + '</span><br>' + esc(ev.translation) + '<br><a target="_blank" rel="noopener" href="' + esc(ev.url) + '">查看来源</a><div class="pp-small">' + esc(ev.note || '') + '</div></div>' : '<div class="pp-notice">未解析的证据 ID：' + esc(id) + '</div>'; }).join(''); }
  function renderEvent(event) { var labels = event.aggregates || {}; return '<article class="pp-event ' + esc(event.phase) + '"><div class="meta">步骤 ' + event.step + ' · ' + esc(eventLabel(event.kind)) + (event.phase === 'interpretive' ? ' · 后期系统化解释' : '') + '</div><div class="statement">' + esc(event.statement || '') + '</div><div class="pp-small">受：' + esc(VALENCES[labels.feeling] || labels.feeling || '') + '；所缘：' + esc(kindLabel(event.conditions && event.conditions.object_kind)) + '</div><details><summary>查看经文与研究依据</summary>' + evidenceCard(event.evidence_ids) + '</details></article>'; }
  function renderTrace(app, trace, comparison) {
    var target = app.querySelector('[data-trace]'); if (!target) return;
    var streams = (trace.streams || []).map(function (stream) { return '<section class="pp-lane"><div class="pp-lane-title"><strong>' + esc(stream.agent_label) + '</strong><span class="pp-badge branch">' + (stream.branch === 'trained' ? '训练条件可用' : '反应链延续') + '</span></div><div class="pp-small">本轮条件设定：反应倾向 ' + esc(stream.tendency_used) + ' · 训练条件 ' + esc(stream.training_available) + '</div>' + stream.events.map(renderEvent).join('') + (stream.caveats || []).map(function (item) { return '<div class="pp-notice">' + esc(item) + '</div>'; }).join('') + '</section>'; }).join('');
    var exchange = (trace.observable_edges || []).map(function (edge) { return '<div class="pp-edge"><strong>' + esc(edge.from_agent_id) + ' → ' + esc(edge.to_agent_id) + '</strong><br>' + esc(edge.value) + '<div class="pp-small">只传递可观察行动；不传递任何内部状态。</div></div>'; }).join('') || '<div class="pp-small">本模式由用户提供下一轮所缘；没有其他个体的内部状态被读取或共享。</div>';
    var compare = comparison ? '<div class="pp-card"><h3>版本比较</h3><p class="pp-small">当前显示：' + esc(modelLabel(trace.model_version)) + '。另一版本 ' + esc(modelLabel(comparison.model_version)) + ' 已用同一输入运行；后期心路说明只在整合版出现。</p></div>' : '';
    var continueButton = state.mode === 'two-models' ? '<button data-continue-models>让双方依据外化行动继续一轮</button>' : '';
    target.innerHTML = '<div class="pp-card"><div class="pp-lane-title"><h3>' + esc(modelLabel(trace.model_version)) + '：本轮完整表现</h3><span class="pp-badge">第 ' + esc(state.turns.length) + ' 轮</span></div><div class="pp-lanes">' + streams + '</div><h3>中央可观察交换</h3>' + exchange + '<div class="pp-notice">“止息”只指当前局部反应链的止息，不模拟或认证涅槃、圣果、灭尽定或真实证悟。</div><div class="pp-buttons"><button data-export>导出可复现案例包</button><button data-explain>请 AI 解释此轮</button>' + continueButton + '</div><pre class="pp-export" data-output hidden></pre><div class="pp-dialogue-answer" data-explanation hidden></div></div>' + compare;
    target.querySelector('[data-export]').addEventListener('click', function () { var out = target.querySelector('[data-output]'); out.hidden = false; out.textContent = JSON.stringify(exportCase(), null, 2); });
    target.querySelector('[data-explain]').addEventListener('click', function () { explainTurn(target, state.turns[state.turns.length - 1]); });
    var continueModels = target.querySelector('[data-continue-models]');
    if (continueModels) continueModels.addEventListener('click', function () { continueTwoModels(app, trace); });
  }
  function continueTwoModels(app, trace) {
    var edge = (trace.observable_edges || [])[0];
    if (!edge) { app.querySelector('[data-status]').textContent = '本轮没有可用的外化行动，因此不能自动推进。'; return; }
    app.querySelector('[data-door]').value = 'ear'; app.querySelector('[data-kind]').value = 'speech'; app.querySelector('[data-valence]').value = 'neutral'; app.querySelector('[data-value]').value = edge.value;
    runTurn(app, false);
  }
  function exportCase() { return { schema_version: P.SCHEMA_VERSION, case_kind: 'pali-personhood-continuous-case', model_version: state.model, interaction_mode: state.mode, saved_case_id: state.savedCaseId, turns: state.turns, evidence_manifest: P.evidenceManifest(), exported_at: new Date().toISOString() }; }
  function explainTurn(target, turn) {
    var panel = target.querySelector('[data-explanation]'); panel.hidden = false; panel.textContent = '正在基于已验证的轨迹与证据请求讲解…';
    if (!apiBase()) { panel.textContent = '未配置 AI 服务。请直接审阅本轮事件的来源卡；确定性轨迹仍然有效。'; return; }
    global.fetch(apiBase().replace(/\/$/, '') + '/api/personhood/explain', { method: 'POST', headers: authHeaders(), body: JSON.stringify(Object.assign({}, turn.request, { question: '请只解释这一轮已验证的条件过程、可观察行动及其证据边界。' })) }).then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || '讲解服务不可用'); return data; }); }).then(function (data) { panel.textContent = (data.explanation && data.explanation.answer) || '没有可显示的讲解。'; }).catch(function (error) { panel.textContent = '讲解服务不可用；未保存任何额外数据。\n' + error.message; });
  }
  function renderTimeline(app) { var target = app.querySelector('[data-timeline]'); if (!target) return; target.innerHTML = state.turns.length ? state.turns.map(function (turn, index) { return '<li><strong>第 ' + (index + 1) + ' 轮：</strong>' + esc(DOORS[turn.input.door]) + ' · ' + esc(VALENCES[turn.input.valence]) + ' · ' + esc(turn.input.value) + '</li>'; }).join('') : '<li>尚未开始。请先输入一个你希望人格模型面对的、可观察的所缘。</li>'; }
  function loadFixture(app) { var item = selectedFixture(app); if (!item) return; app.querySelector('[data-title]').value = item.title; app.querySelector('[data-door]').value = item.primary_object.door; app.querySelector('[data-kind]').value = item.primary_object.kind; app.querySelector('[data-valence]').value = item.primary_object.valence; app.querySelector('[data-value]').value = item.primary_object.value; }
  function saveCase(app) {
    if (!state.turns.length) { app.querySelector('[data-status]').textContent = '请先运行至少一轮，再保存案例。'; return; }
    var base = apiBase(); if (!base) { app.querySelector('[data-status]').textContent = '当前为访客本地暂存：刷新后可继续；独立预览版未配置账户保存服务。'; return; }
    var body = { title: app.querySelector('[data-title]').value || '连续互动案例', snapshot: exportCase() }; var url = base.replace(/\/$/, '') + '/api/personhood/cases' + (state.savedCaseId ? '/' + encodeURIComponent(state.savedCaseId) : '');
    global.fetch(url, { method: state.savedCaseId ? 'PUT' : 'POST', headers: authHeaders(), body: JSON.stringify(body) }).then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || '保存失败'); return data; }); }).then(function (data) { state.savedCaseId = data.id; saveLocal(); app.querySelector('[data-status]').textContent = '已保存到你的账户。案例编号：' + data.id; }).catch(function (error) { app.querySelector('[data-status]').textContent = '未能保存到服务器；本地暂存仍保留。' + error.message; });
  }
  function researchHtml() { return '<div class="personhood-lab pp-research"><button class="back-btn" data-back>← 返回实验室</button><div class="pp-hero"><div class="pp-kicker">RESEARCH · MODEL · DELIVERY</div><h2>研究与系统说明</h2><p class="pp-subtitle">从三源文献核验到可复现的人格—条件过程引擎。此页如实区分已确认、候选与待人工复核材料。</p></div><main data-research><div class="pp-card">正在读取研究清单…</div></main></div>'; }
  function renderResearch() { var app = document.getElementById('app'); if (!app) return; app.innerHTML = researchHtml(); app.querySelector('[data-back]').addEventListener('click', function () { global.location.hash = '#/personhood'; if (!global.location.hash || global.location.pathname.endsWith('index.html')) renderLab(); }); global.fetch('personhood/research-manifest.json').then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('研究清单不可用')); }).then(function (manifest) { app.querySelector('[data-research]').innerHTML = (manifest.sections || []).map(function (section) { return '<details class="pp-card" open><summary><strong>' + esc(section.title) + '</strong></summary><p>' + esc(section.summary) + '</p><ul>' + (section.items || []).map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul>' + (section.links || []).map(function (link) { return '<a class="pp-source-link" href="' + esc(link.href) + '" target="_blank" rel="noopener">' + esc(link.label) + '</a>'; }).join('') + '</details>'; }).join('') + '<div class="pp-notice">版本：' + esc(manifest.version) + '。该页面不声称已经逐条人工穷尽全部巴利文献；请以审计状态与人工签核为准。</div>'; }).catch(function (error) { app.querySelector('[data-research]').innerHTML = '<div class="pp-notice">研究清单不可用：' + esc(error.message) + '</div>'; }); }
  function renderLab() {
    var app = document.getElementById('app'); if (!app) return; restoreLocal();
    var options = (P.FIXTURES || []).concat(P.SPECIAL_FIXTURES || []).map(function (item) { return '<option value="' + esc(item.id) + '">' + esc(item.title) + '</option>'; }).join('');
    app.innerHTML = '<div class="personhood-lab"><div class="pp-topline"><button class="back-btn" data-research>研究与系统说明</button><button class="back-btn" data-reset>开始新案例</button></div><div class="pp-hero"><div class="pp-kicker">PALI PERSONHOOD PROCESS LAB</div><h2>巴利人格过程实验室</h2><p class="pp-subtitle">把一个实际经历拆成可观察所缘、条件过程与外化回应。你可以连续输入景象、体验、言语或行动，观看模型的完整条件轨迹；模型不读取任何人的隐藏心理状态。</p><div class="pp-notice">这是学习与审计工具，不是人格测验、临床建议、道德评价或证悟认证。</div></div><div class="pp-grid"><aside><div class="pp-card"><h3>情境与版本</h3><label>预设情境</label><select data-fixture>' + options + '</select><label>互动模式</label><select data-mode><option value="user-model">我提供所缘，观察人格模型</option><option value="two-models">模拟两个个体相互互动</option></select><label>案例名称</label><input data-title value="连续互动案例"><label>感官门</label><select data-door>' + Object.keys(DOORS).map(function (key) { return '<option value="' + key + '">' + DOORS[key] + '</option>'; }).join('') + '</select><label>所缘类别</label><select data-kind>' + Object.keys(KINDS).map(function (key) { return '<option value="' + key + '">' + KINDS[key] + '</option>'; }).join('') + '</select><label>感受倾向</label><select data-valence>' + Object.keys(VALENCES).map(function (key) { return '<option value="' + key + '">' + VALENCES[key] + '</option>'; }).join('') + '</select><label>可观察所缘／发生的事</label><textarea data-value placeholder="例如：有人对人格模型说：‘你做得很差。’"></textarea><div class="pp-models"><button class="pp-model" data-model="pali-canonical/v1">经律核心版<small>只显示经律可支持的条件关系</small></button><button class="pp-model" data-model="theravada-synthesis/v1">上座部整合版<small>额外标示后期系统化解释</small></button></div><div class="pp-buttons"><button class="primary" data-run>运行这一轮</button><button data-compare>与另一版本比较</button></div></div><div class="pp-card"><h3>条件训练实验</h3><label><input type="checkbox" data-intervention="mindfulness"> 正念与明觉</label><label><input type="checkbox" data-intervention="restraint"> 根门守护与戒护</label><label><input type="checkbox" data-intervention="metta"> 慈心与善意</label><label><input type="checkbox" data-intervention="pause"> 暂停反应</label><p class="pp-small">干预只是当前情境可选择的条件，不代表对使用者的人格或修行成就作判断。</p></div><div class="pp-card"><h3>案例保存</h3><button data-save>保存到我的账户</button><p class="pp-small" data-status>访客案例默认只保存在此浏览器；登录后可主动保存。</p></div></aside><main><section class="pp-card"><h3>连续互动时间线</h3><ol class="pp-timeline" data-timeline></ol></section><section data-trace><div class="pp-card"><p class="pp-small">输入第一轮所缘后，这里会显示人格模型的完整条件过程。</p></div></section></main></div></div>';
    loadFixture(app); state.mode = state.mode || 'user-model'; app.querySelector('[data-mode]').value = state.mode;
    app.querySelectorAll('[data-model]').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-model') === state.model); button.addEventListener('click', function () { state.model = button.getAttribute('data-model'); app.querySelectorAll('[data-model]').forEach(function (item) { item.classList.toggle('active', item === button); }); saveLocal(); }); });
    app.querySelector('[data-fixture]').addEventListener('change', function () { loadFixture(app); }); app.querySelector('[data-mode]').addEventListener('change', function (event) { state.mode = event.target.value; saveLocal(); });
    app.querySelector('[data-run]').addEventListener('click', function () { try { runTurn(app, false); } catch (error) { app.querySelector('[data-status]').textContent = '无法运行：' + error.message; } }); app.querySelector('[data-compare]').addEventListener('click', function () { try { runTurn(app, true); } catch (error) { app.querySelector('[data-status]').textContent = '无法运行：' + error.message; } });
    app.querySelector('[data-save]').addEventListener('click', function () { saveCase(app); }); app.querySelector('[data-reset]').addEventListener('click', function () { state.turns = []; state.savedCaseId = null; saveLocal(); renderLab(); }); app.querySelector('[data-research]').addEventListener('click', function () { global.location.hash = '#/personhood/research'; if (global.location.hash !== '#/personhood/research') renderResearch(); }); renderTimeline(app);
  }
  global.renderPersonhoodLab = renderLab; global.renderPersonhoodResearch = renderResearch;
})(window);
