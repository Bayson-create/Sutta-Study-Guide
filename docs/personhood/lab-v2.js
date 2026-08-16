/* Independent V4 evidence-first personhood chat lab. No Gotama skill/state. */
(function (global) {
  'use strict';
  var KEY = 'sutta-personhood-lab-v2';
  var EVIDENCE_BASE = 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1/personhood-evidence/v1';
  var state = { model: 'theravada-synthesis/v2', turns: [], savedCaseId: null, selectedPath: null, selectedAction: null };
  var bundle = { manifest: null, shards: {} };
  var FALLBACK_API = global.location && (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1')
    ? 'http://localhost:8000'
    : 'https://sutta-api.agreeablemeadow-9da329ca.swedencentral.azurecontainerapps.io';
  function base() { return (global.SUTTA_PERSONHOOD_API_BASE || FALLBACK_API).replace(/\/$/, ''); }
  function headers() { var token = global.localStorage && global.localStorage.getItem('sutta_token'); return Object.assign({'Content-Type':'application/json'}, token ? {'Authorization':'Bearer ' + token} : {}); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function load() { try { var item = JSON.parse(global.localStorage.getItem(KEY) || 'null'); if (item) state = Object.assign(state, item); } catch (_) {} }
  function persist() { try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function methodHtml() { return '<details class="v2-card v2-method"><summary>证据与方法</summary><p>本实验室只把用户报告的事件、感受和推测分开处理。引文来自已发布的 V4 静态引文库：每轮只从本地分片抽取，不重新检索 Azure。经律原典版依《蜜丸经》的显式次第；分层整合版另按《摄阿毗达磨义论》并列遍一切心心所并展开完整心路。</p></details>'; }
  function evidenceHtml(rows) { if (!rows || !rows.length) return '<p class="v2-muted">本轮没有匹配到已保存的引文；流程图仍可作为问题拆分工具。</p>'; return '<div class="v2-evidence">' + rows.map(function (row) { return '<div class="v2-evidence-item"><a href="' + esc(row.reader_url || '#') + '" target="_blank" rel="noopener">' + esc(row.title || row.work_id || 'V4 经文') + ' · ' + esc(row.paranum || ('行 ' + row.row_id)) + '</a><div>' + esc(row.snippet || row.text || '') + '</div><small class="v2-muted">第 ' + esc(row.lineage_layer || '?') + ' 层 · ' + esc(row.provenance === 'canonical' ? '经律／论藏原典' : '后期上座部系统化') + '</small></div>'; }).join('') + '</div>'; }
  function factHtml(observation) { var labels = [['observable_events','可观察事件'],['first_person_reports','我的报告'],['attributions_not_facts','对他人的推测'],['unknown_or_needs_clarification','尚待澄清']]; return '<div class="v2-facts">' + labels.map(function (item) { return '<div class="v2-fact"><strong>' + item[1] + '</strong>' + esc((observation[item[0]] || []).join('；') || '—') + '</div>'; }).join('') + '</div>'; }

  /* ── 流程图 ──
     列数来自该层实际的节点数，所以"并列几个就几列"，前后相继的节点各占一行；
     层与层之间、以及戏论想念回到寻的回环，都由 drawConnectors() 画成真的连线。 */
  function topologyFor(turn) {
    if (turn.topology && turn.topology.layers && turn.topology.layers.length) return turn.topology;
    return global.PersonhoodStages ? global.PersonhoodStages.build(turn.model_version || state.model) : { layers: [], edges: [] };
  }
  function vithiHtml(turn, content) {
    var chosen = turn.citta_vithi;
    var processes = (turn.process || []).reduce(function (found, stage) { return found || (stage.mind_processes ? stage.mind_processes : null); }, null);
    if (!processes) return '';
    var picked = chosen && chosen.selected_process_id;
    return '<div class="v2-vithi">' + processes.map(function (proc) {
      var active = picked ? proc.id === picked : false;
      var notes = active && chosen.step_notes ? chosen.step_notes : [];
      return '<section class="v2-mind-flow' + (active ? ' active' : picked ? ' dimmed' : '') + '">'
        + '<div><strong>' + esc(proc.label) + (active ? ' · 本轮判定' : '') + '</strong><span>' + esc(proc.applies_to) + '</span></div>'
        + '<ol>' + (proc.steps || []).map(function (step, i) {
            return '<li>' + esc(step) + (notes[i] ? '<em>' + esc(notes[i]) + '</em>' : '') + '</li>';
          }).join('') + '</ol></section>';
    }).join('') + (picked && chosen.reason ? '<p class="v2-muted">判定依据：' + esc(chosen.reason) + '</p>' : '') + '</div>';
  }
  // The controlled slots are keyed in English on the wire; label them in the
  // page's own language rather than leaking the schema key to the reader.
  var SLOT_LABELS = { door: '门', valence: '受', object_kind: '所缘类别', consciousness: '识' };
  function nodeHtml(node, turn, layerIndex) {
    var content = (turn.nodes || {})[node.id] || null;
    var slots = content && content.slots ? Object.keys(content.slots).map(function (key) {
      return '<span class="v2-slot"><b>' + esc(SLOT_LABELS[key] || key) + '</b>' + esc(content.slots[key]) + '</span>';
    }).join('') : '';
    var body = content && content.filled
      ? '<p>' + esc(content.filled) + '</p>'
      : '<p class="v2-muted">' + (turn.ai && turn.ai.degraded ? '本节点等待 AI 分析。' : '分析中…') + '</p>';
    var extra = node.id === 'citta-vithi' ? vithiHtml(turn, content) : '';
    var cites = content && content.evidence_ids && content.evidence_ids.length
      ? '<div class="v2-node-cites">' + content.evidence_ids.length + ' 条引文</div>' : '';
    return '<article class="v2-node' + (node.branching ? ' branching' : '') + '" data-node="' + esc(node.id) + '" data-layer="' + layerIndex + '">'
      + '<header><span class="v2-node-label">' + esc(node.label) + '</span>'
      + (node.pali ? '<span class="v2-node-pali">' + esc(node.pali) + '</span>' : '') + '</header>'
      + (slots ? '<div class="v2-slots">' + slots + '</div>' : '') + body + extra + cites + '</article>';
  }
  function flowHtml(turn, turnIndex) {
    var topology = topologyFor(turn);
    var rows = topology.layers.map(function (layer, index) {
      return '<div class="v2-layer" data-layer="' + index + '" style="--cols:' + layer.nodes.length + '">'
        + layer.nodes.map(function (node) { return nodeHtml(node, turn, index); }).join('')
        + '</div>';
    }).join('');
    return '<div class="v2-flow" data-turn="' + turnIndex + '"><svg class="v2-wires" aria-hidden="true"></svg>' + rows + '</div>';
  }

  /* 分支：行动节点在渲染时暂停，让用户选一条或改写，选定后作为本轮输出。 */
  function choiceHtml(turn, turnIndex) {
    var topology = topologyFor(turn);
    var branching = [];
    topology.layers.forEach(function (layer) {
      layer.nodes.forEach(function (node) {
        var content = (turn.nodes || {})[node.id];
        if (node.branching && content && content.options && content.options.length) branching.push({node:node, content:content});
      });
    });
    if (!branching.length) return '';
    if (turn.chosen_action) {
      return '<div class="v2-card v2-chosen"><h3>本轮选择的行动</h3><p>' + esc(turn.chosen_action) + '</p>'
        + '<span class="v2-muted">下一轮请在最下方输入对方真实的回应，或自己新生起的心理活动。</span></div>';
    }
    return '<div class="v2-card v2-choice" data-choice="' + turnIndex + '"><h3>选择这一轮实际要做的行动</h3>'
      + branching.map(function (item) {
          return '<fieldset><legend>' + esc(item.node.label) + '</legend>'
            + item.content.options.map(function (option, i) {
                return '<label class="v2-option"><input type="radio" name="act-' + turnIndex + '" value="' + esc(option) + '"' + (i === 0 && item === branching[0] ? ' checked' : '') + '><span>' + esc(option) + '</span></label>';
              }).join('') + '</fieldset>';
        }).join('')
      + '<label class="v2-rewrite">改写为你实际要做的（可留空沿用上面所选）<input type="text" data-action-text placeholder="例如：我先说『我想确认你的意思』"></label>'
      + '<button class="primary" data-confirm-action>确定这个行动</button></div>';
  }

  function turnHtml(turn, index) {
    var obs = turn.observation || {};
    var evidenceStatus = turn.evidence_status && !turn.evidence_status.available ? '<div class="v2-alert" role="status"><strong>本地引文库状态</strong><span>' + esc(turn.evidence_status.message || '请稍后重试。') + '</span></div>' : '';
    var notice = turn.ai && turn.ai.degraded && !turn.ai.pending
      ? '<div class="v2-alert" role="status"><strong>逐节点分析未生成</strong><span>' + esc(turn.ai.message || 'AI 分析暂不可用；流程结构与引文仍可审阅。') + '</span></div>'
      : '';
    return '<div class="v2-message v2-user"><strong>第 ' + (index + 1) + ' 轮 · 你的输入</strong><div>' + esc(turn.observation && turn.observation.raw || '') + '</div></div>'
      + '<div class="v2-message v2-assistant"><div class="v2-toolbar"><strong>过程分析</strong><span class="v2-muted">' + esc(turn.model_version || state.model) + '</span></div>'
      + factHtml(obs) + evidenceStatus + notice + flowHtml(turn, index) + choiceHtml(turn, index)
      + '<details class="v2-card"><summary>本轮 V4 引文（' + ((turn.evidence || []).length) + ' 条）</summary>' + evidenceHtml(turn.evidence) + '</details></div>';
  }

  /* 连线：在每个 .v2-flow 上按实际盒模型画层间折线与回环。 */
  function drawConnectors(flow) {
    var svg = flow.querySelector('.v2-wires');
    if (!svg) return;
    var box = flow.getBoundingClientRect();
    if (!box.width) return;
    svg.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    var layers = [].slice.call(flow.querySelectorAll('.v2-layer'));
    var parts = ['<defs><marker id="v2-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#a99a87"/></marker></defs>'];
    function rect(el) { var r = el.getBoundingClientRect(); return { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height, cx: r.left - box.left + r.width / 2, bottom: r.top - box.top + r.height }; }
    for (var i = 0; i < layers.length - 1; i++) {
      var from = [].slice.call(layers[i].querySelectorAll('.v2-node')).map(rect);
      var to = [].slice.call(layers[i + 1].querySelectorAll('.v2-node')).map(rect);
      var gapTop = Math.max.apply(null, from.map(function (r) { return r.bottom; }));
      var gapBottom = Math.min.apply(null, to.map(function (r) { return r.top; }));
      var mid = (gapTop + gapBottom) / 2;
      from.forEach(function (a) { parts.push('<path d="M' + a.cx + ',' + a.bottom + ' V' + mid + '" />'); });
      to.forEach(function (b) { parts.push('<path d="M' + b.cx + ',' + mid + ' V' + (b.top - 3) + '" marker-end="url(#v2-arrow)" />'); });
      if (from.length > 1 || to.length > 1) {
        var xs = from.map(function (r) { return r.cx; }).concat(to.map(function (r) { return r.cx; }));
        parts.push('<path d="M' + Math.min.apply(null, xs) + ',' + mid + ' H' + Math.max.apply(null, xs) + '" />');
      }
    }
    // 戏论想念 → 寻 的回环：从右侧绕回，表示反复推演而非线性终点
    var loopFrom = flow.querySelector('[data-node="papanca-sanna-sankha"]');
    var loopTo = flow.querySelector('[data-node="thinking"]');
    if (loopFrom && loopTo) {
      var a = rect(loopFrom), b = rect(loopTo);
      var x = Math.max(a.left + a.width, b.left + b.width) + 26;
      parts.push('<path class="loop" d="M' + (a.left + a.width) + ',' + (a.top + a.height / 2) + ' H' + x + ' V' + (b.top + b.height / 2) + ' H' + (b.left + b.width + 3) + '" marker-end="url(#v2-arrow)" />');
      parts.push('<text class="loop-label" x="' + (x + 5) + '" y="' + ((a.top + b.top) / 2) + '">反复推演</text>');
    }
    svg.innerHTML = parts.join('');
  }
  function drawAllConnectors(app) {
    [].slice.call(app.querySelectorAll('.v2-flow')).forEach(drawConnectors);
  }

  /* 逐层流出：自动一层一层淡入，遇到需要选择的行动层就停下。 */
  function revealLayers(app) {
    var flows = [].slice.call(app.querySelectorAll('.v2-flow'));
    flows.forEach(function (flow, flowIndex) {
      var layers = [].slice.call(flow.querySelectorAll('.v2-layer'));
      var isLatest = flowIndex === flows.length - 1;
      layers.forEach(function (layer, index) {
        if (!isLatest) { layer.classList.add('shown'); return; }
        setTimeout(function () {
          layer.classList.add('shown');
          drawConnectors(flow);
          if (index === layers.length - 1) {
            var choice = app.querySelector('.v2-choice');
            if (choice) choice.classList.add('shown');
          }
        }, 140 * index);
      });
    });
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
  function shard(id, data) { if (bundle.shards[id]) return bundle.shards[id]; var runtime = (data.runtime_files && data.runtime_files[id] && data.runtime_files[id].file) || ('runtime/' + id + '.json.gz'); bundle.shards[id] = fetchJson(EVIDENCE_BASE + '/' + runtime).catch(function () { return fetchJson(EVIDENCE_BASE + '/' + data.files[id].file); }); return bundle.shards[id]; }
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

  // Local placeholder turn: correct topology, no fabricated per-node content.
  function localTurn(message, selected, reason) {
    return {
      schema_version:'personhood-interaction/v2',
      model_version:state.model,
      observation:observe(message),
      evidence_status:{available:selected.rows.length>0, message:reason||'本轮引文从已保存的本地 V4 引文库抽取。'},
      topology:(global.PersonhoodStages ? global.PersonhoodStages.build(state.model) : {layers:[],edges:[]}),
      nodes:{},
      evidence:selected.rows,
      ai:{enabled:false,degraded:false,pending:true},
      evidence_bundle_version:selected.version
    };
  }

  function render() {
    var app = document.getElementById('app');
    if (!app) return;
    load();
    var turns = state.turns.map(turnHtml).join('');
    app.innerHTML = '<div class="personhood-lab personhood-v2"><div class="v2-chat">'
      + '<div class="v2-hero"><div class="v2-kicker">V4 STATIC CITATIONS · INTERACTION LAB</div>'
      + '<h2>有情互动与经验形成实验室</h2>'
      + '<p class="v2-subtitle">输入一个真实发生的现象。系统抽取 V4 引文，按门、触、受、想、寻、戏论、爱、取、有到身语意行动逐层推演；每一层只呈现这一轮的具体内容。</p>'
      + '<div class="v2-toolbar"><div class="v2-segment">'
      + '<button class="' + (state.model === 'pali-canonical/v2' ? 'active' : '') + '" data-model="pali-canonical/v2">经律原典版</button>'
      + '<button class="' + (state.model === 'theravada-synthesis/v2' ? 'active' : '') + '" data-model="theravada-synthesis/v2">分层整合版</button>'
      + '</div><div><button data-new>新案例</button><button data-research>证据研究</button></div></div></div>'
      + '<main>'
      + (turns || '<section class="v2-card"><p class="v2-muted">尚未开始。在下方输入“看见……”“听见……”“别人对我说……”等实际现象即可。</p></section>')
      + '<section class="v2-card v2-input-card"><h3>输入新的交互现象</h3>'
      + '<textarea data-input placeholder="可以是对方的回应，也可以是自己内心新生起的心理活动。例如：听见别人说‘你怎么总是这样’，我觉得对方在否定我……"></textarea>'
      + '<div class="v2-toolbar"><span class="v2-muted" data-status>每次只推进真实的新反馈；不替对方编造心理。</span>'
      + '<button class="primary" data-send>分析这一轮</button></div></section>'
      + '<section class="v2-card"><button data-save>保存到我的账户</button><span class="v2-status" data-save-status>新案例先保存在此浏览器；登录后可主动保存。</span></section>'
      + methodHtml() + '</main></div></div>';

    app.querySelectorAll('[data-model]').forEach(function (button) { button.addEventListener('click', function () { state.model = button.getAttribute('data-model'); persist(); render(); }); });
    app.querySelector('[data-new]').addEventListener('click', function () { state.turns=[]; state.savedCaseId=null; state.selectedPath=null; state.selectedAction=null; persist(); render(); });
    app.querySelector('[data-research]').addEventListener('click', function () { global.location.hash = '#/personhood/research'; if (global.renderPersonhoodResearch) global.renderPersonhoodResearch(); });
    app.querySelector('[data-send]').addEventListener('click', send);
    var confirmBtn = app.querySelector('[data-confirm-action]');
    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      var card = confirmBtn.closest('.v2-choice');
      var typed = card.querySelector('[data-action-text]').value.trim();
      var picked = card.querySelector('input[type=radio]:checked');
      var chosen = typed || (picked ? picked.value : '');
      if (!chosen) return;
      state.turns[state.turns.length - 1].chosen_action = chosen;
      state.selectedAction = chosen;
      persist();
      render();
    });
    app.querySelector('[data-save]').addEventListener('click', save);
    revealLayers(app);
    requestAnimationFrame(function () { drawAllConnectors(app); });
  }

  function send() {
    var app = document.getElementById('app');
    var input = app.querySelector('[data-input]');
    var message = input.value.trim();
    if (!message) return;
    var status = app.querySelector('[data-status]');
    // Per-node analysis is an authenticated, metered call; ask up front rather
    // than silently handing back the structure with every node empty.
    Promise.resolve(global.communityRequireLogin ? global.communityRequireLogin() : true).then(function (ok) {
      if (!ok) { status.textContent = '需要登录后才能生成逐节点分析。'; return; }
      status.textContent = '正在抽取引文并逐层分析…';
      // Citations enrich the turn; they are not a precondition for it. If the
      // static bundle is unreachable, carry on with none rather than leaving
      // the user with no analysis at all.
      return selectEvidence(message, state.model).catch(function (error) {
        return { version: 'personhood-evidence/v1', rows: [], error: error.message };
      }).then(function (selected) {
        var request = {
          message: message, model_version: state.model, conversation_id: 'local-personhood-v2',
          parent_turn_id: state.turns.length ? 'turn-' + state.turns.length : null,
          selected_path: state.selectedPath, selected_action: state.selectedAction,
          previous_observations: state.turns.map(function (t) { return t.observation && t.observation.raw; }).slice(-12),
          evidence_bundle_version: selected.version, selected_evidence: selected.rows
        };
        var turnIndex = state.turns.length;
        state.turns.push(localTurn(message, selected, selected.error ? ('本地引文库暂不可用（' + selected.error + '）；逐层分析仍会进行，但本轮不附引文。') : '本轮引文从已保存的本地 V4 引文库抽取。'));
        state.selectedPath = null; state.selectedAction = null;
        input.value = '';
        persist(); render();
        return fetch(base() + '/api/personhood/v2/analyze', {method:'POST', headers:headers(), body:JSON.stringify(request)})
          .then(function (response) {
            return response.text().then(function (raw) {
              var data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
              if (!response.ok) {
                var detail = data.detail || '';
                if (response.status === 401) detail = '登录状态已失效，请重新登录后再试。';
                if (response.status === 402) detail = detail || '免费额度已用完，逐节点分析暂时无法生成。';
                var err = new Error(detail || ('分析失败（HTTP ' + response.status + '）'));
                throw err;
              }
              return data;
            });
          })
          .then(function (data) { if (data.turn) { state.turns[turnIndex] = data.turn; persist(); render(); } })
          .catch(function (error) {
            var current = state.turns[turnIndex];
            if (current) { current.ai = {enabled:false, degraded:true, pending:false, message:error.message}; persist(); render(); }
          });
      });
    }).catch(function (error) { status.textContent = '本地引文库暂不可用：' + error.message; });
  }

  function save() {
    var app = document.getElementById('app');
    var status = app.querySelector('[data-save-status]');
    if (!state.turns.length) { status.textContent='请先完成至少一轮。'; return; }
    if (!base() || !global.localStorage.getItem('sutta_token')) { status.textContent='当前未登录；案例已安全保存在此浏览器。'; return; }
    var snapshot={schema_version:'personhood-interaction/v2',case_kind:'pali-personhood-chat-case',model_version:state.model,turns:state.turns,evidence_scope:'personhood-evidence/v1'};
    var url=base()+'/api/personhood/cases'+(state.savedCaseId?'/'+encodeURIComponent(state.savedCaseId):'');
    fetch(url,{method:state.savedCaseId?'PUT':'POST',headers:headers(),body:JSON.stringify({title:'有情互动案例',snapshot:snapshot})})
      .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'save failed');return d;});})
      .then(function(d){state.savedCaseId=d.id;persist();status.textContent='已保存到账号，可在其他设备继续查看。';})
      .catch(function(){status.textContent='保存失败；本地案例仍保留，可稍后重试。';});
  }

  function renderResearch() { var app = document.getElementById('app'); if (!app) return; app.innerHTML = '<div class="personhood-lab personhood-v2"><div class="v2-chat"><div class="v2-hero"><div class="v2-kicker">RESEARCH · STATIC V4 CITATIONS</div><h2>证据与研究清单</h2><p class="v2-subtitle">固定词表在构建时完整遍历全部 217 部 V4；实验室只从版本化静态分片抽取引文。</p><button data-back>返回实验室</button></div><div class="v2-card"><h3>互动过程词表</h3><p>触、受、想、作意、寻思、戏论、爱、取、有、慢、见、随眠、身语意行动、正念、明觉与修复。</p><p class="v2-muted">完整台账保留查询词、段落、三语文本、层级与校验值；它是固定词法命中的可审计集合，不伪装为穷尽全部语义相关经文。</p></div></div></div>'; app.querySelector('[data-back]').addEventListener('click', function(){global.location.hash='#/personhood';render();}); }

  var resizeTimer;
  global.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { var app = document.getElementById('app'); if (app && app.querySelector('.v2-flow')) drawAllConnectors(app); }, 120);
  });

  global.renderPersonhoodLab = render;
  global.renderPersonhoodResearch = renderResearch;
})(window);
