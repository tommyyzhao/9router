/**
 * Mistral — api.mistral.ai (OpenAI-compatible chat/completions + embeddings).
 *
 * Includes the Mistral Vibe CLI model ids (same API key, same endpoint):
 *   mistral-vibe-cli-latest / -fast / -with-tools, devstral-small-latest.
 * `devstral-small-latest` is accepted upstream and remapped to mistral-medium-3-5.
 * Source of truth: live /v1/models + mistral-vibe 2.25.x default catalog + CLIProxyAPI.
 */
export default {
  id: "mistral",
  priority: 80,
  alias: "mistral",
  aliases: ["mistral-ai"],
  display: {
    name: "Mistral",
    icon: "air",
    color: "#FF7000",
    textIcon: "MI",
    website: "https://mistral.ai",
    notice: {
      apiKeyUrl: "https://console.mistral.ai/api-keys",
    },
  },
  category: "apikey",
  thinkingConfig: {
    options: ["low", "medium", "high"],
    defaultMode: "high",
  },
  transport: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    validateUrl: "https://api.mistral.ai/v1/models",
    quirks: {
      dropClientMetadata: true,
    },
  },
  models: [
    // ── Mistral Vibe CLI (subscription / La Plateforme key) ──
    {
      id: "mistral-vibe-cli-latest",
      name: "Mistral Vibe (Medium 3.5)",
      contextLength: 200000,
      maxOutputTokens: 65536,
    },
    {
      id: "mistral-vibe-cli-fast",
      name: "Mistral Vibe Fast",
      contextLength: 128000,
      maxOutputTokens: 32768,
    },
    {
      id: "mistral-vibe-cli-with-tools",
      name: "Mistral Vibe + Tools",
      contextLength: 128000,
      maxOutputTokens: 32768,
    },
    {
      // Upstream accepts this id and remaps to mistral-medium-3-5
      id: "devstral-small-latest",
      name: "Devstral Small (Medium 3.5)",
      contextLength: 200000,
      maxOutputTokens: 65536,
    },
    // ── Core public API catalog ──
    { id: "mistral-medium-3-5", name: "Mistral Medium 3.5", contextLength: 256000 },
    { id: "mistral-medium-latest", name: "Mistral Medium", contextLength: 128000 },
    { id: "mistral-large-latest", name: "Mistral Large 3", contextLength: 256000 },
    { id: "mistral-small-latest", name: "Mistral Small", contextLength: 128000 },
    { id: "codestral-latest", name: "Codestral", contextLength: 256000 },
    { id: "magistral-medium-latest", name: "Magistral Medium", contextLength: 40000 },
    { id: "magistral-small-latest", name: "Magistral Small", contextLength: 40000 },
    { id: "mistral-embed", name: "Mistral Embed", kind: "embedding" },
  ],
  serviceKinds: ["llm", "imageToText", "embedding"],
  embeddingConfig: {
    baseUrl: "https://api.mistral.ai/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
  },
};
