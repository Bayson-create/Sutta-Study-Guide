/* Fallback flow topology for the personhood lab.
 *
 * The server is authoritative: every /analyze response carries `turn.topology`,
 * built by api/app/personhood_layers.py, and the renderer uses that when present.
 * This copy only covers the offline/degraded path (no network, not logged in),
 * so the diagram still has its correct shape instead of collapsing to nothing.
 *
 * Keep node ids in sync with personhood_layers.NODE_SPECS — they are the whole
 * contract between the two sides.
 */
(function (global) {
  'use strict';

  var NODES = {
    'door':                 { label: '门',       pali: 'dvāra' },
    'object':               { label: '所缘',     pali: 'ārammaṇa' },
    'consciousness':        { label: '识',       pali: 'viññāṇa' },
    'contact':              { label: '触',       pali: 'phassa' },
    'feeling':              { label: '受',       pali: 'vedanā' },
    'perception':           { label: '想',       pali: 'saññā' },
    'volition':             { label: '思',       pali: 'cetanā' },
    'attention':            { label: '作意',     pali: 'manasikāra' },
    'citta-vithi':          { label: '完整心路', pali: 'citta-vīthi' },
    'thinking':             { label: '寻',       pali: 'vitakka' },
    'papanca':              { label: '戏论',     pali: 'papañca' },
    'papanca-sanna-sankha': { label: '戏论想念', pali: 'papañcasaññāsaṅkhā' },
    'craving':              { label: '爱',       pali: 'taṇhā' },
    'clinging':             { label: '取',       pali: 'upādāna' },
    'becoming':             { label: '有',       pali: 'bhava' },
    'mind-kamma':           { label: '意业',     pali: 'mano-kamma' },
    'speech-kamma':         { label: '语业',     pali: 'vacī-kamma' },
    'body-kamma':           { label: '身业',     pali: 'kāya-kamma' },
    'feedback':             { label: '反馈',     pali: '' }
  };

  var BRANCHING = { 'speech-kamma': 1, 'body-kamma': 1 };

  // MN18's explicit sequence: 根 + 境 + 識 → 觸 → 受 → 想 → 尋 → 戲論.
  var CANONICAL = [
    ['door', 'object', 'consciousness'],
    ['contact'], ['feeling'], ['perception'],
    ['thinking'], ['papanca'], ['papanca-sanna-sankha'],
    ['craving'], ['clinging'], ['becoming'],
    ['mind-kamma'], ['speech-kamma', 'body-kamma'], ['feedback']
  ];

  // Abhidhamma: 觸/受/想/思/作意 co-arise, and the citta-vīthi is spelled out.
  var SYNTHESIS = [
    ['door', 'object', 'consciousness'],
    ['contact', 'feeling', 'perception', 'volition', 'attention'],
    ['citta-vithi'],
    ['thinking'], ['papanca'], ['papanca-sanna-sankha'],
    ['craving'], ['clinging'], ['becoming'],
    ['mind-kamma'], ['speech-kamma', 'body-kamma'], ['feedback']
  ];

  var EDGES = [{ from: 'papanca-sanna-sankha', to: 'thinking', kind: 'loop', label: '反复推演' }];

  function build(modelVersion) {
    var rows = /synthesis\/v2$/.test(String(modelVersion)) ? SYNTHESIS : CANONICAL;
    return {
      model_version: modelVersion,
      edges: EDGES.slice(),
      layers: rows.map(function (ids, index) {
        return {
          id: 'layer-' + (index + 1),
          index: index,
          parallel: ids.length > 1,
          nodes: ids.map(function (id) {
            return { id: id, label: NODES[id].label, pali: NODES[id].pali, branching: !!BRANCHING[id] };
          })
        };
      })
    };
  }

  global.PersonhoodStages = { NODES: NODES, build: build };
})(window);
