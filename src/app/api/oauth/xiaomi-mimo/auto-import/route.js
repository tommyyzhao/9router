import { NextResponse } from "next/server";
import { readFile, access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { readDesktopPassToken, readDesktopRegion } from "open-sse/shared/mimoAccount.js";

/**
 * GET /api/oauth/xiaomi-mimo/auto-import
 * Auto-detect Xiaomi MiMo Desktop credentials for the harness account session.
 *
 * Sources (in priority order):
 *   1. ~/.local/share/mimocode/auth.json  → xiaomi field (sk- key; older Desktop)
 *   2. Desktop Chromium account cookies   → passToken (current Desktop 26.x)
 *
 * Current Desktop (Xiaomi MiMo AI) often has NO auth.json — login is cookie-based.
 * PassToken-only is a valid connect: Preview + mimo-auto/flash/pro + weekly quota
 * work without an sk- key; cloud models still need a key or platform OAuth.
 */

function getCandidateAuthPaths() {
  const home = homedir();
  const paths = [];

  // MiMoCode / MiMo Desktop shared data dir (cross-platform XDG)
  paths.push(join(home, ".local", "share", "mimocode", "auth.json"));

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    paths.push(join(appData, "Xiaomi MiMo AI", "auth.json"));
    paths.push(join(appData, "Xiaomi MiMo", "auth.json"));
  }

  if (process.platform === "darwin") {
    paths.push(join(home, "Library", "Application Support", "mimocode", "auth.json"));
  }

  return paths;
}

async function readAuthJson() {
  const candidates = getCandidateAuthPaths();
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      const raw = await readFile(candidate, "utf-8");
      const auth = JSON.parse(raw);
      const xiaomi = auth?.xiaomi;
      if (xiaomi?.key) {
        return {
          path: candidate,
          key: String(xiaomi.key).trim(),
          uid: xiaomi.metadata?.uid || null,
          baseUrl: xiaomi.metadata?.base_url || "https://api.xiaomimimo.com/v1",
        };
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * GET /api/oauth/xiaomi-mimo/auto-import
 */
export async function GET() {
  try {
    const auth = await readAuthJson();

    let mimoPassToken = null;
    let mimoUserId = null;
    let mimoCUserId = null;
    try {
      const pt = await readDesktopPassToken();
      if (pt) {
        mimoPassToken = pt.passToken;
        mimoUserId = pt.userId;
        mimoCUserId = pt.cUserId;
      }
    } catch (e) {
      console.log("[xiaomi-mimo] passToken read failed (non-fatal):", e.message);
    }

    const region = readDesktopRegion();

    const hasKey = !!(auth && auth.key.startsWith("sk-"));
    const hasSession = !!mimoPassToken;

    if (!hasKey && !hasSession) {
      return NextResponse.json({
        found: false,
        region,
        error:
          "No Xiaomi MiMo Desktop credentials found. Sign in to MiMo Desktop (account session) and/or add an sk- API key.",
      });
    }

    return NextResponse.json({
      found: true,
      // sk- is optional: cookie-only Desktop login is enough for account-route models.
      apiKey: hasKey ? auth.key : null,
      uid: auth?.uid || mimoUserId || null,
      baseUrl: auth?.baseUrl || "https://api.xiaomimimo.com/v1",
      source: hasKey ? auth.path : "desktop-account-cookie",
      hasApiKey: hasKey,
      hasAccountSession: hasSession,
      mimoPassToken,
      mimoUserId,
      mimoCUserId,
      mimoRegion: region,
      region,
    });
  } catch (error) {
    console.log("Xiaomi MiMo auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
