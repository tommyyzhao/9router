// Persisted MCP-scoped secret for Claude Code → local 9router-web MCP.
import crypto from "crypto";

const SETTINGS_KEY = "webMcpToken";
const HEADER = "x-9r-mcp-token";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Return existing settings.webMcpToken or create + persist a 128-bit hex secret. */
export async function ensureWebMcpToken(getSettings, updateSettings) {
  const settings = (await getSettings()) || {};
  const existing = settings[SETTINGS_KEY];
  if (typeof existing === "string" && existing.length >= 32) return existing;
  const token = crypto.randomBytes(16).toString("hex");
  await updateSettings({ [SETTINGS_KEY]: token });
  return token;
}

export function hasValidWebMcpToken(request, storedToken) {
  return safeEqual(request.headers.get(HEADER), storedToken);
}

export { SETTINGS_KEY, HEADER, safeEqual };
