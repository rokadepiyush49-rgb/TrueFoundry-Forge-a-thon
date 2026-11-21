# Demo video script (≤ 4:00)

The brief requires Tasks A, B and C in that order, each followed by its on-screen verification, with the TrueForge session shown briefly during Task B. You may cut model waiting time, but never between giving an instruction and the diff appearing. Each rubric line should be visibly earned at a known timestamp; write the timestamps into the write-up scorecard.

## Before recording

```bash
# terminal 1 (keep running, off-screen)
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' MODEL_HTTP_MAX_RETRIES=0 npx @truefoundry/trueforge@latest

# terminal 2: register real providers + the Task C broken ones
npm run setup:models -- --broken-primary

# Flask checkout, pristine
cd flask-3.1.3 && git checkout -q 3.1.3 && git status   # must be clean
```

- Open `flask-3.1.3` in VS Code with ForgePilot installed. Use a large font (zoom 2×) so the video is legible.
- **ForgePilot: Choose Models** → working models only, e.g. `openai/mini` → `gemini/flash`.
- Open the ForgePilot panel; open an integrated terminal using the Flask venv (`source ../venv-flask/bin/activate`).
- Rehearse each task at least 3 times with the exact wording below. Run the verifiers after each rehearsal (`test/verify/run_all.sh a|b|c`).

## Shot list

| Time | Shot | Rubric |
|---|---|---|
| 0:00–0:12 | Panel open; status bar shows primary → fallback models; `git status` clean | — |
| **Task A** | | |
| 0:12–0:20 | Open `src/flask/helpers.py`, select `get_debug_flag`, press Cmd/Ctrl+Alt+K | A1 |
| 0:20–0:35 | Paste the exact instruction; streaming progress; diff editor opens with **Accept / Reject on each hunk** | A1, A3 |
| 0:35–0:45 | Accept the hunks one by one (CodeLens) | A1, B2 |
| 0:45–0:55 | Terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` | verification |
| **Task B** | | |
| 0:55–1:05 | Agent panel: paste the exact instruction, **no files mentioned** | A2 |
| 1:05–1:35 | Context · automatic card (files + evidence + budget bar); scout **sub-agent** thread; `retrieve_context` card listing `cli.py`, `test_cli.py`, `cli.rst` with reasons; plan card | B1, B4 |
| 1:35–2:05 | Review each file's hunks (diff editor + panel), accept; the agent asks to run `pytest tests/test_cli.py -q` → Run | A2, B2 |
| 2:05–2:20 | Click **Session ↗**: TrueForge session with turns, tool calls, approvals, sub-agent | B4 (required) |
| 2:20–2:40 | Terminal: `pytest tests/test_cli.py -q` passes; `flask --app <sample app> config` shows masked JSON; `git status` shows ≥3 files | verification |
| **Bridge** | | |
| 2:40–2:52 | Panel → Applied changes → **Undo this run** → `git status` clean (all of Task B reverted atomically) | B2 undo |
| 2:52–3:05 | Send any long request, **Stop** mid-stream → "Cancelled (stopped in N ms)"; `git status` clean | A3 |
| **Task C** | | |
| 3:05–3:15 | **ForgePilot: Choose Models** → `broken/unreachable` (or `badkey/...`) first, a working model second | B3 |
| 3:15–3:40 | Repeat Task A exactly; panel shows the failure → retry → **fallback** notice; warning notification; editor stays usable (type in another file) | B3 |
| 3:40–3:55 | The fallback's diff appears → **Reject all**; terminal `git status` → no changes | verification |

A sample app for Task B's verification (outside the repo, so `git status` is unaffected):

```bash
mkdir -p /tmp/cfgdemo && cat > /tmp/cfgdemo/app.py <<'EOF'
from flask import Flask
app = Flask(__name__)
app.config.update(SECRET_KEY="dev-secret", DB_PASSWORD="hunter2", API_TOKEN="abc", GREETING="hello")
EOF
flask --app /tmp/cfgdemo/app.py config
```

## Shortlist call (repeat Task A live with an organiser-chosen model)

1. Add their provider in TrueForge (UI → Settings → Model providers), or ask them to paste the key into the TrueForge UI themselves.
2. **ForgePilot: Choose Models** → their model first.
3. Repeat Task A. Inline edit is tool-less, so it does not depend on the model's tool-calling quality.
4. Be ready to walk through:
   - `src/core/forgeCore.ts` (`runInline`)
   - `src/core/inline.ts`
   - `src/core/diff/review.ts`
   - `src/core/trueforge/runner.ts` (fallback)
   - `src/core/review/broker.ts` (approvals → review)
   - `src/mcp/tools.ts` (`proposeWriteTool` refuses unreviewed writes)
