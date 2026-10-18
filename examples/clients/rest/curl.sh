#!/bin/bash
# The REST facade: same connectors, same grants and audit, for agents without an MCP client.
# Auth: "Authorization: Bearer <key>" or "X-Api-Key: <key>".
URL=${SWITCHBOARD_URL:-http://127.0.0.1:3930}
KEY=${SWITCHBOARD_TOKEN:?set SWITCHBOARD_TOKEN}

# Every tool this key may call, as an OpenAPI 3.1 document (paste into a GPT action / tool config).
curl -s "$URL/api/openapi.json" -H "Authorization: Bearer $KEY" | head -c 400; echo

# The same list as plain JSON.
curl -s "$URL/api/tools" -H "Authorization: Bearer $KEY" | head -c 400; echo

# Call a tool: body = the tool's arguments. 403 = not granted to this key.
curl -s -X POST "$URL/api/call/tasks/find" -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" -d '{"query":"invoice export"}'; echo

curl -s -X POST "$URL/api/call/tasks/start" -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"board":"default","title":"Draft the Q4 supplier survey","ttl_minutes":120}'; echo
