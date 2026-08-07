#!/usr/bin/env python3
"""Run the approved Vism retranslation order, one chapter process at a time.

This deliberately does not start itself on deployment.  Run it only after
the 20-sentence chapter-1 pilot has been reviewed:
    python3 scripts/retranslate_vism_queue.py --apply
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHAPTER_PRIORITY = ((1, 17, 18), (11, 12, 15, 20, 21, 22, 23))
GAP_CHAPTERS = (1, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23)


def queue_steps(phase: str) -> list[tuple[int, str]]:
    steps: list[tuple[int, str]] = []
    if phase in ("machine", "all"):
        steps += [(chapter, "retranslate-dharmamitra") for group in CHAPTER_PRIORITY for chapter in group]
    if phase in ("gaps", "all"):
        steps += [(chapter, "fill-gaps") for chapter in GAP_CHAPTERS]
    return steps


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("machine", "gaps", "all"), default="all")
    parser.add_argument("--limit", type=int, default=None, help="cap each chapter for a staged run")
    parser.add_argument("--api-base", default=None)
    parser.add_argument("--apply", action="store_true", help="run translations; otherwise print the queue")
    args = parser.parse_args()
    for chapter, mode in queue_steps(args.phase):
        command = [sys.executable, str(ROOT / "scripts/retranslate_vism_chapter.py"),
                   "--chapter", str(chapter), "--mode", mode]
        if args.limit:
            command += ["--limit", str(args.limit)]
        if args.api_base:
            command += ["--api-base", args.api_base]
        print(" ".join(command))
        if args.apply:
            subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
