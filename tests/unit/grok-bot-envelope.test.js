import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenMessagesToEnvelope, envelopeMarkers } from "../../open-sse/shared/grokBotEnvelope.js";

describe("flattenMessagesToEnvelope", () => {
  it("wraps markers and sections", () => {
    const out = flattenMessagesToEnvelope([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    const { start, end } = envelopeMarkers();
    assert.ok(out.startsWith(start));
    assert.ok(out.includes("[SYSTEM]"));
    assert.ok(out.includes("be brief"));
    assert.ok(out.includes("[TOOLS]"));
    assert.ok(out.includes("[HISTORY]"));
    assert.ok(out.includes("[USER]"));
    assert.ok(out.includes("hi"));
    assert.ok(out.trimEnd().endsWith(end));
  });

  it("puts prior turns in HISTORY and last user in USER", () => {
    const out = flattenMessagesToEnvelope([
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ]);
    assert.match(out, /\[HISTORY\][\s\S]*user: first/);
    assert.match(out, /\[HISTORY\][\s\S]*assistant: ok/);
    assert.match(out, /\[USER\]\nsecond/);
  });

  it("lists tools and injects protocol when tools present", () => {
    const out = flattenMessagesToEnvelope([{ role: "user", content: "write a file" }], {
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            description: "Write a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    });
    assert.match(out, /\[TOOLS\][\s\S]*write:/);
    assert.match(out, /tool_calls/);
    assert.match(out, /NO local filesystem/);
  });

  it("serializes assistant tool_calls and tool results in HISTORY", () => {
    const out = flattenMessagesToEnvelope([
      { role: "user", content: "make hi.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "write", arguments: '{"path":"hi.txt","content":"hello"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "wrote hi.txt" },
      { role: "user", content: "thanks" },
    ]);
    assert.match(out, /tool_call id=call_1 name=write/);
    assert.match(out, /tool id=call_1: wrote hi\.txt/);
    assert.match(out, /\[USER\]\nthanks/);
  });
});
