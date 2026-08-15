#!/usr/bin/env node

/*
 * Builds the source-bounded V4 meditation graph.  "Complete" here has a
 * testable meaning: every substantive legacy node is retained, every bundled
 * enumeration displayed by the legacy node is expanded to its named members,
 * and every relation is typed and backed by a source shared by its endpoints.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const baseFile = resolve(root, 'docs/research/pali-meditation-node-network/legacy-node-source-inventory-v1.json');
const alignmentFile = resolve(root, 'docs/research/pali-meditation-node-network/legacy-v4-source-alignment-v1.json');
const outDir = resolve(root, 'docs/research/pali-meditation-node-network');
const hash = value => createHash('sha256').update(value).digest('hex');
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
const slug = value => norm(value).replace(/[^a-z0-9\u4e00-\u9fff]/g, '-') || 'node';

const base = JSON.parse(await readFile(baseFile, 'utf8'));
const aligned = JSON.parse(await readFile(alignmentFile, 'utf8'));
const legacy = new Map(base.nodes.filter(node => node.node_kind === 'substantive').map(node => [node.label, node]));
const sourceRows = new Map(aligned.references.map(item => [item.uid, item]));
const referenceUid = reference => {
  const value = reference.ref.toLowerCase();
  const match = value.match(/^([a-z]+)\s+(\d+)(?:\.(\d+))?/);
  return match ? `${match[1]}${match[2]}${match[3] ? `.${match[3]}` : ''}` : null;
};

const domainByLegacy = new Map([
  ['发心与正见','foundation'],['善友与听法','foundation'],['戒清净','foundation'],['根门防护','foundation'],['正念正知','foundation'],['远离与独处','foundation'],['自检心流','foundation'],
  ['五盖现前','hindrance'],['不善寻思','hindrance'],['昏沉睡眠','hindrance'],['禅相障碍','hindrance'],['嗔恚对治','hindrance'],['贪欲对治','hindrance'],['调节精进','hindrance'],
  ['选择业处','practice'],['安般入门','practice'],['身念入门','practice'],['四无量入门','practice'],['随念入门','practice'],['定前五盖暂伏','practice'],['安止门槛','practice'],
  ['初禅','concentration'],['第二禅','concentration'],['第三禅','concentration'],['第四禅','concentration'],['禅那熟练','concentration'],['定中观','concentration'],['四梵住成熟','concentration'],['空无边处','concentration'],['识无边处','concentration'],['无所有处','concentration'],['非想非非想处','concentration'],['无相定','concentration'],['受想灭定','concentration'],
  ['身念处','framework'],['受念处','framework'],['心念处','framework'],['法念处','framework'],['安般十六阶','framework'],['七觉支成熟','framework'],['正勤神足根力','framework'],
  ['五蕴观','insight'],['六处观','insight'],['受观','insight'],['界分别','insight'],['缘起观','insight'],['现法观','insight'],['空性观','insight'],['集灭随观','insight'],['三相深入','insight'],['味患出离','insight'],['厌离','insight'],['离贪','insight'],['灭','insight'],['四圣谛现观','insight'],
  ['入流道','liberation'],['入流果','liberation'],['一来道','liberation'],['一来果','liberation'],['不还道','liberation'],['不还果','liberation'],['阿罗汉道','liberation'],['阿罗汉果','liberation'],['回顾智','liberation'],['证悟检验','liberation'],['不执定境','liberation'],['病中与临终','liberation'],['回到日常','liberation'],
]);
const domainMeta = {
  foundation: '条件与生活支持', hindrance: '障碍、辨识与对治', practice: '所缘与入门', concentration: '定、禅那与定境', framework: '修习框架与能力', insight: '观察、洞见与转向', liberation: '道果、检验与回护',
};
const legacyTermOverrides = {
  '发心与正见': ['dukkha', 'sammādiṭṭhi'], '根门防护': ['indriyesu', 'guttadvāro'], '自检心流': ['paccavekkhamāno'],
  '禅相障碍': ['obhāsa', 'nimitta'], '贪欲对治': ['kāmavitakka', 'kāmacchanda'], '选择业处': ['ārammaṇa', 'anussarati'],
  '安般入门': ['ānāpānassati'], '身念入门': ['kāyagatāsati', 'sampajānakārī'], '安止门槛': ['samādhi', 'jhāna'],
  '四梵住成熟': ['appamāṇavihārī', 'mettā'], '受念处': ['vedanā'], '安般十六阶': ['ānāpānassati'], '五蕴观': ['khandha'],
  '六处观': ['saḷāyatana', '六处'], '受观': ['vedanā'], '现法观': ['paccuppannesu', '现在'], '集灭随观': ['samudaya', 'atthaṅgama'], '三相深入': ['anicca', 'anattā'],
  '离贪': ['virāga'], '灭': ['nirodha'], '入流道': ['sotāpanna', 'sotāpatti', '入流'], '一来道': ['sakadāgāmi', '一来'], '一来果': ['sakadāgāmi', '一来'],
  '不还道': ['anāvattidhammo', '不还法', 'orambhāgiyāni'], '不还果': ['anāvattidhammo', '不还法'],
  '回顾智': ['pubbenivāsānussati'], '证悟检验': ['khīṇāsava', 'vimutti'], '回到日常': ['paccavekkhamāno'],
};
const legacySourceOverrides = {
  '嗔恚对治': ['sn46.51'],
  '选择业处': ['mn118', 'mn10', 'sn46.54', 'an6.10'],
  '正勤神足根力': ['sn48.43'],
  '空无边处': ['sn40.6'],
  '识无边处': ['sn40.7'],
  '无所有处': ['sn40.8'],
  '六处观': ['mn9'],
  '入流道': ['sn55.2'],
  '一来道': ['sn55.24'],
  '一来果': ['sn55.8'],
  '不还果': ['mn64'],
};
const legacyTitleOverrides = {
  '现法观': '现在诸法中不被牵引',
  '入流道': '入流者（四法成就）',
  '入流果': '入流果位（不堕恶趣）',
  '一来道': '一来者（三结尽、贪瞋痴薄）',
  '一来果': '一来果位（仅来此世一次）',
  '不还道': '断五下分结之道行',
  '不还果': '不还法（从彼世间不复还）',
};
const nodes = [];
function inheritedSources(parents) { return [...new Set(parents.flatMap(parent => (legacy.get(parent)?.legacy_references || []).map(referenceUid).filter(Boolean)))]; }
function add({ title, parents, terms, kind = 'topic', note = '', source_uids = [], legacy_title = null }) {
  const domain = domainByLegacy.get(parents[0]);
  if (!domain) throw new Error(`没有为 ${title} 指定领域`);
  const id = `v4m-${String(nodes.length + 1).padStart(3, '0')}-${slug(title)}`;
  nodes.push({ id, title, legacy_title, domain, domain_label: domainMeta[domain], kind, legacy_parents: parents, source_uids: [...new Set([...inheritedSources(parents), ...source_uids])], terms, note });
  return id;
}
// Retain every substantive historical node. These are the graph's traceable
// coverage spine; child nodes below expand every bundled enumeration.
for (const item of base.nodes.filter(node => node.node_kind === 'substantive')) add({ title: legacyTitleOverrides[item.label] || item.label, legacy_title: item.label, parents: [item.label], terms: legacyTermOverrides[item.label] || [item.label], source_uids: legacySourceOverrides[item.label] || [], kind: 'legacy_spine', note: item.summary });
const id = title => nodes.find(node => node.title === title)?.id;
const expand = (parent, entries, extraParents = []) => entries.map(([title, terms]) => add({ title, parents: [parent, ...extraParents], terms, kind: 'atomic_member' }));

const hindrances = expand('五盖现前', [['欲贪',['欲贪','kāmacchanda']],['瞋恚',['瞋恚','byāpāda']],['昏沉与睡眠',['昏沉','thīna']],['掉举与悔',['掉举','uddhacca']],['疑盖',['疑','vicikicchā']]]);
const thoughts = expand('不善寻思', [['欲寻',['欲寻','kāmavitakka']],['瞋寻',['瞋寻','byāpādavitakka']],['害寻',['害寻','vihiṃsāvitakka']]]);
const brahma = expand('四无量入门', [['慈',['慈心','mettā']],['悲',['悲','karuṇā']],['喜',['喜','muditā']],['舍梵住',['舍','upekkhā']]]);
const breath = expand('安般十六阶', [
  ['觉知长息',['长入息','长出息','dīghaṃ']],['觉知短息',['短入息','短出息','rassaṃ']],['体验全身',['全身','sabbakāya']],['安止身行',['身行','passambhayaṃ']],
  ['体验喜',['喜','pīti']],['体验乐',['乐','sukha']],['体验心行',['心行','cittasaṅkhāra']],['安止心行',['安止心行','passambhayaṃ cittasaṅkhāraṃ']],
  ['体验心',['体验心','cittaṃ']],['令心喜悦',['令心喜悦','abhippamodayaṃ']],['令心入定',['令心入定','samādahaṃ']],['令心解脱',['令心解脱','vimocayaṃ']],
  ['随观无常',['无常','aniccānupassī']],['随观离贪',['离贪','virāgānupassī']],['随观灭',['灭','nirodhānupassī']],['随观舍遣',['舍遣','paṭinissaggānupassī']],
]);
const factors = expand('七觉支成熟', [['念觉支',['念觉支','satisambojjhaṅga']],['择法觉支',['择法觉支','dhammavicaya']],['精进觉支',['精进觉支','viriya']],['喜觉支',['喜觉支','pīti']],['轻安觉支',['轻安觉支','passaddhi']],['定觉支',['定觉支','samādhi']],['舍觉支',['舍觉支','upekkhā']]]);
const efforts = expand('正勤神足根力', [['防护未生恶',['未生恶','anuppannā']],['断除已生恶',['已生恶','uppannā']],['生起未生善',['未生善','kusala']],['增广已生善',['增长','bhāvanā']]]);
const bases = expand('正勤神足根力', [['欲神足',['欲','chanda']],['精进神足',['精进','viriya']],['心神足',['心','citta']],['观神足',['观','vīmaṃsā']]]);
const faculties = expand('正勤神足根力', [['信根',['信根','saddhindriya']],['精进根',['精进根','viriyindriya']],['念根',['念根','satindriya']],['定根',['定根','samādhindriya']],['慧根',['慧根','paññindriya']]]);
const powers = [
  add({ title: '信力', parents: ['正勤神足根力'], terms: ['信力','saddhābala'], kind: 'atomic_member', source_uids: ['sn48.43'] }),
  add({ title: '精进力', parents: ['正勤神足根力'], terms: ['精进力','viriyabala'], kind: 'atomic_member', source_uids: ['sn48.43'] }),
  add({ title: '念力', parents: ['正勤神足根力'], terms: ['念力','satibala'], kind: 'atomic_member', source_uids: ['sn48.43'] }),
  add({ title: '定力', parents: ['正勤神足根力'], terms: ['定力','samādhibala'], kind: 'atomic_member', source_uids: ['sn48.43'] }),
  add({ title: '慧力', parents: ['正勤神足根力'], terms: ['慧力','paññābala'], kind: 'atomic_member', source_uids: ['sn48.43'] }),
];
const characteristics = expand('三相深入', [['无常相',['无常','anicca']],['苦相',['苦','dukkha']],['无我相',['无我','anattā']]]);
const truths = expand('四圣谛现观', [['苦圣谛',['苦圣谛','dukkhaṃ ariyasaccaṃ']],['苦集圣谛',['苦集','samudaya']],['苦灭圣谛',['苦灭','nirodha']],['苦灭道迹圣谛',['导向苦灭','dukkhanirodhagāminī']]]);

function allRows(node) {
  return node.source_uids.flatMap(uid => sourceRows.get(uid)?.rows || []);
}
function selectEvidence(node) {
  const seen = new Map();
  for (const row of allRows(node)) seen.set(`${row.uid}:${row.work_id}:${row.row_id}`, row);
  const terms = [...new Set(node.terms.flatMap(term => {
    const normalized = norm(term);
    const cjk = [...normalized].filter(char => /[\u4e00-\u9fff]/.test(char)).join('');
    const bigrams = Array.from({ length: Math.max(0, cjk.length - 1) }, (_, index) => cjk.slice(index, index + 2));
    return [normalized, ...bigrams];
  }).filter(term => term.length > 1))];
  const ranked = [...seen.values()].map(row => {
    const text = norm(`${row.pali} ${row.chinese_simplified} ${row.english}`);
    const hits = terms.filter(term => text.includes(term) || (/[a-z]/.test(term) && term.length >= 5 && text.includes(term.slice(0, 5))));
    return { row, hits, score: hits.length * 100 + row.match.score * 10 + row.match.source_coverage };
  }).filter(item => item.hits.length).sort((a, b) => b.score - a.score || a.row.row_id - b.row.row_id);
  if (!ranked.length && node.kind === 'legacy_spine') {
    const fallback = [...seen.values()].sort((a, b) => b.match.score - a.match.score || a.row_id - b.row_id)[0];
    if (!fallback) throw new Error(`旧图节点“${node.title}”没有任何可对齐的 V4 来源`);
    return { ...fallback, matched_terms: [], verification_status: 'legacy_source_index_only' };
  }
  if (!ranked.length) throw new Error(`节点“${node.title}”没有与术语相符的 V4 逐句证据`);
  const pick = ranked[0];
  return { ...pick.row, matched_terms: pick.hits, verification_status: 'verified_v4_alignment' };
}
for (const node of nodes) node.evidence = selectEvidence(node);

const edges = [];
const relationProofTerms = new Map([
  ['正念正知→自检心流', ['sampajānakārī']],
  ['五盖现前→欲贪', ['kāmacchanda']], ['五盖现前→瞋恚', ['byāpāda']], ['五盖现前→昏沉与睡眠', ['thīnamiddha']], ['五盖现前→掉举与悔', ['uddhaccakukkucca']], ['五盖现前→疑盖', ['vicikicchā']],
  ['嗔恚对治→慈', ['byāpāda', 'mettā']],
  ['调节精进→精进觉支', ['līnaṃ', 'viriyasambojjhaṅga']],
  ['选择业处→安般入门', ['ānāpānassati']], ['选择业处→身念入门', ['kāyānupassī']], ['选择业处→四无量入门', ['mettā']], ['选择业处→随念入门', ['anussarati']],
  ['安般入门→安般十六阶', ['dīghaṃ', 'rassaṃ', 'sabbakāya']],
  ['安般十六阶→身念处', ['cattāro satipaṭṭhāne']], ['安般十六阶→七觉支成熟', ['satta bojjhaṅge']],
  ['初禅→第二禅', ['dutiyaṃ jhānaṃ']], ['第二禅→第三禅', ['tatiyaṃ jhānaṃ']], ['第三禅→第四禅', ['catutthaṃ jhānaṃ']],
  ['空无边处→识无边处', ['ākāsānañcāyatanaṃ', 'viññāṇañcāyatanaṃ']], ['识无边处→无所有处', ['viññāṇañcāyatanaṃ', 'ākiñcaññāyatanaṃ']], ['无所有处→非想非非想处', ['ākiñcaññāyatanaṃ', 'nevasaññānāsaññāyatanaṃ']],
  ['法念处→五蕴观', ['pañcasu upādānakkhandhesu']], ['法念处→六处观', ['saḷāyatana']], ['法念处→七觉支成熟', ['sattasu bojjhaṅgesu']],
  ['五蕴观→三相深入', ['anicca', 'dukkha', 'anattā']], ['缘起观→集灭随观', ['samudaya', 'nirodha']],
  ['三相深入→厌离', ['aniccato', '厌离']], ['厌离→离贪', ['nibbidā', 'virāgo']], ['离贪→灭', ['virāgo', 'nirodho']],
  ['入流者（四法成就）→入流果位（不堕恶趣）', ['sotāpanno', 'avinipātadhammo']],
  ['一来者（三结尽、贪瞋痴薄）→一来果位（仅来此世一次）', ['sakadāgāmī', 'sakideva']],
  ['断五下分结之道行→不还法（从彼世间不复还）', ['anāvattidhammo', 'orambhāgiyānaṃ saṃyojanānaṃ']],
  ['阿罗汉道→阿罗汉果', ['khīṇā jāti', 'nāparaṃ itthattāya']], ['阿罗汉果→回顾智', ['pubbenivāsānussati']], ['回到日常→自检心流', ['paccavekkhamāno']],
]);
const relationEvidenceOverrides = new Map([
  ['五蕴观→三相深入', { uid: 'sn22.59', row_ids: [308, 312], mode: 'adjacent_rows' }],
]);
function edge(fromTitle, toTitle, type, claim, sourceParent) {
  const from = id(fromTitle), to = id(toTitle);
  if (!from || !to) throw new Error(`关系端点不存在：${fromTitle} → ${toTitle}`);
  const fromNode = nodes.find(node => node.id === from), toNode = nodes.find(node => node.id === to);
  const shared = fromNode.source_uids.filter(uid => toNode.source_uids.includes(uid));
  const sourceNode = sourceParent ? nodes.find(node => node.title === sourceParent || node.legacy_title === sourceParent || node.legacy_parents.includes(sourceParent)) : null;
  const preferred = sourceParent ? sourceNode?.source_uids || inheritedSources([sourceParent]) : shared;
  if (!preferred.length) throw new Error(`关系没有指定原始出处：${fromTitle} → ${toTitle}`);
  const pairKey = `${fromTitle}→${toTitle}`;
  const proofTerms = relationProofTerms.get(pairKey) || (type === 'contains' ? toNode.terms : []);
  if (!proofTerms.length) throw new Error(`关系缺少逐句核验术语：${pairKey}`);
  const normalizedTerms = proofTerms.map(norm).filter(Boolean);
  const candidates = preferred.flatMap(uid => sourceRows.get(uid)?.rows || []).map(row => ({ row, text: norm(`${row.pali} ${row.chinese_simplified} ${row.english}`) }));
  const override = relationEvidenceOverrides.get(pairKey);
  const overrideItems = override ? override.row_ids.map(rowId => candidates.find(item => item.row.uid === override.uid && item.row.row_id === rowId)).filter(Boolean) : [];
  if (override && overrideItems.length !== override.row_ids.length) throw new Error(`关系指定的多行证据不存在：${pairKey}`);
  const proofCandidates = candidates.filter(item => type === 'contains'
    ? normalizedTerms.some(term => item.text.includes(term) || (term.length > 5 && item.text.includes(term.slice(0, 5))))
    : normalizedTerms.every(term => item.text.includes(term) || (term.length > 5 && item.text.includes(term.slice(0, 5)))));
  proofCandidates.sort((a, b) => normalizedTerms.filter(term => a.text.includes(term)).length - normalizedTerms.filter(term => b.text.includes(term)).length);
  const proof = (overrideItems.length ? overrideItems : proofCandidates).at(-1)?.row;
  const unionText = (overrideItems.length ? overrideItems : proofCandidates).map(item => item.text).join(' ');
  if (override && !normalizedTerms.every(term => unionText.includes(term) || (term.length > 5 && unionText.includes(term.slice(0, 5))))) throw new Error(`关系的多行 V4 证据未覆盖核验术语：${pairKey}`);
  if (!proof) throw new Error(`关系的同句 V4 证据未同时包含核验术语：${pairKey} [${proofTerms.join(', ')}]`);
  edges.push({ id: `edge-${String(edges.length + 1).padStart(3, '0')}`, from, to, type, claim, direction: `${from}→${to}`, source_uids: preferred, relation_terms: proofTerms, evidence_basis: override ? override.mode : (type === 'contains' ? 'same_source_explicit_member' : 'same_sentence_relation_terms'), evidence: proof, evidence_rows: (overrideItems.length ? overrideItems : [{ row: proof }]).map(item => item.row || item), verification_status: 'verified_relation_evidence' });
}
// Structural enumerations: every member is explicit, so no bundled label hides
// a missing component.
for (const child of hindrances) edge('五盖现前', nodes.find(n => n.id === child).title, 'contains', '此盖是五盖观察框架中明示的一项。', '五盖现前');
for (const child of thoughts) edge('不善寻思', nodes.find(n => n.id === child).title, 'contains', '此寻思是经中列举的不善寻思之一。', '不善寻思');
for (const child of brahma) edge('四无量入门', nodes.find(n => n.id === child).title, 'contains', '此梵住是四无量的一个并列修习对象，不构成固定次第。', '四无量入门');
for (const child of breath) edge('安般十六阶', nodes.find(n => n.id === child).title, 'contains', '此项是安般念十六训练中的一个训练式。', '安般十六阶');
for (const child of factors) edge('七觉支成熟', nodes.find(n => n.id === child).title, 'contains', '此项是七觉支的一个培养要素。', '七觉支成熟');
for (const child of efforts) edge('正勤神足根力', nodes.find(n => n.id === child).title, 'contains', '此项是四正勤的一个工作方向。', '正勤神足根力');
for (const child of bases) edge('正勤神足根力', nodes.find(n => n.id === child).title, 'contains', '此项是四神足的一个培养条件。', '正勤神足根力');
for (const child of faculties) edge('正勤神足根力', nodes.find(n => n.id === child).title, 'contains', '此项是五根的一个能力面向。', '正勤神足根力');
for (const child of powers) edge('正勤神足根力', nodes.find(n => n.id === child).title, 'contains', '此项是五力的一个稳固面向。', '正勤神足根力');
for (const child of characteristics) edge('三相深入', nodes.find(n => n.id === child).title, 'contains', '此相是三相观察中的一个角度。', '三相深入');
for (const child of truths) edge('四圣谛现观', nodes.find(n => n.id === child).title, 'contains', '此谛是四圣谛框架中的一个项目。', '四圣谛现观');

// Only source-bounded cross-node claims. Their verbs intentionally avoid
// asserting a universal personal progression.
for (const [from,to,kind,claim,parent] of [
  ['正念正知','自检心流','supports','正念与正知使当下状态可被辨识和复核。','正念正知'],
  ['五盖现前','欲贪','specifies','五盖观察具体辨识欲贪的现起、断除与不再现起。','五盖现前'],
  ['五盖现前','瞋恚','specifies','五盖观察具体辨识瞋恚的现起、断除与不再现起。','五盖现前'],
  ['五盖现前','昏沉与睡眠','specifies','五盖观察具体辨识昏沉与睡眠的现起、断除与不再现起。','五盖现前'],
  ['五盖现前','掉举与悔','specifies','五盖观察具体辨识掉举与悔的现起、断除与不再现起。','五盖现前'],
  ['五盖现前','疑盖','specifies','五盖观察具体辨识疑的现起、断除与不再现起。','五盖现前'],
  ['嗔恚对治','慈','counterpractice','慈被列为处理瞋恚的修习方向；不代表唯一对治。','嗔恚对治'],
  ['调节精进','精进觉支','balances','经文以觉支的适当培育说明精进需要调节而非单向加码。','调节精进'],
  ['选择业处','安般入门','optional_entry','安般念是可选择的入门门径。','选择业处'],
  ['选择业处','身念入门','optional_entry','身念是可选择的入门门径。','选择业处'],
  ['选择业处','四无量入门','optional_entry','四无量是可选择的入门门径。','选择业处'],
  ['选择业处','随念入门','optional_entry','随念是可选择的入门门径。','选择业处'],
  ['安般入门','安般十六阶','develops','安般入门可按十六训练式展开。','安般入门'],
  ['安般十六阶','身念处','supports','经文明确将安般念的修习与四念处圆满相联。','安般十六阶'],
  ['安般十六阶','七觉支成熟','supports','经文明确将安般念的修习与七觉支圆满相联。','安般十六阶'],
  ['初禅','第二禅','described_sequence','同一经文以四禅的描述次序呈现进一步离寻伺与安住。','初禅'],
  ['第二禅','第三禅','described_sequence','同一经文以四禅的描述次序呈现进一步的平静与舍念。','第二禅'],
  ['第三禅','第四禅','described_sequence','同一经文以四禅的描述次序呈现舍、念与清净。','第三禅'],
  ['空无边处','识无边处','described_sequence','经文以无色处的描述次序呈现此进一步转向。','空无边处'],
  ['识无边处','无所有处','described_sequence','经文以无色处的描述次序呈现此进一步转向。','识无边处'],
  ['无所有处','非想非非想处','described_sequence','经文以无色处的描述次序呈现此进一步转向。','无所有处'],
  ['法念处','五蕴观','opens_framework','五蕴在法念处的框架中被明示为观察对象。','法念处'],
  ['法念处','七觉支成熟','opens_framework','觉支在法念处的框架中被明示为观察对象。','法念处'],
  ['五蕴观','三相深入','investigates','蕴的观察可依无常、苦、无我的角度展开。','五蕴观'],
  ['缘起观','集灭随观','investigates','缘起的观察包含集起与止息的条件性理解。','缘起观'],
  ['三相深入','厌离','textual_turn','相关经文以如实观察而生厌离的语言描述转向。','三相深入'],
  ['厌离','离贪','textual_turn','相关经文以厌离、离贪、解脱的语言描述转向。','厌离'],
  ['离贪','灭','textual_turn','相关经文以离贪与止息相联；不把它画成自动心理结果。','厌离'],
  ['入流者（四法成就）','入流果位（不堕恶趣）','path_fruit_pair','经文明确以 sotāpanna 与不堕恶趣、决定趣向正觉描述该成果位；此边不把道果配对扩写为心理因果。','入流道'],
  ['一来者（三结尽、贪瞋痴薄）','一来果位（仅来此世一次）','path_fruit_pair','经文以三结尽、贪瞋痴薄弱及仅来此世一次描述一来成果位；不推断超出原文的修证次第。','一来道'],
  ['断五下分结之道行','不还法（从彼世间不复还）','path_fruit_pair','经文同段说明这是断五下分结的道与行道，并称为不还法；关系限于该段文字的道行—成果并置。','不还道'],
  ['阿罗汉道','阿罗汉果','path_fruit_pair','此为经中明示的道与果配对。','阿罗汉道'],
  ['阿罗汉果','回顾智','review_relation','部分经文以回顾、知见或检验语汇描述证悟后的复核；不普遍化为每位修行者的经验。','回顾智'],
  ['回到日常','自检心流','feedback','日常行住与持续检视形成回护回路。','回到日常'],
]) edge(from,to,kind,claim,parent);

const degree = new Map(nodes.map(node => [node.id, 0]));
for (const edgeItem of edges) { degree.set(edgeItem.from, degree.get(edgeItem.from) + 1); degree.set(edgeItem.to, degree.get(edgeItem.to) + 1); }
for (const node of nodes) if (degree.get(node.id) === 0) {
  node.isolation_status = 'explained_evidence_anchor';
  node.isolation_reason = '旧图保留的独立概念有直接 V4 逐句证据，但当前闭包没有足够直接的关系句将其连接到另一发布节点；为避免凭概念相似度补边，保留为可检索、可引用的独立节点。';
}

const alignedEvidence = (item) => sourceRows.get(item?.uid)?.rows.some(row => row.work_id === item.work_id && row.row_id === item.row_id);
const legacyContextOnly = nodes.filter(node => node.evidence.verification_status === 'legacy_source_index_only');
if (nodes.length !== 128) throw new Error(`原子节点数异常：${nodes.length}`);
if (new Set(nodes.map(node => node.title)).size !== nodes.length) throw new Error('节点名称重复');
if (nodes.some(node => !node.evidence.pali || !node.evidence.chinese_simplified || !node.evidence.english)) throw new Error('存在非三语节点引文');
if (edges.some(edge => !edge.evidence || !alignedEvidence(edge.evidence) || edge.evidence_rows.some(row => !alignedEvidence(row)))) throw new Error('关系没有来自对齐清单的可回读引文');

const graph = {
  format: 'v4-meditation-knowledge-graph/v2', generated_at: new Date().toISOString(),
  scope: { rule: '旧图全部 68 个实质节点 + 其所标示的五盖、三不善寻、四无量、安般十六阶、七觉支、四正勤、四神足、五根、五力、三相、四圣谛的原子成员。', legacy_substantive_nodes: 68, atomic_expansions: 60, node_count: nodes.length, edge_count: edges.length, source_reference_count: aligned.references.length, source_alignment: 'legacy-v4-source-alignment-v1.json' },
  verification: { node_rule: '每个发布节点必须有至少一条由 SuttaCentral 根本巴利逐句对齐、并回读 V4 三语字段的术语证据。', edge_rule: '每条关系必须有类型、方向、关系术语和来自 V4 对齐行的同句或明确相邻行证据；不得只凭节点名称推断。', term_verified_node_count: nodes.length - legacyContextOnly.length, legacy_context_only_node_count: legacyContextOnly.length, relation_verified_edge_count: edges.filter(edge => edge.verification_status === 'verified_relation_evidence').length, status: legacyContextOnly.length ? 'audit_in_progress_not_publishable' : 'verified_source_bounded_graph' },
  relation_types: { contains: '经文所列的组成项目', specifies: '框架对项目的具体辨识', optional_entry: '可选择的修习门径', develops: '同一训练的展开', supports: '经文明示的支持关系', counterpractice: '经文中的对治方向，非唯一处方', balances: '调节关系', described_sequence: '同一经文的描述顺序，非普遍强制次第', optional_development: '可进一步发展，非每人必经', conditional_development: '受严格条件限制的发展', opens_framework: '框架中明示的观察对象', investigates: '观察角度', textual_turn: '经文的转向语言，非自动心理因果', doctrinal_relation: '教义定义关系', path_fruit_pair: '明示的道果配对', review_relation: '经文中的回顾或检验语境', feedback: '回护循环' },
  nodes, edges,
};
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'meditation-knowledge-graph-v2.json'), `${JSON.stringify(graph, null, 2)}\n`);
await writeFile(resolve(outDir, 'meditation-knowledge-graph-v2-audit.md'), `# V4 禅修知识图 v2：发布审计\n\n- 范围锚点：旧图 68 个实质节点，外加其所有明确枚举成员。\n- 节点：${nodes.length}（68 个可追溯主节点 + 60 个原子成员）。\n- 关系：${edges.length}；全部记录类型、方向、关系术语、来源层级与 V4 逐句证据。\n- 公开巴利来源：${aligned.references.length} 个经号条目；其中范围性出处仍保留为审计范围，但不单独充当逐句引文。\n- V4 逐句对齐：${aligned.references.reduce((sum, item) => sum + item.aligned_row_count, 0)} 行候选；节点和关系只取经号对应子经区间内可回读的行。\n- 分层上下文：义注、复注、藏外另存于 meditation-layer-evidence-v1.json，仅用于层级筛选与上下文展示，不替代根本经逐句证据，也不单独证明节点关系。\n\n## 发布门禁\n\n- 术语直接核验节点：${nodes.length - legacyContextOnly.length}/${nodes.length}。\n- 关系证据核验：${edges.filter(edge => edge.verification_status === 'verified_relation_evidence').length}/${edges.length}。\n- 仍仅具旧图来源索引、尚未取得逐句术语证据的历史标签：${legacyContextOnly.map(node => node.title).join('、') || '无'}。\n- 构建状态：**${legacyContextOnly.length ? '不允许发布' : '通过节点与关系证据门禁'}**。\n\n## 明确不作的断言\n\n- 不把并列业处、四念处、四无量、禅那和无色定画成所有人唯一必经的线性路径。\n- 不把注释语汇或经中描述自动推成个人修证结论。\n- 不把同一合集中的相邻经误当作当前经号的引文。\n- 不以关键词命中代替逐句来源对齐。\n`);
console.log(JSON.stringify({ nodes: nodes.length, edges: edges.length, node_evidence: nodes.length, source_refs: new Set(nodes.flatMap(node => node.source_uids)).size, sha256: hash(JSON.stringify(graph)) }, null, 2));
