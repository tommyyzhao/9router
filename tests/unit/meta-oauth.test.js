import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/oauth/museCredentials.js", () => ({
  readLocalMuseCredentials: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (d) => ({ id: "conn-1", ...d })),
}));

import meta from "../../src/lib/oauth/providers/meta.js";
import { readLocalMuseCredentials } from "@/lib/oauth/museCredentials.js";
import { createProviderConnection } from "@/models";

describe("meta oauth provider", () => {
  it("rejects a device-code token without a minted LLM| key", async () => {
    await expect(meta.postExchange({ access_token: "dca:abc" })).rejects.toThrow(/muse login/i);
  });

  it("accepts api_key on the token payload", async () => {
    const extra = await meta.postExchange({ access_token: "dca:abc", api_key: "LLM|1|secret" });
    expect(extra.mintedApiKey).toBe("LLM|1|secret");
  });

  it("stores the minted LLM| key as accessToken", () => {
    const mapped = meta.mapTokens(
      { access_token: "dca:abc", expires_in: 3600 },
      { mintedApiKey: "LLM|1|secret", email: "user@example.com" },
    );
    expect(mapped.accessToken).toBe("LLM|1|secret");
    expect(mapped.refreshToken).toBeNull();
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.providerSpecificData.oauthAccessToken).toBe("dca:abc");
    expect(mapped.providerSpecificData.mintedApiKey).toBe(true);
  });
});

describe("meta auto-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET never returns the secret", async () => {
    readLocalMuseCredentials.mockResolvedValue({
      found: true,
      source: "keychain",
      email: "user@example.com",
      displayName: "Example User",
      apiBaseUrl: "https://api.meta.ai/v1",
      obtainedVia: "device_code",
      apiKey: "LLM|1|secret",
      oauthAccessToken: "dca:abc",
    });
    const { GET } = await import("../../src/app/api/oauth/meta/auto-import/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.email).toBe("user@example.com");
    expect(res.body.source).toBe("keychain");
    expect(JSON.stringify(res.body)).not.toContain("LLM|");
    expect(JSON.stringify(res.body)).not.toContain("dca:");
    expect(res.body.apiKey).toBeUndefined();
  });

  it("POST imports the minted key as an oauth connection", async () => {
    readLocalMuseCredentials.mockResolvedValue({
      found: true,
      source: "keychain",
      email: "user@example.com",
      displayName: "Example User",
      apiBaseUrl: "https://api.meta.ai/v1",
      obtainedVia: "device_code",
      apiKey: "LLM|1|secret",
      oauthAccessToken: "dca:abc",
    });
    const { POST } = await import("../../src/app/api/oauth/meta/auto-import/route.js");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    const arg = createProviderConnection.mock.calls[0][0];
    expect(arg.provider).toBe("meta");
    expect(arg.authType).toBe("oauth");
    expect(arg.accessToken).toBe("LLM|1|secret");
    expect(arg.refreshToken).toBe("dca:abc");
    expect(arg.email).toBe("user@example.com");
  });

  it("POST 400s when Muse Code is not logged in", async () => {
    readLocalMuseCredentials.mockResolvedValue({
      found: false,
      error: "Muse Code is not logged in on this machine. Run `muse login` first.",
    });
    const { POST } = await import("../../src/app/api/oauth/meta/auto-import/route.js");
    const res = await POST();
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(createProviderConnection).not.toHaveBeenCalled();
  });
});
