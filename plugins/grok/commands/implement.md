---
description: Claude plans, Grok implements - write a concrete implementation plan, hand it to Grok as the worker, wait, then verify the result
argument-hint: "[--background|--wait] [--resume|--fresh] [--verify-only [job-id]] [--no-verify] [--model <model>] [--effort <effort>] [--no-subagents] <what to build or change>"
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Bash(pnpm:*), Bash(yarn:*), Bash(npx:*), AskUserQuestion
---

Run the plan-big, execute-small loop with Grok as the worker.
You (Claude) are the planner and the verifier. Grok implements.

Raw user request:
`$ARGUMENTS`

Roles and hard rules:
- Do not implement the change yourself. Your job is to investigate, write the plan, launch Grok, wait, verify, and report.
- Grok runs write-capable (`--sandbox workspace`) in the repository. It edits files directly in the working tree.
- Never fix Grok's code silently. If verification fails, send a follow-up to the same Grok session (see step 5) or ask the user.
- If the helper reports that Grok is missing or unauthenticated, stop and tell the user to run `/grok:setup`.
- If the user did not supply a request, ask what Grok should implement.

Flags (strip them from the request text; do not forward unknown flags to the helper):
- `--background`: launch only. Do not wait or verify. Tell the user the job id and how to continue.
- `--wait` (default when neither flag is present): launch, wait, verify, report.
- `--resume`: follow-up for the latest Grok implement session in this repo. Skip the full plan; write concise follow-up instructions instead, and launch with `--resume-last`.
- `--fresh`: always start a new Grok session.
- `--verify-only [job-id]`: skip planning and launch. Fetch the finished job (`result [job-id]`) and run step 5 and step 6 only.
- `--no-verify`: skip step 5.
- `--model <model>`, `--effort <effort>`, `--no-subagents`: pass through to the helper unchanged. Leave model and effort unset unless the user asked for them.

Step 1 - Plan:
- Investigate with `Read`, `Glob`, `Grep`, and read-only git (`git status --short`, `git log --oneline -20`, `git diff`) until you can name the files, functions, and acceptance criteria. Do not solve the task yourself; stop investigating once the plan is concrete.
- Use `AskUserQuestion` only when different readings of the request would lead to materially different work.
- Write the plan in this Markdown shape and keep it under 150 lines:

```markdown
# Plan: <short title>

## Goal
One or two sentences.

## Context
What exists today that matters: files with paths, functions, conventions, existing tests.

## Steps
1. <file path>: <exact change>. Each step must be independently checkable.
2. ...

## Out of scope
What Grok must not touch or change.

## Verification
Exact commands to run (for example `npm test`, `npx tsc --noEmit`) and any manual checks.

## Acceptance criteria
- ...
```

Step 2 - Launch Grok (always in the background so Claude Code's Bash timeout cannot kill a long run):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" implement --background --title "<short title>" --verify "<verification command>" - <<'PLAN'
<the plan from step 1>
PLAN
```

- Repeat `--verify "<command>"` once per verification command from the plan. The helper adds them to the prompt as planner checks.
- Add `--model`, `--effort`, or `--no-subagents` only when the user asked for them.
- The command prints the job id (`impl-...`). Remember it.
- For `--resume`, use the same command with `--resume-last` and put the follow-up instructions (what is wrong, where, what to do, what to rerun) in the heredoc instead of a full plan.
- If the plan is too long for a heredoc, write it to a file with `Write` and pass `--plan-file <path>` instead of `-`.

Step 3 - Wait (skip when the user passed `--background`):
- Poll with the helper and a long Bash timeout:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status <job-id> --wait --timeout-ms 540000`,
  description: "Wait for Grok implement job",
  timeout: 600000
})
```

- The output shows the job line `- <job-id> | <status> | implement | ...`. Repeat the poll while the status is `queued` or `running`.
- Stop polling after 12 rounds. Tell the user the job is still running and how to check with `/grok:status <job-id>` and later `/grok:implement --verify-only <job-id>`.
- Do not start other work between polls.

Step 4 - Fetch the report:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result <job-id>
```

- Grok's report has the sections Summary, Changes, Verification, Deviations, and Notes for the planner.
- If the job failed or was cancelled, report the error and stop.

Step 5 - Verify (skip only with `--no-verify`):
- Run `git status --short --untracked-files=all` and `git diff` to see exactly what Grok changed. Compare it with the plan: every step done, nothing out of scope touched, no commits or history rewrites.
- Run the plan's verification commands yourself. Do not trust the report's Verification section without rerunning.
- Read the changed files for correctness.
- Decide PASS or NEEDS FOLLOW-UP.
- On NEEDS FOLLOW-UP, and at most two times per request: write concise follow-up instructions (what is wrong, where, what to change, what to rerun) and go back to step 2 with `--resume-last` so Grok continues in the same session. Then wait, fetch, and verify again.
- After two follow-ups, stop and report what still fails. If the remaining issue is a one-line fix, ask the user whether you should fix it directly or send another follow-up.

Step 6 - Report to the user:
- What Grok changed (file list), verification results (each command with pass or fail), deviations, open questions, and remaining issues.
- Include Grok's Summary and Deviations sections verbatim.
- Include the job id, the Grok session id with `grok --resume <session-id>`, and the Usage line from the helper output.
