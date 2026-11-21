/**
 * Runs INSIDE a real VS Code extension host (see runTest.ts). Drives the real
 * commands, CodeLens provider, diff tabs and file writes against a real
 * TrueForge server and the scripted mock model.
 */
import * as vscode from "vscode";
import * as path from "path";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import type { ForgePilotApi } from "../../src/extension";
import { startMockModel, MockModel } from "../e2e/mockModel";

const CALC = `def add(a, b):
    return a + b


def sub(a, b):
    return a - b
`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const calcPath = path.join(ws, "pkg/calc.py");
  const disk = () => readFileSync(calcPath, "utf8");
  const gitStatus = () => execSync("git status --porcelain", { cwd: ws, encoding: "utf8" });
  const resetWs = () => {
    execSync("git checkout -q -- . && git clean -qfd -e .vscode", { cwd: ws });
  };

  const ext = vscode.extensions.getExtension("forgepilot.forgepilot");
  assert(ext, "extension is installed in the test host");
  const api = (await ext.activate()) as ForgePilotApi;
  assert(await api.ready(), "extension connected to TrueForge and registered its MCP server");
  const core = api.core;
  const mock: MockModel = await startMockModel();
  await core.client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: "custom",
      name: "mock",
      baseUrl: mock.url,
      auth: { apiKey: "test-key-not-secret" },
      models: ["scripted", "inline-scripted", "always-500", "auth-fail", "slow"].map((m) => ({ name: m, modelId: m, properties: { contextLength: 128000 } })),
    },
  } as never);
  const setModels = async (m: string[]) => {
    await vscode.workspace.getConfiguration("forgepilot").update("models", m, vscode.ConfigurationTarget.Global);
    await waitFor("models setting", () => JSON.stringify(vscode.workspace.getConfiguration("forgepilot").get("models")) === JSON.stringify(m));
  };
  const proposedTabs = () =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && (t.input as vscode.TabInputTextDiff).modified.scheme === "forgepilot-proposed");
  const lensTitles = async (uri: vscode.Uri) =>
    ((await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)) || []).map((l) => l.command?.title || "");
  const selectLines = async (start: number, end: number) => {
    const doc = await vscode.workspace.openTextDocument(calcPath);
    const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length);
    return ed;
  };

  const tests: Array<[string, () => Promise<void>]> = [
    [
      "inline edit: diff with per-hunk CodeLens, nothing on disk until accepted, then undo",
      async () => {
        resetWs();
        await setModels(["mock/inline-scripted"]);
        mock.setScript("inline-scripted", [{ text: "```python\ndef sub(a, b):\n    return float(a) - float(b)\n```" }]);
        await selectLines(5, 6);
        const cmd = vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: "use floats" });
        const p = await waitFor("inline review", () => core.review.reviewing()[0]);
        await waitFor("diff tab", () => proposedTabs().length > 0);
        assert(disk() === CALC, "no write before the user accepts");
        const titles = await lensTitles((proposedTabs()[0].input as vscode.TabInputTextDiff).modified);
        assert(titles.some((t) => t.includes("Accept hunk 1/1")), `per-hunk Accept lens present: ${titles.join(" | ")}`);
        assert(titles.some((t) => t.includes("Reject")), "per-hunk Reject lens present");
        await vscode.commands.executeCommand("forgepilot.acceptHunk", p.id, 0);
        await cmd;
        assert(disk() === CALC.replace("return a - b", "return float(a) - float(b)"), "accepted hunk written to disk");
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === calcPath)!;
        assert(open.getText() === disk(), "editor buffer matches disk");
        await waitFor("diff tab closed", () => proposedTabs().length === 0);
        await vscode.commands.executeCommand("forgepilot.undoLastChange");
        await waitFor("undo applied", () => disk() === CALC);
        assert(gitStatus() === "", "workspace clean after undo");
      },
    ],
    [
      "agent mode: TrueForge approval drives per-hunk review; only accepted hunks are written",
      async () => {
        resetWs();
        await setModels(["mock/scripted"]);
        mock.setScript("scripted", [
          { tool: "retrieve_context", args: { query: "add and sub" } },
          {
            tool: "propose_edit",
            args: {
              path: "pkg/calc.py",
              edits: [
                { old_string: "    return a + b", new_string: "    return int(a) + int(b)" },
                { old_string: "    return a - b", new_string: "    return int(a) - int(b)" },
              ],
            },
          },
          { text: "Done." },
        ]);
        core.agent.newSession();
        await vscode.commands.executeCommand("forgepilot.runAgent", "make add and sub coerce to int");
        const p = await waitFor("agent review", () => core.review.reviewing()[0]);
        await waitFor("diff tab", () => proposedTabs().length > 0);
        const titles = await lensTitles((proposedTabs()[0].input as vscode.TabInputTextDiff).modified);
        assert(titles.filter((t) => t.includes("Accept hunk")).length === 2, `two hunk lenses: ${titles.join(" | ")}`);
        assert(disk() === CALC, "nothing written while reviewing");
        await vscode.commands.executeCommand("forgepilot.acceptHunk", p.id, 0);
        await vscode.commands.executeCommand("forgepilot.rejectHunk", p.id, 1);
        await waitFor("run finished", () => !core.busy, 30000);
        assert(disk().includes("return int(a) + int(b)") && disk().includes("return a - b"), `only hunk 1 written:\n${disk()}`);
      },
    ],
    [
      "streaming keeps the editor responsive; cancel is immediate and leaves the workspace clean",
      async () => {
        resetWs();
        await setModels(["mock/slow"]);
        core.agent.newSession();
        let maxLag = 0;
        let last = Date.now();
        const timer = setInterval(() => {
          const now = Date.now();
          maxLag = Math.max(maxLag, now - last - 20);
          last = now;
        }, 20);
        await vscode.commands.executeCommand("forgepilot.runAgent", "write a long essay");
        await waitFor("streaming", () => core.busy && mock.calls.some((c) => c.model.endsWith("slow")));
        await new Promise((r) => setTimeout(r, 1500));
        // the user keeps typing in another document while the agent streams
        const scratch = await vscode.workspace.openTextDocument({ content: "", language: "plaintext" });
        const ed = await vscode.window.showTextDocument(scratch);
        const t0 = Date.now();
        await ed.edit((b) => b.insert(new vscode.Position(0, 0), "typing while the agent runs"));
        const editMs = Date.now() - t0;
        const c0 = Date.now();
        await vscode.commands.executeCommand("forgepilot.cancel");
        await waitFor("cancelled", () => !core.busy, 3000);
        const cancelMs = Date.now() - c0;
        clearInterval(timer);
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
        assert(editMs < 500, `editing stayed responsive (${editMs} ms)`);
        assert(maxLag < 250, `extension host event loop never blocked (max lag ${maxLag} ms)`);
        assert(cancelMs < 1500, `cancel completed in ${cancelMs} ms`);
        assert(gitStatus() === "", "workspace clean after cancel");
        console.log(`[metrics] edit latency ${editMs} ms, max event-loop lag ${maxLag} ms, cancel ${cancelMs} ms`);
      },
    ],
    [
      "Task C: invalid key on the primary model -> automatic fallback, no user action",
      async () => {
        resetWs();
        await setModels(["mock/auth-fail", "mock/inline-scripted"]);
        core.inline.newSession();
        mock.setScript("inline-scripted", [{ text: "```python\ndef sub(a, b):\n    return float(a) - float(b)\n```" }]);
        await selectLines(5, 6);
        const cmd = vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: "use floats" });
        const p = await waitFor("review after fallback", () => core.review.reviewing()[0]);
        assert(mock.calls.some((c) => c.model.endsWith("auth-fail")), "primary model was tried");
        await vscode.commands.executeCommand("forgepilot.rejectAllHunks", p.id);
        await cmd;
        assert(gitStatus() === "", "nothing written when the user rejects");
      },
    ],
    [
      "Task C: every model unreachable -> clear failure, editor responsive, git status clean",
      async () => {
        resetWs();
        await setModels(["mock/always-500"]);
        core.inline.newSession();
        await selectLines(1, 2);
        const t0 = Date.now();
        await vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: "anything" });
        assert(Date.now() - t0 < 15000, "did not hang");
        assert(!core.busy, "not busy afterwards");
        assert(core.review.reviewing().length === 0, "no proposal created");
        assert(gitStatus() === "", "git status clean");
      },
    ],
  ];

  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try {
      await fn();
      console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n    ${(e as Error).stack}`);
      // unblock anything still waiting so the next test starts clean
      await core.cancel();
    }
  }
  await mock.close();
  await core.client.settings.modelProviders.delete("mock").catch(() => undefined);
  console.log(`${tests.length - failed}/${tests.length} VS Code integration tests passed`);
  if (failed) throw new Error(`${failed} VS Code integration test(s) failed`);
}
