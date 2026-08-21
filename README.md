# Sutta Study Guide

巴利语三藏经文学习指南 — 按主题整理的经文索引与三语阅读器

Pāli Canon Study Guide with trilingual reader (Pāli · English · Chinese)

请通过链接 https://bayson-create.github.io/Sutta-Study-Guide/ 访问。

## Features

- **6 thematic guides** with 661 suttas:
  - ☸️ The Buddha's Life & Experience (佛陀个人经历与经验)
  - 📖 Key Terms & Concepts (术语与概念)
  - 🏠 For Lay Practitioners (在家众相关)
  - 🧘 Meditation Practice (禅修相关)
  - 🎭 Expression & Rhetoric (表达、表现与修辞手法)
  - 🧩 Language Traps & Responses (语言陷阱与处理方式)
- **Trilingual reader** fetching live from SuttaCentral API:
  - Pāli-English line-by-line (default)
  - Pāli-Chinese side by side
  - English-Chinese bilingual comparison
  - English only / Chinese only
  - Toggle Pāli visibility
  - Simplified/Traditional Chinese conversion

## 功能详解

首页六个入口分别是什么、解决什么问题——不是营销介绍，是实际机制说明。

### 🙏 问问乔达摩先生（`#/gotama`）

**功能**：不是套壳 ChatGPT，是一个真正的多轮工具调用 agent（后端 `sutta-study-guide-backend/api/app/gotama/agent_loop.py`）。每一轮先让 DeepSeek 决定要不要调用工具，可用工具有四个：`search_early_buddhist`（对站内三十五万余段巴利三藏做 BM25 全文检索，不是靠模型记忆背诵）、`web_search`、`web_fetch`、`read_skill_reference`（读一份白名单调研底稿）。每条可引用的结论都能追溯到一次真实检索命中，前端渲染成可点击的引文徽章，点开直达经文原文，而不是模型自己编出来的引用。设有硬性熔断（最多 30 轮迭代、单轮不超过 240 秒）防止失控循环；长回合走后台任务系统，关闭标签页也能续上、不丢进度。

**意义**：普通 LLM 聊天的"引用"经常是编的、查不到出处。这里把"回答"和"检索"拆开、用代码强制回答必须挂靠在真实检索结果上，把可信度的责任从"模型记不记得住"转移到"检索系统找不找得到"——后者是可验证、可审计的。

### 🧬 法义溯源（`#/dhamma`）

**功能**：给一句话或一个观点，沿八层历史脉络（早期经律 → 早期注释 → 部派阿毗达磨 → 部派系统论书 → 大乘核心经论 → 成熟大乘系统 → 宗派体系 → 现代法师）逐层检索比对。AI 模式（`/api/dhamma/trace`）的 Prompt 硬性要求"绝对不能编造任何未在检索结果中出现的引文"，某一层查无相关内容必须明说"未检索到"，而且要求同时标出**纵向分歧**（后期层对早期源头的重新诠释）和**横向分歧**（同一层内部不同文本互相矛盾）。另有不需要登录、纯客户端二元语法（bigram）检索的关键词模式，作为不依赖 AI 的兜底。

**意义**：很多流行的"佛法金句"其实是后人层层加工、甚至现代人自己总结出来又安回佛陀名下的。这个功能不给一个笼统的"共识答案"，而是刻意保留、暴露教义在历史中演变分歧的过程——查无内容就是查无内容，不用一层的资料去填补另一层的空白。

### 🧭 人格过程实验室（`#/personhood`）

**功能**：把用户描述的一次真实人际互动，按《蜜丸经》（MN 18）的缘起链逐节点分析——门 → 所缘 → 识 → 触 → 受 → 想 →（寻 → 戏论 → 戏论想念 → 爱 → 取 → 有 → 身语意业）。两个版本可切换：**经律原典版**严格按经文字面顺序展开；**分层整合版**按《摄阿毗达磨义论》把触/受/想/思/作意处理为同时俱起，并加一个专门的"心路"（citta-vīthi）节点，判定是五门心路还是意门心路、展开完整的心识刹那序列。后端是逐节点独立调用 LLM（不是一次性生成一整段），每个节点限定输出词表和槽位，引用只能来自当轮实际检索到的经文（检索词来自固定注册表，不是模型自由搜索），生成后代码还会校验引用 ID 确实存在于检索结果里。

**意义**：把"用佛法分析我的一次人际冲突"这件事从"问 AI、它随便说点什么"变成一套受约束、可审计的分析流水线——固定的阿毗达磨节点词表、代码强制的引用真实性、两套可切换的教义视角，让分析结果站得住脚，而不是听起来有道理但查无实据。

