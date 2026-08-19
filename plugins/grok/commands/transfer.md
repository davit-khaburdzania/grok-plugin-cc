---
description: Transfer the current Claude Code session into a resumable Grok session
argument-hint: "[--source <claude-jsonl>] [--model <model>] [--effort <effort>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Grok session ID, the `grok --resume <session-id>` command, and Grok's handover summary.
