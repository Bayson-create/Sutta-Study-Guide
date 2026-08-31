#!/usr/bin/env python3
"""Build the immutable multilingual V4 concept graph v2.

The builder consumes the already published concept-tfidf-v1 audit layer and
the local V4 web dataset.  GPT is used only through a complete, two-pass
build-time cache supplied with --ai-cache; it never supplies quotations or
changes the V4 corpus.  Every evidence item is re-read from the V4 corpus and
hashed before release.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import gzip
import hashlib
import html
import json
import math
import pathlib
import re
import unicodedata
from typing import Any

TOKEN_RE = re.compile(r"[A-Za-zĀĪŪṄÑṬḌṆḶṂṁāīūṅñṭḍṇḷṃ]+", re.UNICODE)
ZH_RE = re.compile(r"[\u3400-\u9fff]+")
EN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
ALLOWED_TYPES = {
    "concept": "法义", "person": "人物", "text": "文本", "school": "修习体系",
    "place": "地点", "event": "事件", "term": "术语", "other": "其他",
}
TYPE_ALIASES = {
    "ethical_practice": "term", "practice": "school", "doctrine": "concept",
    "philosophical_concept": "concept", "entity": "other", "thing": "other",
    "organization": "school", "location": "place", "work": "text",
}
FORMAL_RELATIONS = [
    ("definition_alias", "定义/异名"), ("classification_contains", "分类/包含"),
    ("condition", "条件"), ("arising", "引生"), ("cessation", "止息"),
    ("supports", "支持"), ("obstacle", "障碍"), ("dependence", "依止"),
    ("object", "所缘"), ("co_arising", "共起"), ("correspondence", "相应"),
    ("contrast", "对举"), ("practice_direction", "修习导向"), ("attainment", "证得"),
    ("exclusion", "排除"),
]
STAT_RELATIONS = [("cross_document_salience", "跨文档显著"), ("local_context_cooccurrence", "局部语境共现")]
RELATION_TYPES = FORMAL_RELATIONS + STAT_RELATIONS
CORE = {
    "buddha", "dhamma", "saṅgha", "sīla", "samādhi", "paññā", "sati", "jhāna",
    "nibbāna", "dukkha", "anicca", "anattā", "kamma", "mettā", "karuṇā",
    "vipassanā", "samatha", "magga", "phala", "citta", "rūpa", "vedanā",
    "saññā", "saṅkhāra", "viññāṇa",
}
SUFFIXES = ("assa", "issa", "ussa", "āya", "ena", "ehi", "ebhi", "esu", "ānaṃ", "āyaṃ", "ssa", "to", "aṃ", "ṃ", "o", "ā", "e")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable(obj: Any) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def write_json(path: pathlib.Path, obj: Any, compress: bool = False) -> dict[str, Any]:
    data = stable(obj)
    if compress:
        data = gzip.compress(data, compresslevel=9, mtime=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"path": path.as_posix(), "bytes": len(data), "sha256": sha(data)}


def norm_pali(value: Any) -> str:
    value = unicodedata.normalize("NFC", str(value or "")).lower().replace("ṁ", "ṃ")
    return value.strip("-'’.,;:()[]{}")


def fold_pali(value: Any) -> str:
    value = norm_pali(value)
    return value.translate(str.maketrans({"ā": "a", "ī": "i", "ū": "u", "ṅ": "n", "ñ": "n", "ṭ": "t", "ḍ": "d", "ṇ": "n", "ḷ": "l", "ṃ": "m"}))


def plain(value: Any) -> str:
    return html.unescape(re.sub(r"<[^>]*>", " ", str(value or ""))).strip()


def useful_label(value: Any) -> str:
    value = plain(value)
    return "" if value.lower() in {"unresolved", "unknown", "candidate", "n/a", "none", "null"} else value


def site_simplifier(frontend_index: pathlib.Path | None):
    if not frontend_index or not frontend_index.exists():
        return lambda value: plain(value)
    source = frontend_index.read_text(encoding="utf-8")
    simple = re.search(r'const S2T_S="([^"]*)";', source)
    traditional = re.search(r'const S2T_T="([^"]*)";', source)
    if not simple or not traditional or len(simple.group(1)) != len(traditional.group(1)):
        return lambda value: plain(value)
    mapping = dict(zip(traditional.group(1), simple.group(1)))
    return lambda value: "".join(mapping.get(ch, ch) for ch in plain(value))


def read_json(path: pathlib.Path) -> Any:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def source_hash(archive: pathlib.Path) -> str:
    meta = archive / "source" / "source.json"
    if meta.exists():
        return json.loads(meta.read_text(encoding="utf-8")).get("sha256", "")
    return sha((archive / "web-dataset" / "v1" / "manifest.json").read_bytes())


def load_v1(v1_dir: pathlib.Path):
    manifest = read_json(v1_dir / "manifest.json")
    concepts = read_json(v1_dir / "concepts.json.gz")
    documents = read_json(v1_dir / "documents.json.gz")
    raw_relations: list[dict[str, Any]] = []
    by_relation: dict[str, dict[str, Any]] = {}
    for entry in manifest.get("relation_shards", []):
        path = v1_dir / entry["path"]
        for row in read_json(path):
            rid = row.get("relation_id")
            if rid is not None and rid not in by_relation:
                by_relation[rid] = row
    raw_relations = list(by_relation.values())
    raw_relations.sort(key=lambda x: str(x.get("relation_id", "")))
    return manifest, concepts, documents, raw_relations


def load_dictionary_hints(archive: pathlib.Path) -> dict[str, list[dict[str, str]]]:
    root = archive / "web-dataset" / "v1" / "dictionaries"
    hints: dict[str, list[dict[str, str]]] = collections.defaultdict(list)
    for path in sorted(root.rglob("*.json.gz")):
        payload = read_json(path)
        rows = payload.get("rows", []) if isinstance(payload, dict) else []
        for row in rows:
            key = str(row.get("dict_key") or "")
            content = plain(row.get("dict_content"))
            for form in key.split(","):
                k = norm_pali(form)
                if not k or " " in k or not content:
                    continue
                if len(hints[k]) < 4:
                    hints[k].append({"dictionary": path.parent.name, "key": key, "content": content[:420]})
    return hints


def load_proper_and_user(archive: pathlib.Path) -> tuple[dict[str, list[str]], int, int]:
    root = archive / "web-dataset" / "v1" / "terminology"
    values: dict[str, list[str]] = collections.defaultdict(list)
    proper = read_json(root / "proper-nouns.json")
    user = read_json(root / "user-dictionary.json")
    for row in proper:
        k = norm_pali(row.get("pali_key") or row.get("pali"))
        if k:
            values[k].append(plain(row.get("preferred_chinese") or row.get("english") or ""))
    for row in user:
        k = norm_pali(row.get("dict_key"))
        if k:
            values[k].append(plain(row.get("dict_content") or ""))
    return values, len(proper), len(user)


def normalize_type(value: Any) -> str:
    value = str(value or "").strip().lower().replace("-", "_")
    value = TYPE_ALIASES.get(value, value)
    return value if value in ALLOWED_TYPES else "term"


def safe_canonical(value: Any, surface: str, surface_set: set[str], dictionary_keys: set[str]) -> str:
    candidate = norm_pali(value)
    if not candidate or not TOKEN_RE.fullmatch(candidate):
        return surface
    if candidate == surface or candidate in surface_set or candidate in dictionary_keys or candidate in CORE:
        return candidate
    return surface


def deterministic_base(surface: str, known: set[str], hints: dict[str, list[dict[str, str]]]) -> str:
    """Conservative inflection reduction used only if the base is dictionary-backed."""
    if surface in CORE:
        return surface
    for suffix in sorted(SUFFIXES, key=len, reverse=True):
        if not surface.endswith(suffix) or len(surface) - len(suffix) < 4:
            continue
        base = surface[:-len(suffix)]
        if base in known and (base in CORE or hints.get(base)):
            return base
    if hints.get(surface):
        return surface
    return surface


def cache_by_id(cache: dict[str, Any], field: str) -> dict[str, dict[str, Any]]:
    result = {}
    for item in cache.get(field, []) or []:
        if item.get("surface_id"):
            result[str(item["surface_id"])] = item
    return result


def make_aliases(concepts, cache: dict[str, Any], hints: dict[str, list[dict[str, str]]]):
    surface_set = {norm_pali(x.get("pali") or x.get("concept_id")) for x in concepts}
    dictionary_keys = set(hints)
    proposals = cache_by_id(cache, "proposals")
    reviews = cache_by_id(cache, "reviews")
    alias: dict[str, str] = {}
    audit: dict[str, dict[str, Any]] = {}
    for item in concepts:
        sid = str(item.get("concept_id") or item.get("pali"))
        surface = norm_pali(item.get("pali") or sid)
        review = reviews.get(sid, {})
        proposal = proposals.get(sid, {})
        reviewed = str(review.get("verdict") or "").lower() == "verified"
        candidate = review.get("canonical_pali") if reviewed else None
        candidate = safe_canonical(candidate, surface, surface_set, dictionary_keys)
        if candidate == surface:
            proposal_candidate = safe_canonical(proposal.get("canonical_pali"), surface, surface_set, dictionary_keys)
            if str(proposal.get("merge_status") or "").lower() == "merge" and proposal_candidate != surface:
                candidate = deterministic_base(proposal_candidate, surface_set, hints)
        if candidate == surface:
            candidate = deterministic_base(surface, surface_set, hints)
        alias[sid] = candidate
        audit[sid] = {"proposal": proposal, "review": review, "reviewed": reviewed, "canonical_pali": candidate}
    return alias, audit


def evidence_record(work: dict[str, Any], row: dict[str, Any], matched_term: str, reason: str) -> dict[str, Any]:
    pali = plain(row.get("pali_text"))
    english = plain(row.get("english_translation"))
    chinese = plain(row.get("chinese_simplified") or row.get("chinese_raw"))
    rid = int(row.get("id", 0))
    wid = str(work["id"])
    params = f"row={rid}&hl={matched_term}&hl_lang=pali&hl_anchor={matched_term}"
    return {
        "version": "v4-evidence/v2", "work_id": wid, "row_id": rid,
        "paranum": row.get("paranum"), "layer": work.get("level") or "other",
        "title": work.get("title"), "path": work.get("path") or [],
        "pali": pali, "chinese": chinese, "english": english,
        "pali_sha256": sha(pali.encode("utf-8")), "english_sha256": sha(english.encode("utf-8")),
        "anchor": matched_term, "matched_term": matched_term, "reason": reason,
        "deep_link": f"#/tipitaka/read/{wid}?{params}", "verified": bool(pali or english or chinese),
    }


def load_corpus_evidence(archive: pathlib.Path, terms: set[str]) -> dict[str, dict[str, Any]]:
    catalog = read_json(archive / "web-dataset" / "v1" / "catalog" / "works.json")
    result: dict[str, dict[str, Any]] = {}
    remaining = set(terms)
    for index, work in enumerate(catalog, 1):
        path = archive / "web-dataset" / "v1" / work["data_file"]
        payload = read_json(path)
        for row in payload.get("rows", []):
            text = plain(row.get("pali_text"))
            if not text:
                continue
            row_terms = {norm_pali(t) for t in TOKEN_RE.findall(text)}
            for term in sorted(row_terms & remaining):
                result[term] = evidence_record(work, row, term, "surface_form_attested_in_v4")
                remaining.discard(term)
            if not remaining:
                break
        if not remaining:
            break
        if index % 25 == 0:
            print(f"evidence works {index}/{len(catalog)}; remaining={len(remaining)}")
    return result


def dictionary_labels(forms, hints, dictionary_values, to_simplified):
    zh = ""
    en = ""
    def useful_zh(value):
        value = re.sub(r"\s+", " ", value).strip(" ;,.")
        chars = re.findall(r"[\u3400-\u9fff]", value)
        return value if len(chars) >= 2 and value not in {"的", "者", "之", "其", "阳", "阴"} else ""
    for form in forms:
        values = dictionary_values.get(norm_pali(form), [])
        for value in values:
            value = to_simplified(value)
            if not zh:
                zh = useful_zh(value)[:220]
        hint_rows = sorted(hints.get(norm_pali(form), []), key=lambda row: (0 if str(row.get("dictionary", "")).startswith("pe") else 1, str(row.get("dictionary", ""))))
        for hint in hint_rows:
            content = to_simplified(hint.get("content"))
            if not zh:
                content_without_labels = re.sub(r"【[^】]*】", " ", content)
                match = re.search(r"([\u3400-\u9fff][\u3400-\u9fff，、；：。！？（）\s]*)", content_without_labels)
                if match:
                    zh = useful_zh(match.group(1))[:220]
            if not en and not re.search(r"[\u3400-\u9fff\u1000-\u109f]", content):
                english = re.sub(r"\\[\\'\\\"]", "'", content)
                english = re.sub(r"\s+", " ", english).strip(" ;,.")
                if re.search(r"[A-Za-z]{3,}", english) and not re.fullmatch(r"(?:[a-z]\\.)+", english):
                    en = english[:220]
        if zh and en:
            break
    return zh, en


def build_concepts(v1_concepts, alias, alias_audit, hints, dictionary_values, evidence, to_simplified):
    groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for item in v1_concepts:
        sid = str(item.get("concept_id") or item.get("pali"))
        groups[alias[sid]].append(item)
    output = []
    concept_evidence = {}
    for canonical, members in groups.items():
        members.sort(key=lambda x: str(x.get("concept_id")))
        first = members[0]
        review = alias_audit[str(first.get("concept_id") or first.get("pali"))].get("review") or {}
        proposal = alias_audit[str(first.get("concept_id") or first.get("pali"))].get("proposal") or {}
        zh = useful_label(review.get("chinese") or proposal.get("chinese") or "")
        en = useful_label(review.get("english") or proposal.get("english") or "")
        hint_zh, hint_en = dictionary_labels([canonical, *(x.get("pali") or x.get("concept_id") for x in members)], hints, dictionary_values, to_simplified)
        if not zh:
            zh = hint_zh or to_simplified(dictionary_values.get(canonical, [""])[0] if dictionary_values.get(canonical) else "") or canonical
        if not en:
            en = hint_en or canonical
        if review or proposal:
            status = "ai_verified" if str(review.get("verdict") or "").lower() == "verified" else "ai_candidate"
            source = "gpt_high_two_pass"
        else:
            status = "rule_only"
            source = "dictionary_and_rule_normalization"
        ev = next((evidence.get(norm_pali(x.get("pali") or x.get("concept_id"))) for x in members if evidence.get(norm_pali(x.get("pali") or x.get("concept_id")))), None)
        doc_freq = sum(int(x.get("document_frequency") or 0) for x in members)
        work_count = max(int(x.get("parent_work_count") or 0) for x in members)
        output.append({
            "concept_id": canonical, "pali": canonical, "surface_forms": [x.get("pali") or x.get("concept_id") for x in members],
            "aliases": [x.get("pali") or x.get("concept_id") for x in members if (x.get("pali") or x.get("concept_id")) != canonical],
            "label_zh": zh, "label_en": en, "translation_source": source, "translation_status": status,
            "concept_type": normalize_type(review.get("concept_type") or proposal.get("concept_type")),
            "concept_type_label": ALLOWED_TYPES[normalize_type(review.get("concept_type") or proposal.get("concept_type"))],
            "document_frequency": doc_freq, "parent_work_count": work_count,
            "max_tfidf": max(float(x.get("max_tfidf") or 0) for x in members),
            "degree": 0, "relation_count": 0, "evidence": ev,
            "merge_status": "canonical" if len(members) == 1 else "merged_verified_or_dictionary_backed",
            "surface_count": len(members),
        })
        concept_evidence[canonical] = ev
    output.sort(key=lambda x: (-x["parent_work_count"], -x["document_frequency"], x["concept_id"]))
    return output, concept_evidence


def raw_relation_projection(raw):
    row = dict(raw)
    row["surface_layer"] = True
    row["v2_audit_status"] = "not_ai_audited"
    row["semantic_claim"] = "statistical_association_only"
    return row


def build_relations(raw_relations, alias, evidence):
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for raw in raw_relations:
        source = str(raw.get("source") or "")
        target = str(raw.get("target") or "")
        if source not in alias or target not in alias:
            continue
        a, b = alias[source], alias[target]
        if a == b:
            continue
        typ = str(raw.get("relation_type") or "cross_document_salience")
        key = (typ, a, b)
        item = groups.get(key)
        if item is None:
            item = {
                "relation_id": f"{typ}:{a}:{b}", "source": a, "target": b, "relation_type": typ,
                "direction": "undirected", "document_count": 0, "parent_work_count": 0,
                "layer_document_counts": collections.Counter(), "local_context_window_count": 0,
                "cosine": 0.0, "npmi": 0.0, "raw_relation_count": 0,
                "raw_relation_sample": [], "semantic_claim": "statistical_association_only",
            }
            groups[key] = item
        item["raw_relation_count"] += 1
        item["document_count"] = max(item["document_count"], int(raw.get("document_count") or 0))
        item["parent_work_count"] = max(item["parent_work_count"], int(raw.get("parent_work_count") or 0))
        for layer, count in (raw.get("layer_document_counts") or {}).items():
            item["layer_document_counts"][layer] += int(count or 0)
        item["local_context_window_count"] = max(item["local_context_window_count"], int(raw.get("local_context_window_count") or 0))
        item["cosine"] = max(item["cosine"], float(raw.get("cosine") or 0))
        item["npmi"] = max(item["npmi"], float(raw.get("npmi") or 0))
        if len(item["raw_relation_sample"]) < 4:
            item["raw_relation_sample"].append(raw.get("relation_id"))
    relations = list(groups.values())
    for item in relations:
        item["layer_document_counts"] = dict(item["layer_document_counts"])
        ev = evidence.get(item["source"])
        item["evidence_status"] = "verified" if ev else "unresolved"
        item["evidence"] = ev
    # Percentile ranks are deterministic and make the visual weight explainable.
    def percentile(ordered, value):
        if not ordered:
            return 0.0
        lo, hi = 0, len(ordered)
        import bisect
        return bisect.bisect_right(ordered, value) / len(ordered)
    cos = [x["cosine"] for x in relations]
    npmi = [x["npmi"] for x in relations]
    docs = [math.log1p(x["document_count"]) for x in relations]
    cos_ordered = sorted(cos)
    npmi_ordered = sorted(npmi)
    docs_ordered = sorted(docs)
    for item in relations:
        item["cosine_percentile"] = round(percentile(cos_ordered, item["cosine"]), 8)
        item["npmi_percentile"] = round(percentile(npmi_ordered, item["npmi"]), 8)
        item["document_count_percentile"] = round(percentile(docs_ordered, math.log1p(item["document_count"])), 8)
        item["weight_score"] = round(0.50 * item["cosine_percentile"] + 0.30 * item["npmi_percentile"] + 0.20 * item["document_count_percentile"], 8)
    relations.sort(key=lambda x: (-x["weight_score"], x["relation_id"]))
    return relations, len(raw_relations)


def build_search(concepts):
    zh: dict[str, set[str]] = collections.defaultdict(set)
    pali: dict[str, set[str]] = collections.defaultdict(set)
    en: dict[str, set[str]] = collections.defaultdict(set)
    for c in concepts:
        cid = c["concept_id"]
        forms = [c["pali"], *c.get("surface_forms", [])]
        for form in forms:
            pali[norm_pali(form)].add(cid)
            pali[fold_pali(form)].add(cid)
        for value in [c.get("label_zh"), *c.get("surface_forms", [])]:
            for token in ZH_RE.findall(str(value or "")):
                for i in range(len(token)):
                    for j in range(i + 2, min(len(token), i + 8) + 1):
                        zh[token[i:j]].add(cid)
        for value in [c.get("label_en"), c.get("pali")]:
            for token in EN_RE.findall(str(value or "")):
                en[token.lower()].add(cid)
    def serial(index):
        return {k: sorted(v) for k, v in sorted(index.items())}
    return serial(zh), serial(pali), serial(en)


def build_adjacency(relations):
    """Build bounded per-concept access shards without duplicating long evidence text."""
    groups: dict[str, dict[str, list[dict[str, Any]]]] = collections.defaultdict(lambda: collections.defaultdict(list))
    index: dict[str, str] = {}
    row_count = 0
    def shard(concept_id):
        return sha(concept_id.encode("utf-8"))[:2]
    for relation in relations:
        compact = {k: relation.get(k) for k in (
            "relation_id", "source", "target", "relation_type", "direction", "document_count",
            "parent_work_count", "layer_document_counts", "local_context_window_count", "cosine",
            "npmi", "raw_relation_count", "raw_relation_sample", "semantic_claim", "evidence_status",
            "cosine_percentile", "npmi_percentile", "document_count_percentile", "weight_score",
            "ai_audit_status", "v2_audit_status",
        )}
        compact["evidence_concept_id"] = relation.get("source")
        for endpoint in (relation.get("source"), relation.get("target")):
            if not endpoint:
                continue
            bucket = shard(endpoint)
            index[endpoint] = bucket
            groups[bucket][endpoint].append(compact)
            row_count += 1
    return {bucket: {concept: rows for concept, rows in sorted(values.items())} for bucket, values in sorted(groups.items())}, index, row_count


def refresh_manifest(out: pathlib.Path, manifest: dict[str, Any]):
    entries = []
    for path in sorted(out.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            entries.append({"path": path.relative_to(out).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path.read_bytes())})
    manifest["files"] = entries
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", type=pathlib.Path, required=True)
    ap.add_argument("--v1-dir", type=pathlib.Path, required=True)
    ap.add_argument("--output", type=pathlib.Path, required=True)
    ap.add_argument("--ai-cache", type=pathlib.Path, help="complete two-pass GPT cache; omitted with --skip-ai")
    ap.add_argument("--skip-ai", action="store_true", help="skip AI audit and build a deterministic dictionary/rule projection")
    ap.add_argument("--frontend-index", type=pathlib.Path)
    ap.add_argument("--ai-model", default="gpt-5.6-sol")
    ap.add_argument("--ai-thinking-strength", choices=["low", "medium", "high", "xhigh", "ultra", "max"], default="high")
    args = ap.parse_args()
    out = args.output
    if out.exists():
        for p in sorted(out.rglob("*"), reverse=True):
            if p.is_file():
                p.unlink()
            elif p.is_dir():
                p.rmdir()
    out.mkdir(parents=True, exist_ok=True)
    v1_manifest, v1_concepts, v1_documents, raw_relations = load_v1(args.v1_dir)
    hints = load_dictionary_hints(args.archive)
    dictionary_values, proper_count, user_count = load_proper_and_user(args.archive)
    to_simplified = site_simplifier(args.frontend_index)
    if args.skip_ai:
        cache = {"provider": "not-run", "model": None, "thinking_strength": None, "prompt_version": "not-run", "record_count": 0, "proposal_batch_count": 0, "review_batch_count": 0, "proposals": [], "reviews": [], "errors": []}
    else:
        if not args.ai_cache:
            raise SystemExit("--ai-cache is required unless --skip-ai is supplied")
        cache = json.loads(args.ai_cache.read_text(encoding="utf-8"))
        if cache.get("provider") != "openai-codex" or cache.get("model") != args.ai_model or cache.get("thinking_strength") != args.ai_thinking_strength:
            raise SystemExit("AI cache provider/model/thinking strength does not match the requested GPT high build")
    expected = {str(x.get("concept_id") or x.get("pali")) for x in v1_concepts}
    proposals = cache_by_id(cache, "proposals")
    reviews = cache_by_id(cache, "reviews")
    if not args.skip_ai and (set(proposals) != expected or set(reviews) != expected):
        raise SystemExit(f"incomplete GPT cache: expected {len(expected)}, proposals {len(proposals)}, reviews {len(reviews)}")
    alias, alias_audit = make_aliases(v1_concepts, cache, hints)
    evidence = load_corpus_evidence(args.archive, set(alias))
    concepts, concept_evidence = build_concepts(v1_concepts, alias, alias_audit, hints, dictionary_values, evidence, to_simplified)
    relations, raw_count = build_relations(raw_relations, alias, evidence)
    concept_by_id = {concept["concept_id"]: concept for concept in concepts}
    for relation in relations:
        for endpoint in (relation.get("source"), relation.get("target")):
            concept = concept_by_id.get(endpoint)
            if concept:
                concept["degree"] += 1
                concept["relation_count"] += 1
    v2_audit_status = "not_ai_audited" if args.skip_ai else "ai_audit_available"
    for concept in concepts:
        concept["ai_audit_status"] = "not_run" if args.skip_ai else "completed"
        concept["v2_audit_status"] = v2_audit_status
    for relation in relations:
        relation["ai_audit_status"] = "not_run" if args.skip_ai else "completed"
        relation["v2_audit_status"] = v2_audit_status
    if len(v1_concepts) != 14474 or raw_count != 818110:
        raise SystemExit(f"source completeness failed: concepts={len(v1_concepts)} relations={raw_count}")
    if any(not c.get("label_zh") or not c.get("label_en") for c in concepts):
        raise SystemExit("translation label completeness failed")
    zh, pali, en = build_search(concepts)
    write_json(out / "concepts.json.gz", concepts, True)
    write_json(out / "documents.json.gz", v1_documents, True)
    write_json(out / "evidence" / "concepts.json.gz", concept_evidence, True)
    write_json(out / "search" / "zh.json.gz", zh, True)
    write_json(out / "search" / "pali.json.gz", pali, True)
    write_json(out / "search" / "en.json.gz", en, True)
    adjacency_groups, adjacency_index, adjacency_row_count = build_adjacency(relations)
    for bucket, values in adjacency_groups.items():
        write_json(out / "adjacency" / f"{bucket}.json.gz", values, True)
    write_json(out / "adjacency" / "index.json.gz", {"shards": adjacency_index, "row_count": adjacency_row_count, "relation_count": len(relations), "access_policy": "one bounded shard per selected concept"}, True)
    relation_groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    relation_index: dict[str, set[str]] = collections.defaultdict(set)
    for row in relations:
        prefixes = {row["source"][:2] or "__", row["target"][:2] or "__"}
        for prefix in prefixes:
            relation_groups[prefix].append(row)
            relation_index[row["source"]].add(prefix)
            relation_index[row["target"]].add(prefix)
    for prefix, rows in sorted(relation_groups.items()):
        write_json(out / "relations" / f"{prefix}.json.gz", rows, True)
    write_json(out / "relations" / "index.json.gz", {k: sorted(v) for k, v in sorted(relation_index.items())}, True)
    raw_groups: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in raw_relations:
        source = norm_pali(row.get("source"))
        raw_groups[source[:2] or "__"].append(raw_relation_projection(row))
    for prefix, rows in sorted(raw_groups.items()):
        write_json(out / "raw-relations" / f"{prefix}.json.gz", rows, True)
    write_json(out / "audit" / "ai-audit.json", {
        "provider": cache.get("provider"), "model": cache.get("model"), "thinking_strength": cache.get("thinking_strength"),
        "prompt_version": cache.get("prompt_version"), "record_count": cache.get("record_count"),
        "proposal_count": len(proposals), "review_count": len(reviews), "errors": cache.get("errors", []),
        "proposal_status": dict(collections.Counter(str(x.get("merge_status") or "unresolved") for x in proposals.values())),
        "review_status": dict(collections.Counter(str(x.get("verdict") or "unresolved") for x in reviews.values())),
        "concepts_with_dictionary_hints": sum(1 for x in v1_concepts if hints.get(norm_pali(x.get("pali")))),
        "dictionary_proper_noun_rows": proper_count, "dictionary_user_rows": user_count,
        "audit_status": "skipped_by_user_authorization" if args.skip_ai else "completed",
    })
    write_json(out / "audit" / "alias-audit.json", {
        "surface_count": len(alias), "canonical_count": len(concepts),
        "redirect_count": sum(1 for k, v in alias.items() if k != v),
        "surface_to_canonical": alias,
    })
    manifest = {
        "format": "tipitaka-concept-graph/v2", "version": 2,
        "build_id": "rule-only-20260831" if args.skip_ai else "gpt-high-20260831",
        "generated_at": "SOURCE-DERIVED", "source": {
            "archive_sha256": source_hash(args.archive), "v1_manifest_sha256": sha((args.v1_dir / "manifest.json").read_bytes()),
            "v1_format": v1_manifest.get("format"), "v1_counts": v1_manifest.get("counts", {}),
            "ai_model": None if args.skip_ai else args.ai_model,
            "ai_thinking_strength": None if args.skip_ai else args.ai_thinking_strength,
            "chinese_conversion": "V4 web-dataset chinese_simplified (source projection; no rewriting)",
        },
        "counts": {
            "surface_concepts": len(v1_concepts), "canonical_concepts": len(concepts),
            "surface_relations": raw_count, "canonical_relations": len(relations),
            "concept_evidence_verified": sum(1 for c in concepts if c.get("evidence", {}).get("verified")),
            "concept_evidence_unresolved": sum(1 for c in concepts if not c.get("evidence", {}).get("verified")),
            "relation_evidence_verified": sum(1 for r in relations if r["evidence_status"] == "verified"),
            "relation_evidence_unresolved": sum(1 for r in relations if r["evidence_status"] != "verified"),
            "adjacency_rows": adjacency_row_count, "adjacency_shards": len(adjacency_groups),
            "concept_types": len(ALLOWED_TYPES), "relation_types": len(FORMAL_RELATIONS),
        },
        "concept_types": [{"code": k, "label_zh": v} for k, v in ALLOWED_TYPES.items()],
        "relation_types": [{"code": k, "label_zh": v, "layer": "formal"} for k, v in FORMAL_RELATIONS],
        "statistical_signals": [x[0] for x in STAT_RELATIONS],
        "weight_formula": "0.50*cosine_percentile + 0.30*npmi_percentile + 0.20*log1p(document_count)_percentile",
        "evidence_policy": "V4 row locator and hash are required for verified status; statistical_only is retained and explicitly labeled.",
        "quality_gate": "static-data-passed-without-ai-audit" if args.skip_ai else "passed", "files": [],
        "ai": {"provider": cache.get("provider"), "model": cache.get("model"), "thinking_strength": cache.get("thinking_strength"), "prompt_version": cache.get("prompt_version"), "record_count": cache.get("record_count"), "proposal_batch_count": cache.get("proposal_batch_count"), "review_batch_count": cache.get("review_batch_count"), "status": "not_run" if args.skip_ai else ("partial" if any(x.get("verdict") != "verified" for x in reviews.values()) else "verified")},
    }
    refresh_manifest(out, manifest)
    write_json(out / "manifest.json", manifest)
    print(json.dumps({"surface_concepts": len(v1_concepts), "canonical_concepts": len(concepts), "surface_relations": raw_count, "canonical_relations": len(relations), "relation_evidence_verified": manifest["counts"]["relation_evidence_verified"], "concept_types": len(ALLOWED_TYPES), "relation_types": len(RELATION_TYPES)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
