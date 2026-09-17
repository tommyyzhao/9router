# Plan: Mistral Vibe models as a first-class 9Router catalog

**Date:** 2026-09-16  
**Worktree:** `/Users/admin/.grok/worktrees/opensource-9router/9router-mistral`  
**Branch:** `feat/mistral-vibe-models` (from `dev` @ `e030ce7e`)  
**Reference:** `/Users/admin/Projects/opensource/CLIProxyAPI/local-docs/MISTRAL_SUPPORT.md`

## 0. Context — provider already exists

9Router already ships `mistral` as an API-key OpenAI-compatible provider (`open-sse/providers/registry/mistral.js`) pointed at `https://api.mistral.ai/v1`. The seed catalog was only four rows (large / medium / codestral / embed). Mistral **Vibe CLI** model ids were missing, so clients that speak Vibe could not address them as `mistral/<model>`.

## 1. Harness facts (this host)

| Fact | Value |
|---|---|
| Vibe CLI | `vibe` 2.25.4 |
| Auth file | `~/.vibe/.env` → `MISTRAL_API_KEY` (also `~/.cli-proxy-api/mistral-default.json`) |
| API base | `https://api.mistral.ai/v1` |
| Plan | chat / EDU |
| Default vibe model | `mistral-vibe-cli-latest` (alias `mistral-medium-3.5`) |
| Cheap vibe model | `devstral-small-latest` (server remaps → `mistral-medium-3-5`) |
| Narrator / summary | `mistral-vibe-cli-fast` |
| Tools / web-search | `mistral-vibe-cli-with-tools` |

Live `/v1/models` (53 ids) includes all three `mistral-vibe-cli-*` ids. Probed chat completions:

| Model id | HTTP | Response `model` |
|---|---|---|
| `mistral-vibe-cli-latest` | 200 | itself |
| `mistral-vibe-cli-fast` | 200 | itself |
| `mistral-vibe-cli-with-tools` | 200 | itself |
| `devstral-small-latest` | 200 | `mistral-medium-3-5` |
| `labs-leanstral-1-5` | 403 | not on this plan — omitted |

## 2. Scope

**In:**
- Expand `registry/mistral.js` models with the Vibe CLI catalog + remaining public chat rows
- `thinkingConfig` low/medium/high (matches vibe + CLIProxyAPI defaults)
- Capabilities for vibe/devstral/medium (vision + 200K/256K)
- Canonical pricing for vibe ids
- Unit tests + CHANGELOG

**Out:**
- New provider id / OAuth device flow (Vibe uses a permanent API key, not PKCE)
- Voxtral TTS/STT media surface (separate follow-up if wanted)
- Codestral FIM-specific executor (chat already works on the shared API)

## 3. Request path

```
client → 9Router /v1/chat/completions
  model: mistral/mistral-vibe-cli-latest
  → DefaultExecutor (OpenAI-compatible)
  → https://api.mistral.ai/v1/chat/completions
  → Authorization: Bearer <connection.apiKey>
```

No custom executor, no translator change — pivot through OpenAI.

## 4. Validation

1. Unit: `tests/unit/mistral-vibe-models.test.js`
2. Baselines: `verify-providers.mjs` (transport unchanged), `verify-alias.mjs` (no new alias key required; optional `mistral-ai` alias added)
3. E2E through local 9Router `:20128` with a Mistral connection + minted `/v1` key — PONG on every Vibe model id

## 5. Branch / merge

- Feature branch `feat/mistral-vibe-models`
- After E2E green → merge into `dev` (no push)
