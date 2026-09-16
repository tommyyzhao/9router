import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const MUSE_AUTH_JSON_REL = join(".config", "muse", "auth.json");
export const MUSE_KEYCHAIN_SERVICE = "ai.meta.dev.credentials";
export const MUSE_KEYCHAIN_ACCOUNT = "meta";

/**
 * Parse the Keychain / file secret blob used by Muse Code 1.3.
 * Shape: { secret_schema_version, api_key: "LLM|…", access_token: "dca:…" }
 * Inference uses api_key; access_token is the OIDC device grant and 401s on api.meta.ai.
 */
export function parseMuseSecretBlob(raw) {
  if (raw == null) return null;
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("LLM|")) {
      return { apiKey: trimmed, oauthAccessToken: null, secretSchemaVersion: null };
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawApiKey = typeof value.api_key === "string" && value.api_key.startsWith("LLM|")
    ? value.api_key
    : (typeof value.apiKey === "string" && value.apiKey.startsWith("LLM|") ? value.apiKey : null);
  const rawAccess = typeof value.access_token === "string" && value.access_token
    ? value.access_token
    : (typeof value.accessToken === "string" ? value.accessToken : null);
  const apiKey = rawApiKey || (rawAccess?.startsWith("LLM|") ? rawAccess : null);
  const oauthAccessToken = rawAccess && !rawAccess.startsWith("LLM|") ? rawAccess : null;
  if (!apiKey) return null;
  return {
    apiKey,
    oauthAccessToken,
    secretSchemaVersion: value.secret_schema_version ?? value.secretSchemaVersion ?? null,
  };
}

export function parseMuseAuthJson(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const meta = raw.providers?.meta;
  if (!meta || typeof meta !== "object") return null;
  return {
    schemaVersion: raw.schema_version ?? null,
    mechanism: meta.mechanism || null,
    storage: meta.storage || null,
    obtainedVia: meta.obtained_via || meta.obtainedVia || null,
    apiBaseUrl: meta.api_base_url || meta.apiBaseUrl || "https://api.meta.ai/v1",
    email: typeof meta.user_email === "string" ? meta.user_email : null,
    displayName: typeof meta.user_full_name === "string" ? meta.user_full_name : null,
    fileApiKey: typeof meta.api_key === "string" ? meta.api_key : null,
    fileAccessToken: typeof meta.access_token === "string" ? meta.access_token : null,
  };
}

async function readAuthJsonFile() {
  const path = join(homedir(), MUSE_AUTH_JSON_REL);
  try {
    const text = await readFile(path, "utf8");
    return { path, data: JSON.parse(text) };
  } catch {
    return { path, data: null };
  }
}

async function readDarwinKeychainSecret() {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", MUSE_KEYCHAIN_SERVICE,
      "-a", MUSE_KEYCHAIN_ACCOUNT,
      "-w",
    ], { timeout: 60000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Read the local Muse Code subscription credential.
 * Never logs the secret. Returns { found, source, email, displayName, apiKey, oauthAccessToken, apiBaseUrl }.
 */
export async function readLocalMuseCredentials() {
  const { path, data } = await readAuthJsonFile();
  const meta = parseMuseAuthJson(data);
  let blob = null;
  let source = null;

  const tryKeychain = meta?.storage === "keychain"
    || (process.platform === "darwin" && meta?.storage !== "file");
  if (tryKeychain) {
    const secret = await readDarwinKeychainSecret();
    blob = parseMuseSecretBlob(secret);
    if (blob) source = "keychain";
  }

  if (!blob && meta) {
    blob = parseMuseSecretBlob({
      api_key: meta.fileApiKey,
      access_token: meta.fileAccessToken,
    });
    if (blob) source = "auth.json";
  }

  if (!blob) {
    return {
      found: false,
      source: null,
      authJsonPath: path,
      email: meta?.email || null,
      displayName: meta?.displayName || null,
      error: meta
        ? "Muse Code is configured but the subscription key is not readable (unlock the login keychain, or re-run muse login)."
        : "Muse Code is not logged in on this machine. Run `muse login` first.",
    };
  }

  return {
    found: true,
    source,
    authJsonPath: path,
    email: meta?.email || null,
    displayName: meta?.displayName || null,
    apiBaseUrl: meta?.apiBaseUrl || "https://api.meta.ai/v1",
    obtainedVia: meta?.obtainedVia || null,
    apiKey: blob.apiKey,
    oauthAccessToken: blob.oauthAccessToken,
  };
}
