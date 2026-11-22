import type { TrueForgeApi as TF } from "@truefoundry/trueforge-sdk";
import { WRITE_TOOLS, PRELOAD_TOOLS } from "../../mcp/server";

/** On-disk agent definition (agents/*.agent.json). Model is chosen at runtime from settings. */
export interface AgentDefinition {
  name: string;
  description: string;
  instructions: string;
  tools: "editor" | "none";
  compactionTokens?: number;
  subagents?: boolean;
  iterationLimit?: number;
  skills?: string[];
  maxTokens?: number;
}

import { createHash } from "crypto";

/**
 * Name under which a workspace's editor tools are registered in TrueForge.
 * It is derived from the workspace path so two VS Code windows never
 * overwrite each other's registration (and never act on the wrong folder).
 */
export function mcpServerName(root: string): string {
  return `forgepilot-${createHash("sha1").update(root).digest("hex").slice(0, 10)}`;
}

/**
 * Build the TrueForge AgentSpec for a definition and a model. Sessions are
 * created with an inline spec (not a named agent) because TrueForge only lets
 * a session's model be changed in place for inline specs, and switching the
 * model on the same session is how fallback keeps the conversation history.
 */
/**
 * Build the spec. `extraParams` are provider-specific request parameters for
 * this model only (forwarded by TrueForge as-is), e.g. Groq's
 * {"reasoning_format": "hidden"} for gpt-oss so its reasoning is not echoed
 * back in multi-turn history, which Groq rejects.
 */
export function buildSpec(def: AgentDefinition, model: string, mcpName: string, extraParams: Record<string, unknown> = {}): TF.AgentSpec {
  const spec: TF.AgentSpec = {
    model: { name: model, params: { temperature: 0, ...(def.maxTokens ? { maxTokens: def.maxTokens } : {}), ...extraParams } },
    instructions: def.instructions,
    config: {
      // ForgePilot's UI never renders these; dropping their tool schemas saves
      // tokens on every request (matters on free tiers with small per-minute limits).
      askUserQuestions: { enabled: false },
      generativeUi: { enabled: false },
      iterationLimit: def.iterationLimit ?? 60,
      dynamicSubAgents: { enabled: Boolean(def.subagents) },
      contextManagement: {
        compaction: def.compactionTokens
          ? { enabled: true, trigger: { type: "input_tokens", value: def.compactionTokens } }
          : { enabled: true },
        largeToolResponse: { enabled: false },
      },
    },
  };
  if (def.tools === "editor") {
    spec.mcpServers = [
      {
        name: mcpName,
        enableTools: ["@all"],
        // Deferred tool loading: the rarely used tools (list_files, find_symbol)
        // stay deferred; tools whose arguments we must inspect for review are preloaded.
        preload: false,
        preloadTools: PRELOAD_TOOLS,
        requireApprovalForTools: [...WRITE_TOOLS],
      },
    ];
  }
  if (def.skills?.length) spec.skills = def.skills.map((name) => ({ name, preload: false }));
  return spec;
}
