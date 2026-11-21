/**
 * Retrieval evaluation on pallets/flask 3.1.3.
 *
 * Gold files were labelled by grepping the source for where each change must
 * land (see docs/evaluation.md). Only one query is a fixed competition task
 * (Task B, verbatim); the rest are held out so the retriever is not tuned to
 * the demo. Usage: npx tsx test/eval/retrieval.eval.ts <path-to-flask-3.1.3>
 */
import { ContextIndex } from "../../src/core/context/indexer";
import { retrieve, rankLexical } from "../../src/core/context/retrieve";

interface Case {
  q: string;
  gold: string[]; // first entry is the primary file where the edit belongs
  fixedTask?: boolean;
}

/** Development set: used while designing the fusion weights (see docs/evaluation.md). */
const DEV: Case[] = [
  {
    q: "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as \"***\". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.",
    gold: ["src/flask/cli.py", "tests/test_cli.py", "docs/cli.rst"],
    fixedTask: true,
  },
  { q: "The debug flag read from the environment should treat 'off' and 'n' as false", gold: ["src/flask/helpers.py"] },
  { q: "Let from_prefixed_env load nested config keys with a custom separator", gold: ["src/flask/config.py", "tests/test_config.py"] },
  { q: "Change the default SameSite policy of the session cookie", gold: ["src/flask/sessions.py", "src/flask/app.py"] },
  { q: "The default JSON provider should allow turning off key sorting", gold: ["src/flask/json/provider.py", "tests/test_json.py"] },
  { q: "Raise a clearer error when a blueprint name contains a dot", gold: ["src/flask/sansio/blueprints.py", "tests/test_blueprints.py"] },
  { q: "Add a helper to stream a template rendered from a string", gold: ["src/flask/templating.py"] },
  { q: "Pass the unhandled exception to teardown_appcontext callbacks", gold: ["src/flask/sansio/app.py", "src/flask/ctx.py"] },
  { q: "Respect the configured default max age for files sent with send_file", gold: ["src/flask/helpers.py", "src/flask/app.py"] },
  { q: "Support URL fragments in url_for via the _anchor argument", gold: ["src/flask/helpers.py", "src/flask/app.py"] },
  { q: "Make session_transaction in the test client work with custom session interfaces", gold: ["src/flask/testing.py", "tests/test_testing.py"] },
  { q: "Allow get_flashed_messages to filter by several categories at once", gold: ["src/flask/helpers.py"] },
  { q: "Pushing a request context should also push an application context when none is active", gold: ["src/flask/ctx.py"] },
  { q: "flask run should give a clear error when --cert is a file but --key is missing", gold: ["src/flask/cli.py", "tests/test_cli.py"] },
];

/**
 * Held-out set: written after the dev set was frozen and run once; never used
 * to change the retriever.
 */
const HELDOUT: Case[] = [
  { q: "Make flask shell run the user's PYTHONSTARTUP file before opening the console", gold: ["src/flask/cli.py"] },
  { q: "Config.from_file should be able to open files in binary mode for TOML loaders", gold: ["src/flask/config.py"] },
  { q: "Send the flash category along with the message_flashed signal", gold: ["src/flask/helpers.py", "src/flask/signals.py"] },
  { q: "Improve the type hints of the before_request decorator", gold: ["src/flask/sansio/scaffold.py"] },
  { q: "Allow a per-request override of the maximum content length", gold: ["src/flask/wrappers.py"] },
  { q: "Show a better error when the app factory raises a TypeError while being called by the CLI", gold: ["src/flask/cli.py"] },
  { q: "abort should accept a Response object and raise it directly", gold: ["src/flask/helpers.py"] },
  { q: "Load .flaskenv before .env and let .env override it", gold: ["src/flask/cli.py"] },
  { q: "stream_with_context should support async generators", gold: ["src/flask/helpers.py"] },
  { q: "Do not set the session cookie when the session was not modified and refresh is off", gold: ["src/flask/sessions.py"] },
  { q: "The CLI test runner should pass the app's script info to invoked commands", gold: ["src/flask/testing.py"] },
  { q: "Add a test_cli_runner option to disable catching exceptions", gold: ["src/flask/app.py", "src/flask/testing.py"] },
];

/**
 * Validation set: written BEFORE the BM25F path-field change was implemented,
 * to judge that single change; run once.
 */
