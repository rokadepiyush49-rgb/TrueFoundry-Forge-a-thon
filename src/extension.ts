import * as vscode from "vscode";
import * as path from "path";
import { readFileSync } from "fs";
import { ForgeCore, CoreEvent } from "./core/forgeCore";
import { AgentDefinition } from "./core/trueforge/spec";
import { VsCodeFilePort } from "./vscode/filePort";
import { ReviewController } from "./vscode/reviewController";
import { AgentViewProvider } from "./vscode/agentView";

let core: ForgeCore | undefined;

function cfg() {
  return vscode.workspace.getConfiguration("forgepilot");
}

function loadDef(ctx: vscode.ExtensionContext, file: string): AgentDefinition {
  return JSON.parse(readFileSync(path.join(ctx.extensionPath, "agents", file), "utf8"));
}

/** Parse @file:path, @symbol:name and bare @path mentions out of a request. */
export function parseMentions(text: string, files: Set<string>, findSymbol: (n: string) => Array<{ file: string; line: number }>) {
  const mentions = new Set<string>();
  const notes: string[] = [];
  for (const m of text.matchAll(/@file:(\S+)/g)) if (files.has(m[1])) mentions.add(m[1]);
  for (const m of text.matchAll(/@symbol:([\w.]+)/g)) {
    const defs = findSymbol(m[1]);
    for (const d of defs.slice(0, 2)) {
      mentions.add(d.file);
      notes.push(`@symbol:${m[1]} is defined at ${d.file}:${d.line}`);
    }
    if (!defs.length) notes.push(`@symbol:${m[1]} was not found in this repository`);
  }
  for (const m of text.matchAll(/(?:^|\s)@([\w./-]+\.\w+)/g)) if (files.has(m[1])) mentions.add(m[1]);
  return { mentions: [...mentions], notes };
}

/** API returned from activate(); used by the extension-host integration tests. */
export interface ForgePilotApi {
  core: ForgeCore;
  ready: () => Promise<boolean>;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<ForgePilotApi | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const out = vscode.window.createOutputChannel("ForgePilot", { log: true });
  ctx.subscriptions.push(out);
  if (!folder) {
    for (const id of ["forgepilot.inlineEdit", "forgepilot.runAgent", "forgepilot.cancel", "forgepilot.undoLastChange", "forgepilot.openSession", "forgepilot.reindex", "forgepilot.chooseModels"]) {
      ctx.subscriptions.push(vscode.commands.registerCommand(id, () => vscode.window.showWarningMessage("ForgePilot: open a folder first.")));
    }
    return undefined;
  }
  const root = folder.uri.fsPath;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  ctx.subscriptions.push(status);
  const setIdle = () => {
    const models = cfg().get<string[]>("models") || [];
    status.text = `$(sparkle) ForgePilot${models[0] ? ` · ${models[0]}` : " · choose a model"}`;
    status.tooltip = models.length ? `Models (primary first): ${models.join(" → ")}` : "Click to choose models configured in TrueForge";
    status.command = models.length ? "forgepilot.agentView.focus" : "forgepilot.chooseModels";
    status.backgroundColor = undefined;
  };
  setIdle();
  status.show();

  let view: AgentViewProvider;
  let review: ReviewController;
  let ready: Promise<boolean> = Promise.resolve(false);
  const streamListeners = new Set<(e: CoreEvent) => void>();

  const onEvent = (e: CoreEvent) => {
    view?.emit(e);
    for (const l of streamListeners) l(e);
    if (e.type === "run" && e.phase === "start") {
      status.text = `$(sync~spin) ForgePilot ${e.mode} · Stop`;
      status.command = "forgepilot.cancel";
      status.tooltip = "Click (or Cmd/Ctrl+Alt+Esc) to cancel";
    } else if (e.type === "run" && e.phase === "end") {
      setIdle();
      if (e.result.status === "error" && e.result.error) {
        void vscode.window.showErrorMessage(
          `ForgePilot: ${e.result.error.message} No files were changed by the failed request. (${e.result.failures.length} attempt${e.result.failures.length === 1 ? "" : "s"} across ${new Set(e.result.failures.map((f) => f.model)).size} model(s).)`,
          "Show details",
        ).then((c) => c && out.show());
      }
    } else if (e.type === "status") {
      out.info(`[${e.mode}] ${e.status.kind}: ${e.status.message}${e.status.failure ? ` | ${e.status.failure.raw.slice(0, 300)}` : ""}`);
      if (e.status.kind === "fallback") {
        status.text = `$(warning) ForgePilot · fallback → ${e.status.model}`;
        status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        void vscode.window.showWarningMessage(`ForgePilot: ${e.status.failure?.message ?? "The model failed."} ${e.status.message}`);
      } else if (e.status.kind === "retry") {
        status.text = `$(sync~spin) ForgePilot · retrying ${e.status.model}`;
      }
    } else if (e.type === "log") {
      out.info(e.message);
    } else if (e.type === "applied") {
      out.info(e.summary);
    }
  };

