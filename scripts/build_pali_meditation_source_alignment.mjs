#!/usr/bin/env node

/**
 * Align each SuttaCentral reference printed in the legacy meditation SVG with
 * actual V4 rows.  It uses the public Bilara Pāli root as a *matching aid*;
 * the emitted quotation is always copied from the immutable V4 archive.
 *
 * This is intentionally a strict gate. A reference without a high-confidence
 * lexical alignment is recorded as unresolved and cannot be used to publish a
 * node or an edge as "verified".
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const inventoryFile = resolve(root, 'docs/research/pali-meditation-node-network/legacy-node-source-inventory-v1.json');
const outDir = resolve(root, 'docs/research/pali-meditation-node-network');
const archive = '/Users/xiebeichen/Downloads/Tipitaka-Reader-V4-Archive/2025-12-04-windows-x64/web-dataset/v1';
const corpusDir = resolve(archive, 'corpus');
const catalog = new Map(JSON.parse(await readFile(resolve(archive, 'catalog/works.json'), 'utf8')).map(item => [item.id, item]));
const layerByLevel = { mula: 'root_sutta', atthakatha: 'commentary', tika: 'subcommentary', other: 'other' };
const hash = value => createHash('sha256').update(value).digest('hex');
const stripHtml = value => String(value ?? '').replace(/<[^>]*>/g, ' ');
const norm = value => stripHtml(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
const tokens = value => norm(value).split(' ').filter(token => token.length > 1);
const tokenSet = value => new Set(tokens(value));
const jaccard = (a, b) => {
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(1, a.size + b.size - common);
};
const coverage = (needle, haystack) => {
  let common = 0;
  for (const token of needle) if (haystack.has(token)) common += 1;
  return common / Math.max(1, needle.size);
};

function uidFromRef(ref) {
  const value = String(ref).trim().toLowerCase().replace(/\s+/g, ' ');
  const mn = value.match(/^mn (\d+)$/); if (mn) return `mn${mn[1]}`;
  const dn = value.match(/^dn (\d+)/); if (dn) return `dn${dn[1]}`;
  const sn = value.match(/^sn (\d+)\.(\d+)$/); if (sn) return `sn${sn[1]}.${sn[2]}`;
  const snCollection = value.match(/^sn (\d+)$/); if (snCollection) return `sn${snCollection[1]}`;
  const an = value.match(/^an (\d+)\.(\d+)/); if (an) return `an${an[1]}.${an[2]}`;
  const ud = value.match(/^ud (\d+)\.(\d+)$/); if (ud) return `ud${ud[1]}.${ud[2]}`;
  const iti = value.match(/^iti (\d+)$/); if (iti) return `iti${iti[1]}`;
  const snp = value.match(/^snp (\d+)\.(\d+)$/); if (snp) return `snp${snp[1]}.${snp[2]}`;
  throw new Error(`无法解析旧图经号：${ref}`);
}
function sourcePath(uid) {
  if (/^mn\d+$/.test(uid)) return `sutta/mn/${uid}_root-pli-ms.json`;
  if (/^dn\d+$/.test(uid)) return `sutta/dn/${uid}_root-pli-ms.json`;
  if (/^sn\d+\.\d+$/.test(uid)) return `sutta/sn/${uid.split('.')[0]}/${uid}_root-pli-ms.json`;
  if (/^an\d+\.\d+$/.test(uid)) return `sutta/an/${uid.split('.')[0]}/${uid}_root-pli-ms.json`;
  if (/^ud\d+\.\d+$/.test(uid)) return `sutta/kn/ud/${uid}_root-pli-ms.json`;
  if (/^iti\d+$/.test(uid)) return `sutta/kn/iti/${uid}_root-pli-ms.json`;
  if (/^snp\d+\.\d+$/.test(uid)) return `sutta/kn/snp/${uid}_root-pli-ms.json`;
  throw new Error(`没有 Bilara 路径规则：${uid}`);
}
function workId(uid) {
  const match = uid.match(/^([a-z]+)(\d+)(?:\.(\d+))?$/);
  const [, collection, first] = match || [];
  const n = Number(first);
  if (collection === 'dn') return n <= 13 ? 's0101m_mul' : n <= 23 ? 's0102m_mul' : 's0103m_mul';
  if (collection === 'mn') return n <= 50 ? 's0201m_mul' : n <= 100 ? 's0202m_mul' : 's0203m_mul';
  if (collection === 'sn') return n <= 11 ? 's0301m_mul' : n <= 21 ? 's0302m_mul' : n <= 34 ? 's0303m_mul' : n <= 44 ? 's0304m_mul' : 's0305m_mul';
  if (collection === 'an') return ({ 1: 's0401m_mul', 2: 's0402m1_mul', 3: 's0402m2_mul', 4: 's0402m3_mul', 5: 's0403m1_mul', 6: 's0403m2_mul', 7: 's0403m3_mul', 8: 's0404m1_mul', 9: 's0404m2_mul', 10: 's0404m3_mul', 11: 's0404m4_mul' })[n];
  if (collection === 'ud') return 's0503m_mul';
  if (collection === 'iti') return 's0504m_mul';
  if (collection === 'snp') return 's0505m_mul';
  throw new Error(`没有 V4 作品规则：${uid}`);
}
const workCache = new Map();
async function workRows(id) {
  if (!workCache.has(id)) {
    const raw = await readFile(resolve(corpusDir, `${id}.json.gz`));
    const rows = JSON.parse(gunzipSync(raw)).rows.filter(row => row.pali_text).map(row => ({ ...row, _tokens: tokenSet(row.pali_text) }));
    const inverted = new Map();
    for (const row of rows) for (const token of row._tokens) {
      const list = inverted.get(token) || [];
      list.push(row);
      inverted.set(token, list);
    }
    // A V4 work file contains many individual discourses. Restrict each
    // Bilara segment to its own heading-to-colophon interval; work-level
    // matching can otherwise attach MN 73 text to MN 68 (both are in the
    // same s0202 file).
    const sections = [];
    let parentChapter = null;
    for (let index = 0; index < rows.length; index += 1) {
      const heading = rows[index];
      const headingText = stripHtml(heading.pali_text).replace(/\s+/g, ' ').trim();
      if (heading.rend === 'chapter') parentChapter = heading;
      if (!['chapter', 'subhead'].includes(heading.rend) || !/^\d+\./.test(headingText)) continue;
      const end = rows.findIndex((row, offset) => offset > index && ['chapter', 'subhead'].includes(row.rend) && /^\d+\./.test(stripHtml(row.pali_text).replace(/\s+/g, ' ').trim()));
      const last = end >= 0 ? end : rows.length;
      sections.push({ start: index + 1, end: last, heading, parentChapter, rows: rows.slice(index + 1, last) });
    }
    workCache.set(id, { rows, inverted, sections });
  }
  return workCache.get(id);
}
async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'SuttaStudyGuide-source-audit/1.0' } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}
const metaCache = new Map();
async function suttaMeta(uid) {
  if (!metaCache.has(uid)) metaCache.set(uid, fetchJson(`https://suttacentral.net/api/suttas/${uid}`));
  return metaCache.get(uid);
}
function titleKey(value) {
  return norm(String(value ?? '').replace(/suttaṃ?$/i, '').replace(/ṃ$/i, ''));
}
async function sectionFor(uid, work) {
  const meta = await suttaMeta(uid);
  const originalTitle = meta?.suttaplex?.original_title || '';
  const key = titleKey(originalTitle);
  let sections = work.sections;
  const sn = uid.match(/^sn(\d+)\./);
  if (sn) {
    const number = Number(sn[1]);
    const baseByWork = { s0301m_mul: 1, s0302m_mul: 12, s0303m_mul: 22, s0304m_mul: 35, s0305m_mul: 45 };
    const base = baseByWork[workId(uid)];
    const expected = base ? number - base + 1 : null;
    if (expected) sections = sections.filter(section => {
      const parentText = stripHtml(section.parentChapter?.pali_text || '').replace(/\s+/g, ' ').trim();
      return new RegExp(`^${expected}\\s*\\.`).test(parentText);
    });
  }
  const ranked = sections.map(section => {
    const core = stripHtml(section.heading.pali_text).replace(/\s+/g, ' ').trim().replace(/^\d+\.\s*/, '');
    const headingKey = titleKey(core);
    let score = 0;
    if (headingKey === key) score = 100;
    else if (headingKey.startsWith(`${key}sutta`)) score = 90;
    else if (headingKey.startsWith(`maha${key}`)) score = 88;
    else if (headingKey.startsWith(`${key}puccha`)) score = 85;
    else if (headingKey.startsWith(`${key}vatthu`)) score = 80;
    else if (headingKey.startsWith(`${key}vagga`)) score = 20;
    return { section, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    throw new Error(`无法将 ${uid} 的 ${originalTitle} 唯一映射到 V4 子经表头（候选 ${ranked.length}）`);
  }
  const topScore = ranked[0].score;
  return ranked.filter(item => item.score === topScore).map(item => item.section);
}
function candidateForSegment(segment, work, section) {
  const sourceTokens = tokenSet(segment);
  if (sourceTokens.size < 4) return null;
  const sectionRows = section?.rows || work.rows;
  const sectionInverted = new Map();
  for (const row of sectionRows) for (const token of row._tokens) {
    const list = sectionInverted.get(token) || [];
    list.push(row);
    sectionInverted.set(token, list);
  }
  const seedTokens = [...sourceTokens]
    .filter(token => token.length > 3 && sectionInverted.has(token))
    .sort((a, b) => sectionInverted.get(a).length - sectionInverted.get(b).length)
    .slice(0, 4);
  const narrowed = new Set();
  for (const token of seedTokens) for (const row of sectionInverted.get(token)) narrowed.add(row);
  // Titles and very short formulae occasionally have no discriminating token;
  // letting those compare against the work is safe, but only the strict
  // alignment thresholds below can admit them.
  const candidates = narrowed.size ? [...narrowed] : sectionRows;
  let best;
  for (const row of candidates) {
    const v4Tokens = row._tokens;
    const sourceCoverage = coverage(sourceTokens, v4Tokens);
    if (sourceCoverage < 0.45) continue;
    const score = sourceCoverage * 0.82 + jaccard(sourceTokens, v4Tokens) * 0.18;
    if (!best || score > best.score || (score === best.score && row.id < best.row.id)) best = { row, score, sourceCoverage };
  }
  return best;
}
function quote(row, uid, sourceKey, score, coverageScore, section) {
  const pali = stripHtml(row.pali_text).replace(/\s+/g, ' ').trim();
  const english = String(row.english_translation ?? '').replace(/\s+/g, ' ').trim();
  const chinese = String(row.chinese_simplified ?? '').replace(/\s+/g, ' ').trim();
  const metadata = catalog.get(workId(uid));
  return {
    uid,
    source_segment: sourceKey,
    work_id: workId(uid),
    work_title: metadata?.title || null,
    path: metadata?.path || null,
    level: metadata?.level || null,
    layer: layerByLevel[metadata?.level] || 'unknown',
    row_id: row.id,
    paranum: row.paranum,
    title: row.title,
    pali,
    chinese_simplified: chinese,
    english,
    anchors: { pali_sha256: hash(norm(pali)), english_sha256: hash(norm(english)) },
    match: { score: Number(score.toFixed(4)), source_coverage: Number(coverageScore.toFixed(4)) },
    section: section ? {
      heading_row_id: section.heading.id,
      heading_pali: stripHtml(section.heading.pali_text).replace(/\s+/g, ' ').trim(),
      start_row_id: section.rows[0]?.id ?? null,
      end_row_id: section.rows.at(-1)?.id ?? null,
    } : null,
    reader_url: `#/tipitaka/read/${workId(uid)}?row=${row.id}&hl=${encodeURIComponent(pali.slice(0, 80))}&hl_lang=pali`,
  };
}

