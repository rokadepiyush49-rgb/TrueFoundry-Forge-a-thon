#!/usr/bin/env node
// Register the free-tier models in a local TrueForge.
//   npm run setup:free
// Asks for a Gemini key and a Groq key (hidden input; press Enter to skip one),
// sends them only to your local TrueForge, never writes them to disk, then
// checks each model with a one-line request through TrueForge.
import readline from "readline";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { FREE_PROVIDERS, providerId } from "./providers.mjs";

const url = process.env.TRUEFORGE_URL || "http://localhost:8790";
const client = new TrueForge({ baseUrl: url, timeoutInSeconds: 120 });

const DRY_RUN = process.argv.includes("--dry-run");

// Interactive: keep the terminal in no-echo (raw) mode for the whole run, so a
// key pasted early (e.g. while the previous key is being checked) is never
// echoed in plain text. Restore the terminal however the script exits.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  const restore = () => {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* already closed */
    }
  };
  process.on("exit", restore);
}

// Non-interactive input (piped, used by the self-test): queue lines as they arrive.
let pipedLines = null;
if (!process.stdin.isTTY) {
  pipedLines = { queue: [], waiter: null, closed: false };
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (pipedLines.waiter) {
      const w = pipedLines.waiter;
      pipedLines.waiter = null;
      w(line);
    } else pipedLines.queue.push(line);
  });
  rl.on("close", () => {
    pipedLines.closed = true;
    if (pipedLines.waiter) pipedLines.waiter("");
  });
}

/**
 * Read a secret without echoing it: the prompt stays visible and every typed
 * or pasted character shows as "*". Backspace and Ctrl-C work; bracketed-paste
 * markers some terminals add are stripped.
 */
function askHidden(question, { emptyMeansKeep = false } = {}) {
  process.stdout.write(question);
  if (pipedLines) {
    if (pipedLines.queue.length) {
      process.stdout.write("(received)\n");
      return Promise.resolve(pipedLines.queue.shift().trim());
    }
    if (pipedLines.closed) {
      process.stdout.write("\n");
      return Promise.resolve("");
    }
    return new Promise((resolve) => (pipedLines.waiter = (l) => resolve(l.trim())));
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    let warnedEmpty = false;
    stdin.setEncoding("utf8");
    stdin.resume();
    const done = (value) => {
      stdin.off("data", onData);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk) => {
      const text = chunk.replace(/\x1b\[20[01]~/g, "").replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          // An Enter before anything was pasted is easy to hit by accident:
          // ask once more instead of skipping straight away.
          if (!buf.trim() && !warnedEmpty && !emptyMeansKeep) {
            warnedEmpty = true;
            process.stdout.write("\n  Nothing pasted yet. Paste the key (Cmd+V) and press Enter, or press Enter again to skip: ");
            continue;
          }
          return done(buf);
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130); // the exit handler restores the terminal
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          buf += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function check(model) {
  try {
    const session = await client.sessions.create({
      // Reasoning models spend tokens thinking before answering, so leave room.
      agent: { spec: { model: { name: model, params: { maxTokens: 1024 } }, instructions: "Reply with exactly: OK" } },
    });
    const turn = await client.sessions.createTurn(session.data.id, { input: [{ type: "user.message", content: "Say OK." }] });
    let state = turn.data.state;
    for (let i = 0; i < 60 && state.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      state = (await client.sessions.getTurn(session.data.id, turn.data.id)).data.state;
    }
    await client.sessions.delete(session.data.id).catch(() => undefined);
    if (state.status === "done") return "works";
    // A reply cut off by the token limit still proves the key and model work.
    if (/truncat|token limit|max_tokens|length/i.test(state.message || "")) return "works";
    return `failed: ${state.message || state.status}`;
  } catch (e) {
    return `failed: ${e.message}`;
  }
}

const providers = process.env.FORGEPILOT_SETUP_SELFTEST
  ? JSON.parse(process.env.FORGEPILOT_SETUP_SELFTEST).map((p) => ({ id: p.manifest.name, label: p.label, manifest: (key) => ({ ...p.manifest, auth: { apiKey: key } }), test: p.test }))
  : FREE_PROVIDERS;

if (DRY_RUN) {
  // Exercise the prompts only: report what was received, contact nothing.
  for (const p of [{ label: "first secret" }, { label: "second secret" }]) {
    const v = await askHidden(`Paste your ${p.label} (Enter to skip): `);
    console.log(`  received ${v.length} characters`);
  }
  process.exit(0);
}

try {
  await client.models.list();
} catch (e) {
  console.error(`TrueForge is not reachable at ${url}. Start it first:\n  OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest`);
  process.exit(1);
}

console.log("ForgePilot free model setup. Keys go only to your local TrueForge; nothing is saved to disk.");
console.log("Paste each key with Cmd+V when asked (it shows as ****), then press Enter. Never paste a key at the shell prompt.\n");
const existing = new Set(((await client.settings.modelProviders.list()).data || []).map((p) => p.name));
const registered = [];
for (const p of providers) {
  const have = existing.has(p.id);
  const key = await askHidden(
    have ? `${p.label} is already set up. Paste a new key to replace it, or press Enter to keep it: ` : `Paste your ${p.label} (Enter to skip): `,
    { emptyMeansKeep: have },
  );
  if (!key && !have) {
    console.log("  skipped\n");
    continue;
  }
  try {
    if (key) {
      const manifest = p.manifest(key);
      await client.settings.modelProviders.createOrUpdate({ manifest });
      process.stdout.write(`  registered as ${providerId(manifest)}; checking with a one-line request... `);
    } else {
      process.stdout.write("  keeping the existing key; checking with a one-line request... ");
    }
    const result = await check(p.test);
    console.log(result + "\n");
    if (result === "works") registered.push(p.test);
  } catch (e) {
    const body = JSON.stringify(e.body ?? "");
    if (/Outbound URL blocked/.test(body)) {
      const host = (body.match(/host \\?"([^"\\]+)/) || [])[1] || "the provider";
      console.log(`  TrueForge blocked ${host}. On NAT64 networks (common on Indian ISPs) IPv4-only APIs resolve to 64:ff9b:: addresses,`);
      console.log(`  which TrueForge's SSRF guard treats as private. Restart TrueForge with the host allowlisted, then run this again:`);
      console.log(`    OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1","${host}"]' npx @truefoundry/trueforge@latest\n`);
    } else {
      console.log(`  could not register: ${e.message}\n`);
    }
  }
}

if (registered.length) {
  console.log("Working models:", registered.join(", "));
  console.log('\nIn VS Code run "ForgePilot: Choose Models" and pick them (primary first),');
  console.log(`or set "forgepilot.models": ${JSON.stringify(registered)}`);
} else {
  console.log("No working models were added.");
}
