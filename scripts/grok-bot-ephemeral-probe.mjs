#!/usr/bin/env node
/**
 * Live probe: Create TEMPORAL worker → enveloped Send → List transcripts.
 * Mac worktree only. Claims / status only — never print tokens.
 *
 *   node scripts/grok-bot-ephemeral-probe.mjs
 */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const BASE = process.env.GROK_BOT_API_BASE || "https://api2.cursor.sh";
const PROMPT = process.env.GROK_BOT_PROBE_PROMPT || "Reply with exactly: pong";

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
  const b = Buffer.from(String(s), "utf8");
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
function redact(s) {
  return String(s || "").replace(/eyJ[A-Za-z0-9_-]{20,}/g, "eyJ<JWT>");
}
function claimsOnly(jwt) {
  try {
    const p = JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString());
    return { sub: p.sub ? String(p.sub).slice(0, 12) + "…" : undefined, exp: p.exp, type: p.type };
  } catch {
    return { parse: "failed" };
  }
}

const account = await import(pathToFileURL(path.join(root, "open-sse/shared/grokBotAccount.js")).href);
const { flattenMessagesToEnvelope } = await import(
  pathToFileURL(path.join(root, "open-sse/shared/grokBotEnvelope.js")).href
);
const checksum = await import(pathToFileURL(path.join(root, "open-sse/utils/cursorChecksum.js")).href);

const cred = account.decryptGrokBotDesktopCredentials();
if (!cred.ok) {
  console.log(JSON.stringify({ decrypt: "fail", error: cred.error }));
  process.exit(1);
}
console.log(JSON.stringify({ decrypt: "ok", claims: claimsOnly(cred.accessToken), machineIdPresent: !!cred.machineId }));

const headers = checksum.buildCursorHeaders(cred.accessToken, cred.machineId, true, {
  clientType: "sand",
  clientSource: "sand-desktop",
  clientVersion: "0.57.1",
});

async function postProto(rpcPath, body) {
  const h = { ...headers, "content-type": "application/proto" };
  const res = await fetch(`${BASE}${rpcPath}`, { method: "POST", headers: h, body, signal: AbortSignal.timeout(45000) });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, len: buf.length, text: redact(buf.toString("utf8")), hex: buf.subarray(0, 64).toString("hex") };
}

const agentId = crypto.randomUUID();
const name = `9router-worker-${agentId.slice(0, 8)}`;
const createBody = Buffer.concat([
  encStr(2, name),
  encStr(3, "Stateless API worker. Obey only the instruction block in the user message."),
  encStr(4, "Worker"),
  encStr(8, agentId),
  encEnum(9, 2), // TEMPORAL
  encBool(10, false),
  encBool(11, true),
  encStr(13, "user"),
]);
const created = await postProto("/aiserver.v1.GrokBotService/CreateGrokBotAgent", createBody);
console.log(JSON.stringify({ step: "create", agentId, name, status: created.status, len: created.len, temporal: /temporal/i.test(created.text) }));
if (created.status !== 200) process.exit(2);

const envelope = flattenMessagesToEnvelope([
  { role: "system", content: "You are a completion worker. Reply with only the requested token." },
  { role: "user", content: PROMPT },
]);
const messageId = crypto.randomUUID();
const sendBody = Buffer.concat([
  encStr(1, agentId),
  encStr(2, messageId),
  encStr(3, envelope),
  encInt64(4, Date.now()),
  encEnum(13, 1), // DESKTOP
  encStr(16, cred.machineId || ""),
]);
const sent = await postProto("/aiserver.v1.GrokBotService/SendGrokBotUserMessage", sendBody);
// hex 08011003 ≈ delivery field2=3 ACCEPTED_TEMPORAL (observed)
console.log(JSON.stringify({ step: "send", messageId, status: sent.status, len: sent.len, hex: sent.hex }));

let assistantText = null;
for (let i = 0; i < 10; i++) {
  if (i) await new Promise((r) => setTimeout(r, 1500));
  const list = await postProto(
    "/aiserver.v1.GrokBotService/ListGrokBotTranscriptEntries",
    Buffer.concat([encStr(1, agentId), encInt32(4, 50)]),
  );
  const m = list.text.match(/"kind":"send-message"[^}]*"content":"([^"]*)"/);
  const alt = list.text.match(/"content":"(pong[^"]*)"/i);
  assistantText = m?.[1] || alt?.[1] || null;
  console.log(JSON.stringify({ step: "listPoll", i, status: list.status, len: list.len, assistantText }));
  if (assistantText) break;
}

console.log(JSON.stringify({
  probe: "done",
  ok: created.status === 200 && sent.status === 200 && !!assistantText,
  create: created.status,
  send: sent.status,
  assistantText,
}));
process.exit(assistantText ? 0 : 3);
