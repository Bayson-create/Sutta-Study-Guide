#!/usr/bin/env node

/**
 * Creates a source inventory for the legacy meditation SVG.  This deliberately
 * does not infer doctrine: it only pairs each displayed node with the
 * SuttaCentral references printed immediately beneath it in the original SVG.
 * The inventory is the publication gate for the replacement lecture network.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const svgFile = resolve(root, 'docs/research/assets/pali-meditation-flowchart.svg');
const outDir = resolve(root, 'docs/research/pali-meditation-node-network');
const clean = value => String(value ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const svg = await readFile(svgFile, 'utf8');
const nodes = [...svg.matchAll(/<text[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*class="n"[^>]*>([\s\S]*?)<\/text>\s*<text[^>]*class="s"[^>]*>([\s\S]*?)<\/text>/g)]
  .map(match => ({ x: Number(match[1]), y: Number(match[2]), label: clean(match[3]), summary: clean(match[4]) }));
const refs = [...svg.matchAll(/<a\s+xlink:href="([^"]+)"[^>]*>\s*<text[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*class="ref"[^>]*>([\s\S]*?)<\/text>\s*<\/a>/g)]
  .map(match => ({ url: clean(match[1]), x: Number(match[2]), y: Number(match[3]), ref: clean(match[4]) }));
const metaNodes = new Set(['读图说明', '严格审计补充：经藏中出现但不宜塞进单一路径主线的法数/能力']);

// References are typeset in an immediately following 13–60px band.  When
// several nodes share a row, nearest horizontal centre breaks the tie.
const inventory = nodes.map((node, index) => {
  const candidates = refs.filter(ref => ref.y > node.y + 20 && ref.y < node.y + 110);
  const own = candidates.filter(ref => {
    const nearest = nodes
      .filter(other => ref.y > other.y + 20 && ref.y < other.y + 110)
      .sort((a, b) => Math.abs(a.x - ref.x) - Math.abs(b.x - ref.x))[0];
    return nearest === node;
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  return {
    ordinal: index + 1,
    label: node.label,
    summary: node.summary,
    position: { x: node.x, y: node.y },
    node_kind: metaNodes.has(node.label) ? 'meta' : 'substantive',
    legacy_references: own.map(({ ref, url }) => ({ ref, url })),
  };
});
const unassigned = refs.filter(ref => !inventory.some(item => item.legacy_references.some(candidate => candidate.url === ref.url && candidate.ref === ref.ref)));
if (unassigned.length) throw new Error(`有 ${unassigned.length} 条旧图引文不能唯一归属节点`);
if (inventory.filter(item => item.node_kind === 'substantive').length !== 68) throw new Error('旧图实质节点数不是预期的 68');
if (inventory.filter(item => item.node_kind === 'substantive' && item.legacy_references.length === 0).length) throw new Error('存在没有旧图引文的实质节点');

await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'legacy-node-source-inventory-v1.json'), `${JSON.stringify({
  format: 'legacy-meditation-source-inventory/v1',
  source_svg: 'docs/research/assets/pali-meditation-flowchart.svg',
  node_count: inventory.length,
  substantive_node_count: inventory.filter(item => item.node_kind === 'substantive').length,
  meta_node_count: inventory.filter(item => item.node_kind === 'meta').length,
  reference_count: refs.length,
  unique_reference_count: new Set(refs.map(ref => ref.ref)).size,
  nodes: inventory,
}, null, 2)}\n`);
console.log(JSON.stringify({ nodes: inventory.length, substantive: inventory.filter(item => item.node_kind === 'substantive').length, refs: refs.length, unassigned: unassigned.length }, null, 2));
