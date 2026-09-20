// Internal (in-process) MCP plugins — not spawnable stdio children.
// Lives beside handlers so coworkPlugins.js (Cowork managed list) stays unaware.

export const INTERNAL_MCP_PLUGINS = [
  {
    name: "9router-web",
    kind: "internal",
    toolNames: ["web_search", "web_fetch"],
  },
];

export function findInternalPlugin(name) {
  return INTERNAL_MCP_PLUGINS.find((p) => p.name === name) || null;
}

export async function loadInternalHandler(name) {
  if (name !== "9router-web") return null;
  return await import("./gatewayWebMcp.js");
}
