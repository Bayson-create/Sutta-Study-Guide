#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const graph = JSON.parse(await readFile(resolve(root, 'docs/research/pali-meditation-node-network/meditation-knowledge-graph-v2.json'), 'utf8'));
const deckDir = resolve(root, 'docs/research/pali-meditation-lecture/network-deck');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clip = (value, n) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const chunks = (value, n = 620) => { const text = String(value ?? '').trim() || '（该语种字段为空）'; return Array.from({ length: Math.max(1, Math.ceil(text.length / n)) }, (_, index) => text.slice(index * n, index * n + n)); };
const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
const relationText = edge => `${nodeById.get(edge.from)?.title || edge.from} → ${nodeById.get(edge.to)?.title || edge.to}`;
const page = ({ number, total, kicker, title, body, css }) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=1920"><title>${esc(title)}</title><link rel="stylesheet" href="${css}"><body><main class="slide"><div class="kicker"><span>${esc(kicker)}</span><span>${number} / ${total}</span></div><div class="rule"></div>${body}<div class="foot">V4 禅修节点网讲座 · 经卷式学术编年 · 旧流程图保持原样</div></main></body></html>`;
const layerLabel = { root_sutta: '根本经', commentary: '义注', subcommentary: '复注', other: '藏外典籍' };
const readerHref = (readerUrl, upLevels) => String(readerUrl || '').startsWith('#') ? `${'../'.repeat(upLevels)}${readerUrl}` : readerUrl;
const citation = (evidence, upLevels) => `<div class="citation"><strong>V4</strong>　${esc(evidence.work_id)}:${esc(evidence.row_id)} · 来源层级：${esc(layerLabel[evidence.layer] || evidence.layer)}<br><strong>PATH</strong>　${esc((evidence.path || []).join(' / '))}<br><strong>ANCHOR</strong>　Pāli ${esc(evidence.anchors.pali_sha256)} · English ${esc(evidence.anchors.english_sha256)}<br><a href="${esc(readerHref(evidence.reader_url, upLevels))}" target="_blank" rel="noopener">在 V4 阅读器中核对原段 ↗</a></div>`;
const quote = (evidence, max = 440) => `<div class="quote-label">Pāli</div><blockquote class="pali">${esc(clip(evidence.pali, max))}</blockquote><div class="quote-label">简体中文</div><blockquote class="zh">${esc(clip(evidence.chinese_simplified, max))}</blockquote><div class="quote-label">English</div><blockquote class="en">${esc(clip(evidence.english, Math.round(max * .78)))}</blockquote>`;

await mkdir(resolve(deckDir, 'slides'), { recursive: true });
await mkdir(resolve(deckDir, 'appendix/slides'), { recursive: true });

const appendixItems = [];
for (const node of graph.nodes) appendixItems.push({ kind: 'node', node, evidence: node.evidence, label: `节点证据 · ${node.title}` });
for (const edge of graph.edges) for (const evidence of edge.evidence_rows) appendixItems.push({ kind: 'edge', edge, evidence, label: `关系证据 · ${relationText(edge)}` });

const appendixFiles = [];
const appendixTotal = appendixItems.reduce((sum, item) => sum + Math.max(chunks(item.evidence.pali).length, chunks(item.evidence.chinese_simplified).length, chunks(item.evidence.english).length), 0);
let appendixSlide = 0;
for (const item of appendixItems) {
  const parts = Math.max(chunks(item.evidence.pali).length, chunks(item.evidence.chinese_simplified).length, chunks(item.evidence.english).length);
  for (let index = 0; index < parts; index += 1) {
    appendixSlide += 1;
    const file = `slides/${String(appendixSlide).padStart(4, '0')}-${item.kind}-${item.kind === 'node' ? item.node.id : item.edge.id}-${index + 1}.html`;
    const title = item.kind === 'node' ? item.node.title : relationText(item.edge);
    const label = item.kind === 'node' ? `${item.node.domain_label} · ${item.node.kind}` : `${item.edge.type} · ${item.edge.evidence_basis}`;
    const sliced = { ...item.evidence, pali: chunks(item.evidence.pali)[index] || '', chinese_simplified: chunks(item.evidence.chinese_simplified)[index] || '', english: chunks(item.evidence.english)[index] || '' };
    const body = `<div class="appendix-heading"><div class="label">${esc(label)}</div><h2>${esc(title)}</h2><p>${esc(item.label)} · 引文 ${index + 1}/${parts}${item.kind === 'edge' ? ` · 关系术语：${esc(item.edge.relation_terms.join('、'))}` : ''}</p></div><section class="quote-card citation-card">${quote(sliced, 700)}${citation(item.evidence, 5)}</section>`;
    await writeFile(resolve(deckDir, 'appendix', file), page({ number: appendixSlide, total: appendixTotal, kicker: '逐条证据附录 · 完整三语引文', title, body, css: '../../../deck/theme.css' }));
    appendixFiles.push({ file, label: `${item.label} · ${index + 1}/${parts}` });
  }
}

