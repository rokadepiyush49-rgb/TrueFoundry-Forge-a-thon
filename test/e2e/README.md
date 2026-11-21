# End-to-end tests

These tests drive the real ForgePilot core (MCP server, approval broker, turn
runner) against a **real TrueForge server** and a scripted OpenAI-compatible
mock model (`mockModel.ts`), so behaviour is deterministic and free to run.

```bash
# terminal 1: TrueForge must be allowed to reach the local MCP server and mock model
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' MODEL_HTTP_MAX_RETRIES=0 npx @truefoundry/trueforge@latest

# terminal 2
npm run test:e2e
```

The suite registers a `mock` model provider in TrueForge and uses a throwaway
git repository; `git status --porcelain` is the oracle for "workspace
unchanged", exactly as in Task C.

| Scenario | What it proves |
|---|---|
| per-hunk accept/reject | only accepted hunks reach disk; the agent is told which were rejected |
| missing anchor | an edit to code that does not exist is denied before the user sees it |
| hallucinated import | an edit importing a non-existent project symbol is denied |
| unapproved / unauthenticated MCP call | nothing is written without review; the MCP server requires its token |
| transient failure | retry with backoff, then fallback to the next model on the **same session** |
| auth failure | permanent errors are not retried |
| all models fail | clear error, `git status` clean |
| mid-run failure | fallback continues the task without redoing applied edits |
| cancel while streaming | no tokens after cancel, latency < 1 s, `git status` clean |
| cancel during review | the open review is discarded, nothing written |
| cancel during a command | the process group is killed |
| inline edit | tool-less rewrite of the selection, reviewed, undoable |
| lazy inline reply | elided code ("... rest unchanged") is refused |
