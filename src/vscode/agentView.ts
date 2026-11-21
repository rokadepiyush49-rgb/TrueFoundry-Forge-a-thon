import * as vscode from "vscode";
import * as path from "path";
import { randomBytes } from "crypto";
import { ForgeCore, CoreEvent } from "../core/forgeCore";
import { Proposal } from "../core/diff/review";

type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "newSession" }
  | { type: "decide"; id: string; hunkId: number; decision: "accepted" | "rejected" | "pending" }
  | { type: "decideAll"; id: string; decision: "accepted" | "rejected" }
  | { type: "openReview"; id: string }
  | { type: "undo"; changeId: string; hunkIds?: number[] }
  | { type: "undoTurn"; turnKey: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openSession"; mode?: "agent" | "inline" }
  | { type: "mention"; query: string }
  | { type: "commandAnswer"; reqId: string; ok: boolean };

/** Serializable view of a proposal for the panel. */
function proposalView(p: Proposal) {
  return {
    id: p.id,
    relPath: p.relPath,
    status: p.status,
    kind: p.kind,
    source: p.source,
    hunks: p.hunks.map((h) => ({
      id: h.id,
      start: h.oldIndex + 1,
      removed: h.oldLines.slice(0, 40),
      added: h.newLines.slice(0, 40),
      more: Math.max(0, h.oldLines.length - 40) + Math.max(0, h.newLines.length - 40),
      decision: p.decisions.get(h.id),
      warnings: p.hunkWarnings.get(h.id) || [],
    })),
  };
}

/**
 * The agent panel: chat with streaming, tool timeline, the Context Inspector
 * (which files were chosen and why, against the token budget), the declared
 * plan, the review queue with per-hunk buttons, and the change journal with
 * per-change, per-hunk and per-run undo.
 */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private queue: unknown[] = [];
  private pendingCommands = new Map<string, (ok: boolean) => void>();

  constructor(
    private ctx: vscode.ExtensionContext,
    private core: ForgeCore,
    private root: string,
    private openReview: (p: Proposal) => void,
    private serverUrl: () => string,
  ) {
    core.review.onChange(() => this.post({ type: "reviews", items: core.review.all().map(proposalView) }));
    core.journal.onChange(() => this.postChanges());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    const nonce = randomBytes(16).toString("base64");
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview", "main.js"));
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview", "main.css"));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Forward a core event to the panel (queued until the panel is visible). */
  emit(e: CoreEvent): void {
    this.post({ type: "event", event: e });
  }

  post(msg: unknown): void {
    if (this.view) void this.view.webview.postMessage(msg);
    else {
      this.queue.push(msg);
      if (this.queue.length > 2000) this.queue.splice(0, this.queue.length - 2000);
    }
  }

  reveal(): void {
    void vscode.commands.executeCommand("forgepilot.agentView.focus");
  }

  private postChanges(): void {
    this.post({
      type: "changes",
      items: this.core.journal.list().map((c) => ({
        id: c.id,
        relPath: path.relative(this.root, c.path).split(path.sep).join("/"),
        turnKey: c.turnKey,
        source: c.source,
        hunks: c.hunks.map((h) => ({ id: h.hunkId, undone: c.undoneHunks.has(h.hunkId), added: h.after.length, removed: h.before.length })),
        undone: c.undone,
        time: c.time,
      })),
    });
  }

  /** Ask the user to allow a terminal command, in the panel and as a notification; first answer wins. */
  confirmCommand(command: string): Promise<boolean> {
    const reqId = randomBytes(6).toString("hex");
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        this.pendingCommands.delete(reqId);
        this.post({ type: "commandResolved", reqId, ok });
        resolve(ok);
      };
      this.pendingCommands.set(reqId, finish);
      this.post({ type: "commandRequest", reqId, command });
      void vscode.window
        .showInformationMessage(`ForgePilot wants to run: ${command}`, { modal: false }, "Run", "Deny")
        .then((choice) => finish(choice === "Run"));
    });
  }

  denyPendingCommands(): void {
    for (const finish of [...this.pendingCommands.values()]) finish(false);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          for (const q of this.queue.splice(0)) void this.view?.webview.postMessage(q);
          this.post({ type: "config", models: vscode.workspace.getConfiguration("forgepilot").get<string[]>("models") || [], serverUrl: this.serverUrl() });
          this.post({ type: "reviews", items: this.core.review.all().map(proposalView) });
          this.postChanges();
          break;
        case "send":
          await vscode.commands.executeCommand("forgepilot.runAgent", m.text);
          break;
        case "cancel":
          await vscode.commands.executeCommand("forgepilot.cancel");
          break;
        case "newSession":
          if (this.core.busy) {
            void vscode.window.showWarningMessage("Cancel the running request before starting a new session.");
            return;
          }
          this.core.agent.newSession();
          this.post({ type: "cleared" });
          break;
        case "decide":
          this.core.review.decide(m.id, m.hunkId, m.decision);
          break;
        case "decideAll":
          this.core.review.decideAll(m.id, m.decision);
          break;
        case "openReview": {
          const p = this.core.review.get(m.id);
          if (p) this.openReview(p);
          break;
        }
        case "undo":
          await this.core.undo(m.changeId, m.hunkIds);
          break;
        case "undoTurn":
          await this.core.undoTurn(m.turnKey);
          break;
        case "openFile": {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this.root, m.path)));
          const line = Math.max(0, (m.line ?? 1) - 1);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
          break;
        }
        case "openSession":
          await vscode.commands.executeCommand("forgepilot.openSession", m.mode ?? "agent");
          break;
        case "mention":
          this.post({ type: "mentionResults", query: m.query, items: this.mentionItems(m.query) });
          break;
        case "commandAnswer":
          this.pendingCommands.get(m.reqId)?.(m.ok);
          break;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`ForgePilot: ${(e as Error).message}`);
    }
  }

  private mentionItems(query: string): Array<{ kind: "file" | "symbol"; label: string; detail: string; insert: string }> {
    const q = query.toLowerCase();
    const files = [...this.core.index.files.keys()]
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => a.length - b.length)
      .slice(0, 8)
      .map((f) => ({ kind: "file" as const, label: path.posix.basename(f), detail: f, insert: `@file:${f}` }));
    const symbols: Array<{ kind: "symbol"; label: string; detail: string; insert: string }> = [];
    if (q.length >= 2) {
      for (const [name, defs] of this.core.index.symbolsByName) {
        if (!name.includes(q)) continue;
        for (const d of defs.slice(0, 2)) {
          if (d.kind === "variable") continue;
          symbols.push({ kind: "symbol", label: d.parent ? `${d.parent}.${d.name}` : d.name, detail: `${d.file}:${d.line}`, insert: `@symbol:${d.name}` });
        }
        if (symbols.length >= 8) break;
      }
    }
    return [...symbols, ...files].slice(0, 14);
  }
}
