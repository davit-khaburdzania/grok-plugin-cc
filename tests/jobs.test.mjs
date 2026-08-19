import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok, scenarioEnv } from "./fake-grok-fixture.mjs";
import { commitAll, initGitRepo, makeTempDir, run, waitFor } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

// Copied from runtime.test.mjs so this file stays self-contained.
function setupFixture(options = {}) {
  const binDir = makeTempDir("grok-fake-bin-");
  installFakeGrok(binDir);
  const dataDir = makeTempDir("grok-data-");
  const repo = makeTempDir("grok-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  commitAll(repo, "init");
  const env = buildEnv(binDir, {
    GROK_COMPANION_DATA_DIR: dataDir,
    ...(options.sessionId ? { GROK_COMPANION_SESSION_ID: options.sessionId } : {}),
    ...(options.env ?? {})
  });
  return { binDir, dataDir, repo, env };
}

function companion(args, { cwd, env, input } = {}) {
  return run(process.execPath, [SCRIPT, ...args], { cwd, env, input });
}

function runHook(scriptPath, { cwd, env, input, args = [] } = {}) {
  return run(process.execPath, [scriptPath, ...args], { cwd, env, input });
}

function sessionEnv(env, sessionId) {
  return { ...env, GROK_COMPANION_SESSION_ID: sessionId };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// State layout: $GROK_COMPANION_DATA_DIR/state/<slug>-<hash>/{state.json,jobs/<id>.json}.
function stateSubdir(dataDir) {
  const root = path.join(dataDir, "state");
  if (!fs.existsSync(root)) {
    return null;
  }
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry);
    if (fs.existsSync(path.join(dir, "state.json")) || fs.existsSync(path.join(dir, "jobs"))) {
      return dir;
    }
  }
  return null;
}

function readStateJobs(dataDir) {
  const dir = stateSubdir(dataDir);
  if (!dir) {
    return [];
  }
  const file = path.join(dir, "state.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).jobs ?? [];
  } catch {
    return [];
  }
}

