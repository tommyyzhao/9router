/**
 * Muse Desktop executor — clean-room.
 *
 * Talks to the Muse gateway over Noise_XX_25519_AESGCM_SHA256 WebSocket
 * (see ../shared/museNoise.js) instead of plain HTTPS. Per request:
 *
 *   1. resolve the session (admission JWT + notary endorsement)
 *   2. Noise handshake on wss://<host>/v1/noise
 *   3. open chat.subscribe (server -> client event stream)
 *   4. send chat.stream (the user turn)
 *   5. translate subscribe events to OpenAI SSE (or a single JSON completion)
 *
 * Like the Cursor AgentService executor, this decodes a custom upstream
 * protocol into OpenAI-compatible output and declares
 * responseFormat: "openai".
 *
 * Requires the `ws` npm package (no new native deps).
 */

import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { HatchNoiseClient, ServiceType } from "../shared/museNoise.js";
import { resolveMuseSession, isAuthFailure } from "../shared/museSession.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { chatChunkSse, sseChunk } from "../utils/sse.js";
import { FORMATS } from "../translator/formats.js";

const CHAT_CAPS = ["chat_cancel", "delta_stream", "custom_reactions", "custom_reactions_facebook_thumbs_up_v1"];
const TURN_TIMEOUT_MS = 120000;
const SUBSCRIBE_TIMEOUT_MS = 30000;

// Best-effort resume cursor per gateway VM: avoids replaying the full event
// history on every request. Correctness never depends on it — turn events are
// correlated by message_id.
const lastSeqByVm = new Map();

