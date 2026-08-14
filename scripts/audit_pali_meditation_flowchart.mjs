#!/usr/bin/env node

/* Reproducible audit of the historical SVG flowchart and its viewer. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const svgPath = resolve(root, 'docs/research/assets/pali-meditation-flowchart.svg');
const viewerPath = resolve(root, 'docs/research/pali-meditation-flowchart-viewer.html');
const outPath = resolve(root, 'docs/research/pali-meditation-lecture/flowchart-audit.md');
const svg = await readFile(svgPath, 'utf8');
const viewer = await readFile(viewerPath, 'utf8');
const matches = (pattern, value = svg) => [...value.matchAll(pattern)];
const unique = values => [...new Set(values)];
const refMatches = unique(matches(/\b(?:DN|MN|SN|AN|Iti|Ud)\s*\d+[A-Za-z\d.-]*/g).map(item => item[0]));
const externalLinks = matches(/href=["']([^"']+)["']/g).map(item => item[1]).filter(value => /suttacentral/i.test(value));
const nodeCount = matches(/class=["'][^"']*\bn\b[^"']*["']/g).length;
const noteCount = matches(/class=["'][^"']*\bnote note-\d+\b[^"']*["']/g).length;
const tipCount = matches(/class=["'][^"']*\blocal-tip\b[^"']*["']/g).length;
const embeddedAsImage = /<img[^>]+pali-meditation-flowchart\.svg/i.test(viewer);
const hasInlineSvg = /<svg[\s>]/i.test(viewer);
const hasTextLayer = /<text[\s>]/i.test(viewer) || /data-(?:node|text|citation)/i.test(viewer);
const report = `# 巴利三藏禅修旧流程图审计

生成文件：\`scripts/audit_pali_meditation_flowchart.mjs\`
审计对象：\`docs/research/assets/pali-meditation-flowchart.svg\` 与 \`docs/research/pali-meditation-flowchart-viewer.html\`

## 可见结构盘点

| 项目 | 数量 / 结论 |
|---|---:|
| SVG 节点（class \`n\`） | ${nodeCount} |
| 注释组（class \`note note-N\`） | ${noteCount} |
| 本地提示组（class \`local-tip\`） | ${tipCount} |
| 外部 SuttaCentral 链接 | ${externalLinks.length} |
| 不同经号文本引用 | ${refMatches.length} |
| viewer 是否将 SVG 作为 \`<img>\` 嵌入 | ${embeddedAsImage ? '是' : '否'} |
| viewer 是否含内联 SVG / 可检索文本层 | ${hasInlineSvg || hasTextLayer ? '有' : '无'} |

## 已确认的不完善之处

1. **文本不可检索。** viewer 通过 \`<img src="...svg">\` 显示整张图；浏览器只能把它当作一张位图/矢量图片，无法搜索节点标题、提示项和经号。
2. **图内链接不可交互。** 原 SVG 内部虽然保留外部 \`href\`，但嵌入为图片后，点击不会进入这些链接；viewer 自己也没有将节点映射为可访问链接。
3. **首屏信息密度过低。** 为适配整张 ${'3370pt × 3434pt'} 图，默认 fit scale 会把正文缩到不可读；用户必须放大、拖动，且难以知道当前所在章节。
4. **证据边界不显式。** 节点与提示混在同一条视觉流中，没有把根本三藏、义注、复注、藏外典籍分层展示，也没有绑定 V4 的 \`work_id + row_id\` 与稳定三语锚点。
5. **“路径”语义有风险。** 线性连线容易被理解为所有修行者都必须依次经过的单一路径；实际经文包含不同所缘、定、念处、梵住和观慧的并行展开，以及注释层的解释。
6. **完整性不可复核。** 当前 SVG 可以盘点节点、提示与经号，但没有“177 条经文”逐条清单、查询词、分页总数、去重关系、纳入／排除理由和可回读定位。

## 升级原则

- 保留旧 SVG 作为“流程图／历史参考”，不改写原始资产。
- 新“讲座”使用 HTML 文本和结构化证据卡；每条候选保留完整三语行、层级、命中词、位置、行号与 Pāli／English 哈希。
- 只有通过逐条人工审核的证据进入主讲页与附录；未审核候选保持明确状态，不冒充结论。
- 语义相关但没有原词时只定位真实段落并显示“语义相关”，不伪造文本高亮。

## 当前实现状态

- 已新增同页“讲座／流程图”切换，默认进入讲座，旧链接通过 \`?view=flowchart\` 保持可用。
- 已新增 109 条跨语言、跨主题受控召回词簇和可恢复全游标采集器；完整采集与逐条审核仍是后续发布门槛。
- 已新增三套两页真实视觉方向展示稿；最终主讲 deck 和全量附录将在选定方向后批量生成。
`;
await writeFile(outPath, report, 'utf8');
console.log(JSON.stringify({ out: outPath, nodeCount, noteCount, tipCount, externalLinks: externalLinks.length, uniqueReferences: refMatches.length, embeddedAsImage, hasInlineSvg, hasTextLayer }, null, 2));
