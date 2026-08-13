(function (global) {
  'use strict';
  var P = global.PaliPersonhood = global.PaliPersonhood || {};
  var canonical = P.MODEL_VERSIONS.CANONICAL;
  var synthesis = P.MODEL_VERSIONS.SYNTHESIS;

  function round(value) { return Math.round(value * 1000) / 1000; }
  function stableId(agentId, index, kind) { return agentId + ':e' + String(index + 1).padStart(2, '0') + ':' + kind; }
  function interventionFor(interventions, agentId) {
    var item = interventions && interventions[agentId];
    if (typeof item === 'boolean') return { pause: item };
    return item || {};
  }
  function tendencyFor(agent, valence) {
    if (valence === 'pleasant') return agent.tendencies.lobha;
    if (valence === 'painful') return agent.tendencies.dosa;
    return agent.tendencies.moha;
  }
  function trainingFor(agent, intervention) {
    var score = agent.training.sati * 0.30 + agent.training.sampajanna * 0.20 +
      agent.training.sila * 0.15 + agent.training.metta * 0.15 + agent.training.panna * 0.20;
    if (intervention && intervention.mindfulness) score += 0.16;
    if (intervention && intervention.pause) score += 0.12;
    if (intervention && intervention.metta) score += 0.10;
    if (intervention && intervention.restraint) score += 0.10;
    return Math.min(1, score);
  }
  function baseConditions(agent, scenario) {
    var object = scenario.primary_object;
    return {
      door: object.door,
      object_id: object.id,
      object_kind: object.kind,
      object_value: object.value,
      consciousness: agent.id + ':consciousness-at-' + object.door,
      contact_formula: 'root + object + consciousness',
      shared_object: object.observable === true,
      uncertainty: agent.species === 'animal' ? 'animal-inner-experience-uncertain' : null
    };
  }
  function event(agent, index, kind, phase, conditions, aggregates, action, branch, evidenceIds, extra) {
    var result = {
      id: stableId(agent.id, index, kind), actor_id: agent.id, step: index + 1, phase: phase,
      kind: kind, conditions: conditions, aggregates: aggregates,
      action: action || null, branch: branch || null, evidence_ids: evidenceIds,
      uncertainty: conditions.uncertainty || null
    };
    if (extra) Object.keys(extra).forEach(function (key) { result[key] = extra[key]; });
    return result;
  }
  function actionFor(agent, scenario, branch, intervention) {
    var value = scenario.primary_object.value;
    if (branch === 'trained') {
      if (intervention.pause) return { type: 'pause', observable: true, text: '暂停并保持可观察的安静' };
      if (intervention.metta) return { type: 'kind-speech', observable: true, text: '以善意、不过度取著的方式回应' };
      return { type: 'restrained-response', observable: true, text: '先觉察再作适当回应' };
    }
    if (scenario.primary_object.valence === 'pleasant') return { type: 'appropriating-speech', observable: true, text: '追逐更多赞许：' + value };
    if (scenario.primary_object.valence === 'painful') return { type: 'aversive-speech', observable: true, text: '以防卫或反击回应：' + value };
    return { type: 'confused-action', observable: true, text: '在不明了中作出惯性回应：' + value };
  }
  function buildAgentTrace(agent, input) {
    var scenario = input.scenario;
    var object = scenario.primary_object;
    var intervention = interventionFor(input.interventions, agent.id);
    var reactivity = tendencyFor(agent, object.valence);
    var training = trainingFor(agent, intervention);
    var branch = reactivity > training ? 'untrained' : 'trained';
    var conditions = baseConditions(agent, scenario);
    var aggregates = { form: 'body-and-object', feeling: object.valence, perception: 'recognition-of-' + object.kind, formations: 'conditional-intention', consciousness: conditions.consciousness };
    var events = [];
    var index = 0;
    events.push(event(agent, index++, 'contact', 'arising', conditions, aggregates, null, null, ['sn35.23', 'sn12.23'], { statement: '门、所缘与识共同构成可观察的接触条件。' }));
    events.push(event(agent, index++, 'coarising-aggregates', 'arising', conditions, aggregates, null, null, ['sn22.59'], { statement: '五蕴以共同生起的条件聚合显示；不是固定人格实体。' }));
    events.push(event(agent, index++, 'feeling', 'arising', conditions, aggregates, null, null, ['sn12.23', 'sn22.59'], { statement: '受依触而起，标为乐、苦或不苦不乐。' }));
    events.push(event(agent, index++, 'perception-and-thought', 'elaboration', conditions, aggregates, null, null, ['mn18'], { statement: '想与寻思可进一步展开为戏论；这不是所有心过程的物理时间序列。' }));
    if (input.modelVersion === synthesis) {
      events.push(event(agent, index++, 'citta-vithi-view', 'interpretive', conditions, aggregates, null, null, ['abhidhamma.citta-vithi'], { layer: 'abhidhamma', interpretation_status: 'later-systematisation', statement: '后期上座部分析视图：以心路、随眠或速行等术语补充解释。' }));
    }
    if (branch === 'untrained') {
      events.push(event(agent, index++, 'craving', 'conditioning', conditions, aggregates, null, 'untrained', ['sn12.23'], { statement: '受缘爱：反应循环继续。' }));
      events.push(event(agent, index++, 'clinging-and-becoming', 'conditioning', conditions, aggregates, null, 'untrained', ['sn12.23'], { statement: '取与有在本模拟中表示局部反应模式的加深，不是永久自我。' }));
    } else {
      events.push(event(agent, index++, 'mindfulness-and-clear-comprehension', 'intervention', conditions, aggregates, null, 'trained', ['mn10', 'dn22'], { statement: '正念、明觉、戒护或暂停改变后续条件。' }));
      events.push(event(agent, index++, 'non-clinging', 'cessation', conditions, aggregates, null, 'trained', ['dn22', 'sn12.23'], { statement: '局部爱取反应链在当前情境中止息；不表示涅槃或证悟。' }));
    }
    var action = actionFor(agent, scenario, branch, intervention);
    events.push(event(agent, index++, 'observable-action', 'expression', conditions, aggregates, action, branch, branch === 'trained' ? ['mn10'] : ['sn12.23'], { statement: '只有动作、言语、姿态等外化结果可进入交互交换。' }));
    return {
      agent_id: agent.id, agent_label: agent.label, species: agent.species,
      tendency_used: round(reactivity), training_available: round(training), branch: branch,
      intervention: P.clone(intervention), events: events,
      caveats: agent.species === 'animal' ? ['动物内在经验不可由此读心；只模拟共享刺激与可观察反馈。'] : []
    };
  }

  P.runEpisode = function (request) {
    var input = P.validateInput(request);
    var streams = input.agents.map(function (agent) { return buildAgentTrace(agent, input); });
    var edges = [];
    streams.forEach(function (stream) {
      var action = stream.events.filter(function (item) { return item.kind === 'observable-action'; })[0];
      if (!action || !action.action || action.action.observable !== true) return;
      input.agents.forEach(function (other) {
        if (other.id === stream.agent_id) return;
        edges.push({ from_agent_id: stream.agent_id, to_agent_id: other.id, kind: 'observable-feedback', source_event_id: action.id, value: action.action.text, accessible_state: 'observable-action-only' });
      });
    });
    var trace = {
      schema_version: P.SCHEMA_VERSION, trace_kind: input.agents.length > 1 ? 'InteractionTrace' : 'EpisodeTrace', model_version: input.modelVersion, seed: input.seed,
      scenario: input.scenario, agents: input.agents, streams: streams,
      observable_edges: edges,
      evidence_manifest_version: 'personhood-evidence/2026-08-12',
      interpretation_notes: input.modelVersion === synthesis ? ['新增的 citta-vīthi 视图属于后期系统化解释，已逐事件标记。'] : ['本版本以经藏/律藏核心为准；不把五蕴写成线性实体或固定人格。'],
      forbidden_claims: ['nibbana-simulation', 'enlightenment-certification', 'clinical-diagnosis', 'animal-mind-reading']
    };
    var validation = P.validateTrace(trace);
    if (!validation.ok) throw new Error('Trace validation failed: ' + validation.errors.join('; '));
    trace.validation = validation;
    return trace;
  };

  function namespaceRound(trace, roundIndex) {
    var prefix = 'r' + String(roundIndex) + ':';
    var eventIds = {};
    var streams = (trace.streams || []).map(function (stream) {
      var events = (stream.events || []).map(function (item) {
        var copied = P.clone(item);
        var oldId = copied.id;
        copied.id = prefix + oldId;
        copied.round_index = roundIndex;
        eventIds[oldId] = copied.id;
        return copied;
      });
      var result = P.clone(stream);
      result.events = events;
      result.round_index = roundIndex;
      return result;
    });
    var edges = (trace.observable_edges || []).map(function (edge) {
      var copied = P.clone(edge);
      copied.source_event_id = eventIds[copied.source_event_id] || prefix + copied.source_event_id;
      copied.round_index = roundIndex;
      return copied;
    });
    return { streams: streams, edges: edges };
  }

  P.runInteraction = function (request) {
    var source = P.validateInput(request || {});
    var scenario = source.scenario;
    var requestedRounds = request && (request.maxRounds == null ? request.max_rounds : request.maxRounds);
    var maxRounds = Number(requestedRounds == null ? scenario.max_rounds : requestedRounds);
    if (!Number.isFinite(maxRounds)) maxRounds = 1;
    maxRounds = Math.max(1, Math.min(6, Math.floor(maxRounds)));
    var supplied = (scenario.observations || []).slice();
    var currentObject = supplied[0] || scenario.primary_object;
    var rounds = [], streams = [], edges = [];
    for (var roundIndex = 1; roundIndex <= maxRounds; roundIndex += 1) {
      var roundScenario = P.clone(scenario);
      roundScenario.id = scenario.id + ':round-' + String(roundIndex);
      roundScenario.primary_object = P.clone(currentObject);
      roundScenario.observations = [];
      var roundRequest = {
        modelVersion: source.modelVersion, scenario: roundScenario,
        agents: P.clone(source.agents), interventions: P.clone(source.interventions),
        seed: source.seed + ':round-' + String(roundIndex)
      };
      var roundTrace = P.runEpisode(roundRequest);
      roundTrace.round_index = roundIndex;
      rounds.push(roundTrace);
      var namespaced = namespaceRound(roundTrace, roundIndex);
      streams = streams.concat(namespaced.streams);
      edges = edges.concat(namespaced.edges);
      if (roundIndex >= maxRounds) break;
      if (roundIndex < supplied.length) {
        currentObject = supplied[roundIndex];
        continue;
      }
      if (supplied.length) break;
      var actions = [];
      roundTrace.streams.forEach(function (stream) { stream.events.forEach(function (item) {
        if (item.kind === 'observable-action' && item.action && item.action.observable) actions.push(item);
      }); });
      if (!actions.length) break;
      var action = actions[0];
      currentObject = {
        id: 'feedback-' + String(roundIndex + 1), kind: 'speech', door: 'ear',
        value: action.action.text, valence: 'neutral', observable: true,
        source_agent_id: action.actor_id
      };
    }
    var trace = {
      schema_version: P.SCHEMA_VERSION, trace_kind: 'InteractionTrace',
      model_version: source.modelVersion, seed: source.seed, scenario: source.scenario,
      agents: source.agents, streams: streams, observable_edges: edges, rounds: rounds,
      evidence_manifest_version: 'personhood-evidence/2026-08-12',
      interaction_limits: { max_rounds: 6, rounds_completed: rounds.length, private_state_shared: false },
      interpretation_notes: ['每一轮只把外化的言语、动作、姿态或共同环境作为下一轮所缘。'],
      forbidden_claims: ['nibbana-simulation', 'enlightenment-certification', 'clinical-diagnosis', 'animal-mind-reading']
    };
    var validation = P.validateTrace(trace);
    if (!validation.ok) throw new Error('Interaction trace validation failed: ' + validation.errors.join('; '));
    trace.validation = validation;
    return trace;
  };

  P.validateTrace = function (trace) {
    var errors = [];
    var agentIds = (trace.agents || []).map(function (a) { return a.id; });
    (trace.streams || []).forEach(function (stream) {
      if (agentIds.indexOf(stream.agent_id) < 0) errors.push('stream actor missing: ' + stream.agent_id);
      (stream.events || []).forEach(function (item) {
        if (item.actor_id !== stream.agent_id) errors.push('event actor does not match stream: ' + item.id);
        (item.evidence_ids || []).forEach(function (id) { if (!P.getEvidence(id)) errors.push('unresolved evidence: ' + id); });
        if (item.kind === 'contact') {
          var c = item.conditions || {};
          if (!c.door || !c.object_id || !c.consciousness) errors.push('contact lacks door/object/consciousness: ' + item.id);
        }
        if (item.observed_internal_state || item.accessed_agent_state) errors.push('internal-state leakage: ' + item.id);
        var encoded = JSON.stringify(item).toLowerCase();
        if (encoded.indexOf('enlightenment-certification') >= 0 || encoded.indexOf('nibbana-simulation') >= 0) errors.push('forbidden attainment claim: ' + item.id);
      });
    });
    (trace.observable_edges || []).forEach(function (edge) {
      if (edge.accessible_state !== 'observable-action-only') errors.push('edge exposes non-observable state');
      if (edge.from_agent_id === edge.to_agent_id) errors.push('self interaction edge');
    });
    if ([canonical, synthesis].indexOf(trace.model_version) < 0) errors.push('invalid model version');
    return { ok: errors.length === 0, errors: errors, checked_events: (trace.streams || []).reduce(function (n, s) { return n + s.events.length; }, 0) };
  };
})(window);
