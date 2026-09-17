/**
 * Muse Code usage — no REST usage/billing path on api.meta.ai for CLI-minted
 * LLM| keys (probed /v1/usage*, /muse-code/usage*, /v1/billing*, /v1/subscription*
 * → 404). MSP documents 5h/weekly usedPercent as host-observed frames only.
 * Quota Tracker card is credential health + local spend via usageHistory.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const MODELS_URL = "https://api.meta.ai/v1/models";

function buildMetaHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "muse-code/1.3.0",
  };
}

/**
 * @param {string|null|undefined} accessToken - CLI-minted LLM| key
 * @param {object|null} proxyOptions
 */
export async function getMetaUsage(accessToken = null, proxyOptions = null) {
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    return { message: "Muse Code access token not available. Import muse login or connect." };
  }

  if (!accessToken.startsWith("LLM|")) {
    return {
      plan: "Muse Code",
      message:
        "Stored token is not a Model API key (expected LLM|…). Re-import from Muse CLI.",
    };
  }

  try {
    const response = await proxyAwareFetch(
      MODELS_URL,
      { method: "GET", headers: buildMetaHeaders(accessToken.trim()) },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: "Muse Code",
        message: "Muse Code authentication failed. Re-import from Muse CLI or reconnect.",
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: "Muse Code",
        message: `Muse Code models API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    await response.text().catch(() => {});

    return {
      plan: "Muse Code",
      localSpend: true,
      message:
        "Subscription key valid. Meta does not expose 5h/weekly % over Model API HTTP; showing spend routed through 9Router.",
      quotas: {},
    };
  } catch (error) {
    return { message: `Muse Code usage error: ${error.message}` };
  }
}
