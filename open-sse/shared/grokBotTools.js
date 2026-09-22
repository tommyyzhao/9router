/**
 * Text-protocol bridge: Grok Bot TEMPORAL workers have no client-side tools.
 * Instruct the model to emit OpenAI-shaped tool_calls JSON; parse it back for /v1.
 */

const TOOL_PROTOCOL = `You are an OpenAI-compatible chat completion backend. You have NO local filesystem, shell, or browser.
The client runs tools. When you need a tool, reply with ONLY a single JSON object (no markdown fences, no prose):
{"tool_calls":[{"id":"call_<unique>","type":"function","function":{"name":"<tool_name>","arguments":"<json-stringified-args>"}}]}
Rules:
- "arguments" must be a single-line JSON-encoded string (not a nested object). Use \\n for newlines inside content; never raw newlines.
- Never wrap the reply in markdown fences or add prose outside the JSON object.
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

/** Escape raw control chars / invalid escapes inside JSON strings (model often emits them). */
export function repairJsonControlChars(text) {
  const s = String(text ?? "");
  let out = "";
  let inString = false;
  let escape = false;
  const VALID_ESC = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        if (VALID_ESC.has(ch)) {
          out += ch;
        } else if (ch === "\n") {
          // prior \ + raw newline → \n
          out += "n";
        } else if (ch === "\r") {
          out += "r";
        } else if (ch === "\t") {
          out += "t";
        } else {
          // invalid escape: treat prior backslash as literal
          out += "\\" + ch;
        }
        escape = false;
        continue;
      }
      if (ch.charCodeAt(0) === 92) {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  // Dangling trailing \ → double it (literal backslash)
  if (escape) out += "\\";
  return out;
}

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
        else if (ch.charCodeAt(0) === 92) escape = true;
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
            let obj;
            try {
              obj = JSON.parse(slice);
            } catch {
              obj = JSON.parse(repairJsonControlChars(slice));
            }
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

  let obj =
    extractJsonObjectWithKey(candidate, "tool_calls") ||
    extractJsonObjectWithKey(text, "tool_calls");

  // If it looks like tool_calls JSON but extract/parse failed, repair the whole candidate once more.
  if ((!obj || !Array.isArray(obj.tool_calls) || !obj.tool_calls.length) && /"tool_calls"\s*:/.test(candidate + text)) {
    const repaired = repairJsonControlChars(candidate);
    obj =
      extractJsonObjectWithKey(repaired, "tool_calls") ||
      (() => {
        try {
          return JSON.parse(repaired);
        } catch {
          return null;
        }
      })();
  }

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
  args = String(args);
  // Outer JSON.parse turns "\\n" / repaired "\\n" into real newlines inside the
  // arguments string; re-escape so clients can JSON.parse(arguments).
  try {
    JSON.parse(args);
  } catch {
    const repaired = repairJsonControlChars(args);
    try {
      JSON.parse(repaired);
      args = repaired;
    } catch {
      /* keep original; client may still handle */
    }
  }
  return {
    id: String(id),
    type,
    function: { name: String(name), arguments: args },
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
