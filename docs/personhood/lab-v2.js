/* Independent V4 evidence-first personhood chat lab. No Gotama skill/state. */
(function (global) {
  'use strict';
  var KEY = 'sutta-personhood-lab-v2';
  var EVIDENCE_BASE = 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1/personhood-evidence/v1';
  var state = { model: 'theravada-synthesis/v2', turns: [], savedCaseId: null, selectedPath: null };
  var bundle = { manifest: null, shards: {} };
  var FALLBACK_API = global.location && (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1')
    ? 'http://localhost:8000'
    : 'https://sutta-api.agreeablemeadow-9da329ca.swedencentral.azurecontainerapps.io';
  function base() { return (global.SUTTA_PERSONHOOD_API_BASE || FALLBACK_API).replace(/\/$/, ''); }
  function headers() { var token = global.localStorage && global.localStorage.getItem('sutta_token'); return Object.assign({'Content-Type':'application/json'}, token ? {'Authorization':'Bearer ' + token} : {}); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function load() { try { var item = JSON.parse(global.localStorage.getItem(KEY) || 'null'); if (item) state = Object.assign(state, item); } catch (_) {} }
  function persist() { try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function methodHtml() { return '<details class="v2-card v2-method"><summary>证据与方法</summary><p>本实验室只把用户报告的事件、感受和推测分开处理。引文来自已发布的 V4 静态引文库：每轮只从本地分片抽取，不重新检索 Azure。经律原典版不使用后期术语；分层整合版会单列阿毗达磨心路。</p></details>'; }
  function evidenceHtml(rows) { if (!rows || !rows.length) return '<p class="v2-muted">本轮没有匹配到已保存的引文；过程卡仍可作为问题拆分工具。</p>'; return '<div class="v2-evidence">' + rows.map(function (row) { return '<div class="v2-evidence-item"><a href="' + esc(row.reader_url || '#') + '" target="_blank" rel="noopener">' + esc(row.title || row.work_id || 'V4 经文') + ' · ' + esc(row.paranum || ('行 ' + row.row_id)) + '</a><div>' + esc(row.snippet || row.text || '') + '</div><small class="v2-muted">第 ' + esc(row.lineage_layer || '?') + ' 层 · ' + esc(row.provenance === 'canonical' ? '经律／论藏原典' : '后期上座部系统化') + '</small></div>'; }).join('') + '</div>'; }
  function factHtml(observation) { var labels = [['observable_events','可观察事件'],['first_person_reports','我的报告'],['attributions_not_facts','对他人的推测'],['unknown_or_needs_clarification','尚待澄清']]; return '<div class="v2-facts">' + labels.map(function (item) { return '<div class="v2-fact"><strong>' + item[1] + '</strong>' + esc((observation[item[0]] || []).join('；') || '—') + '</div>'; }).join('') + '</div>'; }
  function processHtml(stage) {
    var flow = (stage.mind_processes || []).map(function (process) {
      return '<section class="v2-mind-flow"><div><strong>' + esc(process.label) + '</strong><span>' + esc(process.applies_to) + '</span></div><ol>' + (process.steps || []).map(function (step) { return '<li>' + esc(step) + '</li>'; }).join('') + '</ol></section>';
    }).join('');
    return '<article class="v2-stage ' + (stage.interpretation_layer === 'later-systematisation' ? 'later' : '') + '"><span class="v2-layer">' + (stage.interpretation_layer === 'later-systematisation' ? '后期解释' : '原典依据') + '</span><div class="v2-label">' + esc(stage.label) + '</div><p>' + esc(stage.meaning) + '</p>' + flow + '</article>';
  }
  function turnHtml(turn, index) {
    var obs = turn.observation || {};
    var process = (turn.process || []).map(processHtml).join('');
    var branches = (turn.branches || []).map(function (branch) { return '<article class="v2-branch ' + (branch.id === 'mindful' ? 'mindful' : '') + '"><h4>' + esc(branch.label) + '</h4><p>' + esc(branch.description) + '</p><ul>' + (branch.steps || []).map(function (step) { return '<li>' + esc(step) + '</li>'; }).join('') + '</ul><button data-path="' + esc(branch.id) + '">选择这条路径</button></article>'; }).join('');
    var ai = turn.ai_explanation ? '<div class="v2-card"><h3>AI 场景化说明</h3><p>' + esc(turn.ai_explanation.summary) + '</p><ul>' + (turn.ai_explanation.concrete_actions || []).map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul></div>' : '<p class="v2-muted">' + (turn.ai && turn.ai.degraded ? 'AI 场景化解释暂不可用；以下本地过程与引文仍可审阅。' : '') + '</p>';
    var evidenceStatus = turn.evidence_status && !turn.evidence_status.available ? '<div class="v2-alert" role="status"><strong>本地引文库状态</strong><span>' + esc(turn.evidence_status.message || '请稍后重试。') + '</span></div>' : '';
    return '<div class="v2-message v2-user"><strong>第 ' + (index + 1) + ' 轮 · 你的输入</strong><div>' + esc(turn.observation && turn.observation.raw || '') + '</div></div><div class="v2-message v2-assistant"><div class="v2-toolbar"><strong>过程分析</strong><span class="v2-muted">' + esc(turn.model_version || state.model) + '</span></div>' + factHtml(obs) + evidenceStatus + '<div class="v2-process">' + process + '</div><h3>两条可能路径</h3><div class="v2-branches">' + branches + '</div>' + ai + '<details class="v2-card"><summary>本轮 V4 引文（' + ((turn.evidence || []).length) + ' 条）</summary>' + evidenceHtml(turn.evidence) + '</details></div>';
  }
  function fetchJson(url) { return fetch(url, {cache:'force-cache'}).then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); }); }
  function manifest() { if (bundle.manifest) return Promise.resolve(bundle.manifest); return fetchJson(EVIDENCE_BASE + '/manifest.json').then(function (data) { bundle.manifest = data; return data; }); }
  function selectedConcepts(message, model, data) {
    var text = String(message || '').toLowerCase();
    var required = {'contact-feeling':1, 'perception-attention':1, 'thought-papanca':1, 'mindfulness':1};
    if (/别人|众生|有情|关系|人/.test(text)) { required.interaction=1; required['body-speech-mind']=1; }
    if (/说|听|争|责|骂|赞|评价/.test(text)) { required['speech-conflict']=1; required['praise-blame']=1; }
    if (/想|执|取|要|喜欢|害怕|生气|渴望/.test(text)) { required['craving-clinging']=1; required['views-conceit']=1; }
    if (/习惯|重复|烦恼|随眠|心路/.test(text)) { required['latent-tendency']=1; }
    if (model === 'theravada-synthesis/v2') required['mind-process']=1;
    return (data.registry.queries || []).map(function (item) { return item.id; }).filter(function (id) { return required[id]; });
  }
  function shard(id, data) { if (bundle.shards[id]) return bundle.shards[id]; bundle.shards[id] = fetchJson(EVIDENCE_BASE + '/' + data.files[id].file); return bundle.shards[id]; }
  function selectEvidence(message, model) {
    return manifest().then(function (data) {
      var concepts = selectedConcepts(message, model, data);
      return Promise.all(concepts.map(function (id) { return shard(id, data); })).then(function (pieces) {
        var direct = {}; (data.direct_citations || []).forEach(function (item) { direct[item.work_id + ':' + item.row_id] = true; });
        var rows = {};
        pieces.forEach(function (piece) { (piece.records || []).forEach(function (row) {
          if (model === 'pali-canonical/v2' && row.provenance !== 'canonical') return;
          if (!rows[row.evidence_id]) rows[row.evidence_id] = row;
        }); });
        var words = String(message || '').replace(/\s+/g, '');
        var list = Object.keys(rows).map(function (id) { return rows[id]; });
        list.sort(function (a, b) {
          function score(row) { var directScore = direct[row.work_id + ':' + row.row_id] ? 10000 : 0; var conceptScore = (row.concept_ids || []).filter(function (id) { return concepts.indexOf(id) >= 0; }).length * 100; var wording = (row.text || '') + (row.snippet || ''); var inputScore = words && wording.indexOf(words) >= 0 ? 50 : 0; return directScore + conceptScore + inputScore; }
          return score(b) - score(a) || String(a.evidence_id).localeCompare(String(b.evidence_id));
        });
        return {version:data.version, rows:list.slice(0, 48)};
      });
    });
  }
  function observe(message) { var text = String(message || '').trim(); var parts = text.split(/[，。！？；;]+/).filter(Boolean); var facts = parts.filter(function (part) { return /看见|看到|听见|听到|发生|别人对我做|别人对我说|对方说|他说|她说|讨论法义/.test(part); }); var reports = parts.filter(function (part) { return /我觉得|我感到|我感觉|我想|我害怕|我生气|我希望|我担心|胸口发紧|心里发紧|身体发紧|发紧/.test(part); }); var attribution = parts.filter(function (part) { return /他想|她想|对方想|针对我|看不起我|讨厌我|故意|要害我|评价我|否定我|轻视我/.test(part); }); return {raw:text,observable_events:facts,first_person_reports:reports,attributions_not_facts:attribution,unknown_or_needs_clarification:(facts.length||reports.length||attribution.length)?parts.filter(function(part){return facts.indexOf(part)<0&&reports.indexOf(part)<0&&attribution.indexOf(part)<0;}):[text]}; }
  function localTurn(message, selected, reason) {
    var later = state.model === 'theravada-synthesis/v2';
    var process = [
      {label:'所缘与门',meaning:'先把看见、听见、身体感觉或记忆当作这一轮可报告的对象；不要把推测当成外界事实。',interpretation_layer:'canonical'},
      {label:'触与受',meaning:'对象、感官门与识相遇后，体验呈现为舒适、不适或中性；这是感受标签，不是对人的判决。',interpretation_layer:'canonical'},
      {label:'命名、想与作意',meaning:'心把声音、表情或事件认作某种意义，并把注意力放到其中一部分；可重新检查命名是否过快。',interpretation_layer:'canonical'},
      {label:'寻思到戏论',meaning:'比较、记忆和反复推演会把一次事件扩展成关于自己和他人的故事；此处只描述可能的展开。',interpretation_layer:'canonical'},
      {label:'爱与取',meaning:'具体问：此刻想得到什么或避免什么？又把什么当成必须证明、维持或夺回？',interpretation_layer:'canonical'},
      {label:'身语意行动与反馈',meaning:'把语气、停顿、距离、姿态和说出的话写成可观察行动；下一轮只接收真实发生的反馈。',interpretation_layer:'canonical'}
    ];
    if (later) process.splice(5,0,{label:'后期上座部系统化：五门与意门完整心路',meaning:'以已保存的《摄阿毗达磨义论》相关引文展开两套完整流程。',interpretation_layer:'later-systematisation',mind_processes:[{label:'五门过程',applies_to:'色、声、香、味、触等外来所缘',steps:['有分','两次波动','有分中断','五门转向','相应五识','领受','推度','确定','速行（通常七次）','彼所缘（随缘二次）','回归有分']},{label:'意门过程',applies_to:'记忆、想象、反复思量等意门所缘',steps:['有分','两次波动','有分中断','意门转向','速行（通常七次）','彼所缘（随缘二次）','回归有分']}]});
    return {schema_version:'personhood-interaction/v2',model_version:state.model,observation:observe(message),evidence_status:{available:selected.rows.length>0,message:reason||'本轮过程卡从已保存的本地 V4 引文库抽取。'},process:process,branches:[{id:'reactive',label:'随反应推进',description:'如果把第一感觉立即当成结论，反应可能继续加深。',steps:['把不适解释成对方的明确意图，并反复寻找支持它的细节。','把“必须被理解／必须赢／必须立刻反击”当成当前行动条件。','选择一个实际可见的动作：提高音量、抢话、冷处理或发送指责文字。']},{id:'mindful',label:'正念处理',description:'先暂停并把事实、感受、推测和需要分开，再选择行动。',steps:['说出“我听见／看见了……，我现在感到……”。','把对方动机标为待确认，并提出一个澄清问题或清楚界限。','选择一个实际可见的动作：放慢语速、保持距离、暂缓回复或约定稍后再谈。']}],evidence:selected.rows,ai:{enabled:false,degraded:true},evidence_bundle_version:selected.version};
  }
  function render() { var app = document.getElementById('app'); if (!app) return; load(); var turns = state.turns.map(turnHtml).join(''); app.innerHTML = '<div class="personhood-lab personhood-v2"><div class="v2-chat"><div class="v2-hero"><div class="v2-kicker">V4 STATIC CITATIONS · INTERACTION LAB</div><h2>有情互动与经验形成实验室</h2><p class="v2-subtitle">直接输入一个真实发生的现象。系统从已保存的 V4 引文中抽取证据，拆开事件、感受、推测与未知处，再呈现两条可能的回应路径。</p><div class="v2-toolbar"><div class="v2-segment"><button class="' + (state.model === 'pali-canonical/v2' ? 'active' : '') + '" data-model="pali-canonical/v2">经律原典版</button><button class="' + (state.model === 'theravada-synthesis/v2' ? 'active' : '') + '" data-model="theravada-synthesis/v2">分层整合版</button></div><div><button data-new>新案例</button><button data-research>证据研究</button></div></div></div><main><section class="v2-card"><h3>输入新的交互现象</h3><textarea data-input placeholder="例如：听见别人说‘你怎么总是这样’，我觉得对方在否定我……"></textarea><div class="v2-toolbar"><span class="v2-muted" data-status>每次只推进真实的新反馈；不替对方编造心理。</span><button class="primary" data-send>分析这一轮</button></div></section>' + (turns || '<section class="v2-card"><p class="v2-muted">尚未开始。输入“看见……”“听见……”“别人对我说……”等实际现象即可。</p></section>') + '<section class="v2-card"><button data-save>保存到我的账户</button><span class="v2-status" data-save-status>新案例先保存在此浏览器；登录后可主动保存。</span></section>' + methodHtml() + '</main></div></div>';
    app.querySelectorAll('[data-model]').forEach(function (button) { button.addEventListener('click', function () { state.model = button.getAttribute('data-model'); persist(); render(); }); });
    app.querySelector('[data-new]').addEventListener('click', function () { state.turns=[]; state.savedCaseId=null; state.selectedPath=null; persist(); render(); });
    app.querySelector('[data-research]').addEventListener('click', function () { global.location.hash = '#/personhood/research'; if (global.renderPersonhoodResearch) global.renderPersonhoodResearch(); });
    app.querySelector('[data-send]').addEventListener('click', function () { var input = app.querySelector('[data-input]'); var message = input.value.trim(); if (!message) return; var status = app.querySelector('[data-status]'); status.textContent = '正在从已保存引文中抽取并组织过程…'; selectEvidence(message, state.model).then(function (selected) { var request = {message:message,model_version:state.model,conversation_id:'local-personhood-v2',parent_turn_id:state.turns.length?'turn-'+state.turns.length:null,selected_path:state.selectedPath,previous_observations:state.turns.map(function(t){return t.observation&&t.observation.raw;}).slice(-12),evidence_bundle_version:selected.version,selected_evidence:selected.rows}; return fetch(base() + '/api/personhood/v2/analyze',{method:'POST',headers:headers(),body:JSON.stringify(request)}).then(function(response){return response.text().then(function(raw){var data={};try{data=raw?JSON.parse(raw):{};}catch(_){ }if(!response.ok)throw new Error('HTTP '+response.status);return data;});}).then(function(data){return data.turn || localTurn(message, selected, '分析服务未返回有效结果；以下为本地过程与引文。');}).catch(function(){return localTurn(message, selected, '分析服务暂不可用；以下为从已保存引文库抽取的本地过程。');}); }).then(function(turn){state.turns.push(turn);state.selectedPath=null;persist();render();}).catch(function(error){status.textContent='本地引文库暂不可用：'+error.message;}); });
    app.querySelectorAll('[data-path]').forEach(function (button) { button.addEventListener('click', function () { state.selectedPath = button.getAttribute('data-path'); persist(); var status = app.querySelector('[data-status]'); if (status) status.textContent = '已选择“' + (state.selectedPath === 'mindful' ? '正念处理' : '随反应推进') + '”。请在上方输入真实发生的下一项反馈。'; }); });
    app.querySelector('[data-save]').addEventListener('click', function () { var status = app.querySelector('[data-save-status]'); if (!state.turns.length) { status.textContent='请先完成至少一轮。'; return; } if (!base() || !global.localStorage.getItem('sutta_token')) { status.textContent='当前未登录；案例已安全保存在此浏览器。'; return; } var snapshot={schema_version:'personhood-interaction/v2',case_kind:'pali-personhood-chat-case',model_version:state.model,turns:state.turns,evidence_scope:'personhood-evidence/v1'}; var url=base()+'/api/personhood/cases'+(state.savedCaseId?'/'+encodeURIComponent(state.savedCaseId):''); fetch(url,{method:state.savedCaseId?'PUT':'POST',headers:headers(),body:JSON.stringify({title:'有情互动案例',snapshot:snapshot})}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'save failed');return d;});}).then(function(d){state.savedCaseId=d.id;persist();status.textContent='已保存到账号，可在其他设备继续查看。';}).catch(function(){status.textContent='保存失败；本地案例仍保留，可稍后重试。';}); });
  }
  function renderResearch() { var app = document.getElementById('app'); if (!app) return; app.innerHTML = '<div class="personhood-lab personhood-v2"><div class="v2-chat"><div class="v2-hero"><div class="v2-kicker">RESEARCH · STATIC V4 CITATIONS</div><h2>证据与研究清单</h2><p class="v2-subtitle">固定词表在构建时完整遍历全部 217 部 V4；实验室只从版本化静态分片抽取引文。</p><button data-back>返回实验室</button></div><div class="v2-card"><h3>互动过程词表</h3><p>触、受、想、作意、寻思、戏论、爱、取、有、慢、见、随眠、身语意行动、正念、明觉与修复。</p><p class="v2-muted">完整台账保留查询词、段落、三语文本、层级与校验值；它是固定词法命中的可审计集合，不伪装为穷尽全部语义相关经文。</p></div></div></div>'; app.querySelector('[data-back]').addEventListener('click', function(){global.location.hash='#/personhood';render();}); }
  global.renderPersonhoodLab = render;
  global.renderPersonhoodResearch = renderResearch;
})(window);
