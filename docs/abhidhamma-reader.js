/* 《摄阿毗达摩义论表解》 static reader and site-search adapter. */
const ABHIDHAMMA_BASE = 'research/abhidhamma-sangaha/';
let _abhidhammaManifest = null;
const _abhidhammaSections = new Map();

function abhidhammaEscape(value) {
  const text = String(value ?? '');
  if (typeof esc === 'function') return esc(text);
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function abhidhammaSimple(value) {
  return typeof toSimplified === 'function' ? toSimplified(String(value || '')) : String(value || '');
}

async function loadAbhidhammaManifest() {
  if (_abhidhammaManifest) return _abhidhammaManifest;
  const response = await fetch(`${ABHIDHAMMA_BASE}manifest.json`);
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  _abhidhammaManifest = await response.json();
  return _abhidhammaManifest;
}

async function loadAbhidhammaSearchDocs() {
  const manifest = await loadAbhidhammaManifest();
  return Array.isArray(manifest.search_documents) ? manifest.search_documents : [];
}

async function loadAbhidhammaSection(slug) {
  if (_abhidhammaSections.has(slug)) return _abhidhammaSections.get(slug);
  const manifest = await loadAbhidhammaManifest();
  const section = (manifest.sections || []).find(item => item.slug === slug);
  if (!section) throw new Error('找不到该章节');
  const response = await fetch(`${ABHIDHAMMA_BASE}${section.file}`);
  if (!response.ok) throw new Error(`section HTTP ${response.status}`);
  const payload = await response.json();
  _abhidhammaSections.set(slug, payload);
  return payload;
}

function abhidhammaSourcePdf(page) {
  return `${ABHIDHAMMA_BASE}${_abhidhammaManifest.source_pdf}#page=${Number(page) || 1}`;
}

function abhidhammaHighlightHtml(text, term) {
  const value = String(text || '');
  const query = String(term || '').trim();
  if (!query) return abhidhammaEscape(value);
  const candidates = [...new Set([query, abhidhammaSimple(query)].filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  let at = -1, matched = '';
  for (const candidate of candidates) {
    const index = value.indexOf(candidate);
    if (index !== -1 && (at === -1 || index < at)) { at = index; matched = candidate; }
  }
  if (at === -1) return abhidhammaEscape(value);
  return `${abhidhammaEscape(value.slice(0, at))}<mark>${abhidhammaEscape(matched)}</mark>${abhidhammaEscape(value.slice(at + matched.length))}`;
}

function abhidhammaTextHtml(text, complex, term) {
  const value = String(text || '').trim();
  if (!value) return '<p class="abhi-empty-text">本页以图表为主，文字层为空；请使用下方原页视图。</p>';
  if (complex) return `<pre class="abhi-page-text">${abhidhammaHighlightHtml(value, term)}</pre>`;
  return value.split(/\n{2,}/).filter(Boolean).map(block => {
    const lines = block.split('\n').filter(line => line.trim());
    return `<p>${lines.map(line => abhidhammaHighlightHtml(line, term)).join('<br>')}</p>`;
  }).join('');
}

function abhidhammaSectionNav(manifest, activeSlug) {
  return (manifest.sections || []).map(section => {
    const active = section.slug === activeSlug ? ' is-active' : '';
    return `<a class="abhi-toc-link${active}" href="#/research/abhidhamma-sangaha/read/${encodeURIComponent(section.slug)}">${abhidhammaEscape(section.title)}<small>第 ${section.physical_page_start}–${section.physical_page_end} 页</small></a>`;
  }).join('');
}

function abhidhammaHeader(manifest, activeSlug = '') {
  return `<section class="abhi-head">
    <div class="abhi-kicker">ABHIDHAMMATTHASAṄGAHA-VITTHĀRA · SIMPLIFIED EDITION</div>
    <h2>《摄阿毗达摩义论表解》</h2>
    <p>全书简体转换版。保留巴利语、英文、特殊符号、原书页码和复杂图表的原页校验视图。</p>
    <div class="abhi-stats">
      <span><strong>${Number(manifest.physical_pages || 0).toLocaleString()}</strong> 页</span>
      <span><strong>${Number(manifest.sections?.length || 0)}</strong> 个分片</span>
      <span><strong>${Number(manifest.complex_pages?.length || 0)}</strong> 页原页校验</span>
      <span>繁体 → 简体 · OpenCC t2s</span>
    </div>
    <div class="abhi-provenance">法雨；明法比丘编，罗庆龙修订 · 2022 年修订版 · <a href="${abhidhammaEscape(`${ABHIDHAMMA_BASE}${manifest.source_pdf}`)}" target="_blank" rel="noopener">打开原 PDF ↗</a></div>
  </section>`;
}

async function renderAbhidhammaHome() {
  app.innerHTML = '<div class="loading"><div class="spinner"></div><div>加载《摄阿毗达摩义论表解》目录…</div></div>';
  try {
    const manifest = await loadAbhidhammaManifest();
    const cards = (manifest.sections || []).map(section => {
      const chapterMatch = section.slug.match(/^chapter-(\d+)$/);
      const badge = chapterMatch ? `第 ${Number(chapterMatch[1])} 品` : ({ cover: '前置页', abbreviations: '前置页', content: '目录', preface: '序', appendix: '附录', answers: '解答', corrections: '更正', 'corrections-appendix': '更正', copyright: '版权' }[section.slug] || '书页');
      return `<a class="abhi-section-card" href="#/research/abhidhamma-sangaha/read/${encodeURIComponent(section.slug)}">
      <span class="abhi-section-number">${abhidhammaEscape(badge)}</span>
      <h3>${abhidhammaEscape(section.title)}</h3>
      <p>第 ${section.physical_page_start}–${section.physical_page_end} 页 · 按需加载</p>
    </a>`;
    }).join('');
    app.innerHTML = `<div class="abhi-page"><button class="back-btn" onclick="location.hash='#/research'">← 返回研究成果</button>
      ${abhidhammaHeader(manifest)}
      <div class="abhi-home-layout"><nav class="abhi-toc" aria-label="摄阿毗达摩义论表解目录">${abhidhammaSectionNav(manifest)}</nav><main>
        <section class="abhi-intro-card"><h3>阅读说明</h3><p>普通正文采用可搜索、可复制的简体 HTML；密集矩阵、箭头图、特殊字体表格和图像页面同时保留可缩放的原页视图。点击页码可以复制和分享精确位置。</p><p>全站搜索已收录本书 18 个内容分片，可直接从搜索结果跳转到具体页。</p><p><a class="community-primary-btn abhi-inline-button" href="#/search?q=心所&scope=site">搜索本书</a></p></section>
        <div class="abhi-section-grid">${cards}</div>
      </main></div></div>`;
  } catch (error) {
    app.innerHTML = `<div class="error-msg">目录加载失败：${abhidhammaEscape(error.message || error)}</div>`;
  }
}

function abhidhammaPageIndex(section, physicalPage) {
  const requested = Number(physicalPage);
  const pages = section.pages || [];
  if (Number.isFinite(requested)) {
    const exact = pages.findIndex(page => Number(page.physical_page) === requested);
    if (exact >= 0) return exact;
  }
  return 0;
}

function abhidhammaPageToolbar(manifest, section, index, page, term, view) {
  const previous = section.pages?.[index - 1];
  const next = section.pages?.[index + 1];
  const link = (target, label, disabled = false) => disabled
    ? `<span class="abhi-page-nav disabled">${label}</span>`
    : `<a class="abhi-page-nav" href="#/research/abhidhamma-sangaha/read/${encodeURIComponent(section.section.slug)}?page=${target.physical_page}${term ? `&hl=${encodeURIComponent(term)}&anc=${encodeURIComponent(target.text.slice(0, 40))}` : ''}">${label}</a>`;
  const sourceHref = abhidhammaSourcePdf(page.physical_page);
  const alternateView = view === 'source' ? '阅读文字' : '查看原页';
  const alternateHref = `#/research/abhidhamma-sangaha/read/${encodeURIComponent(section.section.slug)}?page=${page.physical_page}&view=${view === 'source' ? 'text' : 'source'}${term ? `&hl=${encodeURIComponent(term)}` : ''}`;
  return `<div class="abhi-toolbar">
    <div class="abhi-toolbar-group">${link(previous, '← 上一页', !previous)}<span class="abhi-page-count">第 ${page.physical_page} / ${manifest.physical_pages} 页</span>${link(next, '下一页 →', !next)}</div>
    <div class="abhi-toolbar-group"><a class="abhi-tool-link" href="${abhidhammaEscape(alternateHref)}">${alternateView}</a><a class="abhi-tool-link" href="${abhidhammaEscape(sourceHref)}" target="_blank" rel="noopener">PDF 原页 ↗</a></div>
  </div>`;
}

async function renderAbhidhammaReader(slug, physicalPage, view = 'text', term = '') {
  app.innerHTML = '<div class="loading"><div class="spinner"></div><div>加载本页…</div></div>';
  try {
    const manifest = await loadAbhidhammaManifest();
    const section = await loadAbhidhammaSection(decodeURIComponent(slug || manifest.sections?.[0]?.slug || 'cover'));
    const index = abhidhammaPageIndex(section, physicalPage);
    const page = section.pages[index];
    if (!page) throw new Error('该分片没有可显示的页');
    const sourceImage = page.source_image ? `<details class="abhi-source-view" ${view === 'source' ? 'open' : ''}><summary>原页校验视图 · 第 ${page.physical_page} 页</summary><figure><img src="${abhidhammaEscape(page.source_image)}" alt="《摄阿毗达摩义论表解》第 ${page.physical_page} 页原页" loading="lazy"><figcaption>原 PDF 第 ${page.physical_page} 页；可放大查看复杂表格、图示和特殊符号。</figcaption></figure></details>` : '';
    const logical = page.logical_label ? `<span class="abhi-logical-label">书内页码：${abhidhammaEscape(page.logical_label)}</span>` : '';
    app.innerHTML = `<div class="abhi-page"><button class="back-btn" onclick="location.hash='#/research/abhidhamma-sangaha'">← 返回本书目录</button>
      ${abhidhammaHeader(manifest, section.section.slug)}
      <div class="abhi-reader-layout"><nav class="abhi-toc" aria-label="摄阿毗达摩义论表解目录">${abhidhammaSectionNav(manifest, section.section.slug)}</nav><main>
        <article class="abhi-reader-card" id="abhi-page-${page.physical_page}">
          <div class="abhi-reader-meta"><span>${abhidhammaEscape(section.section.title)}</span>${logical}<span>PDF 第 ${page.physical_page} 页</span></div>
          <h3>${abhidhammaEscape(page.title || section.section.title)}</h3>
          ${abhidhammaPageToolbar(manifest, section, index, page, term, view)}
          <div class="abhi-content ${page.complex_layout ? 'is-complex' : ''}">${abhidhammaTextHtml(page.text, page.complex_layout, term)}</div>
          ${sourceImage}
        </article>
      </main></div></div>`;
    if (term) document.getElementById(`abhi-page-${page.physical_page}`)?.querySelector('mark')?.scrollIntoView({ block: 'center' });
  } catch (error) {
    app.innerHTML = `<div class="error-msg">页面加载失败：${abhidhammaEscape(error.message || error)}</div>`;
  }
}

// The existing site-search reader calls this parser when a JSON-backed search
// document has kind=abhidhamma.  One block per PDF page gives every result a
// stable page deep-link while retaining the full text for snippets.
function searchParseAbhidhamma(json) {
  return (json.pages || []).map(page => ({
    t: String(page.text || ''),
    h: [page.logical_label, page.title].filter(Boolean).join(' · '),
    _page: Number(page.physical_page),
  })).filter(block => block.t);
}
