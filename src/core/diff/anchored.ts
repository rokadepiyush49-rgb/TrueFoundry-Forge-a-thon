import { Hunk, splitLines, joinLines } from "./hunks";

/**
 * A hunk captured with surrounding context so it can be located again in a
 * file that has drifted (the user kept typing elsewhere). Used for undoing a
 * single hunk and for applying accepted hunks after a concurrent edit.
 */
export interface AnchoredHunk {
  hunkId: number;
  before: string[]; // lines that were there before the change
  after: string[]; // lines that are there after the change
  ctxBefore: string[];
  ctxAfter: string[];
}

const CONTEXT = 3;

/**
 * Anchor hunks against the text they produce. `afterLines` is the text after the
 * hunks were applied, and `positions` are each hunk's 0-based start in that text.
 */
export function anchorHunks(
  hunks: Hunk[],
  afterText: string,
  positions: Map<number, number>,
): AnchoredHunk[] {
  const lines = splitLines(afterText).lines;
  return hunks.map((h) => {
    const start = positions.get(h.id)!;
    const end = start + h.newLines.length;
    return {
      hunkId: h.id,
      before: h.oldLines,
      after: h.newLines,
      ctxBefore: lines.slice(Math.max(0, start - CONTEXT), start),
      ctxAfter: lines.slice(end, end + CONTEXT),
    };
  });
}

function findUnique(lines: string[], block: string[]): number | "none" | "many" {
  if (block.length === 0) return "none";
  let found = -1;
  for (let i = 0; i + block.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (found !== -1) return "many";
      found = i;
    }
  }
  return found === -1 ? "none" : found;
}

export class AnchorConflict extends Error {}

/**
 * Replace `from` with `to` at the anchored location in `text`. Tries the block
 * with full context first, then with shrinking context. Throws AnchorConflict
 * when the location cannot be found unambiguously; never guesses.
 */
export function replaceAnchored(
  text: string,
  anchor: { ctxBefore: string[]; ctxAfter: string[] },
  from: string[],
  to: string[],
): string {
  const { lines, eol } = splitLines(text);
  for (let k = CONTEXT; k >= 0; k--) {
    const cb = anchor.ctxBefore.slice(Math.max(0, anchor.ctxBefore.length - k));
    const ca = anchor.ctxAfter.slice(0, k);
    const block = [...cb, ...from, ...ca];
    if (block.length === 0) continue;
    const at = findUnique(lines, block);
    if (typeof at === "number") {
      const out = [
        ...lines.slice(0, at + cb.length),
        ...to,
        ...lines.slice(at + cb.length + from.length),
      ];
      return joinLines(out, eol);
    }
    if (at === "many" && k === 0) break;
  }
  throw new AnchorConflict(
    "The code around this change was modified after it was applied, so it cannot be located unambiguously.",
  );
}
