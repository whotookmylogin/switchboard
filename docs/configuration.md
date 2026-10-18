# Configuration

Everything Switchboard reads at startup (and on `SIGHUP`) lives in one config directory, by default
`<repo>/config/`. State lives in `<repo>/data/`. Logs live in `<repo>/logs/`. Each of those can be
moved with the environment variables below.

```text
config/
  connections.yaml    which MCP servers exist and how to start them
  agents.yaml         who may connect, and what each key may call
  directory.yaml      sources for the lookup directory (cron job input)
  *.env               dotenv files holding connector secrets
data/
  tasks.sqlite  memory.sqlite  arp.sqlite  oauth.sqlite  directory.sqlite  notes.sqlite
  notes/<host>/*.md     markdown files indexed into notes.sqlite
logs/
  audit-YYYY-MM-DD.jsonl    every tool call
  events-YYYY-MM-DD.jsonl   lifecycle events
  <connector>.stderr.log    connector child stderr
```

## Environment variables

These are the only variables the code reads. `SB_*` values may also come from a file listed in
`env_files` (see `connections.yaml`); the process environment wins over file values.

### Service

| Variable | Default | What it does |
|---|---|---|
| `SB_HOME` | the repo root (parent of `src/`) | Base directory used when `SB_CONFIG_DIR`, `SB_DATA_DIR` or `SB_LOG_DIR` are not set. |
| `SB_CONFIG_DIR` | `$SB_HOME/config` | Where `connections.yaml`, `agents.yaml` and `directory.yaml` are read. |
| `SB_DATA_DIR` | `$SB_HOME/data` | Default directory for the SQLite files. |
| `SB_LOG_DIR` | `$SB_HOME/logs` | Audit log, events log and connector stderr logs. |
| `SB_LISTEN` | `127.0.0.1:3930` | `host:port` to bind. Comma-separate several to listen on more than one address. |
| `SB_PUBLIC_URL` | `http://127.0.0.1:3930` | External base URL used in OAuth metadata, approval links and notifications. Set it to the tunnel hostname (for example `https://switchboard.example.com`) when you expose the service. |
| `SB_DIRECTORY` | `$SB_DATA_DIR/directory.sqlite` | Lookup directory file. Shared by `tools/directory_refresh.mjs` (writer) and the `lookup` connector (reader). |
| `SB_DIRECTORY_CONFIG` | `$SB_CONFIG_DIR/directory.yaml` | Sources file for `tools/directory_refresh.mjs`. |
| `SB_MEMORY` | `$SB_DATA_DIR/memory.sqlite` | Shared memory store. Also read by `sb memory`. |
| `SB_NOTES_DB` | `$SB_DATA_DIR/notes.sqlite` | Notes index. Shared by `tools/notes_refresh.mjs` (writer) and the `notes` connector (reader). |
| `SB_NOTES_DIR` | `$SB_HOME/data/notes` | Markdown source tree (`<host>/*.md`) for `tools/notes_refresh.mjs`. |
| `SB_TASKS_BACKEND` | `sqlite` | `tasks` engine: `sqlite` (built-in store) or `hermes` (shell out to `tools/kanban_bridge.py`). |
| `SB_TASKS_DB` | `$SB_DATA_DIR/tasks.sqlite` | Task store file for the sqlite engine. Also read by `sb tasks`. |
| `SB_TASK_LANES` | `claude,codex,human` | Comma-separated lane names accepted as a task `assignee`. |
| `SB_HERMES_DIR` | `~/.hermes/hermes-agent` | Hermes install directory, used by the `hermes` tasks engine. |
| `SB_KANBAN_CMD` | unset | JSON array that overrides the kanban bridge command (test seam). |
| `SB_OPERATOR_NAME` | `operator` | Admin identity recorded for CLI-side ARP decisions and audit views. |
| `SB_DISPLAY_NAME` | `Switchboard` | Name shown on OAuth pages and in resource metadata. |
| `SB_PRIVATE_HOST_SUFFIXES` | unset | Comma-separated extra DNS suffixes treated as private. Client ID Metadata Document URLs on these hosts are never fetched. |
| `SB_TZ` | host timezone | Timezone for human-facing timestamps (the OAuth approval page, compacted Slack lines). Falls back to the system zone. |
| `SB_HEALTHZ_TOKEN` | unset | When set, `GET /healthz` also answers for non-loopback requests carrying `Authorization: Bearer <token>`. Loopback callers never need it. |

