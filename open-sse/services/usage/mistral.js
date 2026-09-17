/**
 * Mistral usage — no public usage/billing HTTP for personal API keys
 * (probed api.mistral.ai /v1/usage*, console.mistral.ai/api/* → 404/401).
 * Quota Tracker card is credential health + local spend via usageHistory.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const MODELS_URL = "https://api.mistral.ai/v1/models";

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 */
export async function getMistralUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Mistral API key not available. Add a key to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      MODELS_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: "Mistral",
        message: "Mistral authentication failed. Check the API key.",
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: "Mistral",
        message: `Mistral models API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    await response.text().catch(() => {});

    return {
      plan: "Mistral",
      localSpend: true,
      message:
        "API key valid. Mistral does not expose numeric quota for this key; showing spend routed through 9Router.",
      quotas: {},
    };
  } catch (error) {
    return { message: `Mistral usage error: ${error.message}` };
  }
}
