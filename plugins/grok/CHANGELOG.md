# Changelog

## 0.2.0

- Add `/grok:implement`: Claude writes a concrete plan, Grok implements it as a write-capable worker, Claude waits, verifies the diff and the plan's commands, and sends follow-ups to the same Grok session when needed.
- Add the `implement` helper subcommand (`--plan-file`, stdin, `--verify`, `--title`, `--no-subagents`, `--resume-last`, `--background`) and the `implement` job kind in `/grok:status`.
- Task summaries skip Markdown headings so `/grok:status` shows the first real sentence of Grok's report.

## 0.1.0

- Initial version of the Grok Build plugin for Claude Code.
- `/grok:review` and `/grok:adversarial-review` run read-only Grok reviews with structured findings.
- `/grok:rescue` delegates tasks to Grok through the `grok:grok-rescue` subagent, with `--resume`, `--fresh`, `--model`, `--effort`, and background execution.
- `/grok:transfer` seeds a resumable Grok session from the current Claude Code transcript.
- `/grok:status`, `/grok:result`, `/grok:transcript`, and `/grok:cancel` manage tracked jobs.
- `/grok:setup` checks the Grok CLI, authentication, and models, and toggles the optional stop-time review gate.
