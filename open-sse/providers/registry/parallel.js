export default {
  id: "parallel",
  alias: "parallel",
  display: {
    name: "Parallel",
    icon: "hub",
    color: "#0F172A",
    textIcon: "PA",
    website: "https://parallel.ai",
    notice: {
      apiKeyUrl: "https://platform.parallel.ai"
    }
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: [
    "webSearch",
    "webFetch"
  ],
  searchConfig: {
    baseUrl: "https://api.parallel.ai/v1/search",
    method: "POST",
    authType: "apikey",
    authHeader: "x-api-key",
    costPerQuery: 0.001,
    freeMonthlyQuota: 5000,
    searchTypes: [
      "web",
      "news"
    ],
    defaultMaxResults: 5,
    maxMaxResults: 20,
    timeoutMs: 10000,
    cacheTTLMs: 300000
  },
  fetchConfig: {
    baseUrl: "https://api.parallel.ai/v1/extract",
    method: "POST",
    authType: "apikey",
    authHeader: "x-api-key",
    costPerQuery: 0.001,
    freeMonthlyQuota: 5000,
    formats: [
      "markdown"
    ],
    maxCharacters: 100000,
    timeoutMs: 20000
  }
};
