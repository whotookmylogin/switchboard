# Security model

Switchboard is built for a personal-scale deployment: one operator, a handful of agents, one box.
It gives each agent a key with exactly the tools you chose, records every call, and keeps agent
credentials away from the agents themselves. It is not a multi-tenant system, and the connector
processes run as the same OS user as the service. Read the code before you put anything important
behind it.

## What a key is worth

An agent key (`sb_...`) is the only credential an agent ever holds. A stolen key can do exactly that
agent's grants, and nothing more:

- Call any connector and tool the grants cover, as that agent, in the audit log.
- Read shared memory up to that agent's `memory_clearance`, and write notes.
- Claim and complete tasks; send ARP requests to other agents (first contact still needs your pair
  approval before anything is delivered).
- It cannot mint new keys, change its own grants, read other agents' requests, see connector
  secrets, or approve anything. Those live in `agents.yaml`, the SQLite files, and `sb` commands on
  the box, which a bearer token can never reach.

If a key leaks: `sb agent revoke <name>` kills it immediately (the hash lookup checks `enabled` on
every request), or `sb agent rotate <name>` issues a new one. To see what it did: `sb log <name>`.

## How keys are stored

`sb agent add` prints the key once. `agents.yaml` stores only `token_sha256`, a hex sha256 of the
key, compared in constant time (`timingSafeEqual`) on every request. OAuth codes, access tokens,
refresh tokens and client secrets are stored the same way: hashes only.

## Grants, denies, and dynamic ARP grants

- `grants` maps connector globs to tool globs. `deny` uses the same shape and always wins, over
  static grants and dynamic ones. Use `deny` to fence write tools off a broad grant, for example
  `"*": "*"` plus `deny: {github: ["delete_*", "merge_*"]}`.
- ARP `tool_access` requests mint *dynamic* grants in `arp.sqlite`: one connector, one tool,
  optionally scoped to exact argument values (`scope: {channel: "#general"}` only allows calls whose
  `channel` argument equals that value). They need the target agent's agreement AND your approval,
  expire in 7 days by default (30 max), never auto-renew, and can be revoked immediately by you
  (`sb arp revoke`) or by either agent involved in the original request.
- `tools/list` is filtered to what the key may call, so an agent doesn't even see the tools it can't
  use.

## Identity comes from the key

The built-in connectors (`tasks`, `memory`, `agents`) take the caller's identity from the
authenticated key, not from tool arguments. An agent passing `agent: "someone-else"` changes
nothing: claims, memory writes and ARP requests are all attributed to the bearer token.

## What the audit log records (and what it never records)

Every tool call appends one line to `logs/audit-YYYY-MM-DD.jsonl`: timestamp, agent, connector,
tool, transport (`mcp`, `mcp-combined`, `rest`), duration, result size, outcome (`ok` / `ERR` /
`DENY`), caller IP when the request came through the tunnel, and a summary of the arguments'
*shape* (key names and value lengths). Argument values are never logged, so secrets passed to a
tool don't end up in the log. The ARP store keeps its own audit table (pairs, requests, grants,
decisions) in `arp.sqlite`.

## Memory safety rails

- **Credential rejection on write.** `remember`, `update` and `set_fact` scan the payload for
  key-shaped strings and `password: X`-style assignments and refuse them, pointing the agent at a
  password manager instead. Pointers (`token: password manager item X`) pass by design.
- **Clearance.** Every fact and note has a sensitivity (`public` < `internal` < `restricted` <
  `secret`); each agent has `memory_clearance`. Above-clearance entries are invisible in listings
  and redacted in history.
- **Reason-gated reads.** Reading a `restricted` or `secret` fact requires a `reason` of at least 8
  characters, and every such read is appended to the `access` table (`sb memory access`).
- **Search can't confirm values.** The FTS index only stores values of `public`/`internal` facts, so
  an agent can't probe a restricted value by searching for it.
- **History.** Every change keeps a JSON snapshot of the row before the change. Notes are retired,
  not deleted.

## Notes redaction

`tools/notes_refresh.mjs` drops credential-looking lines *at index time*, before they ever reach the
search index (`src/notes.js` `CREDENTIAL_LINE_PATTERNS`: password lines, token formats, PEM blocks,
SSN/account-shaped numbers, `sudo -S`, credential tables). Withholding a few extra lines costs
nothing; a leaked password costs a lot.

