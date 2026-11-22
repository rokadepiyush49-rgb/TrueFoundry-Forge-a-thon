/**
 * Scripted demo: runs INSIDE VS Code (see runDemo.ts) on a pristine
 * pallets/flask 3.1.3 checkout and performs Tasks A, B and C in order, each
 * followed by its on-screen verification, while ffmpeg records the screen.
 *
 * Every action goes through ForgePilot's own commands (the same ones the
 * keybindings, CodeLens buttons and panel buttons invoke); the script only
 * replaces the mouse and keyboard, and pauses so each step is legible.
 */
import * as vscode from "vscode";
import * as path from "path";
import { spawn, ChildProcess, execSync } from "child_process";
import type { ForgePilotApi } from "../../src/extension";

const TASK_A =
  "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

const env = (k: string, d = "") => process.env[k] || d;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[demo ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const venv = env("DEMO_VENV");
  const out = env("DEMO_VIDEO", path.join(ws, "..", "forgepilot-demo.mov"));
  const modelsA = env("DEMO_MODELS_A").split(",").filter(Boolean);
  const modelsB = env("DEMO_MODELS_B").split(",").filter(Boolean);
  const modelsC = env("DEMO_MODELS_C").split(",").filter(Boolean);
  const sampleApp = env("DEMO_SAMPLE_APP");
  const api = (await vscode.extensions.getExtension("forgepilot.forgepilot")!.activate()) as ForgePilotApi;
  if (!(await api.ready())) throw new Error("ForgePilot could not connect to TrueForge");
  const core = api.core;
  const cfg = () => vscode.workspace.getConfiguration("forgepilot");
  const setModels = async (m: string[]) => {
    await cfg().update("models", m, vscode.ConfigurationTarget.Global);
    await waitFor("models", () => JSON.stringify(cfg().get("models")) === JSON.stringify(m), 5000);
  };
  const gitClean = () => execSync("git status --porcelain", { cwd: ws, encoding: "utf8" }).trim() === "";
  if (!gitClean()) throw new Error("Flask checkout must be pristine before recording");

  // ---- stage: full screen editor, panel, terminal --------------------------
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
  await sleep(2500);
  await vscode.commands.executeCommand("forgepilot.agentView.focus");
  const term = vscode.window.createTerminal({ name: "verify", cwd: ws });
  term.show(true);
  term.sendText(`source "${venv}/bin/activate" && clear && echo "pallets/flask $(git describe --tags) — git status:" && git status --short && echo "(clean)"`);
  await setModels(modelsA);
  await sleep(2500);

  // ---- start recording -------------------------------------------------------
  let ffmpeg: ChildProcess | undefined;
  if (env("DEMO_RECORD", "1") === "1") {
    ffmpeg = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-capture_cursor", "1", "-framerate", "30", "-i", "Capture screen 0:none",
      "-vf", "scale=1920:-2", "-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p", out], { stdio: ["pipe", "inherit", "inherit"] });
    await sleep(1500);
    log(`recording to ${out}`);
  }
  const marks: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (k: string) => {
    marks[k] = Math.round((Date.now() - t0) / 1000);
    log(`mark ${k} @ ${marks[k]}s`);
  };

  try {
    // ======================= TASK A: inline edit ==============================
    mark("A");
    void vscode.window.showInformationMessage("Task A — inline edit of get_debug_flag (Cmd/Ctrl+Alt+K)");
    const helpers = await vscode.workspace.openTextDocument(path.join(ws, "src/flask/helpers.py"));
    const ed = await vscode.window.showTextDocument(helpers, { preview: false });
    const span = core.index.findSymbol("get_debug_flag").find((d) => d.file === "src/flask/helpers.py")!;
    ed.revealRange(new vscode.Range(span.line - 1, 0, span.endLine, 0), vscode.TextEditorRevealType.InCenter);
    await sleep(1200);
    ed.selection = new vscode.Selection(span.line - 1, 0, span.endLine - 1, helpers.lineAt(span.endLine - 1).text.length);
    await sleep(1500);
    const inline = vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: TASK_A });
    const pA = await waitFor("Task A review", () => core.review.reviewing()[0], 120000);
    await sleep(3000);
    for (const h of pA.hunks) {
      await vscode.commands.executeCommand("forgepilot.acceptHunk", pA.id, h.id);
      await sleep(1300);
    }
    await inline;
    await sleep(1200);
    term.sendText(`clear; FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`);
    await sleep(4000);

    // ======================= TASK B: agent mode ===============================
    mark("B");
    await setModels(modelsB);
    void vscode.window.showInformationMessage("Task B — agent mode, no files named");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("forgepilot.agentView.focus");
    await sleep(1500);
    await vscode.commands.executeCommand("forgepilot.runAgent", TASK_B);
    const seen = new Set<string>();
    const deadline = Date.now() + Number(env("DEMO_TASK_B_TIMEOUT_S", "600")) * 1000;
    let firstDiff = false;
    let started = false;
    while (Date.now() < deadline) {
      if (core.busy) started = true;
      else if (started && core.review.reviewing().length === 0) break; // run ended (done or failed)
      await sleep(400);
      vscode.commands.executeCommand("forgepilot.allowPendingCommands").then(undefined, () => undefined);
      const p = core.review.reviewing().find((x) => !seen.has(x.id));
      if (p) {
        seen.add(p.id);
        if (!firstDiff) {
          firstDiff = true;
          mark("B-first-diff");
        }
        await sleep(2200);
        for (const h of p.hunks) {
          await vscode.commands.executeCommand("forgepilot.acceptHunk", p.id, h.id);
          await sleep(700);
        }
        continue;
      }
    }
    mark("B-done");
    await sleep(2000);
    mark("B-session");
    await vscode.commands.executeCommand("forgepilot.openSession", "agent");
    await sleep(Number(env("DEMO_SESSION_MS", "7000")));
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    mark("B-verify");
    term.show(true);
    term.sendText(`clear; python -m pytest tests/test_cli.py -q 2>&1 | tail -3; flask --app "${sampleApp}" --help | grep -E "^  (config|routes|run|shell)"; flask --app "${sampleApp}" config | head -12; git status --short`);
    await sleep(9000);

    // ======================= Bridge: undo + cancel ============================
    mark("undo");
    void vscode.window.showInformationMessage("Undo the whole Task B run (every file), then cancel a generation mid-stream");
    await vscode.commands.executeCommand("forgepilot.undoLastRun");
    await sleep(1500);
    term.sendText(`clear; echo "after Undo Last Run:"; git status --short; echo "(clean)"`);
    await sleep(3500);
    mark("cancel");
    await vscode.commands.executeCommand("forgepilot.agentView.focus");
    await vscode.commands.executeCommand("forgepilot.runAgent", "Write a detailed, multi-section explanation of how this repository's request dispatch works.");
    await waitFor("streaming", () => core.busy, 30000);
    await sleep(Number(env("DEMO_STREAM_MS", "4000")));
    await vscode.commands.executeCommand("forgepilot.cancel");
    await waitFor("cancelled", () => !core.busy, 5000);
    await sleep(1500);
    term.sendText(`clear; echo "after Stop:"; git status --short; echo "(clean)"`);
    await sleep(3000);

    // ======================= TASK C: resilience ================================
    mark("C");
    await setModels(modelsC);
    core.inline.newSession();
    void vscode.window.showInformationMessage(`Task C — primary model unreachable (${modelsC[0]}); repeating Task A`);
    const helpers2 = await vscode.workspace.openTextDocument(path.join(ws, "src/flask/helpers.py"));
    const ed2 = await vscode.window.showTextDocument(helpers2, { preview: false });
    const span2 = core.index.findSymbol("get_debug_flag").find((d) => d.file === "src/flask/helpers.py")!;
    ed2.revealRange(new vscode.Range(span2.line - 1, 0, span2.endLine, 0), vscode.TextEditorRevealType.InCenter);
    ed2.selection = new vscode.Selection(span2.line - 1, 0, span2.endLine - 1, helpers2.lineAt(span2.endLine - 1).text.length);
    await sleep(1500);
    const inlineC = vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: TASK_A });
    const pC = await Promise.race([
      waitFor("Task C review", () => core.review.reviewing()[0], 120000),
      inlineC.then(() => undefined),
    ]);
    if (pC) {
      await sleep(3500);
      await vscode.commands.executeCommand("forgepilot.rejectAllHunks", pC.id);
    }
    await inlineC;
    await sleep(1500);
    term.show(true);
    term.sendText(`clear; echo "Task C — git status after the failed primary:"; git status --short; echo "(clean)"`);
    await sleep(4500);
    mark("end");
  } finally {
    if (ffmpeg) {
      ffmpeg.stdin?.write("q");
      await new Promise((r) => ffmpeg!.on("close", r));
      log(`saved ${out}`);
    }
    console.log(`DEMO_MARKS ${JSON.stringify(marks)}`);
    await vscode.commands.executeCommand("workbench.action.toggleFullScreen").then(undefined, () => undefined);
  }
  if (!gitClean()) log("note: the Flask checkout is not clean after the demo");
}
