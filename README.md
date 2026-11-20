# pi-rex-agents

Named pi subagents that run in Rex panes. Each agent is a normal interactive pi, so you can click into its pane and talk to it.

## Install

```sh
pi install /Users/maxpaulus/c/pi-rex-agents
```

For agents on another Rex host, install it there too. Update both hosts together so they use the same result handoff format.

## Tools (for the master agent)

| Tool | What it does |
| --- | --- |
| `agent_spawn` | Starts a named agent in a separate interactive terminal and returns at once. Override the layout with `split`, `float`, or `window`. |
| `agent_send` | Types a message into a running agent's pane, or resumes a settled agent with it. |
| `agent_list` | Lists agents and agent definitions. |

Agents in the current session start in named, minimized floating panes by default. Agents on another host or outside the current session default to a separate window.

Pi shows active agents and their status in the **Agents** row above the input. In fullscreen mode, click an agent to restore and focus its pane. Results and questions arrive automatically.

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
- **Settle:** when a child settles, it writes its last reply to a handoff file in `~/.pi/agent/rex-agents/` and exits. The parent removes the file after the full reply is recorded in its session. Session history stays available for resume. It stays open if the run was aborted or if it still waits on its own subagents. A pane waiting on `ask_parent` has not settled, so it stays open too.
- **Resume:** start the agent again with the same `--session-id`.