function bareModel(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// Flatten an OpenAI messages[] into the single text item chat.stream expects.
// Stateless: the full history rides in the turn text (role-tagged except user).
export function toHatchItems(body) {
  const messages = body?.messages || [];
  const text = messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("")
        : String(m.content ?? "");
      if (!content) return "";
      return m.role === "user" ? content : `[${m.role}] ${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
  return [{ type: "text", text }];
}

function sseHeaders() {
  return { ...(SSE_HEADERS || {}), "Content-Type": "text/event-stream" };
}

async function buildProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) return null;
  try {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    throw new Error("Muse Desktop proxy is configured but https-proxy-agent is unavailable");
  }
}

export class MuseDesktopExecutor extends BaseExecutor {
  constructor() {
    super("muse-desktop", { noAuth: false });
  }

  // The Noise gateway is the only upstream; there is no per-transport HTTPS URL.
  buildUrl() {
    return "wss://hatch.metaaivm.com/v1/noise";
  }

  buildHeaders() {
    return {};
  }

  transformRequest(model, body, stream, credentials) {
    return body;
  }

  /**
   * Run one chat turn over the Noise gateway.
   * onDelta(text) fires incrementally for each assistant text delta.
   * Resolves with {text, usage, events} when the turn completes.
   */
  async runTurn({ session, items, signal, log, proxyAgent, onDelta }) {
    const client = new HatchNoiseClient();
    const events = [];
    let maxSeq = lastSeqByVm.get(session.vmId) || 0;

    const turnDone = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("muse-desktop turn timeout")), TURN_TIMEOUT_MS);
      const onAbort = () => finish(new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });

      let messageId = null;
      let sawOwnMessage = false;
      let replyText = "";
      let replyStarted = false;
      let usage = null;
      let sendTimeMs = 0;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try { client.close(); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve({ text: replyText, usage, events });
      };

      (async () => {
        try {
          await client.connect({ ...session, proxyAgent, signal });
          log?.debug?.("MUSE", `noise handshake ok (vm ${session.vmId.slice(0, 8)}…)`);

          // 1. subscribe (server -> client events)
          client.sendHttpRequest({
            method: "chat.subscribe", httpMethod: "POST", path: "/chat/subscribe",
            service: ServiceType.DAEMON,
            body: JSON.stringify({ after_stream_seq: maxSeq, after_chat_event_seq: 0, capabilities: CHAT_CAPS }),
            headers: { "x-request-id": crypto.randomUUID(), "x-app-id": session.appId, "Accept-Language": "en-US", "content-type": "application/json" },
            onRecord: (rec) => {
              if (typeof rec?.seq === "number" && rec.seq > maxSeq) maxSeq = rec.seq;
              events.push(rec);
              handleEvent(rec);
            },
            onError: (e) => finish(e),
            signal,
          });

          // 2. send the turn
          sendTimeMs = Date.now();
          const ack = await new Promise((ackResolve, ackReject) => {
            const ackTimer = setTimeout(() => ackReject(new Error("chat.stream ack timeout")), SUBSCRIBE_TIMEOUT_MS);
            client.sendHttpRequest({
              method: "chat.stream", httpMethod: "POST", path: "/chat/stream",
              service: ServiceType.DAEMON,
              body: JSON.stringify({ items, node_id: crypto.randomUUID(), capabilities: CHAT_CAPS }),
              headers: { "x-request-id": crypto.randomUUID(), "x-app-id": session.appId, "Accept-Language": "en-US", "content-type": "application/json" },
              onRecord: (rec) => { clearTimeout(ackTimer); ackResolve(rec); },
              onError: (e) => { clearTimeout(ackTimer); ackReject(e); },
              signal,
            });
          });
          messageId = ack?.message_id || null;
          log?.debug?.("MUSE", `chat.stream ack message_id=${messageId}`);
          // If the ack carried no id (or the subscribe already replayed past
          // it), fall back to "first reply after send" correlation.
          if (!messageId) sawOwnMessage = true;
        } catch (e) {
          finish(e);
        }
      })();

      function handleEvent(rec) {
        if (!rec || typeof rec !== "object") return;
        const ev = rec.event;
        const payload = rec.payload || {};
        if (ev === "message.user" && messageId && payload.message_id === messageId) {
          sawOwnMessage = true;
          return;
        }
        // Fallback correlation: the first assistant message_start timestamped
        // at/after our send is ours (replay events are older; 5s grace covers
        // client/server clock skew).
        if (!sawOwnMessage && ev === "delta.message_start" &&
            typeof rec.ts_ms === "number" && rec.ts_ms >= sendTimeMs - 5000) {
          sawOwnMessage = true;
        }
        if (!sawOwnMessage) return; // still draining replay
        if (ev === "delta.message_start") {
          replyStarted = true;
          replyText = "";
        } else if (ev === "delta.text_append" && replyStarted) {
          if (typeof payload.text === "string") {
            replyText += payload.text;
            try { onDelta?.(payload.text); } catch { /* ignore */ }
          }
        } else if (ev === "delta.message_done" && replyStarted) {
          usage = payload.usage || payload.token_usage || null;
          lastSeqByVm.set(session.vmId, maxSeq);
          finish(null);
        } else if (ev === "error" || ev === "turn.error") {
          finish(new Error(`muse-desktop upstream error: ${JSON.stringify(payload).slice(0, 300)}`));
        }
      }
    });

    return turnDone;
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const session = resolveMuseSession(credentials);
    const items = toHatchItems(body);
    if (!items[0].text) throw new Error("muse-desktop: empty prompt");
    const proxyAgent = await buildProxyAgent();
    const responseId = `chatcmpl-muse-${crypto.randomUUID().slice(0, 8)}`;
    const created = Math.floor(Date.now() / 1000);
    const modelId = bareModel(model) || "muse-spark";
    const url = this.buildUrl();

    if (!stream) {
      // Non-streaming: run the turn, return one JSON completion.
      let turn;
      try {
        turn = await this.runTurn({ session, items, signal, log, proxyAgent });
      } catch (e) {
        if (isAuthFailure(e)) throw new Error(`Muse Desktop session expired or rejected (${e.message}). Reconnect your Muse session.`);
        throw e;
      }
      const completion = {
        id: responseId, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: turn.text }, finish_reason: "stop" }],
        usage: turn.usage || estimateUsage(items[0].text, turn.text),
      };
      return {
        response: new Response(JSON.stringify(completion), { headers: { "Content-Type": "application/json" } }),
        url, headers: {}, transformedBody: body, responseFormat: FORMATS.OPENAI,
      };
    }

    // Streaming: bridge the Noise turn into an SSE ReadableStream with true
    // incremental deltas.
    const encoder = new TextEncoder();
    const streamAbort = new AbortController();
    const mergedSignal = typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, streamAbort.signal].filter(Boolean))
      : streamAbort.signal;
    let cancelled = false;
    const responseStream = new ReadableStream({
      start: (controller) => {
        let sentRole = false;
        const sendDelta = (content) => {
          const chunk = chatChunkSse({
            id: responseId, created, model: modelId,
            delta: { ...(sentRole ? {} : { role: "assistant" }), content },
          });
          sentRole = true;
          controller.enqueue(encoder.encode(chunk));
        };
        this.runTurn({
          session, items, signal: mergedSignal, log, proxyAgent,
          onDelta: (text) => { if (!cancelled && text) sendDelta(text); },
        }).then(
          () => {
            if (cancelled) return;
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model: modelId, delta: {}, finishReason: "stop" })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          },
          (error) => {
            if (cancelled) return;
            const msg = isAuthFailure(error)
              ? `Muse Desktop session expired or rejected (${error.message}). Reconnect your Muse session.`
              : String(error?.message || error);
            controller.enqueue(encoder.encode(sseChunk({ error: { message: msg, type: "api_error" } })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          },
        );
      },
      cancel: () => {
        cancelled = true;
        streamAbort.abort();
      },
    });

    return {
      response: new Response(responseStream, { headers: sseHeaders() }),
      url, headers: {}, transformedBody: body, responseFormat: FORMATS.OPENAI,
    };
  }
}

function estimateUsage(promptText, completionText) {
  const tok = (s) => Math.max(1, Math.round((s || "").length / 4));
  const prompt_tokens = tok(promptText);
  const completion_tokens = tok(completionText);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens, estimated: true };
}

export const __test__ = { bareModel, toHatchItems, estimateUsage, CHAT_CAPS };

export default MuseDesktopExecutor;
