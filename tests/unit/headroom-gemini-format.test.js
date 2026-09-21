// Headroom compression for Gemini-shaped bodies (contents[]/systemInstruction).
// Unlike Claude/Codex, Gemini bodies are NOT translated through the OpenAI
// pivot (lossy: systemInstruction collapse, generationConfig rebuild,
// thoughtSignature loss). Instead compressible text is projected to
// OpenAI-shaped pseudo-messages by position, sent to the proxy, and the
// compressed text is written back into the original objects in place.
// Everything else (thoughtSignature, `thought:true` parts, inlineData,
// functionCall args, generationConfig, safetySettings, tools) must stay
// byte-identical.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom gemini format", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compresses systemInstruction/text/functionResponse in place, leaves the rest untouched", async () => {
    let requestPayload;
    global.fetch = vi.fn(async (_url, init) => {
      requestPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        messages: [
          { role: "system", content: "helpful assistant" },
          { role: "user", content: "search cats" },
          { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{\"q\":\"cats\"}" } }] },
          { role: "tool", content: JSON.stringify({ results: ["cat1"] }), tool_call_id: "call_1" },
          { role: "user", content: "summarize please" },
        ],
        tokens_before: 200,
        tokens_after: 60,
        tokens_saved: 140,
      }), { status: 200 });
    });

    const body = {
      systemInstruction: { parts: [{ text: "You are a helpful assistant with a very long prompt." }] },
      contents: [
        { role: "user", parts: [{ text: "Please search for cats, a very long request." }] },
        {
          role: "model",
          parts: [
            { text: "Let me think about this quietly.", thought: true },
            { functionCall: { id: "call_1", name: "search", args: { q: "cats" } }, thoughtSignature: "sig-abc" },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { id: "call_1", name: "search", response: { results: ["cat1", "cat2"], meta: "x".repeat(200) } } },
          ],
        },
        { role: "user", parts: [{ text: "Thanks, please summarize the results now." }] },
      ],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
      tools: [{ functionDeclarations: [{ name: "search", parameters: {} }] }],
      safetySettings: [{ category: "HARM", threshold: "BLOCK_NONE" }],
    };
    const originalGenerationConfig = structuredClone(body.generationConfig);
    const originalTools = structuredClone(body.tools);
    const originalSafety = structuredClone(body.safetySettings);

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gemini-2.5-pro",
      format: "gemini",
    });

    expect(data).not.toBeNull();
    expect(data.tokens_saved).toBe(140);

    // outgoing payload: 5 projected messages, thought part excluded
    expect(requestPayload.messages).toHaveLength(5);
    expect(requestPayload.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);

    // targeted slots updated
    expect(body.systemInstruction.parts[0].text).toBe("helpful assistant");
    expect(body.contents[0].parts[0].text).toBe("search cats");
    expect(body.contents[3].parts[0].text).toBe("summarize please");
    expect(body.contents[2].parts[0].functionResponse.response).toEqual({ results: ["cat1"] });
    expect(body.contents[2].parts[0].functionResponse.id).toBe("call_1");
    expect(body.contents[2].parts[0].functionResponse.name).toBe("search");

    // untouched: thought part, functionCall args/id/name, thoughtSignature
    expect(body.contents[1].parts[0]).toEqual({ text: "Let me think about this quietly.", thought: true });
    expect(body.contents[1].parts[1].functionCall).toEqual({ id: "call_1", name: "search", args: { q: "cats" } });
    expect(body.contents[1].parts[1].thoughtSignature).toBe("sig-abc");

    // untouched: generationConfig / tools / safetySettings / roles
    expect(body.generationConfig).toEqual(originalGenerationConfig);
    expect(body.tools).toEqual(originalTools);
    expect(body.safetySettings).toEqual(originalSafety);
    expect(body.contents[1].role).toBe("model");
  });

  it("fails open (returns null, body untouched) when proxy message count doesn't match", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "user", content: "only one" }],
      tokens_saved: 10,
    }), { status: 200 }));

    const body = {
      contents: [
        { role: "user", parts: [{ text: "first" }] },
        { role: "user", parts: [{ text: "second" }] },
      ],
    };
    const original = structuredClone(body);
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gemini-2.5-pro",
      format: "gemini",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(body).toEqual(original);
    expect(diagnostics.reason).toBe("proxy response did not match Gemini message count");
  });

  it("wraps a non-JSON compressed functionResponse back into the original shape", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ role: "tool", content: "a shortened plain summary", tool_call_id: "call_9" }],
      tokens_saved: 5,
    }), { status: 200 }));

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ functionResponse: { id: "call_9", name: "lookup", response: { output: "a very long original tool output" } } }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gemini-2.5-pro",
      format: "gemini",
    });

    expect(data).not.toBeNull();
    expect(body.contents[0].parts[0].functionResponse.response).toEqual({ output: "a shortened plain summary" });
  });

  it("never sends thought:true parts to the proxy", async () => {
    let requestPayload;
    global.fetch = vi.fn(async (_url, init) => {
      requestPayload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        messages: [{ role: "user", content: "visible text" }],
        tokens_saved: 1,
      }), { status: 200 });
    });

    const body = {
      contents: [
        {
          role: "model",
          parts: [{ text: "secret internal reasoning that must never leave the process", thought: true }],
        },
        { role: "user", parts: [{ text: "visible text, long enough to be worth compressing" }] },
      ],
    };

    await compressWithHeadroom(body, {
      enabled: true,
      url: "http://localhost:8787",
      model: "gemini-2.5-pro",
      format: "gemini",
    });

    expect(JSON.stringify(requestPayload)).not.toContain("secret internal reasoning");
    expect(requestPayload.messages).toHaveLength(1);
  });
});