  core = new ForgeCore({
    root,
    serverUrl: cfg().get<string>("serverUrl") || "http://localhost:8790",
    models: () => cfg().get<string[]>("models") || [],
    retry: () => ({ maxAttempts: cfg().get<number>("retry.maxAttempts") ?? 2, baseDelayMs: cfg().get<number>("retry.baseDelayMs") ?? 600 }),
    budget: () => cfg().get<number>("context.budgetTokens") ?? 6000,
    fs: new VsCodeFilePort(),
    agentDef: loadDef(ctx, "forgepilot.agent.json"),
    inlineDef: loadDef(ctx, "inline-edit.agent.json"),
    mcpPort: cfg().get<number>("mcp.port") ?? 0,
    ui: {
      showReview: (p) => {
        void review.show(p);
      },
      confirmCommand: (c) => view.confirmCommand(c),
      rejectionFeedback: () => undefined,
      emit: onEvent,
    },
  });
  const c = core;
  review = new ReviewController(c);
  review.register(ctx);
  view = new AgentViewProvider(ctx, c, root, (p) => void review.show(p), () => cfg().get<string>("serverUrl") || "http://localhost:8790");
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("forgepilot.agentView", view, { webviewOptions: { retainContextWhenHidden: true } }));

  const start = async (): Promise<boolean> => {
    try {
      await c.start();
      out.info(`Indexed ${c.index.stats.files} files (${c.index.stats.chunks} chunks) in ${c.index.stats.ms} ms; MCP server at ${c.mcp?.url}`);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      out.error(`Could not connect to TrueForge: ${msg}`);
      const choice = await vscode.window.showErrorMessage(
        `ForgePilot could not register its editor tools with TrueForge at ${cfg().get("serverUrl")}. Start it with: OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest`,
        "Retry",
      );
      if (choice === "Retry") {
        ready = start();
        return ready;
      }
      return false;
    }
  };
  ready = start();

  const ensureReady = async (): Promise<boolean> => {
    if (await ready) return true;
    ready = start();
    return ready;
  };

  const ensureModels = async (): Promise<boolean> => {
    if ((cfg().get<string[]>("models") || []).length) return true;
    const pick = await vscode.window.showWarningMessage("ForgePilot: choose the model(s) TrueForge should use.", "Choose models");
    if (pick) await vscode.commands.executeCommand("forgepilot.chooseModels");
    return (cfg().get<string[]>("models") || []).length > 0;
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("forgepilot.runAgent", async (text?: string) => {
      const request = text ?? (await vscode.window.showInputBox({ prompt: "What should ForgePilot do?", ignoreFocusOut: true }));
      if (!request?.trim()) return;
      if (!(await ensureReady()) || !(await ensureModels())) return;
      if (c.busy) {
        void vscode.window.showWarningMessage("ForgePilot is already running. Cancel it first.");
        return;
      }
      const { mentions, notes } = parseMentions(request, new Set(c.index.files.keys()), (n) => c.index.findSymbol(n));
      const full = notes.length ? `${request}\n\n${notes.join("\n")}` : request;
      view.reveal();
      void c.runAgent(full, mentions);
    }),

    vscode.commands.registerCommand("forgepilot.inlineEdit", async (args?: { instruction?: string }) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showWarningMessage("ForgePilot: select the code to edit first.");
        return;
      }
      const doc = ed.document;
      if (doc.uri.scheme !== "file" || !doc.uri.fsPath.startsWith(root + path.sep)) {
        void vscode.window.showWarningMessage("ForgePilot: inline edit works on saved files inside the workspace.");
        return;
      }
      const s = ed.selection;
      const endLine = s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
      const sel = { startLine: s.start.line + 1, endLine };
      const instruction =
        args?.instruction ??
        (await vscode.window.showInputBox({
          title: `ForgePilot: edit ${path.basename(doc.fileName)} lines ${sel.startLine}-${sel.endLine}`,
          prompt: "Describe the change",
          ignoreFocusOut: true,
        }));
      if (!instruction?.trim()) return;
      if (!(await ensureReady()) || !(await ensureModels())) return;
      if (c.busy) {
        void vscode.window.showWarningMessage("ForgePilot is already running. Cancel it first.");
        return;
      }
      if (doc.isDirty) await doc.save();
      let chars = 0;
      let model = cfg().get<string[]>("models")?.[0] ?? "";
      let resolveGen: () => void = () => {};
      const generation = new Promise<void>((r) => (resolveGen = r));
      const listener = (e: CoreEvent) => {
        if (e.type === "text" && e.mode === "inline") chars += e.delta.length;
        if (e.type === "session" && e.mode === "inline") model = e.model;
        if ((e.type === "run" && e.phase === "end" && e.mode === "inline") || (e.type === "log" && chars > 0)) resolveGen();
      };
      streamListeners.add(listener);
      const run = c.runInline({ abs: doc.uri.fsPath, languageId: doc.languageId, sel, instruction });
      const reviewOpened = new Promise<void>((r) => {
        const off = c.review.onChange((p) => {
          if (p.id.startsWith("inline-")) {
            off();
            r();
          }
        });
      });
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "ForgePilot inline edit", cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => void c.cancel());
          const tick = setInterval(() => progress.report({ message: `streaming from ${model}… ${chars} chars` }), 150);
          await Promise.race([generation, reviewOpened, run.then(() => undefined)]);
          clearInterval(tick);
        },
      );
      const r = await run;
      streamListeners.delete(listener);
      if (r.error) void vscode.window.showWarningMessage(`ForgePilot: ${r.error}`);
      else if (r.result.status === "cancelled") void vscode.window.showInformationMessage("ForgePilot: inline edit cancelled. No files were changed.");
      else if (r.applied) void vscode.window.setStatusBarMessage(`ForgePilot: applied ${r.applied.hunks.length} hunk(s) — Undo with “ForgePilot: Undo Last Applied Change”.`, 6000);
      else if (r.proposal && r.result.status === "done") void vscode.window.setStatusBarMessage("ForgePilot: all hunks rejected; nothing written.", 5000);
    }),

    vscode.commands.registerCommand("forgepilot.cancel", async () => {
      view.denyPendingCommands();
      const t0 = Date.now();
      const r = await c.cancel();
      out.info(`Cancelled in ${Date.now() - t0} ms (discarded ${r.discarded} pending review(s), killed ${r.killed} command(s)).`);
    }),

    vscode.commands.registerCommand("forgepilot.undoLastChange", async () => {
      try {
        const undone = await c.undoLast();
        if (!undone) void vscode.window.showInformationMessage("ForgePilot: nothing to undo.");
        else void vscode.window.setStatusBarMessage(`ForgePilot: undid change to ${path.relative(root, undone.path)}`, 5000);
      } catch (e) {
        void vscode.window.showWarningMessage(`ForgePilot: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("forgepilot.openSession", async (mode: "agent" | "inline" = "agent") => {
      const runner = mode === "inline" ? c.inline : c.agent;
      const base = (cfg().get<string>("serverUrl") || "http://localhost:8790").replace(/\/$/, "");
      const url = runner.sessionId ? `${base}/sessions/${runner.sessionId}` : base;
      try {
        await vscode.commands.executeCommand("simpleBrowser.show", url);
      } catch {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),

    vscode.commands.registerCommand("forgepilot.reindex", async () => {
      const st = await c.index.build();
      void vscode.window.setStatusBarMessage(`ForgePilot: indexed ${st.files} files in ${st.ms} ms`, 4000);
    }),

    vscode.commands.registerCommand("forgepilot.chooseModels", async () => {
      if (!(await ensureReady())) return;
      let available: string[] = [];
      try {
        const res = (await c.client.models.list()) as unknown as { data: Array<{ name?: string; fqn?: string; id?: string }> };
        available = (res.data || []).map((m) => m.fqn || m.name || m.id || "").filter(Boolean);
      } catch (e) {
        out.warn(`Could not list TrueForge models: ${(e as Error).message}`);
      }
      const current = cfg().get<string[]>("models") || [];
      const items = [...new Set([...current, ...available])].map((m) => ({ label: m, picked: current.includes(m) }));
      if (!items.length) {
        void vscode.window.showWarningMessage(`No models are configured in TrueForge yet. Add a provider at ${cfg().get("serverUrl")} (Settings → Model providers).`);
        return;
      }
      const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: "Models for ForgePilot (pick in priority order: primary first, then fallbacks)" });
      if (!chosen?.length) return;
      // keep the order of the user's existing list, then new picks
      const ordered = [...current.filter((m) => chosen.some((x) => x.label === m)), ...chosen.map((x) => x.label).filter((m) => !current.includes(m))];
      await cfg().update("models", ordered, vscode.ConfigurationTarget.Global);
      c.agent.resetModel();
      c.inline.resetModel();
      setIdle();
      void vscode.window.setStatusBarMessage(`ForgePilot models: ${ordered.join(" → ")}`, 5000);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forgepilot.models")) {
        c.agent.resetModel();
        c.inline.resetModel();
        setIdle();
      }
    }),
  );

  // keep the index fresh as files are saved
  const pending = new Map<string, NodeJS.Timeout>();
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.scheme !== "file" || !d.uri.fsPath.startsWith(root + path.sep)) return;
      const rel = path.relative(root, d.uri.fsPath).split(path.sep).join("/");
      clearTimeout(pending.get(rel));
      pending.set(rel, setTimeout(() => void c.index.refresh(rel), 300));
    }),
  );
  return { core: c, ready: () => ready };
}

export async function deactivate(): Promise<void> {
  await core?.stop();
}
