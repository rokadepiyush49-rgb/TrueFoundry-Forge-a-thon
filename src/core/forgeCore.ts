import * as path from "path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { ContextIndex } from "./context/indexer";
import { retrieve, renderReport, ContextReport } from "./context/retrieve";
import { ChangeJournal, FilePort, AppliedChange } from "./diff/journal";
import { ReviewStore, buildProposal, applyApprovedProposal, isFullyDecided, Proposal, EditScope } from "./diff/review";
import { summarizeHunk } from "./diff/hunks";
import { SessionRunner, RunHandlers, RunResult, StatusEvent, ToolCallInfo } from "./trueforge/runner";
import { AgentDefinition, MCP_SERVER_NAME } from "./trueforge/spec";
import { ApprovalBroker } from "./review/broker";
import { CommandRunner } from "./nodeHost";
import { startMcpServer, RunningMcpServer } from "../mcp/server";
import { Plan, ToolHost } from "../mcp/tools";
import { buildInlinePrompt, extractReplacement, detectElision, fixIndentation, replaceSelection, Selection, InlineReplyError } from "./inline";
import { pythonSyntaxError } from "./context/check";

export type Mode = "agent" | "inline";

export type CoreEvent =
  | { type: "run"; mode: Mode; phase: "start"; request: string; turnKey: string }
  | { type: "run"; mode: Mode; phase: "end"; result: RunResult; turnKey: string }
  | { type: "text"; mode: Mode; delta: string; threadId: string }
  | { type: "tool"; mode: Mode; call: ToolCallInfo }
  | { type: "toolResult"; mode: Mode; toolCallId: string; content: string; threadId: string }
  | { type: "context"; report: ContextReport; origin: "agent" | "auto" }
  | { type: "plan"; plan: Plan }
  | { type: "status"; mode: Mode; status: StatusEvent }
  | { type: "thread"; mode: Mode; threadId: string; title: string; parentThreadId?: string; done?: boolean; ok?: boolean }
  | { type: "compaction"; mode: Mode; threadId: string; phase: "started" | "finished"; contextTokens?: number; thresholdTokens?: number; durationMs?: number }
  | { type: "session"; mode: Mode; sessionId: string; turnId: string; model: string }
  | { type: "applied"; summary: string }
  | { type: "log"; message: string };

export interface CoreUi {
  showReview(p: Proposal): void;
  confirmCommand(command: string): Promise<boolean>;
  rejectionFeedback(p: Proposal): string | undefined;
  emit(e: CoreEvent): void;
}

export interface CoreOptions {
  root: string;
  serverUrl: string;
  models: () => string[];
  retry: () => { maxAttempts: number; baseDelayMs: number };
  budget: () => number;
  fs: FilePort;
  ui: CoreUi;
  agentDef: AgentDefinition;
  inlineDef: AgentDefinition;
  mcpPort?: number;
}

/**
 * Everything ForgePilot does, independent of VS Code: the index, the review
 * store, the undo journal, the MCP server that exposes editor tools to
 * TrueForge, and one TrueForge session per mode (a new turn would cancel a
 * running one, so inline edit and agent mode never share a session).
 */
export class ForgeCore {
  readonly index: ContextIndex;
  readonly review = new ReviewStore();
  readonly journal = new ChangeJournal();
  readonly commands: CommandRunner;
  readonly client: TrueForge;
  readonly agent: SessionRunner;
  readonly inline: SessionRunner;
  mcp?: RunningMcpServer;
  private broker: ApprovalBroker;
  private active: { mode: Mode; turnKey: string; source: string; plan?: Plan; scope?: { rel: string; scope: EditScope }; cancelled: boolean } | undefined;
  private turnSeq = 0;

