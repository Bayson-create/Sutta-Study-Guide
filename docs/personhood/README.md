# 巴利人格过程系统（pali-personhood）

这是一个可审计的“人格—条件过程”实验室，而不是人格测验。运行时把一个遭遇表示为：

`门（六处） → 所缘 → 识/触条件 → 受 → 想/寻思 → 意向/行 → 可观察回应`

五蕴在这里以共同生起的观察标签出现，不是五个排队的实体，也不是固定性格。`pali-canonical/v1` 只显示经藏/律藏核心；`theravada-synthesis/v1` 额外显示明确标注为阿毗达磨/注释传统的系统化视图（例如 `citta-vīthi`）。

## 证据层级

`evidence.js` 是最小可发布注册表。每条事件必须通过 `evidence_ids` 解析到 `EvidenceLink`，并带有层级、原典/研究链接、译文、版本和 locator 占位字段。V4 的 `work_id / row_id / paranum / anchor / source / version` 不能从搜索结果猜测；在 hybrid search 解析到真实行之前保持 `null`，因此界面会显示“待解析”而不伪造深链。

当前核心锚点：SN 12.23（触—受—爱及止息条件）、MN 18（触—受—想—寻思—戏论）、SN 22.59（五蕴与无我）、SN 35.23（六处与“全部”的边界）、MN 10 / DN 22（正念、明觉、起灭观察），以及带有 `abhidhamma` 层级标签的后期心路解释。现代研究材料只作解释语境，不替代巴利原典。

## 研究可复跑性

全量 V4 语料是“可检索覆盖”，不是逐行人工释读的声明。研究日志应记录检索式、日期、索引 manifest、纳入/排除理由、译本/版本和冲突关系。前端 Graphify 已用于检查 `tipitaka-data-worker.js`、V4 manifest、`tipitaka-reader.js`、五蕴/六处/正念资料之间的真实文件关系；后端 Graphify 显示 `SearchIndex`、`Record`、`HybridEngine`、`rrf_merge()`、`V4 authority source` 和 locator contract 的连接。

## 运行规则

- 引擎是确定性的，`seed` 只作为案例包的一部分；相同输入必须得到相同 JSON trace。
- Agent 只能访问自己的内部流；交互中央只接收言语、动作、姿态和共同环境等外化边。
- 人—动物只模拟共享刺激与观察反馈，并显示“动物内在经验不确定”标签。
- “灭”只表示当前局部爱取/反应循环的止息。系统不模拟、评分或认证涅槃、灭尽定、圣果或真实证悟。
- LLM（未来若接入）只能把已验证 trace 转写成讲解，不能决定心理状态、补写引文或跨证据层静默推断。

## 多轮互动与语言讲解

选择 1–6 轮后，`runInteraction` 只把言语、动作、姿态或共同环境等外化结果交给下一轮；任何 agent 的内部字段都不会成为另一 agent 的输入。实验室可向已配置的后端 `POST /api/personhood/explain` 提交当前 trace 与问题，后端先用 Python 确定性引擎重跑，再让受限 AI 解释；请求失败时保留本地 trace，不保存案例或对话。

AI 讲解不是读心、人格诊断、动物经验推断或证悟认证。所有回答都必须服从事件 `evidence_ids` 和三源审计状态；“候选”和“待人工复核”不能显示为已确认。

## 未来 skill 资产

`schema.js`、`engine.js`、`evidence.js` 与后端 `personhood/` Python 镜像构成 `pali-personhood` skill 的输入/输出契约基础。三源审计清单由后端 `scripts/audit_personhood_evidence.py` 生成；只有自动核验和四类 reviewer 签核后，才安装为本机 skill。
