#!/bin/bash
# Claude Code SessionStart hook: "check in" with the shared task list before doing anything.
#
# Injects two things into the new session's context:
#   1. what every agent is working on right now (claimed tasks), so this session doesn't duplicate it
#   2. ready tasks assigned to this agent's lane, so it knows what's waiting for it
#
# Silent on any failure: a down Switchboard must never block or slow a session start (4 s cap per call).
#
# Install:
#   mkdir -p ~/.config/switchboard && chmod 700 ~/.config/switchboard
#   printf 'SWITCHBOARD_URL=https://switchboard.example.com\nSWITCHBOARD_TOKEN=sb_...\nSWITCHBOARD_LANE=claude\n' \
#     > ~/.config/switchboard/claude.env && chmod 600 ~/.config/switchboard/claude.env
#   cp switchboard-checkin.sh ~/.claude/hooks/ && chmod +x ~/.claude/hooks/switchboard-checkin.sh
#   then register it in ~/.claude/settings.json (see settings.snippet.json)
#
# Keep the token file on local disk (not a synced cloud folder): a stalled sync would stall every startup.
ENV_FILE="${SWITCHBOARD_ENV:-$HOME/.config/switchboard/claude.env}"
[ -r "$ENV_FILE" ] || exit 0
# shellcheck disable=SC1090
source "$ENV_FILE"
LANE="${SWITCHBOARD_LANE:-claude}"
call() {
  curl -s --max-time 4 -X POST "$SWITCHBOARD_URL/api/call/tasks/$1" \
    -H "Authorization: Bearer $SWITCHBOARD_TOKEN" -H "content-type: application/json" -d "$2"
}
TMP=$(mktemp -d) || exit 0
trap 'rm -rf "$TMP"' EXIT
call active "{}" > "$TMP/a" &
call list "{\"assignee\":\"$LANE\",\"status\":\"ready\"}" > "$TMP/m" &
wait
ACTIVE=$(cat "$TMP/a"); MINE=$(cat "$TMP/m")
[ -n "$ACTIVE" ] || exit 0
ACTIVE="$ACTIVE" MINE="$MINE" LANE="$LANE" python3 - <<'PY' 2>/dev/null
import json, os
def data(raw):
    try:
        d = json.loads(raw)
        return d.get("structured") or json.loads(d.get("text") or "{}")
    except Exception:
        return {}
a, m = data(os.environ["ACTIVE"]), data(os.environ["MINE"])
if not a:
    raise SystemExit
lines = ["Shared task list (Switchboard `tasks` connector, all agents):"]
now = a.get("working_now") or []
if now:
    lines.append("Being worked on now. Don't duplicate these:")
    for t in now[:15]:
        who = (t.get("claimed_by") or "?").replace("switchboard/", "")
        lines.append(f"- [{t['board']}] {t['id']} {t['title']} (by {who}, until {t.get('claim_expires')})")
else:
    lines.append("Nobody has a task claimed right now.")
mine = m.get("tasks") or []
if mine:
    lines.append(f"Ready and assigned to {os.environ['LANE']}:")
    for t in mine[:10]:
        lines.append(f"- [{t['board']}] {t['id']} {t['title']}")
w = a.get("waiting") or {}
if w.get("total"):
    lines.append(f"{w['total']} tasks waiting in review/blocked across boards.")
lines.append("Before substantial work (multi-step builds, deploys, fixes): call `find`, then `start` or `claim`; "
             "`complete` with what you did and where. Skip for quick questions.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}}))
PY
exit 0
