import * as vscode from "vscode";
import { ForgeCore } from "../core/forgeCore";
import { Proposal, previewText, previewLayout } from "../core/diff/review";
import { HunkDecision } from "../core/diff/hunks";

export const PROPOSED_SCHEME = "forgepilot-proposed";

/**
 * Hunk-by-hunk review in VS Code's native diff editor. The right side is a
 * virtual document showing the proposal with rejected hunks removed; each
 * hunk carries Accept / Reject CodeLens actions. Nothing touches disk here:
 * decisions are recorded, and the write happens only after TrueForge's tool
 * approval reaches the MCP server (agent mode) or the inline flow applies it.
 */
export class ReviewController implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChange = this.contentChanged.event;
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private warnedCodeLens = false;

  constructor(private core: ForgeCore) {
    core.review.onChange((p) => {
      this.contentChanged.fire(this.uriFor(p));
      this.lensChanged.fire();
      if (p.status !== "reviewing") void this.closeDiff(p);
    });
  }

  register(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this),
      vscode.commands.registerCommand("forgepilot.acceptHunk", (id: string, hunkId: number) => this.decide(id, hunkId, "accepted")),
      vscode.commands.registerCommand("forgepilot.rejectHunk", (id: string, hunkId: number) => this.decide(id, hunkId, "rejected")),
      vscode.commands.registerCommand("forgepilot.reconsiderHunk", (id: string, hunkId: number) => this.decide(id, hunkId, "pending")),
      vscode.commands.registerCommand("forgepilot.acceptAllHunks", (id?: string) => this.decideAll(id, "accepted")),
      vscode.commands.registerCommand("forgepilot.rejectAllHunks", (id?: string) => this.decideAll(id, "rejected")),
    );
  }

  uriFor(p: Proposal, side: "proposed" | "empty" = "proposed"): vscode.Uri {
    return vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${p.relPath}`, query: `id=${encodeURIComponent(p.id)}&side=${side}` });
  }

  private proposalOf(uri: vscode.Uri): { p?: Proposal; side: string } {
    const q = new URLSearchParams(uri.query);
    return { p: this.core.review.get(q.get("id") || ""), side: q.get("side") || "proposed" };
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const { p, side } = this.proposalOf(uri);
    if (!p) return "";
    if (side === "empty") return "";
    return previewText(p);
  }

  async show(p: Proposal): Promise<void> {
    await this.ensureCodeLensInDiff();
    const left = p.kind === "create" ? this.uriFor(p, "empty") : vscode.Uri.file(p.path);
    const pending = p.hunks.length;
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      this.uriFor(p),
      `ForgePilot review · ${p.relPath} · ${pending} hunk${pending === 1 ? "" : "s"}`,
      { preview: false, preserveFocus: false },
    );
  }

  private async ensureCodeLensInDiff(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("diffEditor");
    if (cfg.get<boolean>("codeLens")) return;
    await cfg.update("codeLens", true, vscode.ConfigurationTarget.Global);
    if (!this.warnedCodeLens) {
      this.warnedCodeLens = true;
      void vscode.window.showInformationMessage("ForgePilot turned on diffEditor.codeLens (user setting) so each hunk shows Accept / Reject. Your workspace files are not modified.");
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const { p, side } = this.proposalOf(doc.uri);
    if (!p || side !== "proposed") return [];
    const lenses: vscode.CodeLens[] = [];
    const total = p.hunks.length;
    const pending = [...p.decisions.values()].filter((d) => d === "pending").length;
    const top = new vscode.Range(0, 0, 0, 0);
    if (p.status === "reviewing" && pending > 0) {
      lenses.push(
        new vscode.CodeLens(top, { title: `$(check-all) Accept all ${pending} remaining`, command: "forgepilot.acceptAllHunks", arguments: [p.id] }),
        new vscode.CodeLens(top, { title: "$(close-all) Reject all", command: "forgepilot.rejectAllHunks", arguments: [p.id] }),
      );
    } else {
      lenses.push(new vscode.CodeLens(top, { title: `Review ${p.status}`, command: "" }));
    }
    for (const l of previewLayout(p)) {
      const line = Math.max(0, Math.min(l.previewStart, doc.lineCount - 1));
      const r = new vscode.Range(line, 0, line, 0);
      const d = p.decisions.get(l.hunkId);
      const label = `hunk ${l.hunkId + 1}/${total}`;
      if (p.status === "reviewing" && d === "pending") {
        lenses.push(
          new vscode.CodeLens(r, { title: `$(check) Accept ${label}`, command: "forgepilot.acceptHunk", arguments: [p.id, l.hunkId] }),
          new vscode.CodeLens(r, { title: "$(close) Reject", command: "forgepilot.rejectHunk", arguments: [p.id, l.hunkId] }),
        );
      } else {
        lenses.push(
          new vscode.CodeLens(r, {
            title: d === "accepted" ? `$(pass-filled) Accepted ${label}` : d === "rejected" ? `$(circle-slash) Rejected ${label}` : label,
            command: p.status === "reviewing" ? "forgepilot.reconsiderHunk" : "",
            arguments: [p.id, l.hunkId],
            tooltip: p.status === "reviewing" ? "Click to reconsider" : undefined,
          }),
        );
      }
      for (const w of p.hunkWarnings.get(l.hunkId) || []) {
        lenses.push(new vscode.CodeLens(r, { title: `$(warning) ${w}`, command: "" }));
      }
    }
    return lenses;
  }

  decide(id: string, hunkId: number, decision: HunkDecision): void {
    try {
      this.core.review.decide(id, hunkId, decision);
    } catch (e) {
      void vscode.window.showWarningMessage((e as Error).message);
    }
  }

  decideAll(id: string | undefined, decision: HunkDecision): void {
    const p = id ? this.core.review.get(id) : this.activeProposal();
    if (!p) return;
    this.core.review.decideAll(p.id, decision);
  }

  private activeProposal(): Proposal | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === PROPOSED_SCHEME) return this.proposalOf(uri).p;
    return this.core.review.reviewing()[0];
  }

  private async closeDiff(p: Proposal): Promise<void> {
    const target = this.uriFor(p).toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === target) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }
  }
}
