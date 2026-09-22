import { describe, expect, test } from "bun:test";
import { extractAssistantTextFromList } from "../../open-sse/shared/grokBotEphemeral.js";

describe("extractAssistantTextFromList", () => {
  test("reads send-message content", () => {
    const raw = `xx{"kind":"send-message","id":"t0s0","message":{"type":"text","content":"pong"},"timestampMs":1}yy`;
    expect(extractAssistantTextFromList(raw)).toBe("pong");
  });
  test("uses last send-message", () => {
    const raw = `"kind":"send-message","message":{"type":"text","content":"one"} "kind":"send-message","message":{"type":"text","content":"two"}`;
    expect(extractAssistantTextFromList(raw)).toBe("two");
  });
  test("null when absent", () => {
    expect(extractAssistantTextFromList("nope")).toBe(null);
  });
});
