/* Tipiṭaka Reader V4 — immutable static corpus, complete search, and sparse overlays. */
(() => {
  'use strict';

  const DATA_BASE = (window.TIPITAKA_DATA_BASE || 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1').replace(/\/$/, '');
  const API = `${API_BASE}/api/tipitaka/v1`;
  const CACHE_NAME = 'tipitaka-reader-v2';
  const SEARCH_CACHE_NAME = 'tipitaka-search-v3';
  const WORK_CACHE_LIMIT = 3;
  const OVERSCAN = 12;
  const EST_ROW_HEIGHT = 224;
  const PAGE_SIZE = 40;
  const state = {
    works: null, jumps: null, dictionaries: null, searchManifest: null, dictManifest: null,
    workCache: new Map(), overrides: new Map(), settings: null, autoTimer: null,
    dataWorker: null, searchWorker: null, workerId: 0, reader: null, lastSearch: null,
  };
  const CACHE_META_DB = 'tipitaka-reader-cache-v1', CACHE_META_STORE = 'assets', CACHE_BUDGET = 260 * 1024 * 1024;

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const strip = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const query = () => new URLSearchParams(location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '');
  const routePath = () => location.hash.split('?')[0];
  const url = path => `${DATA_BASE}/${path}`;
  const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...(typeof communityAuthHeaders === 'function' ? communityAuthHeaders() : {}) });
  const normalizePali = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const normalizeZh = value => typeof toTraditional === 'function' && typeof toSimplified === 'function' ? toTraditional(toSimplified(String(value || ''))) : String(value || '');
  const normalizeEn = value => String(value || '').toLowerCase();
  const words = /[A-Za-zĀĪŪṂṀṄÑṬḌṆḶāīūṃṁṅñṭḍṇḷ]+/g;
  const dictWords = /[A-Za-zÀ-ÖØ-öø-ÿĀĪŪṂṀṄÑṬḌṆḶāīūṃṁṅñṭḍṇḷ]+/g;

  function settings() {
    if (!state.settings) {
      try { state.settings = JSON.parse(localStorage.getItem('tipitaka-reader-settings') || '{}'); } catch { state.settings = {}; }
      state.settings = { pali: true, zh: true, en: true, traditional: false, font: 18, speed: 22, ...state.settings };
    }
    return state.settings;
  }
  function saveSettings() { localStorage.setItem('tipitaka-reader-settings', JSON.stringify(settings())); }

  function openCacheMeta() {
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    return new Promise((resolve, reject) => { const request = indexedDB.open(CACHE_META_DB, 1); request.onupgradeneeded = () => request.result.createObjectStore(CACHE_META_STORE, { keyPath: 'path' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async function touchCacheMeta(path, bytes) {
    try { const db = await openCacheMeta(), tx = db.transaction(CACHE_META_STORE, 'readwrite'); tx.objectStore(CACHE_META_STORE).put({ path, bytes: bytes || 0, touched_at: Date.now() }); tx.oncomplete = () => db.close(); } catch {}
  }
  async function trimReaderCache() {
    try {
      const db = await openCacheMeta(), rows = await new Promise((resolve, reject) => { const tx = db.transaction(CACHE_META_STORE, 'readonly'), req = tx.objectStore(CACHE_META_STORE).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      let total = rows.reduce((sum, row) => sum + (row.bytes || 0), 0); if (total <= CACHE_BUDGET) { db.close(); return; }
      const evictable = rows.filter(row => /^(corpus\/|dictionaries\/|search-v3\/|dictionary-search-v1\/)/.test(row.path)).sort((a, b) => a.touched_at - b.touched_at), cache = await caches.open(CACHE_NAME);
      for (const row of evictable) { if (total <= CACHE_BUDGET) break; await cache.delete(new Request(url(row.path))); total -= row.bytes || 0; const tx = db.transaction(CACHE_META_STORE, 'readwrite'); tx.objectStore(CACHE_META_STORE).delete(row.path); await new Promise(resolve => { tx.oncomplete = resolve; tx.onerror = resolve; }); }
      db.close();
    } catch {}
  }

  async function cachedJson(path, cacheName = CACHE_NAME) {
    const request = new Request(url(path), { mode: 'cors' });
    try {
      const cache = await caches.open(cacheName);
      let response = await cache.match(request);
      if (!response) {
        response = await fetch(request);
        if (!response.ok) throw new Error(`${path} 加载失败（${response.status}）`);
        await cache.put(request, response.clone());
      }
      const bytes = Number(response.headers.get('Content-Length') || 0); touchCacheMeta(path, bytes); trimReaderCache();
      return response.json();
    } catch (error) {
      throw new Error(`无法读取巴利三藏数据：${error.message}`);
    }
  }

  function workerRequest(worker, payload, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const id = ++state.workerId;
      const timer = setTimeout(() => { worker.removeEventListener('message', done); reject(new Error('Worker 响应超时')); }, timeoutMs);
      const done = event => {
        if (event.data?.id !== id) return;
        clearTimeout(timer);
        worker.removeEventListener('message', done);
        if (event.data.ok) resolve(event.data.data); else reject(new Error(event.data.error || 'Worker 处理失败'));
      };
      worker.addEventListener('message', done);
      worker.postMessage({ ...payload, id });
    });
  }
  function ensureWorkers() {
    if (typeof Worker !== 'undefined') {
      if (!state.dataWorker) state.dataWorker = new Worker(new URL('tipitaka-data-worker.js?v=20260808.7', document.baseURI));
      if (!state.searchWorker) state.searchWorker = new Worker(new URL('tipitaka-search-worker.js?v=20260808.7', document.baseURI));
    }
  }

  async function ensureCatalog() {
    if (!state.works) [state.works, state.jumps, state.dictionaries] = await Promise.all([
      cachedJson('catalog/works.json'), cachedJson('catalog/jump-map.json'), cachedJson('catalog/dictionaries.json'),
    ]);
    return state.works;
  }
  async function workById(id) {
    await ensureCatalog();
    const meta = state.works.find(work => work.id === id);
    if (!meta) throw new Error('找不到该作品');
    if (!state.workCache.has(id)) {
      ensureWorkers();
      const promise = state.dataWorker
        ? workerRequest(state.dataWorker, { base: DATA_BASE, path: meta.data_file }).catch(() => cachedJson(meta.data_file))
        : cachedJson(meta.data_file);
      state.workCache.set(id, promise);
    }
    const value = state.workCache.get(id);
    const work = await value;
    state.workCache.delete(id); state.workCache.set(id, Promise.resolve(work));
    while (state.workCache.size > WORK_CACHE_LIMIT) state.workCache.delete(state.workCache.keys().next().value);
    return [meta, work];
  }
  async function overrides(workId) {
    if (!state.overrides.has(workId)) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      const data = await fetch(`${API}/works/${encodeURIComponent(workId)}/overrides`, { signal: controller.signal }).then(r => r.ok ? r.json() : { units: [] }).catch(() => ({ units: [] })).finally(() => clearTimeout(timer));
      state.overrides.set(workId, new Map(data.units.map(unit => [`${unit.row_id}:${unit.language}`, unit])));
    }
    return state.overrides.get(workId);
  }
  const defaultText = (row, lang) => lang === 'zh' ? (row.chinese_simplified || row.chinese_raw || '') : (row.english_translation || '');
  const displayed = (row, overlays, lang) => overlays.get(`${row.id}:${lang}`)?.current_text || defaultText(row, lang);
  const chineseDisplay = value => settings().traditional && typeof toTraditional === 'function' ? toTraditional(value) : value;

  function workTree(works) {
    const root = {};
    for (const work of works) {
      let node = root;
      for (const part of work.path) node = node[part] ||= {};
      (node.__works ||= []).push(work);
    }
    const render = node => Object.entries(node).filter(([key]) => key !== '__works').map(([key, child]) =>
      `<details open><summary>${esc(key)}</summary>${(child.__works || []).map(w => `<a class="tipitaka-work-link" href="#/tipitaka/read/${encodeURIComponent(w.id)}">${esc(w.title)} <small>${w.row_count.toLocaleString()} 行</small></a>`).join('')}${render(child)}</details>`).join('');
    return render(root);
  }
  function injectCss() {
    if (document.getElementById('tipitaka-reader-css')) return;
    const style = document.createElement('style'); style.id = 'tipitaka-reader-css'; style.textContent = `
      .tipitaka-layout{display:grid;grid-template-columns:minmax(230px,28%) 1fr;gap:18px}.tipitaka-catalog{max-height:68vh;overflow:auto;padding:12px;background:var(--card,#fff);border:1px solid var(--border,#ddd);border-radius:10px}.tipitaka-catalog details{margin:7px 0}.tipitaka-work-link{display:block;padding:5px 8px;color:var(--primary,#6b4f2d);text-decoration:none}.tipitaka-work-link small{color:var(--text-light,#777)}.tipitaka-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.tipitaka-toolbar button,.tipitaka-toolbar input,.tipitaka-toolbar select{padding:7px 10px;border:1px solid var(--border,#ccc);border-radius:7px;background:var(--card,#fff);color:inherit}.tipitaka-row{border-bottom:1px solid var(--border,#e5e5e5);padding:13px 0;line-height:1.75}.tipitaka-row[data-rend="gatha"]{margin-left:2em;font-style:italic}.tipitaka-row[data-rend="nikaya"],.tipitaka-row[data-rend="book"],.tipitaka-row[data-rend="subsubhead"]{font-weight:700}.tipitaka-num{display:inline-block;min-width:5.2em;color:var(--text-light,#777);font-size:.8em;vertical-align:top}.tipitaka-pali{cursor:pointer;color:var(--primary,#6b4f2d);font-style:italic;line-height:1.65}.tipitaka-zh{color:var(--text,#222);font-size:1.04em;line-height:2}.tipitaka-en{color:var(--text-light,#666);line-height:1.65}.tipitaka-actions{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}.tipitaka-actions button{font-size:.8em}.tipitaka-search-result{display:block;padding:10px;border-bottom:1px solid var(--border,#ddd);color:inherit;text-decoration:none}.tipitaka-search-result:hover{background:color-mix(in srgb,var(--primary,#6b4f2d) 8%,transparent)}.tipitaka-pane{height:min(72vh,calc(100vh - 190px));overflow:auto;padding:0 18px;position:relative;scroll-behavior:smooth}.tipitaka-virtual-spacer{position:relative;width:100%}.tipitaka-virtual-window{position:absolute;left:0;right:0;top:0}.tipitaka-hit{background:#ffe066;color:#2d2400;border-radius:3px;padding:0 2px;box-shadow:0 0 0 2px rgba(255,224,102,.22)}.tipitaka-active-hit{background:#ff9f1c;box-shadow:0 0 0 3px rgba(255,159,28,.35)}.tipitaka-default-hit{margin:8px 0;padding:8px 10px;border-left:3px solid #c58b28;background:rgba(197,139,40,.09);font-size:.9em}.tipitaka-skeleton{height:18px;margin:14px 0;background:linear-gradient(90deg,#eee,#fafafa,#eee);background-size:200% 100%;animation:tipitakaShimmer 1.3s infinite;border-radius:5px}.tipitaka-dict-entry{padding:12px 0;border-bottom:1px solid var(--border,#ddd)}.tipitaka-dict-entry h4{margin:0 0 5px}.tipitaka-page{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.tipitaka-note{color:var(--text-light,#777);font-size:.9em}.tipitaka-mobile-note{display:none}@keyframes tipitakaShimmer{to{background-position:-200% 0}}@media(max-width:760px){.tipitaka-layout{grid-template-columns:1fr}.tipitaka-catalog{max-height:38vh}.tipitaka-num{min-width:3.8em}.tipitaka-pane{height:calc(100vh - 230px);padding:0 10px}.tipitaka-mobile-note{display:block}}`; document.head.appendChild(style);
  }

  function readerToolbar(meta, current, hitState) {
    const s = settings();
    const hitNote = hitState?.total ? `<span class="tipitaka-note">命中 ${hitState.index + 1}/${hitState.total}</span><button data-t-action="hit-prev">上一处</button><button data-t-action="hit-next">下一处</button>` : '';
    return `<div class="tipitaka-toolbar"><button data-t-action="back">← 目录</button><strong>${esc(meta.title)}</strong><label><input type="checkbox" data-t-toggle="pali" ${s.pali ? 'checked' : ''}> 巴利</label><label><input type="checkbox" data-t-toggle="zh" ${s.zh ? 'checked' : ''}> 中文</label><label><input type="checkbox" data-t-toggle="traditional" ${s.traditional ? 'checked' : ''}> 繁体</label><label><input type="checkbox" data-t-toggle="en" ${s.en ? 'checked' : ''}> English</label><button data-t-action="font-down">A−</button><button data-t-action="font-up">A+</button><button data-t-action="auto">自动滚动</button><button data-t-action="bookmark">☆ 收藏此处</button>${hitNote}${current?.paranum ? `<span class="tipitaka-note">段号 ${esc(current.paranum)}</span>` : ''}</div>`;
  }

  function highlightHtml(text, term, language, active = false) {
    text = String(text || ''); term = String(term || '').trim();
    if (!term) return esc(text);
    const ranges = [];
    if (language === 'zh') {
      const normalizedText = normalizeZh(text), normalizedTerm = normalizeZh(term).replace(/\s/g, '');
      for (let at = normalizedText.indexOf(normalizedTerm); at !== -1; at = normalizedText.indexOf(normalizedTerm, at + Math.max(1, normalizedTerm.length))) ranges.push([at, at + normalizedTerm.length]);
    } else if (language === 'pali') {
      const q = normalizePali(term);
      for (const match of text.matchAll(words)) if (normalizePali(match[0]).startsWith(q)) ranges.push([match.index, match.index + match[0].length]);
    } else {
      const q = term.toLowerCase(); const lower = text.toLowerCase();
      for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + Math.max(1, q.length))) ranges.push([at, at + q.length]);
    }
    if (!ranges.length) return esc(text);
    let out = '', cursor = 0;
    for (const [start, end] of ranges) { if (start < cursor) continue; out += esc(text.slice(cursor, start)) + `<mark class="tipitaka-hit${active ? ' tipitaka-active-hit' : ''}">${esc(text.slice(start, end))}</mark>`; cursor = end; }
    return out + esc(text.slice(cursor));
  }

  function rowHtml(row, overlays, hit) {
    const s = settings(), parts = [], lang = hit?.language, term = hit?.query;
    const show = (language, value) => highlightHtml(language === 'zh' ? chineseDisplay(value) : value, term, language, !!hit && lang === language);
    if (s.pali && row.pali_text) parts.push(`<div class="tipitaka-pali" data-t-pali="${esc(strip(row.pali_text))}">${hit && lang === 'pali' && Number(row.id) === Number(hit.rowId) ? show('pali', strip(row.pali_text)) : esc(strip(row.pali_text))}</div>`);
    if (s.zh && displayed(row, overlays, 'zh')) {
      const value = displayed(row, overlays, 'zh'), base = chineseDisplay(defaultText(row, 'zh'));
      const effective = hit && lang === 'zh' && Number(row.id) === Number(hit.rowId) ? show('zh', value) : esc(chineseDisplay(value));
      const defaultHit = term && lang === 'zh' && !normalizeZh(chineseDisplay(value)).includes(normalizeZh(term).replace(/\s/g, '')) && normalizeZh(base).includes(normalizeZh(term).replace(/\s/g, ''));
      parts.push(`<div class="tipitaka-zh">${effective}${defaultHit ? `<details class="tipitaka-default-hit"><summary>默认文本命中（当前覆盖层未命中）</summary>${highlightHtml(base, term, 'zh')}</details>` : ''}</div>`);
    }
    if (s.en && displayed(row, overlays, 'en')) parts.push(`<div class="tipitaka-en">${hit && lang === 'en' && Number(row.id) === Number(hit.rowId) ? show('en', displayed(row, overlays, 'en')) : esc(displayed(row, overlays, 'en'))}</div>`);
    return `<article class="tipitaka-row" data-t-row="${row.id}" data-rend="${esc(row.rend || '')}"><span class="tipitaka-num">${esc(row.paranum || row.id)}</span>${parts.join('')}<div class="tipitaka-actions"><button data-t-action="edit-zh" data-row="${row.id}">编辑中译</button><button data-t-action="draft-zh" data-row="${row.id}">Dharmamitra 草稿</button><button data-t-action="edit-en" data-row="${row.id}">编辑英译</button><button data-t-action="history" data-row="${row.id}">历史</button></div></article>`;
  }

  function jumpButtons(row) {
    if (!row?.paranum || !state.jumps) return '';
    const p = Number(String(row.paranum).match(/\d+/)?.[0]); if (!p) return '';
    const jump = state.jumps.find(entry => { const m = String(entry.para_range || '').match(/(\d+)(?:-(\d+))?/); return m && p >= +m[1] && p <= +(m[2] || m[1]); });
    if (!jump) return '';
    return ['Mūla', 'Aṭṭhakathā', 'Ṭīkā'].filter(key => jump[key]).map(key => `<a href="#/tipitaka/read/${encodeURIComponent(jump[key])}?row=${p}">跳至${key}</a>`).join('　');
  }

  function renderVirtual(meta, work, overlays, currentIndex, hit) {
    const pane = document.getElementById('tipitaka-pane'), spacer = document.getElementById('tipitaka-virtual-spacer'), windowEl = document.getElementById('tipitaka-virtual-window');
    if (!pane || !spacer || !windowEl) return;
    const heights = new Map();
    let start = -1, end = -1, measuring = false;
    const offsetFor = index => index * EST_ROW_HEIGHT + [...heights.entries()].reduce((sum, [i, h]) => i < index ? sum + h - EST_ROW_HEIGHT : sum, 0);
    const totalHeight = () => work.rows.length * EST_ROW_HEIGHT + [...heights.values()].reduce((sum, h) => sum + h - EST_ROW_HEIGHT, 0);
    const draw = () => {
      const rough = Math.floor(Math.max(0, pane.scrollTop) / EST_ROW_HEIGHT);
      const nextStart = Math.max(0, rough - OVERSCAN), nextEnd = Math.min(work.rows.length, rough + Math.ceil(pane.clientHeight / EST_ROW_HEIGHT) + OVERSCAN);
      if (nextStart === start && nextEnd === end) return;
      start = nextStart; end = nextEnd;
      windowEl.style.transform = `translateY(${offsetFor(start)}px)`;
      windowEl.innerHTML = work.rows.slice(start, end).map(row => rowHtml(row, overlays, hit && row.id === hit.rowId ? hit : null)).join('');
      spacer.style.height = `${Math.max(1, totalHeight())}px`;
      requestAnimationFrame(() => {
        if (measuring) return;
        measuring = true;
        let changed = false;
        windowEl.querySelectorAll('[data-t-row]').forEach(element => { const id = Number(element.dataset.tRow), index = work.rows.findIndex(row => Number(row.id) === id), height = element.offsetHeight; if (index >= 0 && height && heights.get(index) !== height) { heights.set(index, height); changed = true; } });
        measuring = false;
        if (changed) { spacer.style.height = `${Math.max(1, totalHeight())}px`; windowEl.style.transform = `translateY(${offsetFor(start)}px)`; }
      });
    };
    pane.addEventListener('scroll', draw, { passive: true });
    spacer.style.height = `${work.rows.length * EST_ROW_HEIGHT}px`;
    pane.scrollTop = offsetFor(currentIndex);
    draw();
    return { pane, offsetFor, draw };
  }

  async function searchHitsForReader(value, language, workId) {
    if (!value) return [];
    try { const result = await runSearch(value, language), manifest = await ensureSearchManifest(); const workNo = manifest.work_ids.indexOf(workId); return result.results.filter(item => (Number(item.locator) >>> 20) === workNo).map(item => Number(item.locator) & ((1 << 20) - 1)); }
    catch { return []; }
  }

  async function renderReader(workId) {
    injectCss();
    app.innerHTML = '<div class="loading"><div class="spinner"></div><div>正在准备三语阅读窗口…</div></div>';
    try {
      await ensureCatalog();
      const meta = state.works.find(work => work.id === workId); if (!meta) throw new Error('找不到该作品');
      app.innerHTML = `<div class="cat-header"><h2>${esc(meta.title)}</h2><div class="cat-en">${esc(meta.path.join(' / '))} · ${meta.row_count.toLocaleString()} 行</div></div><div class="tipitaka-skeleton"></div><div class="tipitaka-skeleton"></div>`;
      const [loaded, overlays] = await Promise.all([workById(workId), overrides(workId)]);
      const work = loaded[1], params = query(), anchor = Number(params.get('row') || 0);
      let currentIndex = work.rows.findIndex(row => Number(row.id) === anchor); if (currentIndex < 0) currentIndex = 0;
      const hit = params.get('hl') ? { query: params.get('hl'), language: params.get('hl_lang') || 'zh', rowId: Number(params.get('row') || 0) } : null;
      const hitRows = hit ? await searchHitsForReader(hit.query, hit.language, workId) : [];
      const hitIndex = hit ? Math.max(0, hitRows.indexOf(Number(params.get('row') || 0))) : 0;
      state.reader = { meta, work, overlays, currentIndex, hit, hitRows, hitIndex, virtual: null };
      app.innerHTML = `${readerToolbar(meta, work.rows[currentIndex], hit && hitRows.length ? { total: hitRows.length, index: hitIndex } : null)}<div class="tipitaka-note">共 ${work.rows.length.toLocaleString()} 段；只渲染可视窗口，已访问作品会进入本地缓存。${hit ? ' 已定位到搜索命中。' : ''}</div><div class="tipitaka-pane" id="tipitaka-pane" style="font-size:${settings().font}px"><div class="tipitaka-virtual-spacer" id="tipitaka-virtual-spacer"><div class="tipitaka-virtual-window" id="tipitaka-virtual-window"></div></div></div><div class="tipitaka-toolbar">${jumpButtons(work.rows[currentIndex])}</div>`;
      state.reader.virtual = renderVirtual(meta, work, overlays, currentIndex, hit);
      localStorage.setItem('tipitaka-reader-history', JSON.stringify({ workId, rowId: work.rows[currentIndex]?.id, at: Date.now() }));
      syncProgress(workId, work.rows[currentIndex]?.id);
      bindReader();
      requestAnimationFrame(() => { const el = document.querySelector(`[data-t-row="${work.rows[currentIndex]?.id}"]`); if (el) el.scrollIntoView({ block: 'center' }); });
    } catch (error) { app.innerHTML = `<div class="error-msg">${esc(error.message)}。目录可用时，正文会在静态数据源恢复后继续加载。</div>`; }
  }

  function moveReaderHit(delta) {
    const reader = state.reader; if (!reader?.hitRows?.length) return;
    reader.hitIndex = (reader.hitIndex + delta + reader.hitRows.length) % reader.hitRows.length;
    const rowId = reader.hitRows[reader.hitIndex], idx = reader.work.rows.findIndex(row => Number(row.id) === Number(rowId));
    if (idx < 0) return;
    reader.currentIndex = idx;
    const params = new URLSearchParams({ row: String(rowId), hl: reader.hit.query, hl_lang: reader.hit.language });
    history.replaceState(null, '', `${location.pathname}${location.search}#/tipitaka/read/${encodeURIComponent(reader.meta.id)}?${params}`);
    renderReader(reader.meta.id);
  }
  function bindReader() {
    app.onclick = async event => {
      const button = event.target.closest('button,[data-t-action]'); if (!button) return;
      const reader = state.reader, action = button.dataset.tAction;
      if (!reader) return;
      if (action === 'back') { location.hash = '#/tipitaka'; return; }
      if (action === 'font-up' || action === 'font-down') { settings().font = Math.max(13, Math.min(30, settings().font + (action === 'font-up' ? 1 : -1))); saveSettings(); renderReader(reader.meta.id); return; }
      if (action === 'auto') { toggleAutoScroll(); return; }
      if (action === 'hit-prev') { moveReaderHit(-1); return; }
      if (action === 'hit-next') { moveReaderHit(1); return; }
      if (action === 'bookmark') { await saveBookmark(reader.meta, reader.work.rows[reader.currentIndex]); return; }
      const row = reader.work.rows.find(item => Number(item.id) === Number(button.dataset.row)); if (!row) return;
      if (action === 'edit-zh' || action === 'edit-en') await editTranslation(reader.meta, row, action === 'edit-zh' ? 'zh' : 'en');
      if (action === 'draft-zh') await draftTranslation(reader.meta, row);
      if (action === 'history') await showHistory(reader.meta.id, row.id);
    };
    app.onchange = event => { const toggle = event.target.dataset.tToggle; if (toggle) { settings()[toggle] = event.target.checked; saveSettings(); renderReader(state.reader.meta.id); } };
    app.querySelectorAll('.tipitaka-pali').forEach(el => el.onclick = () => showDictionary(window.getSelection()?.toString().trim() || el.dataset.tPali));
  }
  function toggleAutoScroll() { const pane = document.getElementById('tipitaka-pane'); if (!pane) return; if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; return; } state.autoTimer = setInterval(() => pane.scrollTop += settings().speed / 10, 50); }
  async function saveBookmark(meta, row) { try { const result = await fetch(`${API}/bookmarks`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ work_id: meta.id, row_id: row.id, label: `${meta.title} · ${row.paranum || row.id}` }) }); if (!result.ok) throw new Error('请先登录后收藏'); alert('已收藏'); } catch (e) { alert(e.message); } }
  async function syncProgress(workId, rowId) { try { await fetch(`${API}/progress`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ work_id: workId, row_id: rowId }) }); } catch {} }
  async function editTranslation(meta, row, language) { const base = defaultText(row, language); const text = prompt(`编辑${language === 'zh' ? '中文' : '英文'}译文`, base); if (text === null) return; const reason = prompt('修改理由（将记入公开历史）', '') ?? ''; const response = await fetch(`${API}/works/${encodeURIComponent(meta.id)}/rows/${row.id}/${language}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text, default_text: base, reason, source: 'human' }) }); if (!response.ok) { alert((await response.json().catch(() => ({}))).detail || '保存失败，请先登录'); return; } state.overrides.delete(meta.id); renderReader(meta.id); }
  async function draftTranslation(meta, row) { if (!row.pali_text || typeof mitraTranslate !== 'function') { alert('该行没有巴利原文，或翻译服务尚不可用。'); return; } try { const draft = await mitraTranslate(strip(row.pali_text), `Tipiṭaka Reader V4 · ${meta.title}`); if (!confirm(`Dharmamitra 草稿：\n\n${draft}\n\n确认写入公开修订历史？`)) return; const base = defaultText(row, 'zh'); const response = await fetch(`${API}/works/${encodeURIComponent(meta.id)}/rows/${row.id}/zh`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text: draft, default_text: base, reason: 'Dharmamitra 草稿经人工确认', source: 'dharmamitra' }) }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || '保存失败'); state.overrides.delete(meta.id); renderReader(meta.id); } catch (error) { alert(error.message); } }
  async function showHistory(workId, rowId) { const language = prompt('查看哪个语种历史？输入 zh 或 en', 'zh'); if (!language) return; const rows = await fetch(`${API}/works/${encodeURIComponent(workId)}/rows/${rowId}/${language}/history`).then(r => r.ok ? r.json() : []); if (!rows.length) { alert('尚无历史记录'); return; } const list = rows.map((item, index) => `${index + 1}. ${new Date(item.created_at).toLocaleString()}\n${item.text}\n理由：${item.reason || '—'}`).join('\n\n'); const choice = prompt(`${list}\n\n输入版本编号即可恢复；取消仅查看。`, ''); if (!choice) return; const revision = rows[Number(choice) - 1]; if (!revision) { alert('无效版本编号'); return; } if (!confirm(`恢复为版本 ${choice}？这会新增一条可追溯的修订。`)) return; const saved = await fetch(`${API}/works/${encodeURIComponent(workId)}/rows/${rowId}/${language}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text: revision.text, default_text: '', reason: `从历史版本 ${choice} 恢复`, source: 'restore' }) }); if (!saved.ok) { alert((await saved.json().catch(() => ({}))).detail || '恢复失败，请先登录'); return; } state.overrides.delete(workId); renderReader(workId); }

  async function ensureSearchManifest() { if (!state.searchManifest) state.searchManifest = await cachedJson('search-v3/manifest.json', SEARCH_CACHE_NAME); return state.searchManifest; }
  async function runSearch(value, language) {
    value = String(value || '').trim();
    ensureWorkers();
    if (state.searchWorker) return workerRequest(state.searchWorker, { base: DATA_BASE, q: value, language });
    const manifest = await ensureSearchManifest();
    const [catalog] = await Promise.all([ensureCatalog(), ensureSearchManifest()]);
    const out = [];
    for (const work of catalog) { const data = await cachedJson(work.data_file); for (const row of data.rows) { const text = language === 'zh' ? row.chinese_simplified || row.chinese_raw || '' : language === 'en' ? row.english_translation || '' : strip(row.pali_text); const needle = language === 'zh' ? normalizeZh(value) : language === 'pali' ? normalizePali(value) : value.toLowerCase(); if (needle && (language === 'zh' ? normalizeZh(text).includes(needle) : language === 'pali' ? normalizePali(text).includes(needle) : text.toLowerCase().includes(needle))) out.push({ locator: (manifest.work_ids.indexOf(work.id) << 20) | row.id, score: 1 }); } }
    return { total: out.length, results: out, query: value, language };
  }
  window.TipitakaV4 = window.TipitakaV4 || {};
  window.TipitakaV4.search = (value, language = 'zh') => runSearch(value, language);
  window.TipitakaV4.resolve = (result, page = 0) => resolveSearchPage(result, page);
  window.TipitakaV4.resultHref = (item, language, term) => `#/tipitaka/read/${encodeURIComponent(item.meta.id)}?row=${item.row.id}&hl=${encodeURIComponent(term)}&hl_lang=${encodeURIComponent(language)}&hl_anchor=${encodeURIComponent((language === 'zh' ? item.row.chinese_simplified || item.row.chinese_raw : language === 'en' ? item.row.english_translation : strip(item.row.pali_text) || '').slice(0, 64))}`;

  async function resolveSearchPage(result, page) {
    const manifest = await ensureSearchManifest(), pageItems = result.results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), byWork = new Map();
    for (const item of pageItems) { const workNo = Number(item.locator) >>> 20, rowId = Number(item.locator) & ((1 << 20) - 1), workId = manifest.work_ids[workNo]; if (!byWork.has(workId)) byWork.set(workId, []); byWork.get(workId).push({ ...item, rowId }); }
    const resolved = [];
    for (const [workId, items] of byWork) { const [meta, work] = await workById(workId); for (const item of items) { const row = work.rows.find(candidate => candidate.id === item.rowId); if (row) resolved.push({ meta, work, row, score: item.score }); } }
    return resolved;
  }
  function searchResultHtml(item, language, term) {
    const text = language === 'zh' ? chineseDisplay(item.row.chinese_simplified || item.row.chinese_raw || '') : language === 'en' ? item.row.english_translation || '' : strip(item.row.pali_text);
    const anchor = text.slice(0, 64);
    const href = `#/tipitaka/read/${encodeURIComponent(item.meta.id)}?row=${item.row.id}&hl=${encodeURIComponent(term)}&hl_lang=${encodeURIComponent(language)}&hl_anchor=${encodeURIComponent(anchor)}`;
    return `<a class="tipitaka-search-result" href="${href}"><strong>${esc(item.meta.title)}</strong> · ${esc(item.row.paranum || item.row.id)}<br><span>${highlightHtml(text.slice(0, 280), term, language, true)}</span></a>`;
  }
  async function renderSearch() {
    injectCss(); app.innerHTML = `<button class="back-btn" onclick="location.hash='#/tipitaka'">← 三藏目录</button><div class="cat-header"><h2>V4 三语全文检索</h2><div class="cat-en">Complete position-aware search · Pāli · 简体中文 · English</div></div><form class="tipitaka-toolbar" id="tipitaka-search-form"><input id="tipitaka-search-input" required placeholder="至少两个汉字，或输入巴利/英文词组"><select id="tipitaka-search-lang"><option value="zh">中文</option><option value="pali">巴利</option><option value="en">English</option></select><button>搜索</button></form><div id="tipitaka-search-status" class="tipitaka-note"></div><div id="tipitaka-search-results"></div>`;
    const form = document.getElementById('tipitaka-search-form'), target = document.getElementById('tipitaka-search-results'), status = document.getElementById('tipitaka-search-status');
    const draw = async (result, page) => { state.lastSearch = { result, page }; status.textContent = `完整命中 ${result.total.toLocaleString()} 处 · 第 ${page + 1} 页`; const items = await resolveSearchPage(result, page); target.innerHTML = `${items.map(item => searchResultHtml(item, result.language, result.query)).join('') || '<p>未找到结果。</p>'}<div class="tipitaka-page">${page > 0 ? '<button data-t-search-page="prev">← 上一页</button>' : ''}${(page + 1) * PAGE_SIZE < result.total ? '<button data-t-search-page="next">下一页 →</button>' : ''}<span class="tipitaka-note">每页加载 40 条；总数不截断。</span></div>`; target.querySelectorAll('[data-t-search-page]').forEach(button => button.onclick = () => draw(result, page + (button.dataset.tSearchPage === 'next' ? 1 : -1))); };
    form.onsubmit = async event => { event.preventDefault(); const value = document.getElementById('tipitaka-search-input').value.trim(), language = document.getElementById('tipitaka-search-lang').value; status.textContent = '检索分片中…'; target.textContent = ''; try { await draw(await runSearch(value, language), 0); } catch (error) { status.textContent = error.message; } };
  }

  async function ensureDictionaryManifest() { if (!state.dictManifest) state.dictManifest = await cachedJson('dictionary-search-v1/manifest.json', SEARCH_CACHE_NAME); return state.dictManifest; }
  async function dictShard(language, bucket) { return cachedJson(`dictionary-search-v1/${language}/shard_${bucket}.json.gz`, SEARCH_CACHE_NAME); }
  function dictionaryTerms(value, language) { if (language === 'zh') { const compact = value.replace(/\s/g, ''); if (!/[\u3400-\u9fff]/.test(compact) || compact.length < 2) return []; return [...new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, i) => compact.slice(i, i + 2)))]; } return [...value.matchAll(dictWords)].map(m => language === 'pali' ? normalizePali(m[0]) : m[0].toLowerCase()).filter(Boolean); }
  async function dictionarySearch(value, language, source = '') {
    const manifest = await ensureDictionaryManifest(), terms = dictionaryTerms(value, language); if (!terms.length) return { total: 0, rows: [], query: value, language };
    let candidates = null;
    for (const term of terms) {
      const bucket = language === 'pali' ? (term.replace(/[^a-z0-9]/g, '_').slice(0, 2) || '__').padEnd(2, '_') : String(await (async key => { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)); return new DataView(bytes).getUint32(0) % 256; })(term));
      const shard = await dictShard(language, bucket), postings = [];
      for (const [key, locators] of Object.entries(shard)) if (key === term || (language === 'pali' && key.startsWith(term))) postings.push(...locators);
      const set = new Set(postings.map(item => language === 'pali' ? item : item[0])); candidates = candidates === null ? set : new Set([...candidates].filter(item => set.has(item))); if (!candidates.size) break;
    }
    const rows = [];
    for (const locator of candidates || []) {
      const parts = String(locator).split(':'), dictNo = Number(parts[0]), shardNo = Number(parts[1]), id = Number(parts[2]);
      const dictionary = manifest.dictionaries[dictNo]; if (!dictionary || (source && dictionary.table !== source)) continue;
      const shard = dictionary.shards[shardNo]; if (!shard) continue;
      try { const data = await cachedJson(shard.file); const row = data.rows.find(item => Number(item.id) === id); if (!row) continue; const text = language === 'pali' ? normalizePali(row.dict_key || '') : language === 'zh' ? normalizeZh(row.dict_content || '') : normalizeEn(row.dict_content || ''); const needle = language === 'pali' ? normalizePali(value) : language === 'zh' ? normalizeZh(value).replace(/\s/g, '') : normalizeEn(value); if (!text.includes(needle)) continue; rows.push({ dictionary, row, locator }); } catch {}
    }
    rows.sort((a, b) => a.dictionary.table.localeCompare(b.dictionary.table) || String(a.row.dict_key).localeCompare(String(b.row.dict_key)) || Number(a.row.id) - Number(b.row.id));
    return { total: rows.length, rows, query: value, language };
  }
  function dictionaryEntryHtml(item, result) { const text = item.row.dict_content || ''; return `<article class="tipitaka-dict-entry" id="tipitaka-dict-${esc(item.row.id)}"><h4>${esc(item.row.dict_key)} <span class="tipitaka-note">${esc(item.dictionary.table)} · ${esc(item.dictionary.description)}</span></h4><div>${highlightHtml(text, result.query, result.language === 'pali' ? 'pali' : result.language, true)}</div></article>`; }
  async function showDictionary(value) {
    const word = normalizePali((String(value).match(/[A-Za-zĀĪŪṂṀṄÑṬḌṆḶāīūṃṁṅñṭḍṇḷ]+/) || [''])[0]); if (!word) return;
    try { const result = await dictionarySearch(word, 'pali'); const panel = document.createElement('dialog'); panel.innerHTML = `<button style="float:right">×</button><h3>${esc(word)} · 词典</h3>${result.rows.slice(0, 40).map(item => dictionaryEntryHtml(item, result)).join('') || '<p>未找到词条。</p>'}`; panel.querySelector('button').onclick = () => panel.close(); document.body.appendChild(panel); panel.showModal(); panel.addEventListener('close', () => panel.remove()); } catch (error) { alert(error.message); }
  }
  async function renderDictionaries() {
    injectCss(); await ensureCatalog(); const sources = state.dictionaries.map(item => `<option value="${esc(item.table)}">${esc(item.table)} · ${esc(item.description)}</option>`).join('');
    app.innerHTML = `<button class="back-btn" onclick="location.hash='#/tipitaka'">← 三藏目录</button><div class="cat-header"><h2>巴利词典与专名</h2><div class="cat-en">26 dictionaries · 2,436,672 entries · 634 proper nouns</div></div><form class="tipitaka-toolbar" id="tipitaka-dict-form"><input id="tipitaka-dict-input" required placeholder="巴利词、中文释义或英文释义"><select id="tipitaka-dict-lang"><option value="pali">巴利词头</option><option value="zh">中文释义</option><option value="en">English gloss</option></select><select id="tipitaka-dict-source"><option value="">全部词典</option>${sources}</select><button>查词</button><button type="button" id="tipitaka-proper">专名表</button></form><div id="tipitaka-dict-status" class="tipitaka-note"></div><div id="tipitaka-dict-results"></div>`;
    const form = document.getElementById('tipitaka-dict-form'), target = document.getElementById('tipitaka-dict-results'), status = document.getElementById('tipitaka-dict-status');
    form.onsubmit = async event => { event.preventDefault(); const value = document.getElementById('tipitaka-dict-input').value.trim(), language = document.getElementById('tipitaka-dict-lang').value, source = document.getElementById('tipitaka-dict-source').value; status.textContent = '加载词典索引与原始分片…'; try { const result = await dictionarySearch(value, language, source), draw = page => { const start = page * PAGE_SIZE; status.textContent = `完整命中 ${result.total.toLocaleString()} 条；第 ${page + 1} 页（每页 ${PAGE_SIZE} 条），按词典来源稳定排序。`; target.innerHTML = result.rows.slice(start, start + PAGE_SIZE).map(item => dictionaryEntryHtml(item, result)).join('') || '<p>未找到词条。</p>'; target.insertAdjacentHTML('beforeend', `<div class="tipitaka-page">${page > 0 ? '<button data-t-dict-prev>上一页</button>' : ''}${start + PAGE_SIZE < result.total ? '<button data-t-dict-next>下一页</button>' : ''}</div>`); target.querySelector('[data-t-dict-prev]')?.addEventListener('click', () => draw(page - 1)); target.querySelector('[data-t-dict-next]')?.addEventListener('click', () => draw(page + 1)); }; draw(0); } catch (error) { status.textContent = error.message; } };
    document.getElementById('tipitaka-proper').onclick = async () => { const [items, userEntries] = await Promise.all([cachedJson('terminology/proper-nouns.json'), cachedJson('terminology/user-dictionary.json')]); target.innerHTML = `${userEntries.length ? `<h3>发行包用户词典</h3>${userEntries.map(entry => `<p><strong>${esc(entry.dict_key)}</strong> — ${esc(chineseDisplay(entry.dict_content))}</p>`).join('')}` : ''}<p class="tipitaka-note">${items.length} 条专名；修改会进入与清净道论、经藏注疏共用的 canon 历史。</p>${items.map((item, i) => `<p class="tipitaka-dict-entry"><strong>${esc(item.pali)}</strong> — ${esc(chineseDisplay(item.preferred_chinese || ''))} <button data-t-term="${i}">编辑术语</button><br><span class="tipitaka-note">${esc(chineseDisplay(item.chinese_comment || item.english || ''))}</span></p>`).join('')}`; target.onclick = event => { const button = event.target.closest('[data-t-term]'); if (button) editTerm(items[Number(button.dataset.tTerm)]); }; };
  }
  async function editTerm(item) { const translation = prompt(`编辑 ${item.pali} 的共享术语译法`, item.preferred_chinese || ''); if (translation === null) return; const reason = prompt('修改理由（公开可见）', '') ?? ''; const response = await fetch(`${API}/terms/${encodeURIComponent(item.pali)}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ translation, default_translation: item.preferred_chinese || translation, usage_note: item.chinese_comment || '', reason }) }); if (!response.ok) { alert((await response.json().catch(() => ({}))).detail || '保存失败，请先登录'); return; } alert('术语已保存。'); }
  async function renderHome() { injectCss(); app.innerHTML = `<button class="back-btn" onclick="location.hash='#/'">← 返回首页</button><div class="cat-header"><h2>📚 巴利三藏阅读器 V4</h2><div class="cat-en">Tipiṭaka · Aṭṭhakathā · Ṭīkā — Pāli · 中文 · English</div></div><div class="tipitaka-toolbar"><button data-t-home="search">全文检索</button><button data-t-home="dict">词典与专名</button><button data-t-home="continue">继续阅读</button></div><div class="tipitaka-layout"><aside class="tipitaka-catalog">${workTree(await ensureCatalog())}</aside><section><p>完整收录三藏、义注、复注与藏外典籍；正文、词典和目录均按需读取与本地缓存。</p><p class="tipitaka-note">缅文词典可查；该发行包未提供可验证的缅文/Nissaya 正文列，因此不显示虚假的阅读栏。</p></section></div>`; app.querySelector('[data-t-home="search"]').onclick = () => location.hash = '#/tipitaka/search'; app.querySelector('[data-t-home="dict"]').onclick = () => location.hash = '#/tipitaka/dictionaries'; app.querySelector('[data-t-home="continue"]').onclick = () => { try { const history = JSON.parse(localStorage.getItem('tipitaka-reader-history') || 'null'); location.hash = history ? `#/tipitaka/read/${encodeURIComponent(history.workId)}?row=${history.rowId}` : '#/tipitaka'; } catch { location.hash = '#/tipitaka'; } }; }
  window.renderTipitakaRoute = () => { const path = routePath(); if (path === '#/tipitaka') return renderHome(); if (path === '#/tipitaka/search') return renderSearch(); if (path === '#/tipitaka/dictionaries') return renderDictionaries(); if (path.startsWith('#/tipitaka/read/')) return renderReader(decodeURIComponent(path.slice('#/tipitaka/read/'.length))); renderHome(); };
  if (location.hash.startsWith('#/tipitaka') && typeof route === 'function') route();
})();
