import { DefaultExecutor } from "./default.js";
import {
  getMimoAccountCookie,
  getMimoAccountBase,
  resolveMimoServerBase,
  invalidateMimoAccountCookieCache,
  MIMO_API_UA,
} from "../shared/mimoAccount.js";

// Models served by the account-service route (cookie auth, NOT the sk- key).
// Matches the Desktop harness: exclusive Preview tiles plus subscription
// aliases mimo-auto / mimo-flash / mimo-pro.
const ACCOUNT_ROUTE_MODELS = new Set([
  "mimo-x-pro-preview",
  "mimo-x-flash-preview",
  "mimo-auto",
  "mimo-flash",
  "mimo-pro",
]);

// Desktop maps the public `mimo-auto` alias onto flash (or pro). The account
// route rejects a literal `mimo-auto` on some regions (chat_model_not_public).
const AUTO_ALIAS_UPSTREAM = "mimo-x-flash-preview";

// Dual-route v2.6 models.
// v2.6 models dynamically route to the account service when desktop session credentials
// (mimoPassToken or account cookie) are present to consume weekly quota, falling back to
// the cloud API (sk- key) otherwise.
const ACCOUNT_MODELS = new Set([
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
]);

// Session cookie resolved in execute() (async) and read back by buildHeaders()
// (sync — BaseExecutor.execute does not await it). Carried on the per-request
// credentials object, same as runtimeTransport.
const COOKIE_KEY = "__mimoAccountCookie";
const BASE_KEY = "__mimoAccountBase";

// Upstream calls may hand us either the bare id or a `provider/model` ref.
function bareModel(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export class XiaomiMimoExecutor extends DefaultExecutor {
  constructor() {
    super("xiaomi-mimo");
  }

  static isAccountRouteModel(model) {
    return ACCOUNT_ROUTE_MODELS.has(bareModel(model));
  }

  /** Back-compat alias used by older tests / callers. */
  static isPreviewModel(model) {
    return XiaomiMimoExecutor.isAccountRouteModel(model);
  }

  static isAccountRoute(model, credentials) {
    const bare = bareModel(model);
    // Preview/subscription tiles always ride the account-service route.
    if (ACCOUNT_ROUTE_MODELS.has(bare)) return true;
    // v2.6 trio only when desktop session credentials are present.
    if (!ACCOUNT_MODELS.has(bare)) return false;
    return Boolean(
      credentials?.[COOKIE_KEY] ||
      credentials?.providerSpecificData?.mimoPassToken
    );
  }

  isAccountRoute(model, credentials) {
    return XiaomiMimoExecutor.isAccountRoute(model, credentials);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const bare = bareModel(model);
    // Preview/subscription tiles live on mimo-server-<region>, which is not one of
    // the declared cloud transports — resolve before the default runtimeTransport.
    if (ACCOUNT_ROUTE_MODELS.has(bare)) {
      const base =
        credentials?.[BASE_KEY] ||
        getMimoAccountBase(credentials?.providerSpecificData);
      return `${base}/route/chat/completions`;
    }
    // v2.6 dual-route: account service only when desktop credentials are present.
    if (XiaomiMimoExecutor.isAccountRoute(model, credentials)) {
      return `${resolveMimoServerBase(credentials?.providerSpecificData)}/api/route/chat/completions`;
    }
    // Cloud API models keep default handling, so a Claude-format client reaches
    // the /anthropic/v1/messages transport.
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true, url, model) {
    if (XiaomiMimoExecutor.isAccountRoute(model, credentials) && credentials?.[COOKIE_KEY]) {
      // Account-route models authenticate with the account-session cookie, not the key.
      return {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": MIMO_API_UA,
        Cookie: credentials[COOKIE_KEY],
      };
    }
    return super.buildHeaders(credentials, stream, url, model);
  }

  transformRequest(model, body, stream, credentials) {
    // super runs stripUnsupportedParams, which flattens content-part
    // arrays (see the xiaomi-mimo rule in translator/concerns/paramSupport.js).
    const out = super.transformRequest(model, body, stream, credentials);

    const bare = bareModel(model);
    const isV26Account =
      ACCOUNT_MODELS.has(bare) &&
      Boolean(credentials?.[COOKIE_KEY] || credentials?.providerSpecificData?.mimoPassToken);

    // The account-service route 415s (biz_code 10008 media_type_not_supported)
    // when `stream` is absent from the JSON body — the transport-level Accept
    // header alone is not enough. Default it, never override an explicit value.
    if (ACCOUNT_ROUTE_MODELS.has(bare) && out.stream == null && stream != null) {
      out.stream = stream;
    }

    // Preview models: thinking/params get defaults only — never override what the
    // caller set explicitly. (body.model is already `xiaomi/<id>` via upstreamModelId.)
    // Subscription aliases (mimo-flash/pro) stay untouched — Desktop sends them as-is.
    if (bare === "mimo-x-pro-preview" || bare === "mimo-x-flash-preview") {
      if (out.thinking == null) out.thinking = { type: "enabled" };
      if (out.temperature == null) out.temperature = 1.0;
      if (out.top_p == null) out.top_p = 0.95;
    }

    // v2.6 account route: bridge reasoning_effort to official output_config.effort
    // (matches MiMo Desktop app.asar behavior).
    if (isV26Account) {
      const rawEffort = out.reasoning_effort || body?.reasoning_effort || body?.output_config?.effort;
      if (rawEffort) {
        delete out.reasoning_effort;
        const norm = String(rawEffort).toLowerCase() === "xhigh" ? "high" : String(rawEffort).toLowerCase();
        out.output_config = { ...(out.output_config || {}), effort: norm };
      }

      if (out.temperature == null) out.temperature = 1.0;
      if (out.top_p == null) out.top_p = 0.95;
    }
    // `mimo-auto` is a client-facing alias; upstream wants a concrete tile.
    if (bare === "mimo-auto" || out.model === "mimo-auto" || out.model === "xiaomi/mimo-auto") {
      out.model = `xiaomi/${AUTO_ALIAS_UPSTREAM}`;
    }

    return out;
  }

  async execute(args) {
    const { model, credentials, proxyOptions = null } = args;
    if (!XiaomiMimoExecutor.isAccountRoute(model, credentials)) return super.execute(args);

    const psd = credentials?.providerSpecificData;
    const cookie = await getMimoAccountCookie(psd, proxyOptions);
    if (!cookie) {
      return super.execute(args);
    }
    credentials[COOKIE_KEY] = cookie;
    credentials[BASE_KEY] = getMimoAccountBase(psd);
    const result = await super.execute(args);

    // A cached session can expire early — drop it and retry once with a fresh one.
    if (result.response.status === 401) {
      invalidateMimoAccountCookieCache();
      const fresh = await getMimoAccountCookie(psd, proxyOptions).catch(() => null);
      if (fresh) {
        credentials[COOKIE_KEY] = fresh;
        credentials[BASE_KEY] = getMimoAccountBase(psd);
        return super.execute(args);
      }
    }
    return result;
  }
}

export const __test__ = {
  ACCOUNT_ROUTE_MODELS,
  PREVIEW_MODELS: ACCOUNT_ROUTE_MODELS, // back-compat
  ACCOUNT_MODELS,
  bareModel,
  COOKIE_KEY,
  BASE_KEY,
};

export default XiaomiMimoExecutor;
