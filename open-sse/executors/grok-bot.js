import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { CHAT_PATH_PROBE } from "../shared/grokBotAccount.js";

/**
 * Grok Bot Desktop executor (PR-B spike).
 *
 * Reuses Cursor Connect/checksum helpers with clientType=sand when building
 * headers, but refuses to claim a working chat path: live probe (2026-09-21)
 * showed AgentService.Run rejects sand traffic, ChatService returns an
 * Update-Required version gate, and InferenceService.Stream is unauthenticated
 * for the Sand session JWT. Unary Dashboard/AiService calls succeed.
 *
 * TODO(PR-C): once a supported stream path is confirmed, delegate to
 * CursorExecutor (or InferenceService) with sand headers.
 */
export class GrokBotDesktopExecutor extends BaseExecutor {
  constructor() {
    super("grok-bot", PROVIDERS["grok-bot"] || PROVIDERS.cursor);
  }

  buildUrl() {
    return `${this.config?.baseUrl || "https://api2.cursor.sh"}${this.config?.chatPath || "/aiserver.v1.ChatService/StreamUnifiedChatWithTools"}`;
  }

  /**
   * Sand-flavored Cursor headers (for future stream wiring / manual probes).
   * Not used for a live chat path until CHAT_PATH_PROBE.status !== "blocked".
   */
  buildHeaders(credentials) {
    const accessToken = credentials.accessToken;
    const machineId = credentials.providerSpecificData?.machineId;
    const ghostMode = credentials.providerSpecificData?.ghostMode !== false;
    if (!machineId) {
      throw new Error("Machine ID is required for Grok Bot Desktop API");
    }
    return buildCursorHeaders(accessToken, machineId, ghostMode, {
      clientType: "sand",
      clientSource: "sand-desktop",
      clientVersion: "sand-desktop",
    });
  }

  async execute(_args) {
    const probe = CHAT_PATH_PROBE;
    return new Response(
      JSON.stringify({
        error: {
          message:
            "Grok Bot Desktop chat path not yet available. Decrypt/import works; " +
            "api2.cursor.sh AgentService.Run rejects clientType=sand, ChatService is " +
            "version-gated (Update Required), InferenceService.Stream unauthenticated. " +
            "See docs/plans/2026-09-21-grok-bot-desktop-integration.md (PR-B probe).",
          type: "grok_bot_chat_path_blocked",
          code: "probe_required",
          probe: {
            status: probe.status,
            unaryDashboardOk: probe.unaryDashboardOk,
            agentRunSandRejected: probe.agentRunSandRejected,
            chatServiceVersionGated: probe.chatServiceVersionGated,
            inferenceUnauthenticated: probe.inferenceUnauthenticated,
          },
        },
      }),
      {
        status: HTTP_STATUS.BAD_REQUEST || 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

export default GrokBotDesktopExecutor;
