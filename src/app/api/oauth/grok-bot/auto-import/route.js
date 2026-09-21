import { NextResponse } from "next/server";
import { discoverGrokBotDesktop } from "open-sse/shared/grokBotAccount.js";

/**
 * GET /api/oauth/grok-bot/auto-import
 *
 * Discover-only (PR-A): report whether a local Grok Bot Desktop session
 * profile exists. Never returns ciphertext, plaintext tokens, or Keychain
 * material. Decrypt + probe + store is PR-B.
 */
export async function GET() {
  try {
    const result = discoverGrokBotDesktop();
    // Explicit public shape — strip any accidental extra fields later callers may add.
    return NextResponse.json({
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
    });
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
      },
      { status: 500 },
    );
  }
}
