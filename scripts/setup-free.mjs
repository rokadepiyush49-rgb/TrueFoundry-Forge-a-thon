#!/usr/bin/env node
// Register the free-tier models in a local TrueForge.
//   npm run setup:free
// Asks for a Gemini key and a Groq key (hidden input; press Enter to skip one),
// sends them only to your local TrueForge, never writes them to disk, then
// checks each model with a one-line request through TrueForge.
import readline from "readline";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const url = process.env.TRUEFORGE_URL || "http://localhost:8790";
const client = new TrueForge({ baseUrl: url, timeoutInSeconds: 120 });

// One reader for all prompts; typed characters are echoed as "*". Lines are
// queued as they arrive, so input pasted before a prompt appears is not lost.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let masking = false;
let closed = false;
const queue = [];
let waiter = null;
rl.on("line", (line) => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(line);
  } else queue.push(line);
});
rl.on("close", () => {
  closed = true;
  if (waiter) waiter("");
});
rl._writeToOutput = (s) => {
  if (!masking || s.includes("\n") || s.includes("\r")) rl.output.write(s);
  else rl.output.write("*".repeat(s.length));
};
function askHidden(question) {
  masking = false;
  rl.output.write(question);
  if (queue.length) {
    rl.output.write("(received)\n");
    return Promise.resolve(queue.shift().trim());
  }
  if (closed) {
    rl.output.write("\n");
    return Promise.resolve("");
  }
  masking = true;
  return new Promise((resolve) => {
    waiter = (line) => {
      masking = false;
      resolve(line.trim());
    };
  });
}

async function check(model) {
  try {
    const session = await client.sessions.create({
      agent: { spec: { model: { name: model, params: { maxTokens: 20 } }, instructions: "Reply with exactly: OK" } },
    });
    const turn = await client.sessions.createTurn(session.data.id, { input: [{ type: "user.message", content: "Say OK." }] });
    let state = turn.data.state;
    for (let i = 0; i < 60 && state.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      state = (await client.sessions.getTurn(session.data.id, turn.data.id)).data.state;
    }
    await client.sessions.delete(session.data.id).catch(() => undefined);
    return state.status === "done" ? "works" : `failed: ${state.message || state.status}`;
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

const providers = process.env.FORGEPILOT_SETUP_SELFTEST ? JSON.parse(process.env.FORGEPILOT_SETUP_SELFTEST).map((p) => ({ label: p.label, manifest: (key) => ({ ...p.manifest, auth: { apiKey: key } }), test: p.test })) : [
  {
    label: "Gemini (free key from https://aistudio.google.com/apikey)",
    manifest: (key) => ({
      name: "gemini",
      type: "google-gemini",
      auth: { apiKey: key },
      models: [
        { name: "gemini-3-5-flash-lite", modelId: "gemini-3.5-flash-lite", properties: { contextLength: 1048576 } },
        { name: "gemini-3-8-flash", modelId: "gemini-3.8-flash", properties: { contextLength: 1048576 } },
      ],
    }),
    test: "gemini/gemini-3-5-flash-lite",
  },
  {
    label: "Groq (free key from https://console.groq.com/keys)",
    manifest: (key) => ({
      name: "groq",
      type: "custom",
      baseUrl: "https://api.groq.com/openai/v1",
      auth: { apiKey: key },
      models: [{ name: "gpt-oss-120b", modelId: "openai/gpt-oss-120b", properties: { contextLength: 131072 } }],
    }),
    test: "groq/gpt-oss-120b",
  },
];

try {
  await client.models.list();
} catch (e) {
  console.error(`TrueForge is not reachable at ${url}. Start it first:\n  OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest`);
  process.exit(1);
}

console.log("ForgePilot free model setup. Keys go only to your local TrueForge; nothing is saved to disk.\n");
const registered = [];
for (const p of providers) {
  const key = await askHidden(`Paste your ${p.label} (Enter to skip): `);
  if (!key) {
    console.log("  skipped\n");
    continue;
  }
  try {
    await client.settings.modelProviders.createOrUpdate({ manifest: p.manifest(key) });
    process.stdout.write("  registered; checking with a one-line request... ");
    const result = await check(p.test);
    console.log(result + "\n");
    if (result === "works") registered.push(p.test);
  } catch (e) {
    console.log(`  could not register: ${e.message}\n`);
  }
}

rl.close();
if (registered.length) {
  console.log("Working models:", registered.join(", "));
  console.log('\nIn VS Code run "ForgePilot: Choose Models" and pick them (primary first),');
  console.log(`or set "forgepilot.models": ${JSON.stringify(registered)}`);
} else {
  console.log("No working models were added.");
}
