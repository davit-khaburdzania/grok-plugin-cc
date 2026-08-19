---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Claude Code
user-invocable: false
---

# Grok Runtime

Use this skill only inside the `grok:grok-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `grok` CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, `transcript`, or `cancel` from `grok:grok-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `grok-prompting` skill to rewrite the user's request into a tighter Grok prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Default to a write-capable Grok run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

How the runtime runs Grok:
- Every `task` is one headless `grok` process (`--prompt-file`, `--output-format streaming-json`, `--always-approve`, `--no-plan`).
- `--write` maps to `--sandbox workspace` (writes limited to the repository, `/tmp`, and `~/.grok`). Without `--write` the run uses `--sandbox read-only`.
- `--sandbox <profile>` overrides the profile (`off`, `workspace`, `read-only`, `strict`, or a custom profile from `~/.grok/sandbox.toml`).
- `--max-turns <n>` caps the agent loop.
- `--resume-last` continues the latest tracked Grok session for this repository with `grok --resume <session-id>`; Grok keeps that session's original sandbox, so a read-only session cannot be resumed with `--write`.
- `--background` hands the run to a detached worker and returns the job id immediately.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as execution control only. Strip `--wait`; keep `--background` as the `task` flag, and do not treat either as natural-language task text.
- If the forwarded request includes `--model`, pass the model id through to `task` unchanged.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Grok work in `grok:grok-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Grok cannot be invoked, return nothing.
