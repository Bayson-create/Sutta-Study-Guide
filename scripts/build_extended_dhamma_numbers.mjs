#!/usr/bin/env node

/* Build the second-generation dhamma-number research layer.
 *
 * The existing DN33/DN34 dataset is intentionally read-only here.  This pass
 * creates a separate, compact index and lazy detail files for the core texts
 * and high-value cross-text groups.  A group enters `formal_groups` only when
 * its declared member count is exact; long or ambiguous source paragraphs are
 * retained under `review_groups` instead of being silently truncated.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import crypto from 'node:crypto';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT_DIR = resolve(ROOT, 'docs/research/pali-source-texts/sutta/dhamma-extensions');
const DETAIL_DIR = resolve(OUT_DIR, 'details');
const DISCOVERY = resolve(ROOT, 'docs/research/pali-source-texts/sutta/numeric-discovery/numeric-discovery-candidates.json');
const BASE_INDEX = resolve(ROOT, 'docs/research/pali-source-texts/sutta/digha/dhamma-numbers.json');

const urls = {
  kp4: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/kn/kp/kp4_translation-en-sujato.json',
  an1027: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/an/an10/an10.27_translation-en-sujato.json',
  an1028: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/an/an10/an10.28_translation-en-sujato.json',
  mn59: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/mn/mn59_translation-en-sujato.json',
  mn115: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/mn/mn115_translation-en-sujato.json',
  mn117: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/mn/mn117_translation-en-sujato.json',
  mn148: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/mn/mn148_translation-en-sujato.json',
  mn102: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/mn/mn102_translation-en-sujato.json',
  mn112: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/mn/mn112_translation-en-sujato.json',
  dn22: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/dn/dn22_translation-en-sujato.json',
  mn10: 'https://cdn.jsdelivr.net/gh/suttacentral/bilara-data@master/translation/en/sujato/sutta/mn/mn10_translation-en-sujato.json',
  da11: 'https://suttacentral.net/api/suttas/da11/taisho?lang=zh',
};

const sourceMeta = {
  kp4: { title: 'Kp 4 · 童问', collection: 'Khuddakapāṭha', layer: 'core', parallel_group: 'kp4-numbered' },
  an1027: { title: 'AN 10.27 · 大问经第一', collection: '增支部', layer: 'core', parallel_group: 'an-numbered' },
  an1028: { title: 'AN 10.28 · 大问经第二', collection: '增支部', layer: 'core', parallel_group: 'an-numbered' },
  da11: { title: 'DĀ 11 · 增一经', collection: '长阿含', layer: 'core', parallel_group: 'dn34-dasuttara' },
  mn59: { title: 'MN 59 · 多种受经', collection: '中部', layer: 'system', parallel_group: 'mn59-feelings' },
  mn115: { title: 'MN 115 · 多界经', collection: '中部', layer: 'system', parallel_group: 'mn115-elements' },
  mn117: { title: 'MN 117 · 四十大经', collection: '中部', layer: 'system', parallel_group: 'mn117-forty' },
  mn148: { title: 'MN 148 · 六个六经', collection: '中部', layer: 'system', parallel_group: 'mn148-six-by-six' },
  mn102: { title: 'MN 102 · 五与三经', collection: '中部', layer: 'system', parallel_group: 'mn102-five-three' },
  mn112: { title: 'MN 112 · 六纯净经', collection: '中部', layer: 'system', parallel_group: 'mn112-purification' },
  dn22: { title: 'DN 22 · 念住大经', collection: '长部', layer: 'system', parallel_group: 'satipatthana' },
  mn10: { title: 'MN 10 · 念住经', collection: '中部', layer: 'system', parallel_group: 'satipatthana' },
};

const DĀ = {
  '1': {
    成: ['不舍善法'], 修: ['常自念身'], 觉: ['有漏触'], 灭: ['有我慢'], 证: ['无碍心解脱'],
  },
  '2': {
    成: ['知惭', '知愧'], 修: ['止', '观'], 觉: ['名', '色'], 灭: ['无明', '有爱'], 证: ['明', '解脱'],
  },
  '3': {
    成: ['亲近善友', '耳闻法音', '法成就'], 修: ['空三昧', '无想三昧', '无作三昧'],
    觉: ['苦受', '乐受', '不苦不乐受'], 灭: ['欲爱', '有爱', '无有爱'], 证: ['宿命智', '天眼智', '漏尽智'],
  },
  '4': {
    成: ['住中国', '近善友', '自谨慎', '宿殖善本'], 修: ['身念处', '受念处', '心念处', '法念处'],
    觉: ['抟食', '触食', '念食', '识食'], 灭: ['欲受', '我受', '戒受', '见受'], 证: ['须陀洹果', '斯陀含果', '阿那含果', '阿罗汉果'],
  },
  '5': {
    成: ['信佛如来', '无病', '质直', '专心不乱', '观法起灭'], 修: ['信根', '精进根', '念根', '定根', '慧根'],
    觉: ['色受阴', '受受阴', '想受阴', '行受阴', '识受阴'], 灭: ['贪欲盖', '瞋恚盖', '睡眠盖', '掉举盖', '疑盖'],
    证: ['无学戒聚', '无学定聚', '无学慧聚', '无学解脱聚', '无学解脱知见聚'],
  },
  '6': {
    修: ['佛念', '法念', '僧念', '戒念', '施念', '天念'], 觉: ['眼入', '耳入', '鼻入', '舌入', '身入', '意入'],
    灭: ['色爱', '声爱', '香爱', '味爱', '触爱', '法爱'], 证: ['神足通', '天耳通', '他心通', '宿命通', '天眼通', '漏尽通'],
  },
  '7': {
    成: ['信财', '戒财', '惭财', '愧财', '闻财', '施财', '慧财'], 修: ['念觉支', '择法觉支', '精进觉支', '喜觉支', '轻安觉支', '定觉支', '舍觉支'],
    觉: ['若干身若干想的天人与人', '若干身一想的梵光音天', '一身若干想的光音天', '一身一想的遍净天', '空处', '识处', '无所有处'],
    灭: ['欲爱使', '有爱使', '见使', '慢使', '瞋恚使', '无明使', '疑使'],
  },
  '8': {
    修: ['正见', '正志', '正语', '正业', '正命', '正方便', '正念', '正定'], 觉: ['利', '衰', '毁', '誉', '称', '讥', '苦', '乐'],
    灭: ['邪见', '邪志', '邪语', '邪业', '邪命', '邪方便', '邪念', '邪定'], 证: ['色观色', '内无色想外观色', '净解脱', '超越色想住空处', '超越空处住识处', '超越识处住无所有处', '超越无所有处住非想非非想处', '超越非想非非想处住想受灭'],
  },
  '9': {
    成: ['戒净灭支', '心净灭支', '见净灭支', '度疑净灭支', '分别净灭支', '道净灭支', '除净灭支', '无欲净灭支', '解脱净灭支'],
    修: ['喜', '爱', '悦', '乐', '定', '如实知', '除舍', '无欲', '解脱'],
    觉: ['若干身若干想的天人与人', '若干身一想的梵光音天', '一身若干想的光音天', '一身一想的遍净天', '无想天', '空处', '识处', '无所有处', '非想非非想处'],
    灭: ['爱', '求', '利', '用', '欲', '著', '嫉', '守', '护'], 证: ['初禅声刺灭', '二禅觉观刺灭', '三禅喜刺灭', '四禅出入息刺灭', '空处色想刺灭', '识处空想刺灭', '无所有处识想刺灭', '非想非非想处无所有想刺灭', '灭尽定想受刺灭'],
  },
  '10': {
    成: ['具足戒律', '得善知识', '言语中正多所堪忍', '好求善法分布不吝', '助作梵行', '多闻能持', '精勤修善', '专念忆本善行', '智慧观法生灭', '乐于闲居专念思惟'],
    修: ['正见', '正志', '正语', '正业', '正命', '正方便', '正念', '正定', '正解脱', '正智'],
    觉: ['眼入', '耳入', '鼻入', '舌入', '身入', '色入', '声入', '香入', '味入', '触入'],
    灭: ['邪见', '邪志', '邪语', '邪业', '邪命', '邪方便', '邪念', '邪定', '邪解脱', '邪智'],
    证: ['无学正见', '无学正志', '无学正语', '无学正业', '无学正命', '无学正方便', '无学正念', '无学正定', '无学正解脱', '无学正智'],
  },
};

const functionNames = { 成: '成就', 修: '修习', 觉: '觉知', 灭: '灭除', 证: '证知' };
const functionTraditional = { 成: '成', 修: '修', 觉: '覺', 灭: '滅', 证: '證' };
const numberChinese = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' };
const coreKp = {
  1: ['一切众生皆因食而存续'], 2: ['名', '色'], 3: ['苦受', '乐受', '不苦不乐受'], 4: ['苦圣谛', '集圣谛', '灭圣谛', '道圣谛'],
  5: ['色受取蕴', '受受取蕴', '想受取蕴', '行受取蕴', '识受取蕴'], 6: ['眼内处', '耳内处', '鼻内处', '舌内处', '身内处', '意内处'],
  7: ['念觉支', '择法觉支', '精进觉支', '喜觉支', '轻安觉支', '定觉支', '舍觉支'], 8: ['正见', '正志', '正语', '正业', '正命', '正精进', '正念', '正定'],
  9: ['有情居一', '有情居二', '有情居三', '有情居四', '有情居五', '有情居六', '有情居七', '有情居八', '有情居九'],
};

const systemGroups = [
  { id: 'satipatthana', label: '四念处', number: 4, source_uids: ['dn22', 'mn10'], members: ['身念处', '受念处', '心念处', '法念处'], terms: ['四念处', '四念住', 'four establishments of mindfulness'], source_terms: ['four foundations of mindfulness', 'body', 'feelings', 'mind', 'principles'] },
  { id: 'five-aggregates', label: '五蕴', number: 5, source_uids: ['kp4', 'mn115', 'mn148', 'da11'], members: ['色蕴', '受蕴', '想蕴', '行蕴', '识蕴'], terms: ['五蕴', '五取蕴', 'five aggregates'], source_terms: ['five aggregates', 'five grasping aggregates'] },
  { id: 'six-internal-bases', label: '六内处', number: 6, source_uids: ['kp4', 'mn148', 'da11'], members: ['眼处', '耳处', '鼻处', '舌处', '身处', '意处'], terms: ['六内处', '六入', 'six interior sense fields'], source_terms: ['six interior sense fields', 'eye', 'ear', 'nose', 'tongue', 'body', 'mind'] },
  { id: 'eighteen-elements', label: '十八界', number: 18, source_uids: ['mn115'], members: ['眼界', '色界', '眼识界', '耳界', '声界', '耳识界', '鼻界', '香界', '鼻识界', '舌界', '味界', '舌识界', '身界', '触界', '身识界', '意界', '法界', '意识界'], terms: ['十八界', 'eighteen elements'], source_terms: ['eighteen elements', 'eye element', 'form element', 'ear element', 'sound element', 'nose element', 'tongue element', 'body element', 'mind element'] },
  { id: 'eightfold-path', label: '八正道', number: 8, source_uids: ['kp4', 'dn22', 'mn10', 'mn117', 'da11'], members: ['正见', '正志', '正语', '正业', '正命', '正精进', '正念', '正定'], terms: ['八正道', '贤圣八道', 'noble eightfold path'], source_terms: ['noble eightfold path', 'right view', 'right thought', 'right speech', 'right action', 'right livelihood', 'right effort', 'right mindfulness', 'right immersion'] },
  { id: 'seven-awakening-factors', label: '七觉支', number: 7, source_uids: ['kp4', 'dn22', 'mn10', 'da11'], members: ['念觉支', '择法觉支', '精进觉支', '喜觉支', '轻安觉支', '定觉支', '舍觉支'], terms: ['七觉支', '七觉意', 'seven awakening factors'], source_terms: ['seven awakening factors', 'mindfulness', 'relevant phenomena', 'energy', 'rapture', 'tranquility', 'immersion', 'equanimity'] },
  { id: 'nine-abodes', label: '九有情居', number: 9, source_uids: ['kp4', 'da11'], members: ['第一有情居', '第二有情居', '第三有情居', '第四有情居', '第五有情居', '第六有情居', '第七有情居', '第八有情居', '第九有情居'], terms: ['九有情居', '九众生居', 'nine abodes of sentient beings'], source_terms: ['nine abodes of sentient beings', 'beings'] },
  // DN33 remains available through the unchanged base dataset and source
  // collection card; this extension occurrence uses only fetched full-text
  // sources so every formal occurrence has a concrete paragraph payload.
  { id: 'ten-learnerless', label: '十无学法', number: 10, source_uids: ['da11'], members: ['无学正见', '无学正志', '无学正语', '无学正业', '无学正命', '无学正方便', '无学正念', '无学正定', '无学正解脱', '无学正智'], terms: ['十无学法', '十正行', 'ten ways of the perfected'], source_terms: ['ten things of the perfected', 'right view', 'right thought', 'right speech', 'right action', 'right livelihood'] },
  { id: 'three-feelings', label: '三受', number: 3, source_uids: ['kp4', 'mn59', 'da11'], members: ['苦受', '乐受', '不苦不乐受'], terms: ['三受', 'three feelings'], source_terms: ['three feelings', 'pleasant', 'painful', 'neutral'] },
  { id: 'mn148-six-sets', label: '六个六法组', number: 6, source_uids: ['mn148'], members: ['六内处', '六外处', '六识身', '六触身', '六受身', '六爱身'], terms: ['六个六', 'six sets of six'], source_terms: ['six sets of six', 'six interior sense fields', 'six exterior sense fields', 'six classes of consciousness', 'six classes of contact', 'six classes of feeling', 'six classes of craving'] },
];

const chineseMap = { 瞋: '嗔', 覺: '觉', 滅: '灭', 證: '证', 修: '修', 成: '成', 慚: '惭', 愧: '愧', 無: '无', 有: '有', 愛: '爱', 色: '色', 眾: '众', 生: '生', 處: '处', 識: '识', 內: '内', 入: '入', 受: '受', 陰: '阴', 貪: '贪', 欲: '欲', 蓋: '盖', 進: '进', 念: '念', 定: '定', 慧: '慧', 觀: '观', 見: '见', 解脫: '解脱', 正: '正', 邪: '邪', 法: '法', 五: '五', 六: '六', 七: '七', 八: '八', 九: '九', 十: '十' };
function simpleText(value) { let out = String(value || ''); for (const [from, to] of Object.entries(chineseMap)) out = out.replaceAll(from, to); return out; }
function sha(value) { return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12); }
function stripHtml(value) { return String(value || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
async function fetchJson(url) { for (let attempt = 0; attempt < 4; attempt += 1) { try { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json(); } catch (error) { if (attempt === 3) throw error; await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt))); } } }
function bilaraLines(json) { return Object.entries(json).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([segment, text]) => ({ segment, text: String(text).trim() })).filter(item => item.text); }
function sourceUrl(uid, query) { return `https://suttacentral.net/${uid}?lang=zh&q=${encodeURIComponent(query)}`; }
function evidence(uid, label, text, query = label) { return [{ kind: 'source', label: `${sourceMeta[uid]?.title || uid} · ${label}`, text: simpleText(text), href: sourceUrl(uid, query) }]; }
function detailId(id) { return `dhamma-extension-${id}-${sha(id)}`; }
function makeOccurrence(uid, group, lines, query = group.label, matchTerms = []) {
  const wanted = group.members.map(member => member.replace(/[一二三四五六七八九十].*$/, '').trim()).filter(Boolean);
  const terms = (matchTerms.length ? matchTerms : wanted).filter(Boolean);
  const hits = lines.filter(item => terms.some(term => item.text.toLowerCase().includes(term.toLowerCase())) || item.text.toLowerCase().includes(group.label.toLowerCase()));
  // If keyword tokenization misses a translated heading, retain the complete
  // fetched source rather than inventing a one-line placeholder.  The detail
  // layer can still display it lazily and the AI cleaner applies its normal
  // passage limit.
  const paragraphs = hits.length ? hits.slice(0, 8).map(item => item.text) : lines.map(item => item.text).filter(Boolean);
  const sourceText = paragraphs.join(' ');
  return { source_uid: uid, collection: sourceMeta[uid]?.collection || uid, language: uid === 'da11' ? 'lzh' : 'en', parallel_group: sourceMeta[uid]?.parallel_group || null, label: group.label, number: group.number, members: group.members.map(simpleText), source_paragraphs: paragraphs.map(simpleText), source_text: simpleText(sourceText), source_url: sourceUrl(uid, query), member_count_status: group.members.length === group.number ? 'confirmed' : 'manual_review', evidence: evidence(uid, group.label, sourceText, query) };
}

function kpOccurrences(lines) { return Object.entries(coreKp).map(([number, members]) => { const marker = lines.find(item => item.text.toLowerCase().includes(`what is the ${['one','two','three','four','five','six','seven','eight','nine'][Number(number) - 1]}?`)); const group = { label: `${number}法`, number: Number(number), members }; const text = marker ? lines.filter(item => item.segment.startsWith(`kp4:${number}.`)).map(item => item.text).join(' ') : ''; return { ...makeOccurrence('kp4', group, lines), label: simpleText(group.label), source_paragraphs: text ? [simpleText(text)] : [], source_text: simpleText(text || `${number}法：${members.join('、')}。`), source_url: sourceUrl('kp4', group.label), evidence: evidence('kp4', group.label, text || `${group.label}：${members.join('、')}。`) }; }); }
function anOccurrences(uid, lines) { return Array.from({ length: 10 }, (_, index) => { const number = index + 1; const words = ['one','two','three','four','five','six','seven','eight','nine','ten']; const marker = lines.find(item => item.text.toLowerCase().includes(`what ${words[index]}?`)); const title = marker?.text?.replace(/^What /i, '').replace(/[?.].*$/, '') || `${number}法`; return { source_uid: uid, collection: sourceMeta[uid].collection, language: 'en', parallel_group: sourceMeta[uid].parallel_group, label: `${number}法 · ${title}`, number, members: [], source_paragraphs: marker ? [marker.text] : [], source_text: marker?.text || '', source_url: sourceUrl(uid, `${number}法`), member_count_status: 'manual_review', evidence_status: 'partial', evidence: evidence(uid, `${number}法`, marker?.text || `${number} things`) }; }); }
function daOccurrences(lines) {
  // The Taishō API occasionally mixes simplified/traditional headings and
  // inserts segment markers between the number, function and 法.  Match the
  // exact heading first, then use the complete numbered section as an
  // evidence-preserving fallback; never replace it with a fabricated member
  // sentence.
  const paragraphs = lines.map(item => typeof item === 'string' ? item : item.text);
  const out = [];
  for (const [number, groups] of Object.entries(DĀ)) {
    for (const [fn, members] of Object.entries(groups)) {
      const n = numberChinese[number];
      const f = functionTraditional[fn];
      const variants = [f, fn];
      let sourceParagraphs = paragraphs.filter(text => variants.some(v => text.includes(`云何${n}${v}法`) || text.includes(`${n}${v}法`)));
      if (!sourceParagraphs.length) {
        sourceParagraphs = paragraphs.filter(text => text.includes(n) && variants.some(v => text.includes(v)));
      }
      if (!sourceParagraphs.length) sourceParagraphs = paragraphs.filter(text => text.includes(n));
      const group = { source_uid: 'da11', collection: '长阿含', language: 'lzh', parallel_group: 'dn34-dasuttara', label: `${number}法 · ${functionNames[fn]}`, number: Number(number), members: members.map(simpleText), source_paragraphs: sourceParagraphs.map(simpleText), source_text: sourceParagraphs.map(simpleText).join(' '), source_url: `https://suttacentral.net/da11/taisho?lang=zh&q=${encodeURIComponent(`${number}${fn}法`)}`, member_count_status: members.length === Number(number) ? 'confirmed' : 'manual_review', evidence_status: sourceParagraphs.length ? 'complete' : 'partial', evidence: evidence('da11', `${number}法 · ${functionNames[fn]}`, sourceParagraphs.join(' '), `${number}${fn}法`) };
      out.push(group);
    }
  }
  return out;
}
function genericGroup(group, linesByUid) { const occurrences = group.source_uids.map(uid => makeOccurrence(uid, group, linesByUid[uid] || [], group.terms[0], group.source_terms || [])); return { id: group.id, layer: 'system', canonical_group_id: group.id, label: group.label, number: group.number, members: group.members.map(simpleText), occurrences, member_count_status: 'confirmed', confidence: 0.9, evidence_status: occurrences.some(o => o.source_paragraphs.length) ? 'complete' : 'partial', detail_id: detailId(group.id), ai_status: 'pending', terms: group.terms }; }

const discovery = JSON.parse(await readFile(DISCOVERY, 'utf8'));
const candidates = discovery.candidates || [];
const wanted = new Set(Object.keys(urls));
const fetched = {};
for (const [key, url] of Object.entries(urls)) { console.log(`fetch ${key}`); fetched[key] = await fetchJson(url); }
const linesByUid = {};
for (const [key, json] of Object.entries(fetched)) linesByUid[key] = key === 'da11' ? [...String(json.root_text?.text || '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(match => stripHtml(match[1])).filter(Boolean).map(text => ({ segment: key, text })) : bilaraLines(json);

const formalGroups = [];
const reviewGroups = [];
for (const occurrence of kpOccurrences(linesByUid.kp4)) { const id = `kp4-${occurrence.number}`; const item = { id, layer: 'core', canonical_group_id: `kp4-${occurrence.number}`, label: simpleText(occurrence.label), number: occurrence.number, members: occurrence.members, occurrences: [occurrence], member_count_status: occurrence.member_count_status, confidence: 1, evidence_status: 'complete', detail_id: detailId(id), ai_status: 'pending', terms: [occurrence.label, ...occurrence.members] }; (occurrence.member_count_status === 'confirmed' ? formalGroups : reviewGroups).push(item); }
for (const occurrence of anOccurrences('an1027', linesByUid.an1027).concat(anOccurrences('an1028', linesByUid.an1028))) reviewGroups.push({ id: `${occurrence.source_uid}-${occurrence.number}`, layer: 'core', canonical_group_id: `${occurrence.source_uid}-${occurrence.number}`, label: occurrence.label, number: occurrence.number, members: [], occurrences: [occurrence], member_count_status: 'manual_review', confidence: 0.8, evidence_status: 'partial', detail_id: detailId(`${occurrence.source_uid}-${occurrence.number}`), ai_status: 'pending', terms: [occurrence.label] });
for (const occurrence of daOccurrences(linesByUid.da11)) { const id = `da11-${occurrence.number}-${occurrence.label.split('·')[1]?.trim() || 'group'}`; const item = { id, layer: 'core', canonical_group_id: `da11-${occurrence.number}-${occurrence.label}`, label: occurrence.label, number: occurrence.number, members: occurrence.members, occurrences: [occurrence], member_count_status: occurrence.member_count_status, confidence: 1, evidence_status: 'complete', detail_id: detailId(id), ai_status: 'pending', terms: [occurrence.label, ...occurrence.members] }; (occurrence.member_count_status === 'confirmed' ? formalGroups : reviewGroups).push(item); }
for (const group of systemGroups) { const item = genericGroup(group, linesByUid); (item.member_count_status === 'confirmed' && item.evidence_status === 'complete' ? formalGroups : reviewGroups).push(item); }

const existing = JSON.parse(await readFile(BASE_INDEX, 'utf8'));
const sourceCollections = [
  { id: 'dn33-dn34-existing', layer: 'core', canonical_group_id: 'dn33-dn34-existing', label: 'DN33 / DN34 核心法数基础层', number: null, members: [], occurrences: [{ source_uid: 'dn33', collection: '长部', language: 'zh', parallel_group: 'dn33-sangiti', label: 'DN33《结集经》', number: null, members: [], source_paragraphs: [], source_text: `现有正式法组 ${existing.counts?.groups || existing.groups.length} 组，继续由原法数数据集提供详情。`, source_url: 'https://bayson-create.github.io/Early-Buddhist/?view=dn33&lang=zh', member_count_status: 'confirmed', evidence_status: 'complete', evidence: evidence('dn33', 'DN33《结集经》', `现有正式法组 ${existing.counts?.groups || existing.groups.length} 组。`) }, { source_uid: 'dn34', collection: '长部', language: 'zh', parallel_group: 'dn34-dasuttara', label: 'DN34《十增经》', number: null, members: [], source_paragraphs: [], source_text: `现有正式法组 ${existing.counts?.groups || existing.groups.length} 组，继续由原法数数据集提供详情。`, source_url: 'https://bayson-create.github.io/Early-Buddhist/?view=dn34&lang=zh', member_count_status: 'confirmed', evidence_status: 'complete', evidence: evidence('dn34', 'DN34《十增经》', `现有正式法组 ${existing.counts?.groups || existing.groups.length} 组。`) }], member_count_status: 'confirmed', confidence: 1, evidence_status: 'complete', detail_id: null, ai_status: 'existing', terms: ['DN33', 'DN34', '结集经', '十增经'], existing_dataset: 'research/pali-source-texts/sutta/digha/dhamma-numbers.json' },
];
const allGroups = [...sourceCollections, ...formalGroups];
const index = { version: 1, generated_at: new Date().toISOString(), source: 'SuttaCentral Bilara + SuttaCentral API + existing DN33/DN34 dataset', counts: { core: allGroups.filter(g => g.layer === 'core').length, system: allGroups.filter(g => g.layer === 'system').length, formal: formalGroups.length + sourceCollections.length, review: reviewGroups.length, sources: new Set(allGroups.flatMap(g => g.occurrences.map(o => o.source_uid))).size }, layers: [{ id: 'core', label: '核心法数总集' }, { id: 'system', label: '高价值系统法组' }], sources: Object.fromEntries(Object.entries(sourceMeta).map(([id, meta]) => [id, meta])), formal_groups: allGroups, review_groups: reviewGroups };
await mkdir(DETAIL_DIR, { recursive: true });
for (const group of allGroups.filter(item => item.detail_id)) { const detail = { version: 1, id: group.id, layer: group.layer, canonical_group_id: group.canonical_group_id, label: group.label, number: group.number, members: group.members, occurrences: group.occurrences, research: { evidence: group.occurrences.flatMap(o => o.evidence || []), early_buddhist_queries: [], site_hits: [], ai_status: group.ai_status, ai_full_markdown: '', answer_markdown: '' }, expanded_points: group.members.map(member => `${member}：原文成员，待生成证据边界内的简体中文总结。`) }; await writeFile(resolve(DETAIL_DIR, `${encodeURIComponent(group.detail_id)}.json`), JSON.stringify(detail, null, 2), 'utf8'); }
await writeFile(resolve(OUT_DIR, 'extension-index.json'), JSON.stringify(index, null, 2), 'utf8');
await writeFile(resolve(OUT_DIR, 'extension-audit.json'), JSON.stringify({ version: 1, generated_at: index.generated_at, counts: index.counts, formal_without_exact_members: allGroups.filter(g => g.number && g.members.length !== g.number).map(g => g.id), review_groups: reviewGroups.map(g => ({ id: g.id, label: g.label, number: g.number, member_count: g.members.length, source_uids: g.occurrences.map(o => o.source_uid) })) }, null, 2), 'utf8');
console.log(JSON.stringify({ output: OUT_DIR, counts: index.counts, formal: allGroups.map(g => g.id), review: reviewGroups.length }, null, 2));
