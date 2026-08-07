#!/usr/bin/env python3
"""Generate evidence-bound AI summaries for the formal extension groups.

This deliberately keeps the extension layer separate from the completed
DN33/DN34 batch.  It reads only ``Deepseek:`` from the supplied credential,
writes checkpoints after every group, and never serializes the token.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "docs/research/pali-source-texts/sutta/dhamma-extensions"
INDEX = EXT / "extension-index.json"
DETAIL_DIR = EXT / "details"
BACKEND = ROOT.parent / "sutta-study-guide-backend" / "api"
MODEL = "deepseek-v4-flash"
MAX_CONCURRENCY = 4
MAX_ATTEMPTS = 4
sys.path.insert(0, str(BACKEND))
from app.search import synthesis  # noqa: E402


def read_token(path: Path) -> str:
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip().lower() == "deepseek" and value.strip():
            return value.strip()
    raise ValueError("credential 文件中没有有效的 Deepseek: token")


def compact(value: str) -> str:
    return " ".join(str(value or "").split())


def detail_path(detail_id: str) -> Path:
    return DETAIL_DIR / f"{quote(detail_id, safe='')}.json"


def simple(value: str) -> str:
    return str(value or "").translate(str.maketrans({"瞋": "嗔", "覺": "觉", "滅": "灭", "證": "证", "慚": "惭", "無": "无", "愛": "爱", "處": "处", "識": "识", "內": "内", "陰": "阴", "貪": "贪", "蓋": "盖", "進": "进", "觀": "观", "見": "见", "脫": "脱", "礙": "碍"}))


def passages_for(detail: dict[str, Any]) -> tuple[list[synthesis.Passage], list[dict[str, Any]]]:
    raw = detail.get("research", {}).get("evidence", [])
    rows = [{"source": item.get("label", "来源"), "heading": item.get("kind", "原文证据"), "text": item.get("text", "")} for item in raw]
    cleaned = synthesis.clean_passages(rows)
    retained = [item for item in raw if compact(item.get("text", ""))][: len(cleaned)]
    return cleaned[: synthesis.MAX_PASSAGES], retained[: synthesis.MAX_PASSAGES]


def markdown(label: str, number: int, answer: str, passages: list[synthesis.Passage], evidence: list[dict[str, Any]]) -> str:
    lines = [f"# AI 综合回答：{simple(label)}（{number}法）", "", answer.strip(), "", "## 引用"]
    for passage, item in zip(passages, evidence):
        href = str(item.get("href") or "")
        lines.append(f"- [{passage.index}] {simple(passage.source)} — {href}" if href else f"- [{passage.index}] {simple(passage.source)}")
        if passage.text:
            lines.append(f"  > {simple(passage.text)}")
    return "\n".join(lines)


def parse_output(raw: str, number: int) -> tuple[str, list[str]]:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    obj = json.loads(text)
    answer = str(obj.get("answer_markdown") or "").strip()
    points = obj.get("expanded_points")
    if not answer or not isinstance(points, list) or len(points) != number:
        raise ValueError(f"模型返回的回答或要点数量无效（要求 {number}）")
    invalid = synthesis.citation_report(answer, synthesis.MAX_PASSAGES)["invalid_indices"]
    if invalid:
        raise ValueError(f"引用编号无效：{invalid}")
    normalized = [compact(simple(point)) for point in points]
    if any(not point for point in normalized):
        raise ValueError("存在空展开要点")
    return simple(answer), normalized


def messages_for(detail: dict[str, Any], passages: list[synthesis.Passage]) -> list[dict[str, str]]:
    label = str(detail["label"])
    number = int(detail.get("number") or len(detail.get("members") or []))
    messages = synthesis.build_messages(label, passages)
    members = "、".join(simple(item) for item in detail.get("members", []))
    occurrences = "\n\n".join(
        f"### {item.get('source_uid', '').upper()} 原文\n" + "\n".join(simple(p) for p in item.get("source_paragraphs", []))
        for item in detail.get("occurrences", [])
    )
    contract = f"""

这是扩展法数详情生成任务。只输出一个合法 JSON 对象，不使用代码围栏：
{{"answer_markdown":"完整 Markdown 综合回答","expanded_points":["恰好 {number} 条"]}}

法组名称：{simple(label)}
法数：{number}
成员（必须逐一解释）：{members}

回答必须解释法组整体定义，并在正文中分别解释每一个成员；只能使用上方检索证据支持可核查事实。引用编号必须来自证据编号。expanded_points 必须恰好 {number} 条，按成员顺序逐项总结，不得合并或拆分。完整原文只用于核对成员边界。

