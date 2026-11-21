import { Hunk, HunkDecision, applyHunks, computeHunks, layoutHunks, hunkOriginalRange } from "./hunks";
import { applySearchReplace, SearchReplaceEdit } from "./edits";
import { anchorHunks, replaceAnchored, AnchorConflict } from "./anchored";
import { ChangeJournal, FilePort, AppliedChange } from "./journal";

export type ProposalStatus = "reviewing" | "approved" | "denied" | "applied" | "discarded" | "failed";

export interface EditScope {
  /** 1-based inclusive line range the user selected (inline edit). */
  startLine: number;
  endLine: number;
}

export interface Proposal {
  /** TrueForge tool call id that requested this change. */
  id: string;
  turnKey: string;
  source: string;
  kind: "edit" | "create";
  path: string; // absolute
  relPath: string;
  original: string | null;
  proposed: string;
  hunks: Hunk[];
  decisions: Map<number, HunkDecision>;
  /** Warnings shown next to a specific hunk, e.g. "outside your selection". */
  hunkWarnings: Map<number, string[]>;
  warnings: string[];
  argsKey: string;
  status: ProposalStatus;
  createdAt: number;
}

export interface ProposeEditArgs {
  path: string;
  edits?: SearchReplaceEdit[];
  content?: string; // for new files
}

