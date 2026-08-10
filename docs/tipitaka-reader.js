/* Tipiṭaka Reader V4 — immutable static corpus, complete search, and sparse overlays. */
(() => {
  'use strict';

  const DATA_BASE = (window.TIPITAKA_DATA_BASE || 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1').replace(/\/$/, '');
  const HYBRID_SEARCH_BASE = (window.SUTTA_HYBRID_SEARCH_BASE || '').replace(/\/$/, '');
  // This file is loaded as a separate classic script.  Do not rely on the
  // inline page script's lexical `const API_BASE` being visible here: on
  // GitHub Pages that binding is not shared with this script, which used to
  // abort the reader before `window.TipitakaV4` was exported.
  const API_ROOT = typeof API_BASE !== 'undefined'
    ? API_BASE
    : 'https://sutta-api.agreeablemeadow-9da329ca.swedencentral.azurecontainerapps.io';
  const API = `${API_ROOT}/api/tipitaka/v1`;
  const CACHE_NAME = 'tipitaka-reader-v2';
  const SEARCH_CACHE_NAME = 'tipitaka-search-v4';
  const WORK_CACHE_LIMIT = 3;
  const OVERSCAN = 12;
  const EST_ROW_HEIGHT = 224;
  const PAGE_SIZE = 40;
  const state = {
    works: null, jumps: null, dictionaries: null, searchV4Manifest: null, dictManifest: null,
    workCache: new Map(), overrides: new Map(), settings: null, autoTimer: null,
    dataWorker: null, searchWorker: null, workerId: 0, reader: null, lastSearch: null, readerRequest: 0,
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
      const evictable = rows.filter(row => /^(corpus\/|dictionaries\/|search-v4\/|dictionary-search-v1\/)/.test(row.path)).sort((a, b) => a.touched_at - b.touched_at), cache = await caches.open(CACHE_NAME);
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
        // Cache writes are best-effort: a full or unavailable Cache API must
        // not prevent an already successful V4 data request from rendering.
        try { await cache.put(request, response.clone()); } catch {}
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
      if (!state.dataWorker) state.dataWorker = new Worker(new URL('tipitaka-data-worker.js?v=20260808.20', document.baseURI));
      if (!state.searchWorker) state.searchWorker = new Worker(new URL('tipitaka-search-worker.js?v=20260809.1', document.baseURI));
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
  const dictionaryChineseDisplay = value => settings().traditional && typeof toTraditional === 'function' ? toTraditional(value) : typeof toSimplified === 'function' ? toSimplified(value) : value;
  const dictionaryText = value => dictionaryChineseDisplay(String(value || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '));
  function dictionaryPreferences() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('tipitaka-dictionary-preferences') || '{}') || {}; } catch {}
    const order = [...new Set([...(saved.order || []), ...(state.dictionaries || []).map(item => item.table)])];
    return { order, disabled: new Set(saved.disabled || []) };
  }
  function saveDictionaryPreferences(preferences) { localStorage.setItem('tipitaka-dictionary-preferences', JSON.stringify({ order: preferences.order, disabled: [...preferences.disabled] })); }
  function orderedDictionaries(list = state.dictionaries || []) { const prefs = dictionaryPreferences(), rank = new Map(prefs.order.map((value, index) => [value, index])); return [...list].sort((a, b) => (rank.get(a.table) ?? 9999) - (rank.get(b.table) ?? 9999)); }

  function workTree(works, openPath = '') {
    const root = {};
    for (const work of works) {
      let node = root;
      for (const part of work.path) node = node[part] ||= {};
      (node.__works ||= []).push(work);
    }
    const count = node => (node.__works || []).length + Object.entries(node).filter(([key]) => key !== '__works').reduce((sum, [, child]) => sum + count(child), 0);
    const render = (node, depth = 0, parentPath = []) => Object.entries(node).filter(([key]) => key !== '__works').map(([key, child]) => {
      const path = [...parentPath, key], pathText = path.join(' / '), opened = openPath && (openPath === pathText || openPath.startsWith(`${pathText} / `));
      return `<details class="tipitaka-catalog-node" data-depth="${depth}" data-catalog-path="${esc(pathText)}" ${opened ? 'open' : ''}><summary><span>${esc(key)}</span><small>${count(child).toLocaleString()} 部</small></summary>${(child.__works || []).map(w => `<a class="tipitaka-work-link" data-catalog-label="${esc(`${pathText} / ${w.title}`)}" href="#/tipitaka/read/${encodeURIComponent(w.id)}">${esc(w.title)} <small>${w.row_count.toLocaleString()} 行</small></a>`).join('')}${render(child, depth + 1, path)}</details>`;
    }).join('');
    return render(root);
  }
  const V4_CONTENT_TYPES = [['corpus', '正文'], ['catalog', '目录'], ['proper', '专名'], ['user_dictionary', '用户词典'], ['dictionary', '词典']];
  function scopeDisplayLabel(value) {
    const work = (state.works || []).find(item => item.id === value);
    return work ? work.title : String(value || '').split(' / ').pop();
  }
  function scopeSummaryHtml(scopes) {
    if (!scopes.length) return '<span class="tipitaka-scope-empty">全部 V4 目录</span>';
    return scopes.map(value => `<span class="tipitaka-scope-chip" title="${esc(value)}">${esc(scopeDisplayLabel(value))}</span>`).join('');
  }
  function scopeButtonHtml(count = 0) {
    return typeof window.v4ScopeButtonHtml === 'function'
      ? window.v4ScopeButtonHtml(count)
      : `<span>筛选范围</span>${count ? `<span>${count}</span>` : ''}`;
  }
  async function openV4ScopeDrawer({ scopes = [], types = [], onApply } = {}) {
    await ensureCatalog(); injectCss(); injectSearchTargetCss();
    document.getElementById('tipitaka-scope-drawer')?.remove();
    const activeScopes = new Set(scopes.filter(Boolean));
    const activeTypes = new Set(types.length ? types : V4_CONTENT_TYPES.map(([value]) => value));
    const dialog = document.createElement('dialog');
    dialog.id = 'tipitaka-scope-drawer'; dialog.className = 'tipitaka-scope-drawer';
    dialog.innerHTML = `<div class="tipitaka-scope-shell"><header><div><h3>设置 V4 精确范围</h3><p>可连续选择目录或具体作品；不选择范围即检索全部。</p></div><button type="button" class="tipitaka-scope-close" data-scope-cancel aria-label="关闭">×</button></header><div class="tipitaka-scope-selected" data-scope-selected></div><div class="tipitaka-scope-tools"><input data-scope-filter placeholder="搜索目录或作品" aria-label="搜索目录或作品"><button type="button" data-scope-collapse>全部收起</button><button type="button" data-scope-expand>展开一级</button></div><div class="tipitaka-scope-content"><section><h4>目录与作品</h4><div class="tipitaka-catalog tipitaka-scope-tree">${workTree(state.works)}</div></section><section class="tipitaka-scope-types"><h4>内容类型</h4>${V4_CONTENT_TYPES.map(([value, label]) => `<label><input type="checkbox" data-scope-type="${value}" ${activeTypes.has(value) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</section></div><footer><button type="button" data-scope-clear>清空范围</button><span class="tipitaka-scope-count" data-scope-count></span><button type="button" data-scope-cancel>取消</button><button type="button" class="community-primary-btn" data-scope-apply>应用范围</button></footer></div>`;
    document.body.appendChild(dialog);
    const tree = dialog.querySelector('.tipitaka-scope-tree');
    tree.querySelectorAll('.tipitaka-catalog-node').forEach(node => {
      const summary = node.querySelector(':scope > summary'), path = node.dataset.catalogPath;
      summary.insertAdjacentHTML('afterbegin', `<input type="checkbox" data-scope-value="${esc(path)}" aria-label="选择 ${esc(path)}" ${activeScopes.has(path) ? 'checked' : ''}>`);
      node.open = [...activeScopes].some(scope => scope === path || scope.startsWith(`${path} / `) || (state.works || []).some(work => work.id === scope && work.path.join(' / ').startsWith(path)));
    });
    tree.querySelectorAll('.tipitaka-work-link').forEach(link => {
      const id = decodeURIComponent(link.getAttribute('href').split('/').pop());
      link.removeAttribute('href'); link.setAttribute('role', 'group');
      link.insertAdjacentHTML('afterbegin', `<input type="checkbox" data-scope-value="${esc(id)}" aria-label="选择 ${esc(link.textContent.trim())}" ${activeScopes.has(id) ? 'checked' : ''}>`);
    });
    const updateSummary = () => {
      const selected = [...dialog.querySelectorAll('[data-scope-value]:checked')].map(input => input.dataset.scopeValue);
      dialog.querySelector('[data-scope-selected]').innerHTML = selected.length ? selected.map(value => `<button type="button" class="tipitaka-scope-chip" data-scope-remove="${esc(value)}" title="移除 ${esc(value)}">${esc(scopeDisplayLabel(value))} ×</button>`).join('') : '<span class="tipitaka-scope-empty">全部 V4 目录</span>';
      dialog.querySelectorAll('[data-scope-remove]').forEach(button => { button.onclick = () => { const input = [...dialog.querySelectorAll('[data-scope-value]')].find(candidate => candidate.dataset.scopeValue === button.dataset.scopeRemove); if (input) input.checked = false; updateSummary(); }; });
      dialog.querySelector('[data-scope-count]').textContent = selected.length ? `已选 ${selected.length} 个范围` : '当前搜索全部范围';
    };
    dialog.querySelectorAll('[data-scope-value]').forEach(input => {
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('change', updateSummary);
    });
    dialog.querySelector('[data-scope-filter]').addEventListener('input', event => {
      const needle = event.target.value.trim().toLowerCase();
      tree.querySelectorAll('.tipitaka-work-link').forEach(link => { link.hidden = !!needle && !link.dataset.catalogLabel.toLowerCase().includes(needle); });
      tree.querySelectorAll('.tipitaka-catalog-node').forEach(node => {
        const visible = [...node.querySelectorAll('.tipitaka-work-link')].some(link => !link.hidden), matches = node.dataset.catalogPath.toLowerCase().includes(needle);
        node.hidden = !!needle && !visible && !matches; if (needle && (visible || matches)) node.open = true;
      });
    });
    dialog.querySelector('[data-scope-collapse]').onclick = () => tree.querySelectorAll('details').forEach(node => { node.open = false; });
    dialog.querySelector('[data-scope-expand]').onclick = () => tree.querySelectorAll('details').forEach(node => { node.open = node.dataset.depth === '0'; });
    dialog.querySelector('[data-scope-clear]').onclick = () => { dialog.querySelectorAll('[data-scope-value]').forEach(input => { input.checked = false; }); updateSummary(); };
    dialog.querySelectorAll('[data-scope-cancel]').forEach(button => { button.onclick = () => dialog.close('cancel'); });
    dialog.querySelector('[data-scope-apply]').onclick = () => {
      const nextScopes = [...dialog.querySelectorAll('[data-scope-value]:checked')].map(input => input.dataset.scopeValue);
      const checkedTypes = [...dialog.querySelectorAll('[data-scope-type]:checked')].map(input => input.dataset.scopeType);
      const nextTypes = checkedTypes.length === V4_CONTENT_TYPES.length ? [] : checkedTypes;
      onApply?.({ scopes: nextScopes, types: nextTypes }); dialog.close('apply');
    };
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    updateSummary(); dialog.showModal(); requestAnimationFrame(() => dialog.querySelector('[data-scope-filter]').focus());
  }
  function injectCss() {
    if (document.getElementById('tipitaka-reader-css')) return;
    const style = document.createElement('style'); style.id = 'tipitaka-reader-css'; style.textContent = `
      .tipitaka-layout{display:grid;grid-template-columns:minmax(230px,28%) 1fr;gap:18px}.tipitaka-catalog{max-height:68vh;overflow:auto;padding:12px;background:var(--card,#fff);border:1px solid var(--border,#ddd);border-radius:10px}.tipitaka-catalog details{margin:7px 0}.tipitaka-work-link{display:block;padding:5px 8px;color:var(--primary,#6b4f2d);text-decoration:none}.tipitaka-work-link small{color:var(--text-light,#777)}.tipitaka-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0;min-width:0}.tipitaka-toolbar button,.tipitaka-toolbar input,.tipitaka-toolbar select{padding:7px 10px;border:1px solid var(--border,#ccc);border-radius:7px;background:var(--card,#fff);color:inherit;max-width:100%;box-sizing:border-box}.tipitaka-row{box-sizing:border-box;width:100%;max-width:100%;min-width:0;border-bottom:1px solid var(--border,#e5e5e5);padding:16px 0;line-height:1.75;overflow-wrap:anywhere}.tipitaka-row[data-rend="gatha"]{font-style:italic}.tipitaka-row[data-rend="nikaya"],.tipitaka-row[data-rend="book"],.tipitaka-row[data-rend="subsubhead"]{font-weight:700}.tipitaka-num{display:inline-block;min-width:5.2em;color:var(--text-light,#777);font-size:.8em;vertical-align:top}.tipitaka-pali{cursor:pointer;color:var(--primary,#6b4f2d);font-style:italic;line-height:1.65;overflow-wrap:anywhere}.tipitaka-zh{color:var(--text,#222);font-size:1.04em;line-height:2;overflow-wrap:anywhere}.tipitaka-en{color:var(--text-light,#666);line-height:1.65;overflow-wrap:anywhere}.tipitaka-actions{margin-top:8px}.tipitaka-actions summary{display:inline-flex;cursor:pointer;color:var(--primary,#6b4f2d);font-size:.83em}.tipitaka-actions-grid{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.tipitaka-actions button{font-size:.8em}.tipitaka-search-result{display:block;padding:10px;border-bottom:1px solid var(--border,#ddd);color:inherit;text-decoration:none;min-width:0;overflow-wrap:anywhere}.tipitaka-search-result:hover{background:color-mix(in srgb,var(--primary,#6b4f2d) 8%,transparent)}.tipitaka-pane{height:min(72vh,calc(100vh - 190px));overflow-y:auto;overflow-x:clip;padding:0 18px;position:relative;scroll-behavior:smooth;overscroll-behavior:contain;overscroll-behavior-x:none;touch-action:pan-y pinch-zoom;min-width:0;box-sizing:border-box}.tipitaka-virtual-spacer{position:relative;width:100%;max-width:100%;min-width:0}.tipitaka-virtual-window{position:absolute;left:0;right:0;top:0;max-width:100%;min-width:0;will-change:transform}.tipitaka-hit{background:#ffe066;color:#2d2400;border-radius:3px;padding:0 2px;box-shadow:0 0 0 2px rgba(255,224,102,.22)}.tipitaka-active-hit{background:#ff9f1c;box-shadow:0 0 0 3px rgba(255,159,28,.35)}.tipitaka-default-hit{box-sizing:border-box;max-width:100%;margin:8px 0;padding:8px 10px;border-left:3px solid #c58b28;background:rgba(197,139,40,.09);font-size:.9em;overflow-wrap:anywhere}.tipitaka-skeleton{height:18px;margin:14px 0;background:linear-gradient(90deg,#eee,#fafafa,#eee);background-size:200% 100%;animation:tipitakaShimmer 1.3s infinite;border-radius:5px}.tipitaka-dict-entry{padding:12px 0;border-bottom:1px solid var(--border,#ddd);overflow-wrap:anywhere}.tipitaka-dict-entry h4{margin:0 0 5px}.tipitaka-page{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.tipitaka-note{color:var(--text-light,#777);font-size:.9em}.tipitaka-mobile-note{display:none}@keyframes tipitakaShimmer{to{background-position:-200% 0}}@media(max-width:760px){.tipitaka-layout{grid-template-columns:1fr}.tipitaka-catalog{max-height:38vh}.tipitaka-num{min-width:3.8em}.tipitaka-pane{height:calc(100vh - 230px);padding:0 10px}.tipitaka-toolbar{gap:6px}.tipitaka-toolbar button{padding:6px 8px}.tipitaka-mobile-note{display:block}}`; document.head.appendChild(style);
  }

  function injectSearchTargetCss() {
    if (document.getElementById('tipitaka-search-target-css')) return;
    const style = document.createElement('style');
    style.id = 'tipitaka-search-target-css';
    style.textContent = '.tipitaka-search-target{box-sizing:border-box;width:100%;max-width:100%;border:2px solid #d99000;border-radius:10px;padding:14px 12px;margin:8px 0;background:linear-gradient(90deg,rgba(255,224,102,.2),transparent);box-shadow:0 4px 18px rgba(120,80,0,.12);scroll-margin-top:18px}.tipitaka-pane{overflow-anchor:none;scroll-behavior:auto;overflow-x:clip;touch-action:pan-y pinch-zoom;overscroll-behavior-x:none}';
    style.textContent += `.tipitaka-layout{grid-template-columns:minmax(390px,42%) minmax(0,1fr);gap:28px;align-items:start}.tipitaka-layout>aside{min-width:0}.tipitaka-catalog{max-height:min(74vh,820px);border-radius:14px;box-shadow:0 8px 24px rgba(60,40,10,.06)}.tipitaka-catalog details{margin:3px 0;border-left:1px solid color-mix(in srgb,var(--border,#ddd) 70%,transparent)}.tipitaka-catalog details[data-depth="0"]{border-left:0}.tipitaka-catalog details[data-depth="1"]{margin-left:16px}.tipitaka-catalog details[data-depth="2"]{margin-left:18px}.tipitaka-catalog details[data-depth="3"]{margin-left:20px}.tipitaka-catalog summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start;cursor:pointer;padding:9px 10px;border-radius:8px;font-weight:650;line-height:1.45}.tipitaka-catalog summary>span{min-width:0;overflow-wrap:anywhere}.tipitaka-catalog summary small{color:var(--text-light,#777);font-weight:400;white-space:nowrap}.tipitaka-work-link{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:8px 10px 8px 30px;border-radius:7px;line-height:1.5;overflow-wrap:anywhere}.tipitaka-work-link small{white-space:nowrap;align-self:start}.tipitaka-pali-token{cursor:pointer;border-radius:4px;padding:1px 2px;margin-right:2px}.tipitaka-pali-token:hover,.tipitaka-pali-token:focus{background:#ffe8a3;outline:2px solid rgba(197,139,40,.35)}.tipitaka-catalog-search{width:100%;margin-bottom:10px}.tipitaka-catalog-help{margin:0 0 8px;color:var(--text-light,#777);font-size:.84em}.tipitaka-scope-trigger-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0}.tipitaka-scope-chips,.tipitaka-scope-selected{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.tipitaka-scope-chip{display:inline-flex;max-width:240px;padding:5px 9px;border-radius:999px;background:color-mix(in srgb,var(--primary,#8a6817) 12%,transparent);color:var(--primary,#6b4f2d);font-size:.84em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tipitaka-scope-empty{color:var(--text-light,#777);font-size:.9em}.tipitaka-scope-drawer{position:fixed;inset:0 0 0 auto;width:min(760px,92vw);height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;border-left:1px solid var(--border,#ddd);background:var(--card,#fff);color:var(--text,#222);box-shadow:-18px 0 50px rgba(30,20,10,.18)}.tipitaka-scope-drawer::backdrop{background:rgba(20,15,10,.44)}.tipitaka-scope-shell{height:100%;display:grid;grid-template-rows:auto auto auto minmax(0,1fr) auto;box-sizing:border-box}.tipitaka-scope-shell>header,.tipitaka-scope-shell>footer{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--border,#ddd)}.tipitaka-scope-shell>header{justify-content:space-between}.tipitaka-scope-shell>header h3,.tipitaka-scope-shell>header p{margin:0}.tipitaka-scope-shell>header p{margin-top:4px;color:var(--text-light,#777);font-size:.88em}.tipitaka-scope-shell>footer{justify-content:flex-end;border-top:1px solid var(--border,#ddd);border-bottom:0}.tipitaka-scope-shell button,.tipitaka-scope-shell input{box-sizing:border-box;padding:8px 11px;border:1px solid var(--border,#ccc);border-radius:8px;background:var(--card,#fff);color:inherit}.tipitaka-scope-close{font-size:1.45em;border:0!important}.tipitaka-scope-selected{min-height:34px;padding:10px 20px;border-bottom:1px solid var(--border,#ddd)}.tipitaka-scope-tools{display:flex;gap:8px;padding:12px 20px}.tipitaka-scope-tools input{flex:1;min-width:0}.tipitaka-scope-content{display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:16px;min-height:0;padding:0 20px 16px}.tipitaka-scope-content section{min-width:0;min-height:0}.tipitaka-scope-content h4{margin:4px 0 8px}.tipitaka-scope-tree{height:100%;max-height:none;box-sizing:border-box}.tipitaka-scope-tree summary{grid-template-columns:auto minmax(0,1fr) auto}.tipitaka-scope-tree .tipitaka-work-link{grid-template-columns:auto minmax(0,1fr) auto;cursor:default}.tipitaka-scope-tree input{width:18px;height:18px;margin:1px 0 0;padding:0}.tipitaka-scope-types{display:flex;flex-direction:column;gap:8px}.tipitaka-scope-types label{display:flex;gap:9px;align-items:center;padding:10px;border:1px solid var(--border,#ddd);border-radius:9px}.tipitaka-scope-types input{width:18px;height:18px;padding:0}.tipitaka-scope-count{margin-right:auto;color:var(--text-light,#777);font-size:.88em}@media(max-width:900px){.tipitaka-layout{grid-template-columns:minmax(320px,46%) minmax(0,1fr);gap:18px}}@media(max-width:760px){.tipitaka-layout{grid-template-columns:1fr}.tipitaka-layout>section{display:none}.tipitaka-catalog{max-height:62vh}.tipitaka-scope-drawer{width:100vw}.tipitaka-scope-content{grid-template-columns:1fr;overflow:auto}.tipitaka-scope-tree{height:auto;max-height:55vh}.tipitaka-scope-shell>footer{flex-wrap:wrap;padding:12px}.tipitaka-scope-count{width:100%;order:-1}.tipitaka-scope-tools{flex-wrap:wrap}.tipitaka-scope-tools input{flex-basis:100%}}`;
    style.textContent += `.tipitaka-scope-drawer{display:flex!important;flex-direction:column;overflow:hidden;height:100dvh;max-height:100dvh}.tipitaka-scope-shell{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;overflow:hidden}.tipitaka-scope-shell>header,.tipitaka-scope-shell>footer,.tipitaka-scope-selected,.tipitaka-scope-tools{flex:0 0 auto}.tipitaka-scope-selected{max-height:92px;overflow:auto}.tipitaka-scope-content{flex:1 1 auto;overflow:hidden}.tipitaka-scope-content>section{display:flex;flex-direction:column;overflow:hidden}.tipitaka-scope-content>section:first-child{min-height:0}.tipitaka-scope-tree{flex:1 1 auto;min-height:0;height:auto!important;overflow:auto}.tipitaka-scope-types{overflow:auto}.tipitaka-scope-shell>footer{position:relative;z-index:2;background:var(--card,#fff);box-shadow:0 -5px 16px rgba(40,25,10,.06)}.tipitaka-search-form{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px}.tipitaka-search-form #tipitaka-search-input{width:100%;min-width:0}.tipitaka-catalog-search-wrap{position:relative;display:flex;align-items:center;width:100%;margin-bottom:10px}.tipitaka-catalog-search-wrap>svg{position:absolute;left:12px;width:18px;height:18px;color:var(--text-light,#777);pointer-events:none}.tipitaka-catalog-search-wrap .tipitaka-catalog-search{margin:0;padding:10px 38px 10px 38px;border:1px solid var(--border,#d9cdbb);border-radius:999px;background:var(--card,#fff);box-shadow:0 2px 10px rgba(60,40,10,.05);outline:none}.tipitaka-catalog-search-wrap .tipitaka-catalog-search:focus{border-color:var(--primary,#8a6817);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary,#8a6817) 16%,transparent)}.tipitaka-catalog-search-clear{position:absolute;right:8px;width:28px;height:28px;padding:0!important;border:0!important;border-radius:50%!important;background:transparent!important;color:var(--text-light,#777);font-size:1.1em;line-height:1}.tipitaka-catalog-search-clear[hidden]{display:none}.tipitaka-catalog-search-clear:hover{background:color-mix(in srgb,var(--primary,#8a6817) 12%,transparent)!important}@supports not (height:100dvh){.tipitaka-scope-drawer{height:100vh;max-height:100vh}}@media(max-height:560px){.tipitaka-scope-shell>header{padding:9px 14px}.tipitaka-scope-shell>header p{display:none}.tipitaka-scope-selected{max-height:56px;padding:6px 14px}.tipitaka-scope-tools{padding:7px 14px}.tipitaka-scope-content{padding:0 14px 7px}.tipitaka-scope-shell>footer{padding:8px 12px}.tipitaka-scope-shell button,.tipitaka-scope-shell input{padding:6px 9px}}@media(max-width:760px){.tipitaka-scope-content{display:flex;flex-direction:column;gap:8px;overflow:hidden}.tipitaka-scope-content>section:first-child{flex:1 1 auto}.tipitaka-scope-content>section:last-child{flex:0 0 auto;max-height:34%;overflow:auto}.tipitaka-search-form{grid-template-columns:minmax(0,1fr) auto}.tipitaka-search-form select{grid-column:1}.tipitaka-search-form button{grid-column:2;grid-row:2}.tipitaka-search-form #tipitaka-search-input{grid-column:1 / -1}}@media(max-width:560px){.tipitaka-search-form select,.tipitaka-search-form button{width:100%}.tipitaka-search-form button{grid-column:1 / -1;grid-row:auto}}`;
    document.head.appendChild(style);
  }

  function injectTouchSafetyCss() {
    if (document.getElementById('tipitaka-touch-safety-css')) return;
    const style = document.createElement('style');
    style.id = 'tipitaka-touch-safety-css';
    style.textContent = '.tipitaka-pane{overflow-x:hidden!important;touch-action:pan-y pinch-zoom!important;overscroll-behavior-x:none!important}.tipitaka-search-target{max-width:100%;box-sizing:border-box}';
    document.head.appendChild(style);
  }

  function injectPaliInlineCss() {
    if (document.getElementById('tipitaka-pali-inline-css')) return;
    const style = document.createElement('style');
    style.id = 'tipitaka-pali-inline-css';
    style.textContent = '.tipitaka-pali{font-style:italic;color:var(--pali-color,var(--primary,#6b4f2d));font-size:.95em;line-height:1.6;margin-bottom:6px;overflow-wrap:break-word;word-break:break-word}.tipitaka-pali-token{all:unset;display:inline;font:inherit;color:inherit;cursor:pointer}.tipitaka-pali-token:hover{ text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}.tipitaka-pali-token:focus{outline:2px solid color-mix(in srgb,var(--primary,#6b4f2d) 45%,transparent);outline-offset:2px;border-radius:2px}';
    document.head.appendChild(style);
  }

  function readerToolbar(meta, current, hitState) {
    const s = settings();
    const hitNote = hitState?.total ? `<span class="tipitaka-note">搜索“${esc(hitState.query || '')}” · 命中 ${hitState.index + 1}/${hitState.total}</span><button data-t-action="hit-prev">上一处</button><button data-t-action="hit-next">下一处</button>` : hitState?.query ? `<span class="tipitaka-note">搜索“${esc(hitState.query)}”${hitState.semantic ? ' · 语义相关（实际相关术语可能不同）' : ''}</span>` : '';
    return `<div class="tipitaka-toolbar"><button data-t-action="back">← 目录</button><strong>${esc(meta.title)}</strong><label><input type="checkbox" data-t-toggle="pali" ${s.pali ? 'checked' : ''}> 巴利</label><label><input type="checkbox" data-t-toggle="zh" ${s.zh ? 'checked' : ''}> 中文</label><label><input type="checkbox" data-t-toggle="traditional" ${s.traditional ? 'checked' : ''}> 繁体</label><label><input type="checkbox" data-t-toggle="en" ${s.en ? 'checked' : ''}> English</label><button data-t-action="font-down">A−</button><button data-t-action="font-up">A+</button><button data-t-action="auto">自动滚动</button><button data-t-action="bookmark">☆ 收藏此处</button>${hitNote}${current?.paranum ? `<span class="tipitaka-note">段号 ${esc(current.paranum)}</span>` : ''}</div>`;
  }

  function highlightHtml(text, term, language, active = false, activePosition = null, matchedTerms = null) {
    text = String(text || ''); term = String(term || '').trim();
    if (!term) return esc(text);
    const terms = [...new Set((Array.isArray(matchedTerms) && matchedTerms.length ? matchedTerms : [term]).map(value => String(value || '').trim()).filter(Boolean))];
    const ranges = [];
    if (language === 'zh') {
      const normalizedText = normalizeZh(text), compact = normalizedText.replace(/\s/g, ''), rawIndex = [];
      for (let index = 0; index < normalizedText.length; index += 1) if (!/\s/.test(normalizedText[index])) rawIndex.push(index);
      for (const candidate of terms) {
        const normalizedTerm = normalizeZh(candidate).replace(/\s/g, '');
        for (let at = compact.indexOf(normalizedTerm); at !== -1; at = compact.indexOf(normalizedTerm, at + Math.max(1, normalizedTerm.length))) {
          const start = rawIndex[at], end = rawIndex[at + normalizedTerm.length - 1];
          if (start !== undefined && end !== undefined) ranges.push([start, end + 1, at]);
        }
      }
    } else if (language === 'pali') {
      for (const candidate of terms) {
        const q = normalizePali(candidate);
        let tokenPosition = 0;
        for (const match of text.matchAll(words)) { if (normalizePali(match[0]).startsWith(q)) ranges.push([match.index, match.index + match[0].length, tokenPosition]); tokenPosition += 1; }
      }
    } else {
      const lower = text.toLowerCase(), tokenMatches = [...text.matchAll(words)];
      for (const candidate of terms) {
        const q = candidate.toLowerCase();
        for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + Math.max(1, q.length))) {
          const tokenPosition = tokenMatches.findIndex(match => match.index >= at);
          ranges.push([at, at + q.length, tokenPosition < 0 ? 0 : tokenPosition]);
        }
      }
    }
    if (!ranges.length) return esc(text);
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let out = '', cursor = 0;
    for (const [start, end, position] of ranges) {
      if (start < cursor) continue;
      const hasActivePosition = activePosition !== null && activePosition !== undefined && activePosition !== '' && Number.isFinite(Number(activePosition));
      const isActive = active && (!hasActivePosition || Number(position) === Number(activePosition));
      out += esc(text.slice(cursor, start)) + `<mark class="tipitaka-hit${isActive ? ' tipitaka-active-hit' : ''}" data-t-hit-position="${esc(position)}">${esc(text.slice(start, end))}</mark>`;
      cursor = end;
    }
    return out + esc(text.slice(cursor));
  }

  function paliTokensHtml(value) {
    const text = strip(value), out = []; let cursor = 0;
    for (const match of text.matchAll(words)) {
      out.push(esc(text.slice(cursor, match.index)));
      out.push(`<span class="tipitaka-pali-token" data-pali-token="${esc(match[0])}" role="button" tabindex="0" aria-label="查词 ${esc(match[0])}">${esc(match[0])}</span>`);
      cursor = match.index + match[0].length;
    }
    return out.join('') + esc(text.slice(cursor));
  }

  function paliTokensHighlightHtml(value, term, matchedTerms) {
    const text = strip(value), out = []; let cursor = 0;
    for (const match of text.matchAll(words)) {
      out.push(esc(text.slice(cursor, match.index)));
      const marked = highlightHtml(match[0], term, 'pali', false, null, matchedTerms);
      out.push(`<span class="tipitaka-pali-token" data-pali-token="${esc(match[0])}" role="button" tabindex="0" aria-label="查词 ${esc(match[0])}">${marked}</span>`);
      cursor = match.index + match[0].length;
    }
    return out.join('') + esc(text.slice(cursor));
  }

  function rowHtml(row, overlays, hit) {
    const s = settings(), parts = [], lang = hit?.language, term = hit?.query;
    const isHitRow = !!hit && Number(row.id) === Number(hit.rowId);
    const show = (language, value) => highlightHtml(language === 'zh' ? chineseDisplay(value) : value, term, language, !!hit && lang === language, hit?.position, hit?.terms);
    if (s.pali && row.pali_text) parts.push(`<div class="tipitaka-pali" data-t-pali="${esc(strip(row.pali_text))}">${isHitRow && lang === 'pali' ? paliTokensHighlightHtml(row.pali_text, term, hit?.terms) : paliTokensHtml(row.pali_text)}</div>`);
    if (s.zh && displayed(row, overlays, 'zh')) {
      const value = displayed(row, overlays, 'zh'), base = chineseDisplay(defaultText(row, 'zh'));
      const effective = isHitRow && lang === 'zh' ? show('zh', value) : esc(chineseDisplay(value));
      const hitTerms = hit?.terms?.length ? hit.terms : [term];
      const hasZhHit = textValue => hitTerms.some(candidate => normalizeZh(chineseDisplay(textValue)).includes(normalizeZh(candidate).replace(/\s/g, '')));
      const defaultHit = term && lang === 'zh' && !hasZhHit(value) && hasZhHit(base);
      parts.push(`<div class="tipitaka-zh">${effective}${defaultHit ? `<details class="tipitaka-default-hit"><summary>默认文本命中（当前覆盖层未命中）</summary>${highlightHtml(base, term, 'zh', true, hit?.position, hit?.terms)}</details>` : ''}</div>`);
    }
    if (s.en && displayed(row, overlays, 'en')) parts.push(`<div class="tipitaka-en">${isHitRow && lang === 'en' ? show('en', displayed(row, overlays, 'en')) : esc(displayed(row, overlays, 'en'))}</div>`);
    return `<article class="tipitaka-row${isHitRow ? ' tipitaka-search-target' : ''}" data-t-row="${row.id}" data-rend="${esc(row.rend || '')}"><span class="tipitaka-num">${esc(row.paranum || row.id)}</span>${parts.join('')}<details class="tipitaka-actions"><summary>译文操作</summary><div class="tipitaka-actions-grid"><button data-t-action="edit-zh" data-row="${row.id}">编辑中译</button><button data-t-action="draft-zh" data-row="${row.id}">Dharmamitra 草稿</button><button data-t-action="edit-en" data-row="${row.id}">编辑英译</button><button data-t-action="history" data-row="${row.id}">历史</button></div></details></article>`;
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
    // A Fenwick tree gives the viewport, the spacer and the translated window
    // one canonical coordinate system.  The former implementation selected
    // rows with estimated heights but translated them with measured heights;
    // long commentary rows eventually pushed every rendered row off-screen.
    const count = work.rows.length, tree = new Float64Array(count + 1), heights = new Float64Array(count), indexById = new Map(work.rows.map((row, index) => [Number(row.id), index]));
    let start = -1, end = -1, raf = 0, positionRaf = 0, positionToken = 0, destroyed = false;
    const add = (index, amount) => { for (let i = index + 1; i <= count; i += i & -i) tree[i] += amount; };
    const measuredBefore = index => { let sum = 0; for (let i = index; i > 0; i -= i & -i) sum += tree[i]; return sum; };
    const offsetFor = index => Math.max(0, Math.min(count, index)) * EST_ROW_HEIGHT + measuredBefore(Math.max(0, Math.min(count, index)));
    const totalHeight = () => offsetFor(count);
    const indexAt = offset => {
      let low = 0, high = count;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (offsetFor(mid) <= offset) low = mid; else high = mid - 1; }
      return Math.max(0, Math.min(count - 1, low));
    };
    const clampScroll = value => Math.max(0, Math.min(Number(value) || 0, Math.max(0, pane.scrollHeight - pane.clientHeight)));
    const measure = () => {
      if (destroyed) return;
      const anchor = indexAt(pane.scrollTop);
      let shift = 0, changed = false;
      windowEl.querySelectorAll('[data-t-row]').forEach(element => {
        const index = indexById.get(Number(element.dataset.tRow)), height = Math.ceil(element.getBoundingClientRect().height);
        if (index === undefined || !height || heights[index] === height) return;
        const previous = heights[index] || EST_ROW_HEIGHT, delta = height - previous;
        heights[index] = height; add(index, delta); changed = true;
        if (index < anchor) shift += delta;
      });
      if (changed) {
        if (shift) pane.scrollTop += shift;
        spacer.style.height = `${Math.max(1, totalHeight())}px`;
        windowEl.style.transform = `translateY(${offsetFor(start)}px)`;
      }
    };
    const draw = (force = false) => {
      if (destroyed) return;
      const viewport = Math.max(pane.clientHeight, EST_ROW_HEIGHT * 4), first = indexAt(pane.scrollTop), last = indexAt(pane.scrollTop + viewport);
      const nextStart = Math.max(0, first - OVERSCAN), nextEnd = Math.min(count, Math.max(nextStart + 1, last + OVERSCAN + 1));
      if (!force && nextStart === start && nextEnd === end) return;
      start = nextStart; end = nextEnd;
      windowEl.style.transform = `translateY(${offsetFor(start)}px)`;
      windowEl.innerHTML = work.rows.slice(start, end).map(row => rowHtml(row, overlays, hit && Number(row.id) === Number(hit.rowId) ? hit : null)).join('');
      spacer.style.height = `${Math.max(1, totalHeight())}px`;
      requestAnimationFrame(measure);
    };
    const targetFor = rowId => windowEl.querySelector(`[data-t-row="${String(rowId)}"]`);
    const scrollToIndex = (requestedIndex, align = 'center', targetOffset = 0) => {
      const index = Math.max(0, Math.min(count - 1, Number(requestedIndex) || 0)), rowId = work.rows[index]?.id, token = ++positionToken;
      if (positionRaf) cancelAnimationFrame(positionRaf);
      let attempts = 0;
      const settle = () => {
        positionRaf = 0;
        if (destroyed || token !== positionToken) return;
        measure();
        draw(true);
        const element = targetFor(rowId);
        if (!element) {
          if (attempts++ < 12) positionRaf = requestAnimationFrame(settle);
          return;
        }
        const paneRect = pane.getBoundingClientRect(), rowRect = element.getBoundingClientRect();
        const desired = align === 'anchor'
          ? paneRect.top + Number(targetOffset || 0)
          : align === 'top' ? paneRect.top + 12 : paneRect.top + pane.clientHeight / 2;
        const actual = align === 'top' ? rowRect.top : rowRect.top + rowRect.height / 2;
        const delta = actual - desired, visible = rowRect.bottom > paneRect.top && rowRect.top < paneRect.bottom;
        if ((!visible || Math.abs(delta) > 3) && attempts++ < 12) {
          pane.scrollTop = clampScroll(pane.scrollTop + delta);
          draw(true);
          positionRaf = requestAnimationFrame(settle);
        }
      };
      spacer.style.height = `${Math.max(1, totalHeight())}px`;
      void spacer.offsetHeight;
      pane.scrollTop = clampScroll(offsetFor(index) - (align === 'anchor'
        ? Number(targetOffset || 0)
        : align === 'top' ? 12 : Math.max(0, (pane.clientHeight - (heights[index] || EST_ROW_HEIGHT)) / 2)));
      draw(true);
      const frame = requestAnimationFrame(() => { if (positionRaf !== frame) return; positionRaf = 0; settle(); });
      positionRaf = frame;
      setTimeout(() => { if (destroyed || token !== positionToken || positionRaf !== frame) return; cancelAnimationFrame(frame); positionRaf = 0; settle(); }, 120);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw(true)) : null;
    pane.addEventListener('scroll', schedule, { passive: true }); resize?.observe(pane);
    spacer.style.height = `${count * EST_ROW_HEIGHT}px`;
    draw(true);
    const getAnchor = () => {
      const index = indexAt(pane.scrollTop + 1), row = work.rows[index];
      if (!row) return null;
      const element = targetFor(row.id), paneRect = pane.getBoundingClientRect();
      return {
        rowId: Number(row.id),
        offset: element ? element.getBoundingClientRect().top - paneRect.top : 12,
      };
    };
    return {
      pane,
      offsetFor,
      draw,
      getAnchor,
      scrollToRow: rowId => scrollToIndex(indexById.get(Number(rowId)) ?? currentIndex),
      restoreAnchor: anchor => {
        if (!anchor?.rowId) return;
        const index = indexById.get(Number(anchor.rowId));
        if (index !== undefined) scrollToIndex(index, 'anchor', Number(anchor.offset) || 12);
      },
      destroy: () => { destroyed = true; positionToken += 1; if (raf) cancelAnimationFrame(raf); if (positionRaf) cancelAnimationFrame(positionRaf); pane.removeEventListener('scroll', schedule); resize?.disconnect(); },
    };
  }

  function searchTextForRow(row, language) {
    return language === 'zh' ? (row.chinese_simplified || row.chinese_raw || '') : language === 'en' ? (row.english_translation || '') : strip(row.pali_text);
  }
  function searchAnchorForRow(row, language) { return searchTextForRow(row, language).slice(0, 64); }
  function normalizeSearchAnchor(value, language) {
    if (language === 'zh') return normalizeZh(value).replace(/\s/g, '');
    if (language === 'pali') return normalizePali(strip(value));
    return normalizeEn(value).replace(/\s+/g, ' ');
  }
  function findRowBySearchAnchor(work, language, anchor) {
    const needle = normalizeSearchAnchor(anchor, language); if (!needle) return null;
    return work.rows.find(row => normalizeSearchAnchor(searchTextForRow(row, language), language).includes(needle)) || null;
  }
  async function searchHitsForReader(value, language, workId) {
    if (!value) return [];
    try {
      const result = await runSearch(value, language, { types: ['corpus'], workIds: [workId] });
      return result.results.map(item => { const parts = locatorParts(item.locator); return { rowId: Number(parts[2]), positions: Array.isArray(item.positions) ? item.positions.map(Number).filter(Number.isFinite) : [], matchedTerms: Array.isArray(item.matched_terms) ? item.matched_terms : [], matchLevel: item.match_level, score: item.score }; });
    } catch { return []; }
  }

  async function renderReader(workId, preserveAnchor = null) {
    injectCss(); injectSearchTargetCss(); injectTouchSafetyCss(); injectPaliInlineCss();
    const renderId = ++state.readerRequest;
    state.reader?.virtual?.destroy?.();
    app.innerHTML = '<div class="loading"><div class="spinner"></div><div>正在准备三语阅读窗口…</div></div>';
    try {
      await ensureCatalog();
      if (renderId !== state.readerRequest) return;
      const meta = state.works.find(work => work.id === workId); if (!meta) throw new Error('找不到该作品');
      app.innerHTML = `<div class="cat-header"><h2>${esc(meta.title)}</h2><div class="cat-en">${esc(meta.path.join(' / '))} · ${meta.row_count.toLocaleString()} 行</div></div><div class="tipitaka-skeleton"></div><div class="tipitaka-skeleton"></div>`;
      const [loaded, overlays] = await Promise.all([workById(workId), overrides(workId)]);
      if (renderId !== state.readerRequest) return;
      const work = loaded[1], params = query(), requestedRowId = Number(params.get('row') || 0);
      const positionParam = params.get('hl_pos');
      const hit = params.get('hl') ? { query: params.get('hl'), language: params.get('hl_lang') || 'zh', rowId: requestedRowId, anchor: params.get('hl_anchor') || '', terms: (params.get('hl_terms') || '').split('|').filter(Boolean), position: positionParam !== null && positionParam !== '' && Number.isFinite(Number(positionParam)) ? Number(positionParam) : null, semantic: params.get('semantic') === '1' } : null;
      const hitRows = hit ? await searchHitsForReader(hit.query, hit.language, workId) : [];
      if (renderId !== state.readerRequest) return;
      if (hit) {
        let target = hitRows.find(item => Number(item.rowId) === requestedRowId);
        if (!target && hit.anchor) {
          const fallback = findRowBySearchAnchor(work, hit.language, hit.anchor);
          if (fallback) { hit.rowId = Number(fallback.id); target = hitRows.find(item => Number(item.rowId) === hit.rowId); }
        }
        if (target?.positions?.length) hit.position = target.positions.includes(hit.position) ? hit.position : target.positions[0];
        if (target?.matchedTerms?.length) hit.terms = target.matchedTerms;
      }
      const currentRowId = preserveAnchor?.rowId || hit?.rowId || requestedRowId;
      let currentIndex = work.rows.findIndex(row => Number(row.id) === currentRowId); if (currentIndex < 0) currentIndex = 0;
      const hitIndex = hit ? Math.max(0, hitRows.findIndex(item => Number(item.rowId) === Number(hit.rowId))) : 0;
      state.reader = { meta, work, overlays, currentIndex, hit, hitRows, hitIndex, virtual: null };
      app.innerHTML = `${readerToolbar(meta, work.rows[currentIndex], hit && hitRows.length ? { total: hitRows.length, index: hitIndex, query: hit.query } : hit ? { query: hit.query } : null)}<div class="tipitaka-note">共 ${work.rows.length.toLocaleString()} 段；只渲染可视窗口，已访问作品会进入本地缓存。${hit ? ` 搜索命中：“${esc(hit.query)}”，已定位到目标段。` : ''}</div><div class="tipitaka-pane" id="tipitaka-pane" style="font-size:${settings().font}px"><div class="tipitaka-virtual-spacer" id="tipitaka-virtual-spacer"><div class="tipitaka-virtual-window" id="tipitaka-virtual-window"></div></div></div><div class="tipitaka-toolbar">${jumpButtons(work.rows[currentIndex])}</div>`;
      state.reader.virtual = renderVirtual(meta, work, overlays, currentIndex, hit);
      if (preserveAnchor?.rowId) state.reader.virtual?.restoreAnchor(preserveAnchor);
      else state.reader.virtual?.scrollToRow(work.rows[currentIndex]?.id);
      localStorage.setItem('tipitaka-reader-history', JSON.stringify({ workId, rowId: work.rows[currentIndex]?.id, at: Date.now() }));
      syncProgress(workId, work.rows[currentIndex]?.id);
      bindReader();
    } catch (error) { if (renderId === state.readerRequest) app.innerHTML = `<div class="error-msg">${esc(error.message)}。目录可用时，正文会在静态数据源恢复后继续加载。</div>`; }
  }

  function moveReaderHit(delta) {
    const reader = state.reader; if (!reader?.hitRows?.length) return;
    reader.hitIndex = (reader.hitIndex + delta + reader.hitRows.length) % reader.hitRows.length;
    const next = reader.hitRows[reader.hitIndex], rowId = next.rowId, idx = reader.work.rows.findIndex(row => Number(row.id) === Number(rowId));
    if (idx < 0) return;
    reader.currentIndex = idx;
    const params = new URLSearchParams({ row: String(rowId), hl: reader.hit.query, hl_lang: reader.hit.language });
    if (next.positions?.length) params.set('hl_pos', String(next.positions[0]));
    if (next.matchedTerms?.length) params.set('hl_terms', next.matchedTerms.join('|'));
    params.set('hl_anchor', searchAnchorForRow(reader.work.rows[idx], reader.hit.language));
    history.replaceState(null, '', `${location.pathname}${location.search}#/tipitaka/read/${encodeURIComponent(reader.meta.id)}?${params}`);
    renderReader(reader.meta.id);
  }
  function bindReader() {
    app.onclick = async event => {
      const paliEl = event.target.closest('.tipitaka-pali');
      if (paliEl) {
        const selected = window.getSelection()?.toString().trim();
        if (selected) { await showDictionary(selected); return; }
        const token = event.target.closest('[data-pali-token]');
        if (token) { await showDictionary(token.dataset.paliToken); return; }
      }
      const button = event.target.closest('button,[data-t-action]'); if (!button) return;
      const reader = state.reader, action = button.dataset.tAction;
      if (!reader) return;
      if (action === 'back') { location.hash = '#/tipitaka'; return; }
      if (action === 'font-up' || action === 'font-down') { const anchor = reader.virtual?.getAnchor(); settings().font = Math.max(13, Math.min(30, settings().font + (action === 'font-up' ? 1 : -1))); saveSettings(); renderReader(reader.meta.id, anchor); return; }
      if (action === 'auto') { toggleAutoScroll(); return; }
      if (action === 'hit-prev') { moveReaderHit(-1); return; }
      if (action === 'hit-next') { moveReaderHit(1); return; }
      if (action === 'bookmark') { await saveBookmark(reader.meta, reader.work.rows[reader.currentIndex]); return; }
      const row = reader.work.rows.find(item => Number(item.id) === Number(button.dataset.row)); if (!row) return;
      if (action === 'edit-zh' || action === 'edit-en') await editTranslation(reader.meta, row, action === 'edit-zh' ? 'zh' : 'en');
      if (action === 'draft-zh') await draftTranslation(reader.meta, row);
      if (action === 'history') await showHistory(reader.meta.id, row.id);
    };
    app.onkeydown = async event => {
      const token = event.target.closest?.('[data-pali-token]');
      if (token && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); await showDictionary(token.dataset.paliToken);
      }
    };
    app.onchange = event => {
      const toggle = event.target.dataset.tToggle;
      if (toggle) {
        const anchor = state.reader?.virtual?.getAnchor();
        settings()[toggle] = event.target.checked;
        saveSettings();
        renderReader(state.reader.meta.id, anchor);
      }
    };
  }
  function toggleAutoScroll() { const pane = document.getElementById('tipitaka-pane'); if (!pane) return; if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; return; } state.autoTimer = setInterval(() => pane.scrollTop += settings().speed / 10, 50); }
  async function saveBookmark(meta, row) { try { const result = await fetch(`${API}/bookmarks`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ work_id: meta.id, row_id: row.id, label: `${meta.title} · ${row.paranum || row.id}` }) }); if (!result.ok) throw new Error('请先登录后收藏'); alert('已收藏'); } catch (e) { alert(e.message); } }
  async function syncProgress(workId, rowId) { try { await fetch(`${API}/progress`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ work_id: workId, row_id: rowId }) }); } catch {} }
  async function editTranslation(meta, row, language) { const base = defaultText(row, language); const text = prompt(`编辑${language === 'zh' ? '中文' : '英文'}译文`, base); if (text === null) return; const reason = prompt('修改理由（将记入公开历史）', '') ?? ''; const response = await fetch(`${API}/works/${encodeURIComponent(meta.id)}/rows/${row.id}/${language}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text, default_text: base, reason, source: 'human' }) }); if (!response.ok) { alert((await response.json().catch(() => ({}))).detail || '保存失败，请先登录'); return; } state.overrides.delete(meta.id); renderReader(meta.id); }
  async function draftTranslation(meta, row) { if (!row.pali_text || typeof mitraTranslate !== 'function') { alert('该行没有巴利原文，或翻译服务尚不可用。'); return; } try { const draft = await mitraTranslate(strip(row.pali_text), `Tipiṭaka Reader V4 · ${meta.title}`); if (!confirm(`Dharmamitra 草稿：\n\n${draft}\n\n确认写入公开修订历史？`)) return; const base = defaultText(row, 'zh'); const response = await fetch(`${API}/works/${encodeURIComponent(meta.id)}/rows/${row.id}/zh`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text: draft, default_text: base, reason: 'Dharmamitra 草稿经人工确认', source: 'dharmamitra' }) }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || '保存失败'); state.overrides.delete(meta.id); renderReader(meta.id); } catch (error) { alert(error.message); } }
  async function showHistory(workId, rowId) { const language = prompt('查看哪个语种历史？输入 zh 或 en', 'zh'); if (!language) return; const rows = await fetch(`${API}/works/${encodeURIComponent(workId)}/rows/${rowId}/${language}/history`).then(r => r.ok ? r.json() : []); if (!rows.length) { alert('尚无历史记录'); return; } const list = rows.map((item, index) => `${index + 1}. ${new Date(item.created_at).toLocaleString()}\n${item.text}\n理由：${item.reason || '—'}`).join('\n\n'); const choice = prompt(`${list}\n\n输入版本编号即可恢复；取消仅查看。`, ''); if (!choice) return; const revision = rows[Number(choice) - 1]; if (!revision) { alert('无效版本编号'); return; } if (!confirm(`恢复为版本 ${choice}？这会新增一条可追溯的修订。`)) return; const saved = await fetch(`${API}/works/${encodeURIComponent(workId)}/rows/${rowId}/${language}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text: revision.text, default_text: '', reason: `从历史版本 ${choice} 恢复`, source: 'restore' }) }); if (!saved.ok) { alert((await saved.json().catch(() => ({}))).detail || '恢复失败，请先登录'); return; } state.overrides.delete(workId); renderReader(workId); }

  async function ensureV4SearchManifest() { if (!state.searchV4Manifest) state.searchV4Manifest = await cachedJson('search-v4/manifest.json', SEARCH_CACHE_NAME); return state.searchV4Manifest; }
  function v4Types(options = {}) { return Array.isArray(options.types) && options.types.length ? options.types : ['corpus', 'catalog', 'proper', 'user_dictionary', 'dictionary']; }
  async function runSearch(value, language, options = {}) {
    const originalValue = String(value || '').trim();
    value = language === 'zh' ? normalizeZh(originalValue) : originalValue;
    await ensureCatalog();
    const manifest = await ensureV4SearchManifest();
    const workIndexes = Array.isArray(options.workIds) ? options.workIds.map(id => manifest.work_ids.indexOf(id)).filter(index => index >= 0) : null;
    const dictionaryIndexes = Array.isArray(options.dictionaryTables) ? options.dictionaryTables.map(table => state.dictionaries.findIndex(item => item.table === table)).filter(index => index >= 0) : null;
    ensureWorkers();
    if (state.searchWorker) {
      const result = await workerRequest(state.searchWorker, { base: DATA_BASE, q: value, language, types: v4Types(options), workIndexes, dictionaryIndexes });
      return { ...result, query: originalValue, index_query: value };
    }
    throw new Error('当前浏览器不支持 V4 Worker 检索');
  }
  window.TipitakaV4 = window.TipitakaV4 || {};
  window.TipitakaV4.search = (value, language = 'zh', options = {}) => runSearch(value, language, options);
  window.TipitakaV4.catalog = async () => { await ensureCatalog(); return state.works; };
  window.TipitakaV4.workIdsForScopes = async scopes => { await ensureCatalog(); const selected = new Set(scopes || []); return state.works.filter(work => [...selected].some(scope => work.id === scope || work.path.join(' / ') === scope || work.path.join(' / ').startsWith(`${scope} / `))).map(work => work.id); };
  window.TipitakaV4.resolve = (result, page = 0) => resolveSearchPage(result, page);
  window.TipitakaV4.openScopeDrawer = options => openV4ScopeDrawer(options);
  window.TipitakaV4.scopeSummaryHtml = scopes => scopeSummaryHtml(scopes || []);
  window.addEventListener('hashchange', () => document.getElementById('tipitaka-scope-drawer')?.remove());
  function locatorParts(locator) { return String(locator || '').split(':'); }
  async function resolveV4Locator(item) {
    const [type, a, b, c] = locatorParts(item.locator);
    if (type === 'row') {
      const meta = state.works[Number(a)], work = await workById(meta.id), row = work[1].rows.find(candidate => Number(candidate.id) === Number(b));
      return row ? { ...item, kind: 'corpus', meta, work: work[1], row, score: item.score } : null;
    }
    if (type === 'catalog') return { ...item, kind: 'catalog', meta: state.works[Number(a)], score: item.score };
    if (type === 'proper') { const items = await cachedJson('terminology/proper-nouns.json'); return items[Number(a)] ? { ...item, kind: 'proper', term: items[Number(a)], score: item.score } : null; }
    if (type === 'user') { const items = await cachedJson('terminology/user-dictionary.json'); return items[Number(a)] ? { ...item, kind: 'user_dictionary', term: items[Number(a)], score: item.score } : null; }
    if (type === 'dict') {
      const dictionary = state.dictionaries[Number(a)], shard = dictionary?.shards?.[Number(b)]; if (!shard) return null;
      const data = await cachedJson(shard.file), row = data.rows.find(candidate => Number(candidate.id) === Number(c));
      return row ? { ...item, kind: 'dictionary', dictionary, row, locator: item.locator, score: item.score } : null;
    }
    return null;
  }
  function searchItemText(item, language) {
    if (item.kind === 'corpus') return searchTextForRow(item.row, language);
    if (item.kind === 'catalog') return item.meta.path.concat(item.meta.title).join(' · ');
    if (item.kind === 'proper') return language === 'pali' ? item.term.pali : language === 'en' ? item.term.english || item.term.english_comment : [item.term.preferred_chinese, item.term.new_chinese, item.term.old_chinese, item.term.chinese_comment].filter(Boolean).join(' · ');
    if (item.kind === 'user_dictionary') return language === 'pali' ? item.term.dict_key : item.term.dict_content;
    return language === 'pali' ? item.row.dict_key : item.row.dict_content;
  }
  function searchResultHref(item, language, term) {
    if (item.kind === 'catalog') return `#/tipitaka?open=${encodeURIComponent(item.meta.path.join(' / '))}`;
    if (item.kind === 'proper') return `#/tipitaka/dictionaries?tab=proper&term=${encodeURIComponent(item.term.pali || '')}`;
    if (item.kind === 'user_dictionary') return `#/tipitaka/dictionaries?tab=proper&term=${encodeURIComponent(item.term.dict_key || '')}`;
    if (item.kind === 'dictionary') return `#/tipitaka/dictionaries?term=${encodeURIComponent(term)}&lang=${encodeURIComponent(language)}&dict=${encodeURIComponent(item.dictionary.table)}&entry=${encodeURIComponent(item.row.id)}`;
    const rowId = item.row?.id ?? item.rowId, params = new URLSearchParams({ row: String(rowId), hl: term, hl_lang: language, hl_anchor: searchAnchorForRow(item.row, language) });
    if (Array.isArray(item.positions) && Number.isFinite(Number(item.positions[0]))) params.set('hl_pos', String(item.positions[0]));
    if (Array.isArray(item.matched_terms) && item.matched_terms.length) params.set('hl_terms', item.matched_terms.join('|'));
    return `#/tipitaka/read/${encodeURIComponent(item.meta.id)}?${params}`;
  }
  function searchResultEvidence(item, language, term) {
    const text = searchItemText(item, language) || '', anchor = text.slice(0, 64);
    const position = Array.isArray(item.positions) && Number.isFinite(Number(item.positions[0])) ? Number(item.positions[0]) : null;
    const evidenceTerms = Array.isArray(item.matched_terms) && item.matched_terms.length ? item.matched_terms : [term];
    const normalizedTerm = language === 'zh' ? normalizeZh(term).replace(/\s/g, '') : language === 'pali' ? normalizePali(term) : normalizeEn(term);
    const normalizedText = language === 'zh' ? normalizeZh(text).replace(/\s/g, '') : language === 'pali' ? normalizePali(text) : normalizeEn(text);
    let at = normalizedTerm ? normalizedText.indexOf(normalizedTerm) : -1;
    if (at < 0) {
      for (const candidate of evidenceTerms) {
        const normalizedCandidate = language === 'zh' ? normalizeZh(candidate).replace(/\s/g, '') : language === 'pali' ? normalizePali(candidate) : normalizeEn(candidate);
        if (!normalizedCandidate) continue;
        at = normalizedText.indexOf(normalizedCandidate);
        if (at >= 0) break;
      }
    }
    const rawAt = at >= 0 ? Math.max(0, Math.min(text.length, at)) : 0;
    const start = Math.max(0, rawAt - 220), end = Math.min(text.length, rawAt + Math.max(term.length, 1) + 340);
    const isCorpus = item.kind === 'corpus';
    return {
      kind: 'v4', resource_type: item.kind, resource_locator: item.locator,
      source: `V4 ${item.kind === 'dictionary' ? '词典' : item.kind === 'proper' || item.kind === 'user_dictionary' ? '术语' : '三藏'} · ${item.meta?.title || item.dictionary?.table || item.term?.pali || item.term?.dict_key || ''}`,
      heading: item.meta ? `${item.meta.path.join(' / ')}${item.row?.paranum ? ` · 段号 ${item.row.paranum}` : ''}` : item.dictionary?.description || '',
      path: item.meta?.path || [], text: text.slice(start, end), work_id: isCorpus ? item.meta.id : null, row_id: isCorpus ? Number(item.row.id) : null,
      language, query: term, position, anchor, paranum: item.row?.paranum || null, matched_terms: item.matched_terms || [], match_level: item.match_level || null, _href: searchResultHref(item, language, term), _v4: true,
    };
  }
  window.TipitakaV4.evidence = (item, language, term) => searchResultEvidence(item, language, term);
  window.TipitakaV4.resultHref = (item, language, term) => searchResultHref(item, language, term);

  async function resolveSearchPage(result, page) {
    const pageItems = result.results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    return (await Promise.all(pageItems.map(resolveV4Locator))).filter(Boolean);
  }
  function matchLevelLabel(level) { return level === 'exact' ? '精确短语命中' : level === 'core' ? '核心词命中' : '相关词命中'; }
  function searchResultHtml(item, language, term) {
    const text = searchItemText(item, language) || '', href = searchResultHref(item, language, term), label = item.kind === 'corpus' ? `${item.meta.title} · ${item.row.paranum || item.row.id}` : item.kind === 'dictionary' ? `${item.row.dict_key} · ${item.dictionary.table}` : item.kind === 'catalog' ? item.meta.path.concat(item.meta.title).join(' / ') : item.term.pali || item.term.dict_key;
    const level = item.match_level ? `<span class="tipitaka-note"> · ${matchLevelLabel(item.match_level)}</span>` : '';
    const display = language === 'zh' ? chineseDisplay(text) : text;
    return `<a class="tipitaka-search-result" href="${esc(href)}"><strong>${esc(label)}</strong><span class="tipitaka-note"> · ${esc(item.kind)}${level}</span><br><span>${highlightHtml(display.slice(0, 360), term, language, true, null, item.matched_terms)}</span></a>`;
  }
  function v4ScopeWorkIds() {
    const raw = query().get('scope'); if (!raw) return null;
    const selected = new Set(raw.split('|').filter(Boolean)); if (!selected.size) return null;
    return state.works.filter(work => [...selected].some(scope => work.id === scope || work.path.join(' / ') === scope || work.path.join(' / ').startsWith(`${scope} / `))).map(work => work.id);
  }
  async function runHybridSearch(value, language, scopes, types) {
    if (!HYBRID_SEARCH_BASE) return null;
    const params = new URLSearchParams({ q: value, corpora: 'v4', language, mode: 'explore', page_size: '40' });
    if (scopes.length) params.set('scopes', scopes.join('|'));
    if (types.length && types.length < 5) params.set('resource_types', types.join(','));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
    try { const response = await fetch(`${HYBRID_SEARCH_BASE}/api/search/v1/hybrid?${params}`, { signal: controller.signal }); if (!response.ok) throw new Error(`混合检索 HTTP ${response.status}`); return await response.json(); }
    finally { clearTimeout(timer); }
  }
  function hybridSearchHref(item, language, queryText) {
    const type = item.resource_type || 'corpus';
    if (type === 'dictionary') return `#/tipitaka/dictionaries?term=${encodeURIComponent(queryText)}&lang=${encodeURIComponent(language)}&dict=${encodeURIComponent(item.dictionary_table || '')}&entry=${encodeURIComponent(item.row_id || '')}`;
    if (type === 'proper' || type === 'user_dictionary') return `#/tipitaka/dictionaries?tab=proper&term=${encodeURIComponent(item.title || item.text_pali || queryText)}`;
    if (type === 'catalog') return `#/tipitaka?open=${encodeURIComponent((item.path || []).join(' / '))}`;
    const params = new URLSearchParams({ row: String(item.row_id), hl: queryText, hl_lang: language, hl_anchor: item.anchor || '', semantic: '1' });
    return `#/tipitaka/read/${encodeURIComponent(item.work_id)}?${params}`;
  }
  function hybridSearchHtml(data, language, queryText) {
    const rows = (data?.results || []).map(item => `<a class="tipitaka-search-result" href="${esc(hybridSearchHref(item, language, queryText))}"><strong>${esc(item.title || item.work_id)} · ${esc(item.paranum || item.row_id)}</strong><span class="tipitaka-note"> · ${esc(item.lane === 'direct' ? '直接回答' : '相关主题与探索')} · ${esc((item.match_reasons || []).join('、') || '语义相关')}</span><br><span>${esc(item.snippet || item.text_zh || item.text_en || item.text_pali || '')}</span></a>`).join('');
    return rows ? `<section class="tipitaka-hybrid-results"><h3>混合语义补充 <span class="tipitaka-note">词法 + 语义 + RRF · ${data.semantic?.degraded ? '当前语义降级' : '语义服务已启用'}</span></h3>${rows}</section>` : '';
  }
  async function renderSearch() {
    injectCss(); injectSearchTargetCss(); await ensureCatalog();
    const selected = query().get('scope') || '', typeParam = query().get('types') || '', selectedTypes = typeParam ? new Set(typeParam.split('|').filter(Boolean)) : new Set(['corpus', 'catalog', 'proper', 'user_dictionary', 'dictionary']);
    const scopeSet = new Set(selected.split('|').filter(Boolean));
    app.innerHTML = `<button class="back-btn" onclick="location.hash='#/tipitaka'">← 三藏目录</button><div class="cat-header"><h2>V4 全内容检索</h2><div class="cat-en">217 works · dictionaries · terminology · Pāli · 简体中文 · English</div></div><div class="tipitaka-scope-trigger-row"><button type="button" class="v4-scope-button ${scopeSet.size ? 'is-active' : ''}" id="tipitaka-scope-open" aria-label="筛选 V4 范围">${scopeButtonHtml(scopeSet.size)}</button><div class="tipitaka-scope-chips" id="tipitaka-scope-chips">${scopeSummaryHtml([...scopeSet])}</div></div><form class="tipitaka-toolbar tipitaka-search-form" id="tipitaka-search-form"><input id="tipitaka-search-input" required placeholder="至少两个汉字，或输入巴利/英文词组"><select id="tipitaka-search-lang"><option value="zh">中文</option><option value="pali">巴利</option><option value="en">English</option></select><button>搜索</button></form><div id="tipitaka-search-status" class="tipitaka-note"></div><div id="tipitaka-search-results"></div>`;
    document.getElementById('tipitaka-scope-open').onclick = () => openV4ScopeDrawer({ scopes: [...scopeSet], types: [...selectedTypes], onApply: ({ scopes, types }) => { const params = new URLSearchParams(); const q = document.getElementById('tipitaka-search-input').value.trim(); if (q) params.set('q', q); if (scopes.length) params.set('scope', scopes.join('|')); if (types.length) params.set('types', types.join('|')); location.hash = `#/tipitaka/search?${params}`; } });
    const form = document.getElementById('tipitaka-search-form'), target = document.getElementById('tipitaka-search-results'), status = document.getElementById('tipitaka-search-status');
    const initialQuery = query().get('q'); if (initialQuery) document.getElementById('tipitaka-search-input').value = initialQuery;
    const draw = async (result, page) => { state.lastSearch = { result, page }; status.textContent = `完整命中 ${result.total.toLocaleString()} 处 · 第 ${page + 1} 页`; const items = await resolveSearchPage(result, page); target.innerHTML = `${items.map(item => searchResultHtml(item, result.language, result.query)).join('') || '<p>未找到结果。</p>'}<div class="tipitaka-page">${page > 0 ? '<button data-t-search-page="prev">← 上一页</button>' : ''}${(page + 1) * PAGE_SIZE < result.total ? '<button data-t-search-page="next">下一页 →</button>' : ''}<span class="tipitaka-note">每页加载 40 条；总数不截断。</span></div>`; target.querySelectorAll('[data-t-search-page]').forEach(button => button.onclick = () => draw(result, page + (button.dataset.tSearchPage === 'next' ? 1 : -1))); };
    form.onsubmit = async event => { event.preventDefault(); const value = document.getElementById('tipitaka-search-input').value.trim(), language = document.getElementById('tipitaka-search-lang').value, types = [...selectedTypes], scopes = [...scopeSet]; status.textContent = '检索分片中…'; target.textContent = ''; try { await draw(await runSearch(value, language, { workIds: v4ScopeWorkIds(), types }), 0); if (HYBRID_SEARCH_BASE) { status.textContent += ' · 正在补充语义结果…'; try { const hybrid = await runHybridSearch(value, language, scopes, types); target.insertAdjacentHTML('beforeend', hybridSearchHtml(hybrid, language, value)); status.textContent = `${status.textContent} 完成`; } catch (error) { status.textContent += `（语义服务降级：${error.message}）`; } } } catch (error) { status.textContent = error.message; } };
    if (initialQuery) form.requestSubmit();
  }

  async function ensureDictionaryManifest() { if (!state.dictManifest) state.dictManifest = await cachedJson('dictionary-search-v1/manifest.json', SEARCH_CACHE_NAME); return state.dictManifest; }
  async function dictShard(language, bucket) { return cachedJson(`dictionary-search-v1/${language}/shard_${bucket}.json.gz`, SEARCH_CACHE_NAME); }
  function dictionaryTerms(value, language) { if (language === 'zh') { const compact = value.replace(/\s/g, ''); if (!/[\u3400-\u9fff]/.test(compact) || compact.length < 2) return []; return [...new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, i) => compact.slice(i, i + 2)))]; } return [...value.matchAll(dictWords)].map(m => language === 'pali' ? normalizePali(m[0]) : m[0].toLowerCase()).filter(Boolean); }
  async function dictionarySearch(value, language, source = '') {
    const result = await runSearch(value, language, { types: ['dictionary'], dictionaryTables: source ? [source] : null });
    return { total: result.total, result, rows: null, query: value, language, v4: true };
  }
  function dictionaryEntryHtml(item, result) { const text = dictionaryText(item.row.dict_content || ''); return `<article class="tipitaka-dict-entry" id="tipitaka-dict-${esc(item.locator || item.row.id)}"><h4>${esc(item.row.dict_key)} <span class="tipitaka-note">${esc(item.dictionary.table)} · ${esc(item.dictionary.description)}</span></h4><div>${highlightHtml(text, result.query, result.language === 'pali' ? 'pali' : result.language, true)}</div></article>`; }
  async function showDictionary(value) {
    const selected = String(value || '').trim(), word = normalizePali((selected.match(/[A-Za-zĀĪŪṂṀṄÑṬḌṆḶāīūṃṁṅñṭḌṇḶ]+/i) || [''])[0]); if (!word) return;
    try {
      const result = await dictionarySearch(selected.includes(' ') ? selected : word, 'pali');
      const prefs = dictionaryPreferences(), rank = new Map(prefs.order.map((table, index) => [table, index]));
      const items = (result.v4 ? await resolveSearchPage(result.result, 0) : result.rows.slice(0, PAGE_SIZE)).filter(item => !prefs.disabled.has(item.dictionary.table)).sort((a, b) => (rank.get(a.dictionary.table) ?? 9999) - (rank.get(b.dictionary.table) ?? 9999));
      const panel = document.createElement('dialog'); panel.innerHTML = `<button style="float:right">×</button><h3>${esc(selected)} · 词典</h3>${items.map(item => dictionaryEntryHtml(item, { query: selected, language: 'pali' })).join('') || '<p>未找到词条。</p>'}<p class="tipitaka-note">${result.total.toLocaleString()} 条匹配；打开词典页可分页查看全部。</p><button data-dict-all>查看全部结果</button>`;
      panel.querySelector('button').onclick = () => panel.close(); panel.querySelector('[data-dict-all]').onclick = () => { panel.close(); location.hash = `#/tipitaka/dictionaries?term=${encodeURIComponent(selected)}`; };
      document.body.appendChild(panel); panel.showModal(); panel.addEventListener('close', () => panel.remove());
    } catch (error) { alert(error.message); }
  }
  async function configureDictionaries() {
    const prefs = dictionaryPreferences(), panel = document.createElement('dialog');
    const rows = orderedDictionaries().map(item => `<li data-dict-pref="${esc(item.table)}"><label><input type="checkbox" data-dict-enabled="${esc(item.table)}" ${prefs.disabled.has(item.table) ? '' : 'checked'}> ${esc(item.table)} · ${esc(item.description)}</label><button type="button" data-dict-up>↑</button><button type="button" data-dict-down>↓</button></li>`).join('');
    panel.innerHTML = `<h3>词典优先级与启用状态</h3><p class="tipitaka-note">点击巴利词时，启用的词典按此顺序展示。</p><ol>${rows}</ol><button type="button" data-dict-save>保存</button><button type="button" data-dict-cancel>取消</button>`;
    panel.querySelectorAll('[data-dict-up],[data-dict-down]').forEach(button => button.onclick = () => { const li = button.closest('li'), other = button.hasAttribute('data-dict-up') ? li.previousElementSibling : li.nextElementSibling; if (other) button.hasAttribute('data-dict-up') ? li.parentNode.insertBefore(li, other) : li.parentNode.insertBefore(other, li); });
    panel.querySelector('[data-dict-cancel]').onclick = () => panel.close();
    panel.querySelector('[data-dict-save]').onclick = () => { const order = [...panel.querySelectorAll('li[data-dict-pref]')].map(li => li.dataset.dictPref), disabled = new Set([...panel.querySelectorAll('[data-dict-enabled]:not(:checked)')].map(input => input.dataset.dictEnabled)); saveDictionaryPreferences({ order, disabled }); panel.close(); };
    document.body.appendChild(panel); panel.showModal(); panel.addEventListener('close', () => panel.remove());
  }
  async function renderDictionaries() {
    injectCss(); await ensureCatalog(); const sources = orderedDictionaries().map(item => `<option value="${esc(item.table)}">${esc(item.table)} · ${esc(item.description)}</option>`).join('');
    app.innerHTML = `<button class="back-btn" onclick="location.hash='#/tipitaka'">← 三藏目录</button><div class="cat-header"><h2>巴利词典与专名</h2><div class="cat-en">26 dictionaries · 2,436,672 entries · 634 proper nouns</div></div><form class="tipitaka-toolbar" id="tipitaka-dict-form"><input id="tipitaka-dict-input" required placeholder="巴利词、中文释义或英文释义"><select id="tipitaka-dict-lang"><option value="pali">巴利词头</option><option value="zh">中文释义</option><option value="en">English gloss</option></select><select id="tipitaka-dict-source"><option value="">全部词典</option>${sources}</select><button>查词</button><button type="button" id="tipitaka-proper">专名表</button><button type="button" id="tipitaka-dict-settings">词典设置</button></form><div id="tipitaka-dict-status" class="tipitaka-note"></div><div id="tipitaka-dict-results"></div>`;
    const form = document.getElementById('tipitaka-dict-form'), target = document.getElementById('tipitaka-dict-results'), status = document.getElementById('tipitaka-dict-status');
    document.getElementById('tipitaka-dict-settings').onclick = configureDictionaries;
    form.onsubmit = async event => {
      event.preventDefault(); const value = document.getElementById('tipitaka-dict-input').value.trim(), language = document.getElementById('tipitaka-dict-lang').value, source = document.getElementById('tipitaka-dict-source').value; status.textContent = '加载词典索引与原始分片…';
      try {
        const result = await dictionarySearch(value, language, source);
        const draw = async page => { const start = page * PAGE_SIZE, items = result.v4 ? await resolveSearchPage(result.result, page) : result.rows.slice(start, start + PAGE_SIZE); status.textContent = `完整命中 ${result.total.toLocaleString()} 条；第 ${page + 1} 页（每页 ${PAGE_SIZE} 条），按词典来源稳定排序。`; target.innerHTML = items.map(item => dictionaryEntryHtml(item, result)).join('') || '<p>未找到词条。</p>'; target.insertAdjacentHTML('beforeend', `<div class="tipitaka-page">${page > 0 ? '<button data-t-dict-prev>上一页</button>' : ''}${start + PAGE_SIZE < result.total ? '<button data-t-dict-next>下一页</button>' : ''}</div>`); const entry = query().get('entry'); if (entry && page === 0) [...target.querySelectorAll('.tipitaka-dict-entry')].find(item => item.id === `tipitaka-dict-${entry}`)?.scrollIntoView({ block: 'center' }); target.querySelector('[data-t-dict-prev]')?.addEventListener('click', () => draw(page - 1)); target.querySelector('[data-t-dict-next]')?.addEventListener('click', () => draw(page + 1)); };
        await draw(0);
      } catch (error) { status.textContent = error.message; }
    };
    const deepTerm = query().get('term'), deepLang = query().get('lang'), deepSource = query().get('dict'); if (deepLang && ['pali', 'zh', 'en'].includes(deepLang)) document.getElementById('tipitaka-dict-lang').value = deepLang; if (deepSource && [...document.getElementById('tipitaka-dict-source').options].some(option => option.value === deepSource)) document.getElementById('tipitaka-dict-source').value = deepSource; if (deepTerm) { document.getElementById('tipitaka-dict-input').value = deepTerm; form.requestSubmit(); }
    document.getElementById('tipitaka-proper').onclick = async () => { const [items, userEntries] = await Promise.all([cachedJson('terminology/proper-nouns.json'), cachedJson('terminology/user-dictionary.json')]); target.innerHTML = `${userEntries.length ? `<h3>发行包用户词典</h3>${userEntries.map(entry => `<p><strong>${esc(entry.dict_key)}</strong> — ${esc(dictionaryChineseDisplay(entry.dict_content))}</p>`).join('')}` : ''}<p class="tipitaka-note">${items.length} 条专名；修改会进入与清净道论、经藏注疏共用的 canon 历史。</p>${items.map((item, i) => `<p class="tipitaka-dict-entry" data-proper-pali="${esc(item.pali)}"><strong>${esc(item.pali)}</strong> — ${esc(dictionaryChineseDisplay(item.preferred_chinese || ''))} <button data-t-term="${i}">编辑术语</button><br><span class="tipitaka-note">${esc(dictionaryChineseDisplay(item.chinese_comment || item.english || ''))}</span></p>`).join('')}`; const term = query().get('term'); if (term) [...target.querySelectorAll('[data-proper-pali]')].find(node => node.dataset.properPali === term)?.scrollIntoView({ block: 'center' }); target.onclick = event => { const button = event.target.closest('[data-t-term]'); if (button) editTerm(items[Number(button.dataset.tTerm)]); }; };
    if (query().get('tab') === 'proper') document.getElementById('tipitaka-proper').click();
  }
  async function editTerm(item) { const translation = prompt(`编辑 ${item.pali} 的共享术语译法`, item.preferred_chinese || ''); if (translation === null) return; const reason = prompt('修改理由（公开可见）', '') ?? ''; const response = await fetch(`${API}/terms/${encodeURIComponent(item.pali)}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ translation, default_translation: item.preferred_chinese || translation, usage_note: item.chinese_comment || '', reason }) }); if (!response.ok) { alert((await response.json().catch(() => ({}))).detail || '保存失败，请先登录'); return; } alert('术语已保存。'); }
  async function renderHome() {
    injectCss(); injectSearchTargetCss(); await ensureCatalog();
    app.innerHTML = `<button class="back-btn" onclick="location.hash='#/'">← 返回首页</button><div class="cat-header"><h2>📚 巴利三藏阅读器 V4</h2><div class="cat-en">Tipiṭaka · Aṭṭhakathā · Ṭīkā · Añña — Pāli · 中文 · English</div></div><div class="tipitaka-toolbar"><button data-t-home="search">全文检索</button><button data-t-home="dict">词典与专名</button><button data-t-home="continue">继续阅读</button></div><div class="tipitaka-layout"><aside><div class="tipitaka-catalog-search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg><input class="tipitaka-catalog-search" id="tipitaka-catalog-filter" placeholder="筛选目录或作品" aria-label="筛选目录或作品"><button type="button" class="tipitaka-catalog-search-clear" id="tipitaka-catalog-filter-clear" aria-label="清除目录筛选" hidden>×</button></div><p class="tipitaka-catalog-help">目录默认收起；展开后可逐级浏览。</p><div class="tipitaka-catalog">${workTree(state.works, query().get('open') || '')}</div></aside><section><p>完整收录三藏、义注、复注与藏外典籍；正文、词典和目录均按需读取与本地缓存。</p><p class="tipitaka-note">缅文词典可查；该发行包未提供可验证的缅文/Nissaya 正文列，因此不显示虚假的阅读栏。</p></section></div>`;
    const filter = document.getElementById('tipitaka-catalog-filter');
    const clearFilter = document.getElementById('tipitaka-catalog-filter-clear');
    filter.oninput = event => { const needle = event.target.value.trim().toLowerCase(); const catalog = app.querySelector('.tipitaka-catalog'); clearFilter.hidden = !needle; catalog.querySelectorAll('.tipitaka-work-link').forEach(link => { link.hidden = !!needle && !link.dataset.catalogLabel.toLowerCase().includes(needle); }); catalog.querySelectorAll('.tipitaka-catalog-node').forEach(node => { const hasVisible = [...node.querySelectorAll('.tipitaka-work-link')].some(link => !link.hidden), matchesPath = node.dataset.catalogPath.toLowerCase().includes(needle); node.hidden = !!needle && !hasVisible && !matchesPath; node.open = !!needle && (hasVisible || matchesPath); }); };
    clearFilter.onclick = () => { filter.value = ''; filter.dispatchEvent(new Event('input', { bubbles: true })); filter.focus(); };
    app.querySelector('[data-t-home="search"]').onclick = () => location.hash = '#/tipitaka/search';
    app.querySelector('[data-t-home="dict"]').onclick = () => location.hash = '#/tipitaka/dictionaries';
    app.querySelector('[data-t-home="continue"]').onclick = () => { try { const history = JSON.parse(localStorage.getItem('tipitaka-reader-history') || 'null'); location.hash = history ? `#/tipitaka/read/${encodeURIComponent(history.workId)}?row=${history.rowId}` : '#/tipitaka'; } catch { location.hash = '#/tipitaka'; } };
  }
  window.renderTipitakaRoute = () => { const path = routePath(); if (path === '#/tipitaka') return renderHome(); if (path === '#/tipitaka/search') return renderSearch(); if (path === '#/tipitaka/dictionaries') return renderDictionaries(); if (path.startsWith('#/tipitaka/read/')) return renderReader(decodeURIComponent(path.slice('#/tipitaka/read/'.length))); renderHome(); };
  if (location.hash.startsWith('#/tipitaka') && typeof route === 'function') route();
})();
