import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, headlessInvocations, installFakeGrok, scenarioEnv } from "./fake-grok-fixture.mjs";
import { commitAll, initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");

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

const REVIEW_JSON = {
  verdict: "needs-attention",
  summary: "One real bug.",
  findings: [
    {
      severity: "high",
      title: "Off by one",
      body: "Loop reads past the end.",
      file: "calc.js",
      line_start: 3,
      line_end: 3,
      confidence: 0.9,
      recommendation: "Use < instead of <=."
    }
  ],
  next_steps: ["Add a regression test."]
};

test("setup reports ready when fake grok is installed and authenticated", () => {
  const { repo, env } = setupFixture();
  const result = companion(["setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  assert.match(payload.grok.detail, /grok 1\.0\.5/);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.account, "grok.com");
  assert.deepEqual(
    payload.auth.models.map((model) => model.id),
    ["grok-4.6", "grok-4.5"]
  );
  assert.equal(payload.auth.defaultModel, "grok-4.6");
  assert.equal(payload.reviewGateEnabled, false);
});

test("setup reports not ready and points to grok login when not authenticated", () => {
  const { repo, env } = setupFixture({ env: { FAKE_GROK_AUTH: "not-authenticated" } });
  const result = companion(["setup"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: needs attention/);
  assert.match(result.stdout, /auth: not authenticated/);
  assert.match(result.stdout, /grok login/);
});

test("setup treats XAI_API_KEY as authentication", () => {
  const { repo, env } = setupFixture({ env: { FAKE_GROK_AUTH: "not-authenticated", XAI_API_KEY: "xai-test" } });
  const result = companion(["setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.account, "XAI_API_KEY");
});

test("setup toggles the review gate", () => {
  const { repo, env } = setupFixture();
  let result = companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reviewGateEnabled, true);
  result = companion(["setup", "--disable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(result.stdout).reviewGateEnabled, false);
});

test("setup reports grok missing with the install command", () => {
  const { repo, env, binDir } = setupFixture();
  fs.unlinkSync(path.join(binDir, "grok"));
  const emptyHome = makeTempDir("grok-empty-home-");
  const missingEnv = { ...env, PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`, GROK_HOME: emptyHome };
  delete missingEnv.GROK_PLUGIN_BIN;
  const result = companion(["setup", "--json"], { cwd: repo, env: missingEnv });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.grok.available, false);
  assert.match(payload.nextSteps.join("\n"), /x\.ai\/cli\/install\.sh/);
});

test("task runs a read-only headless grok session and records the job", () => {
  const { repo, env, binDir } = setupFixture({ sessionId: "claude-a" });
  const result = companion(["task", "Explain the build"], {
    cwd: repo,
    env: { ...env, ...scenarioEnv({ response: "Build explained.", numTurns: 2, totalCostUsd: 0.02 }) }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Build explained\./);
  assert.match(result.stdout, /Usage: 1,050 tokens, 2 turns, \$0\.0200/);

  const [invocation] = headlessInvocations(binDir);
  assert.ok(invocation, "grok was invoked");
  assert.equal(invocation.outputFormat, "streaming-json");
  assert.equal(invocation.sandbox, "read-only");
  assert.equal(invocation.alwaysApprove, true);
  assert.equal(invocation.noPlan, true);
  assert.equal(invocation.resume, false);
  assert.match(invocation.prompt, /Explain the build/);
  assert.ok(invocation.argv.includes("--session-id"));
  assert.ok(invocation.argv.includes("--prompt-file"));
  assert.equal(invocation.tools, null);

  const status = companion(["status", "--json"], { cwd: repo, env });
  const report = JSON.parse(status.stdout);
  assert.equal(report.latestFinished.status, "completed");
  assert.equal(report.latestFinished.grokSessionId, invocation.sessionId);
  assert.equal(report.latestFinished.claudeSessionId, "claude-a");
  assert.equal(report.latestFinished.usage.numTurns, 2);
});

test("task --write uses the workspace sandbox and lists touched files", () => {
  const { repo, env, binDir } = setupFixture();
  const events = [
    { type: "tool_call", toolCallId: "c1", title: "search_replace", kind: "edit", status: "pending", toolName: "search_replace", rawInput: { file_path: path.join(repo, "calc.js"), old_string: "a", new_string: "b" } },
    { type: "tool_call_update", toolCallId: "c1", status: "completed", content: [], rawOutput: null }
  ];
  const result = companion(["task", "--write", "Fix calc"], {
    cwd: repo,
    env: { ...env, ...scenarioEnv({ response: "Fixed.", events }) }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fixed\./);
  assert.match(result.stdout, /Touched files:\n- calc\.js/);
  const [invocation] = headlessInvocations(binDir);
  assert.equal(invocation.sandbox, "workspace");
});

test("task forwards model, effort, sandbox, and max-turns", () => {
  const { repo, env, binDir } = setupFixture();
  const result = companion(["task", "--model", "grok-4.5", "--effort", "high", "--sandbox", "strict", "--max-turns", "7", "Do it"], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const [invocation] = headlessInvocations(binDir);
  assert.equal(invocation.model, "grok-4.5");
  assert.equal(invocation.effort, "high");
  assert.equal(invocation.sandbox, "strict");
  assert.equal(invocation.maxTurns, "7");
  assert.match(invocation.prompt, /^Do it$/);
});

test("task rejects an unknown reasoning effort", () => {
  const { repo, env } = setupFixture();
  const result = companion(["task", "--effort", "turbo", "Do it"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported reasoning effort "turbo"/);
});

test("task --resume-last resumes the latest tracked session without re-sending --sandbox", () => {
  const { repo, env, binDir } = setupFixture({ sessionId: "claude-b" });
  let result = companion(["task", "--write", "Start the work"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const first = headlessInvocations(binDir)[0];

  result = companion(["task", "--resume-last", "--write", "Keep going"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const second = headlessInvocations(binDir)[1];
  assert.equal(second.resume, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.sandbox, null);
  assert.match(second.prompt, /^Keep going$/);
  assert.ok(!second.argv.includes("--session-id"));
});

test("task --resume-last refuses to add write access to a read-only session", () => {
  const { repo, env } = setupFixture({ sessionId: "claude-c" });
  let result = companion(["task", "Diagnose only"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  result = companion(["task", "--resume-last", "--write", "Now fix it"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /read-only/);
  assert.match(result.stderr, /--fresh/);
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const { repo, env } = setupFixture({ sessionId: "claude-d" });
  let result = companion(["task", "First"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  result = companion(["task", "--resume-last", "Again"], { cwd: repo, env: { ...env, GROK_COMPANION_SESSION_ID: "claude-e" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No previous Grok task session/);
});

test("task reports a grok error event as a failed run", () => {
  const { repo, env } = setupFixture();
  const result = companion(["task", "Break"], {
    cwd: repo,
    env: { ...env, ...scenarioEnv({ response: "", errorMessage: "Rate limit exceeded", exitCode: 1, omitEnd: true }) }
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Rate limit exceeded/);
  const status = companion(["status", "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "failed");
});

test("task surfaces the grok auth error when not signed in", () => {
  const { repo, env } = setupFixture({ env: { FAKE_GROK_AUTH: "not-authenticated" } });
  const result = companion(["task", "Hello"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Not signed in/);
});

test("review renders structured findings from a fenced JSON final message", () => {
  const { repo, env, binDir, dataDir } = setupFixture();
  fs.writeFileSync(path.join(repo, "calc.js"), "export function avg(v) {\n  let s = 0;\n  for (let i = 0; i <= v.length; i++) s += v[i];\n  return s / v.length;\n}\n", "utf8");
  const response = `I inspected the change.\n\n\`\`\`json\n${JSON.stringify(REVIEW_JSON, null, 2)}\n\`\`\``;
  const result = companion(["review"], { cwd: repo, env: { ...env, ...scenarioEnv({ response, numTurns: 3 }) } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Grok Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /\[high\] Off by one \(calc\.js:3\) \(confidence 90%\)/);
  assert.match(result.stdout, /Recommendation: Use < instead of <=\./);
  assert.match(result.stdout, /Next steps:\n- Add a regression test\./);
  assert.match(result.stdout, /Usage: 1,050 tokens, 3 turns/);

  const [invocation] = headlessInvocations(binDir);
  assert.equal(invocation.tools, "read_file,list_dir,grep");
  assert.match(invocation.disallowedTools, /spawn_subagent/);
  assert.equal(invocation.sandbox, "read-only");
  assert.match(invocation.prompt, /Untracked Files/);
  assert.match(invocation.prompt, /calc\.js/);
  assert.match(invocation.prompt, /"verdict"/, "schema is embedded in the prompt");
  assert.ok(!invocation.argv.includes("--json-schema"));

  const contextFiles = fs.readdirSync(path.join(dataDir, "state")).flatMap((dir) =>
    fs.readdirSync(path.join(dataDir, "state", dir, "jobs")).filter((file) => file.endsWith(".context.md"))
  );
  assert.equal(contextFiles.length, 1);
});

test("review reports a parse error when grok returns no JSON", () => {
  const { repo, env } = setupFixture();
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n", "utf8");
  const result = companion(["review"], { cwd: repo, env: { ...env, ...scenarioEnv({ response: "Looks fine to me." }) } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /did not return valid structured JSON/);
  assert.match(result.stdout, /Looks fine to me\./);
});

test("review hands large diffs over as a context file instead of inlining them", () => {
  const { repo, env, binDir } = setupFixture();
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(repo, `file-${index}.txt`), `content ${index}\n`, "utf8");
  }
  commitAll(repo, "add files");
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(repo, `file-${index}.txt`), `changed ${index}\n`, "utf8");
  }
  const response = `\`\`\`json\n${JSON.stringify({ ...REVIEW_JSON, findings: [], verdict: "approve" })}\n\`\`\``;
  const result = companion(["review"], { cwd: repo, env: { ...env, ...scenarioEnv({ response }) } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings\./);
  const [invocation] = headlessInvocations(binDir);
  assert.match(invocation.prompt, /too large to inline/);
  assert.match(invocation.prompt, /\.context\.md/);
  assert.doesNotMatch(invocation.prompt, /^\+changed 3$/m);
});

test("review accepts --base for branch review and focus text", () => {
  const { repo, env, binDir } = setupFixture();
  run("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
  commitAll(repo, "feature work");
  const response = `\`\`\`json\n${JSON.stringify({ ...REVIEW_JSON, findings: [], verdict: "approve" })}\n\`\`\``;
  const result = companion(["review", "--base main watch the error paths"], { cwd: repo, env: { ...env, ...scenarioEnv({ response }) } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Target: branch diff against main/);
  const [invocation] = headlessInvocations(binDir);
  assert.match(invocation.prompt, /Extra focus requested by the user: watch the error paths/);
  assert.match(invocation.prompt, /Commit Log/);
});

test("adversarial review uses the adversarial prompt and records its kind", () => {
  const { repo, env, binDir } = setupFixture();
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n", "utf8");
  const response = `\`\`\`json\n${JSON.stringify(REVIEW_JSON)}\n\`\`\``;
  const result = companion(["adversarial-review", "question the retry design"], { cwd: repo, env: { ...env, ...scenarioEnv({ response }) } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Grok Adversarial Review/);
  const [invocation] = headlessInvocations(binDir);
  assert.match(invocation.prompt, /adversarial software review/);
  assert.match(invocation.prompt, /User focus: question the retry design/);
  const status = companion(["status", "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(status.stdout).latestFinished.kindLabel, "adversarial-review");
});

test("review fails cleanly outside a git repository", () => {
  const { env } = setupFixture();
  const plainDir = makeTempDir("grok-plain-");
  const result = companion(["review"], { cwd: plainDir, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must run inside a Git repository/);
});
