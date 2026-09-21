import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Grok Bot Desktop (Anysphere Sand) discover helpers — PR-A (discover only).
 *
 * Grok Bot.app stores Cursor-family auth in Electron safeStorage v10 under
 * ~/Library/Application Support/Grok Bot/sand-secrets.json. Blobs are sealed
 * (`djEw…` prefix); the Keychain service is "Grok Bot Safe Storage".
 *
 * This module NEVER decrypts, NEVER touches Keychain, and NEVER returns
 * ciphertext or plaintext tokens — only path discovery + schema presence.
 *
 * Distinct from: grok-cli (Grok Build), grok-web (grok.com cookie), xai (PAYG),
 * and Cursor IDE state.vscdb auto-import.
 */

export const KEYCHAIN_SERVICE = "Grok Bot Safe Storage";
export const ENCRYPTION = "electron-safeStorage-v10";
/** Electron safeStorage v10 sealed-blob prefix (base64 of version tag). */
export const SEALED_PREFIX = "djEw";

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Ordered Grok Bot user-data roots per platform.
 * @returns {string[]}
 */
export function userDataRoots() {
  const home = homeDir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Grok Bot")];
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Grok Bot")];
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [path.join(xdg, "Grok Bot")];
}

/**
 * Ordered candidate paths for sand-secrets.json.
 * @returns {string[]}
 */
export function sandSecretsPathCandidates() {
  return userDataRoots().map((root) => path.join(root, "sand-secrets.json"));
}

/**
 * Ordered candidate paths for desktop-status.json.
 * @returns {string[]}
 */
export function desktopStatusPathCandidates() {
  return userDataRoots().map((root) => path.join(root, "desktop-status.json"));
}

/** First existing readable path from a candidate list, or null. */
function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** First existing sand-secrets.json path, or null. */
export function findSandSecretsPath() {
  return firstExisting(sandSecretsPathCandidates());
}

/** First existing desktop-status.json path, or null. */
export function findDesktopStatusPath() {
  return firstExisting(desktopStatusPathCandidates());
}

/**
 * True when a string looks like an Electron safeStorage v10 sealed blob.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSealedBlob(value) {
  return typeof value === "string" && value.startsWith(SEALED_PREFIX) && value.length > SEALED_PREFIX.length;
}

/**
 * Parse cursor-accounts payload (object or JSON string) without decrypting.
 * @param {unknown} raw
 * @returns {{ ok: boolean, active: string|null, accountIds: string[], sealedFieldCount: number, accountCount: number }}
 */
export function parseCursorAccountsScope(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, active: null, accountIds: [], sealedFieldCount: 0, accountCount: 0 };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, active: null, accountIds: [], sealedFieldCount: 0, accountCount: 0 };
  }

  const accounts = obj.accounts && typeof obj.accounts === "object" && !Array.isArray(obj.accounts)
    ? obj.accounts
    : null;
  if (!accounts) {
    return {
      ok: false,
      active: typeof obj.active === "string" ? obj.active : null,
      accountIds: [],
      sealedFieldCount: 0,
      accountCount: 0,
    };
  }

  const accountIds = Object.keys(accounts);
  let sealedFieldCount = 0;
  for (const id of accountIds) {
    const entry = accounts[id];
    if (!entry || typeof entry !== "object") continue;
    for (const v of Object.values(entry)) {
      if (isSealedBlob(v)) sealedFieldCount += 1;
    }
  }

  return {
    ok: accountIds.length > 0,
    active: typeof obj.active === "string" ? obj.active : null,
    accountIds,
    sealedFieldCount,
    accountCount: accountIds.length,
  };
}

/**
 * Schema-only parse of sand-secrets.json contents. Never returns blob values.
 * @param {unknown} data - parsed JSON object
 * @returns {{
 *   ok: boolean,
 *   topLevelKeys: string[],
 *   accountScopePresent: boolean,
 *   accountCount: number,
 *   activeAccountPresent: boolean,
 *   sealedTopLevelCount: number,
 *   sealedAccountFieldCount: number,
 *   hasSealedMaterial: boolean,
 * }}
 */
