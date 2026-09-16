import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { PROVIDERS, PROVIDER_OAUTH, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { MetaExecutor, parseMetaSuffix } from "../../open-sse/executors/meta.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers.js";
import { stripCallerBoundReasoning } from "../../open-sse/utils/callerBoundReasoning.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("meta registry", () => {
  it("is an oauth-only Muse Code subscription provider", () => {
    expect(PROVIDERS.meta).toBeTruthy();
    expect(PROVIDERS.meta.baseUrl).toBe("https://api.meta.ai/v1/responses");
    expect(PROVIDERS.meta.format).toBe("openai-responses");
    expect(PROVIDERS.meta.thinkingFormat).toBe("meta");
    expect(PROVIDER_OAUTH.meta?.deviceCodeUrl).toContain("auth.meta.com");
    expect(OAUTH_PROVIDERS.meta).toBeTruthy();
    expect(OAUTH_PROVIDERS.meta.authModes).toEqual(["oauth"]);
    expect(OAUTH_PROVIDERS.meta.authModes).not.toContain("apikey");
  });

  it("resolves aliases", () => {
    expect(resolveProviderAlias("meta")).toBe("meta");
    expect(resolveProviderAlias("muse")).toBe("meta");
    expect(resolveProviderAlias("muse-code")).toBe("meta");
    expect(resolveProviderAlias("meta-ai")).toBe("meta");
  });

  it("does not shadow ollama-search in the registry index", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(ids).toContain("meta");
    expect(ids).toContain("ollama-search");
    expect(ids.filter((id) => id === "meta")).toHaveLength(1);
    expect(ids.filter((id) => id === "ollama-search")).toHaveLength(1);
  });

  it("targets Muse Spark to Responses", () => {
    expect(getModelTargetFormat("meta", "muse-spark-1.3-contributor")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelTargetFormat("meta", "muse-spark-1.3-xhigh")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(PROVIDER_MODELS.meta?.some((m) => m.id === "muse-spark-1.3-contributor")).toBe(true);
  });
});

describe("meta capabilities", () => {
  it("Muse Spark reasons and cannot disable thinking", () => {
    const caps = getCapabilitiesForModel("meta", "muse-spark-1.3-contributor");
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("meta");
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("resolves dash-suffixed ids to the meta format", () => {
    const caps = getCapabilitiesForModel("meta", "muse-spark-1.3-xhigh");
    expect(caps.thinkingFormat).toBe("meta");
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("does not leak the meta format into opencode", () => {
    expect(getCapabilitiesForModel("opencode", "muse-spark-1.3-contributor-free").thinkingFormat).toBe("openai");
  });

  it("exposes levels without none", () => {
    expect(getThinkingLevels("meta", "muse-spark-1.3")).toEqual([
      "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
  });
});

describe("meta thinking mapping", () => {
  it("passes supported levels through", () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const body = {};
      applyThinking(FORMATS.OPENAI, "muse-spark-1.3", body, "meta", { mode: "level", level });
      expect(body.reasoning_effort).toBe(level);
    }
  });

  it("omits reasoning_effort for a literal none level", () => {
    const body = {};
    applyThinking(FORMATS.OPENAI, "muse-spark-1.3", body, "meta", { mode: "level", level: "none" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("clamps the none mode to minimal", () => {
    const body = {};
    applyThinking(FORMATS.OPENAI, "muse-spark-1.3", body, "meta", { mode: "none" });
    expect(body.reasoning_effort).toBe("minimal");
  });
});

describe("MetaExecutor", () => {
  it("is registered", () => {
    expect(hasSpecializedExecutor("meta")).toBe(true);
    expect(getExecutor("meta")).toBeInstanceOf(MetaExecutor);
    expect(getExecutor("muse")).toBeInstanceOf(MetaExecutor);
  });

  it("parses dash and paren suffixes", () => {
    expect(parseMetaSuffix("muse-spark-1.3-xhigh")).toEqual({ base: "muse-spark-1.3", level: "xhigh" });
    expect(parseMetaSuffix("muse-spark-1.3(high)")).toEqual({ base: "muse-spark-1.3", level: "high" });
    expect(parseMetaSuffix("muse-spark-1.3")).toEqual({ base: "muse-spark-1.3", level: null });
  });

  it("routes Muse Spark to /responses", () => {
    const ex = new MetaExecutor();
    expect(ex.buildUrl("muse-spark-1.3-contributor")).toBe("https://api.meta.ai/v1/responses");
    expect(ex.buildUrl("muse-spark-1.3-xhigh")).toBe("https://api.meta.ai/v1/responses");
  });

  it("renders Responses reasoning from a dash suffix", () => {
    const body = { model: "muse-spark-1.3-xhigh", input: [], max_tokens: 4096 };
    const out = new MetaExecutor().transformRequest("muse-spark-1.3-xhigh", body, true, {});
    expect(out.model).toBe("muse-spark-1.3");
    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.max_output_tokens).toBe(4096);
    expect(out.max_tokens).toBeUndefined();
    expect(out.store).toBe(false);
    expect(out.include).toContain("reasoning.encrypted_content");
    expect(out.messages).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });

  it("always requests encrypted reasoning on store-less loops", () => {
    const out = new MetaExecutor().transformRequest(
      "muse-spark-1.3-contributor",
      { model: "muse-spark-1.3-contributor", input: [{ type: "message", role: "user", content: "hi" }] },
      true,
      {},
    );
    expect(out.store).toBe(false);
    expect(out.include).toContain("reasoning.encrypted_content");
    expect(out.stream).toBe(true);
  });

  it("forces stream:true even when the client sent stream:false", () => {
    const out = new MetaExecutor().transformRequest(
      "muse-spark-1.3-contributor",
      { model: "muse-spark-1.3-contributor", stream: false, input: [] },
      true,
      {},
    );
    expect(out.stream).toBe(true);
  });

  it("clamps contributor max to xhigh", () => {
    const body = { model: "muse-spark-1.3-contributor-max", messages: [] };
    const out = new MetaExecutor().transformRequest("muse-spark-1.3-contributor-max", body, true, {});
    expect(out.model).toBe("muse-spark-1.3-contributor");
    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });

  it("translates Chat Completions into Responses end-to-end", () => {
    const body = {
      model: "meta/muse-spark-1.3-contributor",
      messages: [{ role: "user", content: "Think, then answer: 2 + 2?" }],
      reasoning_effort: "high",
      max_tokens: 2048,
    };
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "muse-spark-1.3-contributor",
      body,
      true,
      {},
      "meta",
    );
    const out = new MetaExecutor().transformRequest("muse-spark-1.3-contributor", translated, true, {});
    expect(out.model).toBe("muse-spark-1.3-contributor");
    expect(Array.isArray(out.input)).toBe(true);
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBe(2048);
    expect(out.include).toContain("reasoning.encrypted_content");
    expect(out.messages).toBeUndefined();
  });
});

describe("stripCallerBoundReasoning", () => {
  it("drops encrypted blobs from chat messages and Responses input", () => {
    const stripped = stripCallerBoundReasoning({
      messages: [
        { role: "assistant", content: "4", encrypted_content: "blob" },
        { role: "user", content: "again" },
      ],
      input: [
        { type: "reasoning", encrypted_content: "blob" },
        { type: "message", role: "assistant", content: "4" },
      ],
    });
    expect(stripped.messages[0].encrypted_content).toBeUndefined();
    expect(stripped.messages[0].content).toBe("4");
    expect(stripped.input).toEqual([{ type: "message", role: "assistant", content: "4" }]);
  });
});