function readJobJson(dataDir, jobId) {
  const dir = stateSubdir(dataDir);
  if (!dir) {
    return null;
  }
  const file = path.join(dir, "jobs", `${jobId}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pidGone(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function startBackgroundTask(repo, env, scenario, prompt = "Background prompt") {
  const result = companion(["task", "--background", "--json", prompt], {
    cwd: repo,
    env: { ...env, ...scenarioEnv(scenario) }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).jobId;
}

function waitForRunningJob(dataDir, jobId, { needGrokPid = false, needSession = false } = {}) {
  return waitFor(
    () => {
      const job = readJobJson(dataDir, jobId);
      if (!job || job.status !== "running") {
        return null;
      }
      if (needGrokPid && !Number.isFinite(job.grokPid)) {
        return null;
      }
      if (needSession && !job.grokSessionId) {
        return null;
      }
      return job;
    },
    { timeoutMs: 15000, intervalMs: 50 }
  );
}

function cancelQuietly(repo, env, jobId) {
  // Best-effort teardown; a finished/cancelled job just returns a non-zero status.
  companion(["cancel", jobId], { cwd: repo, env });
}

test("background task enqueues a detached worker that runs, then completes with a resumable result", async (t) => {
  const { repo, env, dataDir } = setupFixture({ sessionId: "claude-bg" });
  const scenario = scenarioEnv({ sleepMs: 2500, response: "Background answer." });
  const started = companion(["task", "--background", "Explain the plan"], {
    cwd: repo,
    env: { ...env, ...scenario }
  });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /Grok Task started in the background as task-\S+\. Check \/grok:status/);
  const jobId = started.stdout.match(/as (task-[^\s.]+)\. Check/)[1];
  t.after(() => cancelQuietly(repo, env, jobId));

  const runningJob = await waitForRunningJob(dataDir, jobId, { needSession: true });
  assert.ok(runningJob.grokSessionId, "running job exposes a grok session id");

  const running = companion(["status", jobId, "--json"], { cwd: repo, env });
  assert.equal(running.status, 0, running.stderr);
  const runningSnapshot = JSON.parse(running.stdout);
  assert.ok(["queued", "running"].includes(runningSnapshot.job.status), runningSnapshot.job.status);
  assert.ok(runningSnapshot.job.grokSessionId, "status shows the grok session id while running");

  await waitFor(
    () => {
      const status = companion(["status", "--json"], { cwd: repo, env });
      const report = JSON.parse(status.stdout);
      return report.latestFinished && report.latestFinished.status === "completed" ? report : null;
    },
    { timeoutMs: 15000, intervalMs: 100 }
  );

  const finishedJob = readJobJson(dataDir, jobId);
  const result = companion(["result"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Background answer\./);
  assert.match(result.stdout, new RegExp(`Resume in Grok: grok --resume ${finishedJob.grokSessionId}`));
});

test("status without a job id only lists the current Claude session; with an id it finds any job", (t) => {
  const { repo, env } = setupFixture({ sessionId: "claude-a" });
  const envA = sessionEnv(env, "claude-a");
  const envB = sessionEnv(env, "claude-b");

  let result = companion(["task", "Job A prompt"], { cwd: repo, env: envA });
  assert.equal(result.status, 0, result.stderr);
  const jobAId = JSON.parse(companion(["status", "--json"], { cwd: repo, env: envA }).stdout).latestFinished.id;

  result = companion(["task", "Job B prompt"], { cwd: repo, env: envB });
  assert.equal(result.status, 0, result.stderr);
  const jobBId = JSON.parse(companion(["status", "--json"], { cwd: repo, env: envB }).stdout).latestFinished.id;
  assert.notEqual(jobAId, jobBId);

  const reportA = JSON.parse(companion(["status", "--json"], { cwd: repo, env: envA }).stdout);
  const visibleJobs = [...reportA.running, reportA.latestFinished, ...reportA.recent].filter(Boolean);
  assert.equal(reportA.latestFinished.id, jobAId);
  for (const job of visibleJobs) {
    assert.equal(job.claudeSessionId, "claude-a", `session A should not see ${job.id}`);
  }
  assert.ok(!visibleJobs.some((job) => job.id === jobBId), "job B is hidden from session A's list");

  const single = JSON.parse(companion(["status", jobBId, "--json"], { cwd: repo, env: envA }).stdout);
  assert.equal(single.job.id, jobBId);
  assert.equal(single.job.claudeSessionId, "claude-b");
});

test("status --wait returns within the timeout while a sleeping job is still running, then cancel stops it", async (t) => {
  const { repo, env, dataDir } = setupFixture({ sessionId: "claude-wait" });
  const jobId = startBackgroundTask(repo, env, { sleepMs: 5000, response: "Slow answer." });
  t.after(() => cancelQuietly(repo, env, jobId));

  await waitForRunningJob(dataDir, jobId, { needGrokPid: true });

  const started = Date.now();
  const waited = companion(["status", jobId, "--wait", "--timeout-ms", "500", "--json"], { cwd: repo, env });
  const elapsed = Date.now() - started;
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.waitTimedOut, true, "wait should report a clean timeout");
  assert.equal(snapshot.job.status, "running");
  assert.ok(elapsed < 3000, `status --wait returned in ${elapsed}ms, well before the 5000ms job`);

  const cancelled = companion(["cancel", jobId], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /# Grok Cancel/);
});

test("cancel stops an active background job and its processes, and the state stays cancelled", async (t) => {
  const { repo, env, dataDir } = setupFixture({ sessionId: "claude-cancel" });
  const jobId = startBackgroundTask(repo, env, { sleepMs: 5000, response: "Never returned." });
  t.after(() => cancelQuietly(repo, env, jobId));

  const runningJob = await waitForRunningJob(dataDir, jobId, { needGrokPid: true });
  const { pid, grokPid } = runningJob;
  assert.ok(Number.isFinite(pid) && pid > 0, "worker pid recorded");
  assert.ok(Number.isFinite(grokPid) && grokPid > 0, "grok pid recorded");
  assert.ok(!pidGone(pid), "worker process is alive before cancel");
  assert.ok(!pidGone(grokPid), "grok process is alive before cancel");

  const cancelled = companion(["cancel", jobId], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.ok(cancelled.stdout.startsWith("# Grok Cancel"), cancelled.stdout);
  assert.match(cancelled.stdout, new RegExp(`Cancelled ${jobId}\\.`));

  await waitFor(() => (pidGone(pid) && pidGone(grokPid) ? true : null), { timeoutMs: 10000, intervalMs: 100 });
  assert.ok(pidGone(pid), "worker process is gone (ESRCH) after cancel");
  assert.ok(pidGone(grokPid), "grok process is gone (ESRCH) after cancel");

  const afterCancel = readJobJson(dataDir, jobId);
  assert.equal(afterCancel.status, "cancelled");
  assert.equal(afterCancel.phase, "cancelled");

  // A late worker exit must not flip the job to "failed".
  await delay(1500);
  const later = companion(["status", jobId, "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(later.stdout).job.status, "cancelled");
});

test("cancel without a job id ignores other sessions, but cancel with the id can target them", async (t) => {
  const { repo, env, dataDir } = setupFixture();
  const otherEnv = sessionEnv(env, "claude-owner");
  const callerEnv = sessionEnv(env, "claude-caller");
  const jobId = startBackgroundTask(repo, otherEnv, { sleepMs: 5000, response: "Owned job." });
  t.after(() => cancelQuietly(repo, env, jobId));

  await waitForRunningJob(dataDir, jobId, { needGrokPid: true });

  const blind = companion(["cancel"], { cwd: repo, env: callerEnv });
  assert.equal(blind.status, 1);
  assert.match(blind.stderr, /No active Grok jobs to cancel for this session\./);
  assert.equal(readJobJson(dataDir, jobId).status, "running");

  const targeted = companion(["cancel", jobId], { cwd: repo, env: callerEnv });
  assert.equal(targeted.status, 0, targeted.stderr);
  assert.match(targeted.stdout, new RegExp(`Cancelled ${jobId}\\.`));
  await waitFor(() => (readJobJson(dataDir, jobId).status === "cancelled" ? true : null), { timeoutMs: 5000, intervalMs: 100 });
});

test("result reports no finished jobs, and resolves a job by an 8 char id prefix", (t) => {
  const { repo, env } = setupFixture({ sessionId: "claude-result" });

  const empty = companion(["result"], { cwd: repo, env });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /No finished Grok jobs found for this repository yet\./);

  const task = companion(["task", "Answer this"], {
    cwd: repo,
    env: { ...env, ...scenarioEnv({ response: "Prefixed answer." }) }
  });
  assert.equal(task.status, 0, task.stderr);
  const jobId = JSON.parse(companion(["status", "--json"], { cwd: repo, env }).stdout).latestFinished.id;

  const prefix = jobId.slice(0, 8);
  const byPrefix = companion(["result", prefix], { cwd: repo, env });
  assert.equal(byPrefix.status, 0, byPrefix.stderr);
  assert.match(byPrefix.stdout, /Prefixed answer\./);
  assert.match(byPrefix.stdout, /Resume in Grok: grok --resume /);
});

test("transcript exports a finished job and a raw grok session UUID", (t) => {
  const { repo, env } = setupFixture({ sessionId: "claude-transcript" });
  const task = companion(["task", "Export me"], {
    cwd: repo,
    env: { ...env, ...scenarioEnv({ response: "Exportable." }) }
  });
  assert.equal(task.status, 0, task.stderr);
  const finished = JSON.parse(companion(["status", "--json"], { cwd: repo, env }).stdout).latestFinished;
  const jobId = finished.id;
  const sessionId = finished.grokSessionId;

  const byJob = companion(["transcript", jobId], { cwd: repo, env });
  assert.equal(byJob.status, 0, byJob.stderr);
  assert.match(byJob.stdout, /# Grok Transcript/);
  assert.match(byJob.stdout, new RegExp(`Grok session ID: ${sessionId}`));
  assert.match(byJob.stdout, new RegExp(`Fake answer for ${sessionId}`));

  const rawUuid = "12345678-1234-1234-1234-1234567890ab";
  const byUuid = companion(["transcript", rawUuid], { cwd: repo, env });
  assert.equal(byUuid.status, 0, byUuid.stderr);
  assert.match(byUuid.stdout, /# Grok Transcript/);
  assert.match(byUuid.stdout, new RegExp(`Fake answer for ${rawUuid}`));
});

test("task-resume-candidate flips to available after a completed task and stays session scoped", (t) => {
  const { repo, env } = setupFixture({ sessionId: "claude-resume" });
  const sessionMain = sessionEnv(env, "claude-resume");
  const sessionOther = sessionEnv(env, "claude-resume-other");

  let payload = JSON.parse(companion(["task-resume-candidate", "--json"], { cwd: repo, env: sessionMain }).stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.claudeSessionId, "claude-resume");
  assert.equal(payload.candidate, null);

  const task = companion(["task", "Seed a resumable task"], { cwd: repo, env: sessionMain });
  assert.equal(task.status, 0, task.stderr);

  payload = JSON.parse(companion(["task-resume-candidate", "--json"], { cwd: repo, env: sessionMain }).stdout);
  assert.equal(payload.available, true);
  assert.ok(payload.candidate?.id, "a candidate job id is reported");
  assert.ok(payload.candidate?.grokSessionId, "the candidate carries a grok session id");

  const otherPayload = JSON.parse(
    companion(["task-resume-candidate", "--json"], { cwd: repo, env: sessionOther }).stdout
  );
  assert.equal(otherPayload.available, false);
  assert.equal(otherPayload.candidate, null);
});

test("session hooks export env vars on start and drop only their own session's jobs on end", (t) => {
  const { repo, env, dataDir } = setupFixture();
  const envFile = path.join(makeTempDir("grok-envfile-"), "session.env");
  fs.writeFileSync(envFile, "", "utf8");

  const startEnv = { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: dataDir };
  const startInput = JSON.stringify({
    session_id: "sess-start",
    transcript_path: "/tmp/transcript-abc.jsonl",
    cwd: repo
  });
  const start = runHook(SESSION_HOOK, { cwd: repo, env: startEnv, input: startInput, args: ["SessionStart"] });
  assert.equal(start.status, 0, start.stderr);
  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export GROK_COMPANION_SESSION_ID='sess-start'/);
  assert.match(exported, /export GROK_COMPANION_TRANSCRIPT_PATH='\/tmp\/transcript-abc\.jsonl'/);
  assert.ok(exported.includes(`export GROK_COMPANION_DATA_DIR='${dataDir}'`), exported);

  const keepEnv = sessionEnv(env, "sess-keep");
  const dropEnv = sessionEnv(env, "sess-drop");
  assert.equal(companion(["task", "Keep me"], { cwd: repo, env: keepEnv }).status, 0);
  assert.equal(companion(["task", "Drop me"], { cwd: repo, env: dropEnv }).status, 0);
  const before = readStateJobs(dataDir);
  assert.ok(before.some((job) => job.claudeSessionId === "sess-keep"));
  assert.ok(before.some((job) => job.claudeSessionId === "sess-drop"));

  const end = runHook(SESSION_HOOK, {
    cwd: repo,
    env,
    input: JSON.stringify({ session_id: "sess-drop", cwd: repo }),
    args: ["SessionEnd"]
  });
  assert.equal(end.status, 0, end.stderr);

  const after = readStateJobs(dataDir);
  assert.ok(!after.some((job) => job.claudeSessionId === "sess-drop"), "dropped session's jobs are removed");
  assert.ok(after.some((job) => job.claudeSessionId === "sess-keep"), "other session's jobs remain");
});

test("stop hook honors the review gate: pass-through, ALLOW, BLOCK, and grok-unavailable", (t) => {
  const { repo, env, binDir } = setupFixture({ sessionId: "claude-stop" });
  const stopInput = (extra = {}) => JSON.stringify({ session_id: "claude-stop", cwd: repo, ...extra });

  // Gate disabled (default): no block, nothing on stdout.
  const disabled = runHook(STOP_HOOK, {
    cwd: repo,
    env,
    input: stopInput({ last_assistant_message: "Just a status update." })
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), "");

  const enable = companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(enable.status, 0, enable.stderr);
  assert.equal(JSON.parse(enable.stdout).reviewGateEnabled, true);

  // Gate enabled + ALLOW: no block.
  const allow = runHook(STOP_HOOK, {
    cwd: repo,
    env: { ...env, ...scenarioEnv({ cases: [{ match: "stop-gate review", response: "ALLOW: looks fine" }] }) },
    input: stopInput({ last_assistant_message: "I edited calc.js" })
  });
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(allow.stdout.trim(), "");

  // Gate enabled + BLOCK: one JSON block decision carrying the reason.
  const block = runHook(STOP_HOOK, {
    cwd: repo,
    env: { ...env, ...scenarioEnv({ cases: [{ match: "stop-gate review", response: "BLOCK: bad retry logic\nSee calc.js:3" }] }) },
    input: stopInput({ last_assistant_message: "I edited calc.js" })
  });
  assert.equal(block.status, 0, block.stderr);
  const decision = JSON.parse(block.stdout.trim());
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /bad retry logic/);

  // Gate enabled but grok unavailable: must not block, and must point to /grok:setup.
  fs.unlinkSync(path.join(binDir, "grok"));
  const emptyHome = makeTempDir("grok-empty-home-");
  const missingEnv = { ...env, PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`, GROK_HOME: emptyHome };
  delete missingEnv.GROK_PLUGIN_BIN;
  const unavailable = runHook(STOP_HOOK, {
    cwd: repo,
    env: missingEnv,
    input: stopInput({ last_assistant_message: "I edited calc.js" })
  });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  assert.equal(unavailable.stdout.trim(), "");
  assert.match(unavailable.stderr, /\/grok:setup/);
});

test("stop hook notes a still-running job in stderr when the gate is disabled", async (t) => {
  const { repo, env, dataDir } = setupFixture({ sessionId: "claude-running" });
  const jobId = startBackgroundTask(repo, env, { sleepMs: 5000, response: "Long running." });
  t.after(() => cancelQuietly(repo, env, jobId));

  await waitForRunningJob(dataDir, jobId, { needGrokPid: true });

  const hook = runHook(STOP_HOOK, {
    cwd: repo,
    env,
    input: JSON.stringify({ session_id: "claude-running", cwd: repo, last_assistant_message: "Working on it." })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout.trim(), "", "a disabled gate never blocks");
  assert.match(hook.stderr, new RegExp(jobId));
  assert.match(hook.stderr, new RegExp(`/grok:cancel ${jobId}`));
});
