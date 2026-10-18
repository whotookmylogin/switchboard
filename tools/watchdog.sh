#!/bin/bash
# Switchboard watchdog (user timer, every 2 min): restart if /healthz stops answering; prune logs > 30 days.
set -u
SB_HOME="${SB_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
SB_PORT="${SB_PORT:-3930}"
LOG="${SB_HOME}/logs/watchdog.log"
# /healthz is loopback-only unless the request carries the operator's healthz token; send it when set.
AUTH=()
if [ -n "${SB_HEALTHZ_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${SB_HEALTHZ_TOKEN}")
fi
if ! curl -fsS -m 10 "${AUTH[@]}" "http://127.0.0.1:${SB_PORT}/healthz" >/dev/null; then
  sleep 5
  if ! curl -fsS -m 10 "${AUTH[@]}" "http://127.0.0.1:${SB_PORT}/healthz" >/dev/null; then
    echo "$(date -Is) healthz failed twice; restarting switchboard" >> "$LOG"
    systemctl --user restart switchboard.service
  fi
fi
find "${SB_HOME}/logs" -name '*-20*.jsonl' -mtime +30 -delete 2>/dev/null
