#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=1920"><title>${esc(title)}</title><link rel="stylesheet" href="${css}"><body><main class="slide" data-slide-id="${esc(slideId)}"><div class="kicker"><span>${esc(kicker)}</span><span>${number} / ${total}</span></div><div class="rule"></div>${body}<div class="foot">V4 禅修节点网讲座 · 经卷式学术编年 · 旧流程图保持原样</div></main></body></html>`;
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

const graphView = {
  ...graph,
  nodes: graph.nodes.map(node => ({ ...node, evidence: { ...node.evidence, reader_url: readerHref(node.evidence.reader_url, 3) } })),
  edges: graph.edges.map(edge => ({ ...edge, evidence: { ...edge.evidence, reader_url: readerHref(edge.evidence.reader_url, 3) } })),
};
const graphCss = `body{margin:0;background:#f4eee3;color:#30291f;font-family:Georgia,'Songti SC',serif}main{max-width:1320px;margin:auto;padding:44px 26px 90px}h1{font-size:48px}.meta{color:#766a5c;line-height:1.7}.controls{position:sticky;top:0;z-index:2;background:#f4eee3ee;backdrop-filter:blur(12px);padding:14px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,select{padding:10px 12px;border:1px solid #cdbb9b;border-radius:8px;background:#fffaf2;font:inherit}.controls label{display:inline-flex;align-items:center;gap:7px;padding:9px 12px;border:1px solid #cdbb9b;border-radius:8px;background:#fffaf2;cursor:pointer}.relations-panel{margin:18px 0 26px;padding:18px 20px;background:#fffaf2;border:1px solid #d8c9ae;border-radius:12px;box-shadow:0 8px 18px #50391c12}.relations-panel[hidden]{display:none}.relations-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px}.relations-head h2{margin:0}.relations-count{color:#8b6321;font:600 14px/1.3 sans-serif}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.card{background:#fffaf2;border:1px solid #d8c9ae;border-radius:12px;padding:18px;box-shadow:0 8px 18px #50391c12}.card h2{margin:0 0 8px;font-size:22px}.tag{display:inline-block;color:#8b6321;font:13px sans-serif;margin:0 6px 8px 0}.card a{color:#9b5f23}.edge{border-left:3px solid #c89a54;padding-left:12px;margin:12px 0}.small{color:#766a5c;font:14px/1.5 sans-serif}@media(max-width:720px){main{padding:24px 14px 60px}h1{font-size:34px}.grid{grid-template-columns:1fr}.controls{position:static}}`;
const graphScript = `const graph=${safeJson(graphView)};const escHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));const nodeMap=new Map(graph.nodes.map(n=>[n.id,n]));const q=document.querySelector('#q'),layer=document.querySelector('#layer'),kind=document.querySelector('#kind'),show=document.querySelector('#showEdges'),nodesEl=document.querySelector('#nodes'),edgesEl=document.querySelector('#edges'),relationToggleLabel=document.querySelector('#relationToggleLabel');let lastShowState=show.checked;function layerMatch(n){if(!layer.value)return true;if(layer.value===n.evidence.layer)return true;return !!n.layer_evidence?.[layer.value]?.entries?.length}function draw(scrollRelations=false){const needle=q.value.toLowerCase();const ns=graph.nodes.filter(n=>(!needle||JSON.stringify(n).toLowerCase().includes(needle))&&layerMatch(n)&&(!kind.value||n.kind===kind.value));nodesEl.innerHTML=ns.map(n=>'<article class="card"><div class="tag">'+escHtml(n.domain_label)+' · '+escHtml(n.kind)+'</div><h2>'+escHtml(n.title)+'</h2><div class="small">根本证据：'+escHtml(n.evidence.uid)+' · '+escHtml(n.evidence.work_id)+':'+escHtml(n.evidence.row_id)+' · 上下文：义注 '+(n.layer_evidence?.commentary?.entries?.length||0)+' / 复注 '+(n.layer_evidence?.subcommentary?.entries?.length||0)+' / 藏外 '+(n.layer_evidence?.other?.entries?.length||0)+'</div><p>'+escHtml(n.note)+'</p><a href="'+n.evidence.reader_url+'" target="_blank">打开 V4 原段 ↗</a></article>').join('')||'<p>没有匹配节点。</p>';edgesEl.hidden=!show.checked;edgesEl.setAttribute('aria-expanded',String(show.checked));show.setAttribute('aria-expanded',String(show.checked));relationToggleLabel.textContent=show.checked?'已显示关系（'+graph.edges.length+' 条）':'显示关系（'+graph.edges.length+' 条）';edgesEl.innerHTML=show.checked?'<div class="relations-head"><h2>关系证据</h2><span class="relations-count">'+graph.edges.length+' 条关系</span></div>'+graph.edges.map(e=>'<div class="edge"><b>'+escHtml(nodeMap.get(e.from)?.title||e.from)+' → '+escHtml(nodeMap.get(e.to)?.title||e.to)+'</b>　<span class="tag">'+escHtml(e.type)+'</span><div class="small">'+escHtml(e.claim)+' · '+escHtml(e.evidence.uid)+':'+escHtml(e.evidence.row_id)+'</div><a href="'+e.evidence.reader_url+'" target="_blank">核对关系引文 ↗</a></div>').join(''):'';if(scrollRelations&&show.checked)requestAnimationFrame(()=>edgesEl.scrollIntoView({block:'nearest',behavior:'smooth'}))}q.addEventListener('input',()=>draw());layer.addEventListener('change',()=>draw());kind.addEventListener('change',()=>draw());const onShow=()=>{if(show.checked===lastShowState)return;lastShowState=show.checked;draw(true)};show.addEventListener('change',onShow);show.addEventListener('input',onShow);draw();`;
const graphHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V4 禅修节点网 · 可审计数据视图</title><style>${graphCss}</style><main><h1>V4 禅修节点网</h1><p class="meta">${graph.nodes.length} 个节点 · ${graph.edges.length} 条关系 · 根本经主证据；义注、复注、藏外为独立术语上下文。旧流程图未改写。</p><div class="controls"><input id="q" placeholder="搜索节点、巴利或中文"><select id="layer"><option value="">全部语料上下文</option><option value="root_sutta">根本经主证据</option><option value="commentary">义注上下文</option><option value="subcommentary">复注上下文</option><option value="other">藏外上下文</option></select><select id="kind"><option value="">全部节点类型</option><option value="legacy_spine">旧图主干</option><option value="atomic_member">原子成员</option></select><label><input id="showEdges" type="checkbox" aria-controls="edges" aria-expanded="false"><span id="relationToggleLabel">显示关系（${graph.edges.length} 条）</span></label></div><section id="edges" class="relations-panel" hidden aria-live="polite" aria-expanded="false"></section><section id="nodes" class="grid"></section></main><script>${graphScript}</script></html>`;
await writeFile(resolve(deckDir, 'graph.html'), graphHtml);
console.log(JSON.stringify({ main_slides: mainFiles.length, appendix_slides: appendixFiles.length, base_node_slides: mainBasePages.length, continuation_slides: continuationPages.length, node_count: graph.nodes.length, edge_count: graph.edges.length }, null, 2));
