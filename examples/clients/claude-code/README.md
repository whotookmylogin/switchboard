# Claude Code

Two pieces: MCP servers so Claude can call the tools, and a SessionStart hook so every session
checks in with the shared task list before it starts working.

## 1. Add the connectors

One MCP entry per built-in connector keeps tool names short (`mcp__switchboard-tasks__claim`):

```bash
source ~/.config/switchboard/claude.env
for c in tasks memory lookup notes; do
  claude mcp add --scope user --transport http "switchboard-$c" "$SWITCHBOARD_URL/mcp/$c" \
    --header "Authorization: Bearer $SWITCHBOARD_TOKEN"
done
```

Or add everything the key is granted as one server (tools are named `<connector>__<tool>`):

```bash
claude mcp add --scope user --transport http switchboard "$SWITCHBOARD_URL/mcp" \
  --header "Authorization: Bearer $SWITCHBOARD_TOKEN"
```

## 2. Check in at session start

Copy `switchboard-checkin.sh` to `~/.claude/hooks/`, make it executable, and merge
`settings.snippet.json` into `~/.claude/settings.json`. Each new session then opens with something like:

```
Shared task list (Switchboard `tasks` connector, all agents):
Being worked on now. Don't duplicate these:
- [default] t_3f9a1c22 Migrate invoices export to v2 API (by codex, until 2026-10-17T19:40:00Z)
Ready and assigned to claude:
- [default] t_928a34c6 Write playbooks for the five most common support tickets
Before substantial work: call `find`, then `start` or `claim`; `complete` with what you did and where.
```

## 3. Tell it the rules

Paste the block from [`../AGENTS.md`](../AGENTS.md) into `~/.claude/CLAUDE.md`.
