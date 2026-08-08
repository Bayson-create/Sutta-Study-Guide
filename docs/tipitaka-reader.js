/* Tipiṭaka Reader V4 — static Blob corpus with sparse API overlays. */
(() => {
  'use strict';

  const DATA_BASE = window.TIPITAKA_DATA_BASE || 'https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/v1';
  const API = `${API_BASE}/api/tipitaka/v1`;
  const CACHE_NAME = 'tipitaka-reader-v1';
  const PAGE_ROWS = 160;
  const state = { works: null, jumps: null, dictionaries: null, search: null, workCache: new Map(), overrides: new Map(), settings: null, autoTimer: null };

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const strip = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const query = () => new URLSearchParams(location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '');
  const routePath = () => location.hash.split('?')[0];
  const url = path => `${DATA_BASE}/${path}`;
  const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...(typeof communityAuthHeaders === 'function' ? communityAuthHeaders() : {}) });

  function settings() {
    if (!state.settings) {
      try { state.settings = JSON.parse(localStorage.getItem('tipitaka-reader-settings') || '{}'); } catch { state.settings = {}; }
      state.settings = { pali: true, zh: true, en: true, font: 18, speed: 22, ...state.settings };
    }
    return state.settings;
  }
  function saveSettings() { localStorage.setItem('tipitaka-reader-settings', JSON.stringify(settings())); }
  async function cachedJson(path) {
    const request = new Request(url(path), { mode: 'cors' });
    try {
      const cache = await caches.open(CACHE_NAME);
      let response = await cache.match(request);
      if (!response) {
        response = await fetch(request);
        if (!response.ok) throw new Error(`${path} 加载失败（${response.status}）`);
        await cache.put(request, response.clone());
      }
      return response.json();
    } catch (error) {
      throw new Error(`无法读取巴利三藏数据：${error.message}`);
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
    if (!state.workCache.has(id)) state.workCache.set(id, cachedJson(meta.data_file));
    return [meta, await state.workCache.get(id)];
  }
  async function overrides(workId) {
    if (!state.overrides.has(workId)) {
      const data = await fetch(`${API}/works/${encodeURIComponent(workId)}/overrides`).then(r => r.ok ? r.json() : { units: [] }).catch(() => ({ units: [] }));
      state.overrides.set(workId, new Map(data.units.map(unit => [`${unit.row_id}:${unit.language}`, unit])));
    }
    return state.overrides.get(workId);
  }
  const displayed = (row, overlays, lang) => {
    const key = `${row.id}:${lang}`;
    if (overlays.get(key)) return overlays.get(key).current_text;
    return lang === 'zh' ? (row.chinese_simplified || row.chinese_raw || '') : (row.english_translation || '');
  };
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
      .tipitaka-layout{display:grid;grid-template-columns:minmax(230px,28%) 1fr;gap:18px}.tipitaka-catalog{max-height:68vh;overflow:auto;padding:12px;background:var(--card,#fff);border:1px solid var(--border,#ddd);border-radius:10px}.tipitaka-catalog details{margin:7px 0}.tipitaka-work-link{display:block;padding:5px 8px;color:var(--primary,#6b4f2d);text-decoration:none}.tipitaka-work-link small{color:var(--text-light,#777)}.tipitaka-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.tipitaka-toolbar button,.tipitaka-toolbar input{padding:7px 10px;border:1px solid var(--border,#ccc);border-radius:7px;background:var(--card,#fff);color:inherit}.tipitaka-row{border-bottom:1px solid var(--border,#e5e5e5);padding:10px 0;line-height:1.65}.tipitaka-row[data-rend="gatha"]{margin-left:2em;font-style:italic}.tipitaka-row[data-rend="nikaya"],.tipitaka-row[data-rend="book"],.tipitaka-row[data-rend="subsubhead"]{font-weight:700}.tipitaka-num{display:inline-block;min-width:5.2em;color:var(--text-light,#777);font-size:.8em}.tipitaka-pali{cursor:pointer;color:var(--primary,#6b4f2d)}.tipitaka-zh{color:var(--text,#222)}.tipitaka-en{color:var(--text-light,#666)}.tipitaka-actions{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}.tipitaka-actions button{font-size:.8em}.tipitaka-search-result{display:block;padding:10px;border-bottom:1px solid var(--border,#ddd);color:inherit;text-decoration:none}.tipitaka-pane{max-height:72vh;overflow:auto;padding:0 12px}.tipitaka-note{color:var(--text-light,#777);font-size:.9em}@media(max-width:760px){.tipitaka-layout{grid-template-columns:1fr}.tipitaka-catalog{max-height:38vh}.tipitaka-num{min-width:3.8em}}`; document.head.appendChild(style);
  }
  function readerToolbar(meta, row) {
    const s = settings();
    return `<div class="tipitaka-toolbar"><button data-t-action="back">← 目录</button><strong>${esc(meta.title)}</strong><label><input type="checkbox" data-t-toggle="pali" ${s.pali ? 'checked' : ''}> 巴利</label><label><input type="checkbox" data-t-toggle="zh" ${s.zh ? 'checked' : ''}> 中文</label><label><input type="checkbox" data-t-toggle="en" ${s.en ? 'checked' : ''}> English</label><button data-t-action="font-down">A−</button><button data-t-action="font-up">A+</button><button data-t-action="auto">自动滚动</button><button data-t-action="bookmark">☆ 收藏此处</button>${row?.paranum ? `<span class="tipitaka-note">段号 ${esc(row.paranum)}</span>` : ''}</div>`;
  }
  function rowHtml(row, overlays) {
    const s = settings(), parts = [];
    if (s.pali && row.pali_text) parts.push(`<div class="tipitaka-pali" data-t-pali="${esc(strip(row.pali_text))}">${esc(strip(row.pali_text))}</div>`);
    if (s.zh && displayed(row, overlays, 'zh')) parts.push(`<div class="tipitaka-zh">${esc(displayed(row, overlays, 'zh'))}</div>`);
    if (s.en && displayed(row, overlays, 'en')) parts.push(`<div class="tipitaka-en">${esc(displayed(row, overlays, 'en'))}</div>`);
    return `<article class="tipitaka-row" data-t-row="${row.id}" data-rend="${esc(row.rend || '')}"><span class="tipitaka-num">${esc(row.paranum || row.id)}</span>${parts.join('')}<div class="tipitaka-actions"><button data-t-action="edit-zh" data-row="${row.id}">编辑中译</button><button data-t-action="draft-zh" data-row="${row.id}">Dharmamitra 草稿</button><button data-t-action="edit-en" data-row="${row.id}">编辑英译</button><button data-t-action="history" data-row="${row.id}">历史</button></div></article>`;
  }
  async function renderReader(workId) {
    injectCss(); app.innerHTML = '<div class="loading"><div class="spinner"></div><div>按需加载三语经文…</div></div>';
    try {
      const [meta, work] = await workById(workId), overlays = await overrides(workId);
      const anchor = Number(query().get('row') || 0), at = Math.max(0, work.rows.findIndex(row => row.id === anchor));
      const page = Number(query().get('page') || Math.floor(at / PAGE_ROWS));
      const start = Math.max(0, page * PAGE_ROWS), rows = work.rows.slice(start, start + PAGE_ROWS);
      const current = work.rows[at] || rows[0];
      app.innerHTML = `${readerToolbar(meta, current)}<div class="tipitaka-note">第 ${page + 1} / ${Math.ceil(work.rows.length / PAGE_ROWS)} 段，采用渐进窗口渲染以保持长篇作品流畅。</div><div class="tipitaka-pane" id="tipitaka-pane" style="font-size:${settings().font}px">${rows.map(row => rowHtml(row, overlays)).join('')}</div><div class="tipitaka-toolbar">${page > 0 ? `<button data-t-page="${page - 1}">← 上一段</button>` : ''}${start + PAGE_ROWS < work.rows.length ? `<button data-t-page="${page + 1}">下一段 →</button>` : ''}${jumpButtons(current)}</div>`;
      bindReader(meta, work, current, rows);
      const anchorEl = document.querySelector(`[data-t-row="${current.id}"]`); if (anchorEl && anchor) anchorEl.scrollIntoView({ block: 'center' });
      localStorage.setItem('tipitaka-reader-history', JSON.stringify({ workId, rowId: current.id, at: Date.now() }));
      syncProgress(workId, current.id);
    } catch (error) { app.innerHTML = `<div class="error-msg">${esc(error.message)}。数据尚未发布时，请先运行归档发布脚本。</div>`; }
  }
  function jumpButtons(row) {
    if (!row?.paranum || !state.jumps) return '';
    const p = Number(String(row.paranum).match(/\d+/)?.[0]); if (!p) return '';
    const jump = state.jumps.find(entry => { const m = String(entry.para_range || '').match(/(\d+)(?:-(\d+))?/); return m && p >= +m[1] && p <= +(m[2] || m[1]); });
    if (!jump) return '';
    return ['Mūla', 'Aṭṭhakathā', 'Ṭīkā'].filter(key => jump[key]).map(key => `<a href="#/tipitaka/read/${encodeURIComponent(jump[key])}?row=${p}">跳至${key}</a>`).join('　');
  }
  function bindReader(meta, work, current, rows) {
    app.onclick = async event => {
      const button = event.target.closest('button,[data-t-page]'); if (!button) return;
      if (button.dataset.tPage !== undefined) { location.hash = `#/tipitaka/read/${encodeURIComponent(meta.id)}?page=${button.dataset.tPage}`; return; }
      const action = button.dataset.tAction;
      if (action === 'back') { location.hash = '#/tipitaka'; return; }
      if (action === 'font-up' || action === 'font-down') { settings().font = Math.max(13, Math.min(30, settings().font + (action === 'font-up' ? 1 : -1))); saveSettings(); renderReader(meta.id); return; }
      if (action === 'auto') { toggleAutoScroll(); return; }
      if (action === 'bookmark') { await saveBookmark(meta, current); return; }
      const row = work.rows.find(item => item.id === Number(button.dataset.row));
      if (!row) return;
      if (action === 'edit-zh' || action === 'edit-en') await editTranslation(meta, row, action === 'edit-zh' ? 'zh' : 'en');
      if (action === 'draft-zh') await draftTranslation(meta, row);
      if (action === 'history') await showHistory(meta.id, row.id);
    };
    app.onchange = event => { const toggle = event.target.dataset.tToggle; if (toggle) { settings()[toggle] = event.target.checked; saveSettings(); renderReader(meta.id); } };
    app.querySelectorAll('.tipitaka-pali').forEach(el => el.onclick = () => showDictionary(window.getSelection()?.toString().trim() || el.dataset.tPali));
  }
  function toggleAutoScroll() { const pane = document.getElementById('tipitaka-pane'); if (!pane) return; if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; return; } state.autoTimer = setInterval(() => pane.scrollTop += settings().speed / 10, 50); }
  async function saveBookmark(meta, row) { try { const result = await fetch(`${API}/bookmarks`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ work_id: meta.id, row_id: row.id, label: `${meta.title} · ${row.paranum || row.id}` }) }); if (!result.ok) throw new Error('请先登录后收藏'); alert('已收藏'); } catch (e) { alert(e.message); } }
  async function syncProgress(workId, rowId) { try { await fetch(`${API}/progress`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ work_id: workId, row_id: rowId }) }); } catch {} }
  async function editTranslation(meta, row, language) { const base = language === 'zh' ? (row.chinese_simplified || row.chinese_raw || '') : (row.english_translation || ''); const text = prompt(`编辑${language === 'zh' ? '中文' : '英文'}译文`, base); if (text === null) return; const reason = prompt('修改理由（将记入公开历史）', '') ?? ''; const response = await fetch(`${API}/works/${encodeURIComponent(meta.id)}/rows/${row.id}/${language}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text, default_text: base, reason, source: 'human' }) }); if (!response.ok) { alert((await response.json().catch(() => ({}))).detail || '保存失败，请先登录'); return; } state.overrides.delete(meta.id); renderReader(meta.id); }
  async function draftTranslation(meta, row) { if (!row.pali_text || typeof mitraTranslate !== 'function') { alert('该行没有巴利原文，或翻译服务尚不可用。'); return; } try { const draft = await mitraTranslate(strip(row.pali_text), `Tipiṭaka Reader V4 · ${meta.title}`); if (!confirm(`Dharmamitra 草稿：\n\n${draft}\n\n确认写入公开修订历史？`)) return; const base = row.chinese_simplified || row.chinese_raw || ''; const response = await fetch(`${API}/works/${encodeURIComponent(meta.id)}/rows/${row.id}/zh`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text: draft, default_text: base, reason: 'Dharmamitra 草稿经人工确认', source: 'dharmamitra' }) }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || '保存失败'); state.overrides.delete(meta.id); renderReader(meta.id); } catch (error) { alert(error.message); } }
  async function showHistory(workId, rowId) { const language = prompt('查看哪个语种历史？输入 zh 或 en', 'zh'); if (!language) return; const rows = await fetch(`${API}/works/${encodeURIComponent(workId)}/rows/${rowId}/${language}/history`).then(r => r.ok ? r.json() : []); if (!rows.length) { alert('尚无历史记录'); return; } const list = rows.map((item, index) => `${index + 1}. ${new Date(item.created_at).toLocaleString()}\n${item.text}\n理由：${item.reason || '—'}`).join('\n\n'); const choice = prompt(`${list}\n\n输入版本编号即可恢复；取消仅查看。`, ''); if (!choice) return; const revision = rows[Number(choice) - 1]; if (!revision) { alert('无效版本编号'); return; } if (!confirm(`恢复为版本 ${choice}？这会新增一条可追溯的修订。`)) return; const saved = await fetch(`${API}/works/${encodeURIComponent(workId)}/rows/${rowId}/${language}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ text: revision.text, default_text: '', reason: `从历史版本 ${choice} 恢复`, source: 'restore' }) }); if (!saved.ok) { alert((await saved.json().catch(() => ({}))).detail || '恢复失败，请先登录'); return; } state.overrides.delete(workId); renderReader(workId); }
  async function hashBucket(key) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)); return new DataView(bytes).getUint32(0) % 256; }
  function normalizePali(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  async function ensureSearch() { if (!state.search) state.search = await cachedJson('search/manifest.json'); return state.search; }
  async function searchCorpus(value, language) {
    const manifest = await ensureSearch(); const q = language === 'pali' ? normalizePali(value) : language === 'en' ? value.toLowerCase() : value.replace(/\s/g, '');
    const keys = language === 'zh' ? [...new Set(Array.from({ length: Math.max(0, q.length - 1) }, (_, i) => q.slice(i, i + 2)))] : [q];
    if (!keys.length) return [];
    let candidates = null;
    for (const key of keys) { const n = await hashBucket(key); const shard = await cachedJson(`search/${language}/shard_${String(n).padStart(3, '0')}.json.gz`); const values = new Set(shard[key] || []); candidates = candidates === null ? values : new Set([...candidates].filter(v => values.has(v))); if (!candidates.size) break; }
    const found = [];
    for (const locator of [...(candidates || [])].slice(0, 100)) { const workNo = locator >>> 20, rowId = locator & ((1 << 20) - 1), workId = manifest.work_ids[workNo]; if (!workId) continue; const [meta, work] = await workById(workId); const row = work.rows.find(item => item.id === rowId); if (!row) continue; const text = language === 'zh' ? (row.chinese_simplified || row.chinese_raw || '') : language === 'en' ? (row.english_translation || '') : strip(row.pali_text); if (text.toLowerCase().includes(value.toLowerCase())) found.push({ meta, row, text }); if (found.length >= 40) break; }
    return found;
  }
  async function renderSearch() { injectCss(); app.innerHTML = `<button class="back-btn" onclick="location.hash='#/tipitaka'">← 三藏目录</button><div class="cat-header"><h2>全文检索</h2><div class="cat-en">Pāli · 简体中文 · English</div></div><form class="tipitaka-toolbar" id="tipitaka-search-form"><input id="tipitaka-search-input" required placeholder="输入检索词"><select id="tipitaka-search-lang"><option value="zh">中文</option><option value="pali">巴利</option><option value="en">English</option></select><button>搜索</button></form><div id="tipitaka-search-results"></div>`; document.getElementById('tipitaka-search-form').onsubmit = async event => { event.preventDefault(); const text = document.getElementById('tipitaka-search-input').value.trim(), language = document.getElementById('tipitaka-search-lang').value, target = document.getElementById('tipitaka-search-results'); target.textContent = '检索分片中…'; try { const results = await searchCorpus(text, language); target.innerHTML = results.length ? results.map(result => `<a class="tipitaka-search-result" href="#/tipitaka/read/${encodeURIComponent(result.meta.id)}?row=${result.row.id}"><strong>${esc(result.meta.title)}</strong> · ${esc(result.row.paranum || result.row.id)}<br>${esc(result.text.slice(0, 220))}</a>`).join('') : '未找到结果。'; } catch (e) { target.innerHTML = `<div class="error-msg">${esc(e.message)}。搜索索引尚未发布时，目录阅读仍可使用。</div>`; } }; }
  async function showDictionary(value) { injectCss(); const word = normalizePali((value.match(/[A-Za-zĀĪŪṂṀṄÑṬḌṆḶāīūṃṁṅñṭḍṇḷ]+/) || [''])[0]); if (!word) return; await ensureCatalog(); const hits = []; for (const dictionary of state.dictionaries.slice(0, 26)) { const shard = [...dictionary.shards].sort((a, b) => b.prefix.length - a.prefix.length).find(item => word.startsWith(item.prefix)); if (!shard) continue; try { const data = await cachedJson(shard.file); for (const row of data.rows.filter(item => normalizePali(item.dict_key || '').startsWith(word)).slice(0, 5)) hits.push(`<p><strong>${esc(row.dict_key)}</strong><br>${esc(row.dict_content)}</p>`); } catch {} } const panel = document.createElement('dialog'); panel.innerHTML = `<button style="float:right">×</button><h3>${esc(word)} · 词典</h3>${hits.join('') || '<p>未找到词条。</p>'}`; panel.querySelector('button').onclick = () => panel.close(); document.body.appendChild(panel); panel.showModal(); panel.addEventListener('close', () => panel.remove()); }
  async function renderDictionaries() { injectCss(); await ensureCatalog(); app.innerHTML = `<button class="back-btn" onclick="location.hash='#/tipitaka'">← 三藏目录</button><div class="cat-header"><h2>巴利词典与专名</h2><div class="cat-en">26 dictionaries · 634 proper nouns</div></div><form class="tipitaka-toolbar" id="tipitaka-dict-form"><input id="tipitaka-dict-input" required placeholder="输入巴利词"><button>查词</button><button type="button" id="tipitaka-proper">专名表</button></form><div id="tipitaka-dict-results"></div>`; document.getElementById('tipitaka-dict-form').onsubmit = async event => { event.preventDefault(); await showDictionary(document.getElementById('tipitaka-dict-input').value); }; document.getElementById('tipitaka-proper').onclick = async () => { const [items, userEntries] = await Promise.all([cachedJson('terminology/proper-nouns.json'), cachedJson('terminology/user-dictionary.json')]); const target = document.getElementById('tipitaka-dict-results'); target.innerHTML = `<div class="tipitaka-note">${items.length} 条专名；选择“编辑术语”可写入与清净道论、经藏注疏共用的 canon 术语历史。</div>${userEntries.length ? `<h3>发行包用户词典</h3>${userEntries.map(entry => `<p><strong>${esc(entry.dict_key)}</strong> — ${esc(entry.dict_content)}</p>`).join('')}` : ''}${items.slice(0, 200).map((item, i) => `<p><strong>${esc(item.pali)}</strong> — ${esc(item.preferred_chinese)} <button data-t-term="${i}">编辑术语</button><br><span class="tipitaka-note">${esc(item.chinese_comment || item.english || '')}</span></p>`).join('')}`; target.onclick = event => { const button = event.target.closest('[data-t-term]'); if (button) editTerm(items[Number(button.dataset.tTerm)]); }; }; }
  async function editTerm(item) { const translation = prompt(`编辑 ${item.pali} 的共享术语译法`, item.preferred_chinese || ''); if (translation === null) return; const reason = prompt('修改理由（公开可见）', '') ?? ''; const response = await fetch(`${API}/terms/${encodeURIComponent(item.pali)}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ translation, default_translation: item.preferred_chinese || translation, usage_note: item.chinese_comment || '', reason }) }); if (!response.ok) { alert((await response.json().catch(() => ({}))).detail || '保存失败，请先登录'); return; } const old = item.preferred_chinese || ''; if (old && old !== translation && confirm('是否扫描全文中可能仍含旧译的句子，并创建可审查的同步草稿？')) { const results = await searchCorpus(old, 'zh'); const selected = results.filter(result => confirm(`同步 ${result.meta.title} · ${result.row.paranum || result.row.id}？\n\n${result.text.slice(0, 180)}`)).map(result => ({ work_id: result.meta.id, row_id: result.row.id, language: 'zh', old_text: result.text, new_text: result.text.replaceAll(old, translation) })); if (selected.length) await fetch(`${API}/terms/${encodeURIComponent(item.pali)}/sync-apply`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ reason: `术语表统一：${item.pali} ${old} → ${translation}`, items: selected }) }); } alert('术语已保存。'); }
  async function renderHome() { injectCss(); app.innerHTML = `<button class="back-btn" onclick="location.hash='#/'">← 返回首页</button><div class="cat-header"><h2>📚 巴利三藏阅读器 V4</h2><div class="cat-en">Tipiṭaka · Aṭṭhakathā · Ṭīkā — Pāli · 中文 · English</div></div><div class="tipitaka-toolbar"><button data-t-home="search">全文检索</button><button data-t-home="dict">词典与专名</button><button data-t-home="continue">继续阅读</button></div><div class="tipitaka-layout"><aside class="tipitaka-catalog">${workTree(await ensureCatalog())}</aside><section><p>完整收录三藏、义注、复注与藏外典籍；正文、词典和目录均按需读取与本地缓存。</p><p class="tipitaka-note">缅文词典可查；该发行包未提供可验证的缅文/Nissaya 正文列，因此不显示虚假的阅读栏。</p></section></div>`; app.querySelector('[data-t-home="search"]').onclick = () => location.hash = '#/tipitaka/search'; app.querySelector('[data-t-home="dict"]').onclick = () => location.hash = '#/tipitaka/dictionaries'; app.querySelector('[data-t-home="continue"]').onclick = () => { try { const history = JSON.parse(localStorage.getItem('tipitaka-reader-history') || 'null'); location.hash = history ? `#/tipitaka/read/${encodeURIComponent(history.workId)}?row=${history.rowId}` : '#/tipitaka'; } catch { location.hash = '#/tipitaka'; } }; }
  window.renderTipitakaRoute = () => { const path = routePath(); if (path === '#/tipitaka') return renderHome(); if (path === '#/tipitaka/search') return renderSearch(); if (path === '#/tipitaka/dictionaries') return renderDictionaries(); if (path.startsWith('#/tipitaka/read/')) return renderReader(decodeURIComponent(path.slice('#/tipitaka/read/'.length))); renderHome(); };
  if (location.hash.startsWith('#/tipitaka') && typeof route === 'function') route();
})();
