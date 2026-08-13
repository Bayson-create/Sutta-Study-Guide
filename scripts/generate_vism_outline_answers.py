#!/usr/bin/env python3
"""Generate cited, resumable reference answers for the Vism study outline.

This is a release-time tool, never a browser feature.  It sends one bounded,
chapter-local evidence packet per question to the configured fixed model and
refuses to publish an answer unless all cited Pāli/English anchors are real.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


MODEL = "deepseek-v4-flash"
MAX_EVIDENCE = 42
ZH_WORD = re.compile(r"[\u3400-\u9fff]{2,}")


def normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip().casefold()


def anchor(value: str) -> str:
    return hashlib.sha256(normalized(value).encode()).hexdigest()[:16]


def env_value(path: Path, name: str) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"')
    return ""


def chinese_terms(value: str) -> set[str]:
    terms: set[str] = set()
    for run in ZH_WORD.findall(value):
        terms.add(run)
        terms.update(run[index:index + 2] for index in range(len(run) - 1))
    return {term for term in terms if term not in {"什么", "为何", "如何", "那些", "可以", "应当", "说明"}}


def chapter_rows(data_root: Path, chapter: int) -> list[dict[str, Any]]:
    pe = json.loads((data_root / f"pe_chap{chapter:02d}.json").read_text(encoding="utf-8"))
    zh = json.loads((data_root / f"zh_chap{chapter:02d}.json").read_text(encoding="utf-8"))
    sections = zh.get("sections", [])
    rows: list[dict[str, Any]] = []
    for part_index, part in enumerate(pe.get("parts", []), start=1):
        for row_index, row in enumerate(part.get("rows", []), start=1):
            rows.append({
                "chapter": chapter,
                "part_index": part_index,
                "row_index": row_index,
                "pali": row.get("pali", ""),
                "english": row.get("english", ""),
                "pali_hash": anchor(row.get("pali", "")),
                "english_hash": anchor(row.get("english", "")),
            })
    # Chinese section text is an auxiliary retrieval signal only; original
    # Pāli/English rows remain the sole citable evidence.
    for index, row in enumerate(rows):
        relative = (row["part_index"] - 1) / max(1, len(pe.get("parts", [])) - 1)
        zh_index = min(len(sections) - 1, round(relative * max(0, len(sections) - 1)))
        section = sections[zh_index] if sections else {}
        row["zh_hint"] = f"{section.get('heading', '')} {re.sub('<[^>]+>', ' ', section.get('html', ''))[:1800]}"
    return rows


def evidence_for(question: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    terms = chinese_terms(question)
    scored: list[tuple[int, int, dict[str, Any]]] = []
    for index, row in enumerate(rows):
        hint = row["zh_hint"]
        score = sum(2 + len(term) for term in terms if term in hint)
        # The beginning of each translated part establishes terminology and
        # is useful when question words occur only in headings.
        if row["row_index"] <= 2:
            score += 2
        scored.append((score, -index, row))
    chosen = [row for score, _, row in sorted(scored, reverse=True) if score > 0][:MAX_EVIDENCE]
    if len(chosen) < MAX_EVIDENCE:
        seen = {(row["part_index"], row["row_index"]) for row in chosen}
        for _, _, row in sorted(scored, reverse=True):
            key = (row["part_index"], row["row_index"])
            if key not in seen:
                chosen.append(row)
                seen.add(key)
            if len(chosen) >= MAX_EVIDENCE:
                break
    return sorted(chosen, key=lambda row: (row["part_index"], row["row_index"]))


def call_model(base_url: str, api_key: str, question: str, evidence: list[dict[str, Any]]) -> dict[str, Any]:
    sources = "\n".join(
        f"[{index + 1}] part={row['part_index']} row={row['row_index']} | Pāli: {row['pali']} | English: {row['english']}"
        for index, row in enumerate(evidence)
    )
    system = """你是《清净道论》学习材料的严谨编辑。只根据给出的巴利语/英语原文证据，以简体中文回答问题。每个子问都要明确回答；不能从证据支持的地方必须说明边界。不要杜撰引文、段号、人物或教义。输出严格 JSON：{\"answer\":\"...\",\"citations\":[{\"source\":1,\"note\":\"该证据支持的简短说明\"}]}。answer 中用 [1] 这样的编号引用；至少 2 条、最多 8 条引用，且只引用真正支持的内容。"""
    payload = json.dumps({"model": MODEL, "temperature": 0.1, "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": system}, {"role": "user", "content": f"问题：{question}\n\n证据：\n{sources}"}]}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(f"{base_url.rstrip('/')}/chat/completions", data=payload, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = json.loads(response.read().decode("utf-8"))
    content = raw["choices"][0]["message"]["content"]
    return json.loads(content)


def validate_answer(answer: dict[str, Any], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    text = str(answer.get("answer", "")).strip()
    citations = answer.get("citations")
    if not text or not isinstance(citations, list) or not citations:
        raise ValueError("model returned no answer or no citations")
    output = []
    for citation in citations:
        source = citation.get("source") if isinstance(citation, dict) else None
        if not isinstance(source, int) or source < 1 or source > len(evidence):
            raise ValueError("model cited an unavailable source")
        row = evidence[source - 1]
        output.append({
            "chapter": row["chapter"], "part_index": row["part_index"], "row_index": row["row_index"],
            "pali_hash": row["pali_hash"], "english_hash": row["english_hash"],
            "pali_snippet": row["pali"][:240], "english_snippet": row["english"][:240],
            "note": str(citation.get("note", "")).strip()[:300], "source": source,
        })
    return {"answer": text, "citations": output}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--answers", type=Path, required=True)
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=0, help="generate only this many pending answers")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    outline = json.loads((args.data_root / "outline-v1.json").read_text(encoding="utf-8"))
    questions = [question for section in outline["sections"] for question in section["questions"]]
    existing = json.loads(args.answers.read_text(encoding="utf-8")) if args.answers.exists() else {"answers": {}}
    answers = existing.get("answers", {})
    if args.verify_only:
        if len(answers) != 216:
            raise ValueError(f"expected 216 answers, got {len(answers)}")
        print(json.dumps({"verified": len(answers)}))
        return 0
    base_url = env_value(args.env, "DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
    api_key = env_value(args.env, "DEEPSEEK_API_KEY")
    if not api_key:
        raise ValueError("DEEPSEEK_API_KEY is required to generate pre-built answers")
    cache: dict[int, list[dict[str, Any]]] = {}
    generated = 0
    for question in questions:
        if question["id"] in answers:
            continue
        chapter = question["chapter_ids"][0]
        cache.setdefault(chapter, chapter_rows(args.data_root, chapter))
        evidence = evidence_for(question["text"], cache[chapter])
        try:
            raw = call_model(base_url, api_key, question["text"], evidence)
            item = validate_answer(raw, evidence)
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, KeyError, json.JSONDecodeError) as exc:
            print(f"failed {question['id']}: {exc}")
            time.sleep(2)
            continue
        answers[question["id"]] = {"status": "verified", "question": question["text"], "chapter_ids": question["chapter_ids"], **item}
        payload = {"format": "vism-outline-answers/v1", "source_sha256": outline["source"]["sha256"], "model": {"name": MODEL, "temperature": 0.1, "retrieval": "chapter_local_zh_heading_assisted_v1"}, "answers": answers}
        args.answers.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        generated += 1
        print(f"generated {question['id']} ({len(answers)}/216)")
        if args.limit and generated >= args.limit:
            break
        time.sleep(0.35)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
