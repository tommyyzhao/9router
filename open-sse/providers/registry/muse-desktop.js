// Muse Desktop provider — Meta's Muse via the Hatch Noise gateway.
// Transport is Noise_XX_25519_AESGCM_SHA256 over WSS (see
// open-sse/shared/museNoise.js), not HTTPS: the executor dials the gateway,
// opens chat.subscribe, sends chat.stream, and decodes the event stream into
// OpenAI-compatible SSE. Auth is a Hatch session (admission JWT + notary
// endorsement) imported from the user's logged-in Muse app.
export default {
  id: "muse-desktop",
  priority: 290,
  alias: "muse-desktop",
  aliases: [
    "muse-desktop",
    "musedesktop",
    "mdd",
  ],
  uiAlias: "muse-desktop",
  display: {
    name: "Muse Desktop",
    icon: "smart_toy",
    color: "#0082FB",
    textIcon: "MD",
    website: "https://muse.ai",
    notice: {
      signupUrl: "https://muse.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  serviceKinds: ["llm"],
  transport: {
    // Not an HTTPS endpoint: the executor speaks Noise over WSS.
    baseUrl: "wss://hatch.metaaivm.com/v1/noise",
  },
  transports: [
    {
      format: "openai",
      baseUrl: "wss://hatch.metaaivm.com/v1/noise",
      auth: { combined: true, header: "session", scheme: "muse-noise" },
    },
  ],
  models: [
    { id: "muse-spark", name: "Muse Spark", upstreamModelId: "muse-desktop/muse-spark", supportedFormats: ["openai"] },
  ],
  features: {
    usage: true,
    usageEstimated: true,
  },
};
