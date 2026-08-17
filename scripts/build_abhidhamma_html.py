#!/usr/bin/env python3
"""Build the static, simplified HTML reader for the Abhidhamma table guide.

The supplied PDF is born-digital.  This builder therefore uses its text layer,
bookmarks and page resources directly; it deliberately never runs OCR.  Normal
pages are exposed as readable text blocks, while pages whose grid/image layout
would lose meaning when reflowed also receive a high-resolution page snapshot.

The output is intentionally sharded by top-level PDF bookmark so GitHub Pages
can load one section at a time.  Run from the Sutta-Study-Guide repository:

    python3 scripts/build_abhidhamma_html.py --pdf /path/to/source.pdf

Dependencies: pypdf and opencc-python-reimplemented.  If OpenCC is not present,
the builder falls back to the site's checked-in character map and records that
fact in the audit report instead of silently producing an untracked conversion.
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
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from pypdf import PdfReader

try:  # The normal, phrase-aware conversion path.
    from opencc import OpenCC  # type: ignore
except ImportError:  # pragma: no cover - exercised only on minimal machines.
    OpenCC = None  # type: ignore


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs" / "research" / "abhidhamma-sangaha"
DEFAULT_SOURCE_NAME = "abhidhammattha-sangaha_Table-full-text.pdf"
PAGE_DPI = 144

# These display choices are already used by the site's Buddhist corpus.  They
# are post-conversion exceptions, kept in the generated audit manifest.
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


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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
        title = str(getattr(item, "title", "")).strip()
        rows.append({"title": title, "physical_page": int_page(reader, item), "depth": depth})
    return rows


def root_outline(reader: PdfReader) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    raw = reader.outline
    roots: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, list):
            continue
        roots.append({
            "title": str(getattr(item, "title", "")).strip(),
            "physical_page": int_page(reader, item),
        })
    return roots, outline_rows(reader, raw)


def image_resource_count(page: Any) -> int:
    count = 0
    try:
        xobjects = page.get("/Resources", {}).get("/XObject", {})
        for _, reference in xobjects.items():
            obj = reference.get_object()
            if obj.get("/Subtype") == "/Image":
                count += 1
    except Exception:
        return 0
    return count


def is_complex_page(text: str, image_count: int) -> bool:
    """Identify pages where a reflowed text view cannot carry the full layout."""
    lines = text.splitlines()
    repeated_spacing = len(re.findall(r" {3,}", text))
    table_glyphs = sum(text.count(ch) for ch in ("─", "│", "┌", "└", "", "◙", "→", "←"))
    table_keywords = len(re.findall(r"表|圖|图|一覽|一览|總覽|总览|歸納|归纳|對照|对照|流程|關係|关系|矩陣|矩阵", text))
    return bool(
        image_count
        or len(lines) >= 100
        or repeated_spacing >= 25
        or table_glyphs >= 8
        or (len(lines) >= 35 and table_keywords >= 2)
    )


def logical_label(text: str) -> str:
    patterns = [
        r"\b(preface\s*-?\s*\d+)\b",
        r"\b(appendix\s*-?\s*\d+)\b",
        r"\b(answer\s*-?\s*\d+)\b",
        r"\b(ch\.\s*\d+\s*[- ]\s*\d+)\b",
        r"\b(copyright\s*-?\s*\d+)\b",
    ]
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
    """Load the site's existing character map for dependency-free fallback."""
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
        value = self._opencc.convert(text) if self._opencc is not None else "".join(self._map.get(ch, ch) for ch in text)
        # Longer phrases first so a phrase exception cannot be split by a
        # shorter character exception.
        for before, after in sorted(DISPLAY_REPLACEMENTS.items(), key=lambda pair: len(pair[0]), reverse=True):
            value = value.replace(before, after)
        return value


