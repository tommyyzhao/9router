// In-process MCP handler for 9router-web: web_search / web_fetch → gateway combos.
import { handleSearch } from "@/sse/handlers/search.js";
import { handleFetch } from "@/sse/handlers/fetch.js";
import { getSettings, getApiKeys } from "@/lib/localDb";

export const PLUGIN_NAME = "9router-web";
export const SEARCH_MODEL = "search-combo";
export const FETCH_MODEL = "fetch-combo";

const TOOLS = [
  {
    name: "web_search",
    description:
      "Web search via 9Router search-combo (multi-provider fallback: parallel, minimax, tavily, exa, gemini). Use for live web/news lookups.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results (default 5)" },
        search_type: { type: "string", enum: ["web", "news"], description: "web or news" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL via 9Router fetch-combo (multi-provider fallback: jina-reader, ollama, tavily, parallel, exa). Returns markdown/text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        format: { type: "string", enum: ["markdown", "text", "html"], description: "Output format" },
        max_characters: { type: "number", description: "Truncate content length" },
      },
      required: ["url"],
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResultText(text, isError = false) {
  return {
    content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function resolveApiKey() {
  const settings = await getSettings();
  if (!settings?.requireApiKey) return null;
  let keys = [];
  try {
    const raw = await getApiKeys();
    keys = Array.isArray(raw) ? raw : raw?.keys || [];
  } catch {
    keys = [];
  }
  const active = keys.find((k) => k && k.isActive !== false && (k.key || k.apiKey || k.value));
  const key = active?.key || active?.apiKey || active?.value;
  if (!key) {
    const err = new Error("requireApiKey is enabled but no active gateway API key exists");
    err.mcpStatus = 500;
    throw err;
  }
  return key;
}

function absoluteGatewayUrl(path) {
  const port = process.env.PORT || 20128;
  return `http://127.0.0.1:${port}${path}`;
}

async function callHandler(handler, path, bodyObj) {
  const apiKey = await resolveApiKey();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const request = new Request(absoluteGatewayUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });
  return handler(request);
}

function pick(obj, allowed) {
  const out = {};
  for (const k of allowed) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  }
  return out;
}

async function callWebSearch(args) {
  if (!args?.query || typeof args.query !== "string" || !args.query.trim()) {
    return toolResultText("web_search requires a non-empty query", true);
  }
  const extra = pick(args, ["max_results", "search_type"]);
  // Fixed combo — never accept model/provider from the client.
  const body = { model: SEARCH_MODEL, query: args.query.trim(), ...extra };
  const res = await callHandler(handleSearch, "/v1/search", body);
  const text = await res.text();
  if (!res.ok) return toolResultText(`search failed (${res.status}): ${text}`, true);
  return toolResultText(text);
}

async function callWebFetch(args) {
  if (!args?.url || typeof args.url !== "string") {
    return toolResultText("web_fetch requires url", true);
  }
  const extra = pick(args, ["format", "max_characters"]);
  const body = { model: FETCH_MODEL, url: args.url, ...extra };
  const res = await callHandler(handleFetch, "/v1/web/fetch", body);
  const text = await res.text();
  if (!res.ok) return toolResultText(`fetch failed (${res.status}): ${text}`, true);
  return toolResultText(text);
}

/**
 * Handle one JSON-RPC message for 9router-web.
 * @returns {Promise<object|null>} response frame, or null for notifications
 */
export async function handleJsonRpc(message) {
  if (!message || typeof message !== "object") return null;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }

  if (method === "initialize") {
    if (isNotification) return null;
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: PLUGIN_NAME, version: "1.0.0" },
    });
  }

  if (method === "ping") {
    if (isNotification) return null;
    return rpcResult(id, {});
  }

  if (method === "tools/list") {
    if (isNotification) return null;
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    if (isNotification) return null;
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === "web_search") return rpcResult(id, await callWebSearch(args));
      if (name === "web_fetch") return rpcResult(id, await callWebFetch(args));
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    } catch (e) {
      return rpcResult(id, toolResultText(e?.message || "tool call failed", true));
    }
  }

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export default { PLUGIN_NAME, handleJsonRpc, TOOLS, SEARCH_MODEL, FETCH_MODEL };
