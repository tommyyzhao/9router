/**
 * Mistral Vibe local-spend quota card.
 * Run: cd tests && npx vitest run unit/mistral-local-spend-quota.test.js
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("mistral local-spend quota", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registry declares usage + usageApikey for mistral", async () => {
    const { default: mistral } = await import(
      "../../open-sse/providers/registry/mistral.js"
    );
    expect(mistral.features?.usage).toBe(true);
    expect(mistral.features?.usageApikey).toBe(true);
  });

  it("registers mistral in USAGE_HANDLERS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { getUsageForProvider } = await import(
      "../../open-sse/services/usage.js"
    );
    const usage = await getUsageForProvider(
      { provider: "mistral", apiKey: "test-key" },
      null,
      {},
    );
    expect(usage.message).not.toMatch(/not implemented/i);
    expect(usage.localSpend).toBe(true);
    expect(usage.plan).toBe("Mistral");
  });

  it("getMistralUsage validates key and marks localSpend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        }),
      ),
    );
    const { getMistralUsage } = await import(
      "../../open-sse/services/usage/mistral.js"
    );
    const usage = await getMistralUsage("test-key", null);
    expect(usage.localSpend).toBe(true);
    expect(usage.quotas).toEqual({});
    expect(usage.message).toMatch(/9Router/i);
    expect(usage.plan).toBe("Mistral");
  });

  it("enrich clears message when local spend rows exist (card would hide table)", async () => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => ({
        d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
        d30: { requests: 3, promptTokens: 30, completionTokens: 5, cost: 0 },
      }),
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const enriched = await enrichUsageWithLocalSpend(
      {
        plan: "Mistral",
        message: "API key valid. Mistral does not expose numeric quota for this key; showing spend routed through 9Router.",
        quotas: {},
      },
      { id: "conn-1", provider: "mistral" },
    );
    expect(enriched.quotas["Requests (30d)"].used).toBe(3);
    expect(enriched.message).toBeUndefined();
  });

  it("getMistralUsage surfaces auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const { getMistralUsage } = await import(
      "../../open-sse/services/usage/mistral.js"
    );
    const usage = await getMistralUsage("bad-key", null);
    expect(usage.message).toMatch(/authentication failed/i);
  });

  it("buildLocalSpendQuotas produces unlimited count rows", async () => {
    const { buildLocalSpendQuotas } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const quotas = buildLocalSpendQuotas({
      d7: { requests: 2, promptTokens: 40, completionTokens: 6, cost: 0.0001 },
      d30: { requests: 15, promptTokens: 286, completionTokens: 55, cost: 0.00035 },
    });
    expect(quotas["Requests (30d)"].used).toBe(15);
    expect(quotas["Requests (30d)"].unlimited).toBe(true);
    expect(quotas["Prompt tokens (30d)"].used).toBe(286);
    expect(quotas["Completion tokens (7d)"].used).toBe(6);
    expect(quotas["Est. cost (30d, USD)"].used).toBeCloseTo(0.00035, 6);
  });

  it("enrichUsageWithLocalSpend merges rows for mistral connections", async () => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => ({
        d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
        d30: { requests: 3, promptTokens: 30, completionTokens: 5, cost: 0 },
      }),
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const enriched = await enrichUsageWithLocalSpend(
      { plan: "Mistral", quotas: {} },
      { id: "conn-1", provider: "mistral" },
    );
    expect(enriched.localSpend).toBe(true);
    expect(enriched.quotas["Requests (30d)"].used).toBe(3);
  });
});
