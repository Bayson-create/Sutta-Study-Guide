# 《摄阿毗达摩义论表解》简体数字版

这是 Sutta Study Guide 使用的静态阅读数据。内容依据授权提供的
`abhidhammattha-sangaha_Table-full-text.pdf` 生成，采用 PDF 原有文字层、书签和页面资源，未使用 OCR。

## 内容结构

- `manifest.json`：版本、来源、章节、页码和搜索分片清单。
- `data/*.json`：按顶层书签分片的简体页面文字，每页保留物理页码与书内页码。
- `pages/*.png`：密集表格、图示和含图片页面的高清原页校验视图。
- `source/*.pdf`：原始 PDF，供读者核对和下载。
- `conversion-audit.json`：源文件哈希、转换工具、异常字和覆盖统计。

## 重新构建

```bash
python3 scripts/build_abhidhamma_html.py --pdf /path/to/abhidhammattha-sangaha_Table-full-text.pdf
```

构建需要 `pypdf`、`opencc-python-reimplemented` 和 Poppler 的 `pdftoppm`。正式发布前应确认 `conversion-audit.json` 中的源文件哈希与本次授权版本一致。

## 发布说明

本页面是经授权的繁体转简体数字版，保留作者、编者、修订者、版本、来源和原 PDF 校验入口。巴利语、英文、引文编号和特殊符号不参与中文转换。
