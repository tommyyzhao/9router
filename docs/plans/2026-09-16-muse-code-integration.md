# Muse Code subscription integration

**Status:** plan (not implemented on `master`) — **subscription only, not PAYG**
**Date:** 2026-09-16
**Host evidence:** Muse Code 1.3.0-R3233.1, vendored under `vendor/muse-code/`
**Product page:** https://developer.meta.com/ai/products/muse-code/
**Docs:** https://dev.meta.ai/docs/muse-code.md

## Goal

Get a **Muse Code subscription** (Everyday / High / Power, device-code
`muse login`) working as a 9Router upstream, the way Grok Build subscription
works via `grok-cli` and Claude Pro/Max via `claude` OAuth.

Optional later: a CLI Tools card that points local `muse` at 9Router. That is
a client-config surface, not PAYG.

Today Muse Spark is only reachable as OpenCode Free/Go models
(`oc/muse-spark-*-contributor-free`, `ocg/muse-spark-*`). That is a different
upstream (OpenCode Zen), a different credential, and a known-unstable path
(#3738, encrypted-content replay).

## Non-goals (v1)

- **PAYG Meta Model API keys.** Do not add a dashboard `LLM|…` /
  `MODEL_API_KEY` apikey provider. That is what #3124 / #3757 implement; skip
  them as a product. Extra keys created in the Model API dashboard are billed
  per token and are explicitly *not* the Muse Code subscription credential.
- Spawning `muse exec` / `muse serve` as an executor (Devin-CLI pattern). Muse
  Code is a **client harness**, not an inference backend.
- Implementing MSP (Muse Session Protocol) inside the gateway.
- Muse Image / Muse Voice Transcribe (separate model families, later PRs).
- Redistributing Meta's closed 285 MB native binary.
- Treating OpenCode Muse Spark as a substitute for a Muse Code account.

## Current 9Router state (`master` @ 17c4cc76)

| Surface | Status |
|---|---|
| CLI Tools `CLI_TOOLS` | no `muse` / `muse-code` entry (claude, codex, grok-build, … yes) |
| Provider registry | no `meta.js` |
| Executor | no `meta.js` / `muse-cli.js` |
| OpenCode Muse Spark | **shipped** (Responses URL, capabilities, tests) |
| Related GitHub | #3824 (issue: OAuth + CLI tool — the subscription ask). #3124 / #3757 are **PAYG API-key** providers; out of scope. Steal executor/thinking code from #3757, do not land them. |

## Architecture (subscription upstream)

```
┌──────────────┐                      ┌─────────────┐   device-code / minted sub key
│ Claude/Codex │  9Router API key     │  9Router    │  POST https://api.meta.ai/v1/responses
│ Grok/…       │ ───────────────────► │  /v1/*      │ ──────────────────────────────────►
└──────────────┘                      └─────────────┘     Provider "meta" (Muse Code sub)
```

Same split xAI already has in this repo: `grok-cli` (subscription) vs `xai`
(PAYG). We want the `grok-cli` row, not the `xai` row.

| | Grok analog | Muse target |
|---|---|---|
| Subscription upstream | `grok-cli` device-code → `cli-chat-proxy.grok.com` | `meta` device-code (`muse login`) → `api.meta.ai/v1` with the **CLI-onboarded** credential |
| PAYG upstream | `xai` API key → `api.x.ai` | **not in v1** (dashboard `LLM\|…` / `MODEL_API_KEY`) |
| Client card (optional) | `grok-build` writes `~/.grok/config.toml` | later: point `muse` at 9Router |

The subscription credential still calls `api.meta.ai/v1` — that is where Muse
Code itself infers. Hitting that host with the **subscription-minted** token is
not "adding PAYG". PAYG is a *different* key minted from the Model API
dashboard, billed per token, "for use with Muse Code only" does not apply.

## Key decisions

1. **Provider `meta` (aliases `muse`, `muse-code`) is OAuth/subscription only.**
   `authModes: ["oauth"]`. No apikey field, no "paste MODEL_API_KEY" card.
   Connect = device-code like `muse login`, or import `~/.config/muse/auth.json`
   / macOS Keychain. Analog: `grok-cli`, not `xai`.

2. **Responses is the native transport for Muse Spark.** Lift the executor
   mapping from #3757 (code, not the apikey product): `targetFormat:
   "openai-responses"`, rewrite `/chat/completions` → `/responses` for
   `isMuseSparkModel`. Chat Completions clients translate.

3. **Do not spawn the `muse` binary for inference.** Unlike `devin-cli` /
   `gemini-cli`, Muse Code is not a local ACP/stdio model server. Inference is
   HTTP to `api.meta.ai`. The binary is only relevant as a *client* we configure.

4. **CLI Apply cannot copy Grok's custom-model section.** Muse 1.3.0 has no
   OpenAI-compatible provider type. Apply must:
   - set `settings.json` `{schema_version:1, provider:"meta", model:<picked>}`
   - persist `--base-url` if a settings key exists (probe first); otherwise
     write a documented wrapper / env (`META_API_KEY` + shell alias) and a
     "run with" command
   - **replace** the Meta bearer with a 9Router API key so Muse does not send
     the Keychain Meta token to localhost
   - stash the previous Meta login (pointer only, not the secret) so Reset
     restores `provider/model` and unsets the 9Router key override

5. **OAuth import is Keychain-aware.** `auth.json` schema 2 on macOS is a
   pointer (`storage: "keychain"`, service `ai.meta.dev.credentials`, account
   `meta`). Linux/older builds may still have `providers.meta.access_token` in
   the file (what `muse-launcher.sh` still parses). Import both. Never log the
   token.

6. **Launcher OIDC client id `1031625952748946` is the download client.**
   Session login also uses device-code (binary: `DeviceAuthorization` /
   `TokenGrant` + "mint API key"). First OAuth implementation should HAR
   `muse login` with `MUSE_TRANSPORT_TRACE=1` and confirm whether inference
   uses the OIDC access token directly or a minted `LLM|…` key. Implement
   against the minted-key path if that is what `Authorization: Bearer` on
   `/v1/responses` actually carries — then refresh is "re-mint or re-login",
   not a standard refresh_token, unless the HAR shows otherwise.

7. **Contributor vs Standard is the model id, not a provider flag.**
   Catalog: `muse-spark-1.3` vs `muse-spark-1.3-contributor`. Thinking:
   `none` forbidden; `max` documented as Standard 1.3 only (the live CLI
   catalog still lists `max` on contributor — send it and let upstream 400,
   or clamp contributor to `xhigh`). Default advertised model:
   `muse-spark-1.3-contributor` (CLI default on this host) with a dashboard
   notice that Contributor trains on prompts.

8. **Do not land #3124 / #3757 as-is.** Both are PAYG apikey providers.
   Cherry-pick only the Responses/`MetaExecutor`/thinking-format pieces from
   #3757 into an **oauth-only** registry entry. #3124 is the older Chat-only
   cut; skip it entirely.

9. **Encrypted reasoning stays on one credential.** Meta binds
   `encrypted_content` to the caller. Combos that fail over from `meta` to
   `opencode` (or another Meta account) must strip prior reasoning items, the
   same as OpenCode Free #4061. Fail-open strip is safer than a 400 that
   locks the model.

10. **Vendor the protocol, not the binary.** `vendor/muse-code/` is the
    in-tree reference (SDK + launcher + live MSP schema + this plan's
    evidence). Do not commit `muse-bin-*`.

## Provider design (PR-1)

Follow `open-sse/AGENTS.md` + `REGISTRY_TEMPLATE.js`.

`open-sse/providers/registry/meta.js` (shape, values from PROTOCOL.md):

```js
{
  id: "meta",
  alias: "meta",
  aliases: ["meta-ai", "muse", "muse-code"],
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  thinkingConfig: { options: ["minimal","low","medium","high","xhigh","max"], defaultMode: "high" },
  transport: {
    baseUrl: "https://api.meta.ai/v1/chat/completions",
    validateUrl: "https://api.meta.ai/v1/models",
    format: "openai",
    thinkingFormat: "meta",
    modelsFetcher: { url: "https://api.meta.ai/v1/models", type: "openai" },
    passthroughModels: true,
    auth: { oauth: { header: "Authorization", scheme: "bearer" } },
  },
  models: [
    { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", targetFormat: "openai-responses" },
    { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", targetFormat: "openai-responses" },
    { id: "muse-spark-1.2", name: "Muse Spark 1.2", targetFormat: "openai-responses" },
  ],
  oauth: {
    clientId: "1031625952748946", // confirm vs HAR of `muse login` before shipping
    deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
    tokenUrl: "https://auth.meta.com/oidc/device/token/",
    // refreshUrl: TBD from HAR
  },
}
```

`MetaExecutor` (#3757 already):

- `parseMetaSuffix` accepts `model-xhigh` and `model(xhigh)`
- Muse Spark → `/v1/responses`, `max_output_tokens`, `reasoning: {effort, summary:"auto"}`
- Strip `reasoning_effort` / `max_tokens` after translation
- `include: ["reasoning.encrypted_content"]` on store-less loops

OAuth UI: reuse `src/lib/oauth/providers/grok-cli.js` device-code pattern
(`flowType: "device_code"`, poll `authorization_pending` / `slow_down`).
Add `src/lib/oauth/providers/meta.js` + import-from-file path modeled on
`kiroExternalIdp.js`, plus macOS Keychain:

```
security find-generic-password -s ai.meta.dev.credentials -a meta -w
```

Quota: v1 can skip or show "open Accounts Center" until usage HTTP is
captured. Do not fake OpenCode Zen quotas onto a Meta card.

## CLI Tools design (PR-3)

Files to mirror from Grok Build:

| Grok | Muse |
|---|---|
| `CLI_TOOLS["grok-build"]` | `CLI_TOOLS["muse-code"]` |
| `GrokBuildToolCard.js` | `MuseCodeToolCard.js` |
| `src/lib/grokBuildConfig.js` | `src/lib/museCodeConfig.js` |
| `/api/cli-tools/grok-build-settings` | `/api/cli-tools/muse-code-settings` |
| `all-statuses` map | add `muse-code` |

Card behaviour:

- Detect install: `which muse` / `~/.local/bin/muse`
- Show version (`muse --version`) and current `settings.json` model
- Model picker = 9Router aliases (same as other CLI tools)
- Apply:
  1. Ensure `schema_version: 1`
  2. Set `provider: "meta"`, `model: <selected 9router id>`
  3. Set 9Router key via `META_API_KEY` instructions **and** `muse auth set` if we can do it non-interactively (`--api-key-stdin`)
  4. Persist base URL (settings key if real, else generate a `muse-9router` wrapper on PATH that execs `muse --base-url http://127.0.0.1:20128/v1 "$@"`)
- Reset: restore previous settings.json; do not delete the user's Meta Keychain login
- Notes: Contributor training disclosure; `--base-url` required; Windows now supported upstream (install.ps1)

9Router as the *server* for this client must accept Responses-shaped POSTs on
`/v1/responses` (already present for Codex/Grok). Muse will look like any other
Responses client. Confirm with a traced `muse --base-url` against a dummy
listener before coding the card.

## Test plan

- `tests/unit/meta-ai.test.js` from #3757, plus OAuth device-code fixtures
  (no live Meta).
- Import tests: file `access_token` shape, schema-2 keychain pointer (do not
  call `security` in CI).
- CLI settings round-trip: apply/reset of `settings.json` with a temp HOME.
- `verify-providers` / `verify-alias` / `verify-oauth-urls` baselines.
- Live (manual): device-code login on a Muse Code subscription account, then
  `meta/muse-spark-1.3-contributor` through 9Router from Claude/Codex. No
  dashboard `LLM|` key.

## Risks

| Risk | Mitigation |
|---|---|
| Session OAuth is not the launcher client id | HAR `muse login` before merging; do not fall back to PAYG keys |
| Muse Code sub key rejected unless CLI-shaped headers | `MUSE_TRANSPORT_TRACE=1` against api.meta.ai from a real `muse` session; copy User-Agent / client headers |
| Encrypted reasoning across combo failover | Strip reasoning items when the credential changes |
| Keychain import on macOS needs user keychain unlock | Dashboard: unlock login keychain, or re-run device-code Connect |
| Contributor `max` 400 | Clamp contributor to `xhigh` per official reasoning docs |
| Closed binary drifts | Re-run `muse schema` + catalog snapshot; pin `SNAPSHOT.json` |

## PR Plan

### PR 1 — `feat(providers): Muse Code subscription OAuth`

- OAuth-only `registry/meta.js` (`authModes: ["oauth"]`).
- Device-code Connect (grok-cli pattern) + import `auth.json` / Keychain.
- Lift Responses/`MetaExecutor`/thinking-format from #3757 **without** the
  apikey product, notice, or `MODEL_API_KEY` docs.
- Files: registry, executor, oauth provider, capabilities, thinking, pricing,
  icon, tests, baselines, changelog.
- Depends on: HAR of `muse login` (client id, token vs minted key, headers).
- Done when: dashboard device-code login on a Muse Code **subscription**
  account can complete `meta/muse-spark-1.3-contributor` from a Claude/Codex
  client. No dashboard `LLM|` key used in the proof.

### PR 2 — `feat(usage): Muse Code subscription quota`

- After HAR of `usage/changed` / billing HTTP for the CLI-onboarded credential.
- 5-hour / weekly windows matching Everyday/High/Power, not PAYG token spend.
- Depends on: PR 1.

### PR 3 (optional) — `feat(cli-tools): Muse Code card`

- Point local `muse` at 9Router. Independent of PAYG. Not required to "get
  the subscription working through 9Router" (that is PR 1).
- Depends on: nothing strictly; nicer after PR 1.

PAYG Model API (`LLM|` keys, #3124, #3757 as shipped) stays out.

## Open questions (need a live HAR, not a product decision)

Protocol facts for PR 1, with `MUSE_TRANSPORT_TRACE=1` / device-code mitm of
`auth.meta.com`:

1. Does `/v1/responses` Bearer the OIDC access token or a minted key, and is
   that minted key the subscription-bound CLI key (not a PAYG dashboard key)?
2. Is there a refresh_token, or is re-login the only rotation?
3. Exact User-Agent and extra headers the CLI sends (`x-client-id` appears in
   the binary). Subscription keys may require CLI-shaped headers.

Product is settled: **subscription OAuth only**, Responses transport, no PAYG
apikey provider.

## References

- `vendor/muse-code/PROTOCOL.md` — wire reconstruction
- `vendor/muse-code/README.md` — what was vendored and what was not
- `open-sse/AGENTS.md` — how to add a provider/executor
- Grok analog: `open-sse/providers/registry/grok-cli.js`,
  `src/lib/oauth/providers/grok-cli.js`, `src/lib/grokBuildConfig.js`
- GitHub: #3824 (subscription/OAuth ask). #3757/#3124 = PAYG, code-mine only.