const VALIDATION: Case[] = [
  { q: "jsonify should reject passing both positional and keyword arguments with a clearer message", gold: ["src/flask/json/__init__.py"] },
  { q: "Config.from_pyfile should mention the instance folder in its error when the file is missing", gold: ["src/flask/config.py"] },
  { q: "render_template should raise a helpful error when called outside an application context", gold: ["src/flask/templating.py"] },
  { q: "app.run should read the port from an environment variable when not given", gold: ["src/flask/app.py"] },
  { q: "make_response should accept a tuple whose headers are a list of pairs", gold: ["src/flask/app.py"] },
  { q: "The g namespace object should behave like a dict with setdefault and pop", gold: ["src/flask/ctx.py"] },
  { q: "Request.on_json_loading_failed should include the parse error message in debug mode", gold: ["src/flask/wrappers.py"] },
  { q: "Let the routes command sort by endpoint name in reverse order", gold: ["src/flask/cli.py"] },
  { q: "Support the Partitioned attribute on the session cookie", gold: ["src/flask/sessions.py", "src/flask/app.py"] },
  { q: "Blueprint static files should honour a per-blueprint cache max age", gold: ["src/flask/blueprints.py"] },
  { q: "register_error_handler should validate that the handler is callable", gold: ["src/flask/sansio/scaffold.py"] },
  { q: "Exceptions raised in a view should be passed to user error handlers before the generic handler", gold: ["src/flask/app.py"] },
];

const CASES: Case[] = process.argv.includes("--heldout") ? HELDOUT : process.argv.includes("--validation") ? VALIDATION : DEV;

function metrics(rankings: string[][]) {
  let recall = 0;
  let hit1 = 0;
  let hit3 = 0;
  let mrr = 0;
  CASES.forEach((c, i) => {
    const r = rankings[i];
    recall += c.gold.filter((g) => r.includes(g)).length / c.gold.length;
    const pos = r.indexOf(c.gold[0]);
    if (pos === 0) hit1++;
    if (pos >= 0 && pos < 3) hit3++;
    if (pos >= 0) mrr += 1 / (pos + 1);
  });
  const n = CASES.length;
  return { recall: recall / n, hit1: hit1 / n, hit3: hit3 / n, mrr: mrr / n };
}

(async () => {
  const root = process.argv[2];
  if (!root) throw new Error("usage: retrieval.eval.ts <flask-root>");
  const index = new ContextIndex(root);
  const stats = await index.build();
  const budget = Number(process.env.BUDGET || 6000);
  const hybrid: string[][] = [];
  const lexical: string[][] = [];
  let tokens = 0;
  for (const c of CASES) {
    const rep = retrieve(index, c.q, { budget });
    const ordered = [...rep.selected].sort((a, b) => b.score - a.score).map((s) => s.path);
    hybrid.push(ordered);
    tokens += rep.used;
    lexical.push(rankLexical(index, c.q, ordered.length || 12));
    const missing = c.gold.filter((g) => !ordered.includes(g));
    console.log(
      `${c.fixedTask ? "[task B] " : ""}${c.q.slice(0, 70)}…\n   primary rank: ${ordered.indexOf(c.gold[0]) + 1 || "MISS"}  ` +
        `bm25 rank: ${lexical[lexical.length - 1].indexOf(c.gold[0]) + 1 || "MISS"}  used ${rep.used}/${budget} tok` +
        (missing.length ? `  missing: ${missing.join(", ")}` : ""),
    );
  }
  const h = metrics(hybrid);
  const l = metrics(lexical);
  const fmt = (x: number) => (100 * x).toFixed(0).padStart(4) + "%";
  console.log(`\nIndex: ${stats.files} files, ${stats.chunks} chunks, ~${stats.tokens} tokens, built in ${stats.ms} ms`);
  console.log(`Budget ${budget} tokens; mean context used ${(tokens / CASES.length).toFixed(0)} tokens (${((100 * tokens) / CASES.length / stats.tokens).toFixed(1)}% of repo)`);
  console.log("                 recall  hit@1  hit@3   MRR");
  console.log(`hybrid (ours)    ${fmt(h.recall)} ${fmt(h.hit1)} ${fmt(h.hit3)}  ${h.mrr.toFixed(2)}`);
  console.log(`BM25 only        ${fmt(l.recall)} ${fmt(l.hit1)} ${fmt(l.hit3)}  ${l.mrr.toFixed(2)}`);
})();