const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
const supplementalReferences = [
  // The legacy chart grouped "五根/五力" under one node but only cited the
  // five-faculty discourse. SN 48.43 is added to verify the five powers rather
  // than silently pretending the old citation proves both enumerations.
  { ref: 'SN 48.43', url: 'https://suttacentral.net/sn48.43/en/sujato', supplemental_reason: '五力的逐项出处' },
  { ref: 'SN 55.2', url: 'https://suttacentral.net/sn55.2/en/sujato', supplemental_reason: '入流者四法的逐句出处' },
  { ref: 'SN 55.8', url: 'https://suttacentral.net/sn55.8/en/sujato', supplemental_reason: '一来者记说的逐句出处' },
  { ref: 'SN 55.24', url: 'https://suttacentral.net/sn55.24/en/sujato', supplemental_reason: '一来者定义的逐句出处' },
];
const uniqueRefs = [...new Map([...inventory.nodes.flatMap(node => node.legacy_references), ...supplementalReferences].map(reference => [uidFromRef(reference.ref), reference])).entries()];
const limiter = (items, concurrency, task) => new Promise((resolve, reject) => {
  const results = []; let cursor = 0; let active = 0; let failed = false;
  const next = () => {
    if (failed) return;
    if (cursor >= items.length && active === 0) return resolve(results);
    while (active < concurrency && cursor < items.length) {
      const index = cursor++; active += 1;
      task(items[index]).then(result => { results[index] = result; active -= 1; next(); }).catch(error => { failed = true; reject(error); });
    }
  };
  next();
});

