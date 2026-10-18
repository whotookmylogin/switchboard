# HTTP API

Switchboard listens on `SB_LISTEN` (default `127.0.0.1:3930`). Everything is plain HTTP plus JSON;
there are no MCP sessions to keep alive, so a restart never strands a client.

## Authentication

Send the agent key as a bearer token:

```http
Authorization: Bearer sb_EXAMPLE
```

The `/api/*` endpoints also accept `X-API-Key: sb_EXAMPLE`. OAuth access tokens (`sbo_...`) work
everywhere a static key does; they authenticate as the agent the sign-in was approved for.

A request with no token gets `401 {"error": "invalid or missing token"}` (or `... API key` on `/api`).
On the MCP endpoints the 401 carries a `WWW-Authenticate` header pointing at the OAuth metadata, so
clients that support OAuth discovery can start a sign-in on their own. A token for a disabled agent is
treated as a bad token.

## Endpoints

| Method + path | Auth | What it does |
|---|---|---|
| `POST /mcp/<connector>` | key | One connector as a stateless Streamable HTTP MCP server. |
| `POST /mcp` | key | Every connector the key may use, as one MCP server. Tools are named `<connector>__<tool>`. |
| `GET /healthz` | loopback or `SB_HEALTHZ_TOKEN` | Connector health. Hidden (404) for anything else, including all tunnel traffic. |
| `GET /api/tools` | key | JSON list of tools this key may call. |
| `GET /api/openapi.json` | key | OpenAPI 3.1 document of the same tools, one POST path each. |
| `POST /api/call/<connector>/<tool>` | key | Call one tool; the JSON body is the tool arguments. |
| `GET /.well-known/oauth-protected-resource[/<path>]` | none | RFC 9728 resource metadata. |
| `GET /.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | none | OAuth authorization-server metadata. |
| `POST /oauth/register` | none | RFC 7591 dynamic client registration. |
| `GET /oauth/authorize` | browser | Start a sign-in; shows a waiting page and notifies the operator. |
| `GET /oauth/authorize/poll` | browser | Status of a waiting sign-in (`{"status": ...}`). |
| `GET /oauth/authorize/finish` | browser | Redirect back to the app with a code, once. |
| `GET`/`POST /oauth/approve` | operator | Review page (GET) and the decision (POST). |
| `POST /oauth/token` | client | Exchange a code, or rotate a refresh token. |

Anything else gets `404 {"error": "not found"}`.

### `POST /mcp/<connector>`

Serves exactly one connector as an MCP server (Streamable HTTP, JSON responses). The connector must
be running (stdio children auto-start on the first request, with backoff after failures).

- `404 {"error": "unknown connector <name>"}` for an unknown name.
- `403 {"error": "agent <agent> has no access to <connector>"}` when the key has no grants on it.
- `405` for anything but POST.
- `400` JSON-RPC parse error for an empty or non-JSON body.
- `503` when the connector process cannot be started.

`tools/list` is filtered to the tools the key may actually call (deny list applied). Every
`tools/call` checks grants and the deny list again, and is written to the audit log.

### `POST /mcp`

The combined endpoint: one MCP server exposing every tool the key is granted across every connector,
named `<connector>__<tool>` (separator is two underscores; connector names never contain it). For
clients that accept a single MCP URL. `tools/call` on an unknown name returns an error result, not an
HTTP error.

### `GET /healthz`

No agent key and no secrets. Shape:

```json
{
  "ok": true,
  "connectors": {
    "tasks": { "up": true, "pid": null, "restarts": 0, "inflight": 1, "since": "2026-10-18T12:00:00.000Z" },
    "github": { "up": true, "pid": 12345, "restarts": 2, "inflight": 0, "since": "..." }
  }
}
```

`inflight` counts tool calls currently executing; check it before restarting.

`/healthz` answers only when the request's socket peer is a loopback address, or when it carries
`Authorization: Bearer <SB_HEALTHZ_TOKEN>` and `SB_HEALTHZ_TOKEN` is set on the service. When the
request carries a `cf-connecting-ip` header (which means it came through the Cloudflare tunnel) it
is a `404 {"error": "not found"}` regardless. (`src/index.js` checks the header, so this also holds
for requests that spoof it.)

### `GET /api/tools`

```json
{
  "agent": "claude-code",
  "tools": [
    { "connector": "tasks", "name": "claim", "description": "...", "input_schema": { "type": "object" } }
  ]
}
```

### `GET /api/openapi.json`

An OpenAPI 3.1 document with one `POST /api/call/<connector>/<tool>` path per granted tool, bearer
auth, and a `ToolResult` schema. Paste it into a GPT action or another OpenAPI client. The `servers`
entry is built from the `Host` header and `X-Forwarded-Proto` (or https when `cf-connecting-ip` is
present).

### `POST /api/call/<connector>/<tool>`

Body: a JSON object of the tool's arguments (an empty body counts as `{}`). Response, always JSON:

```json
{ "ok": true, "text": "all text content joined", "content": [{ "type": "text", "text": "..." }], "structured": { } }
```

`ok` is `false` when the tool returned an error result (like a failed `claim`); the HTTP status is
still 200 because the call itself was delivered. `structured` is present only when the tool returns
`structuredContent` (the `tasks` and `agents` tools do).

| Status | When |
|---|---|
| `200` | Call ran; inspect `ok` for tool-level success. |
| `400` | Body was not a JSON object (`{"error": "body must be a JSON object of tool arguments"}`). |
| `401` | Missing or bad key. |
| `403` | Key is valid but not granted this tool (`{"error": "this key is not granted <connector>/<tool>"}`). The denial is also written to the audit log. |
| `404` | Unknown path or connector. |
| `405` | Wrong method on the call path. |
| `502` | The connector threw or is unreachable (`{"ok": false, "error": "..."}`). |

### Cancellation

- MCP: a `notifications/cancelled` message aborts the backend call, but only when its `requestId`
  maps to exactly one in-flight call. An ambiguous id is left running rather than risk aborting the
  wrong call.
- A client that closes the HTTP connection mid-call aborts the backend call too (the response
  `close` event fires the abort).
- Every backend call has a hard cap of 30 minutes, and the connect handshake has its own
  `connect_timeout` (60 s default, per connector).

## OAuth sign-in flow

For apps that cannot hold a static key (ChatGPT connectors, Codex login). Only agents marked
`oauth: true` can be signed into; an OAuth token acts as that agent, with exactly its grants.

1. The client hits `/mcp` without a token and gets `401` + `WWW-Authenticate` pointing at
   `/.well-known/oauth-protected-resource/mcp`, which names the authorization server.
2. The client registers via `POST /oauth/register` (redirect URIs must be https, or http on loopback;
   loopback URIs may use any port at authorize time). An https `client_id` is also accepted as a
   Client ID Metadata Document URL, fetched once and cached for an hour. Registrations are capped at
   30 per hour.
3. `GET /oauth/authorize` (PKCE S256 required) records the request, notifies the operator through the
   configured notifier (`SB_NOTIFY`), and shows the app a page that polls
   `/oauth/authorize/poll` and then redirects through `/oauth/authorize/finish`.
4. The operator opens the one-time `/oauth/approve?t=...` link, sees the app name, the agent it will
   act as, and that agent's grants, then POSTs approve or deny. The waiting browser is redirected
   back to the app with a `code` (or `error=access_denied`).
5. `POST /oauth/token` with the code + PKCE verifier returns a `sbo_` access token (1 h) and a `sbr_`
   refresh token (90 d, rotates on every use). Replaying a rotated-out refresh token revokes every
   token for that client.

Limits: sign-in requests expire after 15 minutes, codes after 5 (single use), and at most 10 sign-in
attempts per hour are accepted. Only hashes of codes, tokens and secrets are stored. Disabling an
agent or running `sb agent oauth <name> off` kills its OAuth tokens on the spot. The operator can
also review with `sb oauth pending` and revoke with `sb oauth revoke <agent|client_id>`.

## Built-in connectors

Five connectors are part of the Switchboard process itself. They always exist, take the caller's
identity from the key (never from arguments), and are granted like any other connector in
`agents.yaml`.

### `tasks` connector

One shared task list (SQLite by default; `SB_TASKS_BACKEND=hermes` bridges to Hermes' kanban). The
caller is recorded as `switchboard/<agent>` on claims.

| Tool | Arguments | What it does |
|---|---|---|
| `boards` | none | List task boards. |
| `active` | none | Everything currently claimed, plus counts of tasks waiting in review/blocked. Check before starting work. |
| `list` | `board?`, `status?` (triage, todo, ready, running, review, blocked, scheduled, done, archived), `assignee?`, `mine?`, `limit?` | List tasks. Defaults to open tasks on all boards. |
| `find` | `query` (required), `include_done?` | Search open tasks across boards. Use before creating work. |
| `show` | `id` (required), `board?` | One task with comments and recent events. |
| `create` | `board`, `title` (required), `body?`, `assignee?`, `priority?`, `parents?`, `branch?`, `idempotency_key?` | Create a task. `assignee` must be a configured lane; empty sends it to triage. |
| `start` | `board`, `title` (required), `body?`, `branch?`, `idempotency_key?`, `ttl_minutes?` | Create a task assigned to yourself and claim it in one step. |
| `claim` | `id` (required), `board?`, `ttl_minutes?` | Atomically claim a ready task. Fails when someone else holds it, saying who and until when. |
| `heartbeat` | `id` (required), `board?`, `ttl_minutes?`, `note?` | Extend your claim; `note` becomes a `[progress]` comment. |
| `comment` | `id`, `body` (required), `board?` | Add a comment. |
| `complete` | `id`, `result` (required), `board?`, `summary?`, `metadata?` | Finish a task you hold (or one in review). `result` must say what you did and where. |
| `release` | `id`, `reason` (required), `board?` | Give up your claim; the task goes back to ready. |
| `block` | `id`, `reason` (required), `board?`, `kind?` (needs_input, dependency, capability, transient) | Park a task you hold as blocked for a human. |
| `edit` | `id` (required), `board?`, `title?`, `body?`, `append_body?`, `priority?`, `assignee?` | Edit an open task. Assigning a triage task routes it to a lane. |
| `park` | `id`, `reason` (required), `board?`, `until?` | Move a task to `scheduled` (icebox); nobody picks it up until `unpark`. |
| `unpark` | `id` (required), `board?`, `reason?` | Bring a parked or blocked task back (ready, or todo while parents are open). |

Claim TTL: `ttl_minutes` defaults to 60, clamped to 5..480 minutes. An expired claim drops the task
back to `ready`.

### `memory` connector

Shared memory: `entity.field` facts with sensitivity levels, plus tagged notes. Your
`memory_clearance` caps what you can read and write. Restricted/secret fact reads require a `reason`
of at least 8 characters and are logged in the `access` table. Anything that looks like a credential
is rejected on write. Agents cannot set `verified`; only the operator can (`sb memory verify`).

| Tool | Arguments | What it does |
|---|---|---|
| `recall` | `q?`, `topic?`, `kind?` (rule, tip, gotcha, howto, preference), `entity?`, `limit?` (default 8, max 25) | Search facts and notes at your clearance. No `q`: `entity` lists an entity's facts, `topic` lists tagged notes, otherwise a short orientation. |
| `get_fact` | `key` or `entity`+`field`, `reason?` | Read one fact exactly. Restricted/secret needs a reason (logged). |
| `profile` | `entity` (required), `reason?` | All facts for one entity. Restricted/secret values are included only with a reason; otherwise shown as withheld. |
| `remember` | `kind`, `title`, `body` (required), `topics?`, `applies_to?`, `sensitivity?`, `force?` | Add a note. Title max 160 chars, body max 4000. Near-duplicate titles are flagged; pass `force: true` to add anyway. |
| `update` | `id`, `why` (required), `title?`, `body?`, `topics?` | Revise a note. Any edit clears `verified`. |
| `flag` | `id_or_key`, `problem` (required) | Mark a note or fact as possibly wrong for the operator. |
| `set_fact` | `key`, `value`, `source`, `why` (required), `label?`, `sensitivity?`, `note?` | Write a fact. `memory_admin` agents only. `key` must look like `entity.field`. |
| `history` | `id_or_key` (required), `limit?` | Version trail for a note or fact. Values above your clearance are redacted. |

### `lookup` connector

Fuzzy search over the small reference directory rebuilt by `tools/directory_refresh.mjs` (SQLite
FTS5). Returns one-line answers with the ids other tools want.

| Tool | Arguments | What it does |
|---|---|---|
| `lookup` | `q?`, `kind?` (person, channel, customer, account, vendor, stock, product, team, guide), `limit?` (default 5, max 20) | Find people, channels, customers, vendors, stock, products, teams or guide entries by name, id, email or number. |

### `notes` connector

Search over a folder of indexed markdown notes (`data/notes/<host>/*.md`, rebuilt by
`tools/notes_refresh.mjs`). Credential-looking lines are withheld at index time, not at read time.

| Tool | Arguments | What it does |
|---|---|---|
| `search_notes` | `q` (required), `limit?` (default 5, max 10), `type?` (user, feedback, project, reference) | Up to 5 short hits with name and excerpt. |
| `read_note` | `name` (required) | Full redacted body of one note by exact name (truncated at 6000 chars). |

### `agents` connector (ARP)

Agent Request Protocol: discovery, typed requests, and expiring grants. First contact between two
agents waits for one-time operator pair approval. `tool_access` mints a grant only after the target
agent agrees AND the operator approves. Grants are one connector + one tool, optionally scoped to
exact argument values, default 7 days, max 30, never auto-renewed. Raw secrets are rejected from
every body.

| Tool | Arguments | What it does |
|---|---|---|
| `agents.list` | none | Directory of registered agents: display name, operator, capabilities, contact policy, last seen. |
| `agents.request` | `to`, `type` (info, tool_access, task), `subject` (required), `body?`, `context_refs?`, `needed_by?`, `expires_at?`, `idempotency_key?` | Send a request. `idempotency_key` makes retries return the original. |
| `agents.inbox` | `status?`, `limit?` (default 50, max 200), `cursor?` | Requests addressed to you. Held first-contact requests are hidden until the pair is approved. |
| `agents.respond` | `request_id`, `status` (fulfilled, declined, needs_info) (required), `payload?`, `reason?` | Answer a request to you. `declined` requires `reason`. Fulfilling `tool_access` requires `payload.connector` + `payload.tool` (plus optional `scope`, `expires_days`) and still waits for operator approval. |
| `agents.request_status` | `request_id` (required) | Status and responses of a request you sent or received. |
| `agents.revoke_grant` | `grant_id` (required) | Revoke a grant immediately. Callable by the operator or either agent involved in the original request. |
| `agents.audit_log` | `limit?` | ARP audit trail. You see only entries involving you; the operator sees everything. |
| `agents.update_profile` | `display_name?`, `operator?`, `capabilities?`, `contact_policy?` (info-auto, notify-operator, approval-required) | Register or refresh your directory entry. |

Operator side: `sb arp list` (pending approvals + open requests), `sb arp approve|deny <id>`,
`sb arp grants`, `sb arp revoke <grant_id>`, `sb arp audit`. New approval cards are also pushed to
the operator through the configured notifier.
