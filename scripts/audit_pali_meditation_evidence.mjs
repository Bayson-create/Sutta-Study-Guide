#!/usr/bin/env node

/* Validate and classify the exhaustive V4 candidate projection before deck build. */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const evidenceDir = resolve(root, 'docs/research/pali-meditation-evidence');
const manifestPath = resolve(evidenceDir, 'manifest.json');
const evidencePath = resolve(evidenceDir, 'evidence.json');
const outPath = resolve(evidenceDir, 'audited-evidence.json');
const auditPath = resolve(evidenceDir, 'audit-report.json');

const directCategories = new Set(['jhāna', 'samādhi', 'samatha', 'ānāpāna', 'satipaṭṭhāna', 'hindrances', 'brahmavihāra', 'bojjhaṅga', 'object', 'recollection', 'formless', 'nirodha', 'emptiness', 'awakening', 'vipassanā']);
const contextCategories = new Set(['practice_context', 'insight', 'dependent_origination', 'mind']);
const required = ['work_id', 'row_id', 'title', 'path', 'anchor_hashes'];
const sha = value => createHash('sha256').update(String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(), 'utf8').digest('hex');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest.completeness || manifest.completeness.complete_queries !== manifest.completeness.query_count || manifest.completeness.errors || manifest.completeness.max_pages) {
  throw new Error('证据采集未完成：必须先完成所有词条的全部游标分页，才允许生成审计投影。');
}
let rows;
try {
  rows = JSON.parse(await readFile(evidencePath, 'utf8'));
} catch {
  const shardIndex = JSON.parse(await readFile(resolve(evidenceDir, 'evidence-shards.json'), 'utf8'));
  rows = [];
  for (const shard of shardIndex.files || []) rows.push(...JSON.parse(gunzipSync(await readFile(resolve(evidenceDir, shard.file))).toString('utf8')));
}
if (!Array.isArray(rows)) throw new Error('evidence.json 必须是数组');

const errors = [];
const audited = [];
const categoryCounts = {};
const layerCounts = {};
for (const [index, row] of rows.entries()) {
  const missing = required.filter(key => row[key] == null || (typeof row[key] === 'string' && !row[key].trim()) || (Array.isArray(row[key]) && !row[key].length));
  if (missing.length) { errors.push({ index, evidence_id: row.evidence_id, error: 'missing_fields', fields: missing }); continue; }
  if (![row.text_pali, row.text_zh, row.text_en].some(value => String(value || '').trim())) { errors.push({ index, evidence_id: row.evidence_id, error: 'all_language_fields_empty' }); continue; }
  if (!Number.isInteger(Number(row.row_id)) || Number(row.row_id) < 0) { errors.push({ index, evidence_id: row.evidence_id, error: 'invalid_row_id' }); continue; }
  if (!Array.isArray(row.path) || ![1, 2, 3, 4].includes(Number(row.corpus_layer_order))) { errors.push({ index, evidence_id: row.evidence_id, error: 'invalid_layer' }); continue; }
  if (row.anchor_hashes.pali !== sha(row.text_pali) || row.anchor_hashes.english !== sha(row.text_en)) { errors.push({ index, evidence_id: row.evidence_id, error: 'anchor_hash_mismatch' }); continue; }
  const categories = Array.isArray(row.categories) ? row.categories : [];
  const direct = categories.some(category => directCategories.has(category));
  const contextual = categories.some(category => contextCategories.has(category));
  const hitCount = Array.isArray(row.query_hits) ? row.query_hits.length : 0;
  const evidenceClass = direct ? 'direct_practice_or_method' : contextual && hitCount >= 2 ? 'conditions_or_insight_context' : 'lexical_context_requires_review';
  const item = { ...row, evidence_class: evidenceClass, audit: { status: 'machine_screened', rule_version: 'meditation-evidence-rules-v1', reason: direct ? 'specific meditation vocabulary' : contextual && hitCount >= 2 ? 'multiple contextual hits' : 'generic or single-term context; keep visible but do not use as primary claim' } };
  audited.push(item);
  for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
  const layer = row.corpus_layer_label || '未分类'; layerCounts[layer] = (layerCounts[layer] || 0) + 1;
}
const directCount = audited.filter(row => row.evidence_class === 'direct_practice_or_method').length;
const contextCount = audited.filter(row => row.evidence_class === 'conditions_or_insight_context').length;
const lexicalCount = audited.filter(row => row.evidence_class === 'lexical_context_requires_review').length;
const report = {
  format: 'v4-meditation-evidence-audit/v1', generated_at: new Date().toISOString(), source_manifest: manifest,
  input_rows: rows.length, output_rows: audited.length, errors, complete: errors.length === 0,
  counts: { direct_practice_or_method: directCount, conditions_or_insight_context: contextCount, lexical_context_requires_review: lexicalCount, by_layer: layerCounts, by_category: categoryCounts },
  review_policy: '机器规则初筛，不替代人工经文审核；主讲页只用直接/方法与条件/观慧层，词汇相关行保留在附录并显式标记。',
};
await writeFile(outPath, JSON.stringify(audited, null, 2), 'utf8');
await writeFile(auditPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ input_rows: rows.length, output_rows: audited.length, errors: errors.length, counts: report.counts }, null, 2));
