/**
 * Muse Code local-spend quota card (PR-2).
 * Run: cd tests && npx vitest run unit/meta-local-spend-quota.test.js
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("meta local-spend quota", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registry declares usage for meta (oauth only)", async () => {
    const { default: meta } = await import(
      "../../open-sse/providers/registry/meta.js"
    );
    expect(meta.features?.usage).toBe(true);
    expect(meta.features?.usageApikey).toBeUndefined();
    expect(meta.authModes).toEqual(["oauth"]);
  });

  it("registers meta in USAGE_HANDLERS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        }),
      ),
    );
    const { getUsageForProvider } = await import(
      "../../open-sse/services/usage.js"
    );
    const usage = await getUsageForProvider(
      { provider: "meta", accessToken: "LLM|123|abc" },
      null,
      {},
    );
    expect(usage.message).not.toMatch(/not implemented/i);
    expect(usage.localSpend).toBe(true);
    expect(usage.plan).toBe("Muse Code");
  });

  it("rejects non-LLM tokens", async () => {
    const { getMetaUsage } = await import(
      "../../open-sse/services/usage/meta.js"
    );
    const usage = await getMetaUsage("dca:not-a-key", null);
    expect(usage.message).toMatch(/LLM\|/i);
  });

  it("getMetaUsage validates LLM key and marks localSpend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
        }),
      ),
    );
    const { getMetaUsage } = await import(
      "../../open-sse/services/usage/meta.js"
    );
    const usage = await getMetaUsage("LLM|123|secret", null);
    expect(usage.localSpend).toBe(true);
    expect(usage.plan).toBe("Muse Code");
    expect(usage.message).toMatch(/9Router/i);
  });

  it("buildLocalSpendQuotas produces unlimited count rows", async () => {
    const { buildLocalSpendQuotas } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const quotas = buildLocalSpendQuotas({
      d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
      d30: { requests: 4, promptTokens: 80, completionTokens: 20, cost: 0.01 },
    });
    expect(quotas["Requests (30d)"].used).toBe(4);
    expect(quotas["Requests (30d)"].unlimited).toBe(true);
    expect(quotas["Est. cost (30d, USD)"].used).toBeCloseTo(0.01, 6);
  });

  it("enrichUsageWithLocalSpend merges rows and clears message", async () => {
    vi.doMock("../../src/lib/db/repos/usageRepo.js", () => ({
      getLocalSpendForConnection: async () => ({
        d7: { requests: 1, promptTokens: 10, completionTokens: 2, cost: 0 },
        d30: { requests: 2, promptTokens: 20, completionTokens: 4, cost: 0 },
      }),
    }));
    const { enrichUsageWithLocalSpend } = await import(
      "../../src/lib/localSpendUsage.js"
    );
    const enriched = await enrichUsageWithLocalSpend(
      {
        plan: "Muse Code",
        message: "Subscription key valid.",
        quotas: {},
      },
      { id: "meta-conn", provider: "meta" },
    );
    expect(enriched.quotas["Requests (30d)"].used).toBe(2);
    expect(enriched.message).toBeUndefined();
    expect(enriched.plan).toBe("Muse Code");
  });
});
