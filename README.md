# pi-rex-agents

Named pi subagents that run in Rex panes. Each agent is a normal interactive pi, so you can click into its pane and talk to it.

## Install

```sh
pi install /Users/maxpaulus/c/pi-rex-agents
```

For agents on another Rex host, install it on that host too.

## Tools (for the master agent)

| Tool | What it does |
| --- | --- |
| `agent_spawn` | Starts a named agent as a `split`, `float`, or `window`, on this machine or on a Rex `host`. Returns at once. |
| `agent_send` | Types a message into a running agent's pane, or resumes a settled agent with it. |
| `agent_list` | Lists agents and agent definitions. |

Results and questions come back on their own, as messages that wake the master.

## Agent files

The extension reads one markdown file per agent from `agents/` in this package, `~/.pi/agent/agents/`, and `.pi/agents/` in trusted projects. A later file with the same name wins.

```markdown
---
name: scout
description: Fast read-only recon
kind: scout            # scout = read-only tools + web; worker = every tool
model: claude-code/claude-sonnet-5-5   # optional; if you leave it out, the agent uses the master's model
thinking: low          # optional
tools: read, grep      # optional allowlist that replaces the kind's default
---
System prompt and personality.
```

## How it uses Rex

- **Spawn:** `session.new_split`, `session.new_layer`, or `session.new_window` with `pi --session-id <id>`. Remote agents go into a `pi-agents` session on the host.
- **Status:** pi reports OSC 7501 program status. The parent follows `rex events` for `program_status_changed` and `block_closed`.
- **Child asks parent:** the child's `ask_parent` opens a pi input dialog, so pi reports `blocked`/`question` with the question. The parent answers with `rex send` + `send-key enter`.
- **Settle:** when a child settles, it writes its last reply to `~/.pi/agent/rex-agents/<id>.md` and exits, which closes its pane. It stays open if the run was aborted or if it still waits on its own subagents. A pane waiting on `ask_parent` has not settled, so it stays open too.
- **Resume:** start the agent again with the same `--session-id`.
