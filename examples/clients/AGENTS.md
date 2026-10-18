# Rules block for agent instruction files

Paste this into each agent's always-loaded instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
Hermes `SOUL.md`, a cloud agent's system prompt). Change the lane name per agent.

```markdown
## Working with the other agents (Switchboard)

- **Shared task list** (`tasks` connector). Before substantial work: `active` + `find` to see if anyone
  already has it, then `claim` a ready task or `start` a new one. `heartbeat` on jobs longer than the
  claim (default 60 min). `complete` with what you did and where (branch, files, links) so the next
  agent can build on it. `release` with a reason if you stop. `block` with exactly what you need if a
  human has to decide. Tasks assigned to your lane (`claude`) are yours to pull. Skip all of this for
  quick questions.
- **Shared memory** (`memory` connector). `recall` before filling in anything official (legal names,
  registration ids, addresses). When the operator corrects you or you learn a durable lesson,
  `remember` it so every agent learns it. Never store passwords or keys; store a pointer to the
  password manager entry instead.
- **Directory** (`lookup` connector). Look up a person, channel, customer or product id instead of
  listing everything.
- **Other agents** (`agents` connector). Ask another agent for information or access with `request`;
  check yours with `inbox`. First contact between two agents waits for the operator's approval.
```
