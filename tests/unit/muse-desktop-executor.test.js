/**
 * Unit tests for the muse-desktop executor and session helpers.
 * No network, no real credentials (synthetic JWTs only).
 */
import { describe, it, expect, vi } from "vitest";
import { MuseDesktopExecutor, __test__ } from "../../open-sse/executors/muse-desktop.js";
import { resolveMuseSession, decodeAdmissionToken, isAuthFailure } from "../../open-sse/shared/museSession.js";

const { bareModel, toHatchItems, estimateUsage, CHAT_CAPS } = __test__;

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "EdDSA", kid: "x" })}.${b64(payload)}.sig`;
}

describe("muse-desktop session", () => {
  it("derives vm_id from the admission token env_id claim", () => {
    const token = fakeJwt({ env_id: "vm-123", iat: 1 });
    const s = resolveMuseSession({ providerSpecificData: { museAdmissionToken: token } });
    expect(s.vmId).toBe("vm-123");
    expect(s.gatewayHost).toBe("hatch.metaaivm.com");
    expect(s.appId).toBe("hatch-web");
  });

  it("prefers explicit providerSpecificData overrides", () => {
    const token = fakeJwt({ env_id: "vm-123" });
    const s = resolveMuseSession({
      providerSpecificData: {
        museAdmissionToken: token,
        museNotaryToken: "nt",
        museGatewayHost: "gw.example",
        museAppId: "hatch-desktop",
      },
    });
    expect(s.notaryToken).toBe("nt");
    expect(s.gatewayHost).toBe("gw.example");
    expect(s.appId).toBe("hatch-desktop");
  });

  it("throws a reconnect hint when no session is present", () => {
    expect(() => resolveMuseSession({ providerSpecificData: {} })).toThrow(/session unavailable/);
    expect(() => resolveMuseSession({})).toThrow(/session unavailable/);
  });

  it("rejects malformed tokens", () => {
    expect(() => decodeAdmissionToken("not-a-jwt")).toThrow(/malformed/);
    expect(() => resolveMuseSession({ providerSpecificData: { museAdmissionToken: fakeJwt({}) } }))
      .toThrow(/no env_id/);
  });

  it("detects auth failures", () => {
    expect(isAuthFailure(Object.assign(new Error("gateway rejected session"), { status: 401 }))).toBe(true);
    expect(isAuthFailure(new Error("401 Unauthorized"))).toBe(true);
    expect(isAuthFailure(new Error("handshake timeout"))).toBe(false);
    expect(isAuthFailure(new Error("Unsupported state or unable to authenticate data"))).toBe(false);
    expect(isAuthFailure(new Error("tokenizer failed"))).toBe(false);
  });
});

describe("muse-desktop executor", () => {
  it("strips provider/model prefixes", () => {
    expect(bareModel("muse-desktop/muse-spark")).toBe("muse-spark");
    expect(bareModel("muse-spark")).toBe("muse-spark");
  });

  it("formats OpenAI messages into hatch items", () => {
    const items = toHatchItems({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: [{ type: "text", text: "OK" }] },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("text");
    expect(items[0].text).toContain("[system] Be brief.");
    expect(items[0].text).toContain("Hi");
    expect(items[0].text).toContain("[assistant] Hello");
    expect(items[0].text).toContain("OK");
  });

  it("advertises the web client's capability set", () => {
    expect(CHAT_CAPS).toEqual(
      expect.arrayContaining(["chat_cancel", "delta_stream", "custom_reactions"]),
    );
  });

  it("estimates usage when the gateway reports none", () => {
    const u = estimateUsage("abcd", "efgh");
    expect(u.prompt_tokens).toBe(1);
    expect(u.total_tokens).toBe(u.prompt_tokens + u.completion_tokens);
    expect(u.estimated).toBe(true);
  });

  it("fails fast without a session", async () => {
    const ex = new MuseDesktopExecutor();
    await expect(
      ex.execute({ model: "muse-spark", body: { messages: [] }, stream: false, credentials: {}, log: null }),
    ).rejects.toThrow(/session unavailable/);
  });

  it("rejects empty prompts", async () => {
    const ex = new MuseDesktopExecutor();
    const token = fakeJwt({ env_id: "vm-123" });
    await expect(
      ex.execute({
        model: "muse-spark",
        body: { messages: [] },
        stream: false,
        credentials: { providerSpecificData: { museAdmissionToken: token } },
        log: null,
      }),
    ).rejects.toThrow(/empty prompt/);
  });

  it("targets the Noise gateway, not HTTPS", () => {
    const ex = new MuseDesktopExecutor();
    expect(ex.buildUrl()).toBe("wss://hatch.metaaivm.com/v1/noise");
  });

  it("rejects concurrent turns for the same VM", async () => {
    const ex = new MuseDesktopExecutor();
    let release;
    ex.runTurn = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const token = fakeJwt({ env_id: "vm-locked" });
    const args = {
      model: "muse-spark",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { providerSpecificData: { museAdmissionToken: token } },
      log: null,
    };
    const first = ex.execute(args);
    await vi.waitFor(() => expect(ex.runTurn).toHaveBeenCalledOnce());
    await expect(ex.execute(args)).rejects.toThrow(/another turn is active/);
    release({ text: "PONG", usage: null, events: [] });
    await first;
  });

  it("bridges a successful PONG turn into OpenAI SSE", async () => {
    const ex = new MuseDesktopExecutor();
    ex.runTurn = vi.fn(async ({ onDelta }) => {
      onDelta("PONG");
      return { text: "PONG", usage: null, events: [] };
    });
    const token = fakeJwt({ env_id: "vm-123" });
    const result = await ex.execute({
      model: "muse-desktop/muse-spark",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: true,
      credentials: { providerSpecificData: { museAdmissionToken: token } },
      log: null,
    });
    const output = await result.response.text();
    expect(ex.runTurn).toHaveBeenCalledOnce();
    expect(output).toContain("PONG");
    expect(output).toContain("data: [DONE]");
  });
});
