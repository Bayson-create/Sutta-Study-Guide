#!/usr/bin/env node

/*
 * Additive layer evidence for the published graph. Root-sutta evidence stays
 * the audited citation for every node. Commentary, subcommentary and other
 * rows are only optional, explicitly labelled reading context; they never
 * replace a root citation or create a new relation by keyword alone.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const archive = '/Users/xiebeichen/Downloads/Tipitaka-Reader-V4-Archive/2025-12-04-windows-x64/web-dataset/v1';
const graphPath = resolve(root, 'docs/research/pali-meditation-node-network/meditation-knowledge-graph-v2.json');
const outPath = resolve(root, 'docs/research/pali-meditation-node-network/meditation-layer-evidence-v1.json');
const catalog = JSON.parse(await readFile(resolve(archive, 'catalog/works.json'), 'utf8'));
const graph = JSON.parse(await readFile(graphPath, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const strip = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = value => strip(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
const layerByLevel = { mula: 'root_sutta', atthakatha: 'commentary', tika: 'subcommentary', other: 'other' };
const layers = ['commentary', 'subcommentary', 'other'];
const records = new Map(graph.nodes.map(node => [node.id, Object.fromEntries(layers.map(layer => [layer, []]))]));
const termsByNode = new Map(graph.nodes.map(node => [node.id, [...new Set(node.terms.map(norm).filter(term => term.length >= 2))]]));
const bestByNodeLayer = new Map(graph.nodes.map(node => [node.id, Object.fromEntries(layers.map(layer => [layer, new Map()]))]));

for (const work of catalog) {
  const layer = layerByLevel[work.level];
  if (!layers.includes(layer)) continue;
  const data = JSON.parse(gunzipSync(await readFile(resolve(archive, work.data_file))).toString());
  for (const row of data.rows.filter(item => item.pali_text || item.chinese_simplified || item.english_translation)) {
    const pali = strip(row.pali_text);
    const chinese = strip(row.chinese_simplified);
    const english = strip(row.english_translation);
    const text = norm(`${pali} ${chinese} ${english}`);
    for (const node of graph.nodes) {
      const matchedTerms = termsByNode.get(node.id).filter(term => text.includes(term));
      if (!matchedTerms.length) continue;
      // Avoid promoting generic one-word matches as context when a longer
      // direct term exists. Keep a small deterministic sample per layer.
      const score = matchedTerms.reduce((sum, term) => sum + term.length * term.length, 0);
      const item = {
        uid: `v4:${work.id}:${row.id}`,
        work_id: work.id,
        work_title: work.title,
        path: work.path,
        level: work.level,
        layer,
        row_id: row.id,
        paranum: row.paranum,
        matched_terms: matchedTerms,
        pali,
        chinese_simplified: chinese,
        english,
        anchors: { pali_sha256: hash(norm(pali)), english_sha256: hash(norm(english)) },
        reader_url: `#/tipitaka/read/${work.id}?row=${row.id}&hl=${encodeURIComponent(pali.slice(0, 80))}&hl_lang=pali`,
        selection: 'term_context_only_not_node_or_relation_proof',
      };
      const map = bestByNodeLayer.get(node.id)[layer];
      const key = `${work.id}:${row.id}`;
      const prior = map.get(key);
      if (!prior || score > prior._score) map.set(key, { ...item, _score: score });
    }
  }
}

for (const node of graph.nodes) {
  for (const layer of layers) {
    const entries = [...bestByNodeLayer.get(node.id)[layer].values()]
      .sort((a, b) => b._score - a._score || a.work_id.localeCompare(b.work_id) || a.row_id - b.row_id)
      .slice(0, 3)
      .map(({ _score, ...item }) => item);
    records.get(node.id)[layer] = entries;
    node.layer_evidence = node.layer_evidence || {};
    node.layer_evidence[layer] = { status: entries.length ? 'term_context_available' : 'no_direct_term_context_found', entries };
  }
}

const summary = Object.fromEntries(layers.map(layer => [layer, {
  nodes_with_context: graph.nodes.filter(node => node.layer_evidence[layer].entries.length).length,
  rows: graph.nodes.reduce((sum, node) => sum + node.layer_evidence[layer].entries.length, 0),
}]));
const output = {
  format: 'v4-meditation-layer-evidence/v1',
  source: 'Tipitaka-Reader-V4-Archive/2025-12-04-windows-x64/web-dataset/v1',
  rule: '仅为根本经节点提供分层阅读上下文，不替代节点根本引文，不单独证明关系，不据此扩展节点网。',
  layers,
  summary,
  nodes: Object.fromEntries(records),
};
graph.scope.layer_evidence = 'meditation-layer-evidence-v1.json';
graph.verification.layer_context_rule = output.rule;
await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
