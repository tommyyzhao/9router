import { FORMATS } from "../../translator/formats.js";
import { CLAUDE_BLOCK, OPENAI_BLOCK, RESPONSES_ITEM, ROLE, OPENAI_FINISH } from "../../translator/schema/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function responseItemText(item) {
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter((part) => part?.type === RESPONSES_ITEM.OUTPUT_TEXT || typeof part?.text === "string")
    .map((part) => part.text || "")
    .join("");
}

function responseItemReasoning(item) {
  const summary = Array.isArray(item?.summary) ? item.summary : [];
  const content = Array.isArray(item?.content) ? item.content : [];
  return [...summary, ...content]
    .filter((part) => part?.type === RESPONSES_ITEM.SUMMARY_TEXT || typeof part?.text === "string")
    .map((part) => part.text || "")
    .join("");
}

/** Convert a completed Responses API body into an OpenAI Chat Completion body. */
export function responsesToOpenAICompletion(responseBody, fallbackModel) {
  if (!Array.isArray(responseBody?.output)) return responseBody;

  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  const includeToolCalls = responseBody.status !== "incomplete";
  for (const item of responseBody.output) {
    if (item?.type === RESPONSES_ITEM.MESSAGE) {
      const text = responseItemText(item);
      if (text) textParts.push(text);
    } else if (item?.type === RESPONSES_ITEM.REASONING) {
      const reasoning = responseItemReasoning(item);
      if (reasoning) reasoningParts.push(reasoning);
    } else if (includeToolCalls && (item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL)) {
      const custom = item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL;
      const rawArguments = custom
        ? (typeof item.input === "string" ? { input: item.input } : item.input || {})
        : (typeof item.arguments === "string" ? item.arguments : item.arguments || {});
      toolCalls.push({
        id: item.call_id || item.id || "",
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name || "",
          arguments: typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments)
        }
      });
    }
  }

  const usage = responseBody.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const hasSeparateCacheCounters = usage.cache_read_input_tokens !== undefined
    || usage.cache_creation_input_tokens !== undefined;
  const cacheReadTokens = hasSeparateCacheCounters
    ? (usage.cache_read_input_tokens ?? 0)
    : (usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens);
  const cacheCreationTokens = hasSeparateCacheCounters
    ? (usage.cache_creation_input_tokens ?? 0)
    : usage.input_tokens_details?.cache_creation_tokens;
  const promptTokens = hasSeparateCacheCounters
    ? inputTokens + cacheReadTokens + cacheCreationTokens
    : inputTokens;
  const chatUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? (promptTokens + (usage.output_tokens ?? usage.completion_tokens ?? 0))
  };
  if (cacheReadTokens !== undefined || cacheCreationTokens !== undefined) {
    chatUsage.prompt_tokens_details = {
      ...(cacheReadTokens !== undefined ? { cached_tokens: cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cache_creation_tokens: cacheCreationTokens } : {})
    };
  }
  if (usage.output_tokens_details?.reasoning_tokens !== undefined) {
    chatUsage.completion_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens };
  }

  const message = {
    role: ROLE.ASSISTANT,
    content: textParts.join("") || (toolCalls.length > 0 ? null : "")
  };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const status = responseBody.status;
  const finishReason = toolCalls.length > 0
    ? OPENAI_FINISH.TOOL_CALLS
    : (status === "completed" || status === "done" ? OPENAI_FINISH.STOP
      : (status === "incomplete" && responseBody.incomplete_details?.reason === "max_output_tokens"
        ? OPENAI_FINISH.LENGTH
        : (status || OPENAI_FINISH.STOP)));
  return {
    id: responseBody.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: responseBody.created_at || Math.floor(Date.now() / 1000),
    model: responseBody.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: chatUsage
  };
}

/** Convert an OpenAI Chat Completion body into an Anthropic Messages response. */
export function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: CLAUDE_BLOCK.THINKING, thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: CLAUDE_BLOCK.TEXT, text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: CLAUDE_BLOCK.TOOL_USE,
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });

  const usage = responseBody.usage || {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0) || 0;
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const claudeUsage = {
    input_tokens: Math.max(0, promptTokens - cacheReadTokens - cacheCreationTokens),
    output_tokens: outputTokens
  };
  if (cacheReadTokens > 0) claudeUsage.cache_read_input_tokens = cacheReadTokens;
  if (cacheCreationTokens > 0) claudeUsage.cache_creation_input_tokens = cacheCreationTokens;

  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: ROLE.ASSISTANT,
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: claudeUsage,
  };
}
