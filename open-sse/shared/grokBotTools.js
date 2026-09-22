/**
 * Text-protocol bridge: Grok Bot TEMPORAL workers have no client-side tools.
 * Instruct the model to emit OpenAI-shaped tool_calls JSON; parse it back for /v1.
 */

const TOOL_PROTOCOL = `You are an OpenAI-compatible chat completion backend. You have NO local filesystem, shell, or browser.
The client runs tools. When you need a tool, reply with ONLY a single JSON object (no markdown fences, no prose):
{"tool_calls":[{"id":"call_<unique>","type":"function","function":{"name":"<tool_name>","arguments":"<json-stringified-args>"}}]}
Rules:
- "arguments" must be a JSON-encoded string (not a nested object).
- You may emit multiple tool_calls in one response.
- When you can answer without tools, reply with plain text only (no JSON wrapper).
- Never pretend a tool already ran. Wait for role=tool results in HISTORY.`;

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** @param {unknown} tools OpenAI tools array */
export function formatToolsBlock(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "(none)";
  return tools
    .map((t, i) => {
      const fn = t?.function || t;
      const name = fn?.name || t?.name || `tool_${i}`;
      const desc = fn?.description || t?.description || "";
      const params = fn?.parameters ?? t?.parameters ?? {};
      return `- ${name}: ${desc}\n  parameters: ${safeJsonStringify(params)}`;
    })
    .join("\n");
}

export function toolProtocolText() {
  return TOOL_PROTOCOL;
}

/**
 * Strip optional markdown fences, then try to parse tool_calls JSON.
 * @returns {{ kind: 'tool_calls', toolCalls: Array } | { kind: 'text', text: string }}
 */

/**
 * Find the last JSON object in `text` that contains key `key` (e.g. "tool_calls"),
 * respecting strings so braces inside HTML/CSS arguments do not truncate the object.
 * @returns {object|null}
 */
export function extractJsonObjectWithKey(text, key) {
  const s = String(text ?? "");
  const marker = `"${key}"`;
  let searchFrom = 0;
  let lastObj = null;

  while (true) {
    const mi = s.indexOf(marker, searchFrom);
    if (mi < 0) break;
    const start = s.lastIndexOf("{", mi);
    if (start < 0) {
      searchFrom = mi + marker.length;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = start; j < s.length; j++) {
      const ch = s[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = s.slice(start, j + 1);
          try {
            const obj = JSON.parse(slice);
            if (obj && Object.prototype.hasOwnProperty.call(obj, key)) lastObj = obj;
          } catch {
            /* keep scanning */
          }
          break;
        }
      }
    }
    searchFrom = mi + marker.length;
  }
  return lastObj;
}

export function parseAssistantCompletion(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { kind: "text", text: "" };

  let candidate = text;
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  const obj =
    extractJsonObjectWithKey(candidate, "tool_calls") ||
    extractJsonObjectWithKey(text, "tool_calls");

  if (obj && Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
    const toolCalls = obj.tool_calls.map((tc, i) => normalizeToolCall(tc, i)).filter(Boolean);
    if (toolCalls.length) return { kind: "tool_calls", toolCalls };
  }

  return { kind: "text", text };
}

function normalizeToolCall(tc, index) {
  if (!tc || typeof tc !== "object") return null;
  const id = tc.id || `call_${index}_${Date.now().toString(36)}`;
  const type = tc.type || "function";
  const fn = tc.function || {};
  const name = fn.name || tc.name;
  if (!name) return null;
  let args = fn.arguments;
  if (args != null && typeof args !== "string") args = safeJsonStringify(args);
  if (args == null) args = "{}";
  return {
    id: String(id),
    type,
    function: { name: String(name), arguments: String(args) },
  };
}

/** Build OpenAI message.tool_calls for non-stream JSON response */
export function toOpenAiToolCallsMessage(toolCalls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: tc.type || "function",
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    })),
  };
}

export default {
  formatToolsBlock,
  toolProtocolText,
  parseAssistantCompletion,
  toOpenAiToolCallsMessage,
};
