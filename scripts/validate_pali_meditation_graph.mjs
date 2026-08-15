#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const dir = resolve(root, 'docs/research/pali-meditation-node-network');
const graph = JSON.parse(await readFile(resolve(dir, 'meditation-knowledge-graph-v2.json'), 'utf8'));
const inventory = JSON.parse(await readFile(resolve(dir, 'legacy-node-source-inventory-v1.json'), 'utf8'));
const alignment = JSON.parse(await readFile(resolve(dir, 'legacy-v4-source-alignment-v1.json'), 'utf8'));
const layerEvidence = JSON.parse(await readFile(resolve(dir, 'meditation-layer-evidence-v1.json'), 'utf8'));
const deckDir = resolve(root, 'docs/research/pali-meditation-lecture/network-deck');
const deckManifest = JSON.parse(await readFile(resolve(deckDir, 'manifest.json'), 'utf8'));
const sourceRows = new Map(alignment.references.map(item => [item.uid, item]));
const hash = value => createHash('sha256').update(value).digest('hex');
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
const compactNorm = value => norm(value).replace(/\s+/g, '');
const fail = message => { throw new Error(`V4 禅修节点网门禁失败：${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const rowKey = item => `${item?.uid}:${item?.work_id}:${item?.row_id}`;
const hasAlignedRow = item => sourceRows.get(item?.uid)?.rows.some(row => rowKey(row) === rowKey(item));
const evidenceHashOk = evidence => hash(norm(evidence.pali)) === evidence.anchors.pali_sha256 && hash(norm(evidence.english)) === evidence.anchors.english_sha256;

const legacy = inventory.nodes.filter(node => node.node_kind === 'substantive');
assert(legacy.length === 68, `旧图实质节点应为 68，实际 ${legacy.length}`);
const legacyTitles = new Set(graph.nodes.map(node => node.legacy_title || node.title));
for (const item of legacy) assert(legacyTitles.has(item.label), `旧图节点没有处理结果：${item.label}`);
assert(graph.nodes.length === 128, `节点总数应为 128，实际 ${graph.nodes.length}`);
assert(graph.nodes.filter(node => node.kind === 'legacy_spine').length === 68, '发布图主干节点不是 68 个');
assert(graph.nodes.filter(node => node.kind === 'atomic_member').length === 60, '原子扩展节点不是 60 个');
assert(new Set(graph.nodes.map(node => node.id)).size === graph.nodes.length, '节点 ID 重复');
assert(new Set(graph.nodes.map(node => node.title)).size === graph.nodes.length, '发布节点标题重复');
assert(graph.nodes.every(node => node.evidence?.verification_status === 'verified_v4_alignment'), '存在未通过 V4 逐句核验的节点');
assert(!graph.nodes.some(node => node.evidence?.verification_status === 'legacy_source_index_only'), '存在 legacy_source_index_only 节点');
assert(graph.scope.layer_evidence === 'meditation-layer-evidence-v1.json', '图未登记分层上下文清单');
for (const layer of ['commentary', 'subcommentary', 'other']) {
  assert(layerEvidence.summary[layer].nodes_with_context > 0, `分层上下文为空：${layer}`);
  assert(layerEvidence.summary[layer].rows > 0, `分层上下文没有记录：${layer}`);
}
assert(layerEvidence.rule.includes('不替代节点根本引文'), '分层上下文清单缺少证据边界声明');
assert(deckManifest.format === 'v4-meditation-node-deck/v3', `讲座清单格式错误：${deckManifest.format}`);
assert(deckManifest.base_node_slide_count === graph.nodes.length + 1, `主讲基础页数量不完整：${deckManifest.base_node_slide_count}`);
assert(deckManifest.continuation_slide_count === deckManifest.main_slide_count - deckManifest.base_node_slide_count, '主讲续页数量不一致');
assert(deckManifest.main_slide_count === deckManifest.main.length, '主讲清单数量不一致');
assert(deckManifest.main_slide_count > graph.nodes.length + 1, '主讲页没有生成任何长引文续页');
assert(deckManifest.edge_count === graph.edges.length, '讲座清单的关系数量与图不一致');
assert(deckManifest.appendix_slide_count === deckManifest.appendix.length, '附录清单数量不一致');
assert(new Set(deckManifest.main.map(item => item.slide_id)).size === deckManifest.main.length, '主讲 slide_id 重复');
assert(new Set(deckManifest.appendix.map(item => item.slide_id)).size === deckManifest.appendix.length, '附录 slide_id 重复');
for (const item of deckManifest.main) await readFile(resolve(deckDir, item.file));
for (const item of deckManifest.appendix) await readFile(resolve(deckDir, 'appendix', item.file));
assert(deckManifest.main.some(item => item.slide_id === 'overview'), '主讲页缺少总览页');
assert(graph.nodes.every(node => deckManifest.main.some(item => item.slide_id === `node-${node.id}`)), '主讲页缺少节点基础页');
assert(deckManifest.main.filter(item => item.slide_id.startsWith('node-evidence-')).every(item => item.file.startsWith('slides/evidence-node-')), '续页路径不规范');
assert(deckManifest.appendix.some(item => item.slide_id.startsWith('appendix-edge-')), '附录缺少关系证据页');

const expectedMembers = new Map([
  ['五盖现前', 5], ['不善寻思', 3], ['四无量入门', 4], ['安般十六阶', 16],
  ['七觉支成熟', 7], ['正勤神足根力', 18], ['三相深入', 3], ['四圣谛现观', 4],
]);
for (const [parent, count] of expectedMembers) {
  const actual = graph.nodes.filter(node => node.kind === 'atomic_member' && node.legacy_parents.includes(parent)).length;
  assert(actual === count, `${parent} 原子成员应为 ${count}，实际 ${actual}`);
}

const allowedLayers = new Set(['root_sutta', 'commentary', 'subcommentary', 'other']);
for (const node of graph.nodes) {
  const evidence = node.evidence;
  assert(evidence.pali && evidence.chinese_simplified && evidence.english, `节点缺三语引文：${node.title}`);
  assert(allowedLayers.has(evidence.layer), `节点来源层级非法：${node.title}`);
  assert(evidence.work_title && Array.isArray(evidence.path) && evidence.path.length > 0, `节点缺目录路径：${node.title}`);
  assert(hasAlignedRow(evidence), `节点引文不在对齐清单：${node.title} ${rowKey(evidence)}`);
  assert(evidenceHashOk(evidence), `节点锚点哈希不一致：${node.title}`);
  assert(evidence.reader_url?.includes(evidence.work_id) && evidence.reader_url.includes(`row=${evidence.row_id}`), `节点深链不完整：${node.title}`);
  for (const layer of ['commentary', 'subcommentary', 'other']) {
    const context = node.layer_evidence?.[layer];
    assert(context && ['term_context_available', 'no_direct_term_context_found'].includes(context.status), `节点分层上下文状态非法：${node.title}/${layer}`);
    for (const item of context.entries) {
      assert(item.layer === layer && item.selection === 'term_context_only_not_node_or_relation_proof', `分层上下文边界错误：${node.title}/${layer}`);
      assert(item.pali && item.chinese_simplified && item.english && item.work_id && item.reader_url.includes(`row=${item.row_id}`), `分层上下文缺字段：${node.title}/${layer}`);
      assert(hash(compactNorm(item.pali)) === item.anchors.pali_sha256 && hash(compactNorm(item.english)) === item.anchors.english_sha256, `分层上下文锚点错误：${node.title}/${layer}`);
    }
  }
}

const nodeIds = new Set(graph.nodes.map(node => node.id));
const relationTypes = new Set(Object.keys(graph.relation_types));
for (const edge of graph.edges) {
  assert(nodeIds.has(edge.from) && nodeIds.has(edge.to), `关系端点不存在：${edge.id}`);
  assert(edge.from !== edge.to, `关系自环：${edge.id}`);
  assert(relationTypes.has(edge.type), `关系类型未注册：${edge.type}`);
  assert(edge.direction === `${edge.from}→${edge.to}`, `关系方向不一致：${edge.id}`);
  assert(edge.verification_status === 'verified_relation_evidence', `关系未通过关系证据门禁：${edge.id}`);
  assert(Array.isArray(edge.relation_terms) && edge.relation_terms.length > 0, `关系没有核验术语：${edge.id}`);
  assert(Array.isArray(edge.evidence_rows) && edge.evidence_rows.length > 0, `关系没有证据行：${edge.id}`);
  for (const evidence of edge.evidence_rows) {
    assert(hasAlignedRow(evidence), `关系证据不在对齐清单：${edge.id} ${rowKey(evidence)}`);
    assert(evidence.pali && evidence.chinese_simplified && evidence.english, `关系证据缺三语字段：${edge.id}`);
    assert(evidenceHashOk(evidence), `关系证据锚点哈希不一致：${edge.id}`);
    assert(allowedLayers.has(evidence.layer), `关系证据层级非法：${edge.id}`);
  }
}

const degree = new Map(graph.nodes.map(node => [node.id, 0]));
for (const edge of graph.edges) { degree.set(edge.from, degree.get(edge.from) + 1); degree.set(edge.to, degree.get(edge.to) + 1); }
const isolates = graph.nodes.filter(node => degree.get(node.id) === 0).map(node => node.title);
assert(graph.nodes.filter(node => degree.get(node.id) === 0).every(node => node.isolation_status === 'explained_evidence_anchor' && node.isolation_reason), `存在未解释孤立节点：${isolates.join('、')}`);

const nodeLayers = Object.fromEntries([...allowedLayers].map(layer => [layer, graph.nodes.filter(node => node.evidence.layer === layer).length]));
const edgeTypes = Object.fromEntries([...relationTypes].filter(type => graph.edges.some(edge => edge.type === type)).map(type => [type, graph.edges.filter(edge => edge.type === type).length]));
const result = {
  status: 'passed',
  legacy_substantive_nodes: legacy.length,
  published_nodes: graph.nodes.length,
  atomic_nodes: graph.nodes.filter(node => node.kind === 'atomic_member').length,
  verified_node_evidence: graph.nodes.filter(node => node.evidence.verification_status === 'verified_v4_alignment').length,
  published_edges: graph.edges.length,
  verified_relation_evidence: graph.edges.filter(edge => edge.verification_status === 'verified_relation_evidence').length,
  node_layers: nodeLayers,
  layer_context_summary: layerEvidence.summary,
  edge_types: edgeTypes,
  alignment_references: alignment.references.length,
  alignment_rows: alignment.references.reduce((sum, item) => sum + item.aligned_row_count, 0),
};
console.log(JSON.stringify(result, null, 2));
