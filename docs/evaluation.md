# Evaluation

This page records how ForgePilot's components were measured, including the
results that did not go our way. Everything here can be reproduced from a
clean clone.

## Context retrieval

**Question.** Given a natural-language change request, does the context pack
contain every file that has to change, inside a fixed token budget?

**Setup.** `pallets/flask` at tag `3.1.3` (commit `22d92470`): 217 indexed
files, 1,331 symbol-level chunks, ~300k tokens. Budget 6,000 tokens per
request (about 2% of the repository). Gold files were labelled by grepping
the source for where each change must land, before running the retriever.

```bash
npx tsx test/eval/retrieval.eval.ts /path/to/flask-3.1.3              # dev set (14)
npx tsx test/eval/retrieval.eval.ts /path/to/flask-3.1.3 --heldout    # held-out (12)
npx tsx test/eval/retrieval.eval.ts /path/to/flask-3.1.3 --validation # validation (12)
```

Metrics: **recall** = share of gold files present in the pack; **hit@k** /
**MRR** = position of the primary file. The BM25 baseline is the same index
ranked by BM25 alone, cut to the same number of files (and, unlike ours,
without a token budget).

### What happened

| Step | Design | Dev recall / MRR | Held-out recall / MRR | BM25 on same set |
|---|---|---|---|---|
| 1 | Equal-weight reciprocal rank fusion of 5 signals | 82% / 0.63 | – | 90% / 0.54 |
| 2 | Weighted fusion + per-file budget cap | 100% / 0.71 | **92% / 0.54** | held-out **100% / 0.78** |
| 3 | BM25 orders primaries; other signals only add/explain | 88% / 0.53 | 100% / 0.78 | 100% / 0.78 |
| 4 | + path field weight ×3 (judged on a fresh validation set) | – | – | no change (0.67 → 0.68), reverted |
| 5 | + 15% of budget reserved for one-line pointers | 100% / 0.53 | 100% / 0.78 | validation 100% / 0.69 |
| 6 | + supporting evidence sets a score floor (unit-test bug) | **100% / 0.55** | **100% / 0.78** | validation **100% / 0.69** |

**The honest reading.** Weighted fusion looked like a clear win on the set we
designed it on (MRR 0.71 vs 0.54) and then lost to plain BM25 on queries it
had never seen (0.54 vs 0.78). It had overfit. This matches the literature:
lexical retrieval is a strong baseline for code localization (SWE-bench,
Agentless), and *Agent Retrieval Bench* (arXiv:2607.24882) finds that no
single retrieval family dominates across tasks.

So the shipped retriever does **not** claim to rank better than BM25. Its job
is different:

1. **Every needed file is in the pack** — 100% recall on all 38 queries at a
   6,000-token budget, using ~2% of the repository's tokens.
2. **Supporting files are added on purpose**: definitions of identifiers named
   in the request, tests and docs that share a name with a primary file, and
   import-graph neighbours. For Task B this is what brings in
   `tests/test_cli.py` and `docs/cli.rst` alongside `src/flask/cli.py`.
3. **Every choice is explained** (lexical terms matched, symbol defined, path,
   companion, import edge), and every omission says why (budget, relevance).
4. **Depth and breadth**: code for the best files, one-line pointers for the
   rest, so the agent knows a candidate exists and can `read_file` it.

### The automatic context card (pointer mode)

At the start of every agent request ForgePilot attaches a pointer-only pack
(paths and evidence, no code). Evaluated separately with
`--pointers` (budget 2,500):

| Pointers | Dev recall | Held-out recall | Validation recall |
|---|---|---|---|
| 10 | 89% | 96% | 92% |
| 16 | 98% | 100% | 100% |
| **20 (shipped)** | **100%** | **100%** | **100%** |

With 10 pointers Task B's `src/flask/cli.py` fell off the card during a
real-model rehearsal; 20 pointers cost about 500 tokens.

### Threats to validity

* 38 queries on one repository, labelled by us. Treat the numbers as a sanity
  check, not a benchmark.
* The dev and held-out sets have both been seen now; only the validation set
  was written before the final change it judged.

## Diff engine

* 28 example-based unit tests plus a deterministic fuzz test: 3,000 random
  files × random edits × random accept/reject subsets × random per-hunk undo.
* The fuzz test found two real bugs on its first run, both fixed with
  regression tests:
  1. Line endings were normalized to the file's dominant style, so rejecting
     every hunk in a mixed CRLF/LF file still changed bytes.
  2. `applySearchReplace` rewrote every line ending in a file containing any
     CRLF, touching lines the edit never targeted.
