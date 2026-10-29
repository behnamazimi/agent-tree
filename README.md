# agent-tree

**See every agent your Claude Code session is running, live, in one place.**

When Claude splits a task across subagents and side sessions, the work goes out of view: a few lines saying "agent launched", then you wait. Agent tree is a Claude Code mod that keeps those agents on screen as a live tree. It shows who started whom, what each one is doing right now, what it costs, and which one is waiting on you.

https://github.com/user-attachments/assets/44ef8b02-0e60-4137-b985-e88accf5466a

## Commands

```text
/agent-tree               open the pane
/agent-tree on | off      record this session or stop recording it
/agent-tree all           show or hide folded finished agents
/agent-tree open <agent>  jump to an agent's conversation (id prefix, part of its name, or main)
/agent-tree export        copy a Markdown outline of the whole tree
```

`export` copies something you can paste into a PR or a standup note:

```markdown
3 agents · 1 running · 2 done · 57 calls · $2.14 · waited on you 1m02

- **this session** (run, opus-5-5, 6 calls, $0.33, 6m20)
  - **Map the API surface** (done, sonnet-5-5, 18 calls, $0.40, 1m52): Found 23 routes across 4 routers
  - **Review auth flow** (done, sonnet-5-5, 22 calls, $1.03, 4m10): Token refresh skips expiry check
  - **Write migration tests** (run, sonnet-5-5, 11 calls, $0.38, 3m05)
```

> [!NOTE]
> Costs are shown only when Claude Code reports what the session spent. Otherwise each node shows the tokens it used.

> [!TIP]
> The desktop app has a single conversation view, so `open <agent>` cannot switch to a subagent there. It prints that agent's task, latest action and result instead.

## Install

```bash
claude plugin marketplace add behnamazimi/agent-tree
claude plugin install agent-tree@behnamazimi-plugins
```
