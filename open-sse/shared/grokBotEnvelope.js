/**
 * Flatten OpenAI chat `messages` into a single SendGrokBotUserMessage text envelope.
 * Pure helper — no I/O, no tokens. See docs/plans/2026-09-21-grok-bot-ephemeral-harness.md
 */

const ENVELOPE_START = "<<<9ROUTER_ENVELOPE v1>>>";
const ENVELOPE_END = "<<<END>>>";

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (part.type === "text" && typeof part.text === "string") return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return String(content);
}

function roleLabel(role) {
  switch (role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case "function":
      return "tool";
    default:
      return role || "unknown";
  }
}

/**
 * @param {Array<{role:string, content?:unknown, name?:string}>} messages
 * @returns {string}
 */
export function flattenMessagesToEnvelope(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = [];
  const history = [];
  let finalUser = "";

  const nonSystem = list.filter((m) => m && m.role !== "system");
  const lastUserIdx = (() => {
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (nonSystem[i].role === "user") return i;
    }
    return -1;
  })();

  for (const m of list) {
    if (!m) continue;
    const text = contentToText(m.content).trimEnd();
    if (m.role === "system") {
      if (text) systems.push(text);
      continue;
    }
  }

  nonSystem.forEach((m, idx) => {
    const text = contentToText(m.content).trimEnd();
    if (idx === lastUserIdx && m.role === "user") {
      finalUser = text;
      return;
    }
    const label = roleLabel(m.role);
    history.push(`${label}: ${text}`);
  });

  const parts = [ENVELOPE_START, "[SYSTEM]"];
  parts.push(systems.length ? systems.join("\n\n") : "(none)");
  parts.push("", "[HISTORY]");
  parts.push(history.length ? history.join("\n") : "(none)");
  parts.push("", "[USER]");
  parts.push(finalUser || "(empty)");
  parts.push("", ENVELOPE_END);
  return parts.join("\n");
}

export function envelopeMarkers() {
  return { start: ENVELOPE_START, end: ENVELOPE_END };
}

export default { flattenMessagesToEnvelope, envelopeMarkers };
