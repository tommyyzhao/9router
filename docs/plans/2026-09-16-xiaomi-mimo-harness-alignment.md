# Plan: Align Xiaomi MiMo with the current MiMo Desktop harness

**Date:** 2026-09-16  
**Worktree:** `/Users/admin/.grok/worktrees/opensource-9router/9router-mimo-harness`  
**Branch:** `feat/xiaomi-mimo-harness-alignment` (from `origin/master` @ `17c4cc76`)  
**Harness under study:** `/Applications/Xiaomi MiMo AI.app` v`26.912.121036` (this host)

## 0. Context — support already exists

9Router **already has** Xiaomi MiMo as first-class providers (landed in `73cb8914` and earlier):

| Provider | Role |
|---|---|
| `xiaomi-mimo` (`mimo` / `xmd`) | Dual auth: `sk-` cloud API **or** Desktop account session. Preview models + TTS. |
| `xiaomi-tokenplan` (`xmtp`) | `tp-` cluster keys (SGP / CN / AMS). |
| `mimo-free` (`mmf`) | Ended free channel — **hidden**. |

This plan is **not** a greenfield provider. It is a **harness-alignment pass**: reverse-engineer the live Desktop engine and fix the places 9Router’s Desktop glue no longer matches it.

## 1. Harness research summary

### 1.1 Product shape

MiMo Desktop is an Electron shell around **MiMoCode** (OpenCode fork). Inference leaves the process as HTTP:

```
client → 9Router /v1/* → translator → XiaomiMimoExecutor
  ├─ cloud models   → https://api.xiaomimimo.com/v1/...   (Bearer sk-…)
  ├─ preview/subscription route
  │                 → https://mimo-server-<region>.xiaomimimo.com/api/route/chat/completions
  │                   (Cookie: serviceToken=… from Xiaomi account SSO)
  └─ token-plan     → token-plan-{sgp,cn,ams}.xiaomimimo.com (tp- key)
```

Local capability API (`mimo llm-server`, loopback `/v1` + scoped tokens) is a **Desktop-side** convenience for skills/subprocesses. 9Router does **not** need to implement it.

### 1.2 Live host facts (this machine)

| Fact | Value |
|---|---|
| App folder | `~/Library/Application Support/Xiaomi MiMo AI/` |
| APM region | **SGP** (`apm-region.json`) |
| Account cookie DB | `…/Xiaomi MiMo AI/Partitions/xiaomi-account/Cookies` (**no** `Network/` subdir) |
| passToken / userId / cUserId | present, plaintext `value` column |
| `~/.local/share/mimocode/auth.json` | **absent** (old auto-import source) |
| Account model catalog | `model-catalog.json` → `mimo-x-pro-preview`, `mimo-x-flash-preview`, `mimo-v2.5-tts*`, `mimo-v2.5-asr`, `gpt-image-2` |

### 1.3 Desktop engine constants (from asar)

**Account-service hosts** (overseas map in `index.mjs`):

| Region | Host |
|---|---|
| SGP | `mimo-server-sgp.xiaomimimo.com` |
| RU | `mimo-server-ru.xiaomimimo.com` |
| IN | `mimo-server-in.xiaomimimo.com` |
| CN | domestic edition path (not in the overseas host map) |
| EU | country-mapped; falls back like SGP |

Resolution order: `MIMO_API_BASE_URL` env → cached region (`apm-region.json`) → edition default → system country → fallback **SGP**.

**Subscription route models** (cookie-auth): `mimo-auto`, `mimo-flash`, `mimo-pro`, plus catalog preview ids. Call path: `{base}/route/chat/completions`.

**Key-auth catalog:** `GET {api}/user/available_models` (Bearer).  
**Account catalog:** `GET {accountBase}/model/list` (cookie).

**Headers the backend expects:**

- Cloud key path: `X-Mimo-Source: mimocode-cli` (Desktop UI uses `mimocode-desktop`; free proxy uses `mimocode-cli-free`).
- Account UA: `miNative PC/Normal Windows_NT/… APP/miaccount_desktop APPV/0.1.0` (already in `mimoAccount.js`).

**Auth storage evolution:** Desktop still *can* write `auth.json` (`writeAuth({sk,url,uid,user})`), but this install has no `auth.json`. Session login is cookie-based. Auto-import that only looks for `sk-` in `auth.json` is therefore stale.

