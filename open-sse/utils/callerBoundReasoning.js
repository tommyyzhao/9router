/**
 * Encrypted reasoning blobs are bound to the caller that minted them
 * (Meta Muse Spark, OpenCode Zen, Codex store=false). Replaying them on a
 * different credential or provider 400s with "was not issued to this caller".
 *
 * Combo failover and account rotation must drop the blob rather than lock
 * the next model. Same-credential multi-turn on the first attempt is left
 * intact — call this only when the credential/provider is changing.
 */
export function stripCallerBoundReasoning(body) {
  if (!body || typeof body !== "object") return body;

  const out = { ...body };

  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      if (msg.encrypted_content == null && msg.reasoning_encrypted_content == null) return msg;
      const copy = { ...msg };
      delete copy.encrypted_content;
      delete copy.reasoning_encrypted_content;
      return copy;
    });
  }

  if (Array.isArray(body.input)) {
    out.input = body.input.filter((item) => !(item && item.type === "reasoning" && item.encrypted_content));
  }

  return out;
}
