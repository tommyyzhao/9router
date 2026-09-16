import { describe, expect, it } from "vitest";
import { parseMuseSecretBlob, parseMuseAuthJson } from "../../src/lib/oauth/museCredentials.js";

describe("parseMuseSecretBlob", () => {
  it("reads the Keychain JSON shape from Muse Code 1.3", () => {
    const parsed = parseMuseSecretBlob({
      secret_schema_version: 1,
      api_key: "LLM|123|secret",
      access_token: "dca:not-an-inference-token",
    });
    expect(parsed.apiKey).toBe("LLM|123|secret");
    expect(parsed.oauthAccessToken).toBe("dca:not-an-inference-token");
  });

  it("accepts a bare LLM| key", () => {
    expect(parseMuseSecretBlob("LLM|abc|xyz").apiKey).toBe("LLM|abc|xyz");
  });

  it("rejects a device-code token without api_key", () => {
    expect(parseMuseSecretBlob({ access_token: "dca:only" })).toBeNull();
  });

  it("treats a file-stored LLM| access_token as the inference key", () => {
    const parsed = parseMuseSecretBlob({ access_token: "LLM|file|key" });
    expect(parsed.apiKey).toBe("LLM|file|key");
    expect(parsed.oauthAccessToken).toBeNull();
  });

  it("reads a JSON string blob", () => {
    const parsed = parseMuseSecretBlob(JSON.stringify({
      secret_schema_version: 1,
      api_key: "LLM|abc|xyz",
      access_token: "dca:oidc",
    }));
    expect(parsed.apiKey).toBe("LLM|abc|xyz");
    expect(parsed.oauthAccessToken).toBe("dca:oidc");
  });
});

describe("parseMuseAuthJson", () => {
  it("reads schema 2 pointer files", () => {
    const parsed = parseMuseAuthJson({
      schema_version: 2,
      providers: {
        meta: {
          mechanism: "oauth",
          storage: "keychain",
          obtained_via: "device_code",
          api_base_url: "https://api.meta.ai/v1",
          user_email: "user@example.com",
          user_full_name: "Example User",
        },
      },
    });
    expect(parsed.storage).toBe("keychain");
    expect(parsed.email).toBe("user@example.com");
    expect(parsed.apiBaseUrl).toBe("https://api.meta.ai/v1");
  });

  it("reads a file-stored access_token on older Linux layouts", () => {
    const parsed = parseMuseAuthJson({
      schema_version: 1,
      providers: {
        meta: {
          mechanism: "oauth",
          access_token: "LLM|file|key",
          user_email: "linux@example.com",
        },
      },
    });
    expect(parsed.fileAccessToken).toBe("LLM|file|key");
    expect(parsed.email).toBe("linux@example.com");
  });
});
