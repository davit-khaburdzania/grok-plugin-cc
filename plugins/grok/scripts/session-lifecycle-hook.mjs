#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { DATA_DIR_ENV, PLUGIN_DATA_ENV, loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    raw = "";
  }
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.claudeSessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    for (const pid of [job.grokPid, job.pid]) {
      try {
        terminateProcessTree(pid ?? Number.NaN);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.claudeSessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  // Hooks receive the plugin-specific data dir; re-export it under a dedicated
  // name so slash-command Bash calls (which only see the shared session env)
  // resolve the same state directory.
  appendEnvVar(DATA_DIR_ENV, process.env[DATA_DIR_ENV] || process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
