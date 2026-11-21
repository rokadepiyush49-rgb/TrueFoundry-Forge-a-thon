import { describe, it, expect } from "vitest";
import { computeHunks, applyHunks, layoutHunks, splitLines } from "../../src/core/diff/hunks";
import { applySearchReplace, EditError } from "../../src/core/diff/edits";
import {
  buildProposal,
  applyApprovedProposal,
  ReviewStore,
  ReviewConflict,
  previewText,
  previewLayout,
  isFullyDecided,
} from "../../src/core/diff/review";
import { ChangeJournal, FilePort, UndoConflict } from "../../src/core/diff/journal";

class MemFs implements FilePort {
  files = new Map<string, string>();
  writes = 0;
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.files.set(k, v);
  }
  async read(p: string) {
    return this.files.has(p) ? this.files.get(p)! : null;
  }
  async write(p: string, c: string) {
    this.writes++;
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.writes++;
    this.files.delete(p);
  }
}

const SRC = ["def a():", "    return 1", "", "def b():", "    return 2", "", "def c():", "    return 3", ""].join("\n");

function propose(original: string | null, edits: { old_string: string; new_string: string }[], extra = {}) {
  return buildProposal({
    id: "call-1",
    turnKey: "t1",
    source: "test",
    kind: original === null ? "create" : "edit",
    path: "/w/f.py",
    relPath: "f.py",
    original,
    args: { path: "f.py", edits },
    toolName: "propose_edit",
    ...extra,
  });
}

describe("hunks", () => {
  it("round-trips: accepting every hunk reproduces the proposal exactly", () => {
    const proposed = SRC.replace("return 1", "return 10").replace("def c():", "def c(x):\n    # new");
    const hunks = computeHunks(SRC, proposed);
    expect(hunks.length).toBe(2);
    expect(applyHunks(SRC, hunks, () => true)).toBe(proposed);
    expect(applyHunks(SRC, hunks, () => false)).toBe(SRC);
  });

  it("applies any subset of hunks independently", () => {
    const proposed = SRC.replace("return 1", "return 10").replace("return 2", "return 20").replace("return 3", "return 30");
    const hunks = computeHunks(SRC, proposed);
    expect(hunks.length).toBe(3);
    for (let mask = 0; mask < 8; mask++) {
      const out = applyHunks(SRC, hunks, (h) => Boolean(mask & (1 << h.id)));
      expect(out.includes("return 10")).toBe(Boolean(mask & 1));
      expect(out.includes("return 20")).toBe(Boolean(mask & 2));
      expect(out.includes("return 30")).toBe(Boolean(mask & 4));
    }
  });

  it("preserves CRLF line endings and a missing trailing newline", () => {
    const crlf = "x = 1\r\ny = 2\r\nz = 3";
    const proposed = "x = 1\r\ny = 22\r\nz = 3";
    const hunks = computeHunks(crlf, proposed);
    expect(applyHunks(crlf, hunks, () => true)).toBe(proposed);
    expect(applyHunks(crlf, hunks, () => false)).toBe(crlf);
    // mixed endings must survive byte-for-byte when every hunk is rejected or accepted
    const mixed = "a\r\nb\nc\r\nd";
    const mixedNew = "a\r\nB\nc\r\nd\n";
    const mh = computeHunks(mixed, mixedNew);
    expect(applyHunks(mixed, mh, () => false)).toBe(mixed);
    expect(applyHunks(mixed, mh, () => true)).toBe(mixedNew);
    expect(splitLines(crlf).lines.length).toBe(3);
  });

  it("handles insertion at the very start and end, and deleting everything", () => {
    const start = "first\n" + SRC;
    expect(applyHunks(SRC, computeHunks(SRC, start), () => true)).toBe(start);
    const end = SRC + "tail\n";
    expect(applyHunks(SRC, computeHunks(SRC, end), () => true)).toBe(end);
    expect(applyHunks(SRC, computeHunks(SRC, ""), () => true)).toBe("");
  });

  it("refuses to apply hunks to text they were not computed from", () => {
    const hunks = computeHunks(SRC, SRC.replace("return 2", "return 20"));
    expect(() => applyHunks(SRC.replace("return 2", "return 99"), hunks, () => true)).toThrow(/does not match/);
  });

  it("layout anchors each hunk at the right line of the preview", () => {
    const proposed = SRC.replace("def a():", "import os\n\ndef a():").replace("return 3", "return 33");
    const hunks = computeHunks(SRC, proposed);
    const layout = layoutHunks(hunks, () => true);
    const lines = proposed.split("\n");
    for (const l of layout) {
      const h = hunks[l.hunkId];
      expect(lines.slice(l.previewStart, l.previewStart + l.previewLines)).toEqual(h.newLines);
    }
  });
});

