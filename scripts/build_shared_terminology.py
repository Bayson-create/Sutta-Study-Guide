#!/usr/bin/env python3
"""Merge papancasudani's terminology.json (3491 terms) with the 17 terms
shared identically across all 13 retranslated_chap*/terminology.json files
into docs/research/shared-terminology.json - one table for both readers.

Conflict rule (papanca wins - it's the larger, part-of-speech-tagged table
with sourced first-occurrences): when a vism term's translation differs
from papanca's, the vism translation is appended to alternative_translations
(deduplicated) and a note is appended to usage_note, rather than dropped -
the disagreement is a real editorial fact (e.g. cetanā: papanca's "思" is
the standard Abhidhamma rendering, vism's "意志" reads more modern), not
noise to discard.

Run from repo root: python3 scripts/build_shared_terminology.py
Requires opencc-python-reimplemented (see scripts/.venv).
"""

import json
import sys
from pathlib import Path

from opencc import OpenCC

ROOT = Path(__file__).resolve().parents[1]
PAPANCA_TERMS = ROOT / "docs/research/pali-source-texts/sutta/majjhima/papancasudani/terminology.json"
VISM_TERMS = ROOT / "docs/research/vism-data/retranslated_chap01/terminology.json"
OUT = ROOT / "docs/research/shared-terminology.json"

T2S = OpenCC("t2s")


def s(text: str) -> str:
    return T2S.convert(text or "")


def main() -> None:
    papanca = json.loads(PAPANCA_TERMS.read_text(encoding="utf-8"))
    vism = json.loads(VISM_TERMS.read_text(encoding="utf-8"))["terms"]

    merged: dict[str, dict] = {}
    for t in papanca:
        merged[t["pali"]] = {
            "pali": t["pali"],
            "preferred_translation": s(t["preferred_translation"]),
            "alternative_translations": [s(x) for x in (t.get("alternative_translations") or [])],
            "part_of_speech": t.get("part_of_speech") or "",
            "usage_note": s(t.get("usage_note") or ""),
            "canonical_first_occurrence_id": t.get("canonical_first_occurrence_id"),
            "sources": ["papanca"],
        }

    conflicts = []
    additions = []
    for t in vism:
        pali = t["pali"]
        vism_translation = s(t["unified_chinese"])
        if pali in merged:
            entry = merged[pali]
            entry["sources"].append("vism")
            if vism_translation != entry["preferred_translation"]:
                if vism_translation not in entry["alternative_translations"]:
                    entry["alternative_translations"].append(vism_translation)
                entry["usage_note"] = (entry["usage_note"] + f"\n《清净道论》译作「{vism_translation}」。").strip()
                conflicts.append(pali)
        else:
            merged[pali] = {
                "pali": pali,
                "preferred_translation": vism_translation,
                "alternative_translations": [s(x) for x in (t.get("other_translations") or [])],
                "part_of_speech": "",
                "usage_note": s(t.get("usage", "")),
                "canonical_first_occurrence_id": None,
                "sources": ["vism"],
            }
            additions.append(pali)

    out = list(merged.values())

    # --- assertions: fail loudly rather than ship a half-built table ---
    expected_total = len(papanca) + len(additions)
    assert len(out) == expected_total, f"expected {expected_total} terms, got {len(out)}"

    expected_conflicts = {"cetanā", "saṃvara", "khanti", "lakkhaṇa"}
    assert set(conflicts) == expected_conflicts, f"conflict set changed: {conflicts}"

    expected_additions = {
        "cetasika", "virati", "rasa", "paccupaṭṭhāna",
        "padaṭṭhāna", "ājīvapārisuddhi", "avippaṭisāra",
    }
    assert set(additions) == expected_additions, f"addition set changed: {additions}"

    TRAD_PROBE = set("現後說靈觀無變讀學實體經術語誰識點爲來時間問題譯註釋總結導論將給認為裡邊團嚴義處斷體")
    bad = [e["pali"] for e in out if any(c in TRAD_PROBE for c in e["preferred_translation"] + "".join(e["alternative_translations"]) + e["usage_note"])]
    assert not bad, f"traditional characters survived normalization in: {bad}"

    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {len(out)} terms to {OUT}")
    print(f"  {len(conflicts)} conflicts resolved (papanca preferred, vism -> alternatives): {sorted(conflicts)}")
    print(f"  {len(additions)} vism-only terms added: {sorted(additions)}")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
