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
export function parseAssistantCompletion(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return { kind: "text", text: "" };

  // Unescape common transcript artifacts (double-encoded quotes / newlines)
  if (text.includes('\\"') && text.includes("tool_calls")) {
    try {
      const once = JSON.parse(`"${text.replace(/^"|"$/g, (m, i, s) => (i === 0 || i === s.length - 1 ? "" : m))}"`);
      if (typeof once === "string" && once.includes("tool_calls")) text = once.trim();
    } catch {
      /* keep text */
    }
  }

  let candidate = text;
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const extractToolCallsObj = (s) => {
    let obj = tryParse(s);
    if (obj && Array.isArray(obj.tool_calls)) return obj;
    // Search for tool_calls key (with optional whitespace)
    const markers = ['"tool_calls"', "'tool_calls'"];
    let idx = -1;
    for (const m of markers) {
      const i = s.indexOf(m);
      if (i >= 0) {
        // walk back to opening brace
        let start = s.lastIndexOf("{", i);
        if (start < 0) continue;
        let depth = 0;
        for (let j = start; j < s.length; j++) {
          if (s[j] === "{") depth++;
          else if (s[j] === "}") {
            depth--;
            if (depth === 0) {
              obj = tryParse(s.slice(start, j + 1));
              if (obj && Array.isArray(obj.tool_calls)) return obj;
              break;
            }
          }
        }
        idx = i;
      }
    }
    return null;
  };

  const obj = extractToolCallsObj(candidate) || extractToolCallsObj(text);
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
