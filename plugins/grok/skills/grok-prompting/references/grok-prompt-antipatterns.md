# Grok Prompt Anti-Patterns

Avoid these when prompting Grok Build.

## Vague task framing

Bad:

```text
Take a look at this and let me know what you think.
```

Better:

```xml
<task>
Review this change for material correctness and regression risks.
</task>
```

## Missing done definition

Bad:

```text
Investigate and report back.
```

Better:

```xml
<structured_output_contract>
Final message returns:
1. root cause
2. evidence
3. smallest safe next step
</structured_output_contract>
```

## Diagnosis and fix mixed into one ambiguous ask

Bad:

```text
Figure out what is wrong and just fix it, or tell me what you found.
```

Better:
- Pick one. For a read-only pass, run `task` without `--write` and ask for a diagnosis only.
- For a fix, run `task --write` and state that Grok must apply the change and report touched files.
- If both are needed, diagnose first, then follow up with `task --resume-last` to apply the fix.

## Missing verification rules

Bad:

```text
Fix the bug.
```

Better:

```xml
<verification_loop>
Before finalizing, verify that the fix matches the task requirements and that the changed code is coherent.
</verification_loop>
```

## Overlong natural-language context instead of contracts

Bad:

```text
So there is this long history where the service used to work but then someone
changed the retry logic and now sometimes it fails, and we think maybe the
config is wrong, and also the logs are confusing, so please read everything
and use your judgment about what matters here.
```

Better:

```xml
<task>
Diagnose why the retry path fails intermittently after the recent retry-logic change.
</task>

<missing_context_gating>
Do not guess. Use grep and read_file to confirm the retry and config code paths.
</missing_context_gating>
```

## Raising effort before tightening the prompt

Bad:

```text
Set --effort max and think very hard.
```

Better:
- Leave `--effort` unset. Add a `verification_loop` and a clear output contract first.

```xml
<verification_loop>
Before finalizing, verify that the answer matches the observed evidence and task requirements.
</verification_loop>
```

## Repeating the whole context on a follow-up

Bad:

```text
Here is the full original prompt again, plus: now apply the top fix.
```

Better:
- Use `task --resume-last` and send only the delta. The session already holds the prior context.

```xml
<task>
Apply the top fix from the previous run. Do not restate the earlier diagnosis.
</task>
```

## Forgetting --write when edits are required

Bad:

```text
task "Refactor the module and update the callers."
```

The default read-only sandbox blocks writes, so Grok cannot apply the edits.

Better:

```text
task --write "Refactor the module and update the callers."
```

## Asking Grok to poll or wait

Bad:

```text
Start the job, then keep checking every minute until it finishes.
```

Better:
- Do not ask Grok to poll, sleep, or wait for background work.
- Run one bounded `task`. If the work is long, hand it to the runtime with `--background` and let the job id return.

## Unbounded subagent spawning

Bad:

```text
Break this into as many parallel subagents as you want.
```

Better:

```xml
<action_safety>
Keep the run bounded. Do not spawn subagents.
</action_safety>
```
