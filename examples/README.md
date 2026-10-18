# Examples

Starter configs, client setup and a two-minute demo.

## Try it

- `demo.sh`: spins up a throwaway Switchboard on port 3939 with two agents and walks the shared
  task list and memory over REST. Output of a real run is in
  [`docs/demo-output.txt`](../docs/demo-output.txt).

## Config starters

Copy these into `config/` and edit:

- `connections.example.yaml`: which MCP servers to run (`command`, `args`, `env`, `serialize`,
  `connect_timeout`, `${VAR}` secrets).
- `agents.example.yaml`: agent entries: `token_sha256`, `grants`, `deny`, `compact`,
  `max_result_kb`, `oauth`, `memory_clearance`.
- `directory.example.yaml`: sources for `tools/directory_refresh.mjs` (file, guide, command,
  slack).
- `directory-team.json`: a `file` source row, for the directory example.
- `example.env`: a dotenv file for connector secrets (referenced by `env_files:`).
- `lane_runner.example.json`: config for `tools/lane_runner.py`, which claims ready Switchboard
  tasks per agent lane and runs a local command on each (see the module docstring).

**Security note on the lane runner:** it feeds task text straight into the lane's command and runs
it with the operator's privileges, so whoever can get a task onto a lane's ready pile can get code
run as you. `trusted_creators` is the gate. What it guarantees: a task runs only when its
`created_by` (set server-side from the caller's token, so it can't be forged inside the task) is in
the list, no event in the history `show` returns shows an agent outside the list editing the title
or body, and the worker's prompt includes only comments written by trusted authors. Keep it tight,
and treat `skip_boards`, `skip_cards` and `manual_markers` as the last line of defense, not the
first.

## Client setup

`clients/` has per-agent setup notes and the shared rules block:

- `clients/AGENTS.md`: paste into each agent's instruction file (the shared task-list protocol).
- `clients/claude-code/`: MCP entries plus a SessionStart check-in hook.
- `clients/codex/`: `config.toml` snippet.
- `clients/hermes/`: HTTP connector config and migration notes.
- `clients/rest/`: curl examples for agents without an MCP client.
