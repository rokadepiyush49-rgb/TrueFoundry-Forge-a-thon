/**
 * Rehearse a fixed task with REAL models through ForgePilot's real core
 * (TrueForge sessions, MCP tools, approval broker, hunk review, journal),
 * without the VS Code UI. Every hunk is auto-accepted and logged; only
 * pytest/flask commands are allowed. Afterwards the task verifier runs.
 *
 *   npx tsx test/rehearse/runTask.ts a|b <flask-dir> <model> [fallback...]
 *   env: VERIFY_PYTHON=<venv python> to run the verifier, KEEP=1 to keep changes
 */
import * as path from "path";
import { readFileSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { ForgeCore, CoreEvent } from "../../src/core/forgeCore";
import { NodeFilePort } from "../../src/core/nodeHost";
import { AgentDefinition } from "../../src/core/trueforge/spec";

const TASK_A =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

const [task, flaskDir, ...models] = process.argv.slice(2);
if (!task || !flaskDir || !models.length) {
  console.error("usage: runTask.ts a|b <flask-dir> <model> [fallback...]");
  process.exit(2);
}
const root = path.resolve(flaskDir);
const here = path.resolve(__dirname, "../..");
const def = (f: string): AgentDefinition => JSON.parse(readFileSync(path.join(here, "agents", f), "utf8"));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
let text = "";

const core = new ForgeCore({
  root,
  serverUrl: process.env.TRUEFORGE_URL || "http://localhost:8790",
  models: () => models,
  retry: () => ({ maxAttempts: 2, baseDelayMs: 600 }),
  budget: () => Number(process.env.BUDGET || 6000),
  modelParams: () => JSON.parse(process.env.MODEL_PARAMS || '{"groq/gpt-oss-120b":{"reasoning_format":"hidden"}}'),
  fs: new NodeFilePort(),
  agentDef: def("forgepilot.agent.json"),
  inlineDef: def("inline-edit.agent.json"),
  ui: {
    showReview: (p) => {
      console.log(`${stamp()} REVIEW ${p.relPath}: ${p.hunks.length} hunk(s)`);
      for (const h of p.hunks) {
        const w = p.hunkWarnings.get(h.id);
        console.log(`         hunk ${h.id + 1} @${h.oldIndex + 1}: -${h.oldLines.length} +${h.newLines.length}${w ? `  ⚠ ${w.join("; ")}` : ""}`);
        for (const l of h.oldLines.slice(0, 6)) console.log(`           - ${l}`);
        for (const l of h.newLines.slice(0, 12)) console.log(`           + ${l}`);
      }
      setTimeout(() => core.review.decideAll(p.id, "accepted"), 10);
    },
    confirmCommand: async (c) => {
      // like a user approving test runs: any pytest/flask invocation
      const ok = /(^|[\s;&|])(\S*python\S*\s+-m\s+)?(pytest|flask)\b/.test(c.trim()) && !/\brm\b|>\s*\//.test(c);
      console.log(`${stamp()} COMMAND ${ok ? "allowed" : "DENIED"}: ${c}`);
      return ok;
    },
    rejectionFeedback: () => undefined,
    emit: (e: CoreEvent) => {
      switch (e.type) {
        case "text":
          if (e.threadId === "main") text += e.delta;
          break;
        case "tool":
          console.log(`${stamp()} TOOL[${e.call.threadId === "main" ? "main" : "sub"}] ${e.call.name} ${e.call.argsJson.slice(0, 140)}`);
          break;
        case "toolResult":
          if (/^\{"error"|not applied|not been approved|denied/i.test(e.content)) console.log(`${stamp()}   → ${e.content.slice(0, 300)}`);
          break;
        case "context":
          console.log(`${stamp()} CONTEXT(${e.origin}) ${e.report.used}/${e.report.budget} tok: ${e.report.selected.map((s) => s.path).join(", ")}`);
          break;
        case "plan":
          console.log(`${stamp()} PLAN ${e.plan.steps.map((s) => s.file).join(", ")}`);
          break;
        case "status":
          console.log(`${stamp()} STATUS ${e.status.kind}: ${e.status.message}${e.status.failure ? ` | ${e.status.failure.raw.slice(0, 240)}` : ""}`);
          break;
        case "thread":
          console.log(`${stamp()} THREAD ${e.done ? "done" : "start"} ${e.title}`);
          break;
        case "compaction":
          console.log(`${stamp()} COMPACTION ${e.phase}`);
          break;
        case "applied":
          console.log(`${stamp()} APPLIED ${e.summary.split("\n")[0]}`);
          break;
        case "session":
          console.log(`${stamp()} SESSION ${e.sessionId} turn ${e.turnId} on ${e.model}`);
          break;
        case "log":
          console.log(`${stamp()} LOG ${e.message}`);
          break;
      }
    },
  },
});

(async () => {
  if (execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim()) {
    console.error("Flask checkout is not clean; refusing to rehearse on top of other changes.");
    process.exit(2);
  }
  await core.start();
  let ok = false;
  try {
    if (task === "a") {
      const span = core.index.findSymbol("get_debug_flag").find((d) => d.file === "src/flask/helpers.py")!;
      console.log(`${stamp()} Task A: inline edit of src/flask/helpers.py lines ${span.line}-${span.endLine} on ${models.join(" -> ")}`);
      const r = await core.runInline({ abs: path.join(root, "src/flask/helpers.py"), languageId: "python", sel: { startLine: span.line, endLine: span.endLine }, instruction: TASK_A });
      console.log(`${stamp()} RESULT ${r.result.status} on ${r.result.model}${r.error ? ` ERROR ${r.error}` : ""}`);
      ok = Boolean(r.applied);
    } else {
      console.log(`${stamp()} Task B: agent mode on ${models.join(" -> ")}`);
      const r = await core.runAgent(TASK_B);
      console.log(`${stamp()} RESULT ${r.status} on ${r.model}${r.error ? ` ERROR ${r.error.message}` : ""}`);
      console.log(`--- final agent message ---\n${text.slice(-1500)}\n---`);
      ok = r.status === "done";
    }
  } finally {
    await core.stop();
  }
  console.log(`\nChanged files:\n${execSync("git status --porcelain", { cwd: root, encoding: "utf8" })}`);
  if (process.env.VERIFY_PYTHON && ok) {
    const v = spawnSync(process.env.VERIFY_PYTHON, [path.join(here, `test/verify/verify_task_${task}.py`)], { cwd: root, encoding: "utf8" });
    console.log(v.stdout || v.stderr);
  }
  if (!process.env.KEEP) {
    execSync("git checkout -q -- . && git clean -qfd", { cwd: root });
    console.log("(Flask checkout reset to pristine; set KEEP=1 to keep the changes)");
  }
  process.exit(ok ? 0 : 1);
})();
