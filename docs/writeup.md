# ForgePilot — Technical Write-up

*TrueFoundry Forge-a-thon · Techfest 2026-27 · Repository: github.com/rokadepiyush49-rgb/TrueFoundry-Forge-a-thon*

## 1. Team

| Member | College / employer | GitHub |
|---|---|---|
| **[NAME]** | **[COLLEGE]** | @rokadepiyush49-rgb |
| **[NAME]** | **[COLLEGE]** | **[HANDLE]** |

## 2. Starting point

**From scratch.** No upstream editor project was forked. Runtime dependencies: `@truefoundry/trueforge-sdk` 0.185.0, `@modelcontextprotocol/sdk`, `diff`, `zod`. Developed against TrueForge 0.185.1 (`npx @truefoundry/trueforge@latest`, local mode).

## 3. Architecture on TrueForge

**Client, not loop.** The extension creates TrueForge sessions and sends turns through the TypeScript SDK (`sessions.create`, `createTurnStream`), renders the SSE event stream, and answers approvals (`createTurnEvents` with `user.tool_approval`). It never calls a model provider. There is one session per mode, because a new turn cancels a running one, so inline edit and agent mode never interrupt each other. Sessions use an **inline AgentSpec** built from `agents/*.agent.json`; inline specs (unlike named agents) allow `sessions.update` to change the model in place, which is how fallback keeps history.

**Editor capabilities as MCP tools.** The extension hosts a Streamable-HTTP MCP server on `127.0.0.1` behind a random bearer token, registered in TrueForge under a per-workspace name and removed on shutdown.

| Kind | Tools | Notes |
|---|---|---|
| Read-only | `retrieve_context`, `read_file` (≤250-line windows), `search_code`, `find_symbol`, `list_files`, `declare_plan` | |
| Write (approval required) | `propose_edit` (exact search/replace), `propose_new_file`, `run_command` | listed in `require_approval_for_tools` |

**Approval drives the review.** On `tool.approval_required`, ForgePilot:

1. Rebuilds the tool call from the streamed deltas.
2. Runs hard checks: every anchor must match exactly once, the Python result must parse, and every name imported from the repository must exist. A failure is **denied back to the agent with the reason and the nearest matching text**, without involving the user.
3. Turns a valid edit into a **per-hunk review**: VS Code's diff editor with Accept/Reject CodeLens, mirrored in the panel. Hunks outside the selection or the declared plan carry warnings.
4. Sends `allow` once every hunk has a decision, or `deny` if all are rejected.

The MCP handler writes **only accepted hunks**, in one write, and only for a call whose canonical arguments match a reviewed approval. An unreviewed call is refused. Every write is journaled for per-change, per-hunk and per-run undo. Undo re-anchors each hunk by its context and refuses rather than overwrite later user edits.

**Harness features used, and why.**

- **Deferred tool loading:** tools whose arguments we must review are preloaded; the rest are discovered on demand.
- **Dynamic sub-agents:** for multi-file changes, one read-only *scout* maps where comparable features are implemented, registered, tested and documented, in a clean context. The broker denies write tools from any sub-agent thread.
- **Compaction:** triggers at 40k input tokens for long runs.
- **Not used:**
  - *Code Mode and skills:* both need a sandbox, and we kept every workspace effect inside reviewed MCP calls.
  - *TrueForge's built-in HTTP retries:* set to 0 so ForgePilot decides between retry and fallback.

**Resilience.** TrueForge has no native model fallback. ForgePilot classifies each failure:

- **Transient** (network, 429, 5xx, timeout): retried with exponential backoff.
- **Permanent** (401/403 key, unknown model): not retried.

It then calls `sessions.update` to switch the **same session** to the next configured model. If edits were already applied in the failed turn, the next attempt *continues* from that turn with a summary of applied changes rather than replaying the request. Cancel aborts the stream locally and calls `sessions.cancel`; pending reviews are discarded and agent commands are killed with their process group, because TrueForge waits for in-flight MCP calls.

## 4. How context is selected

**Pipeline.**

1. Identifier-aware tokenization: `get_debug_flag` is kept whole and also split into `get`, `debug`, `flag`.
2. **BM25 over symbol-level chunks** (functions, classes, doc sections) orders the primary files.
3. Supporting evidence adds files but never reorders: definitions of identifiers named in the request, **tests and docs that share a primary file's name**, and import-graph neighbours.
4. Packing into a **budget**:
   - 6,000 tokens by default;
   - no file may take more than 25%;
   - 15% is reserved for one-line pointers;
   - code goes to the best files, pointers to the rest;
   - the most relevant file is placed last.
