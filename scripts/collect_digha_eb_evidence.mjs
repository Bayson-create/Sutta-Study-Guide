#!/usr/bin/env node
/* Freeze Early Buddhist results with the exact engine used by the frontend.

   Usage: node scripts/collect_digha_eb_evidence.mjs
   Input:  docs/.../dhamma-search-plan.json
   Output: docs/.../dhamma-early-buddhist-cache.json
*/

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const base = 'https://bayson-create.github.io/Early-Buddhist';
const dataDir = resolve(root, 'docs/research/pali-source-texts/sutta/digha');
const planPath = resolve(dataDir, 'dhamma-search-plan.json');
const cachePath = resolve(dataDir, 'dhamma-early-buddhist-cache.json');

function chineseConverters(indexHtml) {
  const simple = indexHtml.match(/const S2T_S="([\s\S]*?)";/)?.[1];
  const traditional = indexHtml.match(/const S2T_T="([\s\S]*?)";/)?.[1];
  if (!simple || !traditional || simple.length !== traditional.length) throw new Error('无法读取前端繁简映射');
  const toSimple = new Map();
  for (let i = 0; i < simple.length; i++) toSimple.set(traditional[i], simple[i]);
  return text => Array.from(text || '', ch => toSimple.get(ch) || ch).join('');
}

function readerLink(item, query) {
  const params = new URLSearchParams({ view: item.u, lang: 'zh', q: query });
  if (item.c) params.set('coll', item.c);
  if (item.au) params.set('au', item.au);
  if (item.z) params.set('mt', item.z);
  return `${base}/?${params.toString()}`;
}

async function loadEngine(toSimple) {
  const source = await (await fetch(`${base}/search_engine.js`)).text();
  const patched = source.replace(
    'async function fetchJson(path) {\n  const res = await fetch(path);',
    'async function fetchJson(path) {\n  const res = await fetch(EB_BASE + "/" + path);'
  );
  if (patched === source) throw new Error('Early Buddhist 搜索引擎接口已变更');
  return new Function('EB_BASE', 'toS', 'toT', 'EN_STOP', `${patched}\nreturn { engineSearch };`)(base, toSimple, text => text, new Set());
}

const [plan, indexHtml] = await Promise.all([
  readFile(planPath, 'utf8').then(JSON.parse),
  readFile(resolve(root, 'docs/index.html'), 'utf8'),
]);
let cache = { version: 1, engine: 'Early Buddhist engineSearch zh', generated_at: new Date().toISOString(), queries: {} };
try { cache = { ...cache, ...JSON.parse(await readFile(cachePath, 'utf8')) }; } catch { /* first collection */ }
cache.queries ||= {};

const engine = await loadEngine(chineseConverters(indexHtml));
const todo = plan.queries.filter(query => !Array.isArray(cache.queries[query]));
console.log(`Early Buddhist: ${plan.queries.length - todo.length}/${plan.queries.length} cached; collecting ${todo.length}`);

for (let i = 0; i < todo.length; i++) {
  const query = todo[i];
  try {
    const { results } = await engine.engineSearch(query, 'zh', { limit: 8 });
    cache.queries[query] = results.map(item => ({
      uid: item.u || '', collection: item.c || '', title: item.t || '', author: item.a || '',
      translator: item.au || '', text: item.z || '', score: item._score || 0,
      href: readerLink(item, query),
    }));
  } catch (error) {
    cache.queries[query] = [];
    cache.errors ||= [];
    cache.errors.push({ query, error: String(error?.message || error) });
  }
  if ((i + 1) % 25 === 0 || i + 1 === todo.length) {
    cache.generated_at = new Date().toISOString();
    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
    console.log(`Collected ${i + 1}/${todo.length}`);
  }
}