export function parseSandSecretsSchema(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      topLevelKeys: [],
      accountScopePresent: false,
      accountCount: 0,
      activeAccountPresent: false,
      sealedTopLevelCount: 0,
      sealedAccountFieldCount: 0,
      hasSealedMaterial: false,
    };
  }

  const topLevelKeys = Object.keys(data);
  let sealedTopLevelCount = 0;
  for (const k of topLevelKeys) {
    if (k === "cursor-accounts") continue;
    if (isSealedBlob(data[k])) sealedTopLevelCount += 1;
  }

  const scope = parseCursorAccountsScope(data["cursor-accounts"]);
  const accountScopePresent = scope.ok;
  const hasSealedMaterial = sealedTopLevelCount > 0 || scope.sealedFieldCount > 0;

  return {
    ok: true,
    topLevelKeys,
    accountScopePresent,
    accountCount: scope.accountCount,
    activeAccountPresent: !!(scope.active && scope.accountIds.includes(scope.active)),
    sealedTopLevelCount,
    sealedAccountFieldCount: scope.sealedFieldCount,
    hasSealedMaterial,
  };
}

/**
 * Read desktop-status.json (non-secret status only).
 * @param {string|null} [explicitPath]
 * @returns {{ path: string|null, signedIn: boolean|null, appVersion: string|null, rawPresent: boolean }}
 */
export function readDesktopStatus(explicitPath = null) {
  const statusPath = explicitPath || findDesktopStatusPath();
  if (!statusPath) {
    return { path: null, signedIn: null, appVersion: null, rawPresent: false };
  }
  try {
    if (!fs.existsSync(statusPath)) {
      return { path: statusPath, signedIn: null, appVersion: null, rawPresent: false };
    }
    const j = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    return {
      path: statusPath,
      signedIn: typeof j?.signedIn === "boolean" ? j.signedIn : null,
      appVersion: typeof j?.appVersion === "string" ? j.appVersion : null,
      rawPresent: true,
    };
  } catch {
    return { path: statusPath, signedIn: null, appVersion: null, rawPresent: true };
  }
}

/**
 * Discover a local Grok Bot Desktop session (schema + status only).
 * Safe for API responses — no ciphertext, no plaintext tokens.
 * @returns {{
 *   found: boolean,
 *   path: string|null,
 *   signedIn: boolean|null,
 *   accountScopePresent: boolean,
 *   sealed: true,
 *   encryption: string,
 *   keychainService: string,
 *   accountCount?: number,
 *   appVersion?: string|null,
 *   statusPath?: string|null,
 *   error?: string,
 * }}
 */
export function discoverGrokBotDesktop() {
  const secretsPath = findSandSecretsPath();
  const status = readDesktopStatus();

  if (!secretsPath) {
    return {
      found: false,
      path: null,
      signedIn: status.signedIn,
      accountScopePresent: false,
      sealed: true,
      encryption: ENCRYPTION,
      keychainService: KEYCHAIN_SERVICE,
      statusPath: status.path,
      appVersion: status.appVersion,
      error: `Grok Bot sand-secrets.json not found. Checked:\n${sandSecretsPathCandidates().join("\n")}`,
    };
  }

  try {
    const raw = fs.readFileSync(secretsPath, "utf-8");
    const data = JSON.parse(raw);
    const schema = parseSandSecretsSchema(data);

    return {
      found: true,
      path: secretsPath,
      signedIn: status.signedIn,
      accountScopePresent: schema.accountScopePresent,
      sealed: true,
      encryption: ENCRYPTION,
      keychainService: KEYCHAIN_SERVICE,
      accountCount: schema.accountCount,
      appVersion: status.appVersion,
      statusPath: status.path,
      hasSealedMaterial: schema.hasSealedMaterial,
      activeAccountPresent: schema.activeAccountPresent,
    };
  } catch (e) {
    return {
      found: false,
      path: secretsPath,
      signedIn: status.signedIn,
      accountScopePresent: false,
      sealed: true,
      encryption: ENCRYPTION,
      keychainService: KEYCHAIN_SERVICE,
      statusPath: status.path,
      appVersion: status.appVersion,
      error: e?.message || "Failed to parse sand-secrets.json",
    };
  }
}

export const __test__ = {
  homeDir,
  firstExisting,
};
