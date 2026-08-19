# Changelog

## 0.1.0

- Initial version of the Grok Build plugin for Claude Code.
- `/grok:review` and `/grok:adversarial-review` run read-only Grok reviews with structured findings.
- `/grok:rescue` delegates tasks to Grok through the `grok:grok-rescue` subagent, with `--resume`, `--fresh`, `--model`, `--effort`, and background execution.
- `/grok:transfer` seeds a resumable Grok session from the current Claude Code transcript.
- `/grok:status`, `/grok:result`, `/grok:transcript`, and `/grok:cancel` manage tracked jobs.
- `/grok:setup` checks the Grok CLI, authentication, and models, and toggles the optional stop-time review gate.
