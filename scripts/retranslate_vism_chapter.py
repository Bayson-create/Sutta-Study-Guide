#!/usr/bin/env python3
"""Re-translate a run of Vism sentences through Dharmamitra and store the
result as each unit's current translation.

Why re-translate rows that already have a translation: chapter 17's existing
Chinese came from an older pipeline whose quality drops partway through. The
current cat-translate endpoint is measurably better - at p1-r80 the old text
renders `apaccakkhāya` as "而不是拒绝条件" (backwards), where the current
endpoint gives "并非不依于缘" and annotates the Pāli term. The shipped
`default_text` is frozen by the backend and never touched by this, and every
write lands in TranslationRevision, so this is reversible per sentence.

Rate limiting - the part that actually needs care
-------------------------------------------------
The backend allows 12 calls per 60s *sliding* window, per user
(app/routers/translations.py: _MITRA_RATE_MAX_CALLS). Two consequences that
a naive "sleep N seconds" loop gets wrong, both verified against the real
limiter logic rather than by observation:

  * Pacing must be measured between request *starts*, not between the end of
    one and the start of the next. A translate call takes 1.6-4.6s, so a
    3s sleep yields ~6s spacing (fine) while a 3s *interval* would be
    rejected 81 times in 10 minutes. Simulating the real limiter: intervals
    of 3.0/4.0/5.0s produce 81/36/9 rejections per 10 min; 5.1s+ produces 0.

  * Recovery from a 429 is not a fixed delay. Under steady pacing the oldest
    call is already about to expire, so ~0.1s suffices; after a 12-call
    burst you must wait the full 60.01s, and a 5s retry loop would spin
    against the wall. So the backoff here is computed from this client's own
    call history, not hardcoded.

Rather than tune a sleep, this mirrors the server's window client-side and
holds itself to CLIENT_MAX_CALLS (below the server's 12). The margin absorbs
clock skew, network jitter, and a human using the Dharmamitra button in the
browser at the same time - the limit is per user, so a shared account
competes with itself. 429 handling remains as a backstop, not the plan.

Resumability: a progress file records every finished unit_key, so the run can
be stopped and restarted without redoing work or double-charging the window.

Usage:
    export SUTTA_API_EMAIL=... SUTTA_API_PASSWORD=...
    python3 scripts/retranslate_vism_chapter.py --chapter 17 --start p1-r80
    python3 scripts/retranslate_vism_chapter.py --chapter 17 --start p1-r80 \
        --minutes 15                      # stop after 15 minutes, resumable
    python3 scripts/retranslate_vism_chapter.py --chapter 17 --start p1-r80 \
        --dry-run                         # translate nothing, just plan
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_API = "https://sutta-api.agreeablemeadow-9da329ca.swedencentral.azurecontainerapps.io"

# The server's own window, mirrored here so this client can stay inside it.
SERVER_WINDOW_SECONDS = 60.0
SERVER_MAX_CALLS = 12
# Held below the server's limit on purpose - see the module docstring.
CLIENT_MAX_CALLS = 10
# Even pacing rather than a floor. The window limiter above is what keeps us
# legal, and simulation shows any spacing from 0-6s yields the same 10/min -
# the window is the binding constraint either way. But a smaller value makes
# the client fire 10 calls back-to-back and then idle ~26s, whereas 60/10
# spreads them evenly for identical throughput. Dharmamitra is a free public
# service; there is no reason to hand it bursts when smooth costs nothing.
MIN_SPACING_SECONDS = SERVER_WINDOW_SECONDS / CLIENT_MAX_CALLS  # 6.0s

HTTP_TIMEOUT = 180

# Live status for the local dashboard. This lives under docs/research/vism-data
# because that is the directory the dashboard container bind-mounts; the
# progress file next to this script is deliberately separate (it is the resume
# ledger and must survive independently of any monitoring).
STATUS_DIR = ROOT / "docs/research/vism-data/.retranslation-dashboard"
RECENT_KEPT = 8


class RateLimitError(RuntimeError):
    pass


class StatusWriter:
    """Publishes live progress for the dashboard to read.

    Written atomically (temp file + rename) because the dashboard polls every
    2 seconds and would otherwise eventually read a half-flushed file and show
    a parse error instead of progress.
    """

    def __init__(self, path: Path, meta: dict):
        self.path = path
        self.state = dict(meta)
        self.state.update({
            "kind": "api-retranslate",
            "status": "starting",
            "pid": os.getpid(),
            "started_at": time.time(),
            "done_count": 0, "failed": 0, "rate_limited": 0,
            "throughput_per_min": 0.0, "eta_minutes": None,
            "current_unit": None, "recent": [], "latency": {},
        })
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.flush()

    def update(self, **fields) -> None:
        self.state.update(fields)
        self.flush()

    def note_done(self, unit_key: str, text: str, elapsed: float, stats: dict,
                  latencies: list, remaining: int) -> None:
        rate = stats["ok"] / (elapsed / 60) if elapsed > 0 else 0.0
        recent = ([{"unit_key": unit_key, "text": text[:120], "at": time.time()}]
                  + self.state.get("recent", []))[:RECENT_KEPT]
        self.state.update({
            "status": "running",
            "done_count": stats["ok"], "failed": stats["failed"],
            "rate_limited": stats["rate_limited"],
            "current_unit": unit_key, "recent": recent,
            "throughput_per_min": round(rate, 2),
            "eta_minutes": round(remaining / rate, 1) if rate > 0 else None,
            "latency": {
                "min": round(min(latencies), 2), "max": round(max(latencies), 2),
                "mean": round(sum(latencies) / len(latencies), 2),
            } if latencies else {},
        })
        self.flush()

    def flush(self) -> None:
        self.state["updated_at"] = time.time()
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)
        except Exception:
            # Losing a status write must never interrupt translation - the
            # dashboard is an observer, not part of the job.
            pass


def _request(url, *, method="GET", body=None, token=None, timeout=HTTP_TIMEOUT):
    data = json.dumps(body).encode() if body is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        try:
            detail = json.loads(payload).get("detail", "")
        except Exception:
            detail = payload[:200].decode("utf-8", "replace")
        if exc.code == 429:
            raise RateLimitError(detail or "rate limited") from exc
        raise RuntimeError(f"HTTP {exc.code} on {method} {url}: {detail}") from exc


class WindowLimiter:
    """Keeps this client inside the server's sliding window by construction.

    Tracks request *start* times because that is what the server records
    (it appends to its deque before making the upstream call), so this
    stays aligned with the server's view even when a translate call is slow.
    """

    def __init__(self, max_calls: int, window: float, min_spacing: float):
        self.max_calls = max_calls
        self.window = window
        self.min_spacing = min_spacing
        self.starts: deque[float] = deque()
        self.slept_total = 0.0

    def _prune(self, now: float) -> None:
        # Mirrors the server's strict `>` comparison: a call at exactly the
        # window boundary is still counted, so we must not drop it either.
        while self.starts and now - self.starts[0] > self.window:
            self.starts.popleft()

    def wait_for_slot(self) -> float:
        waited = 0.0
        while True:
            now = time.monotonic()
            self._prune(now)
            needs = []
            if len(self.starts) >= self.max_calls:
                # Wait for the oldest to leave the window (+ margin for skew).
                needs.append(self.starts[0] + self.window - now + 0.5)
            if self.starts:
                needs.append(self.starts[-1] + self.min_spacing - now)
            delay = max([d for d in needs if d > 0], default=0.0)
            if delay <= 0:
                self.starts.append(time.monotonic())
                self.slept_total += waited
                return waited
            time.sleep(delay)
            waited += delay

    def backoff_after_429(self) -> float:
        """How long until the server can possibly accept us again.

        Derived from our own history rather than a fixed delay: after a
        burst the true answer is the full window, and a short fixed retry
        would just spin. Falls back to the whole window if we somehow have
        no history (e.g. the server counted calls we didn't).
        """
        now = time.monotonic()
        self._prune(now)
        if not self.starts:
            return self.window + 1.0
        return max(1.0, self.starts[0] + self.window - now + 1.0)


def load_chapter_rows(chapter: str):
    """(unit_key, pali, existing_zh) for every row, in reading order.

    unit_key must match what the reader and the backend use - p{part}-r{row},
    1-based, over pe_chapNN.json's structure. Deriving it from the *same*
    file the reader renders is what keeps a write from landing on the wrong
    sentence.
    """
    tag = chapter if chapter in ("nidana", "conclusion") else f"chap{chapter.zfill(2)}"
    pe_path = ROOT / f"docs/research/vism-data/pe_{tag}.json"
    if not pe_path.exists():
        sys.exit(f"FAILED: {pe_path} not found")
    pe = json.loads(pe_path.read_text(encoding="utf-8"))

    zh_by_pos = {}
    if chapter not in ("nidana", "conclusion"):
        rt_dir = ROOT / f"docs/research/vism-data/retranslated_chap{chapter.zfill(2)}"
        final_p = rt_dir / f"pe_chap{chapter.zfill(2)}.final.json"
        results_p = rt_dir / "results.json"
        src = None
        if final_p.exists():
            src = json.loads(final_p.read_text(encoding="utf-8"))
        elif results_p.exists():
            src = json.loads(results_p.read_text(encoding="utf-8"))
        if isinstance(src, list):
            for r in src:
                zh_by_pos[(int(r.get("part_index") or 1) - 1, int(r.get("row_index") or 1) - 1)] = (
                    r.get("chinese_translation") or ""
                )
        elif isinstance(src, dict):
            for pi, part in enumerate(src.get("parts", [])):
                for ri, row in enumerate(part.get("rows", [])):
                    zh_by_pos[(pi, ri)] = row.get("chinese_translation") or ""

    rows = []
    for pi, part in enumerate(pe.get("parts", [])):
        title = part.get("title") or ""
        for ri, row in enumerate(part.get("rows", [])):
            rows.append((
                f"p{pi + 1}-r{ri + 1}",
                (row.get("pali") or "").strip(),
                zh_by_pos.get((pi, ri), ""),
                title,
            ))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chapter", default="17")
    ap.add_argument("--start", required=True, help="unit_key to start from, e.g. p1-r80")
    ap.add_argument("--end", default=None, help="unit_key to stop after (default: end of chapter)")
    ap.add_argument("--minutes", type=float, default=None, help="stop after N minutes (resumable)")
    ap.add_argument("--api-base", default=os.environ.get("SUTTA_API_BASE", DEFAULT_API))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--overwrite-human", action="store_true",
                    help="also replace sentences a person edited by hand (default: skip)")
    ap.add_argument("--progress", default=None, help="progress file (default: alongside this script)")
    ap.add_argument("--status", default=None,
                    help="live status file for the dashboard "
                         "(default: docs/research/vism-data/.retranslation-dashboard/)")
    args = ap.parse_args()

    doc_key = f"vism:{args.chapter}"
    progress_path = Path(args.progress) if args.progress else (
        ROOT / f"scripts/.retranslate-{args.chapter}-progress.json"
    )
    status_path = Path(args.status) if args.status else (
        STATUS_DIR / f"api-retranslate-vism-{args.chapter}.json"
    )

    rows = load_chapter_rows(args.chapter)
    keys = [r[0] for r in rows]
    if args.start not in keys:
        sys.exit(f"FAILED: --start {args.start} not found in {doc_key}")
    lo = keys.index(args.start)
    hi = keys.index(args.end) + 1 if args.end else len(rows)
    todo_all = [r for r in rows[lo:hi] if r[1]]

    done = set()
    if progress_path.exists():
        done = set(json.loads(progress_path.read_text(encoding="utf-8")).get("done", []))

    # Which sentences a person edited by hand - never clobber those silently.
    overlay = _request(f"{args.api_base}/api/translations?doc={doc_key}")["units"]
    human = {k for k, v in overlay.items() if v.get("source") == "human"}

    skipped_human = [r for r in todo_all if r[0] in human and not args.overwrite_human]
    todo = [r for r in todo_all
            if r[0] not in done and (args.overwrite_human or r[0] not in human)]

    print(f"chapter {args.chapter}  doc_key={doc_key}")
    print(f"  range {args.start} .. {keys[hi - 1]}   sentences with Pāli: {len(todo_all)}")
    print(f"  already done (progress file): {len(done)}")
    print(f"  hand-edited, skipping:        {len(skipped_human)}"
          + (f"  {[r[0] for r in skipped_human]}" if skipped_human else ""))
    print(f"  to translate now:             {len(todo)}")
    est = len(todo) * (SERVER_WINDOW_SECONDS / CLIENT_MAX_CALLS) / 60
    print(f"  estimated at {CLIENT_MAX_CALLS}/min: {est:.0f} min")
    if args.minutes:
        print(f"  will stop after {args.minutes:g} min (resumable)")
    if args.dry_run:
        print("\n(dry run - nothing sent)")
        return
    if not todo:
        print("\nnothing to do")
        return

    email = os.environ.get("SUTTA_API_EMAIL")
    password = os.environ.get("SUTTA_API_PASSWORD")
    if not email or not password:
        sys.exit("FAILED: set SUTTA_API_EMAIL and SUTTA_API_PASSWORD")
    token = _request(f"{args.api_base}/api/auth/login", method="POST",
                     body={"email": email, "password": password})["access_token"]

    limiter = WindowLimiter(CLIENT_MAX_CALLS, SERVER_WINDOW_SECONDS, MIN_SPACING_SECONDS)
    started = time.monotonic()
    stats = {"ok": 0, "failed": 0, "rate_limited": 0, "retried": 0}
    latencies = []
    status = StatusWriter(status_path, {
        "doc_key": doc_key, "chapter": args.chapter, "start": args.start,
        "total": len(todo), "already_done": len(done),
        "skipped_human": [r[0] for r in skipped_human],
        "client_max_calls": CLIENT_MAX_CALLS, "server_max_calls": SERVER_MAX_CALLS,
        "minutes_limit": args.minutes,
    })
    print(f"  live status -> {status_path}\n")

    stop_reason = "finished"
    for i, (unit_key, pali, _old_zh, part_title) in enumerate(todo, 1):
        if args.minutes and (time.monotonic() - started) >= args.minutes * 60:
            print(f"\n-- reached {args.minutes:g} min limit, stopping (resumable) --")
            stop_reason = "time_limit"
            break

        context = f"清净道论 第{args.chapter}品" + (f" {part_title}" if part_title else "")
        text = None
        for attempt in range(1, 5):
            limiter.wait_for_slot()
            t0 = time.monotonic()
            try:
                text = _request(f"{args.api_base}/api/mitra/translate", method="POST",
                                body={"pali": pali, "context": context}, token=token)["text"]
                latencies.append(time.monotonic() - t0)
                break
            except RateLimitError:
                stats["rate_limited"] += 1
                delay = limiter.backoff_after_429()
                print(f"  !! 429 on {unit_key} (attempt {attempt}) - backing off {delay:.1f}s")
                status.update(status="rate_limited", current_unit=unit_key,
                              rate_limited=stats["rate_limited"],
                              backoff_until=time.time() + delay)
                time.sleep(delay)
                stats["retried"] += 1
            except Exception as exc:
                print(f"  !! {unit_key} translate failed: {exc}")
                break

        if not text:
            stats["failed"] += 1
            status.update(failed=stats["failed"], current_unit=unit_key)
            continue

        try:
            _request(f"{args.api_base}/api/translations/{doc_key}/{unit_key}",
                     method="PUT", token=token,
                     body={"text": text, "reason": "Dharmamitra 重新翻译（cat-translate）",
                           "source": "dharmamitra"})
        except Exception as exc:
            print(f"  !! {unit_key} save failed: {exc}")
            stats["failed"] += 1
            status.update(failed=stats["failed"], current_unit=unit_key)
            continue

        stats["ok"] += 1
        done.add(unit_key)
        progress_path.write_text(json.dumps({"doc_key": doc_key, "done": sorted(done)},
                                            ensure_ascii=False), encoding="utf-8")

        elapsed = time.monotonic() - started
        rate = stats["ok"] / (elapsed / 60) if elapsed > 0 else 0
        status.note_done(unit_key, text, elapsed, stats, latencies,
                         remaining=len(todo) - stats["ok"] - stats["failed"])
        print(f"[{i}/{len(todo)}] {unit_key}  {elapsed / 60:5.1f}min  "
              f"{rate:4.1f}/min  429s={stats['rate_limited']}  {text[:48]}")

    elapsed = time.monotonic() - started
    remaining = len(todo) - stats["ok"] - stats["failed"]
    status.update(status="stopped" if remaining else "done",
                  stop_reason=stop_reason, current_unit=None,
                  done_count=stats["ok"], failed=stats["failed"],
                  rate_limited=stats["rate_limited"], remaining=remaining,
                  elapsed_minutes=round(elapsed / 60, 1), eta_minutes=None)

    print(f"\n{'=' * 60}")
    print(f"translated : {stats['ok']}")
    print(f"failed     : {stats['failed']}")
    print(f"RATE LIMITED (429): {stats['rate_limited']}   retries: {stats['retried']}")
    print(f"elapsed    : {elapsed / 60:.1f} min   throughput: {stats['ok'] / (elapsed / 60):.1f}/min")
    if latencies:
        print(f"translate latency: min={min(latencies):.2f}s "
              f"mean={sum(latencies) / len(latencies):.2f}s max={max(latencies):.2f}s")
    print(f"progress   : {progress_path}")
    print(f"remaining  : {len(todo) - stats['ok'] - stats['failed']}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted (progress saved, safe to re-run)")
