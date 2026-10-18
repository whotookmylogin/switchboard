# Codex

1. Add the server from `config.toml.snippet` to `~/.codex/config.toml`.
2. Paste the rules block from [`../AGENTS.md`](../AGENTS.md) into `~/.codex/AGENTS.md`, lane `codex`.

Codex defers MCP tool schemas until it needs them. If a session says the tools are unavailable, the
AGENTS.md rules naming the tools (`find`, `claim`, ... on a per-connector server, or `tasks__find`,
`tasks__claim`, ... on the combined `/mcp` server) are usually enough for it to load them.
