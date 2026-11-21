import type { TrueForgeApi as TF } from "@truefoundry/trueforge-sdk";
import { ToolCallInfo } from "../trueforge/runner";
import { FilePort } from "../diff/journal";
import { ReviewStore, buildProposal, isFullyDecided, Proposal, EditScope } from "../diff/review";
import { EditError } from "../diff/edits";
import { ContextIndex } from "../context/indexer";
import { checkPythonImports, pythonSyntaxError } from "../context/check";
import { resolveInside, editKey, EditArgs, NewFileArgs, Plan } from "../../mcp/tools";

export interface BrokerHost {
  root: string;
  mcpName: string;
  fs: FilePort;
  index: ContextIndex;
  review: ReviewStore;
  plan(): Plan | undefined;
  turnKey(): string;
  source(): string;
  scope(path: string): EditScope | undefined;
  /** Called when a proposal is ready for the user to review (open the diff). */
  showReview(p: Proposal): void;
  /** Ask the user to allow a terminal command. */
  confirmCommand(command: string): Promise<boolean>;
  /** Optional feedback the user typed when rejecting. */
  rejectionFeedback(p: Proposal): string | undefined;
  syntaxCheck?: (text: string, relPath: string) => string | undefined;
  log(msg: string): void;
}

const READ_ONLY = new Set(["retrieve_context", "read_file", "list_files", "search_code", "find_symbol", "declare_plan"]);

/**
 * Turns TrueForge tool-approval requests into ForgePilot reviews. Write tools
 * are checked first (anchors must exist, Python must parse, imported project
 * symbols must exist); failures are denied back to the agent with the reason,
 * without bothering the user. Valid edits become per-hunk reviews, and the
 * approval is only sent once every hunk has a decision.
 */
export class ApprovalBroker {
  constructor(private host: BrokerHost) {}

  async decide(call: ToolCallInfo): Promise<TF.ApprovalDecision> {
    if (call.serverName && call.serverName !== this.host.mcpName) {
      return { status: "deny", reason: `ForgePilot only approves its own editor tools; ${call.serverName}/${call.name} was not expected.` };
    }
    if (READ_ONLY.has(call.name)) return { status: "allow" };
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.argsJson || "{}");
    } catch {
      return { status: "deny", reason: "The tool arguments were not valid JSON. Send the call again with valid JSON arguments." };
    }
    if (call.name === "run_command") {
      const cmd = String(args.command ?? "");
      const ok = await this.host.confirmCommand(cmd);
      return ok ? { status: "allow" } : { status: "deny", reason: "The user declined to run this command." };
    }
    if (call.name === "propose_edit" || call.name === "propose_new_file") {
      return this.review(call, call.name, args as unknown as EditArgs | NewFileArgs);
    }
    return { status: "deny", reason: `Unknown tool ${call.name}.` };
  }

  private async review(call: ToolCallInfo, tool: "propose_edit" | "propose_new_file", args: EditArgs | NewFileArgs): Promise<TF.ApprovalDecision> {
    let abs: string;
    let rel: string;
    try {
      ({ abs, rel } = resolveInside(this.host.root, args.path));
    } catch (e) {
      return { status: "deny", reason: (e as Error).message };
    }
    const original = await this.host.fs.read(abs);
    let p: Proposal;
    try {
      p = buildProposal({
        id: call.id,
        turnKey: this.host.turnKey(),
        source: this.host.source(),
        kind: tool === "propose_edit" ? "edit" : "create",
        path: abs,
        relPath: rel,
        original,
        args: tool === "propose_edit" ? { path: rel, edits: (args as EditArgs).edits } : { path: rel, content: (args as NewFileArgs).content },
        toolName: tool,
        scope: this.host.scope(rel),
      });
    } catch (e) {
      const hint = e instanceof EditError && e.hint ? `\n${e.hint}` : "";
      this.host.log(`auto-rejected ${tool} on ${rel}: ${(e as Error).message}`);
      return { status: "deny", reason: `Edit not applied: ${(e as Error).message}${hint}\nRead the file again and send a corrected edit.` };
    }
    p.argsKey = editKey(this.host.root, tool, args);

    // Hard checks: a broken file or a hallucinated import never reaches the user.
    const syntax = (this.host.syntaxCheck ?? ((t, r) => (r.endsWith(".py") ? pythonSyntaxError(t) : undefined)))(p.proposed, rel);
    if (syntax) {
      this.host.log(`auto-rejected ${rel}: syntax error ${syntax}`);
      return { status: "deny", reason: `Edit not applied: the result would not parse (${syntax}). Fix the edit and try again.` };
    }
    const missing = checkPythonImports(this.host.index, p);
    if (missing.size) {
      const msgs = [...missing.values()].flat();
      this.host.log(`auto-rejected ${rel}: ${msgs.join(" ")}`);
      return { status: "deny", reason: `Edit not applied: it imports names that do not exist in this repository. ${msgs.join(" ")}` };
    }

    // Soft checks: shown on the hunk so the user can judge.
    const plan = this.host.plan();
    if (plan && plan.steps.length && !plan.steps.some((s) => s.file === rel)) {
      for (const h of p.hunks) p.hunkWarnings.set(h.id, [...(p.hunkWarnings.get(h.id) || []), `${rel} is not in the agent's declared plan.`]);
    }

    this.host.review.add(p);
    this.host.showReview(p);
    const outcome = await this.waitForDecisions(p);
    if (outcome === "discarded") return { status: "deny", reason: "The run was cancelled; nothing was written." };
    const accepted = [...p.decisions.values()].filter((d) => d === "accepted").length;
    if (accepted === 0) {
      this.host.review.setStatus(p.id, "denied");
      const fb = this.host.rejectionFeedback(p);
      return { status: "deny", reason: `The user rejected every hunk of this edit to ${rel}.${fb ? ` Feedback: ${fb}` : ""} Do not re-apply it unchanged.` };
    }
    this.host.review.setStatus(p.id, "approved");
    return { status: "allow" };
  }

  private waitForDecisions(p: Proposal): Promise<"decided" | "discarded"> {
    return new Promise((resolve) => {
      let off: () => void = () => {};
      const check = (changed: Proposal) => {
        if (changed.id !== p.id) return;
        if (changed.status === "discarded") {
          off();
          resolve("discarded");
        } else if (changed.status === "reviewing" && isFullyDecided(changed)) {
          off();
          resolve("decided");
        }
      };
      off = this.host.review.onChange(check);
      check(p);
    });
  }
}
