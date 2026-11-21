import * as http from "http";

/**
 * A scripted OpenAI-compatible chat-completions server used to test the
 * extension's TrueForge integration deterministically. Behaviour is chosen by
 * the requested model name:
 *   scripted   - follows the step list posted to /__script
 *   always-500 - every call returns HTTP 500
 *   auth-fail  - every call returns HTTP 401
 *   slow       - streams one token every 100 ms for ~60 s (for cancellation)
 *   edit-then-500 - follows the script for its first step, then returns 500
 */
export type Step = { tool: string; args: Record<string, unknown> } | { text: string };

export interface MockModel {
  url: string;
  port: number;
  calls: Array<{ model: string; toolNames: string[]; messages: number; lastUser: string; lastTool: string }>;
  setScript(model: string, steps: Step[]): void;
  close(): Promise<void>;
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export async function startMockModel(): Promise<MockModel> {
  const scripts = new Map<string, Step[]>();
  const calls: MockModel["calls"] = [];
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/__script") {
      const { model, steps } = JSON.parse(raw);
      scripts.set(model, steps);
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [] }));
      return;
    }
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw || "{}");
    const model: string = String(body.model || "");
    const messages: Array<{ role: string; content?: unknown }> = body.messages || [];
    const toolNames: string[] = (body.tools || []).map((t: { function: { name: string } }) => t.function.name);
    const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));
    const lastUser = text([...messages].reverse().find((m) => m.role === "user")?.content);
    const lastTool = text([...messages].reverse().find((m) => m.role === "tool")?.content);
    calls.push({ model, toolNames, messages: messages.length, lastUser, lastTool });
    const base = model.split("/").pop()!;

    if (base === "always-500") {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "mock upstream exploded" } }));
      return;
    }
    if (base === "auth-fail") {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
      return;
    }
    const toolMsgs = messages.filter((m) => m.role === "tool").length;
    if (base === "edit-then-500" && toolMsgs >= 1) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "mock crashed mid-task" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    if (base === "slow") {
      let i = 0;
      res.write(chunk(model, { role: "assistant", content: "" }));
      const t = setInterval(() => {
        if (res.destroyed || i++ > 600) {
          clearInterval(t);
          if (!res.destroyed) {
            res.write(chunk(model, {}, "stop"));
            res.end("data: [DONE]\n\n");
          }
          return;
        }
        res.write(chunk(model, { content: `tok${i} ` }));
      }, 100);
      req.on("close", () => clearInterval(t));
      return;
    }
    const steps = scripts.get(base) || scripts.get(model) || [{ text: "No script." }];
    const step = steps[Math.min(toolMsgs, steps.length - 1)];
    if ("text" in step) {
      res.write(chunk(model, { role: "assistant", content: "" }));
      for (const word of step.text.split(/(\s+)/)) res.write(chunk(model, { content: word }));
      res.write(chunk(model, {}, "stop"));
      res.end("data: [DONE]\n\n");
      return;
    }
    const name = toolNames.find((n) => n === step.tool || n.endsWith(step.tool) || n.endsWith(`__${step.tool}`)) ?? step.tool;
    const id = `call_${++seq}`;
    res.write(chunk(model, { role: "assistant", content: null }));
    res.write(chunk(model, { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }));
    const args = JSON.stringify(step.args);
    for (let i = 0; i < args.length; i += 40) {
      res.write(chunk(model, { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 40) } }] }));
    }
    res.write(chunk(model, {}, "tool_calls"));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    calls,
    setScript: (model, steps) => scripts.set(model, steps),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
