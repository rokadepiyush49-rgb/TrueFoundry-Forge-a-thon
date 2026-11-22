// Providers registered by `npm run setup:free` (two free tiers, then optional paid ones).
// TrueForge names built-in provider types after the type itself (a
// "google-gemini" provider's models are "google-gemini/<model>") and rejects a
// `name` field for them; only "custom" (OpenAI-compatible) providers take a name.
export const FREE_PROVIDERS = [
  {
    id: "google-gemini",
    label: "Gemini (free key from https://aistudio.google.com/apikey)",
    manifest: (key) => ({
      type: "google-gemini",
      auth: { apiKey: key },
      models: [
        { name: "gemini-3-5-flash-lite", modelId: "gemini-3.5-flash-lite", properties: { contextLength: 1048576 } },
        { name: "gemini-3-8-flash", modelId: "gemini-3.8-flash", properties: { contextLength: 1048576 } },
      ],
    }),
    test: "google-gemini/gemini-3-5-flash-lite",
  },
  {
    id: "groq",
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
  {
    id: "nvidia",
    label: "NVIDIA API, free for prototyping (free key from https://build.nvidia.com, no card)",
    manifest: (key) => ({
      name: "nvidia",
      type: "custom",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      auth: { apiKey: key },
      models: [
        { name: "mistral-large-4", modelId: "mistralai/mistral-large-4-1t-a52b", properties: { contextLength: 262144 } },
        { name: "kimi-k3-1-pro", modelId: "moonshotai/kimi-k3.1-pro", properties: { contextLength: 262144 } },
        { name: "glm-5-3-flash", modelId: "z-ai/glm-5.3-flash", properties: { contextLength: 131072 } },
      ],
    }),
    test: "nvidia/mistral-large-4",
  },
  {
    id: "cohere",
    label: "Cohere trial, free (key from https://dashboard.cohere.com/api-keys, no card)",
    manifest: (key) => ({
      name: "cohere",
      type: "custom",
      baseUrl: "https://api.cohere.ai/compatibility/v1",
      auth: { apiKey: key },
      models: [
        { name: "command-a", modelId: "command-a-03-2025", properties: { contextLength: 256000 } },
      ],
    }),
    test: "cohere/command-a",
  },
  {
    id: "openrouter",
    label: "OpenRouter, free models (free key from https://openrouter.ai/keys, no card)",
    manifest: (key) => ({
      name: "openrouter",
      type: "custom",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: { apiKey: key },
      models: [
        { name: "gemma-4-31b-free", modelId: "google/gemma-4-31b-it:free", properties: { contextLength: 262144 } },
        { name: "nemotron-ultra-free", modelId: "nvidia/nemotron-3-ultra-550b-a55b:free", properties: { contextLength: 1000000 } },
      ],
    }),
    test: "openrouter/gemma-4-31b-free",
  },
  {
    id: "anthropic",
    label: "Anthropic, paid, optional (key from https://platform.claude.com/settings/keys)",
    manifest: (key) => ({
      type: "anthropic",
      auth: { apiKey: key },
      models: [{ name: "claude-haiku-5-5", modelId: "claude-haiku-5-5", properties: { contextLength: 1000000 } }],
    }),
    test: "anthropic/claude-haiku-5-5",
  },
  {
    id: "openai",
    label: "OpenAI, paid, optional (key from https://platform.openai.com/api-keys)",
    manifest: (key) => ({
      type: "openai",
      auth: { apiKey: key },
      models: [{ name: "gpt-5-4-mini", modelId: "gpt-5.4-mini", properties: { contextLength: 400000 } }],
    }),
    test: "openai/gpt-5-4-mini",
  },
];

/** Built-in provider types do not accept a `name`; their name is the type. */
export function providerManifest(p) {
  const { enabled: _e, ...rest } = p;
  if (rest.type !== "custom") {
    const { name: _n, ...builtIn } = rest;
    return builtIn;
  }
  return rest;
}

export function providerId(manifest) {
  return manifest.type === "custom" ? manifest.name : manifest.type;
}
