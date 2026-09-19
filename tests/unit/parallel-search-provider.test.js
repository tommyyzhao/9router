import { afterEach, describe, expect, it, vi } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers.js";

const CONFIG = {
  id: "parallel",
  baseUrl: "https://api.parallel.ai/v1/search",
  method: "POST",
  authType: "apikey",
  searchTypes: ["web", "news"],
  defaultMaxResults: 5,
  maxMaxResults: 20,
};

const PARAMS = {
  query: "solid state battery progress",
  searchType: "web",
  maxResults: 5,
  token: "prl_test_key",
};

const SEARCH_RESPONSE = {
  search_id: "search_test",
  results: [
    {
      url: "https://example.com/a",
      title: "First hit",
      publish_date: "2026-01-15",
      excerpts: ["Primary excerpt", "Secondary excerpt"],
    },
    {
      url: "https://example.com/b",
      title: "Second hit",
      publish_date: null,
      excerpts: ["Only one excerpt"],
    },
  ],
  warnings: null,
  session_id: "session_test",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Parallel search provider", () => {
  it("registers webSearch + webFetch with x-api-key auth", () => {
    const entry = REGISTRY.find((candidate) => candidate.id === "parallel");

    expect(entry).toMatchObject({
      category: "apikey",
      authType: "apikey",
      serviceKinds: ["webSearch", "webFetch"],
      searchConfig: {
        baseUrl: "https://api.parallel.ai/v1/search",
        authHeader: "x-api-key",
        searchTypes: ["web", "news"],
        maxMaxResults: 20,
      },
      fetchConfig: {
        baseUrl: "https://api.parallel.ai/v1/extract",
        authHeader: "x-api-key",
      },
    });
    expect(AI_PROVIDERS.parallel?.searchConfig).toEqual(entry.searchConfig);
    expect(AI_PROVIDERS.parallel?.fetchConfig).toEqual(entry.fetchConfig);
    expect(getProvidersByKind("webSearch").map((p) => p.id)).toContain("parallel");
    expect(getProvidersByKind("webFetch").map((p) => p.id)).toContain("parallel");
  });

  it("builds POST /v1/search with x-api-key, search_queries, and default mode fast", () => {
    const request = buildSearchRequest(CONFIG, PARAMS);

    expect(request.url).toBe("https://api.parallel.ai/v1/search");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "prl_test_key",
    });
    expect(request.init.headers.Authorization).toBeUndefined();
    expect(request.url).not.toContain("prl_test_key");

    const body = JSON.parse(request.init.body);
    expect(body).toMatchObject({
      search_queries: ["solid state battery progress"],
      objective: "solid state battery progress",
      mode: "fast",
      advanced_settings: { max_results: 5 },
    });
  });

  it("honors provider_options.mode override when valid", () => {
    const request = buildSearchRequest(CONFIG, {
      ...PARAMS,
      providerOptions: { mode: "turbo" },
    });
    expect(JSON.parse(request.init.body).mode).toBe("turbo");
  });

  it("falls back to fast when mode is invalid", () => {
    const request = buildSearchRequest(CONFIG, {
      ...PARAMS,
      providerOptions: { mode: "warp-speed" },
    });
    expect(JSON.parse(request.init.body).mode).toBe("fast");
  });

  it("steers news search via objective", () => {
    const request = buildSearchRequest(CONFIG, {
      ...PARAMS,
      searchType: "news",
    });
    const body = JSON.parse(request.init.body);
    expect(body.objective).toContain("Recent news");
    expect(body.search_queries).toEqual(["solid state battery progress"]);
  });

  it("maps domain filter include/exclude and prefers includes", () => {
    const withIncludes = buildSearchRequest(CONFIG, {
      ...PARAMS,
      domainFilter: ["wikipedia.org", "-reddit.com"],
    });
    expect(JSON.parse(withIncludes.init.body).advanced_settings.source_policy).toEqual({
      include_domains: ["wikipedia.org"],
    });

    const excludesOnly = buildSearchRequest(CONFIG, {
      ...PARAMS,
      domainFilter: ["-reddit.com", "-youtube.com"],
    });
    expect(JSON.parse(excludesOnly.init.body).advanced_settings.source_policy).toEqual({
      exclude_domains: ["reddit.com", "youtube.com"],
    });
  });

  it("maps country to Parallel location (uk → gb)", () => {
    const request = buildSearchRequest(CONFIG, { ...PARAMS, country: "UK" });
    expect(JSON.parse(request.init.body).advanced_settings.location).toBe("gb");
  });

  it("maps time_range to source_policy.after_date", () => {
    const request = buildSearchRequest(CONFIG, { ...PARAMS, timeRange: "week" });
    const policy = JSON.parse(request.init.body).advanced_settings.source_policy;
    expect(policy.after_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("normalizes Parallel results preserving rank order", () => {
    const normalized = normalizeSearchResponse("parallel", SEARCH_RESPONSE, PARAMS.query, "web");

    expect(normalized.results).toHaveLength(2);
    expect(normalized.totalResults).toBe(2);

    const [first, second] = normalized.results;
    expect(first).toMatchObject({
      title: "First hit",
      url: "https://example.com/a",
      snippet: "Primary excerpt",
      published_at: "2026-01-15",
      position: 1,
      score: null,
    });
    expect(first.content).toMatchObject({
      format: "markdown",
      text: "Primary excerpt\n\nSecondary excerpt",
    });
    expect(second).toMatchObject({
      title: "Second hit",
      snippet: "Only one excerpt",
      published_at: null,
      position: 2,
    });
    expect(second.content).toBeNull();
  });

  it("returns empty results when upstream has no results array", () => {
    expect(normalizeSearchResponse("parallel", {}, PARAMS.query, "web")).toEqual({
      results: [],
      totalResults: null,
    });
  });
});

describe("Parallel web fetch provider", () => {
  it("POSTs /v1/extract with x-api-key and full_content, maps markdown body", async () => {
    const fetchCalls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      fetchCalls.push({ url, init });
      return new Response(
        JSON.stringify({
          extract_id: "extract_test",
          results: [
            {
              url: "https://example.com/page",
              title: "Page Title",
              excerpts: ["Excerpt A"],
              full_content: "# Hello\n\nFull markdown body",
            },
          ],
          errors: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await handleFetchCore({
      url: "https://example.com/page",
      format: "text",
      maxCharacters: 1000,
      provider: "parallel",
      providerConfig: {
        baseUrl: "https://api.parallel.ai/v1/extract",
        timeoutMs: 5000,
        costPerQuery: 0.001,
      },
      credentials: { apiKey: "prl_fetch_key" },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://api.parallel.ai/v1/extract");
    expect(fetchCalls[0].init.headers["x-api-key"]).toBe("prl_fetch_key");
    expect(fetchCalls[0].init.headers.authorization).toBeUndefined();

    const body = JSON.parse(fetchCalls[0].init.body);
    expect(body).toEqual({
      urls: ["https://example.com/page"],
      advanced_settings: { full_content: { max_chars_per_result: 1000 } },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      provider: "parallel",
      url: "https://example.com/page",
      title: "Page Title",
    });
    expect(result.data.content).toMatchObject({
      format: "markdown",
      text: "# Hello\n\nFull markdown body",
    });
  });

  it("falls back to joined excerpts when full_content is missing", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          results: [{ url: "https://example.com", title: null, excerpts: ["A", "B"] }],
          errors: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "parallel",
      providerConfig: { timeoutMs: 5000 },
      credentials: { apiKey: "k" },
    });
    expect(result.success).toBe(true);
    expect(result.data.content.text).toBe("A\n\nB");
  });

  it("surfaces Parallel extract errors when no result rows", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          results: [],
          errors: [{ url: "https://example.com", error_type: "fetch_error", content: "blocked" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "parallel",
      providerConfig: { timeoutMs: 5000 },
      credentials: { apiKey: "k" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked");
  });
});
