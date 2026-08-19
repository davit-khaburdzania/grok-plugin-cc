import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      grokSessionId: typeof value.grokSessionId === "string" && value.grokSessionId.trim() ? value.grokSessionId.trim() : null,
      grokPid: Number.isFinite(value.grokPid) ? value.grokPid : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    grokSessionId: null,
    grokPid: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const claudeSessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(claudeSessionId ? { claudeSessionId } : {})
  };
}

/**
 * Returns a progress listener that mirrors phase / Grok session id / Grok pid
 * changes into the state file and the per-job JSON file.
 */
export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastGrokSessionId = null;
  let lastGrokPid = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.grokSessionId && normalized.grokSessionId !== lastGrokSessionId) {
      lastGrokSessionId = normalized.grokSessionId;
      patch.grokSessionId = normalized.grokSessionId;
      changed = true;
    }

    if (normalized.grokPid && normalized.grokPid !== lastGrokPid) {
      lastGrokPid = normalized.grokPid;
      patch.grokPid = normalized.grokPid;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[grok] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function isJobCancelled(workspaceRoot, jobId) {
  const stored = readStoredJobOrNull(workspaceRoot, jobId);
  return stored?.status === "cancelled";
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

/**
 * Run `runner` while keeping the job record in sync: running -> completed /
 * failed, with the final payload, rendered output, Grok session id, and usage.
 */
export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    if (isJobCancelled(job.workspaceRoot, job.id)) {
      appendLogLine(options.logFile ?? job.logFile ?? null, "Run ended after the job was cancelled; keeping the cancelled state.");
      return { ...execution, cancelled: true };
    }
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const completionPatch = {
      status: completionStatus,
      grokSessionId: execution.grokSessionId ?? null,
      usage: execution.usage ?? null,
      grokPid: null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt
    };
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      ...completionPatch,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      ...completionPatch,
      summary: execution.summary
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isJobCancelled(job.workspaceRoot, job.id)) {
      appendLogLine(options.logFile ?? job.logFile ?? null, `Run failed after the job was cancelled (${errorMessage}); keeping the cancelled state.`);
      throw error;
    }
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      grokPid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      grokPid: null,
      errorMessage,
      completedAt
    });
    appendLogLine(options.logFile ?? job.logFile ?? null, `Failed: ${errorMessage}`);
    throw error;
  }
}
