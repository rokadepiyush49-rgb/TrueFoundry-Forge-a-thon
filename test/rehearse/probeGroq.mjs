import { TrueForge } from "@truefoundry/trueforge-sdk";
const c = new TrueForge({ baseUrl: "http://localhost:8790", timeoutInSeconds: 120 });
const prov = (await c.settings.modelProviders.list()).data.find((p) => p.name === "groq");
const candidates = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct", "moonshotai/kimi-k2-instruct-0905", "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b", "openai/gpt-oss-20b"];
const models = candidates.map((id) => ({ name: id.split("/").pop().replace(/[^a-z0-9-]/gi, "-").toLowerCase(), modelId: id, properties: { contextLength: 131072 } }));
// the redacted apiKey value in the listing keeps the stored key on update
await c.settings.modelProviders.createOrUpdate({ manifest: { ...prov.manifest, models } });
for (const m of models) {
  const fqn = `groq/${m.name}`;
  try {
    const s = await c.sessions.create({ agent: { spec: { model: { name: fqn, params: { maxTokens: 300 } }, instructions: "Reply with exactly: OK" } } });
    const t = await c.sessions.createTurn(s.data.id, { input: [{ type: "user.message", content: "Say OK." }] });
    let st = t.data.state;
    for (let i = 0; i < 40 && st.status === "running"; i++) { await new Promise((r) => setTimeout(r, 750)); st = (await c.sessions.getTurn(s.data.id, t.data.id)).data.state; }
    console.log(fqn.padEnd(40), st.status === "done" ? "OK" : `FAIL ${String(st.message).slice(0, 160)}`);
    await c.sessions.delete(s.data.id).catch(() => {});
  } catch (e) { console.log(fqn.padEnd(40), "ERR", e.message.slice(0, 120)); }
}
