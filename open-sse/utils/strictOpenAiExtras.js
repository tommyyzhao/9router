/**
 * Client-only OpenAI Chat Completions / Responses extras that many
 * "OpenAI-compatible" upstreams reject with Pydantic `extra_forbidden` 422
 * (e.g. mistral-vibe-cli-*). OpenAI's own APIs accept `store`/`metadata`;
 * 9router executors that need `store=false` for Responses continuity set it
 * themselves after translation — so stripping client-supplied values here is
 * safe and does not break Codex/Grok/OpenCode store=false paths.
 */
const STRICT_OPENAI_EXTRA_KEYS = [
  "store",
  "metadata",
];

export function stripStrictOpenAiExtras(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  let out = body;
  for (const key of STRICT_OPENAI_EXTRA_KEYS) {
    if (!(key in out)) continue;
    if (out === body) out = { ...body };
    delete out[key];
  }
  return out;
}

export { STRICT_OPENAI_EXTRA_KEYS };
