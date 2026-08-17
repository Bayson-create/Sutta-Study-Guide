#!/usr/bin/env python3
"""Release-gate audit for the generated Abhidhamma DOC/PDF reader."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs" / "research" / "abhidhamma-sangaha"


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    manifest_path = output / "manifest.json"
    audit_path = output / "conversion-audit.json"
    if not manifest_path.exists() or not audit_path.exists():
        fail("manifest.json or conversion-audit.json is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    if manifest.get("physical_pages") != 489:
        fail(f"expected 489 physical pages, found {manifest.get('physical_pages')}")
    if manifest.get("top_level_outline_entries") != 24:
        fail(f"expected 24 top-level outline entries, found {manifest.get('top_level_outline_entries')}")
    sections = manifest.get("sections") or []
    if len(sections) != 18:
        fail(f"expected 18 sections, found {len(sections)}")
    pages = []
    semantic_files = 0
    semantic_tables = 0
    for section in sections:
        data_path = output / section["file"]
        semantic_path = output / section["semantic_file"]
        if not data_path.exists():
            fail(f"missing section data: {data_path}")
        if not semantic_path.exists():
            fail(f"missing semantic HTML: {semantic_path}")
        semantic = semantic_path.read_text(encoding="utf-8")
        if "�" in semantic:
            fail(f"replacement character in semantic HTML: {semantic_path}")
        semantic_files += 1
        semantic_tables += semantic.count("<table")
        payload = json.loads(data_path.read_text(encoding="utf-8"))
        pages.extend(payload.get("pages") or [])
        if section.get("source_doc") and not (output / section["source_doc"]).exists():
            fail(f"missing source DOC: {section['source_doc']}")
    physical = [int(page["physical_page"]) for page in pages]
    if physical != list(range(1, 490)):
        fail("section page coverage is not exactly physical pages 1-489")
    for page in pages:
        if page.get("complex_layout"):
            image = page.get("source_image")
            if not image or not (ROOT / "docs" / image.removeprefix("docs/" if image.startswith("docs/") else "")).exists():
                candidate = ROOT / "docs" / image if image else None
                if not candidate or not candidate.exists():
                    fail(f"complex page {page['physical_page']} has no source image")
    source_docs = audit.get("source_documents") or []
    if len(source_docs) != 13:
        fail(f"expected 13 source DOC records, found {len(source_docs)}")
    missing_assets = []
    for record in source_docs:
        for media in record.get("media") or []:
            asset = ROOT / "docs" / media["file"]
            if not asset.exists():
                missing_assets.append(str(asset))
    if missing_assets:
        fail("missing media assets: " + ", ".join(missing_assets[:5]))
    if len(manifest.get("search_documents") or []) != 18:
        fail("search_documents does not cover all 18 sections")
    print(json.dumps({
        "status": "PASS",
        "physical_pages": len(physical),
        "top_level_outline_entries": manifest["top_level_outline_entries"],
        "sections": len(sections),
        "semantic_files": semantic_files,
        "semantic_tables": semantic_tables,
        "source_doc_records": len(source_docs),
        "complex_pages": len(manifest.get("complex_pages") or []),
        "replacement_characters": 0,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
