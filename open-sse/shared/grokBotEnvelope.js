/**
 * Flatten OpenAI chat `messages` (+ optional tools) into a SendGrokBotUserMessage envelope.
 * Pure helper — no I/O, no tokens.
 */
import { formatToolsBlock, toolProtocolText } from "./grokBotTools.js";

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

function formatAssistantLine(m) {
  const text = contentToText(m.content).trimEnd();
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  if (calls.length) {
    const rendered = calls
      .map((tc) => {
        const name = tc?.function?.name || tc?.name || "?";
        const args = tc?.function?.arguments ?? "";
        const id = tc?.id || "";
        return `tool_call id=${id} name=${name} arguments=${typeof args === "string" ? args : JSON.stringify(args)}`;
      })
      .join("\n");
    if (text) return `assistant: ${text}\n${rendered}`;
    return `assistant:\n${rendered}`;
  }
  return `assistant: ${text}`;
}

function formatToolLine(m) {
  const text = contentToText(m.content).trimEnd();
  const id = m.tool_call_id || m.name || "";
  return `tool id=${id}: ${text}`;
}

/**
 * @param {Array} messages
 * @param {{ tools?: unknown[] }} [options]
 * @returns {string}
 */
export function flattenMessagesToEnvelope(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const tools = options.tools;
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
    if (m.role === "system") {
      const text = contentToText(m.content).trimEnd();
      if (text) systems.push(text);
    }
  }

  // Always inject tool protocol when tools are present; also when history has tool turns
  const hasToolTurns = nonSystem.some(
    (m) => m.role === "tool" || m.role === "function" || (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length),
  );
  const needProtocol = (Array.isArray(tools) && tools.length > 0) || hasToolTurns;
  if (needProtocol) {
    systems.unshift(toolProtocolText());
  }

  nonSystem.forEach((m, idx) => {
    if (idx === lastUserIdx && m.role === "user") {
      finalUser = contentToText(m.content).trimEnd();
      return;
    }
    if (m.role === "assistant") {
      history.push(formatAssistantLine(m));
      return;
    }
    if (m.role === "tool" || m.role === "function") {
      history.push(formatToolLine(m));
      return;
    }
    if (m.role === "user") {
      history.push(`user: ${contentToText(m.content).trimEnd()}`);
      return;
    }
    history.push(`${m.role || "unknown"}: ${contentToText(m.content).trimEnd()}`);
  });

  const parts = [ENVELOPE_START, "[SYSTEM]"];
  parts.push(systems.length ? systems.join("\n\n") : "(none)");
  parts.push("", "[TOOLS]");
  parts.push(formatToolsBlock(tools));
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
