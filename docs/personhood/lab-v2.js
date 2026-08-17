/* Independent V4 evidence-first personhood chat lab. No Gotama skill/state.
 *
 * Per-node analysis runs as a detached server job (app/jobs/runner.py on the
 * backend) so a triggered turn keeps generating even if this tab closes -
 * this file's job is to attach to that job's SSE stream, patch each node's
 * card in place as its own event arrives (nodes complete in whatever order
 * the model answers them, since they run concurrently), and re-attach on
 * load if a turn was still running when the reader left. aiJobConsume /
 * aiJobAttach / aiJobRemember / aiJobForget / aiJobPending are defined in
 * docs/index.html (shared with Gotama and search synthesis) - this file
 * does not reimplement SSE parsing.
 */
(function (global) {
  'use strict';
  var KEY = 'sutta-personhood-lab-v2';
  var JOB_KIND = 'personhood-analyze';
  var ITER_JOB_KIND = 'personhood-iterate';
  var EVIDENCE_BASE = 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1/personhood-evidence/v1';
  var state = { model: 'theravada-synthesis/v2', turns: [], savedCaseId: null, selectedPath: null, selectedAction: null, conversationId: null };
  var bundle = { manifest: null, shards: {} };
  var FALLBACK_API = global.location && (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1')
    ? 'http://localhost:8000'
    : 'https://sutta-api.agreeablemeadow-9da329ca.swedencentral.azurecontainerapps.io';
  function base() { return (global.SUTTA_PERSONHOOD_API_BASE || FALLBACK_API).replace(/\/$/, ''); }
  function headers() { var token = global.localStorage && global.localStorage.getItem('sutta_token'); return Object.assign({'Content-Type':'application/json'}, token ? {'Authorization':'Bearer ' + token} : {}); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function uid() { return (global.crypto && global.crypto.randomUUID) ? global.crypto.randomUUID() : ('local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)); }
  function load() { try { var item = JSON.parse(global.localStorage.getItem(KEY) || 'null'); if (item) state = Object.assign(state, item); } catch (_) {} if (!state.conversationId) state.conversationId = uid(); }
  function persist() { try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function methodHtml() { return '<details class="v2-card v2-method"><summary>证据与方法</summary><p>本实验室只把用户报告的事件、感受和推测分开处理。引文来自已发布的 V4 静态引文库：每轮只从本地分片抽取，不重新检索 Azure。经律原典版依《蜜丸经》的显式次第；分层整合版另按《摄阿毗达磨义论》并列遍一切心心所并展开完整心路。逐节点分析并发调用，可离开页面，回来后会自动接续未完成的分析。</p></details>'; }

  /* ── 引文：两级 —— 本轮各节点实际引用的并集在前，候选池折叠在后 ── */
  function evidenceRowHtml(row) {
    return '<div class="v2-evidence-item"><a href="' + esc(row.reader_url || '#') + '" target="_blank" rel="noopener">' + esc(row.title || row.work_id || 'V4 经文') + ' · ' + esc(row.paranum || ('行 ' + row.row_id)) + '</a><div>' + esc(row.snippet || row.text || '') + '</div><small class="v2-muted">第 ' + esc(row.lineage_layer || '?') + ' 层 · ' + esc(row.provenance === 'canonical' ? '经律／论藏原典' : '后期上座部系统化') + '</small></div>';
  }
  function usedEvidenceIds(turn) {
    var ids = {};
    Object.keys(turn.nodes || {}).forEach(function (nodeId) { (turn.nodes[nodeId].evidence_ids || []).forEach(function (id) { ids[id] = 1; }); });
    if (turn.citta_vithi) (turn.citta_vithi.evidence_ids || []).forEach(function (id) { ids[id] = 1; });
    (turn.papanca_cycles || []).forEach(function (cycle) { (cycle.evidence_ids || []).forEach(function (id) { ids[id] = 1; }); });
    return ids;
  }
  function evidenceSectionHtml(turn) {
    var byId = {}; (turn.evidence || []).forEach(function (row) { byId[row.evidence_id] = row; });
    var used = Object.keys(usedEvidenceIds(turn)).map(function (id) { return byId[id]; }).filter(Boolean);
    var pool = (turn.evidence || []).filter(function (row) { return !usedEvidenceIds(turn)[row.evidence_id]; });
    return '<div data-role="evidence-section">'
      + '<details class="v2-card" open><summary>本轮引用的引文（' + used.length + ' 条）</summary>'
      + (used.length ? '<div class="v2-evidence">' + used.map(evidenceRowHtml).join('') + '</div>' : '<p class="v2-muted">节点尚未引用到具体经文，或本轮没有匹配到已保存的引文；流程结构仍可作为问题拆分工具。</p>')
      + '</details>'
      + '<details class="v2-card v2-evidence-pool"><summary>候选池（' + pool.length + ' 条，未被任何节点引用）</summary>'
      + (pool.length ? '<div class="v2-evidence">' + pool.map(evidenceRowHtml).join('') + '</div>' : '<p class="v2-muted">候选池为空。</p>')
      + '</details></div>';
  }

  /* ── 观察四格：由 AI 逐条摘录原文片段分类；未生成前用离线正则兜底 ── */
  function factHtml(turn) {
    var obs = turn.observation || {};
    var labels = [['observable_events','可观察事件'],['first_person_reports','我的报告'],['attributions_not_facts','对他人的推测'],['unknown_or_needs_clarification','尚待澄清']];
    return '<div class="v2-facts" data-role="facts">' + labels.map(function (item) {
      return '<div class="v2-fact"><strong>' + item[1] + '</strong>' + esc((obs[item[0]] || []).join('；') || '—') + '</div>';
    }).join('') + '</div>';
  }

  /* ── 流程图 ──
     列数来自该层实际的节点数，所以"并列几个就几列"，前后相继的节点各占一行；
     层与层之间、以及戏论想念回到寻的回环，都由 drawConnectors() 画成真的连线。
     节点并发分析，完成顺序不定：拓扑与全部占位卡一次性画出，逐个节点事件到达
     时只替换那一张卡，不重放整段级联动画。 */
  function topologyFor(turn) {
    if (turn.topology && turn.topology.layers && turn.topology.layers.length) return turn.topology;
    return global.PersonhoodStages ? global.PersonhoodStages.build(turn.model_version || state.model) : { layers: [], edges: [] };
  }
  function vithiHtml(turn, content) {
    var chosen = turn.citta_vithi;
    var processes = global.PersonhoodStages && global.PersonhoodStages.MIND_PROCESSES;
    if (!processes) return '';
    var picked = chosen && chosen.selected_process_id;
    var finished = turn.ai && !turn.ai.pending;
    var retrying = turn._nodeRetrying && turn._nodeRetrying['citta-vithi'];
    var tail;
    if (picked && chosen.reason) tail = '<p class="v2-muted">判定依据：' + esc(chosen.reason) + '</p>';
    else if (!picked && finished) tail = '<p class="v2-muted v2-node-failed">心路判定未能生成。</p><button class="v2-retry-node" data-retry-node="citta-vithi"' + (retrying ? ' disabled' : '') + '>' + (retrying ? '重试中…' : '重试该节点') + '</button>';
    else if (!picked) tail = '<p class="v2-muted"><span class="v2-spinner" aria-hidden="true"></span>心路判定分析中…</p>';
    else tail = '';
    return '<div class="v2-vithi">' + processes.map(function (proc) {
      var active = picked ? proc.id === picked : false;
      var notes = active && chosen.step_notes ? chosen.step_notes : [];
      return '<section class="v2-mind-flow' + (active ? ' active' : picked ? ' dimmed' : '') + '">'
        + '<div><strong>' + esc(proc.label) + (active ? ' · 本轮判定' : '') + '</strong><span>' + esc(proc.applies_to) + '</span></div>'
        + '<ol>' + (proc.steps || []).map(function (step, i) {
            return '<li>' + esc(step) + (notes[i] ? '<em>' + esc(notes[i]) + '</em>' : '') + '</li>';
          }).join('') + '</ol></section>';
    }).join('') + tail + '</div>';
  }
  // Slots are rendered as a single formatted chip, not "<label>key</label>value" -
  // that two-part rendering is exactly what put a stray "type" on screen.
  function slotChipHtml(nodeId, key, value) {
    if (!value) return '';
    var text;
    if (key === 'door') text = value + '门';
    else if (key === 'valence') text = value;
    else if (key === 'object_kind') text = value + '（所缘类别）';
    else if (key === 'consciousness') text = value;
    else text = value;
    return '<span class="v2-slot">' + esc(text) + '</span>';
  }
  function nodeCiteHtml(node, turn) {
    var content = (turn.nodes || {})[node.id];
    var ids = content && content.evidence_ids || [];
    if (!ids.length) return '';
    var byId = {}; (turn.evidence || []).forEach(function (row) { byId[row.evidence_id] = row; });
    var rows = ids.map(function (id) { return byId[id]; }).filter(Boolean);
    if (!rows.length) return '';
    return '<details class="v2-node-cites"><summary>' + rows.length + ' 条引文</summary><div class="v2-evidence">' + rows.map(evidenceRowHtml).join('') + '</div></details>';
  }
  function nodeHtml(node, turn, layerIndex) {
    var isVithi = node.id === 'citta-vithi';
    var content = (turn.nodes || {})[node.id] || null;
    var finished = turn.ai && !turn.ai.pending;
    var retrying = turn._nodeRetrying && turn._nodeRetrying[node.id];
    var slots = content && content.slots ? Object.keys(content.slots).map(function (key) { return slotChipHtml(node.id, key, content.slots[key]); }).join('') : '';
    var body;
    if (isVithi) {
      // citta-vithi runs its own dedicated call (build_vithi_messages, not
      // build_node_messages) and its content lives in turn.citta_vithi, not
      // turn.nodes - vithiHtml() below owns this node's filled/failed/pending
      // states entirely, including its own retry button.
      body = '';
    } else if (content && content.filled) {
      body = '<p>' + esc(content.filled) + '</p>';
    } else if (finished) {
      // The backend already retried this node once server-side (see
      // call_model_json) before giving up - "finished with nothing" here
      // means it genuinely failed twice, not "hasn't been reached yet", so
      // this is a dead end without a manual nudge rather than a spinner.
      body = '<p class="v2-muted v2-node-failed">本节点未能生成具体内容。</p>'
        + '<button class="v2-retry-node" data-retry-node="' + esc(node.id) + '"' + (retrying ? ' disabled' : '') + '>' + (retrying ? '重试中…' : '重试该节点') + '</button>';
    } else {
      body = '<p class="v2-muted v2-pending"><span class="v2-spinner" aria-hidden="true"></span>分析中…</p>';
    }
    var extra = isVithi ? vithiHtml(turn, content) : '';
    var cites = nodeCiteHtml(node, turn);
    return '<article class="v2-node' + (node.branching ? ' branching' : '') + (content ? ' is-filled' : '') + '" data-node="' + esc(node.id) + '" data-layer="' + layerIndex + '">'
      + '<header><span class="v2-node-label">' + esc(node.label) + '</span>'
      + (node.pali ? '<span class="v2-node-pali">' + esc(node.pali) + '</span>' : '') + '</header>'
      + (slots ? '<div class="v2-slots">' + slots + '</div>' : '') + body + extra + cites + '</article>';
  }
  function flowHtml(turn) {
    var topology = topologyFor(turn);
    var rows = topology.layers.map(function (layer, index) {
      return '<div class="v2-layer shown" data-layer="' + index + '" style="--cols:' + layer.nodes.length + '">'
        + layer.nodes.map(function (node) { return nodeHtml(node, turn, index); }).join('')
        + '</div>';
    }).join('');
    return '<div class="v2-flow" data-turn-id="' + esc(turn.turn_id) + '"><svg class="v2-wires" aria-hidden="true"></svg>' + rows + '</div>';
  }

  /* ── 反复推演：戏论想念 → 寻 的回环每点一次真调一次 AI，追加一圈 ── */
  function cyclesHtml(turn, turnIndex) {
    var cycles = turn.papanca_cycles || [];
    var busy = turn._cycleBusy;
    var rows = cycles.map(function (cycle) {
      return '<div class="v2-cycle"><b>第 ' + cycle.index + ' 圈</b>'
        + '<span>寻：' + esc(cycle.thinking || '—') + '</span>'
        + '<span>戏论：' + esc(cycle.papanca || '—') + '</span>'
        + '<span>戏论想念：' + esc(cycle.papanca_sanna_sankha || '—') + '</span></div>';
    }).join('');
    var canIterate = turn.ai && !turn.ai.pending;
    return '<div class="v2-card v2-cycles" data-role="cycles"><h3>反复推演（戏论想念 → 寻）</h3>'
      + (rows || '<p class="v2-muted">尚未推演。点击下方按钮，让 AI 在已有内容基础上再具体推演一圈，不会重复已有内容。</p>')
      + '<button class="' + (busy ? '' : 'primary') + '" data-iterate="' + turnIndex + '"' + (busy || !canIterate ? ' disabled' : '') + '>' + (busy ? '推演中…' : '再推演一轮') + '</button></div>';
  }

  /* ── 分支：语业、身业各自独立选择/改写/不采取；确认后作为本轮输出 ──
     节点始终没能生成可选项时（重试也救不回来），直接退化为纯文本输入框，
     不让"选择行动"这一步卡在一个永远等不到选项的节点上。 */
  function branchGroupHtml(turnIndex, node, content, chosen, finished, retrying) {
    var options = (content && content.options) || [];
    var current = chosen ? chosen[node.id === 'speech-kamma' ? 'speech' : 'body'] : null;
    if (current !== null && current !== undefined) {
      return '<fieldset class="v2-choice-done"><legend>' + esc(node.label) + '</legend><p>' + (current ? esc(current) : '（本轮不采取）') + '</p></fieldset>';
    }
    var field = node.id === 'speech-kamma' ? 'speech' : 'body';
    if (options.length) {
      return '<fieldset data-field="' + field + '"><legend>' + esc(node.label) + '</legend>'
        + options.map(function (option, i) {
            return '<label class="v2-option"><input type="radio" name="act-' + turnIndex + '-' + field + '" value="' + esc(option) + '"' + (i === 0 ? ' checked' : '') + '><span>' + esc(option) + '</span></label>';
          }).join('')
        + '<label class="v2-option"><input type="radio" name="act-' + turnIndex + '-' + field + '" value=""><span>不采取</span></label>'
        + '<input type="text" data-action-text="' + field + '" placeholder="改写为你实际要做的（可留空沿用上面所选）">'
        + '</fieldset>';
    }
    return '<fieldset data-field="' + field + '" class="v2-choice-plain"><legend>' + esc(node.label) + '</legend>'
      + '<p class="v2-muted">未能为该分支生成预设选项，可直接写下你实际要做的（留空＝不采取）。</p>'
      + '<input type="text" data-action-text="' + field + '" placeholder="例如：先说这句…">'
      + (finished ? '<button type="button" class="v2-retry-node-small" data-retry-node="' + esc(node.id) + '"' + (retrying ? ' disabled' : '') + '>重试生成选项</button>' : '')
      + '</fieldset>';
  }
  function choiceHtml(turn, turnIndex) {
    var topology = topologyFor(turn);
    var branching = [];
    topology.layers.forEach(function (layer) {
      layer.nodes.forEach(function (node) {
        if (node.branching) branching.push(node);
      });
    });
    if (!branching.length) return '';
    if (turn.chosen_action) {
      var speech = turn.chosen_action.speech, body = turn.chosen_action.body;
      var lines = [];
      if (speech) lines.push('<div><b>语业：</b>' + esc(speech) + '</div>');
      if (body) lines.push('<div><b>身业：</b>' + esc(body) + '</div>');
      if (!speech && !body) lines.push('<div class="v2-muted">本轮不采取身语行动。</div>');
      return '<div class="v2-card v2-chosen" data-role="choice"><h3>本轮选择的行动</h3>' + lines.join('')
        + '<span class="v2-muted">下一轮请在最下方输入对方真实的回应，或自己新生起的心理活动。</span></div>';
    }
    // Waiting only blocks on the job actually still running - never on
    // whether these two specific nodes happened to come back yet. Once
    // turn.ai.pending is false the job is truly done (including its
    // built-in per-node retry), so a still-missing node at this point is a
    // permanent miss, not a "not yet" - branchGroupHtml degrades that node
    // to a plain text field instead of blocking the whole panel forever.
    var pending = turn.ai && turn.ai.pending;
    if (pending) return '<div class="v2-card v2-choice-loading" data-role="choice"><p class="v2-muted"><span class="v2-spinner" aria-hidden="true"></span>正在并发生成语业与身业…</p></div>';
    var finished = true;
    return '<div class="v2-card v2-choice" data-role="choice" data-choice="' + turnIndex + '"><h3>选择这一轮实际要做的行动（语业、身业可分别选择或改写，也可都不采取）</h3>'
      + branching.map(function (node) { return branchGroupHtml(turnIndex, node, (turn.nodes || {})[node.id], null, finished, turn._nodeRetrying && turn._nodeRetrying[node.id]); }).join('')
      + '<button class="primary" data-confirm-action="' + turnIndex + '">确定这一轮的行动</button></div>';
  }

  function statusBarHtml(turn) {
    var pending = turn.ai && turn.ai.pending;
    var total = turn.total || 0, completed = turn.completed || 0;
    var elapsed = (turn.elapsed_s != null ? turn.elapsed_s : 0).toFixed(1);
    if (!pending && turn.ai) {
      return '<div class="v2-status-bar done" data-role="status">第 ' + (turn._displayIndex + 1) + ' 轮 · 已用 ' + elapsed + 's · ' + (turn.ai.enabled ? '分析完成' : '未能生成逐节点分析') + '</div>';
    }
    return '<div class="v2-status-bar" data-role="status"><span class="v2-spinner" aria-hidden="true"></span>第 ' + (turn._displayIndex + 1) + ' 轮 · 已用 ' + elapsed + 's' + (total ? ' · 节点 ' + completed + '/' + total + ' 完成' : ' · 正在并发分析…') + '</div>';
  }

  function turnHtml(turn, index) {
    turn._displayIndex = index;
    var evidenceStatus = turn.evidence_status && !turn.evidence_status.available ? '<div class="v2-alert" role="status"><strong>本地引文库状态</strong><span>' + esc(turn.evidence_status.message || '请稍后重试。') + '</span></div>' : '';
    var notice = turn.ai && turn.ai.degraded && !turn.ai.pending
      ? '<div class="v2-alert" role="status" data-role="ai-banner"><strong>逐节点分析未生成</strong><span>' + esc(turn.ai.message || 'AI 分析暂不可用；流程结构与引文仍可审阅。') + '</span></div>'
      : '<div data-role="ai-banner"></div>';
    return '<div class="v2-message v2-user"><strong>第 ' + (index + 1) + ' 轮 · 你的输入</strong><div>' + esc(turn.observation && turn.observation.raw || turn.message || '') + '</div></div>'
      + '<div class="v2-message v2-assistant">' + statusBarHtml(turn) + '<div class="v2-toolbar"><strong>过程分析</strong><span class="v2-muted">' + esc(turn.model_version || state.model) + '</span></div>'
      + factHtml(turn) + evidenceStatus + notice + flowHtml(turn) + cyclesHtml(turn, index) + choiceHtml(turn, index)
      + evidenceSectionHtml(turn) + '</div>';
  }

  /* ── 连线：在每个 .v2-flow 上按实际盒模型画层间折线与回环 ── */
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
      if (!from.length || !to.length) continue;
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
  // Sort by real term overlap with what the user actually wrote, not by
  // "does the whole sentence appear verbatim" (which almost never fires) -
  // and keep the candidate pool small since the prompt only needs ~12 rows
  // per node call, not 48.
  function wordOverlapScore(message, row) {
    var text = String(message || '');
    var chars = {}; for (var i = 0; i < text.length - 1; i++) chars[text.slice(i, i + 2)] = 1;
    var hay = String(row.snippet || row.text || '');
    var score = 0;
    Object.keys(chars).forEach(function (bigram) { if (hay.indexOf(bigram) >= 0) score += 1; });
    return score;
  }
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
        var list = Object.keys(rows).map(function (id) { return rows[id]; });
        list.sort(function (a, b) {
          function score(row) { var directScore = direct[row.work_id + ':' + row.row_id] ? 10000 : 0; var conceptScore = (row.concept_ids || []).filter(function (id) { return concepts.indexOf(id) >= 0; }).length * 100; return directScore + conceptScore + wordOverlapScore(message, row); }
          return score(b) - score(a) || String(a.evidence_id).localeCompare(String(b.evidence_id));
        });
        return {version:data.version, rows:list.slice(0, 16)};
      });
    });
  }
  function observe(message) { var text = String(message || '').trim(); var parts = text.split(/[，。！？；;]+/).filter(Boolean); var facts = parts.filter(function (part) { return /看见|看到|听见|听到|发生|别人对我做|别人对我说|对方说|他说|她说|讨论法义/.test(part); }); var reports = parts.filter(function (part) { return /我觉得|我感到|我感觉|我想|我害怕|我生气|我希望|我担心|胸口发紧|心里发紧|身体发紧|发紧/.test(part); }); var attribution = parts.filter(function (part) { return /他想|她想|对方想|针对我|看不起我|讨厌我|故意|要害我|评价我|否定我|轻视我/.test(part); }); return {raw:text,observable_events:facts,first_person_reports:reports,attributions_not_facts:attribution,unknown_or_needs_clarification:(facts.length||reports.length||attribution.length)?parts.filter(function(part){return facts.indexOf(part)<0&&reports.indexOf(part)<0&&attribution.indexOf(part)<0;}):[text]}; }

  function newTurn(message, modelVersion) {
    return {
      turn_id: uid(), message: message, model_version: modelVersion,
      observation: observe(message), topology: (global.PersonhoodStages ? global.PersonhoodStages.build(modelVersion) : {layers:[],edges:[]}),
      nodes: {}, citta_vithi: null, papanca_cycles: [], chosen_action: null,
      evidence: [], evidence_status: null, ai: {enabled:false, degraded:false, pending:true},
      total: null, completed: 0, elapsed_s: 0, started_at: Date.now(), job_id: null,
    };
  }

  /* ── 顶部计时：进行中的轮次每秒刷新一次已用时长，不等事件到达也在走 ── */
  var tickTimer = null;
  function ensureTicking(app) {
    clearInterval(tickTimer);
    tickTimer = setInterval(function () {
      var pendingTurn = state.turns[state.turns.length - 1];
      if (!pendingTurn || !pendingTurn.ai || !pendingTurn.ai.pending) { clearInterval(tickTimer); return; }
      pendingTurn.elapsed_s = (Date.now() - pendingTurn.started_at) / 1000;
      var bar = app.querySelector('.v2-message:last-of-type [data-role="status"]');
      if (bar) bar.outerHTML = statusBarHtml(pendingTurn);
    }, 500);
  }

  /* ── 增量патch：单个事件只替换它对应的那一小块 DOM，不重跑整段渲染 ── */
  function turnBlockEl(app, turnIndex) {
    var flows = app.querySelectorAll('.v2-flow');
    var flow = flows[turnIndex];
    return flow ? flow.closest('.v2-assistant') : null;
  }
  function patchNode(app, turnIndex, turn, nodeId) {
    var flow = app.querySelectorAll('.v2-flow')[turnIndex];
    if (!flow) return;
    var el = flow.querySelector('[data-node="' + nodeId + '"]');
    if (!el) return;
    var topology = topologyFor(turn);
    var node = null, layerIndex = 0;
    topology.layers.forEach(function (layer, index) { layer.nodes.forEach(function (n) { if (n.id === nodeId) { node = n; layerIndex = index; } }); });
    if (!node) return;
    var temp = document.createElement('div');
    temp.innerHTML = nodeHtml(node, turn, layerIndex);
    el.replaceWith(temp.firstElementChild);
    drawConnectors(flow);
  }
  function patchRegion(block, selector, html) {
    if (!block) return;
    var el = block.querySelector(selector);
    if (el) el.outerHTML = html;
  }
  function patchTurn(app, turnIndex, turn, changed) {
    var block = turnBlockEl(app, turnIndex);
    if (!block) return;
    if (changed === 'facts' || changed === 'final') patchRegion(block, '[data-role="facts"]', factHtml(turn));
    if (changed === 'node' || changed === 'vithi' || changed === 'final') {
      patchRegion(block, '[data-role="choice"]', choiceHtml(turn, turnIndex));
      patchRegion(block, '[data-role="evidence-section"]', evidenceSectionHtml(turn));
      var cyclesEl = block.querySelector('[data-role="cycles"]');
      if (cyclesEl) cyclesEl.outerHTML = cyclesHtml(turn, turnIndex);
    }
    var bar = block.querySelector('[data-role="status"]');
    if (bar) bar.outerHTML = statusBarHtml(turn);
    if (changed === 'final') {
      var banner = block.querySelector('[data-role="ai-banner"]');
      if (banner) banner.outerHTML = (turn.ai && turn.ai.degraded && !turn.ai.pending
        ? '<div class="v2-alert" role="status" data-role="ai-banner"><strong>逐节点分析未生成</strong><span>' + esc(turn.ai.message || 'AI 分析暂不可用；流程结构与引文仍可审阅。') + '</span></div>'
        : '<div data-role="ai-banner"></div>');
    }
    bindTurnEvents(app, turnIndex);
  }

  /* ── SSE 事件处理：把每个到达的事件落到对应的轮次和 DOM 区域 ──
     node 事件经一个 rAF 节流队列：并发节点各自完成的时间很接近，网络层
     可能把好几个 SSE 帧一起交给同一次 read()，这时同步处理全部事件会在
     浏览器来不及重绘的情况下把它们全部呈现出来，观感上像是"一次性冒出
     全部结果"。这里把 node 事件放进队列，每帧只处理一个，不管网络怎么
     打包都能看到逐个点亮；job/observation/vithi/final/error 这类只出现
     一次的关键事件不进队列，立即处理，不被节流拖慢。 */
  function analyzeHandler(app, turnIndex) {
    var nodeQueue = [];
    var rafScheduled = false;
    var raf = global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); };
    function applyNodeEvent(evt) {
      var turn = state.turns[turnIndex];
      if (!turn) return;
      if (evt.node) turn.nodes[evt.node_id] = evt.node;
      turn.completed = evt.completed; turn.total = evt.total; turn.elapsed_s = evt.elapsed_s;
      persist();
      patchNode(app, turnIndex, turn, evt.node_id);
      patchTurn(app, turnIndex, turn, 'node');
    }
    function drainOne() {
      rafScheduled = false;
      var evt = nodeQueue.shift();
      if (evt) applyNodeEvent(evt);
      if (nodeQueue.length) scheduleDrain();
    }
    function scheduleDrain() {
      if (rafScheduled) return;
      rafScheduled = true;
      raf(drainOne);
    }
    return function (evt) {
      var turn = state.turns[turnIndex];
      if (!turn) return;
      if (evt.type === 'job') {
        turn.job_id = evt.job_id;
        turn.topology = evt.topology || turn.topology;
        turn.evidence = evt.evidence || [];
        turn.evidence_bundle_version = evt.evidence_bundle_version;
        turn.evidence_status = evt.evidence_status;
        if (!turn.observation || !turn.observation.raw) turn.observation = evt.observation_fallback || turn.observation;
        aiJobRemember(JOB_KIND, evt.job_id, state.conversationId);
        persist();
        var flow = app.querySelectorAll('.v2-flow')[turnIndex];
        if (flow) { flow.outerHTML = flowHtml(turn); drawConnectors(app.querySelectorAll('.v2-flow')[turnIndex]); }
        patchTurn(app, turnIndex, turn, 'facts');
      } else if (evt.type === 'observation') {
        if (evt.observation) turn.observation = evt.observation;
        turn.completed = evt.completed; turn.total = evt.total; turn.elapsed_s = evt.elapsed_s;
        persist();
        patchTurn(app, turnIndex, turn, 'facts');
      } else if (evt.type === 'vithi') {
        turn.citta_vithi = evt.citta_vithi;
        turn.completed = evt.completed; turn.total = evt.total; turn.elapsed_s = evt.elapsed_s;
        persist();
        patchNode(app, turnIndex, turn, 'citta-vithi');
        patchTurn(app, turnIndex, turn, 'vithi');
      } else if (evt.type === 'node') {
        nodeQueue.push(evt);
        scheduleDrain();
      } else if (evt.type === 'final') {
        nodeQueue.length = 0; // the final snapshot below supersedes anything still queued
        if (evt.nodes) turn.nodes = evt.nodes;
        if (evt.observation) turn.observation = evt.observation;
        if (evt.citta_vithi) turn.citta_vithi = evt.citta_vithi;
        turn.ai = evt.ai || {enabled:false, degraded:true, pending:false};
        turn.elapsed_s = evt.elapsed_s;
        turn.completed = turn.total || turn.completed;
        aiJobForget(JOB_KIND);
        persist();
        var flow2 = app.querySelectorAll('.v2-flow')[turnIndex];
        if (flow2) { flow2.outerHTML = flowHtml(turn); drawConnectors(app.querySelectorAll('.v2-flow')[turnIndex]); }
        patchTurn(app, turnIndex, turn, 'final');
      } else if (evt.type === 'error') {
        nodeQueue.length = 0;
        turn.ai = {enabled:false, degraded:true, pending:false, message: evt.detail};
        aiJobForget(JOB_KIND);
        persist();
        patchTurn(app, turnIndex, turn, 'final');
      }
    };
  }

  async function runAnalyze(app, turnIndex, request) {
    var status = app.querySelector('[data-status]');
    var handler = analyzeHandler(app, turnIndex);
    try {
      var res = await fetch(base() + '/api/personhood/v2/analyze', {method:'POST', headers:headers(), body:JSON.stringify(request)});
      if (!res.ok) {
        var data = {}; try { data = await res.json(); } catch (_) {}
        var detail = data.detail || '';
        if (res.status === 401) detail = '登录状态已失效，请重新登录后再试。';
        if (res.status === 402) detail = detail || '免费额度已用完，逐节点分析暂时无法生成。';
        throw new Error(detail || ('分析失败（HTTP ' + res.status + '）'));
      }
      await aiJobConsume(res, handler);
    } catch (error) {
      var turn = state.turns[turnIndex];
      if (turn && turn.ai && turn.ai.pending) { turn.ai = {enabled:false, degraded:true, pending:false, message: error.message}; persist(); patchTurn(app, turnIndex, turn, 'final'); }
      if (status) status.textContent = '本轮分析出错：' + error.message;
    }
  }

  /* ── 离开页面再回来：自动接续未完成的分析（不重新触发、不重新计费） ── */
  // Deliberately does not filter by status: a job that finished *while the
  // reader was away* is exactly the case this whole feature exists for, and
  // /api/ai-jobs/{id}/stream (via aiJobAttach) replays a "done" job's full
  // event log just as readily as it follows a "running" one live - the only
  // wrong move here would be treating "already finished" as "give up".
  async function findPendingJob() {
    var local = global.aiJobPending ? global.aiJobPending(JOB_KIND) : null;
    if (local && local.ref === state.conversationId) return local;
    try {
      var res = await fetch(base() + '/api/ai-jobs/latest?kind=' + encodeURIComponent(JOB_KIND) + '&ref=' + encodeURIComponent(state.conversationId), {headers: headers()});
      if (!res.ok) return null;
      var data = await res.json();
      var job = data.job;
      if (!job) return null;
      return {job_id: job.id, ref: job.ref};
    } catch (_) { return null; }
  }
  async function resumeIfPending(app) {
    var last = state.turns[state.turns.length - 1];
    if (!last || !last.ai || !last.ai.pending) return;
    var pending = await findPendingJob();
    if (!pending) { last.ai = {enabled:false, degraded:true, pending:false, message:'离开期间未能确认分析状态，请重新发起本轮。'}; persist(); patchTurn(app, state.turns.length - 1, last, 'final'); return; }
    var handler = analyzeHandler(app, state.turns.length - 1);
    try { await global.aiJobAttach(pending.job_id, handler); }
    catch (error) { last.ai = {enabled:false, degraded:true, pending:false, message: error.message}; persist(); patchTurn(app, state.turns.length - 1, last, 'final'); }
  }

  function render(skipResume) {
    var app = document.getElementById('app');
    if (!app) return;
    load();
    var turns = state.turns.map(turnHtml).join('');
    app.innerHTML = '<div class="personhood-lab personhood-v2"><div class="v2-chat">'
      + '<div class="v2-hero"><div class="v2-kicker">V4 STATIC CITATIONS · INTERACTION LAB</div>'
      + '<h2>有情互动与经验形成实验室</h2>'
      + '<p class="v2-subtitle">输入一个真实发生的现象。系统并发调用 AI 为门、触、受、想、寻、戏论、爱、取、有到身语意行动逐节点具体分析；节点独立完成，可离开页面，回来后自动接续。</p>'
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
    app.querySelector('[data-new]').addEventListener('click', function () { state.turns=[]; state.savedCaseId=null; state.selectedPath=null; state.selectedAction=null; state.conversationId=uid(); persist(); render(); });
    app.querySelector('[data-research]').addEventListener('click', function () { global.location.hash = '#/personhood/research'; if (global.renderPersonhoodResearch) global.renderPersonhoodResearch(); });
    app.querySelector('[data-send]').addEventListener('click', send);
    app.querySelector('[data-save]').addEventListener('click', save);
    for (var i = 0; i < state.turns.length; i++) bindTurnEvents(app, i);
    drawAllConnectors(app);
    ensureTicking(app);
    // Expanding any <details> (a node's citation list, the candidate pool,
    // 证据与方法…) changes layout height without going through patchNode/
    // patchTurn, so the connectors drawn for the old layout would otherwise
    // stay put and visibly detach from the cards they're supposed to point
    // at. `toggle` does not bubble, so this has to be a capture-phase
    // listener on an ancestor that survives every re-render - `app` itself
    // is never replaced (render() only replaces its innerHTML), so binding
    // this once here covers every turn without rebinding per patch.
    if (!app.dataset.toggleBound) {
      app.dataset.toggleBound = '1';
      app.addEventListener('toggle', function (event) {
        var flow = event.target.closest && event.target.closest('.v2-flow');
        if (flow) drawConnectors(flow);
      }, true);
    }
    // Input is deliberately last in the DOM (below every recorded turn) so
    // each new round is entered where the reader's eye already is, after
    // reading what just happened - not back at the top of the page.
    //
    // Skipped right after send() pushes a fresh turn: that caller is about
    // to create the job itself, and resuming here too would race it into a
    // second concurrent SSE attach to the same job.
    if (!skipResume) resumeIfPending(app);
  }

  // Delegated on the stable .v2-assistant block rather than on the buttons
  // themselves: choice/iterate regions get replaced wholesale via outerHTML
  // on every SSE event (see patchTurn), which would otherwise silently
  // detach a directly-bound listener the next time a node event landed.
  function bindTurnEvents(app, turnIndex) {
    var block = turnBlockEl(app, turnIndex);
    if (!block || block.dataset.bound === '1') return;
    block.dataset.bound = '1';
    block.addEventListener('click', function (event) {
      var confirmBtn = event.target.closest('[data-confirm-action]');
      if (confirmBtn) {
        var card = confirmBtn.closest('.v2-choice');
        var chosen = {speech: null, body: null};
        card.querySelectorAll('fieldset[data-field]').forEach(function (fieldset) {
          var field = fieldset.getAttribute('data-field');
          var typed = fieldset.querySelector('[data-action-text]').value.trim();
          var picked = fieldset.querySelector('input[type=radio]:checked');
          chosen[field] = typed || (picked ? picked.value : '') || null;
        });
        var turn = state.turns[turnIndex];
        turn.chosen_action = chosen;
        state.selectedAction = chosen;
        persist();
        patchTurn(app, turnIndex, turn, 'node');
        return;
      }
      var iterateBtn = event.target.closest('[data-iterate]');
      if (iterateBtn) { runIterate(app, turnIndex); return; }
      var retryBtn = event.target.closest('[data-retry-node]');
      if (retryBtn) runRetryNode(app, turnIndex, retryBtn.getAttribute('data-retry-node'));
    });
  }

  /* ── 单节点重试：/analyze 内置的一次自动重试仍失败后，用户手动再试一次 ── */
  async function runRetryNode(app, turnIndex, nodeId) {
    var turn = state.turns[turnIndex];
    if (!turn) return;
    turn._nodeRetrying = turn._nodeRetrying || {};
    if (turn._nodeRetrying[nodeId]) return;
    turn._nodeRetrying[nodeId] = true;
    persist();
    patchNode(app, turnIndex, turn, nodeId);
    var request = {
      message: turn.observation && turn.observation.raw || turn.message, model_version: turn.model_version,
      node_id: nodeId, previous_observations: state.turns.map(function (t) { return t.observation && t.observation.raw; }).slice(0, turnIndex).slice(-12),
      selected_action: turn.chosen_action, evidence_bundle_version: turn.evidence_bundle_version || 'personhood-evidence/v1',
      selected_evidence: turn.evidence || [],
    };
    try {
      var res = await fetch(base() + '/api/personhood/v2/retry-node', {method:'POST', headers:headers(), body:JSON.stringify(request)});
      var data = {}; try { data = await res.json(); } catch (_) {}
      if (!res.ok) throw new Error(data.detail || ('重试失败（HTTP ' + res.status + '）'));
      if (nodeId === 'citta-vithi') { if (data.citta_vithi) turn.citta_vithi = data.citta_vithi; }
      else if (data.node) turn.nodes[nodeId] = data.node;
    } catch (error) {
      var status = app.querySelector('[data-status]');
      if (status) status.textContent = '节点重试失败：' + error.message;
    } finally {
      delete turn._nodeRetrying[nodeId];
      persist();
      patchNode(app, turnIndex, turn, nodeId);
      patchTurn(app, turnIndex, turn, 'node');
    }
  }

  async function runIterate(app, turnIndex) {
    var turn = state.turns[turnIndex];
    if (!turn || turn._cycleBusy) return;
    turn._cycleBusy = true;
    persist();
    patchTurn(app, turnIndex, turn, 'node');
    var request = {
      message: turn.observation && turn.observation.raw || turn.message, model_version: turn.model_version,
      conversation_id: state.conversationId, prior_cycles: turn.papanca_cycles || [],
      evidence_bundle_version: turn.evidence_bundle_version || 'personhood-evidence/v1', selected_evidence: turn.evidence || [],
    };
    try {
      var res = await fetch(base() + '/api/personhood/v2/iterate', {method:'POST', headers:headers(), body:JSON.stringify(request)});
      if (!res.ok) {
        var data = {}; try { data = await res.json(); } catch (_) {}
        throw new Error(data.detail || ('推演失败（HTTP ' + res.status + '）'));
      }
      var cycle = null;
      await aiJobConsume(res, function (evt) {
        if (evt.type === 'job') aiJobRemember(ITER_JOB_KIND, evt.job_id, state.conversationId);
        else if (evt.type === 'final') { cycle = evt.cycle; aiJobForget(ITER_JOB_KIND); }
        else if (evt.type === 'error') { throw new Error(evt.detail || '推演失败'); }
      });
      if (cycle) { turn.papanca_cycles = (turn.papanca_cycles || []).concat([cycle]); }
    } catch (error) {
      var status = app.querySelector('[data-status]');
      if (status) status.textContent = '推演失败：' + error.message;
    } finally {
      turn._cycleBusy = false;
      persist();
      patchTurn(app, turnIndex, turn, 'node');
    }
  }

  async function send() {
    var app = document.getElementById('app');
    var input = app.querySelector('[data-input]');
    var message = input.value.trim();
    if (!message) return;
    var status = app.querySelector('[data-status]');
    // Per-node analysis is an authenticated, metered call; ask up front rather
    // than silently handing back the structure with every node empty.
    var ok = global.communityRequireLogin ? await global.communityRequireLogin() : true;
    if (!ok) { status.textContent = '需要登录后才能生成逐节点分析。'; return; }
    status.textContent = '正在抽取引文并并发分析…';
    var selected;
    try { selected = await selectEvidence(message, state.model); }
    catch (error) { selected = { version: 'personhood-evidence/v1', rows: [], error: error.message }; }
    var request = {
      message: message, model_version: state.model, conversation_id: state.conversationId,
      parent_turn_id: state.turns.length ? 'turn-' + state.turns.length : null,
      selected_path: state.selectedPath, selected_action: state.selectedAction,
      previous_observations: state.turns.map(function (t) { return t.observation && t.observation.raw; }).slice(-12),
      evidence_bundle_version: selected.version, selected_evidence: selected.rows,
    };
    var turn = newTurn(message, state.model);
    if (selected.error) turn.evidence_status = {available:false, message:'本地引文库暂不可用（' + selected.error + '）；逐节点分析仍会进行，但本轮不附引文。'};
    var turnIndex = state.turns.length;
    state.turns.push(turn);
    state.selectedPath = null; state.selectedAction = null;
    input.value = '';
    persist(); render(true);
    await runAnalyze(app, turnIndex, request);
  }

  async function save() {
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

  /* ── 证据研究页：读 manifest 渲染真实台账，不再是写死文案 ── */
  function statHtml(value, label) { return '<div class="v2-stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>'; }
  function researchBodyHtml(data) {
    var src = data.source_manifest || {};
    var conceptRows = Object.keys(data.files || {}).map(function (id) { return Object.assign({id: id}, data.files[id]); }).sort(function (a, b) { return b.records - a.records; });
    var conceptTotal = conceptRows.reduce(function (sum, row) { return sum + (row.records || 0); }, 0);
    var passageTotal = Object.keys(data.passages || {}).reduce(function (sum, id) { return sum + (data.passages[id].records || 0); }, 0);
    return '<div class="v2-stats">'
      + statHtml((src.corpus_row_count || 0).toLocaleString(), '逐句正文行')
      + statHtml((src.corpus_work_count || 0).toLocaleString(), '部作品')
      + statHtml(conceptRows.length, '个概念词表')
      + statHtml(conceptTotal.toLocaleString(), '条成员记录')
      + statHtml(Object.keys(data.passages || {}).length, '部作品分片')
      + statHtml(passageTotal.toLocaleString(), '条分片记录')
      + '</div>'
      + '<h3>概念台账（按记录数排序）</h3>'
      + '<div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>概念</th><th>记录数</th><th>文件</th><th>sha256</th></tr></thead><tbody>'
      + conceptRows.map(function (row) { return '<tr><td>' + esc(row.id) + '</td><td>' + (row.records || 0).toLocaleString() + '</td><td>' + esc(row.file) + '</td><td class="v2-hash">' + esc((row.sha256 || '').slice(0, 16)) + '…</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + '<h3>定向引文（' + (data.direct_citations || []).length + ' 条）</h3>'
      + '<div class="v2-table-wrap"><table class="v2-table"><thead><tr><th>作品</th><th>行号</th><th>说明</th></tr></thead><tbody>'
      + (data.direct_citations || []).map(function (row) { return '<tr><td>' + esc(row.work_id) + '</td><td>' + esc(row.row_id) + '</td><td>' + esc(row.label) + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + '<h3>完整性校验</h3><p>' + esc(data.integrity && data.integrity.file || '') + ' · ' + (data.integrity && data.integrity.records || 0).toLocaleString() + ' 条记录<br><span class="v2-hash">sha256 ' + esc(data.integrity && data.integrity.sha256 || '') + '</span></p>'
      + '<p class="v2-muted">版本 ' + esc(data.version || '') + ' · 词表范围 ' + esc((data.registry && data.registry.scope) || '') + '</p>';
  }
  function renderResearch() {
    var app = document.getElementById('app'); if (!app) return;
    app.innerHTML = '<div class="personhood-lab personhood-v2"><div class="v2-chat"><div class="v2-hero"><div class="v2-kicker">RESEARCH · STATIC V4 CITATIONS</div><h2>证据与研究清单</h2><p class="v2-subtitle">读取已发布的静态引文库清单，逐条给出真实的记录数与完整性哈希，而非固定描述。</p><button data-back>返回实验室</button></div><div class="v2-card" id="v2ResearchBody"><p class="v2-muted">正在读取 manifest…</p></div></div></div>';
    app.querySelector('[data-back]').addEventListener('click', function(){global.location.hash='#/personhood';render();});
    manifest().then(function (data) { var el = document.getElementById('v2ResearchBody'); if (el) el.innerHTML = researchBodyHtml(data); })
      .catch(function (error) { var el = document.getElementById('v2ResearchBody'); if (el) el.innerHTML = '<p class="error-msg">证据清单读取失败：' + esc(error.message) + '</p><button data-retry>重试</button>'; var retry = el && el.querySelector('[data-retry]'); if (retry) retry.addEventListener('click', renderResearch); });
  }

  var resizeTimer;
  global.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { var app = document.getElementById('app'); if (app && app.querySelector('.v2-flow')) drawAllConnectors(app); }, 120);
  });

  global.renderPersonhoodLab = render;
  global.renderPersonhoodResearch = renderResearch;
})(window);