### 📚 巴利三藏阅读器 V4（`#/tipitaka/read/...`）

**功能**：217 部作品（藏经/义注/复注/其他），巴利·简体中文·English 三语并列，另附 26 部辞典（243 万余词条）和 634 个专有名词索引。全部内容静态预烘焙成 JSON 分片存在 Azure Blob Storage，由后台 Web Worker 加载，用 Cache API + IndexedDB 做离线缓存。阅读器的虚拟滚动用 **Fenwick（树状数组）树**维护变长行高的精确坐标系，应对义注夹注行远比正文行长得多的问题。检索是独立的 Web Worker：中文按二元语法（bigram）切词，巴利/英文按规范化单词处理；每个词条按 **SHA-256 哈希分桶到 256 个分片**（中文）或按前两个字符分桶（巴利/英文），任何一次检索只需要拉取很小的一个分片文件，检索速度不随语料库总量增长而变慢。

**意义**：和直接用 SuttaCentral 网站比，这里做到了三件它做不到的事——**完全离线可用**（数据在本地缓存里，断网也能读）、**横跨整个语料库（含辞典和义注）的真正全文检索**（不是只能搜到已知作品名再进去翻）、以及**义注/复注内联链接到对应根本文位置**（读正文时commentary 就在旁边，不用来回切换页面）。

### 🔍 个人研究（`#/research`）

**功能**：不是"我的笔记/收藏"（那些在 `#/profile` 里），而是站主自己撰写的长篇研究文集——逐章巴利原典研读、跨体系（含藏传道次第）阿毗达磨对照矩阵、28 个核心法义概念解析、《大史》全文翻译/摘要、引用 177 部经的互动式禅修流程图、菩提比丘文章摘要合集，部分文章还有专属的独立阅读器（比如清净道论）。

**意义**：三藏原典之外，佛法研习经常需要跨文本、跨体系的综合梳理——这些是站主自己动手做的这类二手研究，和原典阅读器互补，不是把三藏原文再倒腾一遍。

### 💬 社区（`#/qa` `#/forum` `#/blog` `#/profile`）

**功能**：真正的用户生成内容，独立的私有后端仓库（`sutta-study-guide-backend`）里各自有完整的增删改查（`routers/{qa,forum,blog}.py`）。登录用户可以发问题、开论坛话题、写博客、回复点赞，编辑/删除权限受所有者/管理员校验约束。

**意义**：把"阅读三藏"和"讨论三藏"放在同一个站点里——不用另外去找一个论坛或者微信群，学习中遇到的具体问题可以直接在同一个上下文里提问讨论。

## Data Source

