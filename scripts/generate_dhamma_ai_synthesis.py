#!/usr/bin/env python3
"""Generate evidence-bound DN33/DN34 AI research with DeepSeek V4 Flash.

The credential path is deliberately a required command-line argument.  The
token is read into memory only and is never copied to data, logs, environment
files, or the repository.  Each completed entry is written immediately so a
failed or interrupted batch resumes without repeating paid calls.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any

import httpx


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "docs/research/pali-source-texts/sutta/digha"
INDEX = BASE / "dhamma-numbers.json"
DETAIL_DIR = BASE / "dhamma-number-details"
BACKEND = ROOT.parent / "sutta-study-guide-backend" / "api"
MODEL = "deepseek-v4-flash"
MAX_CONCURRENCY = 4
MAX_ATTEMPTS = 4
T2S_REPLACEMENTS = str.maketrans({"瞋": "嗔"})

sys.path.insert(0, str(BACKEND))
from app.search import synthesis  # noqa: E402


def compact(value: str) -> str:
    return " ".join(value.split())


def read_token(path: Path) -> str:
    for line in path.read_text(encoding="utf-8", errors="strict").splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip().lower() == "deepseek" and value.strip():
            return value.strip()
    raise ValueError("credential 文件中没有有效的 Deepseek: token")


def visible_simple(value: str) -> str:
    # The build pass turns the final JSON through OpenCC.  This guard catches
    # the one terminology variant that OpenCC intentionally keeps unchanged.
    return value.translate(T2S_REPLACEMENTS)


def selected_passages(research: dict[str, Any], max_passages: int) -> tuple[list[synthesis.Passage], list[dict[str, Any]]]:
    raw = research.get("evidence", [])
    cleaned = synthesis.clean_passages([
        {"source": item.get("label") or item.get("source") or "未标注来源",
         "heading": item.get("kind") or "检索证据",
         "text": item.get("text") or ""}
        for item in raw
    ])
    retained: list[dict[str, Any]] = []
    for item in raw:
        if not compact(str(item.get("text") or "")):
            continue
        retained.append(item)
        if len(retained) == len(cleaned):
            break
    return cleaned[:max_passages], retained[:max_passages]


def full_markdown(label: str, answer: str, passages: list[synthesis.Passage], evidence: list[dict[str, Any]]) -> str:
    lines = [f"# AI 综合回答：{label}", "", answer.strip(), "", "## 引用"]
    for passage, item in zip(passages, evidence):
        href = str(item.get("href") or "")
        heading = f" · {passage.heading}" if passage.heading else ""
        lines.append(f"- [{passage.index}] {passage.source}{heading}{f' — {href}' if href else ''}")
        lines.append(f"  > {passage.text}")
    return "\n".join(lines)


def parse_response(value: str, sources: list[dict[str, Any]], number: int, passage_count: int) -> dict[str, Any]:
    text = value.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    result = json.loads(text)
    answer = str(result.get("answer_markdown") or "").strip()
    point_map = result.get("expanded_points")
    if not answer or not isinstance(point_map, dict):
        raise ValueError("模型返回缺少 answer_markdown 或 expanded_points")
    invalid = synthesis.citation_report(answer, passage_count)["invalid_indices"]
    if invalid:
        raise ValueError(f"模型返回了无效引用编号：{invalid}")
    normalized: dict[str, list[str]] = {}
    for source in sources:
        key = str(source["sutta"])
        points = point_map.get(key)
        if not isinstance(points, list) or len(points) != number:
            raise ValueError(f"{key} 要点数应为 {number}，实际为 {len(points) if isinstance(points, list) else '无'}")
        cleaned = [visible_simple(compact(str(point))) for point in points]
        if any(not point for point in cleaned):
            raise ValueError(f"{key} 含空要点")
        normalized[key] = cleaned
    return {"answer_markdown": visible_simple(answer), "expanded_points": normalized}


def build_messages(entry: dict[str, Any], sources: list[dict[str, Any]], passages: list[synthesis.Passage]) -> list[dict[str, str]]:
    messages = synthesis.build_messages(str(entry["label"]), passages)
    source_text = "\n\n".join(
        f"### {source['sutta'].upper()} 原文\n明确成员检索词：{'、'.join(source.get('member_items') or [])}\n" + "\n".join(source.get("source_paragraphs") or [source.get("source_text", "")])
        for source in sources
    )
    contract = f"""

