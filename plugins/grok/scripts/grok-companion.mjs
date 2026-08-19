#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { buildClaudeTranscriptDigest, resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  DEFAULT_CONTINUE_PROMPT,
  INSTALL_COMMAND,
  LOGIN_HINT,
  READ_ONLY_REVIEW_TOOLS,
  createGrokSessionId,
  exportGrokSession,
  formatUsageSummary,
  getGrokAuthStatus,
  getGrokAvailability,
  interruptGrokRun,
  normalizeReasoningEffort,
  normalizeSandboxProfile,
  parseStructuredOutput,
  readOutputSchema,
  runGrokTurn
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForCurrentClaudeSession,
  getCurrentClaudeSessionId,
  isActiveJobStatus,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTransferResult
} from "./lib/render.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobContextFile,
  resolveJobPromptFile,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const REVIEW_DISALLOWED_TOOLS = ["search_tool", "use_tool", "spawn_subagent"];

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/grok-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <effort>] [focus text]",
      "  node scripts/grok-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <effort>] [focus text]",
      "  node scripts/grok-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--sandbox <off|workspace|read-only|strict|profile>] [--max-turns <n>] [prompt]",
      "  node scripts/grok-companion.mjs transfer [--source <claude-jsonl>] [--model <model>] [--effort <effort>] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
      "  node scripts/grok-companion.mjs result [job-id] [--json]",
      "  node scripts/grok-companion.mjs transcript [job-id|grok-session-id]",
      "  node scripts/grok-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  return normalized || null;
}

function normalizeMaxTurns(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --max-turns value "${value}". Use a positive integer.`);
  }
  return parsed;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function buildUsageRecord(result) {
  if (!result) {
    return null;
  }
  if (!result.usage && !Number.isFinite(result.numTurns) && !Number.isFinite(result.totalCostUsd)) {
    return null;
  }
  return {
    tokens: result.usage ?? null,
    numTurns: Number.isFinite(result.numTurns) ? result.numTurns : null,
    totalCostUsd: Number.isFinite(result.totalCostUsd) ? result.totalCostUsd : null,
    modelUsage: result.modelUsage ?? null
  };
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable(process.execPath, ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = getGrokAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push(`Install Grok Build with \`${INSTALL_COMMAND}\`, then rerun \`/grok:setup\`.`);
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push(LOGIN_HINT);
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/grok:setup --enable-review-gate` to require a Grok review before each stop.");
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function ensureGrokAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Grok CLI is not installed. Install it with \`${INSTALL_COMMAND}\`, then rerun \`/grok:setup\`.`);
  }
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, extra = {} }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: kind === "adversarial-review" ? "adversarial-review" : jobClass === "review" ? "review" : "rescue",
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...extra
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function findLatestResumableTaskJob(jobs) {
  return jobs.find((job) => job.jobClass === "task" && job.grokSessionId && !isActiveJobStatus(job.status)) ?? null;
}

function resolveLatestTrackedTaskSession(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /grok:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return trackedTask;
  }

  if (getCurrentClaudeSessionId()) {
    return null;
  }

  // Outside Claude (no session id) fall back to any tracked task in this repo.
  return findLatestResumableTaskJob(jobs);
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

function buildReviewCollectionGuidance(context, contextFile) {
  if (context.inputMode === "inline-diff") {
    return `The complete diff is inlined below in <repository_context>; treat it as primary evidence. The same content is also saved at ${contextFile} if you need to page through it with read_file.`;
  }
  return `The change is too large to inline. <repository_context> below only contains the status, stats, and changed-file list. The complete diff (and untracked file bodies) is saved at ${contextFile}; read it with read_file before forming any finding, paging with offset/limit as needed. Then open the real source files for surrounding context.`;
}

function buildReviewPrompt(reviewName, context, focusText, contextFile) {
  const templateName = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  const focusBlock = focusText ? `\n\nExtra focus requested by the user: ${focusText}` : "";
  const reviewInput = context.inputMode === "inline-diff" ? context.fullContent : context.overview;
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: buildReviewCollectionGuidance(context, contextFile),
    OUTPUT_SCHEMA: JSON.stringify(readOutputSchema(REVIEW_SCHEMA), null, 2),
    REVIEW_INPUT: `${reviewInput}${templateName === "review" ? focusBlock : ""}`
  });
}

