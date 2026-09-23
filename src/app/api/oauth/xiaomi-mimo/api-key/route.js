import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/xiaomi-mimo/api-key
 * Import Xiaomi MiMo credentials from auto-import or manual entry.
 *
 * Accepts:
 *   - apiKey (sk-…) + optional passToken/region
 *   - passToken-only (current Desktop: cookie session, no auth.json key)
 *
 * Body: { apiKey?, uid?, baseUrl?, mimoPassToken?, mimoUserId?, mimoCUserId?, mimoRegion? }
 */
export async function POST(request) {
  try {
<    const {
      apiKey,
      uid,
      baseUrl,
      mimoPassToken,
      mimoUserId,
      mimoCUserId,
      mimoRegion,
      region: bodyRegion,
    } = await request.json();

    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    const hasKey = !!key;
    const hasSession = !!(typeof mimoPassToken === "string" && mimoPassToken.trim());
    const sessionOnly = !hasKey && hasSession;

    if (!hasKey && !hasSession) {
      return NextResponse.json(
        { error: "Provide an sk- API key or a Desktop account session (passToken)" },
        { status: 400 },
      );
    }

<    if (hasKey && !key.startsWith("sk-")) {
      return NextResponse.json(
        { error: "Invalid key format — expected sk- prefix" },
        { status: 400 },
      );
    }

    const effectiveBaseUrl = (baseUrl || "https://api.xiaomimimo.com/v1").replace(/\/+$/, "");
    // Accept BOTH `mimoRegion` and `region` body fields (prefer mimoRegion, fallback region).
    const regionRaw =
      typeof mimoRegion === "string" && mimoRegion.trim()
        ? mimoRegion.trim()
        : typeof bodyRegion === "string" && bodyRegion.trim()
          ? bodyRegion.trim()
          : null;
    const region = regionRaw ? regionRaw.toLowerCase() : null;

    // Validate the key against the models endpoint (skipped for session-only)
    let validated = false;
    let modelCount = 0;
<    if (hasKey) {
      try {
        const resp = await fetch(`${effectiveBaseUrl}/models`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
            "X-Mimo-Source": "mimocode-cli",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const data = await resp.json();
          modelCount = Array.isArray(data?.data) ? data.data.length : 0;
          validated = true;
        }
      } catch {
        // Network error — still allow import (key may be valid but network blocked)
      }
<    } else {
      validated = true; // session-only: account route is the credential surface
    }

    if (hasKey && !validated) {
      console.log("[xiaomi-mimo] key validation failed, storing as untested");
    }

    const sessionFields = {
      mimoPassToken: hasSession ? mimoPassToken.trim() : null,
      mimoUserId: mimoUserId || null,
      mimoCUserId: mimoCUserId || null,
      mimoRegion: region,
    };

    // Dedup: same uid, same key, or same session identity+region
    const { getProviderConnections, updateProviderConnection } = await import("@/models");
    const normRegion = (typeof region === "string" && region) || undefined;
    const existing = (await getProviderConnections()).find(
      (c) => c.provider === "xiaomi-mimo" && (
        (uid && c.email === `${uid}@xiaomi`) ||
        (hasKey && c.accessToken === key) ||
        (sessionOnly && mimoUserId &&
          c.providerSpecificData?.mimoUserId === mimoUserId &&
          (normRegion ? (c.providerSpecificData?.region || "cn") === normRegion : true))
      ),
    );
    if (existing) {
      const updated = await updateProviderConnection(existing.id, {
        accessToken: hasKey ? key : existing.accessToken || null,
        providerSpecificData: {
          ...existing.providerSpecificData,
          uid: uid || existing.providerSpecificData?.uid || null,
          baseUrl: key ? effectiveBaseUrl : (existing.providerSpecificData?.baseUrl || effectiveBaseUrl),
          region: normRegion || existing.providerSpecificData?.region || "cn",
          authMethod: sessionOnly ? "session" : (existing.providerSpecificData?.authMethod || "api_key"),
          // Per-account session credential — enables multi-account rotation.
          mimoPassToken: sessionFields.mimoPassToken || existing.providerSpecificData?.mimoPassToken || null,
          mimoUserId: sessionFields.mimoUserId || existing.providerSpecificData?.mimoUserId || null,
          mimoCUserId: sessionFields.mimoCUserId || existing.providerSpecificData?.mimoCUserId || null,
          mimoRegion: sessionFields.mimoRegion || existing.providerSpecificData?.mimoRegion || null,
          modelCount,
        },
        testStatus: validated ? "active" : existing.testStatus,
      });
      return NextResponse.json({
        success: true,
        validated,
        modelCount,
        updated: true,
        connection: {
          id: existing.id,
          provider: existing.provider,
          email: existing.email,
          displayName: existing.displayName,
        },
      });
    }

    const connection = await createProviderConnection({
      provider: "xiaomi-mimo",
      // "oauth" is the official authType for imported credential connections
      // ([action]/route.js) — the list card and filters key off it; never
      // invent new values ("session" hid the row from the provider card).
      authType: sessionOnly ? "oauth" : "api_key",
      accessToken: key || null,
      refreshToken: null,
      // API keys don't expire on a fixed schedule; use a long horizon
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      email: uid ? `${uid}@xiaomi` : (mimoUserId ? `${mimoUserId}@xiaomi` : null),
      displayName: uid
        ? `Xiaomi ${uid}${sessionOnly ? " (Session)" : ""}`
        : mimoUserId
          ? `Xiaomi ${mimoUserId}${sessionOnly ? " (Session)" : ""}`
          : "Xiaomi MiMo",
      providerSpecificData: {
        uid: uid || mimoUserId || null,
        baseUrl: effectiveBaseUrl,
        authMethod: sessionOnly ? "session" : "api_key",
        provider: sessionOnly ? "Session Login" : "API Key",
        region: normRegion || "cn",
        modelCount,
        // Per-account session credential — enables multi-account rotation.
        mimoPassToken: sessionFields.mimoPassToken,
        mimoUserId: sessionFields.mimoUserId,
        mimoCUserId: sessionFields.mimoCUserId,
        mimoRegion: sessionFields.mimoRegion,
      },
      testStatus: validated ? "active" : (sessionOnly ? "active" : "untested"),
    });

    return NextResponse.json({
      success: true,
      validated,
      modelCount,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    console.log("Xiaomi MiMo API key import error:", error);
    return NextResponse.json(
      { error: "API key import failed" },
      { status: 500 },
    );
  }
}
