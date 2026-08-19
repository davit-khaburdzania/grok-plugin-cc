---
description: Check whether the local Grok Build CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(curl -fsSL https://x.ai/cli/install.sh | bash), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

If the result says Grok is unavailable (`grok.available` is `false`):
- Use `AskUserQuestion` exactly once to ask whether Claude should install Grok Build now with the official installer.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Grok Build (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

If Grok is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user in a compact, readable form: status, each check, the available models, and the next steps.
- If installation was skipped, present the original setup output.
- If Grok is installed but not authenticated, preserve the guidance to run `!grok login` (or `!grok login --device-code`, or export `XAI_API_KEY`).
- Never ask the user for an API key or token in chat.
