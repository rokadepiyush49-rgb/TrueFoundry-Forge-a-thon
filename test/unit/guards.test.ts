import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { detectElision, extractReplacement, fixIndentation, replaceSelection } from "../../src/core/inline";
import { resolveInside, ToolError, editKey } from "../../src/mcp/tools";
import { mcpServerName } from "../../src/core/trueforge/spec";
import { classifyFailure, parseRetryAfter } from "../../src/core/trueforge/errors";

describe("inline elision guard", () => {
  const original = 'def f(x):\n    """Return x."""\n    return x';
  it("refuses comment placeholders and bare ellipses", () => {
    expect(detectElision(original, "def f(x):\n    # ... rest of the code unchanged")).toBeDefined();
    expect(detectElision(original, "def f(x):\n    // existing code")).toBeDefined();
    expect(detectElision(original, "def f(x):\n    ...")).toBeDefined();
    expect(detectElision(original, "def f(x):\n    # rest of function")).toBeDefined();
  });
  it("accepts real code and prose that merely mentions these words", () => {
    const ok = 'def f(x):\n    """Return x. The value remains unchanged when x is None; see the rest of the docs."""\n    return x';
    expect(detectElision(original, ok)).toBeUndefined();
    expect(detectElision(original, "def f(x):\n    # keep existing behaviour for None\n    return x")).toBeUndefined();
  });
  it("allows a bare ellipsis that was already in the selection", () => {
    expect(detectElision("def f():\n    ...", "def f() -> None:\n    ...")).toBeUndefined();
  });
});

describe("inline reply parsing", () => {
  it("takes the fenced block and ignores prose", () => {
    expect(extractReplacement("Sure!\n```python\nx = 1\n```\nDone.")).toBe("x = 1");
  });
  it("handles an unterminated fence", () => {
    expect(extractReplacement("```python\nx = 1\ny = 2\n")).toBe("x = 1\ny = 2");
  });
  it("rejects an empty reply", () => {
    expect(() => extractReplacement("```\n\n```")).toThrow(/empty/);
  });
  it("restores indentation the model stripped", () => {
    expect(fixIndentation("    a = 1\n    b = 2", "a = 3\nb = 4")).toBe("    a = 3\n    b = 4");
    expect(fixIndentation("    a = 1", "    a = 3")).toBe("    a = 3");
  });
  it("replaces exactly the selected lines", () => {
    expect(replaceSelection("1\n2\n3\n4\n", { startLine: 2, endLine: 3 }, "x\ny\nz")).toBe("1\nx\ny\nz\n4\n");
    expect(replaceSelection("1\r\n2\r\n3\r\n", { startLine: 2, endLine: 2 }, "x")).toBe("1\r\nx\r\n3\r\n");
  });
});

describe("workspace path guard", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fp-guard-"));
  const outside = mkdtempSync(path.join(tmpdir(), "fp-outside-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/a.py"), "x = 1\n");
  symlinkSync(outside, path.join(root, "escape"));
  it("accepts normal workspace paths, existing or new", () => {
    expect(resolveInside(root, "src/a.py").rel).toBe("src/a.py");
    expect(resolveInside(root, "./src/new/b.py").rel).toBe("src/new/b.py");
  });
  it("rejects parent traversal, absolute paths outside, and .git", () => {
    expect(() => resolveInside(root, "../x.py")).toThrow(ToolError);
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(ToolError);
    expect(() => resolveInside(root, ".git/config")).toThrow(ToolError);
  });
  it("rejects writes that escape through a symlink", () => {
    expect(() => resolveInside(root, "escape/pwned.py")).toThrow(/outside the workspace/);
    expect(() => resolveInside(root, "escape/deep/dir/pwned.py")).toThrow(/outside the workspace/);
  });
  it("keys reviewed edits by normalized path and content", () => {
    const a = editKey(root, "propose_edit", { path: "./src/a.py", edits: [{ old_string: "x", new_string: "y" }] });
    const b = editKey(root, "propose_edit", { path: "src/a.py", edits: [{ old_string: "x", new_string: "y", replace_all: false }], explanation: "ignored" });
    const c = editKey(root, "propose_edit", { path: "src/a.py", edits: [{ old_string: "x", new_string: "z" }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("per-workspace MCP registration", () => {
  it("gives different workspaces different, stable, valid names", () => {
    const a = mcpServerName("/work/a");
    expect(a).toBe(mcpServerName("/work/a"));
    expect(a).not.toBe(mcpServerName("/work/b"));
    expect(a).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("failure classification", () => {
  it.each([
    ["Request failed (401): Incorrect API key provided", "auth", false],
    ["Request failed (403): permission denied", "auth", false],
    ["Request failed (404): model gpt-9 not found", "model_not_found", false],
    ["Request failed (429): rate limit exceeded", "rate_limit", true],
    ["Request failed (500): upstream exploded", "server", true],
    ["Request failed (503): overloaded", "server", true],
    ["fetch failed: connect ECONNREFUSED 127.0.0.1:9", "unreachable", true],
    ["getaddrinfo ENOTFOUND api.example.invalid", "unreachable", true],
    ["Request timed out after 60s", "timeout", true],
    ["Request failed (400): invalid tools schema", "bad_request", false],
  ])("%s -> %s", (raw, kind, retryable) => {
    const f = classifyFailure(raw);
    expect(f.kind).toBe(kind);
    expect(f.retryable).toBe(retryable);
  });
});

describe("rate-limit handling", () => {
  it.each([
    ["Rate limit reached. Please retry in 37.5s.", 37500],
    ["retry-after: 12", 12000],
    ['{"retryDelay": "20s"}', 20000],
    ["Please try again in 1m30s", 90000],
    ["try again in 250ms", 250],
    ["Request failed (429): too many requests", undefined],
  ])("parses %s", (raw, ms) => {
    expect(parseRetryAfter(raw)).toBe(ms);
  });
  it("treats a per-minute limit as worth waiting for and a daily quota as not", () => {
    const minute = classifyFailure("Request failed (429): Rate limit reached for requests per minute. Please retry in 2s");
    expect(minute).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 2000 });
    const daily = classifyFailure("Request failed (429): Quota exceeded GenerateRequestsPerDayPerProjectPerModel-FreeTier");
    expect(daily).toMatchObject({ kind: "rate_limit", retryable: false });
  });
});
