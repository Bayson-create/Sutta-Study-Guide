(function (global) {
  'use strict';

  var P = global.PaliPersonhood = global.PaliPersonhood || {};
  P.SCHEMA_VERSION = 'pali-personhood/0.1';
  P.MODEL_VERSIONS = {
    CANONICAL: 'pali-canonical/v1',
    SYNTHESIS: 'theravada-synthesis/v1'
  };
  P.DOORS = ['eye', 'ear', 'nose', 'tongue', 'body', 'mind'];
  P.VALENCES = ['pleasant', 'painful', 'neutral'];
  P.SPECIES = ['human', 'animal', 'unknown'];
  P.LAYERS = ['canonical', 'vinaya', 'abhidhamma', 'commentary', 'modern-teaching', 'scholarship'];

  P.clone = function (value) {
    return JSON.parse(JSON.stringify(value));
  };

  P.defaultScenario = function () {
    return {
      id: 'scenario-praise-eye',
      title: '赞美在眼门出现',
      description: '一位同伴公开赞美 Agent A；只记录可观察的声音、姿态和回应。',
      primary_object: {
        id: 'obj-praise',
        kind: 'speech',
        door: 'ear',
        value: '赞美：你这次的工作很有帮助。',
        valence: 'pleasant',
        observable: true,
        source_agent_id: 'agent-b'
      },
      context: { language: 'zh', location: 'shared-space', time_index: 0 },
      observable_events: [
        { id: 'obs-1', actor_id: 'agent-b', type: 'speech', value: '赞美：你这次的工作很有帮助。' }
      ]
    };
  };

  P.defaultAgents = function () {
    return [
      {
        id: 'agent-a', label: 'Agent A', species: 'human',
        tendencies: { lobha: 0.62, dosa: 0.35, moha: 0.48 },
        training: { sati: 0.35, sampajanna: 0.35, sila: 0.45, metta: 0.4, panna: 0.25 },
        notes: '示例条件倾向，不是人格分数、诊断或资格判断。'
      },
      {
        id: 'agent-b', label: 'Agent B', species: 'human',
        tendencies: { lobha: 0.38, dosa: 0.46, moha: 0.42 },
        training: { sati: 0.6, sampajanna: 0.55, sila: 0.58, metta: 0.62, panna: 0.42 },
        notes: '示例条件倾向，不是人格分数、诊断或资格判断。'
      }
    ];
  };

  P.normaliseAgent = function (agent, index) {
    var source = agent || {};
    var tendency = source.tendencies || {};
    var training = source.training || {};
    function bounded(value, fallback) {
      var n = Number(value);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
    }
    return {
      id: source.id || ('agent-' + String.fromCharCode(97 + (index || 0))),
      label: source.label || ('Agent ' + String.fromCharCode(65 + (index || 0))),
      species: P.SPECIES.indexOf(source.species) >= 0 ? source.species : 'unknown',
      tendencies: {
        lobha: bounded(tendency.lobha, 0.5),
        dosa: bounded(tendency.dosa, 0.5),
        moha: bounded(tendency.moha, 0.5)
      },
      training: {
        sati: bounded(training.sati, 0.5),
        sampajanna: bounded(training.sampajanna, 0.5),
        sila: bounded(training.sila, 0.5),
        metta: bounded(training.metta, 0.5),
        panna: bounded(training.panna, 0.5)
      },
      notes: source.notes || '条件性建模资料；不构成诊断。'
    };
  };

  P.normaliseScenario = function (scenario) {
    var source = scenario || P.defaultScenario();
    var object = source.primary_object || {};
    if (P.DOORS.indexOf(object.door) < 0) throw new Error('Scenario.primary_object.door must be one of the six doors');
    if (P.VALENCES.indexOf(object.valence) < 0) throw new Error('Scenario.primary_object.valence is invalid');
    var observations = (source.observations || []).slice(0, 6).map(function (item, index) {
      var observation = item || {};
      if (P.DOORS.indexOf(observation.door) < 0 || P.VALENCES.indexOf(observation.valence) < 0) {
        throw new Error('Scenario.observations[' + index + '] has an invalid door or valence');
      }
      return {
        id: observation.id || ('object-' + String(index + 1)), kind: observation.kind || 'unspecified',
        door: observation.door, value: observation.value == null ? '' : String(observation.value),
        valence: observation.valence, observable: observation.observable !== false,
        source_agent_id: observation.source_agent_id || null
      };
    });
    var requestedRounds = Number(source.maxRounds == null ? source.max_rounds : source.maxRounds);
    if (!Number.isFinite(requestedRounds)) requestedRounds = 1;
    return {
      id: source.id || 'scenario-untitled',
      title: source.title || '未命名情境',
      description: source.description || '',
      primary_object: {
        id: object.id || 'object-1',
        kind: object.kind || 'unspecified',
        door: object.door,
        value: object.value == null ? '' : String(object.value),
        valence: object.valence,
        observable: object.observable !== false,
        source_agent_id: object.source_agent_id || null
      },
      context: P.clone(source.context || {}),
      observable_events: P.clone(source.observable_events || []),
      observations: observations,
      max_rounds: Math.max(1, Math.min(6, Math.floor(requestedRounds)))
    };
  };

  P.validateInput = function (input) {
    var request = input || {};
    var model = request.modelVersion || P.MODEL_VERSIONS.CANONICAL;
    if ([P.MODEL_VERSIONS.CANONICAL, P.MODEL_VERSIONS.SYNTHESIS].indexOf(model) < 0) {
      throw new Error('Unknown modelVersion: ' + model);
    }
    var scenario = P.normaliseScenario(request.scenario);
    var agents = (request.agents && request.agents.length ? request.agents : P.defaultAgents())
      .map(P.normaliseAgent);
    if (!agents.length) throw new Error('At least one agent is required');
    return {
      modelVersion: model,
      scenario: scenario,
      agents: agents,
      interventions: P.clone(request.interventions || {}),
      seed: request.seed == null ? 0 : String(request.seed)
    };
  };
})(window);
