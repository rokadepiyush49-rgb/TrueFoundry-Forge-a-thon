import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { ApprovalBroker, BrokerHost } from "../../src/core/review/broker";
import { ReviewStore, Proposal } from "../../src/core/diff/review";
import { ContextIndex } from "../../src/core/context/indexer";
import { NodeFilePort } from "../../src/core/nodeHost";

async function setup(policy: (p: Proposal, store: ReviewStore) => void = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), "fp-broker-"));
  mkdirSync(path.join(root, "pkg"));
  writeFileSync(path.join(root, "pkg/__init__.py"), "");
  writeFileSync(path.join(root, "pkg/util.py"), "def helper():\n    return 1\n");
  writeFileSync(path.join(root, "pkg/app.py"), "from pkg.util import helper\n\n\ndef main():\n    return helper()\n");
  const index = new ContextIndex(root);
  await index.build();
  const review = new ReviewStore();
  const shown: Proposal[] = [];
  const host: BrokerHost = {
    root, mcpName: "forgepilot-test", fs: new NodeFilePort(), index, review,
    plan: () => ({ summary: "s", steps: [{ file: "pkg/app.py", change: "c" }] }),
    turnKey: () => "t", source: () => "s", scope: () => undefined,
    showReview: (p) => { shown.push(p); setTimeout(() => policy(p, review), 5); },
    confirmCommand: async (c) => c.startsWith("pytest"),
    rejectionFeedback: () => undefined, log: () => {},
  };
  return { broker: new ApprovalBroker(host), review, shown };
}

const call = (name: string, args: unknown, threadId = "main", serverName = "forgepilot-test") => ({
  id: `c-${Math.random()}`, threadId, name, serverName, argsJson: JSON.stringify(args),
});

describe("approval broker", () => {
  it("allows read-only tools without asking", async () => {
    const { broker, shown } = await setup();
    expect(await broker.decide(call("read_file", { path: "pkg/app.py" }))).toEqual({ status: "allow" });
    expect(shown).toHaveLength(0);
  });

  it("denies write tools requested by a sub-agent thread", async () => {
    const { broker, shown } = await setup();
    const d = await broker.decide(call("propose_edit", { path: "pkg/app.py", edits: [{ old_string: "return helper()", new_string: "return 2" }] }, "thread-sub-1"));
    expect(d.status).toBe("deny");
    expect((d as { reason: string }).reason).toMatch(/read-only/);
    expect(shown).toHaveLength(0);
  });

  it("denies tools from an unexpected MCP server", async () => {
    const { broker } = await setup();
    expect((await broker.decide(call("propose_edit", {}, "main", "someone-else"))).status).toBe("deny");
  });

  it("asks before running commands", async () => {
    const { broker } = await setup();
    expect((await broker.decide(call("run_command", { command: "pytest -q" }))).status).toBe("allow");
    expect((await broker.decide(call("run_command", { command: "rm -rf /" }))).status).toBe("deny");
  });

  it("auto-denies a syntax error and a hallucinated import before review", async () => {
    const { broker, shown } = await setup();
    const bad = await broker.decide(call("propose_edit", { path: "pkg/app.py", edits: [{ old_string: "def main():", new_string: "def main(:" }] }));
    expect(bad.status).toBe("deny");
    expect((bad as { reason: string }).reason).toMatch(/would not parse/);
    const halluc = await broker.decide(call("propose_edit", { path: "pkg/app.py", edits: [{ old_string: "from pkg.util import helper", new_string: "from pkg.util import helper, helpr2" }] }));
    expect(halluc.status).toBe("deny");
    expect((halluc as { reason: string }).reason).toMatch(/helpr2.*does not exist/);
    expect(shown).toHaveLength(0);
  });

  it("flags hunks in files outside the declared plan, then allows once a hunk is accepted", async () => {
    const { broker, shown } = await setup((p, store) => store.decide(p.id, 0, "accepted"));
    const d = await broker.decide(call("propose_edit", { path: "pkg/util.py", edits: [{ old_string: "return 1", new_string: "return 2" }] }));
    expect(d.status).toBe("allow");
    expect(shown[0].hunkWarnings.get(0)?.[0]).toMatch(/not in the agent's declared plan/);
    expect(shown[0].status).toBe("approved");
  });

  it("denies with a clear reason when every hunk is rejected", async () => {
    const { broker } = await setup((p, store) => store.decideAll(p.id, "rejected"));
    const d = await broker.decide(call("propose_edit", { path: "pkg/app.py", edits: [{ old_string: "return helper()", new_string: "return 3" }] }));
    expect(d.status).toBe("deny");
    expect((d as { reason: string }).reason).toMatch(/rejected every hunk/);
  });
});