完整原文：
{occurrences}
"""
    messages[0] = {**messages[0], "content": messages[0]["content"] + contract}
    return messages


async def call(client: httpx.AsyncClient, token: str, messages: list[dict[str, str]], attempts: int, max_tokens: int) -> str:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            response = await client.post("/chat/completions", headers={"Authorization": f"Bearer {token}"}, json={"model": MODEL, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens, "thinking": {"type": "disabled"}, "response_format": {"type": "json_object"}})
            response.raise_for_status()
            content = (response.json().get("choices", [{}])[0].get("message", {}) or {}).get("content")
            if not content:
                raise ValueError("模型返回空内容")
            return content
        except (httpx.HTTPError, ValueError, KeyError, json.JSONDecodeError) as exc:
            last = exc
            if attempt + 1 < attempts:
                await asyncio.sleep(1.5 * (2 ** attempt))
    raise RuntimeError(str(last) if last else "DeepSeek 调用失败")


def ready(detail: dict[str, Any]) -> bool:
    research = detail.get("research", {})
    return bool(research.get("ai_full_markdown")) and len(detail.get("expanded_points") or []) == int(detail.get("number") or len(detail.get("members") or []))


async def run_one(group: dict[str, Any], token: str, semaphore: asyncio.Semaphore, force: bool, max_tokens: int, timeout: float) -> tuple[str, str | None]:
    path = detail_path(group["detail_id"])
    try:
        detail = json.loads(path.read_text(encoding="utf-8"))
        if ready(detail) and not force:
            return group["id"], None
        passages, retained = passages_for(detail)
        if not passages:
            return group["id"], "没有可用证据"
        messages = messages_for(detail, passages)
        async with semaphore:
            async with httpx.AsyncClient(base_url="https://api.deepseek.com", timeout=timeout) as client:
                parsed = None
                error: Exception | None = None
                for _ in range(3):
                    try:
                        parsed = parse_output(await call(client, token, messages, MAX_ATTEMPTS, max_tokens), int(detail.get("number") or len(detail.get("members") or [])))
                        break
                    except (ValueError, json.JSONDecodeError) as exc:
                        error = exc
                if parsed is None:
                    return group["id"], f"结构校验失败：{error}"
        answer, points = parsed
        detail["expanded_points"] = points
        detail["research"].update({"answer_markdown": answer, "ai_full_markdown": markdown(detail["label"], int(detail.get("number") or len(points)), answer, passages, retained), "generated_by": "DeepSeek deepseek-v4-flash via existing search synthesis prompt", "model": MODEL, "ai_status": "ready"})
        path.write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding="utf-8")
        return group["id"], None
    except Exception as exc:
        return group["id"], f"{type(exc).__name__}: {exc}"


async def main(args: argparse.Namespace) -> int:
    token = read_token(Path(args.credential))
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    groups = [group for group in index.get("formal_groups", []) if group.get("detail_id")]
    if args.group_id:
        wanted = set(args.group_id)
        groups = [group for group in groups if group["id"] in wanted]
    semaphore = asyncio.Semaphore(args.concurrency)
    failures: list[tuple[str, str]] = []
    for start in range(0, len(groups), args.concurrency):
        results = await asyncio.gather(*(run_one(group, token, semaphore, args.force, args.max_tokens, args.timeout) for group in groups[start:start + args.concurrency]))
        failures.extend((group_id, error) for group_id, error in results if error)
        print(json.dumps({"completed": min(start + args.concurrency, len(groups)), "total": len(groups), "failures": len(failures)}, ensure_ascii=False))
    ready_ids = set()
    for group in groups:
        detail = json.loads(detail_path(group["detail_id"]).read_text(encoding="utf-8"))
        group["ai_status"] = detail.get("research", {}).get("ai_status", "pending")
        group["expanded_points"] = detail.get("expanded_points", [])
        if group["ai_status"] == "ready":
            ready_ids.add(group["id"])
    index["generated_at"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    index["counts"]["ai_ready"] = len(ready_ids)
    INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    if failures:
        print(json.dumps({"failed_groups": failures}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--credential", required=True)
    parser.add_argument("--concurrency", type=int, default=MAX_CONCURRENCY)
    parser.add_argument("--max-tokens", type=int, default=3000)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--group-id", action="append")
    parser.add_argument("--force", action="store_true")
    raise SystemExit(asyncio.run(main(parser.parse_args())))
