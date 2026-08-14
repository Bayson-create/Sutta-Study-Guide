#!/usr/bin/env python3
"""Build a simplified, auditable study edition of Vism_abst.html.

The source is a Word-exported learning handout.  This builder preserves every
paragraph in source order while exposing its 21 chapter blocks and 216
self-assessment questions as stable data for the public study page.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

from opencc import OpenCC  # type: ignore

from build_vism_lecture import Node, TreeParser, simplify


SOURCE_URL = "https://dhammarain.github.io/canon/Anna/read1/Vism_abst.html"
EXPECTED_SECTION_CHAPTERS = [[1], [2], [3], [4, 5], [6], [7], [8], [9], [10], [11], [12, 13], [14], [15], [16], [17], [18], [19], [20], [21], [22], [23]]
QUESTION = re.compile(r"^(\d{1,2})\.\s*(.+)$")
# Word exports the outline tables as paragraphs made from box-drawing
# characters.  A number of legitimate table rows contain only one side bar
# or one short separator, so counting eight characters silently classified
# those rows as ordinary prose and split one visual table into many fragments.
# A lone ─ is also used as ordinary Chinese punctuation in 90 prose rows; it
# is deliberately not enough to make a paragraph a visual table row.
DIAGRAM = re.compile(r"[┌┐└┘├┤┬┴│]")
BOX_DRAWING = re.compile(r"[┌┐└┘├┤┬┴─│]")


def walk(node: Node) -> list[Node]:
    result: list[Node] = []
    for child in node.children:
        if not isinstance(child, Node):
            continue
        result.append(child)
        result.extend(walk(child))
    return result


def body(root: Node) -> Node:
    return next((node for node in walk(root) if node.tag == "body"), root)


def visible_text(node: Node, converter: Any) -> str:
    # text_content is intentionally imported lazily to keep the old lecture
    # builder as the single definition of Word/HTML text extraction rules.
    from build_vism_lecture import text_content
    return simplify(text_content(node), converter)


def clean_heading(value: str) -> str:
    value = re.sub(r"回首\s*页|回首页", "", value)
    return re.sub(r"\s+", " ", value).strip()


def outline_text_content(node: Node | str, *, include_tables: bool = True) -> str:
    """Read visible text while distinguishing HTML formatting newlines.

    The Word exporter wraps tags across physical source lines.  Those line
    breaks are not diagram rows; only an actual ``<br>`` is.  ASCII spaces in
    ``mso-spacerun`` spans are preserved so the layout parser can use them.
    """
    if isinstance(node, str):
        return node.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    if node.tag == "table" and not include_tables:
        return ""
    if node.tag in {"o:p", "xml"}:
        return ""
    if node.tag == "br":
        return "\n"
    return "".join(outline_text_content(child, include_tables=include_tables) for child in node.children)


def is_diagram(value: str) -> bool:
    return bool(DIAGRAM.search(value))


def simplify_layout(value: str, converter: Any) -> str:
    """Convert a Word diagram without destroying its horizontal layout.

    The ordinary ``simplify`` helper is correct for prose, but its ``strip``
    calls remove the leading spaces that Word used as diagram columns.  Keep
    those spaces for diagram rows and let the structured layout builder turn
    them into stable column coordinates.
    """
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = value.replace("\u00a0", " ").replace("\u200b", "")
    value = re.sub(r"<!\[if[^>]*>|<!\[endif\]>", "", value)
    value = converter.convert(value)
    lines = [re.sub(r"[ \t]+$", "", line) for line in value.split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def display_width(value: str) -> int:
    """Return a deterministic terminal-like width for a diagram string."""
    width = 0
    for char in value:
        if unicodedata.combining(char):
            continue
        width += 2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
    return width


def positioned_characters(line: str) -> list[tuple[int, int, str]]:
    """Return source-grid positions, not browser display positions.

    Word's diagrams are authored on a character grid. A CJK glyph may occupy
    two terminal cells when rendered, but it still occupies one source column
    between box-drawing junctions. Layout width is handled by CSS later.
    """
    result: list[tuple[int, int, str]] = []
    cursor = 0
    for char in line:
        char_width = 0 if unicodedata.combining(char) else 1
        if char_width:
            result.append((cursor, cursor + char_width, char))
            cursor += char_width
        elif result:
            start, end, previous = result[-1]
            result[-1] = (start, end, previous + char)
    return result


FRAME_CHARS = set("┌┐└┘├┤┬┴┼─│")
VERTICAL_CHARS = set("│├┤┬┴┼")


def source_columns(top_line: str) -> list[int]:
    """Find boundaries in the original Word character grid."""
    return [start for start, _end, char in positioned_characters(top_line) if char in {"┌", "┬", "┐"}]


def clean_cell_text(value: str) -> str:
    """Remove frame glyphs while retaining inner branches as readable labels."""
    chunks: list[str] = []
    current: list[str] = []
    saw_branch = False
    for char in value.replace("\u00a0", " "):
        if char in FRAME_CHARS:
            if current:
                chunks.append("".join(current))
                current = []
            if char in {"┌", "├", "└", "│"}:
                saw_branch = True
            continue
        current.append(char)
    if current:
        chunks.append("".join(current))
    text = " · ".join(chunk.strip() for chunk in chunks if chunk.strip())
    if saw_branch and text:
        text = "↳ " + text
    return re.sub(r"[ \t]+", " ", text).strip()


def row_boundary_positions(line: str, boundaries: list[int]) -> list[int]:
    """Align a row's visible separators to the top-rule columns.

    Word inserts full-width spaces into some rows, so their separators can be
    shifted by one or more source characters. When an inner branch adds extra
    bars, dynamic programming chooses the monotonic subset closest to the
    top-rule geometry instead of treating the branch as a new outer column.
    """
    bars = [start for start, _end, char in positioned_characters(line) if char == "│"]
    expected = len(boundaries)
    if len(bars) <= 2:
        return bars
    if len(bars) == expected:
        return bars
    if len(bars) < expected:
        return bars
    states: list[tuple[float, list[int]]] = [(0.0, [])]
    for target in boundaries:
        next_states: list[tuple[float, list[int]]] = []
        for cost, chosen in states:
            candidates = [bar for bar in bars if not chosen or bar > chosen[-1]]
            for bar in candidates:
                next_states.append((cost + abs(bar - target), chosen + [bar]))
        next_states.sort(key=lambda item: item[0])
        states = next_states[:64]
    return min(states, key=lambda item: item[0])[1] if states else bars[:expected]


def table_part_layout(lines: list[str]) -> dict[str, Any]:
    """Parse one independent box root into semantic rows and spanning cells."""
    text = "\n".join(lines)
    top_line = next((line for line in lines if "┌" in line and "─" in line), "")
    boundaries = source_columns(top_line)
    if len(boundaries) < 2:
        return {"kind": "flow", "source_text": text, "rows": [
            {"type": "flow", "source": line, "text": clean_cell_text(line)} for line in lines
        ]}
    # Local boxes embedded in a branching diagram are not standalone tables:
    # their top rule contains several independent box starts on one line.
    # A genuine table has exactly one outer start/end pair; its later full-
    # width annotation rows are allowed to be longer than the top rule.
    if top_line.count("┌") != 1 or top_line.count("┐") != 1:
        return {"kind": "flow", "source_text": text, "rows": [
            {"type": "flow", "source": line, "text": clean_cell_text(line)} for line in lines
        ]}
    columns = [{"index": index, "start": left, "end": right, "width": max(1, right - left)}
               for index, (left, right) in enumerate(zip(boundaries, boundaries[1:]))]
    rows: list[dict[str, Any]] = []
    for line in lines:
        chars = {start: char for start, _end, char in positioned_characters(line)}
        is_separator = bool("─" in line and all(char in " ─┌┐└┘├┤┬┴┼│" for char in line))
        present = row_boundary_positions(line, boundaries)
        if is_separator:
            rows.append({"type": "separator", "source": line, "cells": [], "colspan": len(columns)})
            continue
        internal = present[1:-1] if len(present) >= 3 else []
        if not internal:
            left = present[0] if present else boundaries[0]
            right = present[-1] if len(present) > 1 else boundaries[-1]
            raw = "".join(char for start, _end, char in positioned_characters(line)
                          if left <= start < right)
            rows.append({"type": "cells", "source": line, "colspan": len(columns), "cells": [
                {"column": 0, "text": clean_cell_text(raw), "colspan": len(columns)}
            ]})
            continue
        if len(present) < len(boundaries):
            # Sparse separators encode colspan: omitted columns belong to the
            # final visible cell. This avoids slicing CJK text with the
            # top-rule coordinates when Word leaves a continuation row open.
            cells = []
            boundary_columns = list(range(len(present) - 1)) + [len(columns)]
            for index, (left, right) in enumerate(zip(present, present[1:])):
                raw = "".join(char for start, _end, char in positioned_characters(line)
                              if left < start < right)
                start_column = boundary_columns[index]
                span = max(1, boundary_columns[index + 1] - start_column)
                cells.append({"column": start_column, "text": clean_cell_text(raw), "colspan": span})
            rows.append({"type": "cells", "source": line, "colspan": len(columns), "cells": cells})
            continue
        cells = []
        row_boundaries = present
        for index, (left, right) in enumerate(zip(row_boundaries, row_boundaries[1:])):
            raw = "".join(char for start, _end, char in positioned_characters(line)
                          if left < start < right)
            cells.append({"column": index, "text": clean_cell_text(raw), "colspan": 1})
        while len(cells) < len(columns):
            cells.append({"column": len(cells), "text": "", "colspan": 1})
        outside = "".join(
            char for start, _end, char in positioned_characters(line)
            if start < row_boundaries[0] or start >= row_boundaries[-1]
        )
        outside_text = clean_cell_text(outside)
        if outside_text and cells:
            cells[-1]["text"] = " · ".join(filter(None, [cells[-1]["text"], outside_text]))
        rows.append({"type": "cells", "source": line, "colspan": 1, "cells": cells})
    # Repair any row whose inferred separators would lose text by retaining
    # that complete source row as a single colspan cell. This keeps the table
    # semantic at group level while making the uncertain row auditable and
    # content-complete.
    for index, line in enumerate(lines):
        if index >= len(rows) or rows[index].get("type") != "cells":
            continue
        expected_row = Counter(re.findall(
            r"[\u3400-\u9fffA-Za-z0-9]",
            re.sub(r"[┌┐└┘├┤┬┴┼─│]", "", line),
        ))
        actual_row_text = "".join(str(cell.get("text", "")) for cell in rows[index].get("cells", []))
        actual_row = Counter(re.findall(r"[\u3400-\u9fffA-Za-z0-9]", actual_row_text))
        if expected_row != actual_row:
            rows[index] = {
                "type": "cells",
                "source": line,
                "colspan": len(columns),
                "cells": [{"column": 0, "text": clean_cell_text(line), "colspan": len(columns)}],
            }
    source_chars = Counter(re.findall(
        r"[\u3400-\u9fffA-Za-z0-9]",
        re.sub(r"[┌┐└┘├┤┬┴┼─│]", "", text),
    ))
    visible_text = "".join(
        str(row.get("text", "")) + "".join(str(cell.get("text", "")) for cell in row.get("cells", []))
        for row in rows
    )
    if source_chars != Counter(re.findall(r"[\u3400-\u9fffA-Za-z0-9]", visible_text)):
        # A malformed Word drawing cannot safely be inferred as a grid. Keep
        # every source word in a readable flow representation and let the
        # audit metadata record that it used the safe fallback.
        return {"kind": "flow", "source_text": text, "rows": [
            {"type": "flow", "source": line, "text": clean_cell_text(line)} for line in lines
        ]}
    return {"kind": "table", "source_text": text, "columns": columns, "rows": rows}


def split_diagram_roots(text: str) -> list[list[str]]:
    """Split adjacent independent box roots without splitting inner branches."""
    roots: list[list[str]] = []
    current: list[str] = []
    closed = False
    for line in text.split("\n"):
        starts_root = bool(line.lstrip().startswith("┌") and "─" in line)
        if starts_root and current and closed:
            roots.append(current)
            current = []
        current.append(line)
        if "└" in line and "┘" in line:
            closed = True
        elif starts_root:
            closed = False
    if current:
        roots.append(current)
    return roots or [text.split("\n")]


def diagram_layout(text: str) -> dict[str, Any]:
    """Build a semantic, source-auditable grid from one character diagram.

    These source diagrams are not HTML tables.  Their vertical junctions are
    the only reliable column boundary, so we preserve those coordinates and
    turn each interval into a real visual cell.  Border rows remain explicit
    metadata rather than being mistaken for prose or dropped.
    """
    roots = [table_part_layout(root) for root in split_diagram_roots(text)]
    return {
        "kind": "multi" if len(roots) > 1 else roots[0].get("kind", "flow"),
        "source_text": text,
        "parts": roots,
        # Compatibility fields for existing audit tooling and old readers.
        "columns": roots[0].get("columns", []) if roots else [],
        "rows": roots[0].get("rows", []) if roots else [],
    }
    # Legacy parser retained below as an audit reference; the return above is
    # the only production path.
    lines = text.split("\n")
    boundary_chars = set("│├┤┬┴┼┌┐└┘")
    boundary_positions: set[int] = set()
    # The first complete top rule defines the logical columns.  Later rows
    # often contain nested sub-columns; treating every inner bar as a new
    # top-level column was the source of the tiny, unreadable cells in the
    # previous projection.
    top_line = next((line for line in lines if "┌" in line and "─" in line), "")
    top_characters = positioned_characters(top_line)
    if top_characters:
        boundary_positions.update(start for start, _end, char in top_characters if char in boundary_chars)
    # A Word top rule measures dashes in the original single-width grid,
    # while the converted Chinese text is rendered at East-Asian width.  If a
    # first content row has the same number of visible outer bars, use those
    # measured positions so its text remains inside the corresponding cell.
    top_index = lines.index(top_line) if top_line in lines else -1
    separator_characters = set(" ─┌┐└┘├┤┬┴┼│")
    content_line = next(
        (
            line for line in lines[top_index + 1:]
            if "│" in line
            and not ("─" in line and all(char in separator_characters for char in line))
            and sum(1 for _start, _end, char in positioned_characters(line) if char == "│") >= 2
        ),
        "",
    )
    content_positions = [start for start, _end, char in positioned_characters(content_line) if char == "│"]
    if len(content_positions) >= 2:
        boundary_positions = set(content_positions)
    if len(boundary_positions) < 2:
        for line in lines:
            for start, _end, char in positioned_characters(line):
                if char in boundary_chars:
                    boundary_positions.add(start)
    boundaries = sorted(boundary_positions)
    if len(boundaries) < 2:
        return {
            "kind": "flow",
            "source_text": text,
            "columns": [],
            "rows": [{"type": "flow", "source": line, "text": line.strip()} for line in lines],
        }
    max_width = max([display_width(line) for line in lines] + [boundaries[-1] + 1])
    if max_width > boundaries[-1] + 1:
        boundaries.append(max_width)
    columns = [
        {"index": index, "start": left, "end": right, "width": max(1, right - left)}
        for index, (left, right) in enumerate(zip(boundaries, boundaries[1:]))
    ]
    rows: list[dict[str, Any]] = []
    for line in lines:
        chars = positioned_characters(line)
        is_separator = "─" in line and not any(char not in " ─┌┐└┘├┤┬┴┼│" for _start, _end, char in chars)
        row: dict[str, Any] = {
            "type": "separator" if is_separator else "cells",
            "source": line,
            "cells": [],
        }
        for column_index, (left, right) in enumerate(zip(boundaries, boundaries[1:])):
            value = "".join(
                char if char not in boundary_chars or start > left and end < right else ""
                for start, end, char in chars
                if start >= left and end <= right
            )
            value = value.strip()
            row["cells"].append({"column": column_index, "text": value})
        rows.append(row)
    return {
        "kind": "table",
        "source_text": text,
        "columns": columns,
        "rows": rows,
    }


def annotate_diagram_groups(sections: list[dict[str, Any]]) -> None:
    """Assign each box-drawing run to one stable visual table group.

    The source has no semantic table element for these diagrams: it stores
    every visible row as a separate paragraph.  Group IDs let the browser
    render the complete run as one scrollable grid while keeping every source
    paragraph ID and its original order intact.
    """
    for section in sections:
        group_number = 0
        active_group: str | None = None
        section["diagram_groups"] = {}
        grouped_blocks: dict[str, list[dict[str, Any]]] = {}
        for block in section["blocks"]:
            if block["kind"] != "diagram":
                active_group = None
                continue
            if active_group is None:
                group_number += 1
                active_group = f"{section['id']}-diagram-{group_number:02d}"
            block["diagram_group"] = active_group
            grouped_blocks.setdefault(active_group, []).append(block)
        for group_id, blocks in grouped_blocks.items():
            layout = diagram_layout("\n".join(block["text"] for block in blocks))
            layout["audit"] = {
                "status": "structured" if all(part.get("kind") == "table" for part in layout.get("parts", [])) else "flow-safe",
                "source_block_ids": [block["id"] for block in blocks],
                "source_line_count": len(layout.get("source_text", "").splitlines()),
                "visible_text_sha256": hashlib.sha256(
                    re.sub(r"[┌┐└┘├┤┬┴┼─│]", "", layout.get("source_text", "")).encode("utf-8")
                ).hexdigest(),
            }
            section["diagram_groups"][group_id] = layout


def section_blocks(root: Node, converter: Any) -> tuple[list[dict[str, Any]], int]:
    nodes = [node for node in walk(body(root)) if node.tag in {"h3", "p"}]
    paragraphs = sum(node.tag == "p" for node in nodes)
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    preface: list[dict[str, Any]] = []
    for source_index, node in enumerate(nodes):
        raw_text = outline_text_content(node)
        text = simplify(raw_text, converter)
        layout_text = simplify_layout(raw_text, converter)
        diagram = is_diagram(layout_text)
        if node.tag == "h3":
            current = {
                "id": f"vism-outline-section-{len(sections) + 1:02d}",
                "source_heading": text,
                "title": clean_heading(text),
                "chapter_ids": EXPECTED_SECTION_CHAPTERS[len(sections)],
                "blocks": [],
                "questions": [],
            }
            sections.append(current)
            continue
        block = {
            "id": f"p-{source_index + 1:04d}",
            "source_index": source_index,
            "text": layout_text if diagram else text,
            "empty": not bool(text),
            "kind": "diagram" if diagram else "paragraph",
        }
        if current is None:
            preface.append(block)
        else:
            current["blocks"].append(block)
    all_sections = [{"id": "vism-outline-preface", "title": "前言与目录", "chapter_ids": [], "blocks": preface, "questions": []}, *sections]
    annotate_diagram_groups(all_sections)
    return all_sections, paragraphs


def annotate_sections(sections: list[dict[str, Any]]) -> None:
    for section in sections:
        phase = "overview"
        active_question: dict[str, Any] | None = None
        for block in section["blocks"]:
            text = block["text"]
            compact = re.sub(r"\s+", "", text)
            if "学习目标" in compact:
                phase = "learning_goals"
            elif "重要词汇" in compact or "重要辞汇" in compact:
                phase = "terms"
            elif "自我评量题目" in compact:
                phase = "questions"
                active_question = None
            block["role"] = phase
            if compact.startswith("回首页"):
                # Some combined source sections include a small outline or
                # diagram after their assessment and before the next H3. It
                # is still preserved as a source block, but is not another
                # self-assessment set.
                phase = "post_questions"
                block["role"] = phase
                active_question = None
                continue
            if phase != "questions" or not text or is_diagram(text):
                if is_diagram(text):
                    active_question = None
                continue
            match = QUESTION.match(text)
            if match:
                number = int(match.group(1))
                question_id = f"{section['id']}-q{number:03d}"
                active_question = {
                    "id": question_id,
                    "number": number,
                    "text": match.group(2).strip(),
                    "source_block_ids": [block["id"]],
                    "chapter_ids": section["chapter_ids"],
                }
                section["questions"].append(active_question)
            elif active_question and not text.startswith("└") and not text.startswith("┌"):
                # Word occasionally splits one natural-language question over
                # two paragraphs.  Character diagrams remain source blocks,
                # not accidental question text.
                active_question["text"] = f"{active_question['text']} {text}".strip()
                active_question["source_block_ids"].append(block["id"])


def validate(payload: dict[str, Any]) -> None:
    sections = payload["sections"]
    if len(sections) != 22 or len(sections[1:]) != 21:
        raise ValueError(f"expected preface + 21 source sections, got {len(sections)}")
    questions = [question for section in sections for question in section["questions"]]
    if len(questions) != 216 or len({question["id"] for question in questions}) != 216:
        raise ValueError(f"expected 216 stable questions, got {len(questions)}")
    if sorted({chapter for section in sections for chapter in section["chapter_ids"]}) != list(range(1, 24)):
        raise ValueError("source section chapter mapping is incomplete")
    if payload["counts"]["paragraphs"] != 3131:
        raise ValueError(f"expected 3131 source paragraphs, got {payload['counts']['paragraphs']}")
    diagram_blocks = [
        block
        for section in sections
        for block in section["blocks"]
        if is_diagram(block["text"])
    ]
    if len(diagram_blocks) != payload["counts"]["diagrams"]:
        raise ValueError("diagram count does not match the source block classification")
    if any(block.get("kind") != "diagram" or not block.get("diagram_group") for block in diagram_blocks):
        raise ValueError("every box-drawing source row must have one stable diagram group")
    for section in sections:
        group_ids = {block.get("diagram_group") for block in section["blocks"] if block.get("diagram_group")}
        for group_id in group_ids:
            layout = section.get("diagram_groups", {}).get(group_id)
            if not layout or not layout.get("rows") or not layout.get("source_text"):
                raise ValueError(f"diagram group lacks a structured layout: {group_id}")
            source_chars = Counter(re.findall(
                r"[\u3400-\u9fffA-Za-z0-9]",
                re.sub(r"[┌┐└┘├┤┬┴┼─│]", "", layout["source_text"]),
            ))
            visible_text = ""
            for part in layout.get("parts", [layout]):
                for row in part.get("rows", []):
                    visible_text += str(row.get("text", ""))
                    visible_text += "".join(str(cell.get("text", "")) for cell in row.get("cells", []))
            visible_chars = Counter(re.findall(r"[\u3400-\u9fffA-Za-z0-9]", visible_text))
            if source_chars != visible_chars:
                raise ValueError(f"diagram text coverage mismatch: {group_id}")
            if re.search(r"[┌┐└┘├┤┬┴┼─│]", visible_text):
                raise ValueError(f"frame glyph leaked into visible diagram text: {group_id}")
    if any(is_diagram(block["text"]) and block.get("kind") != "diagram" for section in sections for block in section["blocks"]):
        raise ValueError("a box-drawing source row was left as ordinary prose")
    box_drawing_rows = sum(BOX_DRAWING.search(block["text"]) is not None for section in sections for block in section["blocks"])
    if payload["counts"].get("box_drawing_rows") != box_drawing_rows:
        raise ValueError("box-drawing audit count does not match the source")


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
    snapshot = out_dir / "outline-source-v1.html"
    if source != snapshot.resolve():
        shutil.copyfile(source, snapshot)
    parser_impl = TreeParser()
    parser_impl.feed(source_bytes.decode("utf-8", errors="strict"))
    converter = OpenCC("t2s")
    sections, paragraph_count = section_blocks(parser_impl.root, converter)
    annotate_sections(sections)
    all_blocks = [block for section in sections for block in section["blocks"]]
    payload = {
        "format": "vism-outline/v1",
        "source": {"url": args.source_url, "sha256": source_sha, "snapshot": snapshot.name},
        "conversion": {"tool": "OpenCC", "config": "t2s", "display_language": "zh-Hans"},
        "counts": {
            "paragraphs": paragraph_count,
            "visible_paragraphs": sum(not block["empty"] for block in all_blocks),
            "source_sections": 21,
            "chapters": 23,
            "questions": sum(len(section["questions"]) for section in sections),
            "diagrams": sum(block["kind"] == "diagram" for block in all_blocks),
            "box_drawing_rows": sum(BOX_DRAWING.search(block["text"]) is not None for block in all_blocks),
            "diagram_groups": len({block["diagram_group"] for block in all_blocks if block.get("diagram_group")}),
        },
        "content_sha256": hashlib.sha256("\n".join(block["text"] for block in all_blocks).encode("utf-8")).hexdigest(),
        "sections": sections,
    }
    validate(payload)
    (out_dir / "outline-v1.json").write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"source_sha256": source_sha, **payload["counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