describe("search/replace edits", () => {
  it("rejects an edit to code that does not exist, with a hint", () => {
    try {
      applySearchReplace(SRC, [{ old_string: "def d():\n    return 4", new_string: "x" }]);
      throw new Error("should have failed");
    } catch (e) {
      expect(e).toBeInstanceOf(EditError);
      expect((e as Error).message).toMatch(/not found/);
    }
  });

  it("rejects an ambiguous anchor instead of guessing", () => {
    expect(() => applySearchReplace(SRC, [{ old_string: "    return", new_string: "    yield" }])).toThrow(/matches 3 places/);
  });

  it("does not interpret $ patterns in the replacement", () => {
    const out = applySearchReplace("a = 1\n", [{ old_string: "a = 1", new_string: "a = '$&$1'" }]);
    expect(out).toBe("a = '$&$1'\n");
  });

  it("keeps CRLF files CRLF", () => {
    const out = applySearchReplace("a = 1\r\nb = 2\r\n", [{ old_string: "b = 2", new_string: "b = 3\nc = 4" }]);
    expect(out).toBe("a = 1\r\nb = 3\r\nc = 4\r\n");
  });

  it("rejects no-op edits", () => {
    expect(() => applySearchReplace(SRC, [{ old_string: "return 1", new_string: "return 1" }])).toThrow(/identical/);
  });
});

