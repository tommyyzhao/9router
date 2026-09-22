# Plan: Align Grok Bot.app with 9Router (MiMo-harness spirit)

**Date:** 2026-09-21 (PT)
**Canonical MiMo precedent:** docs/plans/2026-09-16-xiaomi-mimo-harness-alignment.md
**Harness:** `/Applications/Grok Bot.app` (Anysphere Sand white-label)
**Branch:** `feat/grok-bot-desktop-discover` (PR-A discover → PR-B decrypt+probe)

**Ephemeral /v1 plan:** [`2026-09-21-grok-bot-ephemeral-harness.md`](./2026-09-21-grok-bot-ephemeral-harness.md)

LT confirmed: Grok Bot.app Desktop, **not** Grok Build CLI (`grok-cli`).

## 0. Product finding

Grok Bot.app is Anysphere Sand (`com.anysphere.sand`), Cursor-family auth to
`api2.cursor.sh`, client-type `sand`. Tokens live in:

| Fact | Value |
|---|---|
| App data | `~/Library/Application Support/Grok Bot/` |
| Secrets file | `sand-secrets.json` (Electron safeStorage **v10**, `djEw…` blobs) |
| Keychain service | `Grok Bot Safe Storage` (account `Grok Bot Key`) |
| Status file | `desktop-status.json` (`signedIn`, `appVersion`, …) |
| Cookies | empty for auth — **not** a MiMo-style cookie scrape |
| Client headers (asar) | `x-cursor-client-type: sand`, `x-cursor-client-source: sand-desktop` |

`sand-secrets.json` top-level keys (schema only; values stay sealed):

- `cursor-accounts` — JSON string `{ active, accounts }` whose per-account
  fields (`cursor-access-token`, `cursor-refresh-token`,
  `cursor-account-profile`) are sealed `djEw…` blobs
- `cursor-machine-id` — sealed
- `local-exec-file-key` — sealed

## 1. Goal

Discover (PR-A) and use (PR-B+) a signed-in Grok Bot Desktop session.
MiMo shape: dedicated desktop import, one provider card.

## 2. Non-goals

- Spawn the app / drive a signed-in browser session.
- Commit secrets, Keychain material, or ciphertext.
- Restart `:20128`.
- Confuse with `grok-cli` / `xai` / `grok-web`.
- Silently fold into Cursor IDE `state.vscdb` import without a distinct source.
- Fake a working chat path when probe shows blockers.

## 3. Architecture

| Piece | Choice |
|---|---|
| Registry id | `grok-bot` (aliases `sand`, `gbot`) |
| Auto-import GET | Discover only — no plaintext |
| Auto-import POST | Decrypt (Keychain + OSCrypt v10) → `createProviderConnection` |
| PSD | `clientType: sand`, `clientSource: sand-desktop`, `authMethod: grok-bot-desktop-import` |
| Executor | Wired stub: reuses Cursor checksum/header helpers with sand options; **refuses chat** until stream probe clears |

## 4. Implementation slices

### PR-A — Discover only (landed)

Path candidates + schema parse, GET discover, hidden stub, unit fixtures.

### PR-B — Decrypt + probe + store (this change)

1. **Live wire probe** (ephemeral; temps deleted) against `api2.cursor.sh` with
   Sand-decrypted session JWT + cursor checksum helpers.
2. Server-side decrypt helpers in `open-sse/shared/grokBotAccount.js`.
3. POST `/api/oauth/grok-bot/auto-import` stores connection after decrypt.
4. Registry un-hidden; executor registered but chat path honestly blocked.
5. Unit tests: OSCrypt fixture vectors + mocked Keychain runner (no live Keychain).

#### Probe matrix (2026-09-21 PT) — no secrets

Content-type note: unary Connect/protobuf needs **`application/proto`**
(raw empty body). `application/connect+proto` → **415**; `application/x-protobuf` → **415**.

| RPC | client-type | checksum | content-type | HTTP | Notes |
|---|---|---|---|---|---|
| `DashboardService/GetMe` | sand (+ source) | present | application/proto | **200** | body parses (profile fields) |
| `DashboardService/GetMe` | ide (same Sand token) | present | application/proto | **200** | Sand token works as ide |
| `DashboardService/GetMe` | sand | **absent** | application/proto | **200** | checksum not required for GetMe |
| `DashboardService/GetUserPrivacyMode` | sand / ide | present | application/proto | **200** | |
| `AiService/AvailableModels` | sand / ide | present | application/proto | **200** | |
| `DashboardService/GetSandAccessStatus` | sand / ide | present | application/proto | **200** | |
| `AgentService/GetUsableModels` | sand | present | connect+proto | **415** | wrong CT in first sweep |
| `AgentService/Run` | **sand** | present | connect+proto | 200 trailer | **`invalid_argument`: Sand traffic is not supported on this endpoint** |
| `AgentService/Run` | ide | present | connect+proto | 200 | empty/minimal → binary frame (not a proven chat) |
| `ChatService/StreamUnifiedChatWithTools` | sand / ide | present | connect+proto | 200 trailer | empty → `invalid_argument`; minimal body → **`resource_exhausted` / Update Required** (version gate) |
| `InferenceService/Stream` | sand / ide | present | connect+proto | 200 trailer | **`unauthenticated`** |

**Conclusions**

- Decrypt (Keychain `Grok Bot Safe Storage` / account `Grok Bot Key` + OSCrypt v10) works.
- Sand session JWT authenticates unary Dashboard/AiService for **both** `sand` and `ide` client-types.
- Checksum is **not** strictly required for GetMe.
- **Chat path blocked for reuse as-is:** AgentService rejects `clientType=sand`; ChatService version-gated; InferenceService unauthenticated for this Sand JWT.
- Do **not** fake chat; PR-C needs a supported stream path (likely Sand-native Inference with correct authMode / client version).

### PR-C — Working chat (future)

Clear `CHAT_PATH_PROBE.status` only after a successful minimal stream with a
supported Sand client version / Inference authMode. Then delegate to Cursor-style
Connect streaming with sand headers.

## 5. Fail-open rules

- Missing profile / unreadable file → `found: false` with a clear error.
- Parse / decrypt failure → error response; never throw ciphertext into the response.
- Never log or return sealed blob contents, Keychain passwords, or JWTs.
- GET discover never returns plaintext; only POST import decrypts server-side into the store.
