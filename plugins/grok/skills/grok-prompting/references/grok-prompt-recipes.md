# Grok Prompt Recipes

Use these as starting templates for Grok Build `task` prompts.
Copy the smallest recipe that fits the task, then trim anything you do not need.
The `task` prompt text goes to the helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task [flags] "<prompt>"`.
In `grok:grok-rescue`, run fix-oriented recipes with `--write` by default unless the user explicitly asked for read-only behavior.

## Bug Diagnosis (read-only)

Invocation: `task "<prompt>"` (no `--write`, so Grok runs in the `read-only` sandbox)

```xml
<task>
Diagnose why the failing test or command is breaking in this repository.
Use read_file, grep, and list_dir to identify the most likely root cause. Do not edit files.
</task>

<compact_output_contract>
Put the answer in your final message with:
1. most likely root cause
2. evidence
3. smallest safe next step
</compact_output_contract>

<default_follow_through_policy>
Keep going until you have enough evidence to identify the root cause confidently.
Only stop to ask questions when a missing detail changes correctness materially.
</default_follow_through_policy>

<missing_context_gating>
Do not guess missing repository facts.
If required context is absent, state exactly what remains unknown.
</missing_context_gating>
```

## Smallest Safe Fix (--write)

Invocation: `task --write "<prompt>"`

```xml
<task>
Implement the smallest safe fix for the identified issue in this repository.
Preserve existing behavior outside the failing path.
</task>

<structured_output_contract>
In your final message return:
1. summary of the fix
2. touched files
3. verification performed
4. residual risks or follow-ups
</structured_output_contract>

<completeness_contract>
Resolve the task fully before stopping.
Do not stop after identifying the issue without applying the fix.
</completeness_contract>

<verification_loop>
Before finalizing, verify that the fix matches the task requirements and that the changed code is coherent.
</verification_loop>

<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors or cleanup.
</action_safety>
```

## Flaky Test Root-Cause (read-only)

Invocation: `task "<prompt>"`

```xml
<task>
Investigate why this test is flaky. Identify the source of nondeterminism: shared state, ordering, timing, randomness, or external dependencies.
</task>

<compact_output_contract>
Final message returns:
1. the nondeterminism source
2. the exact code path that leaks it
3. the smallest fix that removes it
</compact_output_contract>

<tool_persistence_rules>
Keep reading callers and setup or teardown paths until you can prove the source.
Do not stop after a partial read when another targeted check would change the answer.
</tool_persistence_rules>

<grounding_rules>
Ground every claim in tool outputs. Label any timing or ordering hypothesis as a hypothesis.
</grounding_rules>
```

## Refactor With Verification Loop (--write)

Invocation: `task --write "<prompt>"`

```xml
<task>
Refactor the named module for clarity without changing its observable behavior.
Keep the public API and return types unchanged.
</task>

<structured_output_contract>
Final message returns:
1. what changed and why
2. touched files
3. how you confirmed behavior is unchanged
</structured_output_contract>

<verification_loop>
After each change, re-read the touched code and run the relevant tests.
If behavior differs, revert that step instead of shipping it.
</verification_loop>

<action_safety>
Do not rename public symbols or move files unless the task requires it.
Do not spawn subagents.
</action_safety>
```

## Research Or Recommendation (read-only)

Invocation: `task "<prompt>"`

```xml
<task>
Research the available options and recommend the best path for this task.
Use web_search and web_fetch when repository context is not enough.
</task>

<structured_output_contract>
Final message returns:
1. observed facts
2. reasoned recommendation
3. tradeoffs
4. open questions
</structured_output_contract>

<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Prefer breadth first, then go deeper only where the evidence changes the recommendation.
</research_mode>

<citation_rules>
Back important claims with explicit references to the sources you inspected. Prefer primary sources.
</citation_rules>
```

## Follow-up On A Prior Run (--resume-last)

Invocation: `task --resume-last "<delta instruction>"` (add `--write` only if the prior session was already write-capable)

```xml
<task>
Continue the previous session. Apply the top fix you identified.
Do not restate the earlier diagnosis; the session already holds that context.
</task>

<completeness_contract>
Finish the applied fix, including any follow-on edits it requires.
</completeness_contract>

<verification_loop>
Verify the change against the failing case from the earlier run before finalizing.
</verification_loop>
```

## Review-Style Request (route to review commands)

Do not build a `task` prompt for reviewing local git changes.
The runtime has dedicated `review` and `adversarial-review` commands that already carry the review contract, grounding rules, and JSON output schema.
`grok:grok-rescue` forwards only to `task`, so when a request is a review of local changes, state that it belongs to the `review` or `adversarial-review` command instead of forwarding a `task` run.