### Notifications

`SB_NOTIFY` picks the notifier used for OAuth sign-in approvals and ARP approval cards:

| Value | What happens |
|---|---|
| `log` (default) | Writes an `operator_notify` event to stdout and the events log. Watch it, or poll with `sb oauth pending` / `sb arp list`. |
| `telegram` | Sends a Telegram message. Needs `SB_TELEGRAM_BOT_TOKEN` and `SB_TELEGRAM_CHAT_ID`. |
| `webhook` | POSTs `{text, url, content}` JSON to `SB_NOTIFY_WEBHOOK_URL` (Slack/Discord compatible). |
| `ntfy` | POSTs plain text to `SB_NTFY_URL` with a `Click` header for the approval link. |

`SB_OAUTH_NOTIFY_FILE` (unset by default) overrides every mode: each notification is appended to that
file as one `{"text": ..., "url": ...}` JSON line. Tests use it as a seam.

### CLI

| Variable | Default | What it does |
|---|---|---|
| `SB_URL` | `http://127.0.0.1:3930` | Base URL for `sb status` and `sb snippet`. |

`sb` also honors `SB_HOME`, `SB_CONFIG_DIR`, `SB_DATA_DIR`, `SB_LOG_DIR`, `SB_MEMORY`, `SB_TASKS_DB`
and `SB_TASKS_BACKEND` so it always points at the same files as the service.

### Cron tools

| Variable | Default | Used by | What it does |
|---|---|---|---|
| `SB_PORT` | `3930` | `tools/watchdog.sh` | Port probed on `http://127.0.0.1:$SB_PORT/healthz`. |
| `SWITCHBOARD_URL` | `http://127.0.0.1:3930` | `tools/lane_runner.py`, `examples/clients/*` | REST base URL. |
| `SWITCHBOARD_TOKEN` | unset | same | Agent key for REST calls. |
| `XDG_STATE_HOME` | `~/.local/state` | `tools/lane_runner.py` | Base for runner state, lock and run logs. |

## `connections.yaml`

Defines the external MCP servers Switchboard runs once and shares. Built-in connectors (`tasks`,
`memory`, `lookup`, `notes`, `agents`) are not listed here; they always exist.

```yaml
env_files:
  - secrets.env            # optional list of dotenv files

connections:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
  sql-readonly:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
    default_sql_limit: 100
  browser:
    command: npx
    args: ["-y", "@playwright/mcp@0.0.40"]
    serialize: true
    connect_timeout: 90
```

### Top-level keys

| Key | What it does |
|---|---|
| `env_files` | List of dotenv paths. Relative paths resolve against the directory containing `connections.yaml`. Entries may contain `${VAR}` placeholders resolved from the process environment. |
| `connections` | Map of connector name to definition. Names should stick to letters, digits, `.`, `_` and `-`, and must not contain `__` (it is the separator in combined-endpoint tool names). |

### Per-connector keys

| Key | Default | What it does |
|---|---|---|
| `command` | (required) | Executable to spawn for the stdio MCP server. |
| `args` | `[]` | Argument list for `command`. |
| `env` | `{}` | Extra environment variables for the child process. Values are added on top of a minimal safe environment (below). |
| `cwd` | `$HOME` | Working directory of the child. |
| `enabled` | `true` | `enabled: false` skips the connector without deleting it. |
| `serialize` | `false` | `true` queues calls so only one runs at a time. Use it for browser-driven servers that share one page. |
| `connect_timeout` | `60` | Seconds to wait for the MCP handshake before the start is considered failed (restart follows with backoff). |
| `default_sql_limit` | unset | For compact agents, a `LIMIT n` is appended to `query` tool calls whose `sql` argument has none. Any positive number overrides the built-in default of 100. |
| `slack_shaping` | `false` | `true` applies the compact-mode Slack result shaper (and the user-id to name lookup) to this connector. Connectors named `slack-*` get it automatically; set the flag for Slack-like connectors with other names. |

