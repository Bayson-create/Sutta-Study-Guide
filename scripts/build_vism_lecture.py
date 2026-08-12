#!/usr/bin/env python3
"""Build the local, simplified lecture snapshot for the Visuddhimagga page.

The source is an old Word-generated HTML document.  This builder deliberately
keeps the table grid (including row/column spans and blank paragraphs) instead
of flattening it into Markdown, because vertical position is part of the
meaning of the outline.  It does not invent reader anchors: anchor-map entries
start as ``unmapped`` until a stable Pāli/English row is explicitly supplied.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import unicodedata
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

try:
    from opencc import OpenCC  # type: ignore
except ImportError as exc:  # pragma: no cover - build environment guard
    raise SystemExit("opencc-python-reimplemented is required") from exc


SOURCE_URL = "https://dhammarain.github.io/canon/Anna/read1/read1.htm"
PAGE_LABELS = {"页数", "頁數"}
BLOCK_TAGS = {"p", "div", "li", "pre"}
VOID_TAGS = {"br", "hr", "img", "meta", "link", "input", "source", "wbr"}


class Node:
    def __init__(self, tag: str = "root", attrs: dict[str, str] | None = None) -> None:
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list[Node | str] = []


class TreeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag.lower(), {key.lower(): value or "" for key, value in attrs})
        self.stack[-1].children.append(node)
        if node.tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag.lower() and tag.lower() not in VOID_TAGS:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.append(data)


def text_content(node: Node | str) -> str:
    if isinstance(node, str):
        return node
    if node.tag in {"o:p", "xml"}:
        return ""
    if node.tag == "br":
        return "\n"
    return "".join(text_content(child) for child in node.children)


def simplify(value: str, converter: Any) -> str:
    value = html.unescape(value).replace("\r\n", "\n").replace("\r", "\n")
    value = value.replace("\u00a0", " ").replace("\u200b", "")
    value = re.sub(r"<!\[if[^>]*>|<!\[endif\]>", "", value)
    value = converter.convert(value)
    # Keep blank lines and intentional in-cell alignment, but remove the
    # non-content indentation introduced by Word's HTML export.
    lines = [re.sub(r"[ \t]+$", "", line).strip() for line in value.split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def direct_children(node: Node, tag: str) -> list[Node]:
    return [child for child in node.children if isinstance(child, Node) and child.tag == tag]


def blocks_for_cell(cell: Node, converter: Any) -> list[dict[str, Any]]:
    blocks = [child for child in cell.children if isinstance(child, Node) and child.tag in BLOCK_TAGS]
    if not blocks:
        value = simplify(text_content(cell), converter)
        return [{"index": 0, "text": value, "empty": not bool(value)}]
    result = []
    for index, block in enumerate(blocks):
        value = simplify(text_content(block), converter)
        result.append({"index": index, "text": value, "empty": not bool(value)})
    return result


def int_attr(node: Node, name: str, default: int = 1) -> int:
    try:
        return max(1, int(node.attrs.get(name, str(default))))
    except ValueError:
        return default


def parse_tables(root: Node, converter: Any) -> list[dict[str, Any]]:
    tables: list[Node] = []

    def walk(node: Node) -> None:
        if node.tag == "table":
            tables.append(node)
        for child in node.children:
            if isinstance(child, Node):
                walk(child)

    walk(root)
    output = []
    for table_index, table in enumerate(tables):
        trs = []

        def collect_rows(node: Node) -> None:
            if node.tag == "tr":
                trs.append(node)
                return
            for child in node.children:
                if isinstance(child, Node):
                    collect_rows(child)

        collect_rows(table)
        occupied: list[list[bool]] = []
        cells: list[dict[str, Any]] = []
        for row_index, tr in enumerate(trs):
            occupied.extend([] for _ in range(max(0, row_index + 1 - len(occupied))))
            x = 0
            direct_cells = [child for child in tr.children if isinstance(child, Node) and child.tag in {"td", "th"}]
            for cell_index, cell in enumerate(direct_cells):
                while x < len(occupied[row_index]) and occupied[row_index][x]:
                    x += 1
                colspan = int_attr(cell, "colspan")
                rowspan = int_attr(cell, "rowspan")
                for yy in range(row_index, row_index + rowspan):
                    while len(occupied) <= yy:
                        occupied.append([])
                    while len(occupied[yy]) < x + colspan:
                        occupied[yy].append(False)
                    for xx in range(x, x + colspan):
                        occupied[yy][xx] = True
                cells.append({
                    "cell_id": f"t{table_index + 1}-r{row_index + 1}-c{x + 1}",
                    "row": row_index,
                    "source_cell": cell_index,
                    "col": x,
                    "colspan": colspan,
                    "rowspan": rowspan,
                    "blocks": blocks_for_cell(cell, converter),
                })
                x += colspan
        width = max((len(row) for row in occupied), default=0)
        page_ranges: list[tuple[int, int]] = []
        for cell in cells:
            value = "".join(block["text"] for block in cell["blocks"]).replace(" ", "").replace("\n", "")
            if value in PAGE_LABELS:
                page_ranges.append((cell["col"], cell["col"] + cell["colspan"]))
        page_ranges = sorted(set(page_ranges))
        def is_page_cell(cell: dict[str, Any]) -> bool:
            start, end = cell["col"], cell["col"] + cell["colspan"]
            return any(start < page_end and end > page_start for page_start, page_end in page_ranges)
        visible = [cell for cell in cells if not is_page_cell(cell)]
        output.append({
            "table_id": f"lecture-table-{table_index + 1:03d}",
            "source_index": table_index,
            "source_rows": len(trs),
            "source_columns": width,
            "removed_page_ranges": [[start, end] for start, end in page_ranges],
            "rows": len(trs),
            "cells": visible,
        })
    return output


CN_NUM = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def chinese_number(value: str) -> int | None:
    value = value.replace("两", "二")
    if value == "十":
        return 10
    if "十" in value:
        left, right = value.split("十", 1)
        return (CN_NUM.get(left, 1) if left else 1) * 10 + (CN_NUM.get(right, 0) if right else 0)
    return CN_NUM.get(value)


def chapter_from_text(value: str) -> int | None:
    compact = re.sub(r"\s+", "", value)
    match = re.search(r"第?([一二两三四五六七八九十]+)说", compact)
    if not match:
        return None
    number = chinese_number(match.group(1))
    return number if number and 1 <= number <= 23 else None


def build_items(tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    current_chapter: int | None = None
    for table in tables:
        for row in range(table["rows"]):
            row_cells = [cell for cell in table["cells"] if cell["row"] == row]
            row_chapter = next((chapter_from_text("".join(block["text"] for block in cell["blocks"])) for cell in row_cells if chapter_from_text("".join(block["text"] for block in cell["blocks"]))), None)
            if row_chapter:
                current_chapter = row_chapter
            for cell in row_cells:
                if cell["col"] not in {2, 3, 4}:
                    continue
                for block in cell["blocks"]:
                    if block["empty"]:
                        continue
                    item_id = f"{table['table_id']}-r{row + 1:03d}-c{cell['col'] + 1:02d}-b{block['index'] + 1:03d}"
                    items.append({
                        "item_id": item_id,
                        "table_id": table["table_id"],
                        "row": row,
                        "col": cell["col"],
                        "block": block["index"],
                        "text": block["text"],
                        "chapter": row_chapter or current_chapter,
                        "parent_item_ids": [],
                    })
    # Preserve the geometric hierarchy as an auditable candidate chain.  The
    # renderer does not use this as an anchor; it explains why a nested item
    # appears under the preceding column in the source table.
    for item in items:
        preceding = [candidate for candidate in items if candidate["table_id"] == item["table_id"] and candidate["row"] == item["row"] and candidate["col"] < item["col"]]
        if preceding:
            previous_col = max(candidate["col"] for candidate in preceding)
            item["parent_item_ids"] = [candidate["item_id"] for candidate in preceding if candidate["col"] == previous_col]
    return items


def normalize_anchor(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"\s+", " ", value).strip().casefold()


def read_reader_rows(data_root: Path) -> dict[int, list[dict[str, Any]]]:
    rows: dict[int, list[dict[str, Any]]] = {}
    for path in sorted(data_root.glob("pe_chap*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        chapter = int(data.get("chapter", 0))
        flat = []
        for part_index, part in enumerate(data.get("parts", []), start=1):
            for row_index, row in enumerate(part.get("rows", []), start=1):
                pali = row.get("pali", "")
                english = row.get("english", "")
                flat.append({
                    "part_index": part_index,
                    "row_index": row_index,
                    "pali": pali,
                    "english": english,
                    "pali_hash": hashlib.sha256(normalize_anchor(pali).encode()).hexdigest()[:16],
                    "english_hash": hashlib.sha256(normalize_anchor(english).encode()).hexdigest()[:16],
                })
        rows[chapter] = flat
    return rows


def build_reader_anchor_catalog(
    source_sha: str,
    items: list[dict[str, Any]],
    reader_rows: dict[int, list[dict[str, Any]]],
) -> dict[str, Any]:
    """Write only the identity material needed by the review API.

    The backend must be able to reject a stale or fabricated target without
    receiving the corpus itself.  Keeping hashes/snippets and the lecture
    item's geometric context here gives it that proof while leaving the full
    Pāli/English files in the static frontend data set.
    """
    item_catalog = {
        item["item_id"]: {
            "table_id": item["table_id"],
            "row": item["row"],
            "col": item["col"],
            "block": item["block"],
            "chapter": item.get("chapter"),
            "parent_item_ids": item.get("parent_item_ids", []),
        }
        for item in items
    }
    chapter_catalog: dict[str, dict[str, Any]] = {}
    for chapter, rows in sorted(reader_rows.items()):
        chapter_catalog[str(chapter)] = {
            "rows": {
                f"{row['part_index']}-{row['row_index']}": {
                    "pali_hash": row["pali_hash"],
                    "english_hash": row["english_hash"],
                    "pali_snippet": row["pali"][:240],
                    "english_snippet": row["english"][:240],
                }
                for row in rows
            }
        }
    return {
        "format": "vism-lecture-reader-anchors/v1",
        "source_sha256": source_sha,
        "normalization": "NFKC + whitespace collapse + casefold",
        "hash": "sha256-prefix-16",
        "counts": {"items": len(item_catalog), "chapters": len(chapter_catalog), "rows": sum(len(value["rows"]) for value in chapter_catalog.values())},
        "items": item_catalog,
        "chapters": chapter_catalog,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--source-url", default=SOURCE_URL)
    args = parser.parse_args()

    source = args.source.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    source_bytes = source.read_bytes()
    source_sha = hashlib.sha256(source_bytes).hexdigest()
    snapshot = out_dir / "lecture-source-v1.html"
    if source != snapshot.resolve():
        shutil.copyfile(source, snapshot)

    parser_impl = TreeParser()
    parser_impl.feed(source_bytes.decode("utf-8", errors="strict"))
    converter = OpenCC("t2s")
    tables = parse_tables(parser_impl.root, converter)
    items = build_items(tables)
    reader_rows = read_reader_rows(out_dir)
    simplified_text = "\n".join(block["text"] for table in tables for cell in table["cells"] for block in cell["blocks"] if block["text"])
    simplified_sha = hashlib.sha256(simplified_text.encode("utf-8")).hexdigest()
    page_table_count = sum(bool(table["removed_page_ranges"]) for table in tables)
    page_cell_count = sum(len(table["removed_page_ranges"]) for table in tables)

    lecture = {
        "format": "vism-lecture/v1",
        "source": {"url": args.source_url, "sha256": source_sha, "snapshot": snapshot.name},
        "conversion": {"tool": "OpenCC", "config": "t2s", "display_language": "zh-Hans"},
        "counts": {"tables": len(tables), "source_rows": sum(t["source_rows"] for t in tables), "visible_cells": sum(len(t["cells"]) for t in tables), "anchor_items": len(items), "removed_page_tables": page_table_count, "removed_page_ranges": page_cell_count},
        "content_sha256": simplified_sha,
        "tables": tables,
    }
    anchor_map = {
        "format": "vism-lecture-anchors/v1",
        "source_sha256": source_sha,
        "reader_anchor_policy": "pali_or_english_hash_only",
        "counts": {"items": len(items), "verified": 0, "unmapped": len(items)},
        "items": [{**item, "status": "unmapped", "reason": "requires_curated_unique_pali_or_english_anchor", "target": None} for item in items],
    }
    reader_anchor_catalog = build_reader_anchor_catalog(source_sha, items, reader_rows)
    (out_dir / "lecture-v1.json").write_text(json.dumps(lecture, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    (out_dir / "lecture-anchor-map-v1.json").write_text(json.dumps(anchor_map, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    (out_dir / "lecture-reader-anchor-v1.json").write_text(json.dumps(reader_anchor_catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"source_sha256": source_sha, "tables": len(tables), "source_rows": sum(t["source_rows"] for t in tables), "anchor_items": len(items), "removed_page_tables": page_table_count, "removed_page_ranges": page_cell_count, "reader_chapters": len(reader_rows)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
