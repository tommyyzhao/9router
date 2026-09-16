import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

/**
 * Xiaomi MiMo account-session helpers (Desktop harness parity).
 *
 * Weekly quota, Desktop-exclusive Preview models, and subscription aliases
 * (mimo-auto / mimo-flash / mimo-pro) live on the account service and are
 * authorized by an account session cookie, NOT the sk- API key.
 *
 * Acquiring that cookie mirrors MiMo Desktop: a passToken (persisted in
 * Desktop's Chromium cookie store) is exchanged via passportapi SSO, then
 * authorized for the `mimopc` service, and finally stamped by the mimo-server
 * /api/sts callback into a `serviceToken` cookie.
 *
 * Flow (verified against MiMo Desktop traffic):
 *   1. GET  {api}/api/user/xiaomi/me           -> 302 carrying callback + region sid
 *   2. GET  account /pass/serviceLogin?sid=passportapi&_json=true   -> nonce/ssecurity
 *   3. GET  {location}&clientSign=...          -> account-level serviceToken
 *   4. GET  account /pass/serviceLogin?sid=<region>&callback=<sts>&_json=true
 *   5. GET  {api}/api/sts?...&ticket...        -> Set-Cookie: serviceToken
 *
 * Sid is region-specific (mimopc / mimosgp / …) and is taken from the step-1
 * redirect — hardcoding mimopc fails overseas (this host is SGP).
 *
 * Region: Desktop picks mimo-server-<region> (sgp/ru/in; cn for domestic).
 * This host's Desktop is SGP — hardcoding CN breaks overseas Preview + quota.
 */

const ACCOUNT_HOST = "account.xiaomi.com";
const API_UA =
  "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0";
const SSO_UA = "MiClaw/1.0";
const COOKIE_TTL_MS = 30 * 60 * 1000;

/** Overseas account-service hosts from the Desktop engine (asar). */
const ACCOUNT_HOSTS = {
  sgp: "mimo-server-sgp.xiaomimimo.com",
  ru: "mimo-server-ru.xiaomimimo.com",
  in: "mimo-server-in.xiaomimimo.com",
  // Domestic edition — explicit override; not in the overseas host map.
  cn: "mimo-server-cn.xiaomimimo.com",
};

const DEFAULT_REGION = "sgp";

// Per-account session caches (keyed by passToken hash) so multiple Xiaomi
// accounts / connections can rotate without clobbering each other.
const _cache = new Map(); // key -> { cookie, at }
const _inflight = new Map(); // key -> Promise<cookie|null>

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function userDataRoots() {
  const home = homeDir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [
      path.join(appData, "Xiaomi MiMo AI"),
      path.join(appData, "Xiaomi MiMo"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Xiaomi MiMo AI"),
      path.join(home, "Library", "Application Support", "Xiaomi MiMo"),
    ];
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    path.join(xdg, "Xiaomi MiMo AI"),
    path.join(xdg, "Xiaomi MiMo"),
  ];
}

/**
 * Ordered candidate cookie DB paths. Current Desktop (26.912.x) stores cookies
 * at Partitions/xiaomi-account/Cookies — not under Network/, and the app folder
 * is "Xiaomi MiMo AI". Keep legacy layouts as fallbacks.
 * @returns {string[]}
 */
export function desktopCookiePathCandidates() {
  const out = [];
  for (const root of userDataRoots()) {
    out.push(path.join(root, "Partitions", "xiaomi-account", "Cookies"));
    out.push(path.join(root, "Partitions", "xiaomi-account", "Network", "Cookies"));
  }
  return out;
}

