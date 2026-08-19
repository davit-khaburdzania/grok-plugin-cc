---
description: Export the full Grok session transcript for a finished job (or any Grok session ID) as Markdown
argument-hint: '[job-id|grok-session-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" transcript "$ARGUMENTS"`

Present the command output to the user as-is. It is the Markdown transcript that `grok export` produced for the session, preceded by the session ID and the `grok --resume <session-id>` command.
Do not summarize it unless the user asks for a summary.
