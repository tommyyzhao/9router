# Plan: Align Grok Bot.app with 9Router (MiMo-harness spirit)

**Date:** 2026-09-21 (PT)
**Canonical MiMo precedent:** docs/plans/2026-09-16-xiaomi-mimo-harness-alignment.md
**Harness:** `/Applications/Grok Bot.app` (Anysphere Sand white-label)
**Branch:** `feat/grok-bot-desktop-discover` (PR-A)

LT confirmed: Grok Bot.app Desktop, **not** Grok Build CLI (`grok-cli`).

## 0. Product finding

Grok Bot.app is Anysphere Sand (`com.anysphere.sand`), Cursor-family auth to
`api2.cursor.sh`, client-type `sand`. Tokens live in:

| Fact | Value |
|---|---|
| App data | `~/Library/Application Support/Grok Bot/` |
| Secrets file | `sand-secrets.json` (Electron safeStorage **v10**, `djEw…` blobs) |
| Keychain service | `Grok Bot Safe Storage` |
| Status file | `desktop-status.json` (`signedIn`, `appVersion`, …) |
| Cookies | empty for auth — **not** a MiMo-style cookie scrape |

`sand-secrets.json` top-level keys (schema only; values stay sealed):

- `cursor-accounts` — JSON string `{ active, accounts }` whose per-account
  fields (`cursor-access-token`, `cursor-refresh-token`,
  `cursor-account-profile`) are sealed `djEw…` blobs
- `cursor-machine-id` — sealed
- `local-exec-file-key` — sealed

## 1. Goal

Discover (PR-A) and later use (PR-B) a signed-in Grok Bot Desktop session.
MiMo shape: dedicated desktop import, one provider card.

## 2. Non-goals

- Spawn the app / drive a signed-in browser session.
- Commit secrets, Keychain material, or ciphertext.
- Restart `:20128`.
- Confuse with `grok-cli` / `xai` / `grok-web`.
- Silently fold into Cursor IDE `state.vscdb` import without a distinct source.

## 3. Architecture

| Piece | Choice |
|---|---|
| Registry id | `grok-bot` (aliases `sand`, `gbot`) |
| Auto-import | Dedicated `GET /api/oauth/grok-bot/auto-import` |
| Reuse Cursor Connect | Only after decrypt + probe (**PR-B**) |
| PSD (PR-B) | `clientType: sand`, `authMethod: grok-bot-desktop-import` |

## 4. Implementation slices

### PR-A — Discover only (this change)

**Files**

1. This plan file
2. `open-sse/shared/grokBotAccount.js` — path candidates + `sand-secrets` schema
   parse **only** (no decrypt, no Keychain)
3. `GET /api/oauth/grok-bot/auto-import` — returns
   `{ found, path, signedIn, accountScopePresent, sealed: true,
     encryption: "electron-safeStorage-v10",
     keychainService: "Grok Bot Safe Storage" }` —
   **no** ciphertext / plaintext tokens
4. Registry stub `grok-bot` (`hidden: true`) — display + notice, **no**
   executor wiring
5. `tests/unit/grok-bot-account-paths.test.js` with fixtures (fake `djEw` blobs)

**Done when**

- Unit tests green without decrypting or touching Keychain.
- Live host with a signed-in Desktop reports `found: true`,
  `accountScopePresent: true`, `signedIn: true` (when status says so).
- No secret values in logs, API responses, or test snapshots.

### PR-B — Decrypt + probe + store (later)

Decrypt sealed fields via Electron safeStorage / Keychain, sand-header probe
against `api2.cursor.sh`, then store a connection with distinct
`authMethod: grok-bot-desktop-import` (reuse Cursor Connect/checksum only
after that probe).

## 5. Fail-open rules

- Missing profile / unreadable file → `found: false` with a clear error.
- Parse failure → `found: false`; never throw ciphertext into the response.
- Never log or return sealed blob contents.