async function executeReviewRun(request) {
  ensureGrokAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const contextFile = resolveJobContextFile(workspaceRoot, request.jobId);
  fs.writeFileSync(contextFile, `${context.fullContent.trimEnd()}\n`, "utf8");
  request.onProgress?.({
    message: `Collected ${context.fileCount} changed file(s), ${context.diffBytes} diff byte(s) (${context.inputMode}).`,
    phase: "starting"
  });

  const prompt = buildReviewPrompt(reviewName, context, focusText, contextFile);
  const result = await runGrokTurn(context.repoRoot, {
    prompt,
    promptFile: resolveJobPromptFile(workspaceRoot, request.jobId),
    model: request.model,
    effort: request.effort,
    sandbox: "read-only",
    tools: READ_ONLY_REVIEW_TOOLS,
    disallowedTools: REVIEW_DISALLOWED_TOOLS,
    maxTurns: request.maxTurns ?? null,
    onProgress: request.onProgress
  });

  const parsed = parseStructuredOutput(result, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const usageSummary = formatUsageSummary(result);
  const payload = {
    review: reviewName,
    target,
    grokSessionId: result.grokSessionId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary,
      inputMode: context.inputMode,
      contextFile
    },
    grok: {
      status: result.status,
      stopReason: result.stopReason,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary,
      usage: buildUsageRecord(result)
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError
  };

  return {
    exitStatus: result.status,
    grokSessionId: result.grokSessionId,
    usage: buildUsageRecord(result),
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      usageSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Grok ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: `Grok ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd", "max-turns"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const maxTurns = normalizeMaxTurns(options["max-turns"]);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    extra: { model, effort }
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        effort,
        maxTurns,
        focusText,
        reviewName: config.reviewName,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Grok Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Grok Resume" : "Grok Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function resolveTaskSandbox(request, previousJob) {
  if (previousJob) {
    const previousSandbox = previousJob.sandbox ?? (previousJob.write ? "workspace" : "read-only");
    if (request.sandbox && request.sandbox !== previousSandbox) {
      throw new Error(
        `The previous Grok session ran with sandbox "${previousSandbox}". Grok refuses to change a resumed session's sandbox; drop --sandbox or start a new session with --fresh.`
      );
    }
    if (request.write && !previousJob.write && previousSandbox !== "off") {
      throw new Error(
        "The previous Grok session was read-only. Grok keeps a resumed session's sandbox, so edits would fail; start a new write-capable session with --fresh."
      );
    }
    return { sandbox: previousSandbox, write: Boolean(previousJob.write || request.write) };
  }

  const sandbox = normalizeSandboxProfile(request.sandbox, request.write ? "workspace" : "read-only");
  return { sandbox, write: Boolean(request.write) };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let previousJob = null;
  if (request.resumeLast) {
    previousJob = resolveLatestTrackedTaskSession(workspaceRoot, { excludeJobId: request.jobId });
    if (!previousJob) {
      throw new Error("No previous Grok task session was found for this repository. Start a new task without --resume.");
    }
  }

  if (!request.prompt && !previousJob) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const { sandbox, write } = resolveTaskSandbox(request, previousJob);
  if (request.jobId) {
    upsertJob(workspaceRoot, { id: request.jobId, sandbox, write });
  }

  const prompt = request.prompt?.trim() || (previousJob ? DEFAULT_CONTINUE_PROMPT : "");
  const result = await runGrokTurn(workspaceRoot, {
    prompt,
    promptFile: request.jobId ? resolveJobPromptFile(workspaceRoot, request.jobId) : null,
    resumeSessionId: previousJob?.grokSessionId ?? null,
    sessionId: previousJob ? null : createGrokSessionId(),
    model: request.model,
    effort: request.effort,
    sandbox: previousJob ? null : sandbox,
    maxTurns: request.maxTurns ?? null,
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const usageSummary = formatUsageSummary(result);
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write,
      touchedFiles: write ? result.touchedFiles : [],
      usageSummary
    }
  );
  const payload = {
    status: result.status,
    stopReason: result.stopReason,
    grokSessionId: result.grokSessionId,
    resumedFromJobId: previousJob?.id ?? null,
    sandbox,
    write,
    rawOutput,
    touchedFiles: result.touchedFiles,
    commandExecutions: result.commandExecutions,
    reasoningSummary: result.reasoningSummary,
    usage: buildUsageRecord(result),
    stderr: result.stderr,
    error: result.error
  };

  return {
    exitStatus: result.status,
    grokSessionId: result.grokSessionId,
    usage: buildUsageRecord(result),
    payload,
    rendered,
    summary: firstMeaningfulLine(
      result.textSegments?.length ? result.textSegments[result.textSegments.length - 1] : rawOutput,
      firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)
    ),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, request) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write: Boolean(request.write),
    extra: {
      model: request.model ?? null,
      effort: request.effort ?? null,
      sandbox: request.sandbox ?? null
    }
  });
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok:status ${payload.jobId} for progress and /grok:result ${payload.jobId} when it finishes.\n`;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "sandbox", "max-turns"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const maxTurns = normalizeMaxTurns(options["max-turns"]);
  const sandbox = normalizeSandboxProfile(options.sandbox, null);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const request = {
    cwd,
    model,
    effort,
    maxTurns,
    sandbox,
    prompt,
    write,
    resumeLast
  };

  if (options.background) {
    ensureGrokAvailable(cwd);
    const job = buildTaskJob(workspaceRoot, taskMetadata, request);
    const { payload } = enqueueBackgroundTask(cwd, job, { ...request, jobId: job.id });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, request);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...request,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        jobId: storedJob.id,
        onProgress: progress
      }),
    { logFile }
  );
}

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

async function executeTransfer(cwd, options = {}) {
  ensureGrokAvailable(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sourcePath = resolveClaudeSessionPath(cwd, { source: options.source });
  const digest = buildClaudeTranscriptDigest(sourcePath);
  const template = loadPromptTemplate(ROOT_DIR, "transfer-seed");
  const prompt = interpolateTemplate(template, {
    CLAUDE_SESSION_ID: digest.claudeSessionId ?? path.basename(sourcePath, ".jsonl"),
    CWD: digest.cwd ?? workspaceRoot,
    GIT_BRANCH: digest.gitBranch ?? "(unknown)",
    TURN_COUNT: String(digest.turnCount),
    TRUNCATION_NOTE: digest.truncatedTurns ? ` (${digest.truncatedTurns} earlier turn(s) omitted)` : "",
    TRANSCRIPT: digest.markdown
  });

  const sessionId = createGrokSessionId();
  const result = await runGrokTurn(workspaceRoot, {
    prompt,
    sessionId,
    model: options.model ?? null,
    effort: options.effort ?? null,
    sandbox: "read-only",
    tools: READ_ONLY_REVIEW_TOOLS,
    disallowedTools: REVIEW_DISALLOWED_TOOLS,
    onProgress: options.onProgress
  });

  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr ?? "unknown error";
    throw new Error(`Grok could not seed the transferred session: ${detail}`);
  }

  const payload = {
    grokSessionId: result.grokSessionId ?? sessionId,
    resumeCommand: `grok --resume ${result.grokSessionId ?? sessionId}`,
    sourcePath,
    claudeSessionId: digest.claudeSessionId ?? path.basename(sourcePath, ".jsonl"),
    turnCount: digest.turnCount,
    truncatedTurns: digest.truncatedTurns,
    summary: result.finalMessage,
    usage: buildUsageRecord(result),
    usageSummary: formatUsageSummary(result)
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "model", "effort"],
    booleanOptions: ["json"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const progress = options.json ? null : createProgressReporter({ stderr: true });
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source,
    model: normalizeRequestedModel(options.model),
    effort: normalizeReasoningEffort(options.effort),
    onProgress: progress
  });
  outputCommandResult(payload, rendered, options.json);
}

// ---------------------------------------------------------------------------
// status / result / transcript / cancel
// ---------------------------------------------------------------------------

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ""));
}

function handleTranscript(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  let sessionId = null;
  let job = null;

  if (looksLikeUuid(reference)) {
    sessionId = reference;
  } else {
    const resolved = resolveResultJob(cwd, reference);
    job = resolved.job;
    sessionId = resolved.job.grokSessionId ?? readStoredJob(resolved.workspaceRoot, resolved.job.id)?.grokSessionId ?? null;
    if (!sessionId) {
      throw new Error(`Job ${resolved.job.id} has no Grok session id to export.`);
    }
  }

  const transcript = exportGrokSession(cwd, sessionId);
  const header = [`# Grok Transcript`, "", `Grok session ID: ${sessionId}`, job ? `Job: ${job.id}` : null, `Resume in Grok: grok --resume ${sessionId}`, ""]
    .filter((line) => line !== null)
    .join("\n");
  outputCommandResult({ jobId: job?.id ?? null, grokSessionId: sessionId, transcript }, `${header}\n${transcript.trimEnd()}\n`, options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const claudeSessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    claudeSessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            grokSessionId: candidate.grokSessionId,
            write: Boolean(candidate.write),
            sandbox: candidate.sandbox ?? null,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const grokPid = existing.grokPid ?? job.grokPid ?? null;
  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    grokPid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  // Mark the job cancelled before signalling so the worker's exit handler keeps this state.
  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    grokPid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  // Stop the companion process first (it forwards termination to Grok), then Grok itself.
  if (job.pid && job.pid !== process.pid) {
    terminateProcessTree(job.pid);
  }
  let grokInterrupted = false;
  if (grokPid) {
    const interrupt = interruptGrokRun(grokPid);
    grokInterrupted = Boolean(interrupt.delivered);
    appendLogLine(job.logFile, grokInterrupted ? `Sent SIGTERM to Grok process ${grokPid}.` : `Grok process ${grokPid} was already gone.`);
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    grokSessionId: job.grokSessionId ?? existing.grokSessionId ?? null,
    grokInterrupted
  };

  outputCommandResult(payload, renderCancelReport({ ...nextJob, grokSessionId: payload.grokSessionId }), options.json);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "transcript":
      handleTranscript(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
