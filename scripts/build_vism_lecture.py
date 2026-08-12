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


def text_content(node: Node | str, *, include_tables: bool = True) -> str:
    """Extract cell text without leaking nested table text into its parent.

    Word's HTML exporter places several small outline tables inside cells of
    larger tables.  A generic recursive text walk used to copy those nested
    rows into the parent cell and the parent table's row stream.  The table
    itself is now a first-class child, so its text must be excluded here.
    """
    if isinstance(node, str):
        return node
    if node.tag == "table" and not include_tables:
        return ""
    if node.tag in {"o:p", "xml"}:
        return ""
    if node.tag == "br":
        return "\n"
    return "".join(text_content(child, include_tables=include_tables) for child in node.children)


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


def nested_tables(node: Node) -> list[Node]:
    """Return tables directly contained by a cell, stopping at each table."""
    result: list[Node] = []

    def walk(current: Node) -> None:
        for child in current.children:
            if not isinstance(child, Node):
                continue
            if child.tag == "table":
                result.append(child)
                continue
            walk(child)

    walk(node)
    return result


def blocks_for_cell(cell: Node, converter: Any) -> list[dict[str, Any]]:
    blocks = [child for child in cell.children if isinstance(child, Node) and child.tag in BLOCK_TAGS]
    if not blocks:
        value = simplify(text_content(cell, include_tables=False), converter)
        return [{"index": 0, "text": value, "empty": not bool(value)}]
    result = []
    for index, block in enumerate(blocks):
        value = simplify(text_content(block, include_tables=False), converter)
        result.append({"index": index, "text": value, "empty": not bool(value)})
    return result


def int_attr(node: Node, name: str, default: int = 1) -> int:
    try:
        return max(1, int(node.attrs.get(name, str(default))))
    except ValueError:
        return default


def row_is_calibration(row: Node) -> bool:
    """Word's zero-height column-width row is metadata, not visible content."""
    height = row.attrs.get("height", "").strip().lower()
    if height:
        try:
            if float(re.sub(r"[^0-9.+-]", "", height) or "-1") == 0:
                return True
        except ValueError:
            pass
    style = row.attrs.get("style", "").lower()
    return bool(re.search(r"(?:^|;)\s*height\s*:\s*0(?:\s*(?:pt|px|cm|in|em|rem))?\s*(?:;|$)", style))


def direct_table_rows(table: Node) -> list[Node]:
    """Collect rows belonging to one table, never rows inside nested tables."""
    rows: list[Node] = []

    def walk(node: Node) -> None:
        for child in node.children:
            if not isinstance(child, Node):
                continue
            if child.tag == "table":
                continue
            if child.tag == "tr":
                rows.append(child)
                continue
            walk(child)

    walk(table)
    return rows


def style_width(node: Node) -> str:
    """Return a safe CSS width from the source's inline style/width attribute."""
    style_match = re.search(r"(?:^|;)\s*width\s*:\s*([0-9.]+\s*(?:pt|px|cm|mm|in|em|rem|%))", node.attrs.get("style", ""), re.I)
    if style_match:
        return re.sub(r"\s+", "", style_match.group(1))
    attr = node.attrs.get("width", "").strip()
    if re.fullmatch(r"[0-9.]+", attr):
        return f"{attr}px"
    if re.fullmatch(r"[0-9.]+\s*(?:pt|px|cm|mm|in|em|rem|%)", attr, re.I):
        return re.sub(r"\s+", "", attr)
    return ""


def width_from_cell(cell: Node) -> dict[str, str]:
    css = style_width(cell)
    return {"css": css, "source": cell.attrs.get("width", "").strip()} if css or cell.attrs.get("width") else {}


def cell_value(cell: dict[str, Any]) -> str:
    return "".join(block["text"] for block in cell["blocks"]).replace(" ", "").replace("\n", "")


