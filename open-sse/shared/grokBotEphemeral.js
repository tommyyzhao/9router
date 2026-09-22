/**
 * Ephemeral TEMPORAL Grok Bot worker: create → Send → list → delete.
 * Uses Desktop sand-secrets session JWT + sand client headers.
 * Never log tokens.
 */
import crypto from "node:crypto";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { flattenMessagesToEnvelope } from "./grokBotEnvelope.js";
import { parseAssistantCompletion, extractJsonObjectWithKey } from "./grokBotTools.js";

const DEFAULT_BASE = "https://api2.cursor.sh";

function encVarint(n) {
  const o = [];
  let x = BigInt(n);
  while (x >= 0x80n) {
    o.push(Number((x & 0x7fn) | 0x80n));
    x >>= 7n;
  }
  o.push(Number(x));
  return Buffer.from(o);
}
function encStr(f, s) {
  const b = Buffer.from(String(s ?? ""), "utf8");
  return Buffer.concat([encVarint((f << 3) | 2), encVarint(b.length), b]);
}
function encBool(f, v) {
  return Buffer.concat([encVarint((f << 3) | 0), encVarint(v ? 1 : 0)]);
}
function encEnum(f, v) {
  return Buffer.concat([encVarint((f << 3) | 0), encVarint(v)]);
}
function encInt64(f, n) {
  return Buffer.concat([encVarint((f << 3) | 0), encVarint(n)]);
}
function encInt32(f, n) {
  return encEnum(f, n);
}

export function sandHeaders(accessToken, machineId, options = {}) {
  return buildCursorHeaders(accessToken, machineId, options.ghostMode !== false, {
    clientType: "sand",
    clientSource: "sand-desktop",
    clientVersion: options.clientVersion || "0.57.1",
  });
}

async function readResponseBuffer(res) {
  // proxyFetch MITM bypass returns a shim with text()/json() but no arrayBuffer().
  if (typeof res.arrayBuffer === "function") {
    return Buffer.from(await res.arrayBuffer());
  }
  if (typeof res.text === "function") {
    return Buffer.from(await res.text(), "utf8");
  }
  throw new Error("response has neither arrayBuffer nor text");
}

async function postProto(base, headers, rpcPath, body, signal) {
  const h = { ...headers, "content-type": "application/proto" };
  const res = await fetch(`${base}${rpcPath}`, {
    method: "POST",
    headers: h,
    body,
    signal,
  });
  const buf = await readResponseBuffer(res);
  return { status: res.status, ok: res.ok, buf, text: buf.toString("utf8") };
}


/** Server assigns a numeric agent id; DeleteGrokBotAgent requires it (not the UUID). */
export function parseNumericAgentIdFromCreate(rawText) {
  if (!rawText) return null;
  const m = String(rawText).match(/\b(\d{6,})\b/);
  return m ? m[1] : null;
}

/** Create TEMPORAL worker; returns { agentId, numericId, name, status }. */
export async function createTemporalWorker({ accessToken, machineId, base = DEFAULT_BASE, signal, description }) {
  const headers = sandHeaders(accessToken, machineId);
  const agentId = crypto.randomUUID();
  const name = `9router-worker-${agentId.slice(0, 8)}`;
  const createBody = Buffer.concat([
    encStr(2, name),
    encStr(
      3,
      description ??
        "Stateless OpenAI API worker. No filesystem/shell. If TOOLS are listed, emit tool_calls JSON only; otherwise plain text. Obey the envelope.",
    ),
    encStr(4, "Worker"),
    encStr(8, agentId),
    encEnum(9, 2), // TEMPORAL
    encBool(10, false),
    encBool(11, true),
    encStr(13, "user"),
  ]);
  const r = await postProto(
    base,
    headers,
    "/aiserver.v1.GrokBotService/CreateGrokBotAgent",
    createBody,
    signal,
  );
  if (!r.ok) {
    const err = new Error(`CreateGrokBotAgent failed: HTTP ${r.status}`);
    err.status = r.status;
    err.bodyPreview = r.text.slice(0, 300);
    throw err;
  }
  const numericId = parseNumericAgentIdFromCreate(r.text);
  return { agentId, numericId, name, status: r.status };
}

export async function sendEnvelopedUserMessage({
  accessToken,
  machineId,
  agentId,
  messages,
  tools,
  base = DEFAULT_BASE,
  signal,
}) {
  const headers = sandHeaders(accessToken, machineId);
  const envelope = flattenMessagesToEnvelope(messages || [], { tools });
  const messageId = crypto.randomUUID();
  const sendBody = Buffer.concat([
    encStr(1, agentId),
    encStr(2, messageId),
    encStr(3, envelope),
    encInt64(4, Date.now()),
    encEnum(13, 1), // DESKTOP
    encStr(16, machineId || ""),
  ]);
  const r = await postProto(
    base,
    headers,
    "/aiserver.v1.GrokBotService/SendGrokBotUserMessage",
    sendBody,
    signal,
  );
  if (!r.ok) {
    const err = new Error(`SendGrokBotUserMessage failed: HTTP ${r.status}`);
    err.status = r.status;
    err.bodyPreview = r.text.slice(0, 300);
    throw err;
  }
  return { messageId, status: r.status, hex: r.buf.subarray(0, 16).toString("hex") };
}

