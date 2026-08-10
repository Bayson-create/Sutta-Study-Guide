# Graph Report - /Users/xiebeichen/Downloads/Sutta-Study-Guide  (2026-08-06)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 6 nodes · 9 edges · 1 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `03098ef9`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0

## God Nodes (most connected - your core abstractions)
1. `parse_markdown()` - 5 edges
2. `extract_uid_from_url()` - 2 edges
3. `extract_link_url()` - 2 edges
4. `parse_table_row()` - 2 edges
5. `main()` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (1 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.60
Nodes (5): extract_link_url(), extract_uid_from_url(), main(), parse_markdown(), parse_table_row()

## Suggested Questions
_Not enough signal to generate questions. This usually means the corpus has no AMBIGUOUS edges, no bridge nodes, no INFERRED relationships, and all communities are tightly cohesive. Add more files or run with --mode deep to extract richer edges._