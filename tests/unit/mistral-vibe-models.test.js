/**
 * Mistral Vibe model registration.
 *
 * Mistral already existed as an API-key provider; this lane adds the
 * mistral-vibe CLI catalog so `mistral/mistral-vibe-cli-*` and
 * `mistral/devstral-small-latest` route through 9Router.
 *
 * Run: cd tests && npx vitest run unit/mistral-vibe-models.test.js
 */
import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { isValidModel, getModelUpstreamId } from "../../open-sse/config/providerModels.js";

const VIBE_MODEL_IDS = [
  "mistral-vibe-cli-latest",
  "mistral-vibe-cli-fast",
  "mistral-vibe-cli-with-tools",
  "devstral-small-latest",
];

describe("Mistral provider (Vibe models)", () => {
  const mistral = REGISTRY.find((e) => e.id === "mistral");

  it("stays an OpenAI-compatible apikey provider on api.mistral.ai", () => {
    expect(mistral).toBeDefined();
    expect(mistral.category).toBe("apikey");
    expect(mistral.alias).toBe("mistral");
    expect(mistral.transport.baseUrl).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(mistral.transport.validateUrl).toBe("https://api.mistral.ai/v1/models");
  });

  it("exposes every Vibe CLI model id in PROVIDER_MODELS.mistral", () => {
    const ids = (PROVIDER_MODELS.mistral || []).map((m) => m.id);
    for (const id of VIBE_MODEL_IDS) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });

  it("keeps the core public catalog rows", () => {
    const ids = (PROVIDER_MODELS.mistral || []).map((m) => m.id);
    for (const id of [
      "mistral-medium-3-5",
      "mistral-medium-latest",
      "mistral-large-latest",
      "mistral-small-latest",
      "codestral-latest",
      "mistral-embed",
    ]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });

  it("lists vibe-cli-latest first (default model for new connections)", () => {
    expect(PROVIDER_MODELS.mistral?.[0]?.id).toBe("mistral-vibe-cli-latest");
  });

  it("accepts Vibe ids via isValidModel and does not rewrite them upstream", () => {
    for (const id of VIBE_MODEL_IDS) {
      expect(isValidModel("mistral", id)).toBe(true);
      // Server remaps devstral-small-latest → mistral-medium-3-5 itself.
      expect(getModelUpstreamId("mistral", id)).toBe(id);
    }
  });

  it("builds into runtime PROVIDERS with openai format + dropClientMetadata", () => {
    expect(PROVIDERS.mistral?.format).toBe("openai");
    expect(PROVIDERS.mistral?.quirks?.dropClientMetadata).toBe(true);
  });

  it("declares thinking levels matching mistral-vibe", () => {
    expect(mistral.thinkingConfig).toMatchObject({
      options: expect.arrayContaining(["low", "medium", "high"]),
      defaultMode: "high",
    });
  });
});
