import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { CHAT_PATH_PROBE } from "../shared/grokBotAccount.js";
import { runEphemeralCompletion } from "../shared/grokBotEphemeral.js";
import { toOpenAiToolCallsMessage } from "../shared/grokBotTools.js";
import { FORMATS } from "../translator/formats.js";
import { chatChunkSse } from "../utils/sse.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";

/**
 * Grok Bot Desktop executor — ephemeral TEMPORAL harness, native OpenAI I/O.
 *
 * transport.format = openai so chatCore does not cursor-translate.
 * Returns responseFormat FORMATS.OPENAI. Supports tool_calls via text protocol.
 */
export class GrokBotDesktopExecutor extends BaseExecutor {
  constructor() {
    super("grok-bot", PROVIDERS["grok-bot"] || PROVIDERS.cursor);
  }

  buildUrl() {
    return `${this.config?.baseUrl || "https://api2.cursor.sh"}/aiserver.v1.GrokBotService/SendGrokBotUserMessage`;
  }

  buildHeaders(credentials) {
    const accessToken = credentials.accessToken;
    const machineId = credentials.providerSpecificData?.machineId;
    const ghostMode = credentials.providerSpecificData?.ghostMode !== false;
    if (!machineId) {
      throw new Error("Machine ID is required for Grok Bot Desktop API");
    }
    return buildCursorHeaders(accessToken, machineId, ghostMode, {
      clientType: "sand",
      clientSource: "sand-desktop",
      clientVersion: "0.57.1",
    });
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const accessToken = credentials?.accessToken;
    const machineId = credentials?.providerSpecificData?.machineId;
    if (!accessToken || !machineId) {
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: "Grok Bot Desktop connection missing accessToken or machineId. Re-run Desktop auto-import.",
              type: "grok_bot_credentials",
              code: "missing_credentials",
              probe: { status: CHAT_PATH_PROBE.status, next: CHAT_PATH_PROBE.next },
            },
          }),
          { status: HTTP_STATUS.UNAUTHORIZED || 401, headers: { "Content-Type": "application/json" } },
        ),
        responseFormat: FORMATS.OPENAI,
      };
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : undefined;
    const modelId = typeof model === "string" ? model.split("/").pop() : model || body?.model || "default";
    const base = this.config?.baseUrl || "https://api2.cursor.sh";

    let result;
    try {
      result = await runEphemeralCompletion({
        accessToken,
        machineId,
        messages,
        tools,
        base,
        signal,
        log,
      });
    } catch (e) {
      const status = e?.status || HTTP_STATUS.BAD_GATEWAY || 502;
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: e?.message || "Ephemeral Grok Bot completion failed",
              type: "grok_bot_ephemeral",
              code: e?.code || "ephemeral_failed",
              probe: { status: CHAT_PATH_PROBE.status, next: CHAT_PATH_PROBE.next },
            },
          }),
          { status, headers: { "Content-Type": "application/json" } },
        ),
        responseFormat: FORMATS.OPENAI,
      };
    }

    const id = `chatcmpl-${crypto.randomUUID().slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const finishReason = result.finishReason || "stop";
    const isTools = finishReason === "tool_calls" && Array.isArray(result.toolCalls) && result.toolCalls.length > 0;

    if (!stream) {
      const message = isTools
        ? toOpenAiToolCallsMessage(result.toolCalls)
        : { role: "assistant", content: result.text ?? "" };
      const payload = {
        id,
        object: "chat.completion",
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finishReason,
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return {
        response: new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        responseFormat: FORMATS.OPENAI,
      };
    }

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      start(controller) {
        const push = (delta, fr = null) => {
          controller.enqueue(
            encoder.encode(
              chatChunkSse({
                id,
                created,
                model: modelId,
                delta,
                finishReason: fr,
              }),
            ),
          );
        };

        if (isTools) {
          push({ role: "assistant", content: null });
          result.toolCalls.forEach((tc, index) => {
            push({
              tool_calls: [
                {
                  index,
                  id: tc.id,
                  type: tc.type || "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || "",
                  },
                },
              ],
            });
          });
          push({}, "tool_calls");
        } else {
          push({ role: "assistant", content: result.text ?? "" });
          push({}, "stop");
        }
        controller.enqueue(encoder.encode(SSE_DONE));
        controller.close();
      },
    });

    return {
      response: new Response(responseStream, { headers: SSE_HEADERS }),
      responseFormat: FORMATS.OPENAI,
    };
  }
}

export default GrokBotDesktopExecutor;
