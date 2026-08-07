#!/usr/bin/env python3
"""Build the DN33/DN34 dhamma-number research dataset.

The browser already uses Early Buddhist's own public tokenizer/BM25 engine.
Its batch results are frozen in ``dhamma-early-buddhist-cache.json`` by the
companion browser collection pass, then joined here with source paragraphs and
the site's local research search.  No personal API key or model endpoint is
used: every pre-generated synthesis is constrained to the retained evidence.

Install build dependencies with ``python3 -m pip install -r
scripts/requirements-digha-dhamma-numbers.txt``.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

from bs4 import BeautifulSoup
from opencc import OpenCC


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "docs/research/pali-source-texts/sutta/digha"
DATA_DIR = BASE / "data"
OUT = BASE / "dhamma-numbers.json"
DETAIL_DIR = BASE / "dhamma-number-details"
PLAN = BASE / "dhamma-search-plan.json"
EB_CACHE = BASE / "dhamma-early-buddhist-cache.json"
CHINESE = DATA_DIR / "dn33-dn34-chinese.json"

NUMS = "一二三四五六七八九十"
NUM_VALUE = {c: i + 1 for i, c in enumerate(NUMS)}
COLLECTION = "经藏/长部_dn"
EB_BASE = "https://bayson-create.github.io/Early-Buddhist/"
SITE_BASE = "https://bayson-create.github.io/Sutta-Study-Guide/"

DN34_STATUS = {
    "多所助益": "多所助",
    "應該被修習": "应修习",
    "應該被遍知": "应遍知",
    "應該被捨斷": "应舍断",
    "退分": "退分法",
    "殊勝分": "胜分法",
    "難貫通": "难贯通",
    "應該使之生出": "应生出",
    "應該被證知": "应证知",
    "應該被作證": "应作证",
}
T2S = OpenCC("t2s")
# OpenCC retains some variant characters.  Align those with this site’s
# established mainland Buddhist terminology after its general conversion.
DISPLAY_REPLACEMENTS = str.maketrans({"瞋": "嗔"})
_SITE_DOCUMENTS: list[tuple[str, str]] | None = None


def compact(text: str) -> str:
    return " ".join(text.split())


def displayify(value):
    """Convert all reader-facing Chinese values at build time, not in CSS/JS."""
    if isinstance(value, str):
        return T2S.convert(value).translate(DISPLAY_REPLACEMENTS)
    if isinstance(value, list):
        return [displayify(item) for item in value]
    if isinstance(value, dict):
        # Stable identifiers and URLs must retain their original machine form.
        preserved = {"id", "group_ids", "suttas", "sutta", "href", "source_url", "collection", "uid"}
        return {key: (item if key in preserved else displayify(item)) for key, item in value.items()}
    return value


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


def provisional_member_items(number: int, first_content: str, paragraphs: list[str]) -> list[str]:
    """Extract only unambiguous member names for retrieval.

    The display list is deliberately *not* derived here: long formulae such
    as the seven stations of consciousness and the eight liberations need a
    semantic summary, generated later from the complete source paragraphs.
    This helper only provides safe search terms; it never silently pretends a
    partial first sentence is the whole dhamma-number set.
    """
    if number == 1:
        return [first_content.strip(" ，。")] if first_content.strip(" ，。") else []
    first_content = first_content.split("，這些是", 1)[0].strip(" ，。")
    simple = [part.strip(" ，。") for part in re.split(r"[、與]", first_content) if part.strip(" ，。")]
    if len(simple) == number:
        return simple
    direct = [part.strip(" ，。") for part in paragraphs if part.strip(" ，。")]
    if len(direct) == number:
        return direct
    sentences = [part.strip(" ，。") for part in re.split(r"。", "。".join(paragraphs)) if part.strip(" ，。")]
    if len(sentences) == number:
        return sentences
    return []


def clean_label(value: str) -> str:
    value = re.sub(r"^[一二三四五六七八九十]法·", "", value)
    return value.replace("下一個", "").replace("如來的", "").strip(" ，。")


def dn34_status(source_text: str) -> str | None:
    for raw, display in DN34_STATUS.items():
        if f"{raw}的" in source_text or f"{raw}之" in source_text:
            return display
    return None


def _segments(paragraphs: list[str], starts: list[int], close_at: int) -> list[list[str]]:
    """Group a title paragraph with every following paragraph up to the next title."""
    out: list[list[str]] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else close_at
        if start < end:
            out.append(paragraphs[start:end])
    return out


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
            starts = [i for i, p in enumerate(paragraphs[:close_at]) if re.match(r"^（[一二三四五六七八九十]）", p)]
        elif numeral == "一":
            starts = [0] if close_at else []
        elif numeral == "二":
            starts = list(range(1, close_at))
        else:
            prefix = re.compile(rf"^(?:下一個)?(?:如來的)?{numeral}")
            starts = [i for i, p in enumerate(paragraphs[:close_at]) if i > 0 and prefix.match(p)]

        for order, source_paragraphs in enumerate(_segments(paragraphs, starts, close_at), 1):
            source_text = "\n\n".join(source_paragraphs)
            first = source_paragraphs[0]
            status = None
            if uid == "dn34":
                status = dn34_status(first)
                tail = first.split("呢？", 1)[1] if "呢？" in first else first
                member_text = tail.split("，這些是", 1)[0].strip(" ，")
                label = member_text
                if "：" in member_text:
                    explicit, remainder = member_text.split("：", 1)
                    if len(explicit) <= 48:
                        label, member_text = explicit.strip(), remainder.strip()
            elif numeral == "一":
                label = "一法"
                marker = "哪一法呢？"
                member_text = first.split(marker, 1)[1].split("，這是一法", 1)[0].strip(" ，") if marker in first else first
            elif numeral == "二":
                label = first.rstrip("。")
                member_text = label
            else:
                label = first.split("：", 1)[0].strip()
                member_text = first.split("：", 1)[1].strip() if "：" in first else first.rstrip("。")
            display_paragraphs = [member_text, *source_paragraphs[1:]]
            rows.append({
                "id": f"{uid}-n{NUM_VALUE[numeral]}-g{order}",
                "sutta": uid,
                "number": NUM_VALUE[numeral],
                "order": order,
                "label": clean_label(label),
                "members": "\n\n".join(display_paragraphs),
                "match_members": member_text.split("。", 1)[0].strip(" ，。"),
                "member_items": provisional_member_items(NUM_VALUE[numeral], member_text, display_paragraphs),
                "dn34_status": status,
                "source_paragraphs": source_paragraphs,
                "source_text": source_text,
            })
    return rows


def normalize(value: str) -> str:
    value = clean_label(value)
    value = re.sub(r"[（(].*?[）)]", "", value)
    return re.sub(r"[，、。；：！？\s\[\]【】'‘’“”\"-]", "", value)


def source_url(row: dict) -> str:
    query = row["label"] or row["members"][:24]
    params = {"view": row["sutta"], "lang": "zh", "q": query, "coll": COLLECTION, "mt": row["members"][:160]}
    return EB_BASE + "?" + "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params.items())


def stable_id(number: int, values: list[str]) -> str:
    digest = hashlib.sha1("|".join(values).encode("utf-8")).hexdigest()[:12]
    return f"dhamma-n{number}-{digest}"


def score_match(a: dict, b: dict) -> float:
    al, bl = normalize(a["label"]), normalize(b["label"])
    am, bm = normalize(a["members"]), normalize(b["members"])
    if al and al == bl and am == bm:
        return 1.0
    # Long numbered formulae are now preserved in full paragraphs.  Their
    # DN33/DN34 prose can legitimately differ while the named dhamma group is
    # still the same; use the explicitly extracted members before comparing
    # the full prose body.
    if al and al == bl and a["member_items"] and a["member_items"] == b["member_items"]:
        return 0.98
    if al and al == bl and normalize(a.get("match_members", "")) == normalize(b.get("match_members", "")):
        return 0.97
    if al and al == bl and (am in bm or bm in am):
        return 0.96
    if am and am == bm:
        return 0.94
    return 0.0


def build_entries(rows: list[dict]) -> list[dict]:
    by_number: dict[int, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        by_number[row["number"]][row["sutta"]].append(row)
    entries: list[dict] = []
    for number, sides in sorted(by_number.items()):
        left, right = sides["dn33"], sides["dn34"]
        used: set[str] = set()
        for a in left:
            candidates = sorted(((score_match(a, b), b) for b in right if b["id"] not in used), key=lambda pair: pair[0], reverse=True)
            score, b = candidates[0] if candidates else (0.0, None)
            group_ids = [a["id"]]
            if b is not None and score >= 0.92:
                used.add(b["id"])
                group_ids.append(b["id"])
            entries.append(make_entry(number, group_ids, rows))
        for b in right:
            if b["id"] not in used:
                entries.append(make_entry(number, [b["id"]], rows))
    return entries


def make_entry(number: int, group_ids: list[str], rows: list[dict]) -> dict:
    by_id = {row["id"]: row for row in rows}
    sources = [by_id[group_id] for group_id in group_ids]
    preferred = next((row for row in sources if row["sutta"] == "dn33"), sources[0])
    terms = search_terms(sources)
    return {
        "id": stable_id(number, [normalize(preferred["label"]), normalize(preferred["members"]), *sorted(group_ids)]),
        "number": number,
        "label": preferred["label"],
        "member_items": preferred["member_items"],
        "group_ids": group_ids,
        "suttas": [row["sutta"] for row in sources],
        "search_terms": terms,
    }


def search_terms(sources: list[dict]) -> list[str]:
    values: list[str] = []
    for row in sources:
        values.append(row["label"])
        candidates = row["member_items"]
        if len(candidates) <= 12:
            values.extend(candidates)
        for item in candidates:
            # The short forms are the concept queries requested for the
            # three unwholesome roots and work for analogous compounds too.
            values.append(item.replace("貪欲", "貪").replace("瞋恚", "瞋").replace("愚癡", "癡"))
    out: list[str] = []
    for value in values:
        value = compact(value).strip(" ，。")
        if not (2 <= len(value) <= 96) or value in out:
            continue
        out.append(value)
    return out[:14]


def site_documents() -> list[tuple[str, str]]:
    """Load and simplify the static search corpus once for the whole batch."""
    global _SITE_DOCUMENTS
    if _SITE_DOCUMENTS is not None:
        return _SITE_DOCUMENTS
    research = ROOT / "docs/research"
    paths = list(research.rglob("*.md"))
    paths += list((research / "vism-data").glob("zh_*.json"))
    paths += list((research / "pali-source-texts/sutta/majjhima/papancasudani").rglob("bilingual.json"))
    paths += [ROOT / "docs/suttas.json"]
    documents: list[tuple[str, str]] = []
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        documents.append((path.relative_to(ROOT).as_posix(), T2S.convert(text).translate(DISPLAY_REPLACEMENTS)))
    _SITE_DOCUMENTS = documents
    return documents


def site_search_hits(terms: list[str]) -> list[dict]:
    """Freeze the same Markdown and JSON readers exposed by site-wide search."""
    hits: list[dict] = []
    seen: set[str] = set()
    simplified_terms = [(term, T2S.convert(term).translate(DISPLAY_REPLACEMENTS)) for term in terms]
    for rel, simplified_text in site_documents():
        term, needle = next(((term, needle) for term, needle in simplified_terms if needle in simplified_text), (None, None))
        if not term:
            continue
        pos = simplified_text.find(needle)
        key = f"{rel}:{pos}"
        if key in seen:
            continue
        seen.add(key)
        snippet = compact(simplified_text[max(0, pos - 220):min(len(simplified_text), pos + max(340, len(term) + 220))]).replace("\u0000", "")
        hits.append({
            "source": rel,
            "heading": "站内搜索命中",
            "text": snippet,
            "href": f"{SITE_BASE}#/search?q={quote(term, safe='')}&scope=site",
            "query": term,
        })
        if len(hits) >= 6:
            break
    return hits


def load_eb_cache() -> dict[str, list[dict]]:
    if not EB_CACHE.exists():
        return {}
    try:
        raw = json.loads(EB_CACHE.read_text(encoding="utf-8"))
        return raw.get("queries", raw) if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def collect_eb(terms: list[str], cache: dict[str, list[dict]]) -> tuple[list[dict], list[dict]]:
    batches = [{"query": term, "hits": cache.get(term, [])} for term in terms]
    all_hits: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for batch in batches:
        for hit in batch["hits"]:
            key = (str(hit.get("uid", "")), str(hit.get("text", "")))
            if not key[0] or key in seen:
                continue
            seen.add(key)
            all_hits.append(hit)
    return batches, all_hits


def evidence_for(entry: dict, row_map: dict[str, dict], site_hits: list[dict], eb_batches: list[dict]) -> list[dict]:
    evidence: list[dict] = []
    for group_id in entry["group_ids"]:
        row = row_map[group_id]
        evidence.append({
            "kind": "source", "label": f"Early Buddhist · {row['sutta'].upper()} · {row['label']}",
            "text": row["source_text"], "href": source_url(row),
        })
    # First pass gives every queried concept one voice; only then add more
    # high-ranked passages.  This is crucial for multi-member groups: a
    # broad group-name query must not consume the whole citation budget.
    eb_hits: list[dict] = []
    for batch in eb_batches:
        if batch["hits"]:
            eb_hits.append(batch["hits"][0])
    for batch in eb_batches:
        eb_hits.extend(batch["hits"][1:])
    seen: set[tuple[str, str]] = set()
    for hit in eb_hits:
        key = (str(hit.get("uid", "")), str(hit.get("text", "")))
        if key in seen:
            continue
        seen.add(key)
        evidence.append({
            "kind": "early_buddhist", "label": f"Early Buddhist · {hit.get('collection', '')} · {hit.get('uid', '')}",
            "text": hit.get("text", ""), "href": hit.get("href", ""),
        })
        if len(evidence) >= 13:
            break
    for hit in site_hits[:5]:
        evidence.append({"kind": "site", "label": hit["source"], "text": hit["text"], "href": hit["href"]})
    return evidence[:18]


def synthesize(entry: dict, row_map: dict[str, dict], site_hits: list[dict], eb_batches: list[dict], eb_hits: list[dict]) -> dict:
    evidence = evidence_for(entry, row_map, site_hits, eb_batches)
    by_group = {group_id: index + 1 for index, group_id in enumerate(entry["group_ids"])}
    sources = [row_map[group_id] for group_id in entry["group_ids"]]
    primary = sources[0]
    members = primary["member_items"] or [primary["members"]]
    same_text = "DN33 与 DN34 都列出这一法组，原文可对照阅读。" if len(sources) == 2 else f"当前只在 {primary['sutta'].upper()} 的这一处明确列出。"
    lines = [
        "## 直接回答",
        f"「{entry['label']}」属于 {entry['number']} 法。{same_text} 成员以经文逐项列举为准。[1]",
        "",
        "## 法组构成",
    ]
    for row in sources:
        lines.append(f"- {row['sutta'].upper()}：{row['members']}。[{by_group[row['id']]}]")
    lines.extend(["", "## 所含各法"])
    for item in members:
        relevant_queries = [item, item.replace("貪欲", "貪").replace("瞋恚", "瞋").replace("愚癡", "癡")]
        hit = next((candidate for batch in eb_batches if batch["query"] in relevant_queries for candidate in batch["hits"]), None)
        matching = next((index + 1 for index, evidence_item in enumerate(evidence) if hit and hit.get("text") == evidence_item["text"]), 1)
        lines.append(f"### {item}")
        if hit:
            title = hit.get("title") or hit.get("uid") or "Early Buddhist"
            excerpt = compact(hit.get("text", ""))[:220]
            lines.append(f"经文将「{item}」列为「{entry['label']}」的一个成员。Early Buddhist 用该名词检索时，在《{title}》命中：{excerpt}。[{matching}]")
        else:
            lines.append(f"经文将「{item}」列为「{entry['label']}」的一个成员；当前 Early Buddhist 检索没有返回可引用的命中，以下仍以两经原文为准。[{matching}]")
    eb_count = sum(len(batch["hits"]) for batch in eb_batches)
    lines.extend([
        "",
        "## 检索综合",
        f"Early Buddhist 已按法组名及成员分别检索 {len(entry['search_terms'])} 个关键词，冻结 {eb_count} 条命中；详情页保留每个关键词的返回结果，综合时优先使用与该法组直接相关的前 10 条。",
        f"站内资料库命中 {len(site_hits)} 条，作为解释背景；经文原文仍为本条的首要依据。",
        "",
        "## 证据覆盖情况",
        "本条覆盖两部经的明确列举、Early Buddhist 全库关键词命中与站内资料命中。检索证据没有提供的推论不在这里补写。",
    ])
    return {
        "answer_markdown": "\n".join(lines),
        "evidence": evidence,
        "generated_by": "Codex evidence-bound static synthesis",
        "early_buddhist_queries": eb_batches,
        "site_hits": site_hits,
    }


def summary_group(row: dict) -> dict:
    """Keep the first-screen index small; full source text lives per detail."""
    return {key: row.get(key) for key in (
        "id", "sutta", "number", "label", "members", "member_items", "expanded_points", "dn34_status"
    )}


def summary_entry(entry: dict) -> dict:
    return {key: entry.get(key) for key in (
        "id", "number", "label", "group_ids", "suttas", "search_terms"
    )}


def build() -> tuple[dict, dict[str, dict]]:
    raw = json.loads(CHINESE.read_text(encoding="utf-8"))
    rows = [row for text in raw["texts"] for row in parse_rows(text)]
    for row in rows:
        row["source_url"] = source_url(row)
    row_map = {row["id"]: row for row in rows}
    entries = build_entries(rows)
    cache = load_eb_cache()
    for entry in entries:
        site_hits = site_search_hits(entry["search_terms"])
        eb_batches, eb_hits = collect_eb(entry["search_terms"], cache)
        entry["research"] = synthesize(entry, row_map, site_hits, eb_batches, eb_hits)
    result = {
        "version": 3,
        "generated_at": raw["metadata"].get("generated_at"),
        "source": {"provider": "Early Buddhist", "collection": COLLECTION, "external_reader": EB_BASE,
                   "full_text_files": ["data/dn33-dn34-chinese.json", "data/dn33-dn34-english.json"]},
        "counts": {"dn33": sum(row["sutta"] == "dn33" for row in rows), "dn34": sum(row["sutta"] == "dn34" for row in rows), "entries": len(entries)},
        "groups": [summary_group(row) for row in rows],
        "entries": [summary_entry(entry) for entry in entries],
    }
    details = {
        entry["id"]: {
            "version": 1,
            "entry": entry,
            "groups": [row_map[group_id] for group_id in entry["group_ids"]],
        }
        for entry in entries
    }
    PLAN.write_text(json.dumps({"version": 1, "queries": sorted({term for entry in entries for term in entry["search_terms"]})}, ensure_ascii=False, indent=2), encoding="utf-8")
    return displayify(result), {key: displayify(detail) for key, detail in details.items()}


if __name__ == "__main__":
    result, details = build()
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    DETAIL_DIR.mkdir(parents=True, exist_ok=True)
    # Detail files are generated artifacts with stable entry IDs.  Remove only
    # obsolete files in this dedicated generated directory so a changed match
    # never leaves an old route readable beside the new dataset.
    for old_detail in DETAIL_DIR.glob("dhamma-n*.json"):
        if old_detail.stem not in details:
            old_detail.unlink()
    for entry_id, detail in details.items():
        (DETAIL_DIR / f"{entry_id}.json").write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**result["counts"], "details": len(details), "planned_queries": len(json.loads(PLAN.read_text(encoding="utf-8"))["queries"])}, ensure_ascii=False))
