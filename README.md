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

## Data Source

All sutta texts are fetched from [SuttaCentral](https://suttacentral.net) API.

## Vism 逐句重译脚本（`scripts/retranslate_vism_chapter.py`）

`docs/research/vism-data/` 下《清净道论》各章的逐句中译，部分由 `scripts/retranslate_vism_chapter.py` 通过站点自己的 `/api/mitra/translate` 代理调用 Dharmamitra 批量生成/替换，直接写入生产译文覆盖层。运行方式与参数见脚本内 docstring；这里只记录**实测得到的限流行为**，因为它决定了脚本必须怎么写、以及排队跑多章大致要多久。

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

修复：`--fill-gaps` 模式下**不再用进度文件过滤待办**，改为完全以线上覆盖层为准（覆盖层本来就是每次启动重新读取的唯一权威）。`--start` 模式保留进度文件语义，因为那里的目的本就是覆盖已有译文。

### 对排队跑多章的实际含义

19 个章节顺序跑下来，大概率会反复撞上配额墙——每次都会自动冷却重试，不会中断或需要人工干预，但总耗时会明显长于"稳定 10/min"的乐观估算（有效吞吐量随撞墙次数被拉低，实测单次事故就把该次运行的平均吞吐从 10/min 拉到约 2.7-3.1/min）。用本地 dashboard（`papancasudani` 仓库的 `pali-retranslation-dashboard` 容器）上的实时 ETA 判断进度，不要按静态速率估算总时长。

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
