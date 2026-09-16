import { DefaultExecutor } from "./default.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

const META_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none"]);
const CONTRIBUTOR_RE = /-contributor(?:$|[-_:.\s])/i;

function isResponsesModel(model) {
  return isMuseSparkModel(model);
}

/**
 * Strip a trailing reasoning suffix from a Meta model id.
 * Accepts dash form (`muse-spark-1.3-xhigh`) and parenthesized form (`muse-spark-1.3(xhigh)`).
 */
export function parseMetaSuffix(model) {
  const s = String(model || "");
  const paren = s.match(/\(([^()]+)\)\s*$/);
  if (paren) return { base: s.slice(0, paren.index).trim(), level: paren[1].trim().toLowerCase() };
  const dash = s.match(/-(minimal|low|medium|high|xhigh|max|none)\s*$/i);
  if (dash) return { base: s.slice(0, dash.index).trim(), level: dash[1].toLowerCase() };
  return { base: s, level: null };
}

function normalizeMetaEffort(effort, baseModel) {
  if (typeof effort !== "string") return null;
  const e = effort.toLowerCase().trim();
  if (e === "none" || e === "off") return null;
  if (e === "ultra") return "xhigh";
  if (e === "max" && CONTRIBUTOR_RE.test(baseModel || "")) return "xhigh";
  if (e === "max") return "max";
  return META_LEVELS.has(e) ? e : null;
}

export class MetaExecutor extends DefaultExecutor {
  constructor() {
    super("meta");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const { base } = parseMetaSuffix(model);
    if (isResponsesModel(base)) {
      const url = this.config.baseUrl || "";
      if (url.endsWith("/responses")) return url;
      return url.replace(/\/chat\/completions$/, "/responses");
    }
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  transformRequest(model, body, stream, credentials) {
    const { base, level } = parseMetaSuffix(model);
    const t = body && typeof body === "object" ? { ...body } : {};

    if (base !== model) t.model = base;

    if (isResponsesModel(base)) {
      if (t.max_output_tokens === undefined) {
        if (t.max_completion_tokens !== undefined) t.max_output_tokens = t.max_completion_tokens;
        else if (t.max_tokens !== undefined) t.max_output_tokens = t.max_tokens;
      }
      delete t.max_tokens;
      delete t.max_completion_tokens;
      delete t.messages;
      // store=false cannot resolve a previous Meta response id
      delete t.previous_response_id;

      const current = t.reasoning && typeof t.reasoning === "object" && !Array.isArray(t.reasoning)
        ? t.reasoning
        : null;
      const raw = level
        || (typeof t.reasoning_effort === "string" ? t.reasoning_effort : null)
        || current?.effort;
      const effort = normalizeMetaEffort(raw, base);
      if (effort) {
        t.reasoning = { ...current, effort };
        if (!t.reasoning.summary) t.reasoning.summary = "auto";
      }
      delete t.reasoning_effort;

      if (t.store === undefined) t.store = false;
      // Registry forceStream: keep the JSON body aligned with Accept: text/event-stream.
      // Same-format Responses clients otherwise pass stream:false and Meta replies with JSON.
      t.stream = true;
      // Store-less loops need the encrypted blob back for the next turn.
      const include = Array.isArray(t.include) ? [...t.include] : [];
      if (!include.includes("reasoning.encrypted_content")) {
        include.push("reasoning.encrypted_content");
      }
      t.include = include;
    } else if (level && level !== "none" && META_LEVELS.has(level) && t.reasoning_effort === undefined) {
      t.reasoning_effort = level === "max" && CONTRIBUTOR_RE.test(base) ? "xhigh" : level;
    }

    return super.transformRequest(base || model, t, stream, credentials);
  }
}
