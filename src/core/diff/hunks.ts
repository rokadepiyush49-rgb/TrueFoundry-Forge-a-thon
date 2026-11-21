import { diffArrays } from "diff";

/**
 * A hunk is one contiguous block of change between an original text and a
 * proposed text, expressed against the ORIGINAL line array:
 *   replace original lines [oldIndex, oldIndex + oldLines.length) with newLines.
 * Indices are 0-based. A pure insertion has oldLines = []; a pure deletion has
 * newLines = [].
 */
export interface Hunk {
  id: number;
  oldIndex: number;
  oldLines: string[];
  newLines: string[];
}

export type HunkDecision = "pending" | "accepted" | "rejected";

export interface SplitText {
  lines: string[];
  eol: "\n";
}

/**
 * Split on "\n" only. A "\r" stays attached to its line, so CRLF, LF and
 * mixed-ending files all round-trip byte-for-byte (found by the fuzz test:
 * normalizing to the "dominant" ending rewrote lone LFs in mixed files).
 */
export function splitLines(text: string): SplitText {
  return { lines: text.split("\n"), eol: "\n" };
}

export function joinLines(lines: string[], _eol: "\n" = "\n"): string {
  return lines.join("\n");
}

/** Compute change hunks with no context lines; each contiguous change block is one hunk. */
export function computeHunks(original: string, proposed: string): Hunk[] {
  const a = splitLines(original).lines;
  const b = splitLines(proposed).lines;
  const parts = diffArrays(a, b);
  const hunks: Hunk[] = [];
  let oldIndex = 0;
  let current: Hunk | null = null;
  const flush = () => {
    if (current && (current.oldLines.length || current.newLines.length)) {
      current.id = hunks.length;
      hunks.push(current);
    }
    current = null;
  };
  for (const part of parts) {
    const values = part.value as string[];
    if (!part.added && !part.removed) {
      flush();
      oldIndex += values.length;
      continue;
    }
    if (!current) current = { id: -1, oldIndex, oldLines: [], newLines: [] };
    if (part.removed) {
      current.oldLines.push(...values);
      oldIndex += values.length;
    } else {
      current.newLines.push(...values);
    }
  }
  flush();
  return hunks;
}

/**
 * Rebuild text from the original, taking each hunk's new lines only when
 * `take(hunk)` returns true. Hunks must come from computeHunks(original, ...).
 */
export function applyHunks(original: string, hunks: Hunk[], take: (h: Hunk) => boolean): string {
  const { lines, eol } = splitLines(original);
  const out: string[] = [];
  let cursor = 0;
  for (const h of [...hunks].sort((x, y) => x.oldIndex - y.oldIndex)) {
    if (h.oldIndex < cursor) throw new Error(`Overlapping hunk ${h.id}`);
    out.push(...lines.slice(cursor, h.oldIndex));
    const oldSlice = lines.slice(h.oldIndex, h.oldIndex + h.oldLines.length);
    if (oldSlice.join("\n") !== h.oldLines.join("\n")) {
      throw new Error(`Hunk ${h.id} does not match the original text at line ${h.oldIndex + 1}`);
    }
    out.push(...(take(h) ? h.newLines : h.oldLines));
    cursor = h.oldIndex + h.oldLines.length;
  }
  out.push(...lines.slice(cursor));
  return joinLines(out, eol);
}

export interface HunkLayout {
  hunkId: number;
  /** 0-based line in the preview text where this hunk's visible lines start. */
  previewStart: number;
  /** number of lines this hunk occupies in the preview (0 for a deletion). */
  previewLines: number;
}

/**
 * Layout of hunks inside a preview built with applyHunks(original, hunks, take).
 * Used to anchor per-hunk CodeLens actions in the proposed side of the diff editor.
 */
export function layoutHunks(hunks: Hunk[], take: (h: Hunk) => boolean): HunkLayout[] {
  let delta = 0;
  const result: HunkLayout[] = [];
  for (const h of [...hunks].sort((x, y) => x.oldIndex - y.oldIndex)) {
    const shown = take(h) ? h.newLines : h.oldLines;
    result.push({ hunkId: h.id, previewStart: h.oldIndex + delta, previewLines: shown.length });
    delta += shown.length - h.oldLines.length;
  }
  return result;
}

/** Original line range (1-based, inclusive) touched by a hunk; insertions report the line they follow. */
export function hunkOriginalRange(h: Hunk): { start: number; end: number } {
  if (h.oldLines.length === 0) return { start: h.oldIndex, end: h.oldIndex };
  return { start: h.oldIndex + 1, end: h.oldIndex + h.oldLines.length };
}

export function summarizeHunk(h: Hunk): string {
  const r = hunkOriginalRange(h);
  return `hunk ${h.id + 1}: lines ${r.start}-${r.end} (-${h.oldLines.length} +${h.newLines.length})`;
}
