# Switchboard lookup guide

Short how-to entries merged into the lookup directory by `tools/directory_refresh.mjs`.

## Request access to a connector
keys: access grant connector permission agent
Ask the operator to add grants in `config/agents.yaml` (or run `sb agent grant`). Say which connector and tools you need and why.

## Report a broken connector
keys: broken down error connector health restart
Check `sb status` and connector logs under `logs/`. Note the connector name, error text, and what you were trying to do; ask the operator to fix or restart the Switchboard process.

## Where agents should log what they did
keys: audit log memory tasks record work
Use the built-in `tasks` connector for work tracking, `memory` for durable facts and house rules, and the Switchboard audit log (`sb log`) for tool calls. Do not store secrets in memory or task bodies.
