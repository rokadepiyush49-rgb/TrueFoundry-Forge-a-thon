/**
 * End-to-end tests against a REAL TrueForge server, the real ForgePilot MCP
 * server and a scripted OpenAI-compatible mock model. They check behaviour
 * the judges score: per-hunk writes, no silent writes, automatic rejection of
 * impossible edits, retry/fallback on the same session, cancellation latency
 * and workspace consistency (git status is the oracle, as in Task C).
 *
 * Start TrueForge first:
 *   OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' MODEL_HTTP_MAX_RETRIES=0 npx @truefoundry/trueforge@latest
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ForgeCore, CoreEvent } from "../../src/core/forgeCore";
import { NodeFilePort } from "../../src/core/nodeHost";
import { Proposal } from "../../src/core/diff/review";
import { AgentDefinition } from "../../src/core/trueforge/spec";
import { startMockModel, MockModel, Step } from "./mockModel";

const TF_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const ROOT = path.resolve(__dirname, "../..");
const agentDef: AgentDefinition = JSON.parse(readFileSync(path.join(ROOT, "agents/forgepilot.agent.json"), "utf8"));
const inlineDef: AgentDefinition = JSON.parse(readFileSync(path.join(ROOT, "agents/inline-edit.agent.json"), "utf8"));

const CALC = `def add(a, b):
    return a + b


def sub(a, b):
    return a - b
`;

let mock: MockModel;
let ws: string;
let core: ForgeCore;
let models: string[] = [];
let events: CoreEvent[] = [];
let reviewPolicy: (p: Proposal) => void = () => {};
let commandPolicy: (c: string) => Promise<boolean> = async () => true;
let reviewsShown: Proposal[] = [];

const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: ws, encoding: "utf8" });
const calcPath = () => path.join(ws, "pkg/calc.py");
const calc = () => readFileSync(calcPath(), "utf8");
const statusOf = (kind: string) => events.filter((e) => e.type === "status" && e.status.kind === kind);

function script(model: string, steps: Step[]) {
  mock.setScript(model, steps);
}

beforeAll(async () => {
  mock = await startMockModel();
  ws = mkdtempSync(path.join(tmpdir(), "forgepilot-e2e-"));
  mkdirSync(path.join(ws, "pkg"));
  mkdirSync(path.join(ws, "tests"));
  writeFileSync(path.join(ws, "pkg/__init__.py"), "");
  writeFileSync(calcPath(), CALC);
  writeFileSync(path.join(ws, "tests/test_calc.py"), "from pkg.calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n");
  git("init -q");
  git("add -A");
  git("-c user.name=t -c user.email=t@t commit -q -m init");

  core = new ForgeCore({
    root: ws,
    serverUrl: TF_URL,
    models: () => models,
    retry: () => ({ maxAttempts: 2, baseDelayMs: 50 }),
    budget: () => 3000,
    fs: new NodeFilePort(),
    agentDef,
    inlineDef,
    ui: {
      showReview: (p) => {
        reviewsShown.push(p);
        setTimeout(() => reviewPolicy(p), 10);
      },
      confirmCommand: (c) => commandPolicy(c),
      rejectionFeedback: () => undefined,
      emit: (e) => events.push(e),
    },
  });
  // register the mock provider in TrueForge
  await core.client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: "custom",
      name: "mock",
      baseUrl: mock.url,
      auth: { apiKey: "test-key-not-secret" },
      models: ["scripted", "scripted2", "inline-scripted", "inline-lazy", "always-500", "auth-fail", "slow", "edit-then-500", "ratelimit-once", "daily-quota"].map((m) => ({
        name: m,
        modelId: m,
        properties: { contextLength: 128000 },
      })),
    },
  } as never);
  await core.start();
});

afterAll(async () => {
  await core?.client.settings.modelProviders.delete("mock").catch(() => undefined);
  await core?.stop();
  await mock?.close();
});

beforeEach(() => {
  events = [];
  reviewsShown = [];
  reviewPolicy = (p) => p.hunks.forEach((h) => core.review.decide(p.id, h.id, "accepted"));
  commandPolicy = async () => true;
  core.agent.newSession();
  core.inline.newSession();
  git("checkout -q -- .");
  git("clean -qfd");
});

describe("agent mode through TrueForge", () => {
  it("writes only the hunks the user accepted, and tells the agent what was rejected", async () => {
    models = ["mock/scripted"];
    script("scripted", [
      { tool: "retrieve_context", args: { query: "change add and sub" } },
      {
        tool: "propose_edit",
        args: {
          path: "pkg/calc.py",
          edits: [
            { old_string: "    return a + b", new_string: "    return int(a) + int(b)" },
            { old_string: "    return a - b", new_string: "    return int(a) - int(b)" },
          ],
        },
      },
      { text: "Done." },
    ]);
    reviewPolicy = (p) => {
      core.review.decide(p.id, 0, "accepted");
      core.review.decide(p.id, 1, "rejected");
    };
    const r = await core.runAgent("make add and sub coerce to int");
    expect(r.status).toBe("done");
    expect(reviewsShown).toHaveLength(1);
    expect(calc()).toContain("return int(a) + int(b)");
    expect(calc()).toContain("return a - b");
    const toolResult = mock.calls[mock.calls.length - 1].lastTool;
    expect(toolResult).toMatch(/REJECTED/);
    expect(events.some((e) => e.type === "context" && e.origin === "agent")).toBe(true);
    expect(events.some((e) => e.type === "context" && e.origin === "auto")).toBe(true);
  });

  it("auto-rejects an edit whose anchor text does not exist, without asking the user", async () => {
    models = ["mock/scripted"];
    script("scripted", [
      { tool: "propose_edit", args: { path: "pkg/calc.py", edits: [{ old_string: "def mul(a, b):", new_string: "def mul(a, b, c):" }] } },
      { text: "ok" },
    ]);
    const r = await core.runAgent("edit mul");
    expect(r.status).toBe("done");
    expect(reviewsShown).toHaveLength(0);
    expect(mock.calls[mock.calls.length - 1].lastTool).toMatch(/not found/i);
    expect(git("status --porcelain")).toBe("");
  });

  it("auto-rejects an edit that imports a symbol that does not exist in the repository", async () => {
    models = ["mock/scripted"];
    script("scripted", [
      {
        tool: "propose_edit",
        args: { path: "tests/test_calc.py", edits: [{ old_string: "from pkg.calc import add", new_string: "from pkg.calc import add, multiply" }] },
      },
      { text: "ok" },
    ]);
    const r = await core.runAgent("test multiply");
    expect(r.status).toBe("done");
    expect(reviewsShown).toHaveLength(0);
    expect(mock.calls[mock.calls.length - 1].lastTool).toMatch(/multiply.*does not exist/);
    expect(git("status --porcelain")).toBe("");
  });

  it("refuses MCP writes that did not pass review, and unauthenticated MCP calls", async () => {
    const unauth = await fetch(core.mcp!.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauth.status).toBe(401);
    const client = new Client({ name: "attacker", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(core.mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${core.mcp!.token}` } } }),
    );
    const res = (await client.callTool({
      name: "propose_edit",
      arguments: { path: "pkg/calc.py", edits: [{ old_string: "return a + b", new_string: "return 42" }] },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not been approved/);
    expect(git("status --porcelain")).toBe("");
  });
});

describe("resilience (Task C behaviour)", () => {
  it("retries a transient failure with backoff, then falls back on the SAME session", async () => {
    models = ["mock/always-500", "mock/scripted"];
    script("scripted", [{ text: "Recovered on the fallback model." }]);
    await core.agent.ensureSession();
    const sessionBefore = core.agent.sessionId;
    const r = await core.runAgent("hello");
    expect(r.status).toBe("done");
    expect(r.model).toBe("mock/scripted");
    expect(r.failures.filter((f) => f.model === "mock/always-500")).toHaveLength(2);
    expect(statusOf("retry")).toHaveLength(1);
    expect(statusOf("fallback")).toHaveLength(1);
    expect(core.agent.sessionId).toBe(sessionBefore);
    expect(git("status --porcelain")).toBe("");
  });

  it("does not retry an authentication failure on the same model", async () => {
    models = ["mock/auth-fail", "mock/scripted"];
    script("scripted", [{ text: "ok" }]);
    const r = await core.runAgent("hello");
    expect(r.status).toBe("done");
    const authFails = r.failures.filter((f) => f.model === "mock/auth-fail");
    expect(authFails).toHaveLength(1);
    expect(authFails[0].failure.kind).toBe("auth");
    expect(statusOf("retry")).toHaveLength(0);
  });

  it("when every model fails: clear error, no files changed", async () => {
    models = ["mock/always-500"];
    const r = await core.runAgent("hello");
    expect(r.status).toBe("error");
    expect(r.error?.message).toMatch(/server error|failed/i);
    expect(statusOf("failed")).toHaveLength(1);
    expect(git("status --porcelain")).toBe("");
  });

  it("a mid-run failure continues on the fallback model without redoing applied edits", async () => {
    models = ["mock/edit-then-500", "mock/scripted2"];
    script("edit-then-500", [
      { tool: "propose_edit", args: { path: "pkg/calc.py", edits: [{ old_string: "    return a + b", new_string: "    return b + a" }] } },
    ]);
    script("scripted2", [{ text: "unused" }, { text: "Continued and finished." }]);
    const r = await core.runAgent("swap operands in add");
    expect(r.status).toBe("done");
    expect(r.model).toBe("mock/scripted2");
    expect(statusOf("continue").length).toBeGreaterThan(0);
    const cont = mock.calls.filter((c) => c.model.endsWith("scripted2")).pop()!;
    expect(cont.lastUser).toMatch(/Applied so far/);
    expect(cont.lastUser).toMatch(/pkg\/calc\.py/);
    expect(calc().match(/return b \+ a/g)).toHaveLength(1);
  });
});

describe("free-tier rate limits", () => {
  it("waits out a per-minute rate limit on the same model instead of falling back", async () => {
    models = ["mock/ratelimit-once", "mock/scripted2"];
    script("scripted", [{ text: "done after waiting" }]);
    const t0 = Date.now();
    const r = await core.runAgent("hello");
    expect(r.status).toBe("done");
    expect(r.model).toBe("mock/ratelimit-once");
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].failure.kind).toBe("rate_limit");
    expect(statusOf("fallback")).toHaveLength(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000); // honoured the provider's "retry in 1.2s"
  });

  it("falls back immediately when a daily quota is exhausted", async () => {
    models = ["mock/daily-quota", "mock/scripted"];
    script("scripted", [{ text: "fallback ok" }]);
    const r = await core.runAgent("hello");
    expect(r.status).toBe("done");
    expect(r.model).toBe("mock/scripted");
    expect(r.failures.filter((f) => f.model === "mock/daily-quota")).toHaveLength(1);
    expect(statusOf("retry")).toHaveLength(0);
  });
});

describe("streaming and cancellation", () => {
  it("streams tokens and cancels immediately, leaving the workspace clean", async () => {
    models = ["mock/slow"];
    let tokens = 0;
    const p = core.runAgent("write a long essay");
    const t0 = Date.now();
    while (tokens < 5 && Date.now() - t0 < 15000) {
      await new Promise((r) => setTimeout(r, 50));
      tokens = events.filter((e) => e.type === "text").length;
    }
    expect(tokens).toBeGreaterThanOrEqual(5);
    const cancelAt = Date.now();
    await core.cancel();
    const r = await p;
    const latency = Date.now() - cancelAt;
    expect(r.status).toBe("cancelled");
    expect(latency).toBeLessThan(1000);
    const after = events.filter((e) => e.type === "text").length;
    await new Promise((r) => setTimeout(r, 400));
    expect(events.filter((e) => e.type === "text").length).toBe(after); // no tokens after cancel
    expect(git("status --porcelain")).toBe("");
    console.log(`cancel latency: ${latency} ms`);
  });

  it("cancelling while a review is open discards it and writes nothing", async () => {
    models = ["mock/scripted"];
    script("scripted", [
      { tool: "propose_edit", args: { path: "pkg/calc.py", edits: [{ old_string: "    return a + b", new_string: "    return 0" }] } },
      { text: "done" },
    ]);
    reviewPolicy = () => void core.cancel();
    const r = await core.runAgent("zero add");
    expect(r.status).toBe("cancelled");
    expect(reviewsShown).toHaveLength(1);
    expect(reviewsShown[0].status).toBe("discarded");
    await new Promise((r) => setTimeout(r, 300));
    expect(git("status --porcelain")).toBe("");
  });

  it("cancelling kills a running terminal command", async () => {
    models = ["mock/scripted"];
    script("scripted", [{ tool: "run_command", args: { command: "sleep 30" } }, { text: "done" }]);
    const p = core.runAgent("wait");
    const t0 = Date.now();
    while (!events.some((e) => e.type === "tool" && e.call.name === "run_command") && Date.now() - t0 < 15000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));
    const cancelAt = Date.now();
    const { killed } = await core.cancel();
    const r = await p;
    expect(r.status).toBe("cancelled");
    expect(killed).toBe(1);
    expect(Date.now() - cancelAt).toBeLessThan(3000);
  });
});

describe("inline edit through TrueForge", () => {
  it("rewrites only the selection and goes through per-hunk review", async () => {
    models = ["mock/inline-scripted"];
    script("inline-scripted", [{ text: "Here you go:\n```python\ndef sub(a, b):\n    return float(a) - float(b)\n```" }]);
    const r = await core.runInline({ abs: calcPath(), languageId: "python", sel: { startLine: 5, endLine: 6 }, instruction: "use floats" });
    expect(r.result.status).toBe("done");
    expect(r.applied).toBeDefined();
    expect(calc()).toBe(CALC.replace("return a - b", "return float(a) - float(b)"));
    await core.undoLast();
    expect(git("status --porcelain")).toBe("");
  });

  it("refuses a lazy reply that elides code", async () => {
    models = ["mock/inline-lazy"];
    script("inline-lazy", [{ text: "```python\ndef sub(a, b):\n    # ... rest of the code unchanged\n```" }]);
    const r = await core.runInline({ abs: calcPath(), languageId: "python", sel: { startLine: 5, endLine: 6 }, instruction: "rename" });
    expect(r.error).toMatch(/abbreviated/);
    expect(reviewsShown).toHaveLength(0);
    expect(git("status --porcelain")).toBe("");
  });
});

describe("registration and configuration", () => {
  it("two workspaces (two VS Code windows) never share or overwrite each other's tools", async () => {
    const ws2 = mkdtempSync(path.join(tmpdir(), "forgepilot-e2e-second-"));
    writeFileSync(path.join(ws2, "only_in_second.py"), "def second_workspace_marker():\n    return 2\n");
    const core2 = new ForgeCore({
      root: ws2,
      serverUrl: TF_URL,
      models: () => ["mock/scripted"],
      retry: () => ({ maxAttempts: 1, baseDelayMs: 10 }),
      budget: () => 2000,
      fs: new NodeFilePort(),
      agentDef,
      inlineDef,
      ui: { showReview: () => {}, confirmCommand: async () => false, rejectionFeedback: () => undefined, emit: () => {} },
    });
    await core2.start();
    try {
      expect(core2.mcpName).not.toBe(core.mcpName);
      const names = ((await core.client.settings.mcpServers.list()) as unknown as { data: Array<{ name: string }> }).data.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining([core.mcpName, core2.mcpName]));
      // each core's agent sees only its own workspace
      script("scripted", [{ tool: "retrieve_context", args: { query: "second workspace marker" } }, { text: "ok" }]);
      const r2 = await core2.runAgent("find the marker");
      expect(r2.status).toBe("done");
      expect(mock.calls[mock.calls.length - 1].lastTool).toContain("only_in_second.py");
      models = ["mock/scripted"];
      script("scripted", [{ tool: "retrieve_context", args: { query: "add sub calc" } }, { text: "ok" }]);
      const r1 = await core.runAgent("find calc");
      expect(r1.status).toBe("done");
      const seen = mock.calls[mock.calls.length - 1].lastTool;
      expect(seen).toContain("pkg/calc.py");
      expect(seen).not.toContain("only_in_second.py");
    } finally {
      await core2.stop();
    }
    const after = ((await core.client.settings.mcpServers.list()) as unknown as { data: Array<{ name: string }> }).data.map((s) => s.name);
    expect(after).not.toContain(core2.mcpName); // unregistered on stop
    expect(after).toContain(core.mcpName); // the other window is unaffected
  });

  it("falls back when the primary model is not configured in TrueForge at all", async () => {
    models = ["mock/does-not-exist", "mock/scripted"];
    script("scripted", [{ text: "fallback ok" }]);
    const r = await core.runAgent("hello");
    expect(r.status).toBe("done");
    expect(r.model).toBe("mock/scripted");
    expect(git("status --porcelain")).toBe("");
  });
});
