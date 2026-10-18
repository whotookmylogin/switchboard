#!/usr/bin/env bash
# Two-minute Switchboard demo: a throwaway config, two agents (alice-agent, bob-agent),
# the real server on 127.0.0.1:3939, and a few REST calls showing the shared task list
# and shared memory. Everything lands in a temp dir that is deleted at the end.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT=3939
BASE="http://127.0.0.1:$PORT"
TMP=$(mktemp -d)
SB_PID=""

cleanup() {
  [ -n "$SB_PID" ] && kill "$SB_PID" 2>/dev/null
  wait "$SB_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$1"; }

# Print one REST reply: the structured payload when there is one, else the text.
show() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(JSON.stringify(j.structured??j.text??j,null,2))}catch{process.stdout.write(s+"\n")}})'
}

call() { # key connector tool json-body
  curl -sf -X POST "$BASE/api/call/$2/$3" \
    -H "Authorization: Bearer $1" -H "content-type: application/json" -d "$4"
}

say "Writing a throwaway config under $TMP"
mkdir -p "$TMP/config" "$TMP/data" "$TMP/logs"
cat > "$TMP/config/connections.yaml" <<EOF
connections:
  demo:
    command: node
    args: ["$REPO/test/mock-server.mjs"]
EOF
echo "connector 'demo' -> test/mock-server.mjs"

say "Creating alice-agent and bob-agent (each key is shown once; only sha256 is stored)"
export SB_CONFIG_DIR="$TMP/config" SB_DATA_DIR="$TMP/data" SB_LOG_DIR="$TMP/logs"
ALICE_KEY=$(node "$REPO/bin/sb.js" agent add alice-agent --grant tasks --grant memory --grant demo 2>/dev/null | tail -n1)
BOB_KEY=$(node "$REPO/bin/sb.js" agent add bob-agent --grant tasks --grant memory --grant demo 2>/dev/null | tail -n1)
echo "alice-agent key: ${ALICE_KEY:0:8}..."
echo "bob-agent key:   ${BOB_KEY:0:8}..."

say "Starting Switchboard on $BASE"
SB_LISTEN="127.0.0.1:$PORT" node "$REPO/src/index.js" >"$TMP/logs/stdout.log" 2>&1 &
SB_PID=$!
demo_up() { curl -sf "$BASE/healthz" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).connectors.demo.up?0:1)}catch{process.exit(1)}})'; }
for _ in $(seq 1 75); do demo_up && break; sleep 0.2; done
curl -s "$BASE/healthz" | show

say "alice starts a task on board 'default'"
TASK=$(call "$ALICE_KEY" tasks start '{"board":"default","title":"Write the launch checklist for acme","ttl_minutes":30}')
echo "$TASK" | show
TASK_ID=$(echo "$TASK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).structured.task.id))')

say "bob searches open tasks and finds it (no duplicate work)"
call "$BOB_KEY" tasks find '{"query":"launch checklist"}' | show

say "bob tries to claim the task alice holds (conflict expected)"
call "$BOB_KEY" tasks claim "{\"id\":\"$TASK_ID\"}" | show

say "alice completes it with a receipt"
call "$ALICE_KEY" tasks complete "{\"id\":\"$TASK_ID\",\"result\":\"Checklist drafted and left on board default for review.\"}" | show

say "alice saves a note to shared memory"
call "$ALICE_KEY" memory remember '{"kind":"tip","title":"Launch checklists live on board default","body":"Before drafting a launch checklist, run tasks.find first so two agents never write the same one.","topics":"launch,process"}' | show

say "bob recalls it with his own key"
call "$BOB_KEY" memory recall '{"q":"launch checklist"}' | show

say "The audit log, through 'sb log'"
node --no-warnings "$REPO/bin/sb.js" log

say "Done. Stopping the server and deleting $TMP"
