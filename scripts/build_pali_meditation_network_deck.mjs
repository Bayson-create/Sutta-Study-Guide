#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const graph = JSON.parse(await readFile(resolve(root, 'docs/research/pali-meditation-node-network/meditation-knowledge-graph-v2.json'), 'utf8'));
const deckDir = resolve(root, 'docs/research/pali-meditation-lecture/network-deck');

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const safeId = value => String(value ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
const relationText = edge => `${nodeById.get(edge.from)?.title || edge.from} → ${nodeById.get(edge.to)?.title || edge.to}`;
const layerLabel = { root_sutta: '根本经', commentary: '义注', subcommentary: '复注', other: '藏外典籍' };

// These are visual-unit budgets, not source truncation limits. Concatenating
// all returned chunks always reconstructs the original source field exactly.
const MAIN_PREVIEW_BUDGET = { pali: 180, chinese_simplified: 90, english: 150 };
const CONTINUATION_BUDGET = { pali: 300, chinese_simplified: 140, english: 220 };
const APPENDIX_BUDGET = { pali: 270, chinese_simplified: 125, english: 210 };

const isCombining = char => /[\u0300-\u036f\u1ab0-\u1aff\u20d0-\u20ff\ufe20-\ufe2f]/u.test(char);
const isWide = char => /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char);
const charUnits = char => isCombining(char) ? 0 : (isWide(char) ? 2 : 1);

function splitByUnits(value, budget) {
  const text = String(value ?? '');
  if (!text) return [''];
  const pages = [];
  let current = '';
  let units = 0;
  for (const char of text) {
    const width = charUnits(char);
    if (current && units + width > budget) {
      pages.push(current);
      current = '';
      units = 0;
    }
    current += char;
    units += width;
  }
  if (current) pages.push(current);
  return pages;
}

function takePreview(value, budget) {
  const parts = splitByUnits(value, budget);
  return { first: parts[0] || '', rest: parts.slice(1).join('') };
}

function paginateEvidence(evidence, budget) {
  const pali = splitByUnits(evidence.pali, budget.pali);
  const chinese = splitByUnits(evidence.chinese_simplified, budget.chinese_simplified);
  const english = splitByUnits(evidence.english, budget.english);
  const count = Math.max(pali.length, chinese.length, english.length);
  return Array.from({ length: count }, (_, index) => ({
    ...evidence,
    pali: pali[index] || '',
    chinese_simplified: chinese[index] || '',
    english: english[index] || '',
  }));
}

function page({ number, total, kicker, title, body, css, slideId }) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=1920"><title>${esc(title)}</title><link rel="stylesheet" href="${css}?v=network-v3"><body><main class="slide" data-slide-id="${esc(slideId)}"><div class="kicker"><span>${esc(kicker)}</span><span>${number} / ${total}</span></div><div class="rule"></div>${body}<div class="foot">V4 禅修节点网讲座 · 经卷式学术编年 · 旧流程图保持原样</div></main></body></html>`;
}

const readerHref = (readerUrl, upLevels) => String(readerUrl || '').startsWith('#') ? `${'../'.repeat(upLevels)}${readerUrl}` : readerUrl;
const citation = (evidence, upLevels, compact = false) => `<div class="citation${compact ? ' compact-citation' : ''}"><strong>V4</strong>　${esc(evidence.work_id)}:${esc(evidence.row_id)} · 来源层级：${esc(layerLabel[evidence.layer] || evidence.layer)}<br><strong>PATH</strong>　${esc((evidence.path || []).join(' / '))}<br><strong>ANCHOR</strong>　Pāli ${esc(evidence.anchors.pali_sha256)} · English ${esc(evidence.anchors.english_sha256)}<br><a href="${esc(readerHref(evidence.reader_url, upLevels))}" target="_blank" rel="noopener">在 V4 阅读器中核对原段 ↗</a></div>`;
const quoteText = value => value ? esc(value) : '<span class="empty-quote">（本页无新增文本）</span>';
const quote = evidence => `<div class="quote-label">Pāli</div><blockquote class="pali">${quoteText(evidence.pali)}</blockquote><div class="quote-label">简体中文</div><blockquote class="zh">${quoteText(evidence.chinese_simplified)}</blockquote><div class="quote-label">English</div><blockquote class="en">${quoteText(evidence.english)}</blockquote>`;

await mkdir(resolve(deckDir, 'slides'), { recursive: true });
await mkdir(resolve(deckDir, 'appendix/slides'), { recursive: true });

// Generated slide directories are an exact build artifact. Remove only old
// HTML slides before writing the new manifest so stale pre-pagination pages
// cannot remain addressable after a rebuild.
async function clearGeneratedSlides(directory) {
  for (const name of await readdir(directory)) {
    if (name.endsWith('.html')) await rm(resolve(directory, name), { force: true });
  }
}
await clearGeneratedSlides(resolve(deckDir, 'slides'));
await clearGeneratedSlides(resolve(deckDir, 'appendix/slides'));