### `${VAR}` interpolation

Every string in a connection definition may contain `${VAR}` or `${env:VAR}` placeholders. `${userHome}`
resolves to `$HOME`. Values are looked up in the `env_files`, later files winning, then the process
environment overrides everything. A variable that resolves nowhere stays literal (`${VAR}`), so a
missing secret fails loudly in the child's logs instead of silently expanding to empty.

### Dotenv files (`env_files`)

Plain `KEY=value` lines. Optional `export ` prefix, optional single or double quotes, `#` comments.
These files hold the secrets; keep them out of git (`.gitignore` already covers `config/*.env`).

### Child environment

Connector children do not inherit the service's full environment. They get only these parent
variables, plus whatever `env:` adds:

`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, every `XDG_*`, and the Windows
set (`TEMP`, `TMP`, `LOGNAME`, `SYSTEMROOT`, `COMSPEC`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
`PROGRAMDATA`, `WINDIR`).

This is why tokens go in `env:` (or an `env_files` `${VAR}`) and not just the service's own
environment.

## `agents.yaml`

Maps agent names to keys and permissions. `sb agent add|grant|revoke|rotate` writes this file; only
sha256 hashes of keys are ever stored.

```yaml
agents:
  claude-code:
    token_sha256: "3b1f..."      # hash of the key printed once by `sb agent add`
    enabled: true
    grants:
      tasks: "*"
      memory: "*"
      github: ["search_*", "get_file_contents"]
    deny:
      github: ["delete_*"]
    compact: false
    max_result_kb: 64
    oauth: false
    memory_clearance: internal
    memory_admin: false
  gpt-connector:
    oauth: true                  # OAuth-only agent: no static key
    grants:
      tasks: "*"
```

| Key | Default | What it does |
|---|---|---|
| `token_sha256` | unset | sha256 (hex) of the agent's `sb_...` key. Without it, key auth is impossible for this agent (OAuth-only agents have no key). |
| `enabled` | `true` | `false` disables the agent immediately: its key stops authenticating and its OAuth tokens stop working. |
| `grants` | `{}` | Map of connector glob to tool list. `"*"` grants all tools; a list takes tool names or `*` globs. The connector side also takes globs, so `"slack-*": ["*"]` works. |
| `deny` | `{}` | Same shape as `grants`. A matching deny always wins, over both static grants and ARP-minted grants. |
| `compact` | `false` | `true` shortens tool descriptions, clamps page-size arguments, adds `LIMIT` to unbounded `query` calls, and reshapes JSON results into compact lines (see `src/compact.js`). For agents billed per token. |
| `max_result_kb` | unset | Caps one tool result at this many KB, truncated at a line break with a note explaining what happened. |
| `oauth` | `false` | `true` allows OAuth sign-ins to act as this agent. Turning it off (`sb agent oauth <name> off`) also revokes existing OAuth tokens. |
| `memory_clearance` | `internal` | Highest memory sensitivity this agent can read or write: `public`, `internal`, `restricted` or `secret`. |
| `memory_admin` | `false` | `true` lets the agent call `set_fact` (write facts directly). Everyone else uses `remember`/`flag`. |

Fields the CLI writes for bookkeeping (`created`, `revoked`, `enabled_at`) are ignored by the server.

## `directory.yaml`

Input for `tools/directory_refresh.mjs`, which rebuilds `data/directory.sqlite`. Each entry produces
rows the `lookup` tool can search. `${VAR}` interpolation works the same way as in
`connections.yaml`.

```yaml
sources:
  - name: team-json
    type: file
    path: team.json          # relative to this file's directory
  - name: howto
    type: guide
    path: ../tools/directory_guide.md
  - name: roster
    type: file
    path: roster.csv
    map: { line: "display" } # optional column remap for CSV headers
  - name: custom
    type: command
    command: [node, gen.mjs]
    cwd: /opt/acme           # optional; defaults to the config dir
  - name: slack
    type: slack
    token: ${SLACK_BOT_TOKEN}
