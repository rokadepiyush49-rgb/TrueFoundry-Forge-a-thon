import { AnchoredHunk, AnchorConflict, replaceAnchored } from "./anchored";

/** Minimal file access so the journal can be tested without VS Code. */
export interface FilePort {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface AppliedChange {
  id: string;
  path: string;
  /** Which request produced this change (session/turn), for provenance and turn-level undo. */
  turnKey: string;
  /** Human-readable provenance, e.g. the user's instruction. */
  source: string;
  before: string | null; // null: the file did not exist
  after: string;
  hunks: AnchoredHunk[];
  undoneHunks: Set<number>;
  undone: boolean;
  time: number;
}

export class UndoConflict extends Error {}

let seq = 0;

/**
 * Journal of every change ForgePilot wrote to disk. Undo is computed fully in
 * memory first and only written if every step succeeds, so an undo either
 * happens completely or not at all, and it never overwrites edits the user
 * made after the change was applied.
 */
export class ChangeJournal {
  private changes: AppliedChange[] = [];
  private listeners: Array<() => void> = [];

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  record(c: Omit<AppliedChange, "id" | "undoneHunks" | "undone" | "time">): AppliedChange {
    const change: AppliedChange = {
      ...c,
      id: `chg-${Date.now().toString(36)}-${++seq}`,
      undoneHunks: new Set(),
      undone: false,
      time: Date.now(),
    };
    this.changes.push(change);
    this.emit();
    return change;
  }

  list(): AppliedChange[] {
    return [...this.changes];
  }

  get(id: string): AppliedChange | undefined {
    return this.changes.find((c) => c.id === id);
  }

  lastActive(): AppliedChange | undefined {
    return [...this.changes].reverse().find((c) => !c.undone);
  }

  /** Compute the text after undoing the given hunks of a change, without writing. */
  private computeUndo(change: AppliedChange, current: string | null, hunkIds: number[]): string | null {
    const remaining = change.hunks.filter((h) => !change.undoneHunks.has(h.hunkId));
    const all = remaining.every((h) => hunkIds.includes(h.hunkId));
    if (current === null) {
      throw new UndoConflict(`${change.path} no longer exists; nothing to undo.`);
    }
    // Fast path: file unchanged since we wrote it and the whole change is being undone.
    if (all && change.undoneHunks.size === 0 && current === change.after) {
      return change.before;
    }
    let text = current;
    // Undo bottom-up so earlier anchors stay valid.
    const targets = remaining
      .filter((h) => hunkIds.includes(h.hunkId))
      .sort((a, b) => b.hunkId - a.hunkId);
    for (const h of targets) {
      try {
        text = replaceAnchored(text, h, h.after, h.before);
      } catch (e) {
        if (e instanceof AnchorConflict) {
          throw new UndoConflict(
            `Cannot undo hunk ${h.hunkId + 1} in ${change.path}: ${e.message} Your later edits were left untouched.`,
          );
        }
        throw e;
      }
    }
    if (all && change.before === null && text.trim() === "") return null;
    return text;
  }

  async undo(id: string, fs: FilePort, hunkIds?: number[]): Promise<AppliedChange> {
    const change = this.get(id);
    if (!change) throw new Error(`Unknown change ${id}`);
    if (change.undone) throw new UndoConflict("This change has already been undone.");
    const ids = hunkIds ?? change.hunks.map((h) => h.hunkId).filter((x) => !change.undoneHunks.has(x));
    const current = await fs.read(change.path);
    const next = this.computeUndo(change, current, ids);
    if (next === null) await fs.remove(change.path);
    else await fs.write(change.path, next);
    ids.forEach((x) => change.undoneHunks.add(x));
    change.undone = change.hunks.every((h) => change.undoneHunks.has(h.hunkId));
    this.emit();
    return change;
  }

  /**
   * Undo every change from one request, newest first, as a transaction: all
   * target texts are computed before anything is written.
   */
  async undoTurn(turnKey: string, fs: FilePort): Promise<AppliedChange[]> {
    const targets = this.changes.filter((c) => c.turnKey === turnKey && !c.undone).reverse();
    const pending = new Map<string, string | null>();
    const plan: Array<{ change: AppliedChange; next: string | null }> = [];
    for (const change of targets) {
      const current = pending.has(change.path) ? pending.get(change.path)! : await fs.read(change.path);
      const ids = change.hunks.map((h) => h.hunkId).filter((x) => !change.undoneHunks.has(x));
      const next = this.computeUndo(change, current, ids);
      pending.set(change.path, next);
      plan.push({ change, next });
    }
    for (const [path, next] of pending) {
      if (next === null) await fs.remove(path);
      else await fs.write(path, next);
    }
    for (const { change } of plan) {
      change.hunks.forEach((h) => change.undoneHunks.add(h.hunkId));
      change.undone = true;
    }
    this.emit();
    return plan.map((p) => p.change);
  }
}
