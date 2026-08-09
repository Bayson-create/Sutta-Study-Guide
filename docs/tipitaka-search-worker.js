/* Typed, position-aware V4 search worker.  Source text stays in V1. */
(() => {
  const manifestCache = new Map();
  const shardCache = new Map();
  const wordRe = /[A-Za-zĀĪŪṂṀṄÑṬḌṆḶāīūṃṁṅñṭḍṇḷ]+/g;
  const baseUrl = (base, path) => `${base.replace(/\/$/, '')}/${path}`;
  const normalizePali = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const normalizeEnglish = value => String(value || '').toLowerCase();
  const hashBucket = async key => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return new DataView(bytes).getUint32(0) % 256;
  };
  const prefixBucket = key => {
    const clean = key.toLowerCase().replace(/[^a-z0-9]/g, '_');
    return (clean.slice(0, 2) || '__').padEnd(2, '_');
  };
  async function cachedJson(base, path) {
    const key = baseUrl(base, path);
    if (!shardCache.has(key)) {
      const promise = (async () => {
        const request = new Request(key, { mode: 'cors' });
        const cache = typeof caches !== 'undefined' ? await caches.open('tipitaka-search-v4') : null;
        let response = cache ? await cache.match(request) : null;
        if (!response) {
          response = await fetch(request);
          // Offline caching is an optimisation.  Storage quota, browser
          // privacy settings, or a transient Cache API failure must never
          // turn a successfully fetched search shard into a failed search.
          if (cache && response.ok) await cache.put(request, response.clone()).catch(() => {});
        }
        if (!response.ok) throw new Error(`检索分片加载失败（${response.status}）`);
        return response.json();
      })();
      shardCache.set(key, promise);
    }
    return shardCache.get(key);
  }
  async function manifest(base) {
    if (!manifestCache.has(base)) manifestCache.set(base, cachedJson(base, 'search-v4/manifest.json'));
    return manifestCache.get(base);
  }
  function cjkBigrams(value) {
    const compact = value.replace(/\s/g, '');
    return [...new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, i) => compact.slice(i, i + 2)))];
  }
  function queryTerms(value, language) {
    if (language === 'zh') return cjkBigrams(value);
    return [...value.matchAll(wordRe)].map(match => language === 'pali' ? normalizePali(match[0]) : normalizeEnglish(match[0])).filter(Boolean);
  }
  function locatorKind(locator) {
    const value = String(locator || '');
    if (value.startsWith('row:')) return 'corpus';
    if (value.startsWith('catalog:')) return 'catalog';
    if (value.startsWith('proper:')) return 'proper';
    if (value.startsWith('user:')) return 'user_dictionary';
    if (value.startsWith('dict:')) return 'dictionary';
    return 'unknown';
  }
  function allowed(locator, types, workIndexes, dictionaryIndexes) {
    const kind = locatorKind(locator);
    if (types?.length && !types.includes(kind)) return false;
    if (kind === 'dictionary' && dictionaryIndexes?.length) return dictionaryIndexes.includes(Number(String(locator).split(':')[1]));
    if (!workIndexes || !workIndexes.length || (kind !== 'corpus' && kind !== 'catalog')) return true;
    const parts = String(locator).split(':');
    return workIndexes.includes(Number(parts[1]));
  }
  async function termsFor(base, language, term) {
    const bucket = language === 'zh' ? String(await hashBucket(term)) : prefixBucket(term);
    const shard = await cachedJson(base, `search-v4/${language}/shard_${bucket}.json.gz`);
    return Object.entries(shard).filter(([key]) => key === term || (language !== 'zh' && key.startsWith(term)));
  }
  function postingMap(postings, types, workIndexes, dictionaryIndexes) {
    const out = new Map();
    for (const posting of postings || []) {
      const locator = String(posting[0]);
      if (!allowed(locator, types, workIndexes, dictionaryIndexes)) continue;
      const current = out.get(locator);
      const positions = posting[1] || [];
      if (!current || positions.length > current.positions.length) out.set(locator, { positions, length: Number(posting[2] || 1) });
    }
    return out;
  }
  function intersectPhrase(maps) {
    if (!maps.length) return [];
    const first = maps[0], results = [];
    for (const [locator, firstPosting] of first) {
      let found = false;
      for (const position of firstPosting.positions || []) {
        if (maps.every((map, index) => index === 0 || (map.get(locator)?.positions || []).includes(position + index))) { found = true; break; }
      }
      if (found) results.push({ locator, positions: firstPosting.positions, length: firstPosting.length });
    }
    return results;
  }
  async function run(request) {
    const { base, q, language, types = [], workIndexes = null, dictionaryIndexes = null } = request;
    const value = String(q || '').trim();
    if (language === 'zh' && (!/[\u3400-\u9fff]/.test(value) || value.replace(/\s/g, '').length < 2)) return { total: 0, results: [], query: value, language };
    const terms = queryTerms(value, language);
    if (!terms.length) return { total: 0, results: [], query: value, language };
    const index = await manifest(base);
    if (index.format !== 'tipitaka-reader-search/v4') throw new Error('V4 检索索引版本不兼容');
    const maps = [];
    for (const term of terms) {
      const entries = await termsFor(base, language, term);
      const postings = [];
      // Do not spread a popular term's posting list into push(): English
      // stop-word-like terms can have hundreds of thousands of matches and
      // exceed the engine's argument-stack limit.
      for (const [, values] of entries) for (const posting of values || []) postings.push(posting);
      const merged = postingMap(postings, types, workIndexes, dictionaryIndexes);
      maps.push(merged);
      if (!merged.size) return { total: 0, results: [], query: value, language, terms };
    }
    const matches = intersectPhrase(maps);
    const n = Math.max(1, index.counts?.corpus_rows || 1);
    const results = matches.map(item => {
      const tf = item.positions.length;
      const score = (tf / (1 + 1.2 * (0.25 + 0.75 * item.length / 12))) + (terms.length > 1 ? 2 : 0);
      const kindBoost = locatorKind(item.locator) === 'catalog' ? 1.5 : locatorKind(item.locator) === 'corpus' ? 1 : .35;
      return { locator: item.locator, positions: item.positions, score: score + kindBoost + Math.log1p(n / Math.max(1, matches.length)) };
    }).sort((a, b) => b.score - a.score || String(a.locator).localeCompare(String(b.locator)));
    return { total: results.length, results, query: value, language, terms };
  }
  self.onmessage = async event => {
    const { id } = event.data || {};
    if (!id) return;
    try { self.postMessage({ id, ok: true, data: await run(event.data) }); }
    catch (error) { self.postMessage({ id, ok: false, error: error.message || String(error) }); }
  };
})();
