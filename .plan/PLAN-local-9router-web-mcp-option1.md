# Plan v3: Local 9Router Web MCP — Option 1 (YAGNI)

Reviews:
- Opus v1: GREENLIGHT → v2 BLOCK (Cowork CLI-token regression; guard ordering; deploy wording)
- Astra v1/v2: BLOCK (admin export, pre-translate, sessions, then MCP-token scope/secret strength/JSONC)

This revision merges **both** reviewers’ required fixes.

## Goal

One local MCP (`9router-web`) so Claude Code search/fetch always uses 9Router combos `search-combo` / `fetch-combo`. Strip built-in `WebSearch`/`WebFetch` when MCP tools are present. No dual search story. No public Exa primary.

## Non-goals

Stdio package, Streamable HTTP, combo settings UI, model/provider tool args, dynamic native-vs-MCP flipping, Cowork UI work, tunnel MCP, skills rewrite, generalized ACL framework, Exa primary toggle.

## Targets

| name | kind | members (order) |
|---|---|---|
| `search-combo` | webSearch | parallel, minimax, tavily, exa, gemini |
| `fetch-combo` | webFetch | jina-reader, ollama, tavily, parallel, exa |

UI copy: search-combo is Parallel-first among members; fetch-combo is **jina-reader first**.

Wire (existing): `POST /v1/search` / `POST /v1/web/fetch` with `model` = combo name.

## Architecture

```
Claude Code ~/.claude.json
  mcpServers["9router-web"] = {
    type: "sse",
    url: "http://127.0.0.1:<port>/api/mcp/9router-web/sse",
    headers: { "x-9r-mcp-token": "<random persisted secret>" }
  }
        │
        ▼
dashboardGuard early branch: /api/mcp/*
        │
        ├─ /api/mcp/9router-web/*  → isLocalRequest AND x-9r-mcp-token
        └─ other /api/mcp/*        → isLocalRequest AND (x-9r-cli-token OR dashboard JWT)
        ▼
gatewayWebMcp (in-process, no spawn)
        ▼
handleSearch / handleFetch → fixed combo names
```

Chat path:

```
client tools include mcp__9router-web__web_search | web_fetch
chatCore: dedupeTools on CLIENT tools BEFORE translateRequest
  paired: web_search→strip WebSearch; web_fetch→strip WebFetch
keep post-translate dedupe for native passthrough (no translateRequest)
→ opus-class member
```

## Auth (merged Opus + Astra)

### Token

- **Random persisted secret**, not `getConsistentMachineId("9r-mcp-auth")`.
  - Reason (Astra): `machineId.js` only mixes a random secret for salt `9r-cli-auth`; another salt is deterministic machine-id hash — weaker.
  - Mechanism: on first Apply (or first GET if missing), create `settings.webMcpToken = crypto.randomBytes(16).toString("hex")` (or equivalent settings/kv field). Guard compares constant-time to that value. Rotate = rewrite settings + re-Apply Claude Code.
- Header: `x-9r-mcp-token`.
- Claude Code `~/.claude.json` receives **only** this MCP token — never admin `x-9r-cli-token`.

### Guard (early short-circuit — Opus)

`proxy()` today matches `/api/mcp` in **both** `LOCAL_ONLY_PATHS` and `ALWAYS_PROTECTED`. MCP-token-only requests would pass a naive local check then **401** on ALWAYS_PROTECTED (CLI/JWT only). Dead on first probe unless ordered correctly.

**Required:** dedicated branch at the **top** of `proxy()` for `pathname.startsWith("/api/mcp/")`:

```
if !isLocalRequest(request) → 403
if pathname starts with /api/mcp/9router-web/:
  accept iff x-9r-mcp-token === settings.webMcpToken
else:
  accept iff hasValidCliToken(request) OR isAuthenticated(request)   // Cowork/browsermcp unchanged
success → NextResponse.next()
failure → 403
```

- Evaluates **before** `LOCAL_ONLY_PATHS` and `ALWAYS_PROTECTED`.
- **Does not** reject admin CLI token on non-9router-web MCP routes (Cowork `cowork-settings` injects `x-9r-cli-token` into `/api/mcp/` entries — `cowork-settings/route.js:23-28`).
- **Does** require locality for **all** `/api/mcp/*` (closes token-before-locality hole even for Cowork).
- Remote + stolen admin token → 403 (not loopback).
- Loopback + admin token on `/api/mcp/browsermcp/*` → allowed (Cowork keeps working).
- Loopback + admin token on `/api/mcp/9router-web/*` → **403** (wrong credential; search MCP is scoped).
- Loopback + MCP token on `/api/mcp/9router-web/*` → allowed.

Astra’s “restrict web MCP credential to 9router-web; preserve process-backed plugins” is satisfied by the path split above.

### Deploy wording (Opus)

Production **must** use `custom-server.js` (stamps `x-9r-real-ip` / peer token). Without the wrapper, `isLoopbackPeer` is false in prod → MCP auth **fails closed** (feature dead), not “security weakened.” Requirement stands.

## MCP tools

**Files:** `src/lib/mcp/gatewayWebMcp.js` + `src/lib/mcp/internalPlugins.js` (registry beside handler — **not** `coworkPlugins.js`).

