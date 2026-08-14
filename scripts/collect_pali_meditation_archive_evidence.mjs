#!/usr/bin/env node

/*
 * Offline, exhaustive V4 meditation evidence collector.
 *
 * The Windows V4 archive is the immutable source of truth.  This builder
 * scans every row in all 217 corpus works once, so a temporary API outage
 * cannot turn an incomplete remote response into a published conclusion and
 * no additional Azure query load is required.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const archive = resolve(process.env.TIPITAKA_V4_ARCHIVE || '/Users/xiebeichen/Downloads/Tipitaka-Reader-V4-Archive/2025-12-04-windows-x64');
const dataset = resolve(archive, 'web-dataset/v1');
const termsFile = resolve(root, 'scripts/meditation_terms.json');
const output = resolve(root, 'docs/research/pali-meditation-evidence');
const pageSize = 40;

const text = value => String(value ?? '');
const sha256 = value => createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
const normalizeAnchor = value => text(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const anchorHash = value => sha256(normalizeAnchor(value));
const foldPali = value => normalizeAnchor(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const safeArray = value => Array.isArray(value) ? value : [];

function corpusLayer(work) {
  const level = text(work.level);
  if (level === 'mula') return { key: 'mula', label: '根本三藏', order: 1, number: 1 };
  if (level === 'atthakatha') return { key: 'atthakatha', label: '义注', order: 2, number: 2 };
  if (level === 'tika') return { key: 'tika', label: '复注', order: 3, number: 3 };
  if (level === 'anna' || level === 'other') {
    const firstPath = text(work.path?.[0]);
    if (firstPath.includes('三藏经文') || firstPath.includes('Tipiṭaka Mūla')) return { key: 'mula', label: '根本三藏', order: 1, number: 1 };
    if (firstPath.includes('义注') || firstPath.includes('Aṭṭhakathā')) return { key: 'atthakatha', label: '义注', order: 2, number: 2 };
    if (firstPath.includes('复注') || firstPath.includes('Ṭīkā')) return { key: 'tika', label: '复注', order: 3, number: 3 };
    if (firstPath.includes('藏外') || firstPath.includes('Añña')) return { key: 'anna', label: '藏外典籍', order: 4, number: 4 };
  }
  return { key: 'unknown', label: '未分类', order: null, number: null };
}

function positions(value, term, language) {
  const haystack = language === 'pali' ? foldPali(value) : language === 'en' ? normalizeAnchor(value) : text(value).normalize('NFKC');
  const needle = language === 'pali' ? foldPali(term) : language === 'en' ? normalizeAnchor(term) : text(term).normalize('NFKC');
  if (!needle) return [];
  const hits = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    from = at + Math.max(1, needle.length);
  }
  return hits;
}

function contextRow(row) {
  if (!row) return null;
  return { row_id: Number(row.id), paranum: row.paranum == null ? null : text(row.paranum), text_pali: text(row.pali_text), text_zh: text(row.chinese_simplified), text_en: text(row.english_translation) };
}

function projection(work, row, before, after) {
  const pali = text(row.pali_text);
  const zh = text(row.chinese_simplified);
  const en = text(row.english_translation);
  const layer = corpusLayer(work);
  return {
    work_id: text(work.id),
    row_id: Number(row.id),
    paranum: row.paranum == null ? null : text(row.paranum),
    title: text(work.title || work.id),
    path: safeArray(work.path).map(text),
    layer: layer.number,
    lineage_layer: layer.number,
    text_pali: pali,
    text_zh: zh,
    text_zh_raw: row.chinese_raw == null ? '' : text(row.chinese_raw),
    text_en: en,
    format_flags: { rend: row.rend == null ? null : text(row.rend) },
    snippet: zh || en || pali,
    anchor: text(row.paranum || row.id),
    positions: [],
    reader_url: `https://bayson-create.github.io/Sutta-Study-Guide/#/tipitaka/read/${encodeURIComponent(text(work.id))}?row=${encodeURIComponent(String(row.id))}`,
    anchor_hashes: { pali: anchorHash(pali), english: anchorHash(en) },
    context: { before: contextRow(before), after: contextRow(after) },
    corpus_layer: layer.key,
    corpus_layer_label: layer.label,
    corpus_layer_order: layer.order,
  };
}

const terms = JSON.parse(await readFile(termsFile, 'utf8'));
if (!Array.isArray(terms.queries) || !terms.queries.length) throw new Error('禅修词簇为空');
const catalog = JSON.parse(await readFile(resolve(dataset, 'catalog/works.json'), 'utf8'));
if (!Array.isArray(catalog) || catalog.length !== 217) throw new Error(`目录不完整：${catalog.length}`);

const byQuery = new Map(terms.queries.map(query => [query.id, {
  query_id: query.id,
  language: query.language,
  term: query.term,
  category: query.category,
  status: 'complete',
  reported_total: 0,
  fetched_rows: 0,
  pages: [],
  rows: [],
  error: null,
}]));

let scannedWorks = 0;
let scannedRows = 0;
const queryHits = new Map(terms.queries.map(query => [query.id, new Map()]));
for (const work of catalog) {
  const file = resolve(dataset, work.data_file);
  const decoded = gunzipSync(await readFile(file)).toString('utf8');
  const payload = JSON.parse(decoded);
  const rows = safeArray(payload.rows);
  if (rows.length !== Number(work.row_count)) throw new Error(`行数不一致：${work.id} ${rows.length}/${work.row_count}`);
  for (const [rowIndex, row] of rows.entries()) {
    scannedRows += 1;
    const fields = { zh: text(row.chinese_simplified), pali: text(row.pali_text), en: text(row.english_translation) };
    for (const query of terms.queries) {
      const hitPositions = positions(fields[query.language], query.term, query.language);
      if (!hitPositions.length) continue;
      const key = `${work.id}:${Number(row.id)}`;
      let item = queryHits.get(query.id).get(key);
      if (!item) {
        item = projection(work, row, rows[rowIndex - 1], rows[rowIndex + 1]);
        queryHits.get(query.id).set(key, item);
      }
      item.positions = [...new Set([...(item.positions || []), ...hitPositions])].sort((a, b) => a - b);
    }
  }
  scannedWorks += 1;
  if (scannedWorks % 10 === 0 || scannedWorks === catalog.length) console.log(`扫描 ${scannedWorks}/${catalog.length} 部作品，${scannedRows} 行`);
}

const results = [];
for (const query of terms.queries) {
  const items = [...queryHits.get(query.id).values()].sort((a, b) => `${a.work_id}:${String(a.row_id).padStart(8, '0')}`.localeCompare(`${b.work_id}:${String(b.row_id).padStart(8, '0')}`));
  const target = byQuery.get(query.id);
  target.reported_total = items.length;
  target.fetched_rows = items.length;
  target.pages = Array.from({ length: Math.ceil(items.length / pageSize) }, (_, index) => ({ page: index + 1, count: Math.min(pageSize, items.length - index * pageSize), cursor_in: index ? `local:${index * pageSize}` : null, cursor_out: index + 1 < Math.ceil(items.length / pageSize) ? `local:${(index + 1) * pageSize}` : null }));
  target.rows = items;
  results.push(target);
}

const byKey = new Map();
for (const result of results) {
  for (const row of result.rows) {
    const key = `${row.work_id}:${row.row_id}`;
    let evidence = byKey.get(key);
    if (!evidence) {
      evidence = { ...row, evidence_id: `v4-${sha256(key).slice(0, 16)}`, query_hits: [], categories: [], layers: [], review_status: 'candidate', review_class: 'unreviewed' };
      delete evidence.corpus_layer;
      delete evidence.corpus_layer_label;
      delete evidence.corpus_layer_order;
      const layer = corpusLayer(catalog.find(work => work.id === row.work_id) || {});
      evidence.corpus_layer = layer.key;
      evidence.corpus_layer_label = layer.label;
      evidence.corpus_layer_order = layer.order;
      byKey.set(key, evidence);
    }
    const hit = { query_id: result.query_id, language: result.language, term: result.term, category: result.category, positions: row.positions };
    if (!evidence.query_hits.some(existing => existing.query_id === hit.query_id)) evidence.query_hits.push(hit);
    if (!evidence.categories.includes(result.category)) evidence.categories.push(result.category);
    if (row.layer && !evidence.layers.includes(row.layer)) evidence.layers.push(row.layer);
  }
}
const evidence = [...byKey.values()].sort((a, b) => `${a.work_id}:${String(a.row_id).padStart(8, '0')}`.localeCompare(`${b.work_id}:${String(b.row_id).padStart(8, '0')}`));
const queryAudit = results.map(({ rows, ...audit }) => audit);
const layerCounts = Object.fromEntries([1, 2, 3, 4].map(layer => [String(layer), evidence.filter(row => row.layer === layer).length]));
const categoryCounts = {};
for (const row of evidence) for (const category of row.categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
const archiveManifest = JSON.parse(await readFile(resolve(dataset, 'manifest.json'), 'utf8'));
const manifest = {
  format: 'v4-meditation-evidence/v1',
  generated_at: new Date().toISOString(),
  source: { kind: 'immutable_local_archive', dataset: 'Tipitaka-Reader-V4-Archive/2025-12-04-windows-x64/web-dataset/v1', archive_manifest: archiveManifest, archive_source_sha256: archiveManifest.source_zip_sha256, scanned_work_count: scannedWorks, scanned_row_count: scannedRows },
  corpus: { types: ['corpus'], layers: [1, 2, 3, 4], page_size: pageSize },
  query_source: { file: 'scripts/meditation_terms.json', format: terms.version, query_count: terms.queries.length, selection: null },
  completeness: { query_count: terms.queries.length, complete_queries: results.length, errors: 0, reported_total: results.reduce((sum, item) => sum + item.reported_total, 0), fetched_total: results.reduce((sum, item) => sum + item.fetched_rows, 0), deduplicated_rows: evidence.length, max_pages: null },
  counts: { by_layer: layerCounts, by_category: categoryCounts },
  files: { query_audit: 'query-audit.json', evidence: 'evidence.json', review_queue: 'review-queue.json' },
  review: { status: 'candidate_only', note: '本地归档全量召回完成；API 召回结果与人工判断仍需独立复核，机器筛选不替代经文审核。' },
};
const reviewQueue = evidence.map(row => ({ evidence_id: row.evidence_id, work_id: row.work_id, row_id: row.row_id, title: row.title, layer: row.layer, categories: row.categories, query_hits: row.query_hits, review_status: row.review_status, review_class: row.review_class }));
async function writeJsonArray(file, items) {
  const handle = await open(file, 'w');
  try {
    await handle.write('[');
    for (let index = 0; index < items.length; index += 1) await handle.write(`${index ? ',' : ''}${JSON.stringify(items[index])}`);
    await handle.write(']');
  } finally {
    await handle.close();
  }
}
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'query-audit.json'), JSON.stringify(queryAudit, null, 2));
await writeJsonArray(resolve(output, 'evidence.json'), evidence);
await writeJsonArray(resolve(output, 'review-queue.json'), reviewQueue);
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.completeness, null, 2));
