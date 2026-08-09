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
          if (cache && response.ok) {
            try { await cache.put(request, response.clone()); } catch {}
          }
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
  const ZH_QUERY_STOP = new Set('如何 怎麼 怎么 怎樣 怎样 是否 可以 不能 以及 關於 关于 對於 对于 其中 因此 所以 為何 为何'.split(/\s+/));
  const ZH_QUERY_STOP_CHARS = new Set('的了是在與与及之也而或則则即乃其此彼吾汝你他她它們们着過过被把讓让給给對对從从到為为於于又還还並并但卻却才就都很更最這这那些何'.split(''));
  function isQueryStop(term, language) {
    return language === 'zh' && (ZH_QUERY_STOP.has(term) || (term.length === 2 && [...term].some(char => ZH_QUERY_STOP_CHARS.has(char))));
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
      if (!current) {
        out.set(locator, { positions: [...positions], length: Number(posting[2] || 1) });
      } else {
        current.positions.push(...positions);
        current.length = Math.max(current.length, Number(posting[2] || 1));
      }
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
  function resourceKindCounts(index) {
    const counts = index.counts || {};
    return {
      corpus: Math.max(1, Number(counts.corpus_rows || 1)),
      catalog: Math.max(1, Number(counts.catalog_documents || 1)),
      dictionary: Math.max(1, Number(counts.dictionary_rows || 1)),
      proper: Math.max(1, Number(counts.proper_nouns || 1)),
      user_dictionary: Math.max(1, Number(counts.user_dictionary || 1)),
    };
  }
  function locatorKindCount(locator, counts) {
    return counts[locatorKind(locator)] || counts.corpus;
  }
  function proximityScore(records) {
    if (records.length < 2) return 0;
    const positions = records.map(record => record.positions.slice(0, 64).sort((a, b) => a - b));
    let best = Infinity;
    for (const first of positions[0]) {
      let lo = first, hi = first;
      for (let index = 1; index < positions.length; index += 1) {
        const values = positions[index];
        let nearest = values[0];
        for (const value of values) if (Math.abs(value - first) < Math.abs(nearest - first)) nearest = value;
        lo = Math.min(lo, nearest); hi = Math.max(hi, nearest);
      }
      best = Math.min(best, hi - lo);
    }
    return Number.isFinite(best) ? records.length / (best + records.length) : 0;
  }
  function orderedScore(records) {
    if (records.length < 2) return 0;
    let ordered = 0, previous = -Infinity;
    for (const record of records) {
      const next = record.positions.find(position => position > previous);
      if (next === undefined) break;
      ordered += 1; previous = next;
    }
    return ordered / records.length;
  }
  function bm25Approx(tf, length, avgLength, df, documentCount) {
    const safeAvg = Math.max(1, avgLength || 1);
    const safeN = Math.max(1, documentCount || 1);
    const safeDf = Math.min(safeN, Math.max(0, df));
    const idf = Math.log(1 + (safeN - safeDf + 0.5) / (safeDf + 0.5));
    const k1 = 1.2, b = 0.75;
    const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (Math.max(1, length) / safeAvg)));
    return idf * norm;
  }
  async function run(request) {
    const { base, q, language, types = [], workIndexes = null, dictionaryIndexes = null } = request;
    const value = String(q || '').trim();
    if (language === 'zh' && (!/[\u3400-\u9fff]/.test(value) || value.replace(/\s/g, '').length < 2)) return { total: 0, results: [], query: value, language };
    const terms = queryTerms(value, language);
    if (!terms.length) return { total: 0, results: [], query: value, language };
    const index = await manifest(base);
    if (index.format !== 'tipitaka-reader-search/v4') throw new Error('V4 检索索引版本不兼容');
    const phraseMaps = [];
    for (const term of terms) {
      const entries = await termsFor(base, language, term);
      const postings = [];
      // Do not spread a popular term's posting list into push(): English
      // stop-word-like terms can have hundreds of thousands of matches and
      // exceed the engine's argument-stack limit.
      for (const [, values] of entries) for (const posting of values || []) postings.push(posting);
      const merged = postingMap(postings, types, workIndexes, dictionaryIndexes);
      if (merged.size) phraseMaps.push({ term, map: merged, stop: isQueryStop(term, language) });
    }
    if (!phraseMaps.length) return { total: 0, results: [], query: value, language, terms };

    const counts = resourceKindCounts(index);
    const totalDocuments = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const maps = phraseMaps.filter(record => !record.stop);
    const scoringSource = maps.length ? maps : phraseMaps;
    const informative = scoringSource.filter(({ map }) => map.size <= totalDocuments * 0.35);
    const scoringMaps = informative.length ? informative : scoringSource;
    const exact = phraseMaps.length === terms.length ? intersectPhrase(phraseMaps.map(item => item.map)) : [];
    if (!maps.length && !exact.length) return { total: 0, results: [], query: value, language, terms };
    const exactLocators = new Set(exact.map(item => item.locator));
    const scoredRecords = scoringMaps.map(record => {
      const dfByKind = new Map();
      for (const locator of record.map.keys()) {
        const kind = locatorKind(locator);
        dfByKind.set(kind, (dfByKind.get(kind) || 0) + 1);
      }
      return { ...record, dfByKind };
    });
    const candidates = new Map();
    for (const [termIndex, record] of scoredRecords.entries()) {
      for (const [locator, posting] of record.map) {
        let candidate = candidates.get(locator);
        if (!candidate) {
          candidate = { locator, length: posting.length, terms: new Map() };
          candidates.set(locator, candidate);
        }
        candidate.length = Math.max(candidate.length, posting.length);
        candidate.terms.set(termIndex, { term: record.term, positions: posting.positions, df: record.dfByKind.get(locatorKind(locator)) || record.map.size });
      }
    }
    const lengthsByKind = new Map(), lengthCountsByKind = new Map();
    for (const candidate of candidates.values()) {
      const kind = locatorKind(candidate.locator);
      lengthsByKind.set(kind, (lengthsByKind.get(kind) || 0) + candidate.length);
      lengthCountsByKind.set(kind, (lengthCountsByKind.get(kind) || 0) + 1);
    }
    const averageLength = kind => (lengthsByKind.get(kind) || 1) / (lengthCountsByKind.get(kind) || 1);
    const results = [];
    for (const candidate of candidates.values()) {
      const kind = locatorKind(candidate.locator), matched = [...candidate.terms.values()];
      const coverage = matched.length / Math.max(1, scoringMaps.length);
      const score = matched.reduce((sum, posting) => sum + bm25Approx(posting.positions.length, candidate.length, averageLength(kind), posting.df, locatorKindCount(candidate.locator, counts)), 0);
      const proximity = proximityScore(matched), order = orderedScore(matched);
      const isExact = exactLocators.has(candidate.locator);
      const level = isExact ? 'exact' : (matched.length >= 2 || coverage >= 0.6 ? 'core' : 'related');
      if (level === 'related' && (!informative.length || matched.length === 0)) continue;
      const outputTerms = isExact ? phraseMaps.filter(record => record.map.has(candidate.locator)).map(record => record.term) : matched.map(record => record.term);
      const outputPositions = isExact
        ? phraseMaps.flatMap(record => record.map.get(candidate.locator)?.positions || []).sort((a, b) => a - b)
        : matched.flatMap(item => item.positions).sort((a, b) => a - b);
      results.push({
        locator: candidate.locator,
        positions: outputPositions,
        matched_terms: outputTerms,
        match_level: level,
        score: score + proximity * 2 + order + (isExact ? 100 : level === 'core' ? 10 : 0),
      });
    }
    const levelRank = { exact: 0, core: 1, related: 2 };
    results.sort((a, b) => levelRank[a.match_level] - levelRank[b.match_level] || b.score - a.score || String(a.locator).localeCompare(String(b.locator)));
    return { total: results.length, results, query: value, language, terms };
  }
  self.onmessage = async event => {
    const { id } = event.data || {};
    if (!id) return;
    try { self.postMessage({ id, ok: true, data: await run(event.data) }); }
    catch (error) { self.postMessage({ id, ok: false, error: error.message || String(error) }); }
  };
})();