## ARP secret rejection

Every request and response body is scanned (`src/arp.js` `scanForSecrets`) for PEM keys, `sk-`,
`xox*`, `ghp_`, `AKIA`, `EAA`, JWTs, bearer tokens and `key = value` assignments. A hit refuses the
call before anything is stored.

## OAuth

- The operator approves every sign-in. The review link is one-time, the approve action is a POST
  (link previews can't approve), and the page shows the app's name, the agent it will act as, and
  that agent's grants.
- PKCE S256 is required. Codes live 5 minutes and are single-use. Access tokens live 1 hour.
  Refresh tokens live 90 days and rotate on every use; replaying an old refresh token revokes every
  token for that client.
- Rate limits: 30 client registrations and 10 sign-in attempts per hour. Sign-in requests expire in
  15 minutes.
- Only agents marked `oauth: true` can be signed into; disabling an agent or turning `oauth` off
  kills its OAuth tokens immediately.
- Client ID Metadata Document URLs are fetched only for public DNS hostnames (no IPs, no private
  suffixes), capped at 64 KB, with redirects refused.

## `/healthz` is local-only

`/healthz` answers only when the request's socket peer is a loopback address, or when it carries
`Authorization: Bearer <SB_HEALTHZ_TOKEN>` and that variable is set on the service. Through the
Cloudflare tunnel (`cf-connecting-ip` present) it is always a 404, so connector names, pids and
restart counts stay off the public path.

## Where to put the service

Bind to `127.0.0.1` and put a tunnel or reverse proxy in front:

```bash
SB_LISTEN=127.0.0.1:3930                # default; never bind 0.0.0.0 directly
SB_PUBLIC_URL=https://switchboard.example.com
```

The tunnel forwards `cf-connecting-ip`, which both hides `/healthz` and puts the real caller IP in
the audit log. Keep `SB_LISTEN` on loopback even with the tunnel in place.

## Honest limits

- **No multi-tenant isolation.** The SQLite files, config and logs are all readable by the service
  user. Anything that can run code as that user can forge operator decisions in `arp.sqlite` or
  rewrite `agents.yaml`.
- **Connector processes run as the service user.** A compromised MCP server runs with your
  privileges and your `env_files` secrets. Only run connectors you trust, and prefer read-only
  credentials in `env:`.
- **A key is a bearer token.** There is no per-request signing or IP pinning. Keep keys in env
  files and secret stores, not in instruction files or chat history.
- **Rate limiting is minimal.** There is no general request rate limit; a noisy granted agent can
  hammer a connector. `compact` mode exists to cut cost, not abuse.
- **The lane runner executes task text as you.** `trusted_creators` is the only thing between a task
  body and a shell command. Keep it tight.

## Hardening checklist

1. Bind `SB_LISTEN` to `127.0.0.1` and expose the service only through a tunnel or reverse proxy.
2. Keep `config/agents.yaml`, `config/*.env` and `data/` on local disk with restrictive permissions
   (`sb` writes `agents.yaml` as 0600).
3. Grant narrowly: prefer `connector:[tool, tool]` lists over `"*": "*"`, and fence write tools with
   `deny`.
4. Keep `memory_clearance` at `internal` unless an agent genuinely needs `restricted`/`secret`, and
   enable `memory_admin` sparingly.
5. Enable OAuth only on agents meant for it (`sb agent oauth <name> on`), and review `sb oauth list`
   and `sb oauth pending` regularly.
6. Review `sb agent list`, `sb arp grants` and `sb log` periodically for grant drift and odd calls.
7. Route notifications somewhere you check (`SB_NOTIFY=telegram|webhook|ntfy`) so pair approvals,
   grant requests and OAuth sign-ins don't sit unread.
8. In `lane_runner` config, keep `trusted_creators` tight and use `manual_markers`/`skip_boards` for
   anything that must stay human-driven.
9. Back up `data/` with `sqlite3 <file> ".backup out"` (not a live copy of WAL files), and let the
   watchdog prune logs older than 30 days.
10. Pin connector versions in `connections.yaml` instead of `@latest` so a supply-chain surprise is
    your decision, not the registry's.
