/**
 * Grok Bot Desktop (Anysphere Sand) — PR-B spike.
 *
 * Dedicated provider card for the Grok Bot.app Desktop session. Distinct from:
 *   - grok-cli  → Grok Build / cli-chat-proxy.grok.com
 *   - grok-web  → grok.com SSO cookie
 *   - xai       → api.x.ai PAYG
 *   - cursor    → Cursor IDE state.vscdb import
 *
 * PR-A: discover API (GET auto-import) — schema only.
 * PR-B: Keychain + OSCrypt v10 decrypt → POST auto-import stores connection.
 *       Executor: ephemeral TEMPORAL harness (create→Send→list→SSE→GC).
 */
export default {
  id: "grok-bot",
  // Visible card so Desktop import is reachable; chat path still probe-blocked.
  hidden: false,
  priority: 55,
  alias: "gbot",
  aliases: ["sand", "gbot", "grok-bot-desktop"],
  uiAlias: "gbot",
  display: {
    name: "Grok Bot Desktop",
    icon: "smart_toy",
    color: "#1DA1F2",
    textIcon: "GB",
    website: "https://grok.com",
    notice: {
      text: "Import a signed-in Grok Bot.app Desktop session (Anysphere Sand). Desktop import + ephemeral TEMPORAL /v1 (create→Send→transcript→SSE). See docs/plans/2026-09-21-grok-bot-ephemeral-harness.md. Distinct from Grok Build CLI and Grok Web cookie.",
      signupUrl: "https://grok.com",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  // Mirror Cursor transport for future stream reuse (executor currently refuses chat).
  transport: {
    baseUrl: "https://api2.cursor.sh",
    chatPath: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
    format: "cursor",
    headers: {
      "connect-accept-encoding": "gzip",
      "connect-protocol-version": "1",
      "Content-Type": "application/connect+proto",
      "User-Agent": "connect-es/1.6.1",
    },
    clientVersion: "sand-desktop",
  },
  models: [
    { id: "default", name: "Auto (Server Picks)" },
  ],
  oauth: {
    clientType: "sand",
    clientSource: "sand-desktop",
    apiEndpoint: "https://api2.cursor.sh",
    chatEndpoint: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
    modelsEndpoint: "/aiserver.v1.AiService/AvailableModels",
    authMethod: "grok-bot-desktop-import",
    chatPathStatus: "send_ok",
  },
};
