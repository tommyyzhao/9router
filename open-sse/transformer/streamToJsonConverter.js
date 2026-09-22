/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
    const incomplete = eventType === "response.incomplete" || parsed.response?.status === "incomplete" || parsed.status === "incomplete";
    state.status = incomplete ? "incomplete" : "completed";
    state.terminal = true;
    state.incomplete_details = incomplete
      ? (parsed.response?.incomplete_details || parsed.incomplete_details || null)
      : undefined;
    if (parsed.response?.id) state.responseId = parsed.response.id;
    if (parsed.response?.created_at) state.created = parsed.response.created_at;
    if (parsed.response?.usage) {
      const usage = parsed.response.usage;
      state.usage.input_tokens = usage.input_tokens || 0;
      state.usage.output_tokens = usage.output_tokens || 0;
      state.usage.total_tokens = usage.total_tokens || (state.usage.input_tokens + state.usage.output_tokens);
      if (usage.input_tokens_details?.cached_tokens !== undefined) {
        state.usage.cached_tokens = usage.input_tokens_details.cached_tokens;
      }
      if (usage.cache_read_input_tokens !== undefined) {
        state.usage.cache_read_input_tokens = usage.cache_read_input_tokens;
      }
      if (usage.cache_creation_input_tokens !== undefined) {
        state.usage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
      }
      if (usage.output_tokens_details?.reasoning_tokens !== undefined) {
        state.usage.reasoning_tokens = usage.output_tokens_details.reasoning_tokens;
      }
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
    state.terminal = true;
    state.error = parsed.response?.error || parsed.error || null;
    if (parsed.response?.id) state.responseId = parsed.response.id;
    if (parsed.response?.created_at) state.created = parsed.response.created_at;
  } else if (eventType === "error") {
    state.status = "failed";
    state.terminal = true;
    state.error = parsed.error || parsed;
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    terminal: false,
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  if (!state.terminal) {
    state.status = "failed";
    state.error = state.error || { message: "Responses stream ended before a terminal event" };
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    error: state.error,
    ...(state.incomplete_details ? { incomplete_details: state.incomplete_details } : {}),
    output,
    usage: state.usage
  };
}