  constructor(private o: CoreOptions) {
    this.index = new ContextIndex(o.root);
    this.commands = new CommandRunner(o.root);
    this.client = new TrueForge({ baseUrl: o.serverUrl, timeoutInSeconds: 3600, maxRetries: 0 } as ConstructorParameters<typeof TrueForge>[0]);
    this.agent = new SessionRunner(this.client, o.agentDef, o.models, o.retry, `ForgePilot agent · ${path.basename(o.root)}`);
    this.inline = new SessionRunner(this.client, o.inlineDef, o.models, o.retry, `ForgePilot inline · ${path.basename(o.root)}`);
    this.broker = new ApprovalBroker({
      root: o.root,
      fs: o.fs,
      index: this.index,
      review: this.review,
      plan: () => this.active?.plan,
      turnKey: () => this.active?.turnKey ?? "none",
      source: () => this.active?.source ?? "",
      scope: (rel) => (this.active?.scope && this.active.scope.rel === rel ? this.active.scope.scope : undefined),
      showReview: (p) => o.ui.showReview(p),
      confirmCommand: (c) => o.ui.confirmCommand(c),
      rejectionFeedback: (p) => o.ui.rejectionFeedback(p),
      log: (m) => o.ui.emit({ type: "log", message: m }),
    });
  }

  toolHost(): ToolHost {
    return {
      root: this.o.root,
      index: this.index,
      fs: this.o.fs,
      review: this.review,
      journal: this.journal,
      budgetTokens: () => this.o.budget(),
      runCommand: (cmd, ms) => this.commands.run(cmd, ms),
      onContextReport: (report, origin) => this.o.ui.emit({ type: "context", report, origin }),
      onPlan: (plan) => {
        if (this.active) this.active.plan = plan;
        this.o.ui.emit({ type: "plan", plan });
      },
      onApplied: (summary) => this.o.ui.emit({ type: "applied", summary }),
      isCancelled: () => Boolean(this.active?.cancelled),
    };
  }