def render_pages(pdf: Path, output_dir: Path, page_numbers: list[int]) -> dict[int, str]:
    if not page_numbers:
        return {}
    pdftoppm = shutil.which("pdftoppm") or "/opt/homebrew/bin/pdftoppm"
    if not Path(pdftoppm).exists() and shutil.which("pdftoppm") is None:
        raise RuntimeError("pdftoppm is required to render complex pages")
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[int, str] = {}
    # Render contiguous ranges to keep the process count small.
    ranges: list[tuple[int, int]] = []
    for number in page_numbers:
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


def build(pdf: Path, output: Path) -> None:
    pdf = pdf.resolve()
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    data_dir = output / "data"
    page_dir = output / "pages"
    source_dir = output / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
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
        section_records.append({
            "slug": slug,
            "title": display_title,
            "source_title": root["title"],
            "physical_page_start": start,
            "physical_page_end": end,
            "file": f"data/{slug}.json",
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

    for section in section_records:
        section_pages = [
            record for record in page_records
            if section["physical_page_start"] <= record["physical_page"] <= section["physical_page_end"]
        ]
        payload = {
            "format": "abhidhamma-table-guide/v1",
            "section": section,
            "pages": section_pages,
        }
        write_json(output / section["file"], payload)

    original_text = "\n\f\n".join(original_text_parts)
    simplified_text = "\n\f\n".join(simplified_text_parts)
    site_map = site_character_map()
    remaining = Counter(ch for ch in simplified_text if ch in site_map and site_map[ch] != ch)
    changed_chars = Counter()
    for before, after in zip(original_text, simplified_text):
        if before != after:
            changed_chars[f"{before}→{after}"] += 1
    audit = {
        "format": "abhidhamma-table-guide-audit/v1",
        "source": {
            "file": source_copy.relative_to(ROOT / "docs").as_posix(),
            "sha256": sha256_bytes(source_bytes),
            "pages": len(reader.pages),
            "title": str(reader.metadata.title if reader.metadata else ""),
            "author": str(reader.metadata.author if reader.metadata else ""),
        },
        "outline": {
            "top_level_entries": len(reader.outline),
            "section_destinations": len(roots),
            "flattened_entries": len(all_outline),
        },
        "conversion": {
            "tool": converter.mode,
            "config": "t2s",
            "display_language": "zh-Hans",
            "exceptions": DISPLAY_REPLACEMENTS,
            "original_characters": len(original_text),
            "simplified_characters": len(simplified_text),
            "original_text_sha256": sha256_bytes(original_text.encode("utf-8")),
            "simplified_text_sha256": sha256_bytes(simplified_text.encode("utf-8")),
            "remaining_traditional_characters": dict(remaining.most_common(100)),
            "changed_character_pairs": dict(changed_chars.most_common(100)),
        },
        "coverage": {
            "pages": len(page_records),
            "sections": len(section_records),
            "complex_pages": len(complex_pages),
            "rendered_source_images": len(page_paths),
            "section_files": [record["file"] for record in section_records],
        },
    }
    write_json(output / "conversion-audit.json", audit)
    manifest = {
        "format": "abhidhamma-table-guide-manifest/v1",
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
        "conversion_audit": "conversion-audit.json",
        "license_note": "本页面为经授权的繁体转简体数字版；原作者、编者、版本与来源信息保持可追溯。",
        "search_documents": [
            {"file": f"research/abhidhamma-sangaha/{record['file']}", "route": record["route"], "title": record["title"], "section": record["slug"]}
            for record in section_records
        ],
    }
    write_json(output / "manifest.json", manifest)
    print(json.dumps({
        "output": str(output),
        "pages": len(page_records),
        "sections": len(section_records),
        "complex_pages": len(complex_pages),
        "source_images": len(page_paths),
        "conversion": converter.mode,
        "source_sha256": sha256_bytes(source_bytes),
    }, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True, help="The born-digital source PDF")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Static output directory")
    args = parser.parse_args()
    build(args.pdf, args.output)


if __name__ == "__main__":
    main()
