# Privacy

agent-tree collects no data and makes no network requests. It reads the agent activity of your current Claude Code session and shows it on your screen. Its only storage is the per-session history Claude Code keeps on your own machine, so a resumed session still shows its earlier agents.

- **Hooks:** it listens to session, turn, prompt, notification, agent start and stop, and tool-call events to build the tree. Every hook passes the event on unchanged.
- **Side sessions:** the Claude desktop app emits `mcp__ccd_session__start_session` when it starts one. Agent tree uses that call to record it.
- **Storage:** each conversation's tree is kept in Claude Code's own per-plugin store on your machine.
- **Conversation view:** `/agent-tree open <agent>` calls `$.ui.view` to switch the app's own view to that agent's conversation. It moves the screen on your machine and sends nothing.
- **Clipboard:** `/agent-tree export` and the pane's Copy button copy the outline to your clipboard, and only when you use them.

Questions: [open an issue](https://github.com/behnamazimi/agent-tree/issues).
