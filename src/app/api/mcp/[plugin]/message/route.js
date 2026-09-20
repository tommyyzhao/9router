import { NextResponse } from "next/server";
import {
  findPlugin,
  isInternal,
  sendToChild,
  sendToSession,
  getSessionSend,
} from "@/lib/mcp/stdioSseBridge";
import { loadInternalHandler } from "@/lib/mcp/internalPlugins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return NextResponse.json({ error: `Unknown plugin: ${plugin}` }, { status: 404 });
  }

  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (isInternal(plugin)) {
    if (!getSessionSend(plugin, sessionId)) {
      return NextResponse.json({ error: `Unknown MCP session: ${sessionId}` }, { status: 404 });
    }
    const handlerMod = await loadInternalHandler(plugin);
    if (!handlerMod?.handleJsonRpc) {
      return NextResponse.json({ error: `No handler for ${plugin}` }, { status: 500 });
    }
    // ACK immediately; deliver reply only to this session when ready.
    queueMicrotask(async () => {
      try {
        const response = await handlerMod.handleJsonRpc(body);
        if (response) sendToSession(plugin, sessionId, response);
      } catch (e) {
        const id = body?.id ?? null;
        if (id !== null && id !== undefined) {
          try {
            sendToSession(plugin, sessionId, {
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: e?.message || "Internal error" },
            });
          } catch { /* session gone */ }
        }
      }
    });
    return new Response(null, { status: 202 });
  }

  try {
    sendToChild(plugin, body);
    return new Response(null, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