/** Extract latest assistant send-message text from ListTranscript proto/json mix. */
export function extractAssistantTextFromList(rawText) {
  if (!rawText) return null;
  const raw = String(rawText);

  // Prefer embedded tool_calls JSON (string-aware — HTML/CSS braces in args are fine).
  const toolObj = extractJsonObjectWithKey(raw, "tool_calls");
  if (toolObj && Array.isArray(toolObj.tool_calls) && toolObj.tool_calls.length) {
    return JSON.stringify(toolObj);
  }

  // Prefer send-message kind
  const re = /"kind":"send-message"[\s\S]*?"content":"((?:\\.|[^"\\])*)"/g;
  let last = null;
  let m;
  while ((m = re.exec(raw))) last = m[1];
  if (last != null) {
    try {
      return JSON.parse(`"${last}"`);
    } catch {
      return last.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }
  return null;
}

export async function listTranscript({ accessToken, machineId, agentId, limit = 50, base = DEFAULT_BASE, signal }) {
  const headers = sandHeaders(accessToken, machineId);
  const body = Buffer.concat([encStr(1, agentId), encInt32(4, limit)]);
  const r = await postProto(
    base,
    headers,
    "/aiserver.v1.GrokBotService/ListGrokBotTranscriptEntries",
    body,
    signal,
  );
  return {
    status: r.status,
    ok: r.ok,
    text: r.text,
    assistantText: extractAssistantTextFromList(r.text),
  };
}

export async function deleteAgent({ accessToken, machineId, agentId, base = DEFAULT_BASE, signal }) {
  const headers = sandHeaders(accessToken, machineId);
  const body = encStr(1, agentId); // DeleteGrokBotAgentRequest|1 id
  const r = await postProto(
    base,
    headers,
    "/aiserver.v1.GrokBotService/DeleteGrokBotAgent",
    body,
    signal,
  );
  return { status: r.status, ok: r.ok };
}

/**
 * Full ephemeral completion: create → send → poll list → delete.
 * @returns {{ text: string|null, toolCalls: Array|null, finishReason: string, agentId: string, messageId: string }}
 */
export async function runEphemeralCompletion({
  accessToken,
  machineId,
  messages,
  tools,
  base = DEFAULT_BASE,
  signal,
  pollMs = 1500,
  maxPolls = 40,
  log,
}) {
  let agentId = null;
  let numericId = null;
  try {
    const created = await createTemporalWorker({ accessToken, machineId, base, signal });
    agentId = created.agentId;
    numericId = created.numericId;
    log?.debug?.("GROK_BOT", `ephemeral create ${created.name} numericId=${numericId || "?"}`);

    const sent = await sendEnvelopedUserMessage({
      accessToken,
      machineId,
      agentId,
      messages,
      tools,
      base,
      signal,
    });
    log?.debug?.("GROK_BOT", `ephemeral send ${sent.messageId} hex=${sent.hex}`);

    // Do not return on the first transcript hit — early "ack" messages arrive
    // before tool_calls JSON for long write turns. Prefer latest text and wait
    // until it stabilizes (or we parse tool_calls when tools were requested).
    let assistantText = null;
    let stable = 0;
    const wantTools = Array.isArray(tools) && tools.length > 0;
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) throw new Error("aborted");
      if (i) await new Promise((r) => setTimeout(r, pollMs));
      const listed = await listTranscript({ accessToken, machineId, agentId, base, signal });
      if (!listed.assistantText) continue;
      if (listed.assistantText === assistantText) {
        stable += 1;
      } else {
        assistantText = listed.assistantText;
        stable = 0;
      }
      const parsedEarly = parseAssistantCompletion(assistantText);
      if (parsedEarly.kind === "tool_calls") break;
      if (!wantTools && stable >= 1) break;
      if (wantTools && stable >= 2) break;
    }
    if (assistantText == null) {
      const err = new Error("Ephemeral worker produced no assistant text before timeout");
      err.code = "ephemeral_timeout";
      throw err;
    }
    const parsed = parseAssistantCompletion(assistantText);
    if (parsed.kind === "tool_calls") {
      return {
        text: null,
        toolCalls: parsed.toolCalls,
        finishReason: "tool_calls",
        agentId,
        messageId: sent.messageId,
      };
    }
    return {
      text: parsed.text,
      toolCalls: null,
      finishReason: "stop",
      agentId,
      messageId: sent.messageId,
    };
  } finally {
    const idForDelete = numericId || agentId;
    if (idForDelete) {
      try {
        const gc = await deleteAgent({ accessToken, machineId, agentId: idForDelete, base, signal: undefined });
        log?.debug?.("GROK_BOT", `ephemeral GC ${idForDelete} status=${gc.status}`);
      } catch (e) {
        log?.debug?.("GROK_BOT", `ephemeral GC failed: ${e?.message || e}`);
      }
    }
  }
}
