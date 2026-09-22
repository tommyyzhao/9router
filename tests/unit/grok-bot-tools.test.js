import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAssistantCompletion, formatToolsBlock } from "../../open-sse/shared/grokBotTools.js";

describe("parseAssistantCompletion", () => {
  it("parses bare tool_calls JSON", () => {
    const raw = JSON.stringify({
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "write", arguments: '{"path":"a.txt","content":"x"}' },
        },
      ],
    });
    const p = parseAssistantCompletion(raw);
    assert.equal(p.kind, "tool_calls");
    assert.equal(p.toolCalls[0].function.name, "write");
    assert.equal(p.toolCalls[0].id, "call_abc");
  });

  it("parses fenced JSON", () => {
    const raw = '```json\n{"tool_calls":[{"id":"c1","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}\n```';
    const p = parseAssistantCompletion(raw);
    assert.equal(p.kind, "tool_calls");
    assert.equal(p.toolCalls[0].function.name, "bash");
  });

  it("returns text for plain answers", () => {
    const p = parseAssistantCompletion("Hello from Grok Bot");
    assert.equal(p.kind, "text");
    assert.equal(p.text, "Hello from Grok Bot");
  });

  it("stringifies object arguments", () => {
    const raw = JSON.stringify({
      tool_calls: [{ id: "c", function: { name: "write", arguments: { path: "a" } } }],
    });
    const p = parseAssistantCompletion(raw);
    assert.equal(p.kind, "tool_calls");
    assert.equal(typeof p.toolCalls[0].function.arguments, "string");
    assert.match(p.toolCalls[0].function.arguments, /path/);
  });
});

describe("formatToolsBlock", () => {
  it("renders none for empty", () => {
    assert.equal(formatToolsBlock([]), "(none)");
  });
});
