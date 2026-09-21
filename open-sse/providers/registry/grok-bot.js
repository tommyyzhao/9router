/**
 * Grok Bot Desktop (Anysphere Sand) — discover stub (PR-A).
 *
 * Dedicated provider card for the Grok Bot.app Desktop session. Distinct from:
 *   - grok-cli  → Grok Build / cli-chat-proxy.grok.com
 *   - grok-web  → grok.com SSO cookie
 *   - xai       → api.x.ai PAYG
 *   - cursor    → Cursor IDE state.vscdb import
 *
 * PR-A: hidden stub + discover API only. No executor wiring.
 * PR-B: decrypt sand-secrets, sand-header probe, store connection
 *       (clientType sand, authMethod grok-bot-desktop-import).
 */
export default {
  id: "grok-bot",
  hidden: true,
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
      text: "Coming soon: import a signed-in Grok Bot.app Desktop session (Anysphere Sand). Distinct from Grok Build CLI and Grok Web cookie. Discover endpoint: GET /api/oauth/grok-bot/auto-import.",
      signupUrl: "https://grok.com",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  // No transport / models / executor in PR-A — discover-only stub.
  models: [],
  oauth: {
    // PSD hints for PR-B (not used until decrypt+probe lands).
    clientType: "sand",
    apiEndpoint: "https://api2.cursor.sh",
    authMethod: "grok-bot-desktop-import",
  },
};
