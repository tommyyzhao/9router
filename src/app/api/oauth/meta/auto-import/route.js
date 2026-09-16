import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { readLocalMuseCredentials } from "@/lib/oauth/museCredentials.js";

function publicView(creds) {
  return {
    found: creds.found,
    source: creds.source,
    email: creds.email,
    displayName: creds.displayName,
    apiBaseUrl: creds.apiBaseUrl,
    obtainedVia: creds.obtainedVia,
    error: creds.error || null,
  };
}

/**
 * GET /api/oauth/meta/auto-import
 * Detect a local Muse Code subscription login. Does not return the secret.
 */
export async function GET() {
  try {
    const creds = await readLocalMuseCredentials();
    return NextResponse.json(publicView(creds));
  } catch (error) {
    return NextResponse.json(
      { found: false, error: error.message || "Failed to read Muse Code credentials" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/oauth/meta/auto-import
 * Import the local Muse Code subscription key as an oauth connection.
 */
export async function POST() {
  try {
    const creds = await readLocalMuseCredentials();
    if (!creds.found || !creds.apiKey) {
      return NextResponse.json(
        { success: false, error: creds.error || "Muse Code is not logged in on this machine" },
        { status: 400 },
      );
    }

    const connection = await createProviderConnection({
      provider: "meta",
      authType: "oauth",
      accessToken: creds.apiKey,
      refreshToken: creds.oauthAccessToken || null,
      email: creds.email || creds.displayName || "muse-cli",
      displayName: creds.displayName || "Muse Code",
      providerSpecificData: {
        authMethod: "muse_cli_import",
        source: creds.source,
        oauthAccessToken: creds.oauthAccessToken || null,
        mintedApiKey: true,
        apiBaseUrl: creds.apiBaseUrl,
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error.message || "Import failed" },
      { status: 500 },
    );
  }
}