/** Stable key for tool arguments so the MCP call can be matched to its reviewed approval. */
export function argsKey(toolName: string, args: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = canon((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return `${toolName}:${JSON.stringify(canon(args))}`;
}

export function buildProposal(opts: {
  id: string;
  turnKey: string;
  source: string;
  kind: "edit" | "create";
  path: string;
  relPath: string;
  original: string | null;
  args: ProposeEditArgs;
  toolName: string;
  scope?: EditScope;
}): Proposal {
  let proposed: string;
  if (opts.kind === "create") {
    if (opts.original !== null) throw new Error(`${opts.relPath} already exists; use propose_edit to change it.`);
    proposed = opts.args.content ?? "";
  } else {
    if (opts.original === null) throw new Error(`${opts.relPath} does not exist; use propose_new_file to create it.`);
    proposed = applySearchReplace(opts.original, opts.args.edits ?? []);
  }
  const base = opts.original ?? "";
  const hunks = computeHunks(base, proposed);
  if (hunks.length === 0) throw new Error("The proposed edit produces no change.");
  const hunkWarnings = new Map<number, string[]>();
  if (opts.scope) {
    for (const h of hunks) {
      const r = hunkOriginalRange(h);
      const inside = r.start >= opts.scope.startLine - 1 && r.end <= opts.scope.endLine + 1;
      if (!inside) {
        hunkWarnings.set(h.id, [
          `Outside your selection (lines ${opts.scope.startLine}-${opts.scope.endLine}); this hunk touches lines ${r.start}-${r.end}.`,
        ]);
      }
    }
  }
  return {
    id: opts.id,
    turnKey: opts.turnKey,
    source: opts.source,
    kind: opts.kind,
    path: opts.path,
    relPath: opts.relPath,
    original: opts.original,
    proposed,
    hunks,
    decisions: new Map(hunks.map((h) => [h.id, "pending" as HunkDecision])),
    hunkWarnings,
    warnings: [],
    argsKey: argsKey(opts.toolName, opts.args),
    status: "reviewing",
    createdAt: Date.now(),
  };
}

export function isFullyDecided(p: Proposal): boolean {
  return [...p.decisions.values()].every((d) => d !== "pending");
}

export function acceptedHunks(p: Proposal): Hunk[] {
  return p.hunks.filter((h) => p.decisions.get(h.id) === "accepted");
}

/** Text shown on the proposed side while reviewing: pending and accepted hunks applied, rejected ones dropped. */
export function previewText(p: Proposal): string {
  return applyHunks(p.original ?? "", p.hunks, (h) => p.decisions.get(h.id) !== "rejected");
}

export function previewLayout(p: Proposal) {
  return layoutHunks(p.hunks, (h) => p.decisions.get(h.id) !== "rejected");
}

export class ReviewConflict extends Error {}

/**
 * Write the accepted hunks of an approved proposal. Everything is computed in
 * memory first; the file is written once, so a write is never half-applied.
 * If the user edited the file during review, accepted hunks are re-anchored
 * onto the new text; if that is ambiguous, nothing is written.
 */
export async function applyApprovedProposal(
  p: Proposal,
  fs: FilePort,
  journal: ChangeJournal,
): Promise<{ change: AppliedChange; applied: number[]; rejected: number[]; reanchored: boolean }> {
  const accepted = acceptedHunks(p);
  const rejected = p.hunks.filter((h) => p.decisions.get(h.id) !== "accepted").map((h) => h.id);
  if (accepted.length === 0) throw new Error("No hunks were accepted.");
  const current = await fs.read(p.path);
  const take = (h: Hunk) => p.decisions.get(h.id) === "accepted";
  let next: string;
  let reanchored = false;
  if (current === p.original) {
    next = applyHunks(p.original ?? "", p.hunks, take);
  } else {
    if (p.original === null || current === null) {
      throw new ReviewConflict(`${p.relPath} was created or deleted during review; nothing was written.`);
    }
    // The user edited the file while reviewing. Re-locate each accepted hunk in the new text.
    const fullAfter = applyHunks(p.original, p.hunks, take);
    const layout = layoutHunks(p.hunks, take);
    const positions = new Map(layout.map((l) => [l.hunkId, l.previewStart]));
    // anchor using the ORIGINAL text context (before side) for forward application
    const beforeAnchors = anchorHunks(
      p.hunks.map((h) => ({ ...h, newLines: h.oldLines })),
      p.original,
      new Map(p.hunks.map((h) => [h.id, h.oldIndex])),
    );
    void fullAfter;
    void positions;
    let text = current;
    for (const h of [...accepted].sort((a, b) => b.oldIndex - a.oldIndex)) {
      const a = beforeAnchors.find((x) => x.hunkId === h.id)!;
      try {
        text = replaceAnchored(text, a, h.oldLines, h.newLines);
      } catch (e) {
        if (e instanceof AnchorConflict) {
          throw new ReviewConflict(
            `${p.relPath} changed during review and hunk ${h.id + 1} can no longer be placed safely; nothing was written.`,
          );
        }
        throw e;
      }
    }
    next = text;
    reanchored = true;
  }
  // Anchor accepted hunks against the text we are about to write (for undo).
  const afterAnchors = (() => {
    if (!reanchored) {
      const layout = layoutHunks(p.hunks, take);
      const positions = new Map(layout.map((l) => [l.hunkId, l.previewStart]));
      return anchorHunks(accepted, next, positions);
    }
    // After re-anchoring, find each hunk's new block in the written text.
    const lines = next.replace(/\r\n/g, "\n").split("\n");
    const positions = new Map<number, number>();
    for (const h of accepted) {
      const idx = lines.findIndex((_, i) => h.newLines.every((l, j) => lines[i + j] === l));
      positions.set(h.id, idx < 0 ? 0 : idx);
    }
    return anchorHunks(accepted, next, positions);
  })();
  await fs.write(p.path, next);
  const change = journal.record({
    path: p.path,
    turnKey: p.turnKey,
    source: p.source,
    before: current,
    after: next,
    hunks: afterAnchors,
  });
  p.status = "applied";
  return { change, applied: accepted.map((h) => h.id), rejected, reanchored };
}

type Listener = (p: Proposal) => void;

/** In-memory registry of proposals awaiting or having completed review. */
export class ReviewStore {
  private proposals = new Map<string, Proposal>();
  private listeners: Listener[] = [];

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(p: Proposal): void {
    for (const fn of this.listeners) fn(p);
  }

  add(p: Proposal): void {
    this.proposals.set(p.id, p);
    this.emit(p);
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  all(): Proposal[] {
    return [...this.proposals.values()];
  }

  reviewing(): Proposal[] {
    return this.all().filter((p) => p.status === "reviewing");
  }

  reviewingForPath(path: string): Proposal | undefined {
    return this.reviewing().find((p) => p.path === path);
  }

  decide(id: string, hunkId: number, decision: HunkDecision): Proposal {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`Unknown proposal ${id}`);
    if (p.status !== "reviewing") throw new Error(`Proposal ${id} is no longer under review.`);
    if (!p.decisions.has(hunkId)) throw new Error(`Unknown hunk ${hunkId}`);
    p.decisions.set(hunkId, decision);
    this.emit(p);
    return p;
  }

  decideAll(id: string, decision: HunkDecision): Proposal {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`Unknown proposal ${id}`);
    for (const [k, v] of p.decisions) if (v === "pending") p.decisions.set(k, decision);
    this.emit(p);
    return p;
  }

  setStatus(id: string, status: ProposalStatus): void {
    const p = this.proposals.get(id);
    if (!p) return;
    p.status = status;
    this.emit(p);
  }

  /** Approved proposal whose arguments match an incoming MCP tool call. */
  takeApproved(key: string): Proposal | undefined {
    return this.all().find((p) => p.status === "approved" && p.argsKey === key);
  }

  /** Discard every unapplied proposal of a request (used on cancellation). */
  discardTurn(turnKey: string): Proposal[] {
    const out: Proposal[] = [];
    for (const p of this.all()) {
      if (p.turnKey === turnKey && (p.status === "reviewing" || p.status === "approved")) {
        p.status = "discarded";
        out.push(p);
        this.emit(p);
      }
    }
    return out;
  }
}
