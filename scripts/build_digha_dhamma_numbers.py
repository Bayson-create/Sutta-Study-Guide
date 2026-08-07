#!/usr/bin/env python3
"""Build the evidence-bound DN33/DN34 dharma-number research dataset.

The source snapshot is the public Early Buddhist export.  This builder keeps
the source paragraph verbatim, extracts only explicitly labelled numbered
groups, computes conservative same-number correspondences, and produces a
static evidence-only synthesis.  It intentionally does not call a model API.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import quote

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "docs/research/pali-source-texts/sutta/digha/data"
OUT = ROOT / "docs/research/pali-source-texts/sutta/digha/dhamma-numbers.json"
CHINESE = DATA_DIR / "dn33-dn34-chinese.json"

NUMS = "一二三四五六七八九十"
NUM_VALUE = {c: i + 1 for i, c in enumerate(NUMS)}
COLLECTION = "经藏/长部_dn"
EB_BASE = "https://bayson-create.github.io/Early-Buddhist/"
SITE_BASE = "https://bayson-create.github.io/Sutta-Study-Guide/"


def compact(text: str) -> str:
    return " ".join(text.split())


def section_paragraphs(soup: BeautifulSoup, heading: str) -> list[str]:
    node = next((h for h in soup.find_all("h2") if h.get_text(strip=True) == heading), None)
    if node is None:
        return []
    out: list[str] = []
    node = node.find_next_sibling()
    while node is not None and node.name != "h2":
        if node.name == "p":
            value = compact(node.get_text(" ", strip=True))
            if value:
                out.append(value)
        node = node.find_next_sibling()
    return out


def is_closure(text: str, numeral: str) -> bool:
    return f"這些是{numeral}法" in text or f"這些是{numeral}十法" in text


def parse_rows(text: dict) -> list[dict]:
    uid = text["uid"]
    soup = BeautifulSoup(text["zh_legacy"][0]["html"], "html.parser")
    rows: list[dict] = []
    for numeral in NUMS:
        heading = numeral if uid == "dn33" else f"{numeral}法"
        paragraphs = section_paragraphs(soup, heading)
        if not paragraphs:
            continue
        close_at = next((i for i, p in enumerate(paragraphs) if is_closure(p, numeral)), len(paragraphs))
        if uid == "dn34":
            candidates = [
                p for p in paragraphs[1:close_at]
                if re.match(r"^（[一二三四五六七八九十]）", p)
            ]
        elif numeral == "一":
            candidates = paragraphs[:1]
        elif numeral == "二":
            candidates = paragraphs[1:close_at]
        else:
            # Explicit group labels begin with the section numeral (possibly
            # preceded by 下一個/如來的). Explanatory paragraphs begin with
            # 學友們/再者 and are deliberately excluded.
            prefix = re.compile(rf"^(?:下一個)?(?:如來的)?{numeral}")
            candidates = [p for p in paragraphs[1:close_at] if prefix.match(p)]

        for order, source_text in enumerate(candidates, 1):
            if uid == "dn34":
                tail = source_text.split("呢？", 1)[1] if "呢？" in source_text else source_text
                label = tail.split("，這些是", 1)[0].strip(" ，")
                # A first colon inside the label marks the named sub-list.
                member_text = tail.split("，這些是", 1)[0].strip(" ，")
                if "：" in member_text:
                    explicit, remainder = member_text.split("：", 1)
                    if len(explicit) <= 32:
                        label, member_text = explicit.strip(), remainder.strip()
            elif numeral == "一":
                label = "一法"
                marker = "哪一法呢？"
                member_text = source_text.split(marker, 1)[1].split("，這是一法", 1)[0].strip(" ，") if marker in source_text else source_text
            elif numeral == "二":
                label = f"二法·{source_text.rstrip('。')}"
                member_text = source_text.rstrip("。")
            else:
                label = source_text.split("：", 1)[0].strip()
                member_text = source_text.split("：", 1)[1].split("。", 1)[0].strip() if "：" in source_text else source_text.rstrip("。")
            rows.append({
                "id": f"{uid}-n{NUM_VALUE[numeral]}-g{order}",
                "sutta": uid,
                "number": NUM_VALUE[numeral],
                "order": order,
                "label": label,
                "members": member_text,
                "member_items": member_items(member_text),
                "source_text": source_text,
                "source_paragraph": order,
            })
    return rows


def normalize(value: str) -> str:
    value = value.replace("下一個", "").replace("如來的", "")
    value = re.sub(r"[（(].*?[）)]", "", value)
    value = re.sub(r"[，、。；：！？\s\[\]【】]", "", value)
    return value


def member_items(value: str) -> list[str]:
    """Expose explicit ``、``-separated members without inventing a list."""
    value = value.strip(" ，。")
    if "、" not in value:
        return [value] if value else []
    return [part.strip(" ，。") for part in value.split("、") if part.strip(" ，。")]


def source_url(row: dict) -> str:
    query = row["label"] if row["label"] else row["members"][:24]
    params = {
        "view": row["sutta"],
        "lang": "zh",
        "q": query,
        "coll": COLLECTION,
        "mt": row["members"][:160],
    }
    return EB_BASE + "?" + "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params.items())


def site_search_hits(label: str, members: str) -> list[dict]:
    """Find stable, local-site evidence without calling the synthesis API."""
    terms = [label, members.split("、", 1)[0].strip()]
    terms = [t for t in terms if len(t) >= 2]
    hits: list[dict] = []
    seen: set[str] = set()
    paths = list((ROOT / "docs/research").rglob("*.md")) + [ROOT / "docs/suttas.json"]
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        term = next((t for t in terms if t in text), None)
        if not term:
            continue
        pos = text.find(term)
        start = max(0, pos - 180)
        end = min(len(text), pos + max(240, len(term) + 180))
        snippet = compact(text[start:end]).replace("\u0000", "")
        key = f"{path}:{pos}"
        if key in seen:
            continue
        seen.add(key)
        rel = path.relative_to(ROOT).as_posix()
        query = quote(label or term, safe="")
        hits.append({
            "source": rel,
            "heading": "站内搜索命中",
            "text": snippet,
            "href": f"{SITE_BASE}#/search?q={query}&scope=site",
        })
        if len(hits) >= 3:
            break
    return hits


def common_score(a: dict, b: dict) -> float:
    a_label, b_label = normalize(a["label"]), normalize(b["label"])
    a_mem, b_mem = normalize(a["members"]), normalize(b["members"])
    if a_label and (a_label == b_label or a_label in b_mem or b_label in a_mem):
        return 1.0
    # Character trigrams are robust to small translation differences while
    # still requiring several shared meaningful characters.
    def grams(s: str) -> set[str]:
        return {s[i : i + 3] for i in range(max(0, len(s) - 2))}
    ga, gb = grams(a_mem), grams(b_mem)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


def relation(score: float) -> str:
    if score >= 0.92:
        return "同一法组"
    if score >= 0.28:
        return "部分重叠或相关"
    return "同数但未确认同组"


def synthesize(row: dict, counterpart: dict | None, site_hits: list[dict]) -> dict:
    evidence = [{
        "id": "eb-self",
        "label": f"Early Buddhist · {row['sutta'].upper()} · {row['label']}",
        "text": row["source_text"],
        "href": row["source_url"],
        "kind": "early_buddhist",
    }]
    if counterpart:
        evidence.append({
            "id": "eb-counterpart",
            "label": f"Early Buddhist · {counterpart['sutta'].upper()} · {counterpart['label']}",
            "text": counterpart["source_text"],
            "href": counterpart["source_url"],
            "kind": "early_buddhist",
        })
    for i, hit in enumerate(site_hits, 1):
        evidence.append({**hit, "id": f"site-{i}", "kind": "site"})
    refs = " ".join(f"[{i}]" for i in range(1, len(evidence) + 1))
    counterpart_text = (
        f"DN{counterpart['sutta'][2:]} 也列出「{counterpart['label']}」，可作为对应法组；两处原文见 [1][2]。"
        if counterpart
        else "在另一部经的同一法数中没有达到可确认的同组对应；当前结论只覆盖本经原文 [1]。"
    )
    site_text = (
        f"站内检索找到 {len(site_hits)} 处相关资料，作为解释背景，不替代两部经的原文。"
        if site_hits
        else "站内检索暂未找到稳定的同名命中，不能据此补充经文之外的内容。"
    )
    answer = "\n".join([
        "## 直接回答",
        f"这是《{row['sutta'].upper()}》中的{row['number']}法法组「{row['label']}」，原文明确列出：{row['members']}。[1]",
        "",
        "## 对应关系",
        counterpart_text,
        "",
        "## 要点展开",
        f"- 经文功能：该法组被放在第 {row['number']} 法的分类中；成员以原文列举为准。[1]",
        f"- 站内资料：{site_text}",
        "",
        "## 证据覆盖情况",
        f"本条综合使用 {refs}；原文证据优先，站内资料只用于补充检索背景。",
    ])
    return {"answer_markdown": answer, "evidence": evidence, "generated_by": "Codex evidence-bound static synthesis"}


def build() -> dict:
    raw = json.loads(CHINESE.read_text(encoding="utf-8"))
    rows = [r for text in raw["texts"] for r in parse_rows(text)]
    for row in rows:
        row["source_url"] = source_url(row)
        row["site_query"] = row["label"] or row["members"][:40]
    by_num = {}
    for row in rows:
        by_num.setdefault((row["number"], row["sutta"]), []).append(row)
    for row in rows:
        other = by_num.get((row["number"], "dn34" if row["sutta"] == "dn33" else "dn33"), [])
        scored = sorted(((common_score(row, candidate), candidate) for candidate in other), key=lambda x: x[0], reverse=True)
        top_score, top = scored[0] if scored else (0.0, None)
        row["correspondence"] = [] if top is None else [{"id": top["id"], "score": round(top_score, 3), "relation": relation(top_score)}]
        hits = site_search_hits(row["label"], row["members"])
        row["site_hits"] = hits
        row["ai"] = synthesize(row, top if top_score >= 0.92 else None, hits)
    counts = {
        "dn33": sum(r["sutta"] == "dn33" for r in rows),
        "dn34": sum(r["sutta"] == "dn34" for r in rows),
        "total": len(rows),
    }
    return {
        "version": 1,
        "generated_at": raw["metadata"].get("generated_at"),
        "source": {
            "provider": "Early Buddhist",
            "collection": COLLECTION,
            "full_text_files": [
                "data/dn33-dn34-chinese.json",
                "data/dn33-dn34-english.json",
            ],
            "external_reader": EB_BASE,
        },
        "counts": counts,
        "groups": rows,
    }


if __name__ == "__main__":
    result = build()
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["counts"], ensure_ascii=False))
