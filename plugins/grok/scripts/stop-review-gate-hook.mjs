#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getGrokAvailability } from "./lib/grok.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

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

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.claudeSessionId === sessionId);
}

function collectRepoStateBlock(cwd) {
  const runGit = (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout.trimEnd();
  };
  const status = runGit(["status", "--short", "--untracked-files=all"]);
  if (status === null) {
    return "";
  }
  const stat = runGit(["diff", "--stat"]) ?? "";
  const stagedStat = runGit(["diff", "--stat", "--cached"]) ?? "";
  return [
    "Repository state at stop time (captured by the plugin, read-only):",
    "git status --short --untracked-files=all:",
    status || "(clean)",
    "git diff --stat:",
    stat || "(no unstaged changes)",
    "git diff --stat --cached:",
    stagedStat || "(no staged changes)"
  ].join("\n");
}

function buildStopReviewPrompt(input = {}, cwd = process.cwd()) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage ? ["Previous Claude response:", lastAssistantMessage].join("\n") : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock,
    REPO_STATE_BLOCK: collectRepoStateBlock(cwd)
  });
}

function buildSetupNote(cwd) {
  const availability = getGrokAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Grok is not set up for the review gate.${detail} Run /grok:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: "The stop-time Grok review task returned no final output. Run /grok:review --wait manually or bypass the gate."
    };
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const decisionIndex = lines.findIndex((line) => line.startsWith("ALLOW:") || line.startsWith("BLOCK:"));
  const decisionLine = decisionIndex === -1 ? "" : lines[decisionIndex];
  if (decisionLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (decisionLine.startsWith("BLOCK:")) {
    const reason = decisionLine.slice("BLOCK:".length).trim() || text;
    const detail = lines.slice(decisionIndex + 1).join("\n").trim();
    return {
      ok: false,
      reason: `Grok stop-time review found issues that still need fixes before ending the turn: ${reason}${detail ? `\n${detail}` : ""}`
    };
  }

  return {
    ok: false,
    reason: "The stop-time Grok review task returned an unexpected answer. Run /grok:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "grok-companion.mjs");
  const prompt = buildStopReviewPrompt(input, cwd);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason: "The stop-time Grok review task timed out after 15 minutes. Run /grok:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Grok review task failed: ${detail}`
        : "The stop-time Grok review task failed. Run /grok:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    // Grok writes a preamble before acting; the decision line lives in the final message.
    return parseStopReviewOutput(payload?.finalSegment ?? payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason: "The stop-time Grok review task returned invalid JSON. Run /grok:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Grok job ${runningJob.id} is still running. Check /grok:status and use /grok:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
