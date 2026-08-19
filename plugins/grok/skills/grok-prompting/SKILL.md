---
name: grok-prompting
description: Internal guidance for composing Grok Build prompts for coding, review, diagnosis, and research tasks inside the Grok Claude Code plugin
user-invocable: false
---

# Grok Prompting

Use this skill when `grok:grok-rescue` needs to shape a request into a tighter Grok Build prompt before the single `task` handoff.

Prompt Grok like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:
- Prefer one clear task per Grok run. Split unrelated asks into separate runs.
- Tell Grok what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising reasoning effort or adding long natural-language explanations.
- Use XML tags consistently so the prompt has stable internal structure.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Grok should do by default instead of asking routine questions.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>` or `<citation_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review or adversarial review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Grok stays narrow and avoids unrelated refactors.

How to choose prompt shape:
- Use the built-in `review` or `adversarial-review` commands when the job is reviewing local git changes. Those prompts already carry the review contract. `grok:grok-rescue` forwards only to `task`, so route review-style asks by saying they belong to the review commands rather than to a `task` run.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- Use `task --resume-last` for follow-up instructions on the same Grok session. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Use stable XML tag names that match the block names in the reference file.
- Do not raise reasoning effort or complexity first. Tighten the prompt and verification rules before escalating. Grok's `--effort` flag accepts `none, minimal, low, medium, high, xhigh, max`; leave it unset unless the user asked for a specific effort.
- Ask Grok for brief, outcome-based progress updates only when the task is long-running or tool-heavy.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Grok runtime facts you can rely on in prompts:
- Grok runs headless with `--always-approve`. A write run uses a `workspace` sandbox (edits limited to the repository, `/tmp`, and `~/.grok`); without `--write` it uses a `read-only` sandbox.
- Grok has built-in tools: `shell`, `read_file`, `search_replace`, `write`, `grep`, `list_dir`, `web_search`, `web_fetch`, `spawn_subagent`, and `todo_write`. You can name these when a prompt needs a specific tool path.

## Grok-specific notes

- Grok in headless mode writes a short preamble before it acts and a final message after it finishes. Ask for the final message to carry the answer, the diagnosis, or the report. Do not rely on the preamble to hold the result.
- Grok reads `AGENTS.md` and project rules automatically. Do not restate repository conventions, style rules, or build commands that already live in those files.
- Grok may spawn subagents through `spawn_subagent`. When the task must stay bounded, small, or single-threaded, say "do not spawn subagents".
- Prefer `task --resume-last` for follow-ups instead of repeating context. Grok sessions persist and are resumable with `grok --resume <session-id>`, so the prior context is already loaded. A read-only session keeps its sandbox on resume and cannot switch to `--write`.

Prompt assembly checklist:
1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether Grok should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety tags only where the task needs them.
5. Remove redundant instructions before sending the prompt.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/grok-prompt-recipes.md](references/grok-prompt-recipes.md).
Common failure modes to avoid live in [references/grok-prompt-antipatterns.md](references/grok-prompt-antipatterns.md).
