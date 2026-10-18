# Hermes

Hermes (Nous Research's agent) was the first client. Each Hermes process (gateway, dashboard, API
server) used to spawn its own copy of every stdio MCP server. Moving them into the Switchboard cut 71
MCP processes to 23 and ended refresh-token races between copies.

1. Generate `config/connections.yaml` from your existing Hermes config:
   `python3 tools/import_hermes.py ~/.hermes/config.yaml config/connections.yaml`
2. `sb agent add hermes --grant "*"` and put the printed key in `~/.hermes/.env` as `SWITCHBOARD_TOKEN`.
3. Replace each stdio entry in `~/.hermes/config.yaml` with a `url:` entry (see `config.yaml.snippet`).
4. Restart Hermes. Tool names are unchanged.

Optional: `SB_TASKS_BACKEND=hermes` makes the `tasks` connector read and write Hermes' own kanban
board (through `tools/kanban_bridge.py`), so Hermes' dispatcher and the other agents share one board.
