import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/shared/mimoAccount.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Keep region helpers real; pin cookie resolution so unit tests never SSO.
    getMimoAccountCookie: vi.fn(async () => null),
  };
});

import { XiaomiMimoExecutor, __test__ } from "../../open-sse/executors/xiaomi-mimo.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import * as mimoAccount from "../../open-sse/shared/mimoAccount.js";

const {
  bareModel,
  COOKIE_KEY,
  BASE_KEY,
  ACCOUNT_ROUTE_MODELS = new Set(),
  ACCOUNT_MODELS = new Set(),
} = __test__;

const OPENAI_T = { runtimeTransport: { format: "openai", baseUrl: "https://api.xiaomimimo.com/v1/chat/completions" } };
const CLAUDE_T = { runtimeTransport: { format: "claude", baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages" } };

// Pin region so assertions do not depend on the host's Desktop apm-region.json.
const CN_CRED = { providerSpecificData: { mimoRegion: "cn" } };
const SGP_CRED = { providerSpecificData: { mimoRegion: "sgp" } };

describe("xiaomi-mimo executor", () => {
  let ex;
  beforeEach(() => {
    ex = new XiaomiMimoExecutor();
  });

  it("is registered for xiaomi-mimo", () => {
    expect(getExecutor("xiaomi-mimo")).toBeInstanceOf(XiaomiMimoExecutor);
  });

  it("treats Desktop subscription aliases as account-route models", () => {
    for (const id of ["mimo-auto", "mimo-flash", "mimo-pro", "mimo-x-pro-preview", "mimo-x-flash-preview"]) {
      expect(ACCOUNT_ROUTE_MODELS.has(id)).toBe(true);
      expect(XiaomiMimoExecutor.isAccountRouteModel(id)).toBe(true);
    }
    expect(XiaomiMimoExecutor.isAccountRouteModel("mimo-v2.5-pro")).toBe(false);
  });

  it("routes Preview models to the region account-service route", () => {
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, { ...OPENAI_T, ...CN_CRED })).toBe(
      "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions",
    );
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, { ...CLAUDE_T, ...SGP_CRED })).toBe(
      "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions",
    );
    // body.model arrives as `xiaomi/<id>` via upstreamModelId
    expect(ex.buildUrl("xiaomi/mimo-x-flash-preview", true, 0, { ...OPENAI_T, ...CN_CRED })).toBe(
      "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions",
    );
  });

  it("routes subscription aliases to the same account-service route", () => {
    expect(ex.buildUrl("mimo-auto", true, 0, { ...OPENAI_T, ...SGP_CRED })).toBe(
      "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions",
    );
    expect(ex.buildUrl("mimo-pro", true, 0, { ...OPENAI_T, ...SGP_CRED })).toBe(
      "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions",
    );
  });

  it("keeps the sourceFormat-matched endpoint for cloud models", () => {
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
  });

  it("routes v2.6 models to account route when desktop credentials are present", () => {
    // No region → SGP default
    const expected = "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions";
    const credsWithToken = { providerSpecificData: { mimoPassToken: "token123" } };
    const credsWithCookie = { [COOKIE_KEY]: "serviceToken=abc" };

    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, credsWithToken)).toBe(expected);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, credsWithCookie)).toBe(expected);
    expect(ex.buildUrl("xiaomi/mimo-v2.6-flash", true, 0, credsWithToken)).toBe(expected);
  });

  it("routes v2.6 models to cloud API when no desktop credentials are present", () => {
    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
  });

  it("resolves the account-service cluster per connection region", () => {
    const cn = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
    const sgp = "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions";
    const ams = "https://mimo-server-ams.xiaomimimo.com/api/route/chat/completions";
    const ru = "https://mimo-server-ru.xiaomimimo.com/api/route/chat/completions";
    const inRegion = "https://mimo-server-in.xiaomimimo.com/api/route/chat/completions";
    // default (no region) falls back to SGP (the international cluster)
    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, { providerSpecificData: { mimoPassToken: "t" } })).toBe(sgp);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "cn", mimoPassToken: "t" } })).toBe(cn);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "sgp", mimoPassToken: "t" } })).toBe(sgp);
    expect(ex.buildUrl("mimo-v2.6-flash", true, 0, { providerSpecificData: { region: "SGP", mimoPassToken: "t" } })).toBe(sgp);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "ams", mimoPassToken: "t" } })).toBe(ams);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "ru", mimoPassToken: "t" } })).toBe(ru);
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "in", mimoPassToken: "t" } })).toBe(inRegion);
    // unknown region falls back to SGP
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, { providerSpecificData: { region: "eu", mimoPassToken: "t" } })).toBe(sgp);
  });

  it("authenticates v2.6 calls with account cookie when on account route", () => {
    const headers = ex.buildHeaders(
      { [COOKIE_KEY]: "serviceToken=abc", accessToken: "sk-x" },
      true,
      "u",
      "mimo-v2.6-flash",
    );
    expect(headers.Cookie).toBe("serviceToken=abc");
    expect(headers.Authorization).toBeUndefined();
  });

  it("authenticates cloud calls with the bearer key", () => {
    const headers = ex.buildHeaders({ accessToken: "sk-x" }, true, "u", "mimo-v2.5-pro");
    expect(headers.Authorization).toBe("Bearer sk-x");
    expect(headers.Cookie).toBeUndefined();
  });

  it("preserves content-part arrays for multimodal inputs", () => {
    const parts = [{ type: "image_url", image_url: { url: "data:image/png;base64,xyz" } }, { type: "text", text: "hi" }];
    const out = ex.transformRequest(
      "mimo-v2.6-pro",
      { messages: [{ role: "user", content: parts }] },
      true,
      { providerSpecificData: { mimoPassToken: "token" } },
    );
    expect(out.messages[0].content).toEqual(parts);
  });

  it("bridges reasoning_effort to official output_config.effort", () => {
    const creds = { providerSpecificData: { mimoPassToken: "token" } };
    const body = {
      messages: [{ role: "user", content: "solve" }],
      reasoning_effort: "high",
    };
    const out = ex.transformRequest("mimo-v2.6-pro", body, true, creds);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("normalizes xhigh reasoning_effort to high in output_config.effort", () => {
    const creds = { providerSpecificData: { mimoPassToken: "token" } };
    const body = {
      messages: [{ role: "user", content: "complex" }],
      reasoning_effort: "xhigh",
    };
    const out = ex.transformRequest("mimo-v2.6-pro", body, true, creds);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("applies defaults without overriding explicit values", () => {
    const creds = { providerSpecificData: { mimoPassToken: "token" } };
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.2 };
    const out = ex.transformRequest("mimo-v2.6-pro", body, true, creds);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.95);
  });

  it("does not stamp Preview defaults onto subscription aliases", () => {
    const out = ex.transformRequest("mimo-auto", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
    expect(out.temperature).toBeUndefined();
  });

  it("leaves cloud bodies free of account defaults", () => {
    const out = ex.transformRequest("mimo-v2.5-pro", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.output_config).toBeUndefined();
    expect(out.temperature).toBeUndefined();
  });

  it("strips a provider/model prefix when testing model ids", () => {
    expect(bareModel("xiaomi/mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(bareModel("mimo-v2.6-flash")).toBe("mimo-v2.6-flash");
  });

  it("defaults stream on account-route bodies (route 415s without it)", () => {
    // Regression: the account-service route returns 415 media_type_not_supported
    // (biz_code 10008) when `stream` is absent from the JSON body.
    expect(ex.transformRequest("mimo-x-flash-preview", { messages: [] }, true, {}).stream).toBe(true);
    expect(ex.transformRequest("mimo-x-pro-preview", { messages: [] }, false, {}).stream).toBe(false);
    expect(ex.transformRequest("mimo-auto", { messages: [] }, true, {}).stream).toBe(true);
  });

  it("never overrides an explicit stream value on account-route bodies", () => {
    expect(ex.transformRequest("mimo-x-flash-preview", { messages: [], stream: false }, true, {}).stream).toBe(false);
    expect(ex.transformRequest("mimo-x-flash-preview", { messages: [], stream: true }, false, {}).stream).toBe(true);
  });

  it("leaves cloud bodies without a stamped stream flag", () => {
    expect(ex.transformRequest("mimo-v2.5-pro", { messages: [] }, true, {}).stream).toBeUndefined();
  });
});
