(function (global) {
  'use strict';
  var P = global.PaliPersonhood = global.PaliPersonhood || {};
  P.EVIDENCE = {
    'sn12.23': {
      id: 'sn12.23', layer: 'canonical', claim_type: 'conditional-process',
      title: 'Upanisa Sutta: contact, feeling, craving and release',
      citation: 'SN 12.23 Upanisa Sutta',
      pali: 'phassapaccayā vedanā; vedanāpaccayā taṇhā',
      translation: 'With contact as condition there is feeling; with feeling as condition, craving.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'SuttaCentral', version: 'SN12.23' },
      url: 'https://suttacentral.net/sn12.23/en/sujato',
      note: '第一手经文锚点；V4 row_id 待通过 hybrid search 解析后补录，不在缺失时伪造。'
    },
    'mn18': {
      id: 'mn18', layer: 'canonical', claim_type: 'conceptual-proliferation',
      title: 'Madhupiṇḍika Sutta: contact, feeling, perception, thought and proliferation',
      citation: 'MN 18 Madhupiṇḍika Sutta',
      pali: 'yaṃ vedeti taṃ sañjānāti; yaṃ sañjānāti taṃ vitakketi; yaṃ vitakketi taṃ papañceti',
      translation: 'What one feels one perceives; what one perceives one thinks about; what one thinks about proliferates.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'SuttaCentral', version: 'MN18' },
      url: 'https://suttacentral.net/mn18/en/suddhaso',
      note: '说明从接触到戏论的经文展开；不等于所有心过程的固定时间序列。'
    },
    'sn22.59': {
      id: 'sn22.59', layer: 'canonical', claim_type: 'aggregates-anatta',
      title: 'Anattalakkhaṇa Sutta: the five aggregates are not-self',
      citation: 'SN 22.59 Anattalakkhaṇa Sutta',
      pali: 'netaṃ mama, nesohamasmi, na meso attā',
      translation: 'This is not mine, I am not this, this is not my self.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'SuttaCentral', version: 'SN22.59' },
      url: 'https://suttacentral.net/sn22.59/en/bodhi',
      note: '五蕴是条件聚合与观察范围，不在此处被实现为固定实体人格。'
    },
    'sn35.23': {
      id: 'sn35.23', layer: 'canonical', claim_type: 'six-sense-bases',
      title: 'Sabba Sutta: the six internal and external sense bases',
      citation: 'SN 35.23 Sabba Sutta',
      pali: 'sabbaṃ vo bhikkhave desessāmi',
      translation: 'I will teach you the all: the eye and forms ... the mind and thoughts.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'SuttaCentral', version: 'SN35.23' },
      url: 'https://suttacentral.net/sn35.23/en/bodhi',
      note: '限定“全部”的认知范围：六内处与六外处及其接触经验。'
    },
    'mn10': {
      id: 'mn10', layer: 'canonical', claim_type: 'mindfulness',
      title: 'Satipaṭṭhāna Sutta: observing body, feelings, mind and dhammas',
      citation: 'MN 10 Satipaṭṭhāna Sutta',
      pali: 'ātāpī sampajāno satimā',
      translation: 'Ardent, clearly comprehending, mindful, having removed covetousness and displeasure.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'SuttaCentral', version: 'MN10' },
      url: 'https://suttacentral.net/mn10/en/sujato',
      note: '训练路径的正念与明觉锚点；界面只展示条件分岔，不评定修行成就。'
    },
    'dn22': {
      id: 'dn22', layer: 'canonical', claim_type: 'arising-ceasing',
      title: 'Mahāsatipaṭṭhāna Sutta: arising and passing conditions',
      citation: 'DN 22 Mahāsatipaṭṭhāna Sutta',
      pali: 'samudayadhammānupassī ... vayadhammānupassī',
      translation: 'Observing the nature of arising and the nature of passing away.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'SuttaCentral', version: 'DN22' },
      url: 'https://suttacentral.net/dn22/en/sujato',
      note: '“灭”在本模型中首先表示局部条件链和反应循环止息。'
    },
    'abhidhamma.citta-vithi': {
      id: 'abhidhamma.citta-vithi', layer: 'abhidhamma', claim_type: 'later-systematisation',
      title: 'Theravāda Abhidhamma citta-vīthi interpretation',
      citation: 'Abhidhamma / commentarial citta-vīthi model',
      pali: 'citta-vīthi; javana; bhavaṅga',
      translation: 'A later systematic account of mind-door and sense-door cognitive processes.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'Theravāda analytical tradition', version: 'synthesis-v1' },
      url: 'https://www.accesstoinsight.org/lib/authors/mendis/wheel322.html',
      note: '仅在 theravāda-synthesis/v1 显示，并明确标记为后期系统化解释，不能静默写回经藏。'
    },
    'research.five-aggregates': {
      id: 'research.five-aggregates', layer: 'scholarship', claim_type: 'interpretive-context',
      title: 'Buddhist psychology research on the five aggregates and personality',
      citation: 'Practical perspectives on Buddhist psychology of the five aggregates (2019)',
      pali: '',
      translation: 'Modern scholarship often describes the aggregates as a conditional model of psycho-physical experience, not a permanent self.',
      locator: { work_id: null, row_id: null, paranum: null, anchor: null, source: 'University of Peradeniya / Jstage research record', version: '2019' },
      url: 'https://ir.lib.pdn.ac.lk/handle/20.500.12650/3337',
      note: '解释性材料；不替代巴利原典，也不把现代“人格”概念当作 puggala 的同义词。'
    }
  };

  P.getEvidence = function (id) { return P.EVIDENCE[id] || null; };
  P.evidenceManifest = function () {
    return Object.keys(P.EVIDENCE).sort().map(function (id) { return P.clone(P.EVIDENCE[id]); });
  };
})(window);
