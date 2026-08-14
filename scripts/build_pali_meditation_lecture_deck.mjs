#!/usr/bin/env node

/* Build the A-style HTML lecture and a separate full citation appendix. */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const sourceDir = resolve(root, 'docs/research/pali-meditation-evidence');
const deckDir = resolve(root, 'docs/research/pali-meditation-lecture/deck');
const mainSlidesDir = resolve(deckDir, 'slides');
const appendixSlidesDir = resolve(deckDir, 'appendix/slides');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const safeName = value => String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'item';
const layerLabel = row => row.corpus_layer_label || row.path?.[0] || '未分类';
const clip = (value, max = 240) => { const clean = text(value); return clean.length <= max ? clean : clean.slice(0, max); };
const citationHref = row => row.reader_url || `https://bayson-create.github.io/Sutta-Study-Guide/#/tipitaka/read/${encodeURIComponent(row.work_id)}?row=${row.row_id}`;

function splitText(value, max = 680) {
  const clean = String(value ?? '').trim();
  if (!clean) return ['（该语言字段为空）'];
  const parts = [];
  for (let offset = 0; offset < clean.length; offset += max) parts.push(clean.slice(offset, offset + max));
  return parts;
}

function page({ number, total, kicker, title, subtitle = '', body, css = '../theme.css' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${esc(css)}"></head><body><main class="slide"><div class="kicker"><span>${esc(kicker)}</span><span>${String(number).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></div><div class="rule"></div>${body}${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}<div class="foot">V4 全层禅修经证讲座 · 经卷式学术编年 · HTML source</div></main></body></html>`;
}

function citationCard(row, { full = false, part = 1, parts = 1 } = {}) {
  const title = `${row.title || row.work_id} · ${row.paranum || row.row_id}`;
  const line = full ? '' : `<div class="citation-part">完整行 ${part} / ${parts}；长行在附录连续页完整呈现。</div>`;
  return `<section class="quote-card citation-card"><div class="label">${esc(row.evidence_class || 'evidence')} · ${esc(layerLabel(row))}</div><h3>${esc(title)}</h3><div class="path">${esc((row.path || []).join(' / '))} · work_id=${esc(row.work_id)} · row_id=${esc(row.row_id)}</div><blockquote class="pali">${esc(full ? row.text_pali : clip(row.text_pali))}</blockquote><blockquote class="zh">${esc(full ? row.text_zh : clip(row.text_zh))}</blockquote><blockquote class="en">${esc(full ? row.text_en : clip(row.text_en))}</blockquote>${line}<div class="citation"><strong>ANCHOR</strong>　Pāli ${esc(row.anchor_hashes?.pali || '')} · English ${esc(row.anchor_hashes?.english || '')}<br><strong>READER</strong>　<a href="${esc(citationHref(row))}">${esc(citationHref(row))}</a></div></section>`;
}

const chapters = [
  ['conditions', '条件与生活基础', ['practice_context', 'hindrances']],
  ['hindrances', '五盖与对治', ['hindrances']],
  ['objects', '所缘、业处与方法', ['object', 'recollection']],
  ['anapanasati', '安般念：呼吸作为所缘', ['ānāpāna']],
  ['satipatthana', '四念处：身、受、心、法', ['satipaṭṭhāna']],
  ['brahmavihara', '梵住与无量心', ['brahmavihāra']],
  ['jhana', '定与四禅', ['jhāna', 'samādhi']],
  ['formless', '无色定与灭尽', ['formless', 'nirodha']],
  ['bojjhanga', '觉支与觉醒条件', ['bojjhaṅga', 'awakening']],
  ['vipassana', '观慧、三相与解脱', ['vipassanā', 'insight']],
  ['emptiness', '空、无相、无愿', ['emptiness']],
];

function pick(rows, categories, offset = 0) {
  const candidates = rows.filter(row => categories.some(category => row.categories?.includes(category)) && row.evidence_class !== 'lexical_context_requires_review');
  return candidates[offset % Math.max(1, candidates.length)] || rows[offset % Math.max(1, rows.length)];
}

function mainSlideBodies(rows) {
  const result = [];
  result.push({ kicker: 'V4 全层禅修经证讲座', title: '从戒到慧：禅修经证的层级阅读', body: `<h1>从<span>戒</span>到<span>慧</span><br>禅修经证的层级阅读</h1><p class="subtitle">以巴利、简体中文、英文三语原文为证据，重画一张不把“路径”误读成“必经次第”的地图。</p><div class="cover-meta">90 分钟深度课 · V4 全层语料<br>根本三藏 · 义注 · 复注 · 藏外典籍</div><div class="seal">讲座<br>V4</div>` });
  result.push({ kicker: '引子 · 为什么重做', title: '一条线，可能掩盖四种证据', body: `<h1>流程图是入口，<br><em>原文才是证据</em>。</h1><p class="subtitle">旧 SVG 适合概览，却不能承担逐句核查：节点文本不可检索、图内链接不可点击、证据层级不显式。</p><div class="cover-meta">本讲座保留旧流程图为历史参考<br>把 work_id + row_id、三语文本与稳定锚点放回主体</div>` });
  result.push({ kicker: '方法 · 全量召回', title: '先把候选找全，再谈相关性', body: `<div class="evidence-layout"><section class="side"><div class="label">RETRIEVAL CONTRACT</div><h2>109 个受控词条<br>× 四层语料<br>× 全部游标</h2><p>巴利、中文、英文分别走文字检索通道；同一行多词命中合并，不丢失来源词、位置和层级。</p></section><section class="quote-card"><div class="label">审计原则</div><blockquote class="zh">关键词命中只是候选，不自动等于“禅修证据”。</blockquote><div class="citation"><strong>保留</strong>　完整三语行、上下文、作品路径、段号、命中位置、Pāli／English SHA-256<br><strong>拒绝</strong>　只含宽泛词语、缺少真实行号或锚点无法复核的结论</div></section></div>` });
  result.push({ kicker: '全量库 · 可复核', title: '讲座是入口，证据库负责完整', body: `<h1>147,224 条候选行<br><em>全部保留，分层阅读</em></h1><p class="subtitle">机器规则将全量命中分为“直接修习／条件与观慧／词汇相关待复核”。演讲附录展示跨主题、跨层级的精选核验页；完整三语候选可在证据索引中检索，并逐行回到 V4 阅读器。</p><div class="cover-meta">主讲页：脉络与方法<br>附录页：代表性三语引文<br>证据索引：全量候选、命中词、层级与稳定深链</div></div>` });
  result.push({ kicker: '证据边界 · 四层语料', title: '并列呈现，不混为一谈', body: `<h1>根本、义注、复注、藏外<br><em>各自说明自己是谁</em></h1><p class="subtitle">同一个禅修术语在不同层级有不同证据地位；讲座不把注释层的解释改写成根本经文。</p><div class="layers"><div class="layer mula">层 1 · 根本三藏 Mūla</div><div class="layer commentary">层 2 · 义注 Aṭṭhakathā</div><div class="layer">层 3 · 复注 Ṭīkā</div><div class="layer">层 4 · 藏外典籍 Añña</div></div>` });
  result.push({ kicker: '阅读说明 · 多条支路', title: '不是一条必经路线', body: `<h1>从条件开始，<br>向不同所缘展开</h1><p class="subtitle">戒、远离、五盖、业处、安般、念处、梵住、禅那与观慧在不同文本中以不同结构出现。流程图只作索引，不作规范化次第。</p><div class="cover-meta">读者要问的是：这条引文在说什么？<br>它属于哪一层？它能回到哪一行？</div>` });
  for (const [id, title, categories] of chapters) {
    const row = pick(rows, categories, 0);
    result.push({ kicker: `主题 · ${title}`, title, body: row ? `<div class="evidence-layout"><section class="side"><div class="label">${esc(id.toUpperCase())}</div><h2>主题不是<br>一个词。</h2><p>从术语簇进入实际段落；先看完整三语，再根据层级和上下文决定它能支持哪一种论断。</p><div class="layers"><div class="layer ${row.corpus_layer === 'mula' ? 'mula' : ''}">${esc(layerLabel(row))}</div><div class="layer">${esc((row.path || []).slice(1).join(' / '))}</div></div></section>${citationCard(row)}</div>` : `<h1>${esc(title)}</h1><p class="subtitle">当前证据库没有通过结构校验的候选；保留章节位置，等待复核。</p>` });
  }
  result.push({ kicker: '质量门槛 · 引文核验', title: '每一条引用都必须能回家', body: `<h1>从讲义回到<br><em>实际阅读器行</em></h1><p class="subtitle">引用不只显示经号：它携带作品、行号、段号、命中语言、查询词和 Pāli／English 哈希。中文覆盖层改变时，仍用稳定锚点重新确认。</p><div class="cover-meta">缺少锚点 → 不发布为已核验引文<br>锚点不唯一 → 明确标记“待复核”，绝不跳错</div>` });
  result.push({ kicker: '结语 · 研究与实践', title: '把地图交还给原文', body: `<h1>看见路径，<br>也看见<span>边界</span>。</h1><p class="subtitle">更好的禅修阅读器不是替经文下结论，而是让人更快找到原文、分辨层级、检验自己的理解。</p><div class="cover-meta">主讲页：方法与主题脉络<br>附录页：每条通过结构校验的三语证据</div><div class="seal">回到<br>原文</div>` });
  return result;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(sourceDir, 'manifest.json'), 'utf8'));
  let audited;
  try {
    audited = JSON.parse(await readFile(resolve(sourceDir, 'audited-evidence.json'), 'utf8'));
  } catch {
    const shardIndex = JSON.parse(await readFile(resolve(sourceDir, 'evidence-shards.json'), 'utf8'));
    audited = [];
    for (const shard of shardIndex.files || []) audited.push(...JSON.parse(gunzipSync(await readFile(resolve(sourceDir, shard.file))).toString('utf8')));
  }
  if (!Array.isArray(audited) || !audited.length) throw new Error('audited-evidence.json 为空');
  await mkdir(mainSlidesDir, { recursive: true }); await mkdir(appendixSlidesDir, { recursive: true });
  const mainBodies = mainSlideBodies(audited);
  const mainFiles = [];
  for (let index = 0; index < mainBodies.length; index += 1) {
    const item = mainBodies[index];
    const file = `slides/${String(index + 1).padStart(2, '0')}-${safeName(item.title)}.html`;
    await writeFile(resolve(deckDir, file), page({ number: index + 1, total: mainBodies.length, kicker: item.kicker, title: item.title, body: item.body }), 'utf8');
    mainFiles.push({ file, label: item.title });
  }
  const appendixFiles = [];
  const appendixPages = [];
  // A readable 90-minute lecture cannot turn every broad lexical hit into a
  // separate PDF page. Keep the complete machine-screened corpus in the
  // evidence index and select a deterministic, cross-layer citation set for
  // the slide appendix: up to eight strongest rows per query category/layer.
  const appendixRows = [];
  const selected = new Set();
  const buckets = new Map();
  for (const row of audited.filter(item => item.evidence_class !== 'lexical_context_requires_review')) {
    for (const category of row.categories || []) {
      const key = `${category}:${row.corpus_layer || row.corpus_layer_label}`;
      const bucket = buckets.get(key) || [];
      bucket.push(row);
      buckets.set(key, bucket);
    }
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => (b.query_hits?.length || 0) - (a.query_hits?.length || 0) || `${a.work_id}:${a.row_id}`.localeCompare(`${b.work_id}:${b.row_id}`));
    for (const row of bucket.slice(0, 8)) selected.add(row.evidence_id);
  }
  for (const row of audited) if (selected.has(row.evidence_id)) appendixRows.push(row);
  let slideNo = 0;
  for (const row of appendixRows) {
    const paliParts = splitText(row.text_pali), zhParts = splitText(row.text_zh), enParts = splitText(row.text_en);
    const parts = Math.max(paliParts.length, zhParts.length, enParts.length);
    for (let part = 0; part < parts; part += 1) {
      slideNo += 1;
      const body = `<div class="appendix-heading"><div class="label">APPENDIX · ${esc(row.evidence_class)}</div><h2>${esc(row.title || row.work_id)} · ${esc(row.paranum || row.row_id)}</h2><p>${esc(layerLabel(row))} · ${(row.path || []).map(esc).join(' / ')} · 第 ${part + 1} / ${parts} 页</p></div><section class="quote-card citation-card"><blockquote class="pali">${esc(paliParts[part] || '')}</blockquote><blockquote class="zh">${esc(zhParts[part] || '')}</blockquote><blockquote class="en">${esc(enParts[part] || '')}</blockquote><div class="citation"><strong>EVIDENCE</strong>　${esc(row.evidence_id)} · ${esc(row.work_id)}:${esc(row.row_id)}<br><strong>ANCHOR</strong>　Pāli ${esc(row.anchor_hashes?.pali || '')} · English ${esc(row.anchor_hashes?.english || '')}<br><strong>READER</strong>　<a href="${esc(citationHref(row))}">${esc(citationHref(row))}</a></div></section>`;
      const file = `appendix/slides/${String(slideNo).padStart(5, '0')}-${safeName(row.evidence_id)}-${part + 1}.html`;
      const item = { file: `slides/${String(slideNo).padStart(5, '0')}-${safeName(row.evidence_id)}-${part + 1}.html`, label: `${row.work_id}:${row.row_id} · ${part + 1}/${parts}` };
      appendixFiles.push(item); appendixPages.push({ file, title: `${row.title || row.work_id} · ${row.row_id}`, body });
    }
  }
  for (let index = 0; index < appendixPages.length; index += 1) {
    const item = appendixPages[index];
    await writeFile(resolve(deckDir, item.file), page({ number: index + 1, total: appendixPages.length, kicker: '全量引文附录', title: item.title, body: item.body, css: '../../theme.css' }), 'utf8');
  }
  const deckIndex = await readFile(resolve(root, 'docs/research/pali-meditation-lecture/deck/index.html'), 'utf8');
  const appendixIndex = await readFile(resolve(root, 'docs/research/pali-meditation-lecture/deck/appendix/index.html'), 'utf8');
  const manifestLiteral = JSON.stringify(mainFiles, null, 2);
  const appendixLiteral = JSON.stringify(appendixFiles, null, 2);
  await writeFile(resolve(deckDir, 'index.html'), deckIndex.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, `window.DECK_MANIFEST = ${manifestLiteral};`).replace('window.DECK_WIDTH = 1920;', "window.DECK_OVERVIEW = 'grid';\n  window.DECK_WIDTH = 1920;"), 'utf8');
  await writeFile(resolve(deckDir, 'appendix/index.html'), appendixIndex.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, `window.DECK_MANIFEST = ${appendixLiteral};`).replace('window.DECK_WIDTH = 1920;', "window.DECK_OVERVIEW = 'grid';\n  window.DECK_WIDTH = 1920;"), 'utf8');
  const deckManifest = { format: 'v4-meditation-lecture-deck/v1', generated_at: new Date().toISOString(), source: manifest, main_slide_count: mainFiles.length, appendix_slide_count: appendixFiles.length, appendix_evidence_count: appendixRows.length, full_evidence_count: audited.length, appendix_selection: { rule: '非词汇待复核项中，每个查询类别×语料层最多 8 条，按命中词数和稳定定位排序', selected_rows: appendixRows.length }, main: mainFiles, appendix: appendixFiles, note: '完整机器筛选候选保存在证据索引；幻灯片附录为跨主题、跨层级的可讲授精选集，所有条目仍需人工经文审核后才能成为最终定稿引文。' };
  await writeFile(resolve(deckDir, 'deck-manifest.json'), JSON.stringify(deckManifest, null, 2), 'utf8');
  console.log(JSON.stringify({ main_slides: mainFiles.length, appendix_slides: appendixFiles.length, appendix_evidence: appendixRows.length, full_evidence: audited.length }, null, 2));
}

await main();
