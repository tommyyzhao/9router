import { describe, expect, it } from "vitest";
import { stripStrictOpenAiExtras } from "../../open-sse/utils/strictOpenAiExtras.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("stripStrictOpenAiExtras", () => {
  it("removes store and metadata without mutating the original body", () => {
    const body = {
      model: "haiku-class-safe",
      messages: [{ role: "user", content: "ok" }],
      store: false,
      metadata: { foo: "bar" },
      max_tokens: 16,
    };
    const out = stripStrictOpenAiExtras(body);
    expect(out.store).toBeUndefined();
    expect(out.metadata).toBeUndefined();
    expect(out.max_tokens).toBe(16);
    expect(body.store).toBe(false);
  });

  it("returns the same object when nothing to strip", () => {
    const body = { model: "x", messages: [] };
    expect(stripStrictOpenAiExtras(body)).toBe(body);
  });

  it("tolerates null / non-objects", () => {
    expect(stripStrictOpenAiExtras(null)).toBe(null);
    expect(stripStrictOpenAiExtras(undefined)).toBe(undefined);
  });
});

describe("combo schema-reject fallback classification", () => {
  it("classifies mistral-vibe store 422 as fallback-eligible", () => {
    const msg =
      '[422]: {"object":"error","message":{"detail":[{"type":"extra_forbidden","loc":["body","store"],"msg":"Extra inputs are not permitted","input":false}]},"type":"invalid_request_error"}';
    const result = checkFallbackError(422, msg);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(0);
  });

  it("still does not fallback on generic 400 request errors", () => {
    const result = checkFallbackError(400, "This model's maximum context length is exceeded");
    expect(result.shouldFallback).toBe(false);
  });
});
