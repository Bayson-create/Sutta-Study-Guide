# V4 巴利名相 TF-IDF 统计发现层

该数据层把 V4 正文按 `commentary-links-v5` 的真实经／品单元切分为文档，计算巴利名相的 TF-IDF，并构建可追溯的跨文档统计联系。

- `commentary-links-v5` 只从 Azure 线上版本读取；缺失时构建失败，不回退到 v2。
- 根本、义注、复注、藏外典籍分别标记，不能混作同一来源。
- “跨文档显著”和“局部共现”只表示统计关联，不表示教义因果、修行次第或语义等同。
- 每个命中保留 `work_id`、行号、词位及 v5 单元 provenance，可回到 V4 原文核对。
- 浏览器只按术语加载关系分片；完整数据不在首屏整体下载。
- AI 自动抽检是发布门禁。没有成功的模型审计报告时，构建产物不得上传到生产路径。

构建示例：

```bash
python3 scripts/build_v4_concept_tfidf.py \
  --archive /path/to/tipitaka-v4-export.zip \
  --v5-cache /path/to/commentary-links-v5/roots \
  --output /path/to/concept-tfidf-v1 \
  --release
```

发布目标固定为 `tipitaka/v1/concept-tfidf-v1/`，采用不可变缓存与逐文件 SHA-256 校验。