| tool | whitelist args | fixed model |
|---|---|---|
| `web_search` | `query` (req), `max_results`, `search_type` | `search-combo` |
| `web_fetch` | `url` (req), `format`, `max_characters` | `fetch-combo` |

- **No** `model`/`provider` args (`search.js:34` prefers `provider` — bypass risk).
- Protocol: `initialize`, `notifications/initialized` (no reply), `tools/list`, `tools/call`, `ping`.
- No `smartFilterText` on tool results.
- Synthetic `Request` with **absolute** URL.
- `requireApiKey`: pick active key from DB; none → MCP `isError`.
- Async handler failures → JSON-RPC error / `isError` on the **originating** session only.
- `alwaysLoad` in Claude Code config only if live probe shows deferred tools missing.

## Bridge internal lifecycle

`stdioSseBridge.js` + `/api/mcp/[plugin]/sse|message`:

- `kind: "internal"` never spawns; all `entry.proc` paths branched (`getOrSpawn`, `sendToChild`, `unregisterSession`, `killAllBridges`, `isRunning`).
- Message POST reads `sessionId`; unknown → 400/404.
- Reply **only** to that session’s send function (current broadcast at `:130` is wrong for internal).
- Return **202 before** awaiting search/fetch.
- Notifications: no response frame.

## toolDeduper + pre-translate (closed per Astra #2)

When `clientTool === "claude"`:

1. `dedupeTools` on **source/client** tools **before** `translateRequest`.
2. **Keep** post-translate pass — native passthrough (`chatCore.js` ~193) skips translate; that branch is load-bearing.
3. Paired rules:

```js
{ triggers: ["mcp__9router-web__web_search"], strip: ["WebSearch"] },
{ triggers: ["mcp__9router-web__web_fetch"],  strip: ["WebFetch", "mcp__workspace__web_fetch"] },
```

4. Keep Exa/Tavily rules. Disclose: enabling those MCPs too means more than two search tools can appear — guarantee is MCP vs built-ins only.

## Claude Code settings injection

`claude-settings/route.js` + `ClaudeToolCard.js`:

- Toggle **9Router Web MCP** primary.
- GET exposes `webMcpEnabled`.
- Apply writes server URL + `x-9r-mcp-token` from `settings.webMcpToken` (create if missing).
- `writeClaudeJsonMcp`:
  - **String-aware JSONC parse** (not the trailing-comma regex — it corrupts strings containing `,}` / `,]`).
  - On parse error: **do not write**; return 4xx/5xx.
  - Preserve unrelated `mcpServers` keys.
  - Parameterize managed keys (`9router-web`; optional legacy `exa` delete only when user disables that legacy flag).
  - **`chmod 0600` after write** (explicit chmod required; `writeFile({mode})` alone does not tighten an existing file).
- Disable deletes only `9router-web`.
- Optional warn if combos missing; not hard fail.
- Tooltip: restart Claude Code; fetch-combo is jina-reader first.

## Tests

- Guard: loopback+MCP token on 9router-web → allow; remote+any token → 403; loopback+CLI token on browsermcp → allow; loopback+CLI token on 9router-web → deny.
- gatewayWebMcp: fixed combo body; whitelist; missing key → isError; errors target session.
- Bridge: no spawn; sessionId required; 202 prompt; lifecycle safe.
- Settings: string-aware JSONC; fail closed on bad JSON; chmod 0600; disable surgical.
- Dedupe: pre-translate + passthrough post-translate; paired strips.
- Live: `tools/call web_search` → search-combo; usage shows provider.

## Branch / deploy

- Worktree `9router-web-mcp`, branch `feat/local-web-mcp` off **local `dev`**
- PR target **`dev`** (Parallel already on dev; master PR is the existing train)
- muse worktree stays on `dev`, untouched
- No naive registry regen
- Build `NEXT_DIST_DIR=.next-web-mcp`; run via **custom-server**; `PORT=20128 HOSTNAME=0.0.0.0`
- No secrets in git

## Success criteria

1. Claude Code → 9Router + `opus-class[1m]`
2. MCP tools call search-combo / fetch-combo only (no provider bypass)
3. Built-ins stripped when MCP tools present (pre-translate + passthrough)
4. Works on non-Claude hop when Anthropic quota is dead
5. `/api/mcp/9router-web/*` requires loopback + MCP token; Cowork `/api/mcp/*` still works with CLI token + loopback
6. muse `dev` clean

## Implementation order (dual GREENLIGHT required)

1. Worktree/branch off `dev`
2. `settings.webMcpToken` + early `/api/mcp/*` guard branch
3. `gatewayWebMcp.js` + `internalPlugins.js`
4. Bridge internal + session routing
5. Pre-translate + paired dedupe
6. claude-settings + ClaudeToolCard (JSONC-safe, chmod 0600)
7. Unit tests
8. custom-server build/swap
9. Live probe

## Re-review focus

1. Path-split auth + early guard ordering — closes Opus Cowork regression **and** Astra scope/secret issues?
2. Random persisted `settings.webMcpToken` — acceptable secret model?
3. String-aware JSONC + explicit chmod + fail-closed write — closes Astra #4?
4. Anything still over-built or blocking implementation?
