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
from pathlib import Path
from typing import Any

from opencc import OpenCC  # type: ignore

from build_vism_lecture import Node, TreeParser, simplify


SOURCE_URL = "https://dhammarain.github.io/canon/Anna/read1/Vism_abst.html"
EXPECTED_SECTION_CHAPTERS = [[1], [2], [3], [4, 5], [6], [7], [8], [9], [10], [11], [12, 13], [14], [15], [16], [17], [18], [19], [20], [21], [22], [23]]
QUESTION = re.compile(r"^(\d{1,2})\.\s*(.+)$")
DIAGRAM = re.compile(r"[┌┐└┘├┤┬┴─│]")


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


def is_diagram(value: str) -> bool:
    return len(DIAGRAM.findall(value)) >= 8


def section_blocks(root: Node, converter: Any) -> tuple[list[dict[str, Any]], int]:
    nodes = [node for node in walk(body(root)) if node.tag in {"h3", "p"}]
    paragraphs = sum(node.tag == "p" for node in nodes)
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    preface: list[dict[str, Any]] = []
    for source_index, node in enumerate(nodes):
        text = visible_text(node, converter)
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
            "text": text,
            "empty": not bool(text),
            "kind": "diagram" if is_diagram(text) else "paragraph",
        }
        if current is None:
            preface.append(block)
        else:
            current["blocks"].append(block)
    return [{"id": "vism-outline-preface", "title": "前言与目录", "chapter_ids": [], "blocks": preface, "questions": []}, *sections], paragraphs


def annotate_sections(sections: list[dict[str, Any]]) -> None:
    for section in sections:
        phase = "overview"
        active_question: dict[str, Any] | None = None
        for block in section["blocks"]:
            text = block["text"]
            compact = re.sub(r"\s+", "", text)
            if "学习目标" in compact:
                phase = "learning_goals"
            elif "重要词汇" in compact:
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
