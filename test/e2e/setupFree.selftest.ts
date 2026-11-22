// Self-test for scripts/setup-free.mjs against the mock model (run with tsx; needs TrueForge).
import { spawn } from "child_process";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { startMockModel } from "./mockModel";
import { FREE_PROVIDERS, providerId } from "../../scripts/providers.mjs";

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_URL || "http://localhost:8790" });

function runSetup(providers: unknown[], input: string): Promise<string> {
  return new Promise((resolve) => {
    // async spawn: the mock model lives in THIS process and must keep serving
    const child = spawn("node", ["scripts/setup-free.mjs"], { env: { ...process.env, FORGEPILOT_SETUP_SELFTEST: JSON.stringify(providers) } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(input);
    child.on("close", () => resolve(out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")));
  });
}

(async () => {
  const checks: Array<[string, boolean]> = [];
  const mock = await startMockModel();
  mock.setScript("scripted", [{ text: "OK" }]);
  const custom = (name: string, model: string) => ({ label: name, manifest: { name, type: "custom", baseUrl: mock.url, models: [{ name: model, modelId: model, properties: { contextLength: 8000 } }] }, test: `${name}/${model}` });
  const providers = [custom("mocksetup", "scripted"), custom("mocksetupbad", "auth-fail"), custom("mocksetuptrunc", "truncate")];

  const first = await runSetup(providers, "good-key\nbad-key\ntrunc-key\n");
  console.log(first);
  checks.push(["a good key reports works", /registered as mocksetup;[^\n]*works/.test(first)]);
  checks.push(["a bad key reports the provider's error", /registered as mocksetupbad;[^\n]*failed: .*(401|API key)/i.test(first)]);
  checks.push(["a reply cut off by the token limit still counts as working", /registered as mocksetuptrunc;[^\n]*works/.test(first)]);
  checks.push(["keys are never echoed", !/good-key|bad-key|trunc-key/.test(first)]);

  const second = await runSetup([providers[0]], "\n");
  console.log(second);
  checks.push(["Enter keeps an existing key and re-checks it", /already set up[\s\S]*keeping the existing key[^\n]*works/.test(second)]);

  // Built-in provider types must be registered WITHOUT a name (TrueForge rejects it).
  const existing = new Set(((await client.settings.modelProviders.list()).data || []).map((p: { name: string }) => p.name));
  const gemini = FREE_PROVIDERS.find((p) => p.id === "google-gemini")!;
  if (existing.has("google-gemini")) {
    console.log("(skipping the built-in registration check: a real google-gemini provider exists and must not be touched)");
    checks.push(["gemini manifest has no name field", !("name" in gemini.manifest("x"))]);
  } else {
    let ok = false;
    try {
      const m = gemini.manifest("invalid-test-key-not-real");
      await client.settings.modelProviders.createOrUpdate({ manifest: m } as never);
      const fqns = ((await client.models.list()) as unknown as { data: Array<{ fqn?: string; name?: string }> }).data.map((x) => x.fqn || x.name);
      ok = providerId(m) === "google-gemini" && fqns.includes(gemini.test);
    } catch (e) {
      console.log("built-in registration failed:", (e as Error).message);
    } finally {
      await client.settings.modelProviders.delete("google-gemini").catch(() => undefined);
    }
    checks.push(["the Gemini (built-in type) manifest is accepted and yields " + gemini.test, ok]);
  }

  for (const n of ["mocksetup", "mocksetupbad", "mocksetuptrunc"]) await client.settings.modelProviders.delete(n).catch(() => undefined);
  await mock.close();
  for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  const pass = checks.every(([, ok]) => ok);
  console.log(pass ? "SETUP SELFTEST PASSED" : "SETUP SELFTEST FAILED");
  process.exit(pass ? 0 : 1);
})();
