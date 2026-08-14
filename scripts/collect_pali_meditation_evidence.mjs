#!/usr/bin/env node

/*
 * Exhaustive V4 meditation evidence collector.
 *
 * This is an audit builder, not a relevance oracle. It pages every configured
 * literal query through the public V4 API, keeps the complete row returned by
 * the API, merges duplicate work_id + row_id hits, and records every query
 * which caused the row to be included. Raw V4 corpus files and defaults are
 * never modified.
 *
 * Usage:
 *   node scripts/collect_pali_meditation_evidence.mjs
 *   node scripts/collect_pali_meditation_evidence.mjs --max-pages 1
 *   node scripts/collect_pali_meditation_evidence.mjs --out /tmp/evidence
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_API = 'https://sutta-api.agreeablemeadow-9da329ca.swedencentral.azurecontainerapps.io/api/tipitaka/v1';
const DEFAULT_OUT = resolve(ROOT, 'docs/research/pali-meditation-evidence');
const DEFAULT_TERMS = resolve(ROOT, 'scripts/meditation_terms.json');
const DEFAULT_LAYER = '1|2|3|4';
const PAGE_SIZE = 40;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const API = String(arg('--api', process.env.TIPITAKA_API || DEFAULT_API)).replace(/\/$/, '');
const OUT = resolve(arg('--out', DEFAULT_OUT));
const TERMS_FILE = resolve(arg('--terms', DEFAULT_TERMS));
const MAX_PAGES = Number(arg('--max-pages', '0')) || 0;
const CONCURRENCY = Math.max(1, Math.min(6, Number(arg('--concurrency', '3')) || 3));
const RETRIES = Math.max(1, Math.min(5, Number(arg('--retries', '4')) || 4));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(arg('--timeout-ms', '45000')) || 45000);
const ONLY = String(arg('--only', '')).trim();
const QUERY_DIR_NAME = 'query-results';

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const sha256 = value => createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
const normalizeAnchor = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const anchorHash = value => sha256(normalizeAnchor(value));
const text = value => String(value ?? '');
const cleanArray = value => Array.isArray(value) ? value.map(text) : [];
function corpusLayer(path) {
  const root = cleanArray(path)[0] || '';
  if (root.includes('三藏经文') || root.includes('Tipiṭaka Mūla')) return { key: 'mula', label: '根本三藏', order: 1 };
  if (root.includes('义注') || root.includes('Aṭṭhakathā')) return { key: 'atthakatha', label: '义注', order: 2 };
  if (root.includes('复注') || root.includes('Ṭīkā')) return { key: 'tika', label: '复注', order: 3 };
  if (root.includes('藏外') || root.includes('Añña')) return { key: 'anna', label: '藏外典籍', order: 4 };
  return { key: 'unknown', label: '未分类', order: null };
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal }).finally(() => clearTimeout(timer));
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`);
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < RETRIES) await sleep(400 * (2 ** attempt));
    }
  }
  throw lastError;
}

function queryUrl(query, cursor = '') {
  const params = new URLSearchParams({ q: query.term, lang: query.language, limit: String(PAGE_SIZE), types: 'corpus', layer: DEFAULT_LAYER, include_source: 'true' });
  if (cursor) params.set('cursor', cursor);
  return `${API}/search?${params}`;
}

function evidenceKey(item) {
  return `${text(item.work_id)}:${Number(item.row_id)}`;
}

function rowProjection(item) {
  // The deployed sutta-api keeps the compact public names `pali`, `text`,
  // and `en`; the semantic service uses `text_pali`, `text_zh`, `text_en`.
  // Accept both contracts so an API rollout cannot silently erase a language.
  const pali = text(item.text_pali || item.pali || item.pali_text);
  const zh = text(item.text_zh || item.text || item.chinese_simplified || item.chinese_raw);
  const en = text(item.text_en || item.en || item.english_translation || item.english);
  const source = item.source_fields && typeof item.source_fields === 'object' ? item.source_fields : {};
  return {
    work_id: text(item.work_id),
    row_id: Number(item.row_id),
    paranum: item.paranum == null ? null : text(item.paranum),
    title: text(item.title || item.work_id),
    path: cleanArray(item.path),
    layer: Number(item.lineage_layer || item.layer || 0) || null,
    lineage_layer: Number(item.lineage_layer || item.layer || 0) || null,
    text_pali: pali,
    text_zh: zh,
    text_zh_raw: text(source.chinese_raw),
    text_en: en,
    format_flags: source.format_flags || {},
    snippet: text(item.snippet),
    anchor: text(item.anchor),
    positions: Array.isArray(item.positions) ? item.positions.map(Number).filter(Number.isFinite) : [],
    reader_url: text(item.reader_url),
    anchor_hashes: {
      pali: anchorHash(pali),
      english: anchorHash(en),
    },
  };
}

async function collectQuery(query) {
  const rows = new Map();
  const pages = [];
  const seenCursors = new Set();
  let cursor = '';
  let reportedTotal = null;
  let pageCount = 0;
  try {
    while (true) {
      if (MAX_PAGES && pageCount >= MAX_PAGES) break;
      if (cursor && seenCursors.has(cursor)) throw new Error('分页游标重复，拒绝静默截断');
      if (cursor) seenCursors.add(cursor);
      const data = await fetchJson(queryUrl(query, cursor));
      pageCount += 1;
      const results = Array.isArray(data.results) ? data.results : [];
      if (reportedTotal == null) reportedTotal = Number(data.total ?? results.length);
      pages.push({ page: pageCount, count: results.length, cursor_in: cursor || null, cursor_out: data.next_cursor || null });
      for (const item of results) {
        const key = evidenceKey(item);
        if (!key || key === ':NaN') continue;
        rows.set(key, rowProjection(item));
      }
      cursor = text(data.next_cursor);
      if (!cursor || !results.length) break;
    }
    return {
      query_id: query.id, language: query.language, term: query.term, category: query.category,
      status: MAX_PAGES && pageCount >= MAX_PAGES ? 'partial_by_option' : 'complete',
      reported_total: reportedTotal ?? 0, fetched_rows: [...rows.values()].length,
      pages, rows: [...rows.values()], error: null,
    };
  } catch (error) {
    return {
      query_id: query.id, language: query.language, term: query.term, category: query.category,
      status: 'error', reported_total: reportedTotal ?? 0, fetched_rows: [...rows.values()].length,
      pages, rows: [...rows.values()], error: String(error?.message || error),
    };
  }
}

async function workerQueue(items, workerCount, worker) {
  let cursor = 0;
  const output = [];
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, run));
  return output;
}

function mergeEvidence(results) {
  const byKey = new Map();
  for (const result of results) {
    for (const row of result.rows) {
      const key = evidenceKey(row);
      let evidence = byKey.get(key);
      if (!evidence) {
        const corpus = corpusLayer(row.path);
        evidence = { ...row, corpus_layer: corpus.key, corpus_layer_label: corpus.label, corpus_layer_order: corpus.order, evidence_id: `v4-${sha256(key).slice(0, 16)}`, query_hits: [], categories: [], layers: [], review_status: 'candidate', review_class: 'unreviewed' };
        byKey.set(key, evidence);
      }
      const hit = { query_id: result.query_id, language: result.language, term: result.term, category: result.category, positions: row.positions };
      if (!evidence.query_hits.some(existing => existing.query_id === hit.query_id)) evidence.query_hits.push(hit);
      if (!evidence.categories.includes(result.category)) evidence.categories.push(result.category);
      if (row.layer && !evidence.layers.includes(row.layer)) evidence.layers.push(row.layer);
    }
  }
  return [...byKey.values()].sort((a, b) => `${a.work_id}:${String(a.row_id).padStart(8, '0')}`.localeCompare(`${b.work_id}:${String(b.row_id).padStart(8, '0')}`));
}

async function main() {
  const terms = JSON.parse(await readFile(TERMS_FILE, 'utf8'));
  if (!Array.isArray(terms.queries) || !terms.queries.length) throw new Error('词簇为空');
  const queries = ONLY ? terms.queries.filter(query => query.id === ONLY || query.term === ONLY) : terms.queries;
  if (!queries.length) throw new Error(`找不到词条: ${ONLY}`);
  await mkdir(OUT, { recursive: true });
  const queryDir = resolve(OUT, QUERY_DIR_NAME);
  await mkdir(queryDir, { recursive: true });
  const startedAt = new Date().toISOString();
  console.log(`Collecting ${queries.length} queries from ${API}`);
  const results = await workerQueue(queries, CONCURRENCY, async (query, index) => {
    const checkpoint = resolve(queryDir, `${query.id}.json`);
    try {
      const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
      if (saved.status === 'complete' && (!MAX_PAGES || saved.pages?.length >= MAX_PAGES)) {
        console.log(`[${index + 1}/${queries.length}] ${query.language} ${query.term}: 使用已完成检查点 ${saved.fetched_rows}/${saved.reported_total}`);
        return saved;
      }
    } catch { /* no checkpoint yet */ }
    const result = await collectQuery(query);
    await writeFile(checkpoint, JSON.stringify(result), 'utf8');
    console.log(`[${index + 1}/${queries.length}] ${query.language} ${query.term}: ${result.fetched_rows}/${result.reported_total} (${result.status})${result.error ? ` · ${result.error}` : ''}`);
    return result;
  });
  const evidence = mergeEvidence(results);
  const queryAudit = results.map(({ rows, ...audit }) => audit);
  const errors = queryAudit.filter(item => item.status === 'error');
  const complete = queryAudit.filter(item => item.status === 'complete');
  const reportedTotal = queryAudit.reduce((sum, item) => sum + Number(item.reported_total || 0), 0);
  const fetchedTotal = queryAudit.reduce((sum, item) => sum + Number(item.fetched_rows || 0), 0);
  const layerCounts = Object.fromEntries([1, 2, 3, 4].map(layer => [String(layer), evidence.filter(row => row.layer === layer).length]));
  const categoryCounts = {};
  for (const row of evidence) for (const category of row.categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
  const manifest = {
    format: 'v4-meditation-evidence/v1',
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    api_base: API,
    corpus: { types: ['corpus'], layers: [1, 2, 3, 4], page_size: PAGE_SIZE },
    query_source: { file: TERMS_FILE, format: terms.version, query_count: queries.length, selection: ONLY || null },
    completeness: { query_count: queries.length, complete_queries: complete.length, errors: errors.length, reported_total: reportedTotal, fetched_total: fetchedTotal, deduplicated_rows: evidence.length, max_pages: MAX_PAGES || null },
    counts: { by_layer: layerCounts, by_category: categoryCounts },
    files: { query_audit: 'query-audit.json', evidence: 'evidence.json', review_queue: 'review-queue.json' },
    review: { status: 'candidate_only', note: 'API 召回结果尚未人工判断是否构成禅修证据；发布讲座前必须完成逐条纳入/排除审核。' },
  };
  const reviewQueue = evidence.map(row => ({ evidence_id: row.evidence_id, work_id: row.work_id, row_id: row.row_id, title: row.title, layer: row.layer, categories: row.categories, query_hits: row.query_hits, review_status: row.review_status, review_class: row.review_class }));
  await writeFile(resolve(OUT, 'query-audit.json'), JSON.stringify(queryAudit, null, 2), 'utf8');
  await writeFile(resolve(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  await writeFile(resolve(OUT, 'review-queue.json'), JSON.stringify(reviewQueue, null, 2), 'utf8');
  await writeFile(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify(manifest.completeness, null, 2));
}

await main();
