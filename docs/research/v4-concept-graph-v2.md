# V4 知识图谱 v2 发布说明

本版本在不改写 `concept-tfidf-v1`、V4 原文、正式共创图或后端历史的前提下，增加一套版本化、可审计的规范概念统计网络。

## 数据边界

- 保留全部 14,474 个表面概念和 818,110 条原始表面关系。
- 规范层合并词形后另行计算关系；节点和关系均保留来源、统计指标和真实 V4 行证据。
- 中文、English、巴利语（保留变音符与去变音符）都可以检索；去变音符输入只表示正字法折叠，不会把不同词义静默合并。
- 8 种概念类型和 15 种正式关系类型保留在 manifest；统计关系另标为 `cross_document_salience` 或 `local_context_cooccurrence`，不表示教义因果。

## 当前构建状态

本次发布按最新授权跳过 AI 审核门禁，使用词典提示与保守的可审计正字法/词形规则生成完整静态投影。所有概念和关系仍然发布，不因没有 AI 审核而隐藏；数据中的 `ai_audit_status: "not_run"`、`v2_audit_status: "not_ai_audited"`、`translation_status: "rule_only"` 明确表示这一状态，页面也会显示“未完成 AI 审核（全量展示）”。这不是 `ai_verified` 结果，也不应被解读为已经完成语义归并审校。

V4 引文始终由本地归档逐行回读并重新计算哈希。浏览器运行时不调用模型；后续在具备 GPU 的环境完成两轮 GPT 审核后，可以用新的不可变数据版本替换当前规则版，而不改变前端协议。

```text
python3 scripts/build_v4_concept_graph_v2.py \
  --archive /path/to/Tipitaka-Reader-V4-Archive/2025-12-04-windows-x64 \
  --v1-dir /path/to/concept-tfidf-v1 \
  --skip-ai \
  --output /path/to/concept-graph-v2
```

即使使用 `--skip-ai`，构建仍会强制检查表面概念/关系完整、翻译字段非空、关系可回到真实 V4 行，并记录每个文件哈希；AI 未运行只影响审核状态，不影响全量展示。若使用完整 GPT 两轮缓存，则仍会检查模型、思考强度和缓存完整性。

## 运行时与成本

前端只读取 `manifest.json`、`concepts.json.gz` 和当前概念所需的 `adjacency/` 有界邻接分片；不下载全量正文或全量关系。`relations/` 与 `raw-relations/` 仍完整发布，用于分页审计和未来按需工具，但普通概念详情不会扫描它们，因此高频概念也不会把浏览器拖入全库解析。数据使用现有 Blob 的不可变版本路径 `tipitaka/v1/concept-graph-v2/`，不增加 Azure AI Search、数据库、CDN 或常驻服务。

## 本次全量展示约定

规范目录按页展示全部 `canonical_concepts`，每个概念保留 `surface_forms`、别名、统计指标和 V4 证据；关系详情通过“加载更多关系”直至该概念的全部邻接。原始词形和原始关系不因未完成 AI 审核而隐藏，页面只显示“未完成 AI 审核（全量展示）”状态标记。当前版本的归并、中文/英文标签属于规则与词典投影，不是 GPT 审核结论；后续 AI 审核应通过新的不可变版本替换，而不是覆盖本版本。
