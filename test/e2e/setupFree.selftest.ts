// Self-test for scripts/setup-free.mjs against the mock model (run with tsx; needs TrueForge).
import { spawn } from "child_process";
import { startMockModel } from "./mockModel";
(async () => {
  const mock = await startMockModel();
  mock.setScript("scripted", [{ text: "OK" }]);
  const providers = [
    { label: "mock good", manifest: { name: "mocksetup", type: "custom", baseUrl: mock.url, models: [{ name: "scripted", modelId: "scripted", properties: { contextLength: 8000 } }] }, test: "mocksetup/scripted" },
    { label: "mock bad", manifest: { name: "mocksetupbad", type: "custom", baseUrl: mock.url, models: [{ name: "auth-fail", modelId: "auth-fail", properties: { contextLength: 8000 } }] }, test: "mocksetupbad/auth-fail" },
  ];
  // async spawn: the mock model lives in THIS process and must keep serving
  const child = spawn("node", ["scripts/setup-free.mjs"], { env: { ...process.env, FORGEPILOT_SETUP_SELFTEST: JSON.stringify(providers) } });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));
  child.stdin.end("good-key\nbad-key\n");
  await new Promise((r) => child.on("close", r));
  const r = { stdout };
  console.log(r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
  const ok = /registered; checking[^\n]*works/.test(r.stdout) && /failed: .*401|failed: .*API key|failed: .*rejected/i.test(r.stdout) && !r.stdout.includes("good-key") && !r.stdout.includes("bad-key");
  for (const n of ["mocksetup", "mocksetupbad"]) await fetch(`http://localhost:8790/api/v1/settings/model-providers/${n}`, { method: "DELETE" });
  await mock.close();
  console.log(ok ? "SETUP SELFTEST PASSED" : "SETUP SELFTEST FAILED");
  process.exit(ok ? 0 : 1);
})();