/** First existing cookie DB path, or null. */
export function desktopCookiePath() {
  for (const p of desktopCookiePathCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Normalize a region token the way Desktop does (case-insensitive).
 * @param {unknown} raw
 * @returns {"sgp"|"ru"|"in"|"cn"|null}
 */
export function normalizeMimoRegion(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  if (t === "CN") return "cn";
  if (t === "IN") return "in";
  if (t === "RU" || t === "BY" || t === "KZ") return "ru";
  if (t === "SGP" || t === "SG") return "sgp";
  // EU maps to the SGP overseas edition in Desktop's default path.
  if (t === "EU") return "sgp";
  return null;
}

/**
 * Read Desktop's cached APM region (…/apm-region.json).
 * @returns {string|null} lowercase region id
 */
export function readDesktopRegion() {
  for (const root of userDataRoots()) {
    try {
      const p = path.join(root, "apm-region.json");
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      const r = normalizeMimoRegion(j?.region);
      if (r) return r;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Resolve the account-service API base (`https://mimo-server-…/api`).
 * Priority: connection override → Desktop apm-region.json → sgp.
 * @param {object|null} providerSpecificData
 * @returns {string}
 */
export function getMimoAccountBase(providerSpecificData = null) {
  const fromConn = normalizeMimoRegion(providerSpecificData?.mimoRegion);
  const region = fromConn || readDesktopRegion() || DEFAULT_REGION;
  const host = ACCOUNT_HOSTS[region] || ACCOUNT_HOSTS[DEFAULT_REGION];
  return `https://${host}/api`;
}

/** mimo-server account API base (legacy export; prefer getMimoAccountBase). */
export const MIMO_API_BASE = `https://${ACCOUNT_HOSTS[DEFAULT_REGION]}/api`;
export const MIMO_API_UA = API_UA;

async function readCookieJarFromPath(src) {
  if (!src || !fs.existsSync(src)) return null;
  const tmp = path.join(os.tmpdir(), `9r-mimo-cookies-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`);
  try {
    fs.copyFileSync(src, tmp);
  } catch {
    return null; // locked by a running Desktop
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(tmp, { readOnly: true });
    // Desktop writes account cookies under .account.xiaomi.com and .xiaomi.com.
    const rows = db
      .prepare("SELECT name, value FROM cookies WHERE host_key IN (?, ?) AND value != ''")
      .all("." + ACCOUNT_HOST, ".xiaomi.com");
    db.close();
    const jar = {};
    for (const r of rows) {
      if (r?.name && r?.value && !(r.name in jar)) jar[r.name] = r.value;
    }
    return jar.passToken ? jar : null;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read the persisted Xiaomi account cookies from MiMo Desktop's Electron profile.
 * The Chromium cookie DB is held with an exclusive lock while Desktop runs, so we
 * copy it first and bail (return null) if that fails.
 * @returns {Promise<Record<string,string>|null>}
 */
async function readDesktopAccountCookies() {
  for (const src of desktopCookiePathCandidates()) {
    const jar = await readCookieJarFromPath(src);
    if (jar?.passToken) return jar;
  }
  return null;
}

/**
 * Read just the passToken + identity cookies from Desktop's profile.
 * Exported so the connect flow can persist a per-account passToken into the
 * connection's providerSpecificData — this is what enables multi-account rotation.
 * @returns {Promise<{passToken:string, userId:string|null, cUserId:string|null, region:string|null}|null>}
 */
export async function readDesktopPassToken() {
  try {
    const jar = await readDesktopAccountCookies();
    if (!jar?.passToken) return null;
    return {
      passToken: jar.passToken,
      userId: jar.userId || null,
      cUserId: jar.cUserId || null,
      region: readDesktopRegion(),
    };
  } catch {
    return null;
  }
}

function signatureClientSign(nonce, ssecurity) {
  const input = `nonce=${nonce}` + (ssecurity && ssecurity.trim() ? `&${ssecurity}` : "");
  return encodeURIComponent(crypto.createHash("sha1").update(input).digest("base64"));
}

function absorbSetCookie(jar, res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = /^([^=]+)=([^;]*)/.exec(c.trim());
    if (m && m[2]) jar[m[1]] = m[2];
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Exchange a passToken for a mimo-server service session cookie.
 * @returns {Promise<string|null>} Cookie header value, or null on failure.
 */
async function acquireServiceCookie(passJar, apiBase, proxyOptions) {
  const jar = { ...passJar };
  const ck = () => cookieHeader(jar);

  // 1. Unauthenticated API call -> 302 carrying the sts callback + region sid
  //    (sid is region-specific: mimopc / mimosgp / … — never hardcode it).
  const r1 = await proxyAwareFetch(
    `${apiBase}/user/xiaomi/me`,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() } },
    proxyOptions,
  );
  const redirect = r1.headers.get("location");
  if (!redirect) return null;
  const redirectUrl = new URL(redirect);
  const stsCallback = redirectUrl.searchParams.get("callback");
  const sid = redirectUrl.searchParams.get("sid") || "mimopc";
  if (!stsCallback) return null;

  // 2. passportapi SSO phase 1 -> nonce + ssecurity
  const sso1 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=passportapi&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" } },
    proxyOptions,
  );
  const j1 = JSON.parse((await sso1.text()).replace(/^&&&START&&&/, ""));
  const nonce = j1.nonce || (j1.location ? new URL(j1.location).searchParams.get("nonce") : null);
  if (!nonce || !j1.location) return null;

  // 3. passportapi SSO phase 2 -> account-level serviceToken
  const sso2 = await proxyAwareFetch(
    `${j1.location}&clientSign=${signatureClientSign(nonce, j1.ssecurity)}`,
    { redirect: "manual", headers: { Cookie: ck(), "User-Agent": SSO_UA } },
    proxyOptions,
  );
  absorbSetCookie(jar, sso2);

  // 4. region SSO (sid from step 1) -> sts callback carrying a ticket
  const sso3 = await proxyAwareFetch(
    `https://${ACCOUNT_HOST}/pass/serviceLogin?sid=${encodeURIComponent(sid)}&callback=${encodeURIComponent(stsCallback)}&_json=true`,
    { headers: { Cookie: ck(), "User-Agent": SSO_UA, Accept: "application/json" } },
    proxyOptions,
  );
  const j3 = JSON.parse((await sso3.text()).replace(/^&&&START&&&/, ""));
  absorbSetCookie(jar, sso3);
  if (!j3?.location || !/\/api\/sts/.test(j3.location)) return null;

  // 5. sts callback -> Set-Cookie: serviceToken (mimopc scope)
  const sts = await proxyAwareFetch(
    j3.location,
    { redirect: "manual", headers: { "User-Agent": API_UA, Cookie: ck() } },
    proxyOptions,
  );
  absorbSetCookie(jar, sts);

  const needed = ["serviceToken", "mimopc_ph", "mimopc_slh", "userId"];
  if (!jar.serviceToken) return null;
  const out = {};
  for (const k of needed) if (jar[k]) out[k] = jar[k];
  return cookieHeader(out);
}

/**
 * Get (and cache) the mimo-server account cookie.
 * @param {object|null} providerSpecificData - may carry `mimoPassToken` + `mimoRegion`
 */
async function getServiceCookie(providerSpecificData, proxyOptions) {
  const passJar = providerSpecificData?.mimoPassToken
    ? { passToken: providerSpecificData.mimoPassToken, userId: providerSpecificData.mimoUserId, cUserId: providerSpecificData.mimoCUserId }
    : await readDesktopAccountCookies();
  if (!passJar) return { cookie: null, reason: "no-pass-token" };

  const apiBase = getMimoAccountBase(providerSpecificData);

  // One cached session per passToken — accounts/connections rotate independently.
  const key = crypto.createHash("sha256").update(passJar.passToken).digest("hex");

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < COOKIE_TTL_MS) {
    return { cookie: cached.cookie, apiBase };
  }

  // De-dupe concurrent handshakes for the same account: a burst of requests must
  // not each run the full 5-step SSO chain.
  const inflight = _inflight.get(key);
  if (inflight) {
    const cookie = await inflight;
    return cookie ? { cookie, apiBase } : { cookie: null, reason: "sso-failed" };
  }

  const promise = (async () => {
    try {
      return await acquireServiceCookie(passJar, apiBase, proxyOptions);
    } catch {
      return null; // network/parse failure — callers degrade, never throw
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);

  const cookie = await promise;
  if (!cookie) return { cookie: null, reason: "sso-failed" };
  _cache.set(key, { cookie, at: Date.now() });
  return { cookie, apiBase };
}

/** Drop cached sessions so the next call re-runs the handshake (e.g. after a 401). */
export function invalidateMimoAccountCookieCache() {
  _cache.clear();
}

/**
 * Resolve the mimo-server account-session cookie, for upstream /api/route/* calls.
 * @returns {Promise<string|null>} Cookie header value, or null when unavailable.
 */
export async function getMimoAccountCookie(providerSpecificData = null, proxyOptions = null) {
  try {
    const { cookie } = await getServiceCookie(providerSpecificData, proxyOptions);
    return cookie;
  } catch {
    return null;
  }
}

/**
 * Fetch the weekly quota from the account service.
 * @returns {Promise<{percent?:number, resetDate?:string, resetAt?:number, error?:string}>}
 */
export async function getMimoAccountUsage(providerSpecificData = null, proxyOptions = null) {
  const { cookie, reason, apiBase } = await getServiceCookie(providerSpecificData, proxyOptions);
  if (!cookie) {
    return { error: reason === "no-pass-token" ? "no-session" : "session-failed" };
  }
  try {
    const res = await proxyAwareFetch(
      `${apiBase || getMimoAccountBase(providerSpecificData)}/user/usage`,
      { headers: { "User-Agent": API_UA, Cookie: cookie, Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
      proxyOptions,
    );
    if (!res.ok) return { error: `http-${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 0 || !data.data) return { error: "bad-response" };
    return { percent: data.data.percent, resetDate: data.data.resetDate, resetAt: data.data.resetAt };
  } catch (e) {
    return { error: e.message };
  }
}

export const __test__ = {
  ACCOUNT_HOSTS,
  DEFAULT_REGION,
  userDataRoots,
};