  /** Index the workspace, start the MCP server and register it with TrueForge. */
  async start(): Promise<void> {
    await this.index.build();
    this.mcp = await startMcpServer(this.toolHost(), this.o.mcpPort ?? 0);
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: "remote",
        name: MCP_SERVER_NAME,
        description: "ForgePilot: the user's VS Code workspace (read, search, retrieve context, propose reviewed edits, run commands).",
        url: this.mcp.url,
        auth: { type: "header", headers: { Authorization: `Bearer ${this.mcp.token}` } },
      },
    });
  }

  async stop(): Promise<void> {
    await this.cancel();
    await this.mcp?.close();
  }

  get busy(): boolean {
    return this.agent.isRunning || this.inline.isRunning;
  }

  private handlers(mode: Mode): RunHandlers {
    const ui = this.o.ui;
    return {
      onText: (delta, threadId) => ui.emit({ type: "text", mode, delta, threadId }),
      onToolCall: (call) => ui.emit({ type: "tool", mode, call }),
      onToolResult: (toolCallId, content, threadId) => ui.emit({ type: "toolResult", mode, toolCallId, content, threadId }),
      onApprovalNeeded: (call) => this.broker.decide(call),
      onThread: (t) => ui.emit({ type: "thread", mode, threadId: t.threadId, title: t.title, parentThreadId: t.parentThreadId }),
      onThreadDone: (t) => ui.emit({ type: "thread", mode, threadId: t.threadId, title: t.title, done: true, ok: t.ok }),
      onCompaction: (c) => ui.emit({ type: "compaction", mode, ...c }),
      onStatus: (status) => ui.emit({ type: "status", mode, status }),
      onTurn: (turnId, model) => {
        const runner = mode === "agent" ? this.agent : this.inline;
        ui.emit({ type: "session", mode, sessionId: runner.sessionId!, turnId, model });
      },
      progressSummary: () =>
        this.journal
          .list()
          .filter((c) => c.turnKey === this.active?.turnKey && !c.undone)
          .map((c) => `- ${path.relative(this.o.root, c.path)} (${c.hunks.length} hunk${c.hunks.length === 1 ? "" : "s"})`)
          .join("\n"),
    };
  }

  /** Agent mode: one request drives a TrueForge tool loop until done. */
  async runAgent(request: string, mentions: string[] = []): Promise<RunResult> {
    if (this.busy) throw new Error("ForgePilot is already running. Cancel it first.");
    const turnKey = `agent-${Date.now().toString(36)}-${++this.turnSeq}`;
    this.active = { mode: "agent", turnKey, source: request, cancelled: false };
    this.o.ui.emit({ type: "run", mode: "agent", phase: "start", request, turnKey });
    // Automatic context: a pointer pack (paths + reasons, no code) the agent can follow up on.
    const rels = mentions.filter((m) => this.index.files.has(m));
    const report = retrieve(this.index, request, { budget: Math.min(this.o.budget(), 2500), mentions: rels, includeCode: false });
    this.o.ui.emit({ type: "context", report, origin: "auto" });
    const mentioned = await Promise.all(
      rels.map(async (r) => `--- @${r} ---\n${(await this.o.fs.read(path.join(this.o.root, r))) ?? "(missing)"}`),
    );
    const message = [
      request,
      "",
      "[ForgePilot automatic context — candidate files, with the evidence for each; use retrieve_context or read_file for code]",
      renderReport(this.index, report, false),
      mentioned.length ? `\n[Files the user attached]\n${mentioned.join("\n\n")}` : "",
    ].join("\n");
    let result: RunResult;
    try {
      result = await this.agent.run(message, this.handlers("agent"));
    } catch (e) {
      result = { status: "error", model: "", failures: [], error: { kind: "unknown", retryable: false, message: (e as Error).message, raw: String(e) } };
    }
    this.finishRun("agent", turnKey, result);
    return result;
  }

  /**
   * Inline edit: the tool-less inline agent rewrites the selection, then the
   * result goes through the same per-hunk review as agent edits.
   */
  async runInline(opts: { abs: string; languageId: string; sel: Selection; instruction: string }): Promise<{ result: RunResult; proposal?: Proposal; applied?: AppliedChange; error?: string }> {
    if (this.busy) throw new Error("ForgePilot is already running. Cancel it first.");
    const rel = path.relative(this.o.root, opts.abs).split(path.sep).join("/");
    const turnKey = `inline-${Date.now().toString(36)}-${++this.turnSeq}`;
    this.active = { mode: "inline", turnKey, source: opts.instruction, scope: { rel, scope: { startLine: opts.sel.startLine, endLine: opts.sel.endLine } }, cancelled: false };
    this.o.ui.emit({ type: "run", mode: "inline", phase: "start", request: opts.instruction, turnKey });
    const original = await this.o.fs.read(opts.abs);
    if (original === null) throw new Error(`${rel} does not exist on disk. Save the file first.`);
    let reply = "";
    const h = this.handlers("inline");
    const onText = h.onText;
    h.onText = (d, t) => {
      if (t === "main") reply += d;
      onText(d, t);
    };
    const prompt = buildInlinePrompt({ relPath: rel, languageId: opts.languageId, fileText: original, sel: opts.sel, instruction: opts.instruction });
    let result: RunResult;
    try {
      result = await this.inline.run(prompt, h);
    } catch (e) {
      result = { status: "error", model: "", failures: [], error: { kind: "unknown", retryable: false, message: (e as Error).message, raw: String(e) } };
    }
    if (result.status !== "done") {
      this.finishRun("inline", turnKey, result);
      return { result };
    }
    try {
      const selected = original.split("\n").slice(opts.sel.startLine - 1, opts.sel.endLine).join("\n").replace(/\r/g, "");
      let replacement = fixIndentation(selected, extractReplacement(reply));
      const elided = detectElision(selected, replacement);
      if (elided) throw new InlineReplyError(`The model abbreviated the code ("${elided}"); nothing was proposed. Try again or use another model.`);
      const proposedText = replaceSelection(original, opts.sel, replacement);
      if (rel.endsWith(".py")) {
        const err = pythonSyntaxError(proposedText);
        if (err) throw new InlineReplyError(`The suggested code does not parse (${err}); nothing was proposed.`);
      }
      const p = buildProposal({
        id: `inline-${turnKey}`,
        turnKey,
        source: opts.instruction,
        kind: "edit",
        path: opts.abs,
        relPath: rel,
        original,
        args: { path: rel, edits: [{ old_string: original, new_string: proposedText }] },
        toolName: "inline_edit",
        scope: { startLine: opts.sel.startLine, endLine: opts.sel.endLine },
      });
      this.review.add(p);
      this.o.ui.showReview(p);
      const outcome = await this.waitDecided(p);
      if (outcome === "discarded" || this.active?.cancelled) {
        this.finishRun("inline", turnKey, { ...result, status: "cancelled" });
        return { result: { ...result, status: "cancelled" }, proposal: p };
      }
      if (![...p.decisions.values()].includes("accepted")) {
        this.review.setStatus(p.id, "denied");
        this.finishRun("inline", turnKey, result);
        return { result, proposal: p };
      }
      this.review.setStatus(p.id, "approved");
      const r = await applyApprovedProposal(p, this.o.fs, this.journal);
      await this.index.refresh(rel);
      this.o.ui.emit({ type: "applied", summary: `Wrote ${rel}: ${r.applied.map((i) => summarizeHunk(p.hunks[i])).join("; ")}` });
      this.finishRun("inline", turnKey, result);
      return { result, proposal: p, applied: r.change };
    } catch (e) {
      const msg = (e as Error).message;
      this.o.ui.emit({ type: "log", message: msg });
      this.finishRun("inline", turnKey, result);
      return { result, error: msg };
    }
  }

  private waitDecided(p: Proposal): Promise<"decided" | "discarded"> {
    return new Promise((resolve) => {
      let off: () => void = () => {};
      const check = (c: Proposal) => {
        if (c.id !== p.id) return;
        if (c.status === "discarded") {
          off();
          resolve("discarded");
        } else if (isFullyDecided(c)) {
          off();
          resolve("decided");
        }
      };
      off = this.review.onChange(check);
      check(p);
    });
  }

  private finishRun(mode: Mode, turnKey: string, result: RunResult): void {
    this.o.ui.emit({ type: "run", mode, phase: "end", result, turnKey });
    if (this.active?.turnKey === turnKey) this.active = undefined;
  }

  /**
   * Cancel everything immediately. Order matters: mark cancelled (so no MCP
   * write starts), discard unreviewed proposals, kill running commands, then
   * stop the TrueForge turns. Edits the user already accepted stay applied;
   * nothing is ever half-written because each file write is a single atomic
   * operation.
   */
  async cancel(): Promise<{ discarded: number; killed: number }> {
    const turnKey = this.active?.turnKey;
    if (this.active) this.active.cancelled = true;
    const discarded = turnKey ? this.review.discardTurn(turnKey).length : 0;
    const killed = this.commands.killAll();
    await Promise.all([this.agent.cancel(), this.inline.cancel()]);
    return { discarded, killed };
  }

  async undoLast(): Promise<AppliedChange | undefined> {
    const last = this.journal.lastActive();
    if (!last) return undefined;
    await this.journal.undo(last.id, this.o.fs);
    await this.index.refresh(path.relative(this.o.root, last.path).split(path.sep).join("/"));
    return last;
  }

  async undo(changeId: string, hunkIds?: number[]): Promise<void> {
    const c = this.journal.get(changeId);
    await this.journal.undo(changeId, this.o.fs, hunkIds);
    if (c) await this.index.refresh(path.relative(this.o.root, c.path).split(path.sep).join("/"));
  }

  async undoTurn(turnKey: string): Promise<void> {
    const changed = await this.journal.undoTurn(turnKey, this.o.fs);
    for (const c of changed) await this.index.refresh(path.relative(this.o.root, c.path).split(path.sep).join("/"));
  }
}
