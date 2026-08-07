#!/usr/bin/env python3
"""Integrity checks for the DN33/DN34 法数 static research data."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "docs/research/pali-source-texts/sutta/digha"
INDEX = BASE / "dhamma-numbers.json"
DETAILS = BASE / "dhamma-number-details"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main(require_ai: bool) -> None:
    index = load(INDEX)
    groups = index["groups"]
    entries = index["entries"]
    assert len(groups) == 326, f"原始法组数应为 326，实际为 {len(groups)}"
    assert len(entries) == 273, f"合并条目数应为 273，实际为 {len(entries)}"

    group_ids = {group["id"] for group in groups}
    assert len(group_ids) == len(groups), "法组 ID 有重复"
    status_counts = Counter()
    expanded_group_count = 0
    ai_count = 0
    shared_entries = 0
    labels = {"七识住", "七个无十之事", "八胜处", "八解脱"}
    checked_labels: set[str] = set()

    for entry in entries:
        detail = load(DETAILS / f"{entry['id']}.json")
        detail_groups = detail["groups"]
        assert {group["id"] for group in detail_groups} == set(entry["group_ids"]), f"{entry['id']} 详情组引用不一致"
        assert len(detail_groups) in (1, 2), f"{entry['id']} 经文数量异常"
        if len(detail_groups) == 2:
            shared_entries += 1
        for group in detail_groups:
            number = int(group["number"])
            points = group.get("expanded_points") or []
            assert group["id"] in group_ids, f"{entry['id']} 指向不存在的法组"
            assert group.get("source_paragraphs"), f"{group['id']} 缺少原文段落"
            if require_ai:
                assert len(points) == number, f"{group['id']} 要点数 {len(points)} ≠ 法数 {number}"
                assert all(point.strip() for point in points), f"{group['id']} 存在空要点"
                assert all("瞋" not in point for point in points), f"{group['id']} 要点未简体化"
                expanded_group_count += 1
            status_counts[group.get("dn34_status") or "dn33"] += 1
            if group["label"] in labels:
                checked_labels.add(group["label"])

        if require_ai:
            research = detail["entry"].get("research") or {}
            markdown = research.get("ai_full_markdown") or ""
            assert markdown.startswith(f"# AI 综合回答：{entry['label']}"), f"{entry['id']} 缺少完整 AI Markdown"
            assert "## 引用" in markdown and "http" in markdown, f"{entry['id']} 缺少可跳转引用"
            assert research.get("answer_markdown"), f"{entry['id']} 缺少原始回答"
            ai_count += 1

    assert checked_labels == labels, f"命名回归样例不全：{labels - checked_labels}"
    assert shared_entries == 53, f"共有条目应为 53，实际为 {shared_entries}"
    print(json.dumps({
        "groups": len(groups),
        "entries": len(entries),
        "shared_entries": shared_entries,
        "expanded_groups": expanded_group_count,
        "ai_entries": ai_count,
        "source_statuses": dict(status_counts),
        "named_regressions": sorted(checked_labels),
    }, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-ai", action="store_true", help="Require generated AI answers and exact-N points.")
    main(parser.parse_args().require_ai)
