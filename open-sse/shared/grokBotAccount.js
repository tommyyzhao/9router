import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Grok Bot Desktop (Anysphere Sand) account helpers.
 *
 * PR-A: path discovery + sand-secrets schema parse (safe for public discover API).
 * PR-B: server-side Keychain + OSCrypt v10 decrypt for import/connect only.
 *
 * Discover-mode HTTP responses must NEVER include ciphertext or plaintext tokens.
 * Decrypt helpers are for server-side import routes that write into the connection
 * store (same pattern as Cursor IDE auto-import → POST import).
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

/* -------------------------------------------------------------------------- */
/* PR-B — server-side decrypt (Keychain + OSCrypt v10). Never expose plaintext */
/* to discover-mode HTTP clients. Import/connect path stores into connection  */
/* store after decrypt (see POST /api/oauth/grok-bot/auto-import).             */
/* -------------------------------------------------------------------------- */

export const KEYCHAIN_ACCOUNT = "Grok Bot Key";

/**
 * Probe outcome for reusing Cursor chat Connect paths with a Sand token.
 * Documented from live api2.cursor.sh wire probe (2026-09-21 PT). No secrets.
 *
 * Unary Dashboard/AiService with content-type application/proto → 200 (sand & ide).
 * AgentService.Run + clientType=sand → rejected ("Sand traffic is not supported").
 * ChatService.StreamUnifiedChatWithTools → auth reaches business logic but returns
 *   version-gate / Update Required (not a working chat path).
 * InferenceService.Stream → unauthenticated for Sand session JWT.
 * Checksum not strictly required for GetMe unary.
 */
export const CHAT_PATH_PROBE = {
  status: "blocked",
  unaryDashboardOk: true,
  unaryAiServiceOk: true,
  agentRunSandRejected: true,
  chatServiceVersionGated: true,
  inferenceUnauthenticated: true,
  preferredContentTypeUnary: "application/proto",
  preferredClientType: "sand",
  preferredClientSource: "sand-desktop",
  note:
    "Decrypt + store works. Do not claim chat works until Agent/Inference/Chat stream probe succeeds with a supported client version.",
};

/**
 * Decrypt an Electron safeStorage / Chromium OSCrypt v10 sealed blob.
 * @param {string} sealedB64 - base64 string starting with djEw (v10)
 * @param {string} password - Keychain password (raw string)
 * @returns {string} utf8 plaintext
 */
export function decryptOsCryptV10(sealedB64, password) {
  if (!isSealedBlob(sealedB64)) {
    throw new Error("Not an Electron safeStorage v10 sealed blob");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("OSCrypt password is required");
  }
  const raw = Buffer.from(sealedB64, "base64");
  if (raw.length < 4 || raw.subarray(0, 3).toString("utf8") !== "v10") {
    throw new Error("Invalid v10 blob framing");
  }
  const ciphertext = raw.subarray(3);
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20); // 16 ASCII spaces — Chromium OSCrypt default
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * Encrypt plaintext to a v10 sealed blob (test helper / fixture generation).
 * @param {string} plaintext
 * @param {string} password
 * @returns {string} base64 sealed blob
 */
export function encryptOsCryptV10(plaintext, password) {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "utf8"), enc]).toString("base64");
}

/**
 * Read the Grok Bot Safe Storage password from macOS Keychain.
 * Injectable `runner` for unit tests (never hits Keychain in CI).
 *
 * @param {{
 *   service?: string,
 *   account?: string,
 *   runner?: (cmd: string, args: string[]) => string,
 * }} [opts]
 * @returns {string} password (caller must not log)
 */
