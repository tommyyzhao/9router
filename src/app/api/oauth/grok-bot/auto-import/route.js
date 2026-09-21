import { NextResponse } from "next/server";
import {
  discoverGrokBotDesktop,
  decryptGrokBotDesktopCredentials,
  CHAT_PATH_PROBE,
} from "open-sse/shared/grokBotAccount.js";
import { createProviderConnection } from "@/models";

/**
 * Public discover shape — never includes ciphertext or plaintext tokens.
 */
function publicDiscover(result) {
  return {
    found: result.found,
    path: result.path,
    signedIn: result.signedIn,
    accountScopePresent: result.accountScopePresent,
    sealed: true,
    encryption: result.encryption,
    keychainService: result.keychainService,
    ...(typeof result.accountCount === "number" ? { accountCount: result.accountCount } : {}),
    ...(result.appVersion != null ? { appVersion: result.appVersion } : {}),
    ...(result.statusPath ? { statusPath: result.statusPath } : {}),
    ...(typeof result.hasSealedMaterial === "boolean"
      ? { hasSealedMaterial: result.hasSealedMaterial }
      : {}),
    ...(typeof result.activeAccountPresent === "boolean"
      ? { activeAccountPresent: result.activeAccountPresent }
      : {}),
    ...(result.error ? { error: result.error } : {}),
    chatPathProbe: {
      status: CHAT_PATH_PROBE.status,
      note: CHAT_PATH_PROBE.note,
    },
  };
}

/**
 * GET /api/oauth/grok-bot/auto-import
 *
 * Discover-only: report whether a local Grok Bot Desktop session profile exists.
 * Never returns ciphertext, plaintext tokens, or Keychain material.
 */
export async function GET() {
  try {
    const result = discoverGrokBotDesktop();
    return NextResponse.json(publicDiscover(result));
  } catch (error) {
    console.log("Grok Bot auto-import (discover) error:", error?.message || error);
    return NextResponse.json(
      {
        found: false,
        path: null,
        signedIn: null,
        accountScopePresent: false,
        sealed: true,
        encryption: "electron-safeStorage-v10",
        keychainService: "Grok Bot Safe Storage",
        error: error?.message || "Discover failed",
        chatPathProbe: {
          status: CHAT_PATH_PROBE.status,
          note: CHAT_PATH_PROBE.note,
        },
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/oauth/grok-bot/auto-import
 *
 * Decrypt sand-secrets via Keychain + OSCrypt v10 and store a grok-bot connection
 * (same pattern as Cursor IDE import). Response never echoes tokens — only
 * connection id / email / probe status.
 */
export async function POST() {
  try {
    const creds = decryptGrokBotDesktopCredentials();
    if (!creds.ok || !creds.accessToken || !creds.machineId) {
      return NextResponse.json(
        {
          success: false,
          error: creds.error || "Failed to decrypt Grok Bot Desktop credentials",
          chatPathProbe: {
            status: CHAT_PATH_PROBE.status,
            note: CHAT_PATH_PROBE.note,
          },
        },
        { status: 400 },
      );
    }

    const connection = await createProviderConnection({
      provider: "grok-bot",
      authType: "oauth",
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken || null,
      expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
      email: creds.email || null,
      displayName: creds.name || "Grok Bot Desktop",
      providerSpecificData: {
        machineId: creds.machineId,
        authMethod: "grok-bot-desktop-import",
        clientType: "sand",
        clientSource: "sand-desktop",
        source: "sand-secrets",
        chatPathStatus: CHAT_PATH_PROBE.status,
      },
      testStatus: CHAT_PATH_PROBE.status === "blocked" ? "imported" : "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName || connection.name,
      },
      chatPathProbe: {
        status: CHAT_PATH_PROBE.status,
        note: CHAT_PATH_PROBE.note,
        unaryDashboardOk: CHAT_PATH_PROBE.unaryDashboardOk,
        agentRunSandRejected: CHAT_PATH_PROBE.agentRunSandRejected,
        chatServiceVersionGated: CHAT_PATH_PROBE.chatServiceVersionGated,
        inferenceUnauthenticated: CHAT_PATH_PROBE.inferenceUnauthenticated,
      },
    });
  } catch (error) {
    console.log("Grok Bot auto-import (decrypt+store) error:", error?.message || error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Import failed",
        chatPathProbe: {
          status: CHAT_PATH_PROBE.status,
          note: CHAT_PATH_PROBE.note,
        },
      },
      { status: 500 },
    );
  }
}
