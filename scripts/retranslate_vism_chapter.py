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

Usage (after the chapter's archived sample has been approved):
    export SUTTA_API_EMAIL=... SUTTA_API_PASSWORD=...
    python3 scripts/retranslate_vism_chapter.py --chapter 17 --mode retranslate-dharmamitra
    python3 scripts/retranslate_vism_chapter.py --chapter 17 --mode fill-gaps \
        --minutes 15                      # stop after 15 minutes, resumable
    python3 scripts/retranslate_vism_chapter.py --chapter 1 --mode retranslate-dharmamitra --limit 20 \
        --dry-run                         # translate nothing, just plan
"""

import argparse
import json
import os
import re
import signal
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

# How many times the whole set of failed sentences is retried after the main
# pass. Failures here are transient (upstream 5xx, dropped connection); a
# sentence that fails three separate passes minutes apart is reported rather
# than retried forever, so the queue can move on to the next chapter.
RETRY_ROUNDS = 3

# Sentences per Dharmamitra call. The binding constraint on this whole job is
# *requests*, not sentences: Dharmamitra's quota cuts off after roughly 250
# calls regardless of how much text each carried. Batching is therefore worth
# far more than pacing - at 20/call the remaining ~8600 sentences need ~430
# requests instead of 8600.
#
# Measured before choosing 20: batches of 2/5/10/15/20/30/40 all returned
# correctly numbered output, and the 20 *longest* sentences in ch17 (8381
# chars in one call) came back complete in 12.6s. 40 works, but a larger
# batch means a larger blast radius when one has to be redone, and batch
# output is already ~10% terser than solo output; 20 keeps both in hand.
BATCH_SIZE = 20

# The API chooses Dharmamitra's provider-default style.  Batch requests add
# only a numbering contract server-side; this script keeps no prose-style
# instruction of its own.
STYLE_CONFIGURATION = "provider-default; batch-numbering-only"

# Dharmamitra has a hard quota behind cat-translate, separate from our own
# backend's per-minute limiter (which raises RateLimitError and is handled
# inline in translate_one). Observed directly: a run held a steady 10/min for
# ~25 minutes (~250 calls), then every call failed with an upstream
# "429 Too Many Requests" wrapped in our backend's 502 for the rest of a
# 115-minute run (897 straight failures) - a fixed per-minute backoff cannot
# see this because our own limiter never trips; the request round-trips fine
# and fails downstream of it. Recovery took at least that long: a probe run
# ~2 hours after the failures began succeeded again.
#
# Detected here as a *streak* of consecutive failures (of any kind - a quota
# cliff and a real outage look identical from this side), rather than by
# matching the exact wording of the error, so a differently-worded quota
# message or a full outage triggers the same protection. Below the streak
# threshold, an isolated failure is treated as transient (network blip, one
# bad response) and left to the ordinary retry rounds instead.
QUOTA_STREAK_THRESHOLD = 5
QUOTA_COOLDOWN_START_SECONDS = 120.0
QUOTA_COOLDOWN_MAX_SECONDS = 1800.0  # 30 min ceiling; keeps a chapter resumable
                                      # within one dashboard poll cycle's worth
                                      # of patience rather than sleeping for hours.


class RateLimitError(RuntimeError):
    pass


def _request_with_retries(*args, attempts: int = 5, **kwargs):
    """Wraps _request for the two startup calls (login, overlay fetch) that
    happen before the per-sentence loop's own retry logic exists.

    Without this, a single transient failure here - seen live: the login
    endpoint or the overlay fetch timing out while this container itself was
    mid-restart - crashed the whole process with an uncaught traceback before
    a single sentence was translated. The dashboard then recorded that as a
    hard "failed" outcome, which overstates it: nothing was actually lost
    (the next queued attempt resumes from the live overlay same as any other
    run), but the run never got the chance to try again on its own.
    """
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return _request(*args, **kwargs)
        except RateLimitError:
            raise  # handled by the caller's own pacing logic, not this
        except Exception as exc:
            last_exc = exc
            if attempt < attempts:
                delay = min(5.0 * attempt, 30.0)
                print(f"  !! startup request failed (attempt {attempt}/{attempts}), "
                      f"retrying in {delay:.0f}s: {exc}")
                time.sleep(delay)
    raise last_exc


# Set by SIGTERM so a pause finishes the sentence in flight and then stops at a
# clean boundary. Killing mid-request would leave a translation paid for but
# never saved, and a status file still claiming the run is live.
_stop_requested = False


def _request_stop(_signum, _frame) -> None:
    global _stop_requested
    _stop_requested = True
    print("\n-- stop requested, finishing current sentence then exiting --", flush=True)


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


def select_rows(rows, overlay: dict, mode: str, limit: int | None = None):
    """Select work from the current production overlay, never from progress.

    Returning the intermediate selection makes the safety contract testable:
    a human row is never selected, and `retranslate-dharmamitra` is exactly
    the currently-machine-translated subset rather than a stale local idea of
    what a prior run may have written.
    """
    human = {key for key, value in overlay.items() if value.get("source") == "human"}
    if mode == "fill-gaps":
        translated = {key for key, value in overlay.items() if (value.get("current_text") or "").strip()}
        translated |= {row[0] for row in rows if (row[2] or "").strip()}
        todo_all = [row for row in rows if row[1] and row[0] not in translated]
        span = f"whole chapter, gaps only ({len(translated)} already translated)"
    elif mode == "not-dharmamitra":
        done_by_dharmamitra = {key for key, value in overlay.items() if value.get("source") == "dharmamitra"}
        todo_all = [row for row in rows if row[1] and row[0] not in done_by_dharmamitra]
        span = f"whole chapter, not yet Dharmamitra-translated ({len(done_by_dharmamitra)} already are)"
    elif mode == "retranslate-dharmamitra":
        done_by_dharmamitra = {
            key for key, value in overlay.items()
            if value.get("source") == "dharmamitra" and (value.get("current_text") or "").strip()
        }
        todo_all = [row for row in rows if row[1] and row[0] in done_by_dharmamitra]
        span = f"whole chapter, current Dharmamitra rows ({len(done_by_dharmamitra)} selected)"
    else:
        raise ValueError(f"unknown mode: {mode}")
    skipped_human = [row for row in todo_all if row[0] in human]
    todo = [row for row in todo_all if row[0] not in human]
    return todo_all, todo[:limit] if limit is not None else todo, skipped_human, span


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chapter", default="17")
    ap.add_argument("--mode", required=True,
                    choices=("fill-gaps", "not-dharmamitra", "retranslate-dharmamitra"),
                    help="fill missing rows, replace non-machine rows, or retranslate only "
                         "current source=dharmamitra rows")
    ap.add_argument("--batch-size", type=int, default=BATCH_SIZE,
                    help=f"sentences per Dharmamitra call (default {BATCH_SIZE}; 1 disables "
                         f"batching). A batch is only written if it comes back complete and "
                         f"correctly numbered, otherwise its sentences are redone one by one.")
    ap.add_argument("--limit", type=int, default=None,
                    help="process at most N selected rows (use 20 for the chapter-1 pilot)")
    ap.add_argument("--minutes", type=float, default=None, help="stop after N minutes (resumable)")
    ap.add_argument("--api-base", default=os.environ.get("SUTTA_API_BASE", DEFAULT_API))
    ap.add_argument("--dry-run", action="store_true")
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

    if args.limit is not None and args.limit < 1:
        sys.exit("FAILED: --limit must be at least 1")

    rows = load_chapter_rows(args.chapter)

    overlay = _request_with_retries(f"{args.api_base}/api/translations?doc={doc_key}")["units"]
    todo_all, todo, skipped_human, span = select_rows(rows, overlay, args.mode, args.limit)

    done = set()
    if progress_path.exists():
        done = set(json.loads(progress_path.read_text(encoding="utf-8")).get("done", []))

    # The live-overlay modes deliberately ignore the progress file when choosing work:
    # `todo_all` is already derived from the live overlay, which is the only
    # authority on what actually got stored. Trusting the progress file on top
    # of it can permanently skip a sentence whose write was acknowledged but
    # lost - which really happened here, when a PUT was accepted by a replica
    # being drained during a deploy. The overlay says untranslated, the
    # progress file says done, and the sentence is never revisited.
    # --not-dharmamitra and --retranslate-dharmamitra share --fill-gaps's reasoning for bypassing the
    # progress file: its own "already done" check is a fresh read of the live
    # overlay every run, which is the only authority a lost write cannot fool.

    print(f"chapter {args.chapter}  doc_key={doc_key}")
    print(f"  range {span}   sentences with Pāli: {len(todo_all)}")
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
    token = _request_with_retries(f"{args.api_base}/api/auth/login", method="POST",
                     body={"email": email, "password": password})["access_token"]

    limiter = WindowLimiter(CLIENT_MAX_CALLS, SERVER_WINDOW_SECONDS, MIN_SPACING_SECONDS)
    started = time.monotonic()
    stats = {"ok": 0, "failed": 0, "rate_limited": 0, "retried": 0,
             "batched": 0, "batch_rejected": 0}
    latencies = []
    status = StatusWriter(status_path, {
        "doc_key": doc_key, "chapter": args.chapter,
        "mode": args.mode, "style_configuration": STYLE_CONFIGURATION,
        "limit": args.limit,
        "total": len(todo), "already_done": len(done),
        "skipped_human": [r[0] for r in skipped_human],
        "client_max_calls": CLIENT_MAX_CALLS, "server_max_calls": SERVER_MAX_CALLS,
        "minutes_limit": args.minutes,
    })
    print(f"  live status -> {status_path}\n")

    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    def out_of_time() -> bool:
        if _stop_requested:
            return True
        return bool(args.minutes) and (time.monotonic() - started) >= args.minutes * 60

    def save_one(unit_key, text, label) -> bool:
        try:
            _request(f"{args.api_base}/api/translations/{doc_key}/{unit_key}",
                     method="PUT", token=token,
                     body={"text": text, "reason": "Dharmamitra 默认模式现代汉语重译",
                           "source": "dharmamitra"})
        except Exception as exc:
            print(f"  !! {label} {unit_key} save failed: {exc}")
            return False
        stats["ok"] += 1
        done.add(unit_key)
        progress_path.write_text(json.dumps({"doc_key": doc_key, "done": sorted(done)},
                                            ensure_ascii=False), encoding="utf-8")
        return True

    def parse_batch(out: str, n: int) -> dict:
        """Pull `n` numbered translations out of one batch response.

        Results are keyed on the number the model *returned*, never on line
        order, so a response that comes back reordered still lands on the
        right sentence. Only genuinely wrong numbering is unrecoverable, and
        the caller rejects the whole batch in that case.
        """
        found: dict[int, str] = {}
        for line in out.splitlines():
            m = re.match(r"\s*(\d+)\s*[.、)．]\s*(.+)", line)
            if not m:
                continue
            idx = int(m.group(1))
            body = m.group(2).strip()
            # First occurrence wins: a duplicate number means the model
            # emitted something we cannot attribute, and silently taking the
            # later one could overwrite a correct line with a wrong one.
            if 1 <= idx <= n and idx not in found and body:
                found[idx] = body
        return found

    def translate_batch(chunk, label) -> bool:
        """Translate up to BATCH_SIZE sentences in one call.

        Returns True only if every sentence in the chunk was translated and
        saved. Anything less and the caller falls back to one-at-a-time, so a
        malformed batch costs time but can never put a translation on the
        wrong sentence.
        """
        payload = "\n".join(f"{i}. {pali}" for i, (_k, pali, _z, _t) in enumerate(chunk, 1))
        titles = {t for (_k, _p, _z, t) in chunk if t}
        context = f"清净道论 第{args.chapter}品" + (f" {sorted(titles)[0]}" if len(titles) == 1 else "")
        for attempt in range(1, 5):
            limiter.wait_for_slot()
            t0 = time.monotonic()
            try:
                out = _request(f"{args.api_base}/api/mitra/translate", method="POST",
                               body={"pali": payload, "context": context, "batch": True},
                               token=token)["text"]
                latencies.append(time.monotonic() - t0)
            except RateLimitError:
                stats["rate_limited"] += 1
                delay = limiter.backoff_after_429()
                print(f"  !! 429 on batch of {len(chunk)} (attempt {attempt}) - backing off {delay:.1f}s")
                status.update(status="rate_limited", rate_limited=stats["rate_limited"],
                              backoff_until=time.time() + delay)
                time.sleep(delay)
                stats["retried"] += 1
                continue
            except Exception as exc:
                # Falling back to one-by-one costs len(chunk) requests instead
                # of 1, so a transient upstream hiccup must not trigger it -
                # that would spend *more* of the very quota that is scarce.
                # Retry the batch itself a few times first; only a batch that
                # keeps failing is worth breaking apart.
                if attempt < 3:
                    delay = 15.0 * attempt
                    print(f"  !! {label} batch of {len(chunk)} failed "
                          f"(attempt {attempt}), retrying in {delay:.0f}s: {exc}")
                    status.update(status="batch_retry", backoff_until=time.time() + delay)
                    time.sleep(delay)
                    continue
                print(f"  !! {label} batch of {len(chunk)} failed {attempt}x, "
                      f"falling back to one-by-one: {exc}")
                return False

            got = parse_batch(out, len(chunk))
            if len(got) != len(chunk):
                missing = sorted(set(range(1, len(chunk) + 1)) - set(got))
                print(f"  !! {label} batch returned {len(got)}/{len(chunk)} "
                      f"(missing {missing[:6]}) - falling back to one-by-one")
                stats["batch_rejected"] += 1
                return False

            for i, (unit_key, _pali, _zh, _title) in enumerate(chunk, 1):
                if not save_one(unit_key, got[i], label):
                    return False
            stats["batched"] += len(chunk)
            return True
        return False

    def translate_one(unit_key, pali, part_title, label):
        """Translate and save one sentence. Returns the text, or None on
        failure. 429s are retried inline here (they are a pacing problem, and
        the backoff is computed from our own window); anything else returns
        None and is left for the retry rounds below, since a transient network
        or 5xx error deserves a fresh attempt later rather than a tight loop
        against a service that is already unhappy."""
        context = f"清净道论 第{args.chapter}品" + (f" {part_title}" if part_title else "")
        for attempt in range(1, 5):
            limiter.wait_for_slot()
            t0 = time.monotonic()
            try:
                text = _request(f"{args.api_base}/api/mitra/translate", method="POST",
                                body={"pali": pali, "context": context}, token=token)["text"]
                latencies.append(time.monotonic() - t0)
            except RateLimitError:
                stats["rate_limited"] += 1
                delay = limiter.backoff_after_429()
                print(f"  !! 429 on {unit_key} (attempt {attempt}) - backing off {delay:.1f}s")
                status.update(status="rate_limited", current_unit=unit_key,
                              rate_limited=stats["rate_limited"],
                              backoff_until=time.time() + delay)
                time.sleep(delay)
                stats["retried"] += 1
                continue
            except Exception as exc:
                print(f"  !! {label} {unit_key} translate failed: {exc}")
                return None

            return text if save_one(unit_key, text, label) else None
        return None

    stop_reason = "finished"
    pending_retry: list = []
    consecutive_failures = 0
    cooldown_seconds = QUOTA_COOLDOWN_START_SECONDS

    def attempt(unit_key, pali, part_title, label):
        """translate_one, plus quota-cliff detection shared by the main pass
        and the retry rounds. A streak of failures past the threshold pauses
        for an escalating cooldown before the *next* attempt (of any
        sentence) rather than immediately hammering on - see the constants'
        docstring for why a fixed per-minute backoff cannot catch this."""
        nonlocal consecutive_failures, cooldown_seconds
        text = translate_one(unit_key, pali, part_title, label)
        if text is not None:
            consecutive_failures = 0
            cooldown_seconds = QUOTA_COOLDOWN_START_SECONDS
            return text

        consecutive_failures += 1
        if consecutive_failures >= QUOTA_STREAK_THRESHOLD:
            print(f"\n  !! {consecutive_failures} failures in a row - this looks like "
                  f"Dharmamitra's own quota, not a transient error. "
                  f"Cooling down {cooldown_seconds:.0f}s before continuing.")
            status.update(status="quota_cooldown", consecutive_failures=consecutive_failures,
                          cooldown_seconds=cooldown_seconds,
                          cooldown_until=time.time() + cooldown_seconds)
            slept = 0.0
            while slept < cooldown_seconds and not out_of_time():
                step = min(5.0, cooldown_seconds - slept)
                time.sleep(step)
                slept += step
            consecutive_failures = 0
            cooldown_seconds = min(cooldown_seconds * 2, QUOTA_COOLDOWN_MAX_SECONDS)
        return None

    done_before = stats["ok"]
    position = 0
    while position < len(todo):
        if out_of_time():
            stop_reason = "stopped" if _stop_requested else "time_limit"
            why = "stop requested" if _stop_requested else f"reached {args.minutes:g} min limit"
            print(f"\n-- {why}, stopping (resumable) --")
            break

        chunk = todo[position:position + args.batch_size]
        position += len(chunk)

        # One request for the whole chunk. Only if it comes back complete and
        # correctly numbered is any of it written; otherwise every sentence in
        # it is redone individually, so a bad batch costs requests, never
        # correctness.
        if len(chunk) > 1 and translate_batch(chunk, ""):
            elapsed = time.monotonic() - started
            rate = stats["ok"] / (elapsed / 60) if elapsed > 0 else 0
            last_key, _p, _z, _t = chunk[-1]
            status.note_done(last_key, f"[批次 {len(chunk)} 句]", elapsed, stats, latencies,
                             remaining=len(todo) - (stats["ok"] - done_before) - len(pending_retry))
            print(f"[{position}/{len(todo)}] batch x{len(chunk)} -> {last_key}  "
                  f"{elapsed / 60:5.1f}min  {rate:4.1f}/min  429s={stats['rate_limited']}")
            consecutive_failures = 0
            continue

        chunk_start = position - len(chunk)
        for offset, (unit_key, pali, old_zh, part_title) in enumerate(chunk, 1):
            if out_of_time():
                stop_reason = "stopped" if _stop_requested else "time_limit"
                break
            text = attempt(unit_key, pali, part_title, "")
            if text is None:
                pending_retry.append((unit_key, pali, old_zh, part_title))
                status.update(status="running", failed=len(pending_retry), current_unit=unit_key)
                continue
            elapsed = time.monotonic() - started
            rate = stats["ok"] / (elapsed / 60) if elapsed > 0 else 0
            status.note_done(unit_key, text, elapsed, stats, latencies,
                             remaining=len(todo) - (stats["ok"] - done_before) - len(pending_retry))
            print(f"[{chunk_start + offset}/{len(todo)}] {unit_key}  {elapsed / 60:5.1f}min  "
                  f"{rate:4.1f}/min  429s={stats['rate_limited']}  {text[:48]}")

    # Retry rounds. Failures are usually transient (a 5xx from the upstream
    # model, a dropped connection), so they are retried after the main pass
    # rather than immediately - by then the condition that caused them has
    # usually cleared, and the sentence is not blocking the rest of the run.
    # The same quota-cliff cooldown in attempt() applies here too: a chapter
    # that hit the cliff near its end arrives at these rounds still owing
    # the cooldown, not free of it.
    for round_no in range(1, RETRY_ROUNDS + 1):
        if not pending_retry or out_of_time():
            break
        batch, pending_retry = pending_retry, []
        print(f"\n-- retry round {round_no}/{RETRY_ROUNDS}: {len(batch)} sentence(s) --")
        status.update(status="retrying", retry_round=round_no, retry_pending=len(batch))
        for unit_key, pali, old_zh, part_title in batch:
            if out_of_time():
                pending_retry.append((unit_key, pali, old_zh, part_title))
                stop_reason = "time_limit"
                continue
            text = attempt(unit_key, pali, part_title, f"[retry{round_no}]")
            if text is None:
                pending_retry.append((unit_key, pali, old_zh, part_title))
            else:
                print(f"  ok on retry: {unit_key}  {text[:48]}")
                status.note_done(unit_key, text, time.monotonic() - started, stats,
                                 latencies, remaining=len(pending_retry))

    stats["failed"] = len(pending_retry)
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
