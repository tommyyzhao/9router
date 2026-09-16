/**
 * Meta Muse Code (subscription)
 *
 * Device-code / CLI-onboarded Muse Code account. Inference is the Meta Model
 * API Responses endpoint with the CLI-minted key (LLM|…), not a dashboard
 * PAYG key. Analogous to grok-cli vs xai.
 *
 * Distinct from OpenCode Free/Go muse-spark-* (different host + credential).
 */
export default {
  id: "meta",
  priority: 270,
  alias: "meta",
  aliases: ["meta-ai", "muse", "muse-code"],
  uiAlias: "meta",
  display: {
    name: "Muse Code",
    icon: "auto_awesome",
    color: "#0064E0",
    textIcon: "MC",
    website: "https://developer.meta.com/ai/products/muse-code/",
    notice: {
      text: "Sign in with the Muse Code CLI (muse login) or device code. Uses your Muse Code subscription, not a Model API PAYG key.",
      signupUrl: "https://dev.meta.ai/",
    },
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  thinkingConfig: {
    options: ["minimal", "low", "medium", "high", "xhigh", "max"],
    defaultMode: "high",
  },
  passthroughModels: true,
  transport: {
    baseUrl: "https://api.meta.ai/v1/responses",
    validateUrl: "https://api.meta.ai/v1/models",
    format: "openai-responses",
    thinkingFormat: "meta",
    forceStream: true,
    headers: {
      "User-Agent": "muse-code/1.3.0",
    },
    retry: {
      429: { attempts: 2, delayMs: 2000 },
      502: { attempts: 2, delayMs: 1500 },
      503: { attempts: 2, delayMs: 1500 },
    },
  },
  models: [
    { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", targetFormat: "openai-responses" },
    { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", targetFormat: "openai-responses" },
    { id: "muse-spark-1.2", name: "Muse Spark 1.2", targetFormat: "openai-responses" },
    { id: "muse-spark-1.1", name: "Muse Spark 1.1", targetFormat: "openai-responses" },
  ],
  oauth: {
    clientId: "1031625952748946",
    deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
    tokenUrl: "https://auth.meta.com/oidc/device/token/",
    refreshUrl: "https://auth.meta.com/oidc/device/token/",
  },
  modelsFetcher: { url: "https://api.meta.ai/muse-code/models", type: "openai" },
  serviceKinds: ["llm"],
};
