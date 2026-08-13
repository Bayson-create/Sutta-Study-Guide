(function (global) {
  'use strict';
  var P = global.PaliPersonhood = global.PaliPersonhood || {};
  var doors = [
    ['eye', 'visual form', '景象', '看见一个正在变化的姿态'],
    ['ear', 'speech', '说话或声音', '听见一句话'],
    ['nose', 'odor', '气味', '闻到烟味'],
    ['tongue', 'taste', '味道', '尝到苦味饮品'],
    ['body', 'touch', '触碰', '感到突然的压力'],
    ['mind', 'thought', '记忆或想法', '想起一段批评']
  ];
  var valences = [
    ['pleasant', '乐受'],
    ['painful', '苦受'],
    ['neutral', '不苦不乐受']
  ];
  function agent(branch) {
    return {
      id: 'agent-a', label: branch === 'trained' ? '训练路径' : '未训练路径', species: 'human',
      tendencies: { lobha: branch === 'trained' ? 0.2 : 0.85, dosa: branch === 'trained' ? 0.2 : 0.85, moha: branch === 'trained' ? 0.2 : 0.85 },
      training: { sati: branch === 'trained' ? 0.95 : 0.05, sampajanna: branch === 'trained' ? 0.9 : 0.05, sila: branch === 'trained' ? 0.9 : 0.2, metta: branch === 'trained' ? 0.85 : 0.2, panna: branch === 'trained' ? 0.85 : 0.05 },
      notes: 'fixture preset; not a personality score'
    };
  }
  P.FIXTURES = [];
  doors.forEach(function (door) {
    valences.forEach(function (valence) {
      ['untrained', 'trained'].forEach(function (branch) {
        P.FIXTURES.push({
          id: 'fixture-' + door[0] + '-' + valence[0] + '-' + branch,
          title: door[2] + '／' + valence[1] + '／' + (branch === 'trained' ? '训练条件可用' : '反应链延续'),
          description: '六门 × 三受 × ' + branch + ' 分岔的最小确定性情境。',
          primary_object: { id: 'object-' + door[0] + '-' + valence[0], kind: door[1], door: door[0], value: door[3], valence: valence[0], observable: true, source_agent_id: 'agent-b' },
          context: { fixture_family: 'six-doors-three-feelings', expected_branch: branch },
          observable_events: [{ id: 'fixture-observation', actor_id: 'agent-b', type: 'stimulus', value: door[3] }],
          agents: [agent(branch)],
          interventions: branch === 'trained' ? { 'agent-a': { mindfulness: true, restraint: true, metta: true, pause: true } } : {},
          seed: 'fixture-' + door[0] + '-' + valence[0] + '-' + branch
        });
      });
    });
  });
  P.SPECIAL_FIXTURES = [
    { id: 'insult-human-human', title: '辱骂：人与人', object_kind: 'speech', door: 'ear', valence: 'painful' },
    { id: 'praise-intimate', title: '赞美：亲密关系', object_kind: 'speech', door: 'ear', valence: 'pleasant' },
    { id: 'group-conflict', title: '群体冲突：共同环境', object_kind: 'visual form', door: 'eye', valence: 'painful' },
    { id: 'animal-contact', title: '人与动物：共享刺激', object_kind: 'gesture', door: 'eye', valence: 'neutral', species: 'animal' },
    { id: 'pain-body', title: '疼痛：身体门', object_kind: 'pressure', door: 'body', valence: 'painful' },
    { id: 'memory-mind', title: '记忆唤起：意门', object_kind: 'memory', door: 'mind', valence: 'painful' },
    { id: 'empty-object', title: '空所缘：无明确值', object_kind: 'unspecified', door: 'mind', valence: 'neutral' },
    { id: 'ambiguous-object', title: '歧义所缘：待澄清', object_kind: 'ambiguous', door: 'ear', valence: 'neutral' }
  ].map(function (item) {
    var a = agent('trained');
    if (item.species === 'animal') a.species = 'animal';
    return {
      id: item.id, title: item.title, description: '扩展审阅情境；仅模拟共享刺激与可观察反馈。',
      primary_object: { id: 'object-' + item.id, kind: item.object_kind, door: item.door, value: item.title, valence: item.valence, observable: true, source_agent_id: 'agent-b' },
      context: { fixture_family: 'review-extensions' }, observable_events: [], agents: [a],
      interventions: { 'agent-a': { mindfulness: true, restraint: true, metta: true, pause: true } }, seed: item.id
    };
  });
})(window);
