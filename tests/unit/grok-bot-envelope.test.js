import { describe, it, expect } from "bun:test";
import {
  flattenMessagesToEnvelope,
  envelopeMarkers,
} from "../../open-sse/shared/grokBotEnvelope.js";

describe("flattenMessagesToEnvelope", () => {
  it("places system, history, and final user", () => {
    const out = flattenMessagesToEnvelope([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "2+2?" },
    ]);
    const { start, end } = envelopeMarkers();
    expect(out.startsWith(start)).toBe(true);
    expect(out.endsWith(end)).toBe(true);
    expect(out).toContain("[SYSTEM]\nbe brief");
    expect(out).toContain("user: hi");
    expect(out).toContain("assistant: hello");
    expect(out).toContain("[USER]\n2+2?");
    // final user must not also appear as history line after last assistant only once in USER
    expect(out.match(/2\+2\?/g)?.length).toBe(1);
  });

  it("joins array content parts", () => {
    const out = flattenMessagesToEnvelope([
      {
        role: "user",
        content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      },
    ]);
    expect(out).toContain("[USER]\na\nb");
  });

  it("handles empty messages", () => {
    const out = flattenMessagesToEnvelope([]);
    expect(out).toContain("[SYSTEM]\n(none)");
    expect(out).toContain("[USER]\n(empty)");
  });
});