const main = [];
main.push({ title: '不是一条必经路线', body: `<h1>V4 禅修<br><em>节点网</em></h1><p class="subtitle">严格保留旧图 68 个实质节点，并把明确枚举拆成 60 个可核验原子节点。新图只呈现 V4 原文能支持的组成、并列、条件、对治与文本关系。</p><div class="layers"><div class="layer" style="border-color:#a94732">根本经：128 个节点的主证据层</div><div class="layer" style="border-color:#6f7f59">义注／复注／藏外：每节点最多三条术语上下文，不替代根本引文</div><div class="layer" style="border-color:#8b6321">94 条关系：无逐句支持的关系已退出发布图</div></div><div class="cover-meta">68 个旧图主干 · 60 个原子扩展 · 94 条可回读关系<br>箭头不是所有人的唯一修行次第。</div>` });
for (const node of graph.nodes) {
  const inbound = graph.edges.filter(edge => edge.to === node.id);
  const outbound = graph.edges.filter(edge => edge.from === node.id);
  const related = [...inbound, ...outbound].slice(0, 8).map(edge => `<li><span class="relation-tag">${esc(edge.type)}</span> ${esc(relationText(edge))}<br><small>${esc(edge.claim)}</small></li>`).join('') || '<li>独立证据锚点：没有足够直接关系句，未凭概念相似度补边。</li>';
  const appendixIndex = appendixItems.findIndex(item => item.kind === 'node' && item.node.id === node.id) + 1;
  const body = `<div class="evidence-layout"><section class="side"><div class="label">${esc(node.domain_label)} · ${esc(node.kind)}${node.legacy_title && node.legacy_title !== node.title ? ` · 旧图：${esc(node.legacy_title)}` : ''}</div><h2>${esc(node.title)}</h2><p>${esc(node.note || '该节点以 V4 原文逐句证据为边界，讲座不扩写为个人必经经验。')}</p><div class="layer"><strong>关系与边界</strong><ul class="relation-list">${related}</ul></div><p><a class="meditation-reader-link" href="../appendix/#${appendixIndex}" target="_top">查看本节点完整引文附录 →</a></p></section><section class="quote-card citation-card"><div class="label">根本经主证据 · 三语逐句</div><h3>${esc(node.evidence.uid)} · ${esc(node.evidence.paranum || node.evidence.row_id)}</h3>${quote(node.evidence, 410)}${citation(node.evidence, 4)}<div class="citation-part">层级上下文：义注 ${node.layer_evidence?.commentary?.entries?.length || 0} 条 · 复注 ${node.layer_evidence?.subcommentary?.entries?.length || 0} 条 · 藏外 ${node.layer_evidence?.other?.entries?.length || 0} 条（仅作语境，不作节点/关系证明）</div></section></div>`;
  main.push({ title: node.title, body });
}

const mainFiles = [];
for (let index = 0; index < main.length; index += 1) {
  const file = `slides/${String(index + 1).padStart(3, '0')}-${index ? graph.nodes[index - 1].id : 'overview'}.html`;
  await writeFile(resolve(deckDir, file), page({ number: index + 1, total: main.length, kicker: index ? `节点 ${index} / ${graph.nodes.length}` : '研究重构 · 讲座总览', title: main[index].title, body: main[index].body, css: '../../deck/theme.css' }));
  mainFiles.push({ file, label: main[index].title });
}

