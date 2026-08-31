#!/usr/bin/env python3
"""Build the small first-screen overview subgraph for the knowledge-graph page.

The published concept-graph-v2 dataset is sharded for per-concept access: the
browser can afford one ~400KB shard when a reader selects a concept, but the
landing view needs a whole graph before anyone has clicked anything.  This
script fetches the shards once, keeps the induced subgraph over the busiest
concepts, and writes a single small file that ships with the site instead of
from Blob storage - same origin, same deploy, no credentials.

Re-run only when concept-graph-v2 itself is rebuilt.
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import pathlib
import sys
import urllib.request

DEFAULT_ROOT = (
    "https://suttastudyguidestor.blob.core.windows.net/tipitaka-public"
    "/tipitaka/v1/concept-graph-v2"
)
NODE_FIELDS = (
    "concept_id", "pali", "label_zh", "label_en", "concept_type",
    "document_frequency", "parent_work_count",
)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=180) as response:
        return response.read()


def fetch_json(url: str) -> object:
    data = fetch(url)
    if len(data) > 2 and data[0] == 0x1F and data[1] == 0x8B:
        data = gzip.decompress(data)
    return json.loads(data)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--top", type=int, default=180, help="concepts to keep")
    ap.add_argument("--min-degree", type=int, default=3,
                    help="weakest edges kept per concept so none is stranded")
    ap.add_argument("--edges-per-node", type=int, default=6,
                    help="strongest edges kept per concept; the induced subgraph "
                         "over the busiest concepts is ~58%% dense and unreadable")
    ap.add_argument("--output", type=pathlib.Path,
                    default=pathlib.Path("docs/data/concept-graph-overview.json.gz"))
    args = ap.parse_args()

    root = args.root.rstrip("/")
    print(f"manifest…", file=sys.stderr)
    manifest = fetch_json(f"{root}/manifest.json")
    print("concepts…", file=sys.stderr)
    concepts = fetch_json(f"{root}/concepts.json.gz")

    ranked = sorted(
        concepts,
        key=lambda c: (
            -int(c.get("parent_work_count") or 0),
            -int(c.get("document_frequency") or 0),
            str(c.get("concept_id")),
        ),
    )[: args.top]
    keep = {str(c["concept_id"]) for c in ranked}
    print(f"kept {len(keep)} concepts", file=sys.stderr)

    index = fetch_json(f"{root}/adjacency/index.json.gz")
    shards = index.get("shards") or {}
    wanted = sorted({shards[cid] for cid in keep if cid in shards})
    print(f"fetching {len(wanted)} adjacency shards…", file=sys.stderr)

    # An undirected edge shows up once under each endpoint; dedupe on the pair.
    best: dict[tuple[str, str], dict] = {}
    per_concept: dict[str, list[dict]] = collections.defaultdict(list)
    for position, shard in enumerate(wanted, 1):
        payload = fetch_json(f"{root}/adjacency/{shard}.json.gz")
        for cid in keep & payload.keys():
            for row in payload[cid]:
                source, target = str(row.get("source")), str(row.get("target"))
                edge = {
                    "source": source,
                    "target": target,
                    "relation_type": row.get("relation_type"),
                    "weight_score": round(float(row.get("weight_score") or 0), 4),
                    "direction": row.get("direction") or "undirected",
                }
                per_concept[cid].append(edge)
                if target in keep and source in keep:
                    key = tuple(sorted((source, target)))
                    if edge["weight_score"] > best.get(key, {}).get("weight_score", -1):
                        best[key] = edge
        print(f"  {position}/{len(wanted)} {shard} · {len(best)} edges",
              file=sys.stderr)

    # Nothing should be an isolated dot: give every concept its strongest few
    # edges back even when the other endpoint fell outside the top slice.
    for cid, rows in per_concept.items():
        inside = [e for e in rows if e["source"] in keep and e["target"] in keep]
        inside.sort(key=lambda e: -e["weight_score"])
        for edge in inside[: args.min_degree]:
            key = tuple(sorted((edge["source"], edge["target"])))
            best.setdefault(key, edge)

    # The induced subgraph over the busiest concepts is nearly complete, which
    # draws as a solid disc.  Keep each concept's strongest few links and take
    # the union - a symmetric k-nearest-neighbour backbone that preserves the
    # cluster structure while staying legible.
    by_concept: dict[str, list[dict]] = collections.defaultdict(list)
    for edge in best.values():
        by_concept[edge["source"]].append(edge)
        by_concept[edge["target"]].append(edge)
    backbone: dict[tuple[str, str], dict] = {}
    for rows in by_concept.values():
        rows.sort(key=lambda e: -e["weight_score"])
        for edge in rows[: args.edges_per_node]:
            backbone[tuple(sorted((edge["source"], edge["target"])))] = edge

    edges = sorted(backbone.values(), key=lambda e: (-e["weight_score"], e["source"], e["target"]))
    nodes = [{field: c.get(field) for field in NODE_FIELDS} for c in ranked]
    payload = {
        "format": "concept-graph-overview/1",
        "generated_from": manifest.get("build_id") or manifest.get("version"),
        "source_root": root,
        "counts": {"nodes": len(nodes), "edges": len(edges),
                   "canonical_concepts": (manifest.get("counts") or {}).get("canonical_concepts")},
        "relation_types": sorted({e["relation_type"] for e in edges if e["relation_type"]}),
        "nodes": nodes,
        "edges": edges,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    args.output.write_bytes(gzip.compress(blob, 9, mtime=0))
    print(f"wrote {args.output} · {len(nodes)} nodes · {len(edges)} edges · "
          f"{args.output.stat().st_size / 1024:.1f}KB gz", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