```

| `type` | What it reads |
|---|---|
| `file` | A JSON array (or `{"entries": [...]}`) of entry objects, or a CSV with a header row containing `kind,ref,title,keys,line,weight`. `map` renames CSV columns before use. |
| `guide` | A markdown file split on `## Title` headings. An optional `keys:` line adds search terms; the rest of the section is the one-line answer. |
| `command` | Runs the command (60 s timeout) and parses stdout as a JSON array of entry objects. |
| `slack` | Calls `users.list` and `conversations.list` with `token` and emits `person` and `channel` rows. |

Entry fields: `kind` (one of `person`, `channel`, `customer`, `account`, `vendor`, `stock`,
`product`, `team`, `guide`), `ref` (the entry's own id), `title` (display name, weighted highest in
search), `line` (the one-line answer returned to the agent), `keys` (extra searchable ids, emails,
aliases), `weight` (ranking boost, roughly 0 to 3).

A source that fails keeps its rows from the previous build, and the error is recorded in the file's
`meta` table and in the run's JSON output.

## Lane runner (`tools/lane_runner.py`)

Runs from cron every couple of minutes. Each tick claims the top ready task per enabled lane and
starts the lane's command as a detached subprocess. It talks only to the REST API.

Config is a JSON file passed with `--config`, deep-merged over built-in defaults
(`examples/lane_runner.example.json` shows every key):

```json
{
  "enabled": true,
  "switchboard_url": "http://127.0.0.1:3930",
  "token": "sb_EXAMPLE",
  "lanes": {
    "claude": {
      "enabled": true,
      "command": ["claude", "-p", "--permission-mode", "acceptEdits", "--output-format", "json"],
      "daily_cap": 8,
      "concurrency": 1
    }
  },
  "trusted_creators": ["human", "claude", "codex"],
  "manual_markers": ["[manual]", "no-auto", "[interactive]"],
  "skip_boards": [],
  "skip_cards": [],
  "max_runtime_minutes": 120,
  "claim_ttl_minutes": 30,
  "state_path": "~/.local/state/switchboard/lane_runner_state.json",
  "log_path": "~/.local/state/switchboard/lane-runner.log",
  "runs_dir": "~/.local/state/switchboard/lane-runs"
}
```

| Key | What it does |
|---|---|
| `enabled` | Master switch for the whole runner. |
| `switchboard_url` | REST base URL. Falls back to `$SWITCHBOARD_URL`, then `http://127.0.0.1:3930`. |
| `token` | Agent key for REST calls. Falls back to `$SWITCHBOARD_TOKEN`. Required. |
| `lanes` | Per-lane config: `enabled`, `command` (list; `{prompt_file}` and `{task_id}` placeholders are substituted), `daily_cap`, `concurrency`. At most one new task per lane per tick. |
| `trusted_creators` | Only tasks whose `created_by` is in this list run unattended. `null` disables the check. This is the security gate: the runner executes task text as you. |
| `manual_markers` | Substrings in title or body that leave the task for interactive sessions. |
| `skip_boards` | Board slugs never run unattended. |
| `skip_cards` | Task ids never run unattended. |
| `max_runtime_minutes` | Workers past this are killed and the task is blocked. |
| `claim_ttl_minutes` | Claim length the runner asks for and heartbeats under. |
| `state_path` | Runner state JSON (held tasks, skips, daily counts, history). |
| `log_path` | Runner's own log. |
| `runs_dir` | Per-task `<id>.prompt.txt`, `<id>.log`, `<id>.exit`. |

One non-blocking flock on `<state_path's dir>/lane_runner.lock` makes overlapping ticks exit quietly.
`--dry-run` reports what a tick would do without changing anything.

## Reloading

`SIGHUP` to the main process reloads `connections.yaml` and `agents.yaml`: new connectors start,
removed ones stop, changed ones restart, agent changes apply immediately. Send it to the main process
only, not the process group, or every connector child gets HUPped too:

```bash
systemctl --user kill --kill-who=main -s HUP switchboard
```
