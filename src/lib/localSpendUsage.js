/**
 * Local spend aggregation for providers without upstream quota HTTP.
 * Reads usageHistory (SQLite) by connectionId — open-sse stays host-agnostic.
 */

import { getLocalSpendForConnection } from "@/lib/db/repos/usageRepo.js";

/** Providers whose quota card is local spend + credential health only. */
export const LOCAL_SPEND_QUOTA_PROVIDERS = new Set(["mistral", "meta"]);

function spendQuotaRow(used) {
  const safeUsed = Math.max(0, Number(used) || 0);
  return {
    used: safeUsed,
    total: 0,
    remainingPercentage: 100,
    resetAt: null,
    unlimited: true,
  };
}

/**
 * Build QuotaTable rows from rolling local spend windows.
 * Rows are "used · Unlimited" counts — not upstream subscription %.
 */
export function buildLocalSpendQuotas(spend) {
  const quotas = {};
  if (!spend) return quotas;

  const windows = [
    ["7d", spend.d7],
    ["30d", spend.d30],
  ];

  for (const [label, w] of windows) {
    if (!w) continue;
    quotas[`Requests (${label})`] = spendQuotaRow(w.requests);
    quotas[`Prompt tokens (${label})`] = spendQuotaRow(w.promptTokens);
    quotas[`Completion tokens (${label})`] = spendQuotaRow(w.completionTokens);
  }

  const cost = Number(spend.d30?.cost) || 0;
  if (cost > 0) {
    // Display dollars directly (QuotaTable shows used.toLocaleString()).
    quotas["Est. cost (30d, USD)"] = spendQuotaRow(cost);
  }

  return quotas;
}

/**
 * Merge local-spend quota rows into a usage payload for LOCAL_SPEND_QUOTA_PROVIDERS.
 * Fail-open: any DB error leaves the upstream payload untouched.
 */
export async function enrichUsageWithLocalSpend(usage, connection) {
  if (!connection?.id || !LOCAL_SPEND_QUOTA_PROVIDERS.has(connection.provider)) {
    return usage;
  }

  try {
    const spend = await getLocalSpendForConnection(connection.id);
    const localQuotas = buildLocalSpendQuotas(spend);
    if (Object.keys(localQuotas).length === 0) return usage;

    const next = { ...(usage || {}) };
    next.localSpend = true;
    next.quotas = { ...(next.quotas || {}), ...localQuotas };
    // ProviderLimitCard hides QuotaTable whenever `message` is set.
    if (Object.keys(next.quotas).length > 0) delete next.message;
    if (!next.plan) {
      next.plan = connection.provider === "meta" ? "Muse Code" : "Mistral";
    }
    return next;
  } catch {
    return usage;
  }
}
