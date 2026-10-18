# Deployment

Runs fine as a systemd user service on a small Linux box, bound to `127.0.0.1`, with a tunnel or
reverse proxy in front for agents that live elsewhere. Example unit files and a Cloudflare Tunnel
config are in [`deploy/`](../deploy/).

## Install

Needs Node 22.13 or newer (the code uses the built-in `node:sqlite`). Point the service at a Node
you control; a distro package or a node bundled inside another agent will surprise you later.

```bash
git clone https://github.com/<you>/switchboard.git ~/switchboard
cd ~/switchboard
npm ci

mkdir -p config data/notes
cp examples/connections.example.yaml config/connections.yaml   # edit: your MCP servers
cp examples/agents.example.yaml   config/agents.yaml            # or start empty: "agents: {}"
cp examples/example.env           config/secrets.env            # your tokens, keep out of git
```

Quick smoke test before wiring a service:

```bash
SB_LISTEN=127.0.0.1:3930 node src/index.js &
curl -s http://127.0.0.1:3930/healthz
node bin/sb.js agent add claude-code --grant tasks --grant memory --grant lookup
# prints the key once; only its sha256 is stored
```

## systemd user service

```bash
mkdir -p ~/.config/systemd/user
cp deploy/switchboard.service ~/.config/systemd/user/
cp deploy/switchboard-watchdog.service deploy/switchboard-watchdog.timer ~/.config/systemd/user/
# edit ~/.config/systemd/user/switchboard.service: ExecStart node path, repo path, SB_LISTEN

systemctl --user daemon-reload
systemctl --user enable --now switchboard
systemctl --user enable --now switchboard-watchdog.timer
loginctl enable-linger "$USER"     # keep the service alive after you log out
```

The main unit is `Type=simple` with `Restart=always`, `RestartSec=2`, `KillMode=mixed` (SIGTERM to
the main process, SIGKILL to stragglers so connector children don't linger), `TimeoutStopSec=20`,
and `StartLimitIntervalSec=0` so a crash loop never rate-limits restarts.

The watchdog (`deploy/switchboard-watchdog.{service,timer}`) runs `tools/watchdog.sh` every 2
minutes starting 3 minutes after boot. It restarts the service if `/healthz` fails twice, and prunes
`logs/*-*.jsonl` files older than 30 days.

## Reloading config

`connections.yaml` and `agents.yaml` reload on `SIGHUP`, but only when the signal reaches the main
process:

```bash
systemctl --user kill --kill-who=main -s HUP switchboard
```

Do not use plain `kill -HUP` on the process group (or `systemctl kill` without `--kill-who=main`):
that HUPs every connector child too, and they all exit. `sb agent ...` and other `sb` commands that
change `agents.yaml` already send the scoped HUP for you: through `systemctl --user` when the
service runs under systemd, or, when that fails or isn't there, by signaling the pid the server
writes to `data/switchboard.pid` at startup (removed on clean exit). `sb` prints which method it
used.

## Restarting safely

Requests are stateless so clients recover, but a long tool call gets cut off. Check in-flight calls
first:

```bash
curl -s http://127.0.0.1:3930/healthz   # look at "inflight" per connector
systemctl --user restart switchboard
```

## Backups

Tasks, memory, ARP grants, OAuth clients, the lookup directory and the notes index all live as
SQLite files under `data/`. Back them up with the online backup API, never by copying live WAL
files:

```bash
for f in ~/switchboard/data/*.sqlite; do
  sqlite3 "$f" ".backup '${f##*/}.bak'"
done
```

or from Node: `new DatabaseSync(f).backup(dest)`. The refresh jobs (`directory_refresh`,
`notes_refresh`) rebuild their files atomically, so a stale backup of those two is harmless anyway.

## Logs

- `logs/audit-YYYY-MM-DD.jsonl`: every tool call (who, what, how long, how big, outcome; never
  argument values). Read it with `sb log <agent> --since 1h`.
- `logs/events-YYYY-MM-DD.jsonl`: lifecycle events (listening, reloads, backend starts/exits,
  notification failures).
- `logs/<connector>.stderr.log`: connector child stderr, rotated at 5 MB.
- The watchdog deletes `*-*.jsonl` files older than 30 days on each run.

## Exposing it

Keep `SB_LISTEN=127.0.0.1:3930` and put a tunnel or reverse proxy in front. With Cloudflare Tunnel:

```bash
cloudflared tunnel create switchboard
cloudflared tunnel route dns switchboard switchboard.example.com
cp deploy/cloudflared-config.example.yml ~/.cloudflared/config.yml   # fill in TUNNEL_ID
cloudflared service install
```

Then set `SB_PUBLIC_URL=https://switchboard.example.com` so OAuth metadata and approval links use
the public name. `/healthz` stays local: cloudflared adds `cf-connecting-ip` to tunneled requests,
and Switchboard returns 404 for those. That flag also puts the real caller IP in the audit log.

Other reverse proxies work too; forward a client-IP header if you want it in the audit log, and note
that without `cf-connecting-ip` the `/healthz` page is reachable through the proxy (block it there
if you want the same hiding).

## Cron jobs

`deploy/crontab.example` has the three periodic jobs: the lane runner every 2 minutes (under
`flock`), the directory refresh hourly, and the notes refresh every 30 minutes. The explicit `PATH`
line at the top is load-bearing: cron's default PATH will not find `node` or your agent CLIs and the
jobs fail silently.

## macOS (launchd)

`deploy/com.example.switchboard.plist` is a minimal LaunchAgent equivalent of the systemd unit:
`KeepAlive` for restarts, logs under `logs/launchd.*.log`. Install it to
`~/Library/LaunchAgents/`, fix the node and repo paths, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.switchboard.plist`. For reload,
`launchctl kickstart -s` restarts; a scoped HUP can be sent with `kill -HUP <pid>` on the main
process only (same rule as Linux: never signal the process group).