const aligned = await limiter(uniqueRefs, 2, async ([uid, reference]) => {
  if (/^sn\d+$/.test(uid)) {
    return {
      uid,
      label: reference.ref,
      source_url: reference.url,
      bilara_root_url: null,
      source_segment_count: null,
      aligned_row_count: 0,
      alignment_status: 'collection_reference',
      rows: [],
      note: '该旧图条目指向相应部一整相应，而非单一经；它保留为范围性来源，不能单独充当逐句引文。',
    };
  }
  const sourceUrl = `https://suttacentral.net/api/bilarasuttas/${uid}/sujato`;
  const sourcePayload = await fetchJson(sourceUrl);
  const source = sourcePayload.root_text;
  if (!source || typeof source !== 'object') throw new Error(`SuttaCentral API 没有返回根本巴利文本：${uid}`);
  const rows = await workRows(workId(uid));
  const sections = await sectionFor(uid, rows);
  const candidates = sections.map(section => {
    const matches = [];
    for (const [sourceKey, sourceText] of Object.entries(source)) {
      const candidate = candidateForSegment(sourceText, rows, section);
      if (candidate && candidate.score >= 0.56 && candidate.sourceCoverage >= 0.64) matches.push(quote(candidate.row, uid, sourceKey, candidate.score, candidate.sourceCoverage, section));
    }
    const deduped = [...new Map(matches.map(item => [`${item.work_id}:${item.row_id}`, item])).values()].sort((a, b) => b.match.score - a.match.score || a.row_id - b.row_id);
    return { section, rows: deduped, score: deduped.reduce((sum, item) => sum + item.match.score, 0) };
  }).sort((a, b) => b.rows.length - a.rows.length || b.score - a.score);
  if (!candidates.length || !candidates[0].rows.length) throw new Error(`经号 ${uid} 在候选 V4 子经区间内没有达到阈值的逐句对齐`);
  if (candidates[1] && candidates[0].rows.length === candidates[1].rows.length && Math.abs(candidates[0].score - candidates[1].score) < 0.001) {
    throw new Error(`经号 ${uid} 的同名 V4 子经区间无法唯一消歧`);
  }
  const deduped = candidates[0].rows;
  return {
    uid,
    label: reference.ref,
    source_url: reference.url,
    bilara_root_url: sourceUrl,
    source_segment_count: Object.keys(source).length,
    aligned_row_count: deduped.length,
    alignment_status: deduped.length ? 'aligned' : 'unresolved',
    rows: deduped,
  };
});
const unresolved = aligned.filter(item => item.alignment_status === 'unresolved');
const output = {
  format: 'v4-legacy-source-alignment/v1',
  generated_at: new Date().toISOString(),
  immutable_v4_archive: 'Tipitaka-Reader-V4-Archive/2025-12-04-windows-x64/web-dataset/v1',
  matching_source: 'SuttaCentral Bilara Pāli root (public; used only to match the V4 rows)',
  thresholds: { score: 0.56, source_coverage: 0.64 },
  reference_count: aligned.length,
  aligned_reference_count: aligned.length - unresolved.length,
  unresolved_reference_count: unresolved.length,
  references: aligned,
};
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'legacy-v4-source-alignment-v1.json'), `${JSON.stringify(output, null, 2)}\n`);
if (unresolved.length) throw new Error(`有 ${unresolved.length} 个经号无法与 V4 段落高置信对齐：${unresolved.map(item => item.uid).join(', ')}`);
console.log(JSON.stringify({ references: aligned.length, aligned: output.aligned_reference_count, rows: aligned.reduce((sum, item) => sum + item.aligned_row_count, 0) }, null, 2));
