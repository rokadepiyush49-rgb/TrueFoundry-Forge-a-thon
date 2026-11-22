// Free-tier providers registered by `npm run setup:free`.
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
