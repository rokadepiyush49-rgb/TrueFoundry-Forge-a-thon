import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { pythonSymbols, pythonImports } from "../../src/core/context/symbols";
import { tokenize, queryIdentifiers } from "../../src/core/context/tokenize";
import { ContextIndex } from "../../src/core/context/indexer";
import { retrieve, renderReport } from "../../src/core/context/retrieve";

const PY = `import os
from .helpers import get_flag, other as alias
from pkg.models import (
    User,
    Group,
)

CONSTANT = 3


@decorator("x")
@other
def top(a, b=(1,
              2)):
    """doc"""
    return a


class Thing(Base):
    attr = 1

    def method(self):
        return 2

    async def amethod(self):
        pass


def after():
    pass
`;

describe("python symbols", () => {
  it("captures decorators, multi-line signatures, classes and methods with correct spans", () => {
    const defs = pythonSymbols("m.py", PY);
    const top = defs.find((d) => d.name === "top")!;
    expect(top.line).toBe(11); // first decorator line
    expect(top.endLine).toBe(16);
    const thing = defs.find((d) => d.name === "Thing")!;
    expect(thing.kind).toBe("class");
    expect(defs.find((d) => d.name === "method")!.parent).toBe("Thing");
    expect(defs.find((d) => d.name === "amethod")!.kind).toBe("method");
    expect(thing.endLine).toBe(26);
    expect(defs.find((d) => d.name === "after")!.kind).toBe("function");
    expect(defs.find((d) => d.name === "CONSTANT")!.kind).toBe("variable");
  });

  it("parses relative, aliased and parenthesised imports", () => {
    const imps = pythonImports(PY);
    expect(imps.find((i) => i.module === ".helpers")!.names).toEqual(["get_flag", "other"]);
    expect(imps.find((i) => i.module === "pkg.models")!.names).toEqual(["User", "Group"]);
    expect(imps.find((i) => i.module === "os")!.names).toEqual([]);
  });
});

describe("tokenize", () => {
  it("keeps whole identifiers and their parts, drops stop words", () => {
    const t = tokenize("get_debug_flag uses getDebugFlag and the value");
    expect(t).toContain("get_debug_flag");
    expect(t).toContain("debug");
    expect(t).toContain("flag");
    expect(t).not.toContain("the");
  });
  it("finds identifiers in a natural-language request", () => {
    expect(queryIdentifiers("fix `url_for` and teardown_appcontext in Flask.run")).toEqual(
      expect.arrayContaining(["url_for", "teardown_appcontext", "Flask.run"]),
    );
  });
});

describe("retrieval", () => {
  let root: string;
  let index: ContextIndex;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "fp-ctx-"));
    mkdirSync(path.join(root, "src/app"), { recursive: true });
    mkdirSync(path.join(root, "tests"), { recursive: true });
    mkdirSync(path.join(root, "docs"), { recursive: true });
    mkdirSync(path.join(root, "node_modules/junk"), { recursive: true });
    writeFileSync(path.join(root, "src/app/__init__.py"), "from .billing import charge\n");
    writeFileSync(
      path.join(root, "src/app/billing.py"),
      "from .money import Money\n\n\ndef charge(customer, amount):\n    \"\"\"Charge a customer an amount of money with a retry on failure.\"\"\"\n    return Money(amount)\n\n\ndef refund(customer, amount):\n    return -amount\n",
    );
    writeFileSync(path.join(root, "src/app/money.py"), "class Money:\n    def __init__(self, v):\n        self.v = v\n");
    writeFileSync(path.join(root, "src/app/unrelated.py"), "def render_page(theme):\n    return theme.upper()\n" + "x = 1\n".repeat(400));
    writeFileSync(path.join(root, "tests/test_billing.py"), "from app.billing import charge\n\ndef test_charge():\n    assert charge(1, 2)\n");
    writeFileSync(path.join(root, "docs/billing.rst"), "Billing\n=======\n\nHow charges and refunds work.\n");
    writeFileSync(path.join(root, "node_modules/junk/index.js"), "function charge() {}\n");
    index = new ContextIndex(root);
    await index.build();
  });

  it("skips vendored directories", () => {
    expect([...index.files.keys()].some((f) => f.startsWith("node_modules"))).toBe(false);
  });

  it("resolves the import graph across relative and absolute imports", () => {
    expect(index.files.get("src/app/billing.py")!.imports).toContain("src/app/money.py");
    expect([...(index.importedBy.get("src/app/billing.py") || [])]).toContain("tests/test_billing.py");
  });

  it("finds the file to change, adds its test and docs, and explains every choice", () => {
    const rep = retrieve(index, "add a retry limit when we charge a customer", { budget: 2000 });
    const paths = rep.selected.map((s) => s.path);
    expect(paths[0]).toBe("src/app/billing.py");
    expect(paths).toContain("tests/test_billing.py");
    expect(paths).toContain("docs/billing.rst");
    for (const s of rep.selected) expect(s.reasons.length).toBeGreaterThan(0);
    expect(rep.selected.find((s) => s.path === "tests/test_billing.py")!.reasons.some((r) => r.signal === "companion")).toBe(true);
  });

  it("never exceeds the token budget", () => {
    for (const budget of [150, 400, 1000, 3000]) {
      const rep = retrieve(index, "charge refund money render page theme", { budget });
      expect(rep.used).toBeLessThanOrEqual(budget);
    }
  });

  it("always includes @-mentioned files, even irrelevant ones", () => {
    const rep = retrieve(index, "charge a customer", { budget: 1500, mentions: ["src/app/unrelated.py"] });
    expect(rep.selected[0].path).toBe("src/app/unrelated.py");
    expect(rep.selected[0].reasons.some((r) => r.signal === "mention")).toBe(true);
  });

  it("flags low confidence when nothing matches", () => {
    const rep = retrieve(index, "kubernetes helm chart ingress", { budget: 1000 });
    expect(rep.lowConfidence).toBe(true);
  });

  it("renders the most relevant file last, next to the task", () => {
    const rep = retrieve(index, "charge a customer amount", { budget: 2000 });
    const text = renderReport(index, rep, true);
    const lastBlock = text.lastIndexOf("=== ");
    expect(text.slice(lastBlock)).toContain(rep.selected[0].path);
  });
});