All sutta texts are fetched from [SuttaCentral](https://suttacentral.net) API.

## Vism / 破戏疏逐句重译脚本（`scripts/retranslate_vism_chapter.py`）

`docs/research/vism-data/` 下《清净道论》各章、以及 `docs/research/pali-source-texts/sutta/majjhima/papancasudani/` 下《破除戏论疏》三部分的逐句中译，由 `scripts/retranslate_vism_chapter.py` 通过站点自己的 `/api/mitra/translate` 代理调用 Dharmamitra 批量生成/替换，直接写入生产译文覆盖层（`PUT /api/translations/{doc_key}/{unit_key}`）。下面记录三件事：Dharmamitra API 本身的字段含义、**实测得到的限流行为**（决定了脚本必须怎么写）、以及脚本的用法和在新设备上重新部署这条流水线的方式。

### Dharmamitra API：端点与字段含义

我们调用的不是网站内部的流式接口（那个和网页会话绑定，不适合服务器对服务器调用），而是 Dharmamitra 自己的 Claude Code 脚手架（github.com/dharmamitra/dharmamitra-claude-code-agent）在用的同一个端点：

```
POST https://dharmamitra.org/api-search/cat-translate/v1/translate
```

无需鉴权，同步 JSON。请求体（`sutta-study-guide-backend/api/app/dharmamitra.py`）：

| 字段 | 值 | 含义 |
|---|---|---|
| `input_pali` | 待译巴利语原文 | 唯一填的源语言字段 |
| `input_tibetan` / `input_chinese` / `input_sanskrit` | 始终为空字符串 | 明确排除这些源语言，防止模型把术语误判成梵语/藏语拼写而非巴利语 |
| `context` | 如「清净道论 第17品 ...」/「《破除戏论疏》第1部分 Mūlapariyāyasuttavaṇṇanā」 | 给模型的上下文提示，不影响译文语言/风格判定 |
| `focus` | 固定 `"pali"` | 告诉模型以巴利语为源语言解析，这是巴利术语（而非梵语拼写）被正确识别注音的关键设定 |
| `target_language` | 固定 `"modern chinese"` | 目标是现代汉语，不是文言 |
| `style_instruction` | **单句翻译时完全不设**；仅批量翻译时设为固定的编号格式说明（不涉及文风） | 早期版本这里曾经固定填「保持原文的庄重语气」导致译文偏文言，现已移除（见下）——现在单句请求用的是 Dharmamitra 的纯默认风格 |

响应：`{"translation": "..."}`（已经是简体，无需额外转换）。

我们自己的后端在这之上包了两层：`POST /api/mitra/translate`（登录用户可调，每用户滑动窗口限流，见下，结果按 `pali+context+batch` 做内存缓存）和 `POST /api/mitra/cache`（写入型端点，供浏览器直连 Dharmamitra 成功后把结果登记进同一个缓存，不产生新的上游请求，用于把编辑各自的出口 IP 分散开、不都挤占服务器代理的配额）。

### 两层限流，性质完全不同

1. **我们自己后端的限流**（`sutta-study-guide-backend/api/app/routers/translations.py`，`_MITRA_RATE_MAX_CALLS`）：每用户滑动窗口 12 次/60 秒。脚本内 `WindowLimiter` 镜像了这个窗口并主动限制在 10 次/60 秒（留安全余量），触发时后端返回 HTTP 429，脚本能明确识别、按窗口剩余时间精确回退。**这层从未在实测中真正触发过**（`RATE LIMITED (429)` 计数在多次长跑中始终为经过窗口限制器后剩余的少量正常重试，不是这层限流失效导致的雪崩）。

2. **Dharmamitra 自己的硬配额**——这是实测中真正造成问题的一层，且**和上面那层限流表现完全不同**：
   - 请求本身正常往返、拿到 HTTP 200 或 502，**我们自己的限流器完全感知不到**（502 是我们后端把上游的 `429 Too Many Requests` 包装转发的结果，不是我们自己拒绝）。
   - **实测轮廓**：稳定 10/min 的调用速度下，约 **25 分钟（约 250 次调用）后**配额耗尽；耗尽后**连续 897 次请求全部失败**，持续了整个 90 分钟的观测窗口都没有恢复；约 **2 小时后**探测请求恢复成功。
   - 是不是精确的"250 次"或"2 小时"边界，我们没有做更细的二分实验去确认——上面是唯一一次完整实测的观测区间，**不代表官方承诺的配额数值**，仅供设计冷却策略参考。
   - 单句本身没有长度限制：语料中最长的一段（49,845 字符 / 6,256 词）在配额窗口内完整译出、无截断，见脚本历史提交里的验证记录。

### 应对：基于连续失败次数判定，而非固定重试

脚本不区分"这是配额耗尽"还是"这是网络抖动"——两者在客户端看起来完全一样。做法是：**连续失败达到阈值（5 次）就判定为系统性问题**，进入 120 秒起步、失败一次翻倍、封顶 30 分钟的冷却，冷却结束后清零计数器重新尝试，没有总次数上限（配额问题不会因为"再试 3 次"就消失，只能等它自己恢复）。孤立的单次失败（低于阈值）仍走原来的"记入待重试列表，本轮跑完后再统一重试 3 轮"逻辑，避免为偶发错误付出整轮冷却的代价。

### 打包多句：把"请求数"这个真正的瓶颈摊薄

既然配额限制的是**请求次数**而不是文本量，把多句塞进一次请求就是最有效的加速手段。实测结论：

| 每次请求句数 | 结果 |
|---|---|
| 2 / 5 / 10 / 15 / 20 / 30 / 40 | **全部**返回编号完整、数量正确的译文 |
| 20（取 ch17 **最长**的 20 句，共 8381 字符） | 12.6 秒返回，20/20 完整，无截断 |

也就是说**上限远高于 5**，40 句仍然正常。脚本取 `BATCH_SIZE = 20`：40 也可用，但单批越大，一旦需要回退重做的代价越大，且批量输出比单句输出**约精简 10%**（同一句最长文本：单句 302 字 / 批量 272 字，均为完整翻译、非截断），20 在两者之间。

效果：剩余约 8600 句，单句模式需 8600 次请求（约 34 个配额窗口），20 句一批只需约 430 次（约 1.7 个窗口）。实测吞吐从 10 句/分钟 提升到**单批 139 句/分钟**，含回退与限流的真实混合速率约 38 句/分钟（约 4 倍）。

**编号错位是这个方案唯一严重的风险**——一旦错位，译文会被静默写到错误的句子上。因此：

- 结果按模型**返回的编号**匹配，不按行序。响应顺序被打乱也能正确归位，只有编号本身写错才无法恢复。
- 一批必须**完整且编号连续**才写入；缺任何一条就整批丢弃、退回逐句翻译。坏批次只损失时间，绝不会写错句子。
- 已实测验证对齐正确性（非仅"能解析"）：同一批 10 句同时做单句翻译作对照，逐条比对语义最近邻，10/10 对应正确；写入后再抽查译文中括注的巴利语术语是否出现在**它自己那一句**的原文里，23/23 命中；72 条写入中**零重复译文**（重复是错位/合并的典型症状），中译/巴利长度比中位数 0.38，与单句模式一致。

### 一个已修复的隐患：进度文件可能掩盖丢失的写入

实测中发现 `p2-r59` 被记入进度文件、但后端覆盖层里根本没有——原因是那次 PUT 被一个正在部署下线中的副本接收，写入随副本一起丢失（正是 `main.py` 里记录的 ephemeral disk 风险窗口）。若继续信任进度文件，这句会被永久跳过。

修复：`fill-gaps` / `not-dharmamitra` / `retranslate-dharmamitra` 三种模式**都不用进度文件过滤待办**，改为完全以线上覆盖层为准（覆盖层本来就是每次启动重新读取的唯一权威）；进度文件只用来给同一次运行断点续跑做记录，不参与"这句是否已经翻译过"的判断。

### 对排队跑多章的实际含义

顺序跑下来，大概率会反复撞上配额墙——每次都会自动冷却重试，不会中断或需要人工干预，但总耗时会明显长于"稳定 10/min"的乐观估算（有效吞吐量随撞墙次数被拉低，实测单次事故就把该次运行的平均吞吐从 10/min 拉到约 2.7-3.1/min）。用本地 dashboard（`papancasudani` 仓库的 `pali-retranslation-dashboard` 容器）上的实时 ETA 判断进度，不要按静态速率估算总时长。

### 脚本用法：文档族与模式

```
export SUTTA_API_EMAIL=... SUTTA_API_PASSWORD=...
python3 scripts/retranslate_vism_chapter.py --chapter <文档> --mode <模式>
```

`--chapter` 支持三类文档，对应不同的源文件和后端 `doc_key`：

| `--chapter` 取值 | 源文件 | `doc_key` |
|---|---|---|
| `1`..`23` | `docs/research/vism-data/pe_chapNN.json` | `vism:<N>` |
| `nidana` / `conclusion` | `docs/research/vism-data/pe_nidana.json` / `pe_conclusion.json` | `vism:nidana` / `vism:conclusion` |
| `papanca-part1` / `papanca-part2` / `papanca-part3` | `docs/research/pali-source-texts/sutta/majjhima/papancasudani/partN/bilingual.json` | `papanca:partN` |

`--mode` 决定选哪些句子（`source == "human"` 的人工编辑行在任何模式下都不会被覆盖）：

| `--mode` | 选中的句子 |
|---|---|
| `fill-gaps` | 静态文件和覆盖层里都还没有译文的句子（"有译文"取两者并集） |
| `not-dharmamitra` | 覆盖层里 `source` 不是 `dharmamitra` 的句子——包括从没翻译过的、以及现有译文来自其他旧流水线（如破戏疏三部分现成的 `chinese_translation`）的句子，整句覆盖 |
| `retranslate-dharmamitra` | 覆盖层里 `source == "dharmamitra"` 的句子，用于 Dharmamitra 风格变更后（见上）重新译出旧的机翻结果 |

批量大小用 `--batch-size`（默认 20），单章可用 `--dry-run` 先看计划、`--limit N` 只跑前 N 句、`--minutes N` 定时停止（可续跑）。

### 在新设备上重新部署这套流水线

翻译不是跑在 Azure 后端里，而是本机（或任何一台能访问 Azure API 的机器）上的一个 Docker 容器，通过 `/api/mitra/translate` 代理调用 Dharmamitra，直接把结果写进生产环境的翻译覆盖层——**只要这台机器能访问公网，容器本身不需要和 Azure 部署在一起**。部署目录（`papancasudani/`，独立于本仓库，不在 git 里）里有：

```
papancasudani/
  docker-compose.yml
  dashboard/
    Dockerfile
    app.py        # 队列控制器 + 网页看板，唯一打进镜像的文件
```

`docker-compose.yml` 把两样东西挂载进容器：`docs/research/vism-data`（读写，队列状态/进度/日志都落在这里）、以及本仓库整个检出目录（只读，挂载到 `/repo`——`retranslate_vism_chapter.py` 和它读的所有源文件都从这里读，**编辑宿主机上的脚本文件，下一次任务启动时立即生效，不需要重建镜像**）。在新设备上：

1. clone 本仓库到本地任意路径。
2. 把 `docker-compose.yml` 里两个 `volumes` 路径改成新设备上对应的实际路径。
3. 设置账号环境变量（这是队列翻译时用来登录后端 API 的账号，不是你自己的账号）：
   ```
   export SUTTA_API_EMAIL=...
   export SUTTA_API_PASSWORD=...
   ```
4. 构建并启动：
   ```
   cd papancasudani
   docker compose build pali-retranslation-dashboard
   docker compose up -d pali-retranslation-dashboard
   ```
5. 打开 `http://localhost:8080` 看队列看板；`GET /api/status` 返回当前任务/队列/历史的 JSON；`POST /api/queue/add`（body `{chapter, mode, after?}`，`after` 可选，插到指定章节后面而不是排到队尾）、`POST /api/queue/remove`（body `{chapter}`）、`POST /api/pause`（暂停当前任务，SIGTERM 让脚本译完当前句子后干净退出，不会丢失或重复翻译）。

队列状态（`queue.json`）落在挂载的 `vism-data/.retranslation-dashboard/` 里，所以**容器重启、甚至换一台新设备重新挂载同一份 `vism-data` 目录，队列和历史都会原样恢复**；正在跑的那一条任务会被放回队首重新开始（两种模式都是"以线上覆盖层为准"，不会因为重跑而重复翻译或漏句）。修改 `dashboard/app.py`（队列逻辑本身，不是翻译脚本）需要重新 `docker compose build` 才生效。

## 动态服务（问答 / 论坛 / 博客）

本仓库（`docs/`）保持纯静态，继续由 GitHub Pages 发布。问答、论坛、博客等动态功能由一个独立的私有后端服务提供（不在本仓库中），页面通过 `fetch()` 跨域调用该服务的 API。

## 版权声明 · Copyright Notice

本项目（主题经文摘要、分类整理、阅读器网页与解析脚本）由 **[Bayson-create](https://github.com/Bayson-create)** 设计开发，© 2026 Bayson-create。代码以 [MIT License](https://opensource.org/licenses/MIT) 开源；摘要、分类等原创文字内容以 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 共享——欢迎自由使用、转载、修改、二次开发，但请注明出处并附本仓库链接。

本着"法布施胜一切施"（*Sabbadānaṃ dhammadānaṃ jināti*，《法句经》354 偈）的精神，作者不以此项目牟利，亦不限制非商业性的自由传播。

### 经文数据来源与引用

巴利三藏原文及其英、中译文并非本项目原创，引用时遵照各自授权：

- **巴利原文**：源自 [SuttaCentral](https://suttacentral.net) 维护的 Mahāsaṅgīti Tipiṭaka（佛历 2500 年结集本），以 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) 公共领域方式发布。
- **英文译文**：经藏部分主要由 Bhikkhu Sujato 翻译，律藏部分由 Bhikkhu Brahmali 翻译，均以 CC0 1.0 发布于 SuttaCentral。
- **中文译文**：主要采用莊春江（Zhuang Chunjiang）居士的譯註，经 SuttaCentral 收录、对外公开传播，敬请保留译者署名。

### 免责声明

本项目所摘录之"重点""内容主轴""内容总结"等概括文字，皆为作者个人学习整理所得，不代表任何僧团、学派或学术机构的权威解释，亦未经长老或译经委员会审定，仅供学习参考，请以巴利原文及尊者译本为准。若发现摘要有误或可改进之处，欢迎通过 [GitHub Issues](https://github.com/Bayson-create/Sutta-Study-Guide/issues) 指正。

---

**Copyright**: © 2026 [Bayson-create](https://github.com/Bayson-create). Code under [MIT License](https://opensource.org/licenses/MIT); original written content (summaries, categorization) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — attribution and a link back to this repo appreciated.

**Sutta data attribution**: Pāli root text & translations released under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) via [SuttaCentral](https://suttacentral.net). English translations primarily by Bhikkhu Sujato (Suttas) and Bhikkhu Brahmali (Vinaya). Chinese translations primarily by 莊春江 (Zhuang Chunjiang).
