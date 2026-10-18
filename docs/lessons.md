# Lessons learned

Things that bit me while building and running this. Most of them are why the code looks the way it
does.

## Connectors

1. **Rotating refresh tokens and multiple copies don't mix.** Some OAuth providers issue a new refresh
   token on every refresh and kill the old one. Two processes holding the same token: the first to
   refresh wins, the second is logged out. Running each connector once fixed it. If you write a
   connector like this, reload the token file right before refreshing.
2. **Message size caps differ by client.** The MCP JS SDK's stdio client caps messages at 10 MB by
   default, and some agents reject HTTP MCP responses over 10 MB. Switchboard raises the stdio buffer
   and trims any result over 9 MB to a shortened answer instead of an error.
3. **Browser-driven connectors share one page.** Two calls at once step on each other. Mark them
   `serialize: true` and Switchboard queues their calls.
4. **Pin connector versions.** A connector launched with `npx some-server@latest` or `uvx` can break
   overnight when a dependency ships a breaking release. Pin the exact version in `connections.yaml`.
5. **Match the environment exactly when migrating.** Before moving an agent's connectors into
   Switchboard, I dumped every child process's env and working directory from `/proc` and diffed them
   against what Switchboard would start. PATH order mattered (a virtualenv `bin` had to come first).

## Running it

6. **Reload only the main process.** `kill -HUP` on the whole process group also hits every connector
   child and they all exit. With systemd: `systemctl --user kill --kill-who=main -s HUP switchboard`.
7. **Check in-flight calls before restarting.** `curl -s localhost:3930/healthz` shows `inflight` per
   connector. Requests are stateless, so clients recover anyway, but a long tool call gets cut off.
8. **Use a Node you control.** `node:sqlite` needs Node 22.13+. A distro Node was too old, and the Node
   bundled inside another agent got replaced by that agent's updates. The service points at its own
   pinned Node.
9. **Back up `data/`.** Tasks, memory, ARP grants and OAuth clients live in SQLite files there. Use
   `sqlite3 file ".backup out"` (or the `node:sqlite` backup API) rather than copying a live WAL
   database.
10. **Cron PATH is not your shell PATH.** A cron job that sent approval cards failed silently 3,000+
    times because a CLI it called wasn't on cron's PATH. Set PATH in the crontab line and alert on
    repeated failures.

## Agents

11. **Grants drift.** One agent's grants were silently widened to almost everything over a few days.
    Review `sb agent list` regularly and keep write tools behind `deny` lists unless you mean it.
12. **Identity must come from the key.** Early on, a tool accepted an `agent` argument. Anything an
    agent can type, it can type wrong. Built-in connectors now ignore caller-supplied identity.
13. **Claim TTLs must be short.** A crashed agent holding a task for a day is worse than two agents
    briefly overlapping. 60 minutes with heartbeats works.
14. **Require a result on complete.** "Done" with no receipt means the next agent repeats the
    research. `complete` refuses an empty `result`.
15. **Front doors billed per token need compact mode.** One cloud agent burned through its plan
    calling list-everything tools and reading 200 KB Slack user lists. `compact: true` plus the
    `lookup` directory cut that dramatically.
16. **Agents defer tool schemas.** Some clients don't load MCP tool schemas until they think they need
    them, then claim the tools don't exist. Naming the tools in the agent's instruction file fixes it.
17. **Don't let a cleanup job delete what it can't restore.** An automatic sweeper that archived stale
    tasks also deleted their scratch folders, with no undo. It now tars them first. Anything that
    archives or deletes should keep a copy.
18. **Never test against your real home directory.** Running an agent's CLI with a temporary home
    rewrote its launcher scripts to point at the temp directory. Test through the library API, or in
    a container.
