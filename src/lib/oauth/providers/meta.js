import { META_OAUTH_CONFIG } from "../constants/oauth.js";

const USER_AGENT = "muse-code/1.3.0";

function pickInferenceToken(tokens) {
  if (typeof tokens?.api_key === "string" && tokens.api_key.startsWith("LLM|")) return tokens.api_key;
  if (typeof tokens?.access_token === "string" && tokens.access_token.startsWith("LLM|")) return tokens.access_token;
  return null;
}

const meta = {
  config: META_OAUTH_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ client_id: config.clientId }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Muse Code device code request failed: ${error}`);
    }
    return await response.json();
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: config.clientId,
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      const text = await response.text();
      data = { error: "invalid_response", error_description: text };
    }

    const pending = data?.error === "authorization_pending" || data?.error === "slow_down";
    return {
      ok: response.ok || pending,
      data,
    };
  },
  postExchange: async (tokens) => {
    const minted = pickInferenceToken(tokens);
    if (!minted) {
      throw new Error(
        "Muse Code device login did not return a subscription Model API key. Run `muse login` then use Import from Muse CLI.",
      );
    }
    return { mintedApiKey: minted };
  },
  mapTokens: (tokens, extra) => {
    const apiKey = extra?.mintedApiKey || pickInferenceToken(tokens);
    if (!apiKey) {
      throw new Error("Muse Code login produced no subscription key");
    }
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;
    return {
      accessToken: apiKey,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in,
      expiresAt,
      email: extra?.email || undefined,
      displayName: extra?.displayName || undefined,
      providerSpecificData: {
        authMethod: "device_code",
        oauthAccessToken: typeof tokens.access_token === "string" && !tokens.access_token.startsWith("LLM|")
          ? tokens.access_token
          : null,
        mintedApiKey: true,
      },
    };
  },
};

export default meta;