describe("review + apply", () => {
  it("writes only accepted hunks, in a single write", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const journal = new ChangeJournal();
    const store = new ReviewStore();
    const p = propose(SRC, [
      { old_string: "return 1", new_string: "return 10" },
      { old_string: "return 3", new_string: "return 30" },
    ]);
    store.add(p);
    store.decide(p.id, 0, "accepted");
    expect(isFullyDecided(p)).toBe(false);
    store.decide(p.id, 1, "rejected");
    expect(isFullyDecided(p)).toBe(true);
    expect(previewText(p)).toContain("return 10");
    expect(previewText(p)).not.toContain("return 30");
    const r = await applyApprovedProposal(p, fs, journal);
    expect(r.applied).toEqual([0]);
    expect(r.rejected).toEqual([1]);
    expect(fs.writes).toBe(1);
    expect(fs.files.get("/w/f.py")).toBe(SRC.replace("return 1", "return 10"));
  });

  it("refuses to write when nothing was accepted", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const p = propose(SRC, [{ old_string: "return 1", new_string: "return 10" }]);
    p.decisions.set(0, "rejected");
    await expect(applyApprovedProposal(p, fs, new ChangeJournal())).rejects.toThrow(/No hunks/);
    expect(fs.writes).toBe(0);
  });

  it("re-anchors accepted hunks when the user typed elsewhere during review", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const p = propose(SRC, [{ old_string: "return 3", new_string: "return 30" }]);
    p.decisions.set(0, "accepted");
    // user adds a line at the top while the review is open
    fs.files.set("/w/f.py", "# user note\n" + SRC);
    const r = await applyApprovedProposal(p, fs, new ChangeJournal());
    expect(r.reanchored).toBe(true);
    expect(fs.files.get("/w/f.py")).toBe("# user note\n" + SRC.replace("return 3", "return 30"));
  });

  it("writes nothing when the user changed the exact region under review", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const p = propose(SRC, [{ old_string: "return 3", new_string: "return 30" }]);
    p.decisions.set(0, "accepted");
    const userVersion = SRC.replace("def c():\n    return 3", "def c():\n    return 'user'");
    fs.files.set("/w/f.py", userVersion);
    await expect(applyApprovedProposal(p, fs, new ChangeJournal())).rejects.toBeInstanceOf(ReviewConflict);
    expect(fs.files.get("/w/f.py")).toBe(userVersion);
  });

  it("flags hunks outside the selected range (scope guard)", () => {
    const p = propose(
      SRC,
      [
        { old_string: "return 1", new_string: "return 10" },
        { old_string: "return 3", new_string: "return 30" },
      ],
      { scope: { startLine: 1, endLine: 2 } },
    );
    expect(p.hunkWarnings.has(0)).toBe(false);
    expect(p.hunkWarnings.get(1)?.[0]).toMatch(/Outside your selection/);
  });

  it("creates new files and refuses to 'create' over an existing file", async () => {
    const fs = new MemFs();
    const p = buildProposal({
      id: "c2", turnKey: "t1", source: "s", kind: "create", path: "/w/new.py", relPath: "new.py",
      original: null, args: { path: "new.py", content: "print('hi')\n" }, toolName: "propose_new_file",
    });
    p.decisions.forEach((_, k) => p.decisions.set(k, "accepted"));
    await applyApprovedProposal(p, fs, new ChangeJournal());
    expect(fs.files.get("/w/new.py")).toBe("print('hi')\n");
    expect(() =>
      buildProposal({
        id: "c3", turnKey: "t1", source: "s", kind: "create", path: "/w/new.py", relPath: "new.py",
        original: "x", args: { path: "new.py", content: "y" }, toolName: "propose_new_file",
      }),
    ).toThrow(/already exists/);
  });

  it("preview layout always points at the hunk's visible lines", () => {
    const p = propose(SRC, [
      { old_string: "def a():", new_string: "import os\n\n\ndef a():" },
      { old_string: "return 2", new_string: "return 2\n    # two" },
    ]);
    p.decisions.set(0, "rejected");
    const prev = previewText(p).split("\n");
    for (const l of previewLayout(p)) {
      const h = p.hunks[l.hunkId];
      const shown = p.decisions.get(h.id) === "rejected" ? h.oldLines : h.newLines;
      expect(prev.slice(l.previewStart, l.previewStart + l.previewLines)).toEqual(shown);
    }
  });

  it("discards unapplied proposals of a cancelled turn without touching disk", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const store = new ReviewStore();
    const p = propose(SRC, [{ old_string: "return 1", new_string: "return 10" }]);
    store.add(p);
    const discarded = store.discardTurn("t1");
    expect(discarded.map((x) => x.id)).toEqual(["call-1"]);
    expect(store.takeApproved(p.argsKey)).toBeUndefined();
    expect(fs.writes).toBe(0);
  });
});

