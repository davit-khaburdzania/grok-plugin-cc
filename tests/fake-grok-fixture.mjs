/**
 * Fake `grok` CLI for tests.
 *
 * `installFakeGrok(binDir, options)` writes an executable `grok` script that
 * emulates the subset of the real CLI the plugin uses:
 *
 *   grok --version
 *   grok models
 *   grok export <session-id>
 *   grok --prompt-file <file> --output-format streaming-json [flags...]
 *
 * Behaviour is driven by environment variables so each test can shape it:
 *
 *   FAKE_GROK_LOG            JSONL file; every invocation appends {argv, cwd, prompt, sessionId}
 *   FAKE_GROK_AUTH           "logged-in" (default) | "not-authenticated"
 *   FAKE_GROK_SCENARIO       inline JSON scenario (see below)
 *   FAKE_GROK_SCENARIO_FILE  path to a JSON scenario file (used when FAKE_GROK_SCENARIO is unset)
 *
 * Scenario shape (all fields optional):
 *   {
 *     "response": "final assistant text",          // default response
 *     "events": [ {...grok event...}, ... ],        // extra events emitted before the final text
 *     "stopReason": "end_turn",
 *     "exitCode": 0,
 *     "sleepMs": 0,                                  // delay before finishing (for cancel tests)
 *     "structuredOutput": {...},                      // included in the end event when set
 *     "usage": {...}, "numTurns": 2, "totalCostUsd": 0.01,
 *     "cases": [                                      // first case whose `match` regex hits the prompt wins
 *       { "match": "regex", "response": "...", "events": [...], "exitCode": 0, ... }
 *     ]
 *   }
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

const FAKE_GROK_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const argv = process.argv.slice(2);

function readScenario() {
  const inline = process.env.FAKE_GROK_SCENARIO;
  if (inline && inline.trim()) {
    return JSON.parse(inline);
  }
  const file = process.env.FAKE_GROK_SCENARIO_FILE;
  if (file && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return {};
}

function logInvocation(record) {
  const logFile = process.env.FAKE_GROK_LOG;
  if (!logFile) {
    return;
  }
  fs.appendFileSync(logFile, JSON.stringify(record) + "\\n", "utf8");
}

function getFlag(name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function hasFlag(name) {
  return argv.includes(name);
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const loggedIn = (process.env.FAKE_GROK_AUTH ?? "logged-in") !== "not-authenticated";

async function main() {
  if (argv[0] === "--version" || argv[0] === "-v") {
    logInvocation({ argv, cwd: process.cwd() });
    process.stdout.write("grok 1.0.5 (fake)\\n");
    return 0;
  }

  if (argv[0] === "models") {
    logInvocation({ argv, cwd: process.cwd() });
    process.stdout.write((loggedIn ? "You are logged in with grok.com." : "You are not authenticated.") + "\\n\\n");
    process.stdout.write("Default model: grok-4.6\\n\\nAvailable models:\\n  * grok-4.6 (default)\\n  - grok-4.5\\n");
    return 0;
  }

  if (argv[0] === "export") {
    const sessionId = argv[1] ?? "";
    logInvocation({ argv, cwd: process.cwd() });
    if (!sessionId) {
      process.stderr.write("error: missing session id\\n");
      return 2;
    }
    process.stdout.write("## User\\n\\nFake prompt for " + sessionId + "\\n\\n## Assistant\\n\\nFake answer for " + sessionId + "\\n");
    return 0;
  }

  const promptFile = getFlag("--prompt-file");
  const inlinePrompt = getFlag("-p") ?? getFlag("--single");
  const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : inlinePrompt ?? "";
  const resumeId = getFlag("--resume");
  const sessionId = resumeId ?? getFlag("--session-id") ?? crypto.randomUUID();
  const outputFormat = getFlag("--output-format") ?? "plain";

  const scenario = readScenario();
  let selected = { ...scenario };
  delete selected.cases;
  for (const candidate of scenario.cases ?? []) {
    if (candidate.match && new RegExp(candidate.match, "s").test(prompt)) {
      selected = { ...selected, ...candidate };
      break;
    }
  }

  logInvocation({
    argv,
    cwd: process.cwd(),
    prompt,
    sessionId,
    resume: Boolean(resumeId),
    tools: getFlag("--tools"),
    disallowedTools: getFlag("--disallowed-tools"),
    sandbox: getFlag("--sandbox"),
    model: getFlag("--model"),
    effort: getFlag("--reasoning-effort"),
    maxTurns: getFlag("--max-turns"),
    alwaysApprove: hasFlag("--always-approve"),
    noPlan: hasFlag("--no-plan"),
    outputFormat
  });

  if (!loggedIn) {
    const message = "Not signed in. To authenticate without a browser, run:\\n  grok login --device-code";
    if (outputFormat === "streaming-json") {
      emit({ type: "error", message });
    } else {
      process.stdout.write(JSON.stringify({ type: "error", message }) + "\\n");
    }
    process.stderr.write("Error: " + message + "\\n");
    return 1;
  }

  if (selected.notice) {
    process.stdout.write(selected.notice + "\\n");
  }

  const response = selected.response ?? "Fake Grok response.";
  const exitCode = Number.isInteger(selected.exitCode) ? selected.exitCode : 0;
  const stopReason = selected.stopReason ?? "end_turn";
  const sleepMs = Number(selected.sleepMs) || 0;
  const usage = selected.usage ?? { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 };
  const numTurns = Number.isInteger(selected.numTurns) ? selected.numTurns : 1;
  const totalCostUsd = typeof selected.totalCostUsd === "number" ? selected.totalCostUsd : 0.0123;

  if (outputFormat !== "streaming-json") {
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
    const payload = { text: response, stopReason, sessionId, usage, num_turns: numTurns, total_cost_usd: totalCostUsd };
    if (selected.structuredOutput !== undefined) {
      payload.structuredOutput = selected.structuredOutput;
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + "\\n");
    return exitCode;
  }

  emit({ type: "available_commands", tools: ["read_file", "grep", "list_dir"] });
  for (const event of selected.events ?? []) {
    if (event && event.type === "sleep") {
      await sleep(Number(event.ms) || 0);
      continue;
    }
    emit(event);
  }
  if (selected.thought) {
    emit({ type: "thought", data: selected.thought });
  }
  if (sleepMs > 0) {
    // Keep the process alive so cancel tests can observe a running job.
    emit({ type: "text", data: "Working..." });
    await sleep(sleepMs);
  }
  if (selected.errorMessage) {
    emit({ type: "error", message: selected.errorMessage });
  }
  if (response) {
    emit({ type: "text", data: response });
  }
  if (selected.omitEnd) {
    return exitCode;
  }
  const end = {
    type: "end",
    stopReason,
    sessionId,
    requestId: crypto.randomUUID(),
    usage,
    num_turns: numTurns,
    total_cost_usd: totalCostUsd
  };
  if (selected.structuredOutput !== undefined) {
    end.structuredOutput = selected.structuredOutput;
  }
  emit(end);
  if (selected.stderr) {
    process.stderr.write(selected.stderr + "\\n");
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + "\\n");
    process.exitCode = 1;
  }
);
`;

export function installFakeGrok(binDir) {
  const scriptPath = path.join(binDir, "grok");
  writeExecutable(scriptPath, FAKE_GROK_SOURCE);
  return scriptPath;
}

export function buildEnv(binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    GROK_PLUGIN_BIN: path.join(binDir, "grok"),
    FAKE_GROK_LOG: path.join(binDir, "invocations.jsonl"),
    FAKE_GROK_AUTH: "logged-in"
  };
  delete env.FAKE_GROK_SCENARIO;
  delete env.FAKE_GROK_SCENARIO_FILE;
  delete env.GROK_COMPANION_SESSION_ID;
  delete env.GROK_COMPANION_TRANSCRIPT_PATH;
  delete env.GROK_COMPANION_DATA_DIR;
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.XAI_API_KEY;
  return { ...env, ...extra };
}

export function readInvocations(binDir) {
  const logFile = path.join(binDir, "invocations.jsonl");
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function headlessInvocations(binDir) {
  return readInvocations(binDir).filter((record) => record.outputFormat !== undefined);
}

export function scenarioEnv(scenario) {
  return { FAKE_GROK_SCENARIO: JSON.stringify(scenario) };
}
