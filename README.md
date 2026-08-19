# Grok Build plugin for Claude Code

Use [Grok Build](https://github.com/xai-org/grok-build) from inside Claude Code for code reviews or to delegate tasks to Grok.

This plugin is for Claude Code users who want to call xAI's Grok coding agent from the workflow they already have.

## What You Get

- `/grok:review` for a read-only Grok code review with structured findings
- `/grok:adversarial-review` for a steerable challenge review of the design and assumptions
- `/grok:rescue`, `/grok:transfer`, `/grok:status`, `/grok:result`, `/grok:transcript`, and `/grok:cancel` to delegate work, hand off sessions, and manage background jobs
- `/grok:setup` to check the Grok CLI, authentication, available models, and the optional stop-time review gate

## Requirements

- **Grok Build CLI** (`grok`) installed and signed in.
  Sign in with your grok.com account (`grok login`) or an xAI API key (`XAI_API_KEY`).
  Usage counts against your Grok plan or API credits.
- **Node.js 18.18 or later**
- **Git** for the review commands

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add davit-khaburdzania/grok-plugin-cc
```

Install the plugin:

```bash
/plugin install grok@grok-build
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/grok:setup
```

`/grok:setup` tells you whether Grok is ready.
If the `grok` CLI is missing, it can offer to install it with the official installer.

If you prefer to install Grok Build yourself, use:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

If Grok is installed but not signed in yet, run:

```bash
!grok login
```

Use `!grok login --device-code` on a machine without a browser, or export `XAI_API_KEY`.

After install, you should see:

- the slash commands listed below
- the `grok:grok-rescue` subagent in `/agents`

One simple first run is:

```bash
/grok:review --background
/grok:status
/grok:result
```

## Usage

### `/grok:review`

Runs a Grok code review on your current work.
Grok gets the diff, read-only file access (`read_file`, `grep`, `list_dir`), and a structured output contract.
It returns a verdict, a summary, findings ordered by severity with file and line references, and next steps.

> [!NOTE]
> Reviews of multi-file changes can take a few minutes.
> It is generally recommended to run them in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review.
It also supports `--wait`, `--background`, `--model <model>`, `--effort <effort>`, and optional focus text after the flags.

Examples:

```bash
/grok:review
/grok:review --base main
/grok:review --background
/grok:review --background pay attention to the new retry logic
```

This command is read-only and will not perform any changes.
Grok runs with a read-only tool allowlist and the `read-only` sandbox profile.
When run in the background you can use [`/grok:status`](#grokstatus) to check on the progress and [`/grok:cancel`](#grokcancel) to cancel the ongoing task.

Small diffs (up to 2 files and 256 KB) are inlined into the prompt.
Larger diffs are written to a context file that Grok reads with its file tools.

### `/grok:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/grok:review`, including `--base <ref>` for branch review.
It also supports `--wait`, `--background`, `--model`, and `--effort`, and it takes extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/grok:adversarial-review
/grok:adversarial-review --base main challenge whether this was the right caching and retry design
/grok:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only.
It does not fix code.

### `/grok:rescue`

Hands a task to Grok through the `grok:grok-rescue` subagent.

Use it when you want Grok to:

- investigate a bug
- try a fix
- continue a previous Grok task
- take a pass with a different model or reasoning effort

> [!NOTE]
> Depending on the task and the model you choose these tasks can take a long time.
> It is generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`.
If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repo.

Examples:

```bash
/grok:rescue investigate why the tests started failing
/grok:rescue fix the failing test with the smallest safe patch
/grok:rescue --resume apply the top fix from the last run
/grok:rescue --model grok-4.5 --effort medium investigate the flaky integration test
/grok:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Grok:

```text
Ask Grok to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Grok uses the defaults from your `~/.grok/config.toml`
- valid `--effort` values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`
- rescue runs are write-capable by default and use Grok's `workspace` sandbox (writes limited to the repository, `/tmp`, and `~/.grok`); read-only runs use the `read-only` sandbox
- follow-up rescue requests continue the latest Grok session in the repo with `grok --resume`
- a resumed session keeps its original sandbox, so a read-only session cannot be continued with edits; start a fresh one instead

### `/grok:transfer`

Creates a persistent Grok session from the current Claude Code session and prints a `grok --resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Grok.

Examples:

```bash
/grok:transfer
/grok:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override.
The transfer converts the Claude transcript into a Markdown digest (user and assistant turns, summarized tool calls), seeds a new Grok session with it, and asks Grok for a short handover note.
The source must be under `~/.claude/projects`.
Transcripts larger than 160 KB keep the first turn and the latest turns that fit.

### `/grok:status`

Shows running and recent Grok jobs for the current repository.

Examples:

```bash
/grok:status
/grok:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job, including token usage and cost
- confirm whether a task is still running

### `/grok:result`

Shows the final stored Grok output for a finished job.
It also includes the Grok session ID so you can reopen that run directly in Grok with `grok --resume <session-id>`.

Examples:

```bash
/grok:result
/grok:result task-abc123
```

### `/grok:transcript`

Exports the full Grok session transcript for a finished job, or for any Grok session ID, as Markdown.
It wraps `grok export <session-id>`.

Examples:

```bash
/grok:transcript
/grok:transcript task-abc123
/grok:transcript 01a019aa-6bae-7122-848f-f132112ba1d6
```

### `/grok:cancel`

Cancels an active background Grok job.
The partial Grok session stays resumable with `grok --resume <session-id>`.

Examples:

```bash
/grok:cancel
/grok:cancel task-abc123
```

### `/grok:setup`

Checks whether Grok is installed and authenticated, and lists the available models.
If Grok is missing, it can offer to install it with the official installer.

You can also use `/grok:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted read-only Grok review based on Claude's response.
If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Grok loop and may drain usage limits quickly.
> Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/grok:review
```

### Hand A Problem To Grok

```bash
/grok:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/grok:adversarial-review --background
/grok:rescue --background investigate the flaky test
```

Then check in with:

```bash
/grok:status
/grok:result
```

## Grok Integration

The plugin wraps the Grok Build CLI in headless mode.
Every review or task is one `grok` process started with `--prompt-file`, `--output-format streaming-json`, `--always-approve`, and `--no-plan`.
It uses the global `grok` binary installed in your environment (`$GROK_PLUGIN_BIN`, then `grok` on `PATH`, then `~/.grok/bin/grok`) and applies the same configuration.

| Plugin behavior | Grok CLI feature |
| --- | --- |
| Progress in `/grok:status` | `streaming-json` tool call events |
| Read-only reviews | `--tools read_file,list_dir,grep` and `--sandbox read-only` |
| Write-capable rescue | `--sandbox workspace` |
| Follow-up on a task | `--resume <session-id>` |
| Known session ID while running | `--session-id <uuid>` |
| `/grok:transcript` | `grok export <session-id>` |
| Usage and cost lines | `usage`, `num_turns`, `total_cost_usd` from the `end` event |

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, define that in your Grok config.
For example, to always use `grok-4.5` with `high` effort, add this to `~/.grok/config.toml`:

```toml
[models]
default = "grok-4.5"
default_reasoning_effort = "high"
```

Per-run overrides use `--model` and `--effort` on `/grok:review`, `/grok:adversarial-review`, and `/grok:rescue`.

### Moving The Work Over To Grok

Delegated tasks, reviews, and stop-gate runs can be resumed inside Grok by running `grok --resume <session-id>` with the session ID from `/grok:result` or `/grok:status`.
This way you can inspect Grok's work or continue it there.

### Where State Lives

Job state (status, logs, prompts, review context files) is stored per repository under the plugin data directory that Claude Code provides (`CLAUDE_PLUGIN_DATA`), re-exported as `GROK_COMPANION_DATA_DIR` by the plugin's `SessionStart` hook.
Outside Claude Code it falls back to `grok-companion` in the OS temp directory.
The plugin keeps the 50 most recent jobs per repository.

## FAQ

### Do I need a separate Grok account for this plugin?

No.
The plugin uses your local Grok CLI authentication.
If you are already signed in with `grok login` or have `XAI_API_KEY` set, that account works here too.

### Does the plugin use a separate Grok runtime?

No.
This plugin delegates through your local Grok Build CLI on the same machine.

That means:

- it uses the same Grok install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Grok config I already have?

Yes.
The plugin picks up your `~/.grok/config.toml` (models, effort, sandbox profiles, MCP servers, and so on).

### Can I use a custom sandbox profile?

Yes.
Pass `--sandbox <profile>` to `/grok:rescue` (forwarded to the `task` helper) with `off`, `workspace`, `read-only`, `strict`, or a custom profile from `~/.grok/sandbox.toml`.

## Development

```bash
npm test
npm run check-version
node scripts/bump-version.mjs 0.2.0
```

Tests run against a fake `grok` binary, so they do not need a Grok account.

## License

Apache-2.0.
See [LICENSE](LICENSE) and [NOTICE](NOTICE).