const appendixItems = [];
for (const node of graph.nodes) appendixItems.push({ kind: 'node', node, evidence: node.evidence, evidenceIndex: 0, label: `节点证据 · ${node.title}` });
for (const edge of graph.edges) for (const [evidenceIndex, evidence] of edge.evidence_rows.entries()) appendixItems.push({ kind: 'edge', edge, evidence, evidenceIndex, label: `关系证据 · ${relationText(edge)}` });

const appendixPages = [];
const appendixFirstIndexByNode = new Map();
for (const item of appendixItems) {
  const parts = paginateEvidence(item.evidence, APPENDIX_BUDGET);
  for (const [partIndex, evidence] of parts.entries()) {
    const pageIndex = appendixPages.length;
    const itemId = item.kind === 'node' ? item.node.id : item.edge.id;
    const file = `slides/${String(pageIndex + 1).padStart(4, '0')}-${item.kind}-${safeId(itemId)}-e${String(item.evidenceIndex + 1).padStart(2, '0')}-${String(partIndex + 1).padStart(2, '0')}.html`;
    if (item.kind === 'node' && !appendixFirstIndexByNode.has(item.node.id)) appendixFirstIndexByNode.set(item.node.id, pageIndex + 1);
    appendixPages.push({
      file,
      slideId: `appendix-${item.kind}-${safeId(itemId)}-e${item.evidenceIndex + 1}-${partIndex + 1}`,
      title: item.kind === 'node' ? item.node.title : relationText(item.edge),
      label: item.kind === 'node' ? `${item.node.domain_label} · ${item.node.kind}` : `${item.edge.type} · ${item.edge.evidence_basis}`,
      item,
      evidence,
      partIndex,
      partCount: parts.length,
    });
  }
}

const nodePlans = graph.nodes.map((node, nodeIndex) => {
  const previewPali = takePreview(node.evidence.pali, MAIN_PREVIEW_BUDGET.pali);
  const previewChinese = takePreview(node.evidence.chinese_simplified, MAIN_PREVIEW_BUDGET.chinese_simplified);
  const previewEnglish = takePreview(node.evidence.english, MAIN_PREVIEW_BUDGET.english);
  const remainder = { ...node.evidence, pali: previewPali.rest, chinese_simplified: previewChinese.rest, english: previewEnglish.rest };
  const continuationEvidence = (remainder.pali || remainder.chinese_simplified || remainder.english) ? paginateEvidence(remainder, CONTINUATION_BUDGET) : [];
  const continuationFiles = continuationEvidence.map((_, index) => `slides/evidence-node-${String(nodeIndex + 1).padStart(3, '0')}-${safeId(node.id)}-${String(index + 1).padStart(2, '0')}.html`);
  return {
    node,
    nodeIndex,
    preview: { ...node.evidence, pali: previewPali.first, chinese_simplified: previewChinese.first, english: previewEnglish.first },
    continuationEvidence,
    continuationFiles,
    appendixIndex: appendixFirstIndexByNode.get(node.id) || 1,
  };
});

const mainBasePages = [{
  file: 'slides/001-overview.html',
  slideId: 'overview',
  title: '不是一条必经路线',
  body: `<h1>V4 禅修<br><em>节点网</em></h1><p class="subtitle">严格保留旧图 68 个实质节点，并把明确枚举拆成 60 个可核验原子节点。新图只呈现 V4 原文能支持的组成、并列、条件、对治与文本关系。</p><div class="layers"><div class="layer" style="border-color:#a94732">根本经：128 个节点的主证据层</div><div class="layer" style="border-color:#6f7f59">义注／复注／藏外：每节点最多三条术语上下文，不替代根本引文</div><div class="layer" style="border-color:#8b6321">94 条关系：无逐句支持的关系已退出发布图</div></div><div class="cover-meta">68 个旧图主干 · 60 个原子扩展 · 94 条可回读关系<br>箭头不是所有人的唯一修行次第。</div>`,
}];

