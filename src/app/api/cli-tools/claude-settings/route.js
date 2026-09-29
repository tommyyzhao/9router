"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getSettings, updateSettings } from "@/lib/localDb";
import { ensureWebMcpToken } from "@/lib/mcp/webMcpToken";

const execAsync = promisify(exec);
const WEB_MCP_NAME = "9router-web";
const WEB_MCP_TOKEN_HEADER = "x-9r-mcp-token";

const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa");
const buildExaMcpEntry = () => ({
  type: EXA_PLUGIN.transport,
  url: EXA_PLUGIN.url,
});

const getClaudeSettingsPath = () => {
  const homeDir = os.homedir();
  return path.join(homeDir, ".claude", "settings.json");
};

const getClaudeJsonPath = () => path.join(os.homedir(), ".claude.json");

// String-aware JSONC: strip line and block comments only outside string literals.
function stripJsoncComments(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(String(text))));
}

const readClaudeJson = async () => {
  try {
    const content = await fs.readFile(getClaudeJsonPath(), "utf-8");
    return parseJsonc(content);
  } catch {
    return null;
  }
};

/**
 * Merge and/or remove managed MCP servers in ~/.claude.json.
 * @param {object|null} mergeServers keys to upsert
 * @param {string[]} removeKeys server names to delete
 */
const writeClaudeJsonMcp = async (mergeServers, removeKeys = []) => {
  const filePath = getClaudeJsonPath();
  let data = {};
  let existed = false;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    data = parseJsonc(raw);
    existed = true;
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  } catch (error) {
    if (error.code !== "ENOENT") {
      const err = new Error(`Failed to parse ~/.claude.json: ${error.message}`);
      err.status = 400;
      throw err;
    }
  }

  if (mergeServers && Object.keys(mergeServers).length > 0) {
    data.mcpServers = { ...(data.mcpServers || {}), ...mergeServers };
  }
  for (const key of removeKeys) {
    if (data.mcpServers?.[key] !== undefined) delete data.mcpServers[key];
  }
  if (data.mcpServers && Object.keys(data.mcpServers).length === 0) delete data.mcpServers;

  const payload = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, payload, { mode: 0o600 });
  // writeFile mode does not tighten an existing file — always chmod.
  await fs.chmod(filePath, 0o600);
  void existed;
};

const buildWebMcpEntry = (token) => {
  const port = UPDATER_CONFIG.appPort || process.env.PORT || 20128;
  return {
    type: "sse",
    url: `http://127.0.0.1:${port}/api/mcp/${WEB_MCP_NAME}/sse`,
    headers: { [WEB_MCP_TOKEN_HEADER]: token },
  };
};

const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readSettings = async () => {
  try {
    const settingsPath = getClaudeSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    return parseJsonc(content);
  } catch {
    return null;
  }
};

export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const has9Router = !!(settings?.env?.ANTHROPIC_BASE_URL);
    const claudeJson = await readClaudeJson();

    return NextResponse.json({
      installed: true,
      settings: settings,
      has9Router: has9Router,
      webMcpEnabled: !!claudeJson?.mcpServers?.[WEB_MCP_NAME],
      exaMcpEnabled: !!claudeJson?.mcpServers?.exa,
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json({ error: "Failed to check claude settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { env, webMcpEnabled, exaMcpEnabled, autoCompactWindow } = await request.json();

    if (!env || typeof env !== "object") {
      return NextResponse.json({ error: "Invalid env object" }, { status: 400 });
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);
    await fs.mkdir(claudeDir, { recursive: true });

    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = parseJsonc(content);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.endsWith("/v1")
        ? env.ANTHROPIC_BASE_URL
        : `${env.ANTHROPIC_BASE_URL}/v1`;
    }

    // Keep an existing token (real key or earlier config); only add when absent — Reset clears it.
    if (currentSettings.env?.ANTHROPIC_AUTH_TOKEN) {
      delete env.ANTHROPIC_AUTH_TOKEN;
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };

    if (autoCompactWindow) {
      newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(autoCompactWindow);
    } else {
      delete newSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2), { mode: 0o600 });
    await fs.chmod(settingsPath, 0o600);

    const merge = {};
    const remove = [];

    if (webMcpEnabled) {
      const token = await ensureWebMcpToken(getSettings, updateSettings);
      merge[WEB_MCP_NAME] = buildWebMcpEntry(token);
    } else {
      remove.push(WEB_MCP_NAME);
    }

    // Legacy Exa toggle — only touch when explicitly present in the payload.
    if (exaMcpEnabled === true && EXA_PLUGIN) {
      merge.exa = buildExaMcpEntry();
    } else if (exaMcpEnabled === false) {
      remove.push("exa");
    }

    if (Object.keys(merge).length > 0 || remove.length > 0) {
      await writeClaudeJsonMcp(Object.keys(merge).length ? merge : null, remove);
    }

    return NextResponse.json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update claude settings" },
      { status: error.status || 500 }
    );
  }
}

const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];

export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = parseJsonc(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        await writeClaudeJsonMcp(null, [WEB_MCP_NAME, "exa"]);
        return NextResponse.json({ success: true, message: "No settings file to reset" });
      }
      throw error;
    }

    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });
      if (Object.keys(currentSettings.env).length === 0) delete currentSettings.env;
    }

    await writeClaudeJsonMcp(null, [WEB_MCP_NAME, "exa"]);
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));
    await fs.chmod(settingsPath, 0o600);

    return NextResponse.json({ success: true, message: "Settings reset successfully" });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    return NextResponse.json({ error: "Failed to reset claude settings" }, { status: 500 });
  }
}
