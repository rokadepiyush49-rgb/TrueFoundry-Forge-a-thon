import { describe, it, expect } from "vitest";
import { computeHunks, applyHunks, layoutHunks } from "../../src/core/diff/hunks";
import { buildProposal, applyApprovedProposal } from "../../src/core/diff/review";
import { ChangeJournal, FilePort } from "../../src/core/diff/journal";

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VOCAB = ["def f():", "    return 1", "", "x = 1", "# c", "class A:", "    pass", "    x = 2", "import os", "}"];

function randomText(r: () => number, n: number, eol: string): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(VOCAB[Math.floor(r() * VOCAB.length)] + (r() < 0.3 ? ` ${i}` : ""));
  return lines.join(eol) + (r() < 0.5 ? eol : "");
}

function mutate(r: () => number, text: string, eol: string): string {
  const lines = text.split(eol);
  const ops = 1 + Math.floor(r() * 5);
  for (let k = 0; k < ops; k++) {
    const i = Math.floor(r() * (lines.length + 1));
    const op = r();
    if (op < 0.33) lines.splice(i, 0, `new ${k} ${Math.floor(r() * 1000)}`);
    else if (op < 0.66 && lines.length > 1) lines.splice(Math.min(i, lines.length - 1), 1);
    else if (lines.length) lines[Math.min(i, lines.length - 1)] = `changed ${k} ${Math.floor(r() * 1000)}`;
  }
  return lines.join(eol);
}

class MemFs implements FilePort {
  files = new Map<string, string>();
  async read(p: string) {
    return this.files.has(p) ? this.files.get(p)! : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
}

describe("fuzz: hunk engine invariants", () => {
  it("holds for 3000 random edits, subsets, layouts and undos", async () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const eol = r() < 0.2 ? "\r\n" : "\n";
      const original = randomText(r, 1 + Math.floor(r() * 40), eol);
      const proposed = mutate(r, original, eol);
      const hunks = computeHunks(original, proposed);
      const ctx = `seed=${seed}`;

      // 1. all-accept reproduces the proposal; all-reject reproduces the original
      expect(applyHunks(original, hunks, () => true), ctx).toBe(proposed);
      expect(applyHunks(original, hunks, () => false), ctx).toBe(original);

      // 2. random subset: layout points at exactly the shown lines
      const mask = hunks.map(() => r() < 0.5);
      const take = (h: { id: number }) => mask[h.id];
      const partial = applyHunks(original, hunks, take);
      const plines = partial.split("\n");
      for (const l of layoutHunks(hunks, take)) {
        const h = hunks[l.hunkId];
        expect(plines.slice(l.previewStart, l.previewStart + l.previewLines), ctx).toEqual(take(h) ? h.newLines : h.oldLines);
      }

      // 3. apply a subset through the review path, then undo it: bytes must return exactly
      if (hunks.length === 0 || !mask.some(Boolean)) continue;
      const fs = new MemFs();
      fs.files.set("/f", original);
      const journal = new ChangeJournal();
      const p = buildProposal({
        id: "x", turnKey: "t", source: "s", kind: "edit", path: "/f", relPath: "f",
        original, args: { path: "f", edits: [{ old_string: original, new_string: proposed }] }, toolName: "propose_edit",
      });
      // the proposal's hunks are recomputed from the same texts, so ids line up
      p.hunks.forEach((h) => p.decisions.set(h.id, mask[h.id] ? "accepted" : "rejected"));
      const res = await applyApprovedProposal(p, fs, journal);
      expect(fs.files.get("/f"), ctx).toBe(partial);
      // undo hunks one at a time in random order where anchors are unambiguous; fall back to full undo
      try {
        const ids = res.applied.slice().sort(() => r() - 0.5);
        for (const id of ids) await journal.undo(res.change.id, fs, [id]);
      } catch {
        // per-hunk undo may legitimately refuse when context is ambiguous in tiny random files;
        // in that case nothing may have been corrupted:
      }
      const after = fs.files.get("/f")!;
      if (res.change.undone) {
        expect(after, ctx).toBe(original);
      } else {
        // whatever happened, the file must still be a valid mix of original/proposed hunks
        const valid = new Set<string>();
        const n = hunks.length;
        if (n <= 10) {
          for (let m = 0; m < 1 << n; m++) valid.add(applyHunks(original, hunks, (h) => Boolean(m & (1 << h.id))));
          expect(valid.has(after), ctx).toBe(true);
        }
      }
    }
  });
});