const continuationPages = [];
for (const plan of nodePlans) {
  const node = plan.node;
  const inbound = graph.edges.filter(edge => edge.to === node.id);
  const outbound = graph.edges.filter(edge => edge.from === node.id);
  const related = [...inbound, ...outbound].slice(0, 8).map(edge => `<li><span class="relation-tag">${esc(edge.type)}</span> ${esc(relationText(edge))}</li>`).join('') || '<li>独立证据锚点：没有足够直接关系句，未凭概念相似度补边。</li>';
  const continuationLinks = plan.continuationFiles.length
    ? `<p class="continuation-note">本页显示完整引文的第 1 段；其余内容已拆为 ${plan.continuationFiles.length} 个续页，未省略。</p><nav class="continuation-links">${plan.continuationFiles.map((file, index) => `<a href="${esc(file)}" target="_blank" rel="noopener">打开引文续页 ${index + 1} ↗</a>`).join('')}</nav>`
    : '<p class="continuation-note">本页已包含该证据的全部三语文本。</p>';
  const body = `<div class="evidence-layout"><section class="side"><div class="label">${esc(node.domain_label)} · ${esc(node.kind)}${node.legacy_title && node.legacy_title !== node.title ? ` · 旧图：${esc(node.legacy_title)}` : ''}</div><h2>${esc(node.title)}</h2><p>${esc(node.note || '该节点以 V4 原文逐句证据为边界，讲座不扩写为个人必经经验。')}</p><div class="layer"><strong>关系与边界</strong><ul class="relation-list">${related}</ul></div><p><a class="meditation-reader-link" href="../appendix/#${plan.appendixIndex}" target="_top">查看本节点完整引文附录 →</a></p>${continuationLinks}</section><section class="quote-card citation-card"><div class="label">根本经主证据 · 三语逐句</div><h3>${esc(node.evidence.uid)} · ${esc(node.evidence.paranum || node.evidence.row_id)}</h3>${quote(plan.preview)}${citation(node.evidence, 4)}<div class="citation-part">层级上下文：义注 ${node.layer_evidence?.commentary?.entries?.length || 0} 条 · 复注 ${node.layer_evidence?.subcommentary?.entries?.length || 0} 条 · 藏外 ${node.layer_evidence?.other?.entries?.length || 0} 条（仅作语境，不作节点/关系证明）</div></section></div>`;
  mainBasePages.push({ file: `slides/${String(plan.nodeIndex + 2).padStart(3, '0')}-${node.id}.html`, slideId: `node-${node.id}`, title: node.title, body, kicker: `节点 ${plan.nodeIndex + 1} / ${graph.nodes.length}` });
  for (const [index, evidence] of plan.continuationEvidence.entries()) {
    const file = plan.continuationFiles[index];
    const baseFile = mainBasePages[plan.nodeIndex + 1].file.split('/').pop();
    const previous = index > 0 ? plan.continuationFiles[index - 1].split('/').pop() : '';
    const next = index + 1 < plan.continuationFiles.length ? plan.continuationFiles[index + 1].split('/').pop() : '';
    continuationPages.push({
      file,
      slideId: `node-evidence-${node.id}-${index + 1}`,
      title: `${node.title} · 引文续页 ${index + 1}`,
      body: `<div class="continuation-heading"><div class="label">${esc(node.domain_label)} · 三语引文续页</div><h2>${esc(node.title)}</h2><p>节点证据 · ${esc(node.evidence.uid)} · 续页 ${index + 1}/${plan.continuationEvidence.length} · ${esc(node.evidence.work_id)}:${esc(node.evidence.row_id)}</p></div><section class="quote-card continuation-card">${quote(evidence)}${citation(evidence, 4, true)}<nav class="continuation-nav"><a href="./${esc(baseFile)}">返回节点页</a>${previous ? `<a href="./${esc(previous)}">上一续页</a>` : ''}${next ? `<a href="./${esc(next)}">下一续页</a>` : ''}</nav></section>`,
      kicker: `节点证据 · ${plan.nodeIndex + 1} / ${graph.nodes.length}`,
    });
  }
}

const mainPages = [...mainBasePages, ...continuationPages];
const mainFiles = mainPages.map(({ file, slideId, title }) => ({ file, slide_id: slideId, label: title }));
const appendixFiles = appendixPages.map(({ file, slideId, label, partIndex, partCount }) => ({ file, slide_id: slideId, label: `${label} · 引文 ${partIndex + 1}/${partCount}` }));

for (const [index, slide] of mainPages.entries()) {
  await writeFile(resolve(deckDir, slide.file), page({ number: index + 1, total: mainPages.length, kicker: slide.kicker || '研究重构 · 讲座总览', title: slide.title, body: slide.body, css: '../../deck/theme.css', slideId: slide.slideId }));
}

for (const [index, slide] of appendixPages.entries()) {
  const item = slide.item;
  const relationTerms = item.kind === 'edge' ? ` · 关系术语：${esc(item.edge.relation_terms.join('、'))}` : '';
  const body = `<div class="appendix-heading"><div class="label">${esc(slide.label)}</div><h2>${esc(slide.title)}</h2><p>${esc(item.label)} · 引文 ${slide.partIndex + 1}/${slide.partCount}${relationTerms}</p></div><section class="quote-card continuation-card">${quote(slide.evidence)}${citation(slide.evidence, 5, true)}<nav class="continuation-nav"><a href="../#${index + 1}" target="_top">返回附录定位</a></nav></section>`;
  await writeFile(resolve(deckDir, 'appendix', slide.file), page({ number: index + 1, total: appendixPages.length, kicker: '逐条证据附录 · 完整三语引文', title: slide.title, body, css: '../../../deck/theme.css', slideId: slide.slideId }));
}