export function readGrokBotKeychainPassword(opts = {}) {
  const service = opts.service || KEYCHAIN_SERVICE;
  const account = opts.account || KEYCHAIN_ACCOUNT;
  const runner =
    opts.runner ||
    ((cmd, args) =>
      execFileSync(cmd, args, { encoding: "utf8", timeout: 10000 }).trim());

  if (process.platform !== "darwin" && !opts.runner) {
    throw new Error(
      `Grok Bot Keychain decrypt is only supported on macOS (got ${process.platform})`,
    );
  }

  try {
    return runner("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
  } catch (e1) {
    try {
      return runner("security", ["find-generic-password", "-s", service, "-w"]);
    } catch (e2) {
      throw new Error(
        `Failed to read Keychain service "${service}": ${e2?.message || e1?.message || "unknown"}`,
      );
    }
  }
}

/**
 * Decrypt active Grok Bot Desktop credentials from sand-secrets.json.
 * SERVER-SIDE ONLY — never return the result from discover-mode GET handlers.
 *
 * @param {{
 *   secretsPath?: string|null,
 *   password?: string|null,
 *   keychainReader?: () => string,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   accessToken?: string,
 *   refreshToken?: string|null,
 *   machineId?: string,
 *   email?: string|null,
 *   name?: string|null,
 *   activeAccountId?: string|null,
 *   secretsPath?: string,
 *   error?: string,
 *   chatPathProbe?: typeof CHAT_PATH_PROBE,
 * }}
 */
export function decryptGrokBotDesktopCredentials(opts = {}) {
  const secretsPath = opts.secretsPath || findSandSecretsPath();
  if (!secretsPath) {
    return {
      ok: false,
      error: `Grok Bot sand-secrets.json not found. Checked:\n${sandSecretsPathCandidates().join("\n")}`,
      chatPathProbe: CHAT_PATH_PROBE,
    };
  }

  let password = opts.password;
  try {
    if (!password) {
      const reader = opts.keychainReader || (() => readGrokBotKeychainPassword());
      password = reader();
    }
  } catch (e) {
    return {
      ok: false,
      secretsPath,
      error: e?.message || "Keychain read failed",
      chatPathProbe: CHAT_PATH_PROBE,
    };
  }

  try {
    const data = JSON.parse(fs.readFileSync(secretsPath, "utf-8"));
    const machineId = decryptOsCryptV10(data["cursor-machine-id"], password);

    let accountsObj = data["cursor-accounts"];
    if (typeof accountsObj === "string") {
      accountsObj = JSON.parse(accountsObj);
    }
    if (!accountsObj?.accounts || typeof accountsObj.accounts !== "object") {
      return {
        ok: false,
        secretsPath,
        error: "cursor-accounts scope missing or invalid after parse",
        chatPathProbe: CHAT_PATH_PROBE,
      };
    }

    const active = typeof accountsObj.active === "string" ? accountsObj.active : null;
    const entry = active ? accountsObj.accounts[active] : null;
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        secretsPath,
        error: "active account entry missing in cursor-accounts",
        chatPathProbe: CHAT_PATH_PROBE,
      };
    }

    const accessToken = decryptOsCryptV10(entry["cursor-access-token"], password);
    let refreshToken = null;
    if (isSealedBlob(entry["cursor-refresh-token"])) {
      refreshToken = decryptOsCryptV10(entry["cursor-refresh-token"], password);
    }

    let email = null;
    let name = null;
    if (isSealedBlob(entry["cursor-account-profile"])) {
      try {
        const profile = JSON.parse(decryptOsCryptV10(entry["cursor-account-profile"], password));
        if (typeof profile?.email === "string") email = profile.email;
        if (typeof profile?.name === "string") name = profile.name;
      } catch {
        /* profile optional */
      }
    }

    // Fallback: try JWT claims without logging token
    if (!email && typeof accessToken === "string" && accessToken.split(".").length === 3) {
      try {
        let payload = accessToken.split(".")[1];
        while (payload.length % 4) payload += "=";
        const decoded = JSON.parse(
          Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
        );
        email = decoded.email || decoded.sub || null;
      } catch {
        /* ignore */
      }
    }

    return {
      ok: true,
      accessToken,
      refreshToken,
      machineId,
      email,
      name,
      activeAccountId: active,
      secretsPath,
      chatPathProbe: CHAT_PATH_PROBE,
    };
  } catch (e) {
    return {
      ok: false,
      secretsPath,
      error: e?.message || "Decrypt failed",
      chatPathProbe: CHAT_PATH_PROBE,
    };
  }
}

// Re-export test hooks including PR-B decrypt helpers (defined above).
__test__.encryptOsCryptV10 = encryptOsCryptV10;
__test__.decryptOsCryptV10 = decryptOsCryptV10;
__test__.readGrokBotKeychainPassword = readGrokBotKeychainPassword;

