import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      new Set(["exec"])
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat) => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it("converts a Responses SSE aggregate to Claude Messages", async () => {
    const encoder = new TextEncoder();
    const raw = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp-claude", created_at: 1700000000 } })}`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] } })}`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } })}`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 2, item: { type: "function_call", call_id: "call_r", name: "shell", arguments: '{"cmd":"ls"}' } })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-claude", status: "completed", usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, input_tokens_details: { cached_tokens: 5 } } } })}`,
      ""
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      ...sseCtx(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES),
      provider: "codex",
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } })
    });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call_r", name: "shell", input: { cmd: "ls" } }
    ]);
    expect(json.usage).toEqual({ input_tokens: 3, output_tokens: 3, cache_read_input_tokens: 5 });
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = new Set(["shell"]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });

  it("converts chat SSE text, reasoning, tools, and cache usage to Claude Messages", async () => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-claude","model":"gpt-x","choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-claude","model":"gpt-x","choices":[{"delta":{"content":"answer"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-claude","model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_c","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-claude","model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":110,"completion_tokens":7,"total_tokens":117,"prompt_tokens_details":{"cached_tokens":100}}}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      ...sseCtx(FORMATS.CLAUDE, FORMATS.OPENAI),
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } })
    });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "call_c", name: "shell", input: { cmd: "pwd" } }
    ]);
    expect(json.usage).toEqual({ input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100 });
  });
});

describe("forced-SSE failures", () => {
  const errorCtx = (overrides = {}) => ({
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "gpt-x",
    body: { model: "gpt-x", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/messages" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    ...overrides
  });

  it("does not run success callbacks or accounting for terminal Responses errors", async () => {
    const onRequestSuccess = vi.fn();
    const appendLog = vi.fn();
    const payload = [
      `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { id: "resp-fail", error: { message: "quota" } } })}`,
      ""
    ].join("\n\n");
    const result = await handleForcedSSEToJson(errorCtx({
      onRequestSuccess,
      appendLog,
      providerResponse: new Response(payload, { headers: { "content-type": "text/event-stream" } })
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith({ status: "FAILED 502" });
  });

  it("treats a Responses stream without a terminal event as failed", async () => {
    const raw = [
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp-incomplete" } })}`,
      ""
    ].join("\n\n");
    const result = await handleForcedSSEToJson(errorCtx({
      providerResponse: new Response(raw, { headers: { "content-type": "text/event-stream" } })
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});

describe("forceStream provider that returns JSON instead of SSE", () => {
  it("returns the Responses JSON body to a Responses client", async () => {
    const payload = {
      id: "resp_json",
      object: "response",
      status: "completed",
      model: "muse-spark-1.3-contributor",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PONG" }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    };
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "meta",
      model: "muse-spark-1.3-contributor",
      body: { model: "muse-spark-1.3-contributor", stream: false },
      stream: true,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    expect(json.status).toBe("completed");
    expect(json.output[0].content[0].text).toBe("PONG");
  });
});