describe("undo journal", () => {
  async function applied(fs: MemFs, journal: ChangeJournal, edits: { old_string: string; new_string: string }[], turnKey = "t1") {
    const original = (await fs.read("/w/f.py"))!;
    const p = buildProposal({
      id: Math.random().toString(), turnKey, source: "s", kind: "edit", path: "/w/f.py", relPath: "f.py",
      original, args: { path: "f.py", edits }, toolName: "propose_edit",
    });
    p.decisions.forEach((_, k) => p.decisions.set(k, "accepted"));
    return (await applyApprovedProposal(p, fs, journal)).change;
  }

  it("undo restores the exact original bytes", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const j = new ChangeJournal();
    const c = await applied(fs, j, [{ old_string: "return 2", new_string: "return 20" }]);
    await j.undo(c.id, fs);
    expect(fs.files.get("/w/f.py")).toBe(SRC);
    await expect(j.undo(c.id, fs)).rejects.toBeInstanceOf(UndoConflict);
  });

  it("undoes a single hunk and keeps the others", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const j = new ChangeJournal();
    const c = await applied(fs, j, [
      { old_string: "return 1", new_string: "return 10" },
      { old_string: "return 3", new_string: "return 30" },
    ]);
    await j.undo(c.id, fs, [1]);
    expect(fs.files.get("/w/f.py")).toBe(SRC.replace("return 1", "return 10"));
    expect(c.undone).toBe(false);
    await j.undo(c.id, fs, [0]);
    expect(fs.files.get("/w/f.py")).toBe(SRC);
    expect(c.undone).toBe(true);
  });

  it("undo survives unrelated user edits made after the change", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const j = new ChangeJournal();
    const c = await applied(fs, j, [{ old_string: "return 2", new_string: "return 20" }]);
    fs.files.set("/w/f.py", "# later user line\n" + fs.files.get("/w/f.py")!);
    await j.undo(c.id, fs);
    expect(fs.files.get("/w/f.py")).toBe("# later user line\n" + SRC);
  });

  it("refuses to undo over the user's later edit of the same lines, and writes nothing", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const j = new ChangeJournal();
    const c = await applied(fs, j, [{ old_string: "return 2", new_string: "return 20" }]);
    const userText = fs.files.get("/w/f.py")!.replace("return 20", "return 'mine'");
    fs.files.set("/w/f.py", userText);
    const before = fs.writes;
    await expect(j.undo(c.id, fs)).rejects.toBeInstanceOf(UndoConflict);
    expect(fs.files.get("/w/f.py")).toBe(userText);
    expect(fs.writes).toBe(before);
  });

  it("turn undo is all-or-nothing across several changes", async () => {
    const fs = new MemFs({ "/w/f.py": SRC });
    const j = new ChangeJournal();
    await applied(fs, j, [{ old_string: "return 1", new_string: "return 10" }], "turnA");
    await applied(fs, j, [{ old_string: "return 3", new_string: "return 30" }], "turnA");
    await j.undoTurn("turnA", fs);
    expect(fs.files.get("/w/f.py")).toBe(SRC);

    const fs2 = new MemFs({ "/w/f.py": SRC });
    const j2 = new ChangeJournal();
    await applied(fs2, j2, [{ old_string: "return 1", new_string: "return 10" }], "turnB");
    await applied(fs2, j2, [{ old_string: "return 3", new_string: "return 30" }], "turnB");
    const sabotaged = fs2.files.get("/w/f.py")!.replace("return 10", "return 'user'");
    fs2.files.set("/w/f.py", sabotaged);
    const writes = fs2.writes;
    await expect(j2.undoTurn("turnB", fs2)).rejects.toBeInstanceOf(UndoConflict);
    expect(fs2.files.get("/w/f.py")).toBe(sabotaged);
    expect(fs2.writes).toBe(writes);
  });

  it("undoing a created file removes it", async () => {
    const fs = new MemFs();
    const j = new ChangeJournal();
    const p = buildProposal({
      id: "n", turnKey: "t", source: "s", kind: "create", path: "/w/new.py", relPath: "new.py",
      original: null, args: { path: "new.py", content: "x = 1\n" }, toolName: "propose_new_file",
    });
    p.decisions.forEach((_, k) => p.decisions.set(k, "accepted"));
    const r = await applyApprovedProposal(p, fs, j);
    await j.undo(r.change.id, fs);
    expect(fs.files.has("/w/new.py")).toBe(false);
  });
});

describe("line endings in search/replace (regressions found by fuzzing)", () => {
  it("does not rewrite untouched lines of a mixed-ending file", () => {
    const mixed = "a = 1\r\nb = 2\nc = 3\r\nd = 4\r\n";
    const out = applySearchReplace(mixed, [{ old_string: "d = 4", new_string: "d = 5" }]);
    expect(out).toBe("a = 1\r\nb = 2\nc = 3\r\nd = 5\r\n");
  });

  it("matches an LF anchor inside a CRLF file", () => {
    const crlf = "def f():\r\n    return 1\r\n";
    const out = applySearchReplace(crlf, [{ old_string: "def f():\n    return 1", new_string: "def f():\n    return 2" }]);
    expect(out).toBe("def f():\r\n    return 2\r\n");
  });
});
