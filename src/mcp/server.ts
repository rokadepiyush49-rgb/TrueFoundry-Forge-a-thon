import * as http from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  ToolHost,
  ToolError,
  readFileTool,
  listFilesTool,
  searchCodeTool,
  findSymbolTool,
  retrieveContextTool,
  declarePlanTool,
  proposeWriteTool,
  runCommandTool,
} from "./tools";

/** Names of tools that change the workspace; TrueForge must ask for approval before each call. */
export const WRITE_TOOLS = ["propose_edit", "propose_new_file", "run_command"] as const;
/** Tools loaded eagerly; the rest stay deferred until the agent searches for them. */
export const PRELOAD_TOOLS = ["retrieve_context", "read_file", "search_code", "propose_edit", "propose_new_file", "run_command", "declare_plan"];

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function wrap(fn: () => Promise<string> | string): Promise<Result> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : `Tool failed: ${(e as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

const editSchema = z.object({
  old_string: z.string().describe("Exact text currently in the file (copy it from read_file, including indentation). Must match exactly once."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
});

export function buildMcpServer(host: ToolHost): McpServer {
  const server = new McpServer({ name: "forgepilot-editor", version: "0.1.0" });
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "retrieve_context",
    {
      title: "Retrieve relevant code",
      description:
        "Find the code relevant to a task in this repository within a token budget. Returns the selected files with the evidence for each choice (matched terms, defined symbols, tests/docs companions, import edges), what was left out and why, and the code itself (most relevant last). Use this first for any task that spans files you have not been told about.",
      inputSchema: {
        query: z.string().describe("The task or question in natural language, including any identifiers you know."),
        budget_tokens: z.number().int().optional().describe("Token budget for returned code (default from settings)."),
        mentions: z.array(z.string()).optional().describe("Workspace-relative files that must be included."),
      },
      annotations: ro,
    },
    async (a) => wrap(() => retrieveContextTool(host, a)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: `Read a workspace file with line numbers, at most ${250} lines per call. Use start_line/end_line to page.`,
      inputSchema: {
        path: z.string().describe("Workspace-relative path."),
        start_line: z.number().int().optional(),
        end_line: z.number().int().optional(),
      },
      annotations: ro,
    },
    async (a) => wrap(() => readFileTool(host, a)),
  );

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List indexed workspace files, optionally under a directory or containing a substring.",
      inputSchema: { dir: z.string().optional(), contains: z.string().optional() },
      annotations: ro,
    },
    async (a) => wrap(() => listFilesTool(host, a)),
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description: "Search all workspace files for a literal string (or a regex) and return file:line matches.",
      inputSchema: {
        query: z.string(),
        regex: z.boolean().optional(),
        path_contains: z.string().optional(),
        max_results: z.number().int().optional(),
      },
      annotations: ro,
    },
    async (a) => wrap(() => searchCodeTool(host, a)),
  );

  server.registerTool(
    "find_symbol",
    {
      title: "Find symbol",
      description: "Find where a function, class, method or module-level name is defined. Says clearly when a symbol does not exist.",
      inputSchema: { name: z.string() },
      annotations: ro,
    },
    async (a) => wrap(() => findSymbolTool(host, a)),
  );

  server.registerTool(
    "declare_plan",
    {
      title: "Declare change plan",
      description:
        "Before editing, declare which files you intend to change and why. The user sees this plan; edits to files outside it are flagged during review.",
      inputSchema: {
        summary: z.string(),
        steps: z.array(z.object({ file: z.string(), change: z.string() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (a) => wrap(() => declarePlanTool(host, a)),
  );

  server.registerTool(
    "propose_edit",
    {
      title: "Propose an edit",
      description:
        "Propose changes to an existing file as exact search/replace edits. The user reviews each hunk and may accept or reject it individually; only accepted hunks are written. The result says which hunks were rejected. Keep edits minimal: do not reformat or rewrite code you were not asked to change.",
      inputSchema: {
        path: z.string().describe("Workspace-relative path of an existing file."),
        edits: z.array(editSchema).min(1),
        explanation: z.string().optional().describe("One sentence on why, shown to the reviewer."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (a) => wrap(() => proposeWriteTool(host, "propose_edit", a)),
  );

  server.registerTool(
    "propose_new_file",
    {
      title: "Propose a new file",
      description: "Propose creating a new file. The user reviews it before anything is written.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        explanation: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (a) => wrap(() => proposeWriteTool(host, "propose_new_file", a)),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run a terminal command",
      description:
        "Run a shell command (for example tests). It already runs in the workspace root, so do not cd into other directories or guess absolute paths. Requires the user's approval. Output is truncated; prefer targeted test selections.",
      inputSchema: {
        command: z.string(),
        timeout_seconds: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (a) => wrap(() => runCommandTool(host, a)),
  );

  return server;
}

export interface RunningMcpServer {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Serve the editor tools over MCP Streamable HTTP on 127.0.0.1, stateless,
 * behind a random bearer token so other local processes cannot call them.
 */
export async function startMcpServer(host: ToolHost, port = 0): Promise<RunningMcpServer> {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const httpServer = http.createServer(async (req, res) => {
    try {
      const auth = Buffer.from(String(req.headers.authorization || ""));
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const server = buildMcpServer(host);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null }));
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  const addr = httpServer.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    token,
    port: addr.port,
    close: () => new Promise((r) => httpServer.close(() => r())),
  };
}
