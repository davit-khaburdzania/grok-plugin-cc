---
description: Show the stored final output for a finished Grok job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, touched files, usage, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- The Grok session ID and the `grok --resume <session-id>` command
- Follow-up commands such as `/grok:status <id>`, `/grok:transcript <id>`, and `/grok:review`
