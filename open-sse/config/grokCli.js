export const GROK_CLI_VERSION = "0.2.99";
export const GROK_CLI_MODEL = "grok-build";
export const GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const GROK_CLI_CLIENT_IDENTIFIER = "grok-shell";
export const GROK_CLI_USER_AGENT = `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`;

export function supportsGrokCliReasoningEffort(model) {
  // grok-build and grok-composer-2.5-fast reject reasoning.effort (#2538/#2539).
  // Capabilities cannot gate this: PATTERN *grok* reports reasoning:true for all of them.
  // Fail-closed for grok-4.7+ until live cli-chat-proxy metadata is captured.
  return /^grok-4\.[56](?:$|-)/.test(String(model || ""));
}
