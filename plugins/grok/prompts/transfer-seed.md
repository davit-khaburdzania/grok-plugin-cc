<task>
You are taking over a software engineering conversation that started in Claude Code.
The transcript below is the complete context you have. Future turns in this Grok session continue that work.
</task>

<transfer_metadata>
Claude session: {{CLAUDE_SESSION_ID}}
Working directory: {{CWD}}
Git branch: {{GIT_BRANCH}}
Turns transferred: {{TURN_COUNT}}{{TRUNCATION_NOTE}}
</transfer_metadata>

<instructions>
Read the transcript carefully.
Do not edit files, run commands, or start new work in this turn.
Reply with a short handover note, at most 12 lines, that states:
1. The goal of the conversation.
2. What has been done so far, including files that were changed.
3. What is still open or was left as the next step.
4. Any constraints, decisions, or user preferences that must be preserved.
End with one line: "Ready to continue."
</instructions>

<claude_transcript>
{{TRANSCRIPT}}
</claude_transcript>