5. Every selected file carries its evidence, and every omission its reason (budget or relevance). Low confidence is flagged.

At the start of each agent request, an automatic **pointer pack** (paths and reasons, ≤2,500 tokens) is attached to the turn. `retrieve_context` returns code on demand. `@file:`/`@symbol:` mentions are always included. The **Context Inspector** shows each selection with badges, token cost and the budget bar.

**Evidence for the design.**

- More context is not better: SWE-bench resolution fell as retrieved context grew from 13k to 50k tokens, and Chroma's *Context Rot* study shows focused prompts beating long ones on all 18 models. Hence the budget, and code only where it is needed.
- *Agent Retrieval Bench* (arXiv:2607.24882) finds no retrieval family dominates.
- Windowed reads beat whole files in SWE-agent's ablations.

**Measured trade-off (Flask 3.1.3, 38 queries, gold files labelled by grep).**

- An early weighted-fusion ranker reached dev MRR 0.71 against BM25's 0.54, but **lost on a held-out set (0.54 vs 0.78)**. It had overfit, so we reverted to BM25 ordering.
- The shipped retriever reaches **100% recall of the files to change on dev, held-out and a fresh validation set**, using ~2% of the repository's tokens per request.
- Ranking equals BM25; the gains are evidence, companions (which bring `tests/test_cli.py` and `docs/cli.rst` for Task B) and packing. Details: `docs/evaluation.md`.

## 5. Model setup

| Role | Model | Where it ran | Approx. cost |
|---|---|---|---|
| Primary | **[provider/model]** | **[API / free tier / local]** | **[$ total]** |
| Fallback | **[provider/model]** | **[...]** | **[$]** |
| Task C broken primary | `broken/unreachable` (127.0.0.1:9) and `badkey/*` (invalid key) | local TrueForge config | $0 |
| Tests | scripted OpenAI-compatible mock | local | $0 |

To switch models:

1. Configure providers in TrueForge (UI, or `config/models.local.json` with `npm run setup:models`).
2. Run **ForgePilot: Choose Models** (or the `forgepilot.models` setting), primary first.

Nothing is provider-specific. Inline edit is tool-less, so it behaves the same on small and local models.

## 6. Scorecard

| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | **[mm:ss]** | Diff in the editor; Accept/Reject per hunk; scope guard; elision guard |
| A2 Agent mode | **[mm:ss]** | One request; scout sub-agent and retrieval find cli.py, test_cli.py, cli.rst unprompted; ≥3 files edited |
| A3 Streaming + cancellation | **[mm:ss]** | Live tokens; Stop in ~10 ms (measured); no half-applied edit; editor responsive (12 ms typing latency during streaming) |
| B1 Context assembly | **[mm:ss]** | Context Inspector: files, evidence, tokens vs 6k budget, omissions; 100% recall on 38 queries |
| B2 Diff safety | **[mm:ss]** | Per-hunk review backed by TrueForge approvals; per-hunk and per-run undo shown |
| B3 Resilience | **[mm:ss]** | Invalid key / unreachable primary → automatic same-session fallback; `git status` clean |
| B4 TrueForge depth | **[mm:ss]** | MCP tools; approvals drive review; sub-agent and deferred tools visible in the session |
| C1 Video | — | A, B, C in order, each verified on screen |
| C2 Write-up | — | This document; honest limitations |

## 7. Tools used

- **Claude Code** (Anthropic) as an AI coding assistant for research, implementation, tests and documentation.
- TrueForge 0.185.1; VS Code; Node 24, TypeScript, esbuild; vitest and `@vscode/test-electron`; Python 3.14 and pytest 8.4.2 for the task verifiers.

**Verification:**

| Suite | Size |
|---|---|
| Unit + fuzz | 76 tests, plus 3,000 randomized hunk/undo cases |
| End-to-end against a real TrueForge server and a scripted mock model | 17 scenarios |
| Inside a real VS Code extension host | 5 scenarios |
| Task verifiers (mutation-tested against 9 wrong solutions) | 3 verifiers |

## 8. Known limitations and the next month

- **Limitations:**
  - Static checks (syntax, imported-symbol existence) are Python-only.
  - Retrieval ranking is BM25's; the evaluation is 38 queries on one repository.
  - A slow third-party MCP tool can delay TrueForge's cancel.
  - VS Code may normalize line endings in open documents.
- **With another month:**
  - tree-sitter static checks for more languages;
  - a larger retrieval benchmark across repositories, to make a fair case for learned fusion;
  - running the relevant tests on a shadow copy before the user accepts;
  - checkpoints across sessions;
  - upstreaming native model fallback to TrueForge (its docs list automatic model selection as planned).