const template = await readFile(resolve(root, 'docs/research/pali-meditation-lecture/deck/index.html'), 'utf8');
const withManifest = (value, manifest) => value.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`).replace('window.DECK_WIDTH = 1920;', "window.DECK_OVERVIEW = 'grid';\n  window.DECK_WIDTH = 1920;");
await writeFile(resolve(deckDir, 'index.html'), withManifest(template, mainFiles));
await writeFile(resolve(deckDir, 'appendix/index.html'), withManifest(template, appendixFiles));
await writeFile(resolve(deckDir, 'manifest.json'), JSON.stringify({ format: 'v4-meditation-node-deck/v2', generated_at: new Date().toISOString(), node_network: '../../pali-meditation-node-network/meditation-knowledge-graph-v2.json', main_slide_count: mainFiles.length, appendix_slide_count: appendixFiles.length, node_count: graph.nodes.length, edge_count: graph.edges.length, main: mainFiles, appendix: appendixFiles }, null, 2));

const graphHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V4 禅修节点网 · 可审计数据视图</title><style>body{margin:0;background:#f4eee3;color:#30291f;font-family:Georgia,'Songti SC',serif}main{max-width:1320px;margin:auto;padding:44px 26px 90px}h1{font-size:48px}.meta{color:#766a5c;line-height:1.7}.controls{position:sticky;top:0;background:#f4eee3dd;backdrop-filter:blur(12px);padding:14px 0;display:flex;gap:10px;flex-wrap:wrap}input,select{padding:10px 12px;border:1px solid #cdbb9b;border-radius:8px;background:#fffaf2;font:inherit}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.card{background:#fffaf2;border:1px solid #d8c9ae;border-radius:12px;padding:18px;box-shadow:0 8px 18px #50391c12}.card h2{margin:0 0 8px;font-size:22px}.tag{display:inline-block;color:#8b6321;font:13px sans-serif;margin:0 6px 8px 0}.card a{color:#9b5f23}.edge{border-left:3px solid #c89a54;padding-left:12px;margin:12px 0}.small{color:#766a5c;font:14px/1.5 sans-serif}</style><main><h1>V4 禅修节点网</h1><p class="meta">${graph.nodes.length} 个节点 · ${graph.edges.length} 条关系 · 根本经主证据；义注、复注、藏外为独立术语上下文。旧流程图未改写。</p><div class="controls"><input id="q" placeholder="搜索节点、巴利或中文"><select id="layer"><option value="">全部语料上下文</option><option value="root_sutta">根本经主证据</option><option value="commentary">义注上下文</option><option value="subcommentary">复注上下文</option><option value="other">藏外上下文</option></select><select id="kind"><option value="">全部节点类型</option><option value="legacy_spine">旧图主干</option><option value="atomic_member">原子成员</option></select><label><input id="showEdges" type="checkbox"> 显示关系</label></div><section id="nodes" class="grid"></section><section id="edges"></section></main><script>const graph=${JSON.stringify(graph)};const nodeMap=new Map(graph.nodes.map(n=>[n.id,n]));const q=document.querySelector('#q'),layer=document.querySelector('#layer'),kind=document.querySelector('#kind'),show=document.querySelector('#showEdges'),nodesEl=document.querySelector('#nodes'),edgesEl=document.querySelector('#edges');function layerMatch(n){if(!layer.value)return true;if(layer.value===n.evidence.layer)return true;return !!n.layer_evidence?.[layer.value]?.entries?.length}function draw(){const needle=q.value.toLowerCase();const ns=graph.nodes.filter(n=>(!needle||JSON.stringify(n).toLowerCase().includes(needle))&&layerMatch(n)&&(!kind.value||n.kind===kind.value));nodesEl.innerHTML=ns.map(n=>'<article class="card"><div class="tag">'+n.domain_label+' · '+n.kind+'</div><h2>'+n.title+'</h2><div class="small">根本证据：'+n.evidence.uid+' · '+n.evidence.work_id+':'+n.evidence.row_id+' · 上下文：义注 '+(n.layer_evidence?.commentary?.entries?.length||0)+' / 复注 '+(n.layer_evidence?.subcommentary?.entries?.length||0)+' / 藏外 '+(n.layer_evidence?.other?.entries?.length||0)+'</div><p>'+n.note+'</p><a href="'+n.evidence.reader_url+'" target="_blank">打开 V4 原段 ↗</a></article>').join('')||'<p>没有匹配节点。</p>';edgesEl.innerHTML=show.checked?'<h2>关系证据</h2>'+graph.edges.map(e=>'<div class="edge"><b>'+nodeMap.get(e.from).title+' → '+nodeMap.get(e.to).title+'</b>　<span class="tag">'+e.type+'</span><div class="small">'+e.claim+' · '+e.evidence.uid+':'+e.evidence.row_id+'</div><a href="'+e.evidence.reader_url+'" target="_blank">核对关系引文 ↗</a></div>').join(''):'';}
[q,layer,kind,show].forEach(el=>el.addEventListener('input',draw));draw();</script></html>`;
const graphHtmlWithRootLinks = graphHtml
  .replaceAll("href=\"'+n.evidence.reader_url+'\"", "href=\"'+(n.evidence.reader_url.startsWith('#') ? '../../../' + n.evidence.reader_url : n.evidence.reader_url)+'\"")
  .replaceAll("href=\"'+e.evidence.reader_url+'\"", "href=\"'+(e.evidence.reader_url.startsWith('#') ? '../../../' + e.evidence.reader_url : e.evidence.reader_url)+'\"");
await writeFile(resolve(deckDir, 'graph.html'), graphHtmlWithRootLinks);
console.log(JSON.stringify({ main_slides: mainFiles.length, appendix_slides: appendixFiles.length, node_count: graph.nodes.length, edge_count: graph.edges.length }, null, 2));