const template = await readFile(resolve(root, 'docs/research/pali-meditation-lecture/deck/index.html'), 'utf8');
const withManifest = (value, manifest) => value.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`).replace('window.DECK_WIDTH = 1920;', "window.DECK_OVERVIEW = 'grid';\n  window.DECK_WIDTH = 1920;");
await writeFile(resolve(deckDir, 'index.html'), withManifest(template, mainFiles));
await writeFile(resolve(deckDir, 'appendix/index.html'), withManifest(template, appendixFiles));
await writeFile(resolve(deckDir, 'manifest.json'), JSON.stringify({ format: 'v4-meditation-node-deck/v3', generated_at: new Date().toISOString(), node_network: '../../pali-meditation-node-network/meditation-knowledge-graph-v2.json', main_slide_count: mainFiles.length, appendix_slide_count: appendixFiles.length, base_node_slide_count: mainBasePages.length, continuation_slide_count: continuationPages.length, node_count: graph.nodes.length, edge_count: graph.edges.length, main: mainFiles, appendix: appendixFiles }, null, 2));

/* ── 可审计数据视图：分片 + 按需加载 ──
   旧版把整份 graph（3.8M 字符）内联进 graph.html，浏览器一次性解析成深层对象图，
   且每次击键都对每个节点重跑 JSON.stringify()。现改为：
     data/index.json       首屏用的精简字段 + 预先小写的搜索串
     data/edges.json       勾选「显示关系」时才取
     data/nodes/<key>.json 展开单个节点时才取（均值 25KB，页面侧 LRU 缓存）
     data/search-deep.json 勾选「深度搜索」时才取（义注/复注/藏外全文，保持旧版搜索口径）
   分片会在写盘后回合校验，与源 JSON 不一致即失败退出。 */
const dataDir = resolve(deckDir, 'data');
await mkdir(resolve(dataDir, 'nodes'), { recursive: true });

const shardKey = node => (/^(v4m-\d+)/.exec(node.id)?.[1]) || encodeURIComponent(node.id);
const searchText = node => {
  const evidence = node.evidence || {};
  return [
    node.id, node.title, node.legacy_title, node.domain_label, node.kind, node.note, node.isolation_reason,
    evidence.uid, evidence.work_title, evidence.pali, evidence.chinese_simplified, evidence.english,
    ...(node.terms || []), ...(node.source_uids || []), ...(evidence.matched_terms || []),
  ].filter(Boolean).join(' ').toLowerCase();
};
// 深度索引刻意用整份节点的小写 JSON：与旧版 JSON.stringify(n).toLowerCase() 完全同口径，
// 勾选后命中集与改版前逐字一致（区别只在于它是按需拉取的扁平字符串，而不是常驻的深层对象图）。
const deepText = node => JSON.stringify(node).toLowerCase();

const indexNodes = graph.nodes.map(node => ({
  id: node.id,
  key: shardKey(node),
  title: node.title,
  domain_label: node.domain_label,
  kind: node.kind,
  note: node.note || '',
  layer: node.evidence.layer,
  ev: { uid: node.evidence.uid, work_id: node.evidence.work_id, row_id: node.evidence.row_id, reader_url: readerHref(node.evidence.reader_url, 3) },
  counts: {
    commentary: node.layer_evidence?.commentary?.entries?.length || 0,
    subcommentary: node.layer_evidence?.subcommentary?.entries?.length || 0,
    other: node.layer_evidence?.other?.entries?.length || 0,
  },
  s: searchText(node),
}));
const indexPayload = {
  format: 'v4-meditation-node-network-index/v1',
  generated_at: graph.generated_at,
  node_count: graph.nodes.length,
  edge_count: graph.edges.length,
  nodes: indexNodes,
};
const edgesPayload = {
  format: 'v4-meditation-node-network-edges/v1',
  edges: graph.edges.map(edge => ({
    id: edge.id, from: edge.from, to: edge.to, type: edge.type, claim: edge.claim,
    ev: { uid: edge.evidence.uid, row_id: edge.evidence.row_id, reader_url: readerHref(edge.evidence.reader_url, 3) },
  })),
};
const deepPayload = Object.fromEntries(graph.nodes.map(node => [node.id, deepText(node)]).filter(([, text]) => text));

await writeFile(resolve(dataDir, 'index.json'), JSON.stringify(indexPayload));
await writeFile(resolve(dataDir, 'edges.json'), JSON.stringify(edgesPayload));
await writeFile(resolve(dataDir, 'search-deep.json'), JSON.stringify(deepPayload));
for (const node of graph.nodes) await writeFile(resolve(dataDir, 'nodes', `${shardKey(node)}.json`), JSON.stringify(node));
await writeFile(resolve(dataDir, 'meta.json'), JSON.stringify({
  format: 'v4-meditation-node-network-data/v1',
  generated_at: new Date().toISOString(),
  source: '../../../pali-meditation-node-network/meditation-knowledge-graph-v2.json',
  source_sha256: createHash('sha256').update(JSON.stringify(graph)).digest('hex'),
  node_count: graph.nodes.length,
  edge_count: graph.edges.length,
  verification: graph.verification,
}, null, 2));

// 回合校验：分片读回后必须与源节点逐字节一致，否则不发布
for (const node of graph.nodes) {
  const roundTrip = await readFile(resolve(dataDir, 'nodes', `${shardKey(node)}.json`), 'utf8');
  if (roundTrip !== JSON.stringify(node)) {
    console.error(`分片回合校验失败：${node.id}`);
    process.exit(1);
  }
}

const graphCss = `body{margin:0;background:#f4eee3;color:#30291f;font-family:Georgia,'Songti SC',serif}main{max-width:1320px;margin:auto;padding:44px 26px 90px}h1{font-size:48px}.meta{color:#766a5c;line-height:1.7}.controls{position:sticky;top:0;z-index:5;background:#f4eee3ee;backdrop-filter:blur(12px);padding:14px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,select{padding:10px 12px;border:1px solid #cdbb9b;border-radius:8px;background:#fffaf2;font:inherit}.controls label{display:inline-flex;align-items:center;gap:7px;padding:9px 12px;border:1px solid #cdbb9b;border-radius:8px;background:#fffaf2;cursor:pointer;font:14px sans-serif;color:#5f5648}.relations-panel{margin:18px 0 26px;padding:18px 20px;background:#fffaf2;border:1px solid #d8c9ae;border-radius:12px;box-shadow:0 8px 18px #50391c12}.relations-panel[hidden]{display:none}.relations-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px}.relations-head h2{margin:0}.relations-count{color:#8b6321;font:600 14px/1.3 sans-serif}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.card{background:#fffaf2;border:1px solid #d8c9ae;border-radius:12px;padding:18px;box-shadow:0 8px 18px #50391c12}.card h2{margin:0 0 8px;font-size:22px}.tag{display:inline-block;color:#8b6321;font:13px sans-serif;margin:0 6px 8px 0}.card a{color:#9b5f23}.edge{border-left:3px solid #c89a54;padding-left:12px;margin:12px 0}.small{color:#766a5c;font:14px/1.5 sans-serif}.status{color:#766a5c;font:14px/1.6 sans-serif;padding:10px 0}.status strong{color:#30291f}details.ev{margin-top:12px;border-top:1px dashed #d8c9ae;padding-top:10px}details.ev>summary{cursor:pointer;color:#9b5f23;font:14px sans-serif}.quote-label{font:12px sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#8b6321;margin:12px 0 4px}blockquote{margin:0;font-size:15px;line-height:1.75;white-space:pre-wrap}.anchor{font:11px/1.6 ui-monospace,monospace;color:#8d8272;word-break:break-all;margin-top:10px}@media(max-width:720px){main{padding:24px 14px 60px}h1{font-size:34px}.grid{grid-template-columns:1fr}.controls{position:static}}`;


const graphScript = String.raw`
const DATA='data/';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const q=document.querySelector('#q'),layer=document.querySelector('#layer'),kind=document.querySelector('#kind'),
      show=document.querySelector('#showEdges'),deep=document.querySelector('#deepSearch'),
      nodesEl=document.querySelector('#nodes'),edgesEl=document.querySelector('#edges'),statusEl=document.querySelector('#status'),
      relationToggleLabel=document.querySelector('#relationToggleLabel');
let index=null,edges=null,deepMap=null,lastShowState=show.checked;

const getJSON=async path=>{const r=await fetch(DATA+path,{cache:'no-cache'});if(!r.ok)throw new Error('HTTP '+r.status+' · '+path);return r.json()};
const fail=(what,err)=>{statusEl.innerHTML='<strong>'+esc(what)+'暂不可用</strong> '+esc(err&&err.message||'网络不可用')+'；其余内容仍可浏览。'};

/* 展开过的节点分片做 LRU 缓存，避免逐个点开后又把整份数据驻留在内存里 */
const CACHE_MAX=20,cache=new Map();
async function nodeDetail(key){
  if(cache.has(key)){const v=cache.get(key);cache.delete(key);cache.set(key,v);return v}
  const data=await getJSON('nodes/'+key+'.json');
  cache.set(key,data);
  while(cache.size>CACHE_MAX)cache.delete(cache.keys().next().value);
  return data;
}

function layerMatch(n){return !layer.value||layer.value===n.layer||(n.counts[layer.value]||0)>0}
function matches(n,needle){
  if(!needle)return true;
  if(n.s.includes(needle))return true;
  return !!(deepMap&&(deepMap[n.id]||'').includes(needle));
}

function draw(){
  if(!index)return;
  const needle=q.value.trim().toLowerCase();
  const ns=index.nodes.filter(n=>matches(n,needle)&&layerMatch(n)&&(!kind.value||n.kind===kind.value));
  statusEl.innerHTML='<strong>'+ns.length+'</strong> / '+index.nodes.length+' 个节点'+(needle?'　匹配「'+esc(needle)+'」':'')+(deepMap?'　· 深度搜索已加载':'');
  nodesEl.innerHTML=ns.map(n=>'<article class="card"><div class="tag">'+esc(n.domain_label)+' · '+esc(n.kind)+'</div><h2>'+esc(n.title)+'</h2>'
    +'<div class="small">根本证据：'+esc(n.ev.uid)+' · '+esc(n.ev.work_id)+':'+esc(n.ev.row_id)+' · 上下文：义注 '+n.counts.commentary+' / 复注 '+n.counts.subcommentary+' / 藏外 '+n.counts.other+'</div>'
    +'<p>'+esc(n.note)+'</p>'
    +'<details class="ev" data-key="'+esc(n.key)+'"><summary>展开三语原文与层级上下文</summary><div class="small">载入中…</div></details>'
    +'<a href="'+esc(n.ev.reader_url)+'" target="_blank" rel="noopener">打开 V4 原段 ↗</a></article>').join('')||'<p>没有匹配节点。</p>';
}

function renderQuote(e){
  return '<div class="quote-label">Pāli</div><blockquote>'+esc(e.pali)+'</blockquote>'
    +'<div class="quote-label">简体中文</div><blockquote>'+esc(e.chinese_simplified)+'</blockquote>'
    +'<div class="quote-label">English</div><blockquote>'+esc(e.english)+'</blockquote>'
    +'<div class="anchor">ANCHOR · Pāli '+esc(e.anchors&&e.anchors.pali_sha256)+' · English '+esc(e.anchors&&e.anchors.english_sha256)+'</div>';
}
function renderLayers(le){
  const label={commentary:'义注',subcommentary:'复注',other:'藏外典籍'};
  return Object.keys(label).map(k=>{
    const entries=(le&&le[k]&&le[k].entries)||[];
    if(!entries.length)return '';
    return '<div class="quote-label">'+label[k]+'（'+entries.length+' 条语境，不作节点或关系证明）</div>'
      +entries.map(en=>'<div class="edge"><div class="small">'+esc(en.uid||'')+' · '+esc(en.work_title||'')+'</div><blockquote>'+esc(en.pali||'')+'</blockquote><blockquote>'+esc(en.chinese_simplified||'')+'</blockquote></div>').join('');
  }).join('');
}

nodesEl.addEventListener('toggle',async ev=>{
  const el=ev.target;
  if(el.tagName!=='DETAILS'||!el.open||el.dataset.loaded)return;
  const box=el.querySelector('div');
  try{
    const n=await nodeDetail(el.dataset.key);
    box.innerHTML=renderQuote(n.evidence)+renderLayers(n.layer_evidence);
    el.dataset.loaded='1';
  }catch(err){box.innerHTML='<span class="small">引文暂不可用：'+esc(err.message)+'</span>'}
},true);

function syncRelationToggle(){
  const total=index?index.edge_count:0;
  edgesEl.hidden=!show.checked;
  edgesEl.setAttribute('aria-expanded',String(show.checked));
  show.setAttribute('aria-expanded',String(show.checked));
  relationToggleLabel.textContent=(show.checked?'已显示关系（':'显示关系（')+total+' 条）';
}
async function drawEdges(scrollIntoView){
  syncRelationToggle();
  if(!show.checked){edgesEl.innerHTML='';return}
  if(!edges){
    edgesEl.innerHTML='<p class="small">正在读取关系证据…</p>';
    try{edges=await getJSON('edges.json')}catch(err){edgesEl.innerHTML='<p class="small">关系证据暂不可用：'+esc(err.message)+'</p>';return}
  }
  const titles=new Map(index.nodes.map(n=>[n.id,n.title]));
  edgesEl.innerHTML='<div class="relations-head"><h2>关系证据</h2><span class="relations-count">'+edges.edges.length+' 条关系</span></div>'
    +edges.edges.map(e=>'<div class="edge"><b>'+esc(titles.get(e.from)||e.from)+' → '+esc(titles.get(e.to)||e.to)+'</b>　<span class="tag">'+esc(e.type)+'</span><div class="small">'+esc(e.claim)+' · '+esc(e.ev.uid)+':'+esc(e.ev.row_id)+'</div><a href="'+esc(e.ev.reader_url)+'" target="_blank" rel="noopener">核对关系引文 ↗</a></div>').join('');
  if(scrollIntoView)requestAnimationFrame(()=>edgesEl.scrollIntoView({block:'nearest',behavior:'smooth'}));
}

deep.addEventListener('change',async()=>{
  if(!deep.checked){deepMap=null;draw();return}
  deep.disabled=true;
  try{deepMap=await getJSON('search-deep.json')}catch(err){deep.checked=false;fail('深度搜索索引',err)}
  deep.disabled=false;draw();
});

let timer;
q.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(draw,120)});
[layer,kind].forEach(el=>el.addEventListener('change',draw));
const onShow=()=>{if(show.checked===lastShowState)return;lastShowState=show.checked;drawEdges(true)};
show.addEventListener('change',onShow);
show.addEventListener('input',onShow);

(async()=>{
  try{index=await getJSON('index.json');draw();drawEdges(false)}
  catch(err){fail('节点索引',err)}
})();
`;

const graphHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V4 禅修节点网 · 可审计数据视图</title><style>${graphCss}</style><main><h1>V4 禅修节点网</h1><p class="meta">${graph.nodes.length} 个节点 · ${graph.edges.length} 条关系 · 根本经主证据；义注、复注、藏外为独立术语上下文。旧流程图未改写。<br><span class="small">首屏只载入节点索引；三语原文与关系证据按需读取，可在 <a href="data/meta.json">data/meta.json</a> 核对数据来源哈希。</span></p><div class="controls"><input id="q" placeholder="搜索节点、巴利或中文"><select id="layer"><option value="">全部语料上下文</option><option value="root_sutta">根本经主证据</option><option value="commentary">义注上下文</option><option value="subcommentary">复注上下文</option><option value="other">藏外上下文</option></select><select id="kind"><option value="">全部节点类型</option><option value="legacy_spine">旧图主干</option><option value="atomic_member">原子成员</option></select><label><input id="showEdges" type="checkbox" aria-controls="edges" aria-expanded="false"><span id="relationToggleLabel">显示关系（${graph.edges.length} 条）</span></label><label><input id="deepSearch" type="checkbox"> 深度搜索（含义注／复注全文）</label></div><div id="status" class="status">正在读取节点索引…</div><section id="edges" class="relations-panel" hidden aria-live="polite" aria-expanded="false"></section><section id="nodes" class="grid"></section></main><script>${graphScript}</script></html>`;
await writeFile(resolve(deckDir, 'graph.html'), graphHtml);
/* ── 讲座落地页 ──
   /research/pali-meditation-lecture/ 此前没有 index.html（GitHub Pages 直接 404），
   入口只散落在 docs/index.html 的若干外链里。这里生成一个纯静态、无数据的目录页，
   配色沿用 docs/index.html 里 injectMeditationLectureCss() 的那套 token。 */
const kb = bytes => `${Math.round(bytes / 1024)} KB`;
const entry = ({ href, title, desc, cost }) => `<a class="entry" href="${href}"><h2>${esc(title)}</h2><p>${esc(desc)}</p><div class="cost">${esc(cost)}</div></a>`;
const landing = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V4 全层禅修经证 · 讲座交付</title><style>
:root{--med-ink:#2f4036;--med-muted:#6f7d73;--med-gold:#b88948;--med-paper:#f7f5ef}
*{box-sizing:border-box}body{margin:0;background:#efeade;color:var(--med-ink);font-family:Georgia,"Songti SC","STSong",serif}
main{max-width:1080px;margin:0 auto;padding:0 22px 90px}
header{padding:72px 0 46px;border-bottom:1px solid #ddd9cd;margin-bottom:40px}
.eyebrow{font:700 13px/1.3 "Helvetica Neue",sans-serif;letter-spacing:.18em;color:var(--med-gold);text-transform:uppercase}
h1{margin:16px 0 14px;font:600 clamp(32px,5vw,52px)/1.15 "Songti SC","STSong",serif}
header p{max-width:760px;margin:0;color:var(--med-muted);font-size:17px;line-height:1.85}
.stats{display:flex;flex-wrap:wrap;gap:34px;margin-top:30px}.stats div{font:14px/1.5 "Helvetica Neue",sans-serif;color:var(--med-muted)}.stats b{display:block;font:600 30px/1 Georgia,serif;color:var(--med-ink)}
.kicker{font:700 13px/1.3 "Helvetica Neue",sans-serif;letter-spacing:.18em;color:var(--med-gold);text-transform:uppercase;margin:44px 0 18px}
.entries{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.entry{display:block;padding:26px 28px;background:var(--med-paper);border:1px solid #ddd9cd;border-radius:18px;text-decoration:none;color:inherit;transition:transform .18s,box-shadow .18s}
.entry:hover{transform:translateY(-3px);box-shadow:0 16px 40px rgba(50,45,30,.12)}
.entry h2{margin:0 0 10px;font-size:22px}.entry p{margin:0;color:var(--med-muted);font-size:15px;line-height:1.75}
.cost{margin-top:14px;font:12px/1.4 "Helvetica Neue",sans-serif;letter-spacing:.06em;color:var(--med-gold)}
footer{margin-top:56px;padding-top:24px;border-top:1px solid #ddd9cd;color:var(--med-muted);font:14px/1.8 "Helvetica Neue",sans-serif}
footer a{color:var(--med-gold)}
</style><main>
<header>
<div class="eyebrow">V4 全层禅修经证 · LECTURE</div>
<h1>从戒到慧：禅修经证的层级阅读</h1>
<p>以根本三藏、义注、复注与藏外典籍的逐句三语原文，重新审视旧流程图中的“路径”、证据边界与实际修习语境。下列各项互为补充：讲座用于讲述，节点网用于查证，附录用于逐条核对原文。</p>
<div class="stats"><div><b>${graph.nodes.length}</b>节点</div><div><b>${graph.edges.length}</b>可回读关系</div><div><b>4</b>证据层级</div><div><b>${appendixFiles.length}</b>条附录引文</div></div>
</header>
<div class="kicker">01 · 讲述</div>
<div class="entries">
${entry({ href: 'network-deck/', title: '节点网讲座', desc: `${mainFiles.length} 页幻灯片：总览一页，其余每页一个节点，含根本经三语主证据与关系边界。概览墙按需渲染，翻页用 ← → 或点击左右热区。`, cost: `${mainFiles.length} 页 · 概览同时最多渲染 12 页` })}
${entry({ href: 'deck/', title: '原主题讲座', desc: '按主题组织的早期版本，保留作对照。', cost: '20 页' })}
${entry({ href: 'directions/classic/', title: '方向 A · 经卷式学术编年', desc: '同一份研究的另一种叙述编排。', cost: '轻量页面' })}
</div>
<div class="kicker">02 · 查证</div>
<div class="entries">
${entry({ href: 'network-deck/graph.html', title: '可搜索节点网', desc: '按名称、巴利词、中文与根本引文全文检索；可按语料层级与节点类型过滤，展开任一节点查看三语原文与义注／复注／藏外语境。', cost: `首屏 ${kb(Buffer.byteLength(JSON.stringify(indexPayload)))} 索引 · 原文按需读取` })}
${entry({ href: 'network-deck/appendix/', title: '逐条引文附录', desc: '把每条节点证据与关系证据的完整三语原文切成整屏幻灯片，便于逐句核对与投屏引用。', cost: `${appendixFiles.length} 页 · 概览同时最多渲染 12 页` })}
${entry({ href: '../pali-meditation-evidence/evidence-index.html', title: '全量三语证据索引', desc: '词条召回的完整候选集，分片存放，作为节点网之外的上游检索入口。', cost: '分片按需加载' })}
</div>
<div class="kicker">03 · 可审计</div>
<div class="entries">
${entry({ href: 'network-deck/data/meta.json', title: '数据来源与哈希', desc: '节点网分片数据的生成时间、上游文件与 sha256，用于核对页面所示内容未被改写。', cost: '< 1 KB' })}
${entry({ href: 'network-deck/manifest.json', title: '幻灯片清单', desc: '主讲与附录每一页的文件名与标题，便于外部引用与重建。', cost: `${kb(62418)}` })}
</div>
<footer>节点与关系仅以 V4 逐句对齐原文为界：义注、复注、藏外典籍作为独立语境呈现，不替代根本引文，也不据以扩展节点网。箭头不代表所有人的唯一修行次第。<br><a href="../../">← 回到 Sutta Study Guide</a></footer>
</main></html>`;
await writeFile(resolve(root, 'docs/research/pali-meditation-lecture/index.html'), landing);

console.log(JSON.stringify({ main_slides: mainFiles.length, appendix_slides: appendixFiles.length, node_count: graph.nodes.length, edge_count: graph.edges.length, graph_html_bytes: Buffer.byteLength(graphHtml), index_json_bytes: Buffer.byteLength(JSON.stringify(indexPayload)) }, null, 2));
