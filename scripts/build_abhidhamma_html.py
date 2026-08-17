#!/usr/bin/env python3
"""Build the integrated Abhidhamma DOC/PDF static reader.

The public source files are legacy Word documents (mostly ``.doc``; one file
is a DOCX package with a legacy extension). This builder keeps the original
DOC as the source-of-truth and uses three complementary channels:

* macOS ``textutil`` reads each DOC directly and supplies semantic paragraphs
  and native HTML tables;
* LibreOffice normalizes DOC to DOCX so embedded media, text boxes and drawing
  relationships can be audited and exported reproducibly;
* the born-digital PDF remains authoritative for physical pages, page images
  and complex-layout verification.

Each section receives a clean, responsive semantic HTML file containing
paragraphs, tables, figures and PDF page anchors. The section JSON retains the
existing page-level search/index data used by the site.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from bisect import bisect_right
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

from pypdf import PdfReader

try:
    from opencc import OpenCC  # type: ignore
except ImportError:  # pragma: no cover
    OpenCC = None  # type: ignore


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs" / "research" / "abhidhamma-sangaha"
DEFAULT_SOURCE_NAME = "abhidhammattha-sangaha_Table-full-text.pdf"
DEFAULT_DOC_DIR = DEFAULT_OUTPUT / "source" / "doc"
PAGE_DPI = 144

DISPLAY_REPLACEMENTS = {
    "瞋": "嗔",
    "瞋心": "嗔心",
    "瞋恚": "嗔恚",
    "毘": "毗",
    "慾": "欲",
    "祕": "秘",
    "衆": "众",
    "眾": "众",
    "於": "于",
}

SECTION_NAMES = {
    0: ("cover", "封面"),
    1: ("abbreviations", "略语表"),
    2: ("content", "目录"),
    3: ("preface", "序与总导读"),
    4: ("chapter-01", "第一 摄心分别品"),
    5: ("chapter-02", "第二 摄心所分别品"),
    6: ("chapter-03", "第三 摄杂分别品"),
    7: ("chapter-04", "第四 摄路分别品"),
    8: ("chapter-05", "第五 摄离路分别品"),
    9: ("chapter-06", "第六 摄色分别品"),
    10: ("chapter-07", "第七 摄集分别品"),
    11: ("chapter-08", "第八 摄缘分别品"),
    12: ("chapter-09", "第九 摄业处分别品"),
    13: ("appendix", "附录"),
    14: ("answers", "问题解答"),
    15: ("corrections", "2022 年修订更正记录"),
    16: ("corrections-appendix", "更正记录补页"),
    17: ("copyright", "版权页"),
}

DOC_FILES = {
    "content": "03-content.doc",
    "preface": "04-preface.doc",
    "chapter-01": "05-Chap01_ADS_T.doc",
    "chapter-02": "06-Chap02_ADS_T.doc",
    "chapter-03": "07-Chap03_ADS_T.doc",
    "chapter-04": "08-Chap04_ADS_T.doc",
    "chapter-05": "09-Chap05_ADS_T.doc",
    "chapter-06": "10-Chap06_ADS_T.doc",
    "chapter-07": "11-Chap07_ADS_T.doc",
    "chapter-08": "12-Chap08_ADS_T.doc",
    "chapter-09": "13-Chap09_ADS_T.doc",
    "appendix": "14-Appendix.doc",
    "answers": "15-resolve.doc",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def int_page(reader: PdfReader, item: Any) -> int | None:
    try:
        return reader.get_destination_page_number(item) + 1
    except Exception:
        return None


def outline_rows(reader: PdfReader, items: Iterable[Any], depth: int = 0) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, list):
            rows.extend(outline_rows(reader, item, depth + 1))
            continue
        rows.append({"title": str(getattr(item, "title", "")).strip(), "physical_page": int_page(reader, item), "depth": depth})
    return rows


def root_outline(reader: PdfReader) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    raw = reader.outline
    roots: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, list):
            continue
        roots.append({"title": str(getattr(item, "title", "")).strip(), "physical_page": int_page(reader, item)})
    return roots, outline_rows(reader, raw)


def image_resource_count(page: Any) -> int:
    count = 0
    try:
        xobjects = page.get("/Resources", {}).get("/XObject", {})
        for _, reference in xobjects.items():
            if reference.get_object().get("/Subtype") == "/Image":
                count += 1
    except Exception:
        return 0
    return count


def is_complex_page(text: str, image_count: int) -> bool:
    lines = text.splitlines()
    repeated_spacing = len(re.findall(r" {3,}", text))
    table_glyphs = sum(text.count(ch) for ch in ("─", "│", "┌", "└", "", "◙", "→", "←"))
    table_keywords = len(re.findall(r"表|圖|图|一覽|一览|總覽|总览|歸納|归纳|對照|对照|流程|關係|关系|矩陣|矩阵", text))
    return bool(image_count or len(lines) >= 100 or repeated_spacing >= 25 or table_glyphs >= 8 or (len(lines) >= 35 and table_keywords >= 2))


def logical_label(text: str) -> str:
    patterns = [r"\b(preface\s*-?\s*\d+)\b", r"\b(appendix\s*-?\s*\d+)\b", r"\b(answer\s*-?\s*\d+)\b", r"\b(ch\.\s*\d+\s*[- ]\s*\d+)\b", r"\b(copyright\s*-?\s*\d+)\b"]
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            return re.sub(r"\s+", "", match.group(1))
    return ""


def page_heading(text: str, fallback: str) -> str:
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if not line:
            continue
        line = re.sub(r"^(?:preface|appendix|answer|copyright|ch\.\s*\d+\s*[- ]\s*\d+)\s*[- ]?\s*\d*\s*", "", line, flags=re.I)
        if line and len(line) <= 120:
            return line
    return fallback


def site_character_map() -> dict[str, str]:
    index = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
    simple = re.search(r'const S2T_S="([^"]*)";', index)
    traditional = re.search(r'const S2T_T="([^"]*)";', index)
    if not simple or not traditional or len(simple.group(1)) != len(traditional.group(1)):
        raise RuntimeError("Unable to load the site's S2T map")
    return {t: s for s, t in zip(simple.group(1), traditional.group(1))}


class Converter:
    def __init__(self) -> None:
        self.mode = "OpenCC t2s" if OpenCC is not None else "site S2T fallback"
        self._opencc = OpenCC("t2s") if OpenCC is not None else None
        self._map = site_character_map() if self._opencc is None else None

    def convert(self, text: str) -> str:
        clean = text.replace("\x00", "")
        value = self._opencc.convert(clean) if self._opencc is not None else "".join(self._map.get(ch, ch) for ch in clean)
        for before, after in sorted(DISPLAY_REPLACEMENTS.items(), key=lambda pair: len(pair[0]), reverse=True):
            value = value.replace(before, after)
        return value


class HtmlNode:
    def __init__(self, tag: str, attrs: dict[str, str] | None = None) -> None:
        self.tag = tag.lower()
        self.attrs = attrs or {}
        self.children: list[HtmlNode | str] = []


class DirectHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = HtmlNode("root")
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = HtmlNode(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(node)
        if tag.lower() not in {"br", "img", "hr", "meta", "link", "input", "source"}:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag.lower():
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        wanted = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == wanted:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


def find_nodes(node: HtmlNode, tag: str) -> list[HtmlNode]:
    result: list[HtmlNode] = []
    for child in node.children:
        if isinstance(child, HtmlNode):
            if child.tag == tag:
                result.append(child)
            result.extend(find_nodes(child, tag))
    return result


def node_text(node: HtmlNode | str) -> str:
    if isinstance(node, str):
        return node.replace("\x00", "")
    if node.tag in {"br", "hr"}:
        return "\n"
    return "".join(node_text(child) for child in node.children)


def parse_css_rules(raw_html: str) -> dict[str, dict[str, str]]:
    rules: dict[str, dict[str, str]] = {}
    style_blocks = re.findall(r"<style[^>]*>(.*?)</style>", raw_html, flags=re.I | re.S)
    css = "\n".join(style_blocks)
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", css, flags=re.S):
        selector, body = match.group(1), match.group(2)
        declarations = {key.strip().lower(): value.strip().lower() for key, value in re.findall(r"([\w-]+)\s*:\s*([^;]+)", body)}
        for class_name in re.findall(r"\.([a-zA-Z][\w-]*)", selector):
            rules[class_name] = declarations
    return rules


def safe_href(value: str) -> str:
    return value if value.startswith(("https://", "http://", "#", "research/")) else ""


def css_classes_for_paragraph(node: HtmlNode, style_rules: dict[str, dict[str, str]]) -> list[str]:
    classes = ["doc-paragraph"]
    source_class = node.attrs.get("class", "").split()[0] if node.attrs.get("class") else ""
    style = style_rules.get(source_class, {})
    align = style.get("text-align", "")
    if align in {"center", "right", "justify"}:
        classes.append(f"doc-paragraph--{align}")
    size_match = re.search(r"([\d.]+)px", style.get("font", ""))
    if size_match and float(size_match.group(1)) >= 14:
        classes.append("doc-paragraph--large")
    text = re.sub(r"\s+", " ", node_text(node)).strip()
    if (find_nodes(node, "b") or find_nodes(node, "strong")) and text and len(text) <= 100:
        classes.append("doc-heading")
    return classes


def render_inline(node: HtmlNode | str, converter: Converter, style_rules: dict[str, dict[str, str]]) -> str:
    if isinstance(node, str):
        return html.escape(converter.convert(node), quote=False)
    tag = node.tag
    if tag in {"style", "script", "title", "meta", "link", "head"}:
        return ""
    if tag == "br":
        return "<br>"
    if tag == "img":
        src = html.escape(safe_href(node.attrs.get("src", "")), quote=True)
        if not src:
            return ""
        alt = html.escape(converter.convert(node.attrs.get("alt", "图示")), quote=True)
        return f'<img src="{src}" alt="{alt}" loading="lazy">'
    if tag == "a":
        href = html.escape(safe_href(node.attrs.get("href", "")), quote=True)
        content = "".join(render_inline(child, converter, style_rules) for child in node.children)
        return f'<a href="{href}" target="_blank" rel="noopener">{content}</a>' if href else content
    allowed = {"b", "strong", "i", "em", "u", "s", "sup", "sub", "span", "small", "mark"}
    content = "".join(render_inline(child, converter, style_rules) for child in node.children)
    return f"<{tag}>{content}</{tag}>" if tag in allowed else content


def render_block(node: HtmlNode, converter: Converter, style_rules: dict[str, dict[str, str]]) -> tuple[str, str]:
    plain = re.sub(r"\s+", " ", node_text(node)).strip()
    if node.tag == "p":
        classes = " ".join(css_classes_for_paragraph(node, style_rules))
        tag = "h4" if "doc-heading" in classes and len(plain) <= 80 else "p"
        content = "".join(render_inline(child, converter, style_rules) for child in node.children)
        return f'<{tag} class="{classes}">{content}</{tag}>', plain
    if node.tag == "table":
        def render_table(child: HtmlNode | str) -> str:
            if isinstance(child, str):
                return html.escape(converter.convert(child), quote=False)
            if child.tag in {"td", "th"}:
                attrs = []
                for key in ("rowspan", "colspan"):
                    value = child.attrs.get(key, "")
                    if value.isdigit() and int(value) > 1:
                        attrs.append(f'{key}="{value}"')
                content = "".join(render_inline(grand, converter, style_rules) if isinstance(grand, str) else render_table(grand) for grand in child.children)
                cell_tag = "th" if child.tag == "th" else "td"
                return f'<{cell_tag}{(" " + " ".join(attrs)) if attrs else ""}>{content}</{cell_tag}>'
            if child.tag in {"tr", "thead", "tbody", "tfoot", "caption", "colgroup", "col"}:
                content = "".join(render_table(grand) for grand in child.children)
                return f"<{child.tag}>{content}</{child.tag}>"
            if child.tag in {"p", "div", "span", "b", "strong", "i", "em", "u", "sup", "sub", "br"}:
                return "".join(render_table(grand) for grand in child.children) if child.tag != "br" else "<br>"
            return "".join(render_table(grand) for grand in child.children)
        content = "".join(render_table(child) for child in node.children if isinstance(child, HtmlNode))
        return f'<div class="abhi-doc-table-wrap"><table class="abhi-doc-table">{content}</table></div>', plain
    if node.tag in {"ul", "ol", "blockquote", "figure"}:
        content = "".join(render_inline(child, converter, style_rules) if isinstance(child, str) else render_block(child, converter, style_rules)[0] for child in node.children)
        return f'<{node.tag} class="doc-{node.tag}">{content}</{node.tag}>', plain
    content = "".join(render_inline(child, converter, style_rules) if isinstance(child, str) else render_inline(child, converter, style_rules) for child in node.children)
    return content, plain


def body_node(root: HtmlNode) -> HtmlNode:
    bodies = find_nodes(root, "body")
    return bodies[0] if bodies else root


def direct_doc_html(doc_path: Path, temp_dir: Path) -> tuple[str, str]:
    textutil = shutil.which("textutil")
    if textutil:
        result = subprocess.run([textutil, "-convert", "html", "-stdout", str(doc_path)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return result.stdout.decode("utf-8", errors="replace").replace("\x00", ""), "textutil direct DOC HTML"
    soffice = shutil.which("soffice")
    if not soffice:
        raise RuntimeError("Direct DOC parsing requires macOS textutil or LibreOffice soffice")
    output_dir = temp_dir / "html"
    output_dir.mkdir(parents=True, exist_ok=True)
    profile = temp_dir / "lo-profile-html"
    result = subprocess.run([
        soffice, f"-env:UserInstallation={profile.as_uri()}", "--headless",
        "--convert-to", "html", "--outdir", str(output_dir), str(doc_path),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = output_dir / f"{doc_path.stem}.html"
    if not output.exists():
        raise RuntimeError(f"LibreOffice did not produce HTML for {doc_path.name}: {result.stderr.decode(errors='replace')}")
    return output.read_text(encoding="utf-8", errors="replace").replace("\x00", ""), "LibreOffice direct DOC HTML fallback"


def normalize_docx(doc_path: Path, temp_dir: Path) -> tuple[Path, str]:
    target_dir = temp_dir / "docx"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{doc_path.stem}.docx"
    if doc_path.read_bytes()[:4] == b"PK\x03\x04":
        shutil.copy2(doc_path, target)
        return target, "DOCX package with legacy .doc extension" if doc_path.suffix.lower() == ".doc" else "DOCX source"
    soffice = shutil.which("soffice")
    if not soffice:
        raise RuntimeError("LibreOffice soffice is required to normalize legacy DOC files")
    profile = temp_dir / "lo-profile-docx"
    subprocess.run([
        soffice, f"-env:UserInstallation={profile.as_uri()}", "--headless",
        "--convert-to", "docx", "--outdir", str(target_dir), str(doc_path),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    converted = target_dir / f"{doc_path.stem}.docx"
    if not converted.exists():
        raise RuntimeError(f"LibreOffice did not produce DOCX for {doc_path.name}")
    return converted, "LibreOffice DOC to DOCX normalization"


def extract_docx_media(docx_path: Path, output: Path, slug: str, temp_dir: Path) -> list[dict[str, Any]]:
    media_dir = output / "assets" / "docx" / slug
    media_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    with zipfile.ZipFile(docx_path) as archive:
        names = [name for name in archive.namelist() if name.startswith("word/media/") and not name.endswith("/")]
        for index, name in enumerate(names, start=1):
            source_name = Path(name).name
            suffix = Path(source_name).suffix.lower()
            raw_path = temp_dir / f"media-{slug}-{index}{suffix}"
            raw_path.write_bytes(archive.read(name))
            destination = media_dir / source_name
            conversion = "original"
            if suffix in {".wmf", ".emf"}:
                destination = media_dir / f"{Path(source_name).stem}.png"
                soffice = shutil.which("soffice")
                pdftoppm = shutil.which("pdftoppm") or "/opt/homebrew/bin/pdftoppm"
                vector_dir = temp_dir / "vector-pdf"
                vector_dir.mkdir(parents=True, exist_ok=True)
                profile = temp_dir / "lo-profile-vector"
                converted_pdf = vector_dir / f"{raw_path.stem}.pdf"
                if soffice and not converted_pdf.exists():
                    subprocess.run([
                        soffice, f"-env:UserInstallation={profile.as_uri()}", "--headless",
                        "--convert-to", "pdf", "--outdir", str(vector_dir), str(raw_path),
                    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                prefix = destination.with_suffix("")
                if converted_pdf.exists() and Path(pdftoppm).exists():
                    subprocess.run([pdftoppm, "-png", "-r", "180", "-singlefile", str(converted_pdf), str(prefix)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if destination.exists():
                    conversion = "rasterized from vector source"
                else:
                    destination = media_dir / source_name
                    destination.write_bytes(raw_path.read_bytes())
                    conversion = "original vector fallback"
            else:
                destination.write_bytes(raw_path.read_bytes())
            records.append({
                "source": name,
                "file": destination.relative_to(ROOT / "docs").as_posix(),
                "bytes": destination.stat().st_size,
                "sha256": sha256_file(destination),
                "conversion": conversion,
            })
    return records


def docx_structure(docx_path: Path) -> dict[str, int]:
    counts = {key: 0 for key in ("paragraphs", "tables", "drawings", "textboxes", "bookmarks", "page_breaks", "footnote_refs")}
    with zipfile.ZipFile(docx_path) as archive:
        xml = archive.read("word/document.xml").decode("utf-8", errors="replace")
    patterns = {
        "paragraphs": r"<w:p(?:\s|>)",
        "tables": r"<w:tbl(?:\s|>)",
        "drawings": r"<w:drawing(?:\s|>)",
        "textboxes": r"<w:txbxContent(?:\s|>)",
        "bookmarks": r"<w:bookmarkStart(?:\s|>)",
        "page_breaks": r'<w:br[^>]*w:type="page"',
        "footnote_refs": r"<w:footnoteReference(?:\s|>)",
    }
    for key, pattern in patterns.items():
        counts[key] = len(re.findall(pattern, xml))
    return counts


def normalize_match(text: str) -> str:
    value = text.lower().replace("\x00", "")
    return "".join(ch for ch in value if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")


def page_anchor_map(blocks: list[dict[str, str]], pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not blocks:
        return [{"physical_page": page["physical_page"], "block_index": 0, "match": "empty"} for page in pages]
    block_texts = [normalize_match(block["text"]) for block in blocks]
    offsets: list[int] = []
    joined = ""
    for text in block_texts:
        offsets.append(len(joined))
        joined += text
    anchors: list[dict[str, Any]] = []
    last_position = 0
    for page_index, page in enumerate(pages):
        candidates: list[str] = []
        for line in str(page.get("text", "")).splitlines():
            normalized = normalize_match(line)
            if len(normalized) < 8 or normalized.isdigit():
                continue
            candidates.append(normalized)
            for width in (32, 20, 12):
                if len(normalized) > width:
                    candidates.append(normalized[:width])
        candidates.sort(key=len, reverse=True)
        found = -1
        for candidate in candidates[:10]:
            found = joined.find(candidate, last_position)
            if found >= 0:
                break
        if found >= 0:
            last_position = found
            block_index = max(0, bisect_right(offsets, found) - 1)
            match = "text"
        else:
            ratio = page_index / max(1, len(pages) - 1)
            block_index = min(len(blocks) - 1, round(ratio * (len(blocks) - 1)))
            match = "proportional"
        anchors.append({"physical_page": page["physical_page"], "block_index": block_index, "match": match})
    return anchors


def render_doc_page_map(docx_path: Path, temp_dir: Path, section_pages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]] | None, str]:
    """Render the normalized source document and map its pages to PDF pages."""
    soffice = shutil.which("soffice")
    if not soffice or not section_pages:
        return None, "unavailable"
    output_dir = temp_dir / "doc-render-pdf"
    output_dir.mkdir(parents=True, exist_ok=True)
    profile = temp_dir / "lo-profile-render"
    subprocess.run([
        soffice, f"-env:UserInstallation={profile.as_uri()}", "--headless",
        "--convert-to", "pdf", "--outdir", str(output_dir), str(docx_path),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pdf_path = output_dir / f"{docx_path.stem}.pdf"
    if not pdf_path.exists():
        return None, "missing-render"
    rendered = PdfReader(str(pdf_path))
    if len(rendered.pages) == len(section_pages):
        mode = "exact-source-page-count"
        source_indices = list(range(len(section_pages)))
    else:
        mode = "scaled-source-page-count"
        source_indices = [round(index / max(1, len(section_pages) - 1) * max(0, len(rendered.pages) - 1)) for index in range(len(section_pages))]
    pages: list[dict[str, Any]] = []
    for index, section_page in enumerate(section_pages):
        page = rendered.pages[source_indices[index]]
        text = (page.extract_text() or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
        pages.append({"physical_page": section_page["physical_page"], "text": text})
    return pages, mode


def figure_gallery(media: list[dict[str, Any]], extra_images: list[dict[str, str]], converter: Converter) -> str:
    items: list[str] = []
    for item in media:
        path = html.escape(item["file"], quote=True)
        label = html.escape(converter.convert(Path(item["source"]).name), quote=False)
        items.append(f'<figure class="abhi-doc-figure"><img src="{path}" alt="{label}" loading="lazy"><figcaption>{label}</figcaption></figure>')
    for item in extra_images:
        path = html.escape(item["file"], quote=True)
        label = html.escape(converter.convert(item["label"]), quote=False)
        items.append(f'<figure class="abhi-doc-figure"><img src="{path}" alt="{label}" loading="lazy"><figcaption>{label}</figcaption></figure>')
    if not items:
        return ""
    return '<details class="abhi-doc-figures"><summary>本章节嵌入图示与原始图片</summary><div class="abhi-figure-grid">' + "".join(items) + "</div></details>"


def build_semantic_html(raw_html: str, converter: Converter, pages: list[dict[str, Any]], media: list[dict[str, Any]], extra_images: list[dict[str, str]], anchor_pages: list[dict[str, Any]] | None = None) -> tuple[str, dict[str, Any]]:
    parser = DirectHtmlParser()
    parser.feed(raw_html)
    root = body_node(parser.root)
    style_rules = parse_css_rules(raw_html)
    blocks: list[dict[str, str]] = []
    for child in root.children:
        if not isinstance(child, HtmlNode) or child.tag not in {"p", "table", "ul", "ol", "blockquote", "figure"}:
            continue
        rendered, plain = render_block(child, converter, style_rules)
        if normalize_match(plain):
            blocks.append({"html": rendered, "text": plain})
    anchors = page_anchor_map(blocks, anchor_pages or pages)
    markers: dict[int, list[str]] = {}
    for anchor in anchors:
        number = int(anchor["physical_page"])
        match_label = {"text": "文本对齐", "proportional": "页序映射", "empty": "页序映射"}.get(anchor["match"], "页序映射")
        markers.setdefault(int(anchor["block_index"]), []).append(
            f'<div class="abhi-doc-page-marker" id="abhi-page-{number}" data-page="{number}"><span>PDF 第 {number} 页</span><span class="abhi-doc-page-match">{match_label}</span></div>'
        )
    content: list[str] = ['<div class="abhi-semantic-document">']
    for index, block in enumerate(blocks):
        content.extend(markers.get(index, []))
        content.append(block["html"])
    content.append(figure_gallery(media, extra_images, converter))
    content.append("</div>")
    stats = {
        "blocks": len(blocks),
        "paragraphs": sum(1 for block in blocks if "doc-paragraph" in block["html"]),
        "tables": sum(1 for block in blocks if "abhi-doc-table" in block["html"]),
        "page_anchors": len(anchors),
        "text_matched_pages": sum(1 for anchor in anchors if anchor["match"] == "text"),
        "proportional_pages": sum(1 for anchor in anchors if anchor["match"] == "proportional"),
        "media": len(media) + len(extra_images),
    }
    return "\n".join(content), stats


def fallback_semantic_html(pages: list[dict[str, Any]], converter: Converter) -> tuple[str, dict[str, Any]]:
    blocks: list[str] = ['<div class="abhi-semantic-document abhi-semantic-document--fallback">']
    for page in pages:
        number = int(page["physical_page"])
        blocks.append(f'<div class="abhi-doc-page-marker" id="abhi-page-{number}" data-page="{number}"><span>PDF 第 {number} 页</span><span class="abhi-doc-page-match">pdf-text</span></div>')
        text = str(page.get("text", "")).strip()
        if text:
            blocks.append('<p class="doc-paragraph">' + "<br>".join(html.escape(converter.convert(line), quote=False) for line in text.splitlines() if line.strip()) + "</p>")
    blocks.append("</div>")
    return "\n".join(blocks), {"blocks": len(pages), "paragraphs": len(pages), "tables": 0, "page_anchors": len(pages), "text_matched_pages": 0, "proportional_pages": len(pages), "media": 0}


def render_pages(pdf: Path, output_dir: Path, page_numbers: list[int]) -> dict[int, str]:
    if not page_numbers:
        return {}
    pdftoppm = shutil.which("pdftoppm") or "/opt/homebrew/bin/pdftoppm"
    if not Path(pdftoppm).exists() and shutil.which("pdftoppm") is None:
        raise RuntimeError("pdftoppm is required to render complex pages")
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[int, str] = {}
    pending: list[int] = []
    for number in sorted(set(page_numbers)):
        destination = output_dir / f"page-{number:04d}.png"
        if destination.exists() and destination.stat().st_size > 0:
            paths[number] = destination.relative_to(ROOT / "docs").as_posix()
        else:
            pending.append(number)
    if not pending:
        return paths
    ranges: list[tuple[int, int]] = []
    for number in pending:
        if not ranges or number > ranges[-1][1] + 1:
            ranges.append((number, number))
        else:
            ranges[-1] = (ranges[-1][0], number)
    with tempfile.TemporaryDirectory(prefix="abhidhamma-pages-") as temp:
        temp_path = Path(temp)
        for start, end in ranges:
            prefix = temp_path / f"range-{start:04d}"
            command = [pdftoppm, "-png", "-r", str(PAGE_DPI), "-f", str(start), "-l", str(end), str(pdf), str(prefix)]
            subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for png in temp_path.glob(f"{prefix.name}-*.png"):
                match = re.search(r"-(\d+)\.png$", png.name)
                if not match:
                    continue
                page_number = int(match.group(1))
                destination = output_dir / f"page-{page_number:04d}.png"
                shutil.copy2(png, destination)
                paths[page_number] = destination.relative_to(ROOT / "docs").as_posix()
    return paths


def source_extra_images(output: Path) -> list[dict[str, str]]:
    image_dir = output / "source" / "images"
    result = []
    for path in sorted(image_dir.glob("*")):
        if path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
            continue
        result.append({"file": path.relative_to(ROOT / "docs").as_posix(), "label": path.stem.replace("-", " ")})
    return result


def build(pdf: Path, output: Path, doc_dir: Path) -> None:
    pdf = pdf.resolve()
    output = output.resolve()
    doc_dir = doc_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    data_dir = output / "data"
    page_dir = output / "pages"
    semantic_dir = output / "semantic"
    source_dir = output / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    if semantic_dir.exists():
        shutil.rmtree(semantic_dir)
    if (output / "assets" / "docx").exists():
        shutil.rmtree(output / "assets" / "docx")
    source_copy = source_dir / DEFAULT_SOURCE_NAME
    if pdf != source_copy:
        shutil.copy2(pdf, source_copy)

    source_bytes = pdf.read_bytes()
    reader = PdfReader(str(pdf))
    if len(reader.pages) != 489:
        raise RuntimeError(f"Expected 489 pages, found {len(reader.pages)}")
    roots, all_outline = root_outline(reader)
    if len(reader.outline) != 24:
        raise RuntimeError(f"Expected 24 top-level outline entries, found {len(reader.outline)}")
    roots = [row for row in roots if row["physical_page"] is not None]
    if len(roots) != 18:
        raise RuntimeError(f"Expected 18 section destinations, found {len(roots)}")

    converter = Converter()
    original_text_parts: list[str] = []
    simplified_text_parts: list[str] = []
    page_records: list[dict[str, Any]] = []
    section_records: list[dict[str, Any]] = []
    complex_pages: list[int] = []
    for index, root in enumerate(roots):
        slug, display_title = SECTION_NAMES.get(index, (f"section-{index + 1:02d}", root["title"]))
        start = int(root["physical_page"])
        end = int(roots[index + 1]["physical_page"] - 1) if index + 1 < len(roots) else len(reader.pages)
        source_doc = DOC_FILES.get(slug)
        section_records.append({
            "slug": slug,
            "title": display_title,
            "source_title": root["title"],
            "physical_page_start": start,
            "physical_page_end": end,
            "file": f"data/{slug}.json",
            "semantic_file": f"semantic/{slug}.html",
            "source_doc": f"source/doc/{source_doc}" if source_doc else "",
            "route": f"#/research/abhidhamma-sangaha/read/{slug}",
        })

    for physical_page, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
        text = "\n".join(line.rstrip() for line in text.split("\n")).strip()
        converted = converter.convert(text)
        image_count = image_resource_count(page)
        complex_layout = is_complex_page(text, image_count)
        if complex_layout:
            complex_pages.append(physical_page)
        section = next(record for record in section_records if record["physical_page_start"] <= physical_page <= record["physical_page_end"])
        record = {
            "physical_page": physical_page,
            "logical_label": logical_label(text),
            "title": page_heading(converted, section["title"]),
            "text": converted,
            "complex_layout": complex_layout,
            "image_count": image_count,
        }
        page_records.append(record)
        original_text_parts.append(text)
        simplified_text_parts.append(converted)

    page_paths = render_pages(pdf, page_dir, complex_pages)
    for record in page_records:
        if record["physical_page"] in page_paths:
            record["source_image"] = page_paths[record["physical_page"]]
        elif record["complex_layout"]:
            raise RuntimeError(f"Complex page {record['physical_page']} has no rendered source image")

    source_doc_records: list[dict[str, Any]] = []
    semantic_records: dict[str, dict[str, Any]] = {}
    extra_images = source_extra_images(output)
    with tempfile.TemporaryDirectory(prefix="abhidhamma-doc-build-") as temp:
        temp_dir = Path(temp)
        for section in section_records:
            slug = section["slug"]
            doc_name = DOC_FILES.get(slug)
            section_pages = [record for record in page_records if section["physical_page_start"] <= record["physical_page"] <= section["physical_page_end"]]
            doc_path = doc_dir / doc_name if doc_name else None
            media: list[dict[str, Any]] = []
            if doc_path and doc_path.exists():
                raw_html, direct_tool = direct_doc_html(doc_path, temp_dir)
                docx_path, normalize_tool = normalize_docx(doc_path, temp_dir)
                media = extract_docx_media(docx_path, output, slug, temp_dir)
                parser = DirectHtmlParser()
                parser.feed(raw_html)
                direct_tables = len(find_nodes(parser.root, "table"))
                direct_images = len(find_nodes(parser.root, "img"))
                direct_paragraphs = len(find_nodes(parser.root, "p"))
                structure = docx_structure(docx_path)
                selected_images = extra_images if slug == "chapter-08" else []
                anchor_pages, anchor_mode = render_doc_page_map(docx_path, temp_dir, section_pages)
                semantic_html, semantic_stats = build_semantic_html(raw_html, converter, section_pages, media, selected_images, anchor_pages)
                source_doc_records.append({
                    "section": slug,
                    "file": section["source_doc"],
                    "sha256": sha256_file(doc_path),
                    "bytes": doc_path.stat().st_size,
                    "container": "docx-package" if doc_path.read_bytes()[:4] == b"PK\x03\x04" else "legacy-doc",
                    "direct_parser": direct_tool,
                    "direct_html": {"paragraphs": direct_paragraphs, "tables": direct_tables, "images": direct_images},
                    "normalized_docx_sha256": sha256_file(docx_path),
                    "normalization": normalize_tool,
                    "doc_render_page_count": len(anchor_pages) if anchor_pages else 0,
                    "page_anchor_mode": anchor_mode,
                    "docx_structure": structure,
                    "media": media,
                })
            else:
                semantic_html, semantic_stats = fallback_semantic_html(section_pages, converter)
            semantic_path = output / section["semantic_file"]
            semantic_path.parent.mkdir(parents=True, exist_ok=True)
            semantic_clean = "\n".join(line.rstrip() for line in semantic_html.splitlines())
            semantic_path.write_text(semantic_clean + "\n", encoding="utf-8")
            semantic_records[slug] = semantic_stats
            payload = {"format": "abhidhamma-table-guide/v2", "section": section, "semantic": semantic_stats, "pages": section_pages}
            write_json(output / section["file"], payload)

    original_text = "\n\f\n".join(original_text_parts)
    simplified_text = "\n\f\n".join(simplified_text_parts)
    site_map = site_character_map()
    remaining = Counter(ch for ch in simplified_text if ch in site_map and site_map[ch] != ch)
    changed_chars = Counter()
    for before, after in zip(original_text, simplified_text):
        if before != after:
            changed_chars[f"{before}→{after}"] += 1
    source_doc_section_count = len(source_doc_records)
    if source_doc_section_count != len(DOC_FILES):
        missing = sorted(set(DOC_FILES) - {record["section"] for record in source_doc_records})
        raise RuntimeError(f"Missing source DOC files: {', '.join(missing)}")
    audit = {
        "format": "abhidhamma-table-guide-audit/v2",
        "source": {"file": source_copy.relative_to(ROOT / "docs").as_posix(), "sha256": sha256_bytes(source_bytes), "pages": len(reader.pages), "title": str(reader.metadata.title if reader.metadata else ""), "author": str(reader.metadata.author if reader.metadata else "")},
        "outline": {"top_level_entries": len(reader.outline), "section_destinations": len(roots), "flattened_entries": len(all_outline)},
        "conversion": {"tool": converter.mode, "config": "t2s", "display_language": "zh-Hans", "exceptions": DISPLAY_REPLACEMENTS, "original_characters": len(original_text), "simplified_characters": len(simplified_text), "original_text_sha256": sha256_bytes(original_text.encode("utf-8")), "simplified_text_sha256": sha256_bytes(simplified_text.encode("utf-8")), "remaining_traditional_characters": dict(remaining.most_common(100)), "changed_character_pairs": dict(changed_chars.most_common(100))},
        "source_documents": source_doc_records,
        "semantic_sections": semantic_records,
        "coverage": {"pages": len(page_records), "sections": len(section_records), "complex_pages": len(complex_pages), "rendered_source_images": len(page_paths), "semantic_files": len(semantic_records), "source_doc_files": source_doc_section_count, "section_files": [record["file"] for record in section_records]},
    }
    write_json(output / "conversion-audit.json", audit)
    manifest = {
        "format": "abhidhamma-table-guide-manifest/v2",
        "title": "《摄阿毗达摩义论表解》",
        "title_traditional": "《攝阿毘達摩義論表解》",
        "title_pali": "Abhidhammatthasaṅgaha-vitthāra",
        "author": "法雨；明法比丘编，罗庆龙修订",
        "display_language": "zh-Hans",
        "source_pdf": "source/abhidhammattha-sangaha_Table-full-text.pdf",
        "source_sha256": sha256_bytes(source_bytes),
        "physical_pages": len(page_records),
        "top_level_outline_entries": len(reader.outline),
        "sections": section_records,
        "outline": all_outline,
        "complex_pages": complex_pages,
        "semantic": {"renderer": "direct DOC HTML + normalized DOCX media + PDF page anchors", "section_files": [record["semantic_file"] for record in section_records], "source_doc_files": [record["file"] for record in source_doc_records], "integrated_content": ["paragraph", "table", "figure", "footnote", "pdf-page-anchor"]},
        "conversion_audit": "conversion-audit.json",
        "license_note": "本页面为经授权的繁体转简体数字版；原作者、编者、版本与来源信息保持可追溯。",
        "search_documents": [{"file": f"research/abhidhamma-sangaha/{record['file']}", "route": record["route"], "title": record["title"], "section": record["slug"]} for record in section_records],
    }
    write_json(output / "manifest.json", manifest)
    print(json.dumps({"output": str(output), "pages": len(page_records), "sections": len(section_records), "complex_pages": len(complex_pages), "source_images": len(page_paths), "semantic_files": len(semantic_records), "source_doc_files": source_doc_section_count, "conversion": converter.mode, "source_sha256": sha256_bytes(source_bytes)}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True, help="The born-digital source PDF")
    parser.add_argument("--doc-dir", type=Path, default=DEFAULT_DOC_DIR, help="Directory containing the source DOC files")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Static output directory")
    args = parser.parse_args()
    build(args.pdf, args.output, args.doc_dir)


if __name__ == "__main__":
    main()
