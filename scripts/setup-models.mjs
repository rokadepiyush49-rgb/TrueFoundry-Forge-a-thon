#!/usr/bin/env node
// Register model providers in a local TrueForge from config/models.local.json
// (falls back to the example file, which has placeholder keys).
//   npm run setup:models                      register providers
//   npm run setup:models -- --broken-primary  ALSO register "broken/unreachable"
//                                             (closed port) and "broken/badkey"
//                                             (invalid key) for Task C demos
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localPath = path.join(root, "config/models.local.json");
const file = existsSync(localPath) ? localPath : path.join(root, "config/models.example.json");
const cfg = JSON.parse(readFileSync(file, "utf8"));
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_URL || cfg.trueforgeUrl || "http://localhost:8790" });

const providers = [...cfg.providers];
if (process.argv.includes("--broken-primary")) {
  providers.push({
    enabled: true,
    name: "broken",
    type: "custom",
    baseUrl: "http://127.0.0.1:9/v1",
    auth: { apiKey: "not-a-real-key" },
    models: [
      { name: "unreachable", modelId: "unreachable", properties: { contextLength: 32000 } },
    ],
  });
  const first = cfg.providers.find((p) => p.enabled !== false && (p.type === "openai" || p.type === "google-gemini" || p.type === "anthropic"));
  if (first) {
    providers.push({ ...first, name: "badkey", auth: { apiKey: "invalid-key-for-task-c" } });
  }
}

let failed = 0;
for (const p of providers) {
  if (p.enabled === false) {
    console.log(`skip ${p.name}: not enabled in ${path.relative(root, file)}`);
    continue;
  }
  if (JSON.stringify(p.auth || {}).includes("YOUR_")) {
    console.log(`skip ${p.name}: placeholder key (edit ${path.relative(root, localPath)})`);
    continue;
  }
  const { name, enabled: _enabled, ...manifest } = p;
  try {
    await client.settings.modelProviders.createOrUpdate({ manifest: { name, ...manifest } });
    console.log(`registered ${name}: ${p.models.map((m) => `${name}/${m.name}`).join(", ")}`);
  } catch (e) {
    failed++;
    console.error(`failed ${name}: ${e.message} ${e.body ? JSON.stringify(e.body).slice(0, 300) : ""}`);
  }
}
const models = await client.models.list();
console.log("\nModels available in TrueForge:");
for (const m of models.data || []) console.log(`  ${m.fqn || m.name}`);
console.log(`\nSet VS Code setting "forgepilot.models" (primary first), e.g. ${JSON.stringify(cfg.forgepilotModels)}`);
console.log(`or run the command "ForgePilot: Choose Models".`);
process.exit(failed ? 1 : 0);