这是静态法数详情生成任务。保持上面既有的 Markdown 回答结构、引用规则、证据边界和中文要求；不要在回答中加入未经证据支持的事实。

另外，依据下方完整原文，为每部经分别写出恰好 {entry['number']} 条简短的“展开要点”。每条是对该项的中文总结，不得原样长段复制，不能合并、遗漏或新增法项。若“明确成员检索词”恰好有 {entry['number']} 项，必须按其顺序一一对应，每一条都以该成员名称开头并解释该成员；例如“名、色”必须分别得到“名：……”与“色：……”，不能改写成两条泛泛的经文说明。特别是法数为一时，无论该唯一成员名称内部含有逗号、顿号或两个并列分句，都只能生成一条要点，完整概括这个复合成员，不得按标点拆成两条。只输出一个合法 JSON 对象，不能使用代码围栏：
{{
  "answer_markdown": "完整的既有 Markdown 综合回答，含原有小节和引用编号",
  "expanded_points": {{"dn33": ["恰好 N 项"], "dn34": ["恰好 N 项"]}}
}}
只为本法组实际包含的经别输出对应键。完整原文仅用于准确划分展开要点；综合回答中的可核查论断仍必须只引用上方编号证据。

完整原文：
{source_text}
"""
    messages[0] = {**messages[0], "content": messages[0]["content"] + contract}
    return messages


async def call_model(client: httpx.AsyncClient, token: str, messages: list[dict[str, str]], attempts: int, max_tokens: int) -> str:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            payload = {
                "model": MODEL,
                "messages": messages,
                "temperature": 0.2,
                # Match the production synthesis endpoint's cost/latency guard.
                "max_tokens": max_tokens,
                # V4 defaults to a long private thinking pass.  Static synthesis
                # needs a deterministic, schema-checked answer within its build
                # budget, so reserve completion tokens for the final JSON.
                "thinking": {"type": "disabled"},
                "response_format": {"type": "json_object"},
            }
            response = await client.post(
                "/chat/completions", headers={"Authorization": f"Bearer {token}"}, json=payload
            )
            response.raise_for_status()
            choice = response.json()["choices"][0]
            message = choice.get("message") or {}
            content = message.get("content")
            if not content:
                raise ValueError(
                    "模型返回空内容"
                    f"（finish_reason={choice.get('finish_reason')!r}, message_keys={sorted(message.keys())!r}）"
                )
            return content
        except (httpx.HTTPError, KeyError, ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                await asyncio.sleep(1.5 * (2 ** attempt))
    raise RuntimeError(str(last_error) if last_error else "DeepSeek 调用失败")


def completed(detail: dict[str, Any]) -> bool:
    research = detail.get("entry", {}).get("research", {})
    return bool(research.get("ai_full_markdown")) and all(
        len(group.get("expanded_points") or []) == int(group["number"])
        for group in detail.get("groups", [])
    )


async def run_one(entry_id: str, token: str, semaphore: asyncio.Semaphore, index_groups: dict[str, dict[str, Any]], force: bool, semantic_attempts: int, transport_attempts: int, timeout_seconds: float, max_tokens: int, max_passages: int) -> tuple[str, str | None]:
    try:
        detail_path = DETAIL_DIR / f"{entry_id}.json"
        detail = json.loads(detail_path.read_text(encoding="utf-8"))
        if completed(detail) and not force:
            return entry_id, None
        entry = detail["entry"]
        sources = detail["groups"]
        passages, retained = selected_passages(entry.get("research", {}), max_passages)
        if not passages:
            return entry_id, "没有可用检索证据"
        messages = build_messages(entry, sources, passages)
        parsed: dict[str, Any] | None = None
        semantic_error: Exception | None = None
        async with semaphore:
            async with httpx.AsyncClient(base_url="https://api.deepseek.com", timeout=timeout_seconds) as client:
                for _ in range(semantic_attempts):
                    output = await call_model(client, token, messages, transport_attempts, max_tokens)
                    try:
                        parsed = parse_response(output, sources, int(entry["number"]), len(passages))
                        break
                    except (ValueError, json.JSONDecodeError) as exc:
                        semantic_error = exc
        if parsed is None:
            return entry_id, f"模型结构化结果校验失败：{semantic_error}"
        entry["research"].update({
            "answer_markdown": parsed["answer_markdown"],
            "ai_full_markdown": full_markdown(entry["label"], parsed["answer_markdown"], passages, retained),
            "generated_by": "DeepSeek deepseek-v4-flash via existing search synthesis prompt",
            "model": MODEL,
        })
        for source in sources:
            points = parsed["expanded_points"][source["sutta"]]
            source["expanded_points"] = points
            index_groups[source["id"]]["expanded_points"] = points
        detail_path.write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding="utf-8")
        return entry_id, None
    except Exception as exc:  # A bad source or transport edge case must not abort other calls.
        return entry_id, f"未处理异常：{type(exc).__name__}: {exc}"


async def main(args: argparse.Namespace) -> int:
    if not 1 <= args.max_passages <= synthesis.MAX_PASSAGES:
        raise ValueError(f"max-passages 必须介于 1 和 {synthesis.MAX_PASSAGES} 之间")
    if args.semantic_attempts < 1 or args.transport_attempts < 1:
        raise ValueError("重试次数必须至少为 1")
    token = read_token(Path(args.credential))
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    index_groups = {group["id"]: group for group in index["groups"]}
    ids = [entry["id"] for entry in index["entries"]]
    if args.entry_id:
        requested = set(args.entry_id)
        ids = [entry_id for entry_id in ids if entry_id in requested]
        missing = requested - set(ids)
        if missing:
            raise ValueError(f"指定的 entry_id 不存在：{', '.join(sorted(missing))}")
    elif args.offset or args.limit is not None:
        ids = ids[args.offset: args.offset + args.limit if args.limit is not None else None]
    semaphore = asyncio.Semaphore(args.concurrency)
    failures: list[tuple[str, str]] = []
    for offset in range(0, len(ids), args.concurrency):
        results = await asyncio.gather(*(run_one(entry_id, token, semaphore, index_groups, args.force, args.semantic_attempts, args.transport_attempts, args.timeout_seconds, args.max_tokens, args.max_passages) for entry_id in ids[offset:offset + args.concurrency]))
        for entry_id, error in results:
            if error:
                failures.append((entry_id, error))
        INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"completed": min(offset + args.concurrency, len(ids)), "total": len(ids), "failures": len(failures)}, ensure_ascii=False))
    if failures:
        print(json.dumps({"failed_entries": [entry_id for entry_id, _ in failures]}, ensure_ascii=False))
        print(json.dumps({"failure_reasons": dict(failures)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--credential", required=True, help="Path to a local credential file containing Deepseek: TOKEN")
    parser.add_argument("--concurrency", type=int, default=MAX_CONCURRENCY)
    parser.add_argument("--entry-id", action="append", help="Only generate an entry; repeat this option for a retry set")
    parser.add_argument("--offset", type=int, default=0, help="Start at this index entry; used for resumable batch chunks")
    parser.add_argument("--limit", type=int, help="Maximum number of index entries to generate in this chunk")
    parser.add_argument("--semantic-attempts", type=int, default=3, help="Retries for invalid structured model output")
    parser.add_argument("--transport-attempts", type=int, default=MAX_ATTEMPTS, help="Retries for API timeouts, 429s, and transient transport errors")
    parser.add_argument("--timeout-seconds", type=float, default=120, help="Per-request transport timeout")
    parser.add_argument("--max-tokens", type=int, default=synthesis.MAX_ANSWER_TOKENS, help="Maximum completion length; defaults to the production synthesis guard")
    parser.add_argument("--max-passages", type=int, default=synthesis.MAX_PASSAGES, help="Top ranked evidence passages sent to the model (maximum 18)")
    parser.add_argument("--force", action="store_true", help="Regenerate entries that already have valid checkpoints")
    arguments = parser.parse_args()
    raise SystemExit(asyncio.run(main(arguments)))