## 2. Gap matrix (harness vs 9Router today)

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | **Cookie path wrong on macOS** — code uses `Xiaomi MiMo/Partitions/xiaomi-account/Network/Cookies`; live path is `Xiaomi MiMo AI/Partitions/xiaomi-account/Cookies` | **P0** | `mimoAccount.js:42` vs live FS |
| G2 | **Account host hardcoded CN** — overseas host is `mimo-server-sgp` (this host’s region); CN hardcode fails SGP/RU/IN/EU users for Preview + weekly quota | **P0** | `mimoAccount.js:24`, `apm-region.json` = SGP |
| G3 | **Auto-import requires `auth.json` + `sk-`** — fails on cookie-only Desktop login; should fall back to passToken-only account connect | **P1** | no `auth.json` on host; cookies have `passToken` |
| G4 | **Subscription aliases missing** — Desktop exposes `mimo-auto` / `mimo-flash` / `mimo-pro` on the cookie route; 9Router only pins the two preview ids | **P1** | asar model helpers + catalog |
| G5 | **No region capture** — connection should store `mimoRegion` from `apm-region.json` / country guess so multi-account rotation stays on the right host | **P1** | Desktop region machinery |
| G6 | **`X-Mimo-Source` not set on cloud executor path** — usage sets it; chat/TTS do not | **P2** | asar + `usage/xiaomi-mimo.js` only |
| G7 | **ASR / voiceclone / voicedesign missing on `xiaomi-mimo`** — catalog has them; `xiaomi-tokenplan` already lists voiceclone/design | **P2** | `model-catalog.json` |
| G8 | Windows/Linux cookie paths likely also use obsolete `Xiaomi MiMo` + `Network/` | **P2** | same function |

Out of scope (do not implement unless owner asks):

- Spawning Desktop / mimocode as an executor.
- Committing secrets, cookies, `desktop-api.json` tokens.
- Full image-gen (`gpt-image-2`) provider surface.
- Local capability-API (`llm-server`) bridge.

## 3. Design decisions

### 3.1 Multi-path cookie discovery (G1, G8)

Replace single hard-coded path with an ordered candidate list per platform, first hit that contains a readable `passToken` wins:

**darwin**

1. `~/Library/Application Support/Xiaomi MiMo AI/Partitions/xiaomi-account/Cookies` ← **current**
2. `~/Library/Application Support/Xiaomi MiMo/Partitions/xiaomi-account/Cookies` (legacy name)
3. `…/Network/Cookies` under both (older Chromium layouts)

**win32**

1. `%APPDATA%/Xiaomi MiMo AI/Partitions/xiaomi-account/Cookies`
2. `%APPDATA%/Xiaomi MiMo/Partitions/xiaomi-account/Cookies`
3. `Network/Cookies` variants

**linux**

1. `~/.config/Xiaomi MiMo AI/…`
2. `~/.config/Xiaomi MiMo/…`
3. XDG data variants if needed

Keep the existing copy-then-sqlite + exclusive-lock bail. Still never log secret values.

### 3.2 Region-aware account base (G2, G5)

Mirror Desktop’s host map and resolution order, **but prefer the connection’s stored region** over a global cache so multi-account stays correct:

```js
const ACCOUNT_HOSTS = {
  sgp: "mimo-server-sgp.xiaomimimo.com",
  ru:  "mimo-server-ru.xiaomimimo.com",
  in:  "mimo-server-in.xiaomimimo.com",
  // CN / EU: resolve via country mapping + fallback; keep explicit override support
};
```

Priority when building `{base}/api/...`:

1. `providerSpecificData.mimoRegion` (set at import/connect)
2. Live Desktop `apm-region.json` (read-only)
3. Country heuristic (same EU/SGP country sets as asar, if cheap)
4. Fallback `sgp` for overseas-style installs; keep `cn` as override for domestic users who set it

Store `mimoRegion` on the connection at auto-import / OAuth success. Preview `buildUrl` and usage both call the same resolver — one function, no second hardcode.

### 3.3 Connect flow that works without `auth.json` (G3)

Priority in auto-import:

1. **auth.json + sk-** (existing; still fastest when present)
2. **passToken-only account session** — success even without `sk-`. Preview models + weekly quota work; cloud `api.xiaomimimo.com` models require a key or platform OAuth.
3. Offer platform OAuth fallback in the modal when neither is found (already implemented).

`XiaomiMimoAuthModal` copy: stop claiming only `auth.json`; describe “Desktop account session and/or API key”.

### 3.4 Subscription model tiles (G4)

On `xiaomi-mimo` registry models, add account-route models (cookie auth, OpenAI format only):

| id | upstream | notes |
|---|---|---|
| `mimo-auto` | `mimo-auto` | Desktop default alias |
| `mimo-flash` | `mimo-flash` | |
| `mimo-pro` | `mimo-pro` | |

Mark them the same way as preview (`supportedFormats: ["openai"]`, cookie via `PREVIEW_MODELS` → rename to `ACCOUNT_ROUTE_MODELS`). Do **not** invent Opus/Sonnet tiers.

### 3.5 Header + catalog polish (G6, G7)

- Default `X-Mimo-Source: mimocode-cli` on `xiaomi-mimo` cloud transport headers (registry `transports[].headers`).
- Add `mimo-v2.5-asr` (`kind: "stt"` if the STT pipeline supports it; otherwise document deferred), `mimo-v2.5-tts-voiceclone`, `mimo-v2.5-tts-voicedesign` to match tokenplan + Desktop catalog.

