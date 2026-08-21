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

首页六个入口分别是什么、解决什么问题。

### 🙏 问问乔达摩先生（`#/gotama`）

**功能**：一个基于开源人格 Skill [gotama-buddha-perspective](https://github.com/Bayson-create/gotama-buddha-perspective) 优化而来的多轮对话 agent——这个 Skill 本身蒸馏了乔达摩·悉达多的思维框架（缘起相生论、中道智慧、无常观、无我论、苦谛与解脱、涅槃观、六方义务等心智模型，以及一整套决策启发式和渐次说法的问题路由逻辑）；这里在此基础上加了一层真实检索能力：可以主动查询巴利三藏全文、搜索并抓取网页、查阅调研底稿，而不是只靠模型自己的记忆和训练知识作答。每条可引用的结论都能追溯到一次真实检索命中，前端会渲染成可点击的引文徽章、点开直达经文原文；有防止无限循环调用工具的机制；长回合可以在后台继续生成，关闭标签页也不会丢进度。

**意义**：普通 LLM 聊天的"引用"经常是编的、查不到出处。这里把"回答"和"检索"拆开，强制回答必须挂靠在真实检索结果上，把可信度的责任从"模型记不记得住"转移到"检索系统找不找得到"——后者是可验证、可审计的。相比原始的人格 Skill 只靠一段系统提示词让模型扮演角色，这里进一步补上了真实检索和引用校验，让回答有据可查，而不只是"演得像"。

### 🧬 法义溯源（`#/dhamma`）

**功能**：给一句话或一个观点，沿八层历史脉络（早期经律 → 早期注释 → 部派阿毗达磨 → 部派系统论书 → 大乘核心经论 → 成熟大乘系统 → 宗派体系 → 现代法师）逐层检索比对，要求不能编造任何未在检索结果中出现的引文，某一层查无相关内容必须明说"未检索到"，并同时标出**纵向分歧**（后期层对早期源头的重新诠释）和**横向分歧**（同一层内部不同文本互相矛盾）。另有不需要登录、纯关键词检索的模式，作为不依赖 AI 的兜底。

**意义**：很多流行的"佛法金句"其实是后人层层加工、甚至现代人自己总结出来又安回佛陀名下的。这个功能不给一个笼统的"共识答案"，而是刻意保留、暴露教义在历史中演变分歧的过程——查无内容就是查无内容，不用一层的资料去填补另一层的空白。

### 🧭 人格过程实验室（`#/personhood`）

**功能**：把用户描述的一次真实人际互动，按《蜜丸经》（MN 18）的缘起链逐节点分析——门 → 所缘 → 识 → 触 → 受 → 想 →（寻 → 戏论 → 戏论想念 → 爱 → 取 → 有 → 身语意业）。两个版本可切换：**经律原典版**严格按经文字面顺序展开；**分层整合版**按《摄阿毗达磨义论》把触/受/想/思/作意处理为同时俱起，并加一个专门的"心路"（citta-vīthi）节点，判定是五门心路还是意门心路、展开完整的心识刹那序列。每个节点独立生成、限定输出范围，引用只能来自当轮实际检索到的经文，生成后还会校验引用确实存在于检索结果里，不给模型编造引用的空间。

**意义**：把"用佛法分析我的一次人际冲突"这件事从"问 AI、它随便说点什么"变成一套受约束、可审计的分析流水线——固定的阿毗达磨节点词表、代码强制的引用真实性、两套可切换的教义视角，让分析结果站得住脚，而不是听起来有道理但查无实据。

### 📚 巴利三藏阅读器 V4（`#/tipitaka/read/...`）

**功能**：217 部作品（藏经/义注/复注/其他），巴利·简体中文·English 三语并列，另附 26 部辞典（243 万余词条）和 634 个专有名词索引。

**意义**：和直接用 SuttaCentral 网站比，这里做到了三件它做不到的事——**完全离线可用**（数据在本地缓存里，断网也能读）、**横跨整个语料库（含辞典和义注）的真正全文检索**（不是只能搜到已知作品名再进去翻，检索速度也不随语料库总量增长而明显变慢）、以及**义注/复注内联链接到对应根本文位置**（读正文时注疏就在旁边，不用来回切换页面）。

### 🔍 个人研究（`#/research`）

**功能**：不是"我的笔记/收藏"（那些在 `#/profile` 里），而是站主自己撰写的长篇研究文集——逐章巴利原典研读、跨体系（含藏传道次第）阿毗达磨对照矩阵、28 个核心法义概念解析、《大史》全文翻译/摘要、引用 177 部经的互动式禅修流程图、菩提比丘文章摘要合集，部分文章还有专属的独立阅读器（比如清净道论）。

**意义**：三藏原典之外，佛法研习经常需要跨文本、跨体系的综合梳理——这些是站主自己动手做的这类二手研究，和原典阅读器互补，不是把三藏原文再倒腾一遍。

### 💬 社区（`#/qa` `#/forum` `#/blog` `#/profile`）

**功能**：真正的用户生成内容。登录用户可以发问题、开论坛话题、写博客、回复点赞，编辑/删除权限受所有者/管理员校验约束。

**意义**：把"阅读三藏"和"讨论三藏"放在同一个站点里——不用另外去找一个论坛或者微信群，学习中遇到的具体问题可以直接在同一个上下文里提问讨论。

## Data Source

All sutta texts are fetched from [SuttaCentral](https://suttacentral.net) API.

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
