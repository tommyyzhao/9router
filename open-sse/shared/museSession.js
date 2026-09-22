/**
 * Muse Desktop session helpers — clean-room.
 *
 * A Muse session for the Noise gateway is the triple minted by the Hatch
 * control plane:
 *   - admission JWT  (POST /api/hatch/token -> token;  Desktop: /hatch/fetch_leased_vm)
 *   - notary endorsement (same call -> notary_token; optional but recommended)
 *   - vm_id, carried in the JWT's env_id claim
 *
 * In 9router these live on the connection's providerSpecificData:
 *   { museAdmissionToken, museNotaryToken?, museGatewayHost?, museAppId? }
 * This module resolves and validates them; it never logs secret values.
 */

export const DEFAULT_GATEWAY_HOST = "hatch.metaaivm.com";
export const DEFAULT_APP_ID = "hatch-web";
export const DEFAULT_ORIGIN = "https://muse.ai";

export function validateMuseGatewayHost(host) {
  if (typeof host !== "string" || !host || host.length > 253 || /[\r\n/?#@]/.test(host)) {
    throw new Error(`invalid Muse gateway host: ${host || "missing"}`);
  }
  let parsed;
  try { parsed = new URL(`wss://${host}`); } catch {
    throw new Error(`invalid Muse gateway host: ${host}`);
  }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`invalid Muse gateway host: ${host}`);
  }
  return host;
}

export function validateMuseOrigin(origin) {
  if (typeof origin !== "string" || !origin || origin.length > 2048 || /[\r\n]/.test(origin)) {
    throw new Error(`invalid Muse origin: ${origin || "missing"}`);
  }
  let parsed;
  try { parsed = new URL(origin); } catch {
    throw new Error(`invalid Muse origin: ${origin}`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`invalid Muse origin: ${origin}`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function validateMuseAppId(appId) {
  if (typeof appId !== "string" || !appId || appId.length > 128 || /[\r\n]/.test(appId)) {
    throw new Error("invalid Muse app id");
  }
  return appId;
}

function b64urlDecode(seg) {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Extract the JWT payload claims without verifying (admission is server-checked). */
export function decodeAdmissionToken(token) {
  if (typeof token !== "string" || !token) throw new Error("missing admission token");
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("malformed admission token");
  try {
    return JSON.parse(b64urlDecode(parts[1]));
  } catch {
    throw new Error("malformed admission token payload");
  }
}

/**
 * Resolve a live session from a 9router credentials object.
 * Returns {gatewayHost, vmId, authToken, notaryToken, appId, origin}.
 * Throws with a reconnect hint when the session is absent/invalid.
 */
export function resolveMuseSession(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const authToken = psd.museAdmissionToken || credentials?.accessToken;
  if (!authToken) {
    throw new Error(
      "Muse Desktop session unavailable. Connect your Muse session (paste the " +
      "admission token from your logged-in Muse app), then retry.",
    );
  }
  let claims;
  try {
    claims = decodeAdmissionToken(authToken);
  } catch (e) {
    throw new Error(`Muse Desktop session invalid: ${e.message}`);
  }
  if (typeof claims.env_id !== "string" || !claims.env_id.trim()) {
    throw new Error("Muse Desktop session invalid: admission token carries no env_id");
  }
  if (claims.exp !== undefined &&
      (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= 0)) {
    throw new Error("Muse Desktop session invalid: admission token has invalid exp");
  }
  if (claims.exp !== undefined && Date.now() / 1000 >= claims.exp) {
    throw new Error("Muse Desktop session expired. Reconnect your Muse session.");
  }
  if (psd.museVmId !== undefined && psd.museVmId !== claims.env_id) {
    throw new Error("Muse Desktop session invalid: vm_id does not match admission token");
  }
  let gatewayHost;
  let appId;
  let origin;
  try {
    gatewayHost = validateMuseGatewayHost(psd.museGatewayHost || DEFAULT_GATEWAY_HOST);
    appId = validateMuseAppId(psd.museAppId || DEFAULT_APP_ID);
    origin = validateMuseOrigin(psd.museOrigin || DEFAULT_ORIGIN);
  } catch (e) {
    throw new Error(`Muse Desktop session invalid: ${e.message}`);
  }
  return {
    gatewayHost,
    vmId: claims.env_id,
    authToken,
    notaryToken: psd.museNotaryToken || null,
    appId,
    origin,
  };
}

/** True only for an explicit admission/session authentication rejection. */
export function isAuthFailure(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
  if (status === 401 || status === 403) return true;

  const code = String(err?.code || "").toUpperCase();
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "AUTH_REQUIRED") return true;

  const message = String(err?.message || "");
  return /\b(?:unauthorized|forbidden)\b/i.test(message) ||
    /\b(?:expired|invalid|rejected)\s+(?:Muse\s+Desktop\s+)?(?:admission|session|access)?\s*token\b/i.test(message) ||
    /\b(?:admission|session|access)\s+token\s+(?:expired|invalid|rejected)\b/i.test(message);
}

export const __test__ = { b64urlDecode };
