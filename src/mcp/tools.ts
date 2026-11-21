import * as path from "path";
import { realpathSync } from "fs";
import { ContextIndex } from "../core/context/indexer";
import { retrieve, renderReport, ContextReport } from "../core/context/retrieve";
import { ChangeJournal, FilePort } from "../core/diff/journal";
import { ReviewStore, applyApprovedProposal, argsKey, ReviewConflict } from "../core/diff/review";
import { summarizeHunk } from "../core/diff/hunks";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  ms: number;
}

export interface Plan {
  summary: string;
  steps: Array<{ file: string; change: string }>;
}

/** Everything a tool needs from its host (the VS Code extension, or a test harness). */
export interface ToolHost {
  root: string;
  index: ContextIndex;
  fs: FilePort;
  review: ReviewStore;
  journal: ChangeJournal;
  budgetTokens(): number;
  runCommand(command: string, timeoutMs: number): Promise<CommandResult>;
  onContextReport(report: ContextReport, origin: "agent" | "auto"): void;
  onPlan(plan: Plan): void;
  onApplied(summary: string): void;
  /** True when the user cancelled the run that owns pending work. */
  isCancelled(): boolean;
}

export class ToolError extends Error {}

/** Resolve a workspace-relative path, refusing anything outside the workspace or inside .git. */
export function resolveInside(root: string, p: string): { abs: string; rel: string } {
  if (!p || typeof p !== "string") throw new ToolError("A file path is required.");
  const cleaned = p.replace(/^\.\/+/, "");
  const abs = path.resolve(root, cleaned);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ToolError(`Path ${p} is outside the workspace.`);
  if (rel === ".git" || rel.startsWith(".git/")) throw new ToolError("Refusing to touch the .git directory.");
  // Follow symlinks on the deepest existing ancestor: a link inside the
  // workspace must not let a write land outside it.
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const realRoot = realpathSync(root);
      const relReal = path.relative(realRoot, real);
      if (relReal.startsWith("..") || path.isAbsolute(relReal)) throw new ToolError(`Path ${p} resolves outside the workspace.`);
      break;
    } catch (e) {
      if (e instanceof ToolError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { abs, rel };
}

export interface EditArgs {
  path: string;
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
  explanation?: string;
}

export interface NewFileArgs {
  path: string;
  content: string;
  explanation?: string;
}

/**
 * Canonical form of write-tool arguments. The approval handler (which sees the
 * model's raw tool call) and the MCP handler (which sees parsed arguments)
 * both key the reviewed proposal by this, so only an exactly reviewed edit can
 * be written.
 */
export function editKey(root: string, toolName: "propose_edit" | "propose_new_file", args: EditArgs | NewFileArgs): string {
  const { rel } = resolveInside(root, args.path);
  if (toolName === "propose_edit") {
    const a = args as EditArgs;
    return argsKey(toolName, {
      path: rel,
      edits: (a.edits || []).map((e) => ({ o: e.old_string, n: e.new_string, r: Boolean(e.replace_all) })),
    });
  }
  return argsKey(toolName, { path: rel, content: (args as NewFileArgs).content });
}

const MAX_READ_LINES = 250;

export async function readFileTool(host: ToolHost, a: { path: string; start_line?: number; end_line?: number }): Promise<string> {
  const { abs, rel } = resolveInside(host.root, a.path);
  const text = await host.fs.read(abs);
  if (text === null) {
    const similar = [...host.index.files.keys()].filter((f) => f.endsWith(path.posix.basename(rel))).slice(0, 5);
    throw new ToolError(`${rel} does not exist.${similar.length ? ` Did you mean: ${similar.join(", ")}?` : ""}`);
  }
  const lines = text.split("\n");
  const start = Math.max(1, a.start_line ?? 1);
  const end = Math.min(lines.length, a.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
    .join("\n");
  const more = end < lines.length ? `\n... ${lines.length - end} more lines; call read_file with start_line=${end + 1} to continue.` : "";
  return `${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`;
}

export function listFilesTool(host: ToolHost, a: { dir?: string; contains?: string }): string {
  const dir = a.dir ? resolveInside(host.root, a.dir).rel.replace(/\/$/, "") : "";
  const needle = (a.contains || "").toLowerCase();
  const files = [...host.index.files.keys()]
    .filter((f) => (!dir || f.startsWith(dir + "/")) && (!needle || f.toLowerCase().includes(needle)))
    .sort();
  const shown = files.slice(0, 300);
  return `${files.length} files${files.length > shown.length ? ` (first ${shown.length})` : ""}:\n${shown.join("\n")}`;
}

export function searchCodeTool(host: ToolHost, a: { query: string; regex?: boolean; path_contains?: string; max_results?: number }): string {
  if (!a.query) throw new ToolError("query is required");
  let re: RegExp;
  try {
    re = a.regex ? new RegExp(a.query, "i") : new RegExp(a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch (e) {
    throw new ToolError(`Invalid regex: ${(e as Error).message}`);
  }
  const max = Math.min(a.max_results ?? 50, 200);
  const hits: string[] = [];
  let total = 0;
  for (const f of [...host.index.files.values()].sort((x, y) => x.path.localeCompare(y.path))) {
    if (a.path_contains && !f.path.includes(a.path_contains)) continue;
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        total++;
        if (hits.length < max) hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  }
  return total ? `${total} matches${total > hits.length ? ` (showing ${hits.length})` : ""}\n${hits.join("\n")}` : `No matches for ${a.query}.`;
}

export function findSymbolTool(host: ToolHost, a: { name: string }): string {
  const defs = host.index.findSymbol(a.name);
  if (!defs.length) {
    const lower = a.name.toLowerCase().split(".").pop()!;
    const near = [...host.index.symbolsByName.keys()].filter((k) => k.includes(lower) || lower.includes(k)).slice(0, 8);
    return `No definition of ${a.name} exists in this repository.${near.length ? ` Similar names: ${near.join(", ")}` : ""}`;
  }
  const word = new RegExp(`\\b${a.name.split(".").pop()!.replace(/[^\w]/g, "")}\\b`);
  let refs = 0;
  for (const f of host.index.files.values()) for (const l of f.text.split("\n")) if (word.test(l)) refs++;
  return (
    defs
      .slice(0, 15)
      .map((d) => `${d.file}:${d.line}-${d.endLine} ${d.kind}${d.parent ? ` in ${d.parent}` : ""}: ${d.signature}`)
      .join("\n") + `\n(${refs} lines reference this name)`
  );
}

export function retrieveContextTool(host: ToolHost, a: { query: string; budget_tokens?: number; mentions?: string[] }): string {
  const budget = Math.min(Math.max(a.budget_tokens ?? host.budgetTokens(), 500), 20000);
  const mentions = (a.mentions || []).map((m) => resolveInside(host.root, m).rel);
  const report = retrieve(host.index, a.query, { budget, mentions });
  host.onContextReport(report, "agent");
  return renderReport(host.index, report, true);
}

export function declarePlanTool(host: ToolHost, a: Plan): string {
  const steps = (a.steps || []).map((s) => ({ file: resolveInside(host.root, s.file).rel, change: s.change }));
  host.onPlan({ summary: a.summary, steps });
  return `Plan recorded (${steps.length} files). Edits to files outside this plan will be flagged to the user during review.`;
}

export async function proposeWriteTool(
  host: ToolHost,
  toolName: "propose_edit" | "propose_new_file",
  a: EditArgs | NewFileArgs,
): Promise<string> {
  const key = editKey(host.root, toolName, a);
  const p = host.review.takeApproved(key);
  if (!p) {
    throw new ToolError(
      "This change has not been approved in ForgePilot's review, so nothing was written. Every write must go through the review the user sees.",
    );
  }
  if (host.isCancelled()) {
    host.review.setStatus(p.id, "discarded");
    throw new ToolError("The run was cancelled before this change was applied; nothing was written.");
  }
  try {
    const r = await applyApprovedProposal(p, host.fs, host.journal);
    await host.index.refresh(p.relPath);
    const applied = r.applied.map((id) => summarizeHunk(p.hunks[id]));
    const rejected = r.rejected.map((id) => summarizeHunk(p.hunks[id]));
    const summary =
      `Wrote ${p.relPath}: applied ${applied.length} of ${p.hunks.length} hunks.` +
      (rejected.length ? `\nThe user REJECTED: ${rejected.join("; ")}. Do not re-propose these unless the user asks.` : "") +
      (r.reanchored ? "\nThe user edited this file during review; accepted hunks were re-anchored onto their version." : "");
    host.onApplied(summary);
    return summary;
  } catch (e) {
    if (e instanceof ReviewConflict) {
      host.review.setStatus(p.id, "failed");
      throw new ToolError(e.message);
    }
    throw e;
  }
}

export async function runCommandTool(host: ToolHost, a: { command: string; timeout_seconds?: number }): Promise<string> {
  if (!a.command?.trim()) throw new ToolError("command is required");
  if (host.isCancelled()) throw new ToolError("The run was cancelled; command not started.");
  const timeoutMs = Math.min(Math.max(a.timeout_seconds ?? 120, 5), 600) * 1000;
  const r = await host.runCommand(a.command, timeoutMs);
  const clip = (s: string) => (s.length > 6000 ? `${s.slice(0, 2500)}\n... [${s.length - 5000} chars omitted] ...\n${s.slice(-2500)}` : s);
  return [
    `$ ${a.command}`,
    `exit code: ${r.code ?? "none"}${r.timedOut ? " (timed out)" : ""}${r.killed ? " (killed: run cancelled)" : ""} in ${r.ms} ms`,
    r.stdout ? `stdout:\n${clip(r.stdout)}` : "stdout: (empty)",
    r.stderr ? `stderr:\n${clip(r.stderr)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