### 3.6 Fail-open rules

- Cookie read failure → preview/quota degrade with a clear message; cloud `sk-` path still works.
- Region probe failure → fallback host; never throw out of discovery.
- Keep 401 retry once + cache invalidation already in the executor.

## 4. Implementation slices

### PR-A — Desktop session correctness (P0)

**Files**

- `open-sse/shared/mimoAccount.js` — multi-path cookie discovery, region resolver, host map, read `apm-region.json`
- `open-sse/executors/xiaomi-mimo.js` — use resolved account base (stop hardcoding `MIMO_API_BASE` for URL)
- `open-sse/services/usage/xiaomi-mimo.js` — same resolver
- `src/app/api/oauth/xiaomi-mimo/auto-import/route.js` — passToken-only success; persist `mimoRegion`
- `src/app/api/oauth/xiaomi-mimo/api-key/route.js` — persist `mimoRegion` when present
- `src/shared/components/XiaomiMimoAuthModal.js` — copy + passToken-only UX
- `tests/unit/xiaomi-mimo-account-paths.test.js` (new) — path candidates, region resolution, no live `security`/network
- Update `tests/unit/xiaomi-mimo-executor.test.js` URL expectations (region-parameterized)

**Done when**

- On this host (cookie DB live, region SGP): auto-import reports passToken found; preview URL is `https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions`.
- Unit tests green without Desktop running (fixtures for path list + region).
- No secret values in logs or test snapshots.

### PR-B — Subscription aliases + catalog (P1)

**Files**

- `open-sse/providers/registry/xiaomi-mimo.js` — `mimo-auto` / `flash` / `pro`; TTS extras; `X-Mimo-Source` on cloud transports
- `open-sse/executors/xiaomi-mimo.js` — rename `PREVIEW_MODELS` → `ACCOUNT_ROUTE_MODELS`
- `open-sse/config/providerModels.js` if alias matrix needs rows
- `tests/unit/xiaomi-mimo-executor.test.js`, baseline snapshot hooks if provider list changes

**Done when**

- Dashboard shows the three subscription tiles; they route cookie-auth like preview.
- Cloud models still use `sk-` + `X-Mimo-Source`.
- Baselines (`providers` / `alias`) updated via existing snapshot scripts, not hand-edited inventively.

### PR-C — Optional / later

- ASR handler wiring for `mimo-v2.5-asr` (mirror TTS provider pattern).
- Live `GET {account}/model/list` catalog fetch (like Desktop) behind `passthroughModels`.
- CLI Tools card to point local `mimocode` custom provider at 9Router (analog of Muse PR-3).

## 5. Verification plan

```bash
cd /Users/admin/.grok/worktrees/opensource-9router/9router-mimo-harness
# unit (path/region/executor; no Keychain, no live SSO in CI)
cd tests && ./node_modules/.bin/vitest run --config ./vitest.config.js \
  unit/xiaomi-mimo-executor.test.js \
  unit/xiaomi-mimo-oauth-session.test.js \
  unit/xiaomi-mimo-oauth-proxy.test.js \
  unit/xiaomi-mimo-tts.test.js \
  unit/xiaomi-mimo-account-paths.test.js
```

Manual (owner machine, isolated `DATA_DIR`):

1. Auto-import → expect `found: true` with passToken + region `SGP` (even without `auth.json`).
2. `mimo/mimo-x-flash-preview` chat `PONG` via cookie route (max_tokens ≥ 2048).
3. Usage page shows weekly quota (not “session unavailable”).
4. If an `sk-` key exists, `mimo/mimo-v2.5-pro` still works on cloud API.

Do **not** treat a full `vitest run` as merge gate (repo baseline still has known fails).

## 6. Constraints (from owner / repo)

1. Do not push unless asked.
2. Do not commit cookies, tokens, `desktop-api.json`, or Keychain dumps.
3. Do not restart production `:20128` unless asked.
4. Prefer `feat/xiaomi-mimo-harness-alignment` for this work; merge to `dev` only after review.
5. Keep `open-sse/AGENTS.md` conventions: config-driven, one executor, no second hardcode of hosts.

## 7. Open questions for the owner

1. **CN users:** is `mimo-server-cn.xiaomimimo.com` still the domestic account host, or has CN moved? Keep CN as explicit override until confirmed live.
2. **Subscription tiles naming:** keep Desktop’s `mimo-auto` / `mimo-flash` / `mimo-pro`, or surface nicer names only (`MiMo Auto` …) with the same ids?
3. **Scope of this PR pair:** ship A only (correctness) first, or A+B together?

## 8. Suggested first implementation step

Start **PR-A** in this worktree: fix `desktopCookiePath()` candidates + region resolver, then re-point executor/usage/auto-import, then unit tests. That alone unblocks Preview + quota on SGP installs like this one.