def parse_tables(root: Node, converter: Any) -> list[dict[str, Any]]:
    """Parse the source table tree while retaining stable source ordinals.

    The source contains 113 top-level tables and 12 tables nested inside
    cells.  The ordinal is assigned in source pre-order so the existing
    ``lecture-table-NNN`` IDs remain stable for review overlays and deep links.
    """
    table_nodes: list[Node] = []
    parent_nodes: dict[int, Node | None] = {}
    parent_cells: dict[int, Node | None] = {}

    def collect(node: Node, parent_table: Node | None = None, parent_cell: Node | None = None) -> None:
        if node.tag == "table":
            table_nodes.append(node)
            parent_nodes[id(node)] = parent_table
            parent_cells[id(node)] = parent_cell
            parent_table = node
            parent_cell = None
        elif node.tag in {"td", "th"} and parent_table is not None:
            parent_cell = node
        for child in node.children:
            if isinstance(child, Node):
                collect(child, parent_table, parent_cell)

    collect(root)
    table_ids = {id(node): f"lecture-table-{index + 1:03d}" for index, node in enumerate(table_nodes)}
    cell_ids: dict[int, str] = {}
    output: list[dict[str, Any]] = []

    for table_index, table in enumerate(table_nodes):
        table_id = table_ids[id(table)]
        source_rows = direct_table_rows(table)
        calibration_rows = [index for index, row in enumerate(source_rows) if row_is_calibration(row)]
        visible_source_rows = [index for index in range(len(source_rows)) if index not in calibration_rows]
        occupied: list[list[bool]] = []
        raw_cells: list[dict[str, Any]] = []
        width_candidates: list[dict[str, str] | None] = []
        for source_row_index, tr in enumerate(source_rows):
            while len(occupied) <= source_row_index:
                occupied.append([])
            x = 0
            direct_cells = [child for child in tr.children if isinstance(child, Node) and child.tag in {"td", "th"}]
            for source_cell_index, cell in enumerate(direct_cells):
                while x < len(occupied[source_row_index]) and occupied[source_row_index][x]:
                    x += 1
                colspan = int_attr(cell, "colspan")
                rowspan = int_attr(cell, "rowspan")
                for yy in range(source_row_index, source_row_index + rowspan):
                    while len(occupied) <= yy:
                        occupied.append([])
                    while len(occupied[yy]) < x + colspan:
                        occupied[yy].append(False)
                    for xx in range(x, x + colspan):
                        occupied[yy][xx] = True
                raw = {
                    "cell_id": f"t{table_index + 1}-r{source_row_index + 1}-c{x + 1}",
                    "source_row": source_row_index,
                    "source_cell": source_cell_index,
                    "source_col": x,
                    "source_colspan": colspan,
                    "rowspan": rowspan,
                    "blocks": blocks_for_cell(cell, converter),
                    "nested_table_ids": [table_ids[id(child)] for child in nested_tables(cell)],
                    "width": width_from_cell(cell),
                    "node_id": id(cell),
                }
                raw_cells.append(raw)
                cell_ids[id(cell)] = raw["cell_id"]
                x += colspan
        width = max((len(row) for row in occupied), default=0)
        width_candidates = [None] * width
        for raw in raw_cells:
            width_info = raw.get("width") or {}
            css = width_info.get("css", "")
            if not css:
                continue
            for column in range(raw["source_col"], min(width, raw["source_col"] + raw["source_colspan"])):
                if width_candidates[column] is None:
                    width_candidates[column] = {"css": css, "source": width_info.get("source", "")}
        page_ranges: list[tuple[int, int]] = []
        for raw in raw_cells:
            if raw["source_row"] in calibration_rows:
                continue
            if cell_value(raw) in PAGE_LABELS:
                page_ranges.append((raw["source_col"], raw["source_col"] + raw["source_colspan"]))
        page_ranges = sorted(set(page_ranges))
        removed_columns = {column for start, end in page_ranges for column in range(start, end)}
        visible: list[dict[str, Any]] = []
        for raw in raw_cells:
            if raw["source_row"] in calibration_rows:
                continue
            start = raw["source_col"]
            end = start + raw["source_colspan"]
            if cell_value(raw) in PAGE_LABELS:
                continue
            projected_columns = [column for column in range(start, end) if column not in removed_columns]
            if not projected_columns:
                continue
            display_col = sum(column not in removed_columns for column in range(0, start))
            cell = {
                "cell_id": raw["cell_id"],
                "row": raw["source_row"],
                "source_row": raw["source_row"],
                "source_cell": raw["source_cell"],
                "col": start,
                "display_col": display_col,
                "colspan": len(projected_columns),
                "source_colspan": raw["source_colspan"],
                "rowspan": raw["rowspan"],
                "blocks": raw["blocks"],
                "nested_table_ids": raw["nested_table_ids"],
            }
            visible.append(cell)
        parent_table = parent_nodes.get(id(table))
        parent_cell = parent_cells.get(id(table))
        output.append({
            "table_id": table_id,
            "source_index": table_index,
            "table_level": 0 if parent_table is None else 1,
            "parent_table_id": table_ids.get(id(parent_table)) if parent_table is not None else None,
            "parent_cell_id": cell_ids.get(id(parent_cell)) if parent_cell is not None else None,
            "source_rows": len(source_rows),
            "rows": len(visible_source_rows),
            "row_indices": visible_source_rows,
            "calibration_rows": calibration_rows,
            "source_columns": width,
            "display_columns": max(0, width - len(removed_columns)),
            "column_widths": width_candidates,
            "removed_page_ranges": [[start, end] for start, end in page_ranges],
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
        row_indices = table.get("row_indices") or list(range(table["rows"]))
        for row in row_indices:
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


def validate_tables(tables: list[dict[str, Any]]) -> dict[str, int]:
    """Validate the structural invariants of the source-derived table tree."""
    if len(tables) != 125:
        raise ValueError(f"expected 125 source tables, got {len(tables)}")
    top_level = [table for table in tables if table["parent_table_id"] is None]
    nested = [table for table in tables if table["parent_table_id"] is not None]
    if len(top_level) != 113 or len(nested) != 12:
        raise ValueError(f"expected 113 top-level and 12 nested tables, got {len(top_level)} and {len(nested)}")
    source_rows = sum(table["source_rows"] for table in tables)
    if source_rows != 1995:
        raise ValueError(f"expected 1995 source rows, got {source_rows}")
    calibration_rows = sum(len(table["calibration_rows"]) for table in tables)
    if calibration_rows != 90:
        raise ValueError(f"expected 90 zero-height calibration rows, got {calibration_rows}")
    page_tables = sum(bool(table["removed_page_ranges"]) for table in tables)
    if page_tables != 8:
        raise ValueError(f"expected 8 tables with a semantic page column, got {page_tables}")
    table_ids = [table["table_id"] for table in tables]
    if len(set(table_ids)) != len(table_ids) or table_ids != [f"lecture-table-{index:03d}" for index in range(1, 126)]:
        raise ValueError("table IDs are not the stable source pre-order")
    cell_ids: list[str] = []
    for table in tables:
        row_indices = set(table["row_indices"])
        if len(row_indices) != table["rows"]:
            raise ValueError(f"{table['table_id']} has inconsistent rendered row metadata")
        if any(cell["row"] not in row_indices for cell in table["cells"]):
            raise ValueError(f"{table['table_id']} contains a cell from a hidden calibration row")
        if table["display_columns"] != table["source_columns"] - sum(end - start for start, end in table["removed_page_ranges"]):
            raise ValueError(f"{table['table_id']} has inconsistent display column count")
        cell_ids.extend(cell["cell_id"] for cell in table["cells"])
        for cell in table["cells"]:
            if cell["display_col"] < 0 or cell["colspan"] < 1:
                raise ValueError(f"{table['table_id']} contains an invalid projected cell")
            if not set(cell.get("nested_table_ids", [])).issubset(set(table_ids)):
                raise ValueError(f"{table['table_id']} contains an unknown nested table")
    if len(cell_ids) != len(set(cell_ids)):
        raise ValueError("duplicate source cell IDs detected")
    return {
        "tables": len(tables),
        "top_level_tables": len(top_level),
        "nested_tables": len(nested),
        "source_rows": source_rows,
        "rendered_rows": sum(table["rows"] for table in tables),
        "calibration_rows": calibration_rows,
        "page_tables": page_tables,
        "cells": len(cell_ids),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--source-url", default=SOURCE_URL)
    parser.add_argument("--validate", action="store_true", help="validate source-derived table invariants after building")
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
    validation = validate_tables(tables) if args.validate else None
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
        "counts": {"tables": len(tables), "top_level_tables": sum(table["parent_table_id"] is None for table in tables), "nested_tables": sum(table["parent_table_id"] is not None for table in tables), "source_rows": sum(t["source_rows"] for t in tables), "rendered_rows": sum(t["rows"] for t in tables), "calibration_rows": sum(len(t["calibration_rows"]) for t in tables), "visible_cells": sum(len(t["cells"]) for t in tables), "anchor_items": len(items), "removed_page_tables": page_table_count, "removed_page_ranges": page_cell_count},
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
    result = {"source_sha256": source_sha, "tables": len(tables), "source_rows": sum(t["source_rows"] for t in tables), "rendered_rows": sum(t["rows"] for t in tables), "anchor_items": len(items), "removed_page_tables": page_table_count, "removed_page_ranges": page_cell_count, "reader_chapters": len(reader_rows)}
    if validation:
        result["validation"] = validation
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
