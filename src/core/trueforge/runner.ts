import { TrueForge, TrueForgeApi as TF, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import { AgentDefinition, buildSpec } from "./spec";
import { classifyFailure, backoffMs, Failure } from "./errors";

export interface ToolCallInfo {
  id: string;
  threadId: string;
  /** Tool name on its MCP server (unwrapped from deferred `call_tool` when needed). */
  name: string;
  serverName?: string;
  argsJson: string;
}

export interface StatusEvent {
  kind: "attempt" | "retry" | "fallback" | "failed" | "continue";
  model: string;
  message: string;
  failure?: Failure;
}

export interface RunHandlers {
  onText(delta: string, threadId: string): void;
  onToolCall(call: ToolCallInfo): void;
  onToolResult(toolCallId: string, content: string, threadId: string): void;
  /** Decide a pending approval. Must resolve exactly once per tool call. */
  onApprovalNeeded(call: ToolCallInfo, turnId: string): Promise<TF.ApprovalDecision>;
  onThread(ev: { threadId: string; title: string; parentThreadId: string }): void;
  onThreadDone(ev: { threadId: string; title: string; ok: boolean }): void;
  onCompaction(ev: { threadId: string; phase: "started" | "finished"; contextTokens?: number; thresholdTokens?: number; durationMs?: number }): void;
  onStatus(ev: StatusEvent): void;
  onTurn(turnId: string, model: string): void;
  /** Summary of changes already applied during this run (used when continuing after a mid-run failure). */
  progressSummary(): string;
}

export interface RunResult {
  status: "done" | "cancelled" | "error";
  model: string;
  turnId?: string;
  failures: Array<{ model: string; attempt: number; failure: Failure }>;
  error?: Failure;
  cancelLatencyMs?: number;
}

interface TurnOutcome {
  status: "done" | "cancelled" | "error";
  turnId?: string;
  previousTurnId?: string | null;
  errorMessage?: string;
  madeProgress: boolean;
}

const WRITE_TOOL_NAMES = new Set(["propose_edit", "propose_new_file", "run_command"]);

function unwrapDeferred(name: string, argsJson: string): { name: string; argsJson: string } {
  // Deferred MCP tools may arrive wrapped (e.g. call_tool {tool, arguments}).
  if (!/call_tool|use_tool|invoke_tool/.test(name)) return { name, argsJson };
  try {
    const a = JSON.parse(argsJson || "{}");
    const inner = a.tool_name || a.tool || a.name;
    const innerArgs = a.arguments ?? a.args ?? a.input ?? {};
    if (typeof inner === "string") {
      return { name: inner.split(/[:/.]/).pop()!, argsJson: typeof innerArgs === "string" ? innerArgs : JSON.stringify(innerArgs) };
    }
  } catch {
    /* fall through */
  }
  return { name, argsJson };
}

/**
 * One TrueForge session driven by the editor. TrueForge runs the agent loop;
 * this class only sends turns, renders streamed events, answers approvals,
 * cancels, and - because TrueForge has no built-in model fallback - retries
 * transient failures with backoff and then switches the SAME session to the
 * next configured model, so the conversation history survives the switch.
 */
export class SessionRunner {
  sessionId?: string;
  private modelIndex = 0;
  private abort?: AbortController;
  private cancelled = false;
  private cancelAt = 0;
  private answered = new Set<string>();
  private running = false;

  constructor(
    private client: TrueForge,
    private def: AgentDefinition,
    private models: () => string[],
    private retry: () => { maxAttempts: number; baseDelayMs: number },
    private title: string,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  currentModel(): string {
    const m = this.models();
    if (!m.length) throw new Error("No models configured. Set forgepilot.models to model names configured in TrueForge (provider/model).");
    return m[Math.min(this.modelIndex, m.length - 1)];
  }

  /** Start over from the primary model on the next run (e.g. after the user fixed their config). */
  resetModel(): void {
    this.modelIndex = 0;
  }

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const res = await this.client.sessions.create(
      { agent: { spec: buildSpec(this.def, this.currentModel()) }, metadata: { client: "forgepilot", mode: this.def.name } } as unknown as TF.CreateSessionRequest,
    );
    this.sessionId = res.data.id;
    try {
      await this.client.sessions.update(this.sessionId, { title: this.title });
    } catch {
      /* title is cosmetic */
    }
    return this.sessionId;
  }

  newSession(): void {
    this.sessionId = undefined;
    this.modelIndex = 0;
  }

  private async switchModel(index: number): Promise<void> {
    this.modelIndex = index;
    await this.client.sessions.update(this.sessionId!, { agent: { spec: buildSpec(this.def, this.currentModel()) } });
  }

  async run(input: string, h: RunHandlers): Promise<RunResult> {
    if (this.running) throw new Error("A run is already in progress in this session.");
    this.running = true;
    this.cancelled = false;
    this.answered.clear();
    const failures: RunResult["failures"] = [];
    try {
      await this.ensureSession();
      const models = this.models();
      let content = input;
      let previousTurnId: string = "auto";
      let progressTurn: string | undefined;
      const { maxAttempts, baseDelayMs } = this.retry();
      for (let mi = this.modelIndex; mi < models.length; mi++) {
        if (mi !== this.modelIndex) {
          const from = this.currentModel();
          await this.switchModel(mi);
          h.onStatus({
            kind: "fallback",
            model: this.currentModel(),
            message: `Switched from ${from} to ${this.currentModel()} on the same TrueForge session (history kept).`,
            failure: failures[failures.length - 1]?.failure,
          });
        }
        for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
          if (this.cancelled) return { status: "cancelled", model: this.currentModel(), failures };
          h.onStatus({ kind: "attempt", model: this.currentModel(), message: `Running on ${this.currentModel()} (attempt ${attempt})` });
          const out = await this.runOneTurn(content, previousTurnId, h);
          if (out.status === "done") return { status: "done", model: this.currentModel(), turnId: out.turnId, failures };
          if (out.status === "cancelled" || this.cancelled) {
            return { status: "cancelled", model: this.currentModel(), turnId: out.turnId, failures, cancelLatencyMs: this.cancelAt ? Date.now() - this.cancelAt : undefined };
          }
          const failure = classifyFailure(out.errorMessage || "");
          failures.push({ model: this.currentModel(), attempt, failure });
          const continuation = () =>
            `[ForgePilot] The model failed mid-task (${failure.message}). Continue the ORIGINAL task from where it stopped. ` +
            `Do not redo or re-propose changes that are already applied.\nApplied so far:\n${h.progressSummary() || "(none)"}\n\nOriginal request:\n${input}`;
          if (out.madeProgress && out.turnId) {
            // Edits were applied in the failed turn: continue from it rather
            // than replaying the request from scratch.
            progressTurn = out.turnId;
            previousTurnId = out.turnId;
            content = continuation();
            h.onStatus({ kind: "continue", model: this.currentModel(), message: "Continuing from the interrupted turn; applied changes are kept.", failure });
          } else if (progressTurn) {
            // An earlier attempt in this run already applied edits: stay in
            // continuation mode, chained after the last turn that made progress.
            previousTurnId = progressTurn;
            content = continuation();
          } else {
            // Nothing happened yet: abandon the failed turn and replay the same request.
            previousTurnId = out.previousTurnId ?? "none";
            content = input;
          }
          if (!failure.retryable || attempt >= maxAttempts) break;
          const wait = backoffMs(attempt, baseDelayMs);
          h.onStatus({ kind: "retry", model: this.currentModel(), message: `${failure.message} Retrying in ${(wait / 1000).toFixed(1)} s.`, failure });
          await this.sleep(wait);
        }
      }
      const last = failures[failures.length - 1]?.failure ?? classifyFailure("no models configured");
      h.onStatus({ kind: "failed", model: this.currentModel(), message: `All configured models failed. ${last.message}`, failure: last });
      return { status: "error", model: this.currentModel(), failures, error: last };
    } finally {
      this.running = false;
      this.abort = undefined;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort?.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private async runOneTurn(content: string, previousTurnId: string, h: RunHandlers): Promise<TurnOutcome> {
    this.abort = new AbortController();
    // TrueForge streams assistant messages as deltas that must be merged by id
    // (tool-call arguments arrive in fragments, merged by index).
    const messages = new Map<string, TF.ModelMessageEvent>();
    const calls = new Map<string, ToolCallInfo>();
    const toInfo = (tc: TF.ToolCall, threadId: string): ToolCallInfo => {
      const info = tc.toolInfo as { type: string; name: string; serverName?: string } | undefined;
      const un = unwrapDeferred(info?.name ?? tc.function?.name ?? "unknown", tc.function?.arguments ?? "{}");
      return { id: tc.id, threadId, name: un.name, serverName: info?.serverName, argsJson: un.argsJson };
    };
    const emitCalls = (m: TF.ModelMessageEvent) => {
      for (const tc of m.toolCalls ?? []) {
        if (!tc.id || calls.has(tc.id)) continue;
        const call = toInfo(tc, m.threadId);
        calls.set(tc.id, call);
        h.onToolCall(call);
      }
    };
    const resolveCall = (id: string, threadId: string): ToolCallInfo => {
      if (calls.has(id)) return calls.get(id)!;
      for (const m of messages.values()) {
        if (m.toolCalls?.some((tc) => tc.id === id)) {
          emitCalls(m);
          return calls.get(id)!;
        }
      }
      return { id, threadId, name: "unknown", argsJson: "{}" };
    };
    let turnId: string | undefined;
    let prevOfTurn: string | null | undefined;
    let madeProgress = false;
    try {
      const stream = await this.client.sessions.createTurnStream(
        this.sessionId!,
        { input: [{ type: "user.message", content }], previousTurnId },
        { abortSignal: this.abort.signal, timeoutInSeconds: 3600 },
      );
      for await (const ev of stream as AsyncIterable<TF.TurnStreamingEvent>) {
        if (this.cancelled) break;
        switch (ev.type) {
          case "turn.created":
            turnId = ev.turnId;
            prevOfTurn = ev.previousTurnId;
            h.onTurn(ev.turnId, this.currentModel());
            break;
          case "model.message.delta": {
            let base = messages.get(ev.id);
            if (!base) {
              base = { type: "model.message", id: ev.id, threadId: ev.threadId, createdAt: ev.createdAt ?? new Date().toISOString(), content: "" };
              messages.set(ev.id, base);
            }
            mergeEventDelta(base, ev);
            if (ev.content) h.onText(ev.content, ev.threadId);
            if (ev.finishReason) emitCalls(base);
            break;
          }
          case "model.message": {
            const known = messages.get(ev.id);
            if (!known) {
              // a complete message that was not streamed as deltas
              messages.set(ev.id, ev);
              const text = typeof ev.content === "string" ? ev.content : "";
              if (text) h.onText(text, ev.threadId);
            } else if (ev.toolCalls?.length) {
              known.toolCalls = ev.toolCalls;
            }
            emitCalls(messages.get(ev.id)!);
            break;
          }
          case "tool.response": {
            const c = resolveCall(ev.toolCallId, ev.threadId);
            if (WRITE_TOOL_NAMES.has(c.name)) madeProgress = true;
            h.onToolResult(ev.toolCallId, ev.content, ev.threadId);
            break;
          }
          case "tool.approval_required":
            for (const ref of ev.toolCalls) {
              void this.answer(resolveCall(ref.id, ev.threadId), turnId!, h);
            }
            break;
          case "thread.created":
            h.onThread({ threadId: ev.threadId, title: ev.title, parentThreadId: ev.parent.threadId });
            break;
          case "thread.done":
            h.onThreadDone({ threadId: ev.threadId, title: ev.title, ok: (ev.state as { status?: string }).status !== "error" });
            break;
          case "thread.context_compaction_started":
            h.onCompaction({ threadId: ev.threadId, phase: "started", contextTokens: ev.trigger.contextTokens, thresholdTokens: ev.trigger.thresholdTokens });
            break;
          case "thread.context_compaction_finished":
            h.onCompaction({ threadId: ev.threadId, phase: "finished", durationMs: ev.durationMs });
            break;
          case "turn.done": {
            const st = ev.state as { status: string; message?: string };
            if (st.status === "done") return { status: "done", turnId, previousTurnId: prevOfTurn, madeProgress };
            if (st.status === "cancelled") return { status: "cancelled", turnId, previousTurnId: prevOfTurn, madeProgress };
            return { status: "error", turnId, previousTurnId: prevOfTurn, errorMessage: st.message || "turn failed", madeProgress };
          }
          default:
            break;
        }
      }
      if (this.cancelled) return { status: "cancelled", turnId, madeProgress };
      return { status: "error", turnId, previousTurnId: prevOfTurn, errorMessage: "The TrueForge stream ended without finishing the turn.", madeProgress };
    } catch (e) {
      if (this.cancelled) return { status: "cancelled", turnId, madeProgress };
      const err = e as { message?: string; statusCode?: number; body?: unknown };
      const body = err.body ? ` ${JSON.stringify(err.body).slice(0, 300)}` : "";
      return { status: "error", turnId, previousTurnId: prevOfTurn, errorMessage: `${err.statusCode ? `(${err.statusCode}) ` : ""}${err.message ?? String(e)}${body}`, madeProgress };
    }
  }

  private async answer(call: ToolCallInfo, turnId: string, h: RunHandlers): Promise<void> {
    if (this.answered.has(call.id)) return; // never answer twice (TrueForge issue #508)
    this.answered.add(call.id);
    let decision: TF.ApprovalDecision;
    try {
      decision = await h.onApprovalNeeded(call, turnId);
    } catch (e) {
      decision = { status: "deny", reason: `ForgePilot could not review this call: ${(e as Error).message}` };
    }
    if (this.cancelled) return;
    try {
      await this.client.sessions.createTurnEvents(this.sessionId!, turnId, {
        events: [{ type: "user.tool_approval", threadId: call.threadId, toolCallId: call.id, approval: decision }],
      });
    } catch {
      /* the turn may have ended (cancelled or failed); nothing to do */
    }
  }

  /** Cancel immediately: stop streaming locally, then tell TrueForge. Never blocks the editor. */
  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    this.cancelAt = Date.now();
    this.abort?.abort();
    if (this.sessionId) {
      try {
        await this.client.sessions.cancel(this.sessionId, {});
      } catch {
        /* best effort */
      }
    }
  }
}
